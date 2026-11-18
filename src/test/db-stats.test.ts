// db-stats contract (2026-11-18).
//
// The whole reason this script exists is a mistake I made twice by hand: the
// page table stores `updated_at` as ISO text ("2026-11-18T06:30:58.123Z"), and
// `datetime('now','-5 minutes')` returns a SPACE-separated string
// ("2026-11-18 06:30:58"). Comparing them is a string comparison that silently
// matches every row, so a "pages in the last 5 minutes" count comes back equal
// to the whole table. I reported "6,181 pages in 5 minutes, growth is
// exploding" on that basis; the true number was 172.
//
// The script therefore builds its cutoff with toISOString(). These tests pin
// that the comparison actually discriminates — a cutoff in the wrong format
// would make every assertion below pass with the wrong number, so the fixture
// asserts exact counts rather than "greater than zero".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function sqlite(db: string, sql: string) {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

// Build a database shaped like the real one: the pages columns the script
// reads, plus rows at controlled ages.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fd-stats-"));
  const dbDir = join(dir, "owners", "u-test", "db");
  mkdirSync(dbDir, { recursive: true });
  const db = join(dbDir, "memory.sqlite");
  sqlite(db, `
    CREATE TABLE pages (path TEXT PRIMARY KEY, project TEXT, type TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE VIRTUAL TABLE pages_fts USING fts5(title, body, path UNINDEXED, tokenize='trigram');
  `);
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const row = (i: number, type: string, msAgo: number) =>
    `INSERT INTO pages VALUES ('p${i}.md','default','${type}','t','b','${iso(msAgo)}');`;
  // 3 observation pages: two fresh (<1 day), one old (2 days).
  const stmts = [
    row(1, "observation", 60_000),
    row(2, "observation", 120_000),
    row(3, "observation", 2 * 86400_000),
    row(4, "fact", 60_000),
  ].join("\n");
  sqlite(db, stmts);
  return { dir, db };
}

test("db-stats counts recent pages against an ISO cutoff, not a space-separated one", () => {
  const { dir, db } = fixture();
  try {
    const out = execFileSync("node", [join(process.cwd(), "scripts", "db-stats.mjs"),
      "--data", dir, "--root", "u-test", "--days", "1"], { encoding: "utf8" });
    // 3 observation rows total, 2 of them within a day.
    assert.match(out, /observation\s+3\s+2\s+\(67%\)/, `per-type line wrong:\n${out}`);
    // 4 pages total, 3 within a day.
    assert.match(out, /最近 1 天合计新增 3 页/, `totals line wrong:\n${out}`);
    // The freelist line must be present: it is the "is VACUUM worth it" answer.
    assert.match(out, /空闲 \d+/, `freelist line missing:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SPACE-separated cutoff would be caught (the format is load-bearing)", () => {
  // Why this fixture: the first version of this test could not fail. Rows dated
  // "2 days ago" compare greater than a space-separated cutoff either way, so
  // swapping toISOString() for a space-separated string left the counts
  // unchanged and the test stayed green — a test that cannot catch the very
  // mistake it is named after.
  //
  // What actually discriminates: ISO text sorts "2026-11-18T06:30:58.000Z"
  // ABOVE the space-separated "2026-11-18 06:30:58" at the first differing
  // byte ('T' 0x54 > ' ' 0x20). So a row from YESTERDAY (but after the cutoff
  // clock time) is correctly "old" under ISO, yet would be silently counted as
  // "recent" under the space-separated form. Put exactly such a row in the
  // fixture and assert it is excluded.
  const dir = mkdtempSync(join(tmpdir(), "fd-stats-fmt-"));
  try {
    const dbDir = join(dir, "owners", "u-fmt", "db");
    mkdirSync(dbDir, { recursive: true });
    const db = join(dbDir, "memory.sqlite");
    sqlite(db, `
      CREATE TABLE pages (path TEXT PRIMARY KEY, project TEXT, type TEXT, title TEXT, body TEXT, updated_at TEXT);
      CREATE VIRTUAL TABLE pages_fts USING fts5(title, body, path UNINDEXED, tokenize='trigram');
    `);
    // 25 hours ago = outside a 1-day window, but on the SAME calendar day as
    // the cutoff's clock reading only when compared as bare strings.
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    sqlite(db, `INSERT INTO pages VALUES ('old.md','default','observation','t','b','${old}');`);
    const out = execFileSync("node", [join(process.cwd(), "scripts", "db-stats.mjs"),
      "--data", dir, "--root", "u-fmt", "--days", "1"], { encoding: "utf8" });
    // The row is 25h old, so it must NOT count as "最近 1 天新增".
    assert.match(out, /最近 1 天合计新增 0 页/, `a 25h-old row must be outside the 1-day window:\n${out}`);
    assert.match(out, /observation\s+1\s+0\s+\(0%\)/, `per-type recent count must be 0:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db-stats reports '判不出' rather than throwing when the database is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-stats-empty-"));
  try {
    const out = execFileSync("node", [join(process.cwd(), "scripts", "db-stats.mjs"),
      "--data", dir, "--root", "u-missing"], { encoding: "utf8" });
    assert.match(out, /判不出/, `a missing database must say so, got:\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
