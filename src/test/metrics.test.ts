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
