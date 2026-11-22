// L0 truth-of-record contract (change yongyi-multi-agent-memory-plane,
// requirement "L0 捕获流 MUST 为 append-only 且可重建索引").
//
// The property under test: the append-only JSONL under
// <project>/observations/_log/ is the truth, and the SQLite `observations`
// table is only an index over it. Losing or failing the index must never lose
// an event, and the index must be reconstructible from the log alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { CaptureIngest } from "../capture.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fd-memory-l0-"));
}

function logFiles(root: StoreRoot, project: string): string[] {
  const dir = join(root.wikiDir, project, "observations", "_log");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
}

function readLog(root: StoreRoot, project: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of logFiles(root, project)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

test("capture writes append-only truth and the log is the only source needed", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t1");
    const ingest = new CaptureIngest(new Map([["d-t1", root]]), () => root);

    const out = ingest.ingest("d-t1", "default", [
      { event: "session-start", session_id: "s-1" },
      { event: "stop", session_id: "s-1", summary: "定位到锁冲突" },
    ]);
    assert.equal(out.stored, 2);
    assert.equal(out.degraded, 0);

    const log = readLog(root, "default");
    assert.equal(log.length, 2, "both events land in the append-only log");
    assert.equal(log[1].summary, "定位到锁冲突");
    assert.equal(log[1].session_id, "s-1");
    assert.equal(log[1].project, "default");
    assert.ok(typeof log[1].created_at === "string");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("index failure does NOT lose the event (truth written first)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t2");
    const ingest = new CaptureIngest(new Map([["d-t2", root]]), () => root);

    // Force the index write to fail while leaving the truth path intact.
    const realAdd = root.db.addObservation.bind(root.db);
    root.db.addObservation = () => {
      throw new Error("database is locked (simulated)");
    };

    const out = ingest.ingest("d-t2", "default", [{ event: "stop", session_id: "s-2", summary: "写进去了吗" }]);
    assert.equal(out.stored, 1, "the event counts as stored");
    assert.equal(out.degraded, 1, "and is reported as degraded, not failed");

    const log = readLog(root, "default");
    assert.equal(log.length, 1, "truth survived the index failure");
    assert.equal(log[0].summary, "写进去了吗");

    // Restore and confirm the index can be caught up from the log later.
    root.db.addObservation = realAdd;
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("append-only means never rewriting existing lines", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t3");
    const ingest = new CaptureIngest(new Map([["d-t3", root]]), () => root);

    ingest.ingest("d-t3", "default", [{ event: "stop", session_id: "s-a", summary: "第一条" }]);
    const first: string[] = logFiles(root, "default").map((f) => readFileSync(f, "utf8"));

    ingest.ingest("d-t3", "default", [{ event: "stop", session_id: "s-b", summary: "第二条" }]);
    const after: string[] = logFiles(root, "default").map((f) => readFileSync(f, "utf8"));

    assert.equal(first.length, after.length, "same file set (same month)");
    assert.ok(after[0].startsWith(first[0]), "previous bytes are a prefix — nothing rewritten");
    assert.equal(readLog(root, "default").length, 2);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("log is partitioned by month so one file stays bounded", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t4");
    root.appendObservation({
      session_id: "s-x", agent: "a", event: "stop", tool: null,
      summary: "上个月", created_at: "2026-10-15T00:00:00.000Z", project: "default",
    });
    root.appendObservation({
      session_id: "s-y", agent: "a", event: "stop", tool: null,
      summary: "这个月", created_at: "2026-11-15T00:00:00.000Z", project: "default",
    });

    const names = logFiles(root, "default").map((f) => f.split("/").pop()).sort();
    assert.deepEqual(names, ["2026-10.jsonl", "2026-11.jsonl"]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("index is rebuildable from the log alone (tasks 0.4)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t5");
    const ingest = new CaptureIngest(new Map([["d-t5", root]]), () => root);

    ingest.ingest("d-t5", "default", [
      { event: "session-start", session_id: "s-r1" },
      { event: "stop", session_id: "s-r1", summary: "第一条结论" },
      { event: "post-tool-use", session_id: "s-r1", tool_name: "Write", summary: "写了文件" },
    ]);

    const before = root.db.observationsForSession("s-r1");
    assert.equal(before.length, 3);

    // Simulate losing the index (or switching backends): wipe it entirely.
    root.db.db.exec("DELETE FROM observations");
    assert.equal(root.db.observationsForSession("s-r1").length, 0);

    const out = root.db.replayObservationsFromLog(root.wikiDir);
    assert.equal(out.rows, 3, "every row comes back from the log");
    assert.ok(out.projects >= 1);

    const after = root.db.observationsForSession("s-r1");
    assert.equal(after.length, 3);
    // order preserved (matches original arrival order)
    assert.deepEqual(
      after.map((o) => [o.event, o.summary]),
      before.map((o) => [o.event, o.summary]),
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("replay is idempotent (twice yields the same rows, not double)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-t6");
    root.appendObservation({ session_id: "s-i", agent: "a", event: "stop", tool: null, summary: "幂等", created_at: "2026-11-15T00:00:00.000Z", project: "default" });

    const a = root.db.replayObservationsFromLog(root.wikiDir);
    const b = root.db.replayObservationsFromLog(root.wikiDir);
    assert.equal(a.rows, 1);
    assert.equal(b.rows, 1);
    assert.equal(root.db.observationsForSession("s-i").length, 1, "not duplicated by replay");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
