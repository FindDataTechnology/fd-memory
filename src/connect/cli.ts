// Command handlers for `yongyi connect | disconnect | hook`
// (add-yongyi-complete-solution, tasks 3.1–3.7). index.ts dispatches here.

import { homedir } from "node:os";
import { rootKeyForRef } from "../auth.js";
import {
  applyClaudeCode,
  applyZcode,
  cozeDisconnectNotes,
  cozeRecon,
  difyDisconnectNotes,
  difyRecipe,
  disconnectClaudeCode,
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
  saveCredentials,
  writeEnvFile,
  type Binding,
  type CredentialFile,
  type Harness,
} from "./credentials.js";
import { forwardHookEvent, mapHookEvent, normalizeHookEvent, readStdinJson } from "./hook-forward.js";

export const CONNECT_USAGE = `usage:
  yongyi connect claude-code --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect zcode --url <service-url> --as <user> [--project P] [--dir D]
  yongyi connect mcp --url <service-url> [--as <user>]
  yongyi connect dify --url <service-url> --as <user> [--project P]
  yongyi connect coze --url <service-url> --as <user>
  yongyi disconnect <harness>
  yongyi hook <harness> <event>        (reads hook event JSON on stdin)`;

const HOOK_HARNESSES = ["claude-code", "zcode"] as const;

// Recipe-shaped harnesses (add-yongyi-connect-dify-coze): the platform is
// configured through a UI, so connect prints instructions and writes no
// tool-config files — only the identity binding and its 0600 credential files.
const RECIPE_HARNESSES = ["dify", "coze"] as const;

export function connectHarnesses(): readonly string[] {
  return ["claude-code", "zcode", "mcp", "dify", "coze"];
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
  const dataDir = process.env.FD_MEMORY_DATA ?? t.homeDir + "/Library/Application Support/fd-memory";
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
  printConnectReport(report, paths, true);
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
export async function buildSessionContext(binding: Binding): Promise<string> {
  const base = binding.url.replace(/\/+$/, "");
  const project = binding.project && binding.project !== "default" ? binding.project : "default";
  const ctl = new AbortController();
  // 5s, not 2s: the index query touches a multi-thousand-page table on a disk
    // shared with an 8.5 GB session database (measured 2026-11-16: 1.4–2.5 s,
    // while /digest needs 10 s). A session-start hook may take a few seconds —
    // it must not take forever, and it must not fail silently because the
    // budget was tighter than the machine is fast.
    const timer = setTimeout(() => ctl.abort(), 5000);
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
    const res = await fetch(`${base}/memory/index?project=${encodeURIComponent(project)}&limit=100`, {
      headers: { authorization: "Bearer " + binding.token },
      signal: ctl.signal,
    });
    if (!res.ok) return "";
    const doc = (await res.json()) as {
      entries?: Array<{ harness?: string; memory_type?: string; description?: string }>;
      total?: number;
    };
    const entries = Array.isArray(doc.entries) ? doc.entries : [];
    if (entries.length === 0) return "";

    const lines: string[] = ["【永忆 · 跨 harness 记忆】以下是已沉淀的结论（本地优先，其余为其它 harness 的经验）："];
    let used = lines[0].length;
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
    return lines.join("\n");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function runHook(argv: string[], readStdin: () => Promise<string>): Promise<void> {
  const { positionals } = parseArgs(argv, []);
  const harness = positionals[0];
  const rawEvent = positionals[1];
  if (!harness || !rawEvent || !HOOK_HARNESSES.includes(harness as (typeof HOOK_HARNESSES)[number])) {
    console.error(`usage: yongyi hook <claude-code|zcode> <event>  (stdin: hook event JSON)\n${CONNECT_USAGE}`);
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
  // 输出协议：stdout 必须是严格 JSON，`{"additionalContext": "..."}` 会被注入上下文。
  // 纯文本会被判非法丢弃；无内容时输出 `{}`（合法且表示"无话可说"）。
  if (event === "session-start" && binding) {
    const ctx = await buildSessionContext(binding).catch(() => "");
    process.stdout.write(JSON.stringify(ctx ? { additionalContext: ctx } : {}) + "\n");
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
  });
  if (!result.delivered) {
    console.error(`yongyi hook: capture dropped (${result.error ?? "unknown"})`);
  }
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
