// u-root distillation (add-u-root-distillation): person roots enter the
// scheduler through the family gate, note pages ride as observation-shaped
// items with their own cursor, and the deploy-level kill switch restores the
// byte-identical off state. Sidecar fully mocked — zero LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../auth.js";
import { StoreRoot } from "../store.js";
import { DistillScheduler } from "../distill-scheduler.js";
import { buildTools } from "../mcp.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-distill-u-"));
}

function fixture(data: string, sidecar: { impl: typeof fetch; calls: Array<Record<string, unknown>> }, env: Record<string, string>) {
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const roots = new Map<string, StoreRoot>();
  const openRoot = (key: string) => {
    let r = roots.get(key);
    if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
    return r;
  };
  const sched = new DistillScheduler({
    roots, openRoot, tokens, env,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      sidecar.calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return sidecar.impl(url as never, init as never);
    }) as unknown as typeof fetch,
    now: () => Date.now(),
  });
  return { sched, tokens, openRoot, roots };
}

const GATES = { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" };

function okSidecar(calls: Array<Record<string, unknown>>) {
  let n = 0;
  return {
    calls,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      n += 1;
      return { ok: true, status: 200, json: async () => ({
        facts: [],
        experiences: [{ id: `exp_note${n}`, engine: "engine:test/1", task: `报表口径 ${n}`, search_keys: ["周报"], solution: "表头中文、周五发 #ops、akshare 优先", sources: ["note:default/notes/n1.md"], supersedes: [] }],
        cursor_next: {}, llm_calls: [{ stage: "distill_extract", ok: true, prompt_tokens: 900, completion_tokens: 400 }], tokens: 1300, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
}

test("u-root: fallback scan discovers the project, notes ride as observation items, cursor advances without re-distill", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("u-alice@test");
    for (let i = 1; i <= 4; i++) {
      root.writePage("default", "notes", `n${i}`, {
        frontmatter: { type: "note", title: `偏好 ${i}`, generated: { by: "test", at: `2026-10-25T0${i}:00:00.000Z` } },
        body: `第 ${i} 条偏好正文`,
      } as never);
      await new Promise((r) => setTimeout(r, 5)); // index updated_at is write time — keep notes in distinct ms
    }
    await fx.sched.distillNow("u-alice@test", "default");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    // chunked contract (production-probe tuned): 2 items per engine call
    assert.equal(distillCalls().length, 2, "4 notes distill as 2-item chunks");
    const allNoteItems = distillCalls().flatMap((c) => ((c.body as { items: Array<{ tool?: string; summary: string }> }).items).filter((i) => i.tool === "memory_write_page"));
    assert.equal(allNoteItems.length, 4, "all four notes entered as observation-shaped items");
    assert.ok(allNoteItems[0].summary.startsWith("偏好 1："), "summary = title + body excerpt");
    // L2 landed + cursor advanced — the cursor lives on the pages-table view
    // (notesAfter), the same surface the distiller reads, so assert against
    // THAT view; the FTS index samples updated_at separately (1ms drift).
    const l2 = root.db.recentPages(50, ["default"]).filter((p) => p.type === "experience" || p.type === "fact");
    assert.equal(l2.length, 2, "one engine page per chunk");
    const noteRows = root.db.notesAfter("default", "", 120);
    const lastUpdatedAt = noteRows.map((r) => r.updated_at).sort().at(-1)!;
    const st = root.db.getDistillState("default")!;
    assert.equal(st.note_cursor, lastUpdatedAt);
    // write one more note; only the new one is submitted next time
    sidecar.calls.length = 0;
    root.writePage("default", "notes", "n5", {
      frontmatter: { type: "note", title: "偏好 5", generated: { by: "test", at: "2026-10-25T05:00:00.000Z" } },
      body: "第五条",
    } as never);
    await new Promise((r) => setTimeout(r, 5));
    await fx.sched.distillNow("u-alice@test", "default");
    assert.equal(distillCalls().length, 1, "one chunk call for the single new note");
    const req2 = distillCalls()[0]?.body as { items: Array<{ tool?: string; session_id: string }> };
    assert.equal(req2.items.filter((i) => i.tool === "memory_write_page").length, 1, "only the uncursored note re-enters");
    assert.ok(req2.items[0].session_id.includes("n5"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root kill switch: FD_MEMORY_DISTILL_U=0 → no scan, no calls (byte-identical off state); d- roots unaffected", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_U: "0" });
    const uRoot = fx.openRoot("u-bob@test");
    uRoot.writePage("default", "notes", "n1", {
      frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-25T00:00:00.000Z" } },
      body: "b",
    } as never);
    const dRoot = fx.openRoot("d-pkU");
    dRoot.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: "定位", tool: null, created_at: "2026-10-25T00:00:00.000Z", project: "agentA" });
    // fallback scan via drain (pending empty → scan drives)
    (fx.sched as unknown as { lastFallback: number }).lastFallback = 0;
    await fx.sched.drain();
    await new Promise((r) => setTimeout(r, 50));
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.ok(!distillCalls().some((c) => String((c.body as { scope?: string })?.scope ?? "").startsWith("u-")), "u-root never distilled under the kill switch");
    // d- root still flows: its pending entry (cursor lag or capture) may need a tick; force directly
    await fx.sched.distillNow("d-pkU", "agentA");
    assert.equal(distillCalls().length, 1, "d-root unaffected by the u switch");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: scan discovers projects from the pages index (no observations needed)", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("u-carol@test");
    root.writePage("prefs", "notes", "n1", {
      frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-25T00:00:00.000Z" } },
      body: "b",
    } as never);
    assert.deepEqual(root.db.distinctProjects(), ["prefs"]);
    await fx.sched.distillNow("u-carol@test", "prefs");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls().length, 1);
    assert.equal((distillCalls()[0].body as { scope: string }).scope, "u-carol@test/prefs");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// ── write-triggered distillation (add-write-triggered-distill) ───────────────
test("mcp write face: successful note/handoff writes notify the scheduler; failures don't", () => {
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "p");
    const minted = store.mint("person", "u/alice");
    const scope = store.verify(minted.token)!;
    const root = new StoreRoot(data, "u-alice");
    const calls: Array<[string, string]> = [];
    const tools = buildTools(scope, root, { allows: () => true }, (rk, p) => calls.push([rk, p]));
    const call = (name: string, args: Record<string, unknown> = {}) => {
      const out = tools.find((t) => t.name === name)!.handler(args) as { content: [{ text: string }]; isError?: boolean };
      return { isError: out.isError === true, body: JSON.parse(out.content[0].text) };
    };
    const n1 = call("memory_write_page", { title: "口径", body: "表头中文" });
    assert.equal(n1.isError, false);
    const h1 = call("memory_handoff_begin", { summary: "交接", next_steps: ["下一步"] });
    assert.equal(h1.isError, false);
    // a person's shared write is refused BEFORE any write — no notify
    const bad = call("memory_write_page", { title: "x", body: "y", target: "shared" });
    assert.equal(bad.isError, true);
    assert.deepEqual(calls, [["u-alice", "default"], ["u-alice", "default"]], "two successful writes notified, refused one not");
    root.db.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root debounce: write-triggered distill ready in 60s, d-root keeps the 5min session debounce", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    let t = 1_000_000;
    const fx = fixture(data, sidecar, { ...GATES });
    (fx.sched as unknown as { now: () => number }).now = () => t;
    const uRoot = fx.openRoot("u-alice@test");
    uRoot.writePage("default", "notes", "n1", { frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-25T00:00:00.000Z" } }, body: "b" } as never);
    fx.sched.notifyCapture("u-alice@test", "default", [{ event: "session-end" }]);
    assert.equal(fx.sched.pendingCount(), 1);
    t += 30_000; // 30s: still inside the u- 60s debounce window
    await fx.sched.drain();
    assert.equal(sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).length, 0, "not yet: 30s < 60s u-debounce");
    t += 35_000; // 65s: past the u- window, but before the next drain tick matters — drain directly
    await fx.sched.drain();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).length, 1, "distilled after the 60s u-debounce");
    // d-root: session capture still waits the full 5min
    const dRoot = fx.openRoot("d-pkD");
    dRoot.db.addObservation({ session_id: "s1", agent: "a", event: "stop", summary: "定位", tool: null, created_at: "2026-10-25T00:00:00.000Z", project: "agentA" });
    fx.sched.notifyCapture("d-pkD", "agentA", [{ event: "session-end" }]);
    t += 4 * 60_000; // 4min < 5min
    await fx.sched.drain();
    assert.equal(sidecar.calls.filter((c) => String(c.url).endsWith("/distill")).filter((c) => String((c.body as { scope?: string })?.scope ?? "").startsWith("d-pkD")).length, 0, "d-root still inside its 5min debounce");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("disk discovery: a root never touched since boot still distills (lazy-roots gap regression)", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const roots = new Map<string, StoreRoot>();
    const openRoot = (key: string) => {
      let r = roots.get(key);
      if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
      return r;
    };
    const sched = new DistillScheduler({
      roots, openRoot, tokens,
      env: { ...GATES },
      discoverRoots: () => ["u-fresh@test"], // disk has this owner dir; map is empty
      fetchImpl: (async (url: RequestInfo | URL) => {
        sidecar.calls.push({ url: String(url) });
        if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1]], model: "m", tokens: 1 }) };
        return { ok: true, status: 200, json: async () => ({ facts: [], experiences: [{ id: "exp_d1", engine: "e", task: "t", search_keys: [], solution: "s", sources: [], supersedes: [] }], cursor_next: {}, llm_calls: [], tokens: 100, errors: [] }) };
      }) as unknown as typeof fetch,
      now: () => Date.now(),
    });
    const root = openRoot("u-fresh@test");
    root.writePage("default", "notes", "n1", { frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-26T00:00:00.000Z" } }, body: "b" } as never);
    // drive the SCAN (the discovery surface), not distillNow — discovery lives in fallbackScan
    (sched as unknown as { lastFallback: number }).lastFallback = 0;
    await sched.drain();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sidecar.calls.some((c) => String(c.url).endsWith("/distill")), "discovered root distilled despite empty live map");
    root.db.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("patrol-echo dedup: a new L2 with the same 16-char title prefix supersedes the old page", async () => {
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("u-dedup@test");
    // existing L2 from a previous round
    root.writeDistillPage("default", "experience", { id: "exp_r1", engine: "e", confidence: 0.8, task: "按 mission-protocol 每回合执行任务巡检并分派", search_keys: ["巡检"], solution: "第一轮的巡检产出", sources: [], supersedes: [] });
    // a different page that must NOT be touched
    root.writeDistillPage("default", "experience", { id: "exp_other", engine: "e", confidence: 0.8, task: "完全不同的另一件事", search_keys: [], solution: "别动我", sources: [], supersedes: [] });
    let call = 0;
    const sched = new DistillScheduler({
      roots: fx.roots, openRoot: fx.openRoot, tokens: fx.tokens, env: { ...GATES },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1]], model: "m", tokens: 1 }) };
        call += 1;
        return { ok: true, status: 200, json: async () => ({ facts: [], experiences: [{ id: `exp_r${call + 1}`, engine: "e", task: "按 mission-protocol 每回合执行任务巡检并分派（第二轮）", search_keys: [], solution: `第 ${call + 1} 轮巡检产出`, sources: [], supersedes: [] }], cursor_next: {}, llm_calls: [], tokens: 900, errors: [] }) };
      }) as unknown as typeof fetch,
      now: () => Date.now(),
    });
    // a note triggers the distill; the engine returns the same-titled experience
    root.writePage("default", "notes", "n1", { frontmatter: { type: "note", title: "t", generated: { by: "test", at: "2026-10-26T00:00:00.000Z" } }, body: "又巡检了一遍" } as never);
    await sched.distillNow("u-dedup@test", "default");
    // optimize-yongyi-read-surfaces 3.3: every read face now hides a retired
    // page, so the raw page is read through the explicit history opt-in — the
    // default face must NOT list it.
    const liveRows = root.db.recentPages(50, ["default"]).filter((p) => p.type === "experience");
    assert.ok(!liveRows.some((r) => r.path.includes("exp_r1")), "the retired page is out of the default recency face");
    const rows = root.db.recentPages(50, ["default"], undefined, undefined, { includeSuperseded: true }).filter((p) => p.type === "experience");
    const r1 = rows.find((r) => r.path.includes("exp_r1"));
    const other = rows.find((r) => r.path.includes("exp_other"));
    const r2 = rows.find((r) => r.path.includes("exp_r2"));
    assert.ok(r2, "new page written");
    assert.deepEqual(JSON.parse(r2!.supersedes), ["exp_r1"], "the NEW page lists the same-prefix old page (supersede direction: new → old)");
    assert.equal(JSON.parse(r1!.supersedes).length, 0, "the old page's own list stays empty");
    assert.equal(JSON.parse(other!.supersedes).length, 0, "different page untouched");
    // read face: old page filtered, new+other remain
    const c = await (await import("../distill.js")).distillCandidates(root, ["default"], "巡检");
    assert.ok(!c.some((x) => x.id === "exp_r1"), "retired page out of the active candidate set");
    assert.ok(c.some((x) => x.id === "exp_r2"), "successor in the active set");
    const cAll = await (await import("../distill.js")).distillCandidates(root, ["default"], "另一件事");
    assert.ok(cAll.some((x) => x.id === "exp_other"), "unrelated page still reachable by its own terms");
    root.db.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: one engine call per request — a long backlog drains across runs (11-13 lane latency)", async () => {
  // Measured 2026-11-13 with a realistic extraction prompt: ONE call takes
  // 47-97 s on the 詞元 lane (474 chars in → 2.3-2.9k output tokens, and none of
  // the "disable thinking" spellings was honoured). The distiller's 150 s request
  // deadline therefore covers one call, not a run. A u-root with 42 notes needs
  // 21 sequential chunks (~17 min) and died at distill_deadline_exceeded every
  // time — observed in production the hour this landed. One call per request
  // makes each run finish; the cursor carries the rest to the next drain.
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_MAX_CALLS_PER_RUN: "1" });
    const root = fx.openRoot("u-calls@test");
    for (let i = 1; i <= 6; i++) {
      root.writePage("default", "notes", `c${i}`, {
        frontmatter: { type: "note", title: `队列 ${i}`, generated: { by: "test", at: `2026-10-25T0${i}:00:00.000Z` } },
        body: `第 ${i} 条`,
      } as never);
      await new Promise((r) => setTimeout(r, 5));
    }
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));

    await fx.sched.distillNow("u-calls@test", "default");
    assert.equal(distillCalls().length, 1, `one call per request (saw ${distillCalls().length}; 6 notes = 3 chunks of 2)`);
    const afterFirst = root.db.getDistillState("default")!.note_cursor;
    assert.ok(afterFirst, "the cursor keeps what landed, so nothing is stranded");

    await fx.sched.distillNow("u-calls@test", "default");
    assert.equal(distillCalls().length, 2, "the next run takes the next chunk");
    const afterSecond = root.db.getDistillState("default")!.note_cursor;
    assert.ok(afterSecond > afterFirst, "and advances again");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: the daily budget binds DURING the run, not once before it (7.3)", async () => {
  // Measured 2026-11-08: one owner spent 3,734,259 tokens against a 400,000
  // daily limit (9.3x) because the gate was read once per run and the spend
  // was written back only after the whole chunked loop finished — one long run
  // (or two concurrent projects both reading "0 used") sailed past the cap.
  // This test pins the new shape: each chunk re-reads the ledger, so the
  // overshoot is bounded by ONE call instead of the whole backlog.
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_DAILY_TOKENS: "2000" });
    const root = fx.openRoot("u-budget@test");
    for (let i = 1; i <= 6; i++) {
      root.writePage("default", "notes", `b${i}`, {
        frontmatter: { type: "note", title: `预算 ${i}`, generated: { by: "test", at: `2026-10-25T0${i}:00:00.000Z` } },
        body: `第 ${i} 条`,
      } as never);
      await new Promise((r) => setTimeout(r, 5));
    }
    await fx.sched.distillNow("u-budget@test", "default");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    // 6 notes = 3 chunks of 2; each call bills 1300 tokens against a 2000 cap.
    // Old shape: 3 calls / 3900 tokens. New shape: stop when the ledger crosses.
    assert.equal(distillCalls().length, 2, "the run stops once the ledger crosses the cap");
    const day = new Date().toISOString().slice(0, 10);
    const billed = fx.tokens.distillBudgetUsed("u-budget@test", day);
    assert.equal(billed.tokens, 2600, "spend is written per call, so the overshoot is one call");
    assert.ok(billed.tokens < 3900, "the remaining chunks never reached the engine");
    const st = root.db.getDistillState("default")!;
    assert.equal(st.last_error, "daily_budget_exhausted", "the gap is recorded, not swallowed");
    assert.ok((st.gaps ?? 0) >= 1);
    assert.ok(st.note_cursor, "the cursor keeps the work that did land");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: two projects of one owner never both pass the budget gate (7.3 concurrency)", async () => {
  // The double-pass: both projects read the same per-root ledger before either
  // has written to it, so both cleared a 400k cap. Per-owner serialization
  // means the second run sees the first one's spend.
  const data = tmpData();
  const sidecar = okSidecar([]);
  try {
    const fx = fixture(data, sidecar, { ...GATES, FD_MEMORY_DISTILL_DAILY_TOKENS: "1300" });
    const root = fx.openRoot("u-dual@test");
    for (const project of ["alpha", "beta"]) {
      for (let i = 1; i <= 4; i++) {
        root.writePage(project, "notes", `n${i}`, {
          frontmatter: { type: "note", title: `${project} 笔记 ${i}`, generated: { by: "test", at: `2026-10-25T0${i}:00:00.000Z` } },
          body: `正文 ${i}`,
        } as never);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    await Promise.all([fx.sched.distillNow("u-dual@test", "alpha"), fx.sched.distillNow("u-dual@test", "beta")]);
    const day = new Date().toISOString().slice(0, 10);
    const billed = fx.tokens.distillBudgetUsed("u-dual@test", day);
    // One run may overshoot by a single call (1300); two runs in parallel would
    // have reached 2600+ each crossing the cap at their own pace.
    // The cap is exactly ONE call. Unserialized, both projects read "0 used"
    // and both call (2 calls / 2600 billed). Serialized, exactly one runs.
    assert.equal(billed.tokens, 1300, `only one run may bill before the cap binds (billed ${billed.tokens})`);
    const distillCalls = sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls.length, 1, `only one project's chunk reached the engine (${distillCalls.length})`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: a truncated extract now holds the cursor and retries instead of silently dropping the batch (change 2.1/2.2)", async () => {
  // Step 1 made truncation visible; step 2 acts on it. This test REPLACES the
  // step-1 assertion "the cursor still advances" on purpose: that guard fired
  // the moment step 2 changed the contract, which is exactly what it was for.
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      // Every call is truncated, even when the batch is split down to one item.
      return { ok: true, status: 200, json: async () => ({
        facts: [],
        experiences: [{ id: `exp_${Math.random().toString(36).slice(2, 8)}`, engine: "engine:test/1", task: "触顶批次", search_keys: [], solution: "仍应落库", sources: [], supersedes: [] }],
        cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 18000, completion_tokens: 6000 }],
        tokens: 24000, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const metrics = await import("../metrics.js");
    metrics.__resetMetrics();
    const fx = fixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("u-hold@test");
    for (let i = 1; i <= 4; i++) {
      root.writePage("default", "notes", `n${i}`, {
        frontmatter: { type: "note", title: `触顶材料 ${i}`, generated: { by: "test", at: `2026-10-26T0${i}:00:00.000Z` } },
        body: "正文",
      } as never);
      await new Promise((r) => setTimeout(r, 5));
    }
    const before = root.db.notesAfter("default", "", 120).map((r) => r.path).sort();

    await fx.sched.distillNow("u-hold@test", "default");

    // Split: 4 notes = 2 chunks of 2; the first chunk truncates, gets split into
    // 1+1, both still truncate → the run stops and the cursor never moved.
    assert.equal(fx.tokens.distillBudgetRows("u-hold@test", 7)[0]?.truncated_runs, 1, "the run is booked as truncated");
    const st = root.db.getDistillState("default")!;
    assert.equal(st.note_cursor, "", "the cursor did not advance past a truncated batch");
    assert.equal(st.last_error, "extract_truncated");
    assert.ok((st.gaps ?? 0) >= 1);

    // The material is therefore still there for the next round.
    const after = root.db.notesAfter("default", "", 120).map((r) => r.path).sort();
    assert.deepEqual(after, before, "every note is still pending");

    // And the split was actually attempted: >1 engine call for one 2-item chunk.
    const distillCalls = sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.ok(distillCalls.length >= 3, `expected the chunk to be split and retried, saw ${distillCalls.length} call(s)`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: a clean run still advances the cursor and books no gap (change 2.3)", async () => {
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [], cursor_next: {},
        // Well under the ceiling: the model simply found nothing.
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 18000, completion_tokens: 900 }],
        tokens: 19000, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = fixture(data, sidecar, { ...GATES });
    const root = fx.openRoot("u-clean@test");
    root.writePage("default", "notes", "n1", {
      frontmatter: { type: "note", title: "普通材料", generated: { by: "test", at: "2026-10-26T00:00:00.000Z" } },
      body: "正文",
    } as never);
    await new Promise((r) => setTimeout(r, 5));
    await fx.sched.distillNow("u-clean@test", "default");
    const st = root.db.getDistillState("default")!;
    assert.ok(st.note_cursor, "a clean run advances the cursor");
    assert.equal(st.last_error ?? null, null, "no error recorded");
    assert.equal(st.gaps ?? 0, 0, "no gap recorded");
    assert.equal(fx.tokens.distillBudgetRows("u-clean@test", 7)[0]?.truncated_runs, 0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("u-root: a batch that never stops truncating is stepped over after the gap limit, and says so (change 2.4)", async () => {
  const data = tmpData();
  const sidecar = {
    calls: [] as Array<Record<string, unknown>>,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      return { ok: true, status: 200, json: async () => ({
        facts: [], experiences: [], cursor_next: {},
        llm_calls: [{ stage: "coding_extract", ok: true, prompt_tokens: 18000, completion_tokens: 6000 }],
        tokens: 24000, errors: [],
      }) };
    }) as unknown as typeof fetch,
  };
  try {
    const fx = fixture(data, sidecar, { ...GATES, FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS: "2" });
    const root = fx.openRoot("u-giveup@test");
    root.writePage("default", "notes", "n1", {
      frontmatter: { type: "note", title: "永不收敛", generated: { by: "test", at: "2026-10-26T00:00:00.000Z" } },
      body: "正文",
    } as never);
    await new Promise((r) => setTimeout(r, 5));

    for (let round = 0; round < 2; round++) {
      root.db.upsertDistillState("default", { next_attempt_at: 0 });
      await fx.sched.distillNow("u-giveup@test", "default");
    }
    const st = root.db.getDistillState("default")!;
    assert.equal(st.last_error, "extract_truncated_skipped", "the step-over leaves its own error code");
    assert.equal(st.note_cursor, "", "the cursor still does not jump by itself — it is the gap count that bounds the retries");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
