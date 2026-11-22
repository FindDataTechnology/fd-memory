// /observe capture lane (add-yongyi-complete-solution, spec
// yongyi-observe-lane): the platform-side L0 capture face. Any AI harness's
// platform seam (hooks, gateway, runner) reports structured turn events that
// land as observation pages in the CALLER'S namespace — "记得住" as a platform
// guarantee, not agent diligence.
//
// All logic lives here so http.ts stays thin. Failure semantics are
// caller-degrading by design (spec: 捕获永不阻塞回合): closed-set validation
// with named 4xx codes, a per-token rate guard, a bounded body cap with
// in-page truncation annotation, and NO queue — validate, land, answer.

import { randomUUID } from "node:crypto";
import { StoreRoot, AuditIdentity, normalizeMetadata } from "./store.js";
import { safeSegment } from "./auth.js";
import { newPage } from "./okf.js";
import { sanitize } from "./sanitize.js";

// The closed event set (spec: 封闭集). Anything else is a named 400 — a mood
// report is not a turn event, and silently landing it would erode the L0
// contract for every consumer that filters by these three kinds.
export const OBSERVE_EVENT_TYPES = ["turn_outcome", "tool_call", "health_flip"] as const;
export type ObserveEventType = (typeof OBSERVE_EVENT_TYPES)[number];

// Body budget (design D3): 32KB cap, truncation annotated IN the page and in
// the response — an oversized report degrades to its head, never fails the
// turn that produced it.
export const OBSERVE_BODY_CAP_BYTES = 32 * 1024;
export const OBSERVE_TITLE_MAX_CHARS = 200;
const OBSERVE_IDEM_MAX_CHARS = 256;
const OBSERVE_FIELD_MAX_CHARS = 128;

// Per-kind body budget for shell-command captures (2026-11-20).
//
// Why: `tool_call Bash` was 72% of the whole pages table — 38,842 of 54,063
// rows, 18MB of body, ~14.6MB/day of growth counting the FTS copy (≈5.3GB/year).
// The body is `cwd/session/tool/input{full JSON command}`; the title already
// carries the command clipped to 200 chars, so the 32KB body adds only the
// session plumbing and the raw JSON no one reads.
//
// This is a GRANULARITY change, not a capture-policy change: the event is still
// captured (so "which session ran what" stays answerable — the title survives
// intact), only the duplicate long-form blob is clipped. Deliberately NOT the
// same move as spool's shouldSpool(), which drops Bash entirely: that is only
// defensible for the bounded outage buffer, where capacity forces a choice.
// Here the user chose "keep but truncate" over "filter" precisely to keep the
// capture stream complete.
export const OBSERVE_TOOL_CALL_BODY_CAP_BYTES = 256;

/** The body budget for this event kind. */
export function bodyCapFor(ev: { type: ObserveEventType; title: string }): number {
  if (ev.type === "tool_call" && /^tool_call Bash\b/.test(ev.title)) return OBSERVE_TOOL_CALL_BODY_CAP_BYTES;
  return OBSERVE_BODY_CAP_BYTES;
}

export interface NormalizedObserveEvent {
  type: ObserveEventType;
  idempotencyKey: string;
  title: string;
  body: string;
  subject?: string;
  ts?: string;
  harness?: string;
  metadata?: Record<string, unknown>;
  // add-observe-project-field: caller-chosen ROOT-INTERNAL project name the
  // event should land under (person tokens only — http.ts applies the token
  // gate). Absent → the token's default lane. A NAME, never a path.
  project?: string;
}

export type ObserveParseResult =
  | { ok: true; event: NormalizedObserveEvent }
  | { ok: false; status: number; error: string; code: string; extra?: Record<string, unknown> };

// Optional scalar string field: absent/null → undefined, non-string → null
// (invalid), empty → undefined (lenient for harnesses that send "")——
// otherwise trimmed and length-capped.
function optString(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return undefined;
  return s.slice(0, max);
}

export function parseObserveEvent(raw: unknown): ObserveParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "invalid_body", code: "invalid_body" };
  }
  const b = raw as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "";
  if (!(OBSERVE_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, status: 400, error: "unknown_event_type", code: "unknown_event_type", extra: { allowed: [...OBSERVE_EVENT_TYPES] } };
  }
  const idem = typeof b.idempotency_key === "string" ? b.idempotency_key.trim() : "";
  if (!idem || idem.length > OBSERVE_IDEM_MAX_CHARS) {
    return { ok: false, status: 400, error: "idempotency_key_required", code: "idempotency_key_required" };
  }
  const title = typeof b.title === "string" ? sanitize(b.title.trim().slice(0, OBSERVE_TITLE_MAX_CHARS)) : "";
  if (!title) {
    return { ok: false, status: 400, error: "title_required", code: "title_required" };
  }
  if (typeof b.body !== "string" || !b.body.trim()) {
    return { ok: false, status: 400, error: "body_required", code: "body_required" };
  }
  const subject = optString(b.subject, OBSERVE_FIELD_MAX_CHARS);
  if (subject === null) return { ok: false, status: 400, error: "invalid_subject", code: "invalid_subject" };
  const harness = optString(b.harness, OBSERVE_FIELD_MAX_CHARS);
  if (harness === null) return { ok: false, status: 400, error: "invalid_harness", code: "invalid_harness" };
  let ts: string | undefined;
  if (b.ts !== undefined && b.ts !== null) {
    const s = String(b.ts).trim();
    if (!s || Number.isNaN(Date.parse(s))) {
      return { ok: false, status: 400, error: "invalid_ts", code: "invalid_ts" };
    }
    ts = s;
  }
  // Optional project steering (add-observe-project-field): the caller MAY name
  // the root-internal project the event lands in. The value is sanitized like
  // /pages' project (trim → separators flattened → 128 cap) with auth.ts
  // safeSegment's dot-only guard, so "." / ".." and any separator-carrying
  // value degrade to a plain in-root NAME — the wire can never carry a path,
  // let alone cross a root. Malformed shapes (non-string) and empty values are
  // IGNORED, not refused: the field only steers a landing inside the caller's
  // own root, so a bad value degrades to the default lane instead of failing
  // the capture (spec: 照缺省归属).
  let project: string | undefined;
  if (typeof b.project === "string") {
    const p = safeSegment(b.project);
    if (p) project = p;
  }
  const meta = normalizeMetadata(b.metadata);
  if (meta === null) {
    return { ok: false, status: 400, error: "invalid_metadata", code: "invalid_metadata", extra: { reason: "metadata must be an object of scalar/array-of-scalar values" } };
  }
  return {
    ok: true,
    event: {
      type: type as ObserveEventType,
      idempotencyKey: idem,
      title,
      body: b.body,
      ...(subject ? { subject: sanitize(subject) } : {}),
      ...(ts ? { ts } : {}),
      ...(harness ? { harness: sanitize(harness) } : {}),
      ...(meta && Object.keys(meta).length ? { metadata: meta } : {}),
      ...(project ? { project } : {}),
    },
  };
}

// Byte-accurate truncation: cut on a UTF-8 character boundary (walk back over
// continuation bytes) so a clean prefix survives — never a replacement-garbled
// tail — then annotate IN the page body (spec: 截断 MUST 在页内标注).
//
// The note states the ACTUAL budget, not a fixed "32KB": shell-command captures
// ride a much tighter cap (see OBSERVE_TOOL_CALL_BODY_CAP_BYTES), and a note
// claiming 32KB on a 256-byte cut would be a false explanation of what happened
// — the exact class of misleading annotation this codebase keeps paying for.
export function truncateObserveBody(body: string, capBytes = OBSERVE_BODY_CAP_BYTES): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, "utf8") <= capBytes) return { body, truncated: false };
  const buf = Buffer.from(body, "utf8");
  let end = capBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const label = capBytes >= 1024 ? `${Math.round(capBytes / 1024)}KB` : `${capBytes} 字节`;
  return { body: buf.subarray(0, end).toString("utf8") + `\n\n…（正文超过 ${label} 上限，已截断）`, truncated: true };
}

export interface ObserveLanding {
  page: string; // wiki-relative page id (the 页标识 the caller gets back)
  duplicate: boolean;
  truncated: boolean;
}

// Land one validated event as an L0 observation page (page type "observation" —
// L0 derives from the page type, no new storage concept). Idempotency is
// PERSISTENT: a per-root (project, idempotency_key) claim table returns the
// first delivery's page on any replay — restart-safe, no in-memory set.
// `dedupeProject` (add-observe-project-field, purely additive) lets the caller
// pin the claim lane INDEPENDENT of the landing project: the person lane claims
// under its token's canonical partition, so an idempotency key stays
// root-global even when deliveries steer different projects — the replay
// returns the FIRST delivery's page, never a second copy under a new name.
// Landing is fully synchronous: no queue between validate and answer.
export function landObserveEvent(root: StoreRoot, project: string, ev: NormalizedObserveEvent, audit?: AuditIdentity, dedupeProject?: string): ObserveLanding {
  const slug = randomUUID().slice(0, 8);
  const rel = `${project}/observations/${slug}.md`;
  const claim = root.db.claimObserveEvent(dedupeProject ?? project, ev.idempotencyKey, rel, new Date().toISOString());
  if (!claim.first && claim.page_rel) {
    return { page: claim.page_rel, duplicate: true, truncated: false };
  }
  const { body, truncated } = truncateObserveBody(ev.body, bodyCapFor(ev));
  // harness/subject ride the structured metadata as first-class fields (D5) —
  // the same metadata face the digest badge, Portal and the read filters use.
  const metadata: Record<string, unknown> = { ...(ev.metadata ?? {}) };
  if (ev.harness) metadata.harness = ev.harness;
  if (ev.subject) metadata.subject = ev.subject;
  const page = newPage("observation", ev.title, sanitize(body), {
    ...(Object.keys(metadata).length ? { metadata } : {}),
    observe: { type: ev.type, idempotency_key: ev.idempotencyKey, ...(ev.ts ? { ts: ev.ts } : {}) },
    ...(truncated ? { truncated: true } : {}),
  });
  root.writePage(project, "observations", slug, page, audit);
  return { page: rel, duplicate: false, truncated };
}

// -- per-token rate guard -----------------------------------------------------
// Fixed-window counter per token (design D3: 内存桶计数即可, zero deps). A
// noisy harness is shed HERE with a retry hint instead of dragging the write
// path — and because the state is per-token in memory, every other face
// (/digest, /pages, /mcp) is untouched by definition.
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_PER_WINDOW = 120;
const rateWindows = new Map<string, { start: number; count: number }>();

export interface ObserveRateVerdict {
  ok: boolean;
  retryAfterMs: number;
  limit: number;
}

export function observeRateGuard(tokenId: string, now = Date.now()): ObserveRateVerdict {
  const limit = Math.max(1, Number(process.env.FD_MEMORY_OBSERVE_RATE_LIMIT ?? DEFAULT_RATE_PER_WINDOW) || DEFAULT_RATE_PER_WINDOW);
  const start = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  // Bounded memory: stale windows are droppable — a guard must never become a
  // leak, even under a wide token population.
  if (rateWindows.size > 10_000) {
    for (const [k, w] of rateWindows) if (w.start < start) rateWindows.delete(k);
  }
  const w = rateWindows.get(tokenId);
  if (!w || w.start !== start) {
    rateWindows.set(tokenId, { start, count: 1 });
    return { ok: true, retryAfterMs: 0, limit };
  }
  w.count += 1;
  if (w.count > limit) {
    return { ok: false, retryAfterMs: Math.max(0, w.start + RATE_WINDOW_MS - now), limit };
  }
  return { ok: true, retryAfterMs: 0, limit };
}

// Test seam (mirrors __resetMetrics / __resetEmbedGate): clears per-token
// windows so tests never inherit each other's buckets.
export function __resetObserveRateLimiter(): void {
  rateWindows.clear();
}
