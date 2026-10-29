// Tier promotion lane (add-tier-promotion-candidates): candidate selection in
// the DB layer — coverage of the L2 types, the tags non-gate, the tier gate,
// and the independent promotion_cursor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { newPage } from "../okf.js";

function makeRoot(): StoreRoot {
  return new StoreRoot(mkdtempSync(join(tmpdir(), "fdm-promo-root-")), "u-tester");
}

test("promotion candidates cover fact/experience/reference and ignore tags", () => {
  const root = makeRoot();
  // A fact WITH tags must still enter candidates — tags presence is not an
  // exclusion (that was the old lane's fatal gate).
  root.writePage("default", "facts", "f1", newPage("fact", "毛利率口径", "毛利率按扣除退货后口径", { tags: ["财务"], tier: "draft" }));
  root.writePage("default", "experience", "e1", newPage("experience", "对账复盘", "月末对账差异主要来自时区", { tier: "draft" }));
  root.writePage("default", "references", "r1", newPage("reference", "报价单模板", "正式报价单模板", { tags: ["报价"], tier: "draft" }));
  // notes are not promotion material (they ride other lanes)
  root.writePage("default", "notes", "n1", newPage("note", "随手记", "今天天气不错", { tier: "draft" }));

  const picks = root.db.promotionCandidates("default", "", 50);
  const types = picks.map((p) => p.type).sort();
  assert.deepEqual(types, ["experience", "fact", "reference"]);
  const f1 = picks.find((p) => String(p.path).endsWith("f1.md"));
  assert.ok(f1, "tagged fact must not be excluded for having tags");
});

test("promotion candidates exclude settled tiers (stable/canonical)", () => {
  const root = makeRoot();
  root.writePage("default", "facts", "f1", newPage("fact", "草稿口径", "内容甲", { tier: "draft" }));
  root.writePage("default", "experience", "e1", newPage("experience", "稳定经验", "内容乙", { tier: "stable" }));
  root.writePage("default", "references", "r1", newPage("reference", "权威模板", "内容丙", { tier: "canonical" }));

  const picks = root.db.promotionCandidates("default", "", 50);
  assert.equal(picks.length, 1);
  assert.match(picks[0].path, /f1\.md$/);
});

test("promotion cursor rides upsertDistillState and de-dupes picks", () => {
  const root = makeRoot();
  root.writePage("default", "facts", "f1", newPage("fact", "候选甲", "内容甲", { tier: "draft" }));
  const before = root.db.promotionCandidates("default", "", 50);
  assert.equal(before.length, 1);

  // advance the cursor past the only candidate, then patch an UNRELATED
  // cursor — promotion_cursor must survive the second write. This is the
  // exact trap that silently dropped tag_cursor in production (2026-10-28).
  root.db.upsertDistillState("default", { promotion_cursor: before[0].updated_at });
  root.db.upsertDistillState("default", { tag_cursor: "2005-01-01T00:00:00.000Z" });
  const st = root.db.getDistillState("default");
  assert.equal(st?.promotion_cursor, before[0].updated_at);
  assert.equal(st?.tag_cursor, "2005-01-01T00:00:00.000Z");

  // re-picking at the stored cursor returns nothing: no re-proposal forever
  const later = root.db.promotionCandidates("default", st?.promotion_cursor ?? "", 50);
  assert.equal(later.length, 0);
});

// ── §3 scheduler lane + §4 owner face ─────────────────────────────────────

import { StoreRoot as SR2 } from "../store.js";
import { DistillScheduler } from "../distill-scheduler.js";
import { TokenStore } from "../auth.js";
import { Service } from "../http.js";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { metricsSnapshot } from "../metrics.js";

function stubSidecar(promoResults: Array<{ idx: number; suggest_tier: string; reason?: string }>, calls: string[]) {
  return (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/promote")) {
      return { ok: true, status: 200, json: async () => ({ results: promoResults, tokens: 30, llm_calls: [], errors: [] }) } as unknown as Response;
    }
    if (u.endsWith("/tag") || u.endsWith("/embed")) {
      return { ok: true, status: 200, json: async () => ({ results: [], vectors: [], model: "m", tokens: 0, errors: [] }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ facts: [], experiences: [], cursor_next: {}, llm_calls: [], tokens: 0, errors: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("promotion lane: lands a proposal, NEVER touches the page tier; human slots are not proposed", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-promo-sched-"));
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const root = new SR2(join(data, "owners"), "u-tester");
  const roots = new Map([["u-tester", root]]);
  root.writePage("default", "facts", "f1", newPage("fact", "毛利率口径", "按扣除退货后口径", { tags: ["财务"] }));
  root.writePage("default", "facts", "f2", newPage("fact", "人工草稿", "人已看过", { tier: "draft", tier_origin: "human" }));
  const calls: string[] = [];
  const sched = new DistillScheduler({
    roots, openRoot: (k: string) => { const r = roots.get(k); if (!r) throw new Error("no root"); return r; },
    tokens, env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" } as unknown as NodeJS.ProcessEnv,
    fetchImpl: stubSidecar([{ idx: 0, suggest_tier: "stable", reason: "口径完整" }, { idx: 1, suggest_tier: "stable", reason: "也想建议人工位" }], calls),
    now: () => Date.now(),
  });
  await sched.distillNow("u-tester", "default");

  assert.equal(calls.filter((c) => c.endsWith("/promote")).length, 1);
  // The AI verdict did NOT flip any tier (spec: AI 提议不直接晋级) — the
  // frontmatter keeps its default-draft; the proposal table holds the verdict.
  assert.equal(String(root.readPageByRel("default/facts/f1.md")?.frontmatter?.tier ?? "draft"), "draft");
  assert.equal(String(root.readPageByRel("default/facts/f2.md")?.frontmatter?.tier ?? "draft"), "draft");
  // …it landed as a proposal instead — exactly one, the human slot skipped
  const props = root.db.pendingTierProposals("default", 50);
  assert.equal(props.length, 1, "human-origin page must not get a proposal");
  assert.match(props[0].page_rel, /f1\.md$/);
  assert.equal(props[0].proposed_tier, "stable");
  assert.equal(props[0].reason, "口径完整");

  // ignored within the cooldown → re-running the lane re-asks but re-proposes nothing (D4)
  root.db.ignoreTierProposal("default", props[0].page_rel, new Date().toISOString());
  root.db.upsertDistillState("default", { promotion_cursor: "" }); // force re-selection
  await sched.distillNow("u-tester", "default");
  assert.equal(root.db.pendingTierProposals("default", 50).length, 0);

  rmSync(data, { recursive: true, force: true });
});

test("promotion lane: FD_MEMORY_PROMOTION_ENABLED=0 means zero sidecar calls (rollback lever)", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-promo-off-"));
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const root = new SR2(join(data, "owners"), "u-tester");
  const roots = new Map([["u-tester", root]]);
  root.writePage("default", "facts", "f1", newPage("fact", "候选甲", "内容甲"));
  const calls: string[] = [];
  const sched = new DistillScheduler({
    roots, openRoot: (k: string) => roots.get(k)!,
    tokens, env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1", FD_MEMORY_PROMOTION_ENABLED: "0" } as unknown as NodeJS.ProcessEnv,
    fetchImpl: stubSidecar([{ idx: 0, suggest_tier: "stable", reason: "r" }], calls),
    now: () => Date.now(),
  });
  await sched.distillNow("u-tester", "default");
  assert.equal(calls.filter((c) => c.endsWith("/promote")).length, 0);
  rmSync(data, { recursive: true, force: true });
});

test("promotion face: read, accept flips tier with origin=human, ignore counts; metrics visible", async () => {
  const data = mkdtempSync(join(tmpdir(), "fdm-promo-face-"));
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const agent = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("d-promo");
    root.writePage("agentA", "facts", "f1", newPage("fact", "结算口径", "T+1 结算以回单为准", { tags: ["财务"] }));
    const rel = "agentA/facts/f1.md";
    root.db.upsertTierProposal("agentA", rel, { proposed_tier: "stable", reason: "口径稳定可复用", proposed_at: new Date().toISOString() });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${platform}` };

    // read face carries everything a human needs to judge (spec: 提议可读)
    const rd = await fetch(base + "/memory/promotions?rootKey=d-promo", { headers: H });
    assert.equal(rd.status, 200);
    const props = ((await rd.json()) as { proposals: Array<Record<string, string>> }).proposals;
    assert.equal(props.length, 1);
    assert.equal(props[0].current_tier, "draft");
    assert.equal(props[0].proposed_tier, "stable");
    assert.equal(props[0].reason, "口径稳定可复用");
    // agents never see the owner face
    assert.equal((await fetch(base + "/memory/promotions?rootKey=d-promo", { headers: { authorization: `Bearer ${agent}` } })).status, 403);

    // accept: tier flips, origin becomes human, page tier is only ever touched by this gesture
    const m0 = metricsSnapshot().promotion as Record<string, number>;
    const acc = await fetch(base + "/memory/promotions/accept", { method: "POST", headers: H, body: JSON.stringify({ rootKey: "d-promo", path: rel }) });
    assert.equal(acc.status, 200);
    const fm = root.readPageByRel(rel)?.frontmatter ?? {};
    assert.equal(fm.tier, "stable");
    assert.equal(fm.tier_origin, "human");
    assert.equal(((await metricsSnapshot().promotion as Record<string, number>).accepted ?? 0) - (m0.accepted ?? 0), 1);
    // double-accept is a 404 — the proposal left the face
    assert.equal((await fetch(base + "/memory/promotions/accept", { method: "POST", headers: H, body: JSON.stringify({ rootKey: "d-promo", path: rel }) })).status, 404);

    // ignore path: second proposal, ignored, counted, gone
    root.writePage("agentA", "facts", "f2", newPage("fact", "试用口径", "试行中", { tier: "draft" }));
    const rel2 = "agentA/facts/f2.md";
    root.db.upsertTierProposal("agentA", rel2, { proposed_tier: "stable", reason: "看着还行", proposed_at: new Date().toISOString() });
    const m1 = metricsSnapshot().promotion as Record<string, number>;
    const ig = await fetch(base + "/memory/promotions/ignore", { method: "POST", headers: H, body: JSON.stringify({ rootKey: "d-promo", path: rel2 }) });
    assert.equal(ig.status, 200);
    assert.equal(((await metricsSnapshot().promotion as Record<string, number>).ignored ?? 0) - (m1.ignored ?? 0), 1);
    assert.equal(((await (await fetch(base + "/memory/promotions?rootKey=d-promo", { headers: H })).json()) as { proposals: unknown[] }).proposals.length, 0);
    // the page was NOT touched by ignoring
    assert.equal(String(root.readPageByRel(rel2)?.frontmatter?.tier ?? ""), "draft");
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});
