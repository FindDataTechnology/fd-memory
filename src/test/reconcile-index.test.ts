// Reconcile contract (2026-11-19): the repair path must make on-disk pages
// visible WITHOUT disturbing anything already indexed.
//
// Why this test exists: the only repair shipped before today was
// `reindexFromWiki`, which rebuilds everything and stamps `updated_at` = now.
// Running it in production would move 48k timestamps to a single instant,
// destroying recency order and jumping every distill cursor past the whole
// corpus. `scripts/reconcile-index.mjs` is the add-only alternative, and
// "add-only" is precisely the property that is easy to break silently — a
// future refactor could switch it to reindex-and-restore and every count would
// still look right while history silently collapsed. So this pins the two
// things that matter: gaps get filled, and pre-existing rows keep their exact
// timestamps.
//
// The script shells out to `dist/db.js`, so it runs against the built output.
// That is deliberate: it is the same artifact the service runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const SCRIPT = join(process.cwd(), "scripts", "reconcile-index.mjs");

function pageFile(type: string, title: string, body: string, at: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: "${title}"`,
    "generated:",
    "  by: process:fd-memory/0.1",
    `  at: ${at}`,
    "---",
    body,
    "",
  ].join("\n");
}

test("reconcile-index fills gaps without moving an existing row's timestamp", () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-reconcile-"));
  try {
    const owner = join(data, "owners", "u-test");
    const notes = join(owner, "wiki", "default", "notes");
    mkdirSync(notes, { recursive: true });
    mkdirSync(join(owner, "db"), { recursive: true });

    // Two pages on disk, neither indexed yet.
    writeFileSync(join(notes, "old1.md"), pageFile("note", "旧结论甲", "第一个原值页", "2026-11-10T01:00:00.000Z"));
    writeFileSync(join(notes, "old2.md"), pageFile("note", "旧结论乙", "第二个原值页", "2026-11-11T02:00:00.000Z"));

    const run = (apply: boolean) => {
      const args = [SCRIPT, "--data", data, "--root", "u-test"];
      if (apply) args.push("--apply");
      try {
        return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8" }) };
      } catch (err: unknown) {
        // The script exits 1 when a dry run finds work — that is a result, not
        // a crash, so capture stdout instead of failing the test.
        const e = err as { status?: number; stdout?: string };
        return { code: e.status ?? 1, out: String(e.stdout ?? "") };
      }
    };

    const dry = run(false);
    assert.equal(dry.code, 1, "a dry run with gaps present exits 1");
    assert.match(dry.out, /待补\s+2/);

    const applied = run(true);
    assert.equal(applied.code, 0, "apply succeeds");
    assert.match(applied.out, /已补 2 条/);

    const db = new DatabaseSync(join(owner, "db", "memory.sqlite"));
    const rows = db.prepare("SELECT path, updated_at FROM pages ORDER BY updated_at").all();
    assert.deepEqual(
      rows.map((r) => r.updated_at),
      ["2026-11-10T01:00:00.000Z", "2026-11-11T02:00:00.000Z"],
      "backfilled rows carry their OWN frontmatter time, not the repair time",
    );

    // Now add a third page and re-run: the two existing rows must not move.
    writeFileSync(join(notes, "new3.md"), pageFile("note", "新结论丙", "第三个页", "2026-11-12T03:00:00.000Z"));
    const again = run(true);
    assert.equal(again.code, 0);
    assert.match(again.out, /已补 1 条/);

    const after = db.prepare("SELECT path, updated_at FROM pages ORDER BY updated_at").all();
    assert.deepEqual(
      after.map((r) => r.updated_at),
      ["2026-11-10T01:00:00.000Z", "2026-11-11T02:00:00.000Z", "2026-11-12T03:00:00.000Z"],
      "a later reconcile must leave already-indexed timestamps exactly as they were",
    );

    // Idempotent: a third run has nothing to do.
    const converged = run(false);
    assert.equal(converged.code, 0, "nothing left to do exits 0");
    assert.match(converged.out, /待补\s+0/);
    db.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
