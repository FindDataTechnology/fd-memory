// Hook forwarder (add-yongyi-complete-solution D4, task 3.4): reads a harness
// hook event JSON on stdin, maps it to the /observe event schema (D3), and
// POSTs it with the bound person token. Delivery semantics are fail-drop —
// any transport failure logs to stderr and reports undelivered; the CLI exits
// 0 so a hook never blocks a harness turn. Only usage errors exit non-zero.

import { randomUUID } from "node:crypto";

export type ObserveType = "turn_outcome" | "tool_call" | "health_flip";

export interface ObserveEvent {
  type: ObserveType;
  idempotency_key: string;
  title: string;
  body: string;
  harness: string;
  ts: string;
  metadata?: Record<string, unknown>;
}

const BODY_MAX = 4000;
const TITLE_MAX = 200;

// Kebab, snake or Pascal event spellings all accepted — harnesses differ.
const EVENT_TYPES: Record<string, ObserveType> = {
  sessionstart: "turn_outcome",
  stop: "turn_outcome",
  sessionend: "turn_outcome",
  posttooluse: "tool_call",
};

const CANONICAL: Record<string, string> = {
  sessionstart: "session-start",
  sessionend: "session-end",
  posttooluse: "post-tool-use",
  stop: "stop",
};

export function normalizeHookEvent(raw: string): string | null {
  const folded = raw.trim().toLowerCase().replace(/[-_]/g, "");
  return EVENT_TYPES[folded] ? (CANONICAL[folded] ?? folded) : null;
}

// Meaningful-text extraction: pull the salient fields out of the hook payload
// (claude-code/zcode hook JSON shape) into readable bounded lines.
export function extractBody(event: Record<string, unknown>): string {
  const lines: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (!text.trim()) return;
    lines.push(`${label}: ${text}`);
  };
  push("cwd", event.cwd);
  push("session", event.session_id);
  push("tool", event.tool_name);
  push("input", event.tool_input);
  push("summary", event.summary);
  push("prompt", event.prompt);
  push("source", event.source);
  const text = lines.join("\n");
  return text.length > BODY_MAX ? text.slice(0, BODY_MAX) + "\n[truncated]" : text;
}

// Pure mapper: hook event JSON → /observe body (idempotency key generated per
// call, per D4). `event` must already be canonical (normalizeHookEvent).
// Returns null when the event name is not in the mapped set.
export function mapHookEvent(harness: string, event: string, payload: Record<string, unknown> | null): ObserveEvent | null {
  const type = EVENT_TYPES[event.replace(/-/g, "")];
  if (!type) return null;
  const tool = typeof payload?.tool_name === "string" ? (payload.tool_name as string) : "";
  const cwd = typeof payload?.cwd === "string" ? (payload.cwd as string) : "";
  const titleSrc = type === "tool_call" && tool ? `tool_call ${tool}` : `${event} ${cwd ? "· " + cwd.split("/").filter(Boolean).pop() : ""}`;
  return {
    type,
    idempotency_key: randomUUID(),
    title: titleSrc.trim().slice(0, TITLE_MAX) || `${event}`,
    body: extractBody(payload ?? {}),
    harness,
    ts: new Date().toISOString(),
  };
}

export interface ForwardResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

// POST to /observe with a bounded timeout; every failure is swallowed into a
// false `delivered` (fail-drop — no retry, per the observe-lane degrade
// contract). `post` is injectable for tests.
export async function forwardHookEvent(
  opts: { url: string; token: string; event: ObserveEvent; timeoutMs?: number },
  post: typeof fetch = fetch,
): Promise<ForwardResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await post(opts.url.replace(/\/+$/, "") + "/observe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + opts.token },
      body: JSON.stringify(opts.event),
      signal: controller.signal,
    });
    if (res.ok) return { delivered: true, status: res.status };
    return { delivered: false, status: res.status, error: `observe returned ${res.status}` };
  } catch (e) {
    return { delivered: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function readStdinJson(input: string): Record<string, unknown> | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
