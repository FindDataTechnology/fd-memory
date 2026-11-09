// 测试助手：金样读取、临时目录、mock fetch 桩。无网络——所有出站调用都打
// 注入的 fetchImpl（localhost 也不用起）。

import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { FetchResponseLike, FetchInitLike } from "../src/http.js";

// 金样 fixture：由 paas 现役实现实跑产出（生成脚本一次性固化）。
// 编译产物位于 dist-test/test/，向仓库根回退两级即 sdk/。
export function golden(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "test", "goldens", name), "utf8");
}

export function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "yongyi-sdk-"));
}

export function baseEnv(data: string, url = "http://memory.test"): Record<string, string> {
  return {
    CELL_MEMORY_ENABLED: "1",
    CELL_MEMORY_URL: url,
    CELL_MEMORY_PLATFORM_TOKEN: "plat",
    CELL_MEMORY_DATA: data,
  };
}

export function res(ok: boolean, status: number, body: unknown): FetchResponseLike {
  return { ok, status, json: async () => body };
}

export interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

// 铸造 + /pages + /digest 的通用路由桩（记录每次调用）。
export function mintRoutesMinder(opts: {
  mintStatus?: number;
  digest?: (project: string, q: string, url: URL) => { status?: number; body: unknown };
  pages?: (project: string) => { status?: number; body: unknown };
  pagesPost?: (body: any) => { status?: number; body?: unknown };
} = {}) {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL, init: FetchInitLike = {}): Promise<FetchResponseLike> => {
    const u = String(input);
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    if (u.endsWith("/admin/mint")) {
      if ((opts.mintStatus ?? 200) !== 200) return res(false, opts.mintStatus!, {});
      const parsed = JSON.parse(init.body || "{}");
      return res(true, 200, { token: `tok-${parsed.namespace}`, id: "t1" });
    }
    if (u.includes("/digest")) {
      const uo = new URL(u);
      const d = opts.digest?.(uo.searchParams.get("project") || uo.searchParams.get("projects") || "", uo.searchParams.get("q") || "", uo) ?? { body: {} };
      return res(d.status == null || d.status === 200, d.status ?? 200, d.body);
    }
    if (u.includes("/pages")) {
      if (init.method === "POST") {
        const parsed = JSON.parse(init.body || "{}");
        const out = opts.pagesPost?.(parsed) ?? { body: { project: parsed.project, path: "x" } };
        return res((out.status ?? 200) === 200, out.status ?? 200, out.body ?? {});
      }
      const uo = new URL(u);
      const p = opts.pages?.(uo.searchParams.get("project") || "") ?? { body: { pages: [] } };
      return res(p.status == null || p.status === 200, p.status ?? 200, p.body);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, impl };
}

// 永不响应的 fetch：只在被中止时以中止原因拒绝（模拟真实 fetch 的信号语义）。
export function hangingFetch(): FetchLikeRecorder {
  const calls: RecordedCall[] = [];
  const impl = (input: string | URL, init: FetchInitLike = {}): Promise<FetchResponseLike> => {
    calls.push({ url: String(input), method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    });
  };
  return { calls, impl };
}

export interface FetchLikeRecorder {
  calls: RecordedCall[];
  impl: (input: string | URL, init?: FetchInitLike) => Promise<FetchResponseLike>;
}
