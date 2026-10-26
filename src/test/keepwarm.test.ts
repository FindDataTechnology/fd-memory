// Keep-warm tests: gates, cadence, silence (add-keepwarm, 2026-10-26).

import { test } from "node:test";
import assert from "node:assert/strict";
import { startEmbedKeepwarm } from "../keepwarm.js";

function countingFetch(delayMs = 0) {
  const calls: string[] = [];
  const impl = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, status: 200, json: async () => ({ vectors: [[0.1]], model: "m", tokens: 1 }) };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("keepwarm: pings on the interval when the lane is configured; FD_MEMORY_EMBED_KEEPWARM=0 or no URL → inert", async () => {
  const { calls, impl } = countingFetch();
  const on = startEmbedKeepwarm({ env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", DISTILLER_SHARED_TOKEN: "t" }, fetchImpl: impl, intervalMs: 40 });
  await new Promise((r) => setTimeout(r, 150));
  on.stop();
  assert.ok(calls.length >= 2, `pinged ${calls.length} times over 150ms@40ms`);
  assert.ok(calls.every((c) => c.endsWith("/embed")));
  // kill switch
  const { calls: offCalls, impl: offImpl } = countingFetch();
  const off = startEmbedKeepwarm({ env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_EMBED_KEEPWARM: "0" }, fetchImpl: offImpl, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  off.stop();
  assert.equal(offCalls.length, 0, "kill switch = no pings");
  // no URL → inert
  const { calls: noUrlCalls, impl: noUrlImpl } = countingFetch();
  const noUrl = startEmbedKeepwarm({ env: {}, fetchImpl: noUrlImpl, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  noUrl.stop();
  assert.equal(noUrlCalls.length, 0, "no sidecar URL = inert");
});

test("keepwarm: embed failures are swallowed (silent opportunism)", async () => {
  const impl = (async () => { throw new Error("lane down"); }) as unknown as typeof fetch;
  const kw = startEmbedKeepwarm({ env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test" }, fetchImpl: impl, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 100));
  kw.stop();
  assert.ok(true, "no unhandled rejection escaped");
});
