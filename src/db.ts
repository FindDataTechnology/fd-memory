// Per-root derived SQLite index. Rebuildable from the wiki tree at any time
// (`reindex`); the markdown files remain the byte-level truth.
//
// v2 (add-memory-scopes-and-cluster-sharing): one root hosts many projects
// (pack members + the shared area), so every read face takes a project set
// and observations carry the project they landed in.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { readPageFile } from "./okf.js";
import { DOMAIN_KEY_VOCABULARY } from "./policy.js";

/**
 * Identity of one observation as it appears in the append-only log.
 *
 * Retract markers name rows by this digest instead of by rowid: rowids are
 * rebuild artifacts, and the whole point of a marker is that it keeps working
 * after the index has been thrown away and replayed.
 */
export function observationDigest(sessionId: string, summary: string): string {
  return createHash("sha256").update(`${sessionId}\u0000${summary}`).digest("hex").slice(0, 16);
}

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

export interface OversightReadRow {
  ts: string;
  principal: string;
  root_key: string;
  projects: string;
  hits: number;
}

// Structured read filter (add-agent-memory-foundation): metadata key/values
// (array value = contains), a write-time window, and/or a page-type set
// (callers map layer→types; two layerOf variants exist upstream so the DB
// layer does not guess). Absent fields are absent clauses — a filter with no
// fields is no filter.
export interface PageFilter {
  metadata?: Record<string, unknown>;
  since?: string;
  until?: string;
  types?: string[];
}

function projectFilterSql(projects: string[] | null, column: string): { clause: string; args: string[] } {
  if (!projects || projects.length === 0) return { clause: "", args: [] };
  return { clause: ` AND ${column} IN (SELECT value FROM json_each(?))`, args: [JSON.stringify(projects)] };
}

// Metadata predicate pushed into SQL (spec: 筛选下推到查询层，禁渲染层全量过滤).
// Scalar values match by equality; arrays match by containment (any element).
// Missing keys are NULL and never match — a filtered query only ever returns
// pages that explicitly carry the key.
type SqlArg = string | number | null;

// node:sqlite rejects boolean bindings outright (SQLInputValue has no
// boolean) — metadata scalars may be boolean, so the SQL binding normalizes
// them to 1/0. json_extract on JSON `true`/`false` compares 1/0 correctly.
function bindable(v: unknown): SqlArg {
  if (typeof v === "boolean") return v ? 1 : 0;
  return (v ?? null) as SqlArg;
}

function metadataFilterSql(filter: PageFilter | undefined, column: string): { clause: string; args: SqlArg[] } {
  const meta = filter?.metadata;
  if (!meta || typeof meta !== "object") return { clause: "", args: [] };
  let clause = "";
  const args: SqlArg[] = [];
  for (const [key, value] of Object.entries(meta)) {
    const path = `'$.${key.replace(/'/g, "''")}'`;
    if (Array.isArray(value)) {
      clause += ` AND EXISTS (SELECT 1 FROM json_each(json_extract(${column}, ${path})) je WHERE je.value IN (SELECT value FROM json_each(?)))`;
      args.push(JSON.stringify(value));
    } else {
      clause += ` AND json_extract(${column}, ${path}) = ?`;
      args.push(bindable(value));
    }
  }
  return { clause, args };
}

export function pageFilterSql(filter: PageFilter | undefined, projects: string[] | null, projectColumn: string, timeColumn: string, typeColumn?: string): { clause: string; args: SqlArg[] } {
  let clause = projectFilterSql(projects, projectColumn).clause;
  const args: SqlArg[] = projectFilterSql(projects, projectColumn).args;
  if (filter?.since) { clause += ` AND ${timeColumn} >= ?`; args.push(filter.since); }
  if (filter?.until) { clause += ` AND ${timeColumn} <= ?`; args.push(filter.until); }
  if (filter?.types?.length) { clause += ` AND ${typeColumn ?? "type"} IN (SELECT value FROM json_each(?))`; args.push(JSON.stringify(filter.types)); }
  const mf = metadataFilterSql(filter, "metadata");
  return { clause: clause + mf.clause, args: [...args, ...mf.args] };
}

export class RootDb {
  readonly db: DatabaseSync;

  /**
   * Schema version this build expects. Bump it whenever migrate() adds a step
   * that must run again; otherwise an already-migrated database skips the whole
   * write path on open.
   */
    // Bumped to 4 by batch 1 of memory-integration-with-product-lines (usage
  // signal columns). The `columnsOf()` guards below are idempotent, but the
  // whole migrate() short-circuits when the stored version is already current —
  // which it was (3 == 3), so the new ALTERs would never have run on any
  // existing database. Bumping the number is what actually makes them execute.
  static readonly SCHEMA_VERSION = 4;

  /**
   * The closed domain-key vocabulary (add-domain-memory-schema).
   *
   * What this is for: the four memory axes answer "where is it stored / how much
   * does it recall / whose word counts / how is it distilled". None of them
   * answers "what does THIS domain record, and how is it grouped". An investing
   * team wants to gather a review per instrument; a legal team per party. With
   * only the four axes, both teams get identical behaviour and can express the
   * distinction only in free text — and free-text classification was already
   * rejected for `type` (20+ invented lanes, one carrying a whole sentence).
   *
   * Why CLOSED, and why a key can only be added by shipping a release: every key
   * carries an expression index (see migrate()). A distributed artifact that can
   * introduce a key is an artifact that can change the shape of a database it
   * does not own. Same rule as `store.home` accepting only fleet/member/person
   * and refusing every address form.
   *
   * Keys are chosen from domains that already have real packs with a settled
   * write pattern. hotel/flower have pack directories but unmeasured volumes, so
   * they are deliberately absent — adding one later is its own release, which is
   * a reversible step.
   */
  static readonly DOMAIN_KEYS: ReadonlyArray<{ key: string; domain: string }> = [
    { key: "instrument", domain: "invest" },
    { key: "party", domain: "lex" },
    { key: "case_no", domain: "lex" },
    { key: "supplier", domain: "erp" },
    { key: "sku", domain: "erp" },
  ];

  /**
   * The two halves of the domain vocabulary must not drift: `policy.ts` validates
   * a declaration against its copy without importing SQLite, and this table
   * decides which keys are actually indexed. A key accepted by one and unknown to
   * the other would be a declaration that resolves and never participates in
   * recall — the failure mode this whole change exists to remove.
   *
   * Checked at module load, not in a test, because both halves are frozen data
   * and the cost is one comparison per process.
   */
  static {
    const indexed = RootDb.DOMAIN_KEYS.map((d) => d.key).sort();
    const declarable = [...DOMAIN_KEY_VOCABULARY].sort();
    if (JSON.stringify(indexed) !== JSON.stringify(declarable)) {
      throw new Error(
        `domain vocabulary drift: db.ts indexes ${JSON.stringify(indexed)} but policy.ts accepts ${JSON.stringify(declarable)}`,
      );
    }
  }

  /** Is this metadata key a domain key? Unknown keys are ordinary metadata. */
  static isDomainKey(key: string): boolean {
    return RootDb.DOMAIN_KEYS.some((d) => d.key === key);
  }

  /** The domain a key belongs to, or null when the key is not in the vocabulary. */
  static domainOfKey(key: string): string | null {
    return RootDb.DOMAIN_KEYS.find((d) => d.key === key)?.domain ?? null;
  }

  /**
   * Index name for a domain key, in one place because three callers need to
   * agree on it: the migration that creates it, the test that asserts the query
   * plan uses it, and any diagnostic that checks it exists.
   */
  domainIndexName(key: string): string {
    return `pages_domain_${key.replace(/[^a-z0-9_]/gi, "_")}`;
  }

  /**
   * Which domain does this metadata belong to, and which of that domain's keys
   * is it missing? (add-domain-memory-schema)
   *
   * The service does not know which domain a session is in — nothing in the
   * request says "this is the investing team". So the hint is driven by what the
   * caller DID send: the moment metadata carries any key from a domain, that is
   * evidence of intent, and the useful thing to say is which companion keys of
   * the same domain are absent.
   *
   * Ordering matters: DOMAIN_KEYS lists `party` before `case_no`, so a legal
   * page that carries both is matched on `party` and told only that `case_no`
   * is missing — one hint at a time, not a list of everything it could also
   * have carried.
   *
   * Returns null when no domain key is present at all: an ordinary note has no
   * domain and must not be nagged about one.
   */
  /**
   * Which domain keys actually carry this value? (add-domain-memory-schema)
   *
   * Why a reverse lookup and not "remember the key name": the whole point of a
   * domain vocabulary is that a reader asks "what do we have on this thing", not
   * "what is the metadata key for instruments". Forcing the caller to know that
   * it is spelled `instrument` (and not `ticker`/`symbol`/`code`) rebuilds the
   * free-text taxonomy problem one level down.
   *
   * Returns one entry per vocabulary key that has at least one row with this
   * exact value, so a value that happens to be both a party and a case number
   * reports both instead of silently picking one.
   *
   * Counts come from the same expression indexes the recall uses, so this is a
   * cheap probe, not a scan.
   */
  domainKeysForValue(value: string, projects: string[] | null): Array<{ key: string; domain: string; count: number }> {
    const out: Array<{ key: string; domain: string; count: number }> = [];
    // projectFilterSql returns a clause that BEGINS with " AND " (it is built to
    // be appended to "WHERE 1=1"), and an empty string when unscoped. Anchoring
    // on `WHERE 1=1` keeps both cases valid — appending it to a bare `WHERE`
    // produced `WHERE  AND ...`, which is a syntax error, not an empty result.
    const proj = projectFilterSql(projects, "project");
    for (const { key, domain } of RootDb.DOMAIN_KEYS) {
      const path = `'$."${key.replace(/"/g, '""')}"'`;
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM pages WHERE 1=1${proj.clause} AND json_extract(metadata, ${path}) = ?`)
        .get(...(proj.args as never[]), bindable(value)) as { n: number } | undefined;
      const n = Number(row?.n ?? 0);
      if (n > 0) out.push({ key, domain, count: n });
    }
    return out;
  }

  /**
   * How often is each domain key actually filled in? (add-domain-memory-schema)
   *
   * Why this exists: the write-side hint is a REPORT, not a gate — the storage
   * layer never undoes a write for a missing metadata key. A hint nobody can see
   * is indistinguishable from no schema at all, so the missing half is made
   * measurable here instead of being left to good intentions.
   *
   * Denominator is PER DOMAIN, not the whole table. A domain at 100% and another
   * at 0%, averaged together, reads as "50%, not great" — which hides both the
   * team that has adopted it and the one that has never used it. Those are
   * different problems and must not collapse into one number.
   */
  domainFillRates(): Array<{ key: string; domain: string; project: string; filled: number; total: number; rate: number }> {
    // Grouped by (project, domain), not domain alone (2026-11-21).
    //
    // The denominator is "rows carrying ANY key of this domain", which keeps an
    // unrelated note from dragging `case_no` toward 0% forever. But that same
    // definition makes a project that uses NO domain key contribute nothing at
    // all — measured: a project with 100 memories and zero vocabulary coverage
    // plus a project with 2 memories and full coverage reported 100%, i.e. "the
    // vocabulary is doing great" while the busiest project had adopted none of
    // it. That is the exact confusion the spec forbids between domains, one
    // level over.
    //
    // Per project, the honest total is "every page in that project", because the
    // question being asked is "of this project's memories, how many carry the
    // key" — not "of the ones that already carry a key, how many carry this
    // one". The zero-adoption project therefore reports 0/N rather than
    // vanishing.
    const out: Array<{ key: string; domain: string; project: string; filled: number; total: number; rate: number }> = [];
    const domains = [...new Set(RootDb.DOMAIN_KEYS.map((d) => d.domain))];
    const projects = (this.db.prepare("SELECT DISTINCT project FROM pages").all() as Array<{ project: string }>)
      .map((r) => r.project);
    for (const project of projects) {
      const projTotal = Number((this.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE project=?").get(project) as { n: number }).n);
      for (const domain of domains) {
        for (const { key } of RootDb.DOMAIN_KEYS.filter((d) => d.domain === domain)) {
          const path = `'$."${key.replace(/"/g, '""')}"'`;
          const filled = Number((this.db
            .prepare(`SELECT COUNT(*) AS n FROM pages WHERE project=? AND json_extract(metadata, ${path}) IS NOT NULL`)
            .get(project) as { n: number }).n);
          out.push({ key, domain, project, filled, total: projTotal, rate: projTotal > 0 ? filled / projTotal : 0 });
        }
      }
    }
    return out;
  }

  /**
   * The domain key this project's chain actually declares, or null.
   *
   * This is the consumer that makes `schema.key_by` an EXECUTED sub-key rather
   * than a declared-and-ignored one: the write face asks here instead of inferring
   * the domain from whatever metadata the caller happened to send. Resolved
   * through the same project → root chain the process axis uses, so a pack-level
   * declaration reaches its members without every member restating it.
   */
  declaredDomainKey(project: string): string | null {
    const level = this.getMemoryPolicy(project);
    const root = this.getMemoryPolicy("root");
    const value = level.key_by ?? root.key_by;
    if (typeof value !== "string" || !RootDb.isDomainKey(value)) return null;
    return value;
  }

  domainHintFor(meta: Record<string, unknown> | null | undefined, declaredKey?: string | null): { domain: string; present: string[]; missing: string[] } | null {
    // A declared `schema.key_by` says which key this root files under, so the
    // hint stops guessing from whatever the caller happened to include
    // (add-memory-schema-axis). Without a declaration the previous behaviour
    // stands exactly: infer the domain from the first vocabulary key present.
    if (declaredKey) {
      const domain = RootDb.domainOfKey(declaredKey);
      if (domain) {
        const present = RootDb.DOMAIN_KEYS.filter((d) => d.domain === domain && meta && d.key in meta).map((d) => d.key);
        const missing = RootDb.DOMAIN_KEYS.filter((d) => d.domain === domain && !present.includes(d.key)).map((d) => d.key);
        return { domain, present, missing };
      }
      // An unrecognised declaration (a hand-edited row, an older vocabulary) must
      // not be silently treated as "no declaration": that would make the hint
      // describe a different domain than the one in force. Fall through to the
      // inference path and let the read face name the bad value.
    }
    if (!meta) return null;
    const present: string[] = [];
    for (const { key } of RootDb.DOMAIN_KEYS) if (key in meta) present.push(key);
    if (present.length === 0) return null;
    // Attribute the page to the domain of the FIRST vocabulary key it carries —
    // vocabulary order, not metadata key order, so the answer does not depend on
    // how the caller happened to order its JSON.
    const domain = RootDb.domainOfKey(present[0])!;
    const missing = RootDb.DOMAIN_KEYS
      .filter((d) => d.domain === domain && !present.includes(d.key))
      .map((d) => d.key);
    return { domain, present, missing };
  }

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // busy_timeout FIRST, before any statement that could need a write lock.
    // Measured 2026-11-15: with 30 independent processes opening this database
    // simultaneously, migrate() failed with SQLITE_BUSY and StoreRoot
    // construction threw — so the session could not even start. The default
    // (and node:sqlite's) timeout is far too short for multi-process use.
    this.db.exec("PRAGMA busy_timeout = 15000");
    // WAL + NORMAL（2026-11-18 事故）：默认是 journal_mode=delete +
    // synchronous=FULL，每次写事务都要建/删 journal 文件并等磁盘物理落盘。
    // 库涨到 87MB 后，蒸馏写 page 时这个同步提交能把 Node 的事件循环彻底堵死
    // —— 实测 healthz 连续超时、进程 CPU 0.5%/RSS 16MB 不忙，sample 停在
    // sqlite3_step→vdbeCommit→pager_end_transaction→pcache1Truncate。
    //
    // WAL 把写从主库解耦（读不阻塞写、写不阻塞读），NORMAL 只保证 WAL 落盘
    // 而不再每次 fsync 主库——对「单机、进程崩溃可能丢最后几个事务但不会损坏
    // 库」这个场景是正确取舍。WAL 不能用于网络文件系统；本库固定在本机
    // Application Support 下，符合前提。
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    // NOT setting cache_size/mmap_size here (2026-11-18, tried and reverted).
    // Hypothesis was that SQLite's default 2MB page cache explained the
    // "first healthz after a while takes 24s, then 38ms" shape. Measured it:
    // running the same FTS query with and without `cache_size=-16000` +
    // `mmap_size=128MB` gave 0.01–0.03s both ways — no difference outside the
    // noise. The cold read is the OS evicting pages (30% free memory, the
    // 2961M compressor was active), not SQLite's buffer pool. Left here as a
    // recorded negative result so the next person does not try it again.
    this.migrate();
  }

  private columnsOf(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  }

  /**
   * Run the schema migration at most once per database version.
   *
   * Why the version gate: migrate() used to run on EVERY construction, issuing
   * a pile of CREATE TABLE / DELETE statements. That is a write transaction on
   * open, which is fine for one process and fatal for thirty — every session
   * start competed for the write lock. The schema only needs building once, so
   * we record that in a tiny metadata table and skip the rest on subsequent
   * opens.
   */
  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value?: string } | undefined;
    if (row?.value && Number(row.value) >= RootDb.SCHEMA_VERSION) return;

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
      CREATE TABLE IF NOT EXISTS oversight_reads (
        ts TEXT, principal TEXT, root_key TEXT, projects TEXT, hits INTEGER
      );
      CREATE TABLE IF NOT EXISTS page_vectors (
        page_rel TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL
      );
      -- Supersede edges (optimize-yongyi-read-surfaces 3): one row per retired
      -- page, so "is this page still alive" is an index probe instead of a
      -- JSON parse of every page on every read. Derived data: rebuilt by
      -- reindex, droppable, never the truth (the truth stays in frontmatter).
      --
      -- Composite key (2026-11-20). superseded_id is a page_id = the file
      -- basename, which is only unique WITHIN a project. With it as the sole
      -- PRIMARY KEY, the same basename in two projects collided and the second
      -- edge silently replaced the first — measured: a page superseded in
      -- project beta ended up un-retired because project alpha had already
      -- claimed that id. The read face filters by project, so the orphaned
      -- project never matched an edge and kept injecting the retired page.
      CREATE TABLE IF NOT EXISTS superseded_edges (
        superseded_id TEXT NOT NULL, by_path TEXT NOT NULL, project TEXT NOT NULL,
        PRIMARY KEY (superseded_id, project)
      );
      CREATE INDEX IF NOT EXISTS superseded_edges_by ON superseded_edges(by_path);
      CREATE TABLE IF NOT EXISTS tier_proposals (
        project TEXT NOT NULL, page_rel TEXT NOT NULL,
        proposed_tier TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        proposed_by TEXT NOT NULL DEFAULT 'ai', proposed_at TEXT NOT NULL,
        accepted_at TEXT, ignored_at TEXT,
        PRIMARY KEY (project, page_rel)
      );
      CREATE TABLE IF NOT EXISTS distill_state (
        project TEXT PRIMARY KEY, obs_cursor INTEGER NOT NULL DEFAULT 0,
        handoff_cursor TEXT NOT NULL DEFAULT '', note_cursor TEXT NOT NULL DEFAULT '',
        tag_cursor TEXT NOT NULL DEFAULT '', promotion_cursor TEXT NOT NULL DEFAULT '',
        updated_at TEXT,
        last_error TEXT, last_tokens INTEGER NOT NULL DEFAULT 0,
        gaps INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        pending_since INTEGER
      );
      CREATE TABLE IF NOT EXISTS observe_dedupe (
        project TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        page_rel TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (project, idem_key)
      );
      -- Process-axis policy (add-agent-memory-declaration). One row per scope
      -- label inside this root's own DB: 'root' is this root's default, any other
      -- value is a project (member) override. The doc column holds the canonical
      -- JSON from src/policy.ts normalizePolicy — the declaration is the truth, so
      -- the read face can show declared vs effective without inferring intent.
      CREATE TABLE IF NOT EXISTS memory_policy (
        scope TEXT PRIMARY KEY,
        doc TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT
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
    // Unified memory & outputs (add-unified-memory-and-outputs): reference
    // pages carry tags/tier/source_ref — thin index entries for library and
    // output artifacts; bodies never live here.
    if (!pageCols.has("tags")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    if (!pageCols.has("tier")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN tier TEXT NOT NULL DEFAULT 'draft'");
    }
    if (!pageCols.has("source_ref")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN source_ref TEXT");
    }
    // Usage signals (memory-integration-with-product-lines, batch 1).
    //
    // Two counters and one denominator, on purpose:
    //   retrieved_n        — how many times memory_query RETURNED this page to a
    //                        caller. Matching in SQL does not count; use does.
    //   injected_n         — how many times the injection face picked it.
    //   injected_seen_n    — how many candidates that batch had in total.
    //
    // The last column exists because injection sees 50 of 10,049 candidates
    // (measured 2026-11-22, 0.5%). Without the denominator, "was injected" is
    // just "was lucky", and a page written today would outrank a page written
    // three months ago purely by arriving into a smaller pool.
    if (!pageCols.has("retrieved_n")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN retrieved_n INTEGER NOT NULL DEFAULT 0");
    }
    if (!pageCols.has("injected_n")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN injected_n INTEGER NOT NULL DEFAULT 0");
    }
    if (!pageCols.has("injected_seen_n")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN injected_seen_n INTEGER NOT NULL DEFAULT 0");
    }
    // Structured metadata (add-agent-memory-foundation): one JSON column —
    // the markdown frontmatter is the truth, this is the filterable mirror.
    // Expression indexes cover the two high-frequency keys; other keys stay
    // queryable through json_extract without an index.
    if (!pageCols.has("metadata")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN metadata TEXT");
      this.db.exec(`CREATE INDEX IF NOT EXISTS pages_meta_kind ON pages(json_extract(metadata, '$.kind'))`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS pages_meta_member ON pages(json_extract(metadata, '$.memberId'))`);
    }
    // u-root distillation (add-u-root-distillation): notes ride their own
    // string cursor (updated_at), mirroring handoff_cursor.
    const dsCols = this.columnsOf("distill_state");
    if (!dsCols.has("note_cursor")) {
      this.db.exec("ALTER TABLE distill_state ADD COLUMN note_cursor TEXT NOT NULL DEFAULT ''");
    }
    // Unified memory & outputs: tagging-lane cursor for reference pages.
    if (!dsCols.has("tag_cursor")) {
      this.db.exec("ALTER TABLE distill_state ADD COLUMN tag_cursor TEXT NOT NULL DEFAULT ''");
    }
    // Tier promotion lane (add-tier-promotion-candidates): its own cursor so
    // the tagging lane advancing tag_cursor never starves promotion picks.
    if (!dsCols.has("promotion_cursor")) {
      this.db.exec("ALTER TABLE distill_state ADD COLUMN promotion_cursor TEXT NOT NULL DEFAULT ''");
    }
    // Supersede edges (optimize-yongyi-read-surfaces 3): page_id is the
    // basename every supersede list speaks in, so the alive-check is a key
    // lookup instead of a LIKE across the path. Backfilled once from the paths
    // that already exist; reindex rebuilds both columns and the edge table.
    if (!pageCols.has("page_id")) {
      this.db.exec("ALTER TABLE pages ADD COLUMN page_id TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS pages_page_id ON pages(page_id)");
    }
    // Read-face covering index (2026-11-18). Every hot read is
    // `WHERE project=? AND type=? ORDER BY updated_at DESC LIMIT n`
    // (recentNotes/queryNotes/referenceFor/notesAfter). Without an index that
    // is `SCAN pages` + `USE TEMP B-TREE FOR ORDER BY` over ~20k rows whose
    // body column totals ~8MB — measured cold 0.29s vs 0.01s with the index,
    // and the scan runs synchronously on the server's event loop, so it is
    // exactly the `Statement::All → readDbPage → pread` stall that made
    // /healthz time out for minutes (sample, 2026-11-18). The row counts make
    // the waste obvious: `note` is 55 rows, `observation` is 17,948 — the old
    // plan earned its 55 by reading all 20,733.
    // IF NOT EXISTS unconditionally (not inside a column-added branch): the
    // database this matters for already has every column, so a migration
    // gated on "column missing" would never run there.
    this.db.exec("CREATE INDEX IF NOT EXISTS pages_proj_type_updated ON pages(project, type, updated_at DESC)");
    const nullIds = this.db.prepare("SELECT path FROM pages WHERE page_id IS NULL").all() as Array<{ path: string }>;
    if (nullIds.length > 0) {
      const upd = this.db.prepare("UPDATE pages SET page_id=? WHERE path=?");
      for (const row of nullIds) upd.run(this.idOfPath(row.path), row.path);
    }
    // Supersede edge table must key on (id, project), not id alone (2026-11-20).
    // `CREATE TABLE IF NOT EXISTS` cannot change an existing table, and this
    // database already has the single-column version — so migrate explicitly.
    // Detected by inspecting the primary key rather than by schema version, so
    // it also repairs a database whose version marker is already current.
    const edgePk = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='superseded_edges'").get() as { sql?: string } | undefined;
    if (edgePk?.sql && /superseded_id\s+TEXT\s+PRIMARY KEY/i.test(edgePk.sql)) {
      this.db.exec("ALTER TABLE superseded_edges RENAME TO superseded_edges_old");
      this.db.exec(`CREATE TABLE superseded_edges (
        superseded_id TEXT NOT NULL, by_path TEXT NOT NULL, project TEXT NOT NULL,
        PRIMARY KEY (superseded_id, project)
      )`);
      this.db.exec(`INSERT OR IGNORE INTO superseded_edges (superseded_id, by_path, project)
                    SELECT superseded_id, by_path, COALESCE(project, 'default') FROM superseded_edges_old`);
      this.db.exec("DROP TABLE superseded_edges_old");
      this.db.exec("CREATE INDEX IF NOT EXISTS superseded_edges_by ON superseded_edges(by_path)");
      this.rebuildSupersedeEdges();
    }
    // Edge backfill runs only when the table is empty but pages already carry
    // supersede lists — a one-time catch-up for roots that predate the table.
    const edgeCount = this.db.prepare("SELECT COUNT(*) AS n FROM superseded_edges").get() as { n: number };
    if (Number(edgeCount.n) === 0) this.rebuildSupersedeEdges();

    // Domain-key indexes (add-domain-memory-schema).
    //
    // UNCONDITIONAL on purpose. The two older metadata indexes above sit inside
    // `if (!pageCols.has("metadata"))`, which means they never run on any
    // database that already has the column — every live one. They exist here
    // only because some earlier path happened to create them; a fresh open of an
    // already-migrated root silently skips that block. Index creation for the
    // domain vocabulary must not inherit that shape: if a key is in the
    // vocabulary, its index has to exist, and "the column was added long ago" is
    // not a reason to skip.
    //
    // Measured basis (see design D1): with an expression index the same
    // metadata-equality recall is 0.00ms and plans as `SEARCH ... USING INDEX`;
    // without one it is 31.3ms median / 127.3ms p95 because every row in the
    // project pays a json_extract. 1,112ms to build one on 67k rows, so five
    // keys is ~6s, once.
    for (const { key } of RootDb.DOMAIN_KEYS) {
      // The key comes from the constant above, never from input — but quote it
      // the way SQLite expects so a future key with an unusual character cannot
      // turn into a syntax error at migration time.
      //
      // COMPOSITE (project, <expr>), not (<expr>) alone. Every real recall is
      // scoped to a project — a bare key index is never chosen while `project=?`
      // is present, and the planner falls back to pages_proj_type_updated and
      // pays a json_extract per row. Measured on a probe table: `(expr)` alone
      // with `project=?` plans as `SEARCH ... USING INDEX pages_proj_type_updated
      // (project=?)`, i.e. the new index was built and completely ignored. This
      // mirrors pages_proj_type_updated, which also leads with project.
      const path = `'$."${key.replace(/"/g, '""')}"'`;
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${this.domainIndexName(key)} ON pages(project, json_extract(metadata, ${path}))`);
    }
    // Give the planner statistics for the indexes above (add-domain-memory-schema).
    //
    // Measured: without stats, a domain index on a key that is still mostly NULL
    // is simply not chosen — the planner prefers pages_proj_type_updated (or a
    // plain scan) and pays a json_extract per candidate row. `INDEXED BY` proves
    // the index CAN serve the shape, so this is a costing problem, not a
    // definition problem. ANALYZE is what lets the planner cost it correctly
    // once real values start landing.
    //
    // Best-effort: a failure here degrades recall speed, never correctness, and
    // must not abort a migration that already created the indexes.
    try { this.db.exec("ANALYZE"); } catch { /* stats are an optimisation */ }

    // Record the version so the next open skips this whole write path. Done
    // last: a half-finished migration must not be marked complete.
    this.db
      .prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(RootDb.SCHEMA_VERSION));
  }

  // A page id is the file basename without the extension — the vocabulary
  // `supersedes` lists already speak.
  private idOfPath(relPath: string): string {
    const base = String(relPath).split(/[\\/]/).pop() ?? "";
    return base.replace(/\.md$/, "");
  }

  // Rebuild the whole edge table from the pages index (which mirrors
  // frontmatter). Used by reindex, the first-open backfill, and the self-check.
  rebuildSupersedeEdges(): number {
    this.db.exec("DELETE FROM superseded_edges");
    const rows = this.db.prepare("SELECT path, project, supersedes FROM pages WHERE supersedes IS NOT NULL AND supersedes != '[]'").all() as Array<{ path: string; project: string; supersedes: string }>;
    const ins = this.db.prepare("INSERT OR IGNORE INTO superseded_edges (superseded_id, by_path, project) VALUES (?,?,?)");
    let edges = 0;
    for (const r of rows) {
      let ids: string[] = [];
      try { ids = JSON.parse(r.supersedes) as string[]; } catch { continue; }
      for (const id of ids) {
        if (!id) continue;
        ins.run(id, r.path, r.project);
        edges++;
      }
    }
    return edges;
  }

  // Self-check (3.2): the edge table must describe exactly the supersede lists
  // the pages index carries. A short count means the read face hides the wrong
  // pages — fail loudly rather than serve it.
  supersedeEdgeAudit(): { pages_with_supersedes: number; distinct_targets: number; edges: number; ok: boolean } {
    const rows = this.db.prepare("SELECT supersedes FROM pages WHERE supersedes IS NOT NULL AND supersedes != '[]'").all() as Array<{ supersedes: string }>;
    const targets = new Set<string>();
    for (const r of rows) {
      try { for (const id of JSON.parse(r.supersedes) as string[]) if (id) targets.add(id); } catch { /* malformed row: not a target source */ }
    }
    const edges = Number((this.db.prepare("SELECT COUNT(*) AS n FROM superseded_edges").get() as { n: number }).n);
    return { pages_with_supersedes: rows.length, distinct_targets: targets.size, edges, ok: edges === targets.size };
  }

  /**
   * Every vocabulary key must have its index (add-domain-memory-schema).
   *
   * The spec forbids the intermediate state "key is in the vocabulary, index is
   * not" — but the migration creates indexes unconditionally, so nothing
   * actually CHECKS that the two stayed in step. A future key added to
   * DOMAIN_KEYS without the migration running (a stale dist, a hand-edited
   * database, a migration that threw halfway) would leave a key that recalls
   * by full scan and nothing would say so.
   *
   * Returns the keys whose index is missing, so a caller can fail loudly the way
   * supersedeEdgeAudit does, rather than serving a silently-slow read face.
   */
  domainIndexAudit(): { expected: string[]; missing: string[]; ok: boolean } {
    const expected = RootDb.DOMAIN_KEYS.map((d) => this.domainIndexName(d.key));
    const present = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    const missing = expected.filter((n) => !present.has(n));
    return { expected, missing, ok: missing.length === 0 };
  }

  close(): void {
    this.db.close();
  }

  // -- pages / FTS -----------------------------------------------------------

  indexPage(project: string, relPath: string, type: string, title: string, body: string, meta?: { sources?: string[]; supersedes?: string[]; tags?: string[]; tier?: string; source_ref?: string | null; metadata?: Record<string, unknown> | null }): void {
    const sources = JSON.stringify(meta?.sources ?? []);
    const supersedes = JSON.stringify(meta?.supersedes ?? []);
    const tags = JSON.stringify(meta?.tags ?? []);
    const tier = meta?.tier ?? "draft";
    const sourceRef = meta?.source_ref ?? null;
    const metadata = meta?.metadata && Object.keys(meta.metadata).length > 0 ? JSON.stringify(meta.metadata) : null;
    // Read this BEFORE the upsert below: after it, `pages` always holds the
    // path and the "was this an overwrite?" question is unanswerable. Drives
    // whether the FTS row has to be retired first (see the FTS block at the
    // end of this method).
    const existedBefore = this.db.prepare("SELECT 1 FROM pages WHERE path=?").get(relPath) !== undefined;
    this.db.prepare(
      `INSERT INTO pages (path, project, type, title, body, updated_at, sources, supersedes, tags, tier, source_ref, metadata, page_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET project=excluded.project, type=excluded.type,
         title=excluded.title, body=excluded.body, updated_at=excluded.updated_at,
         sources=excluded.sources, supersedes=excluded.supersedes,
         tags=excluded.tags, tier=excluded.tier, source_ref=excluded.source_ref, metadata=excluded.metadata,
         page_id=excluded.page_id`,
    ).run(relPath, project, type, title ?? "", body ?? "", new Date().toISOString(), sources, supersedes, tags, tier, sourceRef, metadata, this.idOfPath(relPath));
    // Supersede edges follow the write (3.1): the row is retired the moment a
    // page names it, in the same transaction-free step the index takes.
    this.db.prepare("DELETE FROM superseded_edges WHERE by_path=?").run(relPath);
    const insEdge = this.db.prepare("INSERT OR IGNORE INTO superseded_edges (superseded_id, by_path, project) VALUES (?,?,?)");
    for (const id of (meta?.supersedes ?? [])) if (id) insEdge.run(String(id), relPath, project);
    // FTS row replacement (2026-11-19). This used to be an unconditional
    // `DELETE FROM pages_fts WHERE path=?`. `path` is an fts5 UNINDEXED column,
    // so that DELETE compiles to `SCAN pages_fts VIRTUAL TABLE INDEX 0:` — a
    // full scan of every indexed row, on EVERY page write, whether or not the
    // path was ever there. Measured on the live 48k-row index: 18–22ms median,
    // p95 over 100ms, versus 0.2ms for the INSERT it guards. Since 88% of write
    // volume is observations whose slug is `randomUUID().slice(0,8)` (physically
    // unrepeatable), the scan almost never found anything to delete.
    //
    // Fix: read the pre-upsert existence from `pages` (a real PRIMARY KEY
    // lookup, 0.002ms) and only pay for the DELETE when this path was already
    // indexed. The probe must happen BEFORE the pages upsert above, because
    // after it the row always exists.
    //
    // Measured on a copy of the live DB: 22.36ms -> 0.06ms median, p95
    // 108.5ms -> 0.45ms. Deliberately NOT the rowid trick: `pages` and
    // `pages_fts` are independent rowid sequences — only 2,906 of 48k rows
    // share both rowid AND path, so deleting by rowid would target the wrong
    // document.
    //
    // Known ceiling: this trades a full scan for a PK lookup, which is only
    // sound while `pages` is the authority for "is this path indexed?" — an
    // FTS row with no matching `pages` row would now survive and gain a
    // sibling instead of being replaced. That state is unreachable by
    // construction (every writer touches `pages` first, and both
    // deletePageIndex and reindexFromWiki drop FTS alongside pages) and
    // measured 0 rows on the live index. If it ever appears, the fix is to
    // convert pages_fts to an external-content table over `pages` and use
    // FTS5's 'delete' command with the OLD row values — that is O(log n) and
    // authoritative. Upgrading to that here would mean a schema migration for
    // a case that cannot currently occur.
    if (existedBefore) this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("INSERT INTO pages_fts (title, body, path, project, updated_at) VALUES (?,?,?,?,?)")
      .run(title ?? "", body ?? "", relPath, project, new Date().toISOString());
  }

  deletePageIndex(relPath: string): void {
    const id = this.idOfPath(relPath);
    this.db.prepare("DELETE FROM pages_fts WHERE path=?").run(relPath);
    this.db.prepare("DELETE FROM pages WHERE path=?").run(relPath);
    // Both directions: this page no longer retires anything, and nothing it
    // used to retire stays hidden (3.1).
    this.db.prepare("DELETE FROM superseded_edges WHERE by_path=?").run(relPath);
    this.db.prepare("DELETE FROM superseded_edges WHERE superseded_id=?").run(id);
  }

  /**
   * Pages written by an importer, keyed by the provenance label the importer
   * stamped into frontmatter metadata (`import:<harness>`).
   *
   * Why the label and not a directory: every import lands in the ordinary
   * `notes/` tree alongside captured pages, so there is no directory to
   * enumerate. The label is the only thing that survives into the index.
   */
  pagesByMetadataSource(labels: string[]): Array<{ path: string; project: string }> {
    if (labels.length === 0) return [];
    const ph = labels.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT path, project FROM pages WHERE json_extract(metadata,'$.source') IN (${ph})`)
      .all(...labels) as unknown as Array<{ path: string; project: string }>;
  }

  /**
   * Drop observation rows written by the given agent labels.
   *
   * This is the INDEX half of a retract; the append-only log keeps the rows and
   * that is deliberate — `replayObservationsFromLog` honours the retract marker
   * written *before* this runs, so a rebuild reproduces the same visible set
   * instead of resurrecting what the user asked to withdraw.
   */
  deleteObservationsByAgent(labels: string[], project?: string): number {
    if (labels.length === 0) return 0;
    const ph = labels.map(() => "?").join(",");
    const r = project
      ? this.db.prepare(`DELETE FROM observations WHERE agent IN (${ph}) AND project=?`).run(...labels, project)
      : this.db.prepare(`DELETE FROM observations WHERE agent IN (${ph})`).run(...labels);
    return Number(r.changes ?? 0);
  }

  /** Projects that still hold observations from these import labels. */
  projectsForAgentLabels(labels: string[]): string[] {
    if (labels.length === 0) return [];
    const ph = labels.map(() => "?").join(",");
    return (this.db
      .prepare(`SELECT DISTINCT project FROM observations WHERE agent IN (${ph})`)
      .all(...labels) as unknown as Array<{ project: string }>).map((r) => r.project);
  }

  /**
   * The rows a retract is about to withdraw, by agent label and project.
   *
   * Returns idENTITY (session_id + summary), never rowid: the marker the retract
   * writes has to keep working after this index is thrown away, and rowids are
   * rebuild artifacts.
   */
  observationsForAgentLabels(labels: string[], project: string): ObservationRow[] {
    if (labels.length === 0) return [];
    const ph = labels.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT session_id, agent, event, tool, summary, created_at, project FROM observations WHERE agent IN (${ph}) AND project=? ORDER BY id`)
      .all(...labels, project) as unknown as ObservationRow[];
  }

  searchPages(query: string, limit = 20, projects: string[] | null = null, filter?: PageFilter, meta?: { total?: number }, opts?: { includeSuperseded?: boolean }): Array<{ path: string; title: string; snippet: string; project: string; type: string; sources: string; metadata?: string | null; _total?: number }> {
    const pf = projectFilterSql(projects, "p.project");
    // mf is the FULL page predicate (project + time + type + metadata) built
    // for the joined columns; pf alone is kept for the observations leg below.
    const mf = pageFilterSql(filter, projects, "p.project", "p.updated_at", "p.type");
    // A metadata/time/type filter only ever constrains PAGES — observations
    // carry none of those columns, so when a filter is present the
    // observations leg drops out entirely (an unfiltered row leaking through
    // would be worse than a smaller result set).
    const hasPageOnlyFilter = Boolean(filter && (filter.metadata || filter.since || filter.until || filter.types?.length));
    const fts = (() => {
      try {
        // `snippet()` and a window function cannot appear in the same statement:
        // SQLite rejects it with "unable to use function snippet in the requested
        // context". Measured 2026-11-22 — the combination threw on EVERY query,
        // `catch` swallowed it, and searchPages silently fell through to the LIKE
        // branch. Result: `memory_query` never used the FTS index at all and every
        // search cost ~2s (a full scan of 89k pages' bodies) while still returning
        // plausible answers, so nothing looked broken.
        //
        // `_total` therefore comes from its own statement below. Two queries is
        // cheaper than one broken one: the count reuses the same MATCH and needs
        // no snippet.
        return this.db
          .prepare(
            `SELECT p.path AS path, p.title AS title, p.project AS project, p.type AS type, p.sources AS sources, p.metadata AS metadata, snippet(pages_fts, 1, '[', ']', '…', 12) AS snippet
             FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
             WHERE pages_fts MATCH ?${mf.clause}${RootDb.aliveSql("p.", opts?.includeSuperseded)} ORDER BY rank LIMIT ?`,
          )
          .all(this.ftsQuery(query), ...mf.args, limit) as Array<{ path: string; title: string; project: string; type: string; sources: string; metadata: string | null; snippet: string }>;
      } catch {
        return [];
      }
    })();
    // True match count for the FTS leg (the window-function trick is unavailable
    // alongside `snippet`, see above). Only computed when the FTS leg produced
    // rows — otherwise the LIKE fallback owns the count.
    let ftsTotal = 0;
    if (fts.length > 0) {
      try {
        ftsTotal = Number((this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM pages_fts f JOIN pages p ON p.rowid = f.rowid
             WHERE pages_fts MATCH ?${mf.clause}${RootDb.aliveSql("p.", opts?.includeSuperseded)}`,
          )
          .get(this.ftsQuery(query), ...mf.args) as { c: number }).c);
      } catch {
        ftsTotal = fts.length;
      }
    }
    let rows: Array<{ path: string; title: string; project: string; type: string; sources: string; metadata: string | null; snippet: string }> = fts;
    if (rows.length === 0) {
      // trigram needs >=3 chars; fall back to LIKE for shorter queries
      const pfq = pageFilterSql(filter, projects, "project", "updated_at", "type");
      rows = (
        this.db
          .prepare(
            `SELECT path, title, project, type, sources, metadata, substr(body, max(1, instr(lower(body), lower(?)) - 40), 120) AS snippet, COUNT(*) OVER () AS _total
             FROM pages WHERE (title LIKE ? OR body LIKE ?)${pfq.clause}${RootDb.aliveSql("", opts?.includeSuperseded)} LIMIT ${Math.max(1, limit | 0)}`,
          )
          .all(query, `%${query}%`, `%${query}%`, ...pfq.args) as unknown as Array<{ path: string; title: string; project: string; type: string; sources: string; metadata: string | null; snippet: string; _total: number }>
      );
    }
    // FTS rows carry no `_total` (see the comment above the query); the LIKE
    // fallback still uses the window function, which is legal there because it
    // has no `snippet()` in the projection.
    const pagesTotal = fts.length > 0
      ? ftsTotal
      : rows.length ? Number((rows[0] as { _total?: number })._total ?? rows.length) : 0;
    if (hasPageOnlyFilter) {
      if (meta) meta.total = pagesTotal;
      const out = rows.slice(0, limit);
      this.notePagesRetrieved(out.map((r) => String((r as { path: string }).path)));
      return out;
    }
    // observations join the search face (spec: manager-captured observations
    // are searchable) — LIKE scan at v1 scale, FTS promotion later. The
    // synthetic path carries the project prefix so a multi-project root (v2)
    // cannot conflate one member's observations with another's.
    const pfo = projectFilterSql(projects, "project");
    const obs = (
      this.db
        .prepare(
          `SELECT project || '/' || session_id || '/' || event AS path, coalesce(tool, event) AS title, project, 'observation' AS type, '[]' AS sources, NULL AS metadata,
             substr(summary, max(1, instr(lower(summary), lower(?)) - 40), 120) AS snippet, COUNT(*) OVER () AS _total
           FROM observations WHERE (summary LIKE ? OR tool LIKE ?)${pfo.clause} LIMIT ${Math.max(1, limit | 0)}`,
        )
        .all(query, `%${query}%`, `%${query}%`, ...pfo.args) as unknown as Array<{ path: string; title: string; project: string; type: string; sources: string; metadata: string | null; snippet: string; _total: number }>
    );
    if (meta) meta.total = pagesTotal + (obs.length ? Number(obs[0]._total ?? obs.length) : 0);

    // 真结论优先于工具流水（2026-11-16 实测）：观测页是 hook 自动抓的
    // `tool_call Bash: kubectl …`，它们数量多、正文短、词频高，在纯相关度
    // 排序下会盖过 note（提炼过的结论）。调用方问「权限」要的是「读权限
    // MUST NOT 覆盖写与拍板」这类判据，不是某次 kubectl 的输出。
    //
    // 排序规则：note 页在前（保持各自内部的相关度次序），observation 在后。
    // 不做成硬过滤——观测仍是合法证据，只是不该排第一。
    const isNote = (t: string) => t !== "observation";
    const pageNotes = rows.filter((r) => isNote(r.type));
    const pageObs = rows.filter((r) => !isNote(r.type));
    const out = [...pageNotes, ...pageObs, ...obs].slice(0, limit);
    // Count only what actually survived the merge+slice AND lives in `pages`.
    // The observation leg is a synthesized path (`project/session/event`) with no
    // row in `pages`, so bumping it would silently do nothing — and counting the
    // whole `rows` before the slice would credit pages the caller never saw.
    const pagePaths = new Set(rows.map((r) => String((r as { path: string }).path)));
    this.notePagesRetrieved(out.map((r) => String((r as { path: string }).path)).filter((p) => pagePaths.has(p)));
    return out;
  }

  // Alive predicate (optimize-yongyi-read-surfaces 3.3): one definition of
  // "retired" for every read face. A page named by any live supersede list is
  // history — the digest already hid it, while search/recent still served it.
  // `includeSuperseded` is the explicit history opt-in.
  private static aliveSql(alias: string, includeSuperseded?: boolean): string {
    return includeSuperseded ? "" : ` AND ${alias}page_id NOT IN (SELECT superseded_id FROM superseded_edges)`;
  }

  private ftsQuery(q: string): string {
    return `"${q.replace(/"/g, '""')}"`;
  }

  /**
   * Record that these pages were actually handed to a caller (batch 1 of
   * memory-integration-with-product-lines).
   *
   * "Returned", not "matched": a row the SQL touched but the caller never saw is
   * not a use. Callers pass the final result array, which is exactly the set the
   * caller received.
   *
   * Best-effort and never throws — a counter is a companion record; it must not
   * be able to fail the search it describes.
   */
  notePagesRetrieved(paths: string[]): void {
    if (paths.length === 0) return;
    try {
      const stmt = this.db.prepare("UPDATE pages SET retrieved_n = retrieved_n + 1 WHERE path = ?");
      this.db.exec("BEGIN");
      try {
        for (const p of paths) stmt.run(p);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } catch {
      /* usage counters are advisory; a failed bump must not break the read */
    }
  }

  /**
   * Injection half of the usage signal (batch 1 of
   * memory-integration-with-product-lines).
   *
   * Keyed by `page_id`, not `path`, because that is what the injection query
   * already selects (`COALESCE(page_id, path)`) and injection rows do not carry
   * a stable path. Both columns live on `pages`, so the UPDATE is equally cheap.
   *
   * `poolSize` is the candidate count that batch competed in. The per-page
   * counters only become comparable across time when the denominator is stored
   * alongside them — see the schema comment.
   *
   * Best-effort: never throws.
   */
  notePagesInjected(pageIds: string[], poolSize: number): void {
    const ids = pageIds.filter(Boolean);
    if (ids.length === 0) return;
    try {
      const stmt = this.db.prepare(
        "UPDATE pages SET injected_n = injected_n + 1, injected_seen_n = injected_seen_n + ? WHERE page_id = ?",
      );
      this.db.exec("BEGIN");
      try {
        for (const id of ids) stmt.run(poolSize, id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    } catch {
      /* advisory */
    }
  }

  /**
   * Usage-signal distribution for the operator (batch 1 tasks 1.4/1.5).
   *
   * Reports both halves separately on purpose. Retrieval is sparse and
   * unbiased; injection is dense and biased by the 0.5% budget. Reading only
   * one of them would answer a different question than the operator is asking:
   *   retrieved_n >= 1   — "how much of the store has ever been used"
   *   injected_rate      — "of the times it competed, how often was it picked"
   *
   * `injected_rate` is null (not 0) when the page never competed — 0/0 is
   * "never offered", which is a different fact from "offered and always lost".
   */
  usageSignalStats(): {
    total: number;
    retrieved_at_least_once: number;
    injected_at_least_once: number;
    never_touched: number;
    top_retrieved: Array<{ path: string; retrieved_n: number }>;
  } {
    const total = Number((this.db.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number }).c);
    const retrieved = Number((this.db.prepare("SELECT COUNT(*) AS c FROM pages WHERE retrieved_n > 0").get() as { c: number }).c);
    const injected = Number((this.db.prepare("SELECT COUNT(*) AS c FROM pages WHERE injected_n > 0").get() as { c: number }).c);
    const untouched = Number((this.db.prepare("SELECT COUNT(*) AS c FROM pages WHERE retrieved_n = 0 AND injected_n = 0").get() as { c: number }).c);
    const top = this.db
      .prepare("SELECT path, retrieved_n FROM pages WHERE retrieved_n > 0 ORDER BY retrieved_n DESC LIMIT 10")
      .all() as Array<{ path: string; retrieved_n: number }>;
    return { total, retrieved_at_least_once: retrieved, injected_at_least_once: injected, never_touched: untouched, top_retrieved: top };
  }

  /** Recent pages (see searchPages for the retrieval-counter contract). */  recentPages(limit = 20, projects: string[] | null = null, filter?: PageFilter, meta?: { total?: number }, opts?: { includeSuperseded?: boolean }): Array<{ path: string; title: string; updated_at: string; project: string; type: string; sources: string; supersedes: string; tags: string; tier: string; source_ref: string | null; metadata: string | null; _total?: number }> {
    const mf = pageFilterSql(filter, projects, "f.project", "f.updated_at", "p.type");
    const rows = this.db
      .prepare(`SELECT f.path, f.title, f.updated_at, f.project, p.type, p.sources, p.supersedes, p.tags, p.tier, p.source_ref, p.metadata, COUNT(*) OVER () AS _total FROM pages_fts f JOIN pages p ON p.path = f.path WHERE 1=1${mf.clause}${RootDb.aliveSql("p.", opts?.includeSuperseded)} ORDER BY f.updated_at DESC LIMIT ?`)
      .all(...mf.args, limit) as unknown as Array<{ path: string; title: string; updated_at: string; project: string; type: string; sources: string; supersedes: string; tags: string; tier: string; source_ref: string | null; metadata: string | null; _total: number }>;
    if (meta) meta.total = rows.length ? Number(rows[0]._total ?? rows.length) : 0;
    return rows;
  }

  // Indexed path set for a filter — the digest face's pushdown helper. Its L2
  // retrieval reads the wiki (files), so filtering happens on candidate ids;
  // this query answers "which pages match" in ONE indexed SQL pass so the
  // candidate filter never becomes a full wiki walk.
  filteredPagePaths(projects: string[] | null, filter: PageFilter): Set<string> {
    const mf = pageFilterSql(filter, projects, "project", "updated_at", "type");
    const rows = this.db
      .prepare(`SELECT path FROM pages WHERE 1=1${mf.clause}`)
      .all(...mf.args) as Array<{ path: string }>;
    return new Set(rows.map((r) => r.path));
  }

  // Per-partition counts for the overview face (add-agent-memory-foundation):
  // page count + last write per project, capped by SQL, never a full scan.
  projectStats(projects?: string[]): Array<{ project: string; pages: number; last_write: string | null }> {
    const pf = projectFilterSql(projects && projects.length ? projects : null, "project");
    return this.db
      .prepare(`SELECT project, COUNT(*) AS pages, MAX(updated_at) AS last_write FROM pages WHERE 1=1${pf.clause} GROUP BY project ORDER BY project LIMIT 50`)
      .all(...pf.args) as unknown as Array<{ project: string; pages: number; last_write: string | null }>;
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

  recentObservations(limit = 50, projects: string[] | null = null, since?: string, until?: string, meta?: { total?: number }): Array<ObservationRow & { project: string }> {
    let clause = projectFilterSql(projects, "project").clause;
    const args: SqlArg[] = projectFilterSql(projects, "project").args;
    if (since) { clause += " AND created_at >= ?"; args.push(since); }
    if (until) { clause += " AND created_at <= ?"; args.push(until); }
    const rows = this.db
      .prepare(`SELECT session_id, agent, event, tool, summary, created_at, project, COUNT(*) OVER () AS _total FROM observations WHERE 1=1${clause} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as unknown as Array<ObservationRow & { project: string; _total: number }>;
    if (meta) meta.total = rows.length ? Number(rows[0]._total ?? rows.length) : 0;
    return rows;
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
      // Tie-break on `rowid`, NOT on `id`: handoff ids are randomUUID(), so
      // ordering by id would make the result deterministic without making it
      // newest-first — it would just always be wrong in the same way. `rowid`
      // is SQLite's insertion counter, which is exactly "later is newer".
      // The tie is real: `created_at` is millisecond ISO text, so anyone opening
      // several handoffs in one tick (a fleet round, a batch import, a 30-iteration
      // loop in a test) gets rows whose only declared ordering key is equal, and
      // SQLite may then return them in any order. Observed 2026-11-18 as a
      // ~1-in-6 flake in `mcp tools: handoff list is capped, newest-first`.
      .prepare(`SELECT * FROM handoffs WHERE state='open'${pf.clause} ORDER BY created_at, rowid`)
      .all(...pf.args) as unknown as HandoffRow[];
  }

  // -- memory policy (add-agent-memory-declaration) --------------------------

  /**
   * Read one scope's PERSISTED declaration ({} when nothing was declared).
   *
   * Deliberately returns the raw document, not a resolved policy: resolution
   * needs the whole inheritance chain and the deployment default, and doing it
   * here would bake this version's defaults into storage.
   */
  getMemoryPolicy(scope: string): Record<string, string | number> {
    const row = this.db.prepare("SELECT doc FROM memory_policy WHERE scope=?").get(scope) as
      | { doc?: string }
      | undefined;
    if (!row?.doc) return {};
    try {
      const parsed = JSON.parse(row.doc);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // A corrupt row must not make the whole root unreadable; an empty document
      // resolves to the inherited values, and the write face re-normalizes.
      return {};
    }
  }

  setMemoryPolicy(scope: string, doc: Record<string, string | number>): void {
    this.db
      .prepare(
        `INSERT INTO memory_policy (scope, doc, updated_at) VALUES (?,?,?)
         ON CONFLICT(scope) DO UPDATE SET doc=excluded.doc, updated_at=excluded.updated_at`,
      )
      .run(scope, JSON.stringify(doc), new Date().toISOString());
  }

  deleteMemoryPolicy(scope: string): boolean {
    const res = this.db.prepare("DELETE FROM memory_policy WHERE scope=?").run(scope);
    return Number(res.changes ?? 0) > 0;
  }

  memoryPolicyScopes(): string[] {
    const rows = this.db.prepare("SELECT scope FROM memory_policy").all() as Array<{ scope: string }>;
    return rows.map((r) => r.scope);
  }

  // -- distill state (add-memory-distiller) -----------------------------------

  getDistillState(project: string): { project: string; obs_cursor: number; handoff_cursor: string; note_cursor: string; tag_cursor: string; promotion_cursor: string; updated_at: string | null; last_error: string | null; last_tokens: number; gaps: number; next_attempt_at: number; pending_since: number | null } | undefined {
    return this.db.prepare("SELECT * FROM distill_state WHERE project=?").get(project) as never;
  }

  upsertDistillState(project: string, patch: { obs_cursor?: number; handoff_cursor?: string; note_cursor?: string; tag_cursor?: string; promotion_cursor?: string; last_error?: string | null; last_tokens?: number; gaps?: number; next_attempt_at?: number; pending_since?: number | null }): void {
    const cur = this.getDistillState(project) ?? { project, obs_cursor: 0, handoff_cursor: "", note_cursor: "", tag_cursor: "", promotion_cursor: "", updated_at: null, last_error: null, last_tokens: 0, gaps: 0, next_attempt_at: 0, pending_since: null };
    const next = {
      ...cur,
      ...patch,
      project,
      updated_at: new Date().toISOString(),
    };
    // tag_cursor rides this statement too: the column was added by the
    // tagging lane's migration but never listed here, so every write silently
    // dropped it and the lane re-tagged the same pages forever (2026-10-28
    // production: all four cursors read back empty). promotion_cursor learns
    // from the same trap: listed in CREATE/migration/patch AND here, or the
    // promotion lane re-proposes forever.
    this.db.prepare(
      `INSERT INTO distill_state (project, obs_cursor, handoff_cursor, note_cursor, tag_cursor, promotion_cursor, updated_at, last_error, last_tokens, gaps, next_attempt_at, pending_since)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project) DO UPDATE SET obs_cursor=excluded.obs_cursor, handoff_cursor=excluded.handoff_cursor, note_cursor=excluded.note_cursor,
         tag_cursor=excluded.tag_cursor,
         promotion_cursor=excluded.promotion_cursor,
         updated_at=excluded.updated_at, last_error=excluded.last_error, last_tokens=excluded.last_tokens,
         gaps=excluded.gaps, next_attempt_at=excluded.next_attempt_at, pending_since=excluded.pending_since`,
    ).run(next.project, next.obs_cursor, next.handoff_cursor, next.note_cursor, next.tag_cursor ?? "", next.promotion_cursor ?? "", next.updated_at, next.last_error, next.last_tokens, next.gaps, next.next_attempt_at, next.pending_since);
  }

  // /digest L1 segment (2026-10-26 benchmark): a type-blind recentPages window
  // loses notes whenever fresh L2/handoff pages churn above them — query the
  // type directly so note recall never depends on other page kinds' activity.
  recentNotes(project: string, limit = 5, opts?: { includeSuperseded?: boolean }): Array<{ path: string; title: string; body: string; updated_at: string }> {
    return this.db
      .prepare(`SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note'${RootDb.aliveSql("", opts?.includeSuperseded)} ORDER BY updated_at DESC LIMIT ?`)
      .all(project, limit) as never;
  }

  // Query-matched note recall (2026-10-26 iteration): notes are only ever
  // recency-ranked — anything older than rank-5 is invisible until distillation
  // catches up (lossy + latent). Score title+body against the same terms rules
  // as the L2 keyword path; returns matched notes with scores (ties by recency).
  queryNotes(project: string, queryFor: string, limit = 3, opts?: { includeSuperseded?: boolean }): Array<{ path: string; title: string; body: string; updated_at: string; score: number }> {
    const rows = this.db
      .prepare(`SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note'${RootDb.aliveSql("", opts?.includeSuperseded)} ORDER BY updated_at DESC LIMIT 200`)
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
  // Correction notes (title prefix 修正：, written by /pages/mutate) are NOT raw
  // material: they describe the memory's own bookkeeping, and distilling them
  // produced L2 "facts" like "用户要求把 tier 从 draft 改为 canonical" that then
  // rode the digest and crowded out real recall. They are excluded by default;
  // the tagging lane reads them through correctionsAfter() as vocabulary only.
  notesAfter(project: string, cursor: string, limit = 120, { includeCorrections = false } = {}): Array<{ path: string; title: string; body: string; updated_at: string }> {
    const gate = includeCorrections ? "" : " AND title NOT LIKE '修正：%'";
    return this.db
      .prepare(`SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' AND updated_at>?${gate} ORDER BY updated_at LIMIT ?`)
      .all(project, cursor, limit) as never;
  }

  // Superseded-id set (2026-10-26 vector-lane gap): the keyword path filters
  // superseded candidates via distillCandidates' active set, but the full-scan
  // vector lane reads page_vectors directly — without this set it resurrects
  // pages a newer distillation already retired.
  supersededIds(project?: string): Set<string> {
    // Reads the edge table (optimize-yongyi-read-surfaces 3.4): the old shape
    // parsed every page's supersedes JSON on every call, once per digest.
    //
    // Project-scoped (2026-11-20). `superseded_id` is a page_id = a basename,
    // so the SAME id can be retired in one project and perfectly alive in
    // another. Returning every id in the table made one project's correction
    // silently delete another project's live conclusion from digest recall —
    // measured: alpha retiring `old-1` made beta's untouched `old-1` report as
    // superseded. Callers that span partitions (multi-project recall) pass no
    // project and keep the union; single-project callers must pass one.
    const rows = project
      ? this.db.prepare("SELECT superseded_id FROM superseded_edges WHERE project=?").all(project) as Array<{ superseded_id: string }>
      : this.db.prepare("SELECT superseded_id FROM superseded_edges").all() as Array<{ superseded_id: string }>;
    const ids = new Set<string>();
    for (const r of rows) if (r.superseded_id) ids.add(r.superseded_id);
    return ids;
  }

  // Reference pages (add-unified-memory-and-outputs): thin index entries for
  // library/output artifacts. Recall = keyword+tags scoring with a tier boost,
  // drafts admitted only when they explicitly match the query (spec: budget
  // limited → canonical > stable > draft).
  queryReferences(project: string, queryFor: string, limit = 3): Array<{ path: string; title: string; body: string; updated_at: string; tags: string; tier: string; source_ref: string | null; score: number }> {
    const rows = this.db
      .prepare("SELECT path, title, body, updated_at, tags, tier, source_ref FROM pages WHERE project=? AND type='reference' ORDER BY updated_at DESC LIMIT 200")
      .all(project) as Array<{ path: string; title: string; body: string | null; updated_at: string; tags: string; tier: string; source_ref: string | null }>;
    const terms = String(queryFor ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2);
    const boost = (tier: string) => (tier === "canonical" ? 2 : tier === "stable" ? 1 : 0);
    return rows
      .map((r) => {
        let tagsArr: string[] = [];
        try { tagsArr = JSON.parse(r.tags ?? "[]") as string[]; } catch { /* malformed */ }
        const hay = `${r.title} ${String(r.body ?? "")} ${tagsArr.join(" ")}`.toLowerCase();
        let kw = 0;
        for (const t of terms) if (hay.includes(t)) kw++;
        const isDraft = !r.tier || r.tier === "draft";
        if (terms.length > 0 && isDraft && kw === 0) return null; // drafts must earn their slot
        if (terms.length > 0 && kw === 0 && r.tier !== "canonical") return null;
        return { ...r, body: r.body ?? "", score: kw * 2 + boost(r.tier) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score || (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, limit);
  }

  // Corrections the user or an AI assistant made to tags/tier — written as
  // notes with a machine-recognisable title prefix so the tagging lane can
  // learn the owner's vocabulary (memory-distiller spec: corrections feed
  // later tag suites).
  correctionsAfter(project: string, cursor: string, limit = 50): Array<{ path: string; title: string; body: string; updated_at: string }> {
    return this.db
      .prepare("SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' AND title LIKE '修正：%' AND updated_at>? ORDER BY updated_at LIMIT ?")
      .all(project, cursor, limit) as never;
  }

  // Tagging lane (add-unified-memory-and-outputs): reference pages whose
  // tags have not been settled by a human and are past the tag cursor — the
  // engine proposes tags/tier for these exactly once per marker.
  referencesNeedingTags(project: string, cursor: string, limit = 12): Array<{ path: string; title: string; body: string; updated_at: string; tags: string; tier: string; source_ref: string | null }> {
    return this.db
      .prepare("SELECT path, title, body, updated_at, tags, tier, source_ref FROM pages WHERE project=? AND type='reference' AND updated_at>? AND (tags IS NULL OR tags='[]') ORDER BY updated_at LIMIT ?")
      .all(project, cursor, limit) as never;
  }

  // Tier promotion lane (add-tier-promotion-candidates): pages that still sit
  // at draft and may deserve stable. Covers the distilled L2 types (fact,
  // experience) plus reference — NOT gated on "has no tags" (a tagged page can
  // still be promotion-worthy), and excludes pages already at stable/canonical
  // so the lane never re-proposes settled pages. Own cursor so the tagging
  // lane's progress cannot starve this selection.
  promotionCandidates(project: string, cursor: string, limit = 20): Array<{ path: string; type: string; title: string; body: string; updated_at: string; tags: string; tier: string }> {
    return this.db
      .prepare(`SELECT path, type, title, body, updated_at, tags, tier FROM pages
                WHERE project=? AND type IN ('fact','experience','reference') AND tier='draft' AND updated_at>?
                ORDER BY updated_at LIMIT ?`)
      .all(project, cursor, limit) as never;
  }

  // -- tier proposals (add-tier-promotion-candidates) -------------------------
  // AI promotion judgement lands HERE as a pending proposal, never on the
  // page itself: pages are markdown truth, proposals are derived state a
  // human accepts (tier flips, origin becomes human) or ignores (cooldown
  // keeps the lane from re-nagging the same page, design D4).

  upsertTierProposal(project: string, pageRel: string, p: { proposed_tier: string; reason: string; proposed_by?: string; proposed_at: string }): void {
    this.db.prepare(
      `INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at, accepted_at, ignored_at)
       VALUES (?,?,?,?,?,?,NULL,NULL)
       ON CONFLICT(project, page_rel) DO UPDATE SET proposed_tier=excluded.proposed_tier, reason=excluded.reason,
         proposed_by=excluded.proposed_by, proposed_at=excluded.proposed_at, accepted_at=NULL, ignored_at=NULL`,
    ).run(project, pageRel, p.proposed_tier, p.reason, p.proposed_by ?? "ai", p.proposed_at);
  }

  tierProposal(project: string, pageRel: string): { project: string; page_rel: string; proposed_tier: string; reason: string; proposed_by: string; proposed_at: string; accepted_at: string | null; ignored_at: string | null } | undefined {
    return this.db.prepare("SELECT * FROM tier_proposals WHERE project=? AND page_rel=?").get(project, pageRel) as never;
  }

  // Proposals a human can still act on: unread face for the owner surface
  // (spec: 提议必须人可见可批). Page columns ride along so the UI never has
  // to N+1 per proposal; the tier re-check means a page settled by other
  // means drops off the face even if its row lingers.
  pendingTierProposals(project: string, limit = 50): Array<{ page_rel: string; proposed_tier: string; reason: string; proposed_by: string; proposed_at: string; title: string; type: string; current_tier: string }> {
    return this.db
      .prepare(`SELECT p.page_rel, p.proposed_tier, p.reason, p.proposed_by, p.proposed_at,
                       pg.title, pg.type, pg.tier AS current_tier
                FROM tier_proposals p JOIN pages pg ON pg.path = p.page_rel
                WHERE p.project=? AND p.accepted_at IS NULL AND p.ignored_at IS NULL AND pg.tier='draft'
                ORDER BY p.proposed_at DESC LIMIT ?`)
      .all(project, limit) as never;
  }

  tierProposalIgnoredWithin(project: string, pageRel: string, sinceIso: string): boolean {
    const r = this.db
      .prepare("SELECT 1 AS hit FROM tier_proposals WHERE project=? AND page_rel=? AND ignored_at IS NOT NULL AND ignored_at>?")
      .get(project, pageRel, sinceIso) as { hit?: number } | undefined;
    return Boolean(r?.hit);
  }

  acceptTierProposal(project: string, pageRel: string, at: string): void {
    this.db.prepare("UPDATE tier_proposals SET accepted_at=? WHERE project=? AND page_rel=? AND accepted_at IS NULL AND ignored_at IS NULL").run(at, project, pageRel);
  }

  ignoreTierProposal(project: string, pageRel: string, at: string): void {
    this.db.prepare("UPDATE tier_proposals SET ignored_at=? WHERE project=? AND page_rel=? AND accepted_at IS NULL").run(at, project, pageRel);
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
    if (!model || !String(model).trim()) {
      // An unnamed model can never match a query (allPageVectors filters by
      // model), so storing it would be a silent loss. Programmer error.
      throw new Error("setPageVector: model is required");
    }
    this.db.prepare(
      `INSERT INTO page_vectors (page_rel, model, dim, vector) VALUES (?,?,?,?)
       ON CONFLICT(page_rel) DO UPDATE SET model=excluded.model, dim=excluded.dim, vector=excluded.vector`,
    ).run(pageRel, model, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }

  // The model most vectors already live under — the space a new write must
  // belong to for cosine similarity to mean anything.
  dominantVectorModel(): { model: string; n: number } | null {
    const row = this.db.prepare("SELECT model, COUNT(*) AS n FROM page_vectors GROUP BY model ORDER BY n DESC LIMIT 1").get() as { model: string; n: number } | undefined;
    return row ?? null;
  }

  // Scale observation (harden-memory-surfaces D3): the full-scan recall lane
  // is safe only while per-root vector counts stay in the measured zone.
  // A COUNT(*) is index-cheap and never decodes a vector — this must not
  // become an allPageVectors call dressed up as a metric.
  vectorCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM page_vectors").get() as { n: number };
    return Number(row.n) || 0;
  }

  // Consistency guard (2026-10-28): one embedding model per store, enforced at
  // write time. A vector from another model is not "slightly worse recall" —
  // cosine across model spaces is meaningless, and allPageVectors() would hide
  // the row anyway, so writing it is pure loss. policy=reject (default) turns
  // that loss into a loud refusal; policy=allow records it for drift audits.
  setPageVectorGuarded(pageRel: string, model: string, vector: Float32Array, opts: { policy?: "reject" | "allow" } = {}): { written: boolean; reason?: string; dominant?: string } {
    if (!model || !String(model).trim()) throw new Error("setPageVectorGuarded: model is required");
    const dominant = this.dominantVectorModel();
    if (dominant && dominant.model !== model) {
      if ((opts.policy ?? "reject") === "reject") {
        return { written: false, reason: "model_mismatch", dominant: dominant.model };
      }
      this.setPageVector(pageRel, model, vector);
      return { written: true, reason: "model_mismatch_allowed", dominant: dominant.model };
    }
    this.setPageVector(pageRel, model, vector);
    return { written: true };
  }

  // Full-scan vector read (2026-10-26 recall-cap fix): the hybrid path used to
  // score ONLY keyword-recalled candidates, which silently demoted the vector
  // lane to a re-ranker of keyword hits — anything keyword missed was
  // unreachable no matter how close its embedding. Scan every vector of the
  // query's model instead (page count is small: tens to low hundreds).
  allPageVectors(model: string): Array<{ page_rel: string; vector: Float32Array }> {
    const rows = this.db.prepare("SELECT page_rel, vector, dim FROM page_vectors WHERE model=?").all(model) as Array<{ page_rel: string; vector: Uint8Array; dim: number }>;
    return rows.map((r) => {
      // node:sqlite yields Uint8Array (not Buffer) — view it, don't method-call it
      const view = new DataView(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
      const out = new Float32Array(r.dim);
      for (let i = 0; i < r.dim; i++) out[i] = view.getFloat32(i * 4, true);
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

  // -- oversight audit (add-agent-memory-foundation) ---------------------------
  // One row per owner supervision read: who, when, which root/partitions, how
  // many hits. Dedicated table (the writes table is page-shaped and has no
  // hit count); never load-bearing — an audit failure must not fail the read.
  addOversightRead(principal: string, rootKey: string, projects: string, hits: number): void {
    this.db.prepare("INSERT INTO oversight_reads (ts, principal, root_key, projects, hits) VALUES (?,?,?,?,?)")
      .run(new Date().toISOString(), principal, rootKey, projects, Math.max(0, hits | 0));
  }

  recentOversightReads(limit = 50): OversightReadRow[] {
    return this.db
      .prepare("SELECT ts, principal, root_key, projects, hits FROM oversight_reads ORDER BY rowid DESC LIMIT ?")
      .all(limit) as unknown as OversightReadRow[];
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

  // -- observe dedupe (add-yongyi-complete-solution, spec yongyi-observe-lane) --
  // Persistent (project, idempotency_key) claim for the /observe lane: the
  // first delivery claims the key and stores its page rel; any replay reads
  // the FIRST page back without adding rows. Pure addition — the root IS the
  // namespace boundary (one DB per owner root), so (project, key) here is the
  // design's (namespace, idempotency_key), restart-safe.
  claimObserveEvent(project: string, idemKey: string, pageRel: string, seenAt: string): { first: boolean; page_rel: string | null } {
    const ins = this.db
      .prepare("INSERT OR IGNORE INTO observe_dedupe (project, idem_key, page_rel, seen_at) VALUES (?,?,?,?)")
      .run(project, idemKey, pageRel, seenAt);
    if (Number(ins.changes) > 0) return { first: true, page_rel: pageRel };
    const row = this.db
      .prepare("SELECT page_rel FROM observe_dedupe WHERE project=? AND idem_key=?")
      .get(project, idemKey) as { page_rel: string } | undefined;
    return { first: false, page_rel: row?.page_rel ?? null };
  }

  // L0 observation pages (wiki) for the digest L1 lane — a pure-additive
  // read: legacy roots hold none, so callers merging it in see unchanged
  // output for every pre-existing page population.
  recentObservationPages(project: string, limit = 5): Array<{ path: string; title: string; body: string; updated_at: string }> {
    return this.db
      .prepare("SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='observation' ORDER BY updated_at DESC LIMIT ?")
      .all(project, limit) as never;
  }

  reindexFromWiki(wikiDir: string): number {
    this.db.exec("DELETE FROM pages");
    this.db.exec("DELETE FROM pages_fts");
    // Edges are derived from the pages index; a rebuild repopulates them
    // through indexPage (3.2).
    this.db.exec("DELETE FROM superseded_edges");
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
            // Structured metadata rides the frontmatter truth; malformed rows
            // degrade to no metadata rather than blocking the rebuild.
            metadata: page.frontmatter.metadata && typeof page.frontmatter.metadata === "object" && !Array.isArray(page.frontmatter.metadata)
              ? (page.frontmatter.metadata as Record<string, unknown>)
              : null,
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

  // replayObservationsFromLog: rebuild the observations index from the
  // append-only JSONL truth written by StoreRoot.appendObservation.
  //
  // This is the other half of "L0 捕获流 MUST 为 append-only 且可重建索引".
  // reindexFromWiki only rebuilds `pages`; observations live outside the wiki
  // page tree, so before this existed there was no way to recover them if the
  // SQLite file was lost or its index got out of sync.
  //
  // Idempotent: clears the table first, then replays every log line in
  // chronological order so the autoincrement `id` matches the original arrival
  // order. Deduplication is NOT applied here — the log is the truth, including
  // duplicate captures that the live path happened to write.
  replayObservationsFromLog(wikiDir: string): { projects: number; rows: number; retracted: number } {
    this.db.exec("DELETE FROM observations");
    let projects = 0;
    let rows = 0;
    let retracted = 0;

    // Two passes, both over the same append-only files.
    //
    // A retract marker (`_retract: true`, written by StoreRoot.retractObservations)
    // lists digests of the rows it withdrew. Pass 1 collects how many of each
    // digest are withdrawn — a COUNT, not a flag, because a deliberate re-import
    // after the retract appends the same bytes again and must survive the replay.
    // Each withdrawn row consumes exactly one such allowance.
    const files: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collect(full);
        else if (entry.endsWith(".jsonl") && full.includes(`${sep}observations${sep}_log${sep}`)) files.push(full);
      }
    };
    collect(wikiDir);

    const withdrawn = new Map<string, number>();
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || !t.includes("_retract")) continue;
        try {
          const rec = JSON.parse(t) as { _retract?: unknown; retracted?: unknown };
          if (rec._retract !== true || !Array.isArray(rec.retracted)) continue;
          for (const d of rec.retracted) {
            const key = String(d);
            withdrawn.set(key, (withdrawn.get(key) ?? 0) + 1);
          }
        } catch {
          console.warn(`[fd-memory] replay: skipped malformed retract marker in ${file}`);
        }
      }
    }

    for (const file of files) {
      projects++;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let rec: { session_id?: unknown; agent?: unknown; event?: unknown; tool?: unknown; summary?: unknown; created_at?: unknown; project?: unknown; _retract?: unknown };
        try {
          rec = JSON.parse(t) as typeof rec;
        } catch {
          console.warn(`[fd-memory] replay: skipped malformed line in ${file}`);
          continue;
        }
        if (rec._retract === true) continue;
        if (typeof rec.session_id !== "string" || typeof rec.event !== "string") continue;
        const digest = observationDigest(rec.session_id, String(rec.summary ?? ""));
        const allowance = withdrawn.get(digest) ?? 0;
        if (allowance > 0) {
          withdrawn.set(digest, allowance - 1);
          retracted++;
          continue;
        }
        this.db
          .prepare("INSERT INTO observations (session_id, agent, event, tool, summary, created_at, project) VALUES (?,?,?,?,?,?,?)")
          .run(
            rec.session_id,
            String(rec.agent ?? "platform"),
            rec.event,
            rec.tool == null ? null : String(rec.tool),
            String(rec.summary ?? ""),
            String(rec.created_at ?? new Date().toISOString()),
            String(rec.project ?? "default"),
          );
        rows++;
      }
    }
    return { projects, rows, retracted };
  }
}
