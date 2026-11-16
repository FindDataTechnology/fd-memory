// Summary-layer import (spec yongyi-summary-layer-import).
//
// The layer that matters: 1 505 distilled memories vs 858 160 raw messages.
// These tests pin the two decisions that make it affordable — parse the
// frontmatter, embed only the description — and the bookkeeping that keeps a
// re-import idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSummaryLayer, summaryAsTurns } from "../connect/import/summary.js";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-sum-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

const SAMPLE = `---
name: a-lesson
description: 一句话钩子，这就是要向量化的对象
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_abc
---

正文很长，不应该被向量化。

见 [[other-lesson]]。
`;

test("parses frontmatter and keeps the body verbatim", () => {
  const dir = fixture({ "a-lesson.md": SAMPLE });
  try {
    const { memories, stats } = extractSummaryLayer(dir, "proj");
    assert.equal(memories.length, 1);
    const m = memories[0];
    assert.equal(m.name, "a-lesson");
    assert.equal(m.description, "一句话钩子，这就是要向量化的对象");
    assert.equal(m.type, "feedback");
    assert.equal(m.originSessionId, "sess_abc");
    assert.ok(m.body.includes("[[other-lesson]]"), "links survive");
    assert.equal(stats.withFrontmatter, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index files are skipped — they are pointers, not memories", () => {
  const dir = fixture({
    "INDEX-topics.md": "# topics\n- [a](a-lesson.md)\n",
    "MEMORY.md": "# index\n",
    "a-lesson.md": SAMPLE,
  });
  try {
    const { memories, stats } = extractSummaryLayer(dir, "p");
    assert.equal(memories.length, 1);
    assert.equal(stats.skippedIndex, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file without frontmatter is counted, not silently dropped", () => {
  const dir = fixture({ "no-fm.md": "# just a heading\n", "a-lesson.md": SAMPLE });
  try {
    const { memories, stats } = extractSummaryLayer(dir, "p");
    assert.equal(memories.length, 1);
    assert.equal(stats.skippedNoFrontmatter, 1);
    // Visible in stats so the report can say "4 files had no frontmatter".
    assert.equal(stats.files, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("format drift fails loudly instead of returning empty", () => {
  const dir = fixture({ "x.md": "totally different\n", "y.md": "also different\n" });
  try {
    assert.throws(() => extractSummaryLayer(dir, "p"), /frontmatter format changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("description bytes are reported (the embedding budget)", () => {
  const dir = fixture({ "a-lesson.md": SAMPLE });
  try {
    const { stats } = extractSummaryLayer(dir, "p");
    assert.ok(stats.descriptionBytes > 0);
    // Budget must reflect description only, never the body.
    assert.ok(stats.descriptionBytes < Buffer.byteLength(SAMPLE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turns carry the type prefix and a stable source key", () => {
  const dir = fixture({ "a-lesson.md": SAMPLE });
  try {
    const { memories } = extractSummaryLayer(dir, "proj");
    const turns = summaryAsTurns(memories);
    assert.equal(turns.length, 1);
    assert.ok(turns[0].text.startsWith("[feedback] "));
    assert.equal(turns[0].sourceKey, "zcode:proj:a-lesson");
    // Re-importing the same corpus must produce the same key.
    const again = summaryAsTurns(extractSummaryLayer(dir, "proj").memories);
    assert.equal(again[0].sourceKey, turns[0].sourceKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("types are preserved and counted", () => {
  const dir = fixture({
    "a.md": SAMPLE.replace("type: feedback", "type: project").replace("name: a-lesson", "name: a"),
    "b.md": SAMPLE.replace("type: feedback", "type: reference").replace("name: a-lesson", "name: b"),
  });
  try {
    const { stats } = extractSummaryLayer(dir, "p");
    assert.equal(stats.byType["project"], 1);
    assert.equal(stats.byType["reference"], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
