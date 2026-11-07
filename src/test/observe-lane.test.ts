// /observe lane tests (add-yongyi-complete-solution, spec yongyi-observe-lane):
// closed-set refusal, persistent idempotent replay, namespace authority
// (person u/ root / deployment own partition / pod shared), per-token rate
// guard isolation, 32KB truncation with in-page annotation, auth matrix, and
// digest recall with the harness source badge. These hit a REAL service over a
// REAL port (same discipline as http-routes.test.ts).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { __resetEmbedGate } from "../embed-gate.js";
import { __resetObserveRateLimiter, OBSERVE_EVENT_TYPES } from "../observe.js";

const dirs: string[] = [];
afterEach(() => {
  __resetObserveRateLimiter();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(prefix = "fdm-observe-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function boot() {
  __resetEmbedGate();
  __resetObserveRateLimiter();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { svc, base, close };
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
const post = (base: string, token: string, body: unknown) =>
  fetch(`${base}/observe`, { method: "POST", headers: json(token), body: JSON.stringify(body) });

test("/observe: closed set — unknown type and missing MUST fields are named 4xx, nothing lands", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const root = svc.rootForKey("u-alice");

    const mood = await post(base, person, { type: "mood", idempotency_key: "m-1", title: "心情", body: "不错" });
    assert.equal(mood.status, 400, "type outside the closed set is a 4xx");
    const md = (await mood.json()) as { error: string; code: string; allowed: string[] };
    assert.equal(md.error, "unknown_event_type");
    assert.equal(md.code, "unknown_event_type");
    assert.deepEqual(md.allowed, [...OBSERVE_EVENT_TYPES]);

    for (const [label, body] of [
      ["no idempotency_key", { type: "turn_outcome", title: "t", body: "b" }],
      ["no title", { type: "turn_outcome", idempotency_key: "k", body: "b" }],
      ["no body", { type: "turn_outcome", idempotency_key: "k", title: "t" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await post(base, person, body);
      assert.equal(r.status, 400, `${label} must be a named 400`);
      const d = (await r.json()) as { error: string; code: string };
      assert.ok(d.error && d.code, `${label} carries {error, code}`);
    }

    assert.equal(root.db.recentObservationPages("default", 50).length, 0, "rejected events never land a page");
  } finally { await close(); }
});

test("/observe: person turn_outcome lands an L0 observation page, /memory lists it, digest recalls it with the harness badge", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const r = await post(base, person, {
      type: "turn_outcome", idempotency_key: "r-42", title: "周报初稿完成",
      body: "初稿已提交待评审", harness: "claude-code",
    });
    assert.equal(r.status, 202, "capture answers 2xx");
    const d = (await r.json()) as { page: string; truncated?: boolean };
    assert.ok(d.page, "response carries the page id");
    assert.notEqual(d.truncated, true);

    const root = svc.rootForKey("u-alice");
    const page = root.readPageByRel(d.page);
    assert.ok(page, "page exists under the person root");
    assert.equal(page!.frontmatter.type, "observation", "observation page type — L0 derives from it");
    assert.equal((page!.frontmatter.metadata as Record<string, unknown>).harness, "claude-code");
    assert.equal((page!.frontmatter.observe as Record<string, unknown>).type, "turn_outcome");
    assert.equal((page!.frontmatter.observe as Record<string, unknown>).idempotency_key, "r-42");

    // /memory lists it as L0
    const mem = await fetch(`${base}/memory?layer=L0&project=default`, { headers: json(person) });
    assert.equal(mem.status, 200);
    const items = ((await mem.json()) as { items: Array<{ title: string; layer: string }> }).items;
    assert.ok(items.some((i) => i.title === "周报初稿完成" && i.layer === "L0"), "observation appears as L0 under the person root");

    // digest recall (spec scenario): the page is digest-recallable, with badge
    const dg = await fetch(`${base}/digest?project=default&q=周报`, { headers: json(person) });
    assert.equal(dg.status, 200);
    const dd = (await dg.json()) as { digest: string };
    assert.ok(dd.digest.includes("周报初稿完成"), "digest recalls the observe page");
    assert.ok(dd.digest.includes("（来自 claude-code）"), "harness badge renders on the evidence line");
    assert.match(dd.digest, /〔L0·observation｜\d{4}-\d{2}-\d{2}〕周报初稿完成/);
  } finally { await close(); }
});

test("/observe: idempotent replay — same {type, idempotency_key} twice → one page, both 2xx, first page id returned", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const first = await post(base, person, { type: "turn_outcome", idempotency_key: "r-1", title: "第一", body: "第一次投递" });
    assert.equal(first.status, 202);
    const p1 = ((await first.json()) as { page: string }).page;

    // network retry shape: same key, payload differs — replay must NOT create
    // a second page; the FIRST result is returned
    const replay = await post(base, person, { type: "tool_call", idempotency_key: "r-1", title: "重试", body: "网络重试的重复投递" });
    assert.equal(replay.status, 202, "replay is a 2xx, never an error");
    const rd = (await replay.json()) as { page: string; duplicate: boolean };
    assert.equal(rd.page, p1, "the first delivery's page id comes back");
    assert.equal(rd.duplicate, true);

    const root = svc.rootForKey("u-alice");
    assert.equal(root.db.recentObservationPages("default", 50).length, 1, "namespace holds exactly one page");

    const other = await post(base, person, { type: "turn_outcome", idempotency_key: "r-2", title: "第二", body: "另一次投递" });
    assert.equal(other.status, 202);
    assert.notEqual(((await other.json()) as { page: string }).page, p1, "a different key is a different page");
    assert.equal(root.db.recentObservationPages("default", 50).length, 2);
  } finally { await close(); }
});

test("/observe: namespace authority — deployment lands own partition, pod lands shared, grant-less is a 403 that lands nothing", async () => {
  const { svc, base, close } = await boot();
  try {
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const r = await post(base, dep, { type: "health_flip", idempotency_key: "h-1", title: "健康翻转", body: "ok→degraded" });
    assert.equal(r.status, 202);
    const page = ((await r.json()) as { page: string }).page;
    assert.ok(page.startsWith("agentA/observations/"), `member event lands in its OWN partition (got ${page})`);
    assert.ok(svc.rootForKey("d-pk").readPageByRel(page), "page lives in the pack root");

    const pod = svc.tokens.mint("pod", "d/pk").token;
    const rp = await post(base, pod, { type: "tool_call", idempotency_key: "t-1", title: "工具调用", body: "query.exec()" });
    assert.equal(rp.status, 202);
    assert.ok(((await rp.json()) as { page: string }).page.startsWith("shared/observations/"), "pod (no own partition) lands shared");

    // 权限不足 → 4xx, nothing silently re-routed
    const broke = svc.tokens.mint("deployment", "d/pk2/agentB");
    svc.tokens.revokeGrant(broke.id, "agent", "d/pk2/agentB");
    svc.tokens.revokeGrant(broke.id, "pack", "d/pk2");
    const rf = await post(base, broke.token, { type: "turn_outcome", idempotency_key: "x-1", title: "无权", body: "应被拒" });
    assert.equal(rf.status, 403);
    assert.equal(((await rf.json()) as { error: string; code: string }).error, "forbidden");
    assert.equal(svc.rootForKey("d-pk2").db.recentObservationPages("agentB", 10).length, 0, "refusal lands nothing, anywhere");
  } finally { await close(); }
});

test("/observe: auth matrix — no token 401, platform/runner tokens refused", async () => {
  const { svc, base, close } = await boot();
  try {
    const anon = await fetch(`${base}/observe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "turn_outcome" }) });
    assert.equal(anon.status, 401);
    assert.equal(((await anon.json()) as { error: string }).error, "unauthorized");

    const platform = svc.tokens.mint("platform", "*").token;
    const rp = await post(base, platform, { type: "turn_outcome", idempotency_key: "k", title: "t", body: "b" });
    assert.equal(rp.status, 403);
    assert.equal(((await rp.json()) as { error: string }).error, "service_tokens_carry_no_data_plane_identity");

    const runner = svc.tokens.mint("runner", "*").token;
    const rr = await post(base, runner, { type: "turn_outcome", idempotency_key: "k", title: "t", body: "b" });
    assert.equal(rr.status, 403);
  } finally { await close(); }
});

test("/observe: rate guard — burst over the per-token window sheds with a retry hint; other faces unaffected", async () => {
  const { svc, base, close } = await boot();
  const prev = process.env.FD_MEMORY_OBSERVE_RATE_LIMIT;
  process.env.FD_MEMORY_OBSERVE_RATE_LIMIT = "2";
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    assert.equal((await post(base, person, { type: "turn_outcome", idempotency_key: "a", title: "一", body: "1" })).status, 202);
    assert.equal((await post(base, person, { type: "turn_outcome", idempotency_key: "b", title: "二", body: "2" })).status, 202);
    const third = await post(base, person, { type: "turn_outcome", idempotency_key: "c", title: "三", body: "3" });
    assert.equal(third.status, 429, "over-guard delivery gets the rate-limit code");
    const td = (await third.json()) as { error: string; code: string; retry_after_ms: number };
    assert.equal(td.error, "rate_limited");
    assert.equal(td.code, "rate_limited");
    assert.ok(td.retry_after_ms >= 0 && td.retry_after_ms <= 60_000, "retry hint is present and bounded");

    // the guard is per-token and per-face: the SAME token's other lanes work
    const pages = await fetch(`${base}/pages?project=default`, { headers: json(person) });
    assert.equal(pages.status, 200, "/pages unaffected by the observe guard");
    const digest = await fetch(`${base}/digest?project=default&q=x`, { headers: json(person) });
    assert.equal(digest.status, 200, "/digest unaffected by the observe guard");

    // a different token has its own budget
    const other = svc.tokens.mint("person", "u/bob").token;
    assert.equal((await post(base, other, { type: "turn_outcome", idempotency_key: "z", title: "独", body: "独立预算" })).status, 202, "another token's budget is untouched");
  } finally {
    if (prev === undefined) delete process.env.FD_MEMORY_OBSERVE_RATE_LIMIT; else process.env.FD_MEMORY_OBSERVE_RATE_LIMIT = prev;
    await close();
  }
});

test("/observe: body cap — oversized body truncates on a clean UTF-8 boundary with in-page annotation + truncated indicator", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const big = "永".repeat(40000); // 120KB of 3-byte chars — cuts mid-char by default
    const r = await post(base, person, { type: "turn_outcome", idempotency_key: "big-1", title: "超大正文", body: big });
    assert.equal(r.status, 202, "oversized still lands (truncation discipline, not refusal)");
    const d = (await r.json()) as { page: string; truncated: boolean };
    assert.equal(d.truncated, true, "response carries the truncation indicator");

    const page = svc.rootForKey("u-alice").readPageByRel(d.page)!;
    assert.equal(page.frontmatter.truncated, true, "in-page truncation annotation (frontmatter)");
    assert.ok(page.body.includes("已截断"), "in-page truncation annotation (body)");
    const bodyBytes = Buffer.byteLength(page.body, "utf8");
    assert.ok(bodyBytes <= 32 * 1024 + 256, `truncated page stays near the cap (got ${bodyBytes} bytes)`);
    assert.ok(!page.body.includes("\uFFFD"), "cut lands on a character boundary — no replacement garbage");
    assert.ok(page.body.includes("永"), "the head of the body survived");

    const small = await post(base, person, { type: "turn_outcome", idempotency_key: "big-2", title: "正常正文", body: "短正文" });
    const sd = (await small.json()) as { truncated?: boolean };
    assert.equal("truncated" in sd, false, "under-cap deliveries carry no truncation indicator");
  } finally { await close(); }
});

test("/observe: subject/ts/metadata pass-through — malformed shapes are named 400s, valid ones ride the page", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const bad = await post(base, person, { type: "tool_call", idempotency_key: "k1", title: "t", body: "b", metadata: "not-an-object" });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_metadata");
    const badTs = await post(base, person, { type: "tool_call", idempotency_key: "k2", title: "t", body: "b", ts: "not-a-date" });
    assert.equal(badTs.status, 400);
    assert.equal(((await badTs.json()) as { error: string }).error, "invalid_ts");
    const badHarness = await post(base, person, { type: "tool_call", idempotency_key: "k3", title: "t", body: "b", harness: 42 });
    assert.equal(badHarness.status, 400);
    assert.equal(((await badHarness.json()) as { error: string }).error, "invalid_harness");
    assert.equal(svc.rootForKey("u-alice").db.recentObservationPages("default", 50).length, 0);

    const ok = await post(base, person, {
      type: "tool_call", idempotency_key: "k4", title: "工具调用", body: "查询了库存接口",
      subject: "agent-x", ts: "2026-11-01T08:00:00Z", metadata: { foo: "bar", tags: ["库存"] },
    });
    assert.equal(ok.status, 202);
    const page = svc.rootForKey("u-alice").readPageByRel(((await ok.json()) as { page: string }).page)!;
    const meta = page.frontmatter.metadata as Record<string, unknown>;
    assert.equal(meta.foo, "bar");
    assert.deepEqual(meta.tags, ["库存"]);
    assert.equal(meta.subject, "agent-x");
    assert.equal(meta.harness, undefined, "absent harness stays absent (no phantom badge)");
    assert.deepEqual(page.frontmatter.observe, { type: "tool_call", idempotency_key: "k4", ts: "2026-11-01T08:00:00Z" });
  } finally { await close(); }
});

// -- add-observe-project-field: optional `project` steering -------------------

test("/observe: person project steering — event lands under the named root-internal project, /digest recalls it there, default lane byte-unchanged", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const r = await post(base, person, {
      type: "turn_outcome", idempotency_key: "room-1", title: "房间纪要", body: "房间回合的捕获内容", project: "room-abc",
    });
    assert.equal(r.status, 202, "steered delivery still answers 2xx");
    const d = (await r.json()) as { page: string; duplicate?: boolean };
    assert.ok(d.page.startsWith("room-abc/observations/"), `page lands under the named project (got ${d.page})`);
    const page = svc.rootForKey("u-alice").readPageByRel(d.page)!;
    assert.ok(page, "page lives inside the caller's own root");
    assert.equal(page.frontmatter.type, "observation");
    assert.equal((page!.frontmatter.observe as Record<string, unknown>).idempotency_key, "room-1");

    // spec scenario: digest recall under THAT project
    const dg = await fetch(`${base}/digest?project=room-abc&q=房间`, { headers: json(person) });
    assert.equal(dg.status, 200);
    assert.ok(((await dg.json()) as { digest: string }).digest.includes("房间纪要"), "digest recalls the page in its project");

    // the steered delivery touched nothing outside the named project
    assert.equal(svc.rootForKey("u-alice").db.recentObservationPages("default", 50).length, 0, "default project untouched by the steered delivery");

    // default lane byte-unchanged: absent project still lands default
    const plain = await post(base, person, { type: "tool_call", idempotency_key: "plain-1", title: "缺省投递", body: "不带 project 字段" });
    assert.equal(plain.status, 202);
    assert.ok(((await plain.json()) as { page: string }).page.startsWith("default/observations/"), "absent project keeps the default lane");
  } finally { await close(); }
});

test("/observe: project value is a root-internal NAME, never a path — separators flatten, dot-only falls back, other roots see zero writes", async () => {
  const { svc, base, close } = await boot();
  try {
    const bob = svc.tokens.mint("person", "u/bob").token;

    // a value that names another root flattens to an in-root project name
    const steal = await post(base, bob, { type: "tool_call", idempotency_key: "x-1", title: "越根尝试", body: "点名别的根", project: "u/alice/p/steal" });
    assert.equal(steal.status, 202);
    const sd = (await steal.json()) as { page: string };
    assert.ok(sd.page.startsWith("u-alice-p-steal/observations/"), `separator-carrying value flattens to an in-root name (got ${sd.page})`);
    assert.ok(svc.rootForKey("u-bob").readPageByRel(sd.page), "page lives in the caller's own root");

    // the named root holds ZERO writes anywhere (spec: 其它根零写入)
    const alicePages = svc.rootForKey("u-alice").db.recentPages(100);
    assert.equal(alicePages.length, 0, "no page of any project appeared in the named root");

    // traversal shapes degrade safely: dot-only → default lane, mixed dots keep no separators
    const dot = await post(base, bob, { type: "tool_call", idempotency_key: "x-2", title: "点号", body: "dot-only 值", project: ".." });
    assert.equal(dot.status, 202);
    assert.ok(((await dot.json()) as { page: string }).page.startsWith("default/observations/"), "dot-only value falls back to the default lane, never climbs out");
    const climb = await post(base, bob, { type: "tool_call", idempotency_key: "x-3", title: "爬路径", body: "相对路径尝试", project: "../../outside" });
    assert.equal(climb.status, 202);
    const cd = ((await climb.json()) as { page: string }).page;
    assert.ok(cd.startsWith("..-..-outside/observations/"), `separators flatten so the value cannot climb (got ${cd})`);
    const climbSeg = cd.split("/")[0];
    assert.ok(!/[\\/]/.test(climbSeg), "project segment holds no path separator — join stays inside the root");
    assert.ok(svc.rootForKey("u-bob").readPageByRel(cd), "climbing value still lands inside the caller's root");

    // malformed shapes are IGNORED (capture-degrading, never a 400): non-string and empty → default lane
    for (const [label, project] of [["number", 42], ["empty", ""]] as Array<[string, unknown]>) {
      const r = await post(base, bob, { type: "tool_call", idempotency_key: `x-${label}`, title: "坏形状", body: "非法形状的 project", project });
      assert.equal(r.status, 202, `${label}-shaped project is ignored, not refused`);
      assert.ok(((await r.json()) as { page: string }).page.startsWith("default/observations/"), `${label}-shaped project degrades to the default lane`);
    }
  } finally { await close(); }
});

test("/observe: deployment/pod tokens ignore the project field — own/shared partitioning unchanged, no steered partition appears", async () => {
  const { svc, base, close } = await boot();
  try {
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const r = await post(base, dep, { type: "turn_outcome", idempotency_key: "dp-1", title: "成员事件", body: "带 project 字段", project: "room-xyz" });
    assert.equal(r.status, 202);
    assert.ok(((await r.json()) as { page: string }).page.startsWith("agentA/observations/"), "member event still lands its OWN partition");

    const pod = svc.tokens.mint("pod", "d/pk").token;
    const rp = await post(base, pod, { type: "tool_call", idempotency_key: "dp-2", title: "pod 事件", body: "带 project 字段", project: "room-xyz" });
    assert.equal(rp.status, 202);
    assert.ok(((await rp.json()) as { page: string }).page.startsWith("shared/observations/"), "pod event still lands shared");

    const packPages = svc.rootForKey("d-pk").db.recentPages(100);
    assert.ok(packPages.every((p) => p.project !== "room-xyz"), "no steered partition was created anywhere in the pack root");
  } finally { await close(); }
});

test("/observe: idempotency stays root-global across projects — same key in another project replays the FIRST page, never a second copy", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const first = await post(base, person, { type: "turn_outcome", idempotency_key: "g-1", title: "首次投递", body: "落在 room-a", project: "room-a" });
    assert.equal(first.status, 202);
    const p1 = ((await first.json()) as { page: string }).page;
    assert.ok(p1.startsWith("room-a/observations/"));

    // same key, different project: duplicate — the first delivery's page wins
    const replay = await post(base, person, { type: "turn_outcome", idempotency_key: "g-1", title: "换房重放", body: "落在 room-b", project: "room-b" });
    assert.equal(replay.status, 202, "replay is a 2xx");
    const rd = (await replay.json()) as { page: string; duplicate: boolean };
    assert.equal(rd.page, p1, "the first delivery's page id comes back");
    assert.equal(rd.duplicate, true);

    // same key, no project at all: still the same first page
    const bare = await post(base, person, { type: "turn_outcome", idempotency_key: "g-1", title: "裸重放", body: "不带 project" });
    assert.equal(bare.status, 202);
    assert.equal(((await bare.json()) as { page: string; duplicate: boolean }).page, p1);

    const root = svc.rootForKey("u-alice");
    assert.equal(root.db.recentObservationPages("room-a", 50).length, 1, "room-a holds exactly the first page");
    assert.equal(root.db.recentObservationPages("room-b", 50).length, 0, "room-b holds nothing — no per-project key fork");
    assert.equal(root.db.recentObservationPages("default", 50).length, 0, "default holds nothing");
  } finally { await close(); }
});
