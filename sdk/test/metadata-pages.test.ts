// 带 metadata 的写 / 按 metadata 的读（establish-agent-role-and-fitness-plane
// 6.2 / 6.3 / 7.2 / 7.3 的客户端前提）。
//
// 为什么这条链能绕开「新增 type 车道」：fd-memory 的写面 enum 是 2026-11-15
// 特意收窄的（20+ 自造车道被拒），但它同时明写「Categories go in metadata」，
// 且 `GET /pages` 早已支持 `meta=key:value` 过滤。所以观测与胜任力不是新档位，
// 是 note 页上的一个 metadata 键。
//
// 三项断言各自能红：
//   1. 不传 opts ⇒ 请求体逐字节与改前相同（既有调用方零迁移）
//   2. 传 opts ⇒ metadata / supersedes 进请求体
//   3. readPages 的 query 与服务端 filterParamsOf 同规（数组值 JSON 编码）

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClusterMemoryClient } from "../src/ladder.js";

/** 记录最后一次请求的假 fetch。 */
function recordingFetch(status = 200, payload: unknown = { ok: true }) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const impl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  return { calls, impl };
}

const mk = (impl: unknown) =>
  createClusterMemoryClient({ url: "http://mem.example", token: "t", fetchImpl: impl as never });

test("不传 opts ⇒ 请求体与改前逐字节相同（零迁移）", async () => {
  const { calls, impl } = recordingFetch();
  await mk(impl).writeDigest("proj", "标题", "正文");
  const body = JSON.parse(calls[0].init!.body!);
  assert.deepEqual(body, { project: "proj", title: "标题", body: "正文" });
  assert.deepEqual(Object.keys(body), ["project", "title", "body"], "键集合也必须一样");
});

test("传 metadata / supersedes ⇒ 进请求体，其余字段不变", async () => {
  const { calls, impl } = recordingFetch();
  await mk(impl).writeDigest("p", "t", "b", { metadata: { kind: "observation", surface: "fd-info" }, supersedes: ["abc123"] });
  const body = JSON.parse(calls[0].init!.body!);
  assert.deepEqual(body.metadata, { kind: "observation", surface: "fd-info" });
  assert.deepEqual(body.supersedes, ["abc123"]);
  assert.equal(body.project, "p");
});

test("空 metadata / 空 supersedes ⇒ 不写这两个键（与不传等价）", async () => {
  const { calls, impl } = recordingFetch();
  await mk(impl).writeDigest("p", "t", "b", { metadata: {}, supersedes: [] });
  const body = JSON.parse(calls[0].init!.body!);
  assert.deepEqual(Object.keys(body), ["project", "title", "body"]);
});

test("readPages 把 metadata 拼成 meta=key:value（字符串原样，非字符串 JSON 编码）", async () => {
  const { calls, impl } = recordingFetch(200, { pages: [{ title: "x" }] });
  const pages = await mk(impl).readPages({
    project: "p",
    limit: 5,
    metadata: { kind: "observation", tags: ["a", "b"], n: 3 },
  });
  assert.deepEqual(pages, [{ title: "x" }]);
  const qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get("project"), "p");
  assert.equal(qs.get("limit"), "5");
  const metas = qs.getAll("meta");
  assert.ok(metas.includes("kind:observation"), "字符串值原样");
  assert.ok(metas.includes('tags:["a","b"]'), "数组值 JSON 编码（服务端 JSON 解析后取 contains）");
  assert.ok(metas.includes("n:3"), "数字 JSON 编码");
});

test("readPages：空 filter ⇒ 不带任何 meta 参数（等价于旧行为）", async () => {
  const { calls, impl } = recordingFetch(200, { pages: [] });
  await mk(impl).readPages();
  const qs = new URL(calls[0].url).searchParams;
  assert.deepEqual(qs.getAll("meta"), []);
  assert.equal(qs.toString(), "");
});

test("readPages：undefined / null 值被跳过（不产出 meta=key:undefined）", async () => {
  const { calls, impl } = recordingFetch(200, { pages: [] });
  await mk(impl).readPages({ metadata: { a: undefined, b: null, c: "keep" } });
  const metas = new URL(calls[0].url).searchParams.getAll("meta");
  assert.deepEqual(metas, ["c:keep"]);
});

test("非 2xx ⇒ 抛错（与 writeDigest 同一纪律，不静默返回空）", async () => {
  const { impl } = recordingFetch(503, {});
  await assert.rejects(() => mk(impl).readPages(), /pages HTTP 503/);
});
