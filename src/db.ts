// Per-root derived SQLite index. Rebuildable from the wiki tree at any time
// (`reindex`); the markdown files remain the byte-level truth.

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
}

export interface HandoffRow {
  id: string;
  project: string;
  from_agent: string;
  summary: string;
  open_questions: string;
  next_steps: string;
  files_touched: string;
  state: "open" | "claimed" | "cancelled";
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

export class RootDb {
  readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        path TEXT PRIMARY KEY, project TEXT, type TEXT, title TEXT, body TEXT, updated_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, body, path UNINDEXED, project UNINDEXED, updated_at UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent TEXT, event TEXT,
        tool TEXT, summary TEXT, created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS obs_session ON observations(session_id);
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY, project TEXT, from_agent TEXT, summary TEXT,
        open_questions TEXT, next_steps TEXT, files_touched TEXT,
        state TEXT NOT NULL DEFAULT 'open', accepted_by TEXT, accepted_at TEXT, created_at TEXT
      );
    `);
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

  searchPages(query: string, limit = 20): Array<{ path: string; title: string; snippet: string }> {
    const fts = (() => {
      try {
        return this.db
          .prepare(
            `SELECT p.path AS path, p.title AS title, snippet(pages_fts, 1, '[', ']', '…', 12) AS snip
             FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
             WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(this.ftsQuery(query), limit) as Array<{ path: string; title: string; snippet: string }>;
      } catch {
        return [];
      }
    })();
    if (fts.length > 0) return fts;
    // trigram needs >=3 chars; fall back to LIKE for shorter queries
    return (
      this.db
        .prepare(
          `SELECT path, title, substr(body, max(1, instr(lower(body), lower(?)) - 40), 120) AS snippet
           FROM pages WHERE title LIKE ? OR body LIKE ? LIMIT ${Math.max(1, limit | 0)}`,
        )
        .all(query, `%${query}%`, `%${query}%`) as unknown as Array<{ path: string; title: string; snippet: string }>
    );
  }

  private ftsQuery(q: string): string {
    return `"${q.replace(/"/g, '""')}"`;
  }

  recentPages(limit = 20): Array<{ path: string; title: string; updated_at: string }> {
    return this.db
      .prepare("SELECT path, title, updated_at FROM pages_fts ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as Array<{ path: string; title: string; updated_at: string }>;
  }

  // -- observations ----------------------------------------------------------

  addObservation(o: ObservationRow): void {
    this.db.prepare(
      "INSERT INTO observations (session_id, agent, event, tool, summary, created_at) VALUES (?,?,?,?,?,?)",
    ).run(o.session_id, o.agent, o.event, o.tool ?? null, o.summary, o.created_at);
  }

  observationsForSession(sessionId: string): ObservationRow[] {
    return this.db
      .prepare("SELECT session_id, agent, event, tool, summary, created_at FROM observations WHERE session_id=? ORDER BY id")
      .all(sessionId) as unknown as ObservationRow[];
  }

  recentObservations(limit = 50): ObservationRow[] {
    return this.db
      .prepare("SELECT session_id, agent, event, tool, summary, created_at FROM observations ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as ObservationRow[];
  }

  // -- handoffs --------------------------------------------------------------

  upsertHandoff(h: HandoffRow): void {
    this.db.prepare(
      `INSERT INTO handoffs (id, project, from_agent, summary, open_questions, next_steps, files_touched, state, accepted_by, accepted_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, open_questions=excluded.open_questions,
         next_steps=excluded.next_steps, files_touched=excluded.files_touched, state=excluded.state,
         accepted_by=excluded.accepted_by, accepted_at=excluded.accepted_at`,
    ).run(h.id, h.project, h.from_agent, h.summary, h.open_questions, h.next_steps, h.files_touched, h.state, h.accepted_by, h.accepted_at, h.created_at);
  }

  getHandoff(id: string): HandoffRow | undefined {
    return this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as HandoffRow | undefined;
  }

  openHandoffs(): HandoffRow[] {
    return this.db.prepare("SELECT * FROM handoffs WHERE state='open' ORDER BY created_at").all() as unknown as HandoffRow[];
  }

  // -- reindex ---------------------------------------------------------------

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
