// ── /observe 客户端（新写，design D6） ───────────────────────────────────────
//
// 面向内核 POST /observe（design D3 schema）的客户端：幂等键调用方生成（缺
// 省自动 crypto.randomUUID()），重复投递由内核按 (namespace, idempotency_key)
// 幂等。上报纪律与捕获契约对齐：fire-and-forget、失败即丢、无重试、有界超
// 时——observe 永不阻塞、永不弄破宿主回合。
//
// 事件类型是内核侧的封闭集（turn_outcome / tool_call / health_flip）：客户端
// 类型上收窄、运行时透传，4xx {error, code} 即封闭集/护栏的权威裁决。

import { randomUUID } from "node:crypto";
import { fetchWithTimeout, FetchLike, EnvLike } from "./http.js";

/** /observe 的封闭事件集（内核侧权威；运行时透传，4xx 即裁决）。 */
export type ObserveEventType = "turn_outcome" | "tool_call" | "health_flip";

export interface ObserveInput {
  /** 永忆内核基址（尾部斜杠容忍）。 */
  url: string;
  /** person 或 deployment 令牌。 */
  token: string;
  type: ObserveEventType;
  title: string;
  body: string;
  /** 幂等键；缺省自动 crypto.randomUUID()。 */
  idempotencyKey?: string;
  /** 成员/agent 标识（可选）。 */
  subject?: string;
  /** ISO8601；缺省=服务端时钟。 */
  ts?: string;
  /** 来源标注（跨 harness 合流，design D5）。 */
  harness?: string;
  metadata?: Record<string, unknown>;
  /** 有界超时（毫秒）；缺省 10s（PLATFORM_FETCH_TIMEOUT_MS 语义）。 */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  env?: EnvLike;
}

export interface ObserveOutcome {
  delivered: boolean;
  status?: number;
  page?: any;
  truncated?: boolean;
  error?: string;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

function observeBase(input: ObserveInput): string {
  return `${input.url.replace(/\/+$/, "")}/observe`;
}

function observePayload(input: ObserveInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: input.type,
    idempotency_key: input.idempotencyKey ?? newIdempotencyKey(),
    title: input.title,
    body: input.body,
  };
  if (input.subject != null) payload.subject = input.subject;
  if (input.ts != null) payload.ts = input.ts;
  if (input.harness != null) payload.harness = input.harness;
  if (input.metadata != null) payload.metadata = input.metadata;
  return payload;
}

// 单次投递：校验-POST-返回，无排队。任何失败（网络/超时/4xx/5xx）都折算成
// { delivered: false, ... } 返回，绝不向调用方抛错——要原始结果用本函数，
// 要「丢了就丢了」用 observeFireAndForget。
export async function observeOnce(input: ObserveInput): Promise<ObserveOutcome> {
  try {
    const r = await fetchWithTimeout(observeBase(input), {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify(observePayload(input)),
    }, { fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs, env: input.env });
    if (!r.ok) {
      let error = `observe HTTP ${r.status}`;
      try {
        const doc = await r.json();
        if (doc?.error) error = String(doc.error);
      } catch { /* 非法错误体保留 HTTP 状态文本 */ }
      return { delivered: false, status: r.status, error };
    }
    const doc = await r.json();
    return { delivered: true, status: r.status, page: doc?.page, truncated: doc?.truncated === true };
  } catch (e: any) {
    return { delivered: false, error: String(e?.message || e) };
  }
}

// fire-and-forget：挂上即走，失败即丢（永不产生 unhandled rejection）。
// hook 转发器等「绝不能阻塞宿主」的车道用本函数。
export function observeFireAndForget(input: ObserveInput): void {
  void observeOnce(input).catch(() => {
    // 双保险：observeOnce 已不抛；这里兜住未来重构引入的意外，保持「失败即丢」。
  });
}
