# ── 纪律文本（跨语言单源，金样钉住） ─────────────────────────────────────────
#
# 本常量与 TypeScript 侧 `platformDisciplineText` 逐字节一致：
#   · TS 侧测试断言 platformDisciplineText == tests/goldens/discipline-platform.txt
#   · 本侧测试断言 DISCIPLINE == tests/goldens/discipline-platform.txt
# fixture 由 scripts/emit-discipline-golden.mjs 从 TS 单源生成，禁手写。
# 任何一侧单独改动都会让另一侧变红——修法只有一条：改 TS 单源、重新生成。
#
# 为什么是「平台版」而不是 harness 版：框架把 MCP 工具转成自己的 tool 对象，
# 工具名不是 mcp__fd-memory__*，所以不能给 agent 一个它验证不了的前缀。

DISCIPLINE = (
    "永忆（fd-memory）的 MCP 工具已挂载到本应用，工具以 memory_* 的名字出现在工具列表里。/ "
    "fd-memory MCP tools are mounted in this app and appear in the tool list as memory_*.\n"
    "会话收尾且本回合有有意义的工作时，先调 memory_handoff_begin 写交接，把情境通知下一位接手者。/ "
    "At session end, when the turn produced meaningful work, call memory_handoff_begin to write a handoff for the next agent.\n"
    "开场若可能是在续作（跨会话回来），先 memory_handoff_list 查未竟交接；有指名给自己的就用 memory_handoff_accept 认领后再动手。/ "
    "At session start, when the work may be a continuation, call memory_handoff_list first; if a handoff is addressed to you, claim it with memory_handoff_accept before working.\n"
    '用户明确说「记住」，或你学到跨会话有价值的偏好/事实时，用 memory_write_page 落页；写前先 memory_query 查重，更新既有结论时写更正 note 并标明「更正」。/ '
    'When the user explicitly says "remember", or you learn a durable cross-session preference/fact, write it with memory_write_page; memory_query first to dedup, and when correcting an existing conclusion mark the note as a correction.\n'
    "读资料库/参考文档时，把与本职相关的要点消化后用 memory_write_page 记下并注明出处；原样照抄不算记忆。/ "
    "When reading reference material, distill the points relevant to your job into memory_write_page with the source noted; verbatim copying is not memory."
)
