// ZCode extractor (change add-harness-memory-import, 阶段四).
//
// Source: ~/.zcode/cli/db/db.sqlite (SQLite, WAL). At the time of writing this
// is 8.5 GB with 852 110 messages — and the fleet may be writing to it
// concurrently, so every decision here is about being a good citizen.
//
// Schema as verified against the live database:
//   message(id PK, session_id, time_created, time_updated, data JSON, sequence)
//     data is an ENVELOPE: {"role": "user"|"assistant", ...}. The text is NOT here.
//   part(id PK, message_id, session_id, time_created, data JSON, sequence)
//     data.type ∈ text | step-start | tool | step-finish | reasoning | compaction | timeline
//     text lives in data.text, and data.synthetic marks harness-injected content.
//
// Three measured facts drive the design:
//
//   1. `synthetic: true` is ZCode's OWN injection marker. 268 924 user messages
//      carry 23 232 non-synthetic text parts — 91.4% of user-lane text is
//      injection (token counters, tool reminders, hook context). Pattern-matching
//      openers (what we needed for Claude Code) is strictly worse here because
//      the harness already told us.
//   2. Conversation role lives on `message`, text lives on `part`. Neither table
//      alone is enough, so extraction is a message→part join along message_id.
//   3. Reading `data` with a `WHERE time_created > ?` filter degrades to a full
//      table SCAN (no index leads with time_created): 2000 rows took 30 s.
//      Reading without that filter is a sequential scan and is faster:
//      852 110 messages in ~42 s. So this extractor pages by rowid order, not
//      by time, and filters in TypeScript.
//
// Read-only by contract: the connection is opened with mode=ro and a generous
// busy_timeout; nothing here ever writes.

import { DatabaseSync } from "node:sqlite";
import type { ExtractedTurn } from "./types.js";

export interface ZcodeStats {
  messages: number;
  userMessages: number;
  textParts: number;
  nonSynthetic: number;
  turns: number;
  /** Rejected because the harness marked it synthetic. */
  syntheticSkipped: number;
  /** Rejected because the text is an assistant reasoning block mislabelled user. */
  reasoningSkipped: number;
  /** Sessions excluded wholesale (sub-agent / side-chat / fork). */
  subagentSessions: number;
}

export interface ZcodeExtractResult {
  turns: ExtractedTurn[];
  stats: ZcodeStats;
}

/** Assistant reasoning blocks that end up in the user lane. */
const REASONING_TAG = /^\s*<(brief|thinking|analysis)>/i;

/** How many message ids to resolve per part query. */
const BATCH = 500;

export interface ExtractZcodeOptions {
  /** Only these session ids (undefined = all). Useful for a trial run. */
  sessionIds?: string[];
  /** Hard cap on extracted turns; stops early. */
  limit?: number;
  /** Progress callback (every N messages). */
  onProgress?: (p: { messages: number; turns: number }) => void;
}

function tsToIso(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    // ZCode stores epoch millis.
    return new Date(v).toISOString();
  }
  if (typeof v === "string" && v) return v;
  return new Date(0).toISOString();
}

/**
 * Extract user-authored turns from a ZCode database.
 *
 * Order of operations matters for cost: message roles are read in one
 * sequential pass (cheap), then parts are fetched in bounded batches keyed by
 * message_id (index-covered). Filtering happens in JS so the SQL stays simple
 * enough that the query planner keeps using the index.
 */
export function extractZcode(dbPath: string, opts: ExtractZcodeOptions = {}): ZcodeExtractResult {
  const limit = opts.limit ?? Infinity;
  const stats: ZcodeStats = {
    messages: 0, userMessages: 0, textParts: 0, nonSynthetic: 0, turns: 0,
    syntheticSkipped: 0, reasoningSkipped: 0, subagentSessions: 0,
  };
  const turns: ExtractedTurn[] = [];

  // mode=ro: never take a write lock on a database the fleet is using.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");

    // Pass 1 — roles. Sequential scan, no WHERE on time_created (see header).
    //
    // Sub-agent sessions are excluded wholesale rather than filtered by text.
    // Measured: 1 871 of 2 645 sessions are `task_type='subagent_child'`, and
    // their opening "user" turn is the parent's dispatch brief ("你在 X 仓库
    // 实施…", "You are exploring a project at …", "你是…代理"). Chasing those
    // phrasings with regexes was whack-a-mole — 142 variants survived four
    // rounds of rules. The session kind is a fact, not a guess.
    const excludedSessions = new Set<string>();
    const sessStmt = db.prepare("SELECT id, task_type FROM session");
    for (const row of sessStmt.iterate() as Iterable<{ id: string; task_type: string }>) {
      if (row.task_type === "subagent_child" || row.task_type === "fork" || row.task_type === "selection_side_chat") {
        excludedSessions.add(row.id);
      }
    }
    stats.subagentSessions = excludedSessions.size;

    const userBySession = new Map<string, string[]>();
    const msgStmt = db.prepare("SELECT id, session_id, data FROM message");
    for (const row of msgStmt.iterate() as Iterable<{ id: string; session_id: string; data: string }>) {
      stats.messages++;
      if (excludedSessions.has(row.session_id)) continue;
      let role: unknown;
      try {
        role = (JSON.parse(row.data) as { role?: unknown }).role;
      } catch {
        continue; // malformed envelope — skip, do not abort the scan
      }
      if (role !== "user") continue;
      stats.userMessages++;
      if (opts.sessionIds && !opts.sessionIds.includes(row.session_id)) continue;
      const list = userBySession.get(row.session_id);
      if (list) list.push(row.id);
      else userBySession.set(row.session_id, [row.id]);
      if (opts.onProgress && stats.messages % 100000 === 0) {
        opts.onProgress({ messages: stats.messages, turns: turns.length });
      }
    }

    // Pass 2 — parts for those messages, in bounded batches.
    for (const [sessionId, msgIds] of userBySession) {
      for (let i = 0; i < msgIds.length; i += BATCH) {
        const batch = msgIds.slice(i, i + BATCH);
        const placeholders = batch.map(() => "?").join(",");
        // Prepared statements cannot vary their IN-list length, so build per batch.
        const stmt = db.prepare(
          `SELECT id, message_id, session_id, time_created, data FROM part WHERE message_id IN (${placeholders})`,
        );
        for (const p of stmt.iterate(...batch) as Iterable<{
          id: string; message_id: string; session_id: string; time_created: number; data: string;
        }>) {
          let part: { type?: unknown; text?: unknown; synthetic?: unknown };
          try {
            part = JSON.parse(p.data) as typeof part;
          } catch {
            continue;
          }
          if (part.type !== "text") continue;
          stats.textParts++;

          if (part.synthetic === true) {
            stats.syntheticSkipped++;
            continue;
          }
          stats.nonSynthetic++;

          const text = typeof part.text === "string" ? part.text.trim() : "";
          if (!text) continue;

          // Runner-up noise: assistant reasoning stored in the user lane.
          if (REASONING_TAG.test(text)) {
            stats.reasoningSkipped++;
            continue;
          }

          turns.push({
            sourceKey: `zcode:${sessionId}:${p.id}`,
            harness: "zcode",
            sessionId,
            sourceFile: dbPath,
            uuid: p.id,
            role: "user",
            text,
            ts: tsToIso(p.time_created),
            projectDir: sessionId,
          });
          stats.turns++;
          if (turns.length >= limit) return { turns, stats };
        }
      }
    }

    return { turns, stats };
  } finally {
    db.close();
  }
}
