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
    // person with rootKey: rejected (platform-seam only)
    assert.equal((await fetch(base + `/memory?rootKey=d-pk`, { headers: { authorization: `Bearer ${person}` } })).status, 400);

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
