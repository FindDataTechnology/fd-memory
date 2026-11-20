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
    for (let i = 0; i < 3; i++) {
      root.writePage("default", "notes", `same-${i}`,
        newPage("note", `600519 复盘 ${i}`, `第 ${i} 条`, {
          metadata: { instrument: "600519", memory_type: "feedback" },
        }));
    }
    root.writePage("default", "notes", "other",
      newPage("note", "别的标的", "另一条", { metadata: { instrument: "000001", memory_type: "feedback" } }));

    const person = svc.tokens.mint("person", "u/lex").token;
    const r = await fetch(`${base}/memory/index?project=default&limit=20`, { headers: json(person) });
    const entries = ((await r.json()) as { entries: Array<{ domain_value?: string; domain_count?: number; domain_note?: string; description: string }> }).entries;

    const grouped = entries.filter((e) => e.domain_value === "600519");
    assert.equal(grouped.length, 1, `同标的应折叠为一条，实际 ${grouped.length}`);
    assert.equal(grouped[0].domain_count, 3, "展开前必须知道有几条");
    assert.ok(grouped[0].domain_note, "必须说明还有多少条未逐条展开");

    // A value with a single page is NOT collapsed — collapsing a group of one
    // would just add noise.
    const single = entries.filter((e) => e.domain_value === "000001");
    assert.equal(single.length, 1);
    assert.equal(single[0].domain_count, undefined, "单条不标注条数");
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
