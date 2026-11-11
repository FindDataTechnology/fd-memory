// Entry-gate tests (add-continuation-eval task 2.3): unreviewed scenes and
// undersized scene sets are refused before any LLM spend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenes, ContinueScene } from "../continue-scenes.js";

function scene(over: Partial<ContinueScene> = {}): ContinueScene {
  return {
    id: "s01",
    source: { root: "d-demo-01", project: "site-heal" },
    review: "reviewed",
    boundary_at: "2026-10-24T00:00:00.000Z",
    task: "继续处理上次的爬虫自愈任务：先汇报当前结论，再给出下一步动作。",
    expected_background: ["爬虫 5xx 的根因是上游 DNS 超时", "已验证的修复是切备用 DNS"],
    history: {
      observations: [{ session_id: "srv-1", event: "user-prompt-submit", summary: "查爬虫 5xx", created_at: "2026-10-23T01:00:00.000Z" }],
      handoffs: [],
      pages: [{ id: "exp_1", kind: "experience", task: "排障 5xx", search_keys: ["5xx"], solution: "切备用 DNS", confidence: 0.8, updated_at: "2026-10-23T02:00:00.000Z", supersedes: [] }],
    },
    ...over,
  };
}

function note(ok: boolean) {
  return ok
    ? { id: "n1", title: "报表口径偏好", body: "表头一律中文；数据源优先 akshare。", updated_at: "2026-10-23T00:00:00.000Z" }
    : ({ title: "缺字段" } as never);
}

test("a full valid set passes", () => {
  const scenes: ContinueScene[] = [];
  for (const project of ["site-heal", "web", "planner"]) {
    for (let i = 0; i < 4; i++) {
      const s = scene({ id: `${project}-${i}`, source: { root: "d-x", project } });
      if (i === 0) s.history.notes = [note(true)];
      scenes.push(s);
    }
  }
  const v = validateScenes(scenes);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("set without note scenes is refused (L1 recall lane must stay covered)", () => {
  const scenes: ContinueScene[] = [];
  for (const project of ["site-heal", "web", "planner"]) {
    for (let i = 0; i < 4; i++) scenes.push(scene({ id: `${project}-${i}`, source: { root: "d-x", project } }));
  }
  const v = validateScenes(scenes);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /note 场景数 0 < 3/);
});

test("malformed note is refused; notes-only history counts as non-empty", () => {
  const base = () => {
    const scenes: ContinueScene[] = [];
    for (const project of ["site-heal", "web", "planner"]) {
      for (let i = 0; i < 4; i++) {
        const s = scene({ id: `${project}-${i}`, source: { root: "d-x", project } });
        if (i === 0) s.history.notes = [note(true)];
        scenes.push(s);
      }
    }
    return scenes;
  };
  const bad = base();
  bad[0].history.notes = [note(false)];
  const vBad = validateScenes(bad);
  assert.equal(vBad.ok, false);
  assert.match(vBad.errors.join(";"), /note 缺 id\/title\/body\/updated_at/);

  const notesOnly = base();
  notesOnly[0].history = { observations: [], handoffs: [], pages: [], notes: [note(true)] };
  const vOk = validateScenes(notesOnly);
  assert.equal(vOk.ok, true, JSON.stringify(vOk.errors));
});

test("undersized set is refused regardless of quality", () => {
  const v = validateScenes([scene(), scene()]);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /场景数 2 < 12/);
});

test("pending review blocks the run", () => {
  const scenes = Array.from({ length: 12 }, (_, i) => scene({ id: `s${i}`, review: i === 3 ? "pending" : "reviewed" }));
  const v = validateScenes(scenes);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /s3: review != reviewed/);
});

test("thin expected-background and empty history are refused", () => {
  const scenes = Array.from({ length: 12 }, () => scene({ id: "x" }));
  scenes[0].expected_background = ["仅一条"];
  scenes[1].history = { observations: [], handoffs: [], pages: [] };
  const v = validateScenes(scenes);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /期望背景集合 <2/);
  assert.match(v.errors.join(";"), /前史为空/);
});

// ── merge-arm coverage gate (add-digest-merge-eval-arm 1.1) ──────────────────
// Separate gate from validateScenes: old own-only sets must keep passing the
// three-arm entry gate, while the merged-vs-split comparison requires all three
// partition coverages.

import { validateMergeCoverage, partitionCoverage } from "../continue-scenes.js";

function sharedPage(id: string) {
  return { id, kind: "experience" as const, task: `共享经验 ${id}`, search_keys: ["shared"], solution: "共享解法", updated_at: "2026-10-23T02:00:00.000Z", supersedes: [] };
}

test("old own-only sets still pass the three-arm gate", () => {
  const scenes: ContinueScene[] = [];
  for (const project of ["site-heal", "web", "planner"]) {
    for (let i = 0; i < 4; i++) {
      const s = scene({ id: `${project}-${i}`, source: { root: "d-x", project } });
      if (i === 0) s.history.notes = [note(true)];
      scenes.push(s);
    }
  }
  // Adding the shared fields must NOT change the v4 gate's verdict.
  assert.equal(validateScenes(scenes).ok, true);
  // ...while the merge gate refuses the same set for lacking shared coverage.
  const m = validateMergeCoverage(scenes);
  assert.equal(m.ok, false);
  assert.match(m.errors.join(";"), /both 场景数 0 < 3/);
  assert.match(m.errors.join(";"), /shared-only 场景数 0 < 3/);
});

test("merge coverage gate passes a set with all three coverages", () => {
  const scenes: ContinueScene[] = [];
  for (let i = 0; i < 3; i++) {
    const both = scene({ id: `both-${i}`, source: { root: "d-x", project: "p1" } });
    both.history.sharedPages = [sharedPage(`sh_${i}`)];
    both.shared_expected_background = ["共享解法是切备用 DNS"];
    scenes.push(both);

    scenes.push(scene({ id: `own-${i}`, source: { root: "d-x", project: "p2" } }));

    const sharedOnly = scene({ id: `shared-${i}`, source: { root: "d-x", project: "p3" } });
    sharedOnly.history = { observations: [], handoffs: [], pages: [], sharedPages: [sharedPage(`so_${i}`)] };
    sharedOnly.shared_expected_background = ["共享解法是切备用 DNS"];
    scenes.push(sharedOnly);
  }
  const v = validateMergeCoverage(scenes);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(partitionCoverage(scenes[0]), "both");
  assert.equal(partitionCoverage(scenes[1]), "own-only");
  assert.equal(partitionCoverage(scenes[2]), "shared-only");
});

test("shared history without a declared shared expectation is refused", () => {
  const scenes: ContinueScene[] = [];
  for (let i = 0; i < 3; i++) {
    const both = scene({ id: `both-${i}` });
    both.history.sharedPages = [sharedPage(`sh_${i}`)];
    scenes.push(both);
    scenes.push(scene({ id: `own-${i}` }));
    const so = scene({ id: `so-${i}` });
    so.history = { observations: [], handoffs: [], pages: [], sharedPages: [sharedPage(`x_${i}`)] };
    scenes.push(so);
  }
  const v = validateMergeCoverage(scenes);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /未声明 shared_expected_background/);
});

test("malformed shared material is refused by the shape gate", () => {
  const scenes = Array.from({ length: 12 }, (_, i) => scene({ id: `s${i}` }));
  scenes[0].history.sharedNotes = [{ id: "n", title: "t" } as never];
  const v = validateScenes(scenes);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(";"), /shared note 缺 id\/title\/body\/updated_at/);
});

test("shared-only history is not 'empty history'", () => {
  const s = scene({ id: "sh-only" });
  s.history = { observations: [], handoffs: [], pages: [], sharedPages: [sharedPage("s1")] };
  s.shared_expected_background = ["共享解法"];
  const v = validateScenes(Array.from({ length: 11 }, (_, i) => scene({ id: `s${i}` })).concat([s]));
  assert.ok(!v.errors.join(";").match(/sh-only: 前史为空/), v.errors.join(";"));
});
