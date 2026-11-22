// Claude Code transcript extractor (change add-harness-memory-import, 阶段二).
//
// Source: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Shape (verified 2026-11-15 against 28 live files / 45 762 records):
//   - one JSON object per line, append-only
//   - `type` discriminates: user | assistant | attachment | api-request |
//     api-request-blob | last-prompt | mode | permission-mode | atis-latch | ai-title
//   - conversation turns carry `uuid` / `parentUuid` (a chain) plus `timestamp`
//   - user content is a string; assistant content is a block array
//     (text | tool_use | thinking)
//   - only user/assistant are conversation; everything else is harness bookkeeping
//     (api-request* are the raw model payloads — duplicated content, huge)
//
// Read-only by contract: this module never opens a file for writing.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";


import type { ExtractedTurn } from "./types.js";
export type { ExtractedTurn };

export interface ExtractStats {
  files: number;
  lines: number;
  malformed: number;
  turns: number;
  skippedByType: Record<string, number>;
}

export interface ExtractResult {
  turns: ExtractedTurn[];
  stats: ExtractStats;
}

/** Record types that carry conversation. Everything else is bookkeeping. */
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

function textOfAssistant(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    // Only `text` blocks are conversation. `tool_use` is an action, `thinking`
    // is private reasoning — neither belongs in long-term memory.
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

function textOfUser(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * Extract conversation turns from one transcript file.
 *
 * Pure function over file content so the parsing rules can be tested without
 * touching the filesystem.
 */
export function extractFromLines(
  lines: string[],
  meta: { sourceFile: string; sessionId: string; projectDir: string },
): { turns: ExtractedTurn[]; malformed: number; skippedByType: Record<string, number> } {
  const turns: ExtractedTurn[] = [];
  const skippedByType: Record<string, number> = {};
  let malformed = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformed++;
      continue;
    }

    const type = typeof rec.type === "string" ? rec.type : "(none)";
    if (!CONVERSATION_TYPES.has(type)) {
      skippedByType[type] = (skippedByType[type] ?? 0) + 1;
      continue;
    }

    const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
    if (!uuid) {
      // Without a stable id there is no safe dedupe key — skip rather than
      // invent one that would collide across sessions.
      malformed++;
      continue;
    }

    const role = type as "user" | "assistant";
    const text = role === "user" ? textOfUser(rec.message) : textOfAssistant(rec.message);
    if (!text) continue;

    // Sub-agent sidechains are a separate conversation; importing them would
    // duplicate the parent's content under a different identity.
    if (rec.isSidechain === true) continue;

    const ts = typeof rec.timestamp === "string" ? rec.timestamp : "";
    if (!ts) continue;

    turns.push({
      sourceKey: `claude-code:${meta.sessionId}:${uuid}`,
      harness: "claude-code",
      sessionId: meta.sessionId,
      sourceFile: meta.sourceFile,
      uuid,
      role,
      text,
      ts,
      cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
      projectDir: meta.projectDir,
    });
  }

  return { turns, malformed, skippedByType };
}

/** Walk `~/.claude/projects` and extract every transcript. Read-only. */
export function extractClaudeProjects(projectsDir: string): ExtractResult {
  const stats: ExtractStats = { files: 0, lines: 0, malformed: 0, turns: 0, skippedByType: {} };
  const turns: ExtractedTurn[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    throw new Error(
      `Claude Code projects directory not found: ${projectsDir}\n` +
        `Expected ~/.claude/projects with one subdirectory per working directory.`,
    );
  }

  for (const projectDir of projectDirs) {
    const dir = join(projectsDir, projectDir);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(dir, entry);
      const sessionId = entry.slice(0, -".jsonl".length);
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      stats.files++;
      stats.lines += lines.length;

      const out = extractFromLines(lines, { sourceFile: file, sessionId, projectDir });
      stats.malformed += out.malformed;
      stats.turns += out.turns.length;
      for (const [k, v] of Object.entries(out.skippedByType)) {
        stats.skippedByType[k] = (stats.skippedByType[k] ?? 0) + v;
      }
      turns.push(...out.turns);
    }
  }

  // Strong failure signal (spec: 格式变化响亮失败): files exist but nothing
  // parsed means the format moved, not that the user had no conversation.
  if (stats.files > 0 && stats.turns === 0) {
    throw new Error(
      `Found ${stats.files} transcript file(s) but extracted 0 conversation turns.\n` +
        `This usually means the transcript format changed. ` +
        `Malformed lines: ${stats.malformed}. Types seen: ${JSON.stringify(stats.skippedByType)}`,
    );
  }

  return { turns, stats };
}
