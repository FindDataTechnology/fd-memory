// Sidecar embed single-flight + serial gate (2026-10-26 production probe):
// the sidecar runs embeddings serially but accepts unbounded concurrent
// requests — 5 parallel calls measured 11.2s total (~2.2s each, queueing on
// each other) versus 1.1-1.5s each when sequential. Under real traffic
// (consecutive digests) that queue blows every caller's deadline and the
// vector rung collapses to keyword recall. One in-flight embed at a time,
// with identical in-flight queries coalesced, keeps the lane honest; a short
// queue wait is still strictly better than degrading to keyword recall.

type EmbedFn = (texts: string[]) => Promise<{ vectors: number[][]; model: string; tokens: number }>;

let chain: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<{ vectors: number[][]; model: string; tokens: number }>>();

export function serializeEmbed(embed: EmbedFn, texts: string[], opts: { coalesce?: boolean } = {}): Promise<{ vectors: number[][]; model: string; tokens: number }> {
  const key = opts.coalesce === false ? "" : texts.join("\u0000");
  if (key) {
    const hit = inflight.get(key);
    if (hit) return hit;
  }
  const run = chain.then(() => embed(texts));
  chain = run.catch(() => {}); // never let one failure poison the chain
  if (key) {
    inflight.set(key, run);
    const clear = () => inflight.delete(key);
    run.then(clear, clear);
  }
  return run;
}

// Adaptive skip (2026-10-26 probe): the sidecar degrades monotonically under
// sustained load (8 sequential probes: 1.2s → 11.7s). Once recent attempts
// keep blowing the deadline, paying the full timeout every request is pure
// loss — skip the lane for a cool-down window and serve keyword recall
// immediately. A successful call resets the streak.
// Sustained-load probe (2026-10-26, 60 digests / 12min + 8-way bursts):
// ratio climbed monotonically (0.64→0.78) so the lane is stable, but the
// on/off oscillation (40 skips vs 9 successes) showed the two-strike rule was
// too jumpy — one success zeroed the streak, the next failure re-armed it.
// Now: failures escalate the penalty (2 min → 4 → 8, capped 8 min) and a
// success HACKS one strike off rather than clearing it, so a flaky lane
// settles into a stable duty cycle instead of flapping.
const slowStreak = { n: 0, until: 0 };
const SLOW_STREAK_LIMIT = 2;
const COOLDOWN_BASE_MS = 120_000;
const COOLDOWN_MAX_MS = 8 * 60_000;

export function embedLaneCoolingDown(now = Date.now()): boolean {
  return now < slowStreak.until;
}

export function noteEmbedOutcome(ok: boolean, now = Date.now()): void {
  if (ok) {
    if (slowStreak.n > 0) slowStreak.n -= 1; // one strike off, not a reset
    return;
  }
  slowStreak.n += 1;
  if (slowStreak.n >= SLOW_STREAK_LIMIT) {
    const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** Math.max(0, slowStreak.n - SLOW_STREAK_LIMIT));
    slowStreak.until = now + backoff;
  }
}

// Test seam: reset the module-level gate.
export function __resetEmbedGate(): void {
  chain = Promise.resolve();
  inflight.clear();
  slowStreak.n = 0;
  slowStreak.until = 0;
}
