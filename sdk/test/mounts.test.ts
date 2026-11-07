// mounts.test —— 挂载行与命名空间坐标：与 paas agent-runner/memory-mount.js
// 逐字节同源（adopt-yongyi-client-sdk 任务 0.1 的移植验收）。纯 builder 测试，
// 无网络无临时目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memoryNamespaceFor,
  podMemoryNamespace,
  dshMemoryMount,
  acpMemoryMount,
} from "../src/mounts.js";

test("memoryNamespaceFor: agentId 是坐标，name 只是回退", () => {
  assert.equal(
    memoryNamespaceFor({ metadata: { packId: "pk", agentId: "a1" }, name: "显示名" }),
    "d/pk/a1",
  );
  assert.equal(memoryNamespaceFor({ metadata: { packId: "pk" }, name: "旧名" }), "d/pk/旧名");
});

test("memoryNamespaceFor: 缺 packId 或 agentId 都返回 null", () => {
  assert.equal(memoryNamespaceFor({ metadata: { agentId: "a1" }, name: "x" }), null);
  assert.equal(memoryNamespaceFor({ metadata: {}, name: "x" }), null);
  assert.equal(memoryNamespaceFor(null), null);
  assert.equal(memoryNamespaceFor({}), null);
});

test("podMemoryNamespace: 两段形状，空值 null", () => {
  assert.equal(podMemoryNamespace("pk"), "d/pk");
  assert.equal(podMemoryNamespace(""), null);
  assert.equal(podMemoryNamespace(undefined), null);
});

test("dshMemoryMount: Harness loader 行，headers 对象形状，无 token 时零 headers 键", () => {
  assert.deepEqual(dshMemoryMount("http://m:49375", "tok"), {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client", // leak-check:allow 公开 npm 包名
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: "http://m:49375",
      headers: { Authorization: "Bearer tok" },
    },
  });
  const bare = dshMemoryMount("http://m:49375", undefined) as { config: Record<string, unknown> };
  assert.equal("headers" in bare.config, false, "no token → no headers key at all");
});

test("acpMemoryMount: ACP wire 行，headers 是 ARRAY of {name,value}，无 token 时空数组", () => {
  assert.deepEqual(acpMemoryMount("http://m:49375", "tok"), {
    type: "http",
    name: "fd-memory",
    url: "http://m:49375",
    headers: [{ name: "Authorization", value: "Bearer tok" }],
  });
  assert.deepEqual((acpMemoryMount("http://m:49375", null) as { headers: unknown[] }).headers, []);
});
