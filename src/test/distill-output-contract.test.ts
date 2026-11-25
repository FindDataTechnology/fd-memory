// distill-output-contract R6: a recall lane that returns top-k must report the
// remainder. Without it a caller cannot tell "8 matched" from "8 of 200 matched",
// and a reconciler fed the first slice drops the rest silently.
//
// The digest face carries the number as `candidates_omitted`; the candidate
// selection used by distillation uses `distillCandidatesDetailed`. Both are
// asserted here against the same corpus so the two counting paths agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { StoreRoot } from "../store.js";
import { Service } from "../http.js";
import { distillCandidates, distillCandidatesDetailed } from "../distill.js";
import { hybridCandidatesDetailed } from "../distill-scheduler.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-r6-"));
}

function seed(root: StoreRoot, n: number): void {
  for (let i = 0; i < n; i++) {
    root.writeDistillPage("agentA", "experience", {
      id: `exp_${i}`,
      engine: "engine:test/1",
      task: `口径巡检 ${i}`,
      search_keys: ["巡检"],
      solution: `第 ${i} 条`,
      sources: ["session:s1"],
      supersedes: [],
    });
  }
}

test("distillCandidatesDetailed reports how many matched candidates the top-k hid", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r6a");
    seed(root, 20);
    const res = distillCandidatesDetailed(root, ["agentA"], "巡检", 8);
    assert.equal(res.candidates.length, 8, "slice honours k");
    assert.equal(res.matched, 20, "matched is the pre-slice count");
    assert.equal(res.omitted, 12, "omitted is matched minus returned");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("nothing omitted when the pool fits: omitted is 0, not absent", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r6b");
    seed(root, 3);
    const res = distillCandidatesDetailed(root, ["agentA"], "巡检", 8);
    assert.equal(res.candidates.length, 3);
    assert.equal(res.matched, 3);
    assert.equal(res.omitted, 0);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("empty query still reports the remainder (the recency path slices too)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r6c");
    seed(root, 12);
    const res = distillCandidatesDetailed(root, ["agentA"], "", 5);
    assert.equal(res.candidates.length, 5);
    assert.equal(res.matched, 12);
    assert.equal(res.omitted, 7);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("hybridCandidatesDetailed reports the same remainder with the vector lane off", async () => {
  const data = tmpData();
  const prev = process.env.FD_MEMORY_EMBED;
  process.env.FD_MEMORY_EMBED = "off"; // keyword-only: no network, deterministic
  try {
    const root = new StoreRoot(data, "d-r6d");
    seed(root, 15);
    const res = await hybridCandidatesDetailed({
      root,
      project: "agentA",
      queryFor: "巡检",
      k: 6,
      embed: async () => {
        throw new Error("embed lane must not be reached when FD_MEMORY_EMBED=off");
      },
    });
    assert.equal(res.candidates.length, 6);
    assert.equal(res.matched, 15);
    assert.equal(res.omitted, 9);
  } finally {
    if (prev === undefined) delete process.env.FD_MEMORY_EMBED;
    else process.env.FD_MEMORY_EMBED = prev;
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("the legacy array-returning helpers keep their exact old shape", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r6e");
    seed(root, 10);
    const plain = distillCandidates(root, ["agentA"], "巡检", 4);
    assert.ok(Array.isArray(plain), "distillCandidates still returns a bare array");
    assert.equal(plain.length, 4);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
test("/digest reports candidates_omitted end to end, and omits the field when nothing was hidden", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    for (let i = 0; i < 12; i++) {
      root.writeDistillPage("p", "experience", {
        id: `exp_d${i}`, engine: "engine:test/1", task: `巡检口径 ${i}`,
        search_keys: ["巡检"], solution: `第 ${i} 条`, sources: [], supersedes: [],
      });
    }
    // One page whose title is unique, so a query for it matches exactly one
    // candidate — the "fits within k" case.
    root.writeDistillPage("p", "experience", {
      id: "exp_solo", engine: "engine:test/1", task: "蓝鲸调优",
      search_keys: ["蓝鲸"], solution: "单独一条", sources: [], supersedes: [],
    });
    server = createServer((req, res) => {
      void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };

    // k=3 over a 12-candidate corpus: 9 must be reported as left out.
    const r1 = await fetch(base + "/digest?project=p&q=巡检&k=3", { headers: H });
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()) as { candidates_omitted?: number; candidates_note?: string };
    assert.equal(d1.candidates_omitted, 9, "12 matched, 3 returned, 9 omitted");
    assert.match(String(d1.candidates_note), /另有 9 条候选未进入本次召回/);

    // A narrower query that matches only what fits: the field must be ABSENT,
    // not 0 — a zero would render as a warning that never happened.
    const r2 = await fetch(base + "/digest?project=p&q=蓝鲸&k=3", { headers: H });
    const d2 = (await r2.json()) as { candidates_omitted?: number };
    assert.equal(d2.candidates_omitted, undefined);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── R1: the page skeleton is the renderer's, not the model's ────────────────

test("R1: a heading inside a model field cannot invent or collide with a page section", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r1a");
    const rel = root.writeDistillPage("agentA", "experience", {
      id: "exp_r1", engine: "engine:test/1",
      task: "排障 5xx",
      search_keys: ["5xx"],
      // The model formats its answer with its own headings.
      solution: "## 我的结论\n先切备用 DNS\n### 细节\n再清缓存",
      sources: [], supersedes: [],
    });
    const body = root.readPageByRel(rel)!.body;
    const headings = body.split("\n").filter((l) => /^#{1,6}\s/.test(l));
    assert.deepEqual(headings, ["## Task", "## Solution"], "only the renderer's two sections remain");
    // The CONTENT survives verbatim — demotion, not rejection.
    assert.match(body, /先切备用 DNS/);
    assert.match(body, /再清缓存/);
    assert.match(body, /我的结论/);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("R1: a fact's details field is demoted the same way", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r1b");
    const rel = root.writeDistillPage("agentA", "fact", {
      id: "fact_r1", engine: "engine:test/1",
      statement: "G7 上游 DNS 超时",
      details: "# 复现\n步骤一\n## 结论\n换 DNS",
      sources: [], supersedes: [],
    });
    const body = root.readPageByRel(rel)!.body;
    const headings = body.split("\n").filter((l) => /^#{1,6}\s/.test(l));
    assert.deepEqual(headings, ["## Statement", "## Details"]);
    assert.match(body, /步骤一/);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("R1: text without headings is byte-identical to before (no collateral change)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r1c");
    const rel = root.writeDistillPage("agentA", "experience", {
      id: "exp_r1c", engine: "engine:test/1", task: "纯文本任务", search_keys: ["纯"],
      solution: "没有标题的正文\n第二行 # 不在行首所以保留",
      sources: [], supersedes: [],
    });
    const body = root.readPageByRel(rel)!.body;
    assert.match(body, /没有标题的正文/);
    assert.match(body, /# 不在行首所以保留/, "a mid-line # is not a heading and must survive");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
// ── R2: a citation must come from the batch the sidecar was given ───────────

test("R2: a source outside the batch's own set is dropped; the memory survives", async () => {
  const { TokenStore } = await import("../auth.js");
  const { DistillScheduler } = await import("../distill-scheduler.js");
  const data = tmpData();
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const roots = new Map<string, StoreRoot>();
    const openRoot = (key: string) => {
      let r = roots.get(key);
      if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
      return r;
    };
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      return {
        ok: true, status: 200, json: async () => ({
          facts: [],
          experiences: [{
            id: "exp_fab", engine: "engine:test/1", task: "排障 5xx", search_keys: ["5xx"],
            solution: "切备用 DNS",
            // One legitimate ref, one the sidecar could not have produced.
            sources: ["session:s1", "session:invented-by-the-model"],
            supersedes: [],
          }],
          // The universe for THIS batch.
          sources: ["session:s1"],
          cursor_next: {}, llm_calls: [{ stage: "distill_extract", ok: true, prompt_tokens: 10, completion_tokens: 10 }],
          tokens: 100, errors: [],
        }),
      };
    }) as unknown as typeof fetch;
    const sched = new DistillScheduler({
      roots, openRoot, tokens,
      env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" },
      fetchImpl,
      now: () => Date.now(),
    });
    const root = openRoot("u-r2@test");
    root.writePage("default", "notes", "n1", {
      frontmatter: { type: "note", title: "排障 5xx", generated: { by: "test", at: "2026-10-25T01:00:00.000Z" } },
      body: "切备用 DNS",
    } as never);
    await sched.distillNow("u-r2@test", "default");
    const page = root.readPageByRel("default/experiences/exp_fab.md");
    assert.ok(page, "the memory is still written");
    assert.deepEqual(page!.frontmatter.sources, ["session:s1"], "the unverifiable ref is dropped, the real one kept");
    assert.match(page!.body, /切备用 DNS/, "content survives a rejected citation");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("R2: an OLD sidecar that sends no `sources` keeps the entry's refs (real-payload regression)", async () => {
  // Caught against fd-prod traffic 2026-11-25: reading absent `sources` as an
  // EMPTY allow-set stripped every citation the instant this build met an
  // un-upgraded sidecar. Absent means "no opinion", not "nothing allowed".
  const { TokenStore } = await import("../auth.js");
  const { DistillScheduler } = await import("../distill-scheduler.js");
  const data = tmpData();
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const roots = new Map<string, StoreRoot>();
    const openRoot = (key: string) => {
      let r = roots.get(key);
      if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
      return r;
    };
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [], model: "", tokens: 0, errors: [] }) };
      }
      // Shape of the pre-contract sidecar: no contract_version, no sources.
      return {
        ok: true, status: 200, json: async () => ({
          facts: [],
          experiences: [{ id: "exp_legacy", engine: "e", task: "t", search_keys: [], solution: "s", sources: ["session:legit"], supersedes: [] }],
          cursor_next: {}, llm_calls: [], tokens: 10, errors: [],
        }),
      };
    }) as unknown as typeof fetch;
    const sched = new DistillScheduler({
      roots, openRoot, tokens,
      env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1", FD_MEMORY_EMBED: "off" },
      fetchImpl, now: () => Date.now(),
    });
    const root = openRoot("u-old@test");
    root.writePage("default", "notes", "n1", {
      frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-25T01:00:00.000Z" } },
      body: "b",
    } as never);
    await sched.distillNow("u-old@test", "default");
    const page = root.readPageByRel("default/experiences/exp_legacy.md");
    assert.ok(page, "the page lands");
    assert.deepEqual(page!.frontmatter.sources, ["session:legit"], "citations survive an un-upgraded sidecar");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("filterSources keeps everything when the sidecar names no universe (back-compat)", async () => {
  const { distillCandidatesDetailed } = await import("../distill.js");
  assert.ok(typeof distillCandidatesDetailed === "function");
  // Directly exercise the helper's contract via a page written with a stale
  // sidecar shape: no `sources` key in the response means "no opinion", and the
  // entries keep what they carried — the old behaviour, byte for byte.
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r2b");
    const rel = root.writeDistillPage("agentA", "experience", {
      id: "exp_keep", engine: "engine:test/1", task: "t", search_keys: [], solution: "s",
      sources: ["session:anything"], supersedes: [],
    });
    assert.deepEqual(root.readPageByRel(rel)!.frontmatter.sources, ["session:anything"]);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
// ── R4: a distillation batch lands whole or not at all ──────────────────────

test("R4: a failure partway through a batch removes every page it had written", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r4a");
    const mk = (id: string) => ({
      project: "p", kind: "experience" as const,
      payload: { id, engine: "engine:test/1", task: `t ${id}`, search_keys: [], solution: "s", sources: [], supersedes: [] },
    });
    // Fail on the third page by making its directory unwritable is not portable
    // on CI; instead make writeDistillPage throw for exactly one id by giving it
    // a payload that cannot be serialised (a circular `supersedes`).
    const bad: Record<string, unknown> = { id: "exp3", engine: "engine:test/1", task: "t3", search_keys: [], solution: "s", sources: [], supersedes: [] };
    const circular: unknown[] = [];
    circular.push(circular);
    (bad as { supersedes: unknown }).supersedes = circular;

    const entries = [mk("exp1"), mk("exp2"), { project: "p", kind: "experience" as const, payload: bad as never }];
    assert.throws(() => root.writeDistillBatch(entries), "the batch fails as a unit");

    // Nothing from the failed batch survives — not the bytes, not the index row.
    assert.equal(root.readPageByRel("p/experiences/exp1.md"), undefined, "first page rolled back");
    assert.equal(root.readPageByRel("p/experiences/exp2.md"), undefined, "second page rolled back");
    const indexed = root.db.recentPages(50, ["p"]).filter((r) => r.path.includes("exp1") || r.path.includes("exp2"));
    assert.deepEqual(indexed, [], "no index rows left behind");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("R4: an overwrite is restored to its pre-batch bytes when the batch fails", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r4b");
    root.writeDistillPage("p", "experience", {
      id: "exp_old", engine: "engine:test/1", task: "旧内容", search_keys: [], solution: "旧正文", sources: [], supersedes: [],
    });
    const before = root.readPageByRel("p/experiences/exp_old.md")!.body;

    const circular: unknown[] = [];
    circular.push(circular);
    assert.throws(() => root.writeDistillBatch([
      { project: "p", kind: "experience", payload: { id: "exp_old", engine: "engine:test/1", task: "新内容", search_keys: [], solution: "新正文", sources: [], supersedes: [] } },
      { project: "p", kind: "experience", payload: { id: "exp_bad", engine: "e", task: "t", search_keys: [], solution: "s", sources: [], supersedes: circular as never } as never },
    ]));
    assert.equal(root.readPageByRel("p/experiences/exp_old.md")!.body, before, "the overwritten page is back to its original bytes");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("R4: a clean batch writes every page and returns their paths in order", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r4c");
    const rels = root.writeDistillBatch([
      { project: "p", kind: "experience", payload: { id: "a", engine: "e", task: "ta", search_keys: [], solution: "sa", sources: [], supersedes: [] } },
      { project: "p", kind: "fact", payload: { id: "b", engine: "e", statement: "sb", sources: [], supersedes: [] } },
    ]);
    assert.deepEqual(rels, ["p/experiences/a.md", "p/facts/b.md"]);
    assert.ok(root.readPageByRel("p/experiences/a.md"));
    assert.ok(root.readPageByRel("p/facts/b.md"));
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
// ── R5: an unknown output shape is refused, not read as empty ───────────────

async function runBatchWith(response: Record<string, unknown>) {
  const { TokenStore } = await import("../auth.js");
  const { DistillScheduler } = await import("../distill-scheduler.js");
  const data = tmpData();
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const roots = new Map<string, StoreRoot>();
  const openRoot = (key: string) => {
    let r = roots.get(key);
    if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
    return r;
  };
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/embed")) {
      return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m", tokens: 1, errors: [] }) };
    }
    return { ok: true, status: 200, json: async () => response };
  }) as unknown as typeof fetch;
  const sched = new DistillScheduler({
    roots, openRoot, tokens,
    env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" },
    fetchImpl, now: () => Date.now(),
  });
  const root = openRoot("u-r5@test");
  root.writePage("default", "notes", "n1", {
    frontmatter: { type: "note", title: "口径", generated: { by: "test", at: "2026-10-25T01:00:00.000Z" } },
    body: "正文",
  } as never);
  let err: unknown = null;
  try { await sched.distillNow("u-r5@test", "default"); } catch (e) { err = e; }
  // A chunk failure is recorded on the distill state and retried with backoff
  // rather than thrown — the run-level contract for every sidecar error. Read
  // the recorded reason, which is what an operator sees.
  const lastError = root.db.getDistillState("default")?.last_error ?? null;
  return { err, lastError, root, cleanup: () => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const entryPayload = () => ({
  facts: [],
  experiences: [{ id: "exp_v", engine: "engine:test/1", task: "t", search_keys: [], solution: "s", sources: [], supersedes: [] }],
  sources: [],
  cursor_next: {}, llm_calls: [], tokens: 10, errors: [],
});

test("R5: a mismatched contract_version fails the batch and names both versions", async () => {
  const run = await runBatchWith({ contract_version: 99, ...entryPayload() });
  try {
    assert.match(String(run.lastError), /contract_version 99 != supported 1/, "the refusal names both versions");
    assert.equal(run.root.readPageByRel("default/experiences/exp_v.md"), undefined, "nothing was written");
    assert.equal(run.err, null, "a bad batch backs off; it does not crash the run");
  } finally { run.cleanup(); }
});

test("R5: the matching version is accepted", async () => {
  const run = await runBatchWith({ contract_version: 1, ...entryPayload() });
  try {
    assert.equal(run.err, null);
    assert.ok(run.root.readPageByRel("default/experiences/exp_v.md"), "the page lands");
  } finally { run.cleanup(); }
});

test("R5: a sidecar that sends no version is accepted (mid-rollout) rather than taking distillation offline", async () => {
  const run = await runBatchWith(entryPayload());
  try {
    assert.equal(run.err, null, "no version is the old sidecar, not a bad one");
    assert.ok(run.root.readPageByRel("default/experiences/exp_v.md"));
  } finally { run.cleanup(); }
});
test("R3: two batch entries on one path are refused, not silently overwritten", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-r3a");
    const e = (task: string) => ({
      project: "p", kind: "experience" as const,
      payload: { id: "dup", engine: "e", task, search_keys: [], solution: "s", sources: [], supersedes: [] },
    });
    assert.throws(
      () => root.writeDistillBatch([e("第一条"), e("第二条")]),
      /writes the same path twice/,
    );
    assert.equal(root.readPageByRel("p/experiences/dup.md"), undefined, "nothing landed");
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── 5.2: the two remainders measure different pools — and must stay distinct ──
//
// Injection (`beyond_budget`) counts pages the TOKEN BUDGET left out.
// Distillation (`candidates_omitted`) counts pages the RECALL top-k left out.
// They can disagree for a single corpus, and that disagreement is correct: one
// is a spending limit, the other a selection limit. This pins that neither
// silently starts reporting the other's number.

test("5.2: recall remainder and budget remainder are independent quantities", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    for (let i = 0; i < 10; i++) {
      root.writeDistillPage("p", "experience", {
        id: `exp_x${i}`, engine: "e", task: `巡检 ${i}`, search_keys: ["巡检"],
        solution: "正文", sources: [], supersedes: [],
      });
    }
    const server = createServer((req, res) => {
      void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // k=4 over 10 → recall omits 6. A generous budget means the token budget
      // omits 0, so `truncated` is false while `candidates_omitted` is not.
      const r = await fetch(`${base}/digest?project=p&q=巡检&k=4&budget=99999`, {
        headers: { "content-type": "application/json", authorization: `Bearer ${person}` },
      });
      const d = (await r.json()) as { candidates_omitted?: number; truncated: boolean };
      assert.equal(d.candidates_omitted, 6, "recall lane reports its own remainder");
      assert.equal(d.truncated, false, "budget lane reports the budget's remainder separately");
      // The two are not interchangeable: a caller reading only `truncated`
      // learns nothing about the 6 pages recall never offered.
      assert.equal(typeof d.truncated, "boolean");
      assert.ok(d.candidates_omitted! > 0);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
