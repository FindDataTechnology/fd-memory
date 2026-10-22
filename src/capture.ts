// Capture API: hooks-shaped lifecycle events from the platform seam (runner
// manager) or from local nodes. Identity comes from the token; events land in
// the token's namespace only.

import { StoreRoot, AuditIdentity } from "./store.js";
import { newPage, appendLedger } from "./okf.js";
import { sanitize } from "./sanitize.js";

export interface CaptureEvent {
  event:
    | "session-start"
    | "user-prompt-submit"
    | "pre-tool-use"
    | "post-tool-use"
    | "stop"
    | "session-end";
  session_id: string;
  agent?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: string;
  summary?: string;
  at?: string;
}

const SUMMARY_MAX = 2000;

function summaryOf(e: CaptureEvent): string {
  const raw =
    e.summary ??
    (e.event === "user-prompt-submit" || (e.event === "post-tool-use" && e.tool_input)
      ? String(e.tool_input ?? "")
      : "");
  return sanitize(String(raw).slice(0, SUMMARY_MAX));
}

export class CaptureIngest {
  constructor(
    private roots: Map<string, StoreRoot>,
    private openRoot: (rootKey: string) => StoreRoot,
  ) {}

  ingest(rootKey: string, project: string, events: CaptureEvent[], audit?: AuditIdentity): { stored: number } {
    const root = this.roots.get(rootKey) ?? this.openRoot(rootKey);
    if (!this.roots.has(rootKey)) this.roots.set(rootKey, root);
    root.ensureProject(project);
    let stored = 0;
    const sessions = new Set<string>();
    for (const e of events) {
      if (!e || typeof e.event !== "string" || typeof e.session_id !== "string") continue;
      const agent = sanitize(String(e.agent ?? "platform"));
      root.db.addObservation({
        session_id: e.session_id,
        agent,
        event: e.event,
        tool: e.tool_name ? sanitize(String(e.tool_name)) : null,
        summary: summaryOf(e),
        created_at: e.at ?? new Date().toISOString(),
        project,
      });
      sessions.add(e.session_id);
      stored++;
    }
    for (const sid of sessions) {
      const rel = `${project}/sessions/${sid}.md`;
      if (!root.readPageByRel(rel)) {
        root.writePage(project, "sessions", sid, newPage("session", `Session ${sid.slice(0, 8)}`, `session_id: ${sid}\n`));
      }
    }
    const dir = root.projectDir(project);
    for (const e of events) {
      if (!e || typeof e.event !== "string") continue;
      appendLedger(dir, e.event, `${e.session_id.slice(0, 8)}${e.tool_name ? " " + sanitize(e.tool_name) : ""}`, e.at ? new Date(e.at) : undefined);
    }
    if (audit && stored > 0) {
      try {
        root.db.addWrite(audit.principal, audit.scope, project, "capture_batch");
      } catch {
        /* companion record only */
      }
    }
    root.snapshotSoon(`capture: ${stored} events`);
    return { stored };
  }
}
