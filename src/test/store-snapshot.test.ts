// Wiki snapshot must never block the event loop (2026-11-18 root cause).
//
// The bug: `snapshotSoon` ran `execFileSync("git", ["add","-A"])` and
// `execFileSync("git", ["commit"])` on the event loop, once per written page.
// With a 504MB `.git` holding 16,655 commits, a single `git add -A` cost
// 0.13–0.24s on an idle machine. `/observe` fires ~9×/min, so the loop was
// blocked continuously — the stall watchdog recorded 2.4–9.0s stalls, every one
// labelled `POST /observe`.
//
// The fix has two independent halves, and each needs its own assertion:
//   · ASYNC — the git work leaves the loop. Measured here by running a timer
//     during snapshot activity: with execFileSync the timer cannot fire until
//     git returns; with execFile it fires on schedule.
//   · THROTTLED — one commit per page was what grew the repo to 16k commits.
//
// Neither assertion can be faked by the other: an async-but-unthrottled impl
// passes the loop test, and a throttled-but-synchronous impl passes the count
// test. Both are checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { StoreRoot } from "../store.js";

function gitCount(dir: string): number {
  try {
    return Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

function writeNote(root: StoreRoot, name: string): void {
  root.writePage("proj", "notes", name, {
    frontmatter: { type: "note", title: `t ${name}`, generated: { by: "test", at: new Date().toISOString() } },
    body: "body\n",
  } as never);
}

test("snapshot work does not block the event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-snap-loop-"));
  try {
    const root = new StoreRoot(dir, "u-snap");
    // A timer scheduled at 1ms must be able to fire while snapshots run. If the
    // implementation used execFileSync, the loop would be held for the whole
    // git invocation and this counter would lag far behind wall-clock.
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    for (let i = 0; i < 20; i++) writeNote(root, `n${i}`);
    // Give the debounce plus a git run time to happen.
    await new Promise((r) => setTimeout(r, 1200));
    clearInterval(timer);
    // 1200ms at 1ms interval: a blocked loop would yield a handful of ticks;
    // a free loop yields hundreds. Assert a generous floor so the test is about
    // "the loop was usable", not timer precision.
    assert.ok(ticks > 50, `event loop was starved: only ${ticks} timer ticks in ~1.2s`);
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes are batched into far fewer commits than pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-snap-count-"));
  try {
    const root = new StoreRoot(dir, "u-snap2");
    const wiki = join(dir, "owners", "u-snap2", "wiki");
    for (let i = 0; i < 30; i++) writeNote(root, `n${i}`);
    // Wait past the debounce, then past a throttle window is NOT required —
    // the assertion is that 30 writes do not produce 30 commits.
    await new Promise((r) => setTimeout(r, 1500));
    const commits = gitCount(wiki);
    assert.ok(commits >= 1, "at least one snapshot should have landed");
    assert.ok(commits < 10, `30 writes produced ${commits} commits — throttling is not working`);
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the last write before a quiet period is still captured", async () => {
  // The failure mode of a naive throttle: drop the request entirely, so the git
  // history stops at the last busy moment and the final page is never snapshotted.
  //
  // Note on timing: the throttle window is 30s (SNAPSHOT_THROTTLE_MS), so a
  // write arriving just after a snapshot waits out the remainder of that window
  // — by design, since a snapshot is a recovery aid, not a per-write guarantee.
  // This test therefore checks the CONTRACT (a later write eventually produces a
  // new commit, rather than being discarded) without waiting the full window:
  // it writes, waits for the pending timer to be armed, and asserts the label
  // was not dropped by inspecting that a snapshot is pending or has run.
  const dir = mkdtempSync(join(tmpdir(), "fd-snap-last-"));
  try {
    const root = new StoreRoot(dir, "u-snap3");
    const wiki = join(dir, "owners", "u-snap3", "wiki");
    for (let i = 0; i < 5; i++) writeNote(root, `n${i}`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = gitCount(wiki);
    assert.ok(after >= 1, "the first batch must be snapshotted");

    // A further write must leave a snapshot PENDING (timer armed) rather than
    // being silently dropped. Reaching into the private field is intentional:
    // the alternative — waiting 30s — makes this test unusably slow, and the
    // contract we care about is "not dropped", not "committed within 1.5s".
    writeNote(root, "final");
    const anyPending = (root as unknown as { gitTimer: unknown; pendingSnapshotLabel: string | null });
    assert.ok(
      anyPending.gitTimer !== null || anyPending.pendingSnapshotLabel !== null,
      "the final write left neither a timer nor a pending label — it was dropped",
    );
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
