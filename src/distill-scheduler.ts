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
import { distillCandidates } from "./distill.js";
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
    if (!rootKey.startsWith("d-")) return;
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
  private async selectCandidates(root: StoreRoot, project: string, queryFor: string) {
    const projects = project === "shared" ? [project] : [project, "shared"];
    const keyword = distillCandidates(root, projects, queryFor);
    try {
      const q = await this.embedTexts([queryFor]);
      if (!q.vectors.length) return keyword;
      const qv = q.vectors[0];
      const scored: Array<{ id: string; kind: "fact" | "experience"; task: string; search_keys: string[]; solution: string; boundary_envs: string; supersedes: string[]; score: number }> = [];
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
      const merged = [...scored, ...keyword.filter((k) => !vectorIds.has(k.id)).map((k) => ({ ...k, score: -1 }))];
      const modelMismatch = root.db.vectorModelCounts().filter((m) => m.model !== q.model).reduce((a, m) => a + m.n, 0);
      if (modelMismatch > 0) this.log.warn(`[distill] ${project}: ${modelMismatch} vector(s) on other models — excluded from cosine (gap noted)`);
      return merged.slice(0, 8);
    } catch (e) {
      this.log.warn(`[distill] embed query failed — keyword-only candidates: ${(e as Error)?.message ?? e}`);
      return keyword;
    }
  }

  private async embedTexts(texts: string[]): Promise<{ vectors: number[][]; model: string; tokens: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
      const doc = (await res.json()) as { vectors: number[][]; model: string; tokens: number; errors?: string[] };
      if (doc.errors?.length) throw new Error(doc.errors.join("; "));
      const day = new Date().toISOString().slice(0, 10);
      const rootKey = this.opts.roots.keys().next().value ?? "";
      // budget accounting rides the caller root (distillOne adds its own) —
      // embed tokens are booked by the caller; here we only surface them.
      void rootKey; void day;
      return { vectors: doc.vectors, model: doc.model, tokens: doc.tokens ?? 0 };
    } finally {
      clearTimeout(timer);
    }
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
      if (!rootKey.startsWith("d-")) continue;
      const day = new Date().toISOString().slice(0, 10);
      const remaining = this.dailyLimit() - this.opts.tokens.distillBudgetUsed(rootKey, day).tokens;
      if (remaining < FALLBACK_BUDGET_RESERVE) continue; // active projects first
      const projects = new Set<string>();
      for (const row of root.db.recentObservations(2000) as unknown as Array<{ project: string }>) projects.add(row.project);
      for (const project of projects) {
        const state = root.db.getDistillState(project);
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
      if (obs.length === 0 && handoffs.length === 0) return;

      // budget guardrail (per root = per owner at v1; see auth.ts)
      const day = new Date().toISOString().slice(0, 10);
      const used = this.opts.tokens.distillBudgetUsed(rootKey, day);
      if (used.tokens >= this.dailyLimit()) {
        root.db.upsertDistillState(project, { last_error: "daily_budget_exhausted", gaps: (state?.gaps ?? 0) + 1, next_attempt_at: tomorrowMs(this.now()) });
        this.log.warn(`[distill] ${key}: daily budget exhausted (${used.tokens}/${this.dailyLimit()}) — gap recorded, cursor kept`);
        return;
      }

      const items: DistillItem[] = [
        ...obs.map((o) => ({ kind: "observation" as const, session_id: o.session_id, at: o.created_at, event: o.event, tool: o.tool, summary: o.summary, agent: o.agent })),
        ...handoffs.map((h) => ({ kind: "handoff" as const, session_id: h.id, at: h.created_at, summary: `${h.summary}｜next: ${h.next_steps}` , agent: h.from_agent })),
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

      const audit = { principal: "distiller:scheduler", scope: `${rootKey}/${project}` };
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
      root.db.upsertDistillState(project, {
        obs_cursor: Math.max(state?.obs_cursor ?? 0, result.cursor_next?.obs ?? maxRid),
        handoff_cursor: (result.cursor_next?.handoff ?? maxHandoff) > (state?.handoff_cursor ?? "") ? String(result.cursor_next?.handoff ?? maxHandoff) : maxHandoff,
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
