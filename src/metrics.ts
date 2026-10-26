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

const digestRungs = { vector: 0, keyword: 0, cooling: 0 };
const embedSamples: EmbedSample[] = [];
const EMBED_SAMPLE_CAP = 200;
const distills = { runs: 0, pages: 0, tokens: 0, failures: 0, lastError: "" as string };
const startedAt = new Date().toISOString();

export function noteDigestRung(rung: "vector" | "keyword" | "cooling"): void {
  digestRungs[rung] += 1;
}

export function noteEmbedSample(s: EmbedSample): void {
  embedSamples.push(s);
  if (embedSamples.length > EMBED_SAMPLE_CAP) embedSamples.shift();
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
  };
}

// Test seam.
export function __resetMetrics(): void {
  digestRungs.vector = 0;
  digestRungs.keyword = 0;
  digestRungs.cooling = 0;
  embedSamples.length = 0;
  distills.runs = 0;
  distills.pages = 0;
  distills.tokens = 0;
  distills.failures = 0;
  distills.lastError = "";
}
