# OKF 3.0.0 兼容 fixture

来源：切片 1 试点数据目录（`~/Library/Application Support/ai-memory`，ai-memory 3.0.0 实产）+
两张按上游 `docs/okf.md` 格式手造的补充页（gotcha/decision，补足页面类型覆盖）。

- `wiki/sessions/381c42bb-….md` — 真实捕获会话页（CC 中止会话，frontmatter 含 session_id/agent/summary 扩展键）
- `wiki/log-2026-10.md` — 真实月度 ledger（`## [ts] event | title` 行，无 frontmatter）
- `wiki/_meta.md` — 项目清单
- `wiki/gotchas/*.md`、`wiki/decisions/*.md` — 手造格式样本（type/kind/tags/generated.by=human:*/sources）

用途：parse 往返保真、reindex 重建、与 stock ai-memory 互读（task 7.2）的基准数据。
