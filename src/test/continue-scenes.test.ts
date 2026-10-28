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
