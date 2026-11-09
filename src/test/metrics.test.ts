// /admin/metrics: rung distribution, embed quantiles + failure reasons,
// distill yield; service-token gate (add-memory-metrics).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../http.js";
import { __resetMetrics, noteDigestRung, noteEmbedSample, noteDistill, metricsSnapshot } from "../metrics.js";
import { __resetEmbedGate } from "../embed-gate.js";

const tmpData = () => mkdtempSync(join(tmpdir(), "fdm-metrics-"));

test("metrics snapshot: quantiles, ratios and failure-reason buckets", () => {
  __resetMetrics();
  noteDigestRung("vector");
  noteDigestRung("vector");
  noteDigestRung("keyword");
  for (const ms of [100, 200, 300, 400, 1000]) noteEmbedSample({ ms, ok: true });
  noteEmbedSample({ ms: 3500, ok: false, reason: "embed deadline 3500ms exceeded" });
  noteEmbedSample({ ms: 0, ok: false, reason: "cooling_down" });
  noteDistill(true, 3, 12000);
  noteDistill(false, 0, 0, "sidecar HTTP 503");
  const m = metricsSnapshot() as any;
  assert.equal(m.digest.total, 3);
  assert.equal(m.digest.vector_ratio, 0.667);
  assert.equal(m.embed.ok, 5);
  assert.equal(m.embed.failed, 2);
  assert.equal(m.embed.ms_p50, 300);
  assert.equal(m.embed.ms_max, 1000);
  assert.equal(m.embed.failure_reasons["cooling_down"], 1);
  assert.equal(m.distill.runs, 1);
  assert.equal(m.distill.pages, 3);
  assert.equal(m.distill.failures, 1);
  assert.match(m.distill.last_error, /503/);
});

test("/admin/metrics: service tokens read it; person token refused", async () => {
  __resetMetrics();
  __resetEmbedGate();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    noteDigestRung("vector");
    const platform = svc.tokens.mint("platform", "u/ops").token;
    const person = svc.tokens.mint("person", "u/alice").token;
    const ok = await fetch(base + "/admin/metrics", { method: "POST", headers: { authorization: `Bearer ${platform}` } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.equal(body.digest.vector, 1);
    const no = await fetch(base + "/admin/metrics", { method: "POST", headers: { authorization: `Bearer ${person}` } });
    assert.equal(no.status, 403);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

// 2026-10-29 production finding: a blank digest query has no vector to compute,
// so the sidecar answers 400 texts_required and the caller reported it as
// "vector lane unavailable — keyword-only recall". Counting that as `keyword`
// made an idle call look like an embed outage in the exact ratio operators
// gate on. `empty` is its own rung and stays out of the denominator.
test("blank-query rung does not dilute vector_ratio", () => {
  __resetMetrics();
  noteDigestRung("vector");
  noteDigestRung("vector");
  noteDigestRung("keyword");
  noteDigestRung("empty");
  noteDigestRung("empty");
  const m = metricsSnapshot() as any;
  assert.equal(m.digest.empty, 2, "empty rung is counted separately");
  assert.equal(m.digest.total, 3, "empty must not enter the denominator");
  assert.equal(m.digest.vector_ratio, 0.667, "ratio reflects only real rung traffic");
});

test("distill metrics: per-run items/calls/tokens distribution, not just cumulative counters (7.1)", async () => {
  const { noteDistill, metricsSnapshot, __resetMetrics } = await import("../metrics.js");
  __resetMetrics();
  const empty = metricsSnapshot().distill as { recent: { samples: number; tokens: { p50: number | null } } };
  assert.equal(empty.recent.samples, 0, "no samples before any run");
  assert.equal(empty.recent.tokens.p50, null, "empty distribution reports null, not 0");

  noteDistill(true, 2, 1300, undefined, { items: 4, calls: 2 });
  noteDistill(true, 1, 900, undefined, { items: 2, calls: 1 });
  noteDistill(true, 3, 2600, undefined, { items: 6, calls: 3 });
  const d = metricsSnapshot().distill as {
    runs: number;
    recent: {
      samples: number;
      items: { total: number; mean: number; max: number };
      calls: { total: number; mean: number; max: number };
      tokens: { total: number; mean: number; p50: number | null; p90: number | null; max: number };
      last: { items: number; calls: number; tokens: number; pages: number };
    };
  };
  assert.equal(d.runs, 3);
  assert.equal(d.recent.samples, 3);
  assert.deepEqual(d.recent.items, { total: 12, mean: 4, max: 6 });
  assert.deepEqual(d.recent.calls, { total: 6, mean: 2, max: 3 });
  assert.equal(d.recent.tokens.total, 4800);
  assert.equal(d.recent.tokens.mean, 1600);
  assert.equal(d.recent.tokens.max, 2600);
  assert.ok(d.recent.tokens.p50 !== null && d.recent.tokens.p90 !== null, "quantiles are present");
  assert.deepEqual(d.recent.last, { items: 6, calls: 3, tokens: 2600, pages: 3 });

  // Failures must not enter the distribution: a failed run has no cost profile.
  noteDistill(false, 0, 0, "boom");
  const after = metricsSnapshot().distill as { failures: number; recent: { samples: number } };
  assert.equal(after.failures, 1);
  assert.equal(after.recent.samples, 3, "a failure is not a sample");
});

test("distill metrics: per-stage prompt/completion profile answers 'which stage costs' (7.1)", async () => {
  const { noteDistillStages, metricsSnapshot, __resetMetrics } = await import("../metrics.js");
  __resetMetrics();
  const before = metricsSnapshot().distill as { stages: Record<string, unknown> };
  assert.deepEqual(before.stages, {}, "no stages before any run");

  noteDistillStages([
    { stage: "distill_extract", ok: true, prompt_tokens: 900, completion_tokens: 400 },
    { stage: "distill_fact_reconcile", ok: true, prompt_tokens: 2100, completion_tokens: 300 },
    { stage: "distill_reconcile", ok: true, prompt_tokens: 1800, completion_tokens: 250 },
    { stage: "distill_subject_judge", ok: false, prompt_tokens: 5000, completion_tokens: 5000 },
    { stage: "fact_cap", ok: true, warning: "dropped 1" },
  ]);
  const stages = (metricsSnapshot().distill as { stages: Record<string, { calls: number; prompt: number; completion: number }> }).stages;
  assert.deepEqual(stages.distill_extract, { calls: 1, prompt: 900, completion: 400 });
  assert.deepEqual(stages.distill_fact_reconcile, { calls: 1, prompt: 2100, completion: 300 });
  assert.deepEqual(stages.distill_reconcile, { calls: 1, prompt: 1800, completion: 250 });
  assert.equal(stages.distill_subject_judge, undefined, "a failed call is not counted");
  assert.deepEqual(stages.fact_cap, { calls: 1, prompt: 0, completion: 0 }, "bookkeeping entries count as a call but carry no tokens");

  // A second run accumulates instead of replacing.
  noteDistillStages([{ stage: "distill_extract", ok: true, prompt_tokens: 100, completion_tokens: 50 }]);
  const again = (metricsSnapshot().distill as { stages: Record<string, { calls: number; prompt: number }> }).stages;
  assert.deepEqual(again.distill_extract, { calls: 2, prompt: 1000, completion: 450 });

  __resetMetrics();
  assert.deepEqual((metricsSnapshot().distill as { stages: Record<string, unknown> }).stages, {}, "reset clears the profile");
});
