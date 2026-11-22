# Cursor 本地会话格式（实测）

change: add-harness-memory-import / 任务 0.2。本文是勘察产物，字段表来自**实测**，
不是猜的。所有值已脱敏，只保留键名与层级。

## 落点

```
~/.cursor/projects/<projectSlug>/agent-transcripts/<conversationId>/<conversationId>.jsonl
```

本机实测（2026-11-16）：`~/.cursor` 是 **Cursor CLI** 的数据目录
（`projects/ ai-tracking/ skills/ skills-cursor/ plans/ plugins/ terminals…`）；
桌面版落点 `~/Library/Application Support/Cursor/` **不存在**（本机没装 IDE）。

- `conversationId` 是 UUID，**目录名与文件名相同**（`<uuid>/<uuid>.jsonl`）。
- `projectSlug` 是工作目录把 `/` 换成 `-` 的结果
  （例：`Users-chengsishi-code-scraw-documents-process`）。**这个编码有损**：原目录名
  里本来就可能带 `-`，反解不能靠猜，只能近匹配 + 以 `first_user_message`/内容为准。

实测规模：**19 个会话文件 / 588 行 / 0 行不可解析**。

## 行格式（JSONL，一行一个对象）

每行的顶层键集合**唯一**（588/588 都是这两个键）：

```json
{"role": "assistant", "message": {"content": [ … ]}}
```

`message.content[]` 元素只有两种键集合（实测计数）：

| 键集合 | 条数 | 含义 |
|---|---|---|
| `("text", "type")` | 438 | 正文；`type == "text"` |
| `("input", "name", "type")` | 832 | 工具调用；`type == "tool_use"`，`name` 是工具名，`input` 是参数对象 |

`content.type` 取值只有 `text`(438) 与 `tool_use`(832)，**没有 tool_result 块**。

角色分布：`user` 56 / `assistant` 532。

工具名分布（前 12）：`Shell` 215、`ReadFile` 123、`ApplyPatch` 122、`Read` 102、
`Glob` 69、`StrReplace` 53、`Grep` 52、`TodoWrite` 22、`Write` 17、`WebSearch` 15、
`rg` 12、`WebFetch` 12。`input` 里出现过的键（即需要跳过的内容面）：
`command, contents, description, explanation, glob, glob_pattern, head_limit, limit,
merge, new_string, old_string, offset, output_mode, path, pattern, questions, replace_all,
required_permissions, search_term, shell_id, target_directory, task_id, title, todos, url,
working_directory`。

## 脱敏样本（键名/层级原样，正文与参数值替换为占位符）

```json
{"role":"user","message":{"content":[{"type":"text","text":"<用户提问，已脱敏>"}]}}
{"role":"assistant","message":{"content":[
  {"type":"text","text":"<助手正文，已脱敏>"},
  {"type":"tool_use","name":"Shell","input":{"command":"<命令，已脱敏>","description":"<说明，已脱敏>","required_permissions":["<perm>"]}}
]}}
```

## 两条必须写进提取器的结论

1. **文件里没有任何时间戳**。顶层键只有 `{role, message}`，全部 588 行都没有
   `time/ts/date/created` 之类的键（逐层扫过）。因此 `ExtractedTurn.ts` 只能：
   - 首选文件 mtime（实测样例 2026-03-10 / 03-11 / 03-13，与文件内顺序一致）；
   - `~/.cursor/ai-tracking/ai-code-tracking.db` 的 `conversation_summaries.updatedAt`
     理论上可给会话级时间，但**本机该表 0 行**，不能依赖。
   写文档/实现时不要把 `ts` 说成「源里有」。
2. **没有逐条消息 id**。行内没有 uuid/message-id 字段 ⇒ `sourceKey` 必须由
   `(conversationId, 行序号)` 或「规范化内容哈希」派生，且**不能**包含导入时刻
   （同 change 3.3 的要求：去重键不依赖导入时刻）。

## 提取口径

- 只取 `content.type == "text"` 的 `text` 作为 `ExtractedTurn.text`；`tool_use` 块整块丢弃
  （`types.ts` 的契约原话：「tool calls and reasoning blocks are excluded」）。
- `sessionId` = `conversationId`（UUID，兼作 `sourceFile` 的父目录名）。
- `sourceFile` = 绝对路径；`uuid` = `conversationId`（无逐条 id 时的退路），
  若需要逐条唯一则用 `conversationId:行序号`。
- `projectDir` 由 `projectSlug` 近匹配得到，**不要**声称可精确反解。
- 只读契约：以 `mode=ro` 打开（jsonl 直接只读），全程不写、不移动、不压缩。

## 相关落点（只作旁证，不作会话源）

`~/.cursor/ai-tracking/ai-code-tracking.db` 表：`ai_code_hashes`、`ai_deleted_files`、
`conversation_summaries`（列 `conversationId,title,tldr,overview,summaryBullets,model,mode,updatedAt`）、
`scored_commits`、`tracked_file_content`、`tracking_state`。本机 `conversation_summaries`
0 行 ⇒ 会话元数据不在库里，别把它当主源。
