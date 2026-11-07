# 永忆接入指南（Harness Integration）

面向把 AI harness（Claude Code、ZCode、任意 MCP 客户端、Dify 这类 UI 配置型 Agent 平台、LangChain/CrewAI/LlamaIndex 这类代码级框架、自研 runner/网关）接入永忆的集成者。读完这篇你应当清楚：接入的三件套契约是什么、`/observe` 的完整 API 语义、每个适配器写了什么与断开时还原什么、客户端 SDK 提供什么，以及「换工具不换记忆」是如何被契约保证的。

> 术语对齐：**u/** 人根 · **d/&lt;pack&gt;/&lt;member&gt;** 部署根 · **own/shared** 分区 · **L0–L3** 四层记忆 · **digest** 服务端渲染摘要块 · **蒸馏接替（supersede）** 旧结论退役、原文保留。
>
> 快速路径（只想用，不想读契约）：`yongyi connect claude-code --url http://localhost:49375 --as you@example.com`，然后看本文第 6 节。

---

## 1. 接入契约总览：三件套

任何 harness 的接入都由三件事构成：**身份绑定**、**digest 槽**、**L0 捕获**。适配器（`yongyi connect`）替你把三件事一次配好；自研 runner 直接按本章语义实现。

### 1.1 身份绑定（identity）

- **person 令牌 → u/ 根。** `connect --as <id>` 把 harness 绑定到一个人根 `u/<id>` 并铸出（或复用）person 令牌。同一 `--as` 身份跨 harness 复用同一根——这是跨 harness 合流的前提（见第 5 节）。
- **deployment 令牌 → d/ 根。** 平台侧、舰队/岗位场景用 deployment 令牌，写入按既有 own/shared 分区规则落 `d/<pack>/<member>`。deployment 根与任何 person 根互不互通。
- **凭据纪律。** 令牌权威与永忆既有 token 树一致（platform / person / deployment）。connect 产出的配置只含令牌引用，不内嵌明文平台级令牌；凭据永不进受管区块或粘贴片段。

### 1.2 digest 槽（召回注入）

永忆的服务端渲染 digest 块是召回进入 prompt 的唯一面——原始召回结果从不直接进会话文件。digest 槽有两种实现形态，接入时至少具备其一：

- **agent 拉取**：纪律区块（受管注入，见第 3 节）指引 agent 在回合开始时经 MCP 工具取 digest / 查询记忆。这是 claude-code / zcode 适配的默认形态。
- **宿主注入**：集成方在 prompt 模板里留一个槽位，由 SDK 注入阶梯（`ladder`）把 digest 块写进去——digest 面优先，失败降级标题列表，再降级缺席；任一步失败都以缺席告终，绝不向宿主回合抛错（见第 4 节）。

### 1.3 L0 捕获（/observe）

- harness 的**平台侧**（hooks、网关、runner）把回合事件 POST 到 `/observe`，落为 L0 observation——「记得住」由平台担保，不依赖 agent 自觉。
- agent **自觉**写 note / 交接（经 MCP 工具或 SDK）降级为可选的 L1 观点层：有则更准，无则捕获照常进行。

---

## 2. `/observe` API 参考

L0 平台担保捕获面：任何 harness 的平台侧无需 agent 配合即可写入回合事件。

### 2.1 请求

```
POST /observe
Authorization: Bearer <person 令牌 | deployment 令牌>
Content-Type: application/json
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | **封闭集**：`turn_outcome`（回合结局）/ `tool_call`（工具调用）/ `health_flip`（健康状态翻转）。未知类型被拒，不落任何页 |
| `idempotency_key` | 是 | 调用方生成的幂等键；同键重放返回首次结果，不新增行 |
| `title` | 是 | 事件标题 |
| `body` | 是 | 事件正文；超过 32KB 上限被截断落盘，页内带截断标注 |
| `subject` | 否 | 主体标识（member/agent） |
| `ts` | 否 | ISO8601 时间戳；缺省取服务端时钟 |
| `harness` | 否 | 来源标注（harness 名）；作为 metadata 一等字段透传，Portal 列表与 digest 证据可读（见第 5 节） |
| `metadata` | 否 | 自由 metadata 对象 |

### 2.2 应答与错误语义

| 情形 | 语义 |
|------|------|
| 成功 | 2xx（202 语义），携带页标识与可选 `truncated` 指示；事件以 observation 类型落在调用方命名空间内，digest 可召回 |
| 未知事件类型 | 4xx 明确错误码，不落任何页 |
| 令牌缺失 / 权限不足 | 4xx，**绝不静默改落他处** |
| 幂等重放 | 2xx：返回首次结果（或等价应答），不新增行、不报错 |
| 正文超限 | 按截断纪律落盘（页内标注截断），请求 2xx 并携带截断指示 |
| 速率超限 | 限流应答并携带重试提示；`/digest`、`/pages`、`/mcp` 等既有读写面不受影响 |

### 2.3 归属与护栏

- **命名空间归属**：person 令牌写入落其 u/ 根；deployment 令牌按 own/shared 分区规则落 d/ 根（岗位私有事件落 own 分区，仅该 deployment 视野可见）。
- **幂等**：服务端按 `(namespace, idempotency_key)` 查重——网络重试导致的重复投递只产生一页。
- **护栏**：逐令牌速率护栏 + 正文 32KB 截断帽，护栏只作用于 observe 自身。

### 2.4 调用方纪律：失败即丢，永不阻塞回合

observe 的失败语义面向调用方降级：明确错误码、有界响应时间。hooks / 网关 / SDK 拿到 5xx 或超时**一律按丢弃处理**——不重试、不排队、不阻塞 harness 回合，无重试风暴。服务端同样保证 observe 队列积压不会延迟 `/digest`、`/pages`、`/mcp`。把 observe 当作「尽力而为的捕获面」来调用，是集成契约的一部分。

---

## 3. connect：每适配器一节

`yongyi connect <harness> --url <service> --as <id>` 一条命令生成目标 harness 的全部接入工件：MCP 挂载、捕获接线、纪律注入、身份绑定。执行结果会列出写了哪些文件、绑定了哪个身份根。全部写操作先查受管标记再合并，**幂等重跑**：连续运行两次，条目与区块只存在一份。

### 3.1 claude-code

```bash
yongyi connect claude-code --url http://localhost:49375 --as you@example.com
```

写入三类受管工件：

1. **MCP 服务器条目**（streamable-http）——挂载永忆 MCP 工具面；
2. **hook 接线**——会话收尾与工具事件注册到 `yongyi hook claude-code <event>` 命令，转发器读事件、映射为 `{type: turn_outcome | tool_call, …}` POST `/observe`，失败即丢、不阻塞回合；
3. **CLAUDE.md 受管纪律区块**——以 `<!-- yongyi:begin --> … <!-- yongyi:end -->` 包裹；更新只替换区块内字节，**区块外的用户自有内容逐字保留**。

断开：

```bash
yongyi disconnect claude-code
```

还原语义：移除 connect 写入的全部受管工件（挂载条目、hook 接线、受管区块整体），用户自有内容不动，**记忆数据一页不删**。

### 3.2 zcode

```bash
yongyi connect zcode --url http://localhost:49375 --as you@example.com
```

与 claude-code 等价的能力：MCP 挂载、捕获接线、**AGENTS.md 受管纪律区块**；幂等语义、受管区块纪律、断开还原与 claude-code 相同（`yongyi disconnect zcode`）。

### 3.3 mcp（通用）

```bash
yongyi connect mcp --url http://localhost:49375
```

输出可直接粘贴进任意 MCP 客户端的 JSON 配置片段（服务 URL + 令牌引用方式）。不写入任何特定工具的配置文件，片段中**不内嵌明文平台令牌**。

### 3.4 dify

```bash
yongyi connect dify --url http://localhost:49375 --as you@example.com
```

Dify 是 UI 配置型平台，没有可合并的配置文件，所以这个适配器是**配方生成器**：不写任何平台配置，输出四段终端指引。

| 段 | 内容 | 依据 |
| --- | --- | --- |
| ① 添加服务器 | Integrations（工具）→ Tools → 添加 MCP 服务器；transport 选 HTTP；URL 填 `…/mcp` | Dify 只支持 HTTP transport 的 MCP 服务器，永忆的 streamable-http 端点原生匹配 |
| ② 认证 header | `Authorization: Bearer <person 令牌>`，每请求携带；令牌用命令从 `$YONGYI_HOME/env` 取，配方正文不落明文 | 静态 header 足够（person 令牌是长期凭据）；动态 OAuth 注册留待后续 |
| ③ 纪律区块 | 整段粘贴到 Agent 应用的系统提示词 | Dify 无回合 hook 面，纪律是此处唯一的记忆写路径 |
| ④ 验证清单 | 工具列表出现五个工具即通：`memory_write_page` / `memory_query` / `memory_recent` / `memory_handoff_begin` / `memory_handoff_list` | 与 MCP 工具面同源核对（`src/mcp.ts`），清单漂移会让测试失败 |

`identifier` 固定为 `yongyi`：Dify 应用按 identifier 引用服务器，改名会断掉所有已有引用，因此配方把它钉死而非留作可选项。

**诚实边界**：Dify 侧的记忆是 agent 自觉写，不是平台担保——`/observe` 的 L0 自动捕获需要回合/工具事件面，Dify 没有，配方与本节都不假装有。幂等：同参数重跑输出一致，并复用同一 person 根。

断开：

```bash
yongyi disconnect dify
```

CLI 代不了 UI 操作，所以输出的是移除步骤（找到 identifier 为 `yongyi` 的服务器并移除、重选工具、删掉提示词里的纪律段落）；本侧只清我们自己的备料——凭据文件里的 dify 绑定与导出的令牌变量。身份根与全部记忆页不动。

### 3.5 coze

```bash
yongyi connect coze --url http://localhost:49375 --as you@example.com
```

**当前不支持，且不说成支持**。勘定（2026-11-07）：coze-studio 开源版没有 MCP client 能力，平台侧无法把外部 MCP 服务器挂成工具；商业版（coze.cn）的 MCP 文档页为 JS 渲染，无法无头勘定，需有账号时实机验证。跟踪：[#7](https://github.com/coze-dev/coze-studio/issues/7)、[#2079](https://github.com/coze-dev/coze-studio/issues/2079)、[#628](https://github.com/coze-dev/coze-studio/issues/628)。

命令输出的是侦察结论 + 备料：端点、身份根、person 令牌（落 0600 凭据文件，`YONGYI_TOKEN_COZE`）。**不含任何接入步骤**——平台支持那天，同一套 URL + `Authorization: Bearer` 即可用，身份不必重铸。勘定日期随 CLI 版本更新，过期可见。

```bash
yongyi disconnect coze
```

coze 没有写入任何平台配置，所以断开只清本侧备料。

### 3.6 框架（Python：LangChain / CrewAI / LlamaIndex）

前三节都是「有配置文件」或「UI 配置」的宿主。代码级框架两样都没有，但它们**有事件面**——所以接入不再依赖 agent 自觉，捕获在适配层担保。三级谱系：

| 级别 | 形态 | 记忆写入的保证 |
| --- | --- | --- |
| 平台担保 | 原生平台 | 平台在每个回合收尾自动落 L0，不依赖 agent |
| 适配层担保 | 框架 handler（本节） | 框架每次工具调用/回合结束都回调，适配层自动上报 |
| agent 自觉 | UI 型平台（Dify，§3.4） | 只有提示词纪律，agent 不写就没有 |

```bash
pip install "yongyi-agent[langchain]"   # 或 [crewai] / [llamaindex]
```

**身份**：适配层只消费凭据，不铸造、不改写——令牌按 `YONGYI_TOKEN`（旧名 `FD_MEMORY_TOKEN`）→ `~/.yongyi/credentials.json`（由 `yongyi connect` 写出，须 0600）解析。

**映射表**（三个框架同一套语义）：

| 框架 | 触发点 | 事件 |
| --- | --- | --- |
| LangChain | `on_tool_end` | `tool_call` |
| LangChain | `on_agent_finish`；无 agent 时顶层 `on_chain_end` | `turn_outcome` |
| CrewAI | `ToolUsageFinishedEvent` | `tool_call`（`failure` 非空 → `metadata.outcome`） |
| CrewAI | `CrewKickoffCompletedEvent` / `CrewKickoffFailedEvent` | `turn_outcome`（`total_tokens` / `crew_name` 进 metadata） |
| LlamaIndex | `AgentToolCallEvent`（instrumentation） | `tool_call` |
| LlamaIndex | `QueryEndEvent`（instrumentation） | `turn_outcome` |

LlamaIndex 那一行是**真跑改过的**：0.14+ 的工具调用不再走 `CBEventType.TOOL`——0.14.25 的 core 连这个枚举成员都没有（`tool` 只存在于上游 main 分支的 schema 里，我最初按 main 写的实现因此完全捕获不到东西）。现役路径是 instrumentation：把 event handler 注册到 `get_dispatcher()`。旧回调面（`on_event_end` 收 `tool` / `function_call` / `agent_step`）仍作为低版本兼容保留，映射语义相同。

接线：

```python
# LangChain
from yongyi_agent.langchain import callback_handler
graph.invoke(inputs, config={"callbacks": [callback_handler()]})

# CrewAI —— 监听器必须实例化才注册，丢掉返回值会静默失去捕获
from yongyi_agent.crewai import event_listener, uninstall
listener = event_listener()
# uninstall(listener)   # 停止捕获，已写下的记忆不动

# LlamaIndex（0.14+，现役）—— 返回值请持有，uninstall(handler) 用它摘除
from yongyi_agent.llamaindex import event_handler
handler = event_handler()

# LlamaIndex（旧版本兼容面）
from llama_index.core.callbacks import CallbackManager
from yongyi_agent.llamaindex import callback_handler
Settings.callback_manager = CallbackManager([callback_handler()])
```

**MCP 挂载配方**（工具面本身仍走 MCP；令牌只给引用）：

```python
# langchain-mcp-adapters
client = MultiServerMCPClient({"fd-memory": {
    "url": "http://127.0.0.1:49375/mcp",
    "transport": "http",
    "headers": {"Authorization": "Bearer ${YONGYI_TOKEN}"},
}})
tools = await client.get_tools()

# llama-index-tools-mcp
client = BasicMCPClient("http://127.0.0.1:49375/mcp")
tools = await McpToolSpec(client=client).to_tool_list_async()
```

CrewAI 的 MCP 集成随版本演进，挂载形态以所装版本为准（要的只是 HTTP transport MCP 客户端 + 自定义 `Authorization` 头）——本节不假装它有一个我们没验证过的固定 API。

**设计底线**（与前面的 harness 适配器同一条）：框架回调体整段包在 try/except 里，任何异常不外泄；投递失败/超时/4xx 全部吞掉、不重试；默认守护线程异步投递，绝不阻塞回合；封闭集之外的事件类型与空标题在构造期就抛错。纪律文本 `yongyi_agent.DISCIPLINE` 与 TypeScript 侧逐字节一致（同一 golden 两侧钉住）。

**已知边界**：LangChain 的 `on_chain_end` 每层 runnable 都触发，适配层只认顶层（`parent_run_id is None`）——不过滤会让一次 agent 运行落十几条 `turn_outcome`。LangChain 的回调管理器还会对**每个**事件调 handler 上的同名方法（真跑 1.7.6 实测：缺方法会被记成 callback 错误打进宿主日志），所以适配层把用不到的入口全部实现成空操作——不是凑数，是消除日志噪声。CrewAI 的 `emit()` 把同步 handler 提交到线程池并返回 Future（不阻塞），所以回调体永远不在调用方线程上；适配层本就 fire-and-forget，不受影响，但自己写测试要等 `future.result()`。LlamaIndex 的 `QueryEndEvent` 未必出现在所有编排里（纯工具编排没有查询收尾），映射层不做「一定会有几次」的假设。

---

## 4. 客户端 SDK（`@finddatatechnology/yongyi-client`）

独立 npm 包，把经过生产验证的集成通用件交给任何 harness 集成者。**零运行时依赖**：SDK 只依赖永忆内核的 HTTP 面（fetch），与服务端是网络契约而非代码契约，可与服务端版本独立演进；HTTP 客户端经 `fetchImpl` 注入可替换——便于单测打桩、代理环境与自签名场景。

| 模块 | 职责 | 契约要点 |
|------|------|----------|
| `ladder` | 注入阶梯 | digest 面 → 标题列表 → 缺席；超时有界；任一失败以缺席告终，绝不向宿主回合抛错 |
| `discipline` | 纪律文本单源 | 双语单一来源；消费方经编程接口取文本，不手抄副本；更新随 SDK 版本发布 |
| `facts` | 舰队五类事实捕获 | 封闭五类：`turn`、`health` 落 own 分区；`decision-opened`、`decision-resolved`、`swap` 落 shared 分区；带进程内有界幂等去重窗；未知类型计失败，不误落分区 |
| `tokens` | 令牌铸造与缓存 | 经平台令牌铸 person（u/）与 deployment（d/&lt;pack&gt;/&lt;member&gt;）令牌；磁盘缓存 0600、重启稳定、同身份只铸一次；铸造失败抛给调用方计数处理，绝不静默假装成功 |
| `observe` | /observe 客户端 | 幂等键生成、失败即丢（与 2.4 纪律一致） |

---

## 5. 跨 harness 合流语义

「记忆跟着用户走，不跟着工具走」——同一 person 根被多个 harness 绑定时：

- **写读并集**：同一 u/ 根的读面（digest、查询、Portal）呈现全部 harness 写入的并集；任何 harness 写入的记忆对其它 harness 立即可召回。
- **蒸馏接替跨源**：蒸馏消费同根并集；harness A 写入的事实可被 harness B（或 Portal）发起的更正 note 接替，接替语义不因来源不同而变化——旧结论读面退役，原文保留可审计。
- **来源可观测**：跨 harness 写入的页携带 `harness` 来源标识，Portal 列表与 digest 证据以用户可读的来源徽标呈现。
- **隔离边界不被稀释**：合流只发生在同一 person 根内。deployment 根（d/）与其它 person 根不因跨 harness 能力而互通；无显式授权不得跨根读写。
- **断开不弃忆**：页归属人根而非工具。卸载、断开或停用任一 harness，其历史写入照常可召回、可蒸馏、可在 Portal 管理。

---

## 6. 最小可跑示例

从零到召回，四步：

```bash
# 0. 构建并启动服务（内置 SQLite + FTS，零外部依赖）
npm ci && npm run build
./dist/index.js serve --port 49375 &

# 1. 连接（claude-code 为例；--as 即人根身份 u/you@example.com）
yongyi connect claude-code --url http://localhost:49375 --as you@example.com
# 输出列出全部写入的配置文件与绑定的身份根

# 2. 模拟一条 hook 上报——hook 转发器在回合收尾时做的正是这条请求。
#    person 令牌由 connect 铸出并写入 harness 配置（此处手动复现同一路径）：
curl -X POST http://localhost:49375/observe \
  -H "authorization: Bearer $PERSON" \
  -H "content-type: application/json" \
  -d '{"type":"turn_outcome","idempotency_key":"r-42","title":"周报初稿完成","body":"本周口径已定稿","harness":"claude-code"}'
# → 2xx {"page":…}

# 3. 召回：这就是 digest 槽拿到的东西
curl "http://localhost:49375/digest?project=default&q=%E5%91%A8%E6%8A%A5" \
  -H "authorization: Bearer $PERSON"
# 该 observation 出现在摘要中，来源标注 harness=claude-code
```

在真实 harness 里，第 2 步由 connect 注册的 hook 自动完成；你只管正常跑回合。之后在浏览器打开服务自带的 `/portal`（粘贴 person 令牌登录），即可浏览、筛选、纠错自己的记忆——Portal 的浏览 / 纠错 / 晋升手势见 README「接入（Integration）」章。
