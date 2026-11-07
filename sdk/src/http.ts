// ── 出站 fetch 超时纪律（自 paas/lib/fetch-with-timeout.js 下放） ────────────
//
// SDK 对内核（fd-memory）的每一次出站调用都有界：fetchWithTimeout() 以默认
// 死线（环境 PLATFORM_FETCH_TIMEOUT_MS，10s）包住 fetch，任何调用点可按次
// 覆盖。死线到点以结构化 FetchTimeoutError（code "FETCH_TIMEOUT"）失败，绝
// 不悬挂。死线覆盖到「响应头到达」为止；之后的正文流式不在此约束内（内核
// /digest 等面都是一次性 JSON，不涉及长流）。
//
// SDK 纪律：零运行时依赖——本模块只用 Node 内置的全局 fetch / AbortController。

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const TIMEOUT_ENV_KEY = "PLATFORM_FETCH_TIMEOUT_MS";

/** 环境对象形状（process.env 的结构子集，便于测试注入）。 */
export type EnvLike = Record<string, string | undefined>;

/** 响应的最小结构面：SDK 各面只用 ok/status/json。 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

/** 出站请求 init 的最小面。 */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * 可注入的 fetch 缝（测试缝）：签名比全局 fetch 窄，全局 fetch 天然可赋值。
 * 参照 paas 各面的做法——fetchImpl 永远作为参数保留。
 */
export type FetchLike = (input: string | URL, init?: FetchInitLike) => Promise<FetchResponseLike>;

// 生效死线在调用时读取（而非模块加载时），测试与一次性脚本可经 env 重调。
export function platformFetchTimeoutMs(env: EnvLike = process.env): number {
  const raw = Number(env[TIMEOUT_ENV_KEY]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
}

export class FetchTimeoutError extends Error {
  constructor(timeoutMs: number, url?: string) {
    super(`outbound fetch timed out after ${timeoutMs}ms${url ? `: ${url}` : ""}`);
    this.name = "FetchTimeoutError";
    this.code = "FETCH_TIMEOUT";
    this.retryable = true;
    this.timeoutMs = timeoutMs;
  }
  code: string;
  retryable: boolean;
  timeoutMs: number;
}

// 合成调用方 signal 与死线 signal，让两者都能取消：调用方中止保留自身原因
// （AbortError），死线到点把 FetchTimeoutError 作为中止原因带上。
// AbortSignal.any 自 Node 20.3 起可用；监听器兜底覆盖更老运行时。
function composeSignals(caller: AbortSignal | undefined, deadline: AbortController): AbortSignal {
  if (!caller) return deadline.signal;
  if (caller.aborted) return caller;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline.signal]);
  const composed = new AbortController();
  const relay = (from: AbortSignal) => () => composed.abort(from.reason);
  caller.addEventListener("abort", relay(caller), { once: true });
  deadline.signal.addEventListener("abort", relay(deadline.signal), { once: true });
  return composed.signal;
}

// 共享包装。opts.timeoutMs 按调用点覆盖 env 默认；opts.fetchImpl 穿插模块注入
// 的 fetch 缝（可测性）；opts.env 从非 process 环境对象读默认值。拒绝原样
// 上抛，唯一例外：死线到点以 FetchTimeoutError 拒绝——中止原因随 signal 走，
// 尊重 init.signal 的注入式 fetch 自然会把它暴露出来。
export function fetchWithTimeout(
  input: string | URL,
  init: FetchInitLike = {},
  opts: { timeoutMs?: number; fetchImpl?: FetchLike; env?: EnvLike } = {},
): Promise<FetchResponseLike> {
  const impl = opts.fetchImpl ?? (fetch as FetchLike);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0
    ? opts.timeoutMs!
    : platformFetchTimeoutMs(opts.env);
  // 旗舰原样：URL 对象上没有 .url 字段，错误消息里的地址回退为空串。
  const url = typeof input === "string" ? input : ((input as any)?.url ?? "");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new FetchTimeoutError(timeoutMs, url)), timeoutMs);
  let promise: Promise<FetchResponseLike>;
  try {
    promise = Promise.resolve(
      impl(input, { ...init, signal: composeSignals(init.signal, deadline) }),
    );
  } catch (err) {
    // 同步抛出的 impl（坏 mock、非法请求形状）不能泄漏挂起的定时器。
    clearTimeout(timer);
    throw err;
  }
  // 死线只覆盖「等响应头」；promise 落定后定时器即撤，正文自由流动。
  return promise.finally(() => clearTimeout(timer));
}
