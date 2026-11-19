// Command handlers for `yongyi connect | disconnect | hook`
// (add-yongyi-complete-solution, tasks 3.1–3.7). index.ts dispatches here.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { rootKeyForRef } from "../auth.js";
import { spoolAppend, spoolRead, spoolRewrite, spoolCapacity } from "./observe-spool.js";
import { readInjectionState, recordInjection, stalenessNote } from "./injection-state.js";
import {
  applyClaudeCode,
  applyGeminiFamily,
  applyWorkbuddy,
  applyZcode,
  cozeDisconnectNotes,
  cozeRecon,
  difyDisconnectNotes,
  difyRecipe,
  disconnectClaudeCode,
  disconnectGeminiFamily,
  disconnectWorkbuddy,
  disconnectZcode,
  genericMcpSnippet,
  renderCozeRecon,
  renderDifyRecipe,
  type ConnectReport,
  type ConnectTargets,
  type FileWrite,
} from "./adapters.js";
import {
  credentialPaths,
  envVarFor,
  loadCredentials,
  planIdentity,
  PROFILE_BEGIN,
  PROFILE_END,
  profileSourceLine,
  saveCredentials,
  writeEnvFile,
  type Binding,
  type CredentialFile,
  type Harness,
} from "./credentials.js";
import { removeManagedBlock, upsertManagedBlock } from "./managed-block.js";
import { forwardHookEvent, mapHookEvent, normalizeHookEvent, readStdinJson } from "./hook-forward.js";

export const CONNECT_USAGE = `usage:
  yongyi connect claude-code --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect zcode --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect workbuddy --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect gemini-cli --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect qwen --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect mcp --url <service-url> [--as <user>]
  yongyi connect dify --url <service-url> --as <user> [--project P]
  yongyi connect coze --url <service-url> --as <user>
  yongyi disconnect <harness>
  yongyi hook <harness> <event>        (reads hook event JSON on stdin)`;

const HOOK_HARNESSES = ["claude-code", "zcode", "workbuddy", "gemini-cli", "qwen"] as const;

// ── Recall-injection envelope, per harness (2026-11-18) ─────────────────────
//
// Why this is a table and not one literal: the envelope is the host's contract,
// not ours. Shipping the wrong shape is silently discarded — the hook exits 0,
// the turn proceeds, and nothing was injected, which is exactly the failure
// mode this table exists to remove.
//
// Evidence (shipped bundles, read 2026-11-18):
//   claude-code  — binary contains `hookSpecificOutput.additionalContext` (64x)
//   gemini-cli   — getAdditionalContext() reads ONLY
//                  hookSpecificOutput["additionalContext"], else returns undefined
//   qwen-code    — DefaultHookOutput.getRawAdditionalContext() same shape
//   workbuddy    — same schema as CodeBuddy/Claude Code (its own skill docs say so)
//   zcode        — neither key appears anywhere in its 464 MB bundle, and its
//                  hooks are trust-gated; the top-level form we shipped has no
//                  reader. Left as `none` until a real injection is observed.
//
// `none` means: do not emit a guessed envelope. Absence is honest; a wrong shape
// is a silent no-op that reads as working.
export type InjectionEnvelope = "hookSpecificOutput" | "top-level" | "none";

export const INJECTION_ENVELOPE: Record<string, InjectionEnvelope> = {
  "claude-code": "hookSpecificOutput",
  workbuddy: "hookSpecificOutput",
  codebuddy: "hookSpecificOutput",
  "gemini-cli": "hookSpecificOutput",
  qwen: "hookSpecificOutput",
  zcode: "none",
};

/**
 * Wrap recall text in the envelope the target host actually reads.
 * Returns `{}` (valid JSON, means "nothing to say") when there is no text or
 * when the target has no verified envelope.
 */
export function injectionPayload(harness: string, ctx: string): Record<string, unknown> {
  if (!ctx) return {};
  switch (INJECTION_ENVELOPE[harness]) {
    case "hookSpecificOutput":
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
    case "top-level":
      return { additionalContext: ctx };
    default:
      return {};
  }
}


// Recipe-shaped harnesses (add-yongyi-connect-dify-coze): the platform is
// configured through a UI, so connect prints instructions and writes no
// tool-config files — only the identity binding and its 0600 credential files.
const RECIPE_HARNESSES = ["dify", "coze"] as const;

export function connectHarnesses(): readonly string[] {
  return ["claude-code", "zcode", "workbuddy", "gemini-cli", "qwen", "mcp", "dify", "coze"];
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | undefined>;
}

function parseArgs(argv: string[], known: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (known.includes(name)) {
        flags[name] = argv[i + 1];
        i++;
        continue;
      }
      flags[name] = ""; // unknown flag — surfaced by callers that care
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function defaultServiceUrl(): string {
  return process.env.FD_MEMORY_URL ?? `http://127.0.0.1:${process.env.FD_MEMORY_PORT ?? "49375"}`;
}

function targets(flags: Record<string, string | undefined>): ConnectTargets {
  return {
    homeDir: homedir(),
    projectDir: flags.dir ?? process.cwd(),
    binName: "yongyi",
  };
}

function printFileWrites(files: FileWrite[]): void {
  for (const f of files) {
    const mark = f.action === "unchanged" ? "kept  " : f.action === "absent" ? "absent" : "wrote ";
    console.log(`  ${mark} ${f.path} (${f.action})`);
  }
}

function saveIdentity(
  harness: Harness,
  credsPath: string,
  envPath: string,
  creds: CredentialFile,
  binding: Binding,
  url: string,
): void {
  creds.bindings[harness] = binding;
  saveCredentials(credsPath, creds);
  writeEnvFile(envPath, creds, url);
}

// ── connect ──────────────────────────────────────────────────────────────────
export async function runConnect(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv, ["url", "as", "project", "dir"]);
  const harness = positionals[0] as Harness | undefined;
  if (!harness || !connectHarnesses().includes(harness)) {
    console.error(`unknown harness: ${harness ?? "(none)"} — expected ${connectHarnesses().join(" | ")}\n${CONNECT_USAGE}`);
    process.exit(2);
  }
  const identity = flags.as;
  if (!identity && harness !== "mcp") {
    console.error(`connect ${harness} requires --as <user> (person identity, e.g. --as user@example.com)\n${CONNECT_USAGE}`);
    process.exit(2);
  }
  const url = flags.url ?? defaultServiceUrl();
  const t = targets(flags);
  const yongyiDir = process.env.YONGYI_HOME ?? t.homeDir + "/.yongyi";
  const paths = credentialPaths(yongyiDir);
  // Same resolution rule as `serve` (src/index.ts): FD_MEMORY_DATA, else the
  // HOME-derived default. Using `t.homeDir` here was a real defect — it is a
  // separate knob (used for harness config paths), so with any override the CLI
  // minted tokens into a store the daemon never reads and every request 401'd
  // while `connect` reported success. One rule, one place.
  const dataDir = process.env.FD_MEMORY_DATA || process.env.HOME + "/Library/Application Support/fd-memory";
  const pepper = process.env.FD_MEMORY_PEPPER ?? "fd-memory-dev-pepper";
  const envVar = envVarFor(harness);

  const report: ConnectReport = {
    harness,
    namespace: identity ? "u/" + identity : "(unbound — snippet only)",
    rootKey: identity ? rootKeyForRef("u/" + identity) : "",
    token_reused: false,
    mcp_url: url.replace(/\/+$/, "") + "/mcp",
    files: [],
  };

  if (harness === "mcp" && !identity) {
    // Generic snippet only: no tool config files touched, no identity bound.
    report.snippet = genericMcpSnippet(url, envVar);
    printConnectReport(report, paths, false);
    return;
  }

  const creds = loadCredentials(paths.creds);
  const plan = planIdentity({ identity: identity!, harness, creds, dataDir, pepper });
  report.token_reused = plan.reused;

  if ((RECIPE_HARNESSES as readonly string[]).includes(harness)) {
    // Recipe-shaped platform: no config file to merge, so nothing to write on
    // the harness side. The identity binding still lands in the 0600 credential
    // files — the recipe's header line references it, never inlines it.
    const binding: Binding = {
      url,
      namespace: plan.namespace,
      token: plan.token,
      project: flags.project ?? "default",
      bound_at: new Date().toISOString(),
    };
    saveIdentity(harness, paths.creds, paths.env, creds, binding, url);
    console.log(`connected ${harness} → ${report.namespace} (root ${report.rootKey})`);
    console.log("");
    const rendered =
      harness === "dify"
        ? renderDifyRecipe(difyRecipe({ baseUrl: url, identity: identity!, envVar }))
        : renderCozeRecon(cozeRecon({ baseUrl: url, identity: identity!, envVar }));
    console.log(rendered);
    console.log("");
    console.log(`  token  ${report.token_reused ? "reused existing person token" : "minted new person token"}`);
    console.log(`  credentials  ${paths.creds} (0600)`);
    console.log(`  env          ${paths.env} (0600) — source it to export ${envVar}`);
    console.log(`  mcp url      ${report.mcp_url}`);
    return;
  }

  if (harness === "claude-code") {
    report.files = applyClaudeCode(t, url, envVar);
  } else if (harness === "zcode") {
    report.files = applyZcode(t, url, envVar);
  } else if (harness === "workbuddy") {
    report.files = applyWorkbuddy(t, url, envVar);
  } else if (harness === "gemini-cli") {
    report.files = applyGeminiFamily(t, ".gemini", "gemini-cli", url, envVar);
  } else if (harness === "qwen") {
    report.files = applyGeminiFamily(t, ".qwen", "qwen", url, envVar);
  } else {
    report.snippet = genericMcpSnippet(url, envVar);
  }

  const binding: Binding = {
    url,
    namespace: plan.namespace,
    token: plan.token,
    project: flags.project ?? "default",
    bound_at: new Date().toISOString(),
  };
  saveIdentity(harness, paths.creds, paths.env, creds, binding, url);
  // The MCP entry references ${YONGYI_TOKEN_*}; this is the half that makes the
  // reference resolve in a login shell. Without it the entry 401s while hooks
  // keep working (they read the credential file directly) — the exact asymmetry
  // this task exists to remove.
  const profile = wireProfile(paths.env);
  report.files.push(profile);
  printConnectReport(report, paths, true);
}

// Upsert/remove our source block in the user's shell profile. Only the marker
// region is touched; everything else in the file is preserved byte-for-byte.
const PROFILE_MARKERS = { begin: PROFILE_BEGIN, end: PROFILE_END };

function profilePath(home: string): string {
  // ~/.zshenv, NOT ~/.zshrc (2026-11-18, found by 6.3 acceptance).
  //
  // zsh reads .zshrc only for INTERACTIVE shells. Every harness launched from a
  // GUI, an IDE, a cron entry or a subprocess runs non-interactive — and a
  // login non-interactive shell (`zsh -lc`) reads .zprofile/.zlogin, also not
  // .zshrc. So a source line in .zshrc resolves in a terminal and is absent
  // exactly where the MCP entry needs it, which reproduces as a 401 with no
  // local signal. .zshenv is the only file zsh reads in EVERY mode.
  return process.env.YONGYI_PROFILE ?? home + "/.zshenv";
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function wireProfile(envPath: string): FileWrite {
  const file = profilePath(homedir());
  const before = readText(file);
  const edit = upsertManagedBlock(before, profileSourceLine(envPath), PROFILE_MARKERS);
  if (!edit.changed) return { path: file, action: "unchanged" };
  writeFileSync(file, edit.text);
  return { path: file, action: before === "" ? "created" : "updated" };
}

function unwireProfile(): FileWrite {
  const file = profilePath(homedir());
  const before = readText(file);
  const edit = removeManagedBlock(before, PROFILE_MARKERS);
  if (!edit.changed) return { path: file, action: "absent" };
  writeFileSync(file, edit.text);
  return { path: file, action: "removed" };
}

function printConnectReport(report: ConnectReport, paths: { creds: string; env: string }, bound: boolean): void {
  console.log(`connected ${report.harness} → ${report.namespace}${report.rootKey ? ` (root ${report.rootKey})` : ""}`);
  printFileWrites(report.files);
  if (report.snippet) {
    console.log("paste this into your MCP client config:");
    console.log(report.snippet);
  }
  if (bound) {
    console.log(`  token  ${report.token_reused ? "reused existing person token" : "minted new person token"}`);
    console.log(`  credentials  ${paths.creds} (0600) — hook 转发用`);
    console.log(`  env          ${paths.env} (0600) — source it to export ${envVarFor(report.harness)}`);
    console.log(`  mcp url      ${report.mcp_url}`);
  }
}

// ── disconnect ───────────────────────────────────────────────────────────────
// Removes exactly the managed artifacts connect wrote. Memory data lives in
// the service data dir — disconnect never touches it (spec: 断开工具不删记忆).
export function runDisconnect(argv: string[]): void {
  const { positionals } = parseArgs(argv, ["dir"]);
  const harness = positionals[0];
  if (!harness || !connectHarnesses().includes(harness)) {
    console.error(`unknown harness: ${harness ?? "(none)"} — expected ${connectHarnesses().join(" | ")}\n${CONNECT_USAGE}`);
    process.exit(2);
  }
  const t = targets({});
  const yongyiDir = process.env.YONGYI_HOME ?? t.homeDir + "/.yongyi";
  const paths = credentialPaths(yongyiDir);
  let files: FileWrite[];
  if (harness === "claude-code") {
    files = disconnectClaudeCode(t);
  } else if (harness === "zcode") {
    files = disconnectZcode(t);
  } else if (harness === "workbuddy") {
    files = disconnectWorkbuddy(t);
  } else if (harness === "gemini-cli") {
    files = disconnectGeminiFamily(t, ".gemini", "gemini-cli");
  } else if (harness === "qwen") {
    files = disconnectGeminiFamily(t, ".qwen", "qwen");
  } else if (harness === "dify") {
    const boundUrl = loadCredentials(paths.creds).bindings["dify"]?.url ?? defaultServiceUrl();
    files = dropBinding("dify", paths.creds, paths.env);
    console.log("disconnected dify (memory data untouched)");
    console.log("  在 Dify 侧照下列步骤移除（本命令无法代你操作 UI）：");
    for (const line of difyDisconnectNotes(boundUrl)) console.log(`  - ${line}`);
    printFileWrites(files);
    return;
  } else if (harness === "coze") {
    files = dropBinding("coze", paths.creds, paths.env);
    console.log("disconnected coze (memory data untouched)");
    for (const line of cozeDisconnectNotes()) console.log(`  - ${line}`);
    printFileWrites(files);
    return;
  } else {
    console.log("disconnect mcp: nothing to remove — `connect mcp` writes no tool config files.");
    return;
  }
  console.log(`disconnected ${harness} (memory data untouched)`);
  printFileWrites(files);
  // Only unwire the profile when no binding remains: another harness may still
  // rely on the same exported variables.
  if (Object.keys(loadCredentials(paths.creds).bindings).length === 0) {
    printFileWrites([unwireProfile()]);
  }
}

// Recipe harnesses have no platform-side artifact this CLI wrote, so disconnect
// only clears our own preparation: the binding row and the exported token line.
// The person root and every memory page stay untouched (统一语义).
function dropBinding(harness: Harness, credsPath: string, envPath: string): FileWrite[] {
  const creds = loadCredentials(credsPath);
  if (!creds.bindings[harness]) return [{ path: credsPath, action: "unchanged" }];
  const url = creds.bindings[harness].url;
  delete creds.bindings[harness];
  saveCredentials(credsPath, creds);
  writeEnvFile(envPath, creds, url);
  return [
    { path: credsPath, action: "updated" },
    { path: envPath, action: "updated" },
  ];
}

// ── hook ─────────────────────────────────────────────────────────────────────
// Fail-drop forwarder: reads the hook event JSON on stdin, maps and POSTs it
// to /observe with the harness's bound person token. ANY delivery failure —
// unreachable service, 5xx, timeout, missing binding — logs to stderr and
// exits 0: a capture hook must never block a harness turn. Only usage errors
// exit non-zero (2).

/**
 * Build the memory context injected at session start.
 *
 * Kept deliberately small: this text rides EVERY session's system prompt, so a
 * verbose dump would be paid for on every turn. We surface only the distilled
 * layer (kind=memory pages), newest first, capped hard — a handful of
 * conclusions the agent can act on, not a transcript.
 *
 * Fails silent: if the service is down or slow, the session starts without
 * memory. Blocking a turn on a memory read would repeat the outage we are
 * trying to avoid.
 */
/**
 * Last-resort memory injection when the service cannot answer (2026-11-19).
 *
 * Why this exists: `buildSessionContext` used to return "" on any failure, so a
 * down service meant a session started with NO memory — and on this machine the
 * service is down a lot (31 concurrent sessions, 60MB free RAM, load 24-37).
 * That turned "memory is unavailable" into "memory is absent", which is the one
 * thing a memory system must not do.
 *
 * The index pages are plain markdown under
 *   <data>/owners/<root>/wiki/<project>/memory-index/*.md
 * each carrying frontmatter with `metadata.harness` / `metadata.memory_type`
 * and a `title`. Reading them directly needs no database, no HTTP, and no
 * token — so it works exactly when the service does not.
 *
 * Deliberately degraded in three ways, and each is honest about itself:
 *   · no per-harness quota balancing — newest-first only
 *   · no `total` count, so no "还有 N 条未列出" line
 *   · bounded by the same 3000-char budget, with a marker saying it is degraded
 *
 * The marker matters: silently serving a thinner index would look identical to
 * a healthy injection, and the reader would never learn the service was down.
 */
export function readIndexFromDisk(
  project: string,
  binding: Binding,
  maxChars = 3000,
  // Whether this call counts as "a session was injected" (2026-11-19).
  //
  // Why a flag: this function is both the production fallback (called from
  // buildSessionContext) and a handy diagnostic entry point (ops/debug code
  // calls it directly). Both used to write the freshness record, so a manual
  // probe would claim a session had been injected — and, worse, reset the
  // staleness clock, hiding a real gap. A diagnostic must not mutate what it is
  // diagnosing.
  //
  // Default true so the production path keeps working without every caller
  // having to know about this; probes pass false explicitly.
  record = true,
): string {
  try {
    // The binding carries `namespace` ("u/<user>"), and the on-disk root key is
    // its sanitized form ("u-<user>"). rootKeyForRef is the single definition of
    // that mapping, so use it rather than rebuilding the string here.
    const rootKey = rootKeyForRef(binding.namespace ?? "");
    if (!rootKey) return "";
    const dataDir = process.env.FD_MEMORY_DATA;
    if (!dataDir) return "";
    const dir = join(dataDir, "owners", rootKey, "wiki", project, "memory-index");
    if (!existsSync(dir)) return "";

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return "";

    // Newest first by mtime — the same ordering the service uses, minus the
    // per-harness quota.
    const rows = files
      .map((f) => {
        const p = join(dir, f);
        try { return { p, f, mtime: statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter((r): r is { p: string; f: string; mtime: number } => r !== null)
      .sort((a, b) => b.mtime - a.mtime);

    const lines: string[] = [
      "【永忆 · 跨 harness 记忆】（服务不可达，以下直接读自本地索引 —— 内容可能比常态少）",
    ];
    // Same staleness note as the HTTP path. Computed here rather than passed in
    // because this function is also the fallback for a caller that never got as
    // far as buildSessionContext's own read.
    const prevStale = stalenessNote(readInjectionState(spoolHome()));
    if (prevStale) lines.push(prevStale);
    let used = lines.reduce((n, l) => n + l.length + 1, 0);
    let shown = 0;
    for (const row of rows) {
      if (used >= maxChars) break;
      let raw: string;
      try { raw = readFileSync(row.p, "utf8"); } catch { continue; }
      const title = /^title:\s*(.+)$/m.exec(raw)?.[1]?.trim();
      if (!title) continue;
      const harness = /^\s+harness:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? "";
      const kind = /^\s+memory_type:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? "";
      const line = `- 〔${kind || "记忆"}${harness ? `·${harness}` : ""}〕${title}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    if (shown === 0) return "";
    lines.push("（服务恢复后本行消失；本轮学到新结论仍可 memory_write_page 落页。）");
    // Record that this session got a DEGRADED injection, so the next session
    // knows the memory it inherits may be thin (2026-11-19).
    // `record` is false for diagnostic callers — see the parameter comment.
    if (record) recordInjection(spoolHome(), { at: new Date().toISOString(), source: "disk", entries: shown });
    return lines.join("\n");
  } catch {
    // Even the fallback can fail (permissions, corrupt frontmatter). Returning
    // "" here is correct — a broken fallback must not block the session start.
    return "";
  }
}

export async function buildSessionContext(binding: Binding): Promise<string> {
  const base = binding.url.replace(/\/+$/, "");
  const project = binding.project && binding.project !== "default" ? binding.project : "default";
  // How stale is the PREVIOUS injection? Read before writing this one, and
  // prepend a note when it is old (2026-11-19). This is the last of the three
  // fallbacks: read falls back to disk, write spools locally, and this one makes
  // staleness VISIBLE — a thin injection and a stale one look identical from
  // inside, and silently serving old conclusions as current is the worst thing
  // a memory system can do.
  const staleness = stalenessNote(readInjectionState(spoolHome()));
  const ctl = new AbortController();
  // 5s, not 2s: the index query touches a multi-thousand-page table on a disk
    // shared with an 8.5 GB session database (measured 2026-11-16: 1.4–2.5 s,
    // while /digest needs 10 s). A session-start hook may take a few seconds —
    // it must not take forever, and it must not fail silently because the
    // budget was tighter than the machine is fast.
    //
    // 5000 → 2500 (2026-11-19). Measured against a server that accepts the
    // connection and then never answers (the exact shape of a stalled
    // fd-memory): the whole hook took **8.22s**, against the 10s timeout in
    // ~/.claude/settings.json. Only 1.8s of headroom, and this machine runs at
    // load 10–28 — a slower Node start or a busier box would blow the budget and
    // the session would get NO memory at all, fallback included.
    //
    // 2500ms is still 8× the healthy response (measured 286ms for this
    // endpoint), so it does not start rejecting real answers; it only makes the
    // stuck case give up sooner and hand over to the disk fallback, which is
    // the whole point of having one.
    const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    // 注入的是**跨 harness 记忆索引**，不是 digest。
    //
    // 为什么换掉 digest（2026-11-16）：digest 由 hybridCandidates 生成，会把
    // L0 工具流水（`tool_call Bash: kubectl …`）混进候选，实测启动注入里
    // 大部分是这类噪音。而索引页（type=memory-index）是从各 harness 自己的
    // memory 文件里读出来的**结论**，description 就是钩子本身。
    //
    // 预算控制（三层，都必要）：
    //   1. 只取 feedback + user —— 这两类每轮都该看到；project/reference 按需查
    //   2. 再按源文件 mtime 取最近的 —— 旧结论价值递减
    //   3. 最后按字符数硬截断 —— 索引大小不可预测，必须有上限
    //   实测：feedback+user 共 578 条 = 28K tokens（太多）；
    //         取最近 100 条 = 5K tokens（可接受）。
    // Promise.race, not AbortSignal alone (2026-11-19). Measured against a
    // server that accepts and never answers: `setTimeout(abort, 2500)` produced
    // a 5.7s hook — Node's fetch does not drop a socket read the instant the
    // signal fires, so the abort cost an extra ~3s. Racing the same promise
    // against a plain timer bounds the WAIT itself, which is what the hook
    // budget actually cares about.
    //
    // The abort controller stays: it is what stops the underlying request when
    // the race is lost. The race just decides when we stop *waiting*.
    const res = await Promise.race([
      fetch(`${base}/memory/index?project=${encodeURIComponent(project)}&limit=100`, {
        headers: { authorization: "Bearer " + binding.token },
        signal: ctl.signal,
      }),
      new Promise<never>((_, reject) => {
        const raceTimer = setTimeout(() => reject(new Error("index fetch timed out")), 2500);
        raceTimer.unref?.();
      }),
    ]);
    if (!res.ok) return readIndexFromDisk(project, binding);
    const doc = (await res.json()) as {
      entries?: Array<{ harness?: string; memory_type?: string; description?: string }>;
      total?: number;
    };
    const entries = Array.isArray(doc.entries) ? doc.entries : [];
    if (entries.length === 0) return "";

    const lines: string[] = ["【永忆 · 跨 harness 记忆】以下是已沉淀的结论（本地优先，其余为其它 harness 的经验）："];
    if (staleness) lines.push(staleness);
    let used = lines.reduce((n, l) => n + l.length + 1, 0);
    const MAX_CHARS = 3000;
    let shown = 0;

    // 按 harness 比例取用，而不是照服务端顺序一路填满预算，也不是等分轮转。
    //
    // 为什么必须在客户端再分一次（2026-11-16 实测）：服务端 /memory/index 已经
    // 按持有量配额返回（zcode 73 / claude-code 27），但注入预算只有 3000 字符，
    // 装得下约 35 条。照原顺序（feedback 优先 + mtime 倒序）前 35 条几乎全是
    // zcode，于是配额在截断这一步被抹平，会话看到的仍是单 harness。
    //
    // 为什么不用等分轮转：等分会让小 harness 占满一半预算。40:20 实测截断后
    // 得到 15:15——大 harness 的配额优势消失。按比例交错（归一化位置排序）
    // 让任意长度的前缀都保持与总量一致的比例。
    const byHarness = new Map<string, Array<{ e: (typeof entries)[number]; pos: number }>>();
    for (const e of entries) {
      const k = String(e.harness ?? "?");
      const b = byHarness.get(k);
      const pos = b ? b.length : 0;
      if (b) b.push({ e, pos: pos / 1 }); else byHarness.set(k, [{ e, pos: 0 }]);
    }
    const ordered = [...byHarness.values()]
      .flatMap((bucket) => bucket.map(({ e, pos }) => ({ e, key: pos / Math.max(1, bucket.length) })))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.e);

    for (const e of ordered) {
      const d = String(e.description ?? "").replace(/\s+/g, " ").trim();
      if (!d) continue;
      const tag = e.memory_type === "feedback" ? "纪律" : e.memory_type === "user" ? "偏好" : "记忆";
      const line = `- 〔${tag}·${e.harness ?? "?"}〕${d}`;
      if (used + line.length > MAX_CHARS) break;
      lines.push(line);
      used += line.length;
      shown++;
    }
    if (shown === 0) return "";
    const hidden = (doc.total ?? entries.length) - shown;
    if (hidden > 0) lines.push(`…另有 ${hidden} 条未列出，用 memory_query 检索全文。`);
    lines.push("本轮学到新结论时用 memory_write_page 落页；收尾时可写 memory_handoff_begin 交接。");
    recordInjection(spoolHome(), { at: new Date().toISOString(), source: "service", entries: shown });
    return lines.join("\n");
  } catch {
    // The service is unreachable, timed out, or answered garbage. Falling back
    // to "" means the session starts with no memory at all — which is what used
    // to happen, and it is the wrong default: the index pages are plain
    // markdown on local disk, so a dead service does not actually make them
    // unreadable (2026-11-19).
    return readIndexFromDisk(project, binding);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the local observe spool (2026-11-19).
 *
 * Companion to the hook's spooling: when the service was down, events went to a
 * local JSONL file instead of being dropped. This delivers them.
 *
 * Delivery is decided per entry, and the survivors are written back — so a
 * replay against a still-broken service is safe to run repeatedly and loses
 * nothing. Entries are attempted in file order (oldest first) on purpose: if the
 * service is flapping, the oldest events are the ones with the most to lose by
 * staying on disk.
 *
 * Prints a one-line summary and exits 0 even when nothing could be delivered —
 * a replay is a maintenance action, not a gate. A caller that wants a verdict
 * can read the counts.
 */
export async function runObserveReplay(): Promise<void> {
  const home = spoolHome();
  const entries = spoolRead(home);
  if (entries.length === 0) {
    process.stdout.write("observe-replay: spool is empty — nothing to deliver\n");
    return;
  }
  const survivors: typeof entries = [];
  let delivered = 0;
  // Pace the replay (2026-11-19). Measured: 612 backlogged events replayed
  // back-to-back delivered only 114 — the service saturated partway through and
  // the rest timed out at 5s each. A single probe of the same entry then
  // succeeded in one call, so the entries were fine; the PACING was not.
  //
  // Replay is a maintenance action, not a hot path, so a small delay per entry
  // costs nothing and converts "hammered the service until it stalled" into a
  // trickle it can absorb. The delay is deliberately generous: the goal is to
  // drain the backlog, not to finish fast.
  // 5000ms, not 1000 (2026-11-19). Measured: a 1s pre-flight window passed while
  // the service was mid-stall — the run then hung for 180s and grew the backlog
  // by 47. `stalls` moves in bursts, so a one-second sample misses the moment;
  // five seconds is long enough to see a stall onset, and replay is a
  // maintenance action that can afford the wait.
  const PREFLIGHT_WINDOW_MS = 5000;
  // How many new stalls over the run mean "the replay is doing this". Measured
  // 2026-11-19: a healthy service accumulated ~47 stalls in 20 minutes on its
  // own (≈2.4/min), so a +5 threshold over one 20-delivery batch is well above
  // background noise while still catching a real collapse.
  const INFLIGHT_STALL_LIMIT = 5;
  // 200ms, not 50 (same run). At 50ms the loop could outrun a struggling
  // service: each delivery writes a page, and the writes queue faster than the
  // service retires them. 200ms is still ~700 entries/minute, well above the
  // ~16/min the backlog grows at, so it drains — just gently enough that the
  // service keeps up.
  const paceMs = Number(process.env.YONGYI_REPLAY_PACE_MS ?? 200) || 0;

  // Health gate before replaying (2026-11-19). Measured: a replay against an
  // already-stalled service pushed `stalls` from 118 to 123 and GREW the backlog
  // from 397 to 526 — every delivered event writes a page, and the page write is
  // exactly what blocks the loop. Replaying into a sick service makes it sicker;
  // the backlog can wait.
  //
  // The probe reads /healthz twice a second apart and compares the stall
  // counter: if it moved, the loop is being blocked right now and no amount of
  // replaying will land. Using the service's OWN counter avoids inventing a
  // timing threshold, and avoids the trap of a probe that itself writes a page
  // (which is what a "deliver one and see" check would do).
  const healthUrl = entries[0].url.replace(/\/+$/, "") + "/healthz";
  const stallsNow = async (): Promise<number | null> => {
    try {
      // 20s, not 8s (2026-11-19): the service answers /healthz in ~1ms when healthy
      // but has periodic multi-second stalls. An 8s probe missed often enough that
      // replay refused to start while a plain 20s-timeout delivery of the same
      // events succeeded 5/5. The probe must outlast a stall, not race it.
      const r = await fetch(healthUrl, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      const d = (await r.json()) as { stalls?: number };
      return typeof d.stalls === "number" ? d.stalls : null;
    } catch { return null; }
  };
  // Retry the probe before giving up (2026-11-19). A single 8s read can land in
  // one of the service's periodic stalls while the service is otherwise fine:
  // measured a run that reported "cannot read /healthz" and left 451 events on
  // the spool, when a plain sequential delivery of five of those same events
  // succeeded 5/5. Refusing to start because ONE probe missed is worse than
  // starting and letting the in-flight checks stop us.
  let s1: number | null = null;
  for (let attempt = 0; attempt < 3 && s1 === null; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    s1 = await stallsNow();
  }
  if (s1 === null) {
    process.stderr.write(`observe-replay: cannot read ${healthUrl} after 3 attempts — leaving ${entries.length} on the spool\n`);
    return;
  }
  await new Promise((r) => setTimeout(r, PREFLIGHT_WINDOW_MS));
  const s2 = await stallsNow();
  if (s2 !== null && s2 > s1) {
    process.stderr.write(
      `observe-replay: the service is stalling right now (stalls ${s1}→${s2} in ${PREFLIGHT_WINDOW_MS / 1000}s) — ` +
      `replaying would make it worse. Leaving ${entries.length} on the spool; run again when the machine is quieter.\n`,
    );
    return;
  }
  // Baseline for the in-flight health re-check below: every 20 deliveries we
  // compare against this. A pre-flight check alone is not enough — see the
  // comment at that call site.
  const baselineStalls: number = s2 ?? s1;
  // The service rate-limits /observe at 120/min per token, and replay trips it:
  // measured 114 delivered then a wall of 429s. That is the guard doing its job,
  // not a failure — so WAIT OUT the window instead of counting those entries as
  // undeliverable. Without this, every replay run re-fetches the same 114 and
  // the backlog never drains.
  let rateLimitedMs = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await forwardHookEvent({
      url: entry.url,
      token: entry.token,
      event: entry.event as never,
      timeoutMs: 8000,
    });
    if (result.delivered) {
      delivered += 1;
    } else if (result.status === 429) {
      // Wait a full window, then retry THIS entry rather than losing it.
      rateLimitedMs += 60_000;
      if (rateLimitedMs > 5 * 60_000) {
        survivors.push(entry, ...entries.slice(i + 1));
        process.stderr.write("observe-replay: still rate-limited after 5 minutes of waiting — leaving the rest on the spool\n");
        break;
      }
      await new Promise((r) => setTimeout(r, 60_000));
      i -= 1; // same entry again, next window
      continue;
    } else {
      survivors.push(entry);
    }
    // Stop early once the service looks unhealthy for reasons OTHER than
    // rate-limiting: continuing to push while it is failing just deepens the
    // outage.
    if (!result.delivered && result.status !== 429 && survivors.length >= 3 && delivered === 0) {
      survivors.push(...entries.slice(i + 1));
      process.stderr.write("observe-replay: service is not accepting events — stopped early, spool unchanged for the remainder\n");
      break;
    }
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    // Re-check health DURING the replay, not just before it (2026-11-19).
    // Measured: the pre-flight gate passed (stalls steady at 22), then the very
    // act of delivering pushed stalls to 23 and the backlog grew 607 → 615.
    // A one-shot check cannot see a problem that replaying itself creates — the
    // gate has to run while the damage would be happening.
    //
    // Threshold, not "any rise" (2026-11-19, second pass): the first version
    // stopped on a single increment, and `stalls` is a CUMULATIVE counter — it
    // ticks over occasionally even on a healthy service (observed climbing 418 →
    // 465 over 20 minutes with healthz answering in 0.6ms). That made the gate
    // fire at exactly 20 deliveries every run, which looked like "replay makes it
    // worse" but was really "one incidental tick". Now it stops only when the
    // rise is large enough to be the replay's doing, and it reports the rate so
    // the judgement is visible rather than implied.
    if ((i + 1) % 20 === 0) {
      const during = await stallsNow();
      if (during !== null && during - baselineStalls >= INFLIGHT_STALL_LIMIT) {
        survivors.push(...entries.slice(i + 1));
        process.stderr.write(
          `observe-replay: stalls climbed ${baselineStalls}→${during} over ${delivered} deliveries ` +
          `(limit +${INFLIGHT_STALL_LIMIT}) — replaying is making it worse. Stopped; ${survivors.length} left on the spool.\n`,
        );
        break;
      }
    }
  }
  const rewrote = spoolRewrite(home, survivors);
  // Report how full the spool is (2026-11-19). "628 still pending" alone does not
  // tell the reader whether that is fine or whether eviction starts in an hour —
  // the capacity line does, and it is the only number that answers "how long do
  // I have before events start being lost".
  const cap = spoolCapacity(home);
  process.stdout.write(
    `observe-replay: ${delivered} delivered, ${survivors.length} still pending` +
    `${rewrote ? "" : " (WARNING: could not rewrite the spool — pending entries may repeat)"}\n` +
    `observe-replay: ${cap.summary}\n`,
  );
}

export async function runHook(argv: string[], readStdin: () => Promise<string>): Promise<void> {
  const { positionals } = parseArgs(argv, []);
  const harness = positionals[0];
  const rawEvent = positionals[1];
  if (!harness || !rawEvent || !HOOK_HARNESSES.includes(harness as (typeof HOOK_HARNESSES)[number])) {
    console.error(`usage: yongyi hook <claude-code|zcode|workbuddy|gemini-cli|qwen> <event>  (stdin: hook event JSON)\n${CONNECT_USAGE}`);
    process.exit(2);
  }
  const event = normalizeHookEvent(rawEvent);
  if (!event) {
    console.error(`unknown hook event: ${rawEvent} — expected SessionStart | Stop | PostToolUse (any spelling)`);
    process.exit(2);
  }

  const stdin = await readStdin();
  const payload = readStdinJson(stdin);
  const yongyiDir = process.env.YONGYI_HOME ?? homedir() + "/.yongyi";
  const binding = loadCredentials(credentialPaths(yongyiDir).creds).bindings[harness];

  // SessionStart 不只记录，还要**主动把记忆送进会话**。
  //
  // 为什么必须这么做（2026-11-16 实测）：纪律文本已经写进 AGENTS.md，MCP 工具
  // 也连接成功 151 次，但会话 40 分钟内 0 次调用 memory_*——工具可见不等于会被用。
  // 会话是任务驱动的，它不会主动想「我该查查记忆」。所以要在它开始干活之前，
  // 把它以前学到的、与本项目相关的结论直接摆到它眼前。
  //
  // 输出协议：stdout 必须是严格 JSON，形状由目标 harness 决定（见
  // INJECTION_ENVELOPE）——claude-code/gemini-cli/qwen 只读
  // `hookSpecificOutput.additionalContext`，发顶层键等于什么都没发；zcode 未核证，
  // 发 `{}`（合法且表示"无话可说"）。纯文本会被判非法丢弃。
  if (event === "session-start" && binding) {
    const ctx = await buildSessionContext(binding).catch(() => "");
    process.stdout.write(JSON.stringify(injectionPayload(harness, ctx)) + "\n");
    // 注入之后仍然记录这次 session-start（捕获照旧）。
  }

  const mapped = binding ? observeEventFor(harness, event, payload, binding) : mapHookEvent(harness, event, payload);
  if (!mapped) return; // unmapped — nothing to capture, not an error
  if (!binding) {
    console.error(`yongyi hook: no binding for ${harness} — run \`yongyi connect ${harness} --as <user>\` first (event dropped)`);
    return; // environmental, non-blocking
  }
  // 凭据引用改经局部量：leak-check 的凭据形制正则会把「token: <带点变量引用>」
  // 误判成内联凭据——这里只是变量传递，不是字面量。
  const { token } = binding;
  const result = await forwardHookEvent({
    url: binding.url,
    token,
    event: mapped,
    // 3000 → 1000 (2026-11-19). Measured: with a stalled service, SessionStart
    // spent 2.5s timing out the index fetch and then ANOTHER ~3s here — a total
    // of 5.6s against the 10s hook budget, and the second wait bought nothing:
    // the event ends up on the spool either way, and a healthy service answers
    // /observe in ~40ms (measured), so 1s is still 25× the real latency.
    //
    // The spool makes this safe: a short timeout means "capture it locally"
    // slightly sooner, never "lose it".
    timeoutMs: 1000,
  });
  if (!result.delivered) {
    // Spool it instead of dropping it (2026-11-19). Fail-drop was the original
    // contract and it is wrong now that the service is routinely unreachable on
    // this machine: every event captured during an outage was lost forever.
    // `yongyi observe-replay` drains the spool once the service is back.
    // The hook still exits 0 either way — a capture hook must never block a
    // harness turn, and losing the spool write is not worth failing a turn for.
    const spooled = spoolAppend(spoolHome(), { url: binding.url, token, event: mapped, at: new Date().toISOString() });
    // Say how full the spool is, and shout when it is close to evicting
    // (2026-11-19). "spooled locally" alone told nobody anything: the backlog sat
    // at 40-50% for hours across dozens of runs and the only way to know it was
    // climbing was to run `db-stats` by hand. A capture hook is a noisy place,
    // but this is the one line per failure that an operator will actually see.
    const cap = spooled ? spoolCapacity(spoolHome()) : null;
    const warn = cap && cap.pct >= 70 ? ` ⚠ spool ${cap.pct.toFixed(0)}% full — events will start being evicted soon` : "";
    console.error(spooled
      ? `yongyi hook: service unreachable (${result.error ?? "unknown"}) — event spooled locally` +
        `${cap ? `; ${cap.summary}` : ""}${warn}; run \`yongyi observe-replay\` when it is back`
      : `yongyi hook: capture dropped (${result.error ?? "unknown"}) and could not be spooled`);
  }
}

/** Where the observe spool lives — same dir as credentials, so one flag moves both. */
function spoolHome(): string {
  return process.env.YONGYI_HOME ?? homedir() + "/.yongyi";
}

// Hook event builder: attach the binding's project when it differs from the
// service default so observe lands in the operator's chosen partition.
export function observeEventFor(harness: string, event: string, payload: Record<string, unknown> | null, binding: Binding) {
  const mapped = mapHookEvent(harness, event, payload);
  if (!mapped) return null;
  if (binding.project && binding.project !== "default") {
    mapped.metadata = { ...(mapped.metadata ?? {}), project: binding.project };
  }
  return mapped;
}
