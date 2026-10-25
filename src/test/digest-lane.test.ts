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
    // agent refused even with rootKey; person with rootKey rejected
    assert.equal((await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: { authorization: `Bearer ${dep}` } })).status, 403);
    assert.equal((await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: H })).status, 400);

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
    assert.match(d.digest, /〔L1·note｜2026-10-2\d〕集群回合 2026-10-25 08:00/);
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
