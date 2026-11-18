// Store roots: one physically isolated root per memory owner. Cross-owner
// data never shares a directory tree or a database file — isolation by
// construction, not by query discipline.
//
// v2 (add-memory-scopes-and-cluster-sharing): a d/ root is the PACK's root —
// members' projects and the shared project live in one tree; rootKey derives
// from namespaceParts so d/<packId> and d/<packId>/<agentId> meet in
// d-<packId>. Writes carry an optional audit identity (principal + scope)
// recorded as companion rows.

import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { RootDb, HandoffRow, ObservationRow, observationDigest } from "./db.js";
import { namespaceParts } from "./auth.js";
import { newPage, writePageFile, readPageFile, appendLedger, projectManifest, workspaceManifest } from "./okf.js";
import { sanitize } from "./sanitize.js";

export interface HandoffInput {
  summary: string;
  open_questions?: string[];
  next_steps?: string[];
  files_touched?: string[];
  to_agent?: string;
}

export interface AuditIdentity {
  principal: string;
  scope: string;
}

// Structured metadata validation (add-agent-memory-foundation): keys ≤ 32,
// values limited to scalars or arrays of scalars (≤ 32 items, each ≤ 256
// chars). Returns `undefined` for absent input, `null` for INVALID input —
// callers turn null into a structured 400, never a silent drop.
const META_MAX_KEYS = 32;
const META_MAX_ARRAY = 32;
const META_MAX_VALUE_CHARS = 256;

export function normalizeMetadata(v: unknown): Record<string, unknown> | null | undefined {
  if (v === undefined || v === null) return v === null ? null : undefined;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > META_MAX_KEYS) return null;
  const out: Record<string, unknown> = {};
  const scalarOk = (x: unknown): boolean =>
    typeof x === "string" || typeof x === "number" || typeof x === "boolean";
  for (const [k, val] of entries) {
    if (!k.trim() || k.length > 64) return null;
    if (Array.isArray(val)) {
      if (val.length > META_MAX_ARRAY) return null;
      const arr: Array<string | number | boolean> = [];
      for (const item of val) {
        if (!scalarOk(item)) return null;
        if (String(item).length > META_MAX_VALUE_CHARS) return null;
        arr.push(item as string | number | boolean);
      }
      out[k] = arr;
    } else if (scalarOk(val)) {
      if (String(val).length > META_MAX_VALUE_CHARS) return null;
      out[k] = val;
    } else {
      return null;
    }
  }
  return out;
}

// rootKey mirrors namespaceParts (v2): u/<user>… → u-<user>; d/<packId>[/<agentId>] → d-<packId>.
export function rootKeyForNamespace(ns: string): string {
  return namespaceParts(ns).rootKey;
}

export class StoreRoot {
  readonly rootDir: string;
  readonly wikiDir: string;
  readonly db: RootDb;
  private gitTimer: NodeJS.Timeout | null = null;
  /** Serialises git add/commit pairs — two overlapping runs race on index.lock. */
  private snapshotInFlight = false;
  /** When the last snapshot completed; drives the throttle window. */
  private lastSnapshotAt = 0;
  /** Most recent label awaiting a snapshot ("" means "already captured"). */
  private pendingSnapshotLabel: string | null = null;

  constructor(dataDir: string, rootKey: string) {
    this.rootDir = join(dataDir, "owners", rootKey);
    this.wikiDir = join(this.rootDir, "wiki");
    mkdirSync(this.wikiDir, { recursive: true });
    workspaceManifest(this.wikiDir);
    this.db = new RootDb(join(this.rootDir, "db", "memory.sqlite"));
    this.ensureGit();
  }

  // Git is OPTIONAL (node:22-slim ships no git): without it the wiki is still
  // the durable truth on the PV — snapshots are a best-effort bonus (and the
  // daily snapshot cron on the host does the versioning when git exists).
  private gitAvailable = false;

  private ensureGit(): void {
    try {
      execFileSync("git", ["-C", this.wikiDir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
      this.gitAvailable = true;
    } catch {
      try {
        execFileSync("git", ["init", "-q"], { cwd: this.wikiDir, stdio: "ignore" });
        execFileSync("git", ["-C", this.wikiDir, "config", "user.email", "fd-memory@localhost"], { stdio: "ignore" });
        execFileSync("git", ["-C", this.wikiDir, "config", "user.name", "fd-memory"], { stdio: "ignore" });
        // Compact sooner than git's default (2026-11-19). The wiki commits once
        // per page write, so loose objects accumulate fast: measured 5,729 loose
        // objects / 426MB after ~17k commits, against a default threshold of
        // 6,700 — it would have grown for days more before tripping. 500 keeps
        // the repo small with a cheap check on each snapshot.
        execFileSync("git", ["-C", this.wikiDir, "config", "gc.auto", "500"], { stdio: "ignore" });
        this.gitAvailable = true;
      } catch {
        this.gitAvailable = false;
      }
    }
  }

  /**
   * Wiki snapshot to git — ASYNC and throttled (2026-11-18 root cause).
   *
   * The bug this replaces: every `writePage` scheduled a 500ms timer that ran
   * `execFileSync("git", ["add","-A"])` + `execFileSync("git", ["commit"])` ON
   * THE EVENT LOOP. Measured: the wiki's `.git` was 504MB with **16,655
   * commits**, and one `git add -A` took 0.13–0.24s when the machine was idle —
   * far worse under load. `/observe` runs ~9×/min, so the loop was being
   * blocked continuously. The stall watchdog caught 2.4 / 2.6 / 4.3 / 4.5 /
   * 6.7 / 8.8 / 9.0-second stalls, every one labelled `POST /observe`.
   *
   * Why it took fifteen rounds to find: every hypothesis pointed at I/O,
   * slow queries, or connections — and SQLite queries genuinely measured
   * 0.01–0.03s. The cost was never the disk; it was walking a repo index that
   * had grown to sixteen thousand commits.
   *
   * Two changes, both needed:
   *  · `execFile` instead of `execFileSync` — the git work moves off the loop.
   *  · THROTTLE_MS between commits — one commit per page was the actual source
   *     of the growth. A snapshot is a recovery aid, not a per-write guarantee,
   *     so batching is the right trade.
   *
   * `inFlight` serialises runs: two overlapping `git add`/`commit` pairs race
   * on `index.lock`, and a failed pair was silently swallowed before.
   */
  private static readonly SNAPSHOT_DEBOUNCE_MS = 500;
  private static readonly SNAPSHOT_THROTTLE_MS = 30_000;

  snapshotSoon(label: string): void {
    this.pendingSnapshotLabel = label;
    if (this.gitTimer || this.snapshotInFlight) return;
    // If a snapshot ran recently, wait out the remainder of the throttle rather
    // than dropping the request: the last write before a quiet period must
    // still land, otherwise the git history silently stops at the last busy
    // moment.
    const since = Date.now() - this.lastSnapshotAt;
    const wait = Math.max(StoreRoot.SNAPSHOT_DEBOUNCE_MS, StoreRoot.SNAPSHOT_THROTTLE_MS - since);
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null;
      this.runSnapshot();
    }, wait);
    this.gitTimer.unref?.();
  }

  private runSnapshot(): void {
    if (this.snapshotInFlight || !this.gitAvailable) return;
    this.snapshotInFlight = true;
    const label = this.pendingSnapshotLabel ?? "snapshot";
    const done = () => {
      this.snapshotInFlight = false;
      this.lastSnapshotAt = Date.now();
      // A write may have arrived while this run was in flight; schedule once
      // more so the final state is captured rather than lost.
      if (this.pendingSnapshotLabel !== null && this.pendingSnapshotLabel !== label) {
        this.pendingSnapshotLabel = null;
        this.snapshotSoon("");
      }
    };
    execFile("git", ["-C", this.wikiDir, "add", "-A"], { timeout: 120_000 }, (err) => {
      if (err) return done(); // best-effort: wiki writes are already durable
      execFile("git", ["-C", this.wikiDir, "commit", "-q", "-m", label, "--allow-empty"], { timeout: 120_000 }, () => {
        // Opportunistic compaction (2026-11-19). Measured: the wiki's `.git` had
        // grown to 510MB — 426MB of it LOOSE objects from 17,355 commits, one
        // per page write. `git gc` packed it to 71MB in one run (442MB back).
        //
        // `--auto` (not a plain `gc`) is the point: it is a no-op unless the
        // repo is over `gc.auto`, so the steady state costs one cheap
        // `count-objects` check. We also lower `gc.auto` (see the constructor)
        // because the default 6,700-object threshold took days to trip in a repo
        // that commits this often.
        //
        // Not awaited and errors ignored: a compaction failure must never block
        // or fail a page write — the wiki content is already durable, the git
        // history is a recovery aid.
        execFile("git", ["-C", this.wikiDir, "gc", "--auto", "--quiet"], { timeout: 600_000 }, () => done());
      });
    });
  }

  // projectDir: the project's wiki subtree (persons may carry p/<name>, d/
  // members use their agentId, the shared area is "shared").
  projectDir(project: string): string {
    return join(this.wikiDir, project);
  }

  ensureProject(project: string): string {
    const dir = this.projectDir(project);
    mkdirSync(dir, { recursive: true });
    projectManifest(dir, project);
    return dir;
  }

  // appendObservation: the L0 capture lane's durable write.
  //
  // Why this exists (change yongyi-multi-agent-memory-plane, requirement
  // "L0 捕获流 MUST 为 append-only 且可重建索引"): the observations table used
  // to be the ONLY copy of hook-captured events — insert into SQLite, done.
  // That made it simultaneously truth and index, so switching storage backends
  // (or losing the DB file) lost events outright. Every other lane (pages,
  // handoffs) had the wiki as truth and could be rebuilt by `reindex`; this one
  // could not. Now the append-only JSONL under <project>/observations/_log/ is
  // the truth and the SQLite row is a rebuildable index.
  //
  // Order matters: the truth write happens FIRST and is never undone by an
  // index failure. A turn must not be blocked or lost because the index is
  // locked — that is exactly the failure mode we hit with SQLite under
  // concurrent writers (25ms busy_timeout, 1275 "database is locked" in a day).
  appendObservation(o: ObservationRow): { stored: boolean; indexed: boolean } {
    const dir = this.ensureProject(o.project ?? "default");
    const logDir = join(dir, "observations", "_log");
    mkdirSync(logDir, { recursive: true });
    const record = {
      session_id: o.session_id,
      agent: o.agent,
      event: o.event,
      tool: o.tool ?? null,
      summary: o.summary,
      created_at: o.created_at,
      project: o.project ?? "default",
    };
    // One JSON object per line: appended, never rewritten. Rotation is by
    // month so a single file stays bounded without needing a compaction pass.
    const logPath = join(logDir, `${o.created_at.slice(0, 7)}.jsonl`);
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");

    let indexed = true;
    try {
      this.db.addObservation(o);
    } catch (err) {
      // Truth is safe; the index can be rebuilt from the log. Surface it in the
      // return value so callers can report a degraded capture instead of a
      // failed one.
      indexed = false;
      console.error(`[appendObservation] truth written, index failed: ${(err as Error).message}`);
    }
    return { stored: true, indexed };
  }

  /**
   * Withdraw every observation an import harness wrote (change
   * add-harness-memory-import, requirement "导入记忆 MUST 标注来源并可整批撤回").
   *
   * Two properties this has to keep:
   *
   *  - **The log is never rewritten.** The retract appends a marker line naming
   *    each withdrawn row by digest (session_id + summary), then drops the index
   *    rows. `replayObservationsFromLog` collects markers before inserting, so a
   *    rebuild reproduces "withdrawn" instead of resurrecting rows the user asked
   *    to remove. Deleting from the log instead would make the truth mutable and
   *    lose the audit trail.
   *  - **A later re-import survives.** The marker carries one digest per withdrawn
   *    row and replay spends those allowances one at a time, so bytes appended
   *    after the retract (a deliberate re-import) are kept.
   *
   * Markers are written per project because the log is per project. The caller
   * reads back `markers`/`deleted` so "nothing matched" and "matched nothing
   * because the label is wrong" stay distinguishable.
   */
  retractObservations(labels: string[], at = new Date().toISOString()): { markers: number; projects: string[]; deleted: number } {
    const projects = this.db.projectsForAgentLabels(labels);
    let markers = 0;
    let deleted = 0;
    for (const project of projects) {
      const rows = this.db.observationsForAgentLabels(labels, project);
      if (rows.length === 0) continue;
      const dir = join(this.ensureProject(project), "observations", "_log");
      mkdirSync(dir, { recursive: true });
      const logPath = join(dir, `${at.slice(0, 7)}.jsonl`);
      const retracted = rows.map((r) => observationDigest(r.session_id, r.summary));
      appendFileSync(
        logPath,
        JSON.stringify({ _retract: true, labels, project, at, retracted }) + "\n",
        "utf8",
      );
      markers++;
      deleted += this.db.deleteObservationsByAgent(labels, project);
    }
    return { markers, projects, deleted };
  }

  writePage(project: string, typeDir: string, slug: string, page: ReturnType<typeof newPage>, audit?: AuditIdentity): string {
    const dir = this.ensureProject(project);
    const rel = `${project}/${typeDir}/${slug}.md`;
    writePageFile(join(this.wikiDir, rel), page);
    // Metadata (add-agent-memory-foundation): the frontmatter is the truth;
    // the SQLite column is the filterable mirror. Reindex reads the same key.
    const meta = page.frontmatter.metadata && typeof page.frontmatter.metadata === "object" && !Array.isArray(page.frontmatter.metadata)
      ? (page.frontmatter.metadata as Record<string, unknown>)
      : null;
    this.db.indexPage(project, rel, String(page.frontmatter.type ?? "note"), String(page.frontmatter.title ?? slug), page.body, {
      sources: Array.isArray(page.frontmatter.sources) ? (page.frontmatter.sources as string[]) : [],
      supersedes: Array.isArray(page.frontmatter.supersedes) ? (page.frontmatter.supersedes as string[]) : [],
      tags: Array.isArray(page.frontmatter.tags) ? (page.frontmatter.tags as string[]).map(String).slice(0, 5) : [],
      tier: ["draft", "stable", "canonical"].includes(String(page.frontmatter.tier)) ? String(page.frontmatter.tier) : "draft",
      source_ref: page.frontmatter.source_ref != null ? String(page.frontmatter.source_ref) : null,
      metadata: meta,
    });
    if (audit) this.audit(audit, rel, "page_write");
    this.snapshotSoon(`page: ${rel}`);
    return rel;
  }

  readPageByRel(rel: string) {
    const full = join(this.wikiDir, rel);
    if (!existsSync(full)) return undefined;
    return readPageFile(full);
  }

  private audit(a: AuditIdentity, pageRel: string, op: string): void {
    try {
      this.db.addWrite(a.principal, a.scope, pageRel, op);
    } catch {
      /* audit is a companion record; never fail the write it describes */
    }
  }

  beginHandoff(project: string, fromAgent: string, input: HandoffInput, audit?: AuditIdentity): HandoffRow {
    const id = randomUUID();
    const row: HandoffRow = {
      id,
      project,
      from_agent: fromAgent,
      summary: sanitize(input.summary),
      open_questions: JSON.stringify(input.open_questions ?? []),
      next_steps: JSON.stringify(input.next_steps ?? []),
      files_touched: JSON.stringify(input.files_touched ?? []),
      to_agent: input.to_agent ? sanitize(input.to_agent) : null,
      state: "open",
      accepted_by: null,
      accepted_at: null,
      created_at: new Date().toISOString(),
    };
    this.db.upsertHandoff(row);
    // The wiki page is the durable truth for handoff content; DB holds the
    // claim state and mirrors content for search.
    this.writePage(project, "handoffs", id, newPage("handoff", `Handoff ${id.slice(0, 8)}`, this.handoffBody(row), {
      handoff_id: id,
      state: "open",
      from_agent: fromAgent,
      ...(row.to_agent ? { to_agent: row.to_agent } : {}),
    }), audit);
    if (audit) this.audit(audit, `${project}/handoffs/${id}.md`, "handoff_begin");
    appendLedger(this.projectDir(project), "handoff_begin", `from ${fromAgent}${row.to_agent ? ` to ${row.to_agent}` : ""}`);
    return row;
  }

  private handoffBody(h: HandoffRow): string {
    const lines = (title: string, arr: string[]) => (arr.length ? `\n## ${title}\n` + arr.map((s) => `- ${s}`).join("\n") : "");
    return (
      `## Summary\n${h.summary}` +
      (h.to_agent ? `\n\n（定向交接：${h.to_agent}）` : "") +
      lines("Open questions", JSON.parse(h.open_questions || "[]")) +
      lines("Next steps", JSON.parse(h.next_steps || "[]")) +
      lines("Files touched", JSON.parse(h.files_touched || "[]"))
    );
  }

  // Claim-once: two independent state guards (SELECT then conditional UPDATE),
  // mirroring the upstream protocol semantics.
  acceptHandoff(id: string, byAgent: string, audit?: AuditIdentity): { claimed: boolean; handoff?: HandoffRow; already?: string } {
    const first = this.db.getHandoff(id);
    if (!first) return { claimed: false };
    if (first.state !== "open") return { claimed: false, already: first.accepted_by ?? first.state };
    const res = this.db
      .db // conditional update = second guard
      .prepare("UPDATE handoffs SET state='claimed', accepted_by=?, accepted_at=? WHERE id=? AND state='open'")
      .run(byAgent, new Date().toISOString(), id);
    if (res.changes === 0) {
      const again = this.db.getHandoff(id);
      return { claimed: false, already: again?.accepted_by ?? "claimed" };
    }
    const row = this.db.getHandoff(id)!;
    const rel = `${row.project}/handoffs/${id}.md`;
    const page = this.readPageByRel(rel);
    if (page) {
      page.frontmatter.state = "claimed";
      page.frontmatter.accepted_by = byAgent;
      writePageFile(join(this.wikiDir, rel), page);
    }
    if (audit) this.audit(audit, rel, "handoff_accept");
    appendLedger(this.projectDir(row.project), "handoff_accept", `by ${byAgent}`);
    this.snapshotSoon(`handoff claim: ${id}`);
    return { claimed: true, handoff: row };
  }

  // -- distiller products (add-memory-distiller) --------------------------------

  writeDistillPage(
    project: string,
    kind: "fact" | "experience",
    payload: {
      id: string;
      engine: string;
      confidence?: number;
      sources: string[];
      supersedes: string[];
      statement?: string; // fact
      subject?: string; // fact
      files?: string[];
      details?: string; // fact
      task?: string; // experience
      search_keys?: string[];
      solution?: string; // experience
      boundary_envs?: string; // experience
    },
    audit?: AuditIdentity,
  ): string {
    const title = String(payload.statement ?? payload.task ?? payload.id).slice(0, 120);
    const body =
      kind === "fact"
        ? `## Statement\n${sanitize(String(payload.statement ?? ""))}` +
          (payload.subject ? `\n\nsubject: ${sanitize(String(payload.subject))}` : "") +
          ((payload.files ?? []).length ? `\n\nfiles: ${payload.files!.map((f) => sanitize(String(f))).join(", ")}` : "") +
          (payload.details ? `\n\n## Details\n${sanitize(String(payload.details)).slice(0, 4000)}` : "")
        : `## Task\n${sanitize(String(payload.task ?? ""))}` +
          `\n\n## Solution\n${sanitize(String(payload.solution ?? ""))}` +
          (payload.boundary_envs ? `\n\nboundary_envs: ${sanitize(String(payload.boundary_envs))}` : "") +
          ((payload.search_keys ?? []).length ? `\n\nsearch_keys: ${payload.search_keys!.map((k) => sanitize(String(k))).join(", ")}` : "");
    const rel = this.writePage(
      project,
      kind === "fact" ? "facts" : "experiences",
      payload.id,
      newPage(kind, title, body, {
        sources: payload.sources,
        supersedes: payload.supersedes,
        ...(payload.confidence != null ? { confidence: payload.confidence } : {}),
      }),
      audit,
    );
    // generated.by rides the frontmatter via a rewrite (newPage already wrote
    // generated.process meta; the engine tag goes beside it)
    const page = this.readPageByRel(rel)!;
    page.frontmatter.generated = { ...(page.frontmatter.generated as Record<string, unknown> ?? {}), by: payload.engine };
    // search_keys is a first-class field the candidate scorer weights x2 — it
    // used to ride ONLY the body line, while the reader read frontmatter, so
    // that weight never fired (optimize-yongyi-read-surfaces 4.1). The body
    // line stays for readers of the page text; this is the indexable copy.
    if ((payload.search_keys ?? []).length > 0) {
      page.frontmatter.search_keys = payload.search_keys!.map((k) => sanitize(String(k))).filter(Boolean);
    }
    writePageFile(join(this.wikiDir, rel), page);
    return rel;
  }

  // Logical delete (memory-visibility): frontmark the truth, drop from every
  // derived read face; file and audit rows stay.
  forgetPage(rel: string, audit?: AuditIdentity): boolean {
    const page = this.readPageByRel(rel);
    if (!page || page.frontmatter.forgotten_at) return false;
    page.frontmatter.forgotten_at = new Date().toISOString();
    writePageFile(join(this.wikiDir, rel), page);
    this.db.deletePageIndex(rel);
    this.db.dropPageVector(rel);
    if (audit) this.audit(audit, rel, "forget");
    this.snapshotSoon(`forget: ${rel}`);
    return true;
  }

  cancelHandoff(id: string, audit?: AuditIdentity): boolean {
    const row = this.db.getHandoff(id);
    if (!row || row.state !== "open") return false;
    this.db.db.prepare("UPDATE handoffs SET state='cancelled' WHERE id=? AND state='open'").run(id);
    const rel = `${row.project}/handoffs/${id}.md`;
    const page = this.readPageByRel(rel);
    if (page) {
      page.frontmatter.state = "cancelled";
      writePageFile(join(this.wikiDir, rel), page);
    }
    if (audit) this.audit(audit, rel, "handoff_cancel");
    return true;
  }
}
