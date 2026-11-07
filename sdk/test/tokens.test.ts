// 令牌铸造与缓存单测：一次铸造、磁盘缓存 0600、重启稳定、namespace 校验、
// 失败抛给调用方。全部 mock fetch，无网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellMemoryConfig,
  cellMemoryMount,
  personTokenFor,
  memberTokenFor,
  memberCachePath,
  memoryMcpEntry,
  MEMORY_DISCIPLINE,
} from "../src/tokens.js";
import { tmpData, baseEnv, mintRoutesMinder } from "./helpers.js";
import { rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = "owner@test.local";

test("person 令牌：铸造一次，磁盘缓存命中后零第二次铸造调用", async () => {
  const data = tmpData();
  try {
    const minder = mintRoutesMinder();
    const cfg = cellMemoryConfig(baseEnv(data))!;
    const t1 = await personTokenFor(cfg, OWNER, minder.impl);
    assert.equal(t1, "tok-u/owner@test.local");
    assert.equal(minder.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1);
    // 重启 = 无进程态，函数无状态；同 owner 再取必须命中磁盘缓存
    const t2 = await personTokenFor(cfg, OWNER, minder.impl);
    assert.equal(t2, t1);
    assert.equal(minder.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1, "零第二次铸造");
    // 缓存文件形状
    const file = join(data, "cell-memory-tokens", `${OWNER}.json`);
    assert.ok(existsSync(file));
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.token, t1);
    assert.equal(doc.namespace, `u/${OWNER}`);
    assert.ok(doc.mintedAt);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("person 令牌：缓存文件权限 0600", async () => {
  const data = tmpData();
  try {
    const minder = mintRoutesMinder();
    const cfg = cellMemoryConfig(baseEnv(data))!;
    await personTokenFor(cfg, OWNER, minder.impl);
    const file = join(data, "cell-memory-tokens", `${OWNER}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600, "0600：磁盘上的令牌只归属主");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("person 令牌：namespace 校验后复用——错 namespace 的旧缓存触发重铸", async () => {
  const data = tmpData();
  try {
    const dir = join(data, "cell-memory-tokens");
    mkdirSync(dir, { recursive: true });
    // 命中：token + 正确 namespace → 不铸
    writeFileSync(join(dir, `${OWNER}.json`), JSON.stringify({ token: "fdm_cached", namespace: `u/${OWNER}`, mintedAt: "2026-10-22T00:00:00.000Z" }), { mode: 0o600 });
    const minder1 = mintRoutesMinder();
    assert.equal(await personTokenFor(cellMemoryConfig(baseEnv(data))!, OWNER, minder1.impl), "fdm_cached");
    assert.equal(minder1.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 0, "缓存命中零铸造");
    // 错 namespace（身份换了）→ 重铸
    writeFileSync(join(dir, `${OWNER}.json`), JSON.stringify({ token: "stale", namespace: "u/someone-else" }), { mode: 0o600 });
    const minder2 = mintRoutesMinder();
    assert.equal(await personTokenFor(cellMemoryConfig(baseEnv(data))!, OWNER, minder2.impl), "tok-u/owner@test.local");
    assert.equal(minder2.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1, "namespace 不匹配 → 重铸");
    // 坏 JSON → 重铸
    writeFileSync(join(dir, `${OWNER}.json`), "not-json{", { mode: 0o600 });
    const minder3 = mintRoutesMinder();
    await personTokenFor(cellMemoryConfig(baseEnv(data))!, OWNER, minder3.impl);
    assert.equal(minder3.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("person 令牌：铸造失败原样抛出（绝不静默假装成功），失败不留半截缓存", async () => {
  const data = tmpData();
  try {
    const broken = mintRoutesMinder({ mintStatus: 500 });
    await assert.rejects(
      () => personTokenFor(cellMemoryConfig(baseEnv(data))!, OWNER, broken.impl),
      /person mint HTTP 500/,
    );
    assert.equal(existsSync(join(data, "cell-memory-tokens", `${OWNER}.json`)), false, "无落盘");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("person 令牌：铸造请求形状——namespace u/、label cell:、平台令牌Bearer", async () => {
  const data = tmpData();
  try {
    const minder = mintRoutesMinder();
    await personTokenFor(cellMemoryConfig(baseEnv(data))!, OWNER, minder.impl);
    const mint = minder.calls.find((c) => c.url.endsWith("/admin/mint"))!;
    assert.equal(mint.url, "http://memory.test/admin/mint");
    assert.equal(mint.headers?.authorization, "Bearer plat");
    assert.equal(mint.headers?.["content-type"], "application/json");
    assert.deepEqual(JSON.parse(mint.body!), { namespace: `u/${OWNER}`, label: `cell:${OWNER}` });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("deployment 令牌：d/<pack>/<member> 铸造、缓存 0600、重启稳定零重铸", async () => {
  const data = tmpData();
  try {
    const minder = mintRoutesMinder();
    const cfg = cellMemoryConfig(baseEnv(data))!;
    const t1 = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "writer-a", ownerEmail: OWNER }, minder.impl);
    assert.equal(t1, "tok-d/fleet-9/writer-a");
    const file = memberCachePath(data, "fleet-9", "writer-a");
    assert.ok(existsSync(file));
    assert.equal(file, join(data, "cell-memory-tokens", "d-fleet-9-writer-a.json"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.namespace, "d/fleet-9/writer-a");
    assert.equal(doc.owner, OWNER, "owner 绑定（督导锚点）");
    // 重启稳定：再取零第二次铸造
    const t2 = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "writer-a", ownerEmail: OWNER }, minder.impl);
    assert.equal(t2, t1);
    assert.equal(minder.calls.filter((c) => c.url.endsWith("/admin/mint")).length, 1);
    // 危险字符净化
    assert.equal(memberCachePath(data, "a/b", "c\\d"), join(data, "cell-memory-tokens", "d-a_b-c_d.json"), "危险字符净化为下划线");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("deployment 令牌：无 ownerEmail 抛锚点错误；铸造失败抛出", async () => {
  const data = tmpData();
  try {
    const cfg = cellMemoryConfig(baseEnv(data))!;
    await assert.rejects(
      () => memberTokenFor(cfg, { packId: "p", memberId: "m" }, mintRoutesMinder().impl),
      /member mint requires ownerEmail \(the oversight anchor\)/,
    );
    const broken = mintRoutesMinder({ mintStatus: 503 });
    await assert.rejects(
      () => memberTokenFor(cfg, { packId: "p", memberId: "m", ownerEmail: OWNER }, broken.impl),
      /member mint HTTP 503/,
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("cellMemoryConfig：四件套缺一即关；URL 去尾斜杠", () => {
  assert.equal(cellMemoryConfig({}), null);
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1" }), null);
  assert.equal(
    cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://x/", CELL_MEMORY_PLATFORM_TOKEN: "p" }),
    null,
    "缺 dataRoot",
  );
  assert.deepEqual(cellMemoryConfig(baseEnv("/data", "http://x/")), {
    url: "http://x",
    platformToken: "plat",
    dataRoot: "/data",
  });
  assert.equal(cellMemoryConfig(baseEnv("/data"))!.url, "http://memory.test", "尾斜杠剥离");
});

test("memoryMcpEntry：Harness 加载行逐字段（http 分支 verbatim）", () => {
  const row = memoryMcpEntry("http://memory.test", "tok");
  assert.deepEqual(row, {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client", // leak-check:allow 公开 npm 包名
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: "http://memory.test/mcp",
      headers: { Authorization: "Bearer tok" },
    },
  });
});

test("cellMemoryMount：成功 = mcpEntry + 同一份纪律文本；失败 fail-open 为 null", async () => {
  const data = tmpData();
  try {
    const minder = mintRoutesMinder();
    const mount = await cellMemoryMount(baseEnv(data), OWNER, minder.impl);
    assert.ok(mount);
    assert.equal(mount!.mcpEntry.id, "mcp-fd-memory");
    assert.equal(mount!.discipline, MEMORY_DISCIPLINE, "纪律文本同源，不是副本");
    assert.equal(await cellMemoryMount({ CELL_MEMORY_ENABLED: "0" }, OWNER), null, "配置关 → null");
    const broken = mintRoutesMinder({ mintStatus: 500 });
    const otherOwner = `broken-${Date.now()}@t.local`;
    assert.equal(await cellMemoryMount(baseEnv(data), otherOwner, broken.impl), null, "铸造失败 fail-open");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
