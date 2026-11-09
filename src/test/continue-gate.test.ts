// Gate arithmetic (optimize-yongyi-read-surfaces 5.1). Hand-computed fixture:
// the numbers below are worked out by hand, not captured from a run, so the
// test is a real check of the caliber rather than a snapshot of whatever the
// script happened to print.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGates, type SceneScore } from "../continue-gate.js";

function row(scene: string, arm: string, re: number, fs: number): SceneScore {
  return { scene, arm, re_derivation: re, first_step: fs };
}

test("gate: headroom caliber excludes scenes that could only tie, and non-inferiority spans the full set", () => {
  // Six pairs, hand-worked:
  //   s1 none=2 digest=4  → headroom scene, win
  //   s2 none=3 digest=3  → headroom scene, tie (no win)
  //   s3 none=4 digest=5  → NO headroom (none>3), excluded from the win rate
  //   s4 none=5 digest=5  → NO headroom, tie
  //   s5 none=1 digest=1  → headroom scene, tie (digest is not worse: non-inferior)
  //   s6 none=4 digest=2  → NO headroom, and digest is 2 points worse → not non-inferior
  const rows: SceneScore[] = [
    row("s1", "none", 2, 2), row("s1", "digest", 4, 4),
    row("s2", "none", 3, 3), row("s2", "digest", 3, 3),
    row("s3", "none", 4, 4), row("s3", "digest", 5, 5),
    row("s4", "none", 5, 5), row("s4", "digest", 5, 5),
    row("s5", "none", 1, 1), row("s5", "digest", 1, 1),
    row("s6", "none", 4, 4), row("s6", "digest", 2, 2),
  ];
  const g = computeGates(rows, { minN: 6 });

  assert.equal(g.n, 6);
  // diffs: +2, 0, +1, 0, 0, -2 → avg = 1/6 ≈ 0.167
  assert.ok(Math.abs(g.avgDiffRe - 1 / 6) < 1e-9, `avg diff ${g.avgDiffRe}`);

  // Full set: wins where digest > none → s1(+2), s3(+1) = 2/6
  assert.deepEqual(g.full, { wins: 2, n: 6, rate: 2 / 6 });

  // Headroom (none ≤ 3): s1, s2, s5 → wins = 1/3
  assert.deepEqual(g.headroom, { wins: 1, n: 3, rate: 1 / 3 });

  // Non-inferior (digest ≥ none − 1): all but s6 → 5/6
  assert.deepEqual(g.nonInferior, { count: 5, n: 6, rate: 5 / 6 });

  // Gates: avg diff < 0.5 and headroom win < 70% → reDerivation fails; the
  // non-inferior gate passes (83% ≥ 70%).
  assert.equal(g.gates.reDerivation, false);
  assert.equal(g.gates.nonInferior, true);
  assert.equal(g.verdict, "FAIL");
});

test("gate: a run with no headroom scenes cannot pass on the calibrated caliber", () => {
  const rows: SceneScore[] = [
    row("a", "none", 5, 5), row("a", "digest", 5, 5),
    row("b", "none", 4, 4), row("b", "digest", 5, 5),
  ];
  const g = computeGates(rows, { minN: 2 });
  assert.equal(g.headroom.n, 0);
  assert.equal(g.headroom.rate, null, "no denominator is reported as null, not 0%");
  assert.equal(g.gates.reDerivation, false, "an empty win denominator cannot pass");
});

test("gate: note-depth that never ran is not_run and does not count; one that ran and failed does", () => {
  const base: SceneScore[] = [];
  for (let i = 0; i < 12; i++) {
    base.push(row(`s${i}`, "none", 2, 2), row(`s${i}`, "digest", 4, 4));
  }
  // Perfect digest arm: avg diff 2, headroom win 100%, non-inferior 100%.
  const noDepth = computeGates(base, { minN: 12 });
  assert.equal(noDepth.noteDepth.status, "not_run");
  assert.match(noDepth.noteDepth.reason ?? "", /no digest\+distill/);
  assert.equal(noDepth.verdict, "PASS", "an unrun gate is excluded, not failing");

  // Deep scene where plain digest is already at the ceiling → still not_run.
  const ceiling = [...base, row("deep-1", "digest", 5, 5), row("deep-1", "digest+distill", 5, 5)];
  const c = computeGates(ceiling, { minN: 12 });
  assert.equal(c.noteDepth.status, "not_run");
  assert.equal(c.noteDepth.ceilinged, 1);

  // Deep scene with headroom where distillation adds < 1 → fail, and the run fails.
  const failed = [...base, row("deep-2", "digest", 3, 3), row("deep-2", "digest+distill", 3, 3)];
  const f = computeGates(failed, { minN: 12 });
  assert.equal(f.noteDepth.status, "fail");
  assert.equal(f.noteDepth.avgDelta, 0);
  assert.equal(f.verdict, "FAIL", "a gate that ran and failed still fails the run");

  // Deep scene where distillation adds ≥1 → pass.
  const passed = [...base, row("deep-3", "digest", 2, 2), row("deep-3", "digest+distill", 4, 4)];
  const p = computeGates(passed, { minN: 12 });
  assert.equal(p.noteDepth.status, "pass");
  assert.equal(p.noteDepth.avgDelta, 2);
  assert.equal(p.verdict, "PASS");
});

test("gate: too few pairs yields INSUFFICIENT_N regardless of the numbers", () => {
  const g = computeGates([row("a", "none", 1, 1), row("a", "digest", 5, 5)], { minN: 12 });
  assert.equal(g.verdict, "INSUFFICIENT_N(1)");
});
