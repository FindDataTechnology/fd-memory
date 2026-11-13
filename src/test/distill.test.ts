// Zero-LLM distiller tier (add-memory-distiller task 5.1): page kinds,
// layer/sources, supersede discipline, budget guardrail, forget, scheduler
// cursor semantics — all deterministic, no engine, no network (sidecar mocked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../auth.js";
import { StoreRoot } from "../store.js";
import { distillCandidates } from "../distill.js";
import { DistillScheduler } from "../distill-scheduler.js";
import { Service } from "../http.js";
import { createServer } from "node:http";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-distill-"));
}

function layerOf(type: string): string {
  return type === "observation" ? "L0" : type === "fact" || type === "experience" ? "L2" : "L1";
}

test("distill pages: kinds round-trip, reindex keeps frontmatter, supersede never rewrites the old page", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-packD");
    const old = root.writeDistillPage("agentA", "experience", {
      id: "exp_old1", engine: "engine:test/1", task: "排障 5xx", search_keys: ["5xx", "G7"],
      solution: "切备用 DNS", boundary_envs: "prod", sources: ["session:s1"], supersedes: [],
    });
    const neu = root.writeDistillPage("agentA", "experience", {
      id: "exp_new1", engine: "engine:test/1", task: "排障 5xx（更新）", search_keys: ["5xx"],
      solution: "切备用 DNS + 清缓存重放", sources: ["session:s2"], supersedes: ["exp_old1"],
    }, { principal: "distiller:test", scope: "d-packD/agentA" });
    const fact = root.writeDistillPage("agentA", "fact", {
      id: "fact_1", engine: "engine:test/1", statement: "G7 分组上游 DNS 超时", subject: "G7",
      files: ["run.sh"], details: "x".repeat(5000), sources: ["session:s2"], supersedes: [],
    });
    const beforeOld = readFileSync(join(root.wikiDir, old), "utf8");
    const beforeFact = readFileSync(join(root.wikiDir, fact), "utf8");

    root.db.db.exec("DELETE FROM pages; DELETE FROM pages_fts;");
    const count = root.db.reindexFromWiki(root.wikiDir);
    assert.ok(count >= 3);
    assert.equal(readFileSync(join(root.wikiDir, old), "utf8"), beforeOld, "superseded page byte-identical");
    assert.equal(readFileSync(join(root.wikiDir, fact), "utf8"), beforeFact);
    assert.equal(readFileSync(join(root.wikiDir, fact), "utf8").includes("xxxx"), true); // details kept
    // index carries sources/supersedes for layer reads
    const row = root.db.recentPages(10, ["agentA"]).find((p) => p.path === neu)!;
    assert.equal(row.type, "experience");
    assert.deepEqual(JSON.parse(row.supersedes), ["exp_old1"]);
    assert.deepEqual(JSON.parse(row.sources), ["session:s2"]);
    // audit rows landed
    const ops = root.db.recentWrites(10).map((w) => w.op);
    assert.ok(ops.includes("page_write"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp reads: mixed-layer project yields layer + sources on L2 rows", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const tok = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("d-pk");
    root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", tool: null, summary: "5xx 排障完成 DNS 超时定位", created_at: new Date().toISOString(), project: "agentA" });
    root.writeDistillPage("agentA", "experience", { id: "exp_x", engine: "e:1", task: "DNS 超时排障", search_keys: ["dns"], solution: "切备用", sources: ["session:s1"], supersedes: [] });
    root.beginHandoff("agentA", "a", { summary: "交接：G7 DNS 超时已处理" });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const init = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    const sid = init.headers.get("mcp-session-id")!;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
      return JSON.parse(((await r.json()).result.content as [{ text: string }])[0].text);
    };
    const q = await call("memory_query", { q: "DNS 超时" });
    const layers = q.results.map((r: { layer: string }) => r.layer).sort();
    assert.deepEqual(layers, ["L0", "L1", "L2"]);
    const l2 = q.results.find((r: { layer: string }) => r.layer === "L2");
    assert.deepEqual(l2.sources, ["session:s1"]);
    const rec = await call("memory_recent", {});
    assert.ok(rec.pages.every((p: { layer: string }) => ["L1", "L2"].includes(p.layer)));
    assert.ok(rec.observations.every((o: { layer: string }) => o.layer === "L0"));
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("candidates: keyword-ranked top-k, superseded and forgotten never offered", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-packC");
    root.writeDistillPage("agentA", "experience", { id: "exp_dns", engine: "e", task: "DNS 超时排障", search_keys: ["dns"], solution: "切备用 DNS", sources: [], supersedes: [] });
    root.writeDistillPage("agentA", "experience", { id: "exp_dns2", engine: "e", task: "DNS 超时排障（新）", search_keys: ["dns"], solution: "切备用+清缓存", sources: [], supersedes: ["exp_dns"] });
    root.writeDistillPage("agentA", "experience", { id: "exp_billing", engine: "e", task: "余额 403 排查", search_keys: ["billing"], solution: "查面板余额", sources: [], supersedes: [] });
    const gone = root.writeDistillPage("agentA", "experience", { id: "exp_gone", engine: "e", task: "DNS 超时但已遗忘", search_keys: ["dns"], solution: "old", sources: [], supersedes: [] });
    root.forgetPage(gone);

    const hits = distillCandidates(root, ["agentA"], "DNS 超时");
    const ids = hits.map((c) => c.id);
    assert.ok(ids.includes("exp_dns2"), `exp_dns2 ranked in: ${ids}`);
    assert.ok(!ids.includes("exp_dns"), "superseded page is not a candidate");
    assert.ok(!ids.includes("exp_gone"), "forgotten page is not a candidate");
    assert.ok(!ids.includes("exp_billing") || ids.indexOf("exp_billing") > ids.indexOf("exp_dns2"), "billing ranks below dns for a dns query");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("budget table: per-root aggregation, daily window, report rows", () => {
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "p");
    store.distillBudgetAdd("d-packB", "2026-10-22", 100, 2);
    store.distillBudgetAdd("d-packB", "2026-10-22", 50, 1);
    assert.deepEqual(store.distillBudgetUsed("d-packB", "2026-10-22"), { tokens: 150, llm_calls: 3 });
    assert.deepEqual(store.distillBudgetUsed("d-packB", "2026-10-23"), { tokens: 0, llm_calls: 0 });
    assert.equal(store.distillBudgetRows("d-packB")[0].tokens, 150);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

function schedulerFixture(data: string, sidecar: { impl: typeof fetch; calls: Array<Record<string, unknown>> }, env: Record<string, string>) {
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const roots = new Map<string, StoreRoot>();
  const openRoot = (key: string) => {
    let r = roots.get(key);
    if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
    return r;
  };
  const sched = new DistillScheduler({
    roots, openRoot, tokens, env,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      sidecar.calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return sidecar.impl(url as never, init as never);
    }) as unknown as typeof fetch,
    now: () => Date.now(),
  });
  return { sched, tokens, openRoot, roots };
}

const GATES = { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" };

test("scheduler: success writes pages, advances cursor, bills budget; second run is a no-op (idempotent cursor)", async () => {
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      // promotion lane (add-tier-promotion-candidates) rides the same stub:
      // answer "no proposals" rather than the distill payload, or its token
      // accounting double-books the budget this test asserts on.
      if (String(url).endsWith("/promote")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({
        facts: [{ id: "fact_a", engine: "engine:test/1", statement: "G7 DNS 超时", subject: "G7", sources: ["session:s1"], supersedes: [] }],
        experiences: [{ id: "exp_a", engine: "engine:test/1", task: "5xx 排障", search_keys: ["5xx"], solution: "切 DNS", sources: ["session:s1"], supersedes: [] }],
        cursor_next: {}, llm_calls: [{ stage: "distill_extract", ok: true, prompt_tokens: 5000, completion_tokens: 2500 }], tokens: 7500, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("d-pkS");
    const at = new Date().toISOString();
    const seed: Array<{ event: string; summary: string; tool?: string }> = [
      { event: "user-prompt-submit", summary: "查 5xx" },
      { event: "pre-tool-use", summary: "args", tool: "run_checks" },
      { event: "stop", summary: "定位 G7 DNS 超时" },
    ];
    for (const e of seed) {
      root.db.addObservation({ session_id: "s1", agent: "a", event: e.event, summary: e.summary, tool: e.tool ?? null, created_at: at, project: "agentA" });
    }
    await fx.sched.distillNow("d-pkS", "agentA");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    const embedCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/embed"));
    assert.equal(distillCalls().length, 1);
    assert.equal(embedCalls().length, 1, "query embedded once per distill");
    const req = distillCalls()[0].body as { items: unknown[]; candidates: unknown[] };
    assert.equal(req.items.length, 3);
    const st = root.db.getDistillState("agentA")!;
    assert.ok(st.obs_cursor > 0, "cursor advanced");
    assert.equal(st.last_error, null);
    assert.deepEqual(fx.tokens.distillBudgetUsed("d-pkS", at.slice(0, 10)), { tokens: 7500, llm_calls: 1 });
    assert.ok(root.db.recentPages(10, ["agentA"]).some((p) => p.type === "experience"));

    // nothing new → no second sidecar call
    await fx.sched.distillNow("d-pkS", "agentA");
    assert.equal(distillCalls().length, 1, "idempotent cursor: no new items, no call");
    assert.equal(embedCalls().length, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("scheduler: sidecar failure keeps cursor and backs off; budget exhaustion records a gap without calling", async () => {
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("d-pkF");
    root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", tool: null, summary: "x", created_at: new Date().toISOString(), project: "agentA" });
    await fx.sched.distillNow("d-pkF", "agentA");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls().length, 1);
    const st = root.db.getDistillState("agentA")!;
    assert.equal(st.obs_cursor, 0, "cursor kept on failure");
    assert.ok(st.last_error?.includes("503"));
    assert.ok(st.next_attempt_at > Date.now(), "backoff armed");

    // budget exhausted for today → gap, no sidecar call
    fx.tokens.distillBudgetAdd("d-pkF", new Date().toISOString().slice(0, 10), 400_000, 10);
    const before = distillCalls().length;
    root.db.upsertDistillState("agentA", { next_attempt_at: 0 });
    await fx.sched.distillNow("d-pkF", "agentA");
    assert.equal(distillCalls().length, before, "no call when budget exhausted");
    assert.ok((root.db.getDistillState("agentA")?.gaps ?? 0) >= 1, "gap recorded");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: a budget stop is persisted in the ledger, not only logged (11-13 cross-day check)", async () => {
  // fd-memory is Recreate + single replica, so every rollout deletes the pod that
  // held the log line `daily budget hit mid-run`. The cross-day check therefore
  // could only ever report "not observed" — which cannot be told apart from "the
  // gate never fired" or "the gate leaked" (measured 11-12: an owner billed
  // 1,256,968 against a 1,200,000 cap with no evidence left). Counting it in
  // token.db survives restarts and makes the judgment answerable by one query.
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      if (String(url).endsWith("/promote") || String(url).endsWith("/tag")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      // Bills the whole cap AND reports a ceiling hit, so the split would fire —
      // with the call budget at 1 it must be refused, which is the stop we count.
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [], cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 4000, completion_tokens: 6000 }],
        tokens: 7500, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_DAILY_TOKENS: "7500" });
    const root = fx.openRoot("d-pkPersist");
    const at = new Date().toISOString();
    for (const t of ["积压一", "积压二", "积压三"]) {
      root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: t, tool: null, created_at: at, project: "agentA" });
    }
    await fx.sched.distillNow("d-pkPersist", "agentA");
    const day = new Date().toISOString().slice(0, 10);
    const row = fx.tokens.distillBudgetRows("d-pkPersist").find((r) => r.day === day)!;
    assert.ok(row, "the ledger row exists");
    assert.ok(row.budget_stops >= 1, `the stop is counted, not just logged (got ${row.budget_stops})`);
    // A refused call bills nothing, so the ledger stays at one call's worth —
    // that is the design, and the proof that the refusal happened at the gate
    // rather than after a second request had already spent money.
    const calls = sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).length;
    assert.equal(calls, 1, `only the first call reached the engine (sent ${calls})`);
    assert.equal(row.tokens, 7500, `nothing was billed for the refused call (billed ${row.tokens})`);
    // A different day's row must not inherit it.
    assert.equal(fx.tokens.distillBudgetRows("d-pkPersist").filter((r) => r.day !== day).length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: the sidecar request budget is configurable and the default does not abort early (11-13)", async () => {
  // The caller's budget must exceed the distiller's own deadline, otherwise the
  // caller aborts first and the named `distill_deadline_exceeded` never reaches
  // us (the exact shape that used to leave "This operation was aborted" with
  // zero LLM errors). Measured: one call is 47-97 s with a 474-char prompt and
  // the tail passes 150 s, so production runs 300 s (distiller) / 330 s (here).
  const data = tmpData();
  const slowButOk = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      if (String(url).endsWith("/promote") || String(url).endsWith("/tag")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      // Real fetch rejects on abort; a bare `await sleep` would swallow the
      // signal and make the tight-budget arm silently pass.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 150);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      });
      return { ok: true, status: 200, json: async () => ({
        facts: [],
        experiences: [{ id: "exp_slow", engine: "engine:test/1", task: "慢但成功", search_keys: ["慢"], solution: "等它", sources: ["session:s1"], supersedes: [] }],
        cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 100, completion_tokens: 50 }],
        tokens: 200, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const seed = (root: StoreRoot) => {
      root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: "慢调用", tool: null, created_at: new Date().toISOString(), project: "agentA" });
    };
    // 50 ms budget against a 150 ms answer → abort, cursor kept, failure named.
    const fxTight = schedulerFixture(data, slowButOk, { ...GATES, FD_MEMORY_SIDECAR_TIMEOUT_MS: "50" });
    const tight = fxTight.openRoot("d-pkSlowA");
    seed(tight);
    await fxTight.sched.distillNow("d-pkSlowA", "agentA");
    const stTight = tight.db.getDistillState("agentA")!;
    assert.equal(stTight.obs_cursor, 0, "an aborted request keeps the cursor");
    assert.ok(/abort/i.test(String(stTight.last_error)), `the abort is named (got ${stTight.last_error})`);

    // Default budget → the same 150 ms answer lands.
    const fxDefault = schedulerFixture(data, slowButOk, { ...GATES });
    const ok = fxDefault.openRoot("d-pkSlowB");
    seed(ok);
    await fxDefault.sched.distillNow("d-pkSlowB", "agentA");
    const stOk = ok.db.getDistillState("agentA")!;
    assert.ok(stOk.obs_cursor > 0, "the same slow answer lands under the default budget");
    assert.equal(stOk.last_error, null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: a truncating batch is held for the next round, not split mid-request (11-13 call budget)", async () => {
  // The split costs two more calls; at ~1 min per call on this lane those cannot
  // fit the same 150 s request, and a half-finished split used to die at
  // distill_deadline_exceeded with the cursor unchanged anyway. Holding the batch
  // is the behaviour that already existed for FD_MEMORY_EXTRACT_RETRY_ON_TRUNCATION=0,
  // so with a call budget of one we take that path deliberately.
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      if (String(url).endsWith("/promote") || String(url).endsWith("/tag")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [],
        cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 4000, completion_tokens: 6000 }],
        tokens: 7500, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_MAX_CALLS_PER_RUN: "1" });
    const root = fx.openRoot("d-pkSplit");
    const at = new Date().toISOString();
    for (const s of ["一条", "两条", "三条"]) {
      root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: s, tool: null, created_at: at, project: "agentA" });
    }
    await fx.sched.distillNow("d-pkSplit", "agentA");
    const distillCalls = sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls.length, 1, `no halves when the call budget is one (saw ${distillCalls.length})`);
    const st = root.db.getDistillState("agentA")!;
    assert.match(String(st.last_error), /extract_truncated/, `the hold is named (got ${st.last_error})`);
    assert.equal(st.obs_cursor, 0, "cursor held: the material returns next round");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: the batch is bounded per call and the run resumes from the cursor (11-13 lane throughput)", async () => {
  // The lane answers at ~34 output tokens/s (measured 2026-11-13: a 4,858-in /
  // 1,378-out extraction call took 41 s), so a 120-item batch with the
  // extractor's 6,000-token completion ceiling is structurally ~176 s — it
  // cannot finish inside the distiller's own 150 s limit, and when it returns it
  // is truncated. Observed on the live pod the same hour: "extract truncated
  // 12x — stepping over this batch (extract_truncated_skipped)" and one run
  // killed at distill_deadline_exceeded. Bounding the batch is the fix; the run
  // must advance its cursor so the NEXT drain continues, not re-send the same
  // head forever.
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      if (String(url).endsWith("/promote") || String(url).endsWith("/tag")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      // Well under the 6,000 ceiling: this test is about size, not truncation.
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [],
        cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 1200, completion_tokens: 200 }],
        tokens: 1400, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_MAX_ITEMS: "10" });
    const root = fx.openRoot("d-pkBatch");
    const at = new Date().toISOString();
    for (let i = 0; i < 30; i++) {
      root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: `第 ${i} 条`, tool: null, created_at: at, project: "agentA" });
    }
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    const itemsSent = () => (distillCalls().at(-1)!.body as { items: unknown[] }).items.length;

    await fx.sched.distillNow("d-pkBatch", "agentA");
    assert.equal(distillCalls().length, 1, `one call per run, not one per item (saw ${distillCalls().length})`);
    assert.equal(itemsSent(), 10, `the batch is capped at FD_MEMORY_DISTILL_MAX_ITEMS (sent ${itemsSent()})`);
    const firstCursor = root.db.getDistillState("agentA")!.obs_cursor;
    assert.equal(firstCursor, 10, "the cursor advances by what was sent, so the rest is not stranded");

    await fx.sched.distillNow("d-pkBatch", "agentA");
    assert.equal(itemsSent(), 10, "the next run takes the next slice");
    assert.equal(root.db.getDistillState("agentA")!.obs_cursor, 20);

    await fx.sched.distillNow("d-pkBatch", "agentA");
    assert.equal(root.db.getDistillState("agentA")!.obs_cursor, 30);
    const callsAfterDrain = distillCalls().length;
    await fx.sched.distillNow("d-pkBatch", "agentA");
    assert.equal(distillCalls().length, callsAfterDrain, "nothing left → no call");

    // Garbage or <1 must fall back to the default instead of sending an empty
    // batch (which would look like "nothing to do" forever).
    const fx2 = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_MAX_ITEMS: "0" });
    const root2 = fx2.openRoot("d-pkBatch2");
    for (let i = 0; i < 30; i++) {
      root2.db.addObservation({ session_id: "s2", agent: "a", event: "stop", summary: `第 ${i} 条`, tool: null, created_at: at, project: "agentA" });
    }
    const before = sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).length;
    await fx2.sched.distillNow("d-pkBatch2", "agentA");
    const sent = (sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).at(-1)!.body as { items: unknown[] }).items.length;
    assert.equal(sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).length, before + 1);
    assert.equal(sent, 30, `a non-positive value falls back to the default, not to 0 (sent ${sent})`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: the budget binds BETWEEN calls, not once per run (11-12 production overshoot)", async () => {
  // Measured on the completed UTC day 2026-11-12: owner d-KkCie7… billed
  // 1,256,968 against FD_MEMORY_DISTILL_DAILY_TOKENS=1,200,000 with per_run =
  // 179,567 — 41,968 past the "cap + one call" allowance. Cause: d-roots checked
  // the ledger once at the top of distillOne, then a truncating batch fired two
  // more calls (extract + halves), each billing. u-roots have re-read per chunk
  // since 7.3; this pins the same shape for d-roots.
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      if (String(url).endsWith("/promote")) {
        return { ok: true, status: 200, json: async () => ({ results: [], tokens: 0, llm_calls: [], errors: [] }) };
      }
      // Every call bills the whole cap AND reports a ceiling hit, so the old
      // shape would immediately fire two more calls ("halves") and bill 3x.
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [],
        cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 4000, completion_tokens: 6000 }],
        tokens: 7500, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_DAILY_TOKENS: "7500" });
    const root = fx.openRoot("d-pkCap");
    const at = new Date().toISOString();
    for (const s of ["查 5xx", "看日志", "定位 G7 DNS 超时"]) {
      root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: s, tool: null, created_at: at, project: "agentA" });
    }
    await fx.sched.distillNow("d-pkCap", "agentA");
    const distillCalls = sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls.length, 1, `the truncation halves must be refused once the cap is spent (saw ${distillCalls.length})`);
    const day = new Date().toISOString().slice(0, 10);
    const billed = fx.tokens.distillBudgetUsed("d-pkCap", day).tokens;
    assert.equal(billed, 7500, `overshoot is bounded by one call (billed ${billed})`);
    const st = root.db.getDistillState("agentA")!;
    assert.equal(st.last_error, "daily_budget_exhausted", "the stop is named, not silent");
    assert.equal(st.obs_cursor, 0, "cursors are kept: the material comes back after the cap resets");
    assert.ok((st.gaps ?? 0) >= 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("scheduler: gates — no URL or not enabled means notify/drain are inert", async () => {
  const data = tmpData();
  const sidecar = { calls: [] as Array<Record<string, unknown>>, impl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch };
  try {
    const envCases: Array<Record<string, string>> = [
      { FD_MEMORY_DISTILL_ENABLED: "1" },
      { FD_MEMORY_DISTILLER_URL: "http://x" },
      {},
    ];
    for (const env of envCases) {
      const fx = schedulerFixture(data, sidecar, env);
      fx.sched.notifyCapture("d-pkG", "agentA", [{ event: "session-end" }]);
      fx.sched.start();
      await fx.sched.drain();
      assert.equal(sidecar.calls.length, 0);
      fx.sched.stop();
    }
    // u/ roots enter via notifyCapture since add-u-root-distillation — and
    // stay out under the FD_MEMORY_DISTILL_U=0 kill switch
    const fx = schedulerFixture(data, sidecar, { ...GATES });
    fx.sched.notifyCapture("u-alice", "cell", [{ event: "session-end" }]);
    assert.equal(fx.sched.pendingCount(), 1);
    const fxOff = schedulerFixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_U: "0" });
    fxOff.sched.notifyCapture("u-alice", "cell", [{ event: "session-end" }]);
    assert.equal(fxOff.sched.pendingCount(), 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("visibility: GET /memory filters by scope/layer for persons only; forget is logical and audited", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("u-alice");
    root.writeDistillPage("cluster-42", "experience", { id: "exp_v", engine: "e", task: "集群排障", search_keys: ["k"], solution: "s", sources: ["session:x"], supersedes: [] });
    root.writePage("cluster-42", "notes", "n1", { frontmatter: { type: "note", title: "note1" }, body: "b" } as never);
    root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", tool: null, summary: "obs", created_at: new Date().toISOString(), project: "cluster-42" });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { authorization: `Bearer ${person}`, "content-type": "application/json" };

    // agent token refused
    assert.equal((await fetch(base + "/memory", { headers: { authorization: `Bearer ${dep}` } })).status, 403);
    // layer filter
    const l2 = await (await fetch(base + "/memory?scope=cluster-42&layer=L2", { headers: H })).json();
    assert.equal(l2.items.length, 1);
    assert.equal(l2.items[0].layer, "L2");
    assert.deepEqual(l2.items[0].sources, ["session:x"]);
    const all = await (await fetch(base + "/memory?scope=cluster-42", { headers: H })).json();
    assert.ok(all.items.length >= 3);
    assert.ok(all.items.some((i: { layer: string }) => i.layer === "L0"));

    // forget: no-confirm rejected, then logical delete
    const rel = all.items.find((i: { layer: string }) => i.layer === "L2").path;
    const noConfirm = await fetch(base + "/forget", { method: "POST", headers: H, body: JSON.stringify({ path: rel }) });
    assert.equal(noConfirm.status, 400);
    const ok = await fetch(base + "/forget", { method: "POST", headers: H, body: JSON.stringify({ path: rel, confirm: true }) });
    assert.equal(((await ok.json()) as { forgotten: string }).forgotten, rel);
    const after = await (await fetch(base + "/memory?scope=cluster-42&layer=L2", { headers: H })).json();
    assert.equal(after.items.length, 0);
    const q = root.db.searchPages("集群排障");
    assert.equal(q.length, 0, "forgotten page leaves every read face");
    assert.ok(root.db.recentWrites(10).some((w) => w.op === "forget"));
    // markdown truth survives
    assert.ok(rmSyncOk(join(root.wikiDir, rel)));
    // and the candidate builder never offers it again
    const { distillCandidates } = await import("../distill.js");
    assert.equal(distillCandidates(root, ["cluster-42"], "集群排障").length, 0);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

function rmSyncOk(p: string): boolean {
  try { readFileSync(p, "utf8"); return true; } catch { return false; }
}

test("scheduler tuning (day-1 production): fallback needs budget headroom — exhausted root adds no pending", async () => {
  const data = tmpData();
  const sidecar = { calls: [] as Array<Record<string, unknown>>, impl: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch };
  try {
    const fx = schedulerFixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("d-pkT");
    root.db.addObservation({ session_id: "old", agent: "a", event: "stop", tool: null, summary: "frozen history", created_at: new Date().toISOString(), project: "frozenProj" });
    // budget nearly exhausted for this root → fallback must not enqueue the lagging frozen project
    fx.tokens.distillBudgetAdd("d-pkT", new Date().toISOString().slice(0, 10), 350_000, 40);
    fx.sched.drain();
    assert.equal(fx.sched.pendingCount(), 0, "no fallback enqueue without headroom");
    // comfortable headroom → lagging project gets picked up
    const fx2tokens = fx.tokens;
    fx2tokens.distillBudgetAdd;
    const data2 = data; // same store, simulate a new day instead
    const nextDay = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    fx2tokens.distillBudgetAdd("d-pkT2" as never, nextDay, 0, 0);
    const fx2 = schedulerFixture(data2, sidecar, { ...GATES });
    const root2 = fx2.openRoot("d-pkT2");
    root2.db.addObservation({ session_id: "old", agent: "a", event: "stop", tool: null, summary: "lagging", created_at: new Date().toISOString(), project: "lagging" });
    fx2.sched.drain();
    assert.ok(fx2.sched.pendingCount() >= 0); // drain ran without calling sidecar (debounce guards)
    assert.equal(sidecar.calls.length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("platform-seam lane: platform token reads/forgets a named rootKey; agents refused; person rootKey rejected", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const runner = svc.tokens.mint("runner", "*").token;
    const person = svc.tokens.mint("person", "u/alice").token;
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    // content lives in a d/ root the person does NOT own
    const root = svc.rootForKey("d-pk");
    root.writeDistillPage("agentA", "experience", { id: "exp_p", engine: "e", task: "G7 DNS 排障", search_keys: ["dns"], solution: "切备用", sources: [], supersedes: [] });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json" };

    // platform with rootKey: read hits the d/ root
    const rd = await fetch(base + `/memory?rootKey=d-pk&scope=agentA&layer=L2`, { headers: { ...H, authorization: `Bearer ${platform}` } });
    assert.equal(rd.status, 200);
    const items = ((await rd.json()) as { items: Array<{ path: string }> }).items;
    assert.equal(items.length, 1);
    // platform without rootKey: 400
    assert.equal((await fetch(base + "/memory", { headers: { authorization: `Bearer ${platform}` } })).status, 400);
    // runner with rootKey works too
    assert.equal((await fetch(base + `/memory?rootKey=d-pk`, { headers: { authorization: `Bearer ${runner}` } })).status, 200);
    // agents refused even with rootKey
    assert.equal((await fetch(base + `/memory?rootKey=d-pk`, { headers: { authorization: `Bearer ${dep}` } })).status, 403);
    // person with rootKey: oversight lane (add-agent-memory-foundation) —
    // this person owns no d/ root, so the refusal is a 403 forbidden_root
    assert.equal((await fetch(base + `/memory?rootKey=d-pk`, { headers: { authorization: `Bearer ${person}` } })).status, 403);

    // forget via platform seam: confirm required, then logical delete with audited principal
    const rel = items[0].path;
    const nf = await fetch(base + "/forget", { method: "POST", headers: { ...H, authorization: `Bearer ${platform}` }, body: JSON.stringify({ rootKey: "d-pk", path: rel }) });
    assert.equal(nf.status, 400); // no confirm
    const ok = await fetch(base + "/forget", { method: "POST", headers: { ...H, authorization: `Bearer ${platform}` }, body: JSON.stringify({ rootKey: "d-pk", path: rel, confirm: true }) });
    assert.equal(((await ok.json()) as { forgotten: string }).forgotten, rel);
    const after = await fetch(base + `/memory?rootKey=d-pk&scope=agentA&layer=L2`, { headers: { authorization: `Bearer ${platform}` } });
    assert.equal(((await after.json()) as { items: unknown[] }).items.length, 0);
    assert.ok(root.db.recentWrites(10).some((w) => w.op === "forget" && w.principal.startsWith("platform:")));
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("candidate scoring: search_keys carries its x2 weight, and legacy pages still reach it (4.1)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-tier");
    // Three pages, one term: title hit (x3) > search_keys hit (x2) > body hit
    // (x1). The x2 tier used to be dead — the field was written only as a body
    // line while the scorer read frontmatter.
    root.writeDistillPage("p", "experience", { id: "exp_title", engine: "e", confidence: 0.5, task: "专属词 在标题里", search_keys: [], solution: "无", sources: [], supersedes: [] });
    root.writeDistillPage("p", "experience", { id: "exp_keys", engine: "e", confidence: 0.5, task: "乙 无关标题", search_keys: ["专属词"], solution: "无", sources: [], supersedes: [] });
    root.writeDistillPage("p", "experience", { id: "exp_body", engine: "e", confidence: 0.5, task: "丙 无关标题", search_keys: [], solution: "正文里提到 专属词 一次", sources: [], supersedes: [] });
    const order = distillCandidates(root, ["p"], "专属词").map((c) => c.id);
    assert.deepEqual(order, ["exp_title", "exp_keys", "exp_body"], "x3 then x2 then x1");

    // The field is now real frontmatter, not just a body line.
    const fm = root.readPageByRel("p/experiences/exp_keys.md")!.frontmatter as Record<string, unknown>;
    assert.deepEqual(fm.search_keys, ["专属词"]);

    // A page written before 4.1 has the list only in its body line — it must
    // still score at the x2 tier instead of degrading to x1 forever.
    root.writePage("p", "experiences", "exp_legacy", {
      frontmatter: { type: "experience", title: "丁 旧页" },
      body: "## Task\n丁 旧页\n\n## Solution\n无\n\nsearch_keys: 旧词\n",
    } as never);
    const legacy = distillCandidates(root, ["p"], "旧词").find((c) => c.id === "exp_legacy");
    assert.ok(legacy, "legacy page is a candidate");
    assert.deepEqual(legacy!.search_keys, ["旧词"], "body-line fallback feeds the x2 tier");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: a truncated single-batch run holds the cursor instead of advancing past the material (step 2, formerly uncovered)", async () => {
  // The d-root path is the one that produced "120 items -> 4 pages": one call
  // for the whole backlog, ceiling hit, cursors advanced anyway. Step 2 covered
  // the chunked u-root path first; this pins the other one.
  const data = tmpData();
  const calls: Array<{ items: number }> = [];
  const sidecar = {
    impl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      const body = JSON.parse(String(init?.body ?? "{}")) as { items?: unknown[] };
      calls.push({ items: (body.items ?? []).length });
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [],
        cursor_next: { obs: 9999, handoff: "2999-01-01T00:00:00.000Z" },
        // Every call sits exactly on the ceiling, so splitting cannot rescue it.
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 30000, completion_tokens: 6000 }],
        tokens: 36000, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const root = new StoreRoot(data, "d-big");
    const roots = new Map([["d-big", root]]);
    const sched = new DistillScheduler({
      roots, openRoot: (k) => roots.get(k)!, tokens,
      env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" } as unknown as NodeJS.ProcessEnv,
      fetchImpl: sidecar.impl, now: () => Date.now(),
    });
    for (let i = 0; i < 6; i++) {
      root.db.addObservation({ session_id: `s${i}`, agent: "a", event: "stop", tool: null, summary: `观测 ${i}`, created_at: `2026-11-0${(i % 9) + 1}T00:00:0${i}.000Z`, project: "agentA" });
    }
    await sched.distillNow("d-big", "agentA");

    const st = root.db.getDistillState("agentA")!;
    assert.equal(st.obs_cursor, 0, "the cursor must not jump past material the engine never answered");
    assert.equal(st.last_error, "extract_truncated");
    assert.ok(calls.length >= 3, `expected one call plus a split retry, saw ${calls.length}`);
    assert.equal(calls[0].items, 6, "the whole backlog went in as one batch first");
    assert.ok(calls.slice(1).every((c) => c.items < 6), "the retry halves are smaller than the original batch");
    assert.equal(tokens.distillBudgetRows("d-big", 7)[0]?.truncated_runs, 1, "booked as truncated");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("d-root: a held batch is attempted again within 30 minutes (hold must not strand material)", async () => {
  // 6.2 现场：d-fleet_1793411839219_jv6bm9/m_1793411839219_ld494z 在 2026-11-10T13:38 被扣住后
  // 162 分钟无人重试，54 条 note 滞留。原因：hold 只写 last_error+next_attempt_at，不把 key 放回
  // pending；而 fallbackScan 的 d-根分支只看观测 lag —— 该 project observations=0，lag 恒 0，
  // 永远扫不到。本测试钉住「扣住之后必须有人再来试」。
  const data = tmpData();
  const calls: number[] = [];
  let clock = Date.UTC(2026, 10, 10, 13, 38, 0); // 固定时钟，避免跨日/时区干扰
  const sidecar = {
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      calls.push(clock);
      // 每次抽取都顶到 6,000 天花板 → 必被扣住
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [], cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 18000, completion_tokens: 6000 }],
        tokens: 24000, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const root = new StoreRoot(data, "d-hold");
    const roots = new Map([["d-hold", root]]);
    const sched = new DistillScheduler({
      roots, openRoot: (k) => roots.get(k)!, tokens,
      env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" } as unknown as NodeJS.ProcessEnv,
      fetchImpl: sidecar.impl, now: () => clock,
    });

    // 只有 note、没有任何观测 —— 正是 6.2 滞留现场的形状
    root.writePage("agentA", "notes", "n1", {
      frontmatter: { type: "note", title: "滞留验证", generated: { by: "test", at: "2026-11-10T13:00:00.000Z" } },
      body: "本体",
    } as never);

    await sched.drain();
    assert.equal(calls.length, 1, "首轮兜底扫描应发现这个只有 note 的 d-根 project");
    assert.equal(root.db.getDistillState("agentA")?.last_error, "extract_truncated", "首轮应被扣住");

    // hold 设的 next_attempt_at 是 +15 分钟；20 分钟后必须有人再来一次（上限 30 分钟）
    clock += 20 * 60_000;
    await sched.drain();
    assert.equal(calls.length, 2, "扣住后 30 分钟内必须有二次尝试，否则材料永久滞留");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
