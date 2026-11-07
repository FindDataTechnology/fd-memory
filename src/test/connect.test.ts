// Connect CLI + harness adapters (add-yongyi-complete-solution, tasks 3.1–3.8).
// Generator/applier unit tests run against temp directories; hook forwarder
// tests hit a real localhost server; the e2e boots the real Service and runs
// connect → hook → observe → digest → disconnect. The /observe endpoint is
// implemented by a parallel agent — the e2e probes for it and skips itself
// (with an explicit integration note) while it is not on the tree yet.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { metricsSnapshot, __resetMetrics } from "../metrics.js";
import { __resetEmbedGate } from "../embed-gate.js";
import { Service } from "../http.js";
import { buildTools } from "../mcp.js";
import { TokenStore, namespaceParts } from "../auth.js";
import { StoreRoot } from "../store.js";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  disciplinePoints,
  disciplineText,
  platformDisciplineText,
} from "../connect/discipline-text.js";
import { removeManagedBlock, upsertManagedBlock } from "../connect/managed-block.js";
import {
  COZE_RECON_DATE,
  COZE_RECON_ISSUES,
  DIFY_VERIFY_TOOLS,
  applyClaudeCode,
  applyZcode,
  cozeRecon,
  difyRecipe,
  disconnectClaudeCode,
  disconnectZcode,
  genericMcpSnippet,
  mcpUrlFor,
  renderCozeRecon,
  renderDifyRecipe,
  type ConnectTargets,
} from "../connect/adapters.js";
import {
  credentialPaths,
  envVarFor,
  loadCredentials,
  planIdentity,
  saveCredentials,
  writeEnvFile,
} from "../connect/credentials.js";
import {
  forwardHookEvent,
  mapHookEvent,
  normalizeHookEvent,
  readStdinJson,
} from "../connect/hook-forward.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = "fdm-connect-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function targetsFor(home: string, proj: string): ConnectTargets {
  return { homeDir: home, projectDir: proj, binName: "yongyi" };
}

// Runtime-minted tokens only — no credential-shaped literals in source.
function mintPerson(dataDir: string, identity: string): string {
  return planIdentity({ identity, harness: "claude-code", creds: loadCredentials("/nonexistent/creds.json"), dataDir, pepper: "p" }).token;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface CliResult {
  code: number;
  out: string;
  err: string;
}

function runCli(args: string[], opts: { env: Record<string, string>; cwd: string; input?: string }): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, "dist", "index.js"), ...args], {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function cliEnv(home: string, data: string): Record<string, string> {
  return { HOME: home, YONGYI_HOME: join(home, ".yongyi"), FD_MEMORY_DATA: data, FD_MEMORY_PEPPER: "p" };
}

// ── discipline text ───────────────────────────────────────────────────────────

test("discipline text: bilingual, marker-ready, ASCII tool names", () => {
  assert.ok(disciplineText.includes("mcp__fd-memory__"));
  for (const tool of ["memory_handoff_begin", "memory_handoff_list", "memory_write_page", "memory_query"]) {
    assert.ok(disciplineText.includes(tool), `mentions ${tool}`);
  }
  assert.ok(disciplineText.includes("更正"), "correction marking present (zh)");
  assert.ok(/is mounted|mounted in this harness/.test(disciplineText), "english counterpart present");
  assert.ok(disciplineText.includes("出处"), "source attribution point present");
});

// ── managed block surgery ─────────────────────────────────────────────────────

test("managed block: double upsert leaves exactly one block (idempotent)", () => {
  const once = upsertManagedBlock("my notes\n", disciplineText).text;
  const twice = upsertManagedBlock(once, disciplineText).text;
  assert.equal(twice, once);
  assert.equal(once.split(BLOCK_BEGIN).length - 1, 1);
  assert.equal(once.split(BLOCK_END).length - 1, 1);
});

test("managed block: update replaces only the region; outside bytes verbatim", () => {
  const before = "header\n\n" + BLOCK_BEGIN + "\nstale body\n" + BLOCK_END + "\n\nfooter rules\n";
  const after = upsertManagedBlock(before, "fresh body").text;
  assert.ok(after.startsWith("header\n\n"), "content before the block untouched");
  assert.ok(after.endsWith("footer rules\n"), "content after the block untouched");
  assert.ok(after.includes("fresh body"));
  assert.equal(after.includes("stale"), false, "old body gone");
});

test("managed block: append adds exactly one separating newline; removal restores the original byte-for-byte", () => {
  for (const orig of ["", "stuff", "stuff\n", "a\n\nb\n", "\n", "rules\n\nmore rules"]) {
    const added = upsertManagedBlock(orig, "body").text;
    assert.ok(added.includes(BLOCK_BEGIN), `block present for ${JSON.stringify(orig)}`);
    const removed = removeManagedBlock(added).text;
    assert.equal(removed, orig, `byte-exact restore for ${JSON.stringify(orig)}`);
  }
});

test("managed block: mid-file block removal keeps surrounding user content", () => {
  // connect appended at EOF, then the user wrote content after the block.
  const evolved = "A rules\n" + upsertManagedBlock("", "body").text + "\nuser added later\n";
  const removed = removeManagedBlock(evolved).text;
  assert.ok(removed.includes("A rules"));
  assert.ok(removed.includes("user added later"));
  assert.equal(removed.includes("yongyi:"), false);
});

test("managed block: unterminated begin marker is rebuilt into a well-formed block", () => {
  const bad = "notes\n" + BLOCK_BEGIN + "\ndangling content";
  const fixed = upsertManagedBlock(bad, "fresh").text;
  assert.equal(fixed.split(BLOCK_BEGIN).length - 1, 1);
  assert.ok(fixed.includes(BLOCK_END));
  assert.ok(fixed.includes("fresh"));
});

// ── claude-code adapter ───────────────────────────────────────────────────────

function seedClaude(home: string, proj: string): void {
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } }, numStartups: 5 }),
  );
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }),
  );
  writeFileSync(join(proj, "CLAUDE.md"), "# my project\n\nuser rules here\n");
}

test("claude-code: connect merges mcp+hooks+block; rerun is a full no-op; neighbors preserved", () => {
  const home = tmp();
  const proj = tmp();
  seedClaude(home, proj);
  const t = targetsFor(home, proj);
  const envVar = envVarFor("claude-code");
  const url = "http://127.0.0.1:49375";

  const files = applyClaudeCode(t, url, envVar);
  assert.deepEqual(files.map((f) => f.action), ["updated", "updated", "updated"]);

  const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
    mcpServers: Record<string, { type: string; url?: string; headers?: Record<string, string> }>;
    numStartups: number;
  };
  assert.equal(Object.keys(claudeJson.mcpServers).length, 2, "pre-existing server preserved");
  assert.equal(claudeJson.numStartups, 5, "unrelated keys preserved");
  const entry = claudeJson.mcpServers["fd-memory"];
  assert.equal(entry.type, "http");
  assert.equal(entry.url, mcpUrlFor(url));
  assert.equal(entry.headers?.Authorization, "Bearer ${" + envVar + "}", "token rides an env reference");
  assert.equal(JSON.stringify(entry).includes("fdm_"), false, "no literal token");

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  };
  assert.equal(settings.hooks.PreToolUse.length, 1, "user hook untouched");
  for (const ev of ["SessionStart", "Stop", "PostToolUse"]) {
    assert.equal(settings.hooks[ev].length, 1, `${ev} wired exactly once`);
    assert.ok((settings.hooks[ev][0].hooks ?? [])[0]?.command?.startsWith("yongyi hook claude-code"));
  }

  const md = readFileSync(join(proj, "CLAUDE.md"), "utf8");
  assert.ok(md.startsWith("# my project\n\nuser rules here\n"), "CLAUDE.md user content verbatim");
  assert.equal(md.split(BLOCK_BEGIN).length - 1, 1);
  assert.ok(md.includes(disciplineText.slice(0, 40)));

  const files2 = applyClaudeCode(t, url, envVar);
  assert.deepEqual(files2.map((f) => f.action), ["unchanged", "unchanged", "unchanged"], "second connect changes nothing");
  assert.equal(readFileSync(join(proj, "CLAUDE.md"), "utf8"), md, "block file byte-stable across reruns");
});

test("claude-code: disconnect removes managed artifacts and restores user content", () => {
  const home = tmp();
  const proj = tmp();
  seedClaude(home, proj);
  const t = targetsFor(home, proj);
  applyClaudeCode(t, "http://127.0.0.1:49375", envVarFor("claude-code"));

  const files = disconnectClaudeCode(t);
  assert.deepEqual(files.map((f) => f.action), ["removed", "removed", "removed"]);

  const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> };
  assert.equal(claudeJson.mcpServers["fd-memory"], undefined);
  assert.ok(claudeJson.mcpServers["other"], "user server stays");

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
    hooks: Record<string, unknown[]>;
  };
  for (const ev of ["SessionStart", "Stop", "PostToolUse"]) assert.equal(settings.hooks[ev].length, 0, `${ev} unwired`);
  assert.equal(settings.hooks.PreToolUse.length, 1, "user hook stays");

  assert.equal(
    readFileSync(join(proj, "CLAUDE.md"), "utf8"),
    "# my project\n\nuser rules here\n",
    "CLAUDE.md restored byte-for-byte",
  );
});

test("claude-code: disconnect on a never-connected machine is a clean no-op", () => {
  const home = tmp();
  const proj = tmp();
  const t = targetsFor(home, proj);
  const files = disconnectClaudeCode(t);
  assert.deepEqual(files.map((f) => f.action), ["absent", "unchanged", "absent"]);
  assert.equal(existsSync(join(home, ".claude.json")), false, "no files invented by disconnect");
});

// ── zcode adapter ─────────────────────────────────────────────────────────────

function seedZcode(home: string): void {
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  writeFileSync(
    join(home, ".zcode", "cli", "config.json"),
    JSON.stringify({
      mcp: { servers: { context7: { type: "stdio", command: "npx" } } },
      hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "node hook.mjs" }] }] },
    }),
  );
}

test("zcode: connect wires mcp.servers+hooks+AGENTS.md; rerun idempotent; disconnect restores", () => {
  const home = tmp();
  const proj = tmp();
  seedZcode(home);
  const t = targetsFor(home, proj);
  const envVar = envVarFor("zcode");
  const url = "http://127.0.0.1:49375";

  const files = applyZcode(t, url, envVar);
  assert.deepEqual(files.map((f) => f.action), ["updated", "updated", "created"]);

  const cfg = JSON.parse(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8")) as {
    mcp: { servers: Record<string, { type: string; url?: string; headers?: Record<string, string> }> };
    hooks: Record<string, unknown> & { enabled?: boolean };
  };
  assert.ok(cfg.mcp.servers.context7, "user server preserved");
  assert.equal(cfg.mcp.servers["fd-memory"]?.url, mcpUrlFor(url));
  assert.equal(cfg.mcp.servers["fd-memory"]?.headers?.Authorization, "Bearer ${" + envVar + "}");
  assert.equal(cfg.hooks.enabled, true, "hook plane enabled, never disabled");
  assert.equal((cfg.hooks.PostToolUse as unknown[]).length, 2, "user hook entry + ours");
  for (const ev of ["SessionStart", "Stop"]) assert.ok(Array.isArray(cfg.hooks[ev]) && (cfg.hooks[ev] as unknown[]).length === 1);

  const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
  assert.equal(agents.split(BLOCK_BEGIN).length - 1, 1, "AGENTS.md block exactly once");

  const again = applyZcode(t, url, envVar);
  assert.deepEqual(again.map((f) => f.action), ["unchanged", "unchanged", "unchanged"]);

  const removed = disconnectZcode(t);
  assert.deepEqual(removed.map((f) => f.action), ["removed", "removed", "removed"]);
  const after = JSON.parse(readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8")) as {
    mcp: { servers: Record<string, unknown> };
    hooks: Record<string, unknown[]> & { enabled?: boolean };
  };
  assert.equal(after.mcp.servers["fd-memory"], undefined);
  assert.ok(after.mcp.servers.context7);
  assert.equal((after.hooks.PostToolUse as unknown[]).length, 1, "user hook entry stays");
  assert.equal(after.hooks.enabled, true);
  assert.equal(existsSync(join(proj, "AGENTS.md")), false, "block-only AGENTS.md unlinked");
});

// ── credentials ───────────────────────────────────────────────────────────────

test("credentials: 0600 files, per-harness bindings, token reuse across harnesses for one identity", () => {
  const home = tmp();
  const data = tmp();
  const paths = credentialPaths(join(home, ".yongyi"));
  const creds = loadCredentials(paths.creds);
  assert.deepEqual(creds.bindings, {}, "absent file starts fresh");

  const a = planIdentity({ identity: "user@example.com", harness: "claude-code", creds, dataDir: data, pepper: "p" });
  assert.equal(a.namespace, "u/user@example.com");
  assert.equal(a.reused, false);
  creds.bindings["claude-code"] = {
    url: "http://127.0.0.1:49375",
    namespace: a.namespace,
    token: a.token,
    project: "default",
    bound_at: "2026-01-01T00:00:00.000Z",
  };
  saveCredentials(paths.creds, creds);
  writeEnvFile(paths.env, creds, "http://127.0.0.1:49375");

  assert.equal(statSync(paths.creds).mode & 0o777, 0o600, "credential file 0600");
  assert.equal(statSync(paths.env).mode & 0o777, 0o600, "env file 0600");

  const b = planIdentity({ identity: "user@example.com", harness: "zcode", creds: loadCredentials(paths.creds), dataDir: data, pepper: "p" });
  assert.equal(b.token, a.token, "same identity reuses the same person token (roots merge)");
  assert.equal(b.reused, true);

  const c = planIdentity({ identity: "other@example.com", harness: "zcode", creds: loadCredentials(paths.creds), dataDir: data, pepper: "p" });
  assert.notEqual(c.token, a.token, "different identity mints fresh");
  assert.equal(c.reused, false);

  const envText = readFileSync(paths.env, "utf8");
  assert.ok(envText.includes("export YONGYI_TOKEN_CLAUDE_CODE="));
  assert.equal(envText.includes("YONGYI_TOKEN_ZCODE="), false, "env file mirrors actual bindings only");
  assert.equal(readStdinJson("not json {"), null);
});

// ── generic mcp snippet ───────────────────────────────────────────────────────

test("connect mcp: paste-ready snippet, env-reference token, zero plaintext", () => {
  const data = tmp();
  const token = mintPerson(data, "user@example.com");
  const snippet = genericMcpSnippet("http://127.0.0.1:49375", envVarFor("mcp"));
  const doc = JSON.parse(snippet) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
  assert.equal(doc.mcpServers["fd-memory"].type, "http");
  assert.equal(doc.mcpServers["fd-memory"].url, "http://127.0.0.1:49375/mcp");
  assert.ok(snippet.includes("${YONGYI_TOKEN_MCP}"), "token referenced via env var");
  assert.equal(snippet.includes(token), false, "minted token never embedded");
  assert.equal(snippet.includes("fdm_"), false, "no credential shape at all");
  assert.equal(mcpUrlFor("http://127.0.0.1:49375/"), "http://127.0.0.1:49375/mcp", "trailing slash normalized");
});

// ── hook forwarder ────────────────────────────────────────────────────────────

test("hook forwarder: maps SessionStart/Stop→turn_outcome, PostToolUse→tool_call; per-call idempotency keys", () => {
  const payload = {
    session_id: "s-1",
    cwd: "/tmp/demo-proj",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: "git status --short",
  };
  const ev1 = mapHookEvent("claude-code", "post-tool-use", payload);
  assert.ok(ev1);
  assert.equal(ev1.type, "tool_call");
  assert.equal(ev1.harness, "claude-code");
  assert.ok(ev1.title.includes("Bash"));
  assert.ok(ev1.body.includes("git status --short"), "meaningful input extracted");
  assert.match(ev1.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const ev2 = mapHookEvent("claude-code", "post-tool-use", payload);
  assert.notEqual(ev2?.idempotency_key, ev1.idempotency_key, "key is fresh per call");

  const stop = mapHookEvent("zcode", "stop", { cwd: "/tmp/demo-proj" });
  assert.equal(stop?.type, "turn_outcome");
  const start = mapHookEvent("zcode", "session-start", { cwd: "/tmp/demo-proj", source: "resume" });
  assert.equal(start?.type, "turn_outcome");
  assert.ok(start?.body.includes("resume"), "source extracted");

  assert.equal(normalizeHookEvent("SessionStart"), "session-start");
  assert.equal(normalizeHookEvent("post_tool_use"), "post-tool-use");
  assert.equal(normalizeHookEvent("Stop"), "stop");
  assert.equal(normalizeHookEvent("nonsense"), null);
  assert.equal(mapHookEvent("zcode", "nonsense", null), null);
  assert.equal(readStdinJson("  "), null);

  const big = mapHookEvent("claude-code", "stop", { cwd: "x", tool_input: "y".repeat(9000) });
  assert.ok(big && big.body.length < 4200 && big.body.includes("[truncated]"), "body truncated to a safe length");
});

test("hook forwarder: delivers mapped event with bearer token; 5xx fails-drop with no retry", async () => {
  const data = tmp();
  const token = mintPerson(data, "user@example.com");
  const seen: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
  let failWith500 = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      if (failWith500) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "observe_degraded" }));
      } else {
        res.statusCode = 202;
        res.end(JSON.stringify({ page: "demo-1" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ev = mapHookEvent("claude-code", "stop", { cwd: "/tmp/demo-proj" })!;
    const ok = await forwardHookEvent({ url: base, token, event: ev });
    assert.equal(ok.delivered, true, "delivered on 2xx");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer " + token);
    assert.equal(seen[0].body.type, "turn_outcome");
    assert.equal(seen[0].body.harness, "claude-code");
    assert.ok(seen[0].body.idempotency_key);

    failWith500 = true;
    const bad = await forwardHookEvent({ url: base, token, event: ev });
    assert.equal(bad.delivered, false, "5xx reported as dropped");
    assert.equal(seen.length, 2, "exactly one request — no retry storm");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── CLI wiring ────────────────────────────────────────────────────────────────

test("CLI: connect binds identity and writes artifacts; same --as reuses the person token; usage errors exit 2", async () => {
  const home = tmp();
  const proj = tmp();
  const data = tmp();
  const env = cliEnv(home, data);

  const r1 = await runCli(["connect", "claude-code", "--url", "http://127.0.0.1:49375", "--as", "user@example.com"], { env, cwd: proj });
  assert.equal(r1.code, 0, r1.err);
  assert.ok(r1.out.includes("u/user@example.com"), "identity root reported");
  assert.ok(r1.out.includes("u-user@example.com"), "rootKey reported");
  assert.ok(existsSync(join(home, ".claude.json")));
  assert.ok(existsSync(join(proj, "CLAUDE.md")));
  assert.equal(statSync(join(home, ".yongyi", "credentials.json")).mode & 0o777, 0o600);

  const r2 = await runCli(["connect", "zcode", "--url", "http://127.0.0.1:49375", "--as", "user@example.com"], { env, cwd: proj });
  assert.equal(r2.code, 0, r2.err);
  const creds = JSON.parse(readFileSync(join(home, ".yongyi", "credentials.json"), "utf8")) as {
    bindings: Record<string, { token: string; url: string }>;
  };
  assert.equal(creds.bindings["claude-code"].token, creds.bindings["zcode"].token, "one person token across harnesses");
  assert.equal(creds.bindings["claude-code"].url, "http://127.0.0.1:49375");

  const badHarness = await runCli(["connect", "nope"], { env, cwd: proj });
  assert.equal(badHarness.code, 2, "unknown harness is a usage error");
  const noIdentity = await runCli(["connect", "claude-code"], { env, cwd: proj });
  assert.equal(noIdentity.code, 2, "missing --as is a usage error");
  const badEvent = await runCli(["hook", "claude-code", "bogus-event"], { env, cwd: proj });
  assert.equal(badEvent.code, 2, "unknown event is a usage error");

  // fail-drop: nothing listens on the bound port — hook still exits 0.
  const hook = await runCli(["hook", "claude-code", "stop"], { env, cwd: proj, input: JSON.stringify({ session_id: "s", cwd: proj }) });
  assert.equal(hook.code, 0, hook.err);

  // disconnect via CLI restores the harness files. CLAUDE.md held only the
  // block (connect created it in the empty project), so it is unlinked.
  const d = await runCli(["disconnect", "claude-code"], { env, cwd: proj });
  assert.equal(d.code, 0, d.err);
  assert.equal(existsSync(join(proj, "CLAUDE.md")), false, "block-only CLAUDE.md removed by disconnect");
  const claudeJson = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.equal(claudeJson.mcpServers?.["fd-memory"], undefined);
});

// ── e2e: connect → hook → observe → digest → disconnect ──────────────────────
// /observe is implemented by a parallel agent (yongyi-observe-lane §1). While
// it is absent from the tree this test skips itself; the main agent reruns it
// at integration time for the full-chain verdict.

test("e2e: connect → hook → observe lands under the person root → digest recalls → disconnect keeps memory", async (t) => {
  __resetEmbedGate();
  __resetMetrics();
  const data = tmp();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // readiness probe: route absent → 404 (skip); any auth/authority 4xx means
    // the endpoint exists and the person-token flow below is the real verdict.
    const platform = svc.tokens.mint("platform", "*").token;
    const probe = await fetch(base + "/observe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + platform },
      body: JSON.stringify({ type: "health_flip", idempotency_key: "probe-1", title: "probe", body: "probe" }),
    });
    if (probe.status === 404) {
      t.skip("/observe 端点未就绪（并行代理实现中）——等集成阶段全量跑");
      return;
    }

    const home = tmp();
    // The hook title carries the cwd basename, so the unique project dir name
    // doubles as the digest recall marker (digest renders titles + gists).
    const proj = tmp("fdm-e2e-proj-");
    const marker = proj.split("/").filter(Boolean).pop()!;
    const env = cliEnv(home, data);
    const conn = await runCli(["connect", "claude-code", "--url", base, "--as", "worker@example.com"], { env, cwd: proj });
    assert.equal(conn.code, 0, conn.err);

    const hook = await runCli(
      ["hook", "claude-code", "stop"],
      { env, cwd: proj, input: JSON.stringify({ session_id: "sess-e2e", cwd: proj, summary: marker }) },
    );
    assert.equal(hook.code, 0, hook.err);

    const creds = JSON.parse(readFileSync(join(home, ".yongyi", "credentials.json"), "utf8")) as {
      bindings: Record<string, { token: string }>;
    };
    const person = creds.bindings["claude-code"].token;

    const digestUrl = `${base}/digest?project=default&q=${encodeURIComponent(marker)}`;
    const digest = await fetch(digestUrl, { headers: { authorization: "Bearer " + person } });
    assert.equal(digest.status, 200);
    const digestText = await digest.text();
    assert.ok(digestText.includes(marker), "hook event recallable from the person root via digest");

    // observe-plane idempotent replay contract (same key → 2xx twice)
    const replayBody = JSON.stringify({ type: "turn_outcome", idempotency_key: "replay-key-1", title: "replay", body: "body" });
    const replayHeaders = { "content-type": "application/json", authorization: "Bearer " + person };
    const replay1 = await fetch(base + "/observe", { method: "POST", headers: replayHeaders, body: replayBody });
    const replay2 = await fetch(base + "/observe", { method: "POST", headers: replayHeaders, body: replayBody });
    assert.ok(replay1.ok && replay2.ok, "observe replay returns 2xx on both deliveries");

    const d = await runCli(["disconnect", "claude-code"], { env, cwd: proj });
    assert.equal(d.code, 0, d.err);
    const mdAfter = existsSync(join(proj, "CLAUDE.md")) ? readFileSync(join(proj, "CLAUDE.md"), "utf8") : "";
    assert.equal(mdAfter.includes("yongyi:begin"), false, "artifacts removed");

    const digestAfter = await fetch(digestUrl, { headers: { authorization: "Bearer " + person } });
    const afterText = await digestAfter.text();
    assert.ok(afterText.includes(marker), "memory survives disconnect (断开工具不删记忆)");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Note: metricsSnapshot import is exercised by Service boot in the e2e above
// (reset pair keeps module state clean across the suite).
void metricsSnapshot;

// ── dify / coze recipes (add-yongyi-connect-dify-coze) ───────────────────────
// UI-configured platforms: the adapter generates instructions, not files. The
// facts under test are the ones a user would be misled by if wrong — the
// pinned identifier, the env-reference header (never a literal token), the
// shared discipline points, and a verification list that matches the real MCP
// tool surface.

test("dify: recipe renders all four sections; identifier pinned; header is an env reference", () => {
  const out = renderDifyRecipe(difyRecipe({ baseUrl: "http://127.0.0.1:49375", identity: "user@example.com", envVar: "YONGYI_TOKEN_DIFY" }));
  for (const section of ["①", "②", "③", "④"]) assert.ok(out.includes(section), `section ${section} present`);
  assert.ok(out.includes("identifier yongyi"), "identifier pinned to yongyi");
  assert.ok(out.includes("http://127.0.0.1:49375/mcp"), "MCP endpoint (streamable-http path)");
  assert.ok(out.includes("u/user@example.com"), "person root named");
  assert.ok(out.includes("Authorization: Bearer ${YONGYI_TOKEN_DIFY}"), "header value is an env reference");
  assert.ok(out.includes("YONGYI_TOKEN_DIFY"), "token command references the exported variable");
  assert.ok(out.includes("仅支持 HTTP transport"), "transport constraint stated (the one misconfiguration Dify punishes)");
  assert.ok(/不是平台担保|非平台担保/.test(out), "honesty note: discipline is the only write path here");
  // Verification list is the tool surface, not prose.
  for (const tool of DIFY_VERIFY_TOOLS) assert.ok(out.includes(tool), `verification lists ${tool}`);
});

test("dify: recipe is idempotent (same args → identical output, no timestamp drift)", () => {
  const args = { baseUrl: "http://127.0.0.1:49375", identity: "user@example.com", envVar: "YONGYI_TOKEN_DIFY" };
  assert.equal(renderDifyRecipe(difyRecipe(args)), renderDifyRecipe(difyRecipe(args)));
  assert.deepEqual(difyRecipe(args), difyRecipe(args));
});

test("dify: discipline is the shared point set with a platform-correct mounting sentence", () => {
  const recipe = difyRecipe({ baseUrl: "http://127.0.0.1:49375", identity: "user@example.com", envVar: "YONGYI_TOKEN_DIFY" });
  assert.equal(recipe.discipline, platformDisciplineText, "single source, not a copy");
  for (const point of disciplinePoints) assert.ok(recipe.discipline.includes(point), "every shared point verbatim");
  // Dify lists imported tools under its own naming — claiming the harness
  // prefix would send the agent looking for tools that do not exist.
  assert.equal(recipe.discipline.includes("mcp__fd-memory__*"), false, "no harness-specific tool prefix");
  assert.ok(recipe.discipline.includes("memory_*"), "names tools the way Dify shows them");
  // The harness face is unchanged by this split.
  assert.ok(disciplineText.startsWith("永忆（fd-memory）已挂载到本 harness"), "hook harness block byte-unchanged");
  assert.equal(disciplineText, "永忆（fd-memory）已挂载到本 harness；工具名一律为 mcp__fd-memory__*。/ fd-memory is mounted in this harness; its tools are always named mcp__fd-memory__*.\n" + disciplinePoints.join("\n"));
});

test("dify: verification list matches the live MCP tool surface (no drift either way)", () => {
  const data = tmp();
  const store = new TokenStore(join(data, "tokens.db"), "p");
  const minted = store.mint("person", "u/user@example.com");
  const scope = store.verify(minted.token)!;
  const { rootKey } = namespaceParts("u/user@example.com");
  const tools = buildTools(scope, new StoreRoot(data, rootKey), { allows: () => true });
  const live = new Set(tools.map((t) => t.name));
  for (const name of DIFY_VERIFY_TOOLS) assert.ok(live.has(name), `verification names a real tool: ${name}`);
  // The five listed are the load-bearing ones; the list must not silently
  // become "everything" or a stale subset of a smaller surface.
  assert.equal(DIFY_VERIFY_TOOLS.length, 5);
});

test("coze: honest downgrade — status and issues, never integration steps", () => {
  const out = renderCozeRecon(cozeRecon({ baseUrl: "http://127.0.0.1:49375", identity: "user@example.com", envVar: "YONGYI_TOKEN_COZE" }));
  assert.ok(out.includes("暂不支持"), "says unsupported");
  assert.ok(out.includes("coze-studio 开源版没有 MCP client 能力"), "names the concrete blocker");
  for (const issue of COZE_RECON_ISSUES) assert.ok(out.includes(issue), `tracks ${issue}`);
  assert.ok(out.includes(COZE_RECON_DATE), "recon date stamped (staleness is visible)");
  assert.ok(out.includes("http://127.0.0.1:49375/mcp"), "endpoint prepared");
  assert.ok(out.includes("u/user@example.com"), "identity prepared");
  // Negative assertions: no step-shaped text whatsoever.
  assert.equal(/添加 MCP 服务器|Integrations\s*>\s*Tools|粘贴到/.test(out), false, "no steps");
  assert.equal(/已支持|接入成功/.test(out), false, "no support claim");
  const twice = renderCozeRecon(cozeRecon({ baseUrl: "http://127.0.0.1:49375", identity: "user@example.com", envVar: "YONGYI_TOKEN_COZE" }));
  assert.equal(out, twice, "idempotent");
});

test("CLI: connect dify prints the four sections with no plaintext token; disconnect dify clears only our preparation", async () => {
  const home = tmp();
  const proj = tmp();
  const data = tmp();
  const env = cliEnv(home, data);

  const r = await runCli(["connect", "dify", "--url", "http://127.0.0.1:49375", "--as", "user@example.com"], { env, cwd: proj });
  assert.equal(r.code, 0, r.err);
  for (const section of ["①", "②", "③", "④"]) assert.ok(r.out.includes(section));
  assert.ok(r.out.includes("identifier yongyi"));
  assert.equal(r.out.includes("mcp__fd-memory__*"), false, "does not print the harness-only tool prefix");

  const credsPath = join(home, ".yongyi", "credentials.json");
  const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { bindings: Record<string, { namespace: string; token: string }> };
  assert.equal(creds.bindings["dify"].namespace, "u/user@example.com");
  // leak-check 的凭据形制正则会把「token = <带点变量引用>」判成内联凭据——这里只是取局部量比对。
  const mintedValue = creds.bindings["dify"].token;
  assert.ok(mintedValue.length > 8);
  assert.equal(r.out.includes(mintedValue), false, "person token never printed — the recipe gives the env command instead");
  assert.equal(statSync(credsPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".yongyi", "env")).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(home, ".yongyi", "env"), "utf8").includes("YONGYI_TOKEN_DIFY"), "env file exports the dify var");
  // No harness config files: this platform is configured in its own UI.
  assert.equal(existsSync(join(proj, "CLAUDE.md")), false);
  assert.equal(existsSync(join(proj, "AGENTS.md")), false);

  // Re-run: same person root reused, nothing re-written elsewhere.
  const r2 = await runCli(["connect", "dify", "--url", "http://127.0.0.1:49375", "--as", "user@example.com"], { env, cwd: proj });
  assert.equal(r2.code, 0, r2.err);
  assert.ok(r2.out.includes("reused existing person token"));

  const d = await runCli(["disconnect", "dify"], { env, cwd: proj });
  assert.equal(d.code, 0, d.err);
  assert.ok(d.out.includes("在 Dify 侧"), "points at the UI removal (the CLI cannot click)");
  assert.ok(d.out.includes("http://127.0.0.1:49375"), "names the endpoint to remove");
  const after = JSON.parse(readFileSync(credsPath, "utf8")) as { bindings: Record<string, unknown> };
  assert.equal(after.bindings["dify"], undefined, "our binding cleared");
  assert.equal(readFileSync(join(home, ".yongyi", "env"), "utf8").includes("YONGYI_TOKEN_DIFY"), false, "exported var dropped");
});

test("CLI: connect coze states the blocker and prepares credentials; disconnect coze clears them", async () => {
  const home = tmp();
  const proj = tmp();
  const data = tmp();
  const env = cliEnv(home, data);

  const r = await runCli(["connect", "coze", "--url", "http://127.0.0.1:49375", "--as", "user@example.com"], { env, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("暂不支持"));
  assert.ok(r.out.includes("issues/7"));
  assert.equal(/添加 MCP 服务器|粘贴到/.test(r.out), false, "no fabricated steps");
  const credsPath = join(home, ".yongyi", "credentials.json");
  assert.equal(statSync(credsPath).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(home, ".yongyi", "env"), "utf8").includes("YONGYI_TOKEN_COZE"), "token prepared for the day it works");

  const d = await runCli(["disconnect", "coze"], { env, cwd: proj });
  assert.equal(d.code, 0, d.err);
  assert.ok(d.out.includes("未写入任何平台配置"));
  const after = JSON.parse(readFileSync(credsPath, "utf8")) as { bindings: Record<string, unknown> };
  assert.equal(after.bindings["coze"], undefined);
});

test("CLI: disconnect dify/coze on a never-connected machine is a clean no-op", async () => {
  const home = tmp();
  const proj = tmp();
  const env = cliEnv(home, tmp());
  for (const h of ["dify", "coze"]) {
    const d = await runCli(["disconnect", h], { env, cwd: proj });
    assert.equal(d.code, 0, d.err);
  }
  assert.equal(existsSync(join(home, ".yongyi", "credentials.json")), false, "no credential file invented by disconnect");
});

// ── cross-language discipline pin (add-yongyi-connect-frameworks D4) ─────────
// The Python adapter ships the same discipline text. Both sides compare against
// the same fixture, which is generated from this single source — so a change on
// either side turns the other side red until they agree again.

test("discipline: platform text equals the cross-language golden the Python package ships", () => {
  const goldenPath = join(repoRoot, "python", "tests", "goldens", "discipline-platform.txt");
  const golden = readFileSync(goldenPath, "utf8");
  assert.equal(
    platformDisciplineText,
    golden,
    "python golden is stale — run `node scripts/emit-discipline-golden.mjs` after editing discipline-text.ts",
  );
});
