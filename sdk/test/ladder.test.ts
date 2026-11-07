// 注入阶梯单测：三级降级顺序、超时有界、缺席不抛错、金样逐字节。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryInjectionFor,
  chatMemoryInjectionFor,
  chatMemoryClientFor,
  chatPromptWithMemory,
  createClusterMemoryClient,
  clusterMemoryFor,
  clusterProjectId,
  digestTimeoutMs,
  digestLadder,
  CLUSTER_TITLES_LABEL,
  LadderMemory,
  MemoryPage,
  DigestDoc,
} from "../src/ladder.js";
import { platformFetchTimeoutMs, FetchTimeoutError } from "../src/http.js";
import { golden, tmpData, baseEnv, mintRoutesMinder, hangingFetch } from "./helpers.js";
import { rmSync } from "node:fs";
import { join } from "node:path";

// 阶梯用 mock 客户端（与 paas 测试同形）。
function ladderMemory(
  { digest = null, digestError = null, pages = [] as MemoryPage[], pagesError = null as Error | null } =
    { digest: null as DigestDoc | null, digestError: null as Error | null, pages: [] as MemoryPage[], pagesError: null as Error | null },
): LadderMemory {
  return {
    async readDigest() {
      if (digestError) throw digestError;
      return digest as DigestDoc;
    },
    async readShared() {
      if (pagesError) throw pagesError;
      return pages;
    },
  };
}

test("阶梯：digest 面胜出——渲染块逐字追加", async () => {
  const d = "## 记忆摘要 / Memory digest（fd-memory，截至 2026-10-25）\n\n### 相关记忆 / Related memory\n- 〔L2·experience｜置信 0.80｜2026-10-24〕集群巡检：先读 digest 再分派";
  const out = await memoryInjectionFor(ladderMemory({ digest: { digest: d } }), "c1", "本轮任务");
  assert.equal(out.source, "digest");
  assert.ok(out.prompt.startsWith("本轮任务\n\n## 记忆摘要"));
  assert.ok(!out.prompt.includes("【集群共享记忆】"), "digest 块自带服务端头，无遗留包装");
});

test("阶梯：digest 失败降级——与金样 cluster-titles-block.txt 逐字节一致", async () => {
  const pages = [
    { title: "集群回合 2026-10-24 08:00", updated_at: "2026-10-24T00:00:00.000Z" },
    { title: "集群回合 2026-10-23 08:00", updated_at: "2026-10-23T00:00:00.000Z" },
  ];
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "c1", "本轮任务");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, `本轮任务\n\n${golden("cluster-titles-block.txt")}`, "注入字节同源（fixture 由 paas 现役实现产出）");
  const block = await digestLadder(ladderMemory({ digestError: new Error("x"), pages }), "c1", "", {
    digestOn: true, k: 5, budget: 1500, titlesLabel: CLUSTER_TITLES_LABEL, warnTag: "cluster", warnName: "c1",
  });
  assert.equal(block.block, golden("cluster-titles-block.txt"), "块字节同源");
});

test("阶梯：两级皆失败——缺席告终，prompt 原样，不抛错", async () => {
  const out = await memoryInjectionFor(ladderMemory({ digestError: new Error("x"), pagesError: new Error("y") }), "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
  const block = await digestLadder(null, "c1", "", {
    digestOn: true, k: 5, budget: 1500, titlesLabel: CLUSTER_TITLES_LABEL, warnTag: "cluster", warnName: "c1",
  });
  assert.equal(block.block, "");
});

test("阶梯：服务整体不可达——空块 + 缺席来源标记，prompt 保持未注入形态", async () => {
  const unreachable: LadderMemory = {
    async readDigest() {
      throw new TypeError("fetch failed");
    },
    async readShared() {
      throw new TypeError("fetch failed");
    },
  };
  const out = await memoryInjectionFor(unreachable, "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务", "宿主 prompt 逐字节未注入形态");
});

test("阶梯：digest 超时——降级返回标题列表块（真客户端 + 有界死线）", async () => {
  const hang = hangingFetch();
  const pages = [{ title: "超时后仍有沉淀", updated_at: "2026-11-01T00:00:00.000Z" }];
  const router = async (input: string | URL, init?: any) => {
    if (String(input).includes("/digest")) return hang.impl(input, init);
    return mintRoutesMinder({ pages: () => ({ body: { pages } }) }).impl(input, init);
  };
  const client = createClusterMemoryClient({ url: "http://memory.test", token: "tok-u/x", fetchImpl: router, timeoutMs: 80 });
  const out = await memoryInjectionFor(client, "c1", "本轮任务", { k: 5, budget: 1500 });
  assert.equal(out.source, "titles", "digest 挂起 → 死线到点 → 降级 titles");
  assert.ok(out.prompt.includes("超时后仍有沉淀（2026-11-01）"));
  // 超时错误形状直证
  const hangClient = createClusterMemoryClient({ url: "http://memory.test", token: "t", fetchImpl: hangingFetch().impl, timeoutMs: 60 });
  await assert.rejects(() => hangClient.readDigest("c1", "q"), (e: any) => {
    // 客户端 readDigest 的死线是裸 controller.abort()——中止以 AbortError
    // 语义浮出（阶梯照单吞成缺席）；FetchTimeoutError 形状出自
    // fetchWithTimeout 面（见 observe 超时用例）。
    assert.match(String(e?.message || e), /[ab]borted|timed out/i);
    return true;
  });
});

test("阶梯：digestOn=false 跳过 digest 面（options 与 env 两路）", async () => {
  let digestCalls = 0;
  const mem: LadderMemory = {
    async readDigest() {
      digestCalls += 1;
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      return [{ title: "旧沉淀", updated_at: "2026-10-24T00:00:00.000Z" }];
    },
  };
  const viaOption = await memoryInjectionFor(mem, "c1", "任务", { digestOn: false });
  assert.equal(viaOption.source, "titles");
  const viaEnv = await memoryInjectionFor(mem, "c1", "任务", { env: { CELL_MEMORY_DIGEST: "0" } });
  assert.equal(viaEnv.source, "titles");
  assert.equal(digestCalls, 0, "回滚杆只跳 digest 级，titles 仍在");
});

test("阶梯：k/budget 默认 5/1500 随调用走；options/env 可覆盖", async () => {
  const seen: Array<{ q: string; k?: number; budget?: number }> = [];
  const mem: LadderMemory = {
    async readDigest(_p, q, opts) {
      seen.push({ q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      return [];
    },
  };
  const defaults = await memoryInjectionFor(mem, "c1", "任务A");
  assert.equal(defaults.source, "digest");
  assert.deepEqual(seen.at(-1), { q: "任务A", k: 5, budget: 1500 });
  await memoryInjectionFor(mem, "c1", "任务B", { k: 3, budget: 800 });
  assert.deepEqual(seen.at(-1), { q: "任务B", k: 3, budget: 800 });
  await memoryInjectionFor(mem, "c1", "任务C", { env: { CELL_MEMORY_DIGEST_K: "6", CELL_MEMORY_DIGEST_BUDGET: "1200" } });
  assert.deepEqual(seen.at(-1), { q: "任务C", k: 6, budget: 1200 });
});

test("阶梯：null 客户端——零调用、prompt 不动（开关关 = 逐字节基线）", async () => {
  const out = await memoryInjectionFor(null, "c1", "本轮任务");
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "本轮任务");
});

test("聊天车道：titles 金样（chat-titles-block.txt）", async () => {
  const pages = [{ title: "偏好：周报用中文", updated_at: "2026-10-24T00:00:00.000Z" }];
  const out = await chatMemoryInjectionFor(ladderMemory({ digestError: new Error("digest HTTP 503"), pages }), "继续");
  assert.equal(out.source, "titles");
  assert.equal(out.prompt, `继续\n\n${golden("chat-titles-block.txt")}`);
  assert.ok(!out.prompt.includes("集群"), "chat 级不带集群措辞");
});

test("聊天车道：CELL_MEMORY_CHAT_DIGEST=0 → prompt 逐字节不动、零调用（总开关）", async () => {
  let anyCall = 0;
  const mem: LadderMemory = {
    async readDigest() {
      anyCall += 1;
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      anyCall += 1;
      return [{ title: "旧沉淀", updated_at: "2026-10-24T00:00:00.000Z" }];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "原文照旧", { env: { CELL_MEMORY_CHAT_DIGEST: "0" } });
  assert.equal(out.source, "none");
  assert.equal(out.prompt, "原文照旧");
  assert.equal(anyCall, 0, "总开关：digest 与 titles 两面都不跑");
});

test("聊天车道：digest 目标项目固定 default", async () => {
  const seen: Array<{ project: string; q: string; k?: number; budget?: number }> = [];
  const mem: LadderMemory = {
    async readDigest(project, q, opts) {
      seen.push({ project, q, ...opts });
      return { digest: "## 记忆摘要" };
    },
    async readShared() {
      return [];
    },
  };
  const out = await chatMemoryInjectionFor(mem, "帮我继续昨天的事", { env: { CELL_MEMORY_DIGEST_K: "6", CELL_MEMORY_DIGEST_BUDGET: "1200" } });
  assert.equal(out.source, "digest");
  assert.deepEqual(seen, [{ project: "default", q: "帮我继续昨天的事", k: 6, budget: 1200 }]);
  assert.ok(out.prompt.startsWith("帮我继续昨天的事"), "注入只追加，不改写用户文本");
});

test("clusterProjectId：净化、路径安全、缺省（paas 用例移植）", () => {
  assert.equal(clusterProjectId("dyn_abc-1"), "dyn_abc-1");
  assert.equal(clusterProjectId("a/b\\c"), "a-b-c");
  assert.equal(clusterProjectId("  "), "cluster");
  assert.equal(clusterProjectId(null), "cluster");
});

test("digestTimeoutMs：默认 9000（高于 embed 预算帽 8000），env 读取并钳制", () => {
  assert.equal(digestTimeoutMs(), 9000);
  assert.equal(digestTimeoutMs({}), 9000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "abc" }), 9000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "7000" }), 7000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "100" }), 500, "下钳 500");
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "100000" }), 60000, "上钳 60000");
});

test("client：/digest URL 携带 project/q/k/budget；pages 面携带 project/limit", async () => {
  const minder = mintRoutesMinder({
    digest: (project, q) => ({ body: { digest: "D" } }),
    pages: (project) => ({ body: { pages: [{ title: "t", updated_at: "2026-11-01T00:00:00.000Z" }] } }),
  });
  const client = createClusterMemoryClient({ url: "http://memory.test", token: "tok-u/x", fetchImpl: minder.impl });
  const d = await client.readDigest("c1", "本轮任务", { k: 5, budget: 1500 });
  assert.equal(d.digest, "D");
  const pages = await client.readShared("c1");
  assert.equal(pages.length, 1);
  const digestUrl = new URL(minder.calls.find((c) => c.url.includes("/digest"))!.url);
  assert.equal(digestUrl.searchParams.get("project"), "c1");
  assert.equal(digestUrl.searchParams.get("q"), "本轮任务");
  assert.equal(digestUrl.searchParams.get("k"), "5");
  assert.equal(digestUrl.searchParams.get("budget"), "1500");
  const pagesUrl = new URL(minder.calls.find((c) => c.url.includes("/pages"))!.url);
  assert.equal(pagesUrl.searchParams.get("project"), "c1");
  assert.equal(pagesUrl.searchParams.get("limit"), "5");
  const auth = minder.calls[0].headers?.authorization;
  assert.equal(auth, "Bearer tok-u/x");
});

test("client：pages 读/写失败抛给调用方（阶梯在上面兜成缺席）", async () => {
  const failing = mintRoutesMinder({ pages: () => ({ status: 503, body: {} }), digest: () => ({ status: 503, body: {} }), pagesPost: () => ({ status: 503, body: {} }) });
  const client = createClusterMemoryClient({ url: "http://memory.test", token: "t", fetchImpl: failing.impl });
  await assert.rejects(() => client.readShared("c"), /pages HTTP 503/);
  await assert.rejects(() => client.readDigest("c", "q"), /digest HTTP 503/);
  await assert.rejects(() => client.writeDigest("c", "t", "b"), /pages HTTP 503/);
});

test("clusterMemoryFor：配置关 / 无 owner → null；铸造失败 → null（降级开放）", async () => {
  const data = tmpData();
  try {
    assert.equal(await clusterMemoryFor({ CELL_MEMORY_ENABLED: "0" }, "o@x"), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), null as any), null);
    assert.equal(await clusterMemoryFor(baseEnv(data), ""), null);
    const broken = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await clusterMemoryFor(baseEnv(data), "o@x", broken), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("chat 客户端：瞬时铸造失败重试（不黑到重启）；解析后进程内缓存", async () => {
  const data = tmpData();
  try {
    let mintOk = false;
    let mints = 0;
    const impl = async (input: string | URL, init: any = {}) => {
      const u = String(input);
      if (u.endsWith("/admin/mint")) {
        mints += 1;
        if (!mintOk) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ token: "fdm_ok", id: "t1" }) };
      }
      return mintRoutesMinder().impl(input, init);
    };
    const env = baseEnv(data);
    const email = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`;
    assert.equal(await chatMemoryClientFor(email, env, impl), null, "铸造 503 → 本回合 null");
    assert.equal(mints, 1);
    mintOk = true;
    const cm = await chatMemoryClientFor(email, env, impl);
    assert.ok(cm, "瞬时失败下一回合自愈");
    assert.equal(mints, 2);
    assert.equal(await chatMemoryClientFor(email, env, impl), cm, "解析后客户端按进程生命周期缓存");
    assert.equal(mints, 2, "解析后不再重铸");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("chat 接线：无身份或配置关 → prompt 原样、零 fetch", async () => {
  assert.equal(await chatPromptWithMemory(null, "原样"), "原样");
  const data = tmpData();
  try {
    const boom = async (u: string | URL) => {
      throw new Error(`unexpected fetch ${u}`);
    };
    const env = { ...baseEnv(data), CELL_MEMORY_ENABLED: "0" };
    const email = `off-${Date.now()}@t.local`;
    assert.equal(await chatPromptWithMemory(email, "原样", env, boom), "原样");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("出站死线默认 10s（PLATFORM_FETCH_TIMEOUT_MS 语义）", () => {
  assert.equal(platformFetchTimeoutMs(), 10000);
  assert.equal(platformFetchTimeoutMs({ PLATFORM_FETCH_TIMEOUT_MS: "2500" }), 2500);
  assert.equal(platformFetchTimeoutMs({ PLATFORM_FETCH_TIMEOUT_MS: "0" }), 10000);
});
