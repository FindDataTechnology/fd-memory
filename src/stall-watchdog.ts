// Event-loop stall watchdog (2026-11-18).
//
// The problem it addresses: fd-memory intermittently stops answering HTTP for
// 15–25 seconds while CPU sits at 0%, FD count is stable, and the process is
// asleep. Six hypotheses were tested and refuted (SQLite cache, half-open
// request headers, client flood, iCloud/APFS/NTFS, raw I/O latency, FTS trigram
// write cost). What is missing is an in-process view of the stall, and that
// cannot be sampled from outside — `sample` only yields native frames at 1ms
// intervals, so a JS callback that blocks the loop looks like `uv__io_poll`.
//
// A watchdog CANNOT report a stall while it is stalled — it runs on the same
// loop. But it can measure the gap afterwards: schedule a timer every tick, and
// if the wall clock advanced far more than the interval, the loop was blocked
// for that long. Recording the delta plus the moment it ended is enough to
// correlate with an external request ("healthz timed out 14:03:20" ↔ "loop
// stalled 15.3s ending 14:03:21"), which is what turns speculation into a
// measurement.
//
// Deliberately minimal: one unref'd timer, one number, one log line per stall.
// It must never be the reason the process stays alive, and it must never be the
// reason a turn is slow.

const DEFAULT_TICK_MS = 500;
const DEFAULT_THRESHOLD_MS = 2000;

export interface StallWatchdog {
  stop: () => void;
  /** Stalls observed so far — exposed so a health probe can report a count. */
  stalls: () => number;
  /**
   * Let the caller name what it was doing, so a stall report says WHERE.
   * Measured 2026-11-18: three stalls (6.7s / 9.0s / 2.4s) all landed while 20
   * concurrent /digest requests were in flight, but that route rejects
   * unauthenticated callers in microseconds — so "concurrent requests caused
   * it" was co-occurrence, not cause. Without a label the report says only
   * "something blocked the loop", which is barely better than the raw stack
   * sample it replaced.
   */
  note: (phase: string) => void;
}

export function startStallWatchdog(opts: {
  tickMs?: number;
  thresholdMs?: number;
  log?: { warn: (msg: string) => void };
  now?: () => number;
} = {}): StallWatchdog {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const log = opts.log ?? console;
  const now = opts.now ?? Date.now;

  let last = now();
  let stalls = 0;
  let stopped = false;
  // Last thing the service said it was doing. Cheap to update, and it is the
  // whole difference between "the loop stalled" and "the loop stalled while
  // handling POST /pages/mutate".
  let phase = "(idle)";

  const timer = setInterval(() => {
    if (stopped) return;
    const t = now();
    const drift = t - last - tickMs;
    last = t;
    if (drift >= thresholdMs) {
      stalls += 1;
      // Say how long the loop was blocked, when it came back, and what the
      // service was last doing. The recovery instant is the correlatable half:
      // an external observer knows when its request timed out, and that
      // timestamp is all they have.
      log.warn(
        `[watchdog] event loop stalled ${(drift / 1000).toFixed(1)}s (recovered at ${new Date(t).toISOString()}) ` +
        `while: ${phase} — a synchronous callback blocked the loop; this is not I/O wait and not a slow query`,
      );
    }
  }, tickMs);
  // Never keep the process alive on its own account.
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    stalls: () => stalls,
    note: (p: string) => {
      phase = p;
    },
  };
}
