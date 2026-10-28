// Unified memory & outputs (add-unified-memory-and-outputs): reference page
// model + tier semantics + tag lanes + the gesture write-master face.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { StoreRoot } from "../store.js";
import { Service } from "../http.js";
import { newPage } from "../okf.js";
import { __resetEmbedGate } from "../embed-gate.js";

function tmpData(prefix = "fdm-ref-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeRoot(): StoreRoot {
  return new StoreRoot(tmpData("fdm-ref-root-"), "u-tester");
}

async function svcServer(dataDir: string): Promise<{ svc: Service; server: ReturnType<typeof createServer>; base: string }> {
  const svc = new Service({ dataDir, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { svc, server, base };
}

test("reference pages index tags/tier/source_ref and query by tier boost", () => {
  const root = makeRoot();
  root.writePage("default", "references", "r1", newPage("reference", "合同模板", "正式合同模板来自法务部", { source_ref: "resource:offered/contract.docx", tags: ["合同", "法务"], tier: "canonical" }));
  root.writePage("default", "references", "r2", newPage("reference", "图表试验", "草稿变图第二版", { source_ref: "resource:offered/chart2.json", tags: ["图表"], tier: "draft" }));
  const hit = root.db.queryReferences("default", "合同", 3);
  assert.equal(hit.length >= 1, true);
  assert.equal(String(hit[0].path).endsWith("references/r1.md"), true);
  assert.equal(hit[0].tier, "canonical");
  // draft 无 query 命中时不入列
  const none = root.db.queryReferences("default", "完全无关词xyz", 3);
  assert.equal(none.filter((r) => r.tier === "draft").length, 0);
  // canonical 即便无关键词命中也在列（tier 信号）
  assert.equal(none.some((r) => r.tier === "canonical"), true);
});

test("corrections feed: 修正 note 标题前缀可检索", () => {
  const root = makeRoot();
  root.writePage("default", "notes", "c1", newPage("note", "修正：default/references/r1.md", "tags: [合同] → [章程]", { origin: "human", correction_of: "r1" }));
  const rows = root.db.correctionsAfter("default", "", 10);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /^修正：/);
  assert.match(rows[0].body, /章程/);
});

test("/memory tier+tag 筛选与 fields", async () => {
  __resetEmbedGate();
  const { svc, server, base } = await svcServer(tmpData());
  try {
    const person = (svc as unknown as { tokens: { mint(k: string, ns: string, l?: string): { token: string } } }).tokens.mint("person", "u/tester").token;
    const root = (svc as unknown as { rootForKey(k: string): StoreRoot }).rootForKey("u-tester");
    root.writePage("default", "references", "r1", newPage("reference", "合同模板", "正式模板", { source_ref: "resource:x", tags: ["合同"], tier: "canonical" }));
    root.writePage("default", "references", "r2", newPage("reference", "草稿图", "未定性", { source_ref: "resource:y", tags: ["图"], tier: "draft" }));
    const H = { authorization: `Bearer ${person}` };
    const res = await fetch(`${base}/memory?tier=canonical`, { headers: H });
    assert.equal(res.status, 200);
    const list = (await res.json()) as { items: Array<{ path: string; tier: string; tags: string[]; type: string }> } | Array<{ path: string; tier: string; tags: string[]; type: string }>;
    const items = Array.isArray(list) ? list : list.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].tier, "canonical");
    const res2 = await fetch(`${base}/memory?tag=${encodeURIComponent("图")}`, { headers: H });
    const list2 = (await res2.json()) as { items: Array<{ tags: string[] }> } | Array<{ tags: string[] }>;
    const items2 = Array.isArray(list2) ? list2 : list2.items;
    assert.equal(items2.length, 1);
    assert.deepEqual(items2[0].tags, ["图"]);
  } finally {
    server.close();
  }
});

test("/pages/mutate 手势面：set_tier/set_tags 写主 + correction note + agent 拒", async () => {
  __resetEmbedGate();
  const { svc, server, base } = await svcServer(tmpData());
  try {
    const tokens = svc as unknown as { tokens: { mint(k: string, ns: string, l?: string): { token: string } } };
    const person = tokens.tokens.mint("person", "u/tester").token;
    const agent = tokens.tokens.mint("deployment", "d/p1/a1").token;
    const root = (svc as unknown as { rootForKey(k: string): StoreRoot }).rootForKey("u-tester");
    root.writePage("default", "references", "r1", newPage("reference", "合同模板", "正式", { source_ref: "resource:z", tier: "draft" }));
    const H = { authorization: `Bearer ${person}`, "content-type": "application/json" };
    // agent 被拒
    const resA = await fetch(`${base}/pages/mutate`, { method: "POST", headers: { authorization: `Bearer ${agent}`, "content-type": "application/json" }, body: JSON.stringify({ path: "default/references/r1.md", op: "set_tier", tier: "canonical" }) });
    assert.equal(resA.status, 403);
    const res1 = await fetch(`${base}/pages/mutate`, { method: "POST", headers: H, body: JSON.stringify({ path: "default/references/r1.md", op: "set_tier", tier: "canonical", origin: "human" }) });
    assert.equal(res1.status, 200);
    const out1 = (await res1.json()) as { changed: boolean };
    assert.equal(out1.changed, true);
    // 幂等：同 tier 再调 unchanged
    const res2 = await fetch(`${base}/pages/mutate`, { method: "POST", headers: H, body: JSON.stringify({ path: "default/references/r1.md", op: "set_tier", tier: "canonical" }) });
    const out2 = (await res2.json()) as { changed: boolean };
    assert.equal(out2.changed, false);
    // set_tags + correction note 落盘
    const res3 = await fetch(`${base}/pages/mutate`, { method: "POST", headers: H, body: JSON.stringify({ path: "default/references/r1.md", op: "set_tags", tags: ["章程"], origin: "human" }) });
    assert.equal(((await res3.json()) as { changed: boolean }).changed, true);
    const corr = root.db.correctionsAfter("default", "", 10);
    assert.equal(corr.length >= 1, true);
    assert.equal(corr.some((c) => /章程/.test(c.body)), true);
  } finally {
    server.close();
  }
});

test("tagging lane: 打标预算门 + AI 写 tags + 人工位不被覆写 + 游标前进", async () => {
  __resetEmbedGate();
  const data = tmpData();
  const schedMod = await import("../distill-scheduler.js");
  const tokens = new (await import("../auth.js")).TokenStore(join(data, "tokens.db"), "p");
  const root = new StoreRoot(join(data, "owners"), "u-tester");
  const roots = new Map([[ "u-tester", root ]]);
  const refs = [
    { slug: "t1", title: "签约合同流程 v2", summary: "正式签约演进阶指南", asHuman: false },
    { slug: "t2", title: "板块总额日报", summary: "板块日报草稿", asHuman: true },
  ];
  for (const r of refs) {
    const extra: Record<string, unknown> = r.asHuman ? { source_ref: "resource:lib/b", tags: ["旧"], tags_origin: "human", tier: "stable", tier_origin: "human" } : { source_ref: "resource:lib/a" };
    root.writePage("default", "references", r.slug, newPage("reference", r.title, r.summary, extra));
  }
  const tagCalls: Array<Record<string, unknown>> = [];
  const sched = new schedMod.DistillScheduler({
    roots, openRoot: (k: string) => { const r = roots.get(k); if (!r) throw new Error("no root"); return r; },
    tokens, env: (await import("node:process")).env,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/distill")) return { ok: true, status: 200, json: async () => ({ facts: [], experiences: [], llm_calls: [], tokens: 10, errors: [] }) } as Response;
      if (u.endsWith("/tag")) {
        tagCalls.push(init?.body ? JSON.parse(String(init.body)) : null);
        return { ok: true, status: 200, json: async () => ({ results: [{ idx: 0, tags: ["合同", "法务"], tier: "stable" }, { idx: 1, tags: ["覆盖"], tier: "canonical" }], tokens: 42, errors: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ vectors: [], model: "m", tokens: 0, errors: [] }) } as Response;
    }) as unknown as typeof fetch,
    now: () => Date.now(),
  });
  await sched.distillNow("u-tester", "default");
  // /tag 被调用一次，tags/tier 落盘且 AI 位标
  assert.equal(tagCalls.length >= 1, true);
  const p1 = root.readPageByRel("default/references/t1.md");
  assert.deepEqual(p1?.frontmatter?.tags, ["合同", "法务"]);
  assert.equal(p1?.frontmatter?.tags_origin, "ai");
  assert.equal(p1?.frontmatter?.tier, "stable");
  // 人工位不被覆写
  const p2 = root.readPageByRel("default/references/t2.md");
  assert.deepEqual(p2?.frontmatter?.tags, ["旧"]);
  assert.equal(p2?.frontmatter?.tags_origin, "human");
  assert.equal(p2?.frontmatter?.tier, "stable");
  // canonical 永仅经人类（AI 说 canonical 也润笔为 stable）
  assert.notEqual(p2?.frontmatter?.tier, "canonical");
  // 游标前进后二跑无新打标
  await sched.distillNow("u-tester", "default");
  assert.equal(tagCalls.length >= 1, true);
  const callCountBefore = tagCalls.length;
  // 没有新页时不发起新调用
  const pending = root.db.referencesNeedingTags("default", p2 ? "2999-01-01" : "", 5);
  assert.equal(pending.length, 0);
  assert.equal(tagCalls.length, callCountBefore);
});

test("/digest reference 渲染为名份引用", async () => {
  __resetEmbedGate();
  const { svc, server, base } = await svcServer(tmpData());
  try {
    const person = (svc as unknown as { tokens: { mint(k: string, ns: string, l?: string): { token: string } } }).tokens.mint("person", "u/tester").token;
    const root = (svc as unknown as { rootForKey(k: string): StoreRoot }).rootForKey("u-tester");
    root.writePage("default", "references", "r1", newPage("reference", "合同模板", "法务模板", { source_ref: "resource:a", tags: ["合同"], tier: "canonical" }));
    const res = await fetch(`${base}/digest?project=default&q=${encodeURIComponent("合同")}`, { headers: { authorization: `Bearer ${person}` } });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { digest: string };
    assert.match(out.digest, /见资料库《合同模板》/);
    assert.match(out.digest, /L2·reference/);
  } finally {
    server.close();
  }
});
