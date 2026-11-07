# 永忆接入指南（Harness Integration）

面向把 AI harness（Claude Code、ZCode、任意 MCP 客户端、自研 runner/网关）接入永忆的集成者。读完这篇你应当清楚：接入的三件套契约是什么、`/observe` 的完整 API 语义、每个适配器写了什么与断开时还原什么、客户端 SDK 提供什么，以及「换工具不换记忆」是如何被契约保证的。

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
