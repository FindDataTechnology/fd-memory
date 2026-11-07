// 五类事实捕获单测：封闭分区映射、有界幂等去重窗、未知类型计失败、健康翻
// 转、三段合流金样、writeFact 的 HTTP 落点与一等 metadata。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KIND_PARTITION,
  CAPTURE_DEDUP_MAX,
  FLEET_SEGMENT_LABELS,
  createFleetMemoryCapture,
  createHealthFlipTracker,
  fleetMemoryFor,
  fleetProjectId,
  memberProjectId,
  FleetMemoryWriter,
} from "../src/facts.js";
import { golden, tmpData, baseEnv, mintRoutesMinder } from "./helpers.js";
import { rmSync } from "node:fs";

function recordingWriter(): { writer: FleetMemoryWriter; writes: Array<any> } {
  const writes: Array<any> = [];
  const writer: FleetMemoryWriter = {
    async writeFact(input) {
      writes.push(input);
      return input;
    },
  };
  return { writer, writes };
}

test("五类分区映射：turn/health→own，decision-opened/decision-resolved/swap→shared", async () => {
  const { writer, writes } = recordingWriter();
  const cap = createFleetMemoryCapture({ memory: writer, clock: () => 1000 })!;
  const plan: Array<[string, string]> = [
    ["turn", "own"],
    ["health", "own"],
    ["decision-opened", "shared"],
    ["decision-resolved", "shared"],
    ["swap", "shared"],
  ];
  for (const [kind, expected] of plan) {
    const out = await cap.capture("fleet-9", "writer-a", kind, `标题 ${kind}`, `正文 ${kind}`);
    assert.equal(out, true, kind);
  }
  assert.equal(cap.captured, 5);
  assert.equal(cap.failures, 0);
  assert.deepEqual(writes.map((w) => [w.kind, w.partition]), plan.map(([k, p]) => [k, p]));
  assert.deepEqual(KIND_PARTITION, {
    turn: "own",
    health: "own",
    "decision-opened": "shared",
    "decision-resolved": "shared",
    swap: "shared",
  });
});

test("第五类漂移：未知类型计失败，不产生任何落页", async () => {
  const { writer, writes } = recordingWriter();
  const cap = createFleetMemoryCapture({ memory: writer, clock: () => 1000 })!;
  const out = await cap.capture("fleet-9", "writer-a", "sixth-sense" as any, "标题", "正文");
  assert.equal(out, false);
  assert.equal(cap.failures, 1, "失败计数就是可观测性");
  assert.equal(cap.captured, 0);
  assert.equal(writes.length, 0, "绝不误落分区");
});

test("幂等去重窗：同内容重放返回 null（未尝试）；同时间戳不同内容不去重", async () => {
  const { writer, writes } = recordingWriter();
  const cap = createFleetMemoryCapture({ memory: writer, clock: () => 1000 })!;
  assert.equal(await cap.capture("f", "m", "turn", "报数", "body-1"), true);
  assert.equal(await cap.capture("f", "m", "turn", "报数", "body-1"), null, "窗内重放 → 幂等");
  assert.equal(await cap.capture("f", "m", "turn", "报数", "body-2"), true, "固定时钟下不同事实不去重");
  assert.equal(writes.length, 2);
  assert.equal(cap.captured, 2);
  assert.equal(cap.failures, 0);
});

test("有界去重窗：512 溢出逐出最旧——被逐出的重放会再次尝试", async () => {
  const { writer, writes } = recordingWriter();
  const cap = createFleetMemoryCapture({ memory: writer, clock: () => 1000 })!;
  assert.equal(CAPTURE_DEDUP_MAX, 512);
  for (let i = 0; i < CAPTURE_DEDUP_MAX; i++) {
    assert.equal(await cap.capture("f", "m", "turn", `t-${i}`, "b"), true);
  }
  assert.equal(writes.length, CAPTURE_DEDUP_MAX);
  // 窗内重放（最新的键仍在窗内）→ null
  assert.equal(await cap.capture("f", "m", "turn", `t-${CAPTURE_DEDUP_MAX - 1}`, "b"), null);
  // 再来一条，最旧 t-0 被逐出；其重放再次尝试
  assert.equal(await cap.capture("f", "m", "turn", "t-new", "b"), true);
  assert.equal(writes.length, CAPTURE_DEDUP_MAX + 1);
  assert.equal(await cap.capture("f", "m", "turn", "t-0", "b"), true, "窗外的旧键重放 = 新事实");
  assert.equal(writes.length, CAPTURE_DEDUP_MAX + 2);
});

test("writeFact 抛错 → 计失败、capture 返回 false，回合不知情", async () => {
  const writer: FleetMemoryWriter = {
    async writeFact() {
      throw new Error("pages HTTP 503");
    },
  };
  const cap = createFleetMemoryCapture({ memory: writer, clock: () => 1 })!;
  assert.equal(await cap.capture("f", "m", "swap", "t", "b"), false);
  assert.equal(cap.failures, 1);
  assert.equal(cap.captured, 0);
});

test("createFleetMemoryCapture：无 memory → null", () => {
  assert.equal(createFleetMemoryCapture(), null);
  assert.equal(createFleetMemoryCapture({ memory: undefined }), null);
});

test("健康翻转追踪器：只报翻转（ok↔failed），同状态与首报都沉默", () => {
  const flip = createHealthFlipTracker();
  assert.equal(flip("f", "m", "ok"), false, "首报不翻");
  assert.equal(flip("f", "m", "ok"), false);
  assert.equal(flip("f", "m", "failed"), true, "ok→failed");
  assert.equal(flip("f", "m", "failed"), false);
  assert.equal(flip("f", "m", "ok"), true, "failed→ok（谁恢复了）");
  assert.equal(flip("f", "m2", "ok"), false, "成员键互相独立");
  assert.equal(flip("f2", "m", "ok"), false, "舰队键互相独立");
});

test("fleetProjectId / memberProjectId：净化、路径安全、缺省（paas 用例移植）", () => {
  assert.equal(fleetProjectId("dyn_abc-1"), "f/dyn_abc-1");
  assert.equal(fleetProjectId("a/b\\c"), "f/a-b-c");
  assert.equal(fleetProjectId("  "), "f/unknown");
  assert.equal(fleetProjectId(null), "f/unknown");
  assert.equal(memberProjectId("writer-a"), "writer-a");
  assert.equal(memberProjectId("a/b\\c"), "a-b-c");
  assert.equal(memberProjectId("  "), "unknown");
});

test("fleetMemoryFor：配置关 / 无 owner / 铸造失败 → null（降级开放）", async () => {
  const data = tmpData();
  try {
    assert.equal(await fleetMemoryFor({ CELL_MEMORY_ENABLED: "0" }, "o@x"), null);
    assert.equal(await fleetMemoryFor(baseEnv(data), ""), null);
    const broken = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await fleetMemoryFor(baseEnv(data), "owner@test.local", broken), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("writeFact 的 HTTP 落点：decision-resolved 页落 shared 分区并携带一等 metadata；turn 落成员分区", async () => {
  const data = tmpData();
  try {
    const posts: Array<any> = [];
    const minder = mintRoutesMinder({
      pagesPost: (body) => {
        posts.push(body);
        return { body: { project: body.project, path: "x" } };
      },
    });
    const fm = await fleetMemoryFor(baseEnv(data), "owner@test.local", minder.impl);
    assert.ok(fm, "客户端构建");
    await fm!.writeFact({ fleetId: "fleet-9", memberId: "writer-a", kind: "decision-resolved", partition: "shared", title: "采用方案 B", body: "理由……" });
    await fm!.writeFact({ fleetId: "fleet-9", memberId: "writer-a", kind: "turn", partition: "own", title: "报数", body: "完成 X" });
    assert.equal(posts.length, 2);
    const [shared, own] = posts;
    assert.equal(shared.project, "shared", "团队事实落该队共享分区");
    assert.deepEqual(shared.metadata, { fleetId: "fleet-9", memberId: "writer-a", kind: "decision-resolved" }, "{fleetId, memberId, kind} 一等 metadata");
    assert.equal(own.project, "writer-a", "岗位私有落成员分区（线上 project = memberId）");
    assert.deepEqual(own.metadata, { fleetId: "fleet-9", memberId: "writer-a", kind: "turn" });
    // 两个分区都走成员的 deployment 令牌（person 令牌会误归 u/ 根）
    const memberAuth = minder.calls.filter((c) => c.url.endsWith("/pages") && c.method === "POST").map((c) => c.headers?.authorization);
    assert.deepEqual(memberAuth, ["Bearer tok-d/fleet-9/writer-a", "Bearer tok-d/fleet-9/writer-a"]);
    const mintBodies = minder.calls.filter((c) => c.url.endsWith("/admin/mint")).map((c) => JSON.parse(c.body!));
    assert.deepEqual(mintBodies, [
      { namespace: "u/owner@test.local", label: "cell:owner@test.local" },
      { namespace: "d/fleet-9/writer-a", owner: "u/owner@test.local", label: "member:fleet-9:writer-a" },
    ]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("writeSharedPage：团队级直写落 shared；metadata 缺省不带字段", async () => {
  const data = tmpData();
  try {
    const posts: Array<any> = [];
    const minder = mintRoutesMinder({ pagesPost: (body) => { posts.push(body); return {}; } });
    const fm = await fleetMemoryFor(baseEnv(data), "owner@test.local", minder.impl)!;
    await fm!.writeSharedPage({ fleetId: "fleet-9", memberId: "writer-a", title: "换防", body: "A→B" });
    assert.equal(posts[0].project, "shared");
    assert.equal("metadata" in posts[0], false, "无 metadata 时不带字段");
    await fm!.writeSharedPage({ fleetId: "fleet-9", memberId: "writer-a", title: "换防2", body: "B→C", metadata: { swap: true } });
    assert.deepEqual(posts[1].metadata, { swap: true });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("三段合流：own/shared/legacy 金样 fleet-digest-block.txt 逐字节一致", async () => {
  const data = tmpData();
  try {
    const digests: Record<string, string> = {
      "writer-a": "岗位记忆：写手 OK",
      shared: "团队：采用方案 B",
      "f/fleet-9": "旧集群：部署完成",
    };
    const minder = mintRoutesMinder({ digest: (project) => ({ body: { digest: digests[project] ?? "" } }) });
    const fm = await fleetMemoryFor(baseEnv(data), "owner@test.local", minder.impl)!;
    const out = await fm!.readDigest("fleet-9", "writer-a", "本轮任务");
    assert.deepEqual(out!.sources, ["own", "shared", "legacy"]);
    assert.equal(out!.block, golden("fleet-digest-block.txt"), "三段标签与拼装逐字节同源");
    assert.equal(FLEET_SEGMENT_LABELS.own, "本岗位记忆");
    assert.equal(FLEET_SEGMENT_LABELS.shared, "团队记忆");
    assert.equal(FLEET_SEGMENT_LABELS.legacy, "历史团队记忆");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("三段合流：单段失败只丢那一段；空段消失；缺席返回 null", async () => {
  const data = tmpData();
  try {
    // shared 段 503
    const minder1 = mintRoutesMinder({
      digest: (project) => (project === "shared" ? { status: 503, body: {} } : { body: { digest: `块-${project}` } }),
    });
    const fm1 = await fleetMemoryFor(baseEnv(data), "owner@test.local", minder1.impl)!;
    const out1 = await fm1!.readDigest("fleet-9", "writer-a", "q");
    assert.deepEqual(out1!.sources, ["own", "legacy"]);
    assert.ok(out1!.block.includes("本岗位记忆"));
    assert.ok(!out1!.block.includes("【团队记忆】"), "shared 段缺席（【历史团队记忆】含同形子串，须带开括号）");
    assert.ok(out1!.block.includes("历史团队记忆"));
    // 全空 → null
    const minder2 = mintRoutesMinder({ digest: () => ({ body: { digest: "" } }) });
    const fm2 = await fleetMemoryFor(baseEnv(data), "owner@test.local", minder2.impl)!;
    assert.equal(await fm2!.readDigest("fleet-9", "writer-a", "q"), null, "全段缺席 = null，不是错误");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("三段合流：段预算 = max(64, floor(budget/3))；legacy q 回退 memberId；scope=shared 跳过自有探测", async () => {
  const data = tmpData();
  try {
    const digestUrls: Array<URL> = [];
    const minder = mintRoutesMinder({
      digest: (project) => {
        return { body: { digest: project === "f/fleet-9" ? "旧块" : "块" } };
      },
    });
    // 记录 URL：包一层
    const impl = async (input: string | URL, init?: any) => {
      if (String(input).includes("/digest")) digestUrls.push(new URL(String(input)));
      return minder.impl(input, init);
    };
    const fm = await fleetMemoryFor(baseEnv(data), "owner@test.local", impl)!;
    const out = await fm!.readDigest("fleet-9", "writer-a", "", { budget: 1200 });
    assert.deepEqual(out!.sources, ["own", "shared", "legacy"]);
    for (const u of digestUrls) {
      assert.equal(u.searchParams.get("budget"), "400", "segBudget = max(64, floor(1200/3))");
      assert.equal(u.searchParams.get("k"), "5");
    }
    const ownUrl = digestUrls.find((u) => u.searchParams.get("project") === "writer-a")!;
    assert.equal(ownUrl.searchParams.get("q") ?? "", "", "own/shared q = 原样（空 q 不携带参数）");
    const legacyUrl = digestUrls.find((u) => u.searchParams.get("project") === "f/fleet-9")!;
    assert.equal(legacyUrl.searchParams.get("q"), "writer-a", "legacy q 空时回退 memberId（成员坐标当查询词）");

    // scope 非 "own+shared"：不取成员令牌——成员令牌是 own/shared 两段的
    // 身份，两段一起缺席，只剩 legacy 段（与 paas 现役行为逐字对齐）
    const digestUrls2: Array<URL> = [];
    const minder2 = mintRoutesMinder({ digest: () => ({ body: { digest: "块" } }) });
    const impl2 = async (input: string | URL, init?: any) => {
      if (String(input).includes("/digest")) digestUrls2.push(new URL(String(input)));
      return minder2.impl(input, init);
    };
    const fm2 = await fleetMemoryFor(baseEnv(data), `scope-${Date.now()}@t.local`, impl2)!;
    const out2 = await fm2!.readDigest("fleet-9", "writer-a", "q", { scope: "shared" });
    assert.deepEqual(out2!.sources, ["legacy"], "无成员令牌 → d/ 两段全缺席，f/ 过渡段独存");
    const mints2 = minder2.calls.filter((c) => c.url.endsWith("/admin/mint")).length;
    assert.equal(mints2, 1, "只铸 person，成员令牌未动");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("成员令牌铸造失败：own/shared 两段都丢，legacy 独存（成员令牌就是身份）", async () => {
  const data = tmpData();
  try {
    const impl = async (input: string | URL, init?: any) => {
      const u = String(input);
      if (u.endsWith("/admin/mint")) {
        const ns = JSON.parse(init.body || "{}").namespace;
        if (String(ns).startsWith("d/")) return { ok: false, status: 403, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ token: "tok-u", id: "t" }) };
      }
      if (u.includes("/digest")) {
        const project = new URL(u).searchParams.get("project");
        if (project === "f/fleet-9") return { ok: true, status: 200, json: async () => ({ digest: "旧块" }) };
        return { ok: false, status: 404, json: async () => ({}) };
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    const fm = await fleetMemoryFor(baseEnv(data), `nobridge-${Date.now()}@t.local`, impl)!;
    const out = await fm!.readDigest("fleet-9", "writer-a", "q");
    assert.deepEqual(out!.sources, ["legacy"], "d/ 两段缺席，过渡窗的 f/ 仍渲染");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
