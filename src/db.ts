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
        path TEXT PRIMARY KEY, project TEXT, type TEXT, title TEXT, body TEXT, updated_at TEXT,
        sources TEXT NOT NULL DEFAULT '[]', supersedes TEXT NOT NULL DEFAULT '[]'
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
      CREATE TABLE IF NOT EXISTS page_vectors (
        page_rel TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS distill_state (
        project TEXT PRIMARY KEY, obs_cursor INTEGER NOT NULL DEFAULT 0,
        handoff_cursor TEXT NOT NULL DEFAULT '', note_cursor TEXT NOT NULL DEFAULT '',
        updated_at TEXT,
        last_error TEXT, last_tokens INTEGER NOT NULL DEFAULT 0,
        gaps INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        pending_since INTEGER
      );
    `);
    // Pre-v2 databases: observations had no project column (the root was one
    // agent's), handoffs had no to_agent. Those rows belong to the agent's own
    // project as resolved at migration time; 'default' matches the v1 wiki
    // layout the migration script moves. Distiller (add-memory-distiller)
    // adds sources/supersedes to the pages index for layer/sources reads.
    const obsCols = this.columnsOf("observations");
    if (!obsCols.has("project")) {
      this.db.exec("ALTER TABLE observations ADD COLUMN project TEXT NOT NULL DEFAULT 'default'");
    }
    const handoffCols = this.columnsOf("handoffs");
    if (!handoffCols.has("to_agent")) {
      this.db.exec("ALTER TABLE handoffs ADD COLUMN to_agent TEXT");
    }
    const pageCols = this.columnsOf("pages");
    if (!pageCols.has("sources")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'");
    }
    if (!pageCols.has("supersedes")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]'");
    }
    // u-root distillation (add-u-root-distillation): notes ride their own
    // string cursor (updated_at), mirroring handoff_cursor.
    const dsCols = this.columnsOf("distill_state");
    if (!dsCols.has("note_cursor")) {
      this.db.exec("ALTER TABLE distill_state ADD COLUMN note_cursor TEXT NOT NULL DEFAULT ''");
    }
  }

  close(): void {
    this.db.close();
  }

  // -- pages / FTS -----------------------------------------------------------

  indexPage(project: string, relPath: string, type: string, title: string, body: string, meta?: { sources?: string[]; supersedes?: string[] }): void {
    const sources = JSON.stringify(meta?.sources ?? []);
    const supersedes = JSON.stringify(meta?.supersedes ?? []);
    this.db.prepare(
      `INSERT INTO pages (path, project, type, title, body, updated_at, sources, supersedes) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET project=excluded.project, type=excluded.type,
         title=excluded.title, body=excluded.body, updated_at=excluded.updated_at,
         sources=excluded.sources, supersedes=excluded.supersedes`,
    ).run(relPath, project, type, title ?? "", body ?? "", new Date().toISOString(), sources, supersedes);
    this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("INSERT INTO pages_fts (title, body, path, project, updated_at) VALUES (?,?,?,?,?)")
      .run(title ?? "", body ?? "", relPath, project, new Date().toISOString());
  }

  deletePageIndex(relPath: string): void {
    this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("DELETE FROM pages WHERE path=?").run(relPath);
  }

  searchPages(query: string, limit = 20, projects: string[] | null = null): Array<{ path: string; title: string; snippet: string; project: string; type: string; sources: string }> {
    const pf = projectFilterSql(projects, "p.project");
    const fts = (() => {
      try {
        return this.db
          .prepare(
            `SELECT p.path AS path, p.title AS title, p.project AS project, p.type AS type, p.sources AS sources, snippet(pages_fts, 1, '[', ']', '…', 12) AS snip
             FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
             WHERE pages_fts MATCH ?${pf.clause} ORDER BY rank LIMIT ?`,
          )
          .all(this.ftsQuery(query), ...pf.args, limit) as Array<{ path: string; title: string; project: string; type: string; sources: string; snippet: string }>;
      } catch {
        return [];
      }
    })();
    let rows: Array<{ path: string; title: string; project: string; type: string; sources: string; snippet: string }> = fts;
    if (rows.length === 0) {
      // trigram needs >=3 chars; fall back to LIKE for shorter queries
      const pfq = projectFilterSql(projects, "project");
      rows = (
        this.db
          .prepare(
            `SELECT path, title, project, type, sources, substr(body, max(1, instr(lower(body), lower(?)) - 40), 120) AS snippet
             FROM pages WHERE title LIKE ? OR body LIKE ?${pfq.clause} LIMIT ${Math.max(1, limit | 0)}`,
          )
          .all(query, `%${query}%`, `%${query}%`, ...pfq.args) as unknown as Array<{ path: string; title: string; project: string; type: string; sources: string; snippet: string }>
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
          `SELECT project || '/' || session_id || '/' || event AS path, coalesce(tool, event) AS title, project, 'observation' AS type, '[]' AS sources,
             substr(summary, max(1, instr(lower(summary), lower(?)) - 40), 120) AS snippet
           FROM observations WHERE (summary LIKE ? OR tool LIKE ?)${pfo.clause} LIMIT ${Math.max(1, limit | 0)}`,
        )
        .all(query, `%${query}%`, `%${query}%`, ...pfo.args) as unknown as Array<{ path: string; title: string; project: string; type: string; sources: string; snippet: string }>
    );
    return [...rows, ...obs].slice(0, limit);
  }

  private ftsQuery(q: string): string {
    return `"${q.replace(/"/g, '""')}"`;
  }

  recentPages(limit = 20, projects: string[] | null = null): Array<{ path: string; title: string; updated_at: string; project: string; type: string; sources: string; supersedes: string }> {
    const pf = projectFilterSql(projects, "f.project");
    return this.db
      .prepare(`SELECT f.path, f.title, f.updated_at, f.project, p.type, p.sources, p.supersedes FROM pages_fts f JOIN pages p ON p.path = f.path${pf.clause ? " WHERE 1=1" + pf.clause : ""} ORDER BY f.updated_at DESC LIMIT ?`)
      .all(...pf.args, limit) as unknown as Array<{ path: string; title: string; updated_at: string; project: string; type: string; sources: string; supersedes: string }>;
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

  // -- distill state (add-memory-distiller) -----------------------------------

  getDistillState(project: string): { project: string; obs_cursor: number; handoff_cursor: string; note_cursor: string; updated_at: string | null; last_error: string | null; last_tokens: number; gaps: number; next_attempt_at: number; pending_since: number | null } | undefined {
    return this.db.prepare("SELECT * FROM distill_state WHERE project=?").get(project) as never;
  }

  upsertDistillState(project: string, patch: { obs_cursor?: number; handoff_cursor?: string; note_cursor?: string; last_error?: string | null; last_tokens?: number; gaps?: number; next_attempt_at?: number; pending_since?: number | null }): void {
    const cur = this.getDistillState(project) ?? { project, obs_cursor: 0, handoff_cursor: "", note_cursor: "", updated_at: null, last_error: null, last_tokens: 0, gaps: 0, next_attempt_at: 0, pending_since: null };
    const next = {
      ...cur,
      ...patch,
      project,
      updated_at: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO distill_state (project, obs_cursor, handoff_cursor, note_cursor, updated_at, last_error, last_tokens, gaps, next_attempt_at, pending_since)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project) DO UPDATE SET obs_cursor=excluded.obs_cursor, handoff_cursor=excluded.handoff_cursor, note_cursor=excluded.note_cursor,
         updated_at=excluded.updated_at, last_error=excluded.last_error, last_tokens=excluded.last_tokens,
         gaps=excluded.gaps, next_attempt_at=excluded.next_attempt_at, pending_since=excluded.pending_since`,
    ).run(next.project, next.obs_cursor, next.handoff_cursor, next.note_cursor, next.updated_at, next.last_error, next.last_tokens, next.gaps, next.next_attempt_at, next.pending_since);
  }

  // /digest L1 segment (2026-10-26 benchmark): a type-blind recentPages window
  // loses notes whenever fresh L2/handoff pages churn above them — query the
  // type directly so note recall never depends on other page kinds' activity.
  recentNotes(project: string, limit = 5): Array<{ path: string; title: string; body: string; updated_at: string }> {
    return this.db
      .prepare("SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' ORDER BY updated_at DESC LIMIT ?")
      .all(project, limit) as never;
  }

  // Query-matched note recall (2026-10-26 iteration): notes are only ever
  // recency-ranked — anything older than rank-5 is invisible until distillation
  // catches up (lossy + latent). Score title+body against the same terms rules
  // as the L2 keyword path; returns matched notes with scores (ties by recency).
  queryNotes(project: string, queryFor: string, limit = 3): Array<{ path: string; title: string; body: string; updated_at: string; score: number }> {
    const rows = this.db
      .prepare("SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' ORDER BY updated_at DESC LIMIT 200")
      .all(project) as Array<{ path: string; title: string; body: string | null; updated_at: string }>;
    const terms = String(queryFor ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2);
    if (terms.length === 0) return rows.slice(0, limit).map((r) => ({ ...r, body: r.body ?? "", score: 0 }));
    const out = rows
      .map((r) => {
        const hay = `${r.title} ${String(r.body ?? "")}`.toLowerCase();
        let score = 0;
        for (const t of terms) if (hay.includes(t)) score++;
        return { ...r, body: r.body ?? "", score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || (a.updated_at < b.updated_at ? 1 : -1));
    return out.slice(0, limit);
  }

  // u-root distillation (add-u-root-distillation): note pages as distill
  // inputs, cursor = updated_at ISO string (same shape as handoff_cursor);
  // forget/excluded rows drop out of the pages index so they never re-enter.
  notesAfter(project: string, cursor: string, limit = 120): Array<{ path: string; title: string; body: string; updated_at: string }> {
    return this.db
      .prepare("SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' AND updated_at>? ORDER BY updated_at LIMIT ?")
      .all(project, cursor, limit) as never;
  }

  distinctProjects(): string[] {
    return (this.db.prepare("SELECT DISTINCT project FROM pages WHERE project IS NOT NULL").all() as Array<{ project: string }>).map((r) => r.project);
  }

  observationsAfter(project: string, cursor: number, limit = 500): ObservationRow[] {
    return this.db
      .prepare("SELECT session_id, agent, event, tool, summary, created_at, project, rowid AS rid FROM observations WHERE project=? AND rowid>? ORDER BY rowid LIMIT ?")
      .all(project, cursor, limit) as unknown as Array<ObservationRow & { rid: number }> as never;
  }

  maxObservationRowid(project: string): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM observations WHERE project=?").get(project) as { m: number };
    return Number(r.m);
  }

  // -- page vectors (add-embedding-recall) ------------------------------------
  // Companion store like FTS: derived, droppable, never part of the markdown
  // truth. Written with distill pages, deleted with them (forget/drop).

  setPageVector(pageRel: string, model: string, vector: Float32Array): void {
    this.db.prepare(
      `INSERT INTO page_vectors (page_rel, model, dim, vector) VALUES (?,?,?,?)
       ON CONFLICT(page_rel) DO UPDATE SET model=excluded.model, dim=excluded.dim, vector=excluded.vector`,
    ).run(pageRel, model, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }

  // Full-scan vector read (2026-10-26 recall-cap fix): the hybrid path used to
  // score ONLY keyword-recalled candidates, which silently demoted the vector
  // lane to a re-ranker of keyword hits — anything keyword missed was
  // unreachable no matter how close its embedding. Scan every vector of the
  // query's model instead (page count is small: tens to low hundreds).
  allPageVectors(model: string): Array<{ page_rel: string; vector: Float32Array }> {
    const rows = this.db.prepare("SELECT page_rel, vector, dim FROM page_vectors WHERE model=?").all(model) as Array<{ page_rel: string; vector: Buffer; dim: number }>;
    return rows.map((r) => {
      const buf = r.vector;
      const out = new Float32Array(r.dim);
      for (let i = 0; i < r.dim; i++) out[i] = buf.readFloatLE(i * 4);
      return { page_rel: r.page_rel, vector: out };
    });
  }

  getPageVector(pageRel: string): { model: string; vector: Float32Array } | undefined {
    const row = this.db.prepare("SELECT model, dim, vector FROM page_vectors WHERE page_rel=?").get(pageRel) as { model: string; dim: number; vector: Buffer } | undefined;
    if (!row) return undefined;
    const buf = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim);
    return { model: row.model, vector: new Float32Array(buf) };
  }

  dropPageVector(pageRel: string): void {
    this.db.prepare("DELETE FROM page_vectors WHERE page_rel=?").run(pageRel);
  }

  vectorModelCounts(): Array<{ model: string; n: number }> {
    return this.db.prepare("SELECT model, COUNT(*) AS n FROM page_vectors GROUP BY model").all() as Array<{ model: string; n: number }>;
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
    let forgotten = 0;
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
          // forgotten pages stay out of every derived read face (their markdown
          // truth and audit rows remain) — reindex must respect that.
          if (page.frontmatter.forgotten_at) { forgotten++; continue; }
          const meta = {
            sources: Array.isArray(page.frontmatter.sources) ? (page.frontmatter.sources as string[]) : [],
            supersedes: Array.isArray(page.frontmatter.supersedes) ? (page.frontmatter.supersedes as string[]) : [],
          };
          this.indexPage(project, rel, String(page.frontmatter.type ?? "note"), String(page.frontmatter.title ?? entry), page.body, meta);
          count++;
        }
      }
    };
    walk(wikiDir);
    if (forgotten > 0) console.log(`[fd-memory] reindex: skipped ${forgotten} forgotten page(s)`);
    return count;
  }
}
