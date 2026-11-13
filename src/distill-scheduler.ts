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
import { deploymentDefaults, distillEnabled } from "./policy.js";
import { noteDistillStages, noteDistillTruncation, extractHitCeiling, noteDistill, notePromotion, noteVectorEvent } from "./metrics.js";

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
  // Declared process policy per root (add-agent-memory-declaration). Absent
  // provider = deployment default only, which is exactly the pre-change
  // behaviour, so callers that never inject one keep working unchanged.
  policyFor?: (rootKey: string) => { root: Record<string, string | number>; projects: Record<string, Record<string, string | number>> };
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
// The extractor's completion ceiling, mirrored from distiller/engine.py
// (CodingMemoryExtractor(max_tokens=6000)). Only used to DETECT truncation; the
// value itself is the engine's, so the two must move together.
const EXTRACT_MAX_TOKENS = Number(process.env.FD_MEMORY_EXTRACT_MAX_TOKENS ?? 6000) || 6000;
const EXTRACT_TRUNCATED_MAX_GAPS = Math.max(1, Number(process.env.FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS ?? 3) || 3);
// Step 2 of fix-distill-extract-truncation. Measured 2/2 runs at exactly the
// 6,000 ceiling with 120 items → 4 pages, so a truncated batch is not a rare
// wobble: the batch is simply bigger than the extractor can answer. Halving it
// once is the smallest change that can actually recover the output.
const EXTRACT_RETRY_ON_TRUNCATION = String(process.env.FD_MEMORY_EXTRACT_RETRY_ON_TRUNCATION ?? "1") !== "0";
// The escape hatch (2.4): a batch that truncates even when split must not stall
// its project forever. After this many consecutive runs, step over it — loudly.

const DEFAULT_MAX_ITEMS = 120; // ~40k-token worst-case prompt (production day-1: 220 obs ≈ 74k tokens was too coarse)
// Batch size is a THROUGHPUT bound, not a taste setting (2026-11-13). Measured
// on the 詞元 lane: 34 output tokens/s, so a 4,858-in/1,378-out extraction call
// takes 41 s. With the extractor's 6,000-token completion ceiling a 120-item
// batch is structurally ~176 s — it cannot finish inside the distiller's own
// 150 s self-limit, and when it does return it is truncated (measured on the
// new pod the same hour: one project stepped over after 12 consecutive
// truncations, one run died at `distill_deadline_exceeded`). Lowering the batch
// makes each call ~30 s and keeps the output under the ceiling; the run simply
// advances its cursor and the next drain continues. Configurable so production
// can be tuned without a rebuild.
const SIDECCAR_TIMEOUT_MS = 180_000;

// Root-family gate. This used to be the whole decision: pack roots always
// distilled, person roots distilled unless FD_MEMORY_DISTILL_U=0 — which made the
// env var the ONLY way to answer "should this root distill", so a team that wanted
// it on could not say so and one that wanted it off needed an operator.
//
// Now the family gate answers a narrower question ("does this root type
// participate at all") and FD_MEMORY_DISTILL_U becomes a deployment DEFAULT
// (policy.deploymentDefaults) that a declared root/project policy overrides.
function isDistillableRootFamily(rootKey: string): boolean {
  return rootKey.startsWith("d-") || rootKey.startsWith("u-");
}

export class DistillScheduler {
  private pending = new Map<string, { rootKey: string; project: string; since: number }>();
  private inflight = new Set<string>();
  // Per-owner serialization for the daily-budget gate (7.3): see distillOne.
  private rootInflight = new Set<string>();
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

  // Per-call batch ceiling (see DEFAULT_MAX_ITEMS). Garbage or <1 falls back to
  // the default rather than sending a zero-item batch, which would look like
  // "nothing to do" forever.
  private maxItems(): number {
    const raw = Number(this.opts.env?.FD_MEMORY_DISTILL_MAX_ITEMS ?? DEFAULT_MAX_ITEMS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ITEMS;
  }

  // Engine calls per /distill request (2026-11-13). One call takes 47-97 s on the
  // 詞元 lane even with a 474-character extraction prompt (measured; no
  // "disable thinking" spelling was honoured), so the distiller's 150 s request
  // deadline covers ONE call — not a run's worth. A u-root with 42 notes needs 21
  // sequential chunks (~17 min) and died on every attempt; a d-root could issue 4
  // calls (observations + handoffs + notes + a truncation split). Bounding calls
  // per request makes every run finish inside the deadline; cursors keep what
  // landed and the next drain continues from there.
  // Unset / garbage means NO cap, i.e. the behaviour every existing caller and
  // test already had; production sets it explicitly (see the deployment
  // manifest). A knob that silently changes the default would also silently
  // change what the older tests mean.
  private maxCallsPerRun(): number {
    const raw = Number(this.opts.env?.FD_MEMORY_DISTILL_MAX_CALLS_PER_RUN ?? 0);
    if (!Number.isFinite(raw) || raw < 1) return Number.POSITIVE_INFINITY;
    return Math.floor(raw);
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
    if (!this.distills(rootKey, project)) return;
    const boundary = events.some((e) => e?.event === "session-end" || e?.event === "stop");
    if (!boundary) return;
    const key = DistillScheduler.key(rootKey, project);
    if (!this.pending.has(key)) this.pending.set(key, { rootKey, project, since: this.now() });
  }

  /**
   * Does this (root, project) participate in distillation right now?
   *
   * Resolves the declaration chain — project policy, then this root's policy,
   * then the deployment default (FD_MEMORY_DISTILL_U demoted to exactly that).
   * An undeclared root behaves as it did before this change, so the default
   * path is byte-identical.
   */
  private distills(rootKey: string, project = ""): boolean {
    if (!isDistillableRootFamily(rootKey)) return false;
    const deployment = deploymentDefaults(rootKey, this.opts.env);
    let docs: { root: Record<string, string | number>; projects: Record<string, Record<string, string | number>> } =
      { root: {}, projects: {} };
    try {
      docs = this.opts.policyFor?.(rootKey) ?? docs;
    } catch {
      // A policy read must never stop distillation: degrade to the deployment
      // default, which is the pre-change behaviour.
      docs = { root: {}, projects: {} };
    }
    return distillEnabled(
      [
        ["project", project ? (docs.projects[project] ?? {}) : {}],
        ["root", docs.root],
      ],
      deployment,
    );
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
    const out = await sidecarEmbed(this.opts.env ?? process.env, texts, this.opts.fetchImpl ?? fetch, this.url());
    this.checkModelConsistency(out.model);
    return out;
  }

  // First-embed self-check (2026-10-28): the sidecar's CURRENT model is only
  // knowable from a response. The moment the process learns it, compare it
  // against every discoverable root's dominant model — a mismatch means that
  // root's whole vector history is excluded from recall RIGHT NOW, silently.
  // Once per model per process; the log line is the alarm, /admin/reembed is
  // the fix.
  private modelChecked = false;
  private modelWarned = new Set<string>();
  private checkModelConsistency(current: string): void {
    if (this.modelChecked || !current) return;
    this.modelChecked = true;
    try {
      const keys = new Set<string>([...this.opts.roots.keys(), ...(this.opts.discoverRoots?.() ?? [])]);
      for (const key of keys) {
        if (!this.distills(key)) continue;
        let root: StoreRoot;
        try { root = this.opts.roots.get(key) ?? this.opts.openRoot(key); } catch { continue; }
        const dom = root.db.dominantVectorModel();
        if (!dom || dom.model === current || this.modelWarned.has(dom.model)) continue;
        this.modelWarned.add(dom.model);
        this.log.warn(`[vector] ${key}: dominant model ${dom.model} != sidecar model ${current} — ${dom.n} vector(s) are EXCLUDED from recall right now; re-embed via POST /admin/reembed`);
      }
    } catch { /* best-effort: never block the embed lane */ }
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

  // Tier promotion lane (add-tier-promotion-candidates D1-D4): ask the
  // sidecar whether draft pages deserve `stable`, and land the verdict as a
  // PENDING PROPOSAL — the page's tier is never touched here (spec: AI 提议
  // 不直接晋级; a human accepts/ignores via /memory/promotions). Rides the
  // same per-owner daily-budget gate as the tagging lane, its own
  // promotion_cursor so tag-lane progress cannot starve selection, and an
  // ignore cooldown so a rejected page is not re-nagged daily.
  private promotionEnabled(): boolean {
    // Default ON: the whole point of this lane is that the tier ladder was
    // empty (draft 99.8%); a switch nobody flips recreates the dead pipe.
    // Rollback lever = FD_MEMORY_PROMOTION_ENABLED=0 (design Migration).
    const v = String(this.opts.env?.FD_MEMORY_PROMOTION_ENABLED ?? "1").trim().toLowerCase();
    return v !== "0" && v !== "false";
  }

  private promotionCooldownDays(): number {
    return Number(this.opts.env?.FD_MEMORY_PROMOTION_IGNORE_COOLDAYS ?? 14) || 14;
  }

  private async promotionPass(root: StoreRoot, rootKey: string, project: string, state: { promotion_cursor?: string } | null): Promise<void> {
    if (!this.promotionEnabled()) return;
    const cursor = state?.promotion_cursor ?? "";
    const pending = root.db.promotionCandidates(project, cursor, 20);
    if (pending.length === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    const used = this.opts.tokens.distillBudgetUsed(rootKey, day);
    if (used.tokens >= this.dailyLimit()) return; // budget exhausted: stop proposing; existing proposals stay acceptable
    const items = pending.map((p, i) => ({ idx: i, title: p.title, summary: p.body, current_tier: p.tier }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECCAR_TIMEOUT_MS);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/promote`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
        body: JSON.stringify({ scope: `${rootKey}/${project}`, items }), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) { this.log.warn(`[promo] ${rootKey}/${project}: sidecar ${res.status}`); return; }
    const out = (await res.json()) as { results: Array<{ idx: number; suggest_tier: string; reason?: string }>; tokens: number; errors: string[] };
    if (out.errors?.length) this.log.warn(`[promo] ${rootKey}/${project}: ${out.errors.slice(0, 2).join("; ")}`);
    notePromotion("candidates", pending.length);
    const cooldownSince = new Date(this.now() - this.promotionCooldownDays() * 86_400_000).toISOString();
    let proposed = 0;
    for (const r of out.results ?? []) {
      if (String(r.suggest_tier ?? "") !== "stable") continue; // "none" = no proposal
      const p = pending[r.idx];
      if (!p) continue;
      // Re-read the page: the judgement was made on a snapshot, the write
      // lands on the live frontmatter — and the ceiling (stable max) is
      // enforced HERE too, not only in the sidecar parser (3.3).
      const page = root.readPageByRel(p.path);
      if (!page) continue;
      const fm: Record<string, unknown> = page.frontmatter ?? {};
      if (String(fm.tier_origin ?? "") === "human") continue; // human slots never get proposals
      if (String(fm.tier ?? "draft") !== "draft") continue; // settled while we were judging
      if (root.db.tierProposalIgnoredWithin(project, p.path, cooldownSince)) continue; // D4 cooldown
      // The ceiling at landing: only a stable proposal is ever stored — the
      // filter above already drops "none", and anything the sidecar somehow
      // returns above stable collapses here (3.3), never onto the page.
      root.db.upsertTierProposal(project, p.path, {
        proposed_tier: "stable",
        reason: String(r.reason ?? "").slice(0, 240),
        proposed_at: new Date().toISOString(),
      });
      proposed++;
    }
    const spentTotal = Number(out.tokens ?? 0) || 0;
    if (spentTotal > 0) this.opts.tokens.distillBudgetAdd(rootKey, day, spentTotal, 1);
    const lastTs = pending[pending.length - 1].updated_at;
    root.db.upsertDistillState(project, { promotion_cursor: lastTs });
    notePromotion("proposed", proposed);
    if (proposed) this.log.log(`[promo] ${rootKey}/${project}: proposed=${proposed}/${pending.length} tokens=${spentTotal}`);
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
        if (this.distills(rootKey) && !this.opts.roots.has(rootKey)) {
          try { this.opts.openRoot(rootKey); } catch { /* unreadable root — skip this scan */ }
        }
      }
    }
    for (const [rootKey, root] of this.opts.roots) {
      if (!this.distills(rootKey)) continue;
      const day = new Date().toISOString().slice(0, 10);
      const remaining = this.dailyLimit() - this.opts.tokens.distillBudgetUsed(rootKey, day).tokens;
      if (remaining < FALLBACK_BUDGET_RESERVE) continue; // active projects first
      const projects = new Set<string>();
      // Pack roots discover work via capture observations; person roots
      // (add-u-root-distillation D3) have none — the pages index is their
      // project discovery surface.
      for (const row of root.db.recentObservations(2000) as unknown as Array<{ project: string }>) projects.add(row.project);
      // Discovery must not be observation-only (fix-distill-extract-truncation 6.2).
      // A d-root whose material lives entirely in notes/handoffs has no
      // observations at all, so it never entered `projects` and the scan could
      // not even see it — measured on m_1793411839219_ld494z: 174 notes, 0
      // observations, stranded for 162 minutes after a hold. The pages index is
      // the only surface that knows such a project exists.
      for (const p of root.db.distinctProjects()) projects.add(p);
      for (const project of projects) {
        const state = root.db.getDistillState(project);
        // Note/handoff lag is meaningful for BOTH families now: u-roots have no
        // observation stream at all, and d-roots stranded by a hold are the same
        // shape (material in notes/handoffs, nothing new observed). Queuing is
        // still budget-gated above, and distillOne honours next_attempt_at, so a
        // held project is retried after its backoff rather than immediately.
        const noteLag = root.db.notesAfter(project, state?.note_cursor ?? "", 1).length > 0;
        let handoffLag = false;
        try {
          handoffLag = !!root.db
            .db.prepare("SELECT id FROM handoffs WHERE project=? AND created_at>? LIMIT 1")
            .get(project, state?.handoff_cursor ?? "");
        } catch { /* best-effort */ }
        const queue = () => {
          const key = DistillScheduler.key(rootKey, project);
          if (!this.pending.has(key)) this.pending.set(key, { rootKey, project, since: 0 });
        };
        if (rootKey.startsWith("u-")) {
          if (noteLag || handoffLag) queue();
          continue;
        }
        const lag = root.db.maxObservationRowid(project) - (state?.obs_cursor ?? 0);
        if (lag >= FALLBACK_CURSOR_LAG || noteLag || handoffLag) queue();
      }
    }
  }

  private async distillOne(rootKey: string, project: string): Promise<void> {
    const key = DistillScheduler.key(rootKey, project);
    // One run per OWNER at a time (optimize-yongyi-read-surfaces 7.3). The
    // daily budget is per root, and the ledger can only be read before a call,
    // so two projects of the same owner starting together would both read
    // "0 used" and both pass. Serializing per root closes that window: the
    // second project sees the first one's spend on its next drain.
    if (this.rootInflight.has(rootKey)) return;
    this.rootInflight.add(rootKey);
    this.pending.delete(key);
    this.inflight.add(key);
    try {
      // Per-project policy gate (add-agent-memory-declaration): a project may
      // declare `process.distill: off` while its root stays on, or the reverse.
      // Checked at drain time as well as at mark time, so a declaration that
      // lands after a project was queued still takes effect on the next drain.
      if (!this.distills(rootKey, project)) return;
      const root = this.opts.openRoot(rootKey);
      const state = root.db.getDistillState(project);
      if (state && state.next_attempt_at > this.now()) return;
      const maxItems = this.maxItems();
      const obs = root.db.observationsAfter(project, state?.obs_cursor ?? 0, maxItems) as unknown as (ObservationRow & { rid: number })[];
      let handoffs: HandoffRow[] = [];
      try {
        handoffs = root.db
          .db.prepare("SELECT * FROM handoffs WHERE project=? AND created_at>? ORDER BY created_at LIMIT ?")
          .all(project, state?.handoff_cursor ?? "", maxItems) as unknown as HandoffRow[];
      } catch { /* handoff cursor best-effort */ }
      // Person-root raw material (add-u-root-distillation D2): note pages are
      // what chat MCP writes actually produce; observations never exist there.
      // Synthesized as observation-shaped items — a note IS a captured event
      // of the user asking to remember — so the sidecar contract is untouched.
      let notes: Array<{ path: string; title: string; body: string; updated_at: string }> = [];
      try {
        notes = root.db.notesAfter(project, state?.note_cursor ?? "", maxItems);
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
      // Patrol-echo dedup: cron-heavy roots can distill the same "ran the
      // round patrol" narrative every round — one deployment burned 600k+
      // tokens/day producing near-identical L2 pages. The engine sees
      // candidates but never self-dedupes, so the write face does:
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
          // Budget gate PER CHUNK (optimize-yongyi-read-surfaces 7.3). The gate
          // used to be read once before the whole run and the spend written back
          // only after it finished, so one long run — or two concurrent projects
          // of the same owner, each reading "0 used" — could sail past the daily
          // cap. Measured 2026-11-08: one owner spent 3,734,259 tokens against a
          // 400,000 limit (9.3x). Re-reading here makes the cap bind during the
          // run; the increment is written after EVERY call so a sibling run sees
          // it too.
          const spentNow = this.opts.tokens.distillBudgetUsed(rootKey, day).tokens;
          if (spentNow >= this.dailyLimit()) throw new Error("daily_budget_exhausted");
          chunksIssued += 1;
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
            writeEntryVector(root, rel, fact, this.log);
          }
          for (const exp of result.experiences ?? []) {
            const entry = normalizeEntry(exp, "experience");
            entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.task ?? ""), "experience")];
            const rel = root.writeDistillPage(project, "experience", entry, audit);
            writeEntryVector(root, rel, exp, this.log);
          }
          for (const c of result.llm_calls ?? []) stageCalls.push(c);
          // Truncation visibility only (fix-distill-extract-truncation 1.1/1.3):
          // this run's extract output may have been cut at the completion
          // ceiling. Counted and logged; the retry/rollback semantics land in a
          // later step so this one cannot change behavior.
          if (extractHitCeiling(result.llm_calls, EXTRACT_MAX_TOKENS)) truncatedRuns += 1;
          spentTotal += result.tokens ?? 0;
          // Written per call, not once per run — this is what makes the gate
          // bind for a concurrent sibling run (7.3).
          if ((result.tokens ?? 0) > 0) this.opts.tokens.distillBudgetAdd(rootKey, day, result.tokens ?? 0, 1);
          return {
            written: (result.facts?.length ?? 0) + (result.experiences?.length ?? 0),
            truncated: extractHitCeiling(result.llm_calls, EXTRACT_MAX_TOKENS),
          };
        };
        // Split-and-retry once (2.1). A half that still truncates leaves the
        // batch unresolved, which is what stops the cursor below.
        const callWithSplit = async (items: DistillItem[]): Promise<{ written: number; unresolved: boolean }> => {
          const first = await callEngine(items);
          if (!first.truncated) return { written: first.written, unresolved: false };
          if (!retryOnTruncation || items.length <= 1) return { written: first.written, unresolved: true };
          const mid = Math.ceil(items.length / 2);
          const halves = await Promise.all([callEngine(items.slice(0, mid)), callEngine(items.slice(mid))]);
          return {
            written: first.written + halves.reduce((a, h) => a + h.written, 0),
            unresolved: halves.some((h) => h.truncated),
          };
        };
        let wrote = 0;
        let chunksIssued = 0;
        let truncatedRuns = 0;
        const stageCalls: unknown[] = [];
        // A chunk that hits the cap stops the run cleanly: cursors keep the work
        // that already landed, and the gap is recorded for the next day.
        let truncationStalled = false;
        // Read from opts.env, not process.env: the scheduler's configuration
        // surface is opts.env everywhere else (dailyLimit, gates), and a knob
        // that only honours process.env is untestable and silently divergent.
        const retryOnTruncation = String(this.opts.env?.FD_MEMORY_EXTRACT_RETRY_ON_TRUNCATION ?? "1") !== "0";
        const gapsLimit = Math.max(1, Number(this.opts.env?.FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS ?? 3) || 3);
        const maxCalls = this.maxCallsPerRun();
        const runChunks = async (batches: Array<() => Promise<void>>): Promise<void> => {
          for (const run of batches) {
            // Out of call budget: everything that landed has its cursor written,
            // so this is a clean stop, not a failure — the next drain resumes.
            if (chunksIssued >= maxCalls) return;
            try { await run(); }
            catch (e) {
              if ((e as Error)?.message === "daily_budget_exhausted") {
                root.db.upsertDistillState(project, { last_error: "daily_budget_exhausted", gaps: (state?.gaps ?? 0) + 1, next_attempt_at: tomorrowMs(this.now()) });
                this.log.warn(`[distill] ${key}: daily budget hit mid-run (${this.opts.tokens.distillBudgetUsed(rootKey, day).tokens}/${this.dailyLimit()}) — stopping, cursors kept`);
                return;
              }
              throw e;
            }
            // The batch could not be distilled without truncation: leave the
            // cursor where it is so the material comes back next round, and
            // stop the run (a bigger batch behind it would truncate too).
            if (truncationStalled) return;
          }
        };
        await runChunks(Array.from({ length: Math.ceil(handoffs.length / CHUNK) }, (_, c) => async () => {
          const batch = handoffs.slice(c * CHUNK, c * CHUNK + CHUNK);
          const out = await callWithSplit(batch.map((h) => ({ kind: "handoff" as const, session_id: h.id, at: h.created_at, summary: `${cap(h.summary)}｜next: ${cap(h.next_steps)}`, agent: h.from_agent })));
          wrote += out.written;
          if (out.unresolved) { truncationStalled = true; return void holdCursorForTruncation(root, project, key, state, { log: (m) => this.log.warn(m), now: () => this.now(), maxGaps: gapsLimit }); }
          root.db.upsertDistillState(project, { handoff_cursor: batch[batch.length - 1].created_at, last_tokens: spentTotal });
        }));
        await runChunks(Array.from({ length: Math.ceil(notes.length / CHUNK) }, (_, c) => async () => {
          const batch = notes.slice(c * CHUNK, c * CHUNK + CHUNK);
          const out = await callWithSplit(batch.map((n) => ({ kind: "observation" as const, session_id: n.path, at: n.updated_at, event: "user-prompt-submit", tool: "memory_write_page", summary: `${cap(n.title)}：${cap(n.body)}`, agent: "user" })));
          wrote += out.written;
          if (out.unresolved) { truncationStalled = true; return void holdCursorForTruncation(root, project, key, state, { log: (m) => this.log.warn(m), now: () => this.now(), maxGaps: gapsLimit }); }
          root.db.upsertDistillState(project, { note_cursor: batch[batch.length - 1].updated_at, last_tokens: spentTotal });
        }));
        // The ledger was already fed per call (7.3); only the run-level metrics
        // report the total here.
        noteDistill(true, wrote, spentTotal, undefined, { items: handoffs.length + notes.length, calls: chunksIssued });
        noteDistillStages(stageCalls);
        noteDistillTruncation(truncatedRuns > 0);
        // Persisted too: the in-process ratio resets on every roll.
        this.opts.tokens.distillRunAdd(rootKey, day, truncatedRuns > 0);
        if (truncatedRuns > 0) this.log.warn(`[distill] ${key}: extract hit the completion ceiling in ${truncatedRuns} chunk(s) — output may be truncated (trunc=yes)`);
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
      // d-root path (fix-distill-extract-truncation step 2). This is the shape
      // that produced "120 items -> 4 pages": the whole backlog went in ONE
      // extract call, hit the 6,000 ceiling, and the cursors advanced anyway —
      // so the rest of the material was gone with no error recorded. Same
      // treatment as the chunked u-root path: split once, and hold the cursors
      // when a half still truncates.
      const retryOnTruncation = String(this.opts.env?.FD_MEMORY_EXTRACT_RETRY_ON_TRUNCATION ?? "1") !== "0";
      const gapsLimit = Math.max(1, Number(this.opts.env?.FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS ?? 3) || 3);
      const stageCalls: unknown[] = [];
      let wrote = 0;
      let billed = 0;
      let engineCalls = 0;
      const callOnce = async (batch: DistillItem[]): Promise<{ written: number; truncated: boolean; stopped?: boolean }> => {
        // Per-call budget re-read on the d-root path (2026-11-13). The check at
        // the top of distillOne runs ONCE per invocation, and one d-root run is
        // up to three calls (extract + two truncation halves) — measured on the
        // completed UTC day 11-12: owner d-KkCie7… billed 1,256,968 against a
        // 1,200,000 cap with per_run = 179,567, i.e. 41,968 past the "cap + one
        // call" allowance. u-roots have re-read per chunk since 7.3; d-roots did
        // not, so that invariant only held on one of the two paths. Same error
        // name and same log line as the u-root branch, so the ops check's
        // `daily budget hit mid-run` evidence now covers both families.
        const spentNow = this.opts.tokens.distillBudgetUsed(rootKey, day).tokens;
        if (spentNow >= this.dailyLimit()) {
          root.db.upsertDistillState(project, {
            last_error: "daily_budget_exhausted",
            gaps: (state?.gaps ?? 0) + 1,
            next_attempt_at: tomorrowMs(this.now()),
          });
          this.log.warn(`[distill] ${key}: daily budget hit mid-run (${spentNow}/${this.dailyLimit()}) — stopping, cursors kept`);
          noteDistillStages(stageCalls);
          noteDistill(true, wrote, billed, undefined, { items: items.length, calls: engineCalls });
          return { written: 0, truncated: false, stopped: true };
        }
        const candidates = await this.selectCandidates(root, project, queryFor);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SIDECCAR_TIMEOUT_MS);
        let res: Response;
        try {
          res = await (this.opts.fetchImpl ?? fetch)(`${this.url()}/distill`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.env?.DISTILLER_SHARED_TOKEN ?? ""}` },
            body: JSON.stringify({ scope: `${rootKey}/${project}`, cursor: { obs: state?.obs_cursor ?? 0, handoff: state?.handoff_cursor ?? "" }, items: batch, candidates }),
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
          writeEntryVector(root, rel, fact, this.log);
        }
        for (const exp of result.experiences ?? []) {
          const entry = normalizeEntry(exp, "experience");
          entry.supersedes = [...entry.supersedes, ...dedupeSupersedes(String(entry.task ?? ""), "experience")];
          const rel = root.writeDistillPage(project, "experience", entry, audit);
          writeEntryVector(root, rel, exp, this.log);
        }
        for (const c of result.llm_calls ?? []) stageCalls.push(c);
        engineCalls += result.llm_calls?.length ?? 0;
        billed += result.tokens ?? 0;
        const pages = (result.facts?.length ?? 0) + (result.experiences?.length ?? 0);
        wrote += pages;
        if ((result.tokens ?? 0) > 0) this.opts.tokens.distillBudgetAdd(rootKey, day, result.tokens ?? 0, result.llm_calls?.length ?? 0);
        return { written: pages, truncated: extractHitCeiling(result.llm_calls, EXTRACT_MAX_TOKENS) };
      };

      let unresolved = false;
      const first = await callOnce(items);
      // Budget ran out between the run-level check and this call (or between
      // chunks): state and log are already written — just stop, cursors kept.
      if (first.stopped) return;
      const truncated = first.truncated;
      if (first.truncated) {
        // The split costs two more calls; with the lane at ~1 min per call that
        // cannot fit the same request, so the batch is held for the next round
        // (existing holdCursorForTruncation path) instead of stalling mid-split.
        const canAffordSplit = 1 + 2 <= this.maxCallsPerRun();
        if (retryOnTruncation && items.length > 1 && canAffordSplit) {
          const mid = Math.ceil(items.length / 2);
          const halves = await Promise.all([callOnce(items.slice(0, mid)), callOnce(items.slice(mid))]);
          if (halves.some((h) => h.stopped)) return;
          unresolved = halves.some((h) => h.truncated);
        } else {
          unresolved = true;
        }
      }

      if (unresolved) {
        holdCursorForTruncation(root, project, key, state, { log: (m) => this.log.warn(m), now: () => this.now(), maxGaps: gapsLimit });
        noteDistillTruncation(true);
        this.opts.tokens.distillRunAdd(rootKey, day, true);
        noteDistillStages(stageCalls);
        noteDistill(true, wrote, billed, undefined, { items: items.length, calls: engineCalls });
        return;
      }

      const maxRid = obs.length ? Math.max(...obs.map((o) => o.rid)) : (state?.obs_cursor ?? 0);
      const maxHandoff = handoffs.length ? handoffs[handoffs.length - 1].created_at : (state?.handoff_cursor ?? "");
      // note cursor is scheduler-local (the engine knows nothing of notes):
      // last note's updated_at, monotonic like handoff_cursor
      const maxNote = notes.length ? notes[notes.length - 1].updated_at : (state?.note_cursor ?? "");
      root.db.upsertDistillState(project, {
        obs_cursor: maxRid,
        handoff_cursor: maxHandoff > (state?.handoff_cursor ?? "") ? String(maxHandoff) : (state?.handoff_cursor ?? ""),
        note_cursor: maxNote > (state?.note_cursor ?? "") ? maxNote : (state?.note_cursor ?? ""),
        last_error: null,
        last_tokens: billed,
        next_attempt_at: 0,
      });
      noteDistill(true, wrote, billed, undefined, { items: items.length, calls: engineCalls });
      noteDistillStages(stageCalls);
      noteDistillTruncation(truncated);
      this.opts.tokens.distillRunAdd(rootKey, day, truncated);
      if (truncated) this.log.warn(`[distill] ${key}: extract hit the completion ceiling — output may be truncated (trunc=yes)`);
      this.log.log(`[distill] ${key}: ${wrote} pages from ${items.length} items, ${billed.toLocaleString()} tokens`);
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
        await this.promotionPassSafe(rootKey, project);
      } finally {
        this.inflight.delete(key);
        this.rootInflight.delete(rootKey);
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

  // promotionPass with the same posture as tagPassSafe (tasks 3.2): a
  // promotion failure is a warning line, never a distillation failure.
  private async promotionPassSafe(rootKey: string, project: string): Promise<void> {
    try {
      const root = this.opts.roots.get(rootKey) ?? this.opts.openRoot(rootKey);
      await this.promotionPass(root, rootKey, project, root.db.getDistillState(project) ?? null);
    } catch (e) {
      this.log.warn(`[promo] ${rootKey}/${project}: skipped (${(e as Error)?.message ?? e})`);
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
// Cursor hold for a batch that truncates even when split (2.2 + 2.4).
//
// Holding the cursor is what keeps the material: the next run re-submits the
// same batch. But a batch that can never be distilled would then stall its
// project forever, so after a few consecutive holds we step over it — and the
// step-over leaves a distinct error code, because "we skipped it on purpose" and
// "we lost it silently" must not look the same in the ledger.
function holdCursorForTruncation(
  root: StoreRoot,
  project: string,
  key: string,
  state: { gaps?: number } | undefined,
  sched: { log: (m: string) => void; now: () => number; maxGaps: number },
): void {
  const gaps = (state?.gaps ?? 0) + 1;
  const giveUp = gaps >= Math.max(1, sched.maxGaps);
  root.db.upsertDistillState(project, {
    last_error: giveUp ? "extract_truncated_skipped" : "extract_truncated",
    gaps,
    next_attempt_at: giveUp ? 0 : sched.now() + 15 * 60_000,
  });
  sched.log(giveUp
    ? `[distill] ${key}: extract truncated ${gaps}x — stepping over this batch (extract_truncated_skipped); it will not be retried`
    : `[distill] ${key}: extract truncated even after splitting — cursor held, this batch retries next round (gap ${gaps})`);
}

export async function hybridCandidates(opts: {
  root: StoreRoot;
  project: string;
  // Multi-partition recall (optimize-yongyi-read-surfaces 6.1): one request can
  // span several partitions, so the caller may pass the whole set. Omitted =
  // the historical [project, "shared"] union, byte-for-byte the old behavior.
  projects?: string[];
  queryFor: string;
  k?: number;
  embed: (texts: string[]) => Promise<{ vectors: number[][]; model: string; tokens: number }>;
  log?: { warn: (msg: string) => void };
}): Promise<Array<DistillCandidate & { score?: number }>> {
  const { root, project, queryFor, k = 8, embed, log } = opts;
  const projects = opts.projects && opts.projects.length
    ? [...new Set(opts.projects)]
    : project === "shared" ? [project] : [project, "shared"];
  const keyword = distillCandidates(root, projects, queryFor);
  // An empty query has no vector to compute (2026-10-29): the sidecar rejects
  // blank input with 400 texts_required, and the caller turned that into
  // "vector lane unavailable — keyword-only recall" — an input-validation
  // answer reported as an infrastructure outage. That mislabel is how a false
  // degradation reaches the operator: the lane was fine, the query was empty.
  // Skip the embed call entirely; keyword recall is the whole answer here.
  if (!queryFor.trim()) return keyword;
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
          id: m[3], kind, project: m[1],
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
    if (modelMismatch > 0) {
      noteVectorEvent("mismatch_excluded", modelMismatch);
      // The recall gap is silent by construction (the filter simply hides the
      // rows), so this warning is the only signal that a model switch
      // stranded history. Actionable fix: POST /admin/reembed.
      log?.warn(`[hybrid] ${project}: ${modelMismatch} vector(s) on other models EXCLUDED from cosine — recall is running on a partial corpus; re-embed via POST /admin/reembed`);
    }
    return merged.slice(0, k);
  } catch (e) {
    log?.warn(`[hybrid] embed query failed — keyword-only candidates: ${(e as Error)?.message ?? e}`);
    return keyword.slice(0, k); // the fallback must honour k like the success path
  }
}

function writeEntryVector(root: StoreRoot, rel: string, entry: Record<string, unknown>, log?: { warn: (m: string) => void }): void {
  const v = (entry as { vector?: unknown }).vector;
  if (Array.isArray(v) && v.length > 0) {
    try {
      const model = String((entry as { vector_model?: unknown }).vector_model ?? "").trim();
      if (!model) {
        // The sidecar did not name its model: the vector could never be
        // matched by a query (allPageVectors filters by model), so storing it
        // is silent loss. Skip and count.
        noteVectorEvent("skipped_no_model");
        log?.warn(`[vector] ${rel}: embed response carried no model name — vector not stored`);
        return;
      }
      const out = root.db.setPageVectorGuarded(rel, model, new Float32Array(v as number[]), {
        policy: process.env.FD_MEMORY_EMBED_GUARD === "allow" ? "allow" : "reject",
      });
      if (!out.written) {
        noteVectorEvent("writes_rejected");
        log?.warn(`[vector] ${rel}: REFUSED off-model embedding (model=${model}, store dominant=${out.dominant}) — the vector space must stay single-model; re-embed via POST /admin/reembed if the switch was intentional`);
      } else if (out.reason === "model_mismatch_allowed") {
        noteVectorEvent("writes_allowed");
        log?.warn(`[vector] ${rel}: off-model embedding stored by policy (model=${model}, dominant=${out.dominant}) — cosine against the dominant space is invalid until re-embedded`);
      }
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
