// Store roots: one physically isolated root per memory owner. Cross-owner
// data never shares a directory tree or a database file — isolation by
// construction, not by query discipline.
//
// v2 (add-memory-scopes-and-cluster-sharing): a d/ root is the PACK's root —
// members' projects and the shared project live in one tree; rootKey derives
// from namespaceParts so d/<packId> and d/<packId>/<agentId> meet in
// d-<packId>. Writes carry an optional audit identity (principal + scope)
// recorded as companion rows.

import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { RootDb, HandoffRow } from "./db.js";
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

// rootKey mirrors namespaceParts (v2): u/<user>… → u-<user>; d/<packId>[/<agentId>] → d-<packId>.
export function rootKeyForNamespace(ns: string): string {
  return namespaceParts(ns).rootKey;
}

export class StoreRoot {
  readonly rootDir: string;
  readonly wikiDir: string;
  readonly db: RootDb;
  private gitTimer: NodeJS.Timeout | null = null;

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
        execFileSync("git", ["-C", this.wikiDir, "config", "user.email", "fd-memory@finddata"], { stdio: "ignore" });
        execFileSync("git", ["-C", this.wikiDir, "config", "user.name", "fd-memory"], { stdio: "ignore" });
        this.gitAvailable = true;
      } catch {
        this.gitAvailable = false;
      }
    }
  }

  snapshotSoon(label: string): void {
    if (this.gitTimer) return;
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null;
      if (!this.gitAvailable) return;
      try {
        execFileSync("git", ["-C", this.wikiDir, "add", "-A"], { stdio: "ignore" });
        execFileSync("git", ["-C", this.wikiDir, "commit", "-q", "-m", label, "--allow-empty"], { stdio: "ignore" });
      } catch {
        /* git snapshot is best-effort; wiki writes are already durable */
      }
    }, 500);
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

  writePage(project: string, typeDir: string, slug: string, page: ReturnType<typeof newPage>, audit?: AuditIdentity): string {
    const dir = this.ensureProject(project);
    const rel = `${project}/${typeDir}/${slug}.md`;
    writePageFile(join(this.wikiDir, rel), page);
    this.db.indexPage(project, rel, String(page.frontmatter.type ?? "note"), String(page.frontmatter.title ?? slug), page.body, {
      sources: Array.isArray(page.frontmatter.sources) ? (page.frontmatter.sources as string[]) : [],
      supersedes: Array.isArray(page.frontmatter.supersedes) ? (page.frontmatter.supersedes as string[]) : [],
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
