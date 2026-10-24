// Entry-gate tests (add-continuation-eval task 2.3): unreviewed scenes and
// undersized scene sets are refused before any LLM spend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScenes, ContinueScene } from "../continue-scenes.js";

function scene(over: Partial<ContinueScene> = {}): ContinueScene {
  return {
    id: "s01",
    source: { root: "d-KkCie7NlrHluo4LiKPnn0w", project: "spider-heal" },
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

test("a full valid set passes", () => {
  const scenes: ContinueScene[] = [];
  for (const project of ["spider-heal", "wx-alpha", "mission-planner"]) {
    for (let i = 0; i < 4; i++) scenes.push(scene({ id: `${project}-${i}`, source: { root: "d-x", project } }));
  }
  const v = validateScenes(scenes);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
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
