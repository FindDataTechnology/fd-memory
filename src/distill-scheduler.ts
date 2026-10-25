// Distill scheduler (add-memory-distiller, design D4): fd-memory is single-
// instance, so the scheduler lives in-process. Capture batches ending with a
// session boundary mark the project pending (debounced 5min so consecutive
// sessions merge); a fallback pass every 10min picks up projects whose cursor
// fell ≥200 observations behind. One project is never distilled concurrently
// with itself; across projects ≤2 sidecar calls are in flight. Failures keep
// the cursor (no progress = no loss) and back off exponentially up to 1h.
//
// Two gates, both required: FD_MEMORY_DISTILLER_URL (empty = scheduler inert,
// the rollback lever) and FD_MEMORY_DISTILL_ENABLED=1.

import { StoreRoot } from "./store.js";
import { TokenStore } from "./auth.js";
import { distillCandidates, DistillCandidate } from "./distill.js";
import { HandoffRow, ObservationRow } from "./db.js";

export interface DistillItem {
  kind: "observation" | "handoff";
  session_id: string;
  at: string;
  event?: string;
  tool?: string | null;
  summary: string;
  agent?: string;
}

export interface DistillSchedulerOptions {
  openRoot: (rootKey: string) => StoreRoot;
  roots: Map<string, StoreRoot>;
  tokens: TokenStore;
  log?: { warn: (msg: string) => void; log: (msg: string) => void };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEBOUNCE_MS = 5 * 60_000;
const FALLBACK_INTERVAL_MS = 10 * 60_000;
const DRAIN_TICK_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const FALLBACK_CURSOR_LAG = 200;
// Day-1 production finding: fallback backfill of FROZEN projects (pre-
// agentId-coordinate archives whose pages the current member cannot even
// read) burned the daily budget before live projects caught up. Fallback now
// only runs while comfortable budget headroom remains — session-triggered
// (active) projects keep their claim on the limit up to the hard stop.
const FALLBACK_BUDGET_RESERVE = 100_000;
const MAX_ITEMS = 120; // ~40k-token worst-case prompt (production day-1: 220 obs ≈ 74k tokens was too coarse)
const SIDECCAR_TIMEOUT_MS = 180_000;

// Root-family gate (add-u-root-distillation D1): pack roots always distill;
// person roots distill unless the deployment opts out. FD_MEMORY_DISTILL_U=0
// is the kill switch — no pending marks, no fallback scan, byte-identical to
// the pre-enablement behavior.
function isDistillableRoot(rootKey: string, env: NodeJS.ProcessEnv | undefined): boolean {
  if (rootKey.startsWith("d-")) return true;
  if (rootKey.startsWith("u-")) return env?.FD_MEMORY_DISTILL_U !== "0";
  return false;
}

export class DistillScheduler {
  private pending = new Map<string, { rootKey: string; project: string; since: number }>();
  private inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private lastFallback = 0;
  private readonly log: { warn: (msg: string) => void; log: (msg: string) => void };
  private readonly now: () => number;

  constructor(private opts: DistillSchedulerOptions) {
    this.log = opts.log ?? console;
    this.now = opts.now ?? (() => Date.now());
  }

  private url(): string {
    return String(this.opts.env?.FD_MEMORY_DISTILLER_URL ?? "").replace(/\/+$/, "");
  }

  private enabled(): boolean {
    return Boolean(this.url()) && this.opts.env?.FD_MEMORY_DISTILL_ENABLED === "1";
  }

  private dailyLimit(): number {
    return Number(this.opts.env?.FD_MEMORY_DISTILL_DAILY_TOKENS ?? 400_000);
  }

  static key(rootKey: string, project: string): string {
    return `${rootKey}::${project}`;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  // Capture hook: a batch ending on a session boundary marks the project
  // pending. Projects are d/-member or shared projects only (design D1).
  notifyCapture(rootKey: string, project: string, events: Array<{ event?: string }>): void {
    if (!this.enabled()) return;
    if (!isDistillableRoot(rootKey, this.opts.env)) return;
    const boundary = events.some((e) => e?.event === "session-end" || e?.event === "stop");
    if (!boundary) return;
    const key = DistillScheduler.key(rootKey, project);
    if (!this.pending.has(key)) this.pending.set(key, { rootKey, project, since: this.now() });
  }

  start(): void {
    if (this.timer || !this.enabled()) return;
    this.timer = setInterval(() => void this.drain(), DRAIN_TICK_MS);
    this.timer.unref?.();
    this.log.log("[distill] scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain(): Promise<void> {
    if (!this.enabled()) return;
    this.fallbackScan();
    const due = [...this.pending.values()].filter(
      (p) => !this.inflight.has(DistillScheduler.key(p.rootKey, p.project)) && this.now() - p.since >= DEBOUNCE_MS,
    );
    const batch = due.slice(0, 2); // cross-project concurrency ≤2
    await Promise.allSettled(batch.map((p) => this.distillOne(p.rootKey, p.project)));
  }

  // v2.2 candidate selection: vector cosine top-8 first (query embedded via
  // the sidecar /embed), keyword path as fallback + gap-filler; results merge
  // deduped, vector hits first. Embed failure or empty root = pure keyword.
  // (add-continuation-eval: the body now lives in the exported
  // hybridCandidates below — the eval's digest arm recalls through the exact
  // same code path so its conclusions extrapolate to production.)
  private async selectCandidates(root: StoreRoot, project: string, queryFor: string) {
    return hybridCandidates({ root, project, queryFor, k: 8, embed: (t) => this.embedTexts(t), log: this.log });
  }

  private async embedTexts(texts: string[]): Promise<{ vectors: number[][]; model: string; tokens: number }> {
    return sidecarEmbed(this.opts.env ?? process.env, texts, this.opts.fetchImpl ?? fetch, this.url());
  }

  // Force a project through now (tests); respects inflight + backoff.
  async distillNow(rootKey: string, project: string): Promise<void> {
    const key = DistillScheduler.key(rootKey, project);
    if (this.inflight.has(key)) return;
    await this.distillOne(rootKey, project);
  }

  private fallbackScan(): void {
    if (this.now() - this.lastFallback < FALLBACK_INTERVAL_MS) return;
    this.lastFallback = this.now();
    for (const [rootKey, root] of this.opts.roots) {
      if (!isDistillableRoot(rootKey, this.opts.env)) continue;
      const day = new Date().toISOString().slice(0, 10);
      const remaining = this.dailyLimit() - this.opts.tokens.distillBudgetUsed(rootKey, day).tokens;
      if (remaining < FALLBACK_BUDGET_RESERVE) continue; // active projects first
      const projects = new Set<string>();
      // Pack roots discover work via capture observations; person roots
      // (add-u-root-distillation D3) have none — the pages index is their
      // project discovery surface.
      for (const row of root.db.recentObservations(2000) as unknown as Array<{ project: string }>) projects.add(row.project);
      if (rootKey.startsWith("u-")) for (const p of root.db.distinctProjects()) projects.add(p);
      for (const project of projects) {
        const state = root.db.getDistillState(project);
        if (rootKey.startsWith("u-")) {
          // Person roots have no observation stream — the cursor-lag gate below
          // (maxObservationRowid - obs_cursor) is always 0 for them. Queue on
          // note/handoff lag instead: any uncursored note or handoff qualifies.
          const noteLag = root.db.notesAfter(project, state?.note_cursor ?? "", 1).length > 0;
          let handoffLag = false;
          try {
            handoffLag = !!root.db
              .db.prepare("SELECT id FROM handoffs WHERE project=? AND created_at>? LIMIT 1")
              .get(project, state?.handoff_cursor ?? "");
          } catch { /* best-effort */ }
          if (noteLag || handoffLag) {
            const key = DistillScheduler.key(rootKey, project);
            if (!this.pending.has(key)) this.pending.set(key, { rootKey, project, since: 0 });
          }
          continue;
        }
        const lag = root.db.maxObservationRowid(project) - (state?.obs_cursor ?? 0);
        if (lag >= FALLBACK_CURSOR_LAG) {
          const key = DistillScheduler.key(rootKey, project);
          if (!this.pending.has(key)) this.pending.set(key, { rootKey, project, since: 0 });
        }
      }
    }
  }

  private async distillOne(rootKey: string, project: string): Promise<void> {
    const key = DistillScheduler.key(rootKey, project);
    this.pending.delete(key);
    this.inflight.add(key);
    try {
      const root = this.opts.openRoot(rootKey);
      const state = root.db.getDistillState(project);
      if (state && state.next_attempt_at > this.now()) return;
      const obs = root.db.observationsAfter(project, state?.obs_cursor ?? 0, MAX_ITEMS) as unknown as (ObservationRow & { rid: number })[];
      let handoffs: HandoffRow[] = [];
      try {
        handoffs = root.db
          .db.prepare("SELECT * FROM handoffs WHERE project=? AND created_at>? ORDER BY created_at LIMIT ?")
          .all(project, state?.handoff_cursor ?? "", MAX_ITEMS) as unknown as HandoffRow[];
      } catch { /* handoff cursor best-effort */ }
      // Person-root raw material (add-u-root-distillation D2): note pages are
      // what chat MCP writes actually produce; observations never exist there.
      // Synthesized as observation-shaped items — a note IS a captured event
      // of the user asking to remember — so the sidecar contract is untouched.
      let notes: Array<{ path: string; title: string; body: string; updated_at: string }> = [];
      try {
        notes = root.db.notesAfter(project, state?.note_cursor ?? "", MAX_ITEMS);
      } catch { /* note cursor best-effort (pre-migration dbs) */ }
      if (obs.length === 0 && handoffs.length === 0 && notes.length === 0) return;

      // budget guardrail (per root = per owner at v1; see auth.ts)
      const day = new Date().toISOString().slice(0, 10);
      const used = this.opts.tokens.distillBudgetUsed(rootKey, day);
      if (used.tokens >= this.dailyLimit()) {
        root.db.upsertDistillState(project, { last_error: "daily_budget_exhausted", gaps: (state?.gaps ?? 0) + 1, next_attempt_at: tomorrowMs(this.now()) });
        this.log.warn(`[distill] ${key}: daily budget exhausted (${used.tokens}/${this.dailyLimit()}) — gap recorded, cursor kept`);
        return;
      }

      const audit = { principal: "distiller:scheduler", scope: `${rootKey}/${project}` };

      if (rootKey.startsWith("u-")) {
        // Person-root chunked distillation (add-u-root-distillation D2, tuned
        // by production probe 2026-10-25): the engine's extraction output
        // truncates at its completion ceiling on large/long batches and the
        // truncated JSON is swallowed into an EMPTY result (no error, 0 pages)
        // — 4 real patrol handoffs → completion_tokens 6000 → silent zero. 2
        // items per call with 800-char summaries stay under the ceiling (4.4k
        // completion). Handoffs and notes are chunked per-stream so cursors
        // advance cleanly; the daily budget is billed once for the whole run.
        const CHUNK = 2;
        const CAP = 800;
        const cap = (s: string) => String(s ?? "").replace(/\s+/g, " ").slice(0, CAP);
        let spentTotal = 0;
        const callEngine = async (items: DistillItem[]) => {
          const candidates = await this.selectCandidates(root, project, items.map((i) => i.summary).join(" ").slice(0, 1200));
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SIDECCAR_TIMEOUT_MS);
          let res: Response;
          try {
            res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/distill`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
              body: JSON.stringify({ scope: `${rootKey}/${project}`, cursor: { obs: state?.obs_cursor ?? 0, handoff: state?.handoff_cursor ?? "" }, items, candidates }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
          const result = (await res.json()) as {
            facts: Array<Record<string, unknown>>;
            experiences: Array<Record<string, unknown>>;
            llm_calls: Array<unknown>;
            tokens: number;
            errors: string[];
          };
          if (result.errors?.length) throw new Error(`engine errors: ${result.errors.slice(0, 3).join("; ")}`);
          for (const fact of result.facts ?? []) {
            const rel = root.writeDistillPage(project, "fact", normalizeEntry(fact, "fact"), audit);
            writeEntryVector(root, rel, fact);
          }
          for (const exp of result.experiences ?? []) {
            const rel = root.writeDistillPage(project, "experience", normalizeEntry(exp, "experience"), audit);
            writeEntryVector(root, rel, exp);
          }
          spentTotal += result.tokens ?? 0;
          return (result.facts?.length ?? 0) + (result.experiences?.length ?? 0);
        };
        let wrote = 0;
        for (let i = 0; i < handoffs.length; i += CHUNK) {
          const batch = handoffs.slice(i, i + CHUNK);
          wrote += await callEngine(batch.map((h) => ({ kind: "handoff" as const, session_id: h.id, at: h.created_at, summary: `${cap(h.summary)}｜next: ${cap(h.next_steps)}`, agent: h.from_agent })));
          root.db.upsertDistillState(project, { handoff_cursor: batch[batch.length - 1].created_at, last_tokens: spentTotal });
        }
        for (let i = 0; i < notes.length; i += CHUNK) {
          const batch = notes.slice(i, i + CHUNK);
          wrote += await callEngine(batch.map((n) => ({ kind: "observation" as const, session_id: n.path, at: n.updated_at, event: "note-write", tool: "memory_write_page", summary: `${cap(n.title)}：${cap(n.body)}`, agent: "user" })));
          root.db.upsertDistillState(project, { note_cursor: batch[batch.length - 1].updated_at, last_tokens: spentTotal });
        }
        this.opts.tokens.distillBudgetAdd(rootKey, day, spentTotal, wrote);
        this.log.log(`[distill] ${key}: ${wrote} pages from ${handoffs.length} handoffs + ${notes.length} notes (chunked), ${(spentTotal).toLocaleString()} tokens`);
        return;
      }

      const items: DistillItem[] = [
        ...obs.map((o) => ({ kind: "observation" as const, session_id: o.session_id, at: o.created_at, event: o.event, tool: o.tool, summary: o.summary, agent: o.agent })),
        ...handoffs.map((h) => ({ kind: "handoff" as const, session_id: h.id, at: h.created_at, summary: `${h.summary}｜next: ${h.next_steps}` , agent: h.from_agent })),
        ...notes.map((n) => ({
          kind: "observation" as const, session_id: n.path, at: n.updated_at, event: "note-write", tool: "memory_write_page",
          summary: `${n.title}：${String(n.body ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 400)}`,
          agent: "user",
        })),
      ].sort((a, b) => (a.at < b.at ? -1 : 1));

      const queryFor = obs.slice(-40).map((o) => o.summary).join(" ");
      const candidates = await this.selectCandidates(root, project, queryFor);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIDECCAR_TIMEOUT_MS);
      let res: Response;
      try {
        res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/distill`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
          body: JSON.stringify({ scope: `${rootKey}/${project}`, cursor: { obs: state?.obs_cursor ?? 0, handoff: state?.handoff_cursor ?? "" }, items, candidates }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
      const result = (await res.json()) as {
        facts: Array<Record<string, unknown>>;
        experiences: Array<Record<string, unknown>>;
        cursor_next: { obs: number; handoff: string };
        llm_calls: Array<unknown>;
        tokens: number;
        errors: string[];
      };
      if (result.errors?.length) throw new Error(`engine errors: ${result.errors.slice(0, 3).join("; ")}`);

      for (const fact of result.facts ?? []) {
        const rel = root.writeDistillPage(project, "fact", normalizeEntry(fact, "fact"), audit);
        writeEntryVector(root, rel, fact);
      }
      for (const exp of result.experiences ?? []) {
        const rel = root.writeDistillPage(project, "experience", normalizeEntry(exp, "experience"), audit);
        writeEntryVector(root, rel, exp);
      }
      const maxRid = obs.length ? Math.max(...obs.map((o) => o.rid)) : (state?.obs_cursor ?? 0);
      const maxHandoff = handoffs.length ? handoffs[handoffs.length - 1].created_at : (state?.handoff_cursor ?? "");
      // note cursor is scheduler-local (the engine knows nothing of notes):
      // last note's updated_at, monotonic like handoff_cursor
      const maxNote = notes.length ? notes[notes.length - 1].updated_at : (state?.note_cursor ?? "");
      root.db.upsertDistillState(project, {
        obs_cursor: Math.max(state?.obs_cursor ?? 0, result.cursor_next?.obs ?? maxRid),
        handoff_cursor: (result.cursor_next?.handoff ?? maxHandoff) > (state?.handoff_cursor ?? "") ? String(result.cursor_next?.handoff ?? maxHandoff) : maxHandoff,
        note_cursor: maxNote > (state?.note_cursor ?? "") ? maxNote : (state?.note_cursor ?? ""),
        last_error: null,
        last_tokens: result.tokens ?? 0,
        next_attempt_at: 0,
      });
      this.opts.tokens.distillBudgetAdd(rootKey, day, result.tokens ?? 0, result.llm_calls?.length ?? 0);
      this.log.log(`[distill] ${key}: ${result.facts?.length ?? 0} facts, ${result.experiences?.length ?? 0} experiences, ${(result.tokens ?? 0).toLocaleString()} tokens`);
    } catch (e) {
      const root = this.opts.roots.get(rootKey) ?? this.opts.openRoot(rootKey);
      const state = root.db.getDistillState(project);
      const prev = state?.next_attempt_at && state.next_attempt_at > this.now() ? state.next_attempt_at - this.now() : 30_000;
      const backoff = Math.min(MAX_BACKOFF_MS, Math.max(30_000, prev * 2));
      root.db.upsertDistillState(project, { last_error: String((e as Error)?.message ?? e).slice(0, 300), next_attempt_at: this.now() + backoff });
      this.log.warn(`[distill] ${key} failed (cursor kept, backoff ${Math.round(backoff / 1000)}s): ${(e as Error)?.message ?? e}`);
    } finally {
      this.inflight.delete(key);
    }
  }
}

// Standalone sidecar /embed call (extracted from the scheduler by
// add-cluster-digest-injection — the /digest platform-seam face shares the
// exact same wire): POST texts, 30s abort, structured failure.
export async function sidecarEmbed(
  env: NodeJS.ProcessEnv | undefined,
  texts: string[],
  fetchImpl: typeof fetch = fetch,
  urlOverride?: string,
): Promise<{ vectors: number[][]; model: string; tokens: number }> {
  const url = String(urlOverride ?? env?.FD_MEMORY_DISTILLER_URL ?? "").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetchImpl(`${url}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env?.DISTILLER_SHARED_TOKEN ?? ""}` },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const doc = (await res.json()) as { vectors: number[][]; model: string; tokens: number; errors?: string[] };
    if (doc.errors?.length) throw new Error(doc.errors.join("; "));
    return { vectors: doc.vectors, model: doc.model, tokens: doc.tokens ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Shared hybrid retrieval (extracted verbatim from the scheduler's candidate
// selection by add-continuation-eval): vector cosine first, keyword fallback +
// gap-filler, merged deduped, top-k. This is THE production recall path for
// distiller candidates AND the eval digest arm — one implementation, no drift.
export async function hybridCandidates(opts: {
  root: StoreRoot;
  project: string;
  queryFor: string;
  k?: number;
  embed: (texts: string[]) => Promise<{ vectors: number[][]; model: string; tokens: number }>;
  log?: { warn: (msg: string) => void };
}): Promise<Array<DistillCandidate & { score?: number }>> {
  const { root, project, queryFor, k = 8, embed, log } = opts;
  const projects = project === "shared" ? [project] : [project, "shared"];
  const keyword = distillCandidates(root, projects, queryFor);
  try {
    const q = await embed([queryFor]);
    if (!q.vectors.length) return keyword;
    const qv = q.vectors[0];
    const scored: Array<DistillCandidate & { score: number }> = [];
    for (const c of keyword) {
      for (const project2 of projects) {
        const rel = `${project2}/${c.kind === "fact" ? "facts" : "experiences"}/${c.id}.md`;
        const pv = root.db.getPageVector(rel);
        if (!pv || pv.model !== q.model || pv.vector.length !== qv.length) continue;
        scored.push({ ...c, score: cosine(qv, pv.vector) });
        break;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const vectorIds = new Set(scored.map((x) => x.id));
    const merged = [...scored, ...keyword.filter((x) => !vectorIds.has(x.id)).map((x) => ({ ...x, score: -1 }))];
    const modelMismatch = root.db.vectorModelCounts().filter((m) => m.model !== q.model).reduce((a, m) => a + m.n, 0);
    if (modelMismatch > 0) log?.warn(`[hybrid] ${project}: ${modelMismatch} vector(s) on other models — excluded from cosine (gap noted)`);
    return merged.slice(0, k);
  } catch (e) {
    log?.warn(`[hybrid] embed query failed — keyword-only candidates: ${(e as Error)?.message ?? e}`);
    return keyword;
  }
}

function writeEntryVector(root: StoreRoot, rel: string, entry: Record<string, unknown>): void {
  const v = (entry as { vector?: unknown }).vector;
  if (Array.isArray(v) && v.length > 0) {
    try {
      root.db.setPageVector(rel, String((entry as { vector_model?: unknown }).vector_model ?? ""), new Float32Array(v as number[]));
    } catch { /* companion store is never load-bearing */ }
  }
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function normalizeEntry(entry: Record<string, unknown>, kind: "fact" | "experience") {
  const id = String(entry.id ?? `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  return {
    id,
    engine: String(entry.engine ?? "engine:unknown"),
    confidence: entry.confidence != null ? Number(entry.confidence) : undefined,
    sources: Array.isArray(entry.sources) ? (entry.sources as string[]) : [],
    supersedes: Array.isArray(entry.supersedes) ? (entry.supersedes as string[]) : [],
    statement: entry.statement != null ? String(entry.statement) : undefined,
    subject: entry.subject != null ? String(entry.subject) : undefined,
    files: Array.isArray(entry.files) ? (entry.files as string[]) : undefined,
    details: entry.details != null ? String(entry.details) : undefined,
    task: entry.task != null ? String(entry.task) : undefined,
    search_keys: Array.isArray(entry.search_keys) ? (entry.search_keys as string[]) : undefined,
    solution: entry.solution != null ? String(entry.solution) : undefined,
    boundary_envs: entry.boundary_envs != null ? String(entry.boundary_envs) : undefined,
  };
}

function tomorrowMs(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 1, 0);
  return d.getTime();
}
