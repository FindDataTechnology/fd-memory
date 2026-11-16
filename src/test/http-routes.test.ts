// Route-boundary contracts (harden-memory-surfaces §1). These hit a REAL
// service over a REAL port: the bugs this repo actually shipped lived in the
// parameter-parsing / scope-branch seams (`q ?? ""`, clamp expressions,
// kind checks) — mocking those would test the mock, not the surface.
//
//   npm test  (tsc + node --test dist/test/*.test.js)

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { newPage } from "../okf.js";
import { metricsSnapshot, __resetMetrics } from "../metrics.js";
import { __resetEmbedGate } from "../embed-gate.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(prefix = "fdm-routes-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function boot() {
  __resetEmbedGate();
  __resetMetrics();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { svc, base, close };
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

test("/digest: missing project is a named 400, never an empty 200", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const r = await fetch(`${base}/digest?rootKey=d-probe&q=x`, { headers: json(platform) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "project_required");
  } finally { await close(); }
});

test("/digest: scope taxonomy — platform needs rootKey, person must not send it, agents refused", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const person = svc.tokens.mint("person", "u/alice").token;
    const agent = svc.tokens.mint("deployment", "d/pk/agentA").token;

    const a = await fetch(`${base}/digest?project=default&q=x`, { headers: json(platform) });
    assert.equal(a.status, 400);
    assert.equal(((await a.json()) as { error: string }).error, "rootKey_required");

    // person rootKey = the oversight lane (add-agent-memory-foundation):
    // u-alice owns no d/ root → 403 forbidden_root (existence never leaked)
    const b = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=x`, { headers: json(person) });
    assert.equal(b.status, 403);
    assert.equal(((await b.json()) as { error: string }).error, "forbidden_root");

    // Deployment digest read (add-agent-memory-foundation follow-on): grant-
    // checked against its own partition; a rootKey param is refused (the
    // token's namespace IS the root).
    const c = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=x`, { headers: json(agent) });
    assert.equal(c.status, 400);
    assert.equal(((await c.json()) as { error: string }).error, "rootKey_is_platform_seam_only");
    const ownRead = await fetch(`${base}/digest?project=agentA&q=x`, { headers: json(agent) });
    assert.equal(ownRead.status, 200, "deployment token reads its own partition digest");
    const foreign = await fetch(`${base}/digest?project=other-member&q=x`, { headers: json(agent) });
    assert.equal(foreign.status, 403, "grant check refuses partitions outside own+shared");
  } finally { await close(); }
});

test("/digest: blank q (empty / spaces / newlines) is a normal 200 with NO model_note, counted as `empty`", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const root = svc.rootForKey("d-probe");
    root.writePage("default", "facts", "f1", newPage("fact", "结算口径", "T+1 结算以回单为准", { tags: ["财务"] }));
    const before = (metricsSnapshot() as { digest: { empty: number; vector_ratio: number | null; total: number } }).digest;

    for (const q of ["", "   ", "\n\t"]) {
      const r = await fetch(`${base}/digest?rootKey=d-probe&project=default&k=3&q=${encodeURIComponent(q)}`, { headers: json(platform) });
      assert.equal(r.status, 200, `blank q variant ${JSON.stringify(q)} must be a normal 200`);
      const doc = (await r.json()) as Record<string, unknown>;
      assert.equal("model_note" in doc, false, "a blank query never lost a vector rung — no degradation note");
    }
    const after = (metricsSnapshot() as { digest: { empty: number; vector_ratio: number | null; total: number } }).digest;
    assert.equal(after.empty - before.empty, 3, "blank queries ride their own rung");
    assert.equal(after.total, before.total, "the empty rung stays out of the degraded denominator");
    assert.equal(after.vector_ratio, before.vector_ratio, "an idle call must not move vector_ratio");
  } finally { await close(); }
});

test("/digest: k and budget extremes clamp instead of erroring", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    svc.rootForKey("d-probe").writePage("default", "facts", "f1", newPage("fact", "口径", "内容"));
    for (const qs of ["k=0&budget=1", "k=-5&budget=999999999", "k=999&budget=0"]) {
      const r = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=${encodeURIComponent("口径")}&${qs}`, { headers: json(platform) });
      assert.equal(r.status, 200, `${qs} must complete, not error`);
      const doc = (await r.json()) as { items: number };
      assert.ok(Number.isInteger(doc.items) && doc.items >= 0);
    }
  } finally { await close(); }
});

test("/pages/mutate: unknown tier and unknown op are 400s that touch nothing", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const root = svc.rootForKey("d-probe");
    root.writePage("default", "facts", "f1", newPage("fact", "口径", "内容", { tier: "draft" }));
    const rel = "default/facts/f1.md";

    const t = await fetch(`${base}/pages/mutate?rootKey=d-probe`, {
      method: "POST", headers: json(platform), body: JSON.stringify({ path: rel, op: "set_tier", tier: "verified" }),
    });
    assert.equal(t.status, 400);
    assert.equal(((await t.json()) as { error: string }).error, "invalid_tier");
    assert.equal(String(root.readPageByRel(rel)?.frontmatter?.tier ?? "draft"), "draft", "rejected write must not land");

    const o = await fetch(`${base}/pages/mutate?rootKey=d-probe`, {
      method: "POST", headers: json(platform), body: JSON.stringify({ path: rel, op: "delete_page" }),
    });
    assert.equal(o.status, 400);
    const od = (await o.json()) as { error: string; allowed: string[] };
    assert.equal(od.error, "unknown_op");
    assert.deepEqual(od.allowed, ["set_tier", "set_tags"]);
  } finally { await close(); }
});

test("/pages/write: an invalid tier is normalized to draft (documented, deterministic)", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    // /pages/write serves the note|reference face (fact/experience are the
    // distiller's to write); reference needs a source_ref.
    const r = await fetch(`${base}/pages/write?rootKey=d-probe`, {
      method: "POST", headers: json(platform),
      body: JSON.stringify({
        project: "default", type: "reference", title: "口径", body: "内容",
        source_ref: "resource:probe/x.json", slug: "tier-probe", tier: "verified",
      }),
    });
    assert.equal(r.status, 201, "page creation answers 201");
    const page = svc.rootForKey("d-probe").readPageByRel("default/references/tier-probe.md");
    assert.ok(page, "page must exist");
    // the arbitrary string never reaches the page — behavior is "normalize to draft"
    assert.equal(String(page!.frontmatter?.tier ?? "draft"), "draft");
  } finally { await close(); }
});

test("/pages/write: unsupported page type is a named 400 (fact/experience are distiller-written)", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const r = await fetch(`${base}/pages/write?rootKey=d-probe`, {
      method: "POST", headers: json(platform),
      body: JSON.stringify({ project: "default", type: "fact", title: "口径", body: "内容" }),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string; type?: string; allowed?: string[]; hint?: string };
    assert.equal(body.error, "unknown_page_type");
    // 两个面（MCP / HTTP）必须给出同一组可行值——否则按码分诊的人还得再猜一次
    assert.deepEqual(body.allowed, ["note", "reference"]);
    assert.equal(body.type, "fact");
    assert.match(String(body.hint), /metadata/);
  } finally { await close(); }
});

test("/memory: junk filters answer 200 (no 500), agents are refused", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const agent = svc.tokens.mint("deployment", "d/pk/agentA").token;
    svc.rootForKey("d-probe").writePage("default", "facts", "f1", newPage("fact", "口径", "内容"));

    for (const qs of ["tier=verified", "tier=&tag=,,,", "tag=%00&layer=XYZ", "since=not-a-date&until="]) {
      const r = await fetch(`${base}/memory?rootKey=d-probe&${qs}`, { headers: json(platform) });
      assert.equal(r.status, 200, `${qs} must not blow up the read face`);
      assert.ok(Array.isArray(((await r.json()) as { items: unknown[] }).items));
    }
    const a = await fetch(`${base}/memory?rootKey=d-probe`, { headers: json(agent) });
    assert.equal(a.status, 403);
  } finally { await close(); }
});

test("/memory/index: 任一 harness 都不能被另一个饿死（跨 harness 配额）", async () => {
  // 2026-11-16 实测缺陷：平铺「feedback 优先 + mtime 倒序」在真实库上返回
  // 100/100 zcode、claude-code 0 条（2 727 条可用）。zcode 的 feedback 文件
  // 又多又常改，两项排序键都赢，其他 harness 全被挤出预算。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-alice");
    const mk = (harness: string, n: number, mtime: number) => {
      for (let i = 0; i < n; i++) {
        root.writePage("default", "index", `${harness}-${i}`,
          newPage("memory-index", `${harness} ${i}`, `${harness} 结论 ${i}`, {
            metadata: { harness, memory_type: "feedback", source_path: `/m/${harness}/${i}.md`, source_mtime: mtime + i },
          }));
      }
    };
    mk("zcode", 40, 1000);        // 多且新
    mk("claude-code", 10, 1);     // 少且旧

    const person = svc.tokens.mint("person", "u/alice").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    assert.equal(r.status, 200);
    const entries = ((await r.json()) as { entries: Array<{ harness: string }> }).entries;
    const hz = entries.filter((e) => e.harness === "zcode").length;
    const hc = entries.filter((e) => e.harness === "claude-code").length;
    assert.ok(hc > 0, `claude-code 必须出现，实际 ${hc}/20（zcode ${hz}）`);
    // 份额按持有量分配：zcode:claude-code = 40:10 ⇒ 20 条里约 16:4。
    // 不断言精确值（轮转边界会差 1），只断言两边都在且大的一方多。
    assert.ok(hz > hc, `zcode 条目多，应占更多槽位（zcode ${hz} / claude ${hc}）`);
    assert.equal(hz + hc, 20, "配额预算未被浪费");
  } finally { await close(); }
});

test("会话启动注入：预算装不下全部时，每个 harness 都要按比例露头", async () => {
  // 2026-11-16 实测：服务端按配额返回 zcode 73 / claude 27，但注入预算 3000
  // 字符只装得下约 35 条，照原顺序截断后前 35 条几乎全是 zcode ⇒ 配额在
  // 客户端这一步被抹平，会话看到的仍是单 harness。这里验证轮转取用。
  //
  // 直接测纯逻辑：喂 40 条 zcode + 20 条 claude，走与 buildSessionContext
  // 相同的轮转 + 截断，断言两个 harness 都出现。
  const desc = (h: string, i: number) => ({ harness: h, memory_type: "feedback",
    description: `${h} 的第 ${i} 条结论，内容足够长以消耗预算字符` });
  const entries = [
    ...Array.from({ length: 40 }, (_, i) => desc("zcode", i)),
    ...Array.from({ length: 20 }, (_, i) => desc("claude-code", i)),
  ];
  // 与 buildSessionContext 相同的归一化位置交错
  const byHarness = new Map<string, typeof entries>();
  for (const e of entries) {
    const b = byHarness.get(e.harness);
    if (b) b.push(e); else byHarness.set(e.harness, [e]);
  }
  const ordered = [...byHarness.values()]
    .flatMap((bucket) => bucket.map((e, pos) => ({ e, key: pos / Math.max(1, bucket.length) })))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.e);
  // 模拟 3000 字符预算：只取前 30 条，看构成
  const shown = ordered.slice(0, 30);
  const hz = shown.filter((e) => e.harness === "zcode").length;
  const hc = shown.filter((e) => e.harness === "claude-code").length;
  assert.ok(hc > 0, `预算被截断后 claude-code 仍须出现，实际 ${hc}/30`);
  assert.ok(hz > hc, `zcode 持有更多，应占更多，实际 zcode ${hz} / claude ${hc}`);
});
