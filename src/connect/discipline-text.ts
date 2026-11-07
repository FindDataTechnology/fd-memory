// Discipline block text, single source shared by every connect adapter
// (add-yongyi-complete-solution D4). The same managed-block markers wrap this
// text in CLAUDE.md and AGENTS.md, so one edit here updates all harnesses on
// the next `yongyi connect`. Bilingual by design (each point 中英对照); tool
// names stay ASCII because they are literal MCP tool names.

export const BLOCK_BEGIN = "<!-- yongyi:begin -->";
export const BLOCK_END = "<!-- yongyi:end -->";

export const MCP_SERVER_NAME = "fd-memory";

// The behavioral points. Tool names stay ASCII (literal MCP tool names); each
// line is self-contained so no markdown renumbering can reflow it. Only the
// mounting sentence differs per platform — the points are shared verbatim, so
// a harness file and a UI-configured platform (Dify) never drift apart.
export const disciplinePoints = [
  "会话收尾且本回合有有意义的工作时，先调 memory_handoff_begin 写交接，把情境通知下一位接手者。/ At session end, when the turn produced meaningful work, call memory_handoff_begin to write a handoff for the next agent.",
  "开场若可能是在续作（跨会话回来），先 memory_handoff_list 查未竟交接；有指名给自己的就用 memory_handoff_accept 认领后再动手。/ At session start, when the work may be a continuation, call memory_handoff_list first; if a handoff is addressed to you, claim it with memory_handoff_accept before working.",
  "用户明确说「记住」，或你学到跨会话有价值的偏好/事实时，用 memory_write_page 落页；写前先 memory_query 查重，更新既有结论时写更正 note 并标明「更正」。/ When the user explicitly says \"remember\", or you learn a durable cross-session preference/fact, write it with memory_write_page; memory_query first to dedup, and when correcting an existing conclusion mark the note as a correction.",
  "读资料库/参考文档时，把与本职相关的要点消化后用 memory_write_page 记下并注明出处；原样照抄不算记忆。/ When reading reference material, distill the points relevant to your job into memory_write_page with the source noted; verbatim copying is not memory.",
];

const HOOK_HARNESS_MOUNT =
  "永忆（fd-memory）已挂载到本 harness；工具名一律为 mcp__fd-memory__*。/ fd-memory is mounted in this harness; its tools are always named mcp__fd-memory__*.";

// Mounting sentence for UI-configured platforms (Dify): the platform imports
// MCP tools under its own listing, so claiming the mcp__fd-memory__* prefix
// here would be a lie the agent cannot verify.
const PLATFORM_MOUNT =
  "永忆（fd-memory）的 MCP 工具已挂载到本应用，工具以 memory_* 的名字出现在工具列表里。/ fd-memory MCP tools are mounted in this app and appear in the tool list as memory_*.";

// The discipline body. Keep every line self-contained (no list numbering that
// reflows); the appliers wrap it verbatim between the markers.
export const disciplineText = [HOOK_HARNESS_MOUNT, ...disciplinePoints].join("\n");

// Same points, platform-correct mounting sentence — what `connect dify` prints
// for pasting into an Agent application's system prompt.
export const platformDisciplineText = [PLATFORM_MOUNT, ...disciplinePoints].join("\n");

// The exact managed region appended to CLAUDE.md / AGENTS.md.
export function managedDisciplineBlock(): string {
  return BLOCK_BEGIN + "\n" + disciplineText + "\n" + BLOCK_END + "\n";
}
