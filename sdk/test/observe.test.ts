// /observe 客户端单测：幂等键生成与透传、payload 形状、202/4xx、失败即丢、
// 有界超时。全部 mock fetch，无网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import { observeOnce, observeFireAndForget, newIdempotencyKey } from "../src/observe.js";
import { res, hangingFetch, RecordedCall } from "./helpers.js";
import type { FetchResponseLike, FetchInitLike } from "../src/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function recorder(handler: (u: string, init: FetchInitLike) => FetchResponseLike | Promise<FetchResponseLike>) {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL, init: FetchInitLike = {}): Promise<FetchResponseLike> => {
    calls.push({ url: String(input), method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    return await Promise.resolve(handler(String(input), init));
  };
  return { calls, impl };
}

const BASE = { url: "http://memory.test", token: "tok-u/x", type: "turn_outcome" as const, title: "回合", body: "完成 X" };

test("observe：缺省自动生成 UUIDv4 幂等键；payload 恰含四键；Bearer 头", async () => {
  const { calls, impl } = recorder(() => res(true, 202, { page: { path: "p" } }));
  const out = await observeOnce({ ...BASE, fetchImpl: impl });
  assert.equal(out.delivered, true);
  assert.equal(out.status, 202);
  assert.deepEqual(out.page, { path: "p" });
  const call = calls[0];
  assert.equal(call.url, "http://memory.test/observe");
  assert.equal(call.method, "POST");
  assert.equal(call.headers?.authorization, "Bearer tok-u/x");
  assert.equal(call.headers?.["content-type"], "application/json");
  const payload = JSON.parse(call.body!);
  assert.equal(Object.keys(payload).length, 4);
  assert.equal(payload.type, "turn_outcome");
  assert.equal(payload.title, "回合");
  assert.equal(payload.body, "完成 X");
  assert.match(String(payload.idempotency_key), UUID_RE, "幂等键自动 crypto.randomUUID()");
});

test("observe：显式幂等键透传；可选字段 subject/ts/harness/metadata 透传", async () => {
  const { calls, impl } = recorder(() => res(true, 202, { page: { path: "p" }, truncated: true }));
  const out = await observeOnce({
    ...BASE,
    idempotencyKey: "my-key-1",
    subject: "writer-a",
    ts: "2026-11-07T00:00:00.000Z",
    harness: "claude-code",
    metadata: { exit: 0 },
    fetchImpl: impl,
  });
  assert.equal(out.delivered, true);
  assert.equal(out.truncated, true, "32KB 截断指示透传");
  const payload = JSON.parse(calls[0].body!);
  assert.equal(payload.idempotency_key, "my-key-1");
  assert.equal(payload.subject, "writer-a");
  assert.equal(payload.ts, "2026-11-07T00:00:00.000Z");
  assert.equal(payload.harness, "claude-code");
  assert.deepEqual(payload.metadata, { exit: 0 });
});

test("observe：4xx {error, code} → delivered=false，错误文本取自响应体", async () => {
  const { impl } = recorder(() => res(false, 422, { error: "unknown observe type", code: "OBSERVE_TYPE" }));
  const out = await observeOnce({ ...BASE, type: "nonsense" as any, fetchImpl: impl });
  assert.equal(out.delivered, false);
  assert.equal(out.status, 422);
  assert.equal(out.error, "unknown observe type");
});

test("observe：网络失败折算为 delivered=false，绝不抛错", async () => {
  const boom = async () => {
    throw new TypeError("fetch failed");
  };
  const out = await observeOnce({ ...BASE, fetchImpl: boom });
  assert.equal(out.delivered, false);
  assert.match(String(out.error), /fetch failed/);
});

test("observe：有界超时——死线到点 delivered=false（FetchTimeoutError 语义）", async () => {
  const started = Date.now();
  const out = await observeOnce({ ...BASE, timeoutMs: 80, fetchImpl: hangingFetch().impl });
  assert.equal(out.delivered, false);
  assert.match(String(out.error), /outbound fetch timed out after 80ms/);
  assert.ok(Date.now() - started < 3000, "有界：不悬挂");
});

test("observe：url 尾斜杠归一，不产生双斜杠", async () => {
  const { calls, impl } = recorder(() => res(true, 202, { page: {} }));
  await observeOnce({ ...BASE, url: "http://memory.test/", fetchImpl: impl });
  assert.equal(calls[0].url, "http://memory.test/observe");
});

test("observeFireAndForget：失败即丢——不抛、零 unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    observeFireAndForget({
      ...BASE,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    observeFireAndForget({
      ...BASE,
      timeoutMs: 50,
      fetchImpl: hangingFetch().impl,
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(rejections.length, 0, "fire-and-forget 永不产生未处理拒绝");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("observeFireAndForget：成功路径照常投递（只是不等人）", async () => {
  let delivered = 0;
  const impl = async () => {
    delivered += 1;
    return res(true, 202, { page: {} });
  };
  observeFireAndForget({ ...BASE, fetchImpl: impl });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(delivered, 1);
});

test("newIdempotencyKey：UUIDv4 形状、每次唯一", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.match(a, UUID_RE);
  assert.match(b, UUID_RE);
  assert.notEqual(a, b);
});
