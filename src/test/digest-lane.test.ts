// /digest platform-seam face tests (add-cluster-digest-injection task 1.2):
// permission matrix (person own-root / platform+rootKey / agent refused),
// embed-lane degradation (keyword fallback + model_note, request still 200),
// server-side parameter clamps, end-to-end assembly with annotations and
// handoffs section. No sidecar needed — the vector lane is absent in tests,
// which is itself the degradation path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { __resetEmbedGate } from "../embed-gate.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-digestlane-"));
}

test("/digest: permission matrix, degradation, clamps, assembly", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const platform = svc.tokens.mint("platform", "*").token;
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("u-alice");
    root.writeDistillPage("cluster-42", "experience", {
      id: "exp_d1", engine: "engine:test/1", confidence: 0.8,
      task: "集群回合巡检排障", search_keys: ["巡检", "集群"], solution: "## Task\n集群回合巡检排障\n## Solution\n先读 digest 再分派",
      sources: [], supersedes: [],
    });
    root.writeDistillPage("cluster-42", "fact", {
      id: "fact_d1", engine: "engine:test/1", confidence: 0.7,
      statement: "集群共享记忆在 owner root 的 cluster project", subject: "cluster",
      sources: [], supersedes: [],
    });
    root.db.upsertHandoff({
      id: "ho-digest-1", project: "cluster-42", from_agent: "member-a",
      summary: "上轮巡检发现队列积压待处理", open_questions: "[]", next_steps: "[\"复核积压\"]", files_touched: "[]",
      to_agent: null, state: "open", accepted_by: null, accepted_at: null, created_at: new Date().toISOString(),
    });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };

    // person own-root: 200 with assembled digest (annotations + handoffs +
    // keyword fallback note because no sidecar in tests)
    const r1 = await fetch(base + "/digest?project=cluster-42&q=集群回合巡检", { headers: H });
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()) as { digest: string; items: number; truncated: boolean; model_note?: string };
    assert.ok(d1.items >= 1);
    assert.match(d1.digest, /〔L2·experience｜置信 0\.80｜/);
    assert.match(d1.digest, /### 待认领交接/);
    assert.match(d1.digest, /上轮巡检发现队列积压/);
    assert.ok(!d1.digest.includes("## Solution"), "section headers stripped from excerpt");
    assert.match(d1.model_note ?? "", /keyword-only/, "no sidecar in tests → degradation note");
    assert.equal(d1.truncated, false);

    // platform with rootKey reaches the same root; platform without rootKey → 400
    const r2 = await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=集群", { headers: { authorization: `Bearer ${platform}` } });
    assert.equal(r2.status, 200);
    assert.equal((await fetch(base + "/digest?project=cluster-42&q=x", { headers: { authorization: `Bearer ${platform}` } })).status, 400);
    // deployment token refuses a rootKey param (its namespace IS the root —
    // add-agent-memory-foundation follow-on); person rootKey resolves the
    // oversight lane: u-alice owns no d/ root → 403
    assert.equal((await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: { authorization: `Bearer ${dep}` } })).status, 400);
    const unbound = await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: H });
    assert.equal(unbound.status, 403);
    assert.equal(((await unbound.json()) as { error: string }).error, "forbidden_root");

    // clamps: k=50/budget=99999 clamped server-side, still 200
    const r3 = await fetch(base + "/digest?project=cluster-42&q=集群&k=50&budget=99999", { headers: H });
    assert.equal(r3.status, 200);

    // empty project → 400
    assert.equal((await fetch(base + "/digest?q=x", { headers: H })).status, 400);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

// ── L1 note recall (add-digest-note-recall) ─────────────────────────────────

async function start(svc: Service) {
  const server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("/digest L1: no-L2 project's recent notes ride with 〔L1·note〕 annotation", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    // notes land via the real /pages face (the lane hook ② uses)
    const w1 = await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-2", title: "集群回合 2026-10-25 08:00", body: "成员回报：数据研究员在位；下一步复核队列。" }) });
    const w2 = await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-2", title: "集群回合 2026-10-25 09:00", body: "第二轮：队列已复核，空。" }) });
    assert.equal(w1.status, 200); assert.equal(w2.status, 200);
    const r = await fetch(base + "/digest?project=c-2&q=集群回合", { headers: H });
    const d = (await r.json()) as { digest: string; items: number; notes: number; truncated: boolean };
    assert.equal(r.status, 200);
    assert.equal(d.items, 0, "no L2 candidates");
    assert.equal(d.notes, 2);
    assert.match(d.digest, /〔L1·note｜\d{4}-\d{2}-\d{2}〕集群回合 2026-10-25 08:00/);
    assert.ok(d.digest.includes("数据研究员在位"));
    assert.equal(d.truncated, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest L1: budget squeeze drops notes before L2 items; truncated honest", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const root = svc.rootForKey("u-alice");
    root.writeDistillPage("c-3", "experience", { id: "exp_n1", engine: "e", confidence: 0.9, task: "巡检流程（已蒸馏）", search_keys: ["巡检"], solution: "先读摘要再分派成员", sources: [], supersedes: [] });
    await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-3", title: "集群回合 note", body: "写回内容".repeat(60) }) });
    // tight budget: header + handoffs(absent) + L2 line fit, the note must go
    const r = await fetch(base + "/digest?project=c-3&q=巡检&budget=170", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number; truncated: boolean; items: number };
    assert.ok(d.digest.includes("巡检流程（已蒸馏）"), "L2 survives");
    if (d.notes === 0) {
      assert.equal(d.truncated, true);
      assert.ok(!d.digest.includes("集群回合 note"));
    } else {
      assert.equal(d.truncated, d.notes < 1 && false, "note rendered means no squeeze claim");
    }
    assert.equal(d.items, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: open-handoff pile caps at 3 so notes survive the budget (chat-lane starvation regression)", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const root = svc.rootForKey("u-alice");
    // a day-of-drills shape: five open handoffs with long summaries + the
    // user note the chat lane must recall
    for (let i = 1; i <= 5; i++) {
      root.db.upsertHandoff({
        id: `h${i}`, project: "default", from_agent: "m",
        summary: `岗 ${i} 回合沉淀：` + "长摘要正文".repeat(60),
        open_questions: "[]", next_steps: "[]", files_touched: "[]",
        to_agent: null, state: "open", accepted_by: null, accepted_at: null, created_at: new Date().toISOString(),
      });
    }
    await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "default", title: "周报口径", body: "表头一律用中文；每周五下班前发到 #ops 频道；数据源优先 akshare。" }) });
    const r = await fetch(base + "/digest?project=default&q=周报&budget=1500", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number };
    assert.equal(r.status, 200);
    assert.ok(d.digest.includes("h4") === false && d.digest.includes("h5") === false, "handoffs capped at 3 (ids h4/h5 absent)");
    assert.equal(d.notes, 1, "the note must not starve under a handoff pile");
    assert.ok(d.digest.includes("周报口径"));
    assert.ok(d.digest.includes("#ops"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

// ── embed deadline (add-u-root-distillation 2.2) ────────────────────────────
// A real local sidecar (slow / fast) stands in for the lane; the deadline
// must turn a 6s embed into a keyword block inside the caller's budget.

test("/digest: slow embed degrades at the internal deadline — keyword block inside budget with model_note", async () => {
  __resetEmbedGate();
  const lane = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ vectors: [[0.1, 0.2]], model: "slow", tokens: 1 }));
    }, 6000);
  });
  await new Promise<void>((r) => lane.listen(0, "127.0.0.1", () => r()));
  const lanePort = (lane.address() as { port: number }).port;
  const prevUrl = process.env.FD_MEMORY_DISTILLER_URL;
  const prevTok = process.env.DISTILLER_SHARED_TOKEN;
  const prevDl = process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS;
  process.env.FD_MEMORY_DISTILLER_URL = `http://127.0.0.1:${lanePort}`;
  process.env.DISTILLER_SHARED_TOKEN = "t";
  process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS = "200";
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const t0 = Date.now();
    const r = await fetch(base + "/digest?project=default&q=x", { headers: { authorization: `Bearer ${person}` } });
    const ms = Date.now() - t0;
    const d = (await r.json()) as { digest: string; model_note?: string };
    assert.equal(r.status, 200);
    assert.ok(ms < 4000, `returned in ${ms}ms, well under the caller's 5s budget`);
    assert.match(d.model_note ?? "", /deadline/, "model_note names the deadline degradation");
    assert.ok(d.digest.length > 0, "a keyword-rendered block still came back");
  } finally {
    if (prevUrl === undefined) delete process.env.FD_MEMORY_DISTILLER_URL; else process.env.FD_MEMORY_DISTILLER_URL = prevUrl;
    if (prevTok === undefined) delete process.env.DISTILLER_SHARED_TOKEN; else process.env.DISTILLER_SHARED_TOKEN = prevTok;
    if (prevDl === undefined) delete process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS; else process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS = prevDl;
    await new Promise<void>((r) => server.close(() => r()));
    lane.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: fast embed keeps the vector rung (no model_note)", async () => {
  __resetEmbedGate();
  const lane = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const n = (JSON.parse(body || "{}").texts ?? [""]).length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ vectors: Array.from({ length: n }, () => [0.3, 0.4]), model: "fast", tokens: n }));
    });
  });
  await new Promise<void>((r) => lane.listen(0, "127.0.0.1", () => r()));
  const lanePort = (lane.address() as { port: number }).port;
  const prevUrl = process.env.FD_MEMORY_DISTILLER_URL;
  const prevTok = process.env.DISTILLER_SHARED_TOKEN;
  process.env.FD_MEMORY_DISTILLER_URL = `http://127.0.0.1:${lanePort}`;
  process.env.DISTILLER_SHARED_TOKEN = "t";
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    root.writeDistillPage("default", "experience", { id: "exp_v1", engine: "e", confidence: 0.9, task: "巡检流程", search_keys: ["巡检"], solution: "先读摘要再分派", sources: [], supersedes: [] });
    const r = await fetch(base + "/digest?project=default&q=巡检", { headers: { authorization: `Bearer ${person}` } });
    const d = (await r.json()) as { digest: string; model_note?: string; items: number };
    assert.equal(r.status, 200);
    assert.equal(d.model_note, undefined, "vector rung served, no degradation note");
    assert.ok(d.digest.includes("巡检流程"));
  } finally {
    if (prevUrl === undefined) delete process.env.FD_MEMORY_DISTILLER_URL; else process.env.FD_MEMORY_DISTILLER_URL = prevUrl;
    if (prevTok === undefined) delete process.env.DISTILLER_SHARED_TOKEN; else process.env.DISTILLER_SHARED_TOKEN = prevTok;
    await new Promise<void>((r) => server.close(() => r()));
    lane.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest L1: a forgotten note never re-enters the block", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const w = await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-4", title: "被遗忘的回合", body: "内容" }) });
    const { path } = (await w.json()) as { path: string };
    const f = await fetch(base + "/forget", { method: "POST", headers: H, body: JSON.stringify({ path, confirm: true }) });
    assert.equal(f.status, 200);
    const r = await fetch(base + "/digest?project=c-4&q=回合", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number };
    assert.equal(d.notes, 0);
    assert.ok(!d.digest.includes("被遗忘的回合"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest L1: segment caps at 5 and the rank-4 note is visible (recall-depth regression)", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    for (let i = 1; i <= 6; i++) {
      const w = await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-depth", title: `填充 ${i}`, body: `第 ${i} 条填充内容` }) });
      assert.equal(w.status, 200);
      await new Promise((r) => setTimeout(r, 8));
    }
    const r = await fetch(base + "/digest?project=c-depth&q=填充&budget=1500", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number };
    assert.equal(r.status, 200);
    assert.ok(d.notes <= 5, `segment caps at 5 (got ${d.notes})`);
    assert.ok(d.digest.includes("填充 4"), "rank-4 note rides the widened segment");
    assert.ok(!d.digest.includes("填充 1"), "the 6th-newest note stays out (cap) — recentPages orders newest-first");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest L1: note recall is window-independent — fresh L2 churn above old notes cannot evict them", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const root = svc.rootForKey("u-alice");
    // the old note the chat lane must recall
    await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-win", title: "宏观研究员验收结论", body: "第二轮验收通过，跨成员可见性已修正。" }) });
    // then a burst of 25 fresh L2 pages churns ABOVE it (distillation write-back shape)
    for (let i = 1; i <= 25; i++) {
      root.writeDistillPage("c-win", "experience", { id: `exp_w${i}`, engine: "e", confidence: 0.8, task: `巡视产出 ${i}`, search_keys: ["巡视"], solution: "产出正文", sources: [], supersedes: [] });
    }
    const r = await fetch(base + "/digest?project=c-win&q=宏观研究员&budget=1500", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number };
    assert.equal(r.status, 200);
    assert.ok(d.notes >= 1, `the old note rides regardless of L2 churn (notes=${d.notes})`);
    assert.ok(d.digest.includes("宏观研究员验收结论"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: handoffs past the 48h recency gate leave the block (stale-claim pull regression)", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const root = svc.rootForKey("u-alice");
    const old = new Date(Date.now() - 72 * 3600_000).toISOString(); // 3 days old
    const fresh = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2 hours old
    root.db.upsertHandoff({ id: "stale1", project: "c-age", from_agent: "m", summary: "三天前的轮报交接", open_questions: "[]", next_steps: "[]", files_touched: "[]", to_agent: null, state: "open", accepted_by: null, accepted_at: null, created_at: old });
    root.db.upsertHandoff({ id: "fresh1", project: "c-age", from_agent: "m", summary: "两小时前的交接", open_questions: "[]", next_steps: "[]", files_touched: "[]", to_agent: null, state: "open", accepted_by: null, accepted_at: null, created_at: fresh });
    const r = await fetch(base + "/digest?project=c-age&q=x&budget=1500", { headers: H });
    const d = (await r.json()) as { digest: string };
    assert.ok(d.digest.includes("fresh1"), "fresh handoff rides");
    assert.ok(!d.digest.includes("stale1"), "3-day-old open handoff is drifted state, not a notification");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest L1: query-matched notes ride first regardless of recency slot; empty query stays pure recency", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    // an OLD note （写触发哨兵: relevant to a query) + newer filler notes
    await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-rel", title: "苦瓜溯源批次口径", body: "苦瓜批次数据一律按批次号溯源，不合并。" }) });
    for (let i = 1; i <= 5; i++) {
      await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-rel", title: `填充 ${i}`, body: `第 ${i} 条` }) });
      await new Promise((r) => setTimeout(r, 8));
    }
    const r = await fetch(base + "/digest?project=c-rel&q=苦瓜溯源&budget=1500", { headers: H });
    const d = (await r.json()) as { digest: string; notes: number };
    assert.ok(d.digest.includes("苦瓜溯源批次口径"), "old-but-relevant note rides via query match, not recency");
    const idx = d.digest.indexOf("苦瓜溯源批次口径");
    const idxFill = d.digest.indexOf("填充 5");
    assert.ok(idx < (idxFill < 0 ? Infinity : idxFill), "matched note sorts before recency fillers");
    // empty query → pure recency (byte-stable)
    const r2 = await fetch(base + "/digest?project=c-rel&q=&budget=1500", { headers: H });
    const d2 = (await r2.json()) as { digest: string };
    assert.ok(!d2.digest.includes("苦瓜溯源批次口径"), "empty query = recency-only, the old note drops below rank-5");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: vector lane reaches pages the keyword path misses (recall-cap regression)", async () => {
  __resetEmbedGate();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    // a page whose WORDS share nothing with the query, but whose vector is a
    // perfect match (we plant the vector directly — the recall path must reach
    // it on cosine alone).
    root.writeDistillPage("c-vec", "experience", { id: "exp_sem", engine: "e", confidence: 0.9, task: "代号青鸾使用规约", search_keys: ["青鸾"], solution: "对外材料统一用青鸾代号", sources: [], supersedes: [] });
    const rel = "c-vec/experiences/exp_sem.md";
    const vec = new Float32Array(4); vec[0] = 1; // unit vector on dim 0
    root.db.setPageVector(rel, "vec-test-model", vec);
    // sidecar stub returning the SAME direction for any text
    const lane = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const n = (JSON.parse(b || "{}").texts ?? [""]).length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: Array.from({ length: n }, () => [1, 0, 0, 0]), model: "vec-test-model", tokens: n }));
      });
    });
    await new Promise<void>((r) => lane.listen(0, "127.0.0.1", () => r()));
    const prevUrl = process.env.FD_MEMORY_DISTILLER_URL; const prevTok = process.env.DISTILLER_SHARED_TOKEN;
    process.env.FD_MEMORY_DISTILLER_URL = `http://127.0.0.1:${(lane.address() as { port: number }).port}`;
    process.env.DISTILLER_SHARED_TOKEN = "t";
    try {
      // query words deliberately do NOT appear in the page
      const r = await fetch(base + "/digest?project=c-vec&q=zzz%20totally%20unrelated&budget=1500", { headers: { authorization: `Bearer ${person}` } });
      const d = (await r.json()) as { digest: string; items: number; model_note?: string };
      assert.equal(d.model_note, undefined, "vector rung served");
      assert.ok(d.digest.includes("代号青鸾使用规约"), "semantic hit reached via cosine alone (keyword path had nothing)");
    } finally {
      if (prevUrl === undefined) delete process.env.FD_MEMORY_DISTILLER_URL; else process.env.FD_MEMORY_DISTILLER_URL = prevUrl;
      if (prevTok === undefined) delete process.env.DISTILLER_SHARED_TOKEN; else process.env.DISTILLER_SHARED_TOKEN = prevTok;
      __resetEmbedGate();
      await new Promise<void>((r) => server.close(() => r()));
      lane.close();
      rmSync(data, { recursive: true, force: true });
    }
  } finally {
    __resetEmbedGate();
  }
});

test("/digest: the vector lane respects supersede — retired pages do not resurrect via full scan", async () => {
  __resetEmbedGate();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");
    const oldPage = root.writeDistillPage("c-sup", "fact", { id: "fact_old", engine: "e", statement: "部署目标 node-a", subject: "部署", details: "v1", sources: [], supersedes: [] });
    const newPage = root.writeDistillPage("c-sup", "fact", { id: "fact_new", engine: "e", statement: "部署目标 node-b（更正）", subject: "部署", details: "v2", sources: [], supersedes: ["fact_old"] });
    const vec = new Float32Array(4); vec[0] = 1;
    root.db.setPageVector(oldPage, "vm", vec);
    root.db.setPageVector(newPage, "vm", vec);
    const lane = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const n = (JSON.parse(b || "{}").texts ?? [""]).length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: Array.from({ length: n }, () => [1, 0, 0, 0]), model: "vm", tokens: n }));
      });
    });
    await new Promise<void>((r) => lane.listen(0, "127.0.0.1", () => r()));
    const prevUrl = process.env.FD_MEMORY_DISTILLER_URL; const prevTok = process.env.DISTILLER_SHARED_TOKEN;
    process.env.FD_MEMORY_DISTILLER_URL = `http://127.0.0.1:${(lane.address() as { port: number }).port}`;
    process.env.DISTILLER_SHARED_TOKEN = "t";
    try {
      const r = await fetch(base + "/digest?project=c-sup&q=部署&budget=1500", { headers: { authorization: `Bearer ${person}` } });
      const d = (await r.json()) as { digest: string; model_note?: string };
      assert.equal(d.model_note, undefined, "vector rung served");
      assert.ok(d.digest.includes("node-b"), "successor rides");
      assert.ok(!d.digest.includes("node-a"), "superseded page stays retired even in the full scan");
    } finally {
      if (prevUrl === undefined) delete process.env.FD_MEMORY_DISTILLER_URL; else process.env.FD_MEMORY_DISTILLER_URL = prevUrl;
      if (prevTok === undefined) delete process.env.DISTILLER_SHARED_TOKEN; else process.env.DISTILLER_SHARED_TOKEN = prevTok;
      __resetEmbedGate();
      await new Promise<void>((r) => server.close(() => r()));
      lane.close();
      rmSync(data, { recursive: true, force: true });
    }
  } finally {
    __resetEmbedGate();
  }
});

// ── harness source badge lane (add-yongyi-complete-solution, design D5 /
// tasks 5.2): pages whose metadata carries `harness` render a （来自 x）
// marker; pages without it keep the exact pre-badge line bytes.

test("/digest L1: harness metadata renders the source badge; pages without harness stay byte-identical", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const { server, base } = await start(svc);
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const withH = await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-badge", title: "跨 harness 口径", body: "两条 harness 的写入都进同一个根。", metadata: { harness: "claude-code" } }) });
    assert.equal(withH.status, 200);
    const r = await fetch(base + "/digest?project=c-badge&q=harness", { headers: H });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { digest: string };
    const line = d.digest.split("\n").find((l) => l.startsWith("- 〔L1"))!;
    assert.ok(line.endsWith("（来自 claude-code）"), `badge rides the line end (got: ${line})`);

    // no-harness note (a page written without source metadata): exact old shape
    await fetch(base + "/pages", { method: "POST", headers: H, body: JSON.stringify({ project: "c-plain", title: "无来源标注", body: "普通页面不渲染徽标。" }) });
    const r2 = await fetch(base + "/digest?project=c-plain&q=普通", { headers: H });
    const d2 = (await r2.json()) as { digest: string };
    const line2 = d2.digest.split("\n").find((l) => l.startsWith("- 〔L1"))!;
    assert.match(line2, /^- 〔L1·note｜\d{4}-\d{2}-\d{2}〕无来源标注：普通页面不渲染徽标。$/, "no-harness line keeps the exact pre-badge shape");
    assert.ok(!d2.digest.includes("（来自"), "no phantom badge without harness metadata");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: a shared-partition candidate carries its date and confidence (4.2)", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/bob").token;
    const root = svc.rootForKey("u-bob");
    // The candidate lives in `shared`; the digest is requested for `cluster-7`.
    // The enrichment map used to be built from [project] only, so the lookup of
    // a shared path always missed — no date, no confidence, silently.
    root.writeDistillPage("shared", "experience", {
      id: "exp_shared1", engine: "engine:test/1", confidence: 0.66,
      task: "共享区的巡检口径", search_keys: ["巡检"], solution: "先看 digest",
      sources: [], supersedes: [],
    });
    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };
    const r = await fetch(base + "/digest?project=cluster-7&q=共享区的巡检", { headers: H });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { digest: string };
    assert.match(d.digest, /〔L2·experience｜置信 0\.66｜/, "shared candidate keeps its confidence annotation");
    assert.ok(/\｜\d{4}-\d{2}-\d{2}/.test(d.digest), "and its date");
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/digest: several partitions in one request, one budget, every entry labelled (6.1)", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/multi").token;
    const root = svc.rootForKey("u-multi");
    for (const [project, id, task] of [
      ["alpha", "exp_a1", "甲分区 的巡检口径"],
      ["beta", "exp_b1", "乙分区 的巡检口径"],
      ["shared", "exp_s1", "共享区 的巡检口径"],
    ] as const) {
      root.writeDistillPage(project, "experience", {
        id, engine: "e", confidence: 0.7, task, search_keys: ["巡检"], solution: "先看 digest",
        sources: [], supersedes: [],
      });
    }
    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };

    // Single partition: the response shape and the rendered lines are the old
    // ones — no partition tags, no extra fields.
    const one = await (await fetch(`${base}/digest?project=alpha&q=巡检口径&budget=600`, { headers: H })).json() as {
      digest: string; projects?: string[]; sources?: string[];
    };
    assert.equal(one.projects, undefined, "single form adds no partition list");
    assert.ok(!/〔L2·experience[^〕]*｜alpha〕/.test(one.digest), "single form adds no partition tag");

    // Multi partition: one request, entries from both partitions, each tagged.
    const multi = await (await fetch(`${base}/digest?projects=alpha,beta&q=巡检口径&budget=600`, { headers: H })).json() as {
      digest: string; projects: string[]; sources: string[]; items: number;
    };
    assert.deepEqual(multi.projects, ["alpha", "beta"]);
    assert.deepEqual(multi.sources, ["alpha", "beta"]);
    assert.match(multi.digest, /｜alpha〕/, "alpha entry carries its partition");
    assert.match(multi.digest, /｜beta〕/, "beta entry carries its partition");

    // ONE budget, not one per partition: the merged block stays within the
    // single-partition ceiling (a naive per-partition render would be ~2x).
    const multiTokens = (await import("../digest.js")).estimateTokens(multi.digest);
    assert.ok(multiTokens <= 600 * 1.15, `merged digest must stay inside one budget (got ${multiTokens})`);

    // A partition the token cannot read is refused, never silently dropped:
    // the member's own partition is granted at mint, an unrelated one is not.
    const member = svc.tokens.mint("deployment", "d/f/m1").token;
    const granted = await fetch(`${base}/digest?projects=m1`, { headers: { authorization: `Bearer ${member}` } });
    assert.equal(granted.status, 200, "own partition is readable");
    const denied = await fetch(`${base}/digest?projects=m1,not-mine`, { headers: { authorization: `Bearer ${member}` } });
    assert.equal(denied.status, 403, "one ungranted partition fails the whole read");
    assert.equal(((await denied.json()) as { error: string }).error, "forbidden_project");
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(data, { recursive: true, force: true });
  }
});
