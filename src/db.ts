// Per-root derived SQLite index. Rebuildable from the wiki tree at any time
// (`reindex`); the markdown files remain the byte-level truth.
//
// v2 (add-memory-scopes-and-cluster-sharing): one root hosts many projects
// (pack members + the shared area), so every read face takes a project set
// and observations carry the project they landed in.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { readPageFile } from "./okf.js";

export interface ObservationRow {
  session_id: string;
  agent: string;
  event: string;
  tool: string | null;
  summary: string;
  created_at: string;
  project?: string;
}

export interface HandoffRow {
  id: string;
  project: string;
  from_agent: string;
  summary: string;
  open_questions: string;
  next_steps: string;
  files_touched: string;
  to_agent: string | null;
  state: "open" | "claimed" | "cancelled";
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface WriteRow {
  ts: string;
  principal: string;
  scope: string;
  page_rel: string;
  op: string;
}

function projectFilterSql(projects: string[] | null, column: string): { clause: string; args: string[] } {
  if (!projects || projects.length === 0) return { clause: "", args: [] };
  return { clause: ` AND ${column} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(projects)] };
}

export class RootDb {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private columnsOf(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        path TEXT PRIMARY KEY, project TEXT, type TEXT, title TEXT, body TEXT, updated_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, body, path UNINDEXED, project UNINDEXED, updated_at UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent TEXT, event TEXT,
        tool TEXT, summary TEXT, created_at TEXT, project TEXT NOT NULL DEFAULT 'default'
      );
      CREATE INDEX IF NOT EXISTS obs_session ON observations(session_id);
      CREATE TABLE IF NOT EXISTS hook_dedupe (
        ingest_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (ingest_key, session_id, event)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY, project TEXT, from_agent TEXT, summary TEXT,
        open_questions TEXT, next_steps TEXT, files_touched TEXT, to_agent TEXT,
        state TEXT NOT NULL DEFAULT 'open', accepted_by TEXT, accepted_at TEXT, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS writes (
        ts TEXT, principal TEXT, scope TEXT, page_rel TEXT, op TEXT
      );
      CREATE INDEX IF NOT EXISTS writes_ts ON writes(ts);
    `);
    // Pre-v2 databases: observations had no project column (the root was one
    // agent's), handoffs had no to_agent. Those rows belong to the agent's own
    // project as resolved at migration time; 'default' matches the v1 wiki
    // layout the migration script moves.
    const obsCols = this.columnsOf("observations");
    if (!obsCols.has("project")) {
      this.db.exec("ALTER TABLE observations ADD COLUMN project TEXT NOT NULL DEFAULT 'default'");
    }
    const handoffCols = this.columnsOf("handoffs");
    if (!handoffCols.has("to_agent")) {
      this.db.exec("ALTER TABLE handoffs ADD COLUMN to_agent TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  // -- pages / FTS -----------------------------------------------------------

  indexPage(project: string, relPath: string, type: string, title: string, body: string): void {
    this.db.prepare(
      `INSERT INTO pages (path, project, type, title, body, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET project=excluded.project, type=excluded.type,
         title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`,
    ).run(relPath, project, type, title ?? "", body ?? "", new Date().toISOString());
    this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("INSERT INTO pages_fts (title, body, path, project, updated_at) VALUES (?,?,?,?,?)")
      .run(title ?? "", body ?? "", relPath, project, new Date().toISOString());
  }

  deletePageIndex(relPath: string): void {
    this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("DELETE FROM pages WHERE path=?").run(relPath);
  }

  searchPages(query: string, limit = 20, projects: string[] | null = null): Array<{ path: string; title: string; snippet: string; project: string }> {
    const pf = projectFilterSql(projects, "p.project");
    const fts = (() => {
      try {
        return this.db
          .prepare(
            `SELECT p.path AS path, p.title AS title, p.project AS project, snippet(pages_fts, 1, '[', ']', '…', 12) AS snip
             FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
             WHERE pages_fts MATCH ?${pf.clause} ORDER BY rank LIMIT ?`,
          )
          .all(this.ftsQuery(query), ...pf.args, limit) as Array<{ path: string; title: string; project: string; snippet: string }>;
      } catch {
        return [];
      }
    })();
    let rows: Array<{ path: string; title: string; project: string; snippet: string }> = fts;
    if (rows.length === 0) {
      // trigram needs >=3 chars; fall back to LIKE for shorter queries
      const pfq = projectFilterSql(projects, "project");
      rows = (
        this.db
          .prepare(
            `SELECT path, title, project, substr(body, max(1, instr(lower(body), lower(?)) - 40), 120) AS snippet
             FROM pages WHERE title LIKE ? OR body LIKE ?${pfq.clause} LIMIT ${Math.max(1, limit | 0)}`,
          )
          .all(query, `%${query}%`, `%${query}%`, ...pfq.args) as unknown as Array<{ path: string; title: string; project: string; snippet: string }>
      );
    }
    // observations join the search face (spec: manager-captured observations
    // are searchable) — LIKE scan at v1 scale, FTS promotion later. The
    // synthetic path carries the project prefix so a multi-project root (v2)
    // cannot conflate one member's observations with another's.
    const pfo = projectFilterSql(projects, "project");
    const obs = (
      this.db
        .prepare(
          `SELECT project || '/' || session_id || '/' || event AS path, coalesce(tool, event) AS title, project,
             substr(summary, max(1, instr(lower(summary), lower(?)) - 40), 120) AS snippet
           FROM observations WHERE (summary LIKE ? OR tool LIKE ?)${pfo.clause} LIMIT ${Math.max(1, limit | 0)}`,
        )
        .all(query, `%${query}%`, `%${query}%`, ...pfo.args) as unknown as Array<{ path: string; title: string; project: string; snippet: string }>
    );
    return [...rows, ...obs].slice(0, limit);
  }

  private ftsQuery(q: string): string {
    return `"${q.replace(/"/g, '""')}"`;
  }

  recentPages(limit = 20, projects: string[] | null = null): Array<{ path: string; title: string; updated_at: string; project: string }> {
    const pf = projectFilterSql(projects, "project");
    return this.db
      .prepare(`SELECT path, title, updated_at, project FROM pages_fts${pf.clause ? " WHERE 1=1" + pf.clause : ""} ORDER BY updated_at DESC LIMIT ?`)
      .all(...pf.args, limit) as unknown as Array<{ path: string; title: string; updated_at: string; project: string }>;
  }

  // -- observations ----------------------------------------------------------

  addObservation(o: ObservationRow): void {
    this.db.prepare(
      "INSERT INTO observations (session_id, agent, event, tool, summary, created_at, project) VALUES (?,?,?,?,?,?,?)",
    ).run(o.session_id, o.agent, o.event, o.tool ?? null, o.summary, o.created_at, o.project ?? "default");
  }

  observationsForSession(sessionId: string): ObservationRow[] {
    return this.db
      .prepare("SELECT session_id, agent, event, tool, summary, created_at, project FROM observations WHERE session_id=? ORDER BY id")
      .all(sessionId) as unknown as ObservationRow[];
  }

  recentObservations(limit = 50, projects: string[] | null = null): Array<ObservationRow & { project: string }> {
    const pf = projectFilterSql(projects, "project");
    return this.db
      .prepare(`SELECT session_id, agent, event, tool, summary, created_at, project FROM observations${pf.clause ? " WHERE 1=1" + pf.clause : ""} ORDER BY id DESC LIMIT ?`)
      .all(...pf.args, limit) as unknown as Array<ObservationRow & { project: string }>;
  }

  // -- handoffs --------------------------------------------------------------

  upsertHandoff(h: HandoffRow): void {
    this.db.prepare(
      `INSERT INTO handoffs (id, project, from_agent, summary, open_questions, next_steps, files_touched, to_agent, state, accepted_by, accepted_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, open_questions=excluded.open_questions,
         next_steps=excluded.next_steps, files_touched=excluded.files_touched, to_agent=excluded.to_agent,
         state=excluded.state, accepted_by=excluded.accepted_by, accepted_at=excluded.accepted_at`,
    ).run(h.id, h.project, h.from_agent, h.summary, h.open_questions, h.next_steps, h.files_touched, h.to_agent ?? null, h.state, h.accepted_by, h.accepted_at, h.created_at);
  }

  getHandoff(id: string): HandoffRow | undefined {
    return this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as HandoffRow | undefined;
  }

  openHandoffs(projects: string[] | null = null): HandoffRow[] {
    const pf = projectFilterSql(projects, "project");
    return this.db
      .prepare(`SELECT * FROM handoffs WHERE state='open'${pf.clause} ORDER BY created_at`)
      .all(...pf.args) as unknown as HandoffRow[];
  }

  // -- audit (add-memory-scopes-and-cluster-sharing) --------------------------

  // Companion record, never load-bearing: a failed audit write must not fail
  // the write it describes.
  addWrite(principal: string, scope: string, pageRel: string, op: string): void {
    this.db.prepare("INSERT INTO writes (ts, principal, scope, page_rel, op) VALUES (?,?,?,?,?)")
      .run(new Date().toISOString(), principal, scope, pageRel, op);
  }

  recentWrites(limit = 50): WriteRow[] {
    return this.db
      .prepare("SELECT ts, principal, scope, page_rel, op FROM writes ORDER BY rowid DESC LIMIT ?")
      .all(limit) as unknown as WriteRow[];
  }

  // -- reindex ---------------------------------------------------------------

  // Spool-replay idempotency (add-memory-federation-v1): returns true when
  // this exact hook event has NOT been seen (caller stores), false on replay.
  // Key (ingest_key, session_id, event) WITHOUT a timestamp on purpose: the
  // server receive-time is unstable across spool replays; dropping it makes
  // dedupe a superset of the spec's (…, ts) requirement.
  claimHookEvent(ingestKey: string, sessionId: string, event: string, seenAt: string): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO hook_dedupe (ingest_key, session_id, event, seen_at) VALUES (?,?,?,?)")
      .run(ingestKey, sessionId, event, seenAt);
    return res.changes > 0;
  }

  reindexFromWiki(wikiDir: string): number {
    this.db.exec("DELETE FROM pages");
    this.db.exec("DELETE FROM pages_fts");
    let count = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".md")) {
          const rel = full.slice(wikiDir.length + 1);
          if (entry === "_meta.md" || rel.includes("/_slots/")) continue;
          const project = rel.split(/[\\/]/)[0];
          const page = readPageFile(full);
          this.indexPage(project, rel, String(page.frontmatter.type ?? "note"), String(page.frontmatter.title ?? entry), page.body);
          count++;
        }
      }
    };
    walk(wikiDir);
    return count;
  }
}
