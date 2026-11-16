// Delivery face invariants (change add-harness-memory-import,
// spec yongyi-harness-memory-delivery).
//
// The hard promise: we put memories where a harness already looks, and we
// touch nothing else — not the user's own prose outside our block, and
// certainly not the harness's conversation store. These tests pin both.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StoreRoot } from "../store.js";
import {
  DELIVER_BEGIN, DELIVER_END,
  deliverToTarget, removeDeliveryBlock, renderBlockBody, upsertDeliveryBlock,
} from "../connect/import/deliver.js";

function sha(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const USER_PROSE = [
  "# 我的项目",
  "",
  "这是用户自己写的内容，绝对不能被送达覆盖。",
  "",
  "- 自有约定一",
  "- 自有约定二",
  "",
].join("\n");

test("delivery appends a block and leaves user prose byte-identical", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del-"));
  try {
    const root = new StoreRoot(data, "d-del");
    root.appendObservation({ session_id: "s1", agent: "a", event: "turn_outcome", tool: null, summary: "决定：以后都用 PG 做多智能体存储", created_at: "2026-11-15T10:00:00.000Z", project: "default" });

    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");
    const before = readFileSync(file, "utf8");

    const res = deliverToTarget(root, { id: "claude-code", file, format: "markdown" }, { project: "default" });
    assert.equal(res.action, "written");
    assert.equal(res.entries, 1);
    assert.ok(res.outsideIntact, "prefix outside the block is unchanged");

    const after = readFileSync(file, "utf8");
    assert.ok(after.startsWith(before), "user prose is a byte-exact prefix");
    assert.ok(after.includes(DELIVER_BEGIN));
    assert.ok(after.includes("以后都用 PG"));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("repeated delivery is idempotent (no duplicate entries)", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del2-"));
  try {
    const root = new StoreRoot(data, "d-del2");
    root.appendObservation({ session_id: "s1", agent: "a", event: "turn_outcome", tool: null, summary: "记忆一", created_at: "2026-11-15T10:00:00.000Z", project: "default" });

    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");

    const first = deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" });
    assert.equal(first.action, "written");
    const bytes1 = readFileSync(file, "utf8");

    const second = deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" });
    assert.equal(second.action, "unchanged", "second run changes nothing");
    assert.equal(readFileSync(file, "utf8"), bytes1);
    assert.equal(bytes1.split("记忆一").length - 1, 1, "exactly one occurrence");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("only the requested project's memories are delivered", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del3-"));
  try {
    const root = new StoreRoot(data, "d-del3");
    root.appendObservation({ session_id: "s1", agent: "a", event: "turn_outcome", tool: null, summary: "p1 的秘密", created_at: "2026-11-15T10:00:00.000Z", project: "p1" });
    root.appendObservation({ session_id: "s2", agent: "a", event: "turn_outcome", tool: null, summary: "p2 的秘密", created_at: "2026-11-15T10:00:00.000Z", project: "p2" });

    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");
    deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "p1" });

    const body = readFileSync(file, "utf8");
    assert.ok(body.includes("p1 的秘密"));
    assert.ok(!body.includes("p2 的秘密"), "other projects never leak across");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("capacity limit is stated in the block, not silently dropped", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del4-"));
  try {
    const root = new StoreRoot(data, "d-del4");
    for (let i = 0; i < 40; i++) {
      root.appendObservation({ session_id: `s${i}`, agent: "a", event: "turn_outcome", tool: null, summary: `第 ${i} 条记忆内容`, created_at: "2026-11-15T10:00:00.000Z", project: "default" });
    }
    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");

    // limit lets entries IN; maxChars is what actually overflows. Set maxChars
    // low enough that the header + a few lines exhausts the budget.
    const res = deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default", limit: 40, maxChars: 250 });
    assert.ok(res.omitted > 0, `some entries were omitted (got omitted=${res.omitted})`);
    assert.ok(readFileSync(file, "utf8").includes(`已省略 ${res.omitted} 条`));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("delivery never touches the harness conversation store", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del5-"));
  try {
    const root = new StoreRoot(data, "d-del5");
    root.appendObservation({ session_id: "s1", agent: "a", event: "turn_outcome", tool: null, summary: "记忆", created_at: "2026-11-15T10:00:00.000Z", project: "default" });

    // Stand-in for a harness transcript + its sqlite store.
    const proj = join(data, "fake-claude", "-tmp-proj");
    mkdirSync(proj, { recursive: true });
    const transcript = join(proj, "s.jsonl");
    writeFileSync(transcript, '{"type":"user","uuid":"u1"}\n', "utf8");
    const dbFile = join(data, "memory.sqlite");
    writeFileSync(dbFile, "pretend-binary", "utf8");
    const tHash = sha(transcript);
    const dHash = sha(dbFile);

    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");
    deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" });

    assert.equal(sha(transcript), tHash, "transcript untouched");
    assert.equal(sha(dbFile), dHash, "store untouched");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("turn-off restores the file and keeps memories", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del6-"));
  try {
    const root = new StoreRoot(data, "d-del6");
    root.appendObservation({ session_id: "s1", agent: "a", event: "turn_outcome", tool: null, summary: "留下的记忆", created_at: "2026-11-15T10:00:00.000Z", project: "default" });

    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");
    deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" });
    assert.ok(readFileSync(file, "utf8").includes(DELIVER_BEGIN));

    const off = deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default", off: true });
    assert.equal(off.action, "removed");
    assert.equal(readFileSync(file, "utf8"), USER_PROSE, "byte-exact restoration");

    // Memories survive a disconnect.
    assert.ok(root.db.recentObservations(10, ["default"]).some((o) => o.summary.includes("留下的记忆")));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("missing target file fails loudly instead of inventing one", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del7-"));
  try {
    const root = new StoreRoot(data, "d-del7");
    const file = join(data, "nope", "CLAUDE.md");
    assert.throws(
      () => deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" }),
      /does not exist/,
    );
    assert.ok(!existsSync(file), "no file was created");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("discipline block and delivery block coexist", () => {
  // Real scenario: `yongyi connect` already wrote its block; delivery must not
  // clobber it and must sit alongside.
  const discipline = "<!-- yongyi:begin -->\n纪律区块\n<!-- yongyi:end -->\n";
  let content = USER_PROSE + discipline;
  const out = upsertDeliveryBlock(content, "## 记忆\n- 一条记忆");
  assert.ok(out.text.includes(discipline), "discipline block intact");
  assert.ok(out.text.includes(DELIVER_BEGIN));

  const removed = removeDeliveryBlock(out.text);
  assert.equal(removed.text, content, "removing delivery restores exactly the connect output");
});

test("empty selection removes a previously written block", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-del8-"));
  try {
    const root = new StoreRoot(data, "d-empty");
    const file = join(data, "CLAUDE.md");
    writeFileSync(file, USER_PROSE, "utf8");
    // No memories at all → nothing to deliver → no block, no bare header.
    const res = deliverToTarget(root, { id: "t", file, format: "markdown" }, { project: "default" });
    assert.equal(res.action, "noop");
    assert.equal(readFileSync(file, "utf8"), USER_PROSE);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("renderBlockBody is deterministic", () => {
  const items = [{ summary: "甲", created_at: "2026-11-15T00:00:00.000Z" }];
  const a = renderBlockBody(items, { project: "p", maxChars: 8000 });
  const b = renderBlockBody(items, { project: "p", maxChars: 8000 });
  assert.equal(a.body, b.body);
});
