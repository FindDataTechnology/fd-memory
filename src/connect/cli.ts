// Command handlers for `yongyi connect | disconnect | hook`
// (add-yongyi-complete-solution, tasks 3.1–3.7). index.ts dispatches here.

import { homedir } from "node:os";
import { rootKeyForRef } from "../auth.js";
import {
  applyClaudeCode,
  applyZcode,
  disconnectClaudeCode,
  disconnectZcode,
  genericMcpSnippet,
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
  yongyi disconnect <harness>
  yongyi hook <harness> <event>        (reads hook event JSON on stdin)`;

const HOOK_HARNESSES = ["claude-code", "zcode"] as const;

export function connectHarnesses(): readonly string[] {
  return ["claude-code", "zcode", "mcp"];
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
    console.error(`unknown harness: ${harness ?? "(none)"} — expected claude-code | zcode | mcp\n${CONNECT_USAGE}`);
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
    console.error(`unknown harness: ${harness ?? "(none)"} — expected claude-code | zcode | mcp\n${CONNECT_USAGE}`);
    process.exit(2);
  }
  const t = targets({});
  let files: FileWrite[];
  if (harness === "claude-code") {
    files = disconnectClaudeCode(t);
  } else if (harness === "zcode") {
    files = disconnectZcode(t);
  } else {
    console.log("disconnect mcp: nothing to remove — `connect mcp` writes no tool config files.");
    return;
  }
  console.log(`disconnected ${harness} (memory data untouched)`);
  printFileWrites(files);
}

// ── hook ─────────────────────────────────────────────────────────────────────
// Fail-drop forwarder: reads the hook event JSON on stdin, maps and POSTs it
// to /observe with the harness's bound person token. ANY delivery failure —
// unreachable service, 5xx, timeout, missing binding — logs to stderr and
// exits 0: a capture hook must never block a harness turn. Only usage errors
// exit non-zero (2).
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
  const mapped = binding ? observeEventFor(harness, event, payload, binding) : mapHookEvent(harness, event, payload);
  if (!mapped) return; // unmapped — nothing to capture, not an error
  if (!binding) {
    console.error(`yongyi hook: no binding for ${harness} — run \`yongyi connect ${harness} --as <user>\` first (event dropped)`);
    return; // environmental, non-blocking
  }
  const result = await forwardHookEvent({
    url: binding.url,
    token: binding.token,
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
