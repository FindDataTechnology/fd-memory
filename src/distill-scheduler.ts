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
import { noteDistill } from "./metrics.js";

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
  // Disk discovery (2026-10-26 lazy-roots gap): the live roots map only holds
  // roots touched since boot — a root nobody hit after a restart never
  // distills, no matter how much note material accumulated. The service
  // supplies the owner-dir listing; the scan opens uncached roots once (the
  // map is the cache) so every root distills regardless of traffic.
  discoverRoots?: () => string[];
  log?: { warn: (msg: string) => void; log: (msg: string) => void };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEBOUNCE_MS = 5 * 60_000;
// Person roots distill on WRITE triggers (add-write-triggered-distill) — the
// material is a discrete note/handoff the user just produced, and its value
// decays fast; a 60s debounce merges bursts without the 5min session wait.
const U_DEBOUNCE_MS = 60_000;
const debounceFor = (rootKey: string) => (rootKey.startsWith("u-") ? U_DEBOUNCE_MS : DEBOUNCE_MS);
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
      (p) => !this.inflight.has(DistillScheduler.key(p.rootKey, p.project)) && this.now() - p.since >= debounceFor(p.rootKey),
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
  // Tagging lane (add-unified-memory-and-outputs D5): propose tags/tier for
  // reference pages under the same per-owner daily-budget gate. Corrections
  // (修正： notes) feed the prompt as the owner's vocabulary; results land as
  // AI-proposed frontmatter (never overwrite human-set tags/tier).
  private async tagPass(root: StoreRoot, rootKey: string, project: string, state: { tag_cursor?: string } | null): Promise<void> {
    const cursor = state?.tag_cursor ?? "";
    const pending = root.db.referencesNeedingTags(project, cursor, 12);
    if (pending.length === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    const used = this.opts.tokens.distillBudgetUsed(rootKey, day);
    if (used.tokens >= this.dailyLimit()) return;
    const corr = root.db.correctionsAfter(project, "", 10).map((c) => `${c.title}: ${c.body}`).slice(0, 6).join("\n");
    const items = pending.map((p, i) => ({ idx: i, title: p.title, summary: p.body, current_tags: JSON.parse(p.tags || "[]"), current_tier: p.tier, corrections: corr }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECCAR_TIMEOUT_MS);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/tag`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
        body: JSON.stringify({ scope: `${rootKey}/${project}`, items }), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) { this.log.warn(`[tag] ${rootKey}/${project}: sidecar ${res.status}`); return; }
    const out = (await res.json()) as { results: Array<{ idx: number; tags: string[]; tier: string }>; tokens: number; errors: string[] };
    if (out.errors?.length) this.log.warn(`[tag] ${rootKey}/${project}: ${out.errors.slice(0, 2).join("; ")}`);
    const audit = { principal: "distiller:tag", scope: `${rootKey}/${project}` };
    let tagged = 0;
    for (const r of out.results ?? []) {
      const p = pending[r.idx];
      if (!p) continue;
      const page = root.readPageByRel(p.path);
      if (!page) continue;
      const fm: Record<string, unknown> = { ...page.frontmatter };
      if (String(fm.tags_origin ?? "") === "human") { /* human wins */ }
      else { fm.tags = (r.tags ?? []).slice(0, 5); fm.tags_origin = "ai"; }
      const cur = String(fm.tier ?? "draft");
      const want = String(r.tier ?? "draft");
      if (String(fm.tier_origin ?? "") !== "human") {
        if ((cur === "draft" && (want === "stable" || want === "canonical")) || (cur === "stable" && want === "canonical")) {
          fm.tier = want === "canonical" ? "stable" : want; // canonical 永仅经人类/信号
          fm.tier_origin = "ai";
        }
      }
      const dir = p.path.split("/")[1];
      const slug = p.path.split("/").pop()!.replace(/\.md$/, "");
      root.writePage(project, dir, slug, { frontmatter: fm, body: page.body } as never, audit);
      tagged++;
    }
    const spentTotal = Number(out.tokens ?? 0) || 0;
    if (spentTotal > 0) this.opts.tokens.distillBudgetAdd(rootKey, day, spentTotal, 1);
    const lastTs = pending[pending.length - 1].updated_at;
    root.db.upsertDistillState(project, { tag_cursor: lastTs });
    if (tagged) this.log.log(`[tag] ${rootKey}/${project}: tagged=${tagged}/${pending.length} tokens=${spentTotal}`);
  }

  async distillNow(rootKey: string, project: string): Promise<void> {
    const key = DistillScheduler.key(rootKey, project);
    if (this.inflight.has(key)) return;
    await this.distillOne(rootKey, project);
  }

  private fallbackScan(): void {
    if (this.now() - this.lastFallback < FALLBACK_INTERVAL_MS) return;
    this.lastFallback = this.now();
    if (this.opts.discoverRoots) {
      for (const rootKey of this.opts.discoverRoots()) {
        if (isDistillableRoot(rootKey, this.opts.env) && !this.opts.roots.has(rootKey)) {
          try { this.opts.openRoot(rootKey); } catch { /* unreadable root — skip this scan */ }
        }
      }
    }
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
      // Patrol-echo dedup (2026-10-26 audit): cron-heavy roots distilled the
      // same "ran the round patrol" narrative every round — mission-planner
      // burned 605k tokens/day producing 277 near-identical L2 pages. The
      // engine sees candidates but never self-dedupes, so the write face does:
      // a new L2 whose title shares the first 16 chars with an existing page
      // of the same kind supersedes it (files persist; the read face retires
      // the old page via the supersededIds filters).
      const TITLE_PREFIX = 16;
      const dedupeSupersedes = (title: string, kind: "fact" | "experience"): string[] => {
        const prefix = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_PREFIX);
        if (prefix.length < TITLE_PREFIX) return [];
        const kindDir = kind === "fact" ? "facts" : "experiences";
        const rows = root.db.db.prepare(
          `SELECT path, title FROM pages WHERE project=? AND type=? AND title LIKE ? ORDER BY updated_at DESC LIMIT 20`,
        ).all(project, kind, `${prefix}%`) as Array<{ path: string; title: string }>;
        return rows
          .filter((r) => String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_PREFIX) === prefix)
          .map((r) => r.path.split("/").pop()?.replace(/\.md$/, "") ?? "")
          .filter(Boolean);
      };

      if (rootKey.startsWith("u-")) {
        // Person-root chunked distillation (add-u-root-distillation D2, tuned
        // by production probe 2026-10-25): the engine's extraction output
        // truncates at its completion ceiling on large/long batches and the
        // truncated JSON is swallowed into an EMPTY result (no error, 0 pages)
        // — 4 real patrol handoffs → completion_tokens 6000 → silent zero. 2
        // items per call with 800-char summaries stay under the ceiling (4.4k
        // completion). Note items ride event "user-prompt-submit": the engine
        // silently DROPS unknown events (probe: "note-write" batches → 0 LLM
        // calls, no error). Handoffs and notes are chunked per-stream so cursors
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
            const entry = normalizeEntry(fact, "fact");
            entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.statement ?? entry.task ?? ""), "fact")];
            const rel = root.writeDistillPage(project, "fact", entry, audit);
            writeEntryVector(root, rel, fact);
          }
          for (const exp of result.experiences ?? []) {
            const entry = normalizeEntry(exp, "experience");
            entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.task ?? ""), "experience")];
            const rel = root.writeDistillPage(project, "experience", entry, audit);
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
          wrote += await callEngine(batch.map((n) => ({ kind: "observation" as const, session_id: n.path, at: n.updated_at, event: "user-prompt-submit", tool: "memory_write_page", summary: `${cap(n.title)}：${cap(n.body)}`, agent: "user" })));
          root.db.upsertDistillState(project, { note_cursor: batch[batch.length - 1].updated_at, last_tokens: spentTotal });
        }
        this.opts.tokens.distillBudgetAdd(rootKey, day, spentTotal, wrote);
        noteDistill(true, wrote, spentTotal);
        this.log.log(`[distill] ${key}: ${wrote} pages from ${handoffs.length} handoffs + ${notes.length} notes (chunked), ${(spentTotal).toLocaleString()} tokens`);
        return;
      }

      const items: DistillItem[] = [
        ...obs.map((o) => ({ kind: "observation" as const, session_id: o.session_id, at: o.created_at, event: o.event, tool: o.tool, summary: o.summary, agent: o.agent })),
        ...handoffs.map((h) => ({ kind: "handoff" as const, session_id: h.id, at: h.created_at, summary: `${h.summary}｜next: ${h.next_steps}` , agent: h.from_agent })),
        ...notes.map((n) => ({
          kind: "observation" as const, session_id: n.path, at: n.updated_at, event: "user-prompt-submit", tool: "memory_write_page",
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
        const entry = normalizeEntry(fact, "fact");
        entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.statement ?? entry.task ?? ""), "fact")];
        const rel = root.writeDistillPage(project, "fact", entry, audit);
        writeEntryVector(root, rel, fact);
      }
      for (const exp of result.experiences ?? []) {
        const entry = normalizeEntry(exp, "experience");
        entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.task ?? ""), "experience")];
        const rel = root.writeDistillPage(project, "experience", entry, audit);
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
      noteDistill(true, (result.facts?.length ?? 0) + (result.experiences?.length ?? 0), result.tokens ?? 0);
      this.log.log(`[distill] ${key}: ${result.facts?.length ?? 0} facts, ${result.experiences?.length ?? 0} experiences, ${(result.tokens ?? 0).toLocaleString()} tokens`);
    } catch (e) {
      const root = this.opts.roots.get(rootKey) ?? this.opts.openRoot(rootKey);
      const state = root.db.getDistillState(project);
      const prev = state?.next_attempt_at && state.next_attempt_at > this.now() ? state.next_attempt_at - this.now() : 30_000;
      const backoff = Math.min(MAX_BACKOFF_MS, Math.max(30_000, prev * 2));
      root.db.upsertDistillState(project, { last_error: String((e as Error)?.message ?? e).slice(0, 300), next_attempt_at: this.now() + backoff });
      noteDistill(false, 0, 0, String((e as Error)?.message ?? e));
      this.log.warn(`[distill] ${key} failed (cursor kept, backoff ${Math.round(backoff / 1000)}s): ${(e as Error)?.message ?? e}`);
    } finally {
      // Tagging lane (reference pages) rides distillOne, NOT distillNow: the
      // production trigger chain is capture → notifyCapture → drain →
      // distillOne, and distillNow is only reached from tests — an earlier
      // version hung the hook there and production never tagged a single page
      // (verified 2026-10-28: zero [tag] lines, every tag_cursor empty).
      // It also runs on the early returns above (no material / budget /
      // backoff) because a reference page needs no distillation material.
      try {
        await this.tagPassSafe(rootKey, project);
      } finally {
        this.inflight.delete(key);
      }
    }
  }

  // tagPass with its own root resolution and a hard mute: tagging is a
  // convenience lane and must never turn a good distillation into a failure.
  private async tagPassSafe(rootKey: string, project: string): Promise<void> {
    try {
      const root = this.opts.roots.get(rootKey) ?? this.opts.openRoot(rootKey);
      await this.tagPass(root, rootKey, project, root.db.getDistillState(project) ?? null);
    } catch (e) {
      this.log.warn(`[tag] ${rootKey}/${project}: skipped (${(e as Error)?.message ?? e})`);
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
    // Scan EVERY vector of this model (2026-10-26 recall-cap fix): scoring only
    // keyword-recalled candidates made the vector lane a mere re-ranker, so a
    // page whose embedding was closest but whose words didn't overlap was
    // unreachable. L2 pages carry a `task`/`statement`; rebuild a candidate
    // from the page itself for vector-only hits.
    const byRel = new Map<string, DistillCandidate>();
    for (const c of keyword) {
      for (const project2 of projects) {
        byRel.set(`${project2}/${c.kind === "fact" ? "facts" : "experiences"}/${c.id}.md`, c);
      }
    }
    const scored: Array<DistillCandidate & { score: number }> = [];
    const superseded = root.db.supersededIds();
    for (const v of root.db.allPageVectors(q.model)) {
      if (v.vector.length !== qv.length) continue;
      const rel = v.page_rel;
      const baseId = rel.split("/").pop()?.replace(/\.md$/, "") ?? "";
      if (superseded.has(baseId)) continue; // retired by a newer distillation
      const projectOfRel = rel.split("/")[0];
      if (!projects.includes(projectOfRel)) continue;
      let c = byRel.get(rel);
      if (!c) {
        const m = rel.match(/^([^/]+)\/(facts|experiences)\/(.+)\.md$/);
        if (!m) continue;
        const page = root.readPageByRel(rel);
        if (!page) continue;
        const kind = m[2] === "facts" ? "fact" : "experience";
        c = {
          id: m[3], kind,
          task: kind === "fact" ? String(page.frontmatter?.subject ?? page.frontmatter?.title ?? m[3]) : String(page.frontmatter?.title ?? m[3]),
          search_keys: [], solution: String(page.body ?? "").slice(0, 400),
          boundary_envs: "", supersedes: [],
        };
      }
      scored.push({ ...c, score: cosine(qv, v.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    const vectorIds = new Set(scored.map((x) => x.id));
    const merged = [...scored, ...keyword.filter((x) => !vectorIds.has(x.id)).map((x) => ({ ...x, score: -1 }))];
    const modelMismatch = root.db.vectorModelCounts().filter((m) => m.model !== q.model).reduce((a, m) => a + m.n, 0);
    if (modelMismatch > 0) log?.warn(`[hybrid] ${project}: ${modelMismatch} vector(s) on other models — excluded from cosine (gap noted)`);
    return merged.slice(0, k);
  } catch (e) {
    log?.warn(`[hybrid] embed query failed — keyword-only candidates: ${(e as Error)?.message ?? e}`);
    return keyword.slice(0, k); // the fallback must honour k like the success path
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
