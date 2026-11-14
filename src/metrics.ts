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
// Per-run samples (optimize-yongyi-read-surfaces 7.1). The cost knobs that
// matter — how many items a run swallowed, how many engine calls that took,
// what it billed — were only visible as cumulative counters, which cannot
// answer "is one run doing 120 calls?" or "did a chunk split get worse".
// Bounded ring so a long-lived process does not accumulate a history.
const DISTILL_SAMPLE_MAX = 200;
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

// Declared process policy (add-agent-memory-declaration): the distill scheduler
// degrades to the deployment default when the policy read fails, because "a
// policy read must never stop distillation". That degradation is correct — but
// a silent one means a persistent read failure un-honours every declared
// `distill: off` while the read face still reports the declaration as in force.
// Counting it makes "the declaration is decoration right now" one metrics read
// instead of a grep through logs nobody wrote (2026-11-14).
const policy = { read_failures: 0, last_error: "" as string };
export function notePolicyReadFailure(err: unknown): void {
  policy.read_failures += 1;
  const head = String((err as { message?: unknown })?.message ?? err ?? "unknown");
  policy.last_error = head.slice(0, 200);
}

// Tier promotion lane (add-tier-promotion-candidates): the proposal face dies
// quietly if nobody can see it flowing — these counters make "is anyone ever
// accepting?" a single /admin/metrics read.
const promotion = { candidates: 0, proposed: 0, accepted: 0, ignored: 0 };
export function notePromotion(kind: keyof typeof promotion, n = 1): void {
  promotion[kind] += n;
}

// Structured-filter usage (add-agent-memory-foundation): whether the metadata
// lane is actually being consumed — zero over a full day means the structured
// surface shipped but nobody calls it.
let metaFilterQueries = 0;
export function noteMetaFilter(n = 1): void {
  metaFilterQueries += n;
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

const distillSamples: Array<{ items: number; calls: number; tokens: number; pages: number }> = [];
// Per-stage token profile (optimize-yongyi-read-surfaces 7.1). A distill run is
// several engine calls — extract, then a reconcile per stream — and "tokens per
// call" says nothing about which stage to attack. The sidecar already reports
// prompt/completion tokens per call with its audit_stage; aggregating them turns
// "reduce cost" from a guess into a measurement.
const distillStages: Record<string, { calls: number; prompt: number; completion: number }> = {};
// Truncation visibility (fix-distill-extract-truncation 1.2). A distill run that
// hit the extract completion ceiling and one that genuinely found nothing are
// today indistinguishable in every surface we have — both are pages=0 with a
// clean cursor. Counting the ceiling hits is the first step to telling them
// apart; it changes no behavior on its own.
const distillTruncation = { runs: 0, truncated: 0 };

export function noteDistill(
  ok: boolean,
  pages: number,
  tokens: number,
  error?: string,
  extra?: { items?: number; calls?: number },
): void {
  if (ok) {
    distills.runs += 1;
    distills.pages += pages;
    distills.tokens += tokens;
    distillSamples.push({
      items: Math.max(0, Math.floor(Number(extra?.items ?? 0)) || 0),
      calls: Math.max(0, Math.floor(Number(extra?.calls ?? 0)) || 0),
      tokens: Math.max(0, Number(tokens) || 0),
      pages,
    });
    if (distillSamples.length > DISTILL_SAMPLE_MAX) distillSamples.shift();
  } else {
    distills.failures += 1;
    if (error) distills.lastError = String(error).slice(0, 300);
  }
}

export function noteDistillStages(calls: unknown): void {
  if (!Array.isArray(calls)) return;
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { stage?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown; ok?: unknown };
    if (c.ok === false) continue; // a failed call has no usable profile
    const stage = String(c.stage ?? "?");
    const slot = distillStages[stage] ?? (distillStages[stage] = { calls: 0, prompt: 0, completion: 0 });
    slot.calls += 1;
    slot.prompt += Number(c.prompt_tokens ?? 0) || 0;
    slot.completion += Number(c.completion_tokens ?? 0) || 0;
  }
}

/**
 * Was this run's extract output cut off by the completion ceiling?
 *
 * The signal is deliberately narrow: a successful (ok) coding_extract call whose
 * completion_tokens reached `maxTokens * ratio`. Parse failures are NOT used —
 * they can come from malformed output too, and retrying on those would loop
 * forever. The 2% slack absorbs provider rounding of the token count.
 */
export function extractHitCeiling(calls: unknown, maxTokens: number, ratio = Number(process.env.FD_MEMORY_EXTRACT_CEILING_RATIO ?? 0.98)): boolean {
  if (!Array.isArray(calls) || !(maxTokens > 0)) return false;
  const ceiling = maxTokens * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.98);
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { stage?: unknown; ok?: unknown; completion_tokens?: unknown };
    if (String(c.stage) !== "coding_extract") continue;
    if (c.ok === false) continue;
    if (Number(c.completion_tokens ?? 0) >= ceiling) return true;
  }
  return false;
}

export function noteDistillTruncation(truncated: boolean): void {
  distillTruncation.runs += 1;
  if (truncated) distillTruncation.truncated += 1;
}

function distillDistribution(): {
  samples: number;
  items: { total: number; mean: number; max: number };
  calls: { total: number; mean: number; max: number };
  tokens: { total: number; mean: number; p50: number | null; p90: number | null; max: number };
  last: { items: number; calls: number; tokens: number; pages: number } | null;
} {
  const n = distillSamples.length;
  const last = n ? distillSamples[n - 1] : null;
  if (!n) {
    const zero = { total: 0, mean: 0, max: 0 };
    return { samples: 0, items: zero, calls: zero, tokens: { ...zero, p50: null, p90: null }, last };
  }
  const sum = (pick: (x: (typeof distillSamples)[number]) => number) => distillSamples.reduce((a, x) => a + pick(x), 0);
  const maxOf = (pick: (x: (typeof distillSamples)[number]) => number) => Math.max(...distillSamples.map(pick));
  const tok = distillSamples.map((x) => x.tokens).sort((a, b) => a - b);
  const itemsTotal = sum((x) => x.items);
  const callsTotal = sum((x) => x.calls);
  const tokensTotal = sum((x) => x.tokens);
  return {
    samples: n,
    items: { total: itemsTotal, mean: Number((itemsTotal / n).toFixed(1)), max: maxOf((x) => x.items) },
    calls: { total: callsTotal, mean: Number((callsTotal / n).toFixed(1)), max: maxOf((x) => x.calls) },
    tokens: {
      total: tokensTotal,
      mean: Math.round(tokensTotal / n),
      p50: quantile(tok, 50),
      p90: quantile(tok, 90),
      max: maxOf((x) => x.tokens),
    },
    last,
  };
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
    distill: {
      runs: distills.runs,
      pages: distills.pages,
      tokens: distills.tokens,
      failures: distills.failures,
      last_error: distills.lastError,
      // Distribution over the last DISTILL_SAMPLE_MAX successful runs.
      recent: distillDistribution(),
      // Per-stage token profile over the process lifetime.
      stages: distillStages,
      // How often a run's extract output reached the completion ceiling.
      truncated: {
        runs: distillTruncation.runs,
        truncated: distillTruncation.truncated,
        ratio: distillTruncation.runs ? Number((distillTruncation.truncated / distillTruncation.runs).toFixed(3)) : null,
        ceiling_ratio: Number(process.env.FD_MEMORY_EXTRACT_CEILING_RATIO ?? 0.98),
      },
    },
    promotion: { ...promotion },
    policy: { ...policy },
    meta_filter_queries: metaFilterQueries,
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
  policy.read_failures = 0;
  policy.last_error = "";
  metaFilterQueries = 0;
  vectorsScaleSample = { roots: 0, total: 0, max_root: 0, over_threshold: false, threshold: vectorScaleThresholds() };
  distills.runs = 0;
  distills.pages = 0;
  distills.tokens = 0;
  distills.failures = 0;
  distills.lastError = "";
  distillSamples.length = 0;
  for (const k of Object.keys(distillStages)) delete distillStages[k];
  distillTruncation.runs = 0;
  distillTruncation.truncated = 0;
  vectors.mismatch_excluded = 0;
  vectors.writes_rejected = 0;
  vectors.writes_allowed = 0;
  vectors.skipped_no_model = 0;
  vectors.reembed_runs = 0;
  vectors.reembedded_pages = 0;
}
