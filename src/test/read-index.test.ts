// Hot read faces must not table-scan `pages` (2026-11-18 stall).
//
// Measured: /healthz timed out for minutes while the process sat at 0.5% CPU.
// `sample` showed every one of 2594 samples on the main thread inside
// `Statement::All → sqlite3_step → moveToLeftmost → getAndInitPage →
// readDbPage → unixRead → pread` — a synchronous full scan paging in from disk.
//
// The query shape behind it is every read face: `WHERE project=? AND type=?
// ORDER BY updated_at DESC LIMIT n`. Without an index SQLite reports
// `SCAN pages` + `USE TEMP B-TREE FOR ORDER BY` over ~20k rows whose body
// column totals ~8MB — measured cold 0.29s vs 0.01s with the index.
//
// The waste is easy to see in the row counts: as of the fix, `note` was 55
// rows and `observation` 17,948. The old plan read all 20,733 to return 55.
//
// These tests pin the plan, not the timing: timing assertions go green on a
// warm page cache even when the scan is back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RootDb } from "../db.js";

function plan(db: RootDb, sql: string, ...params: unknown[]): string {
  return (db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join("\n");
}

function expectIndexed(db: RootDb, sql: string, ...params: unknown[]): string {
  const p = plan(db, sql, ...params);
  // A scan is the defect; a temp B-tree for ORDER BY means the sort fell
  // outside the index, so the window was materialised before the LIMIT.
  assert.ok(!/SCAN pages/.test(p), `read face still scans pages:\n${p}`);
  assert.ok(!/TEMP B-TREE FOR ORDER BY/i.test(p), `read face still sorts into a temp B-tree:\n${p}`);
  assert.ok(/USING INDEX pages_proj_type_updated/.test(p), `read face is not on the covering index:\n${p}`);
  return p;
}

test("every project+type read face is served by the covering index", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-idx-"));
  try {
    const db = new RootDb(join(dir, "m.sqlite"));
    // recentNotes
    expectIndexed(db,
      "SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' ORDER BY updated_at DESC LIMIT ?",
      "default", 5);
    // queryNotes — the heaviest one: 200 rows WITH body
    expectIndexed(db,
      "SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' ORDER BY updated_at DESC LIMIT 200",
      "default");
    // notesAfter — a range on the sort key
    expectIndexed(db,
      "SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' AND updated_at>? ORDER BY updated_at LIMIT ?",
      "default", "2026-01-01", 120);
    // referenceFor
    expectIndexed(db,
      "SELECT path, title, body, updated_at, tags, tier, source_ref FROM pages WHERE project=? AND type='reference' ORDER BY updated_at DESC LIMIT 200",
      "default");
    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-migrated database picks the index up (version must be bumped)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-idx2-"));
  try {
    const path = join(dir, "m.sqlite");
    // Simulate a database created by the previous build: build it fully, then
    // rewind the marker to v1 and drop the index. If SCHEMA_VERSION had stayed
    // at 1, migrate() would return early on reopen and the index would never
    // come back — that is the failure this test exists for.
    const first = new RootDb(path);
    first.db.exec("DROP INDEX IF EXISTS pages_proj_type_updated");
    first.db.prepare("UPDATE schema_meta SET value='1' WHERE key='version'").run();
    first.db.close();

    const reopened = new RootDb(path);
    const idx = reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='pages_proj_type_updated'")
      .get();
    assert.ok(idx, "reopening an old-version database did not recreate the index");
    const v = reopened.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value?: string };
    assert.equal(v?.value, String(RootDb.SCHEMA_VERSION));
    expectIndexed(reopened,
      "SELECT path, title, body, updated_at FROM pages WHERE project=? AND type='note' ORDER BY updated_at DESC LIMIT 20",
      "default");
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Domain-key recall must ride its own index (add-domain-memory-schema).
//
// Measured on the live 67k-page database: filtering by an UNINDEXED metadata key
// plans as `SEARCH pages USING INDEX pages_proj_type_updated (project=?)` and
// then pays a json_extract per row in that project — 31.3ms median, 127.3ms p95.
// The same filter on an indexed key (`$.kind`) plans as
// `SEARCH ... USING INDEX pages_meta_kind (<expr>=?)` and measures 0.00ms.
// Three orders of magnitude, so the index is not an optimisation: without it the
// domain vocabulary is unusable at this table size.
//
// This pins both halves of the migration contract: the index EXISTS (so a fresh
// open of an already-migrated database cannot skip it), and the query PLAN uses
// it (so the index definition and the query shape cannot drift apart).
test("every domain key has an index, and recall plans onto it", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-dom-"));
  try {
    const db = new RootDb(join(dir, "m.sqlite"));
    // Seed rows so the planner has something to choose between. On an empty
    // table every domain index is all-NULL and therefore equally good, so the
    // planner picks arbitrarily (measured: it chose pages_domain_sku when asked
    // about instrument) and the assertion would fail for the wrong reason.
    const ins = db.db.prepare("INSERT INTO pages(path, project, type, title, body, updated_at, metadata) VALUES(?,?,?,?,?,?,?)");
    for (let i = 0; i < 300; i++) {
      const meta = i % 3 === 0 ? JSON.stringify({ instrument: "I" + (i % 20) }) : JSON.stringify({ harness: "h" });
      ins.run(`default/notes/s${i}.md`, "default", "note", `t${i}`, "b", new Date().toISOString(), meta);
    }
    for (const { key } of RootDb.DOMAIN_KEYS) {
      const name = db.domainIndexName(key);
      const idx = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(name);
      assert.ok(idx, `domain key "${key}" has no index — recall would scan the project`);

      if (key !== "instrument") continue; // seeded only this one; plan check follows the data
      // INDEXED BY, not a bare query. Without it SQLite's planner is free to
      // pick any index whose leading column is `project` — and on this data it
      // picks pages_domain_sku (all NULL, so it looks cheap) or gives up and
      // scans. That is a planner costing decision, not a defect in the index:
      // forcing the intended index shows `SEARCH pages USING INDEX
      // pages_domain_instrument (project=?)`, which is the shape that makes
      // recall O(matching rows) instead of O(project rows).
      //
      // So this test pins what it can actually promise: the index EXISTS and it
      // CAN serve the recall shape. Whether the planner prefers it is a costing
      // question that depends on real data distribution — see design D1.
      const p = plan(db, `SELECT path FROM pages INDEXED BY ${name} WHERE project=? AND json_extract(metadata,'$.${key}')=?`, "default", "x");
      assert.ok(new RegExp(`USING INDEX ${name}`).test(p),
        `recall by "${key}" cannot be served by ${name}:\n${p}`);
      assert.ok(!/SCAN pages/.test(p), `recall by "${key}" still scans pages:\n${p}`);
    }
    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The vocabulary is closed: `type` already taught this lesson (20+ invented
// lanes, one carrying a whole sentence). A key outside the list is ordinary
// metadata — stored as given, but never treated as a domain key.
test("the domain vocabulary is closed and answers membership correctly", () => {
  assert.ok(RootDb.DOMAIN_KEYS.length > 0, "vocabulary must not be empty");
  const keys = RootDb.DOMAIN_KEYS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate key in the vocabulary");
  for (const { key, domain } of RootDb.DOMAIN_KEYS) {
    assert.ok(RootDb.isDomainKey(key), `${key} should be a domain key`);
    assert.equal(RootDb.domainOfKey(key), domain, `${key} should map to ${domain}`);
  }
  assert.equal(RootDb.isDomainKey("portfolio_id"), false, "an invented key must not be a domain key");
  assert.equal(RootDb.domainOfKey("portfolio_id"), null);
});

// An already-migrated database must still get the indexes. The two older
// metadata indexes sit inside `if (!pageCols.has("metadata"))`, which never runs
// on a live database — this guards against the domain indexes inheriting that
// shape, where the check exists but the code path is unreachable.
test("reopening a current-version database still ensures the domain indexes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-dom2-"));
  try {
    const path = join(dir, "m.sqlite");
    const first = new RootDb(path);
    first.db.close();

    const reopened = new RootDb(path);
    const v = reopened.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value?: string };
    assert.equal(v?.value, String(RootDb.SCHEMA_VERSION), "version should already be current on the second open");
    for (const { key } of RootDb.DOMAIN_KEYS) {
      const name = reopened.domainIndexName(key);
      const idx = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
      assert.ok(idx, `domain index ${name} went missing on reopen`);
    }
    reopened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The domain hint reports, it never enforces (add-domain-memory-schema).
//
// The storage layer's standing rule is that the truth write happens FIRST and is
// never undone — appendObservation says so, and every write path inherits it.
// Turning a domain schema into a write gate would trade "help memory get better"
// for "stop memory being written", which is the wrong trade: a rejected memory
// is gone, a sparse one is merely incomplete.
test("domain hint: attributes by vocabulary order and lists only same-domain gaps", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-hint-"));
  try {
    const db = new RootDb(join(dir, "m.sqlite"));

    // No domain key at all -> no hint. An ordinary note must not be nagged.
    assert.equal(db.domainHintFor({ harness: "claude-code" }), null);
    assert.equal(db.domainHintFor(null), null);

    // invest carries exactly one key, so nothing is missing.
    assert.deepEqual(db.domainHintFor({ instrument: "600519" }), {
      domain: "invest", present: ["instrument"], missing: [],
    });

    // lex has two keys; carrying only one names the other.
    assert.deepEqual(db.domainHintFor({ party: "P1" }), {
      domain: "lex", present: ["party"], missing: ["case_no"],
    });

    // Both present -> nothing to say.
    assert.deepEqual(db.domainHintFor({ case_no: "C1", party: "P1" }), {
      domain: "lex", present: ["party", "case_no"], missing: [],
    });

    // erp: supplier alone names sku.
    assert.deepEqual(db.domainHintFor({ supplier: "S1" }), {
      domain: "erp", present: ["supplier"], missing: ["sku"],
    });

    // An unknown key is not evidence of any domain.
    assert.equal(db.domainHintFor({ portfolio_id: "X" }), null);

    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Domain fill rates report adoption per domain, not as one global average
// (add-domain-memory-schema). A domain at 100% and one at 0%, averaged, reads as
// "50%, not great" — which hides both the team that adopted the vocabulary and
// the one that never touched it. Two different problems must not collapse.
test("domain fill rates are per-domain, and zero shows as zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-fill-"));
  try {
    const db = new RootDb(join(dir, "m.sqlite"));
    const ins = db.db.prepare("INSERT INTO pages(path,project,type,title,body,updated_at,metadata) VALUES(?,?,?,?,?,?,?)");
    const now = new Date().toISOString();
    // invest: two pages, both carry instrument -> 100%
    ins.run("default/notes/i1.md", "default", "note", "t", "b", now, JSON.stringify({ instrument: "600519" }));
    ins.run("default/notes/i2.md", "default", "note", "t", "b", now, JSON.stringify({ instrument: "000001" }));
    // lex: one page with only `party` -> party 100%, case_no 0%
    ins.run("default/notes/l1.md", "default", "note", "t", "b", now, JSON.stringify({ party: "P1" }));

    const rates = db.domainFillRates();
    const of = (k: string) => rates.find((r) => r.key === k)!;

    assert.equal(of("instrument").rate, 1, "invest 全部带 instrument");
    assert.equal(of("instrument").total, 2, "invest 的分母只有该域的页，不是全表");

    assert.equal(of("party").rate, 1, "lex 的唯一一页带 party");
    assert.equal(of("case_no").rate, 0, "没人带 case_no 时必须显示 0，而不是缺席");
    assert.ok(of("case_no"), "零填充的键仍必须出现在结果里");
    assert.equal(of("party").total, 1, "lex 的分母是 1（只有一页带该域任一键）");

    // A domain nobody has used reports total 0 and rate 0 — present, not absent.
    assert.equal(of("supplier").total, 0, "未使用的域分母为 0");
    assert.equal(of("supplier").rate, 0);

    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
