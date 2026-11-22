// Retract, per source (change add-harness-memory-import, tasks 4.2 / 4.3).
//
// Two claims are tested here, and they fail in different ways:
//
//   4.2  After retracting one harness, its records are invisible on every read
//        face (query / recent / body) and ANOTHER source is untouched. The
//        "another source is untouched" half matters as much as the first: a
//        retract that sweeps by pattern rather than by provenance would pass a
//        test that only checked "the rows are gone".
//
//   4.3  Retract does not move a byte of the source. Measured by hashing the
//        source file before and after, not by inspecting the retract code —
//        the code could gain a "normalise the file while we're here" step and
//        still look read-only.
//
// Plus the durability property that makes this a retract rather than a hide:
// the append-only log keeps the withdrawn rows, and a replay must NOT bring
// them back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { newPage } from "../okf.js";
import { runClaudeImport } from "../connect/import/orchestrator.js";
import { retractHarness, HARNESS_IMPORT_LABELS } from "../connect/import/retract.js";

function turn(uuid: string, text: string, role = "user", ts = "2026-11-15T10:00:00.000Z") {
  return JSON.stringify({ type: role, uuid, timestamp: ts, message: { role, content: text } });
}

function fixture(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-retract-src-"));
  for (const [name, lines] of Object.entries(files)) {
    mkdirSync(join(dir, "-tmp-proj"), { recursive: true });
    writeFileSync(join(dir, "-tmp-proj", name), lines.join("\n") + "\n", "utf8");
  }
  return dir;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A store with one claude-code import plus one unrelated captured observation. */
async function seeded() {
  const data = mkdtempSync(join(tmpdir(), "fd-retract-root-"));
  const src = fixture({
    "sess-a.jsonl": [
      turn("a1", "记住：部署前一定先跑 conformance_gate"),
      turn("a2", "assistant 回复", "assistant"),
      turn("a3", "以后都用 --frozen-lockfile"),
    ],
  });
  const root = new StoreRoot(data, "d-retract");
  await runClaudeImport(root, "default", { projectsDir: src, batchSize: 2, batchPauseMs: 0 });
  // Another source entirely: auto-capture, labelled by the platform.
  root.appendObservation({
    session_id: "other-session",
    agent: "platform",
    event: "turn_outcome",
    tool: null,
    summary: "平台自己的回合一",
    created_at: "2026-11-15T11:00:00.000Z",
    project: "default",
  });
  root.writePage(
    "default",
    "notes",
    "other-note",
    newPage("note", "别的来源", "这段不属于导入，撤回不该碰它", {
      metadata: { source: "platform" },
    }),
  );
  return { data, src, root, sourceFile: join(src, "-tmp-proj", "sess-a.jsonl") };
}

test("4.2 retract hides the harness's records on query, recent and body; other sources survive", async () => {
  const { data, src, root, sourceFile } = await seeded();
  try {
    const before = {
      query: root.db.searchPages("conformance_gate", 10, ["default"]).length,
      recent: root.db.recentPages(50, ["default"]).length,
      obs: root.db.recentObservations(50, ["default"]).length,
      otherObs: root.db.recentObservations(50, ["default"]).filter((o) => o.agent === "platform").length,
    };
    assert.ok(before.query > 0, "fixture must import something searchable");
    assert.equal(before.otherObs, 1);

    const report = retractHarness(root, { harness: "claude-code" });
    assert.ok(report.pagesForgotten > 0, `expected pages forgotten, got ${JSON.stringify(report)}`);
    assert.ok(report.observationsDeleted > 0);
    assert.equal(report.markersWritten > 0, true);
    assert.equal(report.sourcesTouched, 0);
    assert.deepEqual(report.labels, HARNESS_IMPORT_LABELS["claude-code"]);

    // query face
    assert.equal(root.db.searchPages("conformance_gate", 10, ["default"]).length, 0);
    // recent face — pages and observations both
    assert.equal(root.db.searchPages("frozen-lockfile", 10, ["default"]).length, 0);
    const recentObs = root.db.recentObservations(50, ["default"]);
    assert.equal(recentObs.filter((o) => o.agent === "import:claude-code").length, 0);
    // body face — the page file stays (audit) but is frontmarked as forgotten
    const pages = root.db.pagesByMetadataSource(HARNESS_IMPORT_LABELS["claude-code"]);
    for (const p of pages) {
      const page = root.readPageByRel(p.path);
      assert.ok(page, `page file should still exist: ${p.path}`);
      assert.ok(page!.frontmatter.forgotten_at, `page not frontmarked: ${p.path}`);
    }
    // "other sources unaffected" — the half a pattern-based sweep would break
    assert.equal(root.db.recentObservations(50, ["default"]).filter((o) => o.agent === "platform").length, 1);
    assert.equal(root.db.searchPages("撤回不该碰它", 10, ["default"]).length, 1);

    // retract is durable: a replay rebuilds the index WITHOUT the withdrawn rows
    const replay = root.db.replayObservationsFromLog(root.wikiDir);
    assert.equal(replay.retracted > 0, true, "replay should report withdrawn rows");
    const after = root.db.recentObservations(50, ["default"]);
    assert.equal(after.filter((o) => o.agent === "import:claude-code").length, 0);
    assert.equal(after.filter((o) => o.agent === "platform").length, 1);
    assert.ok(sourceFile.length > 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("4.3 retract does not change a single byte of the source", async () => {
  const { data, src, root, sourceFile } = await seeded();
  try {
    const before = sha256(sourceFile);
    retractHarness(root, { harness: "claude-code" });
    assert.equal(sha256(sourceFile), before, "retract must not touch the source file");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("retract refuses an unknown harness instead of reporting zero", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-retract-bad-"));
  try {
    const root = new StoreRoot(data, "d-retract-bad");
    assert.throws(() => retractHarness(root, { harness: "cursor" }), /Unknown harness/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("dry-run reports the same counts and writes nothing", async () => {
  const { data, src, root } = await seeded();
  try {
    const dry = retractHarness(root, { harness: "claude-code", dryRun: true });
    assert.ok(dry.pagesForgotten > 0);
    assert.ok(dry.observationsDeleted > 0);
    assert.equal(dry.markersWritten, 0);
    // nothing was actually withdrawn
    assert.ok(root.db.searchPages("conformance_gate", 10, ["default"]).length > 0);
    assert.ok(root.db.recentObservations(50, ["default"]).some((o) => o.agent === "import:claude-code"));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});
