# 永忆（YongYi）

**面向 AI Agent 与 Multi-Agent 平台的长期记忆服务。**
Working memory for agentic platforms — durable, layered, self-distilling memory as a service.

永忆（YongYi，fd-memory 的产品品牌）是一个为**智能体 / 多智能体系统**设计的长期记忆基础设施：把「一个 agent 过去知道的一切」变成**每回合都可召回**的结构化知识，支撑跨平台部署与多 agent 协同。

> **永久免费**：永忆本体自托管免费，无计量面、无付费墙、无 license 检查机制；嵌入与蒸馏的模型成本由运营者自担（BYO 模型）。Free forever — self-host free, no metering, no paywall; bring your own model budget.

## 为什么

Agentic 平台的共同问题：

- **会话边界 = 记忆断点**：换会话、隔天回来，先前的偏好、结论、未竟事项全部重推。
- **多 agent 协同失忆**：fleet 里 3 个成员轮换轮班，每轮还要重推背景；交接写了很少被认领。
- **检索质量波动**：向量检索被关键词限流、长交接淹没正文、慢 embed 悄悄降级。

FD-memory 把这些收敛到一个服务里，让记忆是**案件内层**（L0 observations → L1 handoffs+notes → L2 facts+experiences → L3 profiles），不是插件式敷在会话边上。

## 核心设计

### 四层记忆（L0–L3）

| 层    | 形态            | 价值                               |
|-----|---------------|----------------------------------|
| L0  | observations  | 原始事件流（tool 调用、会话事件）——蒸馏原料      |
| L1  | notes + handoffs | Agent/用户亲笔记、跨成员交接——**写后立即可召回** |
| L2  | facts + experiences | 蒸馏过的结构化知识——**长期、主检索**         |
| L3  | profiles      | 用户偏好画像（路线图）                     |

### 召回三维防护

1. **向量全库扫描**（解除「只对关键词召回的候选打分」的限流，语义独占命中可达）
2. **字段加权关键词**（title×3 / search_keys×2 / body×1）——慢 embed 时也稳
3. **双维 note 召回**（query 相关≤3 + 新近≤5）——写后约 2 分钟自动可召回

### 生产韧性

- **蒸馏产出侧去重**：主题更正自动接替旧结论，旧页文件保留但读面退役，不误导、不堆积
- **Embed 压力管理**：串行闸+单飞合并、代理冷却退避（2→4→8min）、近视冷启动观察窗
- **摘要预算纪律**：每条保留 1500 tokens，handoffs 通知段行级截断、L2/L1 行级 gist、标题帽与去重

### 服务与部署形态

- **单进程 Node**：零外部依赖（内置 SQLite + FTS5），`fd-memory serve`
- **可插拔蒸馏器**：不启动 sidecar 也可以用全部读写面；装上后 L2 蒸馏自动分层
- **NPM 包**：`npm pack` 一件脱机交付（src + scripts + Docker + fixtures）；发布面定型 `@finddatatechnology/yongyi`（`yongyi --help`）

## 快速启动（约 2 分钟）

```bash
# 1. 依赖与构建（Node >= 22.5）
npm ci && npm run build

# 2. 本地启动（内置 SQLite+FTS，无外部依赖）
./dist/index.js serve --port 4000 &

# 3. 健康检查
curl http://127.0.0.1:4000/healthz
# → {"status":"ok","service":"fd-memory"}

# 4. CLI 发第一枚 bootstrap token
BOOT=$(./dist/index.js token mint --kind platform --namespace '*' --label bootstrap \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# 5. 用它再发一枚人根 token
PERSON=$(curl -sX POST http://127.0.0.1:4000/admin/mint \
  -H "authorization: Bearer $BOOT" \
  -H "content-type: application/json" \
  -d '{"namespace":"u/demo"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# 6. 问记忆：/digest（人根 token 直接发，无需任何 rootKey）
curl "http://127.0.0.1:4000/digest?project=default&q=%E5%91%A8%E6%8A%A5" \
  -H "authorization: Bearer $PERSON" | python3 -m json.tool
```

`--` 提示：/admin/mint 里的 platform token 就能自举整个权限树（platform → person → deployment），无需任何外网环境变量。

## MCP 工具面（agent 侧）

装载 fd-memory 的标准 MCP agent（streamable-http）可调以下工具：

| 工具                               | 用途                             |
|------------------------------------|--------------------------------|
| `memory_write_page`                | 写一条 note（L1）            |
| `memory_handoff_begin`             | 开一条交接（把情境通知位下一位 agent） |
| `memory_handoff_list / accept / cancel` | 列/认领/取消交接             |
| `memory_query`                     | 全页型 FTS 搜索（note 与 L2 均可查）   |
| `memory_recent`                    | 新近页列表                        |
| `memory_read_page` / `memory_overview` | 单页正文（超长按字节分页）/ 分区概览 |
| `memory_handoff_accept / cancel`   | 认领（带完整正文，逐字段自证截断）/ 取消 |

**读面都有上限，且截断会自证。** 每个工具声明自己的上限，被截断时回带 `truncated`
与总量（正文型还回 `next_offset`），不会把截断的返回显示成完整：

| 读面 | 上限 | 自证字段 |
|---|---|---|
| `memory_query` / `memory_recent` | 条数 `[1, 50]`，默认 20 | `total` / `truncated` |
| `memory_read_page` | 单次正文 32 KiB（默认与上限同值） | `truncated` / `total_bytes` / `next_offset` |
| `memory_handoff_list` | 20 条（可到 100），单行 summary 200 字 | `truncated` / `truncated_summaries` |
| `memory_handoff_accept` | summary 4 KiB、列表 20×500 字、文件 200 项 | `truncated_fields` |
| `memory_overview` | 25 个分区 × 每个 3 个标题 | `truncated` / `total_partitions` |
| `/memory/promotions` | 跨分区合计 100 条 | `total` / `truncated` / `total_partitions` |

全部可用环境变量覆盖（如 `FD_MEMORY_LIST_LIMIT_MAX`、`FD_MEMORY_HANDOFF_SUMMARY_CHARS`、
`FD_MEMORY_READ_BODY_MAX_BYTES`），默认值即上表。

**退役页只有一个判定。** 被更新的页通过 `supersedes` 取代的旧页不出现在任何读面
（检索、新近、正文、概览）；需要看历史时显式传 `include_superseded: true`。

## 接入（Integration）

一条命令把 harness 接上永忆：MCP 挂载、回合捕获（hook → `/observe`）、纪律注入、身份绑定一次完成。完整契约与 API 参考见 [`docs/harness-integration.md`](docs/harness-integration.md)。

### Claude Code

```bash
yongyi connect claude-code --url http://localhost:49375 --as you@example.com
```

接入后得到三样东西：

- **MCP 挂载** — streamable-http 方式挂载永忆 MCP 工具面（`memory_write_page` / `memory_query` / …）
- **hook 捕获** — 会话收尾与工具事件经 hook 转发到 `/observe`，落为 L0 observation：记忆捕获由平台担保，不依赖 agent 自觉
- **纪律区块** — CLAUDE.md 注入 `<!-- yongyi:begin --> … <!-- yongyi:end -->` 受管区块；区块外你的自有内容逐字不动，重复运行幂等（条目只存在一份）

断开：

```bash
yongyi disconnect claude-code
```

移除全部受管工件（挂载条目、hook 接线、纪律区块）；已写入的记忆仍在你的 u/ 根下，可召回、可在 Portal 管理——断开工具不删记忆。

### ZCode

```bash
yongyi connect zcode --url http://localhost:49375 --as you@example.com
```

与 claude-code 等价：MCP 挂载 + 捕获接线 + AGENTS.md 受管纪律区块，幂等语义相同；断开用 `yongyi disconnect zcode`。

### 任意 MCP 客户端

```bash
yongyi connect mcp --url http://localhost:49375
```

输出可直接粘贴进任意 MCP 客户端的 JSON 配置片段（服务 URL + 令牌引用方式），不写入任何特定工具的配置文件，也不内嵌明文平台令牌。

### Dify

```bash
yongyi connect dify --url http://localhost:49375 --as you@example.com
```

Dify 原生支持 HTTP transport 的 MCP 服务器，所以接入是配置而非适配：命令输出四段配方——① 添加 MCP 服务器的步骤（identifier 钉死 `yongyi`，改名会断掉已有引用）② 认证 header 指引（`Authorization: Bearer …`，令牌从 0600 凭据文件里取，配方正文不出现明文）③ 系统提示词纪律区块（整段粘贴到 Agent 应用）④ 验证清单（工具列表出现 `memory_write_page` / `memory_query` / `memory_recent` / `memory_handoff_begin` / `memory_handoff_list` 即通）。

诚实边界：Dify 没有回合 hook 面，**平台担保的自动捕获在那里不可达**——纪律提示词是 Dify 侧唯一的记忆写路径，记忆靠 agent 自觉写，不是平台担保。

```bash
yongyi disconnect dify
```

本命令给出 Dify UI 里的移除步骤并清理本侧凭据；记忆数据一页不动。

### Coze

```bash
yongyi connect coze --url http://localhost:49375 --as you@example.com
```

现状结论：**coze-studio 开源版没有 MCP client 能力**，平台侧无法把外部 MCP 服务器挂成工具，因此没有可执行的接入路径（跟踪 issue 见 [coze-dev/coze-studio#7](https://github.com/coze-dev/coze-studio/issues/7)、[#2079](https://github.com/coze-dev/coze-studio/issues/2079)、[#628](https://github.com/coze-dev/coze-studio/issues/628)）。这条命令输出的是侦察结论与备料：端点、身份根、person 令牌都先备好并落到 0600 凭据文件，等平台支持时直接用同一套 URL + 请求头，无需重新铸身份。它**不输出接入步骤，也不宣称已支持**。

### 框架（Python：LangChain / CrewAI / LlamaIndex）

用代码写的 agent 框架没有配置文件可改，但它们**有事件面**——所以捕获能在适配层担保：

```bash
pip install "yongyi-agent[langchain]"   # 或 [crewai] / [llamaindex]
```

```python
from yongyi_agent.langchain import callback_handler
handler = callback_handler()            # 令牌按 YONGYI_TOKEN → ~/.yongyi/credentials.json 解析
graph.invoke(inputs, config={"callbacks": [handler]})
```

工具调用与回合收尾自动上报到 `/observe`，不靠 agent 自觉写。核心包零第三方依赖（只用标准库），框架依赖走 extras；MCP 挂载配方（`langchain-mcp-adapters` / `llama-index-tools-mcp`）见 [python/README.md](python/README.md)。

三级捕获担保谱系：

| 级别 | 形态 | 保证 |
| --- | --- | --- |
| 平台担保 | 原生平台 | 平台每回合自动落 L0 |
| 适配层担保 | 框架 handler | 框架事件驱动自动上报 |
| agent 自觉 | UI 型平台（Dify） | 只有提示词纪律 |


### Portal（人面门户）

服务进程自带 `/portal`：浏览器打开、粘贴 person 令牌即登录，无需任何额外安装。

- **浏览 / 筛选**：按 scope / layer / tier / tag / 时间窗分页浏览你的记忆
- **纠错**：对任一记忆页发起更正，生成一条标注「更正」的 note；旧结论经蒸馏自动接替，原文保留可审计
- **晋升**：AI 提议的晋升候选要等你点头——接受才翻 tier（来源标记 human），忽略进冷却

### 换工具不换记忆

`--as` 绑定的是人根身份（`u/<id>`）：同一身份在多个 harness 接入，写入自动合流到同一 u/ 根。Claude Code 会话里记下的部署口径，在 ZCode 新会话的 digest 里直接可召回；跨来源的更正经蒸馏接替旧结论；每页带 harness 来源标注，Portal 可见。断开任何一个工具都不删记忆。合流只发生在同一 person 根内——deployment 根（d/<pack>/<member>）不参与，岗位私有分区不串门。

## 配置（生产）

环境变量全部可选（默认懒启动、零蒸馏）。

| 变量                            | 默认                                  | 用途                                     |
|-------------------------------|-------------------------------------|----------------------------------------|
| `FD_MEMORY_DATA`              | `~/Library/Application Support/fd-memory` | 数据目录（markdown 真源 + derived SQLite）   |
| `FD_MEMORY_HOST`              | `127.0.0.1`                         | 绑定地址（容器用 0.0.0.0）                    |
| `FD_MEMORY_PORT`              | `49375`                             | 服务端口                                   |
| `FD_MEMORY_PEPPER`            | dev default                         | token 散列散列（生产必改）                   |
| `FD_MEMORY_DISTILLER_URL`     | *empty*                             | 设了就启用蒸馏端点（不蒸馏整个案子仍然自由）           |
| `FD_MEMORY_DISTILL_ENABLED`   | *empty*                             | 蒸馏要过的第二门（fill 值 `1` 才生效）         |
| `FD_MEMORY_DISTILL_DAILY_TOKENS` | `600000`                     | 每日蒸馏 token 限额（护栏，非对账）            |
| `FD_MEMORY_DISTILL_U`         | *(on)*                              | u/ 根蒸馏开关（0 时人根零蒸馏）             |
| `FD_MEMORY_EMBED_KEEPWARM`    | *(on)*                              | embed 保温器（0 关闭）                    |
| `FD_MEMORY_DIGEST_HANDOFF_MAX_AGE_H` | `48`                        | 摘要交接段新鲜门槛（小时后不再签名通知段）       |
| `FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` | `3500`                    | embed 内管 deadline（超了直接降至关键词）    |

常用起法：

```bash
# 最小只读服务
FD_MEMORY_DATA=/var/lib/fdmm FD_MEMORY_HOST=0.0.0.0 fd-memory serve

# 完整（含蒸馏）
FD_MEMORY_DATA=/var/lib/fdmm FD_MEMORY_HOST=0.0.0.0 \
FD_MEMORY_DISTILLER_URL=http://fd-memory-distiller:8100 \
FD_MEMORY_DISTILL_ENABLED=1 \
fd-memory serve

# Docker（仓库内现成 Dockerfile）
docker build -t fd-memory . && docker run -v fdmm-data:/data -p 49375:49375 fd-memory
```

## 结构与测试

```
src/
  digest.ts            # 渲染器（预算纪律、行级 gist、去副、标题帽、接续去重、superseded 过滤）
  distill-scheduler.ts # 蒸馏器（write-trigger + fallback 扫描 + echo dedup + 磁盘发现式扫描）
  http.ts              # 全部服务面（/digest /pages /admin /mcp /metrics /forget /digest）
  mcp.ts               # MCP 工具定义与权限
  auth.ts / store.ts / db.ts / okf.ts / sanitize.ts / metrics.ts / embed-gate.ts / keepwarm.ts
scripts/
  eval-continue.mjs    # 继续性评估 harness（评估一个场景集，出硬门）
distiller/             # Python sidecar（LLM/嵌入调用——可以装起来也可以不装）

测试：`npm test`，70+ 单测（全部内置、无网络、mock sidecar）。
评估套件跑：`node scripts/eval-continue.mjs`（21 合成场景，判定门：headroom win ≥70% + 全集非劣 ≥70% + note-depth delta ≥1 分）。
```

## 文档

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — 部署教程（裸机/Docker/systemd/compose/K8s、反代路径封禁、备份升级、安全清单）
- [`docs/harness-integration.md`](docs/harness-integration.md) — Harness 接入指南（/observe API、connect 适配器、客户端 SDK、跨 harness 合流语义）
- [`docs/eval-continue.md`](docs/eval-continue.md) — 继续性评估 runbook（场景形状、门禁、当前成绩）
- [`docs/federation-recipe.md`](docs/federation-recipe.md) — 多 deployment 联邦与跨 deployment 记忆访问
- [`docs/spike-hook-wire.md`](docs/spike-hook-wire.md) — HTML 写入 hook 的开发思路（后续方向）

## 开源路线图

- [x] 代码结构清晰：3454 行 TS，dep 唯一 `yaml`，node:sqlite/node:test 内置，本地一条命令跑起来
- [x] 内部硬编码为零（src/ 无内部 IP/秘密/内部项目名）
- [ ] 公开 CI 通到公开镜像仓库（ghcr.io / Docker Hub）
- [ ] L0-L2 公开开发文档（当前 docs 是生产 runbook，面向运维）
- [x] 公开 NPM 包（已发布 `@finddatatechnology/yongyi`，`yongyi --help`）

## License

MIT — use it, change it, deploy it, sell it. Attribution welcomed but not required.
