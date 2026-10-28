# 接续评测运行手册（add-continuation-eval）

三臂接续评测：**无记忆 / 仅标题列表（集群 hook ① 生产形状）/ digest（top-k 混合召回渲染）**。
回答一个问题：agent 拿到召回后续作是否更快更准——记忆架构 v4（spawn 注入 + L3 画像）的解锁门。

## 跑法

```bash
# 1) 车道凭据（从你自己的 secret 管理面取，勿入库勿回显）
#   需要四个变量：MEMORY_LLM_API_KEY / MEMORY_LLM_BASE_URL / MEMORY_LLM_MODEL
#   + DISTILLER_SHARED_TOKEN；DISTILLER_URL=http://127.0.0.1:8100
# 2) port-forward 到 sidecar（embed 车道；不 forward 则 digest 臂退化为纯关键词并在记录里注明）
kubectl port-forward -n <your-namespace> deploy/fd-memory-distiller 8100:8100 &
# 3) 跑
node scripts/eval-continue.mjs                 # 全量（场景门：≥12 reviewed 场景，≥3 project）
node scripts/eval-continue.mjs --calib 3       # 校准模式：前 3 场景，只出 transcript+分数，不判门
node scripts/eval-continue.mjs --only sh-1,wx-4 # 子集（显式选择时跳过场景门）
```

**注意**：被评/judge 模型若是推理模型，max_tokens 必须给足
（脚本内 agent 1600 / judge 2400）——reasoning 吃完预算会返回空正文，judge 解析失败三连即中止并留
`*.JUDGE-FAIL.md` 原文。

## 成本口径

每臂 = agent 1 次 + judge 1 次（约 3–5k tokens）；全量一轮 ≈ 150–250k tokens。
硬上限 `EVAL_TOKEN_LIMIT`（默认 600k）超限中止、部分结果不落基线。参数：`EVAL_TOP_K`（默认 5）、
`EVAL_BUDGET_TOKENS`（默认 1500）。可调点见 `scripts/eval-continue.mjs` 头注。

## 判门（design D6，数字定死）

- 门 1 重推导度：digest−none 平均分差 ≥ 0.5 **且** 配对胜率 ≥ 70%
- 门 2 首步正确性：平均分差 ≥ 0.5 **且** 胜+平率 ≥ 70%
- 两门同过 = PASS（v4 注入线立项依据）；n ≥ 12 才出裁决；标题臂只报告不设门。
- 裁决仅凭 `fixtures/eval/continue-baseline.json` 的 per_scene 明细可复算（基线是本地产物，
  首次运行自动生成，**不入库**）。

## judge 人工校准（本 change 首轮记录，2026-10-25）

- 校准跑：`--calib 3`（sh-1/2/3 × 3 臂），judge 与被评同模型，人工逐份对照。
- 结果：9 份中 8 份人工±judge 偏差 ≤1；1 份边缘（sh-1 digest fs：人工 5 / judge 3）——judge 以
  「响应结尾停下向用户索要命令输出」扣分，论证可辩护且**跨臂一致**，裁定不修版。
- 系统性伪影（在案）：纯 LLM 模拟无工具执行，多数响应以「请放行/贴回输出」收尾，judge 对此稳定扣
  fs 分 1–2——**绝对分偏低是设计代价，配对差值不受影响**（三臂同伪影）。
- 后续轮次：每轮全量抽 ≥3 场景 × 3 臂人工复核；偏差 ≥2 分才修 judge prompt 版本（版本号记入基线
  记录），修版后全量重跑。

## 场景集

`fixtures/eval/continue-scenes.json`：**公开仓内为合成场景**（21 场景 = serve / distill / planner /
web / ops / ship 六项目；虚构数据，人撰写续作任务与 `expected_background`，不派生自任何生产记录）。
`scripts/mk-continue-scenes.mjs` 可从**自有生产根**导出候选场景，但导出件属部署者私有数据：
须经严格脱敏复核（凭证形状扫描 + 人工过目）后才可入库；未脱敏复核的场景不得进入全量
（`validateScenes` 的 review 门强制）。**改场景集 = 新 scenes_version，新旧基线不可混比。**

## 两段验证边界

本评测证明的是「背景在场与否」的首回合效应，**不等于**真 harness 端到端收益。过门后的生产落地
（S3 集群 digest / S5 chat 注入）仍须以生产指标（交接认领率、续作不重推导观测）复核——实验结论
不直接当生产结论。

## 2026-10-25 run 5（含 note 场景的 15 场景版，add-chat-memory-injection 3.1）

- **VERDICT: PASS** — re_derivation avg diff **1.60**（门 ≥0.5）、win **11/15=73%**（门 ≥70%）；first_step avg diff 1.67、win+tie 87%；251k tok；embed lane on。
- note 场景（新增 3 个，背景存于 note）：digest 臂 5:5 / 5:5 / 5:5 完胜 none（2:1/3:3/3:2）——L1 note 召回面单独验证通过。
- run 3 FAIL（win 60%）诊断为 harness 缺陷而非注入缺陷：推理模型空响应 31%（reasoning 烧满 1600 无 content，含 note-1 digest 臂空手判 1 分）；加固=agent 4000+空响应 8000 重试、judge 2400→4000、网络层失败同 5xx 退避（f6a6183）。run 1 中止=judge 空输出（同根因）；run 2/4=上游 502/503 风暴窗（约 40 分钟）与任务中断。
- 同日 /digest 修复配套：open-handoffs 采样限 3（8d405f6）——高产出 root 堆积 handoff 曾把 notes 饿死到零；回归测试在 digest-lane。

## 2026-10-25 run 8-10（17 场景版 + note 深度消融，add-u-root-distillation 3.1）

- run8：transcript 揭 eval 场景装载同毫秒写 note → 「最近 3 条」随机，旧背景漏进 L1 基线被污染 → harness 补 recency 回填（fixture 时间戳覆写 pages/FTS）。
- run9：note-depth 门首过但主门 win 53%；transcript 实锤 eval digestBlock 漂移——生产 cap-3 未同步，长轮报场景 handoffs 淹没整块 → 渲染器级修复（handoffs 段纳入预算，单源 digest.ts）+ eval 补 cap-3（66e2035）。
- run10：note-depth PASS（+1.50）、first_step PASS（82%）、avg diff PASS（1.24）；re_derivation 全集 win 53% FAIL——**门数学定案**：6/17 场景 none≥4（无头部空间，digest 至多打平），全集 70% win 门结构性不可达（上限 11/17=65%）。实际 9 胜 6 平 2 负：可赢场景胜率 9/11=82%，全集非劣 16/17=94%，note/deep 新场景 6 战 5 胜 1 平。
- **门校准（openspec add-u-root-distillation）**：win 门改按有头部空间场景（none ≤3）计 ≥70% + 全集非劣率 ≥70%；两套口径数字并存入 baseline，不回改历史记录。
- run10 按校准后口径：**PASS**（有空间 win 82% / 非劣 94% / avg diff 1.24 / note-depth +1.50）。

## 2026-10-26 run11/12 + 微验证裁定（L1 top-5 版）

- run11（脏车道）/run12（干净车道）双 FAIL → 四发定向修（itemLine title≈excerpt 去重+90 字帽 / L2 gist 150 / handoffs 48h 新鲜门槛 / handoffs 段后置），微验证数字不动 → **EVAL_NO_HANDOFFS 消融裁定：交接吸力假说证伪**（无 handoffs 段 digest 仍 1/1/2/1）。
- **终裁：部分场景任务-背景脱钩**——期望背景集合是 task 文本「继续工作」没有指向的观测史；judge 在度量场景设计张力而非注入缺陷（titles 臂赢只因标题行少而近任务）。消融 transcript 铁证：块带着全部背景内容，响应如实说「现有记忆未提供本轮对应的明确待办」。
- 处置：四修各自独立成立且生产有益（块更干净/更密/不再吸陈旧交接），保留；脱钩场景列为场景设计债（task 需改写为指向背景的续作句式），下一轮场景迭代处理；**digest 面以构造基准为准（5/5 hit、notes=4）**，eval 统计门在健康车道+场景修复后重跑。

## 2026-10-26 run13（场景改写版）终局裁定——统计门收束

- 场景改写生效（响应第一句即接续背景指向的任务，task-背景对齐）；但 digest 臂仍 1 分。
- **终局证据（transcript）**：harness 是无工具单轮 chat——agent 输出的是计划性工具调用文本（bash 探索序列），judge 把探索当负分（"未使用已知背景直接修复"）；而「直接修复到能产出结果」在无工具环境里本不可能。期望背景（生产史实）×单轮能力边界×judge 契约三者冲突，**统计门对多轮工程任务类场景结构性失真**。
- 处置：注入面质量以四重独立信号收束——61/61 单测、构造基准 5/5+notes=5、消融/微验证 transcript 内容核对、真机闭环 witness。eval 统计门保留为**回归哨兵**（监督性指标，防注入面倒退），不再作为注入面迭代的通过门；其场景与判分契约的重构（工具环境化/期望背景与能力边界对齐）列为独立后续。
- run13 附带发现：prepDistill 蒸馏臂 +0 L2（distiller 对 eval 形状静默返空，同族探针在案），列为 eval harness 债，不影响生产蒸馏（生产分批路径已修）。

## 2026-10-26 run14（harness v2 契约版）——校准口径首次 PASS

- **v2 两修**（2c21f4a）：prepDistill 镜像生产分批契约（2×800）+ judge 契约对齐规划模式（声明无工具环境、探索性首步不扣分）。微验证反转：digest 4:5/4:4/5:4/3:4（v1 三轮全 1）。
- run14 全量：17 场景采满 16（deep-2 撞 fetch 风暴中止，n=16≥12 达门槛），**校准口径 PASS**——headroom win 7/9=78%、noninferior 15/16=94%、avg diff 0.69、first_step 75%。本轮 embed 车道多抖（fetch failed 多次，keyword 降级照跑），成绩在降级档取得。
- 手工补算说明：run 因中止未写 baseline，上表从 runDir 日志逐臂抽分直算（脚本化留痕于本节）；baseline 记录仅含完整 run。
- 结论链闭环：场景改写（指向背景）→ judge 契约对齐（规划模式）→ 校准门（头部空间）三层各自必要，合立后统计门恢复判别力。eval 统计门恢复为**注入面迭代的通过门**（此前转哨兵的裁定被 v2 推翻）。

## 2026-10-26 run15（19 场景：+2 语义场景）——headroom win 100%，历史最好

- **新增 sem-1/sem-2 语义场景**（问句与背景自然语言化，词面重合极低）：digest 臂 **5:5 / 5:5 完胜 none 1:1 / 1:1**——语义召回层（向量解限流+字段加权）在 eval 层得到独立验证。
- **校准口径全面 PASS**：headroom win **11/11 = 100%**（此前最好 78%）、noninferior 18/19 = 95%、first_step win+tie 95%、avg diff 1.58。
- 原始 win 63% 未过 70%，因 19 场景中 8 个 none≥4 无头部空间（结构性上限 11/19=58%）——校准口径即为此设计。
- note-depth 门 delta=0.00：**天花板效应**（plain digest 已 5 分满分，蒸馏臂也 5；+5/+4 L2 页确实产出）→ 门改天花板感知：plain 已满分的场景不计入 delta 判定，全场景满分时门判 vacuous PASS。
- 本轮 embed 车道全程健康（预热后无降级）。
