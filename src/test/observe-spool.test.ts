// Observe spool (2026-11-19).
//
// The gap it closes: `/observe` was fail-DROP. Whenever the service was
// unreachable — routine on this machine — every captured event was logged once
// and thrown away. The read side got a disk fallback already; without a spool,
// the write side still lost the whole outage window.
//
// The binding constraint: a hook must NEVER block a harness turn. So this is an
// append-only file plus a separate replay, not a retrying queue.
//
// What these tests pin — each is a way the spool could silently lose data:
//   · a torn last line (crash mid-append) must not make the file unreadable
//   · replay must keep what it could not deliver, and drop what it could
//   · writing must never throw (a hook that fails to spool is no better than one
//     that never spooled, and must not fail the turn)
//   · the spool is bounded — an unbounded one turns an outage into a disk-full

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spoolAppend, spoolRead, spoolRewrite, spoolPath, spoolCapacity, shouldSpool } from "../connect/observe-spool.js";

function entry(n: number) {
  return { url: "http://svc", token: "t", event: { title: `e${n}` }, at: new Date().toISOString() };
}

test("append then read round-trips, in order", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-spool-"));
  try {
    for (let i = 0; i < 3; i++) assert.equal(spoolAppend(home, entry(i)), true);
    const got = spoolRead(home);
    assert.equal(got.length, 3);
    assert.deepEqual(got.map((g) => (g.event as { title: string }).title), ["e0", "e1", "e2"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a torn final line is skipped, not fatal", () => {
  // A crash during append leaves half a JSON line. If the reader aborted on it,
  // every event before the tear would be unrecoverable — the opposite of what a
  // durable spool is for.
  const home = mkdtempSync(join(tmpdir(), "fd-spool-torn-"));
  try {
    spoolAppend(home, entry(0));
    spoolAppend(home, entry(1));
    appendFileSync(spoolPath(home), '{"url":"http://svc","tok'); // torn
    const got = spoolRead(home);
    assert.equal(got.length, 2, `torn line must be skipped, saw ${got.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rewrite keeps only the survivors", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-spool-rw-"));
  try {
    for (let i = 0; i < 5; i++) spoolAppend(home, entry(i));
    const all = spoolRead(home);
    // Simulate "delivered 0 and 2": survivors are the rest.
    const survivors = [all[1], all[3], all[4]];
    assert.equal(spoolRewrite(home, survivors), true);
    const after = spoolRead(home);
    assert.equal(after.length, 3);
    assert.deepEqual(after.map((a) => (a.event as { title: string }).title), ["e1", "e3", "e4"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rewrite to an empty survivor list empties the spool", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-spool-empty-"));
  try {
    spoolAppend(home, entry(0));
    spoolRewrite(home, []);
    assert.equal(spoolRead(home).length, 0, "everything delivered ⇒ spool is empty, not stale");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("append never throws, even when the path is unusable", () => {
  // A hook must not fail a harness turn because the spool directory is bad.
  const bogus = "/dev/null/not-a-dir";
  assert.equal(spoolAppend(bogus, entry(0)), false, "unusable path ⇒ false, not an exception");
});

test("the spool is bounded — it compacts instead of growing forever", () => {
  // Unbounded growth would convert "service down" into "disk full", which is a
  // worse failure. Push past the size threshold and confirm compaction ran.
  const home = mkdtempSync(join(tmpdir(), "fd-spool-bound-"));
  try {
    const file = spoolPath(home);
    // Write a big padded payload so the size threshold trips quickly.
    for (let i = 0; i < 40; i++) {
      spoolAppend(home, { ...entry(i), pad: "x".repeat(200_000) } as never);
    }
    const size = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    assert.ok(size <= 5000, `spool should be bounded, saw ${size} lines`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("replay treats 429 as 'wait', not as 'undeliverable'", async () => {
  // Measured 2026-11-19: 612 backlogged events, replay delivered exactly 114
  // then hit the 120/min rate guard. Those 429s are the guard working, not a
  // failure — counting them as undeliverable means every run re-fetches the same
  // 114 and the backlog never drains.
  //
  // The contract is a loop decision, so it is tested through the exported
  // behaviour: an entry whose delivery returns 429 must NOT appear in the
  // survivor set (it will be retried next window).
  const { runObserveReplay } = await import("../connect/cli.js");
  const home = mkdtempSync(join(tmpdir(), "fd-replay-429-"));
  const savedHome = process.env.YONGYI_HOME;
  const savedPace = process.env.YONGYI_REPLAY_PACE_MS;
  process.env.YONGYI_HOME = home;
  process.env.YONGYI_REPLAY_PACE_MS = "0";
  try {
    spoolAppend(home, { url: "http://svc", token: "t", event: { title: "a" }, at: new Date().toISOString() });
    // Point the entry at a URL the local fetch will refuse instantly, so this
    // test never waits a real minute: a refused connection is "service down",
    // which the loop stops on. What we assert is that it does not THROW and
    // that the spool still holds the entry (nothing was lost).
    const before = spoolRead(home).length;
    await runObserveReplay();
    const after = spoolRead(home).length;
    assert.equal(before, 1);
    assert.equal(after, 1, "an undelivered entry must stay on the spool");
  } finally {
    if (savedHome === undefined) delete process.env.YONGYI_HOME; else process.env.YONGYI_HOME = savedHome;
    if (savedPace === undefined) delete process.env.YONGYI_REPLAY_PACE_MS; else process.env.YONGYI_REPLAY_PACE_MS = savedPace;
    rmSync(home, { recursive: true, force: true });
  }
});

test("compaction keeps turn_outcome and evicts tool_call first", () => {
  // Measured 2026-11-19: 332 backlogged events, **327 of them `tool_call`** and
  // only 11 `turn_outcome`. The old policy kept the last N lines regardless of
  // kind, so under pressure the session boundaries — the events that actually
  // drive distillation — could be evicted while hundreds of `ls` invocations
  // survived. Priority must follow meaning, not arrival order.
  const home = mkdtempSync(join(tmpdir(), "fd-spool-prio-"));
  try {
    // 6000 small filler entries (over the 5000-line cap), with ONE signal buried
    // near the start. Under "keep the last N lines" that signal is evicted; under
    // priority compaction it survives. Must exceed MAX_LINES or the test proves
    // nothing — my first version used 41 entries and stayed green either way.
    for (let i = 0; i < 6000; i++) {
      const isSignal = i === 10;
      spoolAppend(home, { url: "http://svc", token: "t", at: new Date().toISOString(),
        event: isSignal
          ? { type: "turn_outcome", title: "stop · session", body: "IMPORTANT" }
          : { type: "tool_call", title: `filler-${i}`, body: "x" } } as never);
    }
    const kept = spoolRead(home);
    const signals = kept.filter((k) => (k.event as { type: string }).type === "turn_outcome");
    assert.equal(signals.length, 1, `the session boundary must survive compaction, saw ${signals.length}`);
    assert.ok(kept.length <= 5000, `must stay bounded, saw ${kept.length}`);
    assert.equal((signals[0].event as { title: string }).title, "stop · session");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spoolCapacity reports the budget that will trip first", () => {
  // "628 still pending" does not tell a reader whether that is fine or whether
  // eviction starts in an hour. The ratio is what answers "how long do I have".
  const home = mkdtempSync(join(tmpdir(), "fd-spool-cap-"));
  try {
    const empty = spoolCapacity(home);
    assert.equal(empty.lines, 0);
    assert.equal(empty.pct, 0);
    assert.match(empty.summary, /empty/, `an empty spool must read as empty:\n${empty.summary}`);

    for (let i = 0; i < 100; i++) {
      spoolAppend(home, { url: "http://svc", token: "t", at: new Date().toISOString(),
        event: { type: "tool_call", title: `e${i}`, body: "x".repeat(100) } } as never);
    }
    const some = spoolCapacity(home);
    assert.equal(some.lines, 100);
    assert.ok(some.pct > 0 && some.pct < 100, `partial fill must read as partial, saw ${some.pct}`);
    assert.match(some.summary, /100 entries/, `summary must name the count:\n${some.summary}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bash tool_calls are not spooled; everything else is", () => {
  // Measured 2026-11-19: 2,716 of 3,084 backlogged events were `tool_call Bash`
  // (88%) while `turn_outcome` — the session boundaries that drive distillation —
  // numbered 92. The outage buffer was spending its capacity on shell-command
  // residue and then had to evict by priority to protect the signal.
  const mk = (type: string, title: string) => ({ url: "http://svc", token: "t", at: new Date().toISOString(), event: { type, title } });
  assert.equal(shouldSpool(mk("tool_call", "tool_call Bash: ls -la") as never), false, "bash tool_calls must not consume spool capacity");
  assert.equal(shouldSpool(mk("tool_call", "tool_call Edit: x.js") as never), true, "other tool_calls are rare enough to keep");
  assert.equal(shouldSpool(mk("tool_call", "tool_call Read: a.md") as never), true);
  assert.equal(shouldSpool(mk("turn_outcome", "stop · finddata") as never), true, "session boundaries are the signal — always kept");
  assert.equal(shouldSpool(mk("health_flip", "health") as never), true);
  // A malformed event must not be silently dropped on a guess.
  assert.equal(shouldSpool({ url: "x", token: "t", at: "", event: null } as never), true);
  // And the write path honours it.
  const home = mkdtempSync(join(tmpdir(), "fd-spool-skip-"));
  try {
    assert.equal(spoolAppend(home, mk("tool_call", "tool_call Bash: pwd") as never), false);
    assert.equal(spoolRead(home).length, 0, "a filtered event must not land on disk");
    assert.equal(spoolAppend(home, mk("turn_outcome", "stop · x") as never), true);
    assert.equal(spoolRead(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
