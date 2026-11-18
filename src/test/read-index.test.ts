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
