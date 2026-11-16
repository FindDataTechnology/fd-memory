// Full-profile gate (add-harness-memory-import task 2.3).
//
// `--profile full` is the "不过滤" mode the spec scenario refuses to run
// silently: every extracted turn becomes a candidate, so on a 8.4 GB / 84 万-row
// source it would recreate the lock outage the whole import design exists to
// avoid. Unconfirmed it must refuse WITH an estimated write volume; `--yes` is
// the only way through. These tests pin both the in-process pieces and the CLI
// behavior (exit code + estimate + nothing written).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StoreRoot } from "../store.js";
import {
  fullProfileNeedsConfirmation,
  planClaudeImport,
  rulesForProfile,
  runClaudeImport,
} from "../connect/import/orchestrator.js";
import { BUILTIN_RULES } from "../connect/import/rules.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function turn(uuid: string, text: string, role = "user", ts = "2026-11-15T10:00:00.000Z") {
  return JSON.stringify({ type: role, uuid, timestamp: ts, message: { role, content: text } });
}

/** 4 turns: 3 explicit-remember + 1 plain chatter (light drops it, full keeps it). */
const TURNS = [
  turn("u1", "记住：部署要加 --frozen-lockfile"),
  turn("u2", "以后都用 pnpm 而不是 npm"),
  turn("u3", "别再把 dist 提交进仓库"),
  turn("u4", "今天天气不错，出去走走"),
];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "fd-profile-src-"));
  const proj = join(dir, "-tmp-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "s1.jsonl"), TURNS.join("\n") + "\n", "utf8");
  return dir;
}

test("profile rule sets: light uses the built-ins, full keeps everything", () => {
  assert.equal(rulesForProfile("light"), BUILTIN_RULES);
  const full = rulesForProfile("full");
  assert.equal(full.length, 1);
  assert.equal(full[0].id, "profile-full");
  // The plain-chatter turn that light's rules reject is kept by full's.
  const sample = {
    sourceKey: "k", harness: "claude-code" as const, sessionId: "s", sourceFile: "f",
    uuid: "u", role: "user" as const, text: "今天天气不错", ts: "2026-11-15T10:00:00.000Z", projectDir: "p",
  };
  assert.equal(full[0].test(sample), true);
});

test("confirmation gate fires only for unconfirmed full", () => {
  assert.equal(fullProfileNeedsConfirmation("light", false), false);
  assert.equal(fullProfileNeedsConfirmation("light", true), false);
  assert.equal(fullProfileNeedsConfirmation("full", true), false);
  assert.equal(fullProfileNeedsConfirmation("full", false), true);
});

test("estimate plans without stamping the ledger (refusal leaves no state)", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-profile-root-"));
  const src = fixture();
  try {
    const root = new StoreRoot(data, "d-nostamp");
    const plan = planClaudeImport(root, { projectsDir: src, rules: rulesForProfile("full"), stamp: false });
    assert.equal(plan.estimatedWrites, 4, "full keeps every turn");
    assert.ok(!existsSync(join(root.rootDir, "import", "claude-code.sources.json")), "no ledger written");
    assert.ok(!existsSync(join(root.rootDir, "import", "claude-code.cursor.json")), "no cursor written");
    assert.equal(root.db.observationsForSession("s1").length, 0, "nothing stored");

    // The stamping path (dry-run / real runs) still persists it.
    planClaudeImport(root, { projectsDir: src, stamp: true });
    assert.ok(existsSync(join(root.rootDir, "import", "claude-code.sources.json")));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("a plan-only stamp does not suppress the real run (dry-run poison regression)", async () => {
  // Regression: before the keys guard, a stamped-but-never-imported file
  // (keys: []) looked "unchanged" to the next run, so "dry-run then real run"
  // silently imported nothing.
  const data = mkdtempSync(join(tmpdir(), "fd-profile-poison-"));
  const src = fixture();
  try {
    const root = new StoreRoot(data, "d-poison");
    planClaudeImport(root, { projectsDir: src, stamp: true });
    const res = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0 });
    assert.equal(res.written, 3, "light rules still write their 3 hits after a plan-only stamp");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("full profile confirmed in-process writes every turn", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-profile-full-"));
  const src = fixture();
  try {
    const root = new StoreRoot(data, "d-fullok");
    const res = await runClaudeImport(root, "default", { projectsDir: src, batchPauseMs: 0, rules: rulesForProfile("full") });
    assert.equal(res.written, 4, "plain chatter lands too");
    assert.equal(root.db.observationsForSession("s1").length, 4);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("CLI: --profile full without --yes refuses with an estimate and writes nothing", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-profile-cli-"));
  const src = fixture();
  try {
    const r = spawnSync(process.execPath, [CLI, "import", "claude-code", "--root", "d-clig", "--dir", src, "--profile", "full"], {
      env: { ...process.env, FD_MEMORY_DATA: data },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0, "exit code is non-zero");
    assert.ok(r.stdout.includes("estimatedWrites"), "the estimate is in the output");
    assert.ok(r.stdout.includes('"estimatedWrites": 4'), `estimate says 4, got: ${r.stdout.slice(0, 400)}`);
    assert.ok((r.stderr ?? "").includes("拒绝"), "the refusal names itself in Chinese");
    const root = new StoreRoot(data, "d-clig");
    assert.equal(root.db.observationsForSession("s1").length, 0, "nothing written");
    assert.ok(!existsSync(join(root.rootDir, "import", "claude-code.cursor.json")));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("CLI: --profile full --yes executes", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-profile-cli2-"));
  const src = fixture();
  try {
    const r = spawnSync(
      process.execPath,
      [CLI, "import", "claude-code", "--root", "d-cliy", "--dir", src, "--profile", "full", "--yes"],
      { env: { ...process.env, FD_MEMORY_DATA: data }, encoding: "utf8" },
    );
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('"written": 4'), `wrote all 4, got: ${r.stdout.slice(0, 500)}`);
    const root = new StoreRoot(data, "d-cliy");
    assert.equal(root.db.observationsForSession("s1").length, 4);
    const cursor = JSON.parse(readFileSync(join(root.rootDir, "import", "claude-code.cursor.json"), "utf8"));
    assert.equal(cursor.keys.length, 4);
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("CLI: invalid profile is a usage error, not a run", () => {
  const data = mkdtempSync(join(tmpdir(), "fd-profile-cli3-"));
  const src = fixture();
  try {
    const r = spawnSync(
      process.execPath,
      [CLI, "import", "claude-code", "--root", "d-cliz", "--dir", src, "--profile", "everything"],
      { env: { ...process.env, FD_MEMORY_DATA: data }, encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.ok((r.stderr ?? "").includes("--profile must be light"));
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});
