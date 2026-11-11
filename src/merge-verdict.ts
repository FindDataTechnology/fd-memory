// Merge-arm verdict (add-digest-merge-eval-arm 3.1). Pure arithmetic, no I/O —
// same discipline as continue-gate.ts: the thresholds are a decision, and a
// decision you cannot re-compute from the per-scene rows is not a decision.
//
// The question this answers is NOT "is digest better than no memory" (that is
// the three-arm gate). It is "did turning the merge lever on make the injected
// memory worse" — so the comparison is merged vs split, and the failure branch
// points at a specific rollback (delete the platform env var).

import type { SceneScore } from "./continue-gate.js";

/**
 * Thresholds are pinned in the change's design.md D4 and MUST NOT move after a
 * run starts (picking the bar after seeing the scores is self-certification).
 * The design references these constants; it does not keep a second copy.
 */
export const MERGE_THRESHOLDS = {
  /** merged win+tie rate vs split, per metric. */
  winTieRate: 0.7,
  /** paired mean difference on the 1–5 scale (merged − split). */
  meanDiff: -0.25,
  /** below this many paired scenes the verdict is INSUFFICIENT_N, not a pass. */
  minN: 12,
} as const;

export type MergeVerdict = "PASS" | "REGRESSION" | "SUSPECT" | "INSUFFICIENT_N";

export interface MetricPairing {
  /** scenes with both arms present. */
  n: number;
  /** merged strictly better than split. */
  wins: number;
  /** merged exactly equal to split. */
  ties: number;
  /** merged strictly worse. */
  losses: number;
  /** (wins + ties) / n — the non-inferiority caliber. */
  winTieRate: number;
  /** mean(merged − split) on the 1–5 scale. */
  meanDiff: number;
  /** margin against the pinned bar; negative means the bar was missed. */
  winTieMargin: number;
  meanDiffMargin: number;
}

export interface MergeVerdictResult {
  verdict: MergeVerdict;
  n: number;
  re_derivation: MetricPairing;
  first_step: MetricPairing;
  /** Which criteria failed — empty on PASS, both entries on REGRESSION. */
  failures: string[];
  /** Human-readable one-liner, printed by the runner and stored in the record. */
  reason: string;
  thresholds: typeof MERGE_THRESHOLDS;
  /** What to undo if this is a regression. Kept next to the verdict so the
   *  record never says "regression" without saying "roll back what". */
  rollback: string;
}

const ROLLBACK = "删除 platform 清单 env FD_MEMORY_DIGEST_MERGE_OWN_SHARED（同时删 deploy 上的同名 env）并重建 pod，回到三段形状";

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number): number => Math.round(x * 1000) / 1000;

function pair(rows: Array<{ merged: number; split: number }>, threshold: number): MetricPairing {
  const n = rows.length;
  const wins = rows.filter((r) => r.merged > r.split).length;
  const ties = rows.filter((r) => r.merged === r.split).length;
  const losses = rows.filter((r) => r.merged < r.split).length;
  const winTieRate = n ? (wins + ties) / n : 0;
  const meanDiff = n ? avg(rows.map((r) => r.merged - r.split)) : 0;
  return {
    n,
    wins,
    ties,
    losses,
    winTieRate: round(winTieRate),
    meanDiff: round(meanDiff),
    winTieMargin: round(winTieRate - MERGE_THRESHOLDS.winTieRate),
    meanDiffMargin: round(meanDiff - threshold),
  };
}

/**
 * Verdict rules (design D4):
 *   both criteria met            → PASS
 *   both criteria missed         → REGRESSION (roll the lever back)
 *   exactly one missed           → SUSPECT (record, keep the lever, name the miss)
 *
 * "Both" is evaluated per metric and then across metrics: a metric passes only
 * when BOTH its win+tie rate and its mean difference clear their bars.
 */
export function computeMergeVerdict(perScene: SceneScore[]): MergeVerdictResult {
  const byScene = new Map<string, Record<string, SceneScore>>();
  for (const r of perScene) {
    if (!byScene.has(r.scene)) byScene.set(r.scene, {});
    byScene.get(r.scene)![r.arm] = r;
  }
  // Anything that is not one of the two comparison arms is ignored by
  // construction — the three-arm rows may ride in the same array.
  const pairs = [...byScene.values()].filter((x) => x["digest-merged"] && x["digest-split"]);
  const n = pairs.length;

  const re = pair(
    pairs.map((x) => ({ merged: x["digest-merged"].re_derivation, split: x["digest-split"].re_derivation })),
    MERGE_THRESHOLDS.meanDiff
  );
  const fs = pair(
    pairs.map((x) => ({ merged: x["digest-merged"].first_step, split: x["digest-split"].first_step })),
    MERGE_THRESHOLDS.meanDiff
  );

  const metricFails = (m: MetricPairing): string[] => {
    const out: string[] = [];
    if (m.winTieRate < MERGE_THRESHOLDS.winTieRate) out.push(`胜+平 ${m.winTieRate} < ${MERGE_THRESHOLDS.winTieRate}`);
    if (m.meanDiff < MERGE_THRESHOLDS.meanDiff) out.push(`平均分差 ${m.meanDiff} < ${MERGE_THRESHOLDS.meanDiff}`);
    return out;
  };
  const reFails = metricFails(re);
  const fsFails = metricFails(fs);
  const failures = [...reFails.map((f) => `重推导度: ${f}`), ...fsFails.map((f) => `首步正确性: ${f}`)];

  const base = { n, re_derivation: re, first_step: fs, failures, thresholds: MERGE_THRESHOLDS, rollback: ROLLBACK };

  if (n < MERGE_THRESHOLDS.minN) {
    return {
      ...base,
      verdict: "INSUFFICIENT_N",
      reason: `配对场景 ${n} < ${MERGE_THRESHOLDS.minN}，不出裁决（小样本下一条场景翻转就能让胜率跳 8 个点）`,
    };
  }
  if (!failures.length) {
    return {
      ...base,
      verdict: "PASS",
      reason:
        `合并臂不劣：胜+平 ${re.winTieRate}/${fs.winTieRate}（平局 ${re.ties}/${fs.ties}），` +
        `平均分差 ${re.meanDiff}/${fs.meanDiff}`,
    };
  }
  if (reFails.length && fsFails.length) {
    return { ...base, verdict: "REGRESSION", reason: `两个指标都未达标（${failures.join("；")}）——按 design D4 应回滚开关` };
  }
  return { ...base, verdict: "SUSPECT", reason: `仅一个指标未达标（${failures.join("；")}）——记录不改开关，但须写明差多少` };
}
