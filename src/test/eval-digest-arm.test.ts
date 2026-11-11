// Merge-arm block tests (add-digest-merge-eval-arm 2.1 / 2.2).
//
// The comparison only means something if the two arms differ in EXACTLY one
// respect: how the partitions are segmented, under the same total budget. These
// tests pin that down structurally — a merged block that lost its source tags,
// or a split arm that quietly spent twice the budget, would still produce
// numbers the judge would happily score.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { seedSceneHistory } from "../eval-fixtures.js";
import { buildDigestBlock, buildMergeArms } from "../eval-digest-arm.js";
import { estimateTokens } from "../digest.js";
import type { ContinueScene } from "../continue-scenes.js";

// Zero vectors: recall falls back to keyword, which is deterministic and needs
// no model download. The comparison is about segmentation and budget, not the
// embed lane.
const embed = async (texts: string[]) => ({ vectors: texts.map(() => []), model: "test:zero", tokens: 0 });

function scene(): ContinueScene {
  return {
    id: "mx",
    source: { root: "d-eval-mx", project: "agentEval" },
    review: "reviewed",
    boundary_at: "2026-11-09T04:00:00.000Z",
    task: "抓取 5xx 的排查结论与下一步：先给结论，再给动作。",
    expected_background: ["own 结论", "shared 结论"],
    shared_expected_background: ["shared 结论"],
    history: {
      observations: [],
      handoffs: [],
      pages: [
        { id: "own_1", kind: "experience", task: "抓取 5xx 自有排障", search_keys: ["5xx"], solution: "自有解:切备用 DNS", confidence: 0.8, updated_at: "2026-11-09T02:00:00.000Z", supersedes: [] },
        { id: "own_2", kind: "experience", task: "抓取 超时自有经验", search_keys: ["超时"], solution: "自有解:降并发", confidence: 0.7, updated_at: "2026-11-09T02:10:00.000Z", supersedes: [] },
      ],
      notes: [{ id: "own_n", title: "自有口径", body: "自有口径备注内容", updated_at: "2026-11-09T03:00:00.000Z" }],
      sharedPages: [
        { id: "sh_1", kind: "experience", task: "抓取 5xx 团队经验", search_keys: ["5xx"], solution: "共享解:指数退避上限60s", confidence: 0.9, updated_at: "2026-11-09T02:00:00.000Z", supersedes: [] },
      ],
      sharedNotes: [{ id: "sh_n", title: "共享口径", body: "共享口径备注内容", updated_at: "2026-11-09T03:00:00.000Z" }],
    },
  };
}

function withRoot(fn: (root: StoreRoot, s: ContinueScene) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "fdm-arm-"));
    try {
      const root = new StoreRoot(dir, "d-eval-mx");
      const s = scene();
      seedSceneHistory(root, s);
      await fn(root, s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("merged block is tagged per source; split parts are not", withRoot(async (root, s) => {
  const merged = await buildDigestBlock(root, s, "agentEval", { projects: ["agentEval", "shared"], budget: 800, embed, now: "2026-11-09T05:00:00.000Z", labelSources: true });
  const ownOnly = await buildDigestBlock(root, s, "agentEval", { projects: ["agentEval"], budget: 400, embed, now: "2026-11-09T05:00:00.000Z" });

  assert.match(merged.block, /agentEval〕/, "merged entries must carry the own partition tag");
  assert.match(merged.block, /shared〕/, "merged entries must carry the shared partition tag");
  // Every digest line already ends with 〕; the source tag is the segment just
  // before it, so assert on the tag string, not on the bracket.
  assert.ok(!/agentEval〕|shared〕/.test(ownOnly.block), "single-partition reads must stay untagged (legacy /digest shape)");
}));

test("merged block spans both partitions' material", withRoot(async (root, s) => {
  const merged = await buildDigestBlock(root, s, "agentEval", { projects: ["agentEval", "shared"], budget: 800, embed, now: "2026-11-09T05:00:00.000Z", labelSources: true });
  assert.match(merged.block, /自有解/, "own material missing from merged block");
  assert.match(merged.block, /共享解/, "shared material missing from merged block");
}));

test("the merged arm does not get more budget than the split arm's two halves", withRoot(async (root, s) => {
  const arms = await buildMergeArms(root, s, "agentEval", { embed, now: "2026-11-09T05:00:00.000Z", totalBudget: 800 });

  const seg = arms.totalBudget / 2;
  assert.equal(arms.totalBudget, 800);
  for (const part of arms.split.parts) {
    assert.ok(estimateTokens(part.block) <= seg + 1, `split part spent ${estimateTokens(part.block)} > ${seg}`);
  }
  assert.ok(estimateTokens(arms.merged.block) <= arms.totalBudget + 1, `merged spent ${estimateTokens(arms.merged.block)} > ${arms.totalBudget}`);
  // Total spend of the split arm (two renders) must not exceed the merged
  // render's ceiling — otherwise "one request instead of two" is really
  // "one request with a bigger allowance".
  const splitTotal = arms.split.parts.reduce((a, p) => a + estimateTokens(p.block), 0);
  assert.ok(splitTotal <= arms.totalBudget * 1.05, `split total ${splitTotal} > ${arms.totalBudget} (+5%)`);
}));

test("split arm concatenates both partitions into one injected block", withRoot(async (root, s) => {
  const arms = await buildMergeArms(root, s, "agentEval", { embed, now: "2026-11-09T05:00:00.000Z", totalBudget: 800 });
  assert.equal(arms.split.parts.length, 2);
  assert.match(arms.split.block, /自有解/);
  assert.match(arms.split.block, /共享解/);
}));

test("the same embed/now inputs make the two arms' headers identical", withRoot(async (root, s) => {
  const arms = await buildMergeArms(root, s, "agentEval", { embed, now: "2026-11-09T05:00:00.000Z", totalBudget: 800 });
  const header = (b: string) => b.split("\n")[0];
  assert.equal(header(arms.merged.block), header(arms.split.block));
}));
