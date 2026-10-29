// In-process metrics counters (add-memory-metrics, 2026-10-26): every prior
// optimisation in this line was diagnosed by grepping logs and ad-hoc probes.
// These counters make the same signals a single /admin/metrics read: digest
// rung distribution, embed latency quantiles, distill yield, degradation
// reasons. Process-lifetime counters (reset on restart) — a window, not a
// historical record; the log lines remain the audit trail.

export interface EmbedSample {
  ms: number;
  ok: boolean;
  reason?: string;
}

// `empty` is not a degradation (2026-10-29): a blank query has no vector to
// compute, so counting it as `keyword` made idle calls look like embed outages
// in the very ratio operators gate on.
const digestRungs = { vector: 0, keyword: 0, cooling: 0, empty: 0 };
const embedSamples: EmbedSample[] = [];
const EMBED_SAMPLE_CAP = 200;
const distills = { runs: 0, pages: 0, tokens: 0, failures: 0, lastError: "" as string };
// Embedding-model consistency (2026-10-28): the vector space is only valid
// while every stored vector and every query embedding come from ONE model.
// These counters make drift observable from a single /admin/metrics read.
const vectors = {
  mismatch_excluded: 0, // vectors skipped by the model filter at query time
  writes_rejected: 0, // guard refused a write whose model differs from the dominant
  writes_allowed: 0, // guard allowed (policy=allow) an off-model write
  skipped_no_model: 0, // sidecar returned no model name — vector NOT stored
  reembed_runs: 0, // /admin/reembed executions
  reembedded_pages: 0,
};
const startedAt = new Date().toISOString();

// Tier promotion lane (add-tier-promotion-candidates): the proposal face dies
// quietly if nobody can see it flowing — these counters make "is anyone ever
// accepting?" a single /admin/metrics read.
const promotion = { candidates: 0, proposed: 0, accepted: 0, ignored: 0 };
export function notePromotion(kind: keyof typeof promotion, n = 1): void {
  promotion[kind] += n;
}

export function noteDigestRung(rung: "vector" | "keyword" | "cooling" | "empty"): void {
  digestRungs[rung] += 1;
}

export function noteEmbedSample(s: EmbedSample): void {
  embedSamples.push(s);
  if (embedSamples.length > EMBED_SAMPLE_CAP) embedSamples.shift();
}

// Recent successful embed latency, for the adaptive per-call budget
// (fix-digest-adaptive-embed-deadline). Only successes count: a failed sample
// is truncated at whatever budget was in force, so feeding it back would make
// the budget feed on itself (slow → larger budget → larger recorded sample).
// Returns null when there is too little evidence to be worth adapting to.
export function recentEmbedP90(minSamples = 5): number | null {
  const oks = embedSamples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  if (oks.length < Math.max(1, minSamples)) return null;
  return quantile(oks, 0.9);
}

// Timeouts are CENSORED observations, not missing ones (2026-10-29, caught by
// real-machine verification): a timeout at budget B proves the true latency was
// AT LEAST B. Dropping them lets the budget collapse — in a bimodal lane (half
// the calls 2s, half 12s) every slow call times out, so the success-only p90
// sees 2s, the budget shrinks to 3s, and the slow half can never be observed
// again. The budget then ratchets downward on evidence that excludes the very
// requests it is starving.
// The floor here is the largest recent timeout wait: the budget must never be
// smaller than a wait we already proved was too small.
export function recentEmbedTimeoutFloor(): number {
  let max = 0;
  for (const s of embedSamples) {
    if (s.ok) continue;
    if (String(s.reason ?? "") !== "timeout") continue;
    if (s.ms > max) max = s.ms;
  }
  return max;
}

export type VectorEvent = "mismatch_excluded" | "writes_rejected" | "writes_allowed" | "skipped_no_model" | "reembed_runs" | "reembedded_pages";
export function noteVectorEvent(kind: VectorEvent, n = 1): void {
  vectors[kind] += n;
}

// Vector-scale observation (harden-memory-surfaces): the full-scan recall lane
// (`allPageVectors`) is safe only while per-root vector counts stay inside
// the measured zone — that fact used to live in a comment. `sampleVectorsScale`
// is fed per-root counts by the service (open roots + directory discovery)
// at /admin/metrics time; the thresholds read the SAME env the docs quote.
const VECTOR_WARN_MAX_PER_ROOT_DEFAULT = 2000; // measured max 304 → ~6.5x headroom
const VECTOR_WARN_TOTAL_DEFAULT = 10000; // measured global 1065 → ~9x headroom
function vectorScaleThresholds(): { max_per_root: number; total: number } {
  const mp = Number(process.env.FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT);
  const tt = Number(process.env.FD_MEMORY_VECTOR_WARN_TOTAL);
  return {
    max_per_root: Number.isFinite(mp) && mp > 0 ? Math.floor(mp) : VECTOR_WARN_MAX_PER_ROOT_DEFAULT,
    total: Number.isFinite(tt) && tt > 0 ? Math.floor(tt) : VECTOR_WARN_TOTAL_DEFAULT,
  };
}
let vectorsScaleSample = { roots: 0, total: 0, max_root: 0, over_threshold: false, threshold: vectorScaleThresholds() };
export function sampleVectorsScale(perRootCounts: number[]): void {
  const t = vectorScaleThresholds();
  const live = perRootCounts.filter((n) => n > 0);
  const total = live.reduce((a, b) => a + b, 0);
  const max = live.length ? Math.max(...live) : 0;
  vectorsScaleSample = { roots: live.length, total, max_root: max, over_threshold: max > t.max_per_root || total > t.total, threshold: t };
}

export function noteDistill(ok: boolean, pages: number, tokens: number, error?: string): void {
  if (ok) {
    distills.runs += 1;
    distills.pages += pages;
    distills.tokens += tokens;
  } else {
    distills.failures += 1;
    if (error) distills.lastError = String(error).slice(0, 300);
  }
}

function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function metricsSnapshot(): Record<string, unknown> {
  const oks = embedSamples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const fails = embedSamples.filter((s) => !s.ok);
  const reasons: Record<string, number> = {};
  for (const f of fails) {
    const k = String(f.reason ?? "unknown").slice(0, 80);
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  // `empty` stays out of the denominator: a blank-query digest never had a
  // vector rung to lose, so counting it would drag vector_ratio down for a
  // reason that is not an outage.
  const total = digestRungs.vector + digestRungs.keyword + digestRungs.cooling;
  return {
    started_at: startedAt,
    digest: {
      total,
      ...digestRungs,
      vector_ratio: total ? Number((digestRungs.vector / total).toFixed(3)) : null,
    },
    embed: {
      samples: embedSamples.length,
      ok: oks.length,
      failed: fails.length,
      ms_p50: quantile(oks, 0.5),
      ms_p90: quantile(oks, 0.9),
      ms_max: oks.length ? oks[oks.length - 1] : null,
      failure_reasons: reasons,
    },
    distill: { runs: distills.runs, pages: distills.pages, tokens: distills.tokens, failures: distills.failures, last_error: distills.lastError },
    promotion: { ...promotion },
    vectors: { ...vectors },
    "vectors.scale": vectorsScaleSample,
  };
}

// Test seam.
export function __resetMetrics(): void {
  digestRungs.vector = 0;
  digestRungs.keyword = 0;
  digestRungs.cooling = 0;
  digestRungs.empty = 0;
  embedSamples.length = 0;
  promotion.candidates = 0;
  promotion.proposed = 0;
  promotion.accepted = 0;
  promotion.ignored = 0;
  vectorsScaleSample = { roots: 0, total: 0, max_root: 0, over_threshold: false, threshold: vectorScaleThresholds() };
  distills.runs = 0;
  distills.pages = 0;
  distills.tokens = 0;
  distills.failures = 0;
  distills.lastError = "";
  vectors.mismatch_excluded = 0;
  vectors.writes_rejected = 0;
  vectors.writes_allowed = 0;
  vectors.skipped_no_model = 0;
  vectors.reembed_runs = 0;
  vectors.reembedded_pages = 0;
}
