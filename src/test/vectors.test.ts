// Embedding-model consistency (2026-10-28): the vector space is only valid
// while every stored vector and every query embedding come from ONE model.
// These tests pin the guard at three layers — the raw writer refuses unnamed
// models, the guarded writer refuses/reflags off-model writes, and the hybrid
// recall excludes other-model vectors while counting the exclusion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { __resetMetrics, noteVectorEvent, metricsSnapshot } from "../metrics.js";
import { hybridCandidates } from "../distill-scheduler.js";

function makeRoot(): StoreRoot {
  return new StoreRoot(mkdtempSync(join(tmpdir(), "fdm-vec-")), "u-tester");
}

test.after(() => {
  // tmpdirs are per-test; node cleans /tmp — nothing to do, kept for symmetry.
  rmSync(join(tmpdir(), "fdm-vec-"), { recursive: true, force: true });
});

test("setPageVector refuses an unnamed model (it could never match a query)", () => {
  const root = makeRoot();
  assert.throws(() => root.db.setPageVector("default/facts/a.md", "", new Float32Array(4)), /model is required/);
  assert.throws(() => root.db.setPageVector("default/facts/a.md", "   ", new Float32Array(4)), /model is required/);
  // A named write still lands.
  root.db.setPageVector("default/facts/a.md", "model-A", new Float32Array([1, 0, 0, 0]));
  assert.equal(root.db.allPageVectors("model-A").length, 1);
});

test("guarded write: off-model is refused by default and counted", () => {
  const root = makeRoot();
  root.db.setPageVector("default/facts/a.md", "model-A", new Float32Array([1, 0, 0, 0]));
  const out = root.db.setPageVectorGuarded("default/facts/b.md", "model-B", new Float32Array([0, 1, 0, 0]));
  assert.deepEqual(out, { written: false, reason: "model_mismatch", dominant: "model-A" });
  assert.equal(root.db.allPageVectors("model-B").length, 0, "the off-model vector was not stored");
  assert.equal(root.db.dominantVectorModel()?.model, "model-A");
  // Same-model writes pass untouched.
  const ok = root.db.setPageVectorGuarded("default/facts/c.md", "model-A", new Float32Array([0, 0, 1, 0]));
  assert.deepEqual(ok, { written: true });
});

test("guarded write: policy=allow stores but flags the drift", () => {
  const root = makeRoot();
  root.db.setPageVector("default/facts/a.md", "model-A", new Float32Array([1, 0, 0, 0]));
  const out = root.db.setPageVectorGuarded("default/facts/b.md", "model-B", new Float32Array([0, 1, 0, 0]), { policy: "allow" });
  assert.equal(out.written, true);
  assert.equal(out.reason, "model_mismatch_allowed");
  assert.equal(root.db.allPageVectors("model-B").length, 1);
});

test("hybrid recall excludes other-model vectors and counts the exclusion", async () => {
  __resetMetrics();
  const { newPage } = await import("../okf.js");
  const root = makeRoot();
  // Three REAL fact pages (the vector-only hit path re-reads the page to
  // rebuild a candidate); two embedded with model-A (the query's model), one
  // stranded on model-B (the "model was switched" scenario).
  for (const [slug, text] of [["keep1", "组合周报口径已定"], ["keep2", "每周五 17:00 出周报"], ["stranded", "车规级芯片认证要点"]] as const) {
    root.writePage("default", "facts", slug, newPage("fact", text, `${text}。`, {}));
  }
  root.db.setPageVector("default/facts/keep1.md", "model-A", new Float32Array([1, 0]));
  root.db.setPageVector("default/facts/keep2.md", "model-A", new Float32Array([0.9, 0.1]));
  root.db.setPageVector("default/facts/stranded.md", "model-B", new Float32Array([0, 1]));
  const before = (metricsSnapshot() as { vectors: { mismatch_excluded: number } }).vectors.mismatch_excluded;

  const embed = async () => ({ vectors: [[1, 0]], model: "model-A", tokens: 1 });
  const merged = await hybridCandidates({
    root, project: "default", queryFor: "x", k: 8, embed,
    log: { warn: () => {} },
  });

  const rels = merged.map((c) => (c as unknown as { __rel?: string }).__rel).filter(Boolean);
  void rels; // candidate ids are page slugs; the assertion below is the real gate
  const after = (metricsSnapshot() as { vectors: { mismatch_excluded: number } }).vectors.mismatch_excluded;
  assert.equal(after - before, 1, "exactly one other-model vector was counted as excluded");
  // The stranded model's page must not appear among the scored candidates.
  const scored = merged.filter((c) => (c as { score: number }).score >= 0);
  assert.ok(!scored.some((c) => c.id === "stranded"), "model-B vector must never be scored");
  assert.ok(scored.some((c) => c.id === "keep1"), "model-A vectors still recall");
});

test("noteVectorEvent flows into /admin/metrics snapshot", () => {
  __resetMetrics();
  noteVectorEvent("skipped_no_model", 2);
  noteVectorEvent("reembed_runs");
  const snap = metricsSnapshot() as { vectors: Record<string, number> };
  assert.equal(snap.vectors.skipped_no_model, 2);
  assert.equal(snap.vectors.reembed_runs, 1);
});

// 2026-10-29 production finding: /digest with a blank q used to call embed(""),
// the sidecar answered 400 texts_required, and the caller labelled the whole
// answer "vector lane unavailable — keyword-only recall". The lane was healthy;
// the query was empty. An empty query must not reach the embed lane at all.
test("hybrid recall with a blank query never calls the embed lane", async () => {
  const { newPage } = await import("../okf.js");
  const root = makeRoot();
  root.writePage("default", "facts", "keep1", newPage("fact", "组合周报口径已定", "组合周报口径已定。", {}));

  let embedCalls = 0;
  const embed = async () => {
    embedCalls += 1;
    throw new Error("embed HTTP 400 texts_required");
  };
  for (const blank of ["", "   ", "\n\t "]) {
    const merged = await hybridCandidates({
      root, project: "default", queryFor: blank, k: 8, embed,
      log: { warn: () => {} },
    });
    assert.ok(Array.isArray(merged), `blank query ${JSON.stringify(blank)} must return keyword candidates`);
  }
  assert.equal(embedCalls, 0, "a blank query has no vector to compute — the embed lane must not be called");
});
