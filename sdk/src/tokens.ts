// ── 永忆挂载客户端：令牌铸造与缓存（自 paas/cell-memory.js 下放） ────────────
//
// 平台缝：CELL_MEMORY_ENABLED=1 且平台令牌与永忆 URL 配齐时，person 令牌
// 按 owner 首次铸造并缓存到数据根磁盘下——每个用户只铸一次，重启稳定。
//
// 契约（fail-open 面与 fail-loud 面的分界）：铸造/URL 缺失/磁盘等任何失败，
// 组合层（cellMemoryMount）返回 null、落点与「记忆关闭」基线逐字节一致；
// 但令牌函数本身（personTokenFor/memberTokenFor）把铸造失败原样抛给调用方
// 计数处理——绝不静默假装成功。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { MEMORY_DISCIPLINE } from "./discipline.js";
import { fetchWithTimeout, FetchLike, EnvLike } from "./http.js";

export { MEMORY_DISCIPLINE };

/** 永忆内核连接三元组（cellMemoryConfig 的产物）。 */
export interface CellMemoryConfig {
  url: string;
  platformToken: string;
  dataRoot: string;
}

// 开关四件套：ENABLED=1 + URL + 平台令牌 + 数据根，缺一即整体关闭（返回
// null，上层按「记忆不存在」处理）。
export function cellMemoryConfig(env: EnvLike = process.env): CellMemoryConfig | null {
  const enabled = env.CELL_MEMORY_ENABLED === "1";
  const url = String(env.CELL_MEMORY_URL || "").replace(/\/+$/, "");
  const platformToken = String(env.CELL_MEMORY_PLATFORM_TOKEN || "");
  const dataRoot = String(env.CELL_MEMORY_DATA || "");
  return enabled && url && platformToken && dataRoot ? { url, platformToken, dataRoot } : null;
}

function cachePath(dataRoot: string, ownerEmail: string): string {
  const safe = String(ownerEmail || "unknown").replace(/[^a-zA-Z0-9@._-]/g, "_");
  return join(dataRoot, "cell-memory-tokens", `${safe}.json`);
}

// 铸造 person（u/）令牌：磁盘缓存优先（namespace 校验后复用），未命中才打
// /admin/mint；写盘 0600。铸造失败抛错——计数处理归调用方。
export async function personTokenFor(
  cfg: CellMemoryConfig,
  ownerEmail: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<string> {
  const p = cachePath(cfg.dataRoot, ownerEmail);
  try {
    const cached = JSON.parse(readFileSync(p, "utf8"));
    if (cached?.token && cached?.namespace === `u/${ownerEmail}`) return cached.token;
  } catch { /* 未命中 → 铸造 */ }
  // 出站纪律：令牌铸造走共享死线包装（默认 env 界）；fetchImpl 保持测试缝。
  const res = await fetchWithTimeout(`${cfg.url}/admin/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.platformToken}` },
    body: JSON.stringify({ namespace: `u/${ownerEmail}`, label: `cell:${ownerEmail}` }),
  }, { fetchImpl });
  if (!res.ok) throw new Error(`person mint HTTP ${res.status}`);
  const { token } = await res.json();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token, namespace: `u/${ownerEmail}`, mintedAt: new Date().toISOString() }), { mode: 0o600 });
  return token;
}

// dsh-mcp-client 的加载行（http 分支），mcpEntry 形状逐字段保留。
export function memoryMcpEntry(url: string, token: string) {
  return {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

// 组合助手：返回 { mcpEntry, discipline } 或 null（fail-open）。任何失败都
// 不改变调用方的落点——与「记忆关闭」基线逐字节一致。
export async function cellMemoryMount(
  env: EnvLike,
  ownerEmail: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<{ mcpEntry: ReturnType<typeof memoryMcpEntry>; discipline: string } | null> {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    return { mcpEntry: memoryMcpEntry(cfg.url, token), discipline: MEMORY_DISCIPLINE };
  } catch (e: any) {
    console.warn(`[cell-memory] mount skipped (fail-open): ${e?.message || e}`);
    return null;
  }
}

// ── Deployment 成员令牌（自 paas/cell-memory.js 下放） ───────────────────────
//
// 平台缝为每个成员铸一枚 deployment 令牌（d/<packId>/<memberId>，在 fd-memory
// 侧绑 owner 作为督导锚点），缓存到 cell 数据根——每成员只铸一次、重启稳定、
// 0600。令牌属于「岗位」而不属于背后的模型实例：换防保留缓存，新上岗模型
// 继承旧岗写下的分区。fail-open 同 person 面契约：铸造失败 = 计数 + 把错误
// 抛给调用方，绝不弄破回合。

export function memberCachePath(dataRoot: string, packId: string, memberId: string): string {
  const safe = (s: string) => String(s ?? "x").replace(/[^a-zA-Z0-9@._-]/g, "_");
  return join(dataRoot, "cell-memory-tokens", `d-${safe(packId)}-${safe(memberId)}.json`);
}

export interface MemberTokenInput {
  packId: string;
  memberId: string;
  ownerEmail?: string;
}

export async function memberTokenFor(
  cfg: CellMemoryConfig,
  { packId, memberId, ownerEmail }: MemberTokenInput,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<string> {
  const p = memberCachePath(cfg.dataRoot, packId, memberId);
  const namespace = `d/${packId}/${memberId}`;
  try {
    const cached = JSON.parse(readFileSync(p, "utf8"));
    if (cached?.token && cached?.namespace === namespace) return cached.token;
  } catch { /* 未命中 → 铸造 */ }
  if (!ownerEmail) throw new Error("member mint requires ownerEmail (the oversight anchor)");
  const res = await fetchWithTimeout(`${cfg.url}/admin/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.platformToken}` },
    body: JSON.stringify({ namespace, owner: `u/${ownerEmail}`, label: `member:${packId}:${memberId}` }),
  }, { fetchImpl });
  if (!res.ok) throw new Error(`member mint HTTP ${res.status}`);
  const { token } = await res.json();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token, namespace, owner: ownerEmail, mintedAt: new Date().toISOString() }), { mode: 0o600 });
  return token;
}
