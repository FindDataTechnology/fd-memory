// ── mounts.ts · 挂载行与命名空间坐标（add-yongyi-complete-solution 后续补件）──
//
// 从壹座 agent-runner/memory-mount.js 逐字节移植（adopt-yongyi-client-sdk
// 任务 0.1，paas 侧缺口审计裁定：命名空间坐标规则与 ACP/dsh 两种挂载行形状
// 属通用件，随 SDK 下发）。纯 builder——不碰网络、不碰 manager，可独立测试。
//
// 两个挂载行形状：
//   dsh  dsh-mcp-client loader 行（headers 为对象）——与 tokens.ts 的
//        memoryMcpEntry 同源，此处以别名导出保持 runner 侧函数名不漂
//   acp  ACP SDK wire 行（headers 为 ARRAY of {name,value}——见 acpMcpServers）

// 成员条目的记忆坐标（add-memory-scopes-and-cluster-sharing 语义）：
// metadata.agentId 是坐标本体——显示名不是（改名不得改变命名空间）；名字
// 只作为 agentId 尚未入册的旧 descriptor 的回退。
export function memoryNamespaceFor(entry: {
  metadata?: { packId?: string | null; agentId?: string | null };
  name?: string | null;
} | null | undefined): string | null {
  const packId = entry?.metadata?.packId;
  const agentId = entry?.metadata?.agentId ?? entry?.name;
  if (!packId || !agentId) return null;
  return `d/${packId}/${agentId}`;
}

// pod 令牌挂的 pack 共享命名空间（2 段——fd-memory 按此形状铸 pod 族）。
export function podMemoryNamespace(packId: string | null | undefined): string | null {
  return packId ? `d/${packId}` : null;
}

export function dshMemoryMount(url: string, token: string | null | undefined) {
  return {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

export function acpMemoryMount(url: string, token: string | null | undefined) {
  return {
    type: "http",
    name: "fd-memory",
    url,
    headers: token ? [{ name: "Authorization", value: `Bearer ${token}` }] : [],
  };
}
