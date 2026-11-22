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

// FTS overwrite semantics (2026-11-19). indexPage used to retire the old FTS
// row with an unconditional `DELETE ... WHERE path=?`; that predicate is an
// UNINDEXED fts5 column, so every page write paid a full index scan (22ms) to
// delete nothing 88% of the time. It is now conditional on a pre-upsert PK
// lookup. The optimization is only sound if an overwrite STILL replaces the
// indexed text rather than appending a second row — that is what this pins:
// a stale term must stop matching, the new term must match, and the row count
// must not grow.
test("indexPage overwrite replaces the FTS row instead of duplicating it", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "d-p--a");
    const countFts = () => (root.db.db.prepare("SELECT COUNT(*) AS n FROM pages_fts").get() as { n: number }).n;
    const matchCount = (term: string) =>
      (root.db.db.prepare("SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(`"${term}"`) as { n: number }).n;

    root.writePage("default", "facts", "f1", newPage("fact", "结算口径", "毛利率按含退口径"));
    const afterFirst = countFts();
    // Trigram tokenizer: a query needs >= 3 characters to match anything.
    assert.equal(matchCount("含退口"), 1, "first write indexes the body");

    // Same path, different text: the overwrite must REPLACE.
    root.writePage("default", "facts", "f1", newPage("fact", "结算口径", "毛利率按扣退口径"));
    assert.equal(countFts(), afterFirst, "an overwrite must not append a second FTS row");
    assert.equal(matchCount("含退口"), 0, "the stale term must stop matching after an overwrite");
    assert.equal(matchCount("扣退口"), 1, "the new term must match after an overwrite");

    // A fresh path still indexes normally.
    root.writePage("default", "facts", "f2", newPage("fact", "另一口径", "收入按净额确认"));
    assert.equal(countFts(), afterFirst + 1, "a new path adds exactly one row");
    assert.equal(matchCount("净额确"), 1);
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
  return { store, scope, root, tools, call };
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

test("memory_write_page: 两条合法 filing lane 写在 schema 里，拒收自带可行值（2026-11-15 实测 20+ 种自造类型）", () => {
  // 现场：事实档把分类当 type 用 —— fact / experience / decision_log / round-log /
  // dutylog / patrol-board / shift_log …，56+ 次被拒，其中一次把整句话塞进了该字段
  // （"fact. Let me check what types are allowed. …"）。另有 135 次 target='shared'
  // 被拒：工具描述把 shared 列为合法枚举值、却没说普通成员写它会被拒。
  // 修法不是逐岗补提示词，而是让 schema 自己说出两条 lane、让拒收自带「那我该写哪」。
  const data = tmpData();
  try {
    const person = memberTools(data, "u/alice", "person");
    const spec = person.tools.find((t) => t.name === "memory_write_page")!;
    const typeProp = (spec.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties.type;
    assert.deepEqual(typeProp.enum, ["note", "reference"]);
    assert.match(String(typeProp.description), /metadata/);

    const bad = person.call("memory_write_page", { title: "t", body: "b", type: "fact" });
    assert.equal(bad.isError, true);
    assert.equal(bad.body.error, "unknown_page_type: fact"); // 码不变：调用方按码分诊
    assert.deepEqual(bad.body.allowed, ["note", "reference"]); // 可复制的正确值
    assert.match(String(bad.body.hint), /metadata/);

    const shared = person.call("memory_write_page", { title: "t", body: "b", target: "shared" });
    assert.equal(shared.body.error, "shared_is_deployment_pack_only");
    assert.match(String(shared.body.hint), /own/); // 「写哪儿」必须说清楚
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
      "memory_by_domain", "memory_handoff_accept", "memory_handoff_begin", "memory_handoff_cancel",
      "memory_handoff_list", "memory_overview", "memory_query", "memory_read_page", "memory_recent", "memory_write_page",
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

test("mcp: a session id survives a restart — a live client is never bricked by one", async () => {
  // 2026-11-20: the session map is process memory, so any `launchctl kickstart`
  // empties it while connected clients keep their `mcp-session-id`. The old
  // code answered those with a hard 400 "session not initialized", which meant
  // a routine restart silently broke every live MCP client until each one
  // happened to re-initialize — observed in production as a session that could
  // not write memory and had no clue why.
  //
  // The session is a CACHE, not an auth gate: `route()` verifies the token on
  // every request. So a stale id must be resumed, not refused.
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const tok = svc.tokens.mint("deployment", "d/p/a").token;
    server = createServer((req, res) => {
      (svc as any).route(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const call = (sid: string, method: string, params: Record<string, unknown> = {}) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
      });

    const init = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const sid = init.headers.get("mcp-session-id")!;
    assert.equal((await call(sid, "tools/list")).status, 200, "baseline: the session works before the restart");

    // Simulate the restart exactly: the process's session map is gone, the
    // client's id is not.
    (svc as unknown as { sessions: Map<string, unknown> }).sessions.clear();

    const afterRestart = await call(sid, "tools/list");
    assert.equal(afterRestart.status, 200, "a pre-restart session id must still work");
    const body = (await afterRestart.json()) as { result?: { tools?: unknown[] }; error?: { message: string } };
    assert.equal(body.error, undefined, "no -32000 session error after a restart");
    assert.ok((body.result?.tools?.length ?? 0) > 0, "and it serves real tools, not an empty shell");

    // A tools/call must work too — that is the path memory writes take.
    const write = await call(sid, "tools/call", { name: "memory_write_page", arguments: { project: "default", type: "note", title: "重启后写入", body: "会话恢复" } });
    assert.equal(write.status, 200, "writes still land on a resumed session");
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
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
    assert.equal(tools.length, 10); // eight legacy + memory_overview + memory_by_domain
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

    const mint = (tok: string, ns: string, owner?: string) => post("/admin/mint", tok, JSON.stringify({ namespace: ns, ...(owner ? { owner } : {}) })).then((x) => x.status);
    assert.equal(await mint(platform, "u/bob"), 200);
    // add-agent-memory-foundation: platform mints deployment member tokens
    // WITH a binding owner; without one it is a named 400 (was cross-family
    // 403 before the oversight anchor existed).
    assert.equal(await mint(platform, "d/p/a"), 400);
    assert.equal(await mint(platform, "d/p/a", "u/alice"), 200);
    assert.equal(svc.tokens.rootOwnerOf("d-p"), "alice");
    // add-pack-memory-declaration (2026-11-13): platform also mints the
    // ONE-segment pack-root POD token — the credential a pack's declaration
    // write uses. Without it the write path had no legal credential: platform
    // tokens reach every root (which that path refuses to use) and a pod token
    // cannot be obtained for `d/<pack>`. Strictly narrower than the two-segment
    // mint above, so it adds no reach.
    assert.equal(await mint(platform, "d/p"), 200);
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

test("mcp tools: handoff list is capped, newest-first, and says what it left out", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/p/handoffs");
    const call = a.call;
    const tools = buildTools(a.scope, a.root, { allows: () => true });
    const schema = tools.find((t) => t.name === "memory_handoff_list")!.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    assert.ok(schema.properties.limit, "the page size is caller-settable");

    // 30 open handoffs, oldest first in the store — the list must answer with
    // the NEWEST page and say how many it did not show.
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(call("memory_handoff_begin", { summary: `s${i}`, next_steps: ["n"] }).body.handoff_id);
    const page = call("memory_handoff_list", {});
    assert.equal(page.body.handoffs.length, 20, "default page");
    assert.equal(page.body.total, 30);
    assert.equal(page.body.truncated, true);
    assert.equal(page.body.handoffs[0].id, ids[29], "newest first");

    // The decision fields ride; the body does not (that is what claiming is for).
    const row = page.body.handoffs[0];
    for (const k of ["id", "summary", "from_agent", "to_agent", "project", "created_at", "source"]) assert.ok(k in row, k);
    for (const k of ["open_questions", "next_steps", "files_touched"]) assert.equal(row[k], undefined, `${k} must not ride the list`);

    // Claiming still returns the full body.
    const claimed = call("memory_handoff_accept", { handoff_id: ids[29], agent: "zcode" });
    assert.equal(claimed.body.status, "claimed");
    assert.ok("next_steps" in claimed.body.handoff);

    // Paging: a larger limit reaches everything; over-max is clamped.
    assert.equal(call("memory_handoff_list", { limit: 25 }).body.handoffs.length, 25);
    const capped = call("memory_handoff_list", { limit: 9999 });
    assert.equal(capped.body.handoffs.length, 29, "29 still open after the claim, clamped at the ceiling");
    assert.equal(capped.body.truncated, false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp read faces: list caps are stated, and a clipped row says so", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/p/reads");
    const call = a.call;

    // --- handoff_list: per-row gist cap (optimize-yongyi-read-surfaces 2.4).
    // Measured on production: row count was capped but each row carried its
    // full summary, so the list stayed the single largest tool result.
    const longSummary = "L".repeat(600);
    const longId = call("memory_handoff_begin", { summary: longSummary }).body.handoff_id;
    const shortId = call("memory_handoff_begin", { summary: "short one" }).body.handoff_id;
    const list = call("memory_handoff_list", {});
    const longRow = list.body.handoffs.find((h: { id: string }) => h.id === longId)!;
    const shortRow = list.body.handoffs.find((h: { id: string }) => h.id === shortId)!;
    assert.equal(longRow.summary.length, 200, "gist is cut to the declared width");
    assert.equal(longRow.summary_truncated, true);
    assert.equal(shortRow.summary, "short one", "a row under the cap keeps its bytes");
    assert.equal(shortRow.summary_truncated, undefined);
    assert.equal(list.body.truncated, true, "a clipped row makes the page truncated even when the set is complete");
    assert.equal(list.body.truncated_summaries, 1);
    // The full text is still reachable through the claim face.
    const claimed = call("memory_handoff_accept", { handoff_id: longId });
    assert.equal(claimed.body.handoff.summary.length, 600);
    assert.equal(claimed.body.truncated, undefined);

    // --- query/recent: the caller's limit is clamped, and the true total rides.
    for (let i = 0; i < 60; i++) call("memory_write_page", { title: `alpha note ${i}`, body: `body ${i}` });
    const q = call("memory_query", { q: "alpha", limit: 10000 });
    assert.equal(q.body.results.length, 50, "clamped to the declared ceiling");
    assert.equal(q.body.total, 60, "total is the match count, not the page size");
    assert.equal(q.body.truncated, true);
    assert.equal(q.body.results.some((r: Record<string, unknown>) => "_total" in r), false, "the count column never leaks");
    const qDefault = call("memory_query", { q: "alpha" });
    assert.equal(qDefault.body.results.length, 20, "default page");
    const qSmall = call("memory_query", { q: "alpha", limit: 3 });
    assert.equal(qSmall.body.results.length, 3);
    assert.equal(qSmall.body.total, 60);
    // A nonsense limit falls back to the default instead of becoming 0 rows.
    assert.equal(call("memory_query", { q: "alpha", limit: 0 }).body.results.length, 20);
    assert.equal(call("memory_query", { q: "alpha", limit: -5 }).body.results.length, 20);
    const r = call("memory_recent", { limit: 10000 });
    assert.ok(r.body.pages.length <= 50, "recent clamps both legs");
    assert.ok(r.body.total >= 60, "recent total spans pages and observations");

    // --- handoff_accept: field-level caps, unnamed fields keep their bytes.
    const bigId = call("memory_handoff_begin", {
      summary: "s".repeat(5000),
      open_questions: Array.from({ length: 30 }, (_, i) => `question ${i} ${"q".repeat(600)}`),
      next_steps: ["one small step"],
      files_touched: Array.from({ length: 250 }, (_, i) => `file${i}.ts`),
    }).body.handoff_id;
    const big = call("memory_handoff_accept", { handoff_id: bigId });
    assert.equal(big.body.truncated, true);
    assert.deepEqual(big.body.truncated_fields.sort(), ["files_touched", "open_questions", "summary"]);
    assert.equal(big.body.handoff.summary.length, 4096);
    const oq = JSON.parse(big.body.handoff.open_questions) as string[];
    assert.equal(oq.length, 20, "item count capped");
    assert.ok(oq.every((s) => s.length <= 500), "item width capped");
    assert.equal(big.body.handoff.next_steps, JSON.stringify(["one small step"]), "an uncut field keeps its stored bytes");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp read faces: caps are env-overridable and there is one place to look", () => {
  const data = tmpData();
  const prev = process.env.FD_MEMORY_LIST_LIMIT_MAX;
  try {
    process.env.FD_MEMORY_LIST_LIMIT_MAX = "5";
    const a = memberTools(data, "d/p/envcaps");
    for (let i = 0; i < 12; i++) a.call("memory_write_page", { title: `beta note ${i}`, body: `b ${i}` });
    const q = a.call("memory_query", { q: "beta", limit: 10000 });
    assert.equal(q.body.results.length, 5, "env widened/narrowed the clamp");
    assert.equal(q.body.total, 12);
  } finally {
    if (prev === undefined) delete process.env.FD_MEMORY_LIST_LIMIT_MAX;
    else process.env.FD_MEMORY_LIST_LIMIT_MAX = prev;
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp read faces: read_page pages by byte offset and never splits a character", () => {
  const data = tmpData();
  const prev = process.env.FD_MEMORY_READ_BODY_MAX_BYTES;
  try {
    process.env.FD_MEMORY_READ_BODY_MAX_BYTES = "90";
    const a = memberTools(data, "d/p/readpage");
    // 100 CJK chars = 300 UTF-8 bytes, well past the 90-byte slice.
    const body = "记".repeat(100);
    a.call("memory_write_page", { title: "long page", body });
    const first = a.call("memory_read_page", { path: a.call("memory_query", { q: "long page" }).body.results[0].path });
    assert.equal(first.body.truncated, true);
    assert.equal(first.body.total_bytes, 301, "body plus the trailing newline");
    assert.ok(first.body.body.length > 0);
    assert.ok(!first.body.body.includes("\uFFFD"), "no character was cut in half");
    // Walk the offsets; the concatenation must equal the original bytes.
    let acc = first.body.body;
    let next = first.body.next_offset;
    let guard = 0;
    while (next !== null && guard++ < 20) {
      const step = a.call("memory_read_page", { path: a.call("memory_query", { q: "long page" }).body.results[0].path, offset: next });
      assert.ok(!step.body.body.includes("\uFFFD"), "every slice lands on a character boundary");
      acc += step.body.body;
      next = step.body.next_offset;
    }
    assert.equal(acc, `${body}\n`, "offsets cover the page once, no gap and no repeat");

    // A page that fits keeps the pre-existing shape: no truncation fields.
    a.call("memory_write_page", { title: "short page", body: "short" });
    const small = a.call("memory_read_page", { path: a.call("memory_query", { q: "short page" }).body.results[0].path });
    assert.equal(small.body.truncated, undefined);
    assert.equal(small.body.body, "short\n");
  } finally {
    if (prev === undefined) delete process.env.FD_MEMORY_READ_BODY_MAX_BYTES;
    else process.env.FD_MEMORY_READ_BODY_MAX_BYTES = prev;
    rmSync(data, { recursive: true, force: true });
  }
});

test("mcp read faces: a retired page is out of every read face, and history is opt-in", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/p/retired");
    const call = a.call;
    const root = a.root;
    // Discover the partition this token actually reads (a deployment token's
    // own area is not "default").
    const probe = call("memory_write_page", { title: "probe", body: "probe" });
    const project = String(probe.body.path).split("/")[0];
    // Two L2 pages where the newer names the older in its supersedes list —
    // written through the production index path, so the edge table is built by
    // the same code that builds it in production (3.1).
    root.writeDistillPage(project, "experience", { id: "exp_old", engine: "e", confidence: 0.8, task: "巡检口径 甲", search_keys: ["巡检"], solution: "旧口径", sources: [], supersedes: [] });
    root.writeDistillPage(project, "experience", { id: "exp_new", engine: "e", confidence: 0.9, task: "巡检口径 乙", search_keys: ["巡检"], solution: "新口径", sources: [], supersedes: ["exp_old"] });

    const q = call("memory_query", { q: "巡检口径" });
    const paths = q.body.results.map((r: { path: string }) => r.path as string);
    assert.ok(paths.some((p: string) => p.includes("exp_new")), "the successor is served");
    assert.ok(!paths.some((p: string) => p.includes("exp_old")), "the retired page is not (search face)");
    const recent = call("memory_recent", {});
    assert.ok(!recent.body.pages.some((p: { path: string }) => p.path.includes("exp_old")), "nor in the recency face");

    // Explicit history: visible again, on both faces.
    const qHist = call("memory_query", { q: "巡检口径", include_superseded: true });
    assert.ok(qHist.body.results.some((r: { path: string }) => r.path.includes("exp_old")), "history opt-in on search");
    const rHist = call("memory_recent", { include_superseded: true });
    assert.ok(rHist.body.pages.some((p: { path: string }) => p.path.includes("exp_old")), "history opt-in on recency");

    // The edge table describes exactly what the pages say (3.2 self-check).
    const audit = root.db.supersedeEdgeAudit();
    assert.equal(audit.ok, true);
    assert.equal(audit.distinct_targets, 1);
    assert.equal(audit.edges, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("supersede edges: rebuilt by reindex, and the audit catches a short table (3.2)", () => {
  const data = tmpData();
  try {
    const a = memberTools(data, "d/p/edges");
    const root = a.root;
    const project = String(a.call("memory_write_page", { title: "probe", body: "probe" }).body.path).split("/")[0];
    root.writeDistillPage(project, "experience", { id: "exp_a", engine: "e", confidence: 0.8, task: "甲", search_keys: [], solution: "a", sources: [], supersedes: [] });
    root.writeDistillPage(project, "experience", { id: "exp_b", engine: "e", confidence: 0.8, task: "乙", search_keys: [], solution: "b", sources: [], supersedes: ["exp_a"] });
    assert.equal(root.db.supersedeEdgeAudit().edges, 1);

    // Rewriting the successor without the supersede link must retract the edge
    // (the page no longer retires anything).
    root.writeDistillPage(project, "experience", { id: "exp_b", engine: "e", confidence: 0.8, task: "乙", search_keys: [], solution: "b2", sources: [], supersedes: [] });
    assert.equal(root.db.supersedeEdgeAudit().edges, 0, "the stale edge is retracted on rewrite");

    // reindex rebuilds both index and edges from the markdown truth.
    root.writeDistillPage(project, "experience", { id: "exp_c", engine: "e", confidence: 0.8, task: "丙", search_keys: [], solution: "c", sources: [], supersedes: ["exp_a"] });
    root.db.reindexFromWiki(root.wikiDir);
    const after = root.db.supersedeEdgeAudit();
    assert.equal(after.ok, true, "reindex leaves a self-consistent edge table");
    assert.equal(after.edges, 1);

    // A table that lost a row must be reported, not served silently.
    root.db.db.prepare("DELETE FROM superseded_edges").run();
    assert.equal(root.db.supersedeEdgeAudit().ok, false, "a short edge table fails the audit");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── the FTS leg must actually run, not silently degrade to LIKE ─────────────
//
// 2026-11-22 measured defect: `searchPages`'s FTS statement combined
// `snippet()` with `COUNT(*) OVER ()`, which SQLite rejects with
// "unable to use function snippet in the requested context". The `catch`
// swallowed it, so EVERY search fell through to the LIKE branch — a full scan
// of 89k pages' bodies, ~2s per query, while still returning plausible rows.
// Nothing looked broken; it was just 100× slower and ignored the index.
//
// The assertion has to hit the REAL code path. A first version of this test
// hand-wrote the SQL and checked ITS plan — which stayed green even after the
// bug was re-injected, because it never exercised `searchPages` at all. Instead:
// make the LIKE branch observably different from the FTS branch, then assert
// which one produced the answer.
test("searchPages uses the FTS leg, not the LIKE fallback (3+ char query)", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-fts");
    // A page whose BODY contains the term but whose TITLE does not. The FTS leg
    // indexes title+body and will find it; the LIKE fallback searches
    // (title LIKE ? OR body LIKE ?) and would also find it — so filter by what
    // each branch returns differently instead: the FTS leg's snippet comes from
    // `snippet(pages_fts, ...)`, which brackets matches with '[' ']' … '…'.
    root.writePage("default", "notes", "n0",
      newPage("note", "部署结论", "这一条正文提到 ArgoCD 的配置", {}));

    const hits = root.db.searchPages("ArgoCD", 20);
    assert.equal(hits.length, 1, "必须命中那一条");

    // The discriminator: the LIKE branch builds its snippet with substr/instr
    // and never inserts the '[' … ']' match brackets that `snippet()` adds.
    assert.match(
      hits[0].snippet,
      /\[ArgoCD\]/i,
      `snippet 应来自 FTS 的 snippet()（带 [] 高亮）；没有说明走了 LIKE 兜底。实际：${JSON.stringify(hits[0].snippet)}`,
    );

    // And total is still right now that it comes from its own statement.
    const meta: { total?: number } = {};
    root.db.searchPages("ArgoCD", 1, null, undefined, meta);
    assert.equal(meta.total, 1, `total 应报全部命中（独立 COUNT），实际 ${meta.total}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── usage signals: "returned" is not "matched" ──────────────────────────────
//
// Batch 1 of memory-integration-with-product-lines. Two counters, and the
// distinction that makes them meaningful: a page counts as USED only when the
// caller received it, not when the SQL touched it.
test("searchPages counts only the pages the caller actually received", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-signal");
    for (let i = 0; i < 5; i++) {
      root.writePage("default", "notes", `s${i}`, newPage("note", `信号 ${i}`, `正文 ${i}`, {}));
    }
    // limit=1: five match, one is returned.
    const hits = root.db.searchPages("信号", 1);
    assert.equal(hits.length, 1);

    const counts = root.db.db.prepare("SELECT path, retrieved_n FROM pages ORDER BY path").all() as Array<{ path: string; retrieved_n: number }>;
    const bumped = counts.filter((c) => c.retrieved_n > 0);
    assert.equal(bumped.length, 1, "只有被返回的那一条计数；SQL 匹配到但没返回的不算");
    assert.equal(bumped[0].path, String((hits[0] as { path: string }).path));

    // A page with no hits stays at zero forever.
    assert.equal(counts.filter((c) => c.retrieved_n === 0).length, 4);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("injection count records the pool size it competed in", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-pool");
    root.writePage("default", "notes", "a", newPage("note", "池 A", "正文", {}));
    const pageId = (root.db.db.prepare("SELECT page_id FROM pages WHERE path LIKE '%/a.md'").get() as { page_id: string }).page_id;

    // Two injections, pools of 100 and 400 candidates.
    root.db.notePagesInjected([pageId], 100);
    root.db.notePagesInjected([pageId], 400);

    const row = root.db.db.prepare("SELECT injected_n, injected_seen_n FROM pages WHERE page_id = ?").get(pageId) as { injected_n: number; injected_seen_n: number };
    assert.equal(row.injected_n, 2, "选中两次");
    assert.equal(row.injected_seen_n, 500, "分母累加：100 + 400 —— 没有它，选中次数跨时间不可比");

    const st = root.db.usageSignalStats();
    assert.equal(st.total, 1);
    assert.equal(st.injected_at_least_once, 1);
    assert.equal(st.retrieved_at_least_once, 0, "注入不等于检索，两个信号分开记");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("usage stats distinguish never-offered from never-used", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-untouched");
    root.writePage("default", "notes", "x", newPage("note", "没被碰过", "正文", {}));
    const st = root.db.usageSignalStats();
    assert.equal(st.total, 1);
    assert.equal(st.never_touched, 1, "0/0 是「从未被提供过」，与「提供过但没中」不同");
    assert.equal(st.retrieved_at_least_once, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// A stale-version database must gain the new columns on reopen.
//
// The trap this pins (2026-11-22, hit for real on the live store): the
// `columnsOf()` guards are idempotent, so adding an ALTER looks safe — but
// `migrate()` returns early when the stored version already equals
// SCHEMA_VERSION, so on every existing database the new ALTER never ran. The
// columns were simply absent while everything else looked healthy.
test("reopening an older database adds the usage-signal columns", () => {
  const data = tmpData();
  try {
    const first = new StoreRoot(data, "u-migrate");
    first.writePage("default", "notes", "m", newPage("note", "迁移前", "正文", {}));

    // Simulate a database written before batch 1: drop the columns and rewind
    // the version gate. SQLite cannot DROP COLUMN on every build, so rebuild
    // the table without them.
    first.db.db.exec(`
      CREATE TABLE pages_old AS SELECT path, project, type, title, body, updated_at, sources, supersedes FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_old RENAME TO pages;
      UPDATE schema_meta SET value = '3' WHERE key = 'version';  -- 旧版本号本身：正是「存的是旧号，代码是新号」这个差值驱动迁移
    `);
    const before = first.db.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    assert.equal(before.some((c) => c.name === "retrieved_n"), false, "前提：老库确实没有该列");

    // Reopen: migrate() must now run and add them.
    const second = new StoreRoot(data, "u-migrate");
    const after = second.db.db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    for (const col of ["retrieved_n", "injected_n", "injected_seen_n"]) {
      assert.ok(after.some((c) => c.name === col), `reopen 后必须有 ${col}`);
    }
    // Existing rows default to 0, not NULL.
    const row = second.db.db.prepare("SELECT retrieved_n, injected_n FROM pages LIMIT 1").get() as { retrieved_n: number; injected_n: number };
    assert.equal(row.retrieved_n, 0);
    assert.equal(row.injected_n, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("injected_rate is a rate, and null rather than 0 when never offered", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-rate");
    root.writePage("default", "notes", "a", newPage("note", "常被选中", "正文", {}));
    root.writePage("default", "notes", "b", newPage("note", "从未参选", "正文", {}));
    const idOf = (slug: string) => (root.db.db.prepare("SELECT page_id FROM pages WHERE path LIKE ?").get(`%/${slug}.md`) as { page_id: string }).page_id;

    // "a" competed twice in a pool of 100 → rate 0.02. "b" never competed.
    root.db.notePagesInjected([idOf("a")], 100);
    root.db.notePagesInjected([idOf("a")], 100);
    const top = root.db.usageSignalStats().top_retrieved;
    const a = top.find((r) => r.path.endsWith("/a.md"))!;
    assert.equal(a.injected_rate, 0.01, "选中率 = 2 次 / (100+100) = 200 候选，即 1%");
    assert.equal(top.some((r) => r.path.endsWith("/b.md")), false, "从未参选的页不出现在 top 里");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── promotion classification: the three buckets and why they are separate ────
//
// Batch 2 of memory-integration-with-product-lines. The rule is "model says yes
// AND usage backs it", and the interesting part is what happens when the two
// disagree: that must NOT be auto-resolved, because an auto-promoted wrong page
// leaks into other roots once sharing opens.
test("pending proposals split into auto / conflict / no-signal", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-promo");
    const mk = (slug: string, title: string) => {
      root.writePage("default", "notes", slug, newPage("note", title, "正文内容足够长以便成为候选", {}));
      return (root.db.db.prepare("SELECT page_id FROM pages WHERE path LIKE ?").get(`%/${slug}.md`) as { page_id: string }).page_id;
    };
    const idUsed = mk("used", "被用过的");
    const idCold = mk("cold", "从没用过的");
    const idNever = mk("never", "从未参选的");

    for (const [id, slug] of [[idUsed, "used"], [idCold, "cold"], [idNever, "never"]] as const) {
      root.db.db.prepare(
        "INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at) VALUES (?,?,?,?,?,?)",
      ).run("default", `default/notes/${slug}.md`, "stable", "模型认为可复用", "ai", "2026-11-22T00:00:00Z");
    }
    // "used": retrieved twice AND competed in a sizeable pool.
    root.db.notePagesRetrieved(["default/notes/used.md"]);
    root.db.notePagesRetrieved(["default/notes/used.md"]);
    root.db.notePagesInjected([idUsed], 100);
    // "cold": competed but never retrieved -> conflict (model yes, signal weak).
    root.db.notePagesInjected([idCold], 5000);
    // "never": untouched -> no_signal, not a conflict.

    const c = root.db.classifyPendingProposals("default", { minRetrieved: 2 });
    assert.deepEqual(c.auto.map((x) => x.page_rel), ["default/notes/used.md"], "两个条件都满足才自动升");
    assert.deepEqual(c.conflict.map((x) => x.page_rel), ["default/notes/cold.md"], "模型说是但证据不足 -> 交人");
    assert.deepEqual(c.no_signal.map((x) => x.page_rel), ["default/notes/never.md"], "没有任何证据 -> 不是冲突，只是还没积累");
    assert.match(c.conflict[0].why, /交人裁决/);

    // A missing threshold promotes NOTHING (0 would mean "everything").
    const none = root.db.classifyPendingProposals("default", {});
    assert.equal(none.auto.length, 0, "没给阈值时不得自动提升——阈值是要观察后定的，不是猜的");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("promotePage stamps who caused it, so auto promotions are distinguishable", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-promote");
    root.writePage("default", "notes", "p", newPage("note", "要提升的", "正文", {}));
    root.db.db.prepare(
      "INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at) VALUES (?,?,?,?,?,?)",
    ).run("default", "default/notes/p.md", "stable", "理由", "ai", "2026-11-22T00:00:00Z");

    root.db.promotePage("default/notes/p.md", "stable", "信号达标", "2026-11-22T01:00:00Z");
    const page = root.db.db.prepare("SELECT tier FROM pages WHERE path=?").get("default/notes/p.md") as { tier: string };
    assert.equal(page.tier, "stable");
    const prop = root.db.db.prepare("SELECT proposed_by, accepted_at FROM tier_proposals WHERE page_rel=?").get("default/notes/p.md") as { proposed_by: string; accepted_at: string | null };
    assert.match(prop.proposed_by, /^auto:/, "自动提升要能从 proposed_by 前缀认出来，否则和人工接受混为一谈");
    assert.ok(prop.accepted_at);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("high usage without a model proposal never promotes", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-noProposal");
    root.writePage("default", "notes", "hot", newPage("note", "很热但没被提案", "正文", {}));
    // Heavy usage, but no row in tier_proposals at all.
    for (let i = 0; i < 5; i++) root.db.notePagesRetrieved(["default/notes/hot.md"]);

    const c = root.db.classifyPendingProposals("default", { minRetrieved: 1 });
    assert.equal(c.auto.length, 0, "没有模型提案就没有「两个条件同时成立」，再多使用也不升");
    const page = root.db.db.prepare("SELECT tier FROM pages WHERE path=?").get("default/notes/hot.md") as { tier: string };
    assert.equal(page.tier, "draft", "tier 不变");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── cross-root sharing: only a settled, published page is visible ───────────
//
// Batch 3 task 3.4 of memory-integration-with-product-lines. Three states, and
// only the third is shareable:
//
//   draft                       never
//   stable, never published     no  <- this is the one worth pinning
//   stable, published           yes
//
// The middle case is why "stable" and "published" are separate columns: a
// conclusion can be settled and still be nobody else's business.
test("only a settled AND published page is shareable", () => {
  const data = tmpData();
  try {
    const root = new StoreRoot(data, "u-share");
    const mk = (slug: string) => {
      root.writePage("default", "notes", slug, newPage("note", `页 ${slug}`, "正文", {}));
      return `default/notes/${slug}.md`;
    };
    const draft = mk("draft");
    const stableUnshared = mk("stableUnshared");
    const stableShared = mk("stableShared");

    // Settle two of them through the real promotion path.
    for (const rel of [stableUnshared, stableShared]) {
      root.db.db.prepare("INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at) VALUES (?,?,?,?,?,?)")
        .run("default", rel, "stable", "理由", "ai", "2026-11-22T00:00:00Z");
      root.db.promotePage(rel, "stable", "测试", "2026-11-22T01:00:00Z");
    }

    // Publishing a draft is refused — that is the boundary the spec protects.
    assert.equal(root.db.setPageShareable(draft, true, "2026-11-22T02:00:00Z"), false, "草稿不得被发布");
    assert.equal(root.db.setPageShareable(stableShared, true, "2026-11-22T02:00:00Z"), true);
    assert.equal(root.db.setPageShareable(stableShared, true, "2026-11-22T02:00:00Z"), false, "已发布的不重复写");

    const shared = root.db.sharedPages().map((p) => p.path);
    assert.deepEqual(shared, [stableShared], "只有「稳定 + 已发布」那条可见；稳定的但没发布的那条不出现");

    // Unpublish closes it again.
    assert.equal(root.db.setPageShareable(stableShared, false, "2026-11-22T03:00:00Z"), true);
    assert.deepEqual(root.db.sharedPages(), [], "取消发布后回到不可见");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── cross-root read: a grant is a row, never an inference ───────────────────
//
// Batch 3 tasks 3.1/3.3/3.5. This is the only path in the service that reads a
// root other than the caller's, so every condition is pinned separately:
//   no grant        -> refuse
//   grant           -> only settled AND published pages
//   similar name    -> still refuse (naming is not permission)
//   write side      -> does not exist at all
test("a grant is required and only exposes settled+published pages", () => {
  const data = tmpData();
  try {
    const owner = new StoreRoot(data, "u-owner");
    const reader = new StoreRoot(data, "d-alice-pack");

    // Three pages in the owner's root, in the three states that matter.
    owner.writePage("default", "notes", "draft", newPage("note", "草稿", "正文", {}));
    owner.writePage("default", "notes", "stableOnly", newPage("note", "稳定未发布", "正文", {}));
    owner.writePage("default", "notes", "shared", newPage("note", "稳定已发布", "正文", {}));
    for (const slug of ["stableOnly", "shared"]) {
      owner.db.db.prepare("INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at) VALUES (?,?,?,?,?,?)")
        .run("default", `default/notes/${slug}.md`, "stable", "理由", "ai", "2026-11-22T00:00:00Z");
      owner.db.promotePage(`default/notes/${slug}.md`, "stable", "测试", "2026-11-22T01:00:00Z");
    }
    owner.db.setPageShareable("default/notes/shared.md", true, "2026-11-22T02:00:00Z");
    // A draft must be refused even if someone tries to publish it.
    assert.equal(owner.db.setPageShareable("default/notes/draft.md", true, "2026-11-22T02:00:00Z"), false);

    // 1. No grant -> the reader sees nothing.
    assert.equal(owner.db.hasShareGrant("d-alice-pack"), false, "未授权时不得有任何读权限");

    // 2. A similar-looking name proves nothing.
    assert.equal(owner.db.hasShareGrant("u-owner2"), false, "名字像不等于授权");

    // 3. Grant, then read: only the published+s settled page appears.
    assert.equal(owner.db.setShareGrant("d-alice-pack", true, "2026-11-22T03:00:00Z", "试用"), true);
    assert.equal(owner.db.hasShareGrant("d-alice-pack"), true);
    const visible = owner.db.sharedPages().map((p) => p.path);
    assert.deepEqual(visible, ["default/notes/shared.md"], "草稿与「稳定但未发布」都不可见");

    // 4. Revoke closes it.
    assert.equal(owner.db.setShareGrant("d-alice-pack", false, "2026-11-22T04:00:00Z"), true);
    assert.equal(owner.db.hasShareGrant("d-alice-pack"), false);

    // The reader's own root has its own (empty) grant table — grants are not global.
    assert.deepEqual(reader.db.shareGrants(), []);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// New TABLES need the version bump too, not just new columns.
//
// Hit for real on 2026-11-22 (twice in one night): `migrate()` short-circuits
// when the stored version matches, so a `CREATE TABLE IF NOT EXISTS` added
// inside it never runs on an existing database. The idempotent guard makes the
// statement look harmless; the version number is the only trigger.
test("reopening an older database creates newly-added tables", () => {
  const data = tmpData();
  try {
    const first = new StoreRoot(data, "u-tables");
    // Simulate a database written before the share_grants table existed.
    first.db.db.exec("DROP TABLE IF EXISTS share_grants; UPDATE schema_meta SET value = '5' WHERE key = 'version';");
    const before = first.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='share_grants'").all() as Array<{ name: string }>;
    assert.equal(before.length, 0, "前提：老库确实没有该表");

    const second = new StoreRoot(data, "u-tables");
    const after = second.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='share_grants'").all() as Array<{ name: string }>;
    assert.equal(after.length, 1, "reopen 后必须建出新表");
    // And it must be usable, not just present.
    assert.deepEqual(second.db.shareGrants(), []);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// Cross-root reads must be auditable by the owner (batch 4 task 4.3).
//
// "Who read my shared pages" is the owner's question, so the row lives in the
// OWNER's database — not a global log, not the reader's. Separate from
// oversight_reads, which records the owner looking at their own data.
test("a cross-root read leaves an audit row in the owner's database", () => {
  const data = tmpData();
  try {
    const owner = new StoreRoot(data, "u-audited");
    owner.writePage("default", "notes", "p", newPage("note", "共享页", "正文", {}));
    owner.db.db.prepare("INSERT INTO tier_proposals (project, page_rel, proposed_tier, reason, proposed_by, proposed_at) VALUES (?,?,?,?,?,?)")
      .run("default", "default/notes/p.md", "stable", "理由", "ai", "2026-11-22T00:00:00Z");
    owner.db.promotePage("default/notes/p.md", "stable", "测试", "2026-11-22T01:00:00Z");
    owner.db.setPageShareable("default/notes/p.md", true, "2026-11-22T02:00:00Z");

    assert.deepEqual(owner.db.shareReads(), [], "读之前没有记录");

    owner.db.noteSharedRead("d-alice-pack", ["default/notes/p.md"], "2026-11-22T03:00:00Z");
    const reads = owner.db.shareReads();
    assert.equal(reads.length, 1);
    assert.equal(reads[0].reader_root, "d-alice-pack");
    assert.equal(reads[0].page_rel, "default/notes/p.md");
    assert.equal(reads[0].ts, "2026-11-22T03:00:00Z");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("the share_reads table appears on a database that predates it", () => {
  const data = tmpData();
  try {
    const first = new StoreRoot(data, "u-shareReads");
    first.db.db.exec("DROP TABLE IF EXISTS share_reads; UPDATE schema_meta SET value='6' WHERE key='version';");
    const before = first.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='share_reads'").all() as Array<{ name: string }>;
    assert.equal(before.length, 0, "前提：老库没有该表");

    const second = new StoreRoot(data, "u-shareReads");
    const after = second.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='share_reads'").all() as Array<{ name: string }>;
    assert.equal(after.length, 1, "reopen 后必须建出该表");
    assert.deepEqual(second.db.shareReads(), []);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
