#!/usr/bin/env node
// Three-arm continuation eval (add-continuation-eval): does recalled memory
// actually help a fresh session continue — the v4 unlock gate. Arms per scene:
//   none   — task prompt as-is
//   titles — the EXACT production cluster-hook-① shape (title+date list)
//   digest — renderDigest over hybridCandidates (same retrieval as production
//            distiller candidates) + open handoffs notice
// One agent first-turn call per arm (pure LLM, no tool execution — by design
// the measured effect is "background present or absent"), one blind judge call
// per transcript (arms anonymously relabeled A/B/C per run).
//
// Gates (design D6, both must pass): re_derivation avg diff ≥0.5 AND paired
// win-rate ≥70%; first_step avg diff ≥0.5 AND win+tie rate ≥70%. n≥12 scenes.
//
// env: MEMORY_LLM_API_KEY / MEMORY_LLM_BASE_URL / MEMORY_LLM_MODEL   (lane)
//      EVAL_AGENT_MODEL / EVAL_JUDGE_MODEL (pins, default = MEMORY_LLM_MODEL)
//      DISTILLER_URL + DISTILLER_SHARED_TOKEN (embed lane; absent ⇒ digest
//      arm runs keyword-only and the record says so)
//      EVAL_TOP_K (5) / EVAL_BUDGET_TOKENS (1500) / EVAL_TOKEN_LIMIT (600000)
// usage: node scripts/eval-continue.mjs [--scenes <file>] [--only id,id]
//        [--calib N]  (calib: run first N scenes, print transcripts for the
//        human-vs-judge calibration pass; no verdict)

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../dist/store.js";
import { hybridCandidates } from "../dist/distill-scheduler.js";
import { renderDigest } from "../dist/digest.js";
import { validateScenes } from "../dist/continue-scenes.js";
import { newPage } from "../dist/okf.js";

const SCENES_DEFAULT = new URL("../fixtures/eval/continue-scenes.json", import.meta.url);
const BASELINE = new URL("../fixtures/eval/continue-baseline.json", import.meta.url);
const ARMS = ["none", "titles", "digest"];
const SYSTEM_BASE =
  "你是一台长期独立运行的工作 agent（壹座/萬星部署）。现在开启一个全新会话。用户给出本轮任务；请直接给出你的执行计划与第一步动作（可含要执行的命令/工具调用），除非任务本身要求，不要向用户询问可自行获得的背景。";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// -- lane helpers ------------------------------------------------------------
let spent = 0;
const TOKEN_LIMIT = Number(process.env.EVAL_TOKEN_LIMIT ?? 600_000);

async function chat(model, messages, { maxTokens = 1600, temperature = 0 } = {}) {
  if (spent >= TOKEN_LIMIT) throw new Error(`token limit reached (${spent}/${TOKEN_LIMIT}) — run aborted, partial state kept`);
  // transient lane failures (503/502/429) get 3 attempts with backoff — a
  // single blip must not kill a multi-minute run (production lane jitter is
  // on record, ledger §15.30)
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * 3 ** (attempt - 1))));
    try {
      const res = await fetch(`${process.env.MEMORY_LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MEMORY_LLM_API_KEY}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 4) { lastErr = new Error(`chat HTTP ${res.status}: ${body}`); continue; }
        throw new Error(`chat HTTP ${res.status}: ${body}`);
      }
      const doc = await res.json();
      const used = doc.usage?.total_tokens ?? 0;
      spent += used;
      return { text: doc.choices?.[0]?.message?.content ?? "", tokens: used };
    } catch (e) {
      // network-layer failures (fetch failed / ECONNRESET) retry like 5xx —
      // a lane blip must not kill a 45-scene run either
      lastErr = e;
      if (attempt >= 4) throw e;
    }
  }
  throw lastErr ?? new Error("chat failed");
}

async function embedTexts(texts) {
  const url = String(process.env.DISTILLER_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new Error("DISTILLER_URL absent");
  const res = await fetch(`${url}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DISTILLER_SHARED_TOKEN ?? ""}` },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const doc = await res.json();
  if (doc.errors?.length) throw new Error(doc.errors.join("; "));
  return { vectors: doc.vectors, model: doc.model, tokens: doc.tokens ?? 0 };
}

const embedLane = Boolean(process.env.DISTILLER_URL);
const avg = (a) => (a.length ? a.reduce((s2, x) => s2 + x, 0) / a.length : 0);
const embed = embedLane ? embedTexts : async () => { throw new Error("no embed lane"); };

// -- scene loading -----------------------------------------------------------
const scenesFile = arg("scenes") ?? SCENES_DEFAULT.pathname;
const scenes = JSON.parse(readFileSync(scenesFile, "utf8"));
const only = arg("only")?.split(",").map((s) => s.trim());
let selected = only ? scenes.filter((s) => only.includes(s.id)) : scenes;
const armFilter = arg("arm"); // e.g. "digest" — single-arm mode (grid runs): no pairing verdict
const v = validateScenes(selected);
if (!v.ok && !arg("calib")) {
  console.error("[eval-continue] scene gate REFUSED:\n" + v.errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
if (only) console.log(`[eval-continue] --only subset: entry gate skipped by explicit selection (${selected.length} scenes)`);

const calibN = Number(arg("calib") ?? 0);
if (calibN > 0) selected = selected.slice(0, calibN);

const runDir = join(tmpdir(), `fdm-eval-continue-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const agentModel = process.env.EVAL_AGENT_MODEL ?? process.env.MEMORY_LLM_MODEL;
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? process.env.MEMORY_LLM_MODEL;

// blind map: arms → A/B/C, shuffled once per run, stored in the run record
const labels = ["A", "B", "C"];
for (let i = labels.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [labels[i], labels[j]] = [labels[j], labels[i]];
}
const blindMap = Object.fromEntries(ARMS.map((a, i) => [a, labels[i]]));

// -- scratch loading ----------------------------------------------------------
function loadScene(scene, dataDir) {
  const root = new StoreRoot(dataDir, `d-eval-${scene.id}`);
  const project = "agentEval";
  for (const p of scene.history.pages) {
    root.writeDistillPage(project, p.kind, {
      id: p.id,
      engine: "engine:fixture/0",
      confidence: p.confidence ?? undefined,
      sources: [],
      supersedes: p.supersedes ?? [],
      ...(p.kind === "fact"
        ? { statement: p.task, subject: p.id, details: p.solution }
        : { task: p.task, search_keys: p.search_keys, solution: p.solution, boundary_envs: p.boundary_envs }),
    });
  }
  for (const h of scene.history.handoffs) {
    root.db.upsertHandoff({
      id: h.id, project, from_agent: "fixture", summary: h.summary,
      open_questions: "[]", next_steps: h.next_steps, files_touched: "[]",
      to_agent: h.to_agent ?? null, state: h.state, accepted_by: null, accepted_at: null, created_at: h.created_at,
    });
  }
  // L1 notes (add-chat-memory-injection): seeded exactly as the chat lane's
  // MCP write-back produces them — note pages under the project's notes/.
  for (const n of scene.history.notes ?? []) {
    root.writePage(project, "notes", n.id, newPage("note", n.title, n.body), { principal: "eval:fixture", scope: `d-eval-${scene.id}/${project}` });
  }
  return { root, project };
}

async function vectorize(root, project, scene) {
  const pages = scene.history.pages.filter((p) => p.task || p.solution);
  for (let i = 0; i < pages.length; i += 64) {
    const batch = pages.slice(i, i + 64);
    const texts = batch.map((p) => `${p.task} ${p.search_keys.join(" ")} ${p.solution}`.slice(0, 1500));
    const r = await embed(texts);
    batch.forEach((p, j) => {
      if (r.vectors[j]) root.db.setPageVector(`${project}/${p.kind === "fact" ? "facts" : "experiences"}/${p.id}.md`, r.model, new Float32Array(r.vectors[j]));
    });
  }
}

// -- injection blocks ----------------------------------------------------------
function titlesBlock(root, project) {
  // verbatim cluster hook-① shape (paas server/cron-runner.js): top-5 recent
  // pages as `- title（YYYY-MM-DD）`, appended to the task prompt.
  const pages = root.db.recentPages(5, [project]);
  if (!pages.length) return null;
  const block = pages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
  return `【集群共享记忆】本集群此前回合的沉淀，供参考：\n${block}`;
}

async function digestBlock(root, project, scene) {
  const k = Number(process.env.EVAL_TOP_K ?? 5);
  const candidates = await hybridCandidates({ root, project, queryFor: scene.task, k, embed, log: { warn: (m) => console.warn(`[eval-continue] ${m}`) } });
  const byId = new Map(scene.history.pages.map((p) => [p.id, p]));
  const items = candidates
    .map((c) => {
      const meta = byId.get(c.id);
      return {
        id: c.id, layer: "L2", kind: c.kind, title: c.task,
        // page bodies carry "## Task/## Solution" section headers — strip for
        // the excerpt (render stays pure; this is producer-side hygiene)
        excerpt: String(c.solution ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 400),
        confidence: meta?.confidence ?? null, updated_at: meta?.updated_at ?? null,
      };
    });
  // L1 notes appended after L2 — verbatim the production /digest face
  // (http.ts add-digest-note-recall): top-3 recent notes of the project,
  // headers stripped, 400-char excerpt. Notes ride recent-first, not query-
  // matched, faithful to the seam the chat lane reads.
  const NOTES_LIMIT = 3;
  const recentNotes = root.db.recentPages(20, [project]).filter((p) => p.type === "note").slice(0, NOTES_LIMIT);
  const noteItems = recentNotes.map((p) => {
    const page = root.readPageByRel(p.path);
    return {
      id: p.path, layer: "L1", kind: "note", title: p.title,
      excerpt: String(page?.body ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 400),
      confidence: null, updated_at: p.updated_at,
    };
  });
  const allItems = [...items, ...noteItems];
  const handoffs = scene.history.handoffs.filter((h) => h.state === "open")
    .map((h) => ({ id: h.id, summary: h.summary, to_agent: h.to_agent, created_at: h.created_at }));
  const block = renderDigest({ items: allItems, handoffs, budgetTokens: Number(process.env.EVAL_BUDGET_TOKENS ?? 1500), now: new Date().toISOString() });
  return { block, nItems: allItems.length };
}

// -- judge ----------------------------------------------------------------------
const JUDGE_SYSTEM = `你是评测裁判。给定：【任务】【期望背景集合】（该会话前史中已沉淀、agent 本可知道的事实）和【agent 首回合响应】。
只依据期望背景集合判定，不要用自己的猜测补充。输出严格 JSON（无多余文字）：
{"re_derivation": 1-5, "first_step": 1-5, "evidence": ["引用响应原文的依据…"]}
- re_derivation：5=零重推导，直接建立在背景之上；1=把期望背景当新问题从头重推或向用户索要已知背景。
- first_step：5=第一步动作与期望背景完全一致且可直接执行；1=首步方向与背景矛盾或空泛无效。`;

function parseJudge(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const rd = Math.min(5, Math.max(1, Number(j.re_derivation)));
    const fs = Math.min(5, Math.max(1, Number(j.first_step)));
    if (!Number.isFinite(rd) || !Number.isFinite(fs)) return null;
    return { re_derivation: rd, first_step: fs, evidence: Array.isArray(j.evidence) ? j.evidence : [] };
  } catch {
    return null;
  }
}

// -- main ------------------------------------------------------------------------
async function main() {
  if (!process.env.MEMORY_LLM_API_KEY) { console.error("MEMORY_LLM_API_KEY absent"); process.exit(1); }
  const data = mkdtempSync(join(tmpdir(), "fdm-eval-cont-"));
  const perScene = [];
  try {
    for (const scene of selected) {
      const { root, project } = loadScene(scene, data);
      if (embedLane) {
        try { await vectorize(root, project, scene); } catch (e) { console.warn(`[eval-continue] ${scene.id}: vectorize failed (${e.message}) — digest arm keyword-only`); }
      }
      const blocks = {};
      blocks.none = null;
      blocks.titles = titlesBlock(root, project);
      const d = await digestBlock(root, project, scene);
      blocks.digest = d.block;

      for (const arm of armFilter ? [armFilter] : ARMS) {
        const inject = blocks[arm];
        const system = inject ? `${SYSTEM_BASE}\n\n${inject}` : SYSTEM_BASE;
        // Reasoning lane: a tight budget burns out in reasoning with an EMPTY
        // content (31% of arms on run 3) — start higher and retry an empty
        // response once with an even larger budget before sampling it.
        let agent = await chat(agentModel, [
          { role: "system", content: system },
          { role: "user", content: scene.task },
        ], { maxTokens: 4000 });
        if (!agent.text.trim()) {
          agent = await chat(agentModel, [
            { role: "system", content: system },
            { role: "user", content: scene.task },
          ], { maxTokens: 8000 });
        }
        const judgeUser = (extra) => `${extra ? `${extra}\n\n` : ""}【任务】\n${scene.task}\n\n【期望背景集合】\n${scene.expected_background.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n\n【agent 首回合响应】\n${agent.text}`;
        let score = null;
        let lastJudgeText = "";
        let judgeTokens = 0;
        for (const nudge of ["", "上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要任何其他文字。", "再试一次：只输出形如 {\"re_derivation\":n,\"first_step\":n,\"evidence\":[\"…\"]} 的 JSON。"]) {
          const judged = await chat(judgeModel, [
            { role: "system", content: JUDGE_SYSTEM },
            { role: "user", content: judgeUser(nudge) },
          ], { maxTokens: 4000 });
          lastJudgeText = judged.text;
          judgeTokens += judged.tokens;
          score = parseJudge(judged.text);
          if (score) break;
        }
        if (!score) {
          writeFileSync(join(runDir, `${scene.id}.${blindMap[arm]}.JUDGE-FAIL.md`), `# ${scene.id} arm=${arm}\n\n## inject\n${inject ?? "(none)"}\n\n## response\n${agent.text}\n\n## raw judge\n${lastJudgeText}\n`);
          console.error(`[eval-continue] ${scene.id}/${arm}: judge unparseable after 3 attempts — aborting run (raw kept in run dir)`);
          process.exit(1);
        }
        writeFileSync(join(runDir, `${scene.id}.${blindMap[arm]}.md`), `# ${scene.id} arm=${arm} blind=${blindMap[arm]}\n\n## task\n${scene.task}\n\n## inject\n${inject ?? "(none)"}\n\n## response\n${agent.text}\n\n## judge\n${JSON.stringify(score, null, 2)}\n`);
        perScene.push({ scene: scene.id, arm, re_derivation: score.re_derivation, first_step: score.first_step, tokens: agent.tokens + judgeTokens, digest_items: arm === "digest" ? d.nItems : undefined });
        console.log(`[eval-continue] ${scene.id}/${arm}: re=${score.re_derivation} fs=${score.first_step} (${(agent.tokens + judgeTokens).toLocaleString()} tok)`);
      }
      root.db.close();
    }

    if (armFilter) {
      const avgRe = avg(perScene.map((r) => r.re_derivation));
      const avgFs = avg(perScene.map((r) => r.first_step));
      console.log(`\n[eval-continue] GRID (arm=${armFilter}, k=${process.env.EVAL_TOP_K ?? 5}, budget=${process.env.EVAL_BUDGET_TOKENS ?? 1500}): avg re=${avgRe.toFixed(2)} fs=${avgFs.toFixed(2)} over ${perScene.length} scenes | tokens ${spent.toLocaleString()}`);
      const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [];
      baseline.push({
        ran_at: new Date().toISOString(), scenes_version: `${selected.length} scenes`,
        agent_model: agentModel, judge_model: judgeModel,
        top_k: Number(process.env.EVAL_TOP_K ?? 5), budget_tokens: Number(process.env.EVAL_BUDGET_TOKENS ?? 1500),
        embed_lane: embedLane, arm_filter: armFilter, per_scene: perScene,
        verdict: "GRID", tokens: spent, run_dir_local: runDir,
      });
      writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
      return;
    }

    if (calibN > 0) {
      console.log(`\n[eval-continue] CALIBRATION MODE — transcripts + judge scores in ${runDir}`);
      console.log(`[eval-continue] blind map (local only): ${JSON.stringify(blindMap)}`);
      return;
    }

    // paired aggregation (design D6)
    const byScene = new Map();
    for (const r of perScene) {
      if (!byScene.has(r.scene)) byScene.set(r.scene, {});
      byScene.get(r.scene)[r.arm] = r;
    }
    const pairs = [...byScene.values()].filter((x) => x.none && x.digest);
    const diffsRe = pairs.map((x) => x.digest.re_derivation - x.none.re_derivation);
    const diffsFs = pairs.map((x) => x.digest.first_step - x.none.first_step);
    const wins = pairs.filter((x) => x.digest.re_derivation > x.none.re_derivation).length;
    const tiesRe = pairs.filter((x) => x.digest.re_derivation === x.none.re_derivation).length;
    const winsFs = pairs.filter((x) => x.digest.first_step > x.none.first_step).length;
    const tiesFs = pairs.filter((x) => x.digest.first_step === x.none.first_step).length;
    const n = pairs.length;
    const winRateRe = n ? wins / n : 0;
    const nonInferiorFs = n ? (winsFs + tiesFs) / n : 0;
    const titlesAvgRe = avg(perScene.filter((r) => r.arm === "titles").map((r) => r.re_derivation));
    const gate1 = avg(diffsRe) >= 0.5 && winRateRe >= 0.7;
    const gate2 = avg(diffsFs) >= 0.5 && nonInferiorFs >= 0.7;
    const verdict = n >= 12 ? (gate1 && gate2 ? "PASS" : "FAIL") : `INSUFFICIENT_N(${n})`;

    console.log(`\n[eval-continue] paired n=${n}`);
    console.log(`  re_derivation: avg diff ${avg(diffsRe).toFixed(2)} (gate ≥0.5), win ${wins}/${n} = ${(winRateRe * 100).toFixed(0)}% (gate ≥70%) -> ${gate1 ? "PASS" : "FAIL"}`);
    console.log(`  first_step:    avg diff ${avg(diffsFs).toFixed(2)} (gate ≥0.5), win+tie ${(winsFs + tiesFs)}/${n} = ${(nonInferiorFs * 100).toFixed(0)}% (gate ≥70%) -> ${gate2 ? "PASS" : "FAIL"}`);
    console.log(`  titles arm (reference, no gate): avg re_derivation ${titlesAvgRe.toFixed(2)}`);
    console.log(`[eval-continue] VERDICT: ${verdict} | tokens ${spent.toLocaleString()}/${TOKEN_LIMIT.toLocaleString()} | embed lane ${embedLane ? "on" : "OFF (keyword-only digest)"}`);

    const record = {
      ran_at: new Date().toISOString(),
      scenes_file: scenesFile, scenes_version: `${selected.length} scenes`,
      agent_model: agentModel, judge_model: judgeModel,
      top_k: Number(process.env.EVAL_TOP_K ?? 5), budget_tokens: Number(process.env.EVAL_BUDGET_TOKENS ?? 1500),
      embed_lane: embedLane,
      thresholds: { avg_diff_min: 0.5, win_rate_min: 0.7, noninferior_min: 0.7, min_n: 12 },
      per_scene: perScene.map(({ digest_items, ...r }) => ({ ...r, ...(digest_items != null ? { digest_items } : {}) })),
      verdict, tokens: spent,
      run_dir_local: runDir,
      blind_map_local_only: blindMap,
    };
    const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [];
    baseline.push(record);
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[eval-continue] baseline appended (${BASELINE.pathname}); transcripts (NOT committed) in ${runDir}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("[eval-continue] ERROR", e.message); process.exit(1); });
