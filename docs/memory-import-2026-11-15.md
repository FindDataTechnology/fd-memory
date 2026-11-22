# 变更总结：多智能体记忆系统（2026-11-15）

## 一句话

把永忆从「只能从现在起记」变成「能接住已有记忆，并送到新工具眼前」——同时补上唯一一处没有真源的数据。

## 为什么做

起因是一次事故排查：本机 ZCode 舰队（30 并发）在重启后静默停摆 1 小时。查下去发现根因不是重启，而是 **SQLite 在多写入者下撑不住**：

```
失败回合 model_request_count = 0    → 模型请求没发出去
单回合直跑   Error: database is locked
CLI 内建     busy_timeout = 25 毫秒
库           8.4 GB，WAL 448 MB 无法 checkpoint
当天 locked  1,275 次
对照         30 并发全失败 / 8 并发仍 75% 失败 / 1 并发成功
```

但真正推动这次变更的是另一个发现：**永忆只能"从现在起"记**。`src/connect/hook-forward.ts` 第一行注释写着 "reads a harness hook event JSON on stdin"——它是实时事件流，接不住用户接入之前的全部历史。

而"记忆绑死在某个工具里"的真正含义，恰恰是这个。

## 做了什么（四阶段）

### 阶段一：L0 补真源

**发现**：`observe.ts` 走 `/observe` 那条一直有 markdown 真源；但 `capture.ts` 的 hook 捕获只写 SQLite 的 `observations` 表——**那是唯一一段没有真源的数据**，换后端即丢。

```
写路径   真源(append-only JSONL) → 索引(SQLite)   索引失败只降级，不丢事件
恢复     yongyi replay --root <key>               从真源重建索引
```

实测：写真源 → 清空索引 → replay → 3 条全恢复，顺序一致。

### 阶段二：Claude Code 导入

```
提取  28 文件 / 46,755 行 / 0 解析失败 / 334ms → 1,554 条会话回合
筛选  保留 32 条（1.9%）
导入  幂等、增量、分批、可中断
```

**规则迭代四次**（20.4% → 6.6% → 4.2% → 2.2%），每次都是靠真实数据抽查发现的：

| 修正 | 原因 |
|---|---|
| 噪声过滤（7 类） | slash command 回显、skill 正文被当用户输入 |
| `explicit-remember` 只认用户侧 | 助手复述"记住"不算记忆 |
| `handoff` 只认用户侧 | 助手自己的"下一步"不算交接 |
| 信封检测（全文） | `<task-notification>` 走了 user lane |

### 阶段三：送达面

```
受管区块   <!-- yongyi:memory:begin --> … end
不变量     区块外逐字不动 / 幂等 / 断开逐字恢复 / 记忆保留
硬边界     不碰 harness 会话历史（JSONL 链、SQLite 消息表）
```

**为什么不做注入**：实测两个目标都脆弱——Claude 的 JSONL 是 uuid/parentUuid 链，断链无法 resume；ZCode 的库 8.4 GB + 25ms 锁窗口且舰队在写，再加写入者只会加剧故障。

### 阶段四：ZCode 导入

全库实测：

```
852,426 条消息 / 8.5 GB / 顺序扫描 46 秒
user 消息        269,109
正文片段(type=text)  9,973
非 synthetic       3,001   ← 91.4% 被 ZCode 自己的标记滤掉
最终保留            1,034   （抽样 3,000 条）
```

**关键发现**：ZCode 的 `part.synthetic` 是它官方打的注入标记。对比 Claude Code 那边要靠猜 XML 信封试错四轮，ZCode 直接把答案写在数据里。

## 三个值得记住的教训

### 1. 慢的时候先看查询计划，别先怪数据量

```
select data ... where time_created > ?   →  SCAN message（全表）  2000 行 30 秒
select id   ... where time_created > ?   →  COVERING INDEX        2000 行 0.31 秒
两步法（先 id 后 data）                    →                    2000 行 0.67 秒
```

`data` 平均只有 1 KB。差 45 倍不是因为数据大，是 `time_created` 没有打头的索引导致全表扫。差点让我在设计里写下"ZCode 需要分批慢跑"这个错误结论。

### 2. 单测全绿 ≠ 规则可用，抽样估算 ≠ 全量实跑

- Claude 规则：单测全绿，真实数据跑出 20.4% 噪声
- ZCode 比例：抽 3000 条估出 1.9% 真人内容，全量实跑是 8.6%（差 4.5 倍）

**86 秒能跑完的事，不该靠猜。**

### 3. 用对方自己的标签，不要用模式匹配

ZCode 的 `synthetic` 是官方标记，一次滤掉 91.4%。Claude Code 没有这个字段，只能靠信封和前缀猜，试错四轮。

**先问「数据里有没有现成的判定依据」，再考虑自己写规则。**

## 代码量

```
新增  src/connect/import/        1,125 行（5 个模块）
新增  src/test/                  765 行（4 个测试文件）
改动  src/store.ts +50 / db.ts +59 / capture.ts +11 / index.ts +106
```

测试：**301 个，300 通过**。唯一失败的是 `agent-memory-foundation` 的 `/digest meta filter`，用 `git stash` 验证过**基线就红**，与本次无关。

## 怎么用

```bash
# 1. 看会导入什么（不写任何东西）
yongyi import claude-code --root <rootKey> --dry-run
yongyi import zcode       --root <rootKey> --dry-run --limit 3000

# 2. 导入
yongyi import claude-code --root <rootKey> --project default
yongyi import zcode       --root <rootKey> --project default --limit 3000

# 3. 送到 harness 会读的文件
yongyi deliver --root <rootKey> --project default --file ./CLAUDE.md

# 4. 索引丢了从真源重建
yongyi replay --root <rootKey>
```

## 明确的边界

**没做**：

- 注入式写回（往 harness 会话历史插消息）——风险与收益不成比例
- Cursor / Codex 提取器——本地格式未勘察，工作量未知
- 双向同步——送达已经覆盖"新工具看到旧记忆"的需求

**已知局限**：

- harness 已清理的历史无法导入
- 工具调用的输入输出不入库（体量大、信噪比低）
- ZCode 全库跑完约 46 秒 + 规则匹配时间，84 万条全量估计 5–10 分钟

## 下一步建议

**先实际用一次，再决定扩不扩。** 具体建议：

1. 在真实项目上跑 `import` + `deliver`
2. 开一个新会话，看送达的记忆是否真的帮上忙
3. 如果记忆质量不够，调筛选规则（`src/connect/import/rules.ts` 是单点）
4. 如果够用，再考虑 Cursor/Codex

理由：现在导入的记忆是**几百到几千条**，质量还未经真实使用检验。继续堆 harness 之前，应该先确认这批记忆有用。

## 相关的 openspec change

| change | 角色 | 进度 |
|---|---|---|
| `add-harness-memory-import` | 主线：导入 + 送达 | 27/34 |
| `yongyi-multi-agent-memory-plane` | 前置：存储分层 | 阶段一完成 |

两者都通过 `openspec validate --strict`。
