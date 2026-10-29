// Vector-scale observation (harden-memory-surfaces §2): the full-scan recall
// lane's safety zone was a comment; these tests pin the numbers that replace
// it. Thresholds come from env so a deployment can tighten/loosen without a
// rebuild — and the docs quote the same defaults (task 3.2).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { Service } from "../http.js";
import { newPage } from "../okf.js";
import { sampleVectorsScale, metricsSnapshot, __resetMetrics } from "../metrics.js";

const dirs: string[] = [];
function tmpData(prefix = "fdm-vscale-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT;
  delete process.env.FD_MEMORY_VECTOR_WARN_TOTAL;
});

function scale() {
  return (metricsSnapshot() as { "vectors.scale": { roots: number; total: number; max_root: number; over_threshold: boolean; threshold: { max_per_root: number; total: number } } })["vectors.scale"];
}

test("empty store: zero everywhere, not over threshold", () => {
  sampleVectorsScale([]);
  const s = scale();
  assert.equal(s.roots, 0);
  assert.equal(s.total, 0);
  assert.equal(s.max_root, 0);
  assert.equal(s.over_threshold, false);
});

test("single root and multi root totals; roots counts only non-empty roots", () => {
  sampleVectorsScale([120]);
  assert.equal(scale().roots, 1);
  assert.equal(scale().total, 120);
  assert.equal(scale().max_root, 120);

  sampleVectorsScale([120, 80, 0]);
  const s = scale();
  assert.equal(s.roots, 2, "a root with zero vectors is not a vector root");
  assert.equal(s.total, 200);
  assert.equal(s.max_root, 120);
  assert.equal(s.over_threshold, false);
});

test("over threshold flags on EITHER max_root or total, with defaults quoted in docs", () => {
  const t = scale().threshold;
  assert.equal(t.max_per_root, 2000, "doc §8.2 quotes this default");
  assert.equal(t.total, 10000, "doc §8.2 quotes this default");

  sampleVectorsScale([t.max_per_root + 1]);
  assert.equal(scale().over_threshold, true, "one root past the per-root line lights up");

  sampleVectorsScale(Array.from({ length: 11 }, () => Math.floor(t.total / 10) + 1));
  assert.equal(scale().over_threshold, true, "total past the global line lights up");
  assert.ok(scale().max_root <= t.max_per_root, "flagged by total, not by any single root");
});

test("thresholds are env-configurable and reflected in the sample", () => {
  process.env.FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT = "50";
  process.env.FD_MEMORY_VECTOR_WARN_TOTAL = "60";
  sampleVectorsScale([40, 30]);
  const s = scale();
  assert.equal(s.threshold.max_per_root, 50);
  assert.equal(s.threshold.total, 60);
  assert.equal(s.over_threshold, true, "total 70 > 60 even though no root exceeds 50");
});

test("garbage env values fall back to defaults instead of 0/NaN", () => {
  process.env.FD_MEMORY_VECTOR_WARN_MAX_PER_ROOT = "abc";
  process.env.FD_MEMORY_VECTOR_WARN_TOTAL = "-5";
  sampleVectorsScale([1]);
  const t = scale().threshold;
  assert.equal(t.max_per_root, 2000);
  assert.equal(t.total, 10000);
});

test("service samples real per-root counts; a COUNT(*) never decodes vectors", () => {
  __resetMetrics();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const a = svc.rootForKey("u-alpha");
  a.writePage("default", "facts", "f1", newPage("fact", "口径甲", "内容甲"));
  a.db.setPageVector("default/facts/f1.md", "m-test", new Float32Array([0.1, 0.2, 0.3]));
  const b = svc.rootForKey("u-beta");
  b.writePage("default", "facts", "f2", newPage("fact", "口径乙", "内容乙"));
  b.db.setPageVector("default/facts/f2.md", "m-test", new Float32Array([0.4, 0.5, 0.6]));
  b.db.setPageVector("default/facts/f3.md", "m-test", new Float32Array([0.7, 0.8, 0.9]));

  const counts = svc.vectorCountsByRoot();
  assert.deepEqual(counts.filter((n) => n > 0).sort((x, y) => x - y), [1, 2]);

  sampleVectorsScale(counts);
  const s = scale();
  assert.equal(s.total, 3);
  assert.equal(s.max_root, 2);
  assert.equal(s.roots, 2);
});
