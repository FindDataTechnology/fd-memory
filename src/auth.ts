// Token families and the Grant table (add-memory-scopes-and-cluster-sharing):
// deployment (one d/<packId>/<agentId> member), pod (one d/<packId> pack),
// person (one u/ root), runner (capture-only + minting), platform (minting
// only). Authority over data is expressed as grants — (token, scope_kind,
// scope_ref, mode) rows — not namespace string matching: minting writes the
// family defaults, every data-plane access consults the table, and revoking
// one grant narrows one face without code changes. Hashed at rest with a
// pepper; lookup per request so revocation is immediate (no cache grace).

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TokenKind = "deployment" | "person" | "runner" | "platform" | "pod";
export type ScopeKind = "agent" | "pack" | "owner";
export type GrantMode = "r" | "rw";

export interface TokenRecord {
  id: string;
  kind: TokenKind;
  namespace: string; // d/<packId>/<agentId> | d/<packId> | u/<user> | "*"
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  label: string | null;
}

export interface GrantRow {
  token_id: string;
  scope_kind: ScopeKind;
  scope_ref: string;
  mode: GrantMode;
  granted_at: string;
}

export interface Scope {
  tokenId: string;
  kind: TokenKind;
  namespace: string; // runner/platform tokens carry "*"
}

// A single filesystem-safe project/namespace segment: path separators are
// flattened, dot-only names rejected. Display-name agentIds (Chinese, spaces)
// are kept — they are legal project names on every filesystem we run on.
export function safeSegment(s: string, fallback = "default"): string {
  const out = String(s ?? "").trim().replace(/[/\\]+/g, "-");
  if (!out || /^[.]+$/.test(out)) return fallback;
  return out.slice(0, 128);
}

function hash(token: string, pepper: string): string {
  return createHash("sha256").update(token + ":" + pepper).digest("hex");
}

// Default grants written at mint (and backfilled for pre-grant tokens):
// member = own agent rw + pack rw; pod = pack rw; person = owner rw;
// runner/platform hold no data grants (their lanes are route-level special
// cases, unchanged).
export function defaultGrantsFor(kind: TokenKind, namespace: string): Array<{ scope_kind: ScopeKind; scope_ref: string; mode: GrantMode }> {
  if (kind === "deployment" && namespace.startsWith("d/")) {
    const parts = namespace.slice(2).split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return [
        { scope_kind: "agent", scope_ref: `d/${parts[0]}/${parts[1]}`, mode: "rw" },
        { scope_kind: "pack", scope_ref: `d/${parts[0]}`, mode: "rw" },
      ];
    }
  }
  if (kind === "pod" && namespace.startsWith("d/")) {
    const parts = namespace.slice(2).split("/");
    if (parts.length === 1 && parts[0]) return [{ scope_kind: "pack", scope_ref: `d/${parts[0]}`, mode: "rw" }];
  }
  if (kind === "person" && namespace.startsWith("u/")) {
    const user = namespace.slice(2).split("/")[0];
    if (user) return [{ scope_kind: "owner", scope_ref: `u/${user}`, mode: "rw" }];
  }
  return [];
}

// Which scopes a namespace belongs to. Deliberately NOT hierarchical: a pack
// grant covers ONLY the pack's shared partition (ns d/<packId>), never a
// member's private namespace — sharing is opt-in via the shared area, so a
// member token cannot reach a sibling's private project through its pack
// grant. u/… belongs to its owner scope.
export function scopesForNamespace(ns: string): Array<{ kind: ScopeKind; ref: string }> {
  if (ns.startsWith("u/")) {
    const user = ns.slice(2).split("/")[0];
    return user ? [{ kind: "owner", ref: "u/" + user }] : [];
  }
  if (ns.startsWith("d/")) {
    const parts = ns.slice(2).split("/").filter(Boolean);
    if (parts.length === 1) return [{ kind: "pack", ref: "d/" + parts[0] }];
    if (parts.length >= 2) return [{ kind: "agent", ref: `d/${parts[0]}/${parts[1]}` }];
  }
  return [];
}

export class TokenStore {
  private db: DatabaseSync;

  constructor(dbPath: string, private pepper: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, kind TEXT, namespace TEXT, token_hash TEXT UNIQUE,
        created_at TEXT, revoked_at TEXT, label TEXT
      );
      CREATE TABLE IF NOT EXISTS grants (
        token_id TEXT, scope_kind TEXT, scope_ref TEXT, mode TEXT, granted_at TEXT,
        PRIMARY KEY (token_id, scope_kind, scope_ref)
      );
      CREATE TABLE IF NOT EXISTS distill_budget (
        owner_key TEXT, day TEXT, tokens INTEGER NOT NULL DEFAULT 0, llm_calls INTEGER NOT NULL DEFAULT 0,
        -- Run/truncation counters persist across restarts (fix-distill-extract-
        -- truncation): the in-process metrics reset on every roll, which is
        -- exactly when an operator most wants the historical ratio.
        runs INTEGER NOT NULL DEFAULT 0, truncated_runs INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_key, day)
      );
      CREATE TABLE IF NOT EXISTS root_owner (
        root_key TEXT PRIMARY KEY, owner_user TEXT NOT NULL, bound_at TEXT NOT NULL, source TEXT
      )`,
    );
    // Pre-existing ledgers: add the run counters once (SQLite has no
    // ADD COLUMN IF NOT EXISTS).
    const budgetCols = new Set(
      (this.db.prepare("PRAGMA table_info(distill_budget)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!budgetCols.has("runs")) this.db.exec("ALTER TABLE distill_budget ADD COLUMN runs INTEGER NOT NULL DEFAULT 0");
    if (!budgetCols.has("truncated_runs")) this.db.exec("ALTER TABLE distill_budget ADD COLUMN truncated_runs INTEGER NOT NULL DEFAULT 0");
    this.backfillDefaultGrants();
  }

  // Idempotent: every pre-grant token receives its family defaults exactly
  // once. Re-running (every boot) inserts nothing new.
  backfillDefaultGrants(): number {
    const rows = this.db
      .prepare("SELECT id, kind, namespace FROM tokens WHERE revoked_at IS NULL")
      .all() as Array<{ id: string; kind: string; namespace: string }>;
    let added = 0;
    for (const row of rows) {
      for (const g of defaultGrantsFor(row.kind as TokenKind, row.namespace)) {
        added += this.grant(row.id, g.scope_kind, g.scope_ref, g.mode);
      }
    }
    return added;
  }

  grant(tokenId: string, scopeKind: ScopeKind, scopeRef: string, mode: GrantMode): number {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO grants (token_id, scope_kind, scope_ref, mode, granted_at) VALUES (?,?,?,?,?)")
      .run(tokenId, scopeKind, scopeRef, mode, new Date().toISOString());
    return Number(res.changes);
  }

  revokeGrant(tokenId: string, scopeKind: ScopeKind, scopeRef: string): boolean {
    const res = this.db
      .prepare("DELETE FROM grants WHERE token_id=? AND scope_kind=? AND scope_ref=?")
      .run(tokenId, scopeKind, scopeRef);
    return res.changes > 0;
  }

  grantsFor(tokenId: string): GrantRow[] {
    return this.db
      .prepare("SELECT token_id, scope_kind, scope_ref, mode, granted_at FROM grants WHERE token_id=?")
      .all(tokenId) as unknown as GrantRow[];
  }

  // Grants whose scope_ref resolves into the given root (tokens minted for
  // namespaces of that root; e.g. every member token of d-<packId> plus its
  // pod token).
  grantsForRoot(rootKey: string): Array<GrantRow & { token_kind: string; token_namespace: string; token_label: string | null; token_revoked: number }> {
    const rows = this.db
      .prepare(
        `SELECT g.token_id, g.scope_kind, g.scope_ref, g.mode, g.granted_at,
                t.kind AS token_kind, t.namespace AS token_namespace, t.label AS token_label,
                (t.revoked_at IS NOT NULL) AS token_revoked
         FROM grants g JOIN tokens t ON t.id = g.token_id`,
      )
      .all() as unknown as Array<GrantRow & { token_kind: string; token_namespace: string; token_label: string | null; token_revoked: number }>;
    return rows.filter((r) => rootKeyForRef(r.scope_ref) === rootKey);
  }

  allows(tokenId: string, ns: string, mode: GrantMode): boolean {
    const grants = new Map(this.grantsFor(tokenId).map((g) => [`${g.scope_kind}|${g.scope_ref}`, g.mode]));
    for (const s of scopesForNamespace(ns)) {
      const m = grants.get(`${s.kind}|${s.ref}`);
      if (m && (m === "rw" || mode === "r")) return true;
    }
    return false;
  }

  // -- root ownership (add-agent-memory-foundation) ----------------------------
  // The structural anchor for owner oversight: which person owns which d/
  // root, recorded at mint time (platform deployment minting) or via the
  // explicit admin bind gesture for pre-existing roots. Deliberately a table,
  // never a naming convention (spec: ownership 判定 MUST NOT 依赖名称约定).
  // First binding wins and re-binding is idempotent — a rebind that silently
  // rewrote ownership would be an oversight-bypass primitive.
  bindRootOwner(rootKey: string, ownerUser: string, source: string): { bound: boolean; existing: string | null } {
    const clean = safeSegment(rootKey);
    const row = this.db.prepare("SELECT owner_user FROM root_owner WHERE root_key=?").get(clean) as { owner_user: string } | undefined;
    if (row) return { bound: false, existing: row.owner_user };
    this.db.prepare("INSERT INTO root_owner (root_key, owner_user, bound_at, source) VALUES (?,?,?,?)")
      .run(clean, ownerUser, new Date().toISOString(), source);
    return { bound: true, existing: null };
  }

  rootOwnerOf(rootKey: string): string | null {
    const row = this.db.prepare("SELECT owner_user FROM root_owner WHERE root_key=?").get(rootKey) as { owner_user: string } | undefined;
    return row?.owner_user ?? null;
  }

  // The d/ roots a person namespace (u/<user>) may supervise. Empty unless
  // bindings exist — oversight is opt-in by binding, never ambient.
  oversightRootKeysFor(userNs: string): string[] {
    if (!userNs.startsWith("u/")) return [];
    const user = userNs.slice(2).split("/")[0];
    if (!user) return [];
    const rows = this.db.prepare("SELECT root_key FROM root_owner WHERE owner_user=? ORDER BY root_key LIMIT 100").all(user) as Array<{ root_key: string }>;
    return rows.map((r) => r.root_key);
  }

  // -- distill budget (add-memory-distiller) ----------------------------------
  // owner_key = store rootKey: u-<user> for persons, d-<packId> per deployed
  // pack (packIds are unique per deployer by the serving plane's singleton
  // deployment key, so per-root == per-owner at v1 scale). A guardrail for
  // visibility, not a billing ledger (external billing lanes keep their own truth).

  distillBudgetUsed(ownerKey: string, day: string): { tokens: number; llm_calls: number } {
    const row = this.db
      .prepare("SELECT tokens, llm_calls FROM distill_budget WHERE owner_key=? AND day=?")
      .get(ownerKey, day) as { tokens: number; llm_calls: number } | undefined;
    return { tokens: Number(row?.tokens ?? 0), llm_calls: Number(row?.llm_calls ?? 0) };
  }

  distillBudgetRows(ownerKey: string, limitDays = 7): Array<{ owner_key: string; day: string; tokens: number; llm_calls: number; runs: number; truncated_runs: number }> {
    return this.db
      .prepare("SELECT owner_key, day, tokens, llm_calls, runs, truncated_runs FROM distill_budget WHERE owner_key=? ORDER BY day DESC LIMIT ?")
      .all(ownerKey, limitDays) as unknown as Array<{ owner_key: string; day: string; tokens: number; llm_calls: number; runs: number; truncated_runs: number }>;
  }

  // One row per distill run, with whether its extract hit the completion ceiling.
  // Persisted rather than in-memory because a roll resets the process counters,
  // and "did we lose output before the roll" is the question being asked.
  distillRunAdd(ownerKey: string, day: string, truncated: boolean): void {
    this.db
      .prepare(
        `INSERT INTO distill_budget (owner_key, day, runs, truncated_runs) VALUES (?,?,1,?)
         ON CONFLICT(owner_key, day) DO UPDATE SET runs = runs + 1, truncated_runs = truncated_runs + excluded.truncated_runs`,
      )
      .run(ownerKey, day, truncated ? 1 : 0);
  }

  distillBudgetAdd(ownerKey: string, day: string, tokens: number, llmCalls: number): void {
    this.db
      .prepare(
        `INSERT INTO distill_budget (owner_key, day, tokens, llm_calls) VALUES (?,?,?,?)
         ON CONFLICT(owner_key, day) DO UPDATE SET tokens = tokens + excluded.tokens, llm_calls = llm_calls + excluded.llm_calls`,
      )
      .run(ownerKey, day, Math.max(0, tokens | 0), Math.max(0, llmCalls | 0));
  }

  mint(kind: TokenKind, namespace: string, label?: string): { token: string; id: string } {
    const token = "fdm_" + randomBytes(24).toString("hex");
    const id = randomBytes(8).toString("hex");
    this.db
      .prepare("INSERT INTO tokens (id, kind, namespace, token_hash, created_at, label) VALUES (?,?,?,?,?,?)")
      .run(id, kind, namespace, hash(token, this.pepper), new Date().toISOString(), label ?? null);
    for (const g of defaultGrantsFor(kind, namespace)) this.grant(id, g.scope_kind, g.scope_ref, g.mode);
    return { token, id };
  }

  verify(token: string): Scope | null {
    const row = this.db
      .prepare("SELECT id, kind, namespace, revoked_at FROM tokens WHERE token_hash=?")
      .get(hash(token, this.pepper)) as (Omit<TokenRecord, "token_hash" | "created_at" | "label"> & { kind: string }) | undefined;
    if (!row || row.revoked_at) return null;
    return { tokenId: row.id, kind: row.kind as TokenKind, namespace: row.namespace };
  }

  revoke(id: string): boolean {
    const res = this.db
      .prepare("UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return res.changes > 0;
  }

  list(): Array<Omit<TokenRecord, "token_hash">> {
    return this.db
      .prepare("SELECT id, kind, namespace, created_at, revoked_at, label FROM tokens ORDER BY created_at")
      .all() as Array<Omit<TokenRecord, "token_hash">>;
  }
}

// The store-root key a scope_ref's namespaces live under.
export function rootKeyForRef(scopeRef: string): string {
  if (scopeRef.startsWith("u/")) return "u-" + safeSegment(scopeRef.slice(2).split("/")[0]);
  if (scopeRef.startsWith("d/")) return "d-" + safeSegment(scopeRef.slice(2).split("/")[0]);
  return "";
}

// namespace -> { rootKey, project } (v2 layout: d/ mirrors u/'s
// one-root-many-projects shape — one physical root per pack, member
// observations under their own project, the pack's shared area under
// "shared").
// u/<user>/p/<project>  => root "u-<user>", project "<project>"
// d/<packId>/<agentId>  => root "d-<packId>", project "<agentId>"
// d/<packId>            => root "d-<packId>", project "shared"
export function namespaceParts(ns: string): { rootKey: string; project: string } {
  if (ns.startsWith("u/")) {
    const rest = ns.slice(2); // <user>[/p/<project>]
    const m = rest.match(/^(.+?)(?:\/p\/(.+))?$/);
    const user = m![1];
    return { rootKey: "u-" + safeSegment(user), project: m![2] ? safeSegment(m![2]) : "default" };
  }
  if (ns.startsWith("d/")) {
    const parts = ns.slice(2).split("/");
    const pack = safeSegment(parts[0], "pack");
    if (parts.length >= 2 && parts[1]) return { rootKey: "d-" + pack, project: safeSegment(parts[1]) };
    return { rootKey: "d-" + pack, project: "shared" };
  }
  return { rootKey: safeSegment(ns), project: "default" };
}
