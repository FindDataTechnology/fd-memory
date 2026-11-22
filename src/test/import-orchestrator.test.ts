// Import orchestrator invariants (change add-harness-memory-import, D3–D6).
//
// These are the three properties that separate "a script that copies files"
// from "an import that is safe to run repeatedly on a growing source":
// idempotency, incrementality, and bounded write pacing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { planClaudeImport, runClaudeImport } from "../connect/import/orchestrator.js";

function turn(uuid: string, text: string, role = "user", ts = "2026-11-15T10:00:00.000Z") {
  return JSON.stringify({ type: role, uuid, timestamp: ts, message: { role, content: text } });
}

/** Build a fake ~/.claude/projects tree. */
function fixture(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-import-src-"));
  for (const [name, lines] of Object.entries(files)) {
    const proj = join(dir, "-tmp-proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, name), lines.join("\n") + "\n", "utf8");
  }
  return dir;
}

test("plan writes nothing and reports what it would do", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：部署要加 --frozen-lockfile")] });
  try {
    const root = new StoreRoot(data, "d-imp");
    const plan = planClaudeImport(root, { projectsDir: src });
    assert.equal(plan.estimatedWrites, 1);
    assert.equal(plan.alreadyImported, 0);
    // Nothing landed
    assert.equal(root.db.observationsForSession("s1").length, 0);
    assert.ok(!existsSync(join(root.rootDir, "import", "claude-code.cursor.json")));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("import lands memories with provenance and a cursor", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：部署要加 --frozen-lockfile")] });
  try {
    const root = new StoreRoot(data, "d-imp2");
    const res = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(res.written, 1);
    assert.equal(res.degraded, 0);

    const obs = root.db.observationsForSession("s1");
    assert.equal(obs.length, 1);
    assert.ok(obs[0].summary.includes("explicit-remember"), "rule attribution rides the summary");
    assert.ok(obs[0].summary.includes("--frozen-lockfile"));
    assert.equal(obs[0].agent, "import:claude-code");

    assert.ok(existsSync(join(root.rootDir, "import", "claude-code.cursor.json")));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("re-import is idempotent (second run writes nothing)", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：第一条"), turn("u2", "记住：第二条")] });
  try {
    const root = new StoreRoot(data, "d-imp3");
    const first = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(first.written, 2);

    const second = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(second.written, 0, "nothing new on a rerun");
    // Since the source-hash ledger landed (2026-11-16) an unchanged file is
    // skipped wholesale, so the two turns are reported as skippedUnchanged
    // rather than alreadyImported. Both are "we did not write it" — assert the
    // total, not which bucket, so either path satisfies idempotency.
    assert.equal(
      second.plan.alreadyImported + second.plan.skippedUnchanged,
      2,
      "every kept turn accounted for, un-written",
    );
    assert.equal(root.db.observationsForSession("s1").length, 2, "no duplicates");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("growing source is imported incrementally", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：第一条")] });
  try {
    const root = new StoreRoot(data, "d-imp4");
    const first = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(first.written, 1);

    // The source grows (a later session appended a turn).
    writeFileSync(join(src, "-tmp-proj", "s1.jsonl"), [turn("u1", "记住：第一条"), turn("u2", "记住：第二条")].join("\n") + "\n");
    const second = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(second.written, 1, "only the new turn");
    assert.equal(root.db.observationsForSession("s1").length, 2);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("writes are batched and the cursor survives each batch", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const many = Array.from({ length: 7 }, (_, i) => turn(`u${i}`, `记住：第 ${i} 条`));
  const src = fixture({ "s1.jsonl": many });
  try {
    const root = new StoreRoot(data, "d-imp5");
    const res = await runClaudeImport(root, "default", { projectsDir: src, batchSize: 3, batchPauseMs: 0 });
    assert.equal(res.written, 7);
    assert.equal(res.batches, 3, "7 items at size 3 = 3 batches");

    const cursor = JSON.parse(readFileSync(join(root.rootDir, "import", "claude-code.cursor.json"), "utf8"));
    assert.equal(cursor.keys.length, 7, "every written key is recorded");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("index failure degrades but does not lose the import", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：索引锁住也要写进去")] });
  try {
    const root = new StoreRoot(data, "d-imp6");
    root.db.addObservation = () => {
      throw new Error("database is locked (simulated)");
    };
    const res = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(res.written, 1);
    assert.equal(res.degraded, 1, "reported as degraded");

    // The truth log still has it — replay recovers the index later.
    const out = root.db.replayObservationsFromLog(root.wikiDir);
    assert.equal(out.rows, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("corrupt cursor fails loudly instead of silently re-importing", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：第一条")] });
  try {
    const root = new StoreRoot(data, "d-imp7");
    const dir = join(root.rootDir, "import");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-code.cursor.json"), "{not valid json");
    await assert.rejects(
      () => runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 }),
      /cursor is unreadable/,
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("unchanged source file is skipped on re-import (living documents)", async () => {
  // Measured 2026-11-16: 1 117 of 1 614 memory files changed within a week.
  // Re-reading an unchanged file must cost nothing; a changed one must be
  // picked up. Both halves are asserted here.
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：增量导入测试")] });
  try {
    const root = new StoreRoot(data, "d-ledger");
    const first = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(first.written, 1, "first import writes");

    const second = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(second.written, 0, "unchanged file contributes nothing");
    assert.ok(second.plan.skippedUnchanged >= 1, "and is reported as skipped, not as duplicate");

    // Touch the source: new turn appears, hash changes → re-import sees it.
    writeFileSync(
      join(src, "-tmp-proj", "s1.jsonl"),
      [turn("u1", "记住：增量导入测试"), turn("u2", "记住：新增第二条")].join("\n") + "\n",
    );
    const third = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(third.written, 1, "changed file is picked up again");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("corrupt source ledger fails loudly instead of silent re-import", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-import-root-"));
  const src = fixture({ "s1.jsonl": [turn("u1", "记住：坏台账")] });
  try {
    const root = new StoreRoot(data, "d-ledger2");
    const dir = join(root.rootDir, "import");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-code.sources.json"), "{broken");
    await assert.rejects(
      () => runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 }),
      /ledger is unreadable/,
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});
