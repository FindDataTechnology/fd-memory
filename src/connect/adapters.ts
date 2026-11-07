// Harness adapters (add-yongyi-complete-solution D4, tasks 3.2–3.7): per
// harness a pure generator (config objects + managed block text) and an
// applier (marker-aware merge into the target files; idempotent; everything
// outside the managed region preserved byte-for-byte).
//
// Write targets are parameterized (homeDir/projectDir) so tests run against
// temp directories. Defaults follow the real shapes probed on a live machine:
//   claude-code → ~/.claude.json (mcpServers), ~/.claude/settings.json
//                 (hooks.<Event>), ./CLAUDE.md (project scope)
//   zcode       → ~/.zcode/cli/config.json (mcp.servers + hooks.<Event>),
//                 ./AGENTS.md (project scope)
// Both harnesses keep the same hook-entry schema: { matcher, hooks:
// [{ type: "command", command, timeout }] } inside hooks.<EventName> arrays.

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { upsertManagedBlock, removeManagedBlock } from "./managed-block.js";
import { MCP_SERVER_NAME, managedDisciplineBlock, disciplineText, platformDisciplineText } from "./discipline-text.js";
import type { Harness } from "./credentials.js";

export interface ConnectTargets {
  homeDir: string;
  projectDir: string;
  binName: string; // hook command head, normally "yongyi"
}

export type FileAction = "created" | "updated" | "unchanged" | "removed" | "absent";

export interface FileWrite {
  path: string;
  action: FileAction;
}

export interface ConnectReport {
  harness: Harness;
  namespace: string;
  rootKey: string;
  token_reused: boolean;
  mcp_url: string;
  snippet?: string; // `connect mcp` only
  files: FileWrite[];
}

export const HOOK_EVENTS = ["SessionStart", "Stop", "PostToolUse"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

const KEBAB: Record<HookEventName, string> = {
  SessionStart: "session-start",
  Stop: "stop",
  PostToolUse: "post-tool-use",
};

export function mcpUrlFor(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/mcp";
}

// Pure generator: the MCP server entry. The person token appears ONLY as an
// environment-variable reference — never a literal (spec: 不内嵌明文令牌).
export function mcpServerEntry(baseUrl: string, envVar: string): Record<string, unknown> {
  return {
    type: "http",
    url: mcpUrlFor(baseUrl),
    headers: { Authorization: "Bearer ${" + envVar + "}" },
  };
}

function hookCommand(targets: ConnectTargets, harness: Harness, event: HookEventName): string {
  return `${targets.binName} hook ${harness} ${KEBAB[event]}`;
}

// Pure generator: the hook wiring entry for one event.
export function hookEntry(targets: ConnectTargets, harness: Harness, event: HookEventName): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [{ type: "command", command: hookCommand(targets, harness, event), timeout: 10 }],
  };
}

function isOurHookEntry(entry: unknown, prefix: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every(
    (h) => typeof (h as { command?: unknown })?.command === "string" && (h as { command: string }).command.startsWith(prefix),
  );
}

function writeJson(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

// Read-modify-write a JSON file. `changed` compares structure, so re-running
// connect on an already-formatted file never rewrites it (idempotency).
// `removedLabel` renames the action when the mutation removes our artifacts
// (disconnect reporting), defaulting to "updated".
function applyJson(path: string, mutate: (doc: Record<string, unknown>) => void, removedLabel: FileAction = "updated"): FileWrite {
  const existed = existsSync(path);
  let doc: Record<string, unknown> = {};
  if (existed) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`connect: target file is not valid JSON: ${path}`);
    }
  }
  const before = JSON.stringify(doc);
  mutate(doc);
  if (JSON.stringify(doc) === before) return { path, action: "unchanged" };
  writeJson(path, doc);
  return { path, action: existed ? removedLabel : "created" };
}

// Apply a JSON-file object-map entry (mcpServers / mcp.servers).
function applyServerEntry(path: string, containers: string[], entry: Record<string, unknown>): FileWrite {
  return applyJson(path, (doc) => {
    let node = doc;
    for (const key of containers) {
      if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[MCP_SERVER_NAME] = entry;
  });
}

function removeServerEntry(path: string, containers: string[]): FileWrite {
  if (!existsSync(path)) return { path, action: "absent" };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { path, action: "absent" };
  }
  const before = JSON.stringify(doc);
  // Walk the container chain keeping references, delete the entry, then drop
  // now-empty ancestors bottom-up (never the document root itself).
  const chain: Array<{ parent: Record<string, unknown>; key: string; node: Record<string, unknown> }> = [];
  let node: Record<string, unknown> | undefined = doc;
  for (const key of containers) {
    const next = node?.[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) { node = undefined; break; }
    chain.push({ parent: node!, key, node: next as Record<string, unknown> });
    node = next as Record<string, unknown>;
  }
  if (node) {
    delete node[MCP_SERVER_NAME];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (Object.keys(chain[i].node).length === 0) delete chain[i].parent[chain[i].key];
      else break;
    }
  }
  if (JSON.stringify(doc) === before) return { path, action: "unchanged" };
  writeJson(path, doc);
  return { path, action: "removed" };
}

function hookPrefix(targets: ConnectTargets, harness: Harness): string {
  return `${targets.binName} hook ${harness} `;
}

// Merge our hook entry into hooks.<Event> arrays — one entry per event, no
// duplicates on re-run (spec scenario: 幂等重跑).
function wireHooks(doc: Record<string, unknown>, targets: ConnectTargets, harness: Harness): void {
  if (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) doc.hooks = {};
  const hooks = doc.hooks as Record<string, unknown>;
  if (harness === "zcode" && hooks.enabled === undefined) hooks.enabled = true;
  const prefix = hookPrefix(targets, harness);
  for (const event of HOOK_EVENTS) {
    const arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (arr.some((e) => isOurHookEntry(e, prefix))) continue;
    hooks[event] = [...arr, hookEntry(targets, harness, event)];
  }
}

function unwireHooks(doc: Record<string, unknown>, targets: ConnectTargets, harness: Harness): void {
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
  const prefix = hookPrefix(targets, harness);
  for (const event of HOOK_EVENTS) {
    const arr = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(arr)) continue;
    (hooks as Record<string, unknown>)[event] = arr.filter((e) => !isOurHookEntry(e, prefix));
  }
}

function applyMarkdownBlock(path: string): FileWrite {
  const existed = existsSync(path);
  const content = existed ? readFileSync(path, "utf8") : "";
  const edit = upsertManagedBlock(content, disciplineText);
  if (!edit.changed) return { path, action: "unchanged" };
  writeFileSync(path, edit.text);
  return { path, action: existed ? "updated" : "created" };
}

function removeMarkdownBlock(path: string): FileWrite {
  if (!existsSync(path)) return { path, action: "absent" };
  const edit = removeManagedBlock(readFileSync(path, "utf8"));
  if (!edit.changed) return { path, action: "unchanged" };
  // A file that held only the managed block goes away entirely — that is the
  // file connect created, so disconnect restores its absence.
  if (edit.text === "") {
    unlinkSync(path);
    return { path, action: "removed" };
  }
  writeFileSync(path, edit.text);
  return { path, action: "removed" };
}

export function claudeJsonPath(t: ConnectTargets): string {
  return t.homeDir + "/.claude.json";
}
export function claudeSettingsPath(t: ConnectTargets): string {
  return t.homeDir + "/.claude/settings.json";
}
export function zcodeConfigPath(t: ConnectTargets): string {
  return t.homeDir + "/.zcode/cli/config.json";
}
export function disciplineMdPath(t: ConnectTargets, harness: Harness): string {
  return t.projectDir + (harness === "claude-code" ? "/CLAUDE.md" : "/AGENTS.md");
}

// ── claude-code ──────────────────────────────────────────────────────────────
export function applyClaudeCode(t: ConnectTargets, baseUrl: string, envVar: string): FileWrite[] {
  return [
    applyServerEntry(claudeJsonPath(t), ["mcpServers"], mcpServerEntry(baseUrl, envVar)),
    applyJson(claudeSettingsPath(t), (doc) => wireHooks(doc, t, "claude-code")),
    applyMarkdownBlock(t.projectDir + "/CLAUDE.md"),
  ];
}

export function disconnectClaudeCode(t: ConnectTargets): FileWrite[] {
  return [
    removeServerEntry(claudeJsonPath(t), ["mcpServers"]),
    applyJson(claudeSettingsPath(t), (doc) => unwireHooks(doc, t, "claude-code"), "removed"),
    removeMarkdownBlock(t.projectDir + "/CLAUDE.md"),
  ];
}

// ── zcode ────────────────────────────────────────────────────────────────────
export function applyZcode(t: ConnectTargets, baseUrl: string, envVar: string): FileWrite[] {
  return [
    applyServerEntry(zcodeConfigPath(t), ["mcp", "servers"], mcpServerEntry(baseUrl, envVar)),
    applyJson(zcodeConfigPath(t), (doc) => wireHooks(doc, t, "zcode")),
    applyMarkdownBlock(t.projectDir + "/AGENTS.md"),
  ];
}

export function disconnectZcode(t: ConnectTargets): FileWrite[] {
  return [
    removeServerEntry(zcodeConfigPath(t), ["mcp", "servers"]),
    applyJson(zcodeConfigPath(t), (doc) => unwireHooks(doc, t, "zcode"), "removed"),
    removeMarkdownBlock(t.projectDir + "/AGENTS.md"),
  ];
}

// ── generic mcp ──────────────────────────────────────────────────────────────
// Pure generator for `connect mcp`: a paste-ready snippet for any MCP client.
// Never touches a tool-specific config file; token stays an env reference.
export function genericMcpSnippet(baseUrl: string, envVar: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpServerEntry(baseUrl, envVar) } }, null, 2);
}

// ── dify (add-yongyi-connect-dify-coze, D1–D3) ───────────────────────────────
// Dify is a UI-configured platform: there is no config file to merge into, so
// this adapter is a RECIPE generator (structured object + terminal renderer).
// Two facts from the reconnaissance drive the shape:
//   • Dify speaks HTTP-transport MCP only — our streamable-http endpoint is
//     natively in shape, so integration is configuration, not code;
//   • Dify applications reference a server by its `identifier`, and renaming
//     breaks every existing reference — so the identifier is pinned.
// Dify has no turn/hook surface, so the platform-guaranteed L0 capture lane is
// unreachable there: the discipline block is Dify's ONLY memory write path,
// and the recipe says so instead of pretending otherwise.

export const DIFY_SERVER_IDENTIFIER = "yongyi";

// The tool names a correctly configured Dify tool list must show. Kept as data
// so a test can cross-check it against the live MCP surface (mcp.ts buildTools)
// — drift in either direction fails the suite.
export const DIFY_VERIFY_TOOLS = [
  "memory_write_page",
  "memory_query",
  "memory_recent",
  "memory_handoff_begin",
  "memory_handoff_list",
] as const;

export interface DifyRecipe {
  identifier: string;
  serverUrl: string;
  identity: string;
  headerName: string;
  headerValueRef: string; // env reference, never a literal token
  tokenCommand: string; // how to reveal the header value locally
  steps: string[];
  discipline: string;
  verification: readonly string[];
  honesty: string;
}

// The header the user pastes into Dify, as an environment reference. Dify's UI
// needs the literal value, so the recipe tells the operator how to print it
// from the 0600 env file instead of embedding it in the recipe text.
export function difyHeaderValueRef(envVar: string): string {
  return "Bearer ${" + envVar + "}";
}

export function difyTokenCommand(envVar: string): string {
  return `. "\${YONGYI_HOME:-\$HOME/.yongyi}/env" && printf 'Bearer %s\\n' "\${${envVar}}"`;
}

export function difyRecipe(args: { baseUrl: string; identity: string; envVar: string }): DifyRecipe {
  const serverUrl = mcpUrlFor(args.baseUrl);
  return {
    identifier: DIFY_SERVER_IDENTIFIER,
    serverUrl,
    identity: "u/" + args.identity,
    headerName: "Authorization",
    headerValueRef: difyHeaderValueRef(args.envVar),
    tokenCommand: difyTokenCommand(args.envVar),
    steps: [
      `Dify 控制台 → Integrations（工具）→ Tools → 添加 MCP 服务器`,
      `transport 选 HTTP（Dify 仅支持 HTTP transport 的 MCP 服务器），URL 填 ${serverUrl}`,
      `名称可自定为 fd-memory；identifier 必须为 ${DIFY_SERVER_IDENTIFIER}——Dify 按 identifier 引用服务器，改名会使已有应用的引用失效`,
    ],
    discipline: platformDisciplineText,
    verification: DIFY_VERIFY_TOOLS,
    honesty:
      "Dify 没有回合 hook 面：平台担保的自动捕获在此不可达，回合与工具事件不会自动落 L0。上面这段纪律提示词是 Dify 侧唯一的记忆写路径——agent 自觉写，不是平台担保。",
  };
}

// Dify's UI is the target; the CLI's job is to say exactly what to click and
// paste, in an order that works on the first try.
export function renderDifyRecipe(r: DifyRecipe): string {
  const lines: string[] = [];
  lines.push("Dify 接入配方（永忆 / fd-memory）");
  lines.push(`  服务      ${r.serverUrl}`);
  lines.push(`  身份根    ${r.identity}`);
  lines.push(`  identifier ${r.identifier}`);
  lines.push("");
  lines.push("① 添加 MCP 服务器");
  r.steps.forEach((s, i) => lines.push(`   ${i + 1}. ${s}`));
  lines.push("");
  lines.push("② 自定义 header（认证，每请求携带）");
  lines.push(`   ${r.headerName}: ${r.headerValueRef}`);
  lines.push("   令牌不写进配方正文（避免明文外泄）。在本机取出整行值再粘贴到 Dify 的 header 值：");
  lines.push(`     ${r.tokenCommand}`);
  lines.push("");
  lines.push("③ 系统提示词纪律区块（整段粘贴到 Agent 应用的系统提示词/指令）");
  lines.push(r.discipline);
  lines.push("");
  lines.push("④ 验证（Dify 工具列表应出现下列工具，出现即通）");
  for (const tool of r.verification) lines.push(`   - ${tool}`);
  lines.push("   不出现：先查 URL 可达性（Dify 所在网络能否访问服务端点），再查 header 是否带 Bearer 前缀。");
  lines.push("");
  lines.push("边界：" + r.honesty);
  return lines.join("\n");
}

export function difyDisconnectNotes(serverUrl: string): string[] {
  return [
    `Dify 控制台 → Integrations（工具）→ Tools → 找到 identifier 为 ${DIFY_SERVER_IDENTIFIER} 的服务器（${serverUrl}）并移除`,
    `引用过它的 Agent/Chatflow/Workflow 要重新选工具；系统提示词里的纪律段落请一并删除`,
  ];
}

// ── coze (honest recon, D2) ──────────────────────────────────────────────────
// Coze Studio (open source) has no MCP client capability — the tracked issues
// are still open. So this adapter ships reconnaissance, not steps: credentials
// and the endpoint are prepared for the day the commercial build supports it,
// and the output never claims support it does not have.
export const COZE_RECON_DATE = "2026-11-07";
export const COZE_RECON_ISSUES = [
  "https://github.com/coze-dev/coze-studio/issues/7",
  "https://github.com/coze-dev/coze-studio/issues/2079",
  "https://github.com/coze-dev/coze-studio/issues/628",
] as const;

export interface CozeRecon {
  date: string;
  supported: false;
  status: string;
  issues: readonly string[];
  serverUrl: string;
  identity: string;
  headerValueRef: string;
  tokenCommand: string;
  prepared: string;
}

export function cozeRecon(args: { baseUrl: string; identity: string; envVar: string }): CozeRecon {
  return {
    date: COZE_RECON_DATE,
    supported: false,
    status:
      "coze-studio 开源版没有 MCP client 能力：平台侧无法把外部 MCP 服务器挂成工具，因此现在没有可执行的接入路径。商业版（coze.cn）的 MCP 文档页无法无头勘定，待有账号时实机验证。",
    issues: COZE_RECON_ISSUES,
    serverUrl: mcpUrlFor(args.baseUrl),
    identity: "u/" + args.identity,
    headerValueRef: difyHeaderValueRef(args.envVar),
    tokenCommand: difyTokenCommand(args.envVar),
    prepared:
      "端点、身份绑定与 person 令牌已备好（写入 0600 凭据文件）。等平台侧支持 HTTP transport 的 MCP 客户端，直接用同一套 URL + 请求头即可，无需重新铸造身份。",
  };
}

export function renderCozeRecon(r: CozeRecon): string {
  const lines: string[] = [];
  lines.push("Coze 接入现状（诚实结论：暂不支持）");
  lines.push(`  勘定日期  ${r.date}`);
  lines.push(`  结论      ${r.status}`);
  lines.push("  跟踪      ");
  for (const issue of r.issues) lines.push(`     - ${issue}`);
  lines.push("");
  lines.push("已备好的料（等平台支持后即用）");
  lines.push(`  服务      ${r.serverUrl}`);
  lines.push(`  身份根    ${r.identity}`);
  lines.push(`  请求头    Authorization: ${r.headerValueRef}`);
  lines.push(`  取值      ${r.tokenCommand}`);
  lines.push("");
  lines.push(r.prepared);
  lines.push("本次没有写入任何平台配置，也没有生成接入步骤——支持就是支持，不支持不假装。");
  return lines.join("\n");
}

export function cozeDisconnectNotes(): string[] {
  return [
    "coze 未写入任何平台配置，无需在平台侧移除",
    "本侧备料（凭据文件中的 coze 绑定与导出的令牌变量）已清理；身份根与记忆数据不动",
  ];
}
