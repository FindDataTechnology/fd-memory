// Scene seeding, extracted from scripts/eval-continue.mjs so the fixture shape
// is unit-testable (add-digest-merge-eval-arm 1.2).
//
// Why it lives in src/ instead of the script: the merge comparison depends on
// material sitting in TWO partitions of the SAME root — if seeding silently
// wrote shared pages into the own project (or dropped them), both arms would
// read the same content and the comparison would be measuring nothing while
// still producing numbers. That failure is invisible from the outside, so the
// seeding path has to be assertable without spending an LLM call.
import type { ContinueScene } from "./continue-scenes.js";
import type { StoreRoot } from "./store.js";
import { newPage } from "./okf.js";

/** The pack's shared partition. Production shape is `d/<fleetId>/shared`. */
export const SHARED_PROJECT = "shared";

export function seedSceneHistory(
  root: StoreRoot,
  scene: ContinueScene,
  opts: { project?: string } = {}
): { project: string; sharedProject: string } {
  const project = opts.project ?? "agentEval";
  const audit = (p: string) => ({ principal: "eval:fixture", scope: `d-eval-${scene.id}/${p}` });

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
  // Shared partition (add-digest-merge-eval-arm 1.2): same root, project
  // "shared" — exactly what hybridCandidates sees when asked for
  // projects=[own,shared] the way the fleet turn asks.
  for (const p of scene.history.sharedPages ?? []) {
    root.writeDistillPage(SHARED_PROJECT, p.kind, {
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
      id: h.id,
      project,
      from_agent: "fixture",
      summary: h.summary,
      open_questions: "[]",
      next_steps: h.next_steps,
      files_touched: "[]",
      to_agent: h.to_agent ?? null,
      state: h.state,
      accepted_by: null,
      accepted_at: null,
      created_at: h.created_at,
    });
  }

  // L1 notes (add-chat-memory-injection): seeded exactly as the chat lane's MCP
  // write-back produces them — note pages under the project's notes/.
  // Recency backfill: indexPage stamps updated_at at load time (all notes in one
  // burst = same ms), which makes the digest L1 "recent 3" cut arbitrary and the
  // old-note ablation meaningless — restore the fixture's timestamps.
  for (const n of scene.history.notes ?? []) {
    const rel = root.writePage(project, "notes", n.id, newPage("note", n.title, n.body), audit(project));
    root.db.db.prepare("UPDATE pages SET updated_at=? WHERE path=?").run(n.updated_at, rel);
    root.db.db.prepare("UPDATE pages_fts SET updated_at=? WHERE path=?").run(n.updated_at, rel);
  }
  for (const n of scene.history.sharedNotes ?? []) {
    const rel = root.writePage(SHARED_PROJECT, "notes", n.id, newPage("note", n.title, n.body), audit(SHARED_PROJECT));
    root.db.db.prepare("UPDATE pages SET updated_at=? WHERE path=?").run(n.updated_at, rel);
    root.db.db.prepare("UPDATE pages_fts SET updated_at=? WHERE path=?").run(n.updated_at, rel);
  }

  // Reference 页（add-unified-memory-and-outputs eval 场景）: seed 薄索引页，
  // digest 名份车道在生产同款代码下读（只不过这里借 route 读面镜像）。
  for (const r of scene.history.references ?? []) {
    const rel = root.writePage(
      project,
      "references",
      r.id,
      newPage("reference", r.title, r.summary ?? "", {
        source_ref: r.source_ref ?? "resource:fixture",
        tags: r.tags ?? [],
        tier: r.tier ?? "draft",
      }),
      audit(project)
    );
    if (r.updated_at) {
      root.db.db.prepare("UPDATE pages SET updated_at=? WHERE path=?").run(r.updated_at, rel);
      root.db.db.prepare("UPDATE pages_fts SET updated_at=? WHERE path=?").run(r.updated_at, rel);
    }
  }

  return { project, sharedProject: SHARED_PROJECT };
}
