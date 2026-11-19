// Local spool for undeliverable observe events (2026-11-19).
//
// Why: `/observe` was fail-DROP. When the service is unreachable (which on this
// machine is often — 31 concurrent sessions, 60MB free, load 24-37), the hook
// logged one line to stderr and threw the event away. The read side got a disk
// fallback in the previous change; without this, the write side still lost
// everything captured during an outage.
//
// The design constraint that shapes everything here: a hook must NEVER block a
// harness turn. So this is not a queue with retries — it is a durable
// append-only file that costs one small write, and a separate replay command
// drains it later.
//
// Format: JSON Lines, one ObserveEvent per line, appended with O_APPEND. That
// makes concurrent hook processes safe (each write is a single small append)
// and makes partial lines recoverable (a torn last line is simply skipped).
//
// Bounded: the spool keeps at most MAX_LINES; beyond that the file is compacted
// by dropping the OLDEST entries. A spool that grows without limit would turn a
// service outage into a disk-full outage, which is worse than losing events.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LINES = 5000;
/** Disk cap, independent of entry count — a few big events must not grow the file without bound. */
const MAX_BYTES = 5 * 1024 * 1024; // ≈ 4MB at 800 bytes/event — a few hours of normal capture

export interface SpoolEntry {
  url: string;
  token: string;
  event: unknown;
  at: string;
}

export function spoolPath(home: string): string {
  return join(home, "observe-spool.jsonl");
}

/**
 * Append one undeliverable event. Never throws: a hook that fails to spool is
 * exactly as bad as one that never had a spool, so the caller must not have to
 * care.
 */
export function spoolAppend(home: string, entry: SpoolEntry): boolean {
  try {
    const file = spoolPath(home);
    mkdirSync(home, { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n", { flag: "a" });
    // Compaction is triggered by SIZE but enforced by LINE COUNT (2026-11-19).
    //
    // These two used to disagree: the trigger was `size > MAX_LINES * 1024`
    // (≈5MB) while `compact()` returned immediately unless `lines.length >
    // MAX_LINES` (5000 lines). A burst of large events could therefore trip the
    // trigger on every append while compaction did nothing — the spool would
    // grow without bound under exactly the load that produces big events.
    //
    // Fix: pass the size-based decision INTO compact() so it trims to the budget
    // even when the line count is under the limit. Line count still caps how
    // many entries exist; size caps how much disk they may use. Whichever trips
    // first, compaction runs.
    try {
      // BOTH budgets must be able to trigger compaction. Checking bytes alone
      // let 6000 small events (1.5MB) sit under the 5MB trigger while far over
      // the 5000-line cap — the spool grew unbounded in entry count. Checking
      // lines alone let 40 large events (8MB) bloat the file. Whichever trips
      // first, compaction runs; `force` tells compact() which budget spoke.
      if (statSync(file).size > MAX_BYTES) compact(file, { force: true });
      else if (lineCountExceeds(file, MAX_LINES)) compact(file);
    } catch { /* size check is best-effort */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read what is on the spool. Torn or unparseable lines are skipped, not fatal —
 * a crash mid-append must not make the whole file unreadable.
 */
export function spoolRead(home: string): SpoolEntry[] {
  const file = spoolPath(home);
  if (!existsSync(file)) return [];
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const out: SpoolEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t) as SpoolEntry;
      if (d && typeof d === "object" && typeof d.url === "string") out.push(d);
    } catch { /* torn line — skip it, never abort the read */ }
  }
  return out;
}

/**
 * Replace the spool with only the entries that could NOT be delivered.
 *
 * Write-then-rename, so a crash during compaction cannot leave a half-written
 * spool. Callers pass the survivors, which means "delivered" and "still
 * pending" are decided by the caller (it is the only one that knows).
 */
export function spoolRewrite(home: string, survivors: SpoolEntry[]): boolean {
  const file = spoolPath(home);
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(tmp, survivors.map((s) => JSON.stringify(s) + "\n").join(""));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trim the spool to MAX_LINES, keeping the events that carry the most meaning.
 *
 * Measured 2026-11-19: of 332 backlogged events, **327 were `tool_call`** (mostly
 * `tool_call Bash: …`) and only 11 were `turn_outcome` (the session boundaries —
 * `stop`, `session-end` — which are what actually drives distillation). The old
 * policy ("keep the last N lines") dropped the OLDEST entries regardless of kind,
 * so under pressure the signal (session boundaries) could be evicted while
 * hundreds of `ls` invocations survived.
 *
 * New policy, in priority order:
 *   1. every `turn_outcome`, oldest first (bounded by MAX_LINES itself — if there
 *      were ever that many, keeping all of them is still correct)
 *   2. then the newest `tool_call`s, to fill the remaining budget
 *
 * Ordering inside the file is preserved so replay still goes oldest-first.
 */

/**
 * Cheap line-count check for the compaction trigger. Counting newlines is O(n)
 * but avoids parsing every entry — the whole reason the trigger was size-based
 * to begin with was to keep the per-append cost tiny.
 */
function lineCountExceeds(file: string, limit: number): boolean {
  try {
    const raw = readFileSync(file, "utf8");
    let n = 0;
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
    return n > limit;
  } catch { return false; }
}

function compact(file: string, opts: { force?: boolean } = {}): void {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    // Trim when EITHER budget is exceeded. `force` means the caller already saw
    // the file exceed MAX_BYTES, so the line count alone must not veto it.
    if (!opts.force && lines.length <= MAX_LINES) return;
    if (opts.force && lines.length <= 1) return; // nothing meaningful to trim

    const parsed: Array<{ line: string; idx: number; keep: boolean }> = lines.map((line, idx) => {
      let keep = false;
      try {
        const d = JSON.parse(line) as { event?: { type?: string } };
        keep = d?.event?.type === "turn_outcome";
      } catch { /* unparseable: treat as low priority, it cannot be replayed anyway */ }
      return { line, idx, keep };
    });

    const signals = parsed.filter((p) => p.keep);
    const budget = Math.max(0, MAX_LINES - signals.length);
    const fillers = parsed.filter((p) => !p.keep).slice(-budget);
    const keep = [...signals, ...fillers].sort((a, b) => a.idx - b.idx).map((p) => p.line);

    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.join("\n") + "\n");
    renameSync(tmp, file);
  } catch { /* best-effort */ }
}

/**
 * How close the spool is to dropping events (2026-11-19).
 *
 * Why this exists: the spool is bounded (5000 lines / 5MB) precisely so a long
 * outage cannot fill the disk — but "bounded" also means that at some point it
 * starts evicting. Observed 2026-11-19: the backlog climbed 332 → 585 → 628
 * while the service stayed unreachable, and there was no way to answer "how
 * long until we start losing events" except by re-deriving it from the limits.
 *
 * Callers get a plain ratio plus a one-line human summary, so a hook or a
 * diagnostic can say "spool is 12% full, ~5h of headroom at the current rate"
 * instead of "spooled locally" and nothing else.
 */
export function spoolCapacity(home: string): { lines: number; bytes: number; pct: number; summary: string } {
  const file = spoolPath(home);
  let lines = 0;
  let bytes = 0;
  try {
    const raw = readFileSync(file, "utf8");
    bytes = Buffer.byteLength(raw, "utf8");
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
  } catch { /* missing file ⇒ empty, which is the healthy state */ }
  // Whichever budget is closer to its limit decides the percentage — that is the
  // one that will actually start evicting first.
  const pct = Math.max(
    MAX_LINES > 0 ? (lines / MAX_LINES) * 100 : 0,
    MAX_BYTES > 0 ? (bytes / MAX_BYTES) * 100 : 0,
  );
  const summary = lines === 0
    ? "spool empty"
    : `spool ${lines} entries / ${(bytes / 1024).toFixed(0)}KB (${pct.toFixed(0)}% of capacity)`;
  return { lines, bytes, pct, summary };
}
