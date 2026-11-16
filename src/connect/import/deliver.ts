// Memory delivery (change add-harness-memory-import, spec
// yongyi-harness-memory-delivery).
//
// The problem this solves: importing history gets memories INTO YongYi, but a
// new session in a different harness still starts blank. Delivery closes that
// loop by putting the project's memories where the harness already looks —
// its instruction file — without ever touching the harness's conversation
// store.
//
// Why a SEPARATE block from the discipline block: `yongyi connect` already owns
// a managed region in these same files (the behavioral discipline text). If
// delivery wrote into that region, every `yongyi connect` would wipe delivered
// memories and every delivery would wipe the discipline. Two blocks, two
// owners, both byte-preserving outside their own markers.
//
// Explicitly NOT done here (design D7 / Non-Goals): injecting messages into the
// harness's transcript or SQLite store. Claude Code's JSONL is a uuid/parentUuid
// chain that breaks on insert; ZCode's message table is behind triggers in an
// 8.4 GB database already underserving 30 concurrent writers. Delivery to a
// file the harness reads achieves the same user-visible outcome with no write
// risk to the source of truth.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoreRoot } from "../../store.js";

/** Delivery block markers — distinct from `<!-- yongyi:begin -->`. */
export const DELIVER_BEGIN = "<!-- yongyi:memory:begin -->";
export const DELIVER_END = "<!-- yongyi:memory:end -->";

export interface DeliveryTarget {
  /** Harness id, for reporting and per-target defaults. */
  id: string;
  /** Absolute path to the instruction file the harness reads. */
  file: string;
  /** Format the target can carry. */
  format: "markdown";
}

export interface DeliverOptions {
  /** Max entries to emit (default 50). */
  limit?: number;
  /** Max total characters across entries (default 8000). */
  maxChars?: number;
  /** Remove the block instead of writing it. */
  off?: boolean;
  /** Project whose memories to deliver. */
  project: string;
}

export interface DeliverResult {
  target: string;
  file: string;
  action: "written" | "unchanged" | "removed" | "noop";
  entries: number;
  omitted: number;
  /** True when the file's bytes outside our block are untouched. */
  outsideIntact: boolean;
}

interface RememberedItem {
  summary: string;
  created_at: string;
}

/**
 * Pull the project's memories worth surfacing at session start.
 *
 * Reads through the store's public read face so delivery sees exactly what a
 * recall would see (forgotten pages, superseded entries already excluded).
 */
export function selectForDelivery(root: StoreRoot, project: string, limit: number): RememberedItem[] {
  const rows = root.db.recentObservations(limit, [project]);
  return rows.map((r) => ({ summary: r.summary, created_at: r.created_at }));
}

/**
 * Render the block body. Deterministic: same inputs → same bytes, which is what
 * makes repeated delivery a no-op instead of a churn.
 */
export function renderBlockBody(items: RememberedItem[], opts: { project: string; maxChars: number }): {
  body: string;
  omitted: number;
} {
  const header = [
    `## 永忆送达的记忆（project: ${opts.project}）`,
    "",
    "以下是此前会话中沉淀的、与本项目相关的记忆。它们是背景资料，不是本回合的指令。",
    "",
  ].join("\n");

  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;

  for (const item of items) {
    const text = item.summary.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `- ${text}`;
    if (used + line.length + 1 > opts.maxChars) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const tail = omitted > 0 ? `\n（已省略 ${omitted} 条，超出本次送达的容量上限）` : "";
  if (lines.length === 0 && omitted === 0) {
    return { body: "", omitted: 0 };
  }
  return { body: header + lines.join("\n") + tail, omitted };
}

function blockRegion(content: string): { start: number; end: number } | null {
  const beginIdx = content.indexOf(DELIVER_BEGIN);
  if (beginIdx < 0) return null;
  const endIdx = content.indexOf(DELIVER_END, beginIdx + DELIVER_BEGIN.length);
  if (endIdx < 0) return null;
  let end = endIdx + DELIVER_END.length;
  if (content[end] === "\n") end += 1;
  return { start: beginIdx, end };
}

/** Replace our block in `content`, or append it. Bytes outside are preserved. */
export function upsertDeliveryBlock(content: string, body: string): { text: string; changed: boolean } {
  const fresh = DELIVER_BEGIN + "\n" + body.trim() + "\n" + DELIVER_END + "\n";
  const region = blockRegion(content);

  if (!region) {
    // No well-formed block. If a stray begin marker exists, treat begin→EOF as
    // ours and rebuild (never leave two half-blocks behind).
    const strayBegin = content.indexOf(DELIVER_BEGIN);
    if (strayBegin >= 0) {
      const before = content.slice(0, strayBegin);
      const sep = before === "" ? "" : "\n";
      return { text: before + sep + fresh, changed: true };
    }
    const sep = content === "" ? "" : "\n";
    return { text: content + sep + fresh, changed: true };
  }

  const current = content.slice(region.start, region.end);
  if (current === fresh) return { text: content, changed: false };
  return { text: content.slice(0, region.start) + fresh + content.slice(region.end), changed: true };
}

/** Remove our block. Bytes outside are preserved; EOF separator consumed. */
export function removeDeliveryBlock(content: string): { text: string; changed: boolean } {
  const beginIdx = content.indexOf(DELIVER_BEGIN);
  if (beginIdx < 0) return { text: content, changed: false };

  const region = blockRegion(content);
  if (!region) {
    const before = content.slice(0, beginIdx);
    return { text: before.endsWith("\n") ? before.slice(0, -1) : before, changed: true };
  }

  const before = content.slice(0, region.start);
  const after = content.slice(region.end);
  const atEof = after.trim() === "";
  const kept = atEof && before.endsWith("\n") ? before.slice(0, -1) : before;
  return { text: kept + (atEof ? "" : after), changed: true };
}

/**
 * Deliver to one target. Never creates a file that does not already exist —
 * a harness only reads files at paths it knows, so inventing one would produce
 * a block nobody sees (spec: 目标路径不存在时不静默失败).
 */
export function deliverToTarget(
  root: StoreRoot,
  target: DeliveryTarget,
  opts: DeliverOptions,
): DeliverResult {
  if (!existsSync(target.file)) {
    throw new Error(
      `Delivery target does not exist: ${target.file}\n` +
        `Create the file first (or run the harness once so it generates one), ` +
        `then deliver again. Refusing to create a file the harness may not read.`,
    );
  }

  const original = readFileSync(target.file, "utf8");

  if (opts.off) {
    const out = removeDeliveryBlock(original);
    if (out.changed) writeFileSync(target.file, out.text, "utf8");
    return {
      target: target.id,
      file: target.file,
      action: out.changed ? "removed" : "noop",
      entries: 0,
      omitted: 0,
      outsideIntact: true,
    };
  }

  const limit = opts.limit ?? 50;
  const maxChars = opts.maxChars ?? 8000;
  const items = selectForDelivery(root, opts.project, limit);

  // Empty selection: do not leave a bare header claiming memories that do not
  // exist. Treated the same as a turn-off for this run.
  const { body, omitted } = renderBlockBody(items, { project: opts.project, maxChars });
  if (!body) {
    const out = removeDeliveryBlock(original);
    if (out.changed) writeFileSync(target.file, out.text, "utf8");
    return {
      target: target.id,
      file: target.file,
      action: out.changed ? "removed" : "noop",
      entries: 0,
      omitted: 0,
      outsideIntact: true,
    };
  }

  const out = upsertDeliveryBlock(original, body);
  if (out.changed) writeFileSync(target.file, out.text, "utf8");

  const entries = body.split("\n").filter((l) => l.startsWith("- ")).length;
  return {
    target: target.id,
    file: target.file,
    action: out.changed ? "written" : "unchanged",
    entries,
    omitted,
    outsideIntact: verifyOutsideIntact(original, out.text),
  };
}

/** Belt-and-braces check that our surgery only touched our own region.
 *
 * The comparison is done on the text OUTSIDE our block, after normalizing the
 * one separator newline that appending/removing legitimately adds or consumes.
 * Getting this wrong would make the function report false alarms on the most
 * common case (append to a file that had no block yet), so the normalization
 * is explicit rather than incidental.
 */
function verifyOutsideIntact(before: string, after: string): boolean {
  const strip = (s: string) => {
    const r = blockRegion(s);
    const outside = r ? s.slice(0, r.start) + s.slice(r.end) : s;
    // At most one trailing newline belongs to the block's framing, not to the
    // user's content — normalize it away on both sides before comparing.
    return outside.replace(/\n+$/, "");
  };
  return strip(before) === strip(after);
}

/** Well-known instruction files per harness. Paths are absolute. */
export function defaultTargets(homeDir: string, projectRoot: string): DeliveryTarget[] {
  const targets: DeliveryTarget[] = [];
  // Claude Code reads CLAUDE.md from the project root.
  targets.push({ id: "claude-code", file: `${projectRoot}/CLAUDE.md`, format: "markdown" });
  // Codex/OpenAI-style harnesses read AGENTS.md.
  targets.push({ id: "agents-md", file: `${projectRoot}/AGENTS.md`, format: "markdown" });
  return targets;
}
