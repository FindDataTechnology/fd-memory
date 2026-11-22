// Embed keep-warm (2026-10-26, served-rung data): the sidecar shares its GPU
// with the LLM, so idle stretches swap the embed model out — the next /digest
// then blows its 3.5s internal deadline and degrades to keyword recall (run14
// logged repeated "embed query failed" degradations; the historical cold cliff
// measured 122.7s). A tiny periodic ping pins the model: one 8-char embed
// every few minutes costs effectively nothing and keeps the vector rung hot.
// FD_MEMORY_EMBED_KEEPWARM=0 is the kill switch; failures are silent (the
// digest face has its own degradation path — this is pure opportunism).

import { sidecarEmbed, embedDisabled } from "./distill-scheduler.js";
import { serializeEmbed } from "./embed-gate.js";

const DEFAULT_INTERVAL_MS = 4 * 60_000;

export function startEmbedKeepwarm(opts: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: { warn: (msg: string) => void };
  intervalMs?: number;
} = {}): { stop: () => void } {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console;
  const url = String(env.FD_MEMORY_DISTILLER_URL ?? "").trim();
  // `FD_MEMORY_EMBED=off` must stop keep-warm too (2026-11-18). This lane had
  // its own kill switch (`FD_MEMORY_EMBED_KEEPWARM`) and never consulted the
  // global one, so a deployment that had turned embeddings OFF still pinged
  // /embed every 4 minutes — against a gateway with no embedding model, i.e. a
  // guaranteed 404 forever. Same shape as the hybridCandidates gap fixed the
  // same day: a switch that one seam honours and another ignores. Keep-warm is
  // pure opportunism (see the header), so disabling it costs nothing when the
  // lane is already off.
  if (!url || env.FD_MEMORY_EMBED_KEEPWARM === "0" || embedDisabled(env)) return { stop: () => {} };
  const intervalMs = opts.intervalMs ?? (Number(env.FD_MEMORY_EMBED_KEEPWARM_INTERVAL_MS ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);  const timer = setInterval(() => {
    serializeEmbed((t) => sidecarEmbed(env, t, opts.fetchImpl), ["keep-warm"]).catch(() => {
      /* silent: opportunistic warmth, the digest face degrades on its own */
    });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
