// Import filter rules (change add-harness-memory-import, design D1).
//
// Why rules and not an LLM: the ZCode source alone holds 846 931 messages.
// Running a model over that is neither affordable nor auditable. Rules are
// enumerable, explainable, offline, and each hit is attributable — which is
// what the spec's "筛选结果可解释" scenario requires.
//
// Bias is deliberately conservative: importing too little is recoverable (the
// source is untouched, rerun with a wider profile); importing noise into
// long-term memory is not — it poisons recall and dilution the distill lane.

import type { ExtractedTurn } from "./claude-code.js";

/** A single filter rule. Named so hits can be explained. */
export interface FilterRule {
  id: string;
  description: string;
  /** Return true when this turn is worth keeping. */
  test: (turn: ExtractedTurn) => boolean;
}

/**
 * Chinese + English "remember this" markers. These are the highest-signal
 * turns: the user explicitly told the agent something durable.
 */
const EXPLICIT_REMEMBER = [
  /记住/,
  /记一下/,
  /以后都/,
  /以后别/,
  /下次(?:都|不要|别)/,
  /别再/,
  /不要再/,
  /规则是/,
  /规矩是/,
  /一律/,
  /必须是/,
  /绝对不能/,
  /\bremember\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bdon't ever\b/i,
];

/**
 * Conclusion-shaped statements: decisions, conventions, config values.
 * Only user turns carry these reliably here — assistant turns restate them
 * verbatim, so keeping both would double the volume for no gain.
 */
const CONCLUSION = [
  /^决定[:：]/,
  /结论[:：]/,
  /定案[:：]/,
  /口径[:：]/,
  /约定[:：]/,
  /配置是/,
  /改成/,
  /改成用/,
  /我们(?:就|统)一/,
  /用这个方案/,
  /就这样/,
];

/** Unfinished work / handoff — the thing a next session most needs. */
const HANDOFF = [
  /待办[:：]/,
  /TODO[:：]?/i,
  /未完成/,
  /下次继续/,
  /下一步/,
  /遗留/,
  /还没(?:做|改|修)/,
  /(?:需要|得)跟进/,
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

/**
 * Harness noise masquerading as user turns. Real data (28 Claude transcripts,
 * 1 554 turns) showed these dominating the "substantive" bucket:
 *   - slash-command plumbing  (<command-name>/model</command-name>, <local-command-stdout>)
 *   - injected skill bodies   ("Base directory for this skill: …")
 *   - system reminders and mode boilerplate
 * None of it is something the user chose to say, so none of it belongs in
 * long-term memory — it would be recalled as if it were a user preference.
 */
const NOISE = [
  /^<local-command-(?:caveat|stdout|stderr)>/,
  /^<command-(?:name|message|args)>/,
  /^<system-reminder>/,
  /^Base directory for this skill:/,
  /^#\s*Skill:\s/,
  /^\s*Store selection:\s*$/m,
  /^Enter explore mode\./,
  /^Implement tasks from an OpenSpec change\./,
  /^Caveat: The messages below were generated/,
  // Bracketed control-plane messages the harness injects into the user lane.
  /^\[(?:Your previous response had no visible output|Request interrupted by user|Tool use was denied)/,
  // XML-ish envelopes the harness delivers THROUGH the user lane: async task
  // notifications, sub-agent messages, and system reminders. Found in real
  // data — a <task-notification> block was imported as if the user said it.
  /^<task-notification>/,
  /^<task-id>/,
  /^<tool-use-id>/,
  /^<agent-message/,
  /^Another Claude session sent a message:/,
  // ZCode-specific: its `synthetic` flag catches most injection, but not all.
  // Measured against the live 8.5 GB database, these still came through with
  // synthetic absent/false and were being counted as user speech.
  /^Run custom command \//,
  /^Command source:/,
  /^\/(?:opsx|graphify|lawcraw)[\w:-]*/,   // slash-command echoes that start with the command
  /^You are Assessment [A-Z] /,
  /^Called the [A-Z]\w+ tool/,
  // Skill/prompt bodies pasted into the user lane. They address the agent in
  // the second person ("You are implementing…"), which a human talking to an
  // agent essentially never does about themselves.
  /^You are (?:implementing|an? |the )/,
  /^Enter [\w ]+ mode\./,
  /^You have exited plan mode/,
  // Task-dispatch prompts: the harness assigns work to a sub-agent by putting a
  // second-person brief in the user lane. Measured against real ZCode imports:
  // 142 of 1 156 imported memories were this shape, and chasing individual
  // variants ("你在…实施", "你在为…", "你是…代理", "你要为…") kept missing new
  // phrasings. The invariant is simpler than the pattern list: a human talking
  // to an agent addresses it as 你, but never opens by DESCRIBING the agent's
  // assignment to it. So any turn that opens by telling 你 what its job is,
  // is a brief rather than a memory.
  /^你(?:在|是|要|负责|需要|将|会)(?=[^,，。！？\n]{0,60}(?:任务|实施|编写|写|创建|完成|代理|助手|侦察|盘点|盘點|背景|目标))/,
  /^你(?:在|是|要|负责)/,
  /实施 OpenSpec change/,
  /^\$grill-/,
  /^\[\$[\w-]+\]\(/,
];

/** True when the turn is harness plumbing rather than a human turn. */
export function isNoise(text: string): boolean {
  const head = text.slice(0, 400);
  for (const p of NOISE) if (p.test(head)) return true;
  // Some envelopes appear mid-text (a task notification can be preceded by the
  // user's own words). These markers never occur in genuine user prose, so a
  // whole-text check is safe and catches what the head-anchored list misses.
  if (/<\/?(?:task-notification|task-id|tool-use-id|agent-message)\b/.test(text)) return true;
  if (/Another Claude session sent a message:/.test(text)) return true;
  if (containsSecret(text)) return true;
  return false;
}

/**
 * Credential detection — a hard gate, not a heuristic.
 *
 * Why this exists: imported memories get DELIVERED into files like CLAUDE.md,
 * which are read by every session and often committed. A token that reaches
 * memory therefore leaks repeatedly, to every project that file lives in.
 * Measured incident (2026-11-15): a live `github_pat_…` and a password pair
 * were imported from ZCode history before this gate existed.
 *
 * Bias is deliberately aggressive: dropping a memory that merely mentions
 * "password" costs nothing (the user can re-state it), while missing one costs
 * a credential. False positives are acceptable here in a way they are not for
 * the other rules.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,                    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,                  // GitHub fine-grained PAT
  /\bsk-[A-Za-z0-9]{20,}/,                           // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,                     // Anthropic
  /\bAKIA[0-9A-Z]{16}\b/,                            // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                  // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,   // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,              // PEM private key
  /(?:password|passwd|pwd|密码)\s*[:=：]\s*\S{6,}/i,  // explicit password assignments
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,                  // bearer headers pasted in
];

/** True when the text looks like it carries a credential. */
export function containsSecret(text: string): boolean {
  for (const p of SECRET_PATTERNS) if (p.test(text)) return true;
  return false;
}

/** Built-in rules. Order matters only for reporting (first hit is attributed). */
export const BUILTIN_RULES: FilterRule[] = [
  {
    id: "explicit-remember",
    description: "用户显式要求记住的内容（记住/以后都/必须/always…），只取用户侧",
    // Assistant turns restate the user's instruction verbatim ("我会记住…"),
    // so accepting them doubles the volume and attributes the rule to the echo
    // rather than to the person who stated the preference.
    test: (t) => t.role === "user" && anyMatch(EXPLICIT_REMEMBER, t.text),
  },
  {
    id: "conclusion",
    description: "结论性语句（决定/结论/口径/约定/改成…），只取用户侧",
    test: (t) => t.role === "user" && anyMatch(CONCLUSION, t.text),
  },
  {
    id: "handoff",
    description: "用户提出的未竟事项与交接（待办/下一步/未完成/遗留…），只取用户侧",
    // Same reasoning as explicit-remember: an assistant's "下一步是…" is its
    // own plan for the current turn, not a durable obligation the user set.
    test: (t) => t.role === "user" && anyMatch(HANDOFF, t.text),
  },
  {
    id: "substantive-user-turn",
    description: "用户提出的实质性问题或要求（长度足够且非纯指令词）",
    test: (t) => {
      if (t.role !== "user") return false;
      const len = t.text.length;
      if (len < 40 || len > 4000) return false;
      // Very short imperatives ("继续", "好的", "现在做") carry no durable meaning.
      const trivial = /^(?:继续|好的|好|嗯|是的|对|可以|行|ok|OK|继续吧|开始|做吧)[。!！?？\s]*$/;
      return !trivial.test(t.text);
    },
  },
];

export interface FilterOutcome {
  kept: Array<{ turn: ExtractedTurn; ruleId: string }>;
  dropped: number;
  /** Per-rule hit counts, for the dry-run report. */
  hits: Record<string, number>;
}

/**
 * Apply rules. First matching rule wins and is recorded as the attribution.
 * A turn that matches nothing is dropped (and counted) — it stays in the
 * source, so a wider profile can pick it up later.
 */
export function applyRules(turns: ExtractedTurn[], rules: FilterRule[] = BUILTIN_RULES): FilterOutcome {
  const kept: Array<{ turn: ExtractedTurn; ruleId: string }> = [];
  const hits: Record<string, number> = {};
  let dropped = 0;

  for (const turn of turns) {
    // Noise is rejected before any rule sees it: a slash command that happens
    // to contain "记住" is still not a memory.
    if (isNoise(turn.text)) {
      dropped++;
      continue;
    }
    let matched: FilterRule | undefined;
    for (const rule of rules) {
      if (rule.test(turn)) {
        matched = rule;
        break;
      }
    }
    if (matched) {
      kept.push({ turn, ruleId: matched.id });
      hits[matched.id] = (hits[matched.id] ?? 0) + 1;
    } else {
      dropped++;
    }
  }

  return { kept, dropped, hits };
}
