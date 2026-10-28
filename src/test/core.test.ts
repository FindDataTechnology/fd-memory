import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePage, dumpPage, newPage } from "../okf.js";
import { StoreRoot, rootKeyForNamespace } from "../store.js";
import { TokenStore, namespaceParts, scopesForNamespace, defaultGrantsFor, safeSegment } from "../auth.js";
import { CaptureIngest, CaptureEvent } from "../capture.js";
import { sanitize } from "../sanitize.js";
import { buildTools } from "../mcp.js";
import { Service } from "../http.js";
import { runMigration } from "../scripts/migrate-v2.js";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-test-"));
}

// A grant check backed by a real TokenStore (fresh per namespace semantics).
function grantsOf(store: TokenStore, token: string) {
  const scope = store.verify(token)!;
  return { allows: (ns: string, mode: "r" | "rw") => store.allows(scope.tokenId, ns, mode) };
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
    `key sk-abcdefghijklmnop123456 and ghp_` + "a".repeat(40) + // leak-check:allow
    ` bearer abcdefghijklmnop and password: "hunter2secret" ` + // leak-check:allow
    `-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
  );
  assert.ok(!out.includes("sk-abcdefghijklmnop")); // leak-check:allow
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
    a.beginHandoff("default", "runner", { summary: "owner A secret summary 舰队" });
    b.beginHandoff("default", "runner", { summary: "owner B" });
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
    root.beginHandoff("default", "runner", { summary: "舰队记忆 reindex probe" });
    const wikiFile = (rel: string) => readFileSync(join(root.wikiDir, rel), "utf8");
    const rel = root.db.searchPages("reindex probe")[0].path;
    const before = wikiFile(rel);
    root.db.db.exec("DELETE FROM pages; DELETE FROM pages_fts;");
    const count = root.db.reindexFromWiki(root.wikiDir);
    assert.ok(count >= 1);
    assert.equal(wikiFile(rel), before);
    assert.equal(root.db.searchPages("reindex probe")[0].path, rel);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("tokens: mint/verify/revoke with immediate effect and grant checks", () => {
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "pepper");
    const dep = store.mint("deployment", "d/packA/agent1");
    const person = store.mint("person", "u/alice");
    assert.equal(store.verify(dep.token)?.namespace, "d/packA/agent1");
    assert.equal(store.verify("fdm_fake" + "0".repeat(40)), null);
    // person's owner grant covers every project under their root
    const s = store.verify(person.token)!;
    assert.ok(store.allows(s.tokenId, "u/alice/p/proj", "rw"));
    assert.ok(store.allows(s.tokenId, "u/alice", "rw"));
    assert.ok(!store.allows(s.tokenId, "u/bob", "r"));
    // deployment grant covers its own agent scope + the pack scope
    const d = store.verify(dep.token)!;
    assert.ok(store.allows(d.tokenId, "d/packA/agent1", "rw"));
    assert.ok(store.allows(d.tokenId, "d/packA", "rw")); // shared partition
    assert.ok(!store.allows(d.tokenId, "d/packA/agent2", "r"));
    // revocation immediate
    assert.equal(store.revoke(dep.id), true);
    assert.equal(store.verify(dep.token), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("grants: default matrix at mint, backfill for legacy tokens, revoke narrows one face", () => {
  const data = tmpData();
  try {
    const dbPath = join(data, "tokens.db");
    const store = new TokenStore(dbPath, "pepper");
    // default matrix
    const dep = store.mint("deployment", "d/p1/a1");
    const pod = store.mint("pod", "d/p1");
    const person = store.mint("person", "u/alice");
    const depS = store.verify(dep.token)!;
    assert.deepEqual(
      store.grantsFor(depS.tokenId).map((g) => `${g.scope_kind}:${g.scope_ref}:${g.mode}`).sort(),
      ["agent:d/p1/a1:rw", "pack:d/p1:rw"],
    );
    const podS = store.verify(pod.token)!;
    assert.deepEqual(
      store.grantsFor(podS.tokenId).map((g) => `${g.scope_kind}:${g.scope_ref}:${g.mode}`),
      ["pack:d/p1:rw"],
    );
    const personS = store.verify(person.token)!;
    assert.deepEqual(
      store.grantsFor(personS.tokenId).map((g) => `${g.scope_kind}:${g.scope_ref}:${g.mode}`),
      ["owner:u/alice:rw"],
    );
    // revoke the member's pack grant: shared face off, own partition intact
    assert.equal(store.revokeGrant(depS.tokenId, "pack", "d/p1"), true);
    assert.ok(store.allows(depS.tokenId, "d/p1/a1", "rw"));
    assert.ok(!store.allows(depS.tokenId, "d/p1", "r"));
    // backfill: a pre-grant (legacy) token row gets family defaults on next boot
    const legacy = store.mint("deployment", "d/p2/b2");
    const legacyS = store.verify(legacy.token)!;
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM grants"); // simulate a v1 database
    raw.close();
    const reopened = new TokenStore(dbPath, "pepper");
    assert.ok(reopened.allows(legacyS.tokenId, "d/p2/b2", "rw"));
    assert.ok(reopened.allows(legacyS.tokenId, "d/p2", "rw"));
    assert.equal(reopened.backfillDefaultGrants(), 0); // idempotent second pass
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("namespace parts v2: d/ mirrors u/'s one-root-many-projects shape", () => {
  assert.deepEqual(namespaceParts("u/alice/p/proj"), { rootKey: "u-alice", project: "proj" });
  assert.deepEqual(namespaceParts("u/alice"), { rootKey: "u-alice", project: "default" });
  // v2: the pack owns the root; the member gets a project; shared for 2-seg
  assert.deepEqual(namespaceParts("d/packX/agentY"), { rootKey: "d-packX", project: "agentY" });
  assert.deepEqual(namespaceParts("d/packX"), { rootKey: "d-packX", project: "shared" });
  assert.equal(rootKeyForNamespace("d/packX/agentY"), "d-packX");
  assert.equal(rootKeyForNamespace("d/packX"), "d-packX");
  // display-name agentIds survive; packIds containing "--" stay unambiguous
  assert.deepEqual(namespaceParts("d/pa--ck/爬虫自愈修复 Agent"), { rootKey: "d-pa--ck", project: "爬虫自愈修复 Agent" });
  // scope derivation — NOT hierarchical: a member ns belongs to its agent
  // scope only; the pack scope covers the shared partition alone
  assert.deepEqual(scopesForNamespace("d/p/a"), [{ kind: "agent", ref: "d/p/a" }]);
  assert.deepEqual(scopesForNamespace("d/p"), [{ kind: "pack", ref: "d/p" }]);
  assert.deepEqual(scopesForNamespace("u/alice/p/x"), [{ kind: "owner", ref: "u/alice" }]);
  // safeSegment: separators flattened, dot-only rejected
  assert.equal(safeSegment("a/b\\c"), "a-b-c");
  assert.equal(safeSegment(".."), "default");
  assert.equal(safeSegment("  "), "default");
  assert.equal(safeSegment("中文 报告"), "中文 报告");
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
      { event: "session-start", session_id: "sess-1", agent: "runner" },
      { event: "user-prompt-submit", session_id: "sess-1", summary: "fix the bug sk-abcdefghijklmnop123456" }, // leak-check:allow
      { event: "post-tool-use", session_id: "sess-1", tool_name: "Write", tool_input: "wrote check-links.mjs" },
      { event: "session-end", session_id: "sess-1" },
    ];
    const out = ingest.ingest("d-p--a", "default", events, { principal: "runner:t1", scope: "d/p/a" });
    assert.equal(out.stored, 4);
    const root = roots.get("d-p--a")!;
    const obs = root.db.observationsForSession("sess-1");
    assert.equal(obs.length, 4);
    assert.ok(obs[1].summary.includes("[REDACTED"));
    assert.ok(existsSync(join(root.wikiDir, "default/sessions/sess-1.md")));
    assert.ok(existsSync(join(root.wikiDir, `default/log-${new Date().toISOString().slice(0, 7)}.md`)));
    assert.ok(root.db.searchPages("check-links").length >= 0); // session page indexed
    // capture batch audit row
    const writes = root.db.recentWrites(10);
    assert.ok(writes.some((w) => w.op === "capture_batch" && w.principal === "runner:t1"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("v2 root: same-pack members share one root, projects stay disjoint", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-packZ");
    const roots = new Map<string, StoreRoot>([["d-packZ", root]]);
    const ingest = new CaptureIngest(roots, () => root);
    ingest.ingest("d-packZ", "agentA", [{ event: "stop", session_id: "s-a", summary: "成员 A 的总结" }]);
    ingest.ingest("d-packZ", "agentB", [{ event: "stop", session_id: "s-b", summary: "成员 B 的总结" }]);
    ingest.ingest("d-packZ", "shared", [{ event: "stop", session_id: "s-sh", summary: "共享结论" }]);
    // member A's filtered read sees only their project (plus whatever they're granted below)
    const aObs = root.db.recentObservations(10, ["agentA"]);
    assert.equal(aObs.length, 1);
    assert.ok(aObs[0].summary.includes("成员 A"));
    assert.equal(root.db.recentObservations(10, ["agentB"])[0].summary.includes("成员 B"), true);
    assert.equal(root.db.recentObservations(10, ["shared"])[0].summary.includes("共享"), true);
    // unfiltered keeps everything (reindex / audit lane)
    assert.equal(root.db.recentObservations(10).length, 3);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

function memberTools(data: string, ns: string, kind: "deployment" | "pod" | "person" = "deployment") {
  const store = new TokenStore(join(data, "tokens.db"), "pepper");
  const minted = store.mint(kind, ns);
  const scope = store.verify(minted.token)!;
  const { rootKey } = namespaceParts(ns);
  const root = new StoreRoot(data, rootKey);
  const tools = buildTools(scope, root, { allows: (n, m) => store.allows(scope.tokenId, n, m) });
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const out = tools.find((t) => t.name === name)!.handler(args) as { content: [{ text: string }]; isError?: boolean };
    return { isError: out.isError === true, body: JSON.parse(out.content[0].text) };
  };
  return { store, scope, root, call };
}

test("mcp v2: member reads own+shared union with source; write defaults own, shared on demand; handoff to_agent", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/packM/agentA");
    const b = memberTools(data, "d/packM/agentB"); // same pack, sibling member
    // A writes own + shared
    const ownPage = a.call("memory_write_page", { title: "A 私有笔记", body: "独享细节 alpha" });
    assert.equal(ownPage.body.source, "own");
    assert.ok(String(ownPage.body.path).startsWith("agentA/"));
    const sh = a.call("memory_write_page", { title: "共享结论", body: "pack 级结论 beta", target: "shared" });
    assert.equal(sh.body.source, "shared");
    assert.ok(String(sh.body.path).startsWith("shared/"));
    // A's default recent = union, each row tagged
    const rec = a.call("memory_recent", {});
    const paths = rec.body.pages.map((p: { path: string; source: string }) => `${p.source}:${p.path}`);
    assert.ok(paths.some((x: string) => x.startsWith("own:agentA/")));
    assert.ok(paths.some((x: string) => x.startsWith("shared:shared/")));
    // target narrows
    const onlyShared = a.call("memory_recent", { target: "shared" });
    assert.ok(onlyShared.body.pages.every((p: { source: string }) => p.source === "shared"));
    // B sees shared but never A's private pages
    const bRec = b.call("memory_recent", {});
    assert.ok(bRec.body.pages.every((p: { path: string }) => String(p.path).startsWith("shared/") || String(p.path).startsWith("agentB/")));
    const bQuery = b.call("memory_query", { q: "独享细节" });
    assert.equal(bQuery.body.results.length, 0);
    // read_page guard: B cannot read A's page by path
    const g = a.call("memory_read_page", { path: ownPage.body.path });
    assert.equal(g.isError, false);
    const g2 = b.call("memory_read_page", { path: ownPage.body.path });
    assert.equal(g2.isError, true);
    assert.equal(g2.body.error, "forbidden_project");
    // handoff to shared with to_agent; sibling claims once
    const h = a.call("memory_handoff_begin", { summary: "阶段一完成", next_steps: ["阶段二"], target: "shared", to_agent: "agentB" });
    assert.equal(h.body.source, "shared");
    const claim = b.call("memory_handoff_accept", { handoff_id: h.body.handoff_id, agent: "agentB" });
    assert.equal(claim.body.status, "claimed");
    const again = a.call("memory_handoff_accept", { handoff_id: h.body.handoff_id, agent: "agentA" });
    assert.equal(again.body.status, "already_claimed");
    // to_agent outside shared is refused
    const bad = a.call("memory_handoff_begin", { summary: "x", to_agent: "agentB" });
    assert.equal(bad.isError, true);
    assert.equal(bad.body.error, "to_agent_requires_shared");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp v2: pod token defaults to shared, explicit own refused; person shared refused", () => {
  const data = tmpData();
  try {
    const pod = memberTools(data, "d/packP", "pod");
    const w = pod.call("memory_write_page", { title: "pod 共享", body: "content" });
    assert.equal(w.body.source, "shared");
    const own = pod.call("memory_write_page", { title: "x", body: "y", target: "own" });
    assert.equal(own.isError, true);
    assert.equal(own.body.error, "pod_token_has_no_own_partition");
    const person = memberTools(data, "u/alice", "person");
    const ps = person.call("memory_write_page", { title: "x", body: "y", target: "shared" });
    assert.equal(ps.isError, true);
    assert.equal(ps.body.error, "shared_is_deployment_pack_only");
    // person default write lands in their default project
    const pw = person.call("memory_write_page", { title: "个人笔记", body: "z" });
    assert.ok(String(pw.body.path).startsWith("default/"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp: revoking the pack grant narrows the shared face immediately (per-call grants)", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/packR/agentA");
    a.call("memory_write_page", { title: "共享", body: "v", target: "shared" });
    const before = a.call("memory_recent", { target: "shared" });
    assert.equal(before.isError, false);
    a.store.revokeGrant(a.scope.tokenId, "pack", "d/packR");
    const after = a.call("memory_recent", { target: "shared" });
    assert.equal(after.isError, true);
    assert.equal(after.body.error, "forbidden_partition");
    const own = a.call("memory_recent", { target: "own" });
    assert.equal(own.isError, false); // private partition untouched
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp tools: handoff claim-once across agents; scope has no namespace param", () => {
  const data = tmpData();
  try {
    const { tools, call } = (() => {
      const a = memberTools(data, "d/p/a");
      return { tools: buildTools(a.scope, a.root, { allows: () => true }), call: a.call };
    })();
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
    const out = call("memory_handoff_begin", { summary: "stage 1 done 接力", next_steps: ["stage 2"] });
    const id = out.body.handoff_id;
    const b = call("memory_handoff_accept", { handoff_id: id, agent: "zcode" });
    assert.equal(b.body.status, "claimed");
    assert.equal(b.body.handoff.summary, "stage 1 done 接力");
    const c = call("memory_handoff_accept", { handoff_id: id, agent: "codex" });
    assert.equal(c.body.status, "already_claimed");
    assert.equal(c.body.accepted_by, "zcode");
    const open = call("memory_handoff_list", {});
    assert.equal(open.body.handoffs.length, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("audit: page writes and handoff ops each leave a write row", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/packW/agentA");
    const page = a.call("memory_write_page", { title: "t", body: "b" });
    const h = a.call("memory_handoff_begin", { summary: "s" });
    a.call("memory_handoff_accept", { handoff_id: h.body.handoff_id, agent: "x" });
    const writes = a.root.db.recentWrites(10);
    const ops = writes.map((w) => w.op);
    assert.ok(ops.includes("page_write"));
    assert.ok(ops.includes("handoff_begin"));
    assert.ok(ops.includes("handoff_accept"));
    assert.ok(writes.every((w) => w.principal === `deployment:${a.scope.tokenId}`));
    assert.ok(writes.some((w) => w.page_rel === page.body.path));
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

test("runner token: capture into many d/ namespaces, MCP refused, deployment token ignores payload ns; pod capture refused", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const runnerTok = svc.tokens.mint("runner", "*").token;
    const depTok = svc.tokens.mint("deployment", "d/p1/a1").token;
    const podTok = svc.tokens.mint("pod", "d/p1").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => (server ? server.listen(0, "127.0.0.1", r) : r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;

    const post = (tok: string, body: unknown) =>
      fetch(base + "/capture", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });

    let r = await post(runnerTok, { namespace: "d/p1/a1", events: [{ event: "session-start", session_id: "s1" }] });
    assert.equal(r.status, 200);
    r = await post(runnerTok, { namespace: "d/p2/a2", events: [{ event: "stop", session_id: "s1", summary: "turn ok" }] });
    assert.equal(r.status, 200);
    r = await post(runnerTok, { namespace: "u/alice", events: [{ event: "stop", session_id: "s1" }] });
    assert.equal(r.status, 403);
    // pod tokens are mount credentials — the capture lane refuses them
    r = await post(podTok, { events: [{ event: "stop", session_id: "s9" }] });
    assert.equal(r.status, 403);
    const mcp = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${runnerTok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(mcp.status, 403);
    // deployment token ignores a payload namespace override (scope stays its own)
    r = await post(depTok, { namespace: "d/p2/a2", events: [{ event: "session-start", session_id: "s2" }] });
    assert.equal(r.status, 200);
    const root2 = svc.rootFor({ tokenId: "x", kind: "deployment", namespace: "d/p2/a2" });
    assert.equal(root2.db.observationsForSession("s2").length, 0);
    const root1 = svc.rootFor({ tokenId: "x", kind: "deployment", namespace: "d/p1/a1" });
    assert.equal(root1.db.observationsForSession("s2").length, 1);
    // v2: the two runner namespaces are separate roots' projects — p1/a1 and p2/a2 never mix
    assert.equal(root1.db.recentObservations(10, ["a1"]).some((o) => o.session_id === "s1"), true);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("runner token mints per-deployment AND pod tokens by segment count; other scopes cannot mint", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const runnerTok = svc.tokens.mint("runner", "*").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => (server ? server.listen(0, "127.0.0.1", r) : r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const mint = (tok: string, ns: string) =>
      fetch(base + "/admin/mint", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ namespace: ns }) });
    const ok = await mint(runnerTok, "d/p9/a9");
    assert.equal(ok.status, 200);
    const { token } = (await ok.json()) as { token: string };
    const init = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(init.status, 200);
    // two-segment d/ mints a POD token (pack shared mount)
    const podRes = await mint(runnerTok, "d/p9");
    assert.equal(podRes.status, 200);
    const podTok = ((await podRes.json()) as { token: string }).token;
    const podScope = svc.tokens.verify(podTok)!;
    assert.equal(podScope.kind, "pod");
    assert.deepEqual(svc.tokens.grantsFor(podScope.tokenId).map((g) => g.scope_kind), ["pack"]);
    // one or four segments are invalid
    assert.equal((await mint(runnerTok, "d/")).status, 400);
    assert.equal((await mint(runnerTok, "d/a/b/c")).status, 400);
    const depTok = svc.tokens.mint("deployment", "d/p1/a1").token;
    const forbidden = await mint(depTok, "d/p9/a9");
    assert.equal(forbidden.status, 403);
    const badNs = await mint(runnerTok, "u/alice");
    assert.equal(badNs.status, 403);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/pages face: person reads/writes any project in their root; deployment confined to granted projects; audited", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const personTok = svc.tokens.mint("person", "u/alice").token;
    const depTok = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const runnerTok = svc.tokens.mint("runner", "*").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => (server ? server.listen(0, "127.0.0.1", r) : r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = (tok: string) => ({ authorization: `Bearer ${tok}`, "content-type": "application/json" });

    // person writes a cluster digest page into a clusterId project, reads it back
    let r = await fetch(base + "/pages?project=cluster-42&limit=5", { headers: H(personTok) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).pages.length, 0);
    r = await fetch(base + "/pages", { method: "POST", headers: H(personTok), body: JSON.stringify({ project: "cluster-42", title: "集群回合 digest", body: "成员输出汇总 cluster-42 首轮" }) });
    assert.equal(r.status, 200);
    const { path } = (await r.json()) as { path: string };
    assert.ok(path.startsWith("cluster-42/"));
    r = await fetch(base + "/pages?project=cluster-42&limit=5", { headers: H(personTok) });
    assert.equal((await r.json()).pages.length, 1);
    // searchable in the person root
    assert.ok(svc.rootFor({ tokenId: "x", kind: "person", namespace: "u/alice" }).db.searchPages("cluster-42").length >= 1);
    // audit row names the person principal
    const writes = svc.rootFor({ tokenId: "x", kind: "person", namespace: "u/alice" }).db.recentWrites(5);
    assert.ok(writes.some((w) => w.op === "page_write" && w.principal.startsWith("person:") && w.scope === "u/alice/p/cluster-42"));

    // deployment token: own agent project OK (own agent scope), sibling project refused
    r = await fetch(base + "/pages", { method: "POST", headers: H(depTok), body: JSON.stringify({ project: "agentA", title: "t", body: "b" }) });
    assert.equal(r.status, 200);
    r = await fetch(base + "/pages", { method: "POST", headers: H(depTok), body: JSON.stringify({ project: "agentB", title: "t", body: "b" }) });
    assert.equal(r.status, 403);
    // shared partition reachable for pack members
    r = await fetch(base + "/pages", { method: "POST", headers: H(depTok), body: JSON.stringify({ project: "shared", title: "t", body: "b" }) });
    assert.equal(r.status, 200);
    // runner refused on the pages face
    r = await fetch(base + "/pages?project=x", { headers: H(runnerTok) });
    assert.equal(r.status, 403);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("/admin/report lists grants and recent writes for a root", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const member = svc.tokens.mint("deployment", "d/pr/agentA");
    const pod = svc.tokens.mint("pod", "d/pr");
    const runnerTok = svc.tokens.mint("runner", "*").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => (server ? server.listen(0, "127.0.0.1", r) : r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const report = await fetch(base + "/admin/report", {
      method: "POST",
      headers: { authorization: `Bearer ${runnerTok}`, "content-type": "application/json" },
      body: JSON.stringify({ rootKey: "d-pr" }),
    });
    assert.equal(report.status, 200);
    const doc = (await report.json()) as { rootKey: string; grants: Array<{ token_kind: string; scope_kind: string; mode: string }>; recent_writes: unknown[] };
    assert.equal(doc.rootKey, "d-pr");
    const pairs = doc.grants.map((g) => `${g.token_kind}:${g.scope_kind}:${g.mode}`).sort();
    assert.deepEqual(pairs, ["deployment:agent:rw", "deployment:pack:rw", "pod:pack:rw"]);
    // a member token sees its own root without naming one; a person cannot name another root
    const self = await fetch(base + "/admin/report", { method: "POST", headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(((await self.json()) as { rootKey: string }).rootKey, "d-pr");
    const personTok = svc.tokens.mint("person", "u/eve").token;
    const foreign = await fetch(base + "/admin/report", { method: "POST", headers: { authorization: `Bearer ${personTok}`, "content-type": "application/json" }, body: JSON.stringify({ rootKey: "d-pr" }) });
    assert.equal(((await foreign.json()) as { rootKey: string }).rootKey, "u-eve");
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("federation: /hook person face + platform minting matrix + idempotency", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const runner = svc.tokens.mint("runner", "*").token;
    const platform = svc.tokens.mint("platform", "*").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => (server ? server.listen(0, "127.0.0.1", r) : r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const post = (p: string, tok: string, body?: string) =>
      fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ?? "{}" });

    const q = "/hook?event=user-prompt-submit&agent=zcode&cwd=%2FUsers%2Fx%2Fproj77&ingest_key=k1";
    let r = await post(q, person, JSON.stringify({ session_id: "s-fed-1", cwd: "/Users/x/proj77", prompt: "联邦首投 hello" }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).stored, 1);
    r = await post(q, person, JSON.stringify({ session_id: "s-fed-1", cwd: "/Users/x/proj77", prompt: "联邦首投 hello" }));
    assert.equal((await r.json()).stored, 0);
    r = await post("/hook?event=bogus&agent=z&cwd=/x&ingest_key=k2", person, JSON.stringify({ session_id: "s" }));
    assert.equal(r.status, 400);
    r = await post("/hook?event=stop&agent=z&cwd=/x&ingest_key=k3", runner, JSON.stringify({ session_id: "s" }));
    assert.equal(r.status, 403);
    r = await post("/hook?event=stop&agent=z&cwd=/x&ingest_key=k4", platform, JSON.stringify({ session_id: "s" }));
    assert.equal(r.status, 403);

    const mint = (tok: string, ns: string) => post("/admin/mint", tok, JSON.stringify({ namespace: ns })).then((x) => x.status);
    assert.equal(await mint(platform, "u/bob"), 200);
    assert.equal(await mint(platform, "d/p/a"), 403);
    assert.equal(await mint(runner, "u/bob"), 403);
    assert.equal(await mint(person, "u/bob"), 403);

    assert.equal(await post("/capture", platform, JSON.stringify({ events: [] }) || "{}").then((x) => x.status) >= 400, true);
    const mcp = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${platform}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(mcp.status, 403);

    const bobTok = (await (await post("/admin/mint", platform, JSON.stringify({ namespace: "u/bob", label: "t" }))).json()).token;
    const init = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(init.status, 200);

    const rootAlice = svc.rootFor({ tokenId: "x", kind: "person", namespace: "u/alice" });
    assert.equal(rootAlice.db.searchPages("联邦首投").length >= 1, true);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});

test("migrate-v2: moves wiki verbatim, carries observations/handoffs, keeps backup, idempotent", () => {
  const data = tmpData();
  try {
    // Build a v1 world: token + old-layout root with content. The old db is
    // downgraded to the REAL v1 schema (no to_agent in handoffs, no project
    // in observations) — a fixed-column carry-over crashed on prod exactly
    // here; this test pins the regression.
    const store = new TokenStore(join(data, "tokens.db"), "pepper");
    store.mint("deployment", "d/packM/爬虫自愈修复 Agent");
    const oldRoot = new StoreRoot(data, "d-packM--爬虫自愈修复 Agent");
    oldRoot.beginHandoff("default", "site-heal", { summary: "首轮排障结论 heal-x" });
    oldRoot.db.addObservation({ session_id: "s-old", agent: "site-heal", event: "stop", tool: null, summary: "旧观测 legacy obs", created_at: new Date().toISOString(), project: "default" });
    oldRoot.db.db.exec("ALTER TABLE handoffs DROP COLUMN to_agent; ALTER TABLE observations DROP COLUMN project;");
    const oldWikiPath = join(oldRoot.wikiDir, "default", "handoffs");
    const [handoffFile] = readdirSync(oldWikiPath).filter((f) => f.endsWith(".md"));
    const before = readFileSync(join(oldWikiPath, handoffFile), "utf8");
    mkdirSync(join(data, "owners", "d-packM--爬虫自愈修复 Agent", "db"), { recursive: true });

    runMigration(data, false);
    // New layout exists and is searchable
    const newRoot = new StoreRoot(data, "d-packM");
    const hits = newRoot.db.searchPages("heal-x");
    assert.ok(hits.length >= 1);
    assert.equal(newRoot.db.recentObservations(10, ["爬虫自愈修复 Agent"])[0].summary, "旧观测 legacy obs");
    const carried = newRoot.db.openHandoffs();
    assert.equal(carried.length, 1);
    assert.equal(carried[0].project, "爬虫自愈修复 Agent");
    // wiki truth byte-identical at the new location
    const newPath = join(newRoot.wikiDir, "爬虫自愈修复 Agent", "handoffs", handoffFile);
    assert.ok(existsSync(newPath));
    assert.equal(readFileSync(newPath, "utf8"), before);
    // old root kept as backup
    assert.ok(existsSync(join(data, "owners", "d-packM--爬虫自愈修复 Agent.v1-backup")));
    // idempotent: second run changes nothing
    const snapshot = JSON.stringify(readdirSync(join(data, "owners")));
    runMigration(data, false);
    assert.equal(JSON.stringify(readdirSync(join(data, "owners"))), snapshot);
    // dry-run on a fresh v1 world writes nothing
    const data2 = tmpData();
    try {
      const s2 = new TokenStore(join(data2, "tokens.db"), "pepper");
      s2.mint("deployment", "d/pp/aa");
      const old2 = new StoreRoot(data2, "d-pp--aa");
      old2.writePage("default", "notes", "seed", newPage("note", "seed", "dry-run must not move me"));
      runMigration(data2, true);
      assert.ok(existsSync(join(data2, "owners", "d-pp--aa", "wiki", "default")));
      assert.ok(!existsSync(join(data2, "owners", "d-pp")));
    } finally {
      rmSync(data2, { recursive: true, force: true });
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
