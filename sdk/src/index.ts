// ── @finddatatechnology/yongyi-client · 出口面 ───────────────────────────────
//
// 永忆（fd-memory）客户端 SDK：把旗舰平台与运行器里经过实战验证的接入件
// 下放为独立发包。零运行时依赖——只用 Node 内置 fetch 打内核 HTTP 面
// （/digest、/pages、/admin/mint、/observe），与服务端之间是网络契约，不是
// 代码契约。
//
// 模块地图（design D6）：
//   ladder     注入阶梯 digest→titles→absent（自 cluster-memory.js 移植）
//   discipline 纪律文本双语单源（自 memory-discipline.js 移植）
//   facts      五类事实捕获 own/shared（自 fleet-memory.js 移植）
//   tokens     person/deployment 令牌铸造 + 磁盘缓存 0600（自 cell-memory.js 移植）
//   observe    /observe 上报客户端（幂等键、失败即丢）
//   http       出站 fetch 死线包装（fetchImpl 测试缝、FetchTimeoutError）
//   mounts     挂载行与命名空间坐标（DeepSeek Harness / ACP 两形状，自运行器移植）

export * from "./http.js";
export * from "./discipline.js";
export * from "./tokens.js";
export * from "./ladder.js";
export * from "./facts.js";
export * from "./observe.js";
export * from "./mounts.js";
