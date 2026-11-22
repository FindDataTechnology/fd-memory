// Shared shapes for harness importers.
//
// Each harness stores conversation in a different place and shape, but once a
// turn is extracted they are interchangeable: the filter rules, the cursor, and
// the store only care about these fields. Keeping the interface here (rather
// than letting each extractor declare its own narrow type) is what lets
// `applyRules` accept turns from any harness without generics gymnastics.

/** A conversational turn pulled out of a harness's local storage. */
export interface ExtractedTurn {
  /** Stable dedupe key derived from the SOURCE, never from the import run. */
  sourceKey: string;
  harness: HarnessId;
  sessionId: string;
  /** Where this came from (file path or database path) — provenance. */
  sourceFile: string;
  /** Harness-native record identifier. */
  uuid: string;
  role: "user" | "assistant";
  /** Conversation text only — tool calls and reasoning blocks are excluded. */
  text: string;
  /** ISO timestamp from the source. */
  ts: string;
  cwd?: string;
  /** Coarse grouping label used for reporting. */
  projectDir: string;
}

export type HarnessId = "claude-code" | "zcode";
