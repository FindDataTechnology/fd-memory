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

const MAX_LINES = 5000; // ≈ 4MB at 800 bytes/event — a few hours of normal capture

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
    // Compaction is checked cheaply by size rather than by parsing on every
    // append — reading and splitting 4MB per hook turn would defeat the point.
    try {
      if (statSync(file).size > MAX_LINES * 1024) compact(file);
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

function compact(file: string): void {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(-MAX_LINES);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.join("\n") + "\n");
    renameSync(tmp, file);
  } catch { /* best-effort */ }
}
