# 永忆（YongYi）

**面向 AI Agent 与 Multi-Agent 平台的长期记忆服务。**
Working memory for agentic platforms — durable, layered, self-distilling memory as a service.

永忆（YongYi，fd-memory 的产品品牌）是一个为**智能体 / 多智能体系统**设计的长期记忆基础设施：把「一个 agent 过去知道的一切」变成**每回合都可召回**的结构化知识，支撑跨平台部署与多 agent 协同。

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
- **NPM 包**：`npm pack` 一件脱机交付（src + scripts + Docker + fixtures）；发布面定型 `@deepseek-ai/yongyi`（`yongyi --help`）

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
评估套件跑：`node scripts/eval-continue.mjs`（19 场景，判定门：headroom win ≥70% + 全集非劣 ≥70% + note-depth delta ≥1 分）。
```

## 文档

- [`docs/eval-continue.md`](docs/eval-continue.md) — 继续性评估 runbook（场景形状、门禁、当前成绩）
- [`docs/federation-recipe.md`](docs/federation-recipe.md) — 多 deployment 联邦与跨 deployment 记忆访问
- [`docs/spike-hook-wire.md`](docs/spike-hook-wire.md) — HTML 写入 hook 的开发思路（后续方向）

## 开源路线图

- [x] 代码结构清晰：3454 行 TS，dep 唯一 `yaml`，node:sqlite/node:test 内置，本地一条命令跑起来
- [x] 内部硬编码为零（src/ 无内部 IP/秘密/内部项目名）
- [ ] 公开 CI 通到公开镜像仓库（ghcr.io / Docker Hub）
- [ ] L0-L2 公开开发文档（当前 docs 是生产 runbook，面向运维）
- [ ] 公开 NPM 包（fd-memory 当前 `private: true`，准备作为 `@deepseek-ai/fd-memory`）

## License

MIT — use it, change it, deploy it, sell it. Attribution welcomed but not required.
