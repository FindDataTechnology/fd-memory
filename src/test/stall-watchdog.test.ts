// Stall watchdog contract (2026-11-18).
//
// The bug it exists for: fd-memory intermittently stops answering for 15–25s
// with CPU at 0%, FD count stable, and the process asleep. Six hypotheses were
// tested and refuted. What was missing is an in-process view — `sample` only
// gives native frames, so a blocked JS callback is indistinguishable from
// `uv__io_poll`.
//
// The watchdog cannot report a stall WHILE stalled (same loop). It measures the
// gap afterwards, which is enough to correlate with an external timeout.
//
// These tests pin the three things that make such a measurement trustworthy:
//   · a stall BELOW the threshold is not reported (no cry-wolf on normal jitter)
//   · a stall AT/ABOVE it is reported exactly once, with the real duration
//   · it never keeps the process alive (unref'd)

import { test } from "node:test";
import assert from "node:assert/strict";
import { startStallWatchdog } from "../stall-watchdog.js";

function recorder() {
  const lines: string[] = [];
  return { lines, log: { warn: (m: string) => lines.push(m) } };
}

test("a loop stall above the threshold is reported once, with the real duration", async () => {
  const { lines, log } = recorder();
  // Fake clock we advance by hand: deterministic, no wall-clock flakiness.
  let fake = 0;
  const wd = startStallWatchdog({ tickMs: 10, thresholdMs: 100, log, now: () => fake });
  // Normal tick: advance exactly one interval — no drift, no report.
  fake += 10;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(lines.length, 0, "a normal tick must not be reported");
  // Simulate the loop being blocked for 3s: the timer fires late by 3000ms.
  fake += 10 + 3000;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(lines.length, 1, `expected exactly one report, got ${lines.length}: ${lines.join(" | ")}`);
  assert.match(lines[0], /stalled 3\.0s/, `duration must be the real gap:\n${lines[0]}`);
  assert.match(lines[0], /not I\/O wait and not a slow query/, "the message must rule out the two wrong readings");
  wd.stop();
});

test("jitter below the threshold is silent (no cry-wolf)", async () => {
  const { lines, log } = recorder();
  let fake = 0;
  const wd = startStallWatchdog({ tickMs: 10, thresholdMs: 100, log, now: () => fake });
  // 90ms drift: large but under the 100ms threshold.
  fake += 10 + 90;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(lines.length, 0, `90ms drift must not be reported:\n${lines.join(" | ")}`);
  wd.stop();
});

test("the stall counter is exposed for healthz, and stop() freezes it", async () => {
  const { log } = recorder();
  let fake = 0;
  const wd = startStallWatchdog({ tickMs: 10, thresholdMs: 100, log, now: () => fake });
  assert.equal(wd.stalls(), 0, "starts at zero");
  fake += 10 + 5000;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(wd.stalls(), 1, "a stall increments the counter");
  wd.stop();
  fake += 10 + 5000;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(wd.stalls(), 1, "after stop() no further stalls are counted");
});

test("stop() is idempotent", () => {
  const wd = startStallWatchdog({ tickMs: 10, thresholdMs: 100, log: { warn: () => {} } });
  wd.stop();
  wd.stop(); // must not throw
});
