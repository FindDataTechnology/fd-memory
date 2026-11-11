// Fixture seeding tests (add-digest-merge-eval-arm 1.2): the merge comparison is
// only meaningful if own and shared material land in TWO partitions of the SAME
// root. A seeding bug that wrote everything into one project would leave both
// arms reading the same content — the run would still produce numbers, and they
// would be meaningless. Hence this assertable seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { seedSceneHistory, SHARED_PROJECT } from "../eval-fixtures.js";
import type { ContinueScene } from "../continue-scenes.js";

function scene(over: Partial<ContinueScene> = {}): ContinueScene {
  return {
    id: "m1",
    source: { root: "d-eval-m1", project: "agentEval" },
    review: "reviewed",
    boundary_at: "2026-10-24T00:00:00.000Z",
    task: "继续处理上次的排障：先给结论，再给下一步。",
    expected_background: ["own 侧结论", "shared 侧结论"],
    shared_expected_background: ["shared 侧结论"],
    history: {
      observations: [],
      handoffs: [],
      pages: [
        { id: "own_exp", kind: "experience", task: "own 任务", search_keys: ["own"], solution: "own 解法", updated_at: "2026-10-23T02:00:00.000Z", supersedes: [] },
      ],
      notes: [{ id: "own_note", title: "own note", body: "own note body", updated_at: "2026-10-23T03:00:00.000Z" }],
      sharedPages: [
        { id: "sh_exp", kind: "experience", task: "shared 任务", search_keys: ["shared"], solution: "shared 解法", updated_at: "2026-10-23T02:00:00.000Z", supersedes: [] },
      ],
      sharedNotes: [{ id: "sh_note", title: "shared note", body: "shared note body", updated_at: "2026-10-23T03:00:00.000Z" }],
    },
    ...over,
  };
}

test("own and shared material land in two partitions of the same root", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-eval-fx-"));
  try {
    const root = new StoreRoot(dir, "d-eval-m1");
    const { project, sharedProject } = seedSceneHistory(root, scene());

    const projects = root.db.distinctProjects().sort();
    assert.deepEqual(projects, [project, sharedProject].sort());
    assert.equal(sharedProject, SHARED_PROJECT);

    // The material must be where the arms will look for it — project separation,
    // not just a second project existing.
    const ownPages = root.db.recentPages(50, [project]).map((p) => p.path);
    const sharedPages = root.db.recentPages(50, [sharedProject]).map((p) => p.path);
    assert.ok(ownPages.some((p) => p.includes("own_exp")), `own pages: ${ownPages.join(",")}`);
    assert.ok(sharedPages.some((p) => p.includes("sh_exp")), `shared pages: ${sharedPages.join(",")}`);
    assert.ok(!sharedPages.some((p) => p.includes("own_exp")), "own material leaked into shared");
    assert.ok(!ownPages.some((p) => p.includes("sh_exp")), "shared material leaked into own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scene with no shared material still seeds cleanly (own-only stays valid)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-eval-fx-"));
  try {
    const root = new StoreRoot(dir, "d-eval-m2");
    const s = scene({ id: "m2" });
    s.history.sharedPages = [];
    s.history.sharedNotes = [];
    seedSceneHistory(root, s);
    assert.deepEqual(root.db.distinctProjects(), ["agentEval"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
