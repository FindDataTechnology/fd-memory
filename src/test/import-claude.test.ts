// Import extractor + filter rules (change add-harness-memory-import, 阶段二).
//
// Verified against the real shape of ~/.claude/projects transcripts
// (2026-11-15: 28 files / 45 762 records). These tests pin the parsing
// decisions so a format drift fails loudly here instead of silently
// producing an empty import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromLines } from "../connect/import/claude-code.js";
import { applyRules, BUILTIN_RULES } from "../connect/import/rules.js";
import { mapHookEvent } from "../connect/hook-forward.js";

const META = { sourceFile: "/tmp/x/abc.jsonl", sessionId: "abc", projectDir: "-Users-me" };

function line(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

test("extracts user and assistant conversation, skips bookkeeping", () => {
  const lines = [
    line({ type: "ai-title", sessionId: "abc", aiTitle: "标题" }),
    line({ type: "user", uuid: "u1", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "帮我看看链接检查脚本" } }),
    line({ type: "assistant", uuid: "a1", timestamp: "2026-11-15T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的，我来写" }] } }),
    line({ type: "api-request-blob", sessionId: "abc" }),
    line({ type: "attachment", sessionId: "abc" }),
  ];
  const out = extractFromLines(lines, META);
  assert.equal(out.turns.length, 2);
  assert.equal(out.turns[0].role, "user");
  assert.equal(out.turns[0].text, "帮我看看链接检查脚本");
  assert.equal(out.turns[1].role, "assistant");
  assert.equal(out.turns[1].text, "好的，我来写");
  assert.equal(out.skippedByType["api-request-blob"], 1);
  assert.equal(out.skippedByType["attachment"], 1);
});

test("drops tool_use and thinking blocks — actions are not memories", () => {
  const lines = [
    line({
      type: "assistant", uuid: "a1", timestamp: "2026-11-15T10:00:00.000Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "我心里想的" },
        { type: "text", text: "可见的话" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ] },
    }),
  ];
  const out = extractFromLines(lines, META);
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0].text, "可见的话");
  assert.ok(!out.turns[0].text.includes("ls"));
});

test("sidechain (sub-agent) turns are excluded", () => {
  const lines = [
    line({ type: "user", uuid: "u1", timestamp: "2026-11-15T10:00:00.000Z", isSidechain: true, message: { role: "user", content: "子代理内容" } }),
    line({ type: "user", uuid: "u2", timestamp: "2026-11-15T10:00:01.000Z", message: { role: "user", content: "主会话内容" } }),
  ];
  const out = extractFromLines(lines, META);
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0].text, "主会话内容");
});

test("records without uuid are skipped (no unsafe dedupe key)", () => {
  const lines = [
    line({ type: "user", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "无 uuid" } }),
    line({ type: "user", uuid: "u2", timestamp: "2026-11-15T10:00:01.000Z", message: { role: "user", content: "有 uuid" } }),
  ];
  const out = extractFromLines(lines, META);
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0].uuid, "u2");
  assert.equal(out.malformed, 1);
});

test("sourceKey is stable across runs", () => {
  const lines = [line({ type: "user", uuid: "u1", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "同样内容" } })];
  const a = extractFromLines(lines, META).turns[0].sourceKey;
  const b = extractFromLines(lines, META).turns[0].sourceKey;
  assert.equal(a, b);
  assert.equal(a, "claude-code:abc:u1");
});

test("malformed JSON is counted, not fatal", () => {
  const lines = ["{not json", line({ type: "user", uuid: "u1", timestamp: "2026-11-15T10:00:00.000Z", message: { role: "user", content: "好的" } })];
  const out = extractFromLines(lines, META);
  assert.equal(out.malformed, 1);
  assert.equal(out.turns.length, 1);
});

// -- filter rules ------------------------------------------------------------

function turn(text: string, role: "user" | "assistant" = "user") {
  return {
    sourceKey: "k", harness: "claude-code" as const, sessionId: "s", sourceFile: "f",
    uuid: "u", role, text, ts: "2026-11-15T00:00:00.000Z", projectDir: "p",
  };
}

test("explicit remember wins and is attributed", () => {
  const out = applyRules([turn("记住：部署脚本要加 --frozen-lockfile")]);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].ruleId, "explicit-remember");
});

test("conclusion rule only takes user side", () => {
  const { kept, hits } = applyRules([turn("决定：用 PG 不用 SQLite", "user"), turn("决定：用 PG 不用 SQLite", "assistant")]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].turn.role, "user");
  assert.equal(hits["conclusion"], 1);
});

test("handoff rule catches unfinished work", () => {
  const out = applyRules([turn("待办：迁移脚本还没写完")]);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].ruleId, "handoff");
});

test("trivial imperatives are dropped", () => {
  const out = applyRules([turn("继续"), turn("好的"), turn("嗯")]);
  assert.equal(out.kept.length, 0);
  assert.equal(out.dropped, 3);
});

test("substantive user turn is kept even without keywords", () => {
  const long = "这个记忆系统的核心问题是导入历史数据时不知道哪些是有价值的，所以需要一个可解释的筛选规则，你帮我看看下面这个方案是否可行，特别是规则命中率这一块";
  const out = applyRules([turn(long)]);
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].ruleId, "substantive-user-turn");
});

test("assistant turns without keywords are dropped", () => {
  const out = applyRules([turn("这是一个很长的助手回答，描述了很多实现细节但是没有任何用户侧的结论词，按照规则不该被导入到长期记忆里去。", "assistant")]);
  assert.equal(out.kept.length, 0);
});

test("every rule is enumerable with a description", () => {
  assert.ok(BUILTIN_RULES.length >= 4);
  for (const r of BUILTIN_RULES) {
    assert.ok(r.id && r.description, "each rule has id + description");
    assert.equal(typeof r.test, "function");
  }
});

// -- noise rejection (discovered against real transcripts, not guessed) ------

test("harness plumbing never becomes memory", () => {
  const noise = [
    "<local-command-stdout>Set model to `x`",
    "<command-name>/model</command-name>",
    "<system-reminder>reminder</system-reminder>",
    "Base directory for this skill: /Users/me/.claude/skills/x",
    "[Your previous response had no visible output. Please continue]",
    "[Request interrupted by user for tool use]",
  ];
  for (const n of noise) {
    const out = applyRules([turn(n + " 记住：这条规则很重要")]);
    assert.equal(out.kept.length, 0, `noise should be dropped: ${n.slice(0, 40)}`);
  }
});

test("assistant echo of a user instruction is not an explicit memory", () => {
  const out = applyRules([turn("好的，我会记住：部署要加 --frozen-lockfile", "assistant")]);
  assert.equal(out.kept.length, 0);
});

test("assistant plan is not a user handoff", () => {
  const out = applyRules([turn("下一步我会先跑测试，然后提交。", "assistant")]);
  assert.equal(out.kept.length, 0);
});

test("real user conclusion still gets through", () => {
  const out = applyRules([turn("决定：以后都用 PG，不再用 SQLite 做多智能体存储")]);
  assert.equal(out.kept.length, 1, "user-side decision survives both filters");
});

test("harness envelopes delivered through the user lane are noise", () => {
  const cases = [
    "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>",
    "前面的用户话\n<task-notification><task-id>x</task-id></task-notification>",
    "Another Claude session sent a message: <agent-message from=\"a1\">hi</agent-message>",
  ];
  for (const c of cases) {
    const out = applyRules([turn(c)]);
    assert.equal(out.kept.length, 0, `envelope should be dropped: ${c.slice(0, 40)}`);
  }
});

test("ZCode-specific injection that synthetic does not catch", () => {
  const cases = [
    "Run custom command /opsx:explore. Command source: project/zcode.",
    "Command source: project",
    "/opsx:apply something",
    "You are implementing part of an OpenSpec change (x) in /Users/me",
    "Enter explore mode. Think deeply.",
    "Called the Read tool with the following input: {...}",
  ];
  for (const c of cases) {
    const out = applyRules([turn(c)]);
    assert.equal(out.kept.length, 0, `should be noise: ${c.slice(0, 40)}`);
  }
});

test("genuine ZCode user statements survive", () => {
  const real = [
    "以后都不允许给cheap集群放scraw镜像，你用tencent集群放就行",
    "把paas.tokenvault.vip改成 paas.token118.com，另外两个我改好了",
  ];
  for (const c of real) {
    assert.equal(applyRules([turn(c)]).kept.length, 1, `should be kept: ${c.slice(0, 30)}`);
  }
});

test("task-dispatch briefs are not memories", () => {
  const cases = [
    "你在 /Users/chengsishi/finddata/fd-wire 仓库实施 OpenSpec change `x` 的团队端点部分",
    "你是 fd-industry-data 爬虫内容仓的建造代理。任务：新建爬虫单元",
    "你负责撰写一个谦面（facet）预设技能稿。",
    "你在 /Users/chengsishi/finddata 写一份**初步洽淡用方案书**（不含价格）",
  ];
  for (const c of cases) {
    assert.equal(applyRules([turn(c)]).kept.length, 0, `dispatch brief: ${c.slice(0, 30)}`);
  }
});

test("credentials never become memories (they get delivered to CLAUDE.md)", () => {
  // Synthetic shapes only — real secrets must never appear in a test file.
  const cases = [
    "github_pat_" + "A".repeat(30) + " 这个是一个可用key",
    "用这个 token ghp_" + "b".repeat(36) + " 拉代码",
    "账号是 admin，user@example.com " + "Zx9Qw8Er",
    "password: " + "x".repeat(16),
    "密码：" + "y".repeat(16),
    "Authorization: Bearer " + "c".repeat(30),
    "-----BEGIN RSA PRIVATE KEY-----",
  ];
  for (const c of cases) {
    const out = applyRules([turn(c)]);
    assert.equal(out.kept.length, 0, `credential must be dropped: ${c.slice(0, 30)}`);
  }
});

test("ordinary technical talk about keys is still allowed", () => {
  // Discussing the CONCEPT must not be blocked — only actual secret material.
  const ok = "逻辑是这样的，用户可以选择用自己的search的key，但是如果用户不配置，admin配置的池他们也可以用";
  assert.equal(applyRules([turn(ok)]).kept.length, 1);
});

test("tool_call titles carry a gist, not just the tool name", () => {
  // 2026-11-16: 275 of 405 captured pages shared the title "tool_call Bash",
  // making the layer unsearchable by label.
  const withCmd = mapHookEvent("zcode", "post-tool-use", {
    tool_name: "Bash", cwd: "/tmp", tool_input: { command: "kubectl get pods -n fd-prod" },
  });
  assert.ok(withCmd);
  assert.ok(withCmd!.title.includes("kubectl get pods"), withCmd!.title);

  const withPath = mapHookEvent("zcode", "post-tool-use", {
    tool_name: "Edit", cwd: "/tmp", tool_input: { file_path: "/Users/me/app.ts" },
  });
  assert.ok(withPath!.title.includes("app.ts"), withPath!.title);

  // No identifying input → falls back to the plain label, never empty.
  const bare = mapHookEvent("zcode", "post-tool-use", { tool_name: "TodoWrite", cwd: "/tmp" });
  assert.equal(bare!.title, "tool_call TodoWrite");
});

test("舰队派发模板不算用户交办的未竟事项", () => {
  // 2026-11-16 实测：zcode-fleet driver 每轮把同一段收尾纪律打给会话，两个
  // 变体里都含「下一步」⇒ 被 handoff 规则收成 note。96 条 note 里 56 条是它。
  const variants = [
    "你来主导本轮开发，允许做任何你觉得必要的操作，继续。\n收尾纪律（务必遵守）：\n1. 用一句话交代：本轮做了什么、还剩什么。\n2. 若你承载的 openspec change 剩余 ≤5 项，优先推完并归档。\n3. 若 change 已归档、任务全部完成、无下一步可推进，请以「任务已完成」开头作答。",
    "继续按你自己的计划推进开发，完成当前步骤后自主选择下一步。\n收尾纪律（务必遵守）：\n1. 交代本轮做了什么、还剩什么。\n2. 承载的 openspec change 剩 ≤5 项时，优先推完并归档。",
  ];
  for (const text of variants) {
    const out = applyRules(
      [{ sourceKey: "k", harness: "zcode", sessionId: "s", sourceFile: "/tmp/x", uuid: "u",
         role: "user", text, ts: "2026-11-16T00:00:00Z", projectDir: "p" }],
      BUILTIN_RULES,
    );
    assert.equal(out.kept.length, 0, `应被过滤：${text.slice(0, 20)}`);
  }
});
