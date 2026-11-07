// ── 召回注入阶梯（自 paas/server/cluster-memory.js 下放） ────────────────────
//
// 集群共享记忆的 cell 侧车道：owner 的 person 令牌经 fd-memory 平台缝 /pages
// 面读写集群-id 项目的页。降级开放是契约：任何失败返回缺席（空块），集群/
// 聊天回合照常进行——记忆永不弄破回合。
//
// 注入阶梯（add-cluster-digest-injection design D3）：digest 面优先（服务端
// 渲染块，经续作评测验证），失败降级标题列表，再降级缺席。每一级降级恰一条
// warn；记忆永不失败一个回合。返回块本身（记忆关闭/不可用时为空串），调用方
// 拼装自己的 prompt 时追加的文本与聊天车道产出的完全一致。
//
// 字节同源纪律：标题标签与行组装字符串与旗舰现行注入逐字节一致，金样固化在
// test/goldens/（由 paas 现役实现实跑产出）。
//
// 环境参数化：壹座侧从 process.env 读的开关与默认（CELL_MEMORY_DIGEST*）在
// SDK 里参数化为 options（env 字段仍可传环境对象），默认值不变。

import { cellMemoryConfig, personTokenFor } from "./tokens.js";
import { fetchWithTimeout, FetchLike, EnvLike } from "./http.js";

export function clusterProjectId(clusterId: unknown): string {
  const out = String(clusterId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out || "cluster";
}

// digest 读超时（fix-digest-adaptive-embed-deadline）。必须高于 fd-memory 的
// 内部 embed 预算帽，否则会在被叫方仍在收尾时挂断——块整个丢掉而不是收到
// 降级形态。默认 9000（帽 8000 + 传输余量）；设得比帽还低，阶梯会直接跳过
// digest 级——这正是这条配置要暴露的错误用法。
export function digestTimeoutMs(env: EnvLike = process.env): number {
  const raw = Number(env.CELL_MEMORY_DIGEST_TIMEOUT_MS ?? 9000);
  const n = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 9000;
  return Math.max(500, Math.min(60_000, n));
}

/** 一条记忆页的最小读取面（/pages GET 的行形状）。 */
export interface MemoryPage {
  title?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** /digest 响应的服务端形状：渲染文本在 `digest` 字段。 */
export interface DigestDoc {
  digest?: string;
}

export type LadderSource = "digest" | "titles" | "none";

/** 阶梯依赖的客户端最小面（createClusterMemoryClient 的产物子集）。 */
export interface LadderMemory {
  readDigest(project: string, q: string, opts?: { k?: number; budget?: number }): Promise<DigestDoc>;
  readShared(project: string, limit?: number): Promise<MemoryPage[]>;
}

/** 集群记忆客户端三面（/digest、/pages 读、/pages 写）。 */
export interface ClusterMemoryClient extends LadderMemory {
  writeDigest(project: string, title: string, body: string): Promise<any>;
}

export interface ClusterClientOptions {
  url: string;
  token: string;
  fetchImpl?: FetchLike;
  /** digest 读死线（毫秒）；缺省读 env.CELL_MEMORY_DIGEST_TIMEOUT_MS，默认 9000。 */
  timeoutMs?: number;
  env?: EnvLike;
}

// 从 cell 配置构建的客户端三面（clusterMemoryFor 的 faces 移植）。
export function createClusterMemoryClient(opts: ClusterClientOptions): ClusterMemoryClient {
  const { url, token } = opts;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const env = opts.env ?? process.env;
  return {
    async readShared(project: string, limit = 5): Promise<MemoryPage[]> {
      // 出站纪律：共享死线包装（默认 env 界）；fetchImpl 保持测试缝。
      const r = await fetchWithTimeout(
        `${url}/pages?project=${encodeURIComponent(project)}&limit=${limit}`,
        { headers: { authorization: `Bearer ${token}` } },
        { fetchImpl },
      );
      if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
      const doc = await r.json();
      return Array.isArray(doc?.pages) ? doc.pages : [];
    },
    async writeDigest(project: string, title: string, body: string): Promise<any> {
      const r = await fetchWithTimeout(`${url}/pages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ project, title, body }),
      }, { fetchImpl });
      if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
      return await r.json();
    },
    // digest 读面（add-cluster-digest-injection）：服务端渲染块——一次机会、
    // 不重试（调用方的阶梯在任何失败时降级标题列表）。
    //
    // 超时（fix-digest-adaptive-embed-deadline）：这里曾有平的 5s，低于
    // fd-memory 自身的 embed 预算（8000ms）。嵌入上游慢时，fd-memory 还在
    // 做答案而我们已挂断——块整个丢掉而不是收到降级（关键词）形态。调用方
    // 必须比被叫方的内部预算更有耐心，故默认 9s；快路径毫秒级零成本，可配置。
    async readDigest(project: string, q: string, { k = 5, budget = 1500 } = {}): Promise<DigestDoc> {
      const u = new URL(`${url}/digest`);
      u.searchParams.set("project", project);
      u.searchParams.set("q", String(q ?? ""));
      u.searchParams.set("k", String(k));
      u.searchParams.set("budget", String(budget));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? digestTimeoutMs(env));
      try {
        const r = await fetchImpl(u, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!r.ok) throw new Error(`digest HTTP ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// 旗舰位形的整体构建（clusterMemoryFor 移植）：返回客户端或 null（配置关 /
// 无 owner / 铸造失败）。person 令牌与记忆挂载铸的是同一枚并缓存磁盘——每
// owner 一铸，重启稳定。
export async function clusterMemoryFor(
  env: EnvLike,
  ownerEmail: string,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ClusterMemoryClient | null> {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    return createClusterMemoryClient({ url: cfg.url, token, fetchImpl, env });
  } catch (e: any) {
    console.warn(`[cluster-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}

export interface DigestLadderOptions {
  digestOn: boolean;
  k: number;
  budget: number;
  titlesLabel: string;
  warnTag: string;
  warnName: string;
}

export interface LadderResult {
  block: string;
  source: LadderSource;
}

// 阶梯本体：digest 面优先，降级标题列表，再降级缺席。每个降级级恰一条 warn。
export async function digestLadder(
  cm: LadderMemory | null,
  project: string,
  prompt: string,
  { digestOn, k, budget, titlesLabel, warnTag, warnName }: DigestLadderOptions,
): Promise<LadderResult> {
  if (!cm) return { block: "", source: "none" };
  if (digestOn) {
    try {
      const d = await cm.readDigest(project, prompt, { k, budget });
      if (d?.digest) return { block: d.digest, source: "digest" };
    } catch (e: any) {
      console.warn(`[${warnTag}] digest read failed for ${warnName} (fallback to titles): ${e?.message || e}`);
    }
  }
  try {
    const sharedPages = await cm.readShared(project, 5);
    if (sharedPages.length) {
      const lines = sharedPages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
      return { block: `${titlesLabel}\n${lines}`, source: "titles" };
    }
  } catch (e: any) {
    console.warn(`[${warnTag}] shared-memory read failed for ${warnName} (degrade open): ${e?.message || e}`);
  }
  return { block: "", source: "none" };
}

// 注入调用选项：旗舰从 env 读的量全部参数化于此（env 字段保持 env 键语义）。
export interface LadderCallOptions {
  /** 读取 CELL_MEMORY_* 键的环境对象；缺省 process.env。 */
  env?: EnvLike;
  /** 显式覆盖 digest 面开关（集群键 env.CELL_MEMORY_DIGEST，聊天键 CELL_MEMORY_CHAT_DIGEST）。 */
  digestOn?: boolean;
  /** digest 召回条数；缺省 env.CELL_MEMORY_DIGEST_K，默认 5。 */
  k?: number;
  /** digest 字符预算；缺省 env.CELL_MEMORY_DIGEST_BUDGET，默认 1500。 */
  budget?: number;
}

const ladderEnv = (env: EnvLike) => ({
  k: Number(env.CELL_MEMORY_DIGEST_K ?? 5) || 5,
  budget: Number(env.CELL_MEMORY_DIGEST_BUDGET ?? 1500) || 1500,
});

// 标题标签：旗舰现行字符串，逐字节金样（test/goldens/*-titles-block.txt）。
export const CHAT_TITLES_LABEL = "【工作记忆】此前会话的沉淀，供参考：";
export const CLUSTER_TITLES_LABEL = "【集群共享记忆】本集群此前回合的沉淀，供参考：";

// 聊天车道阶梯配置：prompt 包装器与块读取面共用同一份，两面永不漂移
// （房间车道从这里读块）。项目固定 "default"——person 令牌的 MCP 写入落点
// （fd-memory namespaceParts），读面即写面。
const chatLadder = (cm: LadderMemory | null, query: string, env: EnvLike): Promise<LadderResult> =>
  digestLadder(cm, "default", String(query ?? ""), {
    digestOn: true,
    ...ladderEnv(env),
    titlesLabel: CHAT_TITLES_LABEL,
    warnTag: "chat-memory",
    warnName: "default",
  });

// 集群车道注入：CELL_MEMORY_DIGEST=0 是只跳过 digest 级的回滚杆。签名与行为
// 不变（env 语义经 options.env 传入）。
export async function memoryInjectionFor(
  clusterMemory: LadderMemory | null,
  clusterId: string,
  prompt: string,
  opts: LadderCallOptions = {},
): Promise<{ prompt: string; source: LadderSource }> {
  const env = opts.env ?? process.env;
  const envDefaults = ladderEnv(env);
  const { block, source } = await digestLadder(clusterMemory, clusterProjectId(clusterId), prompt, {
    digestOn: opts.digestOn ?? env.CELL_MEMORY_DIGEST !== "0",
    k: opts.k ?? envDefaults.k,
    budget: opts.budget ?? envDefaults.budget,
    titlesLabel: CLUSTER_TITLES_LABEL,
    warnTag: "cluster",
    warnName: clusterId,
  });
  return { prompt: block ? `${prompt}\n\n${block}` : prompt, source };
}

// 聊天车道（add-chat-memory-injection D2/D3）：owner 记忆根上的同一阶梯。
// CELL_MEMORY_CHAT_DIGEST=0 是聊天车道的总开关（spec：prompt 逐字节一致、
// 零 fd-memory 请求）——不同于集群杆只跳 digest 级；k/budget 与集群共用。
export async function chatMemoryInjectionFor(
  clusterMemory: LadderMemory | null,
  prompt: string,
  opts: LadderCallOptions = {},
): Promise<{ prompt: string; source: LadderSource }> {
  const env = opts.env ?? process.env;
  if (opts.digestOn != null ? !opts.digestOn : env.CELL_MEMORY_CHAT_DIGEST === "0") {
    return { prompt, source: "none" };
  }
  const { block, source } = await chatLadder(clusterMemory, prompt, env);
  return { prompt: block ? `${prompt}\n\n${block}` : prompt, source };
}

// 聊天车道的块面（add-unified-memory-and-outputs D7）：自己拼 prompt 的调用方
// （智语房间回合）得到同一文本、同一开关，车道与聊天永不分歧。关/杀/不可用
// 一律 ""——永不抛。
export async function chatMemoryBlockFor(
  ownerEmail: string | null | undefined,
  query: string,
  env: EnvLike = process.env,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<LadderResult> {
  if (!ownerEmail || env.CELL_MEMORY_CHAT_DIGEST === "0") return { block: "", source: "none" };
  try {
    const cm = await chatMemoryClientFor(ownerEmail, env, fetchImpl);
    if (!cm) return { block: "", source: "none" };
    return await chatLadder(cm, query, env);
  } catch (e: any) {
    console.warn(`[chat-memory] block read failed for ${ownerEmail} (degrade open): ${e?.message || e}`);
    return { block: "", source: "none" };
  }
}

// ws 聊天车道的客户端缓存：每 owner email 一个记忆客户端。已解析的客户端按
// 进程生命周期缓存；配置开着时的 null 结果（瞬时铸造失败）会被丢弃，下一回
// 合重试而不是黑到重启。
const chatClients = new Map<string, Promise<ClusterMemoryClient | null>>();
export async function chatMemoryClientFor(
  ownerEmail: string | null | undefined,
  env: EnvLike = process.env,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ClusterMemoryClient | null> {
  if (!ownerEmail) return null;
  let p = chatClients.get(ownerEmail);
  if (!p) {
    p = clusterMemoryFor(env, ownerEmail, fetchImpl);
    chatClients.set(ownerEmail, p);
  }
  const cm = await p;
  if (!cm && cellMemoryConfig(env)) chatClients.delete(ownerEmail);
  return cm;
}

// ws 车道接线（add-chat-memory-injection D1）：无身份或任何失败都不动 prompt
// ——记忆永不失败一次聊天回合。
export async function chatPromptWithMemory(
  ownerEmail: string | null | undefined,
  prompt: string,
  env: EnvLike = process.env,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<string> {
  if (!ownerEmail) return prompt;
  try {
    const cm = await chatMemoryClientFor(ownerEmail, env, fetchImpl);
    if (!cm) return prompt;
    return (await chatMemoryInjectionFor(cm, prompt, { env })).prompt;
  } catch (e: any) {
    console.warn(`[chat-memory] injection failed for ${ownerEmail} (degrade open): ${e?.message || e}`);
    return prompt;
  }
}
