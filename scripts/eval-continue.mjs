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
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Build before importing (optimize-yongyi-read-surfaces 5.5). The eval measures
// ../dist/*, so a stale build silently reports numbers for code that is no
// longer in src/ — the worst kind of green. Building here makes "what we
// measured" and "what is in the tree" the same thing; EVAL_SKIP_BUILD=1 opts
// out deliberately.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
if (process.env.EVAL_SKIP_BUILD !== "1") {
  try {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    console.error("[eval-continue] build failed — refusing to measure a stale artifact (set EVAL_SKIP_BUILD=1 to measure the existing dist deliberately)");
    process.exit(1);
  }
}
const { StoreRoot } = await import("../dist/store.js");
const { hybridCandidates } = await import("../dist/distill-scheduler.js");
const { renderDigest } = await import("../dist/digest.js");
const { validateScenes, validateMergeCoverage } = await import("../dist/continue-scenes.js");
const { buildDigestBlock, buildMergeArms } = await import("../dist/eval-digest-arm.js");
const { estimateTokens } = await import("../dist/digest.js");
const { seedSceneHistory } = await import("../dist/eval-fixtures.js");
const { computeGates } = await import("../dist/continue-gate.js");
const SCENES_DEFAULT = new URL("../fixtures/eval/continue-scenes.json", import.meta.url);
const BASELINE = new URL("../fixtures/eval/continue-baseline.json", import.meta.url);
const ARMS = ["none", "titles", "digest"];
// Merge comparison arms (add-digest-merge-eval-arm 2.2/2.3): own+shared in one
// request vs two single-partition reads. They carry their own verdict and never
// enter computeGates, which pairs (none, digest) only — see design D1.
const MERGE_ARMS = ["digest-merged", "digest-split"];
const MERGE_BUDGET_DEFAULT = 800; // production SDK budgets segBudget*2 = 800
const SYSTEM_BASE =
  "你是一台长期独立运行的工作 agent（自部署）。现在开启一个全新会话。用户给出本轮任务；请直接给出你的执行计划与第一步动作（可含要执行的命令/工具调用），除非任务本身要求，不要向用户询问可自行获得的背景。";

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
  // single blip must not kill a multi-minute run (production lanes jitter;
  // keep the retry budget generous)
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
const prepDistillOn = Boolean(process.env.EVAL_PREP_DISTILL); // old-note depth ablation (add-u-root-distillation)
// Merge mode (add-digest-merge-eval-arm 2.3/3.x): run ONLY the two comparison
// arms on the merge scene set. It is a separate experiment with its own verdict,
// so it must not touch the three-arm gate — neither its scene gate nor its
// scoring.
const mergeMode = process.argv.includes("--merge") || Boolean(process.env.EVAL_MERGE_ARMS);
const mergeBudget = Number(process.env.EVAL_MERGE_BUDGET ?? MERGE_BUDGET_DEFAULT);
const mergeArmsSeen = [];
const sceneGate = mergeMode ? validateMergeCoverage(selected) : validateScenes(selected);
if (!sceneGate.ok && !arg("calib")) {
  console.error(`[eval-continue] scene gate REFUSED (${mergeMode ? "merge coverage" : "three-arm entry"}):\n` + sceneGate.errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
if (only) console.log(`[eval-continue] --only subset: entry gate skipped by explicit selection (${selected.length} scenes)`);

const calibN = Number(arg("calib") ?? 0);
if (calibN > 0) selected = selected.slice(0, calibN);

const runDir = join(tmpdir(), `fdm-eval-continue-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const agentModel = process.env.EVAL_AGENT_MODEL ?? process.env.MEMORY_LLM_MODEL;
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? process.env.MEMORY_LLM_MODEL;

// blind map: active arms → one letter each, shuffled once per run, stored in the
// run record. Labels are generated per run so a judge cannot learn "A is the
// good one" across runs. Five arms (merge mode) ⇒ five letters.
const activeArms = mergeMode ? MERGE_ARMS : ARMS;
const labels = activeArms.map((_, i) => String.fromCharCode(65 + i));
for (let i = labels.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [labels[i], labels[j]] = [labels[j], labels[i]];
}
const blindMap = Object.fromEntries(activeArms.map((a, i) => [a, labels[i]]));

// -- scratch loading ----------------------------------------------------------
function loadScene(scene, dataDir) {
  const root = new StoreRoot(dataDir, `d-eval-${scene.id}`);
  // Seeding lives in src/eval-fixtures.ts so the two-partition fixture shape is
  // unit-testable without an LLM call (add-digest-merge-eval-arm 1.2).
  const { project, sharedProject } = seedSceneHistory(root, scene);
  return { root, project, sharedProject };
}

async function vectorize(root, project, scene) {
  // Both partitions, same embed lane: a shared partition left un-vectorized
  // would only be reachable by keyword recall, and the merged arm would then
  // lose to the split arm for a reason that has nothing to do with merging.
  const sharedProject = "shared";
  const groups = [
    { project, pages: scene.history.pages.filter((p) => p.task || p.solution) },
    { project: sharedProject, pages: (scene.history.sharedPages ?? []).filter((p) => p.task || p.solution) },
  ];
  for (const g of groups) {
    for (let i = 0; i < g.pages.length; i += 64) {
      const batch = g.pages.slice(i, i + 64);
      const texts = batch.map((p) => `${p.task} ${p.search_keys.join(" ")} ${p.solution}`.slice(0, 1500));
      const r = await embed(texts);
      batch.forEach((p, j) => {
        if (r.vectors[j]) root.db.setPageVector(`${g.project}/${p.kind === "fact" ? "facts" : "experiences"}/${p.id}.md`, r.model, new Float32Array(r.vectors[j]));
      });
    }
  }
}

// -- injection blocks ----------------------------------------------------------
function titlesBlock(root, project) {
  // verbatim cluster hook-① shape (platform cron runner): top-5 recent
  // pages as `- title（YYYY-MM-DD）`, appended to the task prompt.
  const pages = root.db.recentPages(5, [project]);
  if (!pages.length) return null;
  const block = pages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
  return `【集群共享记忆】本集群此前回合的沉淀，供参考：\n${block}`;
}

async function digestBlock(root, project, scene, nowIso) {
  // Delegates to src/eval-digest-arm.ts (add-digest-merge-eval-arm 2.1): the
  // three-arm digest block and the merge arms must come from ONE implementation,
  // or "same retrieval, same budget" is a claim rather than a property.
  const r = await buildDigestBlock(root, scene, project, {
    budget: Number(process.env.EVAL_BUDGET_TOKENS ?? 1500),
    k: Number(process.env.EVAL_TOP_K ?? 5),
    embed,
    now: nowIso,
    ...(process.env.EVAL_NO_HANDOFFS ? { noHandoffs: true } : {}),
  });
  return { block: r.block, nItems: r.nItems };
}

// -- judge ----------------------------------------------------------------------
const JUDGE_SYSTEM = `你是评测裁判。给定：【任务】【期望背景集合】（该会话前史中已沉淀、agent 本可知道的事实）和【agent 首回合响应】。
只依据期望背景集合判定，不要用自己的猜测补充。注意：agent 处于规划模式（无工具执行环境），响应中的工具调用序列表示其第一步行动计划——按计划是否建立在背景之上评分，不要因为响应包含探索性步骤而扣分，也不要期望响应直接产出最终结果。输出严格 JSON（无多余文字）：
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

// -- old-note depth ablation (add-u-root-distillation 3.1) ---------------------
// For scenes whose background sits in notes beyond the L1 top-3, run the REAL
// distill path — the same sidecar contract distillOne speaks (items built
// exactly like the scheduler's, engine candidates from hybridCandidates) —
// over the seeded root, then render the digest arm again. The delta against
// the plain digest arm measures what distillation unlocks.
async function prepDistill(root, project, scene) {
  const url = String(process.env.DISTILLER_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new Error("EVAL_PREP_DISTILL set but DISTILLER_URL absent");
  const items = [
    ...(scene.history.notes ?? []).map((n) => ({
      kind: "observation", session_id: `note:${n.id}`, at: n.updated_at, event: "user-prompt-submit", tool: "memory_write_page",
      summary: `${n.title}：${String(n.body ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 400)}`,
      agent: "user",
    })),
    ...(scene.history.handoffs ?? []).filter((h) => h.state === "open").map((h) => ({ kind: "handoff", session_id: h.id, at: h.created_at, summary: `${h.summary}｜next: ${h.next_steps}`, agent: "fixture" })),
  ];
  if (!items.length) return 0;
  // Mirror the production chunked contract (§15.37 probe): the engine
  // truncates its extraction output at the completion ceiling on large/long
  // batches and returns a silent EMPTY result. 2 items × 800-char summaries.
  const CHUNK = 2, CAP = 800;
  const cap = (x) => String(x ?? "").replace(/\s+/g, " ").slice(0, CAP);
  const audit = { principal: "eval:prep-distill", scope: `eval/${project}` };
  const newRels = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK).map((it) => ({ ...it, summary: cap(it.summary) }));
    const candidates = await hybridCandidates({ root, project, queryFor: batch.map((b) => b.summary).join(" ").slice(0, 1200), k: 8, embed, log: { warn: () => {} } });
    const res = await fetch(`${url}/distill`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DISTILLER_SHARED_TOKEN ?? ""}` },
      body: JSON.stringify({ scope: `eval/${project}`, cursor: { obs: 0, handoff: "" }, items: batch, candidates }),
    });
    if (!res.ok) throw new Error(`distill HTTP ${res.status}`);
    const result = await res.json();
    if (result.errors?.length) throw new Error(`engine errors: ${result.errors.slice(0, 3).join("; ")}`);
    const norm = (e, kind) => ({
      id: String(e.id ?? `${kind}_${Math.random().toString(36).slice(2, 8)}`),
      engine: String(e.engine ?? "engine:unknown"),
      confidence: e.confidence != null ? Number(e.confidence) : undefined,
      sources: Array.isArray(e.sources) ? e.sources : [],
      supersedes: Array.isArray(e.supersedes) ? e.supersedes : [],
      ...(kind === "fact"
        ? { statement: e.statement != null ? String(e.statement) : undefined, subject: e.subject != null ? String(e.subject) : undefined, details: e.details != null ? String(e.details) : undefined }
        : { task: e.task != null ? String(e.task) : undefined, search_keys: Array.isArray(e.search_keys) ? e.search_keys : undefined, solution: e.solution != null ? String(e.solution) : undefined, boundary_envs: e.boundary_envs != null ? String(e.boundary_envs) : undefined }),
    });
    for (const f of result.facts ?? []) newRels.push(root.writeDistillPage(project, "fact", norm(f, "fact"), audit));
    for (const x of result.experiences ?? []) newRels.push(root.writeDistillPage(project, "experience", norm(x, "experience"), audit));
  }

  if (embedLane && newRels.length) {
    const texts = [], rels = [];
    for (const rel of newRels) {
      const page = root.readPageByRel(rel);
      if (!page) continue;
      texts.push(`${page.frontmatter?.title ?? ""} ${page.body}`.slice(0, 1500));
      rels.push(rel);
    }
    if (texts.length) {
      const r = await embedTexts(texts);
      rels.forEach((rel, j) => { if (r.vectors[j]) root.db.setPageVector(rel, r.model, new Float32Array(r.vectors[j])); });
    }
  }
  return newRels.length;
}

// -- main ------------------------------------------------------------------------
async function main() {
  if (!process.env.MEMORY_LLM_API_KEY) { console.error("MEMORY_LLM_API_KEY absent"); process.exit(1); }
  const data = mkdtempSync(join(tmpdir(), "fdm-eval-cont-"));
  const perScene = [];
  try {
    for (const scene of selected) {
      const { root, project, sharedProject } = loadScene(scene, data);
      // One frozen `now` per scene: two arms rendered at different wall-clock
      // instants would differ in the recency gate and the header date.
      const sceneNow = new Date().toISOString();
      if (embedLane) {
        try { await vectorize(root, project, scene); } catch (e) { console.warn(`[eval-continue] ${scene.id}: vectorize failed (${e.message}) — digest arm keyword-only`); }
      }
      const blocks = {};
      blocks.none = null;
      blocks.titles = titlesBlock(root, project);
      const d = await digestBlock(root, project, scene, sceneNow);
      blocks.digest = d.block;
      // Merge comparison (add-digest-merge-eval-arm 2.2): both arms read the
      // SAME partitions with the SAME total budget; only segmentation differs.
      // Built only in merge mode — the three-arm gate must not pay for them.
      if (mergeMode) {
        const arms = await buildMergeArms(root, scene, project, {
          embed,
          now: sceneNow,
          totalBudget: mergeBudget,
          sharedProject,
          ...(process.env.EVAL_NO_HANDOFFS ? { noHandoffs: true } : {}),
        });
        blocks["digest-merged"] = arms.merged.block;
        blocks["digest-split"] = arms.split.block;
        mergeArmsSeen.push({ scene: scene.id, mergedTokens: estimateTokens(arms.merged.block), splitTokens: arms.split.block ? estimateTokens(arms.split.block) : 0, totalBudget: arms.totalBudget });
      }

      for (const arm of armFilter ? [armFilter] : activeArms) {
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

      // old-note depth arm (add-u-root-distillation 3.1): plain-digest already
      // sampled above; re-sample after the real distill path prepared the root
      const noteDepth = (scene.history.notes?.length ?? 0) > 3;
      if (prepDistillOn && noteDepth && !armFilter) {
        const wrote = await prepDistill(root, project, scene);
        const dd = await digestBlock(root, project, scene, sceneNow);
        const arm = "digest+distill";
        const inject = dd.block;
        let agent = await chat(agentModel, [
          { role: "system", content: `${SYSTEM_BASE}\n\n${inject}` },
          { role: "user", content: scene.task },
        ], { maxTokens: 4000 });
        if (!agent.text.trim()) {
          agent = await chat(agentModel, [
            { role: "system", content: `${SYSTEM_BASE}\n\n${inject}` },
            { role: "user", content: scene.task },
          ], { maxTokens: 8000 });
        }
        const judgeUser = (extra) => `${extra ? `${extra}\n\n` : ""}【任务】\n${scene.task}\n\n【期望背景集合】\n${scene.expected_background.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n\n【agent 首回合响应】\n${agent.text}`;
        let score = null, lastJudgeText = "", judgeTokens = 0;
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
          writeFileSync(join(runDir, `${scene.id}.distill.JUDGE-FAIL.md`), `# ${scene.id} arm=${arm}\n\n## inject\n${inject}\n\n## response\n${agent.text}\n\n## raw judge\n${lastJudgeText}\n`);
          console.error(`[eval-continue] ${scene.id}/${arm}: judge unparseable — aborting`);
          process.exit(1);
        }
        writeFileSync(join(runDir, `${scene.id}.distill.md`), `# ${scene.id} arm=${arm} (distilled ${wrote} pages)\n\n## task\n${scene.task}\n\n## inject\n${inject}\n\n## response\n${agent.text}\n\n## judge\n${JSON.stringify(score, null, 2)}\n`);
        perScene.push({ scene: scene.id, arm, re_derivation: score.re_derivation, first_step: score.first_step, tokens: agent.tokens + judgeTokens, distilled_pages: wrote });
        console.log(`[eval-continue] ${scene.id}/${arm}: re=${score.re_derivation} fs=${score.first_step} (+${wrote} L2) (${(agent.tokens + judgeTokens).toLocaleString()} tok)`);
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
    // Gate arithmetic lives in src/continue-gate.ts so it is unit-testable
    // without spending a model budget (5.1).
    // Only the three pinned arms reach the gate (add-digest-merge-eval-arm 2.3):
    // computeGates pairs (none, digest), so a digest-* row would be ignored
    // anyway — filtering here keeps that explicit instead of relying on it.
    const G = computeGates(
      perScene
        .filter((r) => ARMS.includes(r.arm))
        .map((r) => ({ scene: r.scene, arm: r.arm, re_derivation: r.re_derivation, first_step: r.first_step }))
    );
    const { n, headroom, nonInferior, firstStep, noteDepth: nd, gates: g, verdict } = G;
    const titlesAvgRe = avg(perScene.filter((r) => r.arm === "titles").map((r) => r.re_derivation));

        console.log(`\n[eval-continue] paired n=${n}`);
    console.log(`  re_derivation: avg diff ${G.avgDiffRe.toFixed(2)} (gate ≥0.5)`);
    console.log(`  win (full set, legacy caliber): ${G.full.wins}/${G.full.n} = ${(G.full.rate * 100).toFixed(0)}%`);
    console.log(`  win (headroom-calibrated, none≤3): ${headroom.wins}/${headroom.n}${headroom.rate === null ? " (no headroom scenes — gate cannot pass)" : ` = ${(headroom.rate * 100).toFixed(0)}% (gate ≥70%)`} -> ${g.reDerivation ? "PASS" : "FAIL"}`);
    console.log(`  non-inferior (digest ≥ none−1, full set): ${nonInferior.count}/${nonInferior.n} = ${(nonInferior.rate * 100).toFixed(0)}% (gate ≥70%) -> ${g.nonInferior ? "PASS" : "FAIL"}`);
    console.log(`  first_step:    avg diff ${firstStep.avgDiff.toFixed(2)} (gate ≥0.5), win+tie ${firstStep.wins + firstStep.ties}/${firstStep.n} = ${(firstStep.rate * 100).toFixed(0)}% (gate ≥70%) -> ${g.firstStep ? "PASS" : "FAIL"}`);
    console.log(nd.status === "not_run"
      ? `  note-depth: NOT RUN — ${nd.reason}. This gate does NOT count toward the verdict.`
      : `  note-depth: distilled vs plain over ${nd.scenes} deep scene(s) with headroom${nd.ceilinged ? ` (${nd.ceilinged} at ceiling, excluded)` : ""}: avg re delta ${(nd.avgDelta ?? 0).toFixed(2)} (gate ≥1.0) -> ${nd.status === "pass" ? "PASS" : "FAIL"}`);
    console.log(`  titles arm (reference, no gate): avg re_derivation ${titlesAvgRe.toFixed(2)}`);
    console.log(`[eval-continue] VERDICT: ${verdict} | tokens ${spent.toLocaleString()}/${TOKEN_LIMIT.toLocaleString()} | embed lane ${embedLane ? "on" : "OFF (keyword-only digest)"}`);

    const record = {
      ran_at: new Date().toISOString(),
      code_version: codeVersion,
      scenes_sha: scenesSha,
      replay: `node scripts/eval-continue.mjs --scenes ${scenesFile}` + (arg("only") ? ` --only ${arg("only")}` : ""),
      scenes_file: scenesFile, scenes_version: `${selected.length} scenes`,
      agent_model: agentModel, judge_model: judgeModel,
      top_k: Number(process.env.EVAL_TOP_K ?? 5), budget_tokens: Number(process.env.EVAL_BUDGET_TOKENS ?? 1500),
      embed_lane: embedLane,
      thresholds: { avg_diff_min: 0.5, win_rate_min: 0.7, noninferior_min: 0.7, min_n: 12 },
      // Both calibers ride the baseline (spec: 两套口径数字均入 continue-baseline).
      win_rates: {
        full_set: G.full,
        headroom: G.headroom,
        non_inferior_full: G.nonInferior,
        first_step_win_tie: { count: firstStep.wins + firstStep.ties, n: firstStep.n, rate: firstStep.rate },
      },
      gates: { re_derivation: g.reDerivation, non_inferior: g.nonInferior, first_step: g.firstStep, note_depth: nd.status },
      note_depth: { scenes: nd.scenes, avg_re_delta: nd.avgDelta, ceilinged: nd.ceilinged, gate: nd.status, reason: nd.reason },
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
