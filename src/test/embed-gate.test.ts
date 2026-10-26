// Serial gate + single-flight (2026-10-26 probe: sidecar runs serially but
// accepts unbounded concurrency — 5 parallel = 11.2s vs 1.4s each sequential).

import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeEmbed, __resetEmbedGate } from "../embed-gate.js";

function slowEmbed(ms: number) {
  let active = 0, maxActive = 0, calls = 0;
  const fn = async (texts: string[]) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, ms));
    active -= 1;
    return { vectors: texts.map(() => [0.1]), model: "m", tokens: 1 };
  };
  return { fn, stats: () => ({ maxActive, calls }) };
}

test("serial gate: concurrent callers never overlap on the sidecar", async () => {
  __resetEmbedGate();
  const { fn, stats } = slowEmbed(40);
  await Promise.all([serializeEmbed(fn, ["a"]), serializeEmbed(fn, ["b"]), serializeEmbed(fn, ["c"]), serializeEmbed(fn, ["d"])]);
  const s = stats();
  assert.equal(s.maxActive, 1, "one in-flight embed at a time");
  assert.equal(s.calls, 4, "all four distinct queries ran");
});

test("single-flight: identical in-flight queries coalesce to one sidecar call", async () => {
  __resetEmbedGate();
  const { fn, stats } = slowEmbed(40);
  const [a, b, c] = await Promise.all([serializeEmbed(fn, ["same"]), serializeEmbed(fn, ["same"]), serializeEmbed(fn, ["diff"])]);
  const s = stats();
  assert.equal(s.calls, 2, "duplicate coalesced, distinct ran");
  assert.deepEqual(a.vectors, b.vectors);
  assert.ok(c.vectors.length === 1);
});

test("gate: a failing call does not poison the chain", async () => {
  __resetEmbedGate();
  let n = 0;
  const fn = async (texts: string[]) => {
    n += 1;
    if (n === 1) throw new Error("boom");
    return { vectors: [[0.2]], model: "m", tokens: 1 };
  };
  const bad = serializeEmbed(fn, ["x"]);
  await assert.rejects(() => bad, /boom/);
  const ok = await serializeEmbed(fn, ["y"]);
  assert.equal(ok.vectors.length, 1, "next call still runs");
});
