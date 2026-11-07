// Managed-block surgery (add-yongyi-complete-solution D4). Pure functions over
// file text: upsert replaces only the bytes between the markers, remove splices
// the block back out. Content OUTSIDE the managed region is preserved
// byte-for-byte in every path — the spec scenario "受管区块不误删" is a hard
// invariant, not a best effort.
//
// Separator discipline that makes disconnect byte-exact for the common
// connect-appended-at-EOF case: appending always adds exactly one "\n" between
// the previous content and the begin marker (so the last newline before the
// block always belongs to connect), and removal consumes exactly that one
// newline when the block sits at end-of-file.

import { BLOCK_BEGIN, BLOCK_END } from "./discipline-text.js";

export interface BlockEdit {
  text: string;
  changed: boolean;
}

function blockText(inner: string): string {
  return BLOCK_BEGIN + "\n" + inner.trim() + "\n" + BLOCK_END + "\n";
}

// Region [begin, end) covered by a well-formed block: from the begin marker to
// the end marker, plus one immediately-following newline when present.
function blockRegion(content: string, beginIdx: number): { start: number; end: number } | null {
  const endIdx = content.indexOf(BLOCK_END, beginIdx + BLOCK_BEGIN.length);
  if (endIdx < 0) return null; // unterminated block — handled by caller
  let end = endIdx + BLOCK_END.length;
  if (content[end] === "\n") end += 1;
  return { start: beginIdx, end };
}

export function upsertManagedBlock(content: string, inner: string): BlockEdit {
  const beginIdx = content.indexOf(BLOCK_BEGIN);
  const fresh = blockText(inner);

  if (beginIdx < 0) {
    // No block yet — append. Exactly one separating newline (ours) unless the
    // file is empty.
    const sep = content === "" ? "" : "\n";
    return { text: content + sep + fresh, changed: true };
  }

  const region = blockRegion(content, beginIdx);
  if (!region) {
    // Unterminated block (begin without end): treat everything from begin to
    // EOF as ours and rebuild cleanly.
    const before = content.slice(0, beginIdx);
    const sep = before === "" ? "" : "\n";
    return { text: before + sep + fresh, changed: true };
  }

  const current = content.slice(region.start, region.end);
  if (current === fresh) return { text: content, changed: false };
  return { text: content.slice(0, region.start) + fresh + content.slice(region.end), changed: true };
}

export function removeManagedBlock(content: string): BlockEdit {
  const beginIdx = content.indexOf(BLOCK_BEGIN);
  if (beginIdx < 0) return { text: content, changed: false };

  const region = blockRegion(content, beginIdx);
  if (!region) {
    // Unterminated: remove begin-to-EOF (and our separator, if any).
    const before = stripOurTrailingNewline(content.slice(0, beginIdx));
    return { text: before, changed: true };
  }

  const before = content.slice(0, region.start);
  const after = content.slice(region.end);
  const atEof = after.trim() === "";
  // At EOF the last "\n" before the block is the separator connect added —
  // consume it so the original file is restored byte-for-byte.
  const kept = atEof ? stripOurTrailingNewline(before) : before;
  return { text: kept + (atEof ? "" : after), changed: true };
}

// One trailing "\n" off. On an empty prefix this is a no-op (nothing to strip).
function stripOurTrailingNewline(before: string): string {
  return before.endsWith("\n") ? before.slice(0, -1) : before;
}
