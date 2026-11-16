# Codex 本地会话格式（实测 + 本机限制）

change: add-harness-memory-import / 任务 0.2。字段表来自**实测**（`pragma_table_info` 与
`sqlite_master.sql`），不是猜的。**本机没有会话数据**，原因见末节——这一节比样本本身重要，
不写清楚下一个人会以为是提取器写错了。

## 落点

```
~/.codex/state_5.sqlite     ← 会话索引（SQLite，另有 -shm / -wal 边车）
~/.codex/logs_2.sqlite      ← 诊断日志（不是会话）
~/.codex/sqlite/codex-dev.db ← automations / inbox（本机全 0 行）
```

`codex` 是 Homebrew 安装的 npm 包 `@openai/codex` **0.128.0**（`/opt/homebrew/bin/codex`）。

## `threads` 表（会话索引，实测 DDL）

```sql
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, …
)
```

全部 26 列：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 线程 id |
| `rollout_path` | TEXT NOT NULL | **会话正文所在文件的路径**（正文不在库里） |
| `created_at` / `updated_at` | INTEGER NOT NULL | 时刻；**单位未证**（本机 0 行，秒与毫秒都可能） |
| `source` | TEXT NOT NULL | 来源标记 |
| `model_provider` / `model` / `reasoning_effort` | TEXT | 模型侧 |
| `cwd` / `git_sha` / `git_branch` / `git_origin_url` | TEXT | 工作目录与 git 上下文 |
| `title` / `first_user_message` | TEXT | **首条用户消息单独存一列**（可当项目归属的旁证） |
| `tokens_used` | INTEGER | 用量 |
| `has_user_event` / `archived` / `archived_at` | INTEGER | 状态 |
| `sandbox_policy` / `approval_mode` | TEXT | 运行策略 |
| `cli_version` | TEXT | 产出版本 |
| `agent_nickname` / `agent_role` / `agent_path` / `memory_mode` | TEXT | 角色/记忆档 |

其它表（本机行数）：`jobs` 0、`agent_jobs` 0、`agent_job_items` 0、`thread_goals` 0、
`thread_dynamic_tools` 0、`stage1_outputs` 0、`backfill_state` 1、`thread_spawn_edges` 0、
`remote_control_enrollments` 0。

## `logs_2.sqlite.logs`（诊断日志，**不是**会话源）

实测 1965 行，列：`id, ts, ts_nanos, level, target, feedback_log_body, module_path,
file, line, thread_id, process_uuid, estimated_bytes`。

真样本一条（脱敏，只留形状）：

```
id=<int>  ts=<int:1779952636…>  ts_nanos=<int:504809000>  level="DEBUG"
target="opentelemetry_sdk…"  feedback_log_body="<日志正文，已脱敏>"
module_path="opentelemetry_sdk::metri…"  file="/Users/runner/.cargo/reg…"  line=<int>
thread_id=<NULL>  process_uuid="pid:<n>:<uuid>"  estimated_bytes=<int>
```

两条可读结论：
- `ts` 是 **epoch 秒**（该行 ts 与 `logs_2.sqlite` 的 mtime 2026-05-28 吻合），`ts_nanos`
  是纳秒余数。**别把 ts 当毫秒**（同族坑见「epoch 毫秒 vs ISO 串」那条记忆）。
- `thread_id` 可为 NULL ⇒ 日志行不能当会话归属的依据。

## 本机为什么没有样本（重要）

- `threads` **0 行**；`~/.codex/sessions/` 与 `~/.codex/rollouts/` **目录不存在**；
  全盘 `find ~/.codex -name '*rollout*'` 无命中。
- `codex --version` 直接失败：

  ```
  Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT
  ```

  即 **npm 包装了、vendored 原生二进制缺失** ⇒ 这台机从没成功跑起 Codex，
  自然没有线程，也就没有 rollout 文件。

因此本轮**产不出 Codex 的真实会话样本**（区别于 Cursor：那边 19 个文件 588 行可读）。
补齐条件写死在这里，别含糊：装好 `@openai/codex` 的 `codex-darwin-arm64` 原生包、
跑一次会话产生 1 个 thread 之后，用下面的方法抓样本：

```bash
sqlite3 -readonly ~/.codex/state_5.sqlite \
  "select id, rollout_path, created_at, updated_at from threads limit 1"
head -c 2000 "$(sqlite3 -readonly ~/.codex/state_5.sqlite 'select rollout_path from threads limit 1')"
```

## 提取器要守的（推断面已标注）

- **正文只从 `rollout_path` 读**，`threads` 行只提供 `id / cwd / created_at / title /
  first_user_message` 等元数据。`rollout_path` 是 `NOT NULL` ⇒ 空线程不会出现。
- `sessionId` = `threads.id`；`uuid` 用 rollout 文件里的逐条 id（格式待样本确认，
  **未验**）；`ts` 用 rollout 行内时刻，缺失时退 `threads.updated_at`（**单位待确认**，
  本机无行不可证）。
- `projectDir` 可由 `cwd` 直接得到（比 Cursor 的 slug 可靠）。
- 只读契约：SQLite 以 `mode=ro` + `busy_timeout` 打开（该库有 `-wal`，可能正在写），
  rollout 文件只读、不移动。
- **失败要响**：`threads` 有行但 `rollout_path` 指向的文件不存在时，必须非 0 退出并点名
  路径（这是「索引在、正文没了」的形态，不能静默当成 0 条）。
