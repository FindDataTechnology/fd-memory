// Digest renderer (add-continuation-eval design D2): the v4 injection-block
// prototype. Pure function — no IO, no network. The continuation eval renders
// it; the future injection lanes (cluster hook upgrade / cell session start /
// spawn) import this same module so the block shape never drifts between eval
// and production.
//
// Budget discipline is the anti-rot guardrail (zcode-style always-in-context
// indexes rot — observed at 13.8MB): hard cap, open handoffs first, then items
// in recall-rank order, whole-item granularity, excerpt truncation only when
// even the first item would not fit. Forgotten/expired entries are rejected at
// the door (spec scenario), never silently included.

export interface DigestItem {
  id: string;
  layer: "L1" | "L2";
  kind: string; // fact | experience | note …
  title: string; // fact: statement; experience: task
  excerpt: string;
  confidence?: number | null;
  updated_at?: string | null;
  forgotten_at?: string | null;
  expires_at?: string | null;
}

export interface DigestHandoff {
  id: string;
  summary: string;
  to_agent?: string | null;
  created_at?: string | null;
}

export const DIGEST_DEFAULT_BUDGET_TOKENS = 1500;

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\u3000-\u303F\uFF00-\uFFEF]/gu;

// Deterministic CJK-aware token approximation (no tokenizer dependency):
// 1 token per CJK char, 1 per 4 other characters. Eval and production share
// it, so budgets mean the same thing on both sides.
export function estimateTokens(text: string): number {
  const s = String(text ?? "");
  const cjk = s.match(CJK)?.length ?? 0;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function alive(item: DigestItem, now: string): boolean {
  if (item.forgotten_at) return false;
  if (item.expires_at && String(item.expires_at) <= now) return false;
  return true;
}

function itemLine(item: DigestItem): string {
  const conf = item.confidence != null ? `｜置信 ${Number(item.confidence).toFixed(2)}` : "";
  const date = item.updated_at ? `｜${String(item.updated_at).slice(0, 10)}` : "";
  const title = String(item.title ?? "").replace(/\s+/g, " ").trim();
  // Title cap (run12 transcript): distiller L2 rows carry task ≈ the whole
  // narrative — an unbounded title + its excerpt echo read everything twice
  // and drowned the signal the titles arm wins with (crisp one-liners).
  const shownTitle = title.length > 90 ? `${title.slice(0, 90)}…` : title;
  let excerpt = String(item.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  // Strip the shared prefix so the line never says the same thing twice.
  if (excerpt && title) {
    const max = Math.min(title.length, excerpt.length);
    let common = 0;
    while (common < max && title[common] === excerpt[common]) common += 1;
    if (common >= 40) excerpt = excerpt.slice(common).trimStart();
  }
  return `- 〔${item.layer}·${item.kind}${conf}${date}〕${shownTitle}${excerpt ? `：${excerpt}` : ""}`;
}

// Notification semantics (constructed-benchmark finding, 2026-10-25): a
// handoff line is "there is an open handoff [id], gist, accept it" — the full
// summary lives in the page and is recovered on claim. Round-report handoffs
// ran 700-1500 tokens each and drowned the whole block (retrieval was fine;
// the memory section rendered as one title-only truncated line).
const HANDOFF_GIST_CHARS = 100;

function handoffLine(h: DigestHandoff): string {
  const to = h.to_agent ? `（→ ${h.to_agent}，${String(h.created_at ?? "").slice(0, 10)}）` : `（${String(h.created_at ?? "").slice(0, 10)}）`;
  const gist = String(h.summary ?? "").replace(/\s+/g, " ").trim().slice(0, HANDOFF_GIST_CHARS);
  return `- [${String(h.id).slice(0, 8)}] ${gist}${String(h.summary ?? "").length > HANDOFF_GIST_CHARS ? "…" : ""}${to}`;
}

export function renderDigest(opts: {
  items: DigestItem[];
  handoffs?: DigestHandoff[];
  budgetTokens?: number;
  now?: string;
}): string {
  const budget = Math.max(64, Number(opts.budgetTokens ?? DIGEST_DEFAULT_BUDGET_TOKENS) | 0);
  const now = String(opts.now ?? new Date().toISOString());

  const header = `## 记忆摘要 / Memory digest（fd-memory，截至 ${now.slice(0, 10)}）`;
  const lines: string[] = [header];
  let used = estimateTokens(header);

  const items = opts.items.filter((i) => alive(i, now));
  if (items.length > 0) {
    const sectionTitle = "### 相关记忆 / Related memory";
    lines.push("", sectionTitle);
    used += estimateTokens(sectionTitle);
    // Note share (constructed-benchmark finding, 2026-10-25 ②): L2 candidates
    // render first by recall rank, but when they fill the budget the recent
    // notes — the "user just told me this" context the chat lane most needs —
    // were squeezed to zero. Reserve a floor for L1 notes; L2 keeps the rest,
    // and notes may expand into whatever L2 leaves unused. No L1 items ⇒
    // byte-identical to the previous single-loop behavior.
    const NOTE_SHARE_TOKENS = 400;
    const l1 = items.filter((i) => i.layer === "L1");
    const rest = items.filter((i) => i.layer !== "L1");
    const cap = l1.length ? budget - Math.min(NOTE_SHARE_TOKENS, Math.floor(budget / 3)) : budget;
    const pushItems = (list: typeof items, capTokens: number): number => {
      let spent = 0;
      let opened = false;
      for (const item of list) {
        let line = itemLine(item);
        let cost = estimateTokens(line);
        if (used + spent + cost > capTokens) {
          if (!opened && list.length > 0) {
            // Even the first entry exceeds the remaining budget: truncate its
            // excerpt to fit rather than emitting an empty section.
            const room = Math.max(0, capTokens - used - spent);
            const static_ = `${item.title}：`;
            const staticCost = estimateTokens(static_) + estimateTokens("- 〔〕") + estimateTokens(`${item.layer}·${item.kind}`);
            const roomChars = Math.max(0, (room - staticCost) * 2); // CJK≈1 token/char
            line = `- 〔${item.layer}·${item.kind}〕${String(item.title).slice(0, roomChars)}…`;
            cost = estimateTokens(line);
            if (cost > capTokens - used - spent) break;
            lines.push(line);
            spent += cost;
            opened = true;
          }
          break; // whole-item granularity: later items = lower recall rank
        }
        lines.push(line);
        spent += cost;
        opened = true;
      }
      return spent;
    };
    used += pushItems(rest, cap);
    used += pushItems(l1, budget);
  }

  const handoffs = opts.handoffs ?? [];
  if (handoffs.length > 0) {
    const sectionTitle = "### 待认领交接 / Open handoffs";
    lines.push("", sectionTitle);
    used += estimateTokens(sectionTitle);
    for (const h of handoffs) {
      const line = handoffLine(h);
      const cost = estimateTokens(line);
      // Handoffs are notifications, not privileged spend: they obey the same
      // budget as memory items (production probe 2026-10-25 — a pile of
      // round-report handoffs drowned the whole block and misled the agent).
      if (used + cost > budget) break;
      used += cost;
      lines.push(line);
    }
  }

  lines.push("", "（fd-memory 生成；认领交接用 memory_handoff_accept，本摘要不自动消费。）");
  return lines.join("\n");
}
