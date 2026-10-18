// Token families: deployment tokens (bound to exactly one d/ namespace) and
// person tokens (bound to one u/ root). Hashed at rest with a pepper; lookup
// per request so revocation is immediate (no cache grace).

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TokenRecord {
  id: string;
  kind: "deployment" | "person";
  namespace: string; // d/<packId>/<agentId> | u/<user>
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  label: string | null;
}

export interface Scope {
  tokenId: string;
  kind: "deployment" | "person";
  namespace: string;
}

function hash(token: string, pepper: string): string {
  return createHash("sha256").update(token + ":" + pepper).digest("hex");
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
      )`,
    );
  }

  mint(kind: "deployment" | "person", namespace: string, label?: string): { token: string; id: string } {
    const token = "fdm_" + randomBytes(24).toString("hex");
    const id = randomBytes(8).toString("hex");
    this.db
      .prepare("INSERT INTO tokens (id, kind, namespace, token_hash, created_at, label) VALUES (?,?,?,?,?,?)")
      .run(id, kind, namespace, hash(token, this.pepper), new Date().toISOString(), label ?? null);
    return { token, id };
  }

  verify(token: string): Scope | null {
    const row = this.db
      .prepare("SELECT id, kind, namespace, revoked_at FROM tokens WHERE token_hash=?")
      .get(hash(token, this.pepper)) as (Omit<TokenRecord, "token_hash" | "created_at" | "label"> & { kind: string }) | undefined;
    if (!row || row.revoked_at) return null;
    return { tokenId: row.id, kind: row.kind as "deployment" | "person", namespace: row.namespace };
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

// namespace -> { rootKey, project }
// u/<user>/p/<project> => root "u-<user>", project "<project>"
// d/<packId>/<agentId> => root "d-<packId>--<agentId>", project "default"
export function namespaceParts(ns: string): { rootKey: string; project: string } {
  if (ns.startsWith("u/")) {
    const rest = ns.slice(2); // <user>[/p/<project>]
    const m = rest.match(/^(.+?)(?:\/p\/(.+))?$/);
    const user = m![1];
    return { rootKey: "u-" + user, project: m![2] ?? "default" };
  }
  const parts = ns.slice(2).split("/");
  return { rootKey: "d-" + parts[0] + "--" + (parts[1] ?? "default"), project: "default" };
}

export function scopeAllowsNamespace(scope: Scope, ns: string): boolean {
  if (scope.kind === "deployment") return ns === scope.namespace;
  // person scope: anything under their u/<user> root
  return ns === scope.namespace || ns.startsWith(scope.namespace + "/");
}
