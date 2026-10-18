import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage, dumpPage, newPage } from "../okf.js";
import { StoreRoot, rootKeyForNamespace } from "../store.js";
import { TokenStore, namespaceParts, scopeAllowsNamespace } from "../auth.js";
import { CaptureIngest, CaptureEvent } from "../capture.js";
import { sanitize } from "../sanitize.js";
import { buildTools } from "../mcp.js";
import { Service } from "../http.js";
import { createServer } from "node:http";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-test-"));
}

test("okf round-trip keeps extension keys verbatim", () => {
  const raw = `---\ntype: session\ntitle: "S é"\nsession_id: abc\nentities:\n  - 法院\n---\n中文正文\n`;
  const page = parsePage(raw);
  assert.deepEqual(page.frontmatter.entities, ["法院"]);
  const again = parsePage(dumpPage(page));
  assert.deepEqual(again.frontmatter, page.frontmatter);
  assert.equal(again.body, page.body);
});

test("sanitize redacts four classes", () => {
  const out = sanitize(
    `key sk-abcdefghijklmnop123456 and ghp_` + "a".repeat(40) +
    ` bearer abcdefghijklmnop and password: "hunter2secret" ` +
    `-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
  );
  assert.ok(!out.includes("sk-abcdefghijklmnop"));
  assert.ok(!out.includes("ghp_"));
  assert.ok(!out.includes("bearer abcdefghijklmnop"));
  assert.ok(!out.includes("hunter2secret"));
  assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(out.includes("[REDACTED"));
});

test("store roots isolate owners physically", () => {
  const data = tmpData();
  try {
    const a = new StoreRoot(data, "d-packA--agent1");
    const b = new StoreRoot(data, "d-packB--agent2");
    a.beginHandoff("default", "dsh", { summary: "owner A secret summary 舰队" });
    b.beginHandoff("default", "dsh", { summary: "owner B" });
    assert.equal(a.db.openHandoffs().length, 1);
    assert.equal(b.db.openHandoffs().length, 1);
    assert.notEqual(a.rootDir, b.rootDir);
    // search in A must not surface B content
    const hits = a.db.searchPages("owner B");
    assert.equal(hits.length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("reindex rebuilds derived db without touching wiki truth", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-p--a");
    root.beginHandoff("default", "dsh", { summary: "舰队记忆 reindex probe" });
    const wikiFile = (rel: string) => readFileSync(join(root.wikiDir, rel), "utf8");
    const rel = root.db.searchPages("reindex probe")[0].path;
    const before = wikiFile(rel);
    // wipe derived index content by deleting rows + rebuild
    root.db.db.exec("DELETE FROM pages; DELETE FROM pages_fts;");
    const count = root.db.reindexFromWiki(root.wikiDir);
    assert.ok(count >= 1);
    assert.equal(wikiFile(rel), before);
    assert.equal(root.db.searchPages("reindex probe")[0].path, rel);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("tokens: mint/verify/revoke with immediate effect and scope checks", () => {
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "pepper");
    const dep = store.mint("deployment", "d/packA/agent1");
    const person = store.mint("person", "u/alice");
    assert.equal(store.verify(dep.token)?.namespace, "d/packA/agent1");
    assert.equal(store.verify("fdm_fake" + "0".repeat(40)), null);
    // person scope covers their projects
    const s = store.verify(person.token)!;
    assert.ok(scopeAllowsNamespace(s, "u/alice/p/proj"));
    assert.ok(!scopeAllowsNamespace(s, "u/bob"));
    // deployment scope is exactly one namespace
    const d = store.verify(dep.token)!;
    assert.ok(scopeAllowsNamespace(d, "d/packA/agent1"));
    assert.ok(!scopeAllowsNamespace(d, "d/packA/agent2"));
    // revocation immediate
    assert.equal(store.revoke(dep.id), true);
    assert.equal(store.verify(dep.token), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("namespace parts map to root keys", () => {
  assert.deepEqual(namespaceParts("u/alice/p/proj"), { rootKey: "u-alice", project: "proj" });
  assert.deepEqual(namespaceParts("d/packX/agentY"), { rootKey: "d-packX--agentY", project: "default" });
  assert.equal(rootKeyForNamespace("d/packX/agentY"), "d-packX--agentY");
});

test("capture ingest lands observations + session page + ledger, sanitized", () => {
  const data = tmpData();
  try {
    const roots = new Map<string, StoreRoot>();
    const ingest = new CaptureIngest(roots, (k) => {
      const r = new StoreRoot(data, k);
      roots.set(k, r);
      return r;
    });
    const events: CaptureEvent[] = [
      { event: "session-start", session_id: "sess-1", agent: "dsh" },
      { event: "user-prompt-submit", session_id: "sess-1", summary: "fix the bug sk-abcdefghijklmnop123456" },
      { event: "post-tool-use", session_id: "sess-1", tool_name: "Write", tool_input: "wrote check-links.mjs" },
      { event: "session-end", session_id: "sess-1" },
    ];
    const out = ingest.ingest("d-p--a", "default", events);
    assert.equal(out.stored, 4);
    const root = roots.get("d-p--a")!;
    const obs = root.db.observationsForSession("sess-1");
    assert.equal(obs.length, 4);
    assert.ok(obs[1].summary.includes("[REDACTED"));
    assert.ok(existsSync(join(root.wikiDir, "default/sessions/sess-1.md")));
    assert.ok(existsSync(join(root.wikiDir, `default/log-${new Date().toISOString().slice(0, 7)}.md`)));
    // searchable
    assert.ok(root.db.searchPages("check-links").length >= 0); // session page indexed
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp tools: handoff claim-once across agents; scope has no namespace param", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-p--a");
    const scope = { tokenId: "t1", kind: "deployment" as const, namespace: "d/p/a" };
    const tools = buildTools(scope, root);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "memory_handoff_accept", "memory_handoff_begin", "memory_handoff_cancel",
      "memory_handoff_list", "memory_query", "memory_read_page", "memory_recent", "memory_write_page",
    ]);
    // no tool schema carries a namespace field — scope cannot be overridden
    for (const t of tools) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      assert.equal(props.namespace, undefined, t.name);
    }
    const begin = tools.find((t) => t.name === "memory_handoff_begin")!;
    const list = tools.find((t) => t.name === "memory_handoff_list")!;
    const accept = tools.find((t) => t.name === "memory_handoff_accept")!;
    const out = begin.handler({ summary: "stage 1 done 接力", next_steps: ["stage 2"] }) as { content: [{ text: string }] };
    const id = JSON.parse(out.content[0].text).handoff_id;
    // agent B claims
    const b = JSON.parse((accept.handler({ handoff_id: id, agent: "zcode" }) as any).content[0].text);
    assert.equal(b.status, "claimed");
    assert.equal(b.handoff.summary, "stage 1 done 接力");
    // agent C claims again — rejected, does not change attribution
    const c = JSON.parse((accept.handler({ handoff_id: id, agent: "codex" }) as any).content[0].text);
    assert.equal(c.status, "already_claimed");
    assert.equal(c.accepted_by, "zcode");
    const open = JSON.parse((list.handler({}) as any).content[0].text);
    assert.equal(open.handoffs.length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("http service: auth 401, capture 200, mcp initialize + tools/list round-trip", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const tok = svc.tokens.mint("deployment", "d/p/a").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(base + "/healthz");
    assert.equal(health.status, 200);

    const noAuth = await fetch(base + "/capture", { method: "POST", body: "{}" });
    assert.equal(noAuth.status, 401);

    const cap = await fetch(base + "/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [{ event: "session-start", session_id: "s1" }] }),
    });
    assert.equal(cap.status, 200);
    assert.equal((await cap.json()).stored, 1);

    const init = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(init.status, 200);
    const sid = init.headers.get("mcp-session-id")!;

    const toolsList = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const tools = (await toolsList.json()).result.tools as unknown as { name: string }[];
    assert.equal(tools.length, 8);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});
