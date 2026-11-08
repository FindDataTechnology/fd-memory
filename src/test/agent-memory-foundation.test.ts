// agent-memory-foundation contracts (add-agent-memory-foundation): metadata
// write/reject/equivalence, structured filters on the HTTP + MCP read faces,
// the idempotent title-prefix backfill, owner oversight (bound read /
// cross-owner refusal / zero write power / audited), and memory_overview.
// Route-level tests hit a REAL service like the rest of this repo — the bugs
// that shipped here lived in parameter-parsing seams, not in mocks.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { StoreRoot, normalizeMetadata } from "../store.js";
import { __resetMetrics } from "../metrics.js";
import { __resetEmbedGate } from "../embed-gate.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(prefix = "fdm-foundation-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function boot() {
  __resetEmbedGate();
  __resetMetrics();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { svc, base, close, data };
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

async function mcpSession(base: string, tok: string) {
  const init = await fetch(base + "/mcp", { method: "POST", headers: json(tok), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const sid = init.headers.get("mcp-session-id")!;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(base + "/mcp", { method: "POST", headers: { ...json(tok), "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
    const body = await r.json();
    if (body.error) return { __rpc_error: body.error };
    return JSON.parse((body.result.content as [{ text: string }])[0].text);
  };
}

// ── metadata write face ──────────────────────────────────────────────────────

test("metadata: write lands in frontmatter + index, structured filter finds it by kind and memberId", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const w = await fetch(base + "/pages", { method: "POST", headers: json(person), body: JSON.stringify({ project: "f-team", title: "拍板：换网关", body: "结论 body", metadata: { kind: "decision-resolved", memberId: "clerk" } }) });
    assert.equal(w.status, 200);
    const rel = ((await w.json()) as { path: string }).path;
    // truth carries it
    const raw = readFileSync(join(svc.rootForKey("u-alice").wikiDir, rel), "utf8");
    assert.ok(raw.includes("kind: decision-resolved"));
    assert.ok(raw.includes("memberId: clerk"));
    // indexed filter finds it
    const g = await fetch(`${base}/pages?project=f-team&meta=kind:decision-resolved`, { headers: json(person) });
    assert.equal(g.status, 200);
    const pages = ((await g.json()) as { pages: Array<{ path: string }> }).pages;
    assert.deepEqual(pages.map((p) => p.path), [rel]);
    // member filter too
    const g2 = await fetch(`${base}/pages?project=f-team&meta=memberId:clerk`, { headers: json(person) });
    assert.equal(((await g2.json()) as { pages: unknown[] }).pages.length, 1);
  } finally { await close(); }
});

test("metadata: invalid shape is a named 400 and nothing lands", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const w = await fetch(base + "/pages", { method: "POST", headers: json(person), body: JSON.stringify({ project: "f-team", title: "t", body: "b", metadata: { tags: { a: 1 } } }) });
    assert.equal(w.status, 400);
    assert.equal(((await w.json()) as { error: string }).error, "invalid_metadata");
    const g = await fetch(`${base}/pages?project=f-team&limit=50`, { headers: json(person) });
    assert.deepEqual(((await g.json()) as { pages: unknown[] }).pages, []);
  } finally { await close(); }
});

test("metadata: absent metadata write is byte-equivalent legacy behavior", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const w = await fetch(base + "/pages", { method: "POST", headers: json(person), body: JSON.stringify({ project: "f-team", title: "旧格式页", body: "b" }) });
    assert.equal(w.status, 200);
    const g = await fetch(`${base}/pages?project=f-team`, { headers: json(person) });
    const pages = ((await g.json()) as { pages: Array<{ metadata: string | null }> }).pages;
    assert.equal(pages.length, 1);
    assert.equal(pages[0].metadata, null);
    // and it is invisible to a metadata filter (missing key never matches)
    const g2 = await fetch(`${base}/pages?project=f-team&meta=kind:turn`, { headers: json(person) });
    assert.deepEqual(((await g2.json()) as { pages: unknown[] }).pages, []);
  } finally { await close(); }
});

// ── structured filters on read faces ─────────────────────────────────────────

test("filters: /pages GET layer + time window + metadata compose", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const mk = (title: string, metadata?: unknown) =>
      fetch(base + "/pages", { method: "POST", headers: json(person), body: JSON.stringify({ project: "f-team", title, body: "b", ...(metadata ? { metadata } : {}) }) });
    await mk("拍板一", { kind: "decision-resolved", memberId: "clerk" });
    await mk("报数一", { kind: "turn", memberId: "clerk" });
    await mk("纯笔记");
    const l2 = await fetch(`${base}/pages?project=f-team&layer=L2`, { headers: json(person) });
    assert.deepEqual(((await l2.json()) as { pages: unknown[] }).pages, []);
    const notes = await fetch(`${base}/pages?project=f-team&layer=L1&limit=50`, { headers: json(person) });
    assert.equal(((await notes.json()) as { pages: unknown[] }).pages.length, 3);
    const kind = await fetch(`${base}/pages?project=f-team&meta=kind:turn`, { headers: json(person) });
    const kp = ((await kind.json()) as { pages: Array<{ title: string }> }).pages;
    assert.equal(kp.length, 1);
    assert.equal(kp[0].title, "报数一");
    const since = await fetch(`${base}/pages?project=f-team&since=9999-01-01`, { headers: json(person) });
    assert.deepEqual(((await since.json()) as { pages: unknown[] }).pages, []);
  } finally { await close(); }
});

test("filters: MCP memory_query filter narrows; memory_recent layer=L0 returns observations only", async () => {
  const { svc, base, close } = await boot();
  try {
    const tok = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("d-pk");
    root.writePage("agentA", "notes", "n1", { frontmatter: { type: "note", title: "[turn][clerk] 报数完成", metadata: { kind: "turn", memberId: "clerk" } }, body: "b1\n" });
    root.writePage("agentA", "notes", "n2", { frontmatter: { type: "note", title: "普通笔记" }, body: "b2\n" });
    root.db.addObservation({ session_id: "s1", agent: "a", event: "stop", tool: null, summary: "回合完成", created_at: new Date().toISOString(), project: "agentA" });
    const call = await mcpSession(base, tok);
    const byMeta = await call("memory_query", { q: "报数", filter: { metadata: { kind: "turn" } } });
    assert.equal(byMeta.results.length, 1);
    assert.equal(byMeta.results[0].title, "[turn][clerk] 报数完成");
    assert.deepEqual(byMeta.results[0].metadata, { kind: "turn", memberId: "clerk" });
    const l0 = await call("memory_recent", { filter: { layer: "L0" } });
    assert.deepEqual(l0.pages, []);
    assert.equal(l0.observations.length, 1);
    const l1 = await call("memory_recent", { filter: { layer: "L1" } });
    assert.equal(l1.pages.length, 2);
    assert.deepEqual(l1.observations, []);
    const bad = await call("memory_query", { q: "x", filter: { metadata: { tags: { a: 1 } } } });
    assert.equal(bad.error, "invalid_metadata");
  } finally { await close(); }
});

test("filters: /digest meta filter narrows L2+notes; empty intersection is an empty digest, not an error", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const root = svc.rootForKey("d-pk");
    root.writePage("f-team", "notes", "n1", { frontmatter: { type: "note", title: "[turn][clerk] 报数", metadata: { kind: "turn", memberId: "clerk" } }, body: "报数 body\n" });
    root.writePage("f-team", "notes", "n2", { frontmatter: { type: "note", title: "拍板记录", metadata: { kind: "decision-resolved", memberId: "lead" } }, body: "拍板 body\n" });
    const hit = await fetch(`${base}/digest?rootKey=d-pk&project=f-team&meta=kind:turn`, { headers: json(platform) });
    assert.equal(hit.status, 200);
    const hitBody = await hit.json() as { digest: string };
    assert.ok(hitBody.digest.includes("报数"));
    assert.ok(!hitBody.digest.includes("拍板记录"));
    const miss = await fetch(`${base}/digest?rootKey=d-pk&project=f-team&meta=kind:nonexistent`, { headers: json(platform) });
    assert.equal(miss.status, 200);
    const missBody = (await miss.json()) as { digest: string; items: number; notes: number };
    assert.equal(missBody.items + missBody.notes, 0);
    const bad = await fetch(`${base}/digest?rootKey=d-pk&project=f-team&meta=novalue`, { headers: json(platform) });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_meta_param");
  } finally { await close(); }
});

// ── backfill ─────────────────────────────────────────────────────────────────

test("backfill: parses [kind][member] prefixes into metadata, idempotent, leaves unmatched alone", async () => {
  const { svc, data, close } = await boot();
  try {
    const root = svc.rootForKey("d-pk");
    root.writePage("f-team", "notes", "n1", { frontmatter: { type: "note", title: "[decision-resolved][lead] 换网关" }, body: "b\n" });
    root.writePage("f-team", "notes", "n2", { frontmatter: { type: "note", title: "[turn][clerk] 报数" }, body: "b\n" });
    root.writePage("f-team", "notes", "n3", { frontmatter: { type: "note", title: "无前缀的页" }, body: "b\n" });
    const script = new URL("../../scripts/backfill-metadata.mjs", import.meta.url).pathname;
    const run = () => JSON.parse(execFileSync(process.execPath, [script, "--data", data], { encoding: "utf8" })) as { backfilled: number; unmatched: number };
    const first = run();
    assert.equal(first.backfilled, 2);
    assert.equal(first.unmatched, 1);
    const second = run();
    assert.equal(second.backfilled, 0, "re-run is a no-op");
    // title preserved (quote style is yaml's choice — `[` forces double
    // quotes), metadata present, page still on disk
    const raw = readFileSync(join(root.wikiDir, "f-team/notes/n1.md"), "utf8");
    assert.ok(raw.includes("[decision-resolved][lead] 换网关"));
    assert.ok(raw.includes("kind: decision-resolved"));
    assert.ok(existsSync(join(root.wikiDir, "f-team/notes/n1.md")));
  } finally { await close(); }
});

// ── owner oversight ──────────────────────────────────────────────────────────

test("oversight: platform deployment mint binds root_owner; owner reads member partitions audited; stranger refused; zero write power", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const mint = await fetch(base + "/admin/mint", { method: "POST", headers: json(platform), body: JSON.stringify({ namespace: "d/pk/clerk", owner: "u/alice", label: "member" }) });
    assert.equal(mint.status, 200);
    const memberTok = ((await mint.json()) as { token: string }).token;
    assert.equal(svc.tokens.rootOwnerOf("d-pk"), "alice");
    // member writes its own partition
    const w = await fetch(base + "/pages", { method: "POST", headers: json(memberTok), body: JSON.stringify({ project: "clerk", title: "我的经验", body: "b", metadata: { kind: "turn", memberId: "clerk" } }) });
    assert.equal(w.status, 200);
    const alice = svc.tokens.mint("person", "u/alice").token;
    const bob = svc.tokens.mint("person", "u/bob").token;
    // owner reads the member's private partition — audited
    const r1 = await fetch(`${base}/pages?rootKey=d-pk&project=clerk`, { headers: json(alice) });
    assert.equal(r1.status, 200);
    const pages = ((await r1.json()) as { pages: Array<{ title: string }> }).pages;
    assert.equal(pages.length, 1);
    assert.equal(pages[0].title, "我的经验");
    // digest oversight read
    const r2 = await fetch(`${base}/digest?rootKey=d-pk&project=clerk`, { headers: json(alice) });
    assert.equal(r2.status, 200);
    // /memory oversight listing
    const r3 = await fetch(`${base}/memory?rootKey=d-pk`, { headers: json(alice) });
    assert.equal(r3.status, 200);
    assert.ok(((await r3.json()) as { items: unknown[] }).items.length >= 1);
    // stranger refused, existence not leaked
    const r4 = await fetch(`${base}/pages?rootKey=d-pk&project=clerk`, { headers: json(bob) });
    assert.equal(r4.status, 403);
    const r5 = await fetch(`${base}/digest?rootKey=d-pk&project=clerk`, { headers: json(bob) });
    assert.equal(r5.status, 403);
    // person has ZERO write power on the d/ root: /pages POST resolves inside
    // their own u/ root no matter what project name they type — the d/ tree
    // never gains a file.
    const before = execFileSync("find", [join(svc.rootForKey("d-pk").wikiDir, "clerk"), "-name", "*.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    const w2 = await fetch(base + "/pages", { method: "POST", headers: json(alice), body: JSON.stringify({ project: "clerk", title: "越权?", body: "b" }) });
    assert.equal(w2.status, 200); // it wrote to u/alice/p/clerk, NOT d-pk
    const after = execFileSync("find", [join(svc.rootForKey("d-pk").wikiDir, "clerk"), "-name", "*.md"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
    assert.equal(after, before);
    // audit rows visible via /admin/report
    const rep = await fetch(base + "/admin/report", { method: "POST", headers: json(platform), body: JSON.stringify({ rootKey: "d-pk" }) });
    const report = (await rep.json()) as { oversight_reads: Array<{ principal: string; root_key: string; hits: number }> };
    assert.ok(report.oversight_reads.length >= 3);
    assert.ok(report.oversight_reads.every((o) => o.root_key === "d-pk"));
  } finally { await close(); }
});

test("oversight: first binding wins — admin rebind is a no-op reporting the existing owner", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const b1 = await fetch(base + "/admin/bind-root-owner", { method: "POST", headers: json(platform), body: JSON.stringify({ rootKey: "d-old", owner: "u/alice" }) });
    assert.equal(((await b1.json()) as { bound: boolean }).bound, true);
    const b2 = await fetch(base + "/admin/bind-root-owner", { method: "POST", headers: json(platform), body: JSON.stringify({ rootKey: "d-old", owner: "u/bob" }) });
    const j2 = (await b2.json()) as { bound: boolean; existing: string | null };
    assert.equal(j2.bound, false);
    assert.equal(j2.existing, "alice");
    assert.equal(svc.tokens.rootOwnerOf("d-old"), "alice");
    // bob (the would-be rebinder) still cannot read
    const bob = svc.tokens.mint("person", "u/bob").token;
    const r = await fetch(`${base}/pages?rootKey=d-old&project=shared`, { headers: json(bob) });
    assert.equal(r.status, 403);
  } finally { await close(); }
});

// ── memory_overview ──────────────────────────────────────────────────────────

test("overview: deployment member sees own+shared only; pod sees shared only; person sees their root", async () => {
  const { svc, base, close } = await boot();
  try {
    const memberTok = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const podTok = svc.tokens.mint("pod", "d/pk").token;
    const personTok = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("d-pk");
    root.writePage("agentA", "notes", "n1", { frontmatter: { type: "note", title: "成员笔记" }, body: "b\n" });
    root.writePage("shared", "notes", "s1", { frontmatter: { type: "note", title: "共享笔记" }, body: "b\n" });
    root.writePage("agentB", "notes", "x1", { frontmatter: { type: "note", title: "兄弟的页" }, body: "b\n" });
    const mcall = await mcpSession(base, memberTok);
    const mo = await mcall("memory_overview", {});
    const mProjects = mo.partitions.map((p: { project: string }) => p.project).sort();
    assert.deepEqual(mProjects, ["agentA", "shared"]);
    const agentA = mo.partitions.find((p: { project: string }) => p.project === "agentA");
    assert.equal(agentA.source, "own");
    assert.equal(agentA.pages, 1);
    assert.equal(agentA.recent[0].title, "成员笔记");
    const pcall = await mcpSession(base, podTok);
    const po = await pcall("memory_overview", {});
    assert.deepEqual(po.partitions.map((p: { project: string }) => p.project), ["shared"]);
    const ucall = await mcpSession(base, personTok);
    const root2 = svc.rootForKey("u-alice");
    root2.writePage("default", "notes", "p1", { frontmatter: { type: "note", title: "主人笔记" }, body: "b\n" });
    const uo = await ucall("memory_overview", {});
    assert.deepEqual(uo.partitions.map((p: { project: string }) => p.project), ["default"]);
  } finally { await close(); }
});

test("overview: both dimensions capped, and truncated tells the truth", async () => {
  const { svc, base, close } = await boot();
  try {
    const personTok = svc.tokens.mint("person", "u/bulk").token;
    const root = svc.rootForKey("u-bulk");
    // 40 partitions (over the 25 cap), the first holding 20 pages (over the 3
    // titles shown). The old guard (`partitions.length >= 50`) would have said
    // truncated=false while shipping all of it.
    root.writePage("p00", "notes", "a", { frontmatter: { type: "note", title: "t" }, body: "b\n" });
    for (let i = 0; i < 20; i++) root.writePage("p00", "notes", `n${i}`, { frontmatter: { type: "note", title: `t${i}` }, body: "b\n" });
    for (let p = 1; p < 40; p++) root.writePage(`p${String(p).padStart(2, "0")}`, "notes", "x", { frontmatter: { type: "note", title: "x" }, body: "b\n" });
    const call = await mcpSession(base, personTok);
    const out = await call("memory_overview", {});
    assert.equal(out.partitions.length, 25, "partition page is capped");
    assert.equal(out.total_partitions, 40, "the real count is stated");
    assert.equal(out.truncated, true, "and the page says it is a page");
    for (const p of out.partitions) assert.ok(p.recent.length <= 3, `${p.project} listed ${p.recent.length} titles`);

    // A single partition with more pages than titles is ALSO truncated even
    // though the partition count fits.
    const root2 = svc.rootForKey("u-small");
    const t2 = svc.tokens.mint("person", "u/small").token;
    for (let i = 0; i < 9; i++) root2.writePage("only", "notes", `k${i}`, { frontmatter: { type: "note", title: `k${i}` }, body: "b\n" });
    const out2 = await (await mcpSession(base, t2))("memory_overview", {});
    assert.equal(out2.partitions.length, 1);
    assert.equal(out2.truncated, true, "9 pages behind 3 titles is truncation, not a complete view");
  } finally { await close(); }
});

// ── normalizeMetadata unit shape ─────────────────────────────────────────────

test("normalizeMetadata: absent vs invalid vs valid", () => {
  assert.equal(normalizeMetadata(undefined), undefined);
  assert.equal(normalizeMetadata(null), null);
  assert.equal(normalizeMetadata("nope"), null);
  assert.equal(normalizeMetadata({ a: { b: 1 } }), null);
  assert.deepEqual(normalizeMetadata({ ok: ["x", 1, true] }), { ok: ["x", 1, true] });
  assert.equal(normalizeMetadata({ bad: [{}, 1] }), null);
  assert.equal(normalizeMetadata({ big: "x".repeat(300) }), null);
  assert.deepEqual(normalizeMetadata({ flag: true }), { flag: true });
});
