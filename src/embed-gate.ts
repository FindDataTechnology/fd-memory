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
const slowStreak = { n: 0, until: 0 };
const SLOW_STREAK_LIMIT = 2;
const COOLDOWN_MS = 60_000;

export function embedLaneCoolingDown(now = Date.now()): boolean {
  return now < slowStreak.until;
}

export function noteEmbedOutcome(ok: boolean, now = Date.now()): void {
  if (ok) {
    slowStreak.n = 0;
    return;
  }
  slowStreak.n += 1;
  if (slowStreak.n >= SLOW_STREAK_LIMIT) slowStreak.until = now + COOLDOWN_MS;
}

// Test seam: reset the module-level gate.
export function __resetEmbedGate(): void {
  chain = Promise.resolve();
  inflight.clear();
  slowStreak.n = 0;
  slowStreak.until = 0;
}
