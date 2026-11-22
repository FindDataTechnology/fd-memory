// Disk fallback for session-start memory injection (2026-11-19).
//
// Why it exists: `buildSessionContext` returned "" on ANY failure, so a down
// service meant a session started with NO memory. On this machine the service is
// down a lot (31 concurrent sessions, 60MB free RAM, load 24-37) — turning
// "temporarily unavailable" into "you have no memory" is the one thing a memory
// system must never do.
//
// The index pages are plain markdown under <data>/owners/<root>/wiki/<project>/
// memory-index/*.md, so they stay readable exactly when the service does not.
//
// What these tests pin:
//   · it actually reads real pages and produces the documented line format
//   · it honours the character budget (the injected text rides EVERY session's
//     system prompt, so an unbounded fallback would be worse than none)
//   · it FAILS CLOSED — no data dir, no root, missing directory all return ""
//     rather than throwing (a broken fallback must not block session start)
//   · the degraded marker is present, so a thinner injection never masquerades
//     as a healthy one

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexFromDisk } from "../connect/cli.js";

function page(title: string, harness: string, kind: string): string {
  return [
    "---",
    "type: memory-index",
    `title: ${title}`,
    "metadata:",
    `  harness: ${harness}`,
    `  memory_type: ${kind}`,
    "---",
    "body\n",
  ].join("\n");
}

function fixture(specs: Array<{ name: string; title: string; harness: string; kind: string }>) {
  const data = mkdtempSync(join(tmpdir(), "fd-fallback-"));
  const dir = join(data, "owners", "u-test", "wiki", "default", "memory-index");
  mkdirSync(dir, { recursive: true });
  for (const s of specs) writeFileSync(join(dir, `${s.name}.md`), page(s.title, s.harness, s.kind));
  return { data, dir };
}

const binding = { url: "http://x", namespace: "u/test", token: "t", project: "default", bound_at: "" };

test("reads index pages from disk and renders the documented line format", () => {
  const { data } = fixture([
    { name: "a", title: "结论甲", harness: "claude-code", kind: "project" },
    { name: "b", title: "纪律乙", harness: "zcode", kind: "feedback" },
  ]);
  const saved = process.env.FD_MEMORY_DATA;
  process.env.FD_MEMORY_DATA = data;
  try {
    const out = readIndexFromDisk("default", binding, 3000, false);
    assert.ok(out.length > 0, "fallback must produce something with pages on disk");
    assert.match(out, /- 〔project·claude-code〕结论甲/, `line format wrong:\n${out}`);
    assert.match(out, /- 〔feedback·zcode〕纪律乙/);
  } finally {
    if (saved === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = saved;
    rmSync(data, { recursive: true, force: true });
  }
});

test("says it is degraded, so a thin injection never looks like a healthy one", () => {
  const { data } = fixture([{ name: "a", title: "X", harness: "h", kind: "project" }]);
  const saved = process.env.FD_MEMORY_DATA;
  process.env.FD_MEMORY_DATA = data;
  try {
    const out = readIndexFromDisk("default", binding, 3000, false);
    assert.match(out, /服务不可达/, "must announce the service is unreachable");
    assert.match(out, /服务恢复后本行消失/, "must explain that the marker is temporary");
  } finally {
    if (saved === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = saved;
    rmSync(data, { recursive: true, force: true });
  }
});

test("honours the character budget (this text rides every system prompt)", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    name: `p${i}`, title: `很长的一条结论 ${i} `.repeat(4), harness: "claude-code", kind: "project",
  }));
  const { data } = fixture(many);
  const saved = process.env.FD_MEMORY_DATA;
  process.env.FD_MEMORY_DATA = data;
  try {
    const out = readIndexFromDisk("default", binding, 800, false);
    assert.ok(out.length <= 800 + 120, `budget overrun: ${out.length} chars for a 800 budget`);
    assert.ok(out.length > 200, `budget so tight nothing came through: ${out.length}`);
  } finally {
    if (saved === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = saved;
    rmSync(data, { recursive: true, force: true });
  }
});

test("fails closed on every missing input rather than throwing", () => {
  const saved = process.env.FD_MEMORY_DATA;
  try {
    // no data dir env
    delete process.env.FD_MEMORY_DATA;
    assert.equal(readIndexFromDisk("default", binding), "", "no FD_MEMORY_DATA ⇒ empty, not throw");

    // unusable namespace
    process.env.FD_MEMORY_DATA = tmpdir();
    assert.equal(readIndexFromDisk("default", { ...binding, namespace: "garbage" }), "", "bad namespace ⇒ empty");

    // directory that does not exist
    assert.equal(readIndexFromDisk("no-such-project", binding), "", "missing project dir ⇒ empty");
  } finally {
    if (saved === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = saved;
  }
});

test("a diagnostic call does not record an injection (probes must not mutate)", async () => {
  // A manual probe used to write the freshness record, which claimed a session
  // had been injected AND reset the staleness clock — hiding a real gap. The
  // `record` flag exists so ops code can inspect without lying to the record.
  const { readInjectionState } = await import("../connect/injection-state.js");
  const data = mkdtempSync(join(tmpdir(), "fd-fallback-norec-"));
  const home = mkdtempSync(join(tmpdir(), "fd-home-norec-"));
  const dir = join(data, "owners", "u-test", "wiki", "default", "memory-index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.md"), page("X", "h", "project"));
  const savedData = process.env.FD_MEMORY_DATA;
  const savedHome = process.env.YONGYI_HOME;
  process.env.FD_MEMORY_DATA = data;
  process.env.YONGYI_HOME = home;
  try {
    const out = readIndexFromDisk("default", binding, 3000, false);
    assert.ok(out.length > 0, "the probe must still return content");
    assert.equal(readInjectionState(home), null, "a diagnostic call must not write a freshness record");

    // And the production default still records — otherwise the flag would have
    // silently disabled the whole feature.
    readIndexFromDisk("default", binding, 3000);
    assert.ok(readInjectionState(home), "the production path must still record");
  } finally {
    if (savedData === undefined) delete process.env.FD_MEMORY_DATA; else process.env.FD_MEMORY_DATA = savedData;
    if (savedHome === undefined) delete process.env.YONGYI_HOME; else process.env.YONGYI_HOME = savedHome;
    rmSync(data, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
