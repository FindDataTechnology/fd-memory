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
import { MCP_SERVER_NAME, managedDisciplineBlock, disciplineText } from "./discipline-text.js";
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
