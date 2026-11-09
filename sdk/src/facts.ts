// ── 舰队工作记忆（自 paas/server/fleet-memory.js 下放） ──────────────────────
//
// 舰队（FLEET）工作记忆的 cell 侧车道。成员拆分后，事实落 DEPLOYMENT 命名
// 空间、用每成员的 deployment 令牌：
//   岗位私有 (turn / health)      → 成员自己的分区 d/<pack>/<member>
//   团队事实 (decision-* / swap) → 该队的共享分区（shared）
// 每页携带一等 metadata {fleetId, memberId, kind}（openspec: agent-memory-
// foundation）——标题重新只是人话，永不做机器寻址。遗留的 `f/<fleetId>`
// owner 项目停止收写；其页保持可读，过渡窗内 digest 仍会合成它们（自然衰减
// ——不再有新行落进去）。
//
// 降级开放是契约（spec: capture 失败 MUST NOT 阻塞回合，digest 缺席即段缺
// 席）：每个失败都是一个计数器，绝不把错误抛进回合。
//
// 五类事实（spec: fleet-turn-memory）：turn（经 outcome 的报数摘要）、health
// （ok↔failed 状态迁移翻转）、decision-opened、decision-resolved、swap。
// 幂等：进程内有界键集对 (fleetId, memberId, kind, ts) 重放去重；跨重启重放
// 是非目标（fire-and-forget 捕获）。

import { cellMemoryConfig, personTokenFor, memberTokenFor } from "./tokens.js";
import { digestTimeoutMs } from "./ladder.js";
import { fetchWithTimeout, FetchLike, EnvLike } from "./http.js";

export const CAPTURE_DEDUP_MAX = 512;

/** 封闭五类：五类之外没有第六种口径（映射刻意不可配置）。 */
export type FleetFactKind = "turn" | "health" | "decision-opened" | "decision-resolved" | "swap";

export type FactPartition = "own" | "shared";

// 封闭的 own/shared 拆分（spec：五类是封闭集——映射刻意不可配置；这里的第
// 四种意见就是第四种口径）。turn/health 是岗位的私有产出；决定与换防是全员
// 必须看见的团队事实。
export const KIND_PARTITION: Readonly<Record<FleetFactKind, FactPartition>> = {
  turn: "own",
  health: "own",
  "decision-opened": "shared",
  "decision-resolved": "shared",
  swap: "shared",
};

export function fleetProjectId(fleetId: unknown): string {
  const out = String(fleetId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out ? `f/${out}` : "f/unknown";
}

// d/ 根内成员自有分区的项目名：fd-memory 把 d/<packId>/<memberId> 解析为根
// "d-<packId>"、项目 "<memberId>"——线上的 project 就是 memberId（registry
// metadata.agentId 坐标，与 agent-runner/memory-mount.js 在 runner 载体上跑
// 的是同一条规则）。
export function memberProjectId(memberId: unknown): string {
  const out = String(memberId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out || "unknown";
}

/** 捕获件依赖的写面（fleetMemoryFor 产物或任何同形实现）。 */
export interface FleetMemoryWriter {
  writeFact(input: {
    fleetId: string;
    memberId: string;
    kind: string;
    partition: FactPartition;
    title: string;
    body: string;
  }): Promise<unknown>;
}

export interface FleetMemoryCapture {
  readonly failures: number;
  readonly captured: number;
  capture(
    fleetId: string,
    memberId: string,
    kind: FleetFactKind | (string & {}),
    title: string,
    body: string,
  ): Promise<boolean | null>;
}
export function createFleetMemoryCapture(
  { memory, clock = Date.now }: { memory?: FleetMemoryWriter; clock?: () => number } = {},
): FleetMemoryCapture | null {
  if (!memory) return null;
  const seen = new Set<string>();
  const seenKeys: string[] = [];
  let failures = 0;
  let captured = 0;
  return {
    get failures() {
      return failures;
    },
    get captured() {
      return captured;
    },
    async capture(fleetId, memberId, kind, title, body) {
      const ts = clock();
      // 幂等键包含「内容」而不只是时间戳：固定时钟（测试、快速连发回合）不
      // 能把两条不同的事实去重掉；真正的重放（同一事实重复投递）仍然会。
      const key = `${fleetId}|${memberId}|${kind}|${ts}|${title}|${body}`;
      if (seen.has(key)) return null; // 窗内重放 → 幂等
      seen.add(key);
      seenKeys.push(key);
      if (seenKeys.length > CAPTURE_DEDUP_MAX) seen.delete(seenKeys.shift()!);
      const partition = (KIND_PARTITION as Record<string, FactPartition | undefined>)[kind];
      if (!partition) {
        // 未知类型：绝不静默落进错误分区——计为失败，让运维看见第五类漂移。
        failures += 1;
        return false;
      }
      try {
        await memory.writeFact({ fleetId, memberId, kind, partition, title, body });
        captured += 1;
        return true;
      } catch {
        failures += 1; // 回合永不知情；计数器就是可观测性
        return false; // false = 失败（null = 重放去重，未尝试）
      }
    },
  };
}

// 健康翻转追踪器：记住每成员最近一次落定的状态，只在「翻转」（ok↔failed）
// 时产出一条观察——留下"谁恢复了/谁开始失败"的记忆叙事，不被逐回合噪音淹没。
export function createHealthFlipTracker() {
  const last = new Map<string, string>();
  return (fleetId: string, memberId: string, status: string): boolean => {
    const key = `${fleetId}|${memberId}`;
    const prev = last.get(key);
    last.set(key, status);
    if (prev === undefined || prev === status) return false;
    return true;
  };
}

/** 舰队记忆客户端三面（writeFact / writeSharedPage / readDigest）。 */
export interface FleetMemory {
  writeFact(input: {
    fleetId: string;
    memberId: string;
    kind: string;
    partition: FactPartition;
    title: string;
    body: string;
  }): Promise<void>;
  writeSharedPage(input: {
    fleetId: string;
    memberId: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<any>;
  readDigest(
    fleetId: string,
    memberId: string,
    q?: string,
    opts?: { k?: number; budget?: number; scope?: "own+shared" | "shared" | "off"; mergeOwnShared?: boolean },
  ): Promise<{ sources: string[]; block: string } | null>;
}

export interface FleetDigestSegment {
  source: "own" | "shared" | "legacy" | "own+shared";
  block: string;
}

// 三段标签：旗舰现行字符串，逐字节金样（test/goldens/fleet-digest-block.txt）。
// `own+shared` 只在 mergeOwnShared 合并读生效时出现（服务端一次请求返回两个分区）；
// 默认路径不会产生它，所以既有金样逐字节不变。
export const FLEET_SEGMENT_LABELS: Record<FleetDigestSegment["source"], string> = {
  own: "本岗位记忆",
  shared: "团队记忆",
  legacy: "历史团队记忆",
  "own+shared": "本岗位与团队记忆",
};

// 返回 { writeFact, writeSharedPage, readDigest } 或 null（配置关 / 无 owner /
// 铸造失败）——fleetMemoryFor 确立的降级开放姿态。
export async function fleetMemoryFor(
  env: EnvLike,
  ownerEmail: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<FleetMemory | null> {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    // person 令牌留给遗留过渡读（f/ digest）；成员令牌按舰队成员懒铸造——
    // 舰队就是 deployment（d/<fleetId>/<memberId>，shared = d/<fleetId>/
    // shared），每支队伍有自己的根与自己的团队事实分区。缓存按 (fleetId,
    // memberId)：换防不换（令牌属于岗位），舰队改名 id 不变。
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    const memberTokens = new Map<string, string>();
    const tokenForMember = async (fleetId: string, memberId: string): Promise<string> => {
      const key = `${fleetId}|${memberId}`;
      const cached = memberTokens.get(key);
      if (cached) return cached;
      const t = await memberTokenFor(cfg, { packId: fleetId, memberId, ownerEmail }, fetchImpl);
      memberTokens.set(key, t);
      return t;
    };
    const post = async (tok: string, project: string, title: string, body: string, metadata: Record<string, unknown> | null) => {
      // 出站纪律：共享死线包装（默认 env 界）；fetchImpl 保持测试缝。
      const r = await fetchWithTimeout(`${cfg.url}/pages`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({ project, title, body, ...(metadata ? { metadata } : {}) }),
      }, { fetchImpl });
      if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
      return await r.json();
    };
    const digestOnce = async (tok: string, project: string, q: string, { k = 5, budget = 1200, merged = false } = {}) => {
      const u = new URL(`${cfg.url}/digest`);
      // merged: the project argument is already a comma list → ask the server for
      // one multi-partition read; otherwise keep the single `project` parameter.
      if (merged) u.searchParams.set("projects", project);
      else u.searchParams.set("project", project);
      if (q) u.searchParams.set("q", String(q));
      u.searchParams.set("k", String(k));
      u.searchParams.set("budget", String(budget));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), digestTimeoutMs(env));
      try {
        const r = await fetchImpl(u, { headers: { authorization: `Bearer ${tok}` }, signal: controller.signal });
        if (!r.ok) throw new Error(`digest HTTP ${r.status}`);
        const json = await r.json();
        // fd-memory 的面把渲染文本叫 `digest`；下面的阶梯读 `.block`——在此
        // 归一化，让每一段都说同一种形状。
        return { block: typeof json?.digest === "string" ? json.digest : (json?.block ?? "") };
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      // 拆分写：分区来自封闭类型映射；metadata 携带结构化三元组，标题保持
      // 人话。重要：两个分区都走成员的 deployment 令牌——fd-memory 只对
      // deployment 令牌把项目名 "shared" 解析到该队的共享分区
      // （d/<fleetId>/shared），这里用 person 令牌会把团队事实误归到 owner
      // 的 u/ 根。
      async writeFact({ fleetId, memberId, kind, partition, title, body }) {
        const metadata = { fleetId, memberId, kind };
        const tok = await tokenForMember(fleetId, memberId);
        if (partition === "own") {
          await post(tok, memberProjectId(memberId), title, body, metadata);
        } else {
          await post(tok, "shared", title, body, metadata);
        }
      },
      // 团队级直接共享写（本来就知道自己是团队级的车道用，如其他载体上的
      // 换防记录员）。走执行成员的 deployment 令牌，理由同上。
      async writeSharedPage({ fleetId, memberId, title, body, metadata }) {
        const tok = await tokenForMember(fleetId, memberId);
        await post(tok, "shared", title, body, metadata ?? null);
      },
      // fleetContext 记忆段——阶梯在一个预算下合成三个来源，按成员的知识
      // 范围门控：成员自有分区、舰队共享分区（两者都走成员的 deployment
      // 令牌——共享项目名只对 deployment 令牌解析到 d/<fleetId>/shared），
      // 以及经 person 令牌的遗留 f/ digest（过渡窗；随停写自然衰减）。每段
      // 以同样的预算纪律服务端渲染；任何一段失败只丢那一段，绝不丢整节。
      // scope "shared" 跳过自有探测；"off" 到不了这个调用（调用方先查）。
      async readDigest(fleetId, memberId, q, { k = 5, budget = 1200, scope = "own+shared", mergeOwnShared = false } = {}) {
        const segBudget = Math.max(64, Math.floor(budget / 3));
        let memberTok: string | null = null;
        if (scope === "own+shared") {
          try {
            memberTok = await tokenForMember(fleetId, memberId);
          } catch {
            // 成员令牌就是 own/shared 两段的身份——没有它两段都丢，只剩遗留
            // f/ digest 能渲染
          }
        }
        const segments: FleetDigestSegment[] = [];
        let merged = false;
        // 合并读（optimize-yongyi-read-surfaces 6.2）：own 与 shared 在同一个根、同一枚
        // 成员令牌下，服务端一次请求即可跨分区返回（`?projects=a,shared`）。默认关闭
        // ——沿用单段读取与既有金样；打开后少一次请求，也少一次整根召回与向量解码。
        // 老服务端不认识 `projects`（会回 400 project_required），此时退回单段路径，
        // 不把版本差变成丢记忆。
        if (scope === "own+shared" && mergeOwnShared && memberTok) {
          try {
            const out = await digestOnce(
              memberTok,
              `${memberProjectId(memberId)},shared`,
              q ?? "",
              { k, budget: segBudget * 2, merged: true },
            );
            if (typeof out?.block === "string" && out.block.trim()) {
              segments.push({ source: "own+shared", block: out.block });
              merged = true;
            }
          } catch {
            merged = false; // fall through to the two single-partition reads
          }
        }
        const probes = merged
          ? [{ name: "legacy" as const, project: fleetProjectId(fleetId), token, q: (q ?? "") || String(memberId ?? "") }]
          : [
            { name: "own" as const, project: memberProjectId(memberId), token: memberTok, q: q ?? "" },
            { name: "shared" as const, project: "shared", token: memberTok, q: q ?? "" },
            { name: "legacy" as const, project: fleetProjectId(fleetId), token, q: (q ?? "") || String(memberId ?? "") },
          ];
        for (const probe of probes) {
          if (!probe.token) continue;
          try {
            const out = await digestOnce(probe.token, probe.project, probe.q, { k, budget: segBudget });
            if (typeof out?.block === "string" && out.block.trim()) {
              segments.push({ source: probe.name, block: out.block });
            }
          } catch {
            // 单段失败是计数器形状的缺席，不是错误
          }
        }
        if (segments.length === 0) return null;
        // 渲染器自己的头每段重复——阶梯给每个来源标一次签、拼接正文；空段
        // 消失。
        return {
          sources: segments.map((s) => s.source),
          block: segments
            .map((s) => `【${FLEET_SEGMENT_LABELS[s.source]}】\n${s.block}`)
            .join("\n\n"),
        };
      },
    };
  } catch (e: any) {
    console.warn(`[fleet-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}
