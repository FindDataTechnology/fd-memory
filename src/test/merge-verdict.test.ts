// Merge verdict arithmetic (add-digest-merge-eval-arm 3.1). Hand-computed
// fixtures — the numbers are worked out on paper, so this checks the caliber
// rather than snapshotting whatever the runner printed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMergeVerdict, MERGE_THRESHOLDS } from "../merge-verdict.js";
import type { SceneScore } from "../continue-gate.js";

function rows(pairs: Array<[number, number, number, number]>, scenePrefix = "s"): SceneScore[] {
  const out: SceneScore[] = [];
  pairs.forEach(([mRe, sRe, mFs, sFs], i) => {
    out.push({ scene: `${scenePrefix}${i}`, arm: "digest-merged", re_derivation: mRe, first_step: mFs });
    out.push({ scene: `${scenePrefix}${i}`, arm: "digest-split", re_derivation: sRe, first_step: sFs });
  });
  return out;
}

const twelve = (mRe: number, sRe: number, mFs = mRe, sFs = sRe): Array<[number, number, number, number]> =>
  Array.from({ length: 12 }, () => [mRe, sRe, mFs, sFs] as [number, number, number, number]);

test("merged not worse than split → PASS", () => {
  // 8 merged-better, 4 ties: win+tie = 12/12 = 1.0; mean diff +0.67 both metrics.
  const pairs: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 8; i++) pairs.push([4, 2, 4, 2]);
  for (let i = 0; i < 4; i++) pairs.push([3, 3, 3, 3]);
  const v = computeMergeVerdict(rows(pairs));
  assert.equal(v.verdict, "PASS", v.reason);
  assert.equal(v.re_derivation.winTieRate, 1);
  assert.ok(v.re_derivation.meanDiff > 0);
  assert.match(v.reason, /平局 4/);
});

test("all ties → PASS (indistinguishable is not a loss)", () => {
  const v = computeMergeVerdict(rows(twelve(3, 3)));
  assert.equal(v.verdict, "PASS", v.reason);
  assert.equal(v.re_derivation.ties, 12);
  assert.equal(v.re_derivation.winTieRate, 1);
});

test("both metrics clearly worse → REGRESSION with a rollback instruction", () => {
  // Every scene: merged 1 vs split 4 → win+tie 0, mean diff −3 on both metrics.
  const v = computeMergeVerdict(rows(twelve(1, 4)));
  assert.equal(v.verdict, "REGRESSION", v.reason);
  assert.equal(v.failures.length, 4, "both criteria on both metrics should be named");
  assert.match(v.rollback, /FD_MEMORY_DIGEST_MERGE_OWN_SHARED/);
  assert.ok(v.re_derivation.meanDiffMargin < 0);
});

test("only one metric misses → SUSPECT, not REGRESSION", () => {
  // re_derivation: merged worse everywhere (fails both bars).
  // first_step: identical everywhere (passes both bars).
  const pairs = twelve(1, 4, 3, 3);
  const v = computeMergeVerdict(rows(pairs));
  assert.equal(v.verdict, "SUSPECT", v.reason);
  assert.ok(v.failures.every((f) => f.startsWith("重推导度")), v.failures.join(";"));
});

test("small sample yields INSUFFICIENT_N, never PASS", () => {
  const v = computeMergeVerdict(rows(twelve(4, 1).slice(0, 5)));
  assert.equal(v.verdict, "INSUFFICIENT_N", v.reason);
  assert.equal(v.n, 5);
  assert.match(v.reason, /< 12/);
});

test("three-arm rows riding in the same array are ignored", () => {
  const mergeRows = rows(twelve(4, 4));
  const withNoise: SceneScore[] = [
    ...mergeRows,
    ...mergeRows.map((r) => ({ ...r, arm: "digest" as const })),
    ...mergeRows.map((r) => ({ ...r, arm: "none" as const })),
  ];
  const a = computeMergeVerdict(mergeRows);
  const b = computeMergeVerdict(withNoise);
  assert.equal(b.n, a.n);
  assert.equal(b.verdict, a.verdict);
});

test("thresholds are the pinned ones (a silent re-calibration is a red test)", () => {
  assert.equal(MERGE_THRESHOLDS.winTieRate, 0.7);
  assert.equal(MERGE_THRESHOLDS.meanDiff, -0.25);
  assert.equal(MERGE_THRESHOLDS.minN, 12);
});

// 3.3: the thresholds must have ONE source. design.md points at these constants;
// if someone edits the code, this test is the tripwire that forces the design
// text to be revisited in the same change.
//
// Scope note: the runner legitimately carries the THREE-arm gate's own numbers
// (win_rate_min 0.7 etc.) — a first version of this test flagged those and was
// wrong. What must not be duplicated is the MERGE thresholds, so the check is
// scoped to the merge-mode block.
test("merge thresholds are not duplicated in the runner", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../scripts/eval-continue.mjs", import.meta.url), "utf8");
  const start = src.indexOf("merge-arm comparison (add-digest-merge-eval-arm 3.2)");
  assert.ok(start > 0, "merge-mode block not found — did the marker move?");
  const block = src.slice(start, src.indexOf("// paired aggregation (design D6)", start));
  const code = block.replace(/\/\/.*$/gm, "");
  assert.ok(!/0\.7\b/.test(code), "merge block hard-codes the 0.7 bar");
  assert.ok(!/-\s*0\.25\b/.test(code), "merge block hard-codes the -0.25 bar");
});
