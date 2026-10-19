# Spike：ai-memory hooks 线上协议（切片 4 前置，2026-10-19 实测）

## 结论（全量实证，方法=server profile 指向探针 + 读 spool 原文）

- **投递端点**：`POST <server_url>/hook?event=<event>&agent=<agent>&cwd=<urlencoded cwd>&ingest_key=<per-install uuid>`
- **鉴权**：`Authorization: Bearer <token>`（profile 静态 token，`server add --auth-token-stdin`）
- **body**：hook stdin JSON 原文（`{session_id, cwd, prompt|tool_name|tool_input, ...}`），尾部带换行
- **投递机制**：hook **永远先写本地 spool**（`<data>/hook-spool/*.json`：`{url, body, auth_mode:"static", token, attempts}`），由 watcher（本地 serve 时）或 **`ai-memory recover`**（无本地 serve 时）排空投递——失败安全、离线友好
- **profile 语义**：`server add <name> --url … --auth-token-stdin --root <允许目录>`；仓内 `.ai-memory.toml` `server = "<name>"` 选择；>1 profile 时 root 必填（按 cwd 匹配）
- **server 自报**：`POST /mcp, POST /hook`（serve 启动日志原文）

## 对切片 4 的意义

fd-memory 实现 `POST /hook` 兼容端点（query 解包→capture 事件映射→u/ namespace）后：本地 stock
ai-memory 节点仅需 `server add fleet --url http://<fd-memory> --auth-token-stdin --root ~/工作区`
+ 各仓 `.ai-memory.toml server="fleet"` + 定时 `ai-memory recover`，即全量接入舰队记忆——零改上游、
协议级联邦，「通用=格式+协议」论题的兑现路径。

## 附：7.2B 互读方向再评估

切片 2 遗留的 B 向阻塞（stock 冷导入缺失）**不阻塞联邦**：联邦双向都是活线（本地→舰队=capture
路由；舰队→本地=MCP 查询，切片 1 已证）；冷导入只影响存量历史批量迁移（`ai-memory backup` tarball
→ fd-memory 读 wiki 树，fd-memory 已具格式读能力）。7.2B 降级为可选迁移工具，非切片 4 前置。
