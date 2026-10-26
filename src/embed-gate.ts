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

// Test seam: reset the module-level gate.
export function __resetEmbedGate(): void {
  chain = Promise.resolve();
  inflight.clear();
}
