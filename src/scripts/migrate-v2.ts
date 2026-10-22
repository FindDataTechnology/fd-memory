// One-shot v1→v2 layout migration (add-memory-scopes-and-cluster-sharing).
//
// v1: every d/<packId>/<agentId> namespace got its own root
//     owners/d-<packId>--<agentId>/ with a single "default" project.
// v2: the pack owns one root owners/d-<packId>/ with per-agent projects and
//     a "shared" project.
//
// Coordinates come from tokens.db (clean separators) — the v1 directory name
// is AMBIGUOUS (packIds are base64url and may themselves contain "--"), so
// the tree is never parsed back from disk names. Orphan directories (no
// matching token) are moved with a best-effort split and a warning.
//
// Idempotent: a root already migrated (old dir renamed to *.v1-backup) is
// skipped. The old directory is KEPT (renamed <root>.v1-backup) until
// acceptance; nothing is deleted. Wiki markdown is moved verbatim (byte-level
// truth untouched); observations, handoffs (claim state), and hook-dedupe
// rows are carried over into the new root's derived db.
//
// usage: node dist/scripts/migrate-v2.js [--data <dir>] [--dry-run]

import { existsSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TokenStore } from "../auth.js";
import { StoreRoot } from "../store.js";

interface Plan {
  namespace: string;
  rootKey: string;
  oldRoot: string;
  newRoot: string;
  project: string;
}

function v1RootKey(ns: string): string {
  const parts = ns.slice(2).split("/");
  return "d-" + parts[0] + "--" + (parts[1] ?? "default");
}

function carryOver(oldDbPath: string, root: StoreRoot, project: string): { obs: number; handoffs: number } {
  if (!existsSync(oldDbPath)) return { obs: 0, handoffs: 0 };
  const old = new DatabaseSync(oldDbPath, { readOnly: true });
  try {
    const obs = old
      .prepare("SELECT session_id, agent, event, tool, summary, created_at FROM observations ORDER BY id")
      .all() as Array<{ session_id: string; agent: string; event: string; tool: string | null; summary: string; created_at: string }>;
    for (const row of obs) {
      root.db.addObservation({ ...row, project });
    }
    const handoffs = old
      .prepare("SELECT id, project, from_agent, summary, open_questions, next_steps, files_touched, to_agent, state, accepted_by, accepted_at, created_at FROM handoffs ORDER BY created_at")
      .all() as Array<Record<string, string | null>>;
    for (const h of handoffs) {
      root.db.upsertHandoff({
        id: String(h.id),
        project,
        from_agent: String(h.from_agent ?? "unknown"),
        summary: String(h.summary ?? ""),
        open_questions: String(h.open_questions ?? "[]"),
        next_steps: String(h.next_steps ?? "[]"),
        files_touched: String(h.files_touched ?? "[]"),
        to_agent: h.to_agent != null ? String(h.to_agent) : null,
        state: (h.state as "open" | "claimed" | "cancelled") ?? "open",
        accepted_by: h.accepted_by != null ? String(h.accepted_by) : null,
        accepted_at: h.accepted_at != null ? String(h.accepted_at) : null,
        created_at: String(h.created_at ?? new Date().toISOString()),
      });
    }
    // hook dedupe: keep replay protection intact across the move
    const dedupe = old.prepare("SELECT ingest_key, session_id, event, seen_at FROM hook_dedupe").all() as Array<Record<string, string>>;
    for (const d of dedupe) {
      root.db.claimHookEvent(String(d.ingest_key), String(d.session_id), String(d.event), String(d.seen_at));
    }
    return { obs: obs.length, handoffs: handoffs.length };
  } finally {
    old.close();
  }
}

function migrateNamespace(dataDir: string, dryRun: boolean, plan: Plan): void {
  const oldWikiDefault = join(plan.oldRoot, "wiki", "default");
  if (!existsSync(plan.oldRoot)) {
    console.log(`skip (already migrated or empty): ${plan.namespace}`);
    return;
  }
  if (!existsSync(oldWikiDefault)) {
    console.log(`skip (no default project): ${plan.namespace}`);
    return;
  }
  const targetProjectDir = join(plan.newRoot, "wiki", plan.project);
  if (existsSync(targetProjectDir)) {
    // merge file-by-file; a name collision is a hard stop (manual call)
    for (const entry of readdirSync(oldWikiDefault)) {
      const dst = join(targetProjectDir, entry);
      if (existsSync(dst)) throw new Error(`collision merging ${plan.namespace}: ${dst} already exists`);
      if (dryRun) continue;
      renameSync(join(oldWikiDefault, entry), dst);
    }
  } else {
    if (!dryRun) {
      mkdirSync(join(plan.newRoot, "wiki"), { recursive: true });
      renameSync(oldWikiDefault, targetProjectDir);
    }
  }
  console.log(`${dryRun ? "[dry-run] " : ""}moved ${plan.namespace}: wiki/default -> ${plan.project}`);
  if (dryRun) return;
  const root = new StoreRoot(dataDir, plan.rootKey);
  const count = root.db.reindexFromWiki(root.wikiDir);
  const carried = carryOver(join(plan.oldRoot, "db", "memory.sqlite"), root, plan.project);
  console.log(`  reindexed ${count} pages; carried ${carried.obs} observations, ${carried.handoffs} handoffs`);
  const backup = plan.oldRoot + ".v1-backup";
  if (!existsSync(backup)) renameSync(plan.oldRoot, backup);
  console.log(`  kept old root at ${backup}`);
}

export function runMigration(dataDir: string, dryRun: boolean): void {
  const tokens = new TokenStore(join(dataDir, "tokens.db"), process.env.FD_MEMORY_PEPPER ?? "fd-memory-dev-pepper");
  const ownersDir = join(dataDir, "owners");
  const namespaces = tokens
    .list()
    .filter((t) => t.kind === "deployment" && t.namespace.startsWith("d/") && !t.revoked_at)
    .map((t) => t.namespace);
  const seen = new Set<string>();
  const plans: Plan[] = [];
  for (const ns of namespaces) {
    if (seen.has(ns)) continue;
    seen.add(ns);
    const parts = ns.slice(2).split("/");
    if (parts.length < 2) continue;
    plans.push({
      namespace: ns,
      rootKey: "d-" + parts[0],
      oldRoot: join(ownersDir, v1RootKey(ns)),
      newRoot: join(ownersDir, "d-" + parts[0]),
      project: parts[1],
    });
  }
  console.log(`migrate-v2: data=${dataDir} namespaces=${plans.length}${dryRun ? " (dry-run)" : ""}`);
  for (const plan of plans) migrateNamespace(dataDir, dryRun, plan);

  // Orphan v1 d- roots with no token: best-effort split (packIds may contain
  // "--"; we try every split and prefer the one whose pack side is non-empty).
  if (existsSync(ownersDir)) {
    for (const entry of readdirSync(ownersDir)) {
      if (!entry.startsWith("d-") || entry.endsWith(".v1-backup")) continue;
      if (plans.some((p) => p.newRoot.endsWith(entry))) continue;
      const body = entry.slice(2);
      const splits = body.split("--");
      if (splits.length < 2) continue;
      console.log(`WARN orphan v1 root (no matching token): ${entry} — best-effort as pack=${splits[0]} agent=${splits.slice(1).join("--")}`);
      if (splits[0] && splits[1]) {
        migrateNamespace(dataDir, dryRun, {
          namespace: `d/${splits[0]}/${splits.slice(1).join("--")}`,
          rootKey: "d-" + splits[0],
          oldRoot: join(ownersDir, entry),
          newRoot: join(ownersDir, "d-" + splits[0]),
          project: splits.slice(1).join("--"),
        });
      }
    }
  }
  // u/ roots and any d-<pack> (v2) roots need nothing — layout unchanged.
  console.log("migrate-v2: done");
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dataIdx = args.indexOf("--data");
  const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : (process.env.FD_MEMORY_DATA ?? process.env.HOME + "/Library/Application Support/fd-memory");
  runMigration(dataDir, dryRun);
}
