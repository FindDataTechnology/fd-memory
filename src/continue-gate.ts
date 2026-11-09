// Continuation-eval gates (optimize-yongyi-read-surfaces 5.1 / memory-eval
// "胜率门按头部空间校准"). Pure arithmetic, no I/O: the eval script feeds it the
// per-scene rows and prints what it returns, and tests feed it a hand-computed
// fixture. Keeping it out of the script is what makes "the numbers are right"
// checkable without spending a model budget.

export interface SceneScore {
  scene: string;
  arm: string;
  re_derivation: number;
  first_step: number;
}

export interface GateResult {
  n: number;
  avgDiffRe: number;
  // Full-set win rate: kept as the legacy caliber, printed for comparison and
  // recorded in the baseline, but NOT part of the verdict.
  full: { wins: number; n: number; rate: number };
  // Headroom-calibrated: only scenes where the no-memory arm scored ≤3 (it has
  // background it could actually re-derive).
  headroom: { wins: number; n: number; rate: number | null };
  // Non-inferior: digest is not worse than none by more than one point.
  nonInferior: { count: number; n: number; rate: number };
  firstStep: { avgDiff: number; wins: number; ties: number; n: number; rate: number };
  noteDepth: {
    status: "pass" | "fail" | "not_run";
    scenes: number;
    ceilinged: number;
    avgDelta: number | null;
    reason?: string;
  };
  gates: { reDerivation: boolean; nonInferior: boolean; firstStep: boolean };
  verdict: string;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function computeGates(perScene: SceneScore[], opts: { minN?: number } = {}): GateResult {
  const minN = opts.minN ?? 12;
  const byScene = new Map<string, Record<string, SceneScore>>();
  for (const r of perScene) {
    if (!byScene.has(r.scene)) byScene.set(r.scene, {});
    byScene.get(r.scene)![r.arm] = r;
  }
  const pairs = [...byScene.values()].filter((x) => x.none && x.digest);
  const n = pairs.length;
  const diffsRe = pairs.map((x) => x.digest.re_derivation - x.none.re_derivation);
  const diffsFs = pairs.map((x) => x.digest.first_step - x.none.first_step);
  const avgDiffRe = avg(diffsRe);

  const wins = pairs.filter((x) => x.digest.re_derivation > x.none.re_derivation).length;
  const full = { wins, n, rate: n ? wins / n : 0 };

  const headroomPairs = pairs.filter((x) => x.none.re_derivation <= 3);
  const headroomWins = headroomPairs.filter((x) => x.digest.re_derivation > x.none.re_derivation).length;
  const headroom = {
    wins: headroomWins,
    n: headroomPairs.length,
    rate: headroomPairs.length ? headroomWins / headroomPairs.length : null,
  };

  const nonInferiorCount = pairs.filter((x) => x.digest.re_derivation >= x.none.re_derivation - 1).length;
  const nonInferior = { count: nonInferiorCount, n, rate: n ? nonInferiorCount / n : 0 };

  const winsFs = pairs.filter((x) => x.digest.first_step > x.none.first_step).length;
  const tiesFs = pairs.filter((x) => x.digest.first_step === x.none.first_step).length;
  const firstStep = { avgDiff: avg(diffsFs), wins: winsFs, ties: tiesFs, n, rate: n ? (winsFs + tiesFs) / n : 0 };

  // note-depth: distilled arm vs plain digest on deep scenes. A scene already at
  // the ceiling under plain digest has nothing for distillation to add, so it
  // measures nothing; when no scene has headroom the gate is NOT RUN — never a
  // pass (a gate that never executed must not read as a gate that succeeded).
  const ddRows = perScene.filter((r) => r.arm === "digest+distill");
  let noteDepth: GateResult["noteDepth"] = {
    status: "not_run",
    scenes: 0,
    ceilinged: 0,
    avgDelta: null,
    reason: "no digest+distill samples in this run",
  };
  if (ddRows.length) {
    const ddByScene = new Map(ddRows.map((r) => [r.scene, r]));
    const deepAll = perScene.filter((r) => r.arm === "digest" && r.scene.startsWith("deep-") && ddByScene.has(r.scene));
    const deepPlain = deepAll.filter((r) => r.re_derivation < 5);
    const ceilinged = deepAll.length - deepPlain.length;
    if (deepPlain.length === 0) {
      noteDepth = {
        status: "not_run",
        scenes: deepAll.length,
        ceilinged,
        avgDelta: 0,
        reason: deepAll.length
          ? "every deep scene is already at the ceiling under plain digest — no headroom to measure"
          : "no deep-* scene was sampled by both the digest and digest+distill arms",
      };
    } else {
      const delta = avg(deepPlain.map((r) => ddByScene.get(r.scene)!.re_derivation - r.re_derivation));
      noteDepth = { status: delta >= 1 ? "pass" : "fail", scenes: deepPlain.length, ceilinged, avgDelta: delta };
    }
  }

  const gates = {
    reDerivation: avgDiffRe >= 0.5 && (headroom.rate ?? 0) >= 0.7,
    nonInferior: nonInferior.rate >= 0.7,
    firstStep: firstStep.avgDiff >= 0.5 && firstStep.rate >= 0.7,
  };
  // not_run is excluded from the pass condition; ran-and-failed still fails.
  const noteDepthOk = noteDepth.status !== "fail";
  const verdict =
    n < minN
      ? `INSUFFICIENT_N(${n})`
      : gates.reDerivation && gates.nonInferior && gates.firstStep && noteDepthOk
        ? "PASS"
        : "FAIL";

  return { n, avgDiffRe, full, headroom, nonInferior, firstStep, noteDepth, gates, verdict };
}
