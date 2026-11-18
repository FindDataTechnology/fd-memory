// Injection freshness record (2026-11-19).
//
// The last of three fallbacks. Read side falls back to disk, write side spools
// locally — but a session still cannot tell whether the memory it just received
// is CURRENT or from three days ago. A thinner injection and a stale one look
// identical from the inside, and "quietly serving old conclusions as if they
// were today's" is the worst failure a memory system can have: the reader has no
// way to notice.
//
// So: every injection writes a tiny local record; every injection also reads the
// PREVIOUS one and, when it is old, says so in the injected text itself.
//
// Why local file and not the service: the whole point is to work when the
// service does not. A freshness marker that requires the service is useless in
// exactly the situation it exists for.
//
// Bounded and atomic: one small JSON file, written with write-then-rename so a
// crash cannot leave a half-record that would then be misread as "very old".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InjectionState {
  /** ISO timestamp of the last injection attempt that produced content. */
  at: string;
  /** "service" when it came over HTTP, "disk" when the fallback was used. */
  source: "service" | "disk";
  /** How many entries made it in — lets the reader spot a sudden thinning. */
  entries: number;
}

export function statePath(home: string): string {
  return join(home, "injection-state.json");
}

export function readInjectionState(home: string): InjectionState | null {
  try {
    const p = statePath(home);
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf8")) as InjectionState;
    if (!d || typeof d.at !== "string" || (d.source !== "service" && d.source !== "disk")) return null;
    return d;
  } catch {
    // A corrupt record must not block a session start; treat it as "unknown".
    return null;
  }
}

export function recordInjection(home: string, state: InjectionState): boolean {
  try {
    mkdirSync(home, { recursive: true });
    const p = statePath(home);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Describe how stale the PREVIOUS injection was, or null when it is fresh /
 * unknown.
 *
 * Thresholds are deliberately coarse — this is a warning, not a gate. Under a
 * day: silence (that is a normal working rhythm). 1–3 days: a short note. Over
 * 3 days: a louder one, because at that point the reader should go look for a
 * real `memory_query` rather than trust the injected list.
 *
 * Returns a line WITHOUT a trailing newline, or null.
 */
export function stalenessNote(prev: InjectionState | null, now = Date.now()): string | null {
  if (!prev) return null; // first run: nothing to compare against, say nothing
  const at = new Date(prev.at).getTime();
  if (!Number.isFinite(at)) return null;
  const hours = (now - at) / 3_600_000;
  if (hours < 24) return null;
  const days = Math.floor(hours / 24);
  const how = prev.source === "disk" ? "（当时服务不可达，用的是本地兜底）" : "";
  if (days >= 3) {
    return `⚠ 距上次成功注入已 ${days} 天${how} —— 下面的结论可能已经过时，重要判断请用 memory_query 复查。`;
  }
  return `（距上次成功注入 ${days} 天${how}）`;
}
