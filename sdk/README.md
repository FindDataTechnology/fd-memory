# @finddatatechnology/yongyi-client

永忆（YongYi / fd-memory）客户端 SDK：把经过旗舰平台（agent 工作台/运行器）实战验证的接入件下放为独立 npm 包，任何 harness 集成方拿到同一套接入件。

**零运行时依赖**——只用 Node 内置 fetch 打永忆内核的 HTTP 面（`/digest`、`/pages`、`/admin/mint`、`/observe`），与内核之间是网络契约，不是代码契约。

- 模块：`ladder`（注入阶梯）、`discipline`（纪律文本单源）、`facts`（五类事实捕获）、`tokens`（令牌铸造缓存）、`observe`（/observe 上报）、`http`（出站死线包装）。
- 契约：降级开放——注入与捕获的任何失败都以缺席告终，绝不向宿主回合抛错；铸造失败则原样抛给调用方计数处理，绝不静默假装成功。
- 字节同源：注入块与旗舰平台现行输出逐字节一致（金样固化于 `test/goldens/`，由现役实现实跑产出）。

```bash
npm install @finddatatechnology/yongyi-client
```

## ladder — 注入阶梯

digest 面优先（服务端渲染块），失败降级标题列表，再降级缺席；digest 读死线默认 9000ms（必须高于内核 embed 预算帽 8000ms）。

```js
import { clusterMemoryFor, memoryInjectionFor, chatMemoryInjectionFor } from "@finddatatechnology/yongyi-client";

const env = {
  CELL_MEMORY_ENABLED: "1",
  CELL_MEMORY_URL: "http://127.0.0.1:8080",
  CELL_MEMORY_PLATFORM_TOKEN: "<平台令牌>",
  CELL_MEMORY_DATA: "/var/lib/my-harness",   // 令牌磁盘缓存根（0600）
};
const cm = await clusterMemoryFor(env, "owner@example.com");
if (cm) {
  // 集群车道：prompt 追加记忆块；source ∈ digest | titles | none
  const { prompt, source } = await memoryInjectionFor(cm, "cluster-42", userPrompt, { k: 5, budget: 1500 });
  // 聊天车道：项目固定 default；CELL_MEMORY_CHAT_DIGEST=0 为总开关（经 opts.env 传入）
  const chat = await chatMemoryInjectionFor(cm, userPrompt, { env });
}
```

任何失败（服务不可达、digest 超时）都返回空块与 `source: "none"`，prompt 保持未注入形态。

## discipline — 纪律文本单源

双语（zh + en）纪律文本的单源导出。消费者经本接口取文本用于自己的 persona 注入，不得手抄副本；文本更新随 SDK 版本发布。

```js
import { MEMORY_DISCIPLINE } from "@finddatatechnology/yongyi-client";
personaSuffix += MEMORY_DISCIPLINE;  // 与旗舰现行注入逐字节一致
```

## facts — 五类事实捕获

封闭五类：`turn`、`health` 落成员 own 分区（`d/<pack>/<member>`）；`decision-opened`、`decision-resolved`、`swap` 落团队 shared 分区。每页携带一等 metadata `{fleetId, memberId, kind}`；进程内有界幂等去重窗（512，键含内容）；未知类型计失败而非误落分区。

```js
import { fleetMemoryFor, createFleetMemoryCapture, createHealthFlipTracker } from "@finddatatechnology/yongyi-client";

const fm = await fleetMemoryFor(env, "owner@example.com");
if (fm) {
  const capture = createFleetMemoryCapture({ memory: fm });
  const healthFlip = createHealthFlipTracker();
  if (healthFlip("fleet-9", "writer-a", "failed")) {
    await capture("fleet-9", "writer-a", "health", "writer-a 开始失败", "digest HTTP 503 ×3");
  }
  await capture("fleet-9", "writer-a", "decision-resolved", "采用方案 B", "理由……");
  // capture 失败只进计数器：capture.failures / capture.captured
}
```

## tokens — 令牌铸造与缓存

经平台令牌铸造 person（`u/`）与 deployment（`d/<pack>/<member>`）令牌；磁盘缓存 0600、重启稳定、同身份只铸一次（namespace 校验后复用）。

```js
import { cellMemoryConfig, personTokenFor, memberTokenFor, memoryMcpEntry } from "@finddatatechnology/yongyi-client";

const cfg = cellMemoryConfig(env);          // 四件套缺一即 null（整体关闭）
const person = await personTokenFor(cfg, "owner@example.com");   // 失败 → throw，调用方计数
const member = await memberTokenFor(cfg, { packId: "fleet-9", memberId: "writer-a", ownerEmail: "owner@example.com" });
const mcpEntry = memoryMcpEntry(cfg.url, person);                // DeepSeek Harness MCP 客户端加载行（http 分支） // leak-check:allow
```

## observe — /observe 上报

事件投递到内核 `POST /observe`（封闭集 `turn_outcome | tool_call | health_flip`）。幂等键缺省自动 `crypto.randomUUID()`；`observeFireAndForget` 失败即丢、无重试、有界超时（默认 10s），永不阻塞宿主。

```js
import { observeFireAndForget, observeOnce } from "@finddatatechnology/yongyi-client";

observeFireAndForget({
  url: "http://127.0.0.1:8080", token: person,
  type: "turn_outcome", title: "回合收尾", body: "完成 X，下一步 Y",
  harness: "claude-code",           // 来源标注（跨 harness 合流）
});
// 要结果（如 hook 转发器收尾前确认）用 await observeOnce(...)
```

## 挂载行形状（参照）

DeepSeek Harness / ACP 两类载体的记忆挂载行形状（`dshMemoryMount` / `acpMemoryMount`）：

```js
// DeepSeek Harness：mcp 客户端加载行
{ id: "mcp-fd-memory", name: "@deepseek-ai/dsh-mcp-client", // leak-check:allow 公开 npm 包名
  config: { serverName: "fd-memory", failOnStartupError: false, transport: "streamable-http",
            url: "<url>/mcp", headers: { Authorization: "Bearer <token>" } } }
// ACP：SDK wire 行（headers 为 {name,value} 数组）
{ type: "http", name: "fd-memory", url: "<url>/mcp",
  headers: [{ name: "Authorization", value: "Bearer <token>" }] }
```

## 构建与测试

```bash
npm install        # 开发依赖：typescript、@types/node（运行时零依赖）
npm run build      # tsc -p tsconfig.json → dist/
npm test           # 编译 src+test → dist-test/，node --test 全绿（mock fetch，无网络）
npm pack --dry-run # 文件清单：dist/ + README.md，无测试产物泄漏
```

## License

MIT
