#!/usr/bin/env node
// LLM-tier distiller eval (add-memory-distiller task 5.2): replays the S1
// dedup/language scenes through the REAL sidecar (engine + 词元 lane) against
// a scratch fd-memory root driven by the real scheduler. Prints baseline
// numbers; exits non-zero on the two hard gates (multi-agent dedup, task
// language). Skipped when MEMORY_LLM_* is absent — CI's zero-LLM tier is
// src/test/distill.test.ts.
//
// usage: DISTILLER_URL=http://127.0.0.1:8100 [DISTILLER_SHARED_TOKEN=...] \
//        node scripts/eval-distill.mjs
// sidecar: cd distiller && DISTILLER_PORT=8100 MEMORY_LLM_MODEL=... \
//          MEMORY_LLM_API_KEY=... MEMORY_LLM_BASE_URL=... python app.py

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../dist/auth.js";
import { StoreRoot } from "../dist/store.js";
import { DistillScheduler } from "../dist/distill-scheduler.js";

const sidecarUrl = (process.env.DISTILLER_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
const scenes = JSON.parse(readFileSync(new URL("../fixtures/eval/distill-scenes.json", import.meta.url), "utf8"));

async function main() {
  const health = await fetch(`${sidecarUrl}/healthz`).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.log("[eval-distill] SKIP: sidecar not reachable at", sidecarUrl);
    process.exit(0);
  }
  console.log(`[eval-distill] sidecar ${health.engine}`);

  const data = mkdtempSync(join(tmpdir(), "fdm-eval-distill-"));
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const roots = new Map();
    const openRoot = (key) => {
      let r = roots.get(key);
      if (!r) { r = new StoreRoot(data, key); roots.set(key, r); }
      return r;
    };
    const calls = [];
    const sched = new DistillScheduler({
      roots, openRoot, tokens,
      env: { FD_MEMORY_DISTILLER_URL: sidecarUrl, FD_MEMORY_DISTILL_ENABLED: "1", DISTILLER_SHARED_TOKEN: process.env.DISTILLER_SHARED_TOKEN ?? "" },
      fetchImpl: (async (url, init) => { calls.push(String(url)); return fetch(url, init); }),
    });
    const root = openRoot("d-evalpack");
    const CJK = /[\u4e00-\u9fff]/;

    const distillScene = async (scene) => {
      for (const s of scene.sessions) {
        for (const e of s.events) {
          root.db.addObservation({ session_id: s.session_id, agent: "eval", event: e.event, summary: e.summary, tool: e.tool ?? null, created_at: new Date().toISOString(), project: "agentEval" });
        }
      }
      root.db.upsertDistillState("agentEval", { next_attempt_at: 0 }); // eval: no cross-scene backoff
      await sched.distillNow("d-evalpack", "agentEval");
    };

    const pagesAfter = {};
    for (const scene of scenes) {
      await distillScene(scene);
      pagesAfter[scene.id] = root.db.recentPages(100, ["agentEval"]).filter((p) => p.type === "experience").length;
      if (!scene.dedup_of && !scene.no_output_gate && pagesAfter[scene.id] === 0) {
        console.log(`[eval-distill] FAIL: scene ${scene.id} produced 0 experiences (call failure must surface, never read as empty)`);
        hardFails++;
      }
    }

    const pages = root.db.recentPages(100, ["agentEval"]).filter((p) => p.type === "experience");
    const bodies = pages.map((p) => `${p.title}\n${readFileSync(join(root.wikiDir, p.path), "utf8")}`);

    // keyword recall per scene
    let hardFails = 0;
    for (const scene of scenes) {
      for (const kw of scene.expect_keywords) {
        const hit = bodies.some((b) => b.includes(kw));
        console.log(`[eval-distill] scene ${scene.id} keyword "${kw}": ${hit ? "HIT" : "MISS"}`);
      }
    }
    // v2.1 fact gates: same-subject sessions merge into supersede chains
    const factPages = root.db.recentPages(100, ["agentEval"]).filter((p) => p.type === "fact");
    const supersedingFacts = factPages.filter((p) => JSON.parse(p.supersedes ?? "[]").length > 0);
    console.log(`[eval-distill] facts=${factPages.length} superseding=${supersedingFacts.length}`);
    if (scenes.some((x) => x.fact_merge) && supersedingFacts.length === 0) {
      console.log("[eval-distill] FAIL: fact merge — same-subject sessions produced no supersede chain");
      hardFails++;
    }

    // dedup gate: s11 must supersede, not duplicate — count experience pages
    // whose supersedes points at an s10-era id, and total pages for the same topic
    const superseding = pages.filter((p) => JSON.parse(p.supersedes ?? "[]").length > 0);
    const dupAdds = bodies.filter((b) => b.includes("100 tag") || b.includes("100/100")).length;
    console.log(`[eval-distill] experiences=${pages.length} superseding=${superseding.length} quota-topic-pages=${dupAdds}`);
    if (scenes.some((s) => s.dedup_of) && superseding.length === 0 && dupAdds > 1) {
      console.log("[eval-distill] FAIL: dedup — s11 duplicated instead of superseding");
      hardFails++;
    } else if (superseding.length > 0) {
      console.log("[eval-distill] dedup: PASS (supersede recorded)");
    }
    // language gate: tasks of a CJK corpus must be CJK
    const nonCjkTasks = pages.filter((p) => !CJK.test(p.title)).map((p) => p.title);
    console.log(`[eval-distill] task language: ${pages.length - nonCjkTasks.length}/${pages.length} CJK`);
    if (nonCjkTasks.length > 0) {
      console.log("[eval-distill] FAIL: non-CJK tasks:", JSON.stringify(nonCjkTasks));
      hardFails++;
    }
    const budget = tokens.distillBudgetUsed("d-evalpack", new Date().toISOString().slice(0, 10));
    console.log(`[eval-distill] tokens=${budget.tokens.toLocaleString()} llm_calls=${budget.llm_calls} sidecar_calls=${calls.length}`);
    console.log(`[eval-distill] verdict: ${hardFails === 0 ? "PASS" : `FAIL (${hardFails})`}`);
    process.exitCode = hardFails === 0 ? 0 : 1;
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("[eval-distill] ERROR", e); process.exit(1); });
