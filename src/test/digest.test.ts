// Digest renderer tests (add-continuation-eval task 1.2): the four spec
// scenarios pinned deterministically — hard budget keeps the handoffs section,
// forgotten/expired entries never render, annotations are present, and
// truncation drops lower-priority (later-rank) items first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DigestItem, renderDigest, estimateTokens, DIGEST_DEFAULT_BUDGET_TOKENS } from "../digest.js";

const NOW = "2026-10-25T00:00:00.000Z";

function item(over: Partial<Parameters<typeof renderDigest>[0]["items"][number]> = {}) {
  return {
    id: "exp_1",
    layer: "L2" as const,
    kind: "experience",
    title: "排障 5xx",
    excerpt: "切备用 DNS 后恢复",
    confidence: 0.8,
    updated_at: "2026-10-23T10:00:00.000Z",
    ...over,
  };
}

test("annotations: layer, confidence, date present on every line", () => {
  const out = renderDigest({
    items: [item()],
    handoffs: [],
    now: NOW,
  });
  assert.match(out, /〔L2·experience｜置信 0\.80｜2026-10-23〕排障 5xx/);
});

test("open handoffs section renders and survives a tight budget", () => {
  const out = renderDigest({
    items: [item({ id: "exp_big", title: "很长的经验".repeat(200) })],
    handoffs: [{ id: "abcdef123456", summary: "未完成的巡检交接", to_agent: "spider-heal", created_at: "2026-10-24T01:00:00.000Z" }],
    budgetTokens: 120,
    now: NOW,
  });
  assert.match(out, /### 待认领交接/);
  assert.match(out, /abcdef12\] 未完成的巡检交接（→ spider-heal，2026-10-24）/);
  // hard cap honored
  assert.ok(estimateTokens(out) <= 120 + 40, `digest within budget+slack, got ${estimateTokens(out)}`);
});

test("forgotten and expired entries are rejected at the door", () => {
  const out = renderDigest({
    items: [
      item({ id: "a", forgotten_at: "2026-10-24T00:00:00.000Z", title: "被遗忘" }),
      item({ id: "b", expires_at: "2026-10-24T00:00:00.000Z", title: "已过期" }),
      item({ id: "c", expires_at: "2026-12-01T00:00:00.000Z", title: "仍在期" }),
    ],
    now: NOW,
  });
  assert.ok(!out.includes("被遗忘"));
  assert.ok(!out.includes("已过期"));
  assert.match(out, /仍在期/);
});

test("truncation drops lower-priority (later-rank) items whole", () => {
  const out = renderDigest({
    items: [
      item({ id: "first", title: "第一优先" }),
      item({ id: "second", title: "第二优先" }),
      item({ id: "third", title: "第三优先", excerpt: "x".repeat(600) }),
    ],
    budgetTokens: 60,
    now: NOW,
  });
  assert.match(out, /第一优先/);
  // third is the lowest rank: never rendered before second
  if (out.includes("第三优先")) assert.ok(out.includes("第二优先"));
});

test("default budget is 1500 and zero items still renders the header", () => {
  assert.equal(DIGEST_DEFAULT_BUDGET_TOKENS, 1500);
  const out = renderDigest({ items: [], handoffs: [], now: NOW });
  assert.match(out, /## 记忆摘要 \/ Memory digest（fd-memory，截至 2026-10-25）/);
  assert.ok(!out.includes("### 相关记忆"));
  assert.ok(!out.includes("### 待认领交接"));
});

test("note share: recent notes keep a floor when L2 candidates fill the budget; no-notes case unchanged", () => {
  const l2Item = (n: number): DigestItem => ({
    id: `exp_${n}`, layer: "L2", kind: "experience", title: `L2 条目 ${n}：` + "正文".repeat(120),
    excerpt: "摘录".repeat(150), confidence: 0.8, updated_at: "2026-10-24T00:00:00.000Z",
  });
  const note: DigestItem = {
    id: "n1", layer: "L1", kind: "note", title: "周报口径",
    excerpt: "表头一律用中文；每周五下班前发到 #ops 频道；数据源优先 akshare。",
    confidence: null, updated_at: "2026-10-25T00:00:00.000Z",
  };
  // 6 heavy L2 items would consume the whole 1500 budget — the note must still ride
  const withNote = renderDigest({ items: [...Array.from({ length: 6 }, (_, i) => l2Item(i + 1)), note], handoffs: [], budgetTokens: 1500, now: NOW });
  assert.ok(withNote.includes("周报口径"), "note survives L2 pressure via its share");
  assert.ok(withNote.includes("#ops"));
  // a notes-only root uses the full budget (no artificial share cap)
  const notesOnly = renderDigest({ items: [note], handoffs: [], budgetTokens: 1500, now: NOW });
  assert.ok(notesOnly.includes("周报口径"));
  assert.ok(notesOnly.includes("akshare"), "notes-only block renders the full note line");
});
