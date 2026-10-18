// Store roots: one physically isolated root per memory owner. Cross-owner
// data never shares a directory tree or a database file — isolation by
// construction, not by query discipline.

import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { RootDb, HandoffRow } from "./db.js";
import { newPage, writePageFile, readPageFile, appendLedger, projectManifest } from "./okf.js";
import { sanitize } from "./sanitize.js";

export interface HandoffInput {
  summary: string;
  open_questions?: string[];
  next_steps?: string[];
  files_touched?: string[];
}

// rootKey: "u-<user>" (person, projects inside) | "d-<packId>--<agentId>" (deployment, single project)
export function rootKeyForNamespace(ns: string): string {
  return ns.replace(/^u\//, "u-").replace(/^d\//, "d-").replace(/\//g, "--");
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
    this.db = new RootDb(join(this.rootDir, "db", "memory.sqlite"));
    this.ensureGit();
  }

  private ensureGit(): void {
    try {
      execFileSync("git", ["-C", this.wikiDir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    } catch {
      execFileSync("git", ["init", "-q"], { cwd: this.wikiDir });
      execFileSync("git", ["-C", this.wikiDir, "config", "user.email", "fd-memory@finddata"]);
      execFileSync("git", ["-C", this.wikiDir, "config", "user.name", "fd-memory"]);
    }
  }

  snapshotSoon(label: string): void {
    if (this.gitTimer) return;
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null;
      try {
        execFileSync("git", ["-C", this.wikiDir, "add", "-A"], { stdio: "ignore" });
        execFileSync("git", ["-C", this.wikiDir, "commit", "-q", "-m", label, "--allow-empty"], { stdio: "ignore" });
      } catch {
        /* git snapshot is best-effort; wiki writes are already durable */
      }
    }, 500);
  }

  // projectDir: for persons the p/<name> segment; deployments use "default".
  projectDir(project: string): string {
    return join(this.wikiDir, project);
  }

  ensureProject(project: string): string {
    const dir = this.projectDir(project);
    mkdirSync(dir, { recursive: true });
    projectManifest(dir, project);
    return dir;
  }

  writePage(project: string, typeDir: string, slug: string, page: ReturnType<typeof newPage>): string {
    const dir = this.ensureProject(project);
    const rel = `${project}/${typeDir}/${slug}.md`;
    writePageFile(join(this.wikiDir, rel), page);
    this.db.indexPage(project, rel, String(page.frontmatter.type ?? "note"), String(page.frontmatter.title ?? slug), page.body);
    this.snapshotSoon(`page: ${rel}`);
    return rel;
  }

  readPageByRel(rel: string) {
    const full = join(this.wikiDir, rel);
    if (!existsSync(full)) return undefined;
    return readPageFile(full);
  }

  beginHandoff(project: string, fromAgent: string, input: HandoffInput): HandoffRow {
    const id = randomUUID();
    const row: HandoffRow = {
      id,
      project,
      from_agent: fromAgent,
      summary: sanitize(input.summary),
      open_questions: JSON.stringify(input.open_questions ?? []),
      next_steps: JSON.stringify(input.next_steps ?? []),
      files_touched: JSON.stringify(input.files_touched ?? []),
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
    }));
    appendLedger(this.projectDir(project), "handoff_begin", `from ${fromAgent}`);
    return row;
  }

  private handoffBody(h: HandoffRow): string {
    const lines = (title: string, arr: string[]) => (arr.length ? `\n## ${title}\n` + arr.map((s) => `- ${s}`).join("\n") : "");
    return (
      `## Summary\n${h.summary}` +
      lines("Open questions", JSON.parse(h.open_questions || "[]")) +
      lines("Next steps", JSON.parse(h.next_steps || "[]")) +
      lines("Files touched", JSON.parse(h.files_touched || "[]"))
    );
  }

  // Claim-once: two independent state guards (SELECT then conditional UPDATE),
  // mirroring the upstream protocol semantics.
  acceptHandoff(id: string, byAgent: string): { claimed: boolean; handoff?: HandoffRow; already?: string } {
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
    appendLedger(this.projectDir(row.project), "handoff_accept", `by ${byAgent}`);
    this.snapshotSoon(`handoff claim: ${id}`);
    return { claimed: true, handoff: row };
  }

  cancelHandoff(id: string): boolean {
    const row = this.db.getHandoff(id);
    if (!row || row.state !== "open") return false;
    this.db.db.prepare("UPDATE handoffs SET state='cancelled' WHERE id=? AND state='open'").run(id);
    const rel = `${row.project}/handoffs/${id}.md`;
    const page = this.readPageByRel(rel);
    if (page) {
      page.frontmatter.state = "cancelled";
      writePageFile(join(this.wikiDir, rel), page);
    }
    return true;
  }
}
