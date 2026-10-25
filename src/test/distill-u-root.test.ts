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
  return {
    calls,
    impl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({
        facts: [],
        experiences: [{ id: "exp_note1", engine: "engine:test/1", task: "报表口径", search_keys: ["周报"], solution: "表头中文、周五发 #ops、akshare 优先", sources: ["note:default/notes/n1.md"], supersedes: [] }],
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
    }
    await fx.sched.distillNow("u-alice@test", "default");
    const distillCalls = () => sidecar.calls.filter((c) => String(c.url).endsWith("/distill"));
    assert.equal(distillCalls().length, 1, "u-root distilled via fallback path");
    const req = distillCalls()[0].body as { items: Array<{ kind: string; tool?: string; summary: string; session_id: string }>; scope: string };
    assert.equal(req.scope, "u-alice@test/default");
    const noteItems = req.items.filter((i) => i.tool === "memory_write_page");
    assert.equal(noteItems.length, 4, "all four notes entered as observation-shaped items");
    assert.ok(noteItems[0].summary.startsWith("偏好 1："), "summary = title + body excerpt");
    // L2 landed + cursor advanced (index updated_at = write time, not
    // frontmatter; the cursor must equal the last note's indexed updated_at)
    const l2 = root.db.recentPages(50, ["default"]).filter((p) => p.type === "experience" || p.type === "fact");
    assert.equal(l2.length, 1);
    const noteRows = root.db.recentPages(50, ["default"]).filter((p) => p.type === "note");
    const lastUpdatedAt = noteRows.map((r) => r.updated_at).sort().at(-1)!;
    const st = root.db.getDistillState("default")!;
    assert.equal(st.note_cursor, lastUpdatedAt);
    // write one more note; only the new one is submitted next time
    sidecar.calls.length = 0;
    root.writePage("default", "notes", "n5", {
      frontmatter: { type: "note", title: "偏好 5", generated: { by: "test", at: "2026-10-25T05:00:00.000Z" } },
      body: "第五条",
    } as never);
    await fx.sched.distillNow("u-alice@test", "default");
    const req2 = distillCalls()[0]?.body as { items: Array<{ tool?: string; session_id: string }> };
    assert.equal(distillCalls().length, 1);
    assert.equal(req2.items.filter((i) => i.tool === "memory_write_page").length, 1, "only the uncursored note re-enters");
    assert.equal(req2.items[0].session_id.endsWith("n5.md") || req2.items[0].session_id.includes("n5"), true);
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
