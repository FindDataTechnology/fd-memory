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

test("/memory/index: 链式接替 A<-B<-C 只留链尾 C", async () => {
  // 2026-11-20 真实数据里看到的形态：蒸馏会连续更正同一结论，形成
  // bff26b7c <- 604caef9 <- b97bcd43 这样的链。中间节点自己已被接替，
  // 不该出现在注入里——否则读者会拿到一个「已被取代但仍被当作当前」的版本。
  //
  // 实现天然支持这一点（判据是「有没有人接替我」，与链长无关），但链式是
  // 真实数据里最常见的形态，必须钉住而不是假设。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-hana");
    const mk = (slug: string, title: string, sup?: string[]) =>
      root.writePage("default", "notes", slug, newPage("note", title, `${title} 正文`, sup ? { supersedes: sup } as never : {}));
    mk("a", "第一版");
    mk("b", "第二版", ["a"]);
    mk("c", "第三版", ["b"]);

    const person = svc.tokens.mint("person", "u/hana").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const titles = ((await r.json()) as { entries: Array<{ description: string }> }).entries.map((e) => e.description.trim());
    assert.equal(titles.filter((t) => t === "第一版").length, 0, "链头退出注入");
    assert.equal(titles.filter((t) => t === "第二版").length, 0, "中间节点也退出注入");
    assert.equal(titles.filter((t) => t === "第三版").length, 1, "只有链尾出现");
  } finally { await close(); }
});

test("/memory/index: 缓存不能让刚写入的记忆看不到", async () => {
  // 2026-11-20：注入面每次会话启动都全量扫 ~6,500 行并排序（实测端到端
  // 148–757ms，全在事件循环上同步跑）。加了进程内缓存，以 MAX(rowid) 为
  // 失效键。这条测试钉住缓存最危险的失败模式：写完看不到。
  // 用 TTL 就一定会中这个坑，用写版本号则不会。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-gina");
    root.writePage("default", "index", "seed",
      newPage("memory-index", "第一条", "初始内容", {
        metadata: { harness: "zcode", memory_type: "feedback", source_path: "/m/a.md", source_mtime: 100 },
      }));
    const person = svc.tokens.mint("person", "u/gina").token;
    const get = async () => {
      const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
      return ((await r.json()) as { entries: Array<{ description: string }> }).entries.map((e) => e.description.trim());
    };

    const first = await get();
    assert.ok(first.includes("初始内容"), "第一次请求能看到已有的页");
    // 再请求一次：命中缓存，结果不变。
    assert.deepEqual(await get(), first, "内容未变时缓存返回同样的结果");

    // 写一条新的 —— 下一个请求必须看到它，这是缓存失效的关键断言。
    root.writePage("default", "index", "fresh",
      newPage("memory-index", "第二条", "刚写入的内容", {
        metadata: { harness: "zcode", memory_type: "feedback", source_path: "/m/b.md", source_mtime: 200 },
      }));
    const after = await get();
    assert.ok(after.includes("刚写入的内容"), `写入后必须立刻可见，实际 ${JSON.stringify(after)}`);
  } finally { await close(); }
});

test("/memory/index: 同一结论被两个 harness 各写一份时，注入只出现一次", async () => {
  // 2026-11-20 实测：2,846 条 memory-index 里 523 组是同一个 memory_name 被
  // 两个 harness 各存一份（claude-code 的 paas/memory/x.md 与 zcode 的
  // bff3/memory/x.md），18.4% 的注入预算在展示同一个结论的两份副本。
  //
  // 判据「同名即同一结论、取最新」是用存量数据验证过的：523 组里 515 组正文
  // 完全相同，另 8 组是同一结论的新旧两版（10-22「已修」vs 10-23「已归档」）——
  // 两种情况都该只显示新的那份。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-dana");
    const mk = (harness: string, mtime: number, text: string) =>
      root.writePage("default", "index", `${harness}-dup`,
        newPage("memory-index", "同名结论", text, {
          metadata: {
            harness, memory_type: "feedback", memory_name: "shared-conclusion",
            source_path: `/m/${harness}/x.md`, source_mtime: mtime,
          },
        }));
    mk("claude-code", 100, "旧版本：已修但仍需验证");
    mk("zcode", 200, "新版本：已归档完结");

    const person = svc.tokens.mint("person", "u/dana").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ description: string; harness?: string; harnesses?: string[] }> }).entries;
    const dupes = entries.filter((e) => e.description.includes("版本："));
    assert.equal(dupes.length, 1, `同一 memory_name 只该出一条，实际 ${dupes.length}`);
    assert.ok(dupes[0].description.includes("新版本"), "保留 mtime 最新的那份");
    assert.deepEqual(dupes[0].harnesses, ["claude-code", "zcode"], "标注来源 harness 集合，读者知道两方都写过");
  } finally { await close(); }
});

test("/memory/index: 没有 memory_name 的页绝不被去重", async () => {
  // 手写页与蒸馏产物没有语义身份。按正文合并会误合并真正不同的结论——
  // 重复可以人工清理，丢掉的记忆找不回来。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-eli");
    for (const i of [0, 1]) {
      root.writePage("default", "index", `noname-${i}`,
        newPage("memory-index", `结论${i}`, "完全相同的正文", {
          metadata: { harness: "zcode", memory_type: "feedback", source_path: `/m/z/${i}.md`, source_mtime: 100 + i },
        }));
    }
    const person = svc.tokens.mint("person", "u/eli").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ description: string }> }).entries;
    // `newPage` appends a trailing newline to the body, and the index serves
    // the body verbatim — compare on the trimmed text.
    assert.equal(entries.filter((e) => e.description.trim() === "完全相同的正文").length, 2,
      "没有 memory_name 的两条正文相同也必须都保留");
  } finally { await close(); }
});

test("/memory/index: 被接替的页退出注入面", async () => {
  // superseded_edges 自 optimize-yongyi-read-surfaces 起就在写，但没有任何读面
  // 消费它——只有 supersedeEdgeAudit 做自检。于是一条被显式退役的页仍会每次
  // 会话被注入，写侧的意图从未生效。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-finn");
    root.writePage("default", "index", "old-concl",
      newPage("memory-index", "旧结论", "这条已被更正", {
        metadata: { harness: "zcode", memory_type: "feedback", source_path: "/m/z/old.md", source_mtime: 100 },
      }));
    root.writePage("default", "index", "new-concl",
      newPage("memory-index", "新结论", "这条取代旧的", {
        metadata: { harness: "zcode", memory_type: "feedback", source_path: "/m/z/new.md", source_mtime: 200 },
        supersedes: ["old-concl"],
      } as never));

    const person = svc.tokens.mint("person", "u/finn").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ description: string }> }).entries;
    assert.equal(entries.filter((e) => e.description.trim() === "这条已被更正").length, 0, "被接替的页不得出现在注入里");
    assert.equal(entries.filter((e) => e.description.trim() === "这条取代旧的").length, 1, "接替者照常出现");
    // 但仍可经 pages 读面找回
    const back = svc.rootForKey("u-finn").db.db.prepare("SELECT body FROM pages WHERE page_id=?").get("old-concl") as { body?: string } | undefined;
    assert.equal(back?.body?.trim(), "这条已被更正", "被接替页不物理删除，仍可读回");
  } finally { await close(); }
});

test("/memory/index: 蒸馏出来的 note 要进注入，且排在别人写的纪律之前", async () => {
  // 2026-11-16 实测缺口：distill 在跑、页也在写，但 /memory/index 只取
  // memory-index（由 sync.ts 扫描 harness 文件产生），note/fact 永远进不了
  // 注入 —— 「记忆越蒸馏越深，会话越看不见」，恰恰反了。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-carol");
    root.writePage("default", "index", "z1",
      newPage("memory-index", "z 纪律", "zcode 的一条纪律", {
        metadata: { harness: "zcode", memory_type: "feedback", source_path: "/m/z.md", source_mtime: 9e9 },
      }));
    root.writePage("default", "notes", "n1",
      newPage("note", "蒸馏出的一句话结论", "展开正文很长", { updated_at: "2026-11-16T10:00:00Z" }));

    const person = svc.tokens.mint("person", "u/carol").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=10`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ harness: string; memory_type: string; description: string }> }).entries;
    const n = entries.find((e) => e.memory_type === "note");
    assert.ok(n, `note 必须进注入，实际只有 ${entries.map((e) => e.memory_type).join(",")}`);
    assert.equal(n!.harness, "yongyi", "蒸馏产物来源标 yongyi");
    assert.equal(n!.description, "蒸馏出的一句话结论", "取 title（一句话结论），不是展开的 body");
    assert.equal(entries[0].memory_type, "note", "蒸馏结论排在别人写的纪律之前");
  } finally { await close(); }
});

test("/memory/index: 蒸馏产物（note/fact）不被 harness 配额挤掉", async () => {
  // 2026-11-17 实测：20 条 fact 一条都没进注入。原因是按 harness 持有量分
  // 配额 —— yongyi 只有几十条，在 2700+ 条里占比 0.7%，100 条预算分不到 1 条。
  // 而 note/fact 是「从本机全部流水里提炼过的」那层，复用价值最高，必须保底。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u/erin".replace("/", "-"));
    // 大量 harness 条目淹没预算
    for (let i = 0; i < 60; i++) {
      root.writePage("default", "index", `z${i}`,
        newPage("memory-index", `z${i}`, `zcode 纪律 ${i}`, {
          metadata: { harness: "zcode", memory_type: "feedback", source_path: `/m/z${i}.md`, source_mtime: 1e9 + i },
        }));
    }
    // 少量蒸馏产物
    root.writePage("default", "facts", "f1", newPage("fact", "蒸馏结论一", "正文", { updated_at: "2026-11-16T10:00:00Z" }));
    root.writePage("default", "facts", "f2", newPage("fact", "蒸馏结论二", "正文", { updated_at: "2026-11-16T11:00:00Z" }));

    const person = svc.tokens.mint("person", "u/erin").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=10`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ memory_type: string }> }).entries;
    const facts = entries.filter((e) => e.memory_type === "fact").length;
    assert.equal(facts, 2, `两条 fact 都必须进注入，实际 ${facts}/${entries.length}`);
  } finally { await close(); }
});

test("/memory/index: 同一领域值的多条记忆折叠为一条并标注条数", async () => {
  // add-domain-memory-schema 5.1: ten reviews of one instrument and ten reviews
  // of ten instruments cost the same number of lines, but only the first cannot
  // be read as "what do we have on this thing".
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-lex");
    // No memory_type: the priority rule keys off memory_type, so tagging these
    // "feedback" would push them into the harness-quota pool and only some
    // would be picked — the grouping would then have nothing to fold, which is
    // a test artifact, not a defect.
    for (let i = 0; i < 3; i++) {
      root.writePage("default", "notes", `same-${i}`,
        newPage("note", `600519 复盘 ${i}`, `第 ${i} 条`, {
          metadata: { instrument: "600519" },
        }));
    }
    root.writePage("default", "notes", "other",
      newPage("note", "别的标的", "另一条", { metadata: { instrument: "000001" } }));

    const person = svc.tokens.mint("person", "u/lex").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ domain_value?: string; domain_count?: number; domain_note?: string; description: string }> }).entries;

    const grouped = entries.filter((e) => e.domain_value === "600519");
    // assert.ok, not assert.equal: node:test puts expected/actual into structured
    // fields and drops the message, so a failing equal() reports "0 !== 1" and
    // nothing about WHAT the entries actually were — which is exactly the
    // information needed when CI and the laptop disagree.
    assert.ok(grouped.length === 1,
      `同标的应折叠为一条，实际 ${grouped.length}；全部条目=${JSON.stringify(entries.map((e) => ({ d: e.description, dv: e.domain_value, dc: e.domain_count })))}`);
    assert.equal(grouped[0].domain_count, 3, "展开前必须知道有几条");
    assert.ok(grouped[0].domain_note, "必须说明还有多少条未逐条展开");

    // A value with a single page is NOT collapsed — collapsing a group of one
    // would just add noise.
    const single = entries.filter((e) => e.domain_value === "000001");
    assert.ok(single.length === 1, `单条组应恰好一条，实际 ${single.length}；全部=${JSON.stringify(entries)}`);
    assert.ok(single[0].domain_count === undefined,
      `单条不标注条数，实际 ${JSON.stringify(single[0])}；全部=${JSON.stringify(entries)}`);
  } finally { await close(); }
});

test("/memory/index: 无领域键时输出与折叠功能加入前一致", async () => {
  // add-domain-memory-schema 5.3 red-proof anchor. Every page in the live
  // database today has no domain key, so the grouping path must be a no-op —
  // not "produces equivalent results", but literally the same objects.
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-nodom");
    for (let i = 0; i < 3; i++) {
      root.writePage("default", "notes", `plain-${i}`,
        newPage("note", `普通 ${i}`, `正文 ${i}`, { metadata: { memory_type: "feedback" } }));
    }
    const person = svc.tokens.mint("person", "u/nodom").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(entries.length, 3);
    for (const e of entries) {
      assert.equal(e.domain_value, undefined, "无领域键的条目不得带领域字段");
      assert.equal(e.domain_count, undefined);
      assert.equal(e.domain_note, undefined);
    }
  } finally { await close(); }
});

test("/memory/index: 领域值都不重复时，domain_value 仍必须出现", async () => {
  // add-domain-memory-schema. The grouping branch used to run only when some
  // value had >1 page, so a library where every page carries a DISTINCT domain
  // value — the normal case once the vocabulary is adopted — took the untouched
  // path and lost the field entirely. Measured on the live database: three pages
  // carried instruments and the response reported zero.
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-solo");
    // Three pages, three DIFFERENT instruments: nothing to fold.
    for (const v of ["A-1", "A-2", "A-3"]) {
      root.writePage("default", "notes", `solo-${v}`,
        newPage("note", `标的 ${v}`, `正文 ${v}`, { metadata: { instrument: v } }));
    }
    const person = svc.tokens.mint("person", "u/solo").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ domain_value?: string; domain_count?: number }> }).entries;
    assert.ok(entries.length === 3, `应三条，实际 ${entries.length}`);
    const withDomain = entries.filter((e) => e.domain_value !== undefined);
    assert.ok(withDomain.length === 3,
      `三条都必须带 domain_value（互不相同，不该折叠但也不该丢），实际 ${JSON.stringify(entries)}`);
    assert.ok(entries.every((e) => e.domain_count === undefined), "没有可折叠的，不该有条数");
  } finally { await close(); }
});

test("注入预算：纪律条目必须在预算耗尽前出现（类别保底）", async () => {
  // 2026-11-21 实测缺陷：服务端把 note/fact 排在前面（「更浓缩」），
  // 客户端按顺序消费 —— 真实库上 feedback 首个位置 50，预算在第 44 条耗尽，
  // 于是纪律条目**一条都没进过会话**，而代码注释称它是「每轮都该付钱买的两类」。
  //
  // 这里用同一份排序输入复刻客户端的取用逻辑，断言纪律条进得去。
  const mem = (i: number) => ({ harness: "yongyi", memory_type: "note",
    description: `记忆条目 ${i}，内容长度接近真实均值以便消耗预算` });
  const disc = (h: string, i: number) => ({ harness: h, memory_type: "feedback",
    description: `纪律 ${i}，同样长度以便公平比较预算消耗情况` });
  // 服务端顺序：50 条 note 在前，feedback 在后
  const entries = [
    ...Array.from({ length: 50 }, (_, i) => mem(i)),
    ...Array.from({ length: 5 }, (_, i) => disc("zcode", i)),
    ...Array.from({ length: 5 }, (_, i) => disc("claude-code", i)),
  ];
  const isDisc = (t?: string) => t === "feedback" || t === "user";
  const interleave = (list: typeof entries) => {
    const b = new Map<string, typeof entries>();
    for (const e of list) { const k = String(e.harness); const x = b.get(k); if (x) x.push(e); else b.set(k, [e]); }
    return [...b.values()].flatMap((bucket) => bucket.map((e, i) => ({ e, key: i / Math.max(1, bucket.length) })))
      .sort((a, b2) => a.key - b2.key).map((x) => x.e);
  };
  const ordered = [
    ...interleave(entries.filter((e) => isDisc(e.memory_type))),
    ...interleave(entries.filter((e) => !isDisc(e.memory_type))),
  ];
  // 3000 字符预算
  let used = 0; const shown: typeof entries = [];
  for (const e of ordered) { const len = e.description.length + 12; if (used + len > 3000) break; used += len; shown.push(e); }
  const d = shown.filter((e) => isDisc(e.memory_type));
  assert.ok(d.length > 0, `纪律条目必须进预算，实际 0/${shown.length}`);
  assert.ok(d.some((e) => e.harness === "claude-code"), "两个 harness 的纪律都要有代表");
  assert.ok(shown.some((e) => !isDisc(e.memory_type)), "记忆条目也不能被完全挤掉");
});

test("磁盘兜底：最近写入全是 note 时，纪律条目仍必须出现", async () => {
  // 2026-11-21 实测：磁盘兜底（服务不可达时走的路径）只按 mtime 倒序取用，
  // 没有类别配额。造一个「20 条最新全是 note + 5 条较旧 feedback」的场景，
  // 修复前 21 行里只有 1 条纪律是侥幸挤进来的；note 再多一点就是 0。
  //
  // 这是 HTTP 路径那个饥饿缺陷在兜底路径上的同一形态——而兜底是故障期间
  // 会话唯一能拿到的东西，不能是较弱的那条。
  const { readIndexFromDisk } = await import("../connect/cli.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fd-disc-"));
  try {
    const D = path.join(home, "owners", "u-demo", "wiki", "default", "memory-index");
    fs.mkdirSync(D, { recursive: true });
    const write = (name: string, type: string, title: string, ago: number) => {
      const p = path.join(D, name);
      fs.writeFileSync(p, `---\ntype: memory-index\ntitle: ${title}\ngenerated:\n  by: process\n  at: 2026-01-01T00:00:00.000Z\nmetadata:\n  memory_type: ${type}\n  harness: zcode\n---\n正文\n`);
      const t = new Date(Date.now() - ago * 1000);
      fs.utimesSync(p, t, t);
    };
    // 20 条最新的全是 note，5 条较旧的 feedback
    for (let i = 0; i < 20; i++) write(`n${i}.md`, "note", `最新笔记 ${i} 标题长度接近真实值以消耗预算`, i);
    for (let i = 0; i < 5; i++) write(`f${i}.md`, "feedback", `较早的纪律 ${i} 同样长度以公平比较`, 1000 + i);

    const prev = process.env.FD_MEMORY_DATA;
    process.env.FD_MEMORY_DATA = home;
    try {
      const out = readIndexFromDisk("default", { namespace: "u/demo" } as never, 900, false);
      const lines = out.split("\n").filter((l) => l.startsWith("- 〔"));
      assert.ok(lines.some((l) => l.includes("纪律")),
        `纪律条目必须出现在兜底输出里，实际=${JSON.stringify(lines.map((l) => l.slice(0, 24)))}`);
      assert.ok(lines.some((l) => l.includes("笔记")), "记忆条目也不能被完全挤掉");
    } finally {
      if (prev === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = prev;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("/memory/index: 缓存的条目数有上限", async () => {
  // 2026-11-21：缓存的注释从它诞生起就写着「bounded to 200 entries」，
  // 但根本没有驱逐代码——承诺只在注释里。
  // 键含调用方指定的 `limit`，单项目就能产生 200 个键；多 root × 多 project
  // 时无上限，每条都存一份序列化后的 100 条响应。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-cap");
    root.writePage("default", "notes", "seed",
      newPage("note", "种子", "内容", { metadata: { memory_type: "feedback" } }));
    const person = svc.tokens.mint("person", "u/cap").token;
    // 用不同 limit 打满缓存：键含 limit，所以每次都是新键
    for (let i = 1; i <= 260; i++) {
      await fetch(`${base}/memory/index?project=default&limit=${i}`, { headers: json(person) });
    }
    const cache = (svc as unknown as { indexCache: Map<string, unknown> }).indexCache;
    assert.ok(cache instanceof Map);
    assert.ok(cache.size <= 200, `缓存条目必须被上限约束，实际 ${cache.size}`);
  } finally { await close(); }
});

test("/memory/index: 拆分查询后结果与拆分前逐条一致", async () => {
  // slim-injection-query-and-expose-latency 1.4。拆成两条查询（note/fact 不取
  // body，memory-index 取）是为了省 IO，但对外行为必须一模一样——条目、顺序、
  // description 全等。这条测试是拆分安全性的唯一保证。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-split");
    // memory-index（description 取 body）
    root.writePage("default", "memory-index", "mi-1",
      newPage("memory-index", "索引标题", "索引正文的内容", {
        metadata: { harness: "zcode", memory_type: "feedback", memory_name: "mi-1", source_path: "/m/a.md", source_mtime: 100 },
      }));
    // note（description 取 title）
    root.writePage("default", "notes", "n-1",
      newPage("note", "笔记标题一", "笔记正文一", { metadata: { memory_type: "feedback" } }));
    root.writePage("default", "notes", "n-2",
      newPage("note", "笔记标题二", "笔记正文二", { metadata: { memory_type: "feedback" } }));
    // fact
    root.writePage("default", "facts", "f-1",
      newPage("fact", "事实标题", "事实正文", { metadata: { memory_type: "note" } }));

    const person = svc.tokens.mint("person", "u/split").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ description: string; memory_type: string; harness: string }> }).entries;

    assert.equal(entries.length, 4, `四条都要出现，实际 ${entries.length}`);
    const descs = entries.map((e) => e.description.trim()).sort();
    // memory-index 的 description 是 body；note/fact 的是 title
    assert.ok(descs.includes("索引正文的内容"), "memory-index 的 description 必须取 body");
    assert.ok(descs.includes("笔记标题一"), "note 的 description 必须取 title");
    assert.ok(descs.includes("笔记标题二"));
    assert.ok(descs.includes("事实标题"), "fact 的 description 必须取 title");
    // 反向确认：note 的正文不该出现在 description 里
    assert.ok(!descs.some((d) => d.includes("笔记正文")), "note 的 body 不该被当成 description");
  } finally { await close(); }
});

test("/memory/index: 跨类型同 semantic identity 仍然只出现一次", async () => {
  // slim-injection-query-and-expose-latency 1.5。拆成两条查询后，若各算各的去重，
  // 一条 memory-index 与一条 note 带同一 memory_name 会各出现一次。
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-xdup");
    root.writePage("default", "memory-index", "dup-a",
      newPage("memory-index", "同一结论", "来自 memory-index", {
        metadata: { harness: "zcode", memory_type: "feedback", memory_name: "shared-identity", source_mtime: 100 },
      }));
    root.writePage("default", "notes", "dup-b",
      newPage("note", "同一结论（笔记版）", "来自 note", {
        metadata: { memory_name: "shared-identity", memory_type: "feedback" },
      }));

    const person = svc.tokens.mint("person", "u/xdup").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ description: string }> }).entries;
    const hitting = entries.filter((e) => String(e.description).includes("同一结论"));
    assert.equal(hitting.length, 1,
      `跨类型同 identity 必须收敛为一条，实际 ${hitting.length}: ${JSON.stringify(entries.map((e) => e.description))}`);
  } finally { await close(); }
});

test("/admin/metrics: 注入耗时给出中位数与最大值，慢调用不被平均掉", async () => {
  // slim-injection-query-and-expose-latency 2.2/2.4。平均值会主动误导：
  // 一次 2,100ms 混在十九次 30ms 里读作 130ms，而那一次正是让会话降级的那个。
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/lat").token;
    svc.rootForKey("u/lat").writePage("default", "notes", "seed",
      newPage("note", "种子", "内容", { metadata: { memory_type: "feedback" } }));

    // 打几次注入，产生样本
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    }
    const runner = svc.tokens.mint("runner", "d/lat").token;
    const m = await (await fetch(`${base}/admin/metrics`, { method: "POST", headers: json(runner) })).json() as {
      injection?: { samples: number; median_ms: number | null; max_ms: number | null; budget_ms: number; near_budget?: boolean };
    };
    assert.ok(m.injection, "metrics 必须暴露 injection 段");
    assert.ok(m.injection!.samples >= 3, `至少三次样本，实际 ${m.injection!.samples}`);
    assert.ok(typeof m.injection!.median_ms === "number", "必须有中位数");
    assert.ok(typeof m.injection!.max_ms === "number", "必须有最大值");
    assert.equal(m.injection!.budget_ms, 2500, "预算默认 2500，与客户端一致");
    assert.ok(m.injection!.max_ms! >= m.injection!.median_ms!, "最大值不可能小于中位数");
  } finally { await close(); }
});

// ── the declared schema reaches the injection face BEFORE the write ─────────
//
// add-memory-schema-axis gave `key_by` a CONSUMER (the write-side hint). That
// is still one-directional: the agent learns "you forgot instrument" only
// after it has already written without one, every turn. The declaration is a
// standing convention for the team, so it has to be visible on the READ face —
// that is where an agent looks before deciding what to write.
//
// These tests pin both halves: the block appears when declared, and the
// response is byte-identical to the pre-change shape when it is not (the same
// "additive, absent-by-default" discipline the domain folding follows).

test("/memory/index: a declared key_by is reported on the read face", async () => {
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-sch");
    root.db.setMemoryPolicy("root", { key_by: "instrument" });
    root.writePage("default", "notes", "seed", newPage("note", "种子", "内容", {}));

    const person = svc.tokens.mint("person", "u/sch").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { schema?: { key_by: string; domain: string | null } };
    assert.ok(body.schema, "声明的 key_by 必须出现在注入面（否则 agent 只能写完才知道）");
    assert.equal(body.schema!.key_by, "instrument");
    assert.equal(body.schema!.domain, "invest", "域由词表推导，不是另存一份");
  } finally { await close(); }
});

test("/memory/index: without a declaration the response carries no schema key", async () => {
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-nosch");
    root.writePage("default", "notes", "seed", newPage("note", "种子", "内容", {}));

    const person = svc.tokens.mint("person", "u/nosch").token;
    const body = (await (await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) })).json()) as Record<string, unknown>;
    // Absent, not null: a root that never adopted the vocabulary must get the
    // exact pre-change shape, so nothing downstream starts branching on a field
    // that means "we have no idea" for everyone.
    assert.equal("schema" in body, false, "无声明时不得出现 schema 字段");
  } finally { await close(); }
});

test("/memory/index: declaring a key invalidates the injection cache", async () => {
  const { svc, base, close } = await boot();
  try {
    const root = svc.rootForKey("u-cache");
    root.writePage("default", "notes", "seed", newPage("note", "种子", "内容", {}));

    const person = svc.tokens.mint("person", "u/cache").token;
    const first = (await (await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) })).json()) as Record<string, unknown>;
    assert.equal("schema" in first, false);

    // Declare AFTER the first read cached a no-schema body. Nothing writes a
    // page here on purpose: the only thing that changed is the policy row, so
    // a cache keyed on `MAX(rowid)` alone would keep serving the old answer —
    // which reads exactly like "the declaration was ignored".
    root.db.setMemoryPolicy("root", { key_by: "party" });
    const second = (await (await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) })).json()) as { schema?: { key_by: string } };
    assert.equal(second.schema?.key_by, "party", "声明变化必须让注入缓存失效");
  } finally { await close(); }
});
