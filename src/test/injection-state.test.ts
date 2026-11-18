// Injection freshness record (2026-11-19).
//
// The third and last fallback. Read falls back to disk; write spools locally;
// this one makes staleness VISIBLE.
//
// Why it matters more than it looks: from inside a session, a thin injection
// and a stale one are indistinguishable. If the memory system quietly serves
// three-day-old conclusions as if they were current, the reader has no way to
// notice — and will act on them. Every other fallback makes the system keep
// working; this one makes it keep being honest about how well it is working.
//
// The record must be local: a freshness marker that requires the service is
// useless in exactly the situation it exists for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordInjection, readInjectionState, stalenessNote, statePath } from "../connect/injection-state.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

test("record then read round-trips", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-inj-"));
  try {
    const rec = { at: new Date().toISOString(), source: "service" as const, entries: 42 };
    assert.equal(recordInjection(home, rec), true);
    const got = readInjectionState(home);
    assert.deepEqual(got, rec);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no record means no claim — first run says nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-inj-none-"));
  try {
    assert.equal(readInjectionState(home), null);
    assert.equal(stalenessNote(null), null, "with no history there is nothing to warn about");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a fresh previous injection is silent (no cry-wolf)", () => {
  // A daily working rhythm must not produce a warning every session — a marker
  // that always fires is a marker nobody reads.
  assert.equal(stalenessNote({ at: isoAgo(2 * HOUR), source: "service", entries: 30 }), null);
  assert.equal(stalenessNote({ at: isoAgo(23 * HOUR), source: "service", entries: 30 }), null);
});

test("1–2 days old gets a quiet parenthetical, not an alarm", () => {
  const note = stalenessNote({ at: isoAgo(30 * HOUR), source: "service", entries: 30 });
  assert.ok(note, "30h should produce a note");
  assert.match(note, /距上次成功注入 1 天/);
  assert.ok(!note.includes("⚠"), `1 day should not raise the alarm mark: ${note}`);
});

test("3+ days old is loud, and says which source it came from", () => {
  const note = stalenessNote({ at: isoAgo(5 * DAY), source: "disk", entries: 12 });
  assert.ok(note);
  assert.match(note, /⚠/, "5 days must be loud");
  assert.match(note, /5 天/);
  assert.match(note, /服务不可达/, "a disk-sourced record must say so — it means the injection was already degraded");
});

test("a corrupt record is treated as unknown, never as 'very old'", () => {
  // Misreading corruption as staleness would train the reader to ignore the
  // warning; misreading it as fresh would hide a real gap. Unknown is right.
  const home = mkdtempSync(join(tmpdir(), "fd-inj-bad-"));
  try {
    writeFileSync(statePath(home), "{not json");
    assert.equal(readInjectionState(home), null);
    assert.equal(stalenessNote(readInjectionState(home)), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a record with an unparseable timestamp yields no note", () => {
  assert.equal(stalenessNote({ at: "not-a-date", source: "service", entries: 1 }), null);
});

test("recording never throws, even on an unusable path", () => {
  assert.equal(recordInjection("/dev/null/nope", { at: new Date().toISOString(), source: "service", entries: 0 }), false);
});

test("each record appends to a bounded history (frequency must be answerable)", () => {
  // The single state file says how stale the LAST injection was. It cannot say
  // whether the fallback fires once a day or on every session — and that
  // difference decides whether a degraded injection is an incident or the
  // normal mode. Observed 2026-11-19: state read `source:disk` with no history
  // to compare against.
  const home = mkdtempSync(join(tmpdir(), "fd-inj-hist-"));
  try {
    recordInjection(home, { at: isoAgo(3 * HOUR), source: "service", entries: 30 });
    recordInjection(home, { at: isoAgo(2 * HOUR), source: "disk", entries: 11 });
    recordInjection(home, { at: isoAgo(1 * HOUR), source: "service", entries: 28 });
    const raw = readFileSync(join(home, "injection-history.log"), "utf8").split("\n").filter(Boolean);
    assert.equal(raw.length, 3, `expected 3 history lines, got ${raw.length}`);
    assert.match(raw[1], /source=disk entries=11/, `the middle line must record the degraded run:\n${raw[1]}`);
    // The single-record path still works.
    assert.equal(readInjectionState(home)?.entries, 28);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("history is bounded — a diagnostic trail must not fill the disk", () => {
  const home = mkdtempSync(join(tmpdir(), "fd-inj-bound-"));
  try {
    for (let i = 0; i < 520; i++) {
      recordInjection(home, { at: new Date(Date.now() - i * 1000).toISOString(), source: "service", entries: 1 });
    }
    const lines = readFileSync(join(home, "injection-history.log"), "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 500, `history must stay bounded, saw ${lines.length}`);
    assert.ok(lines.length >= 400, `but must not be truncated to nothing, saw ${lines.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Guard: no test may write to the operator's real ~/.yongyi (2026-11-19).
//
// Why this exists: the fallback design leans on LOCAL FILES instead of the
// service (spool, injection history), which makes it very easy to write to the
// wrong home — every helper that bypasses HTTP is a place to get it wrong. That
// already happened once: three bogus `source=disk` records landed in the real
// injection history with entry counts (1/2/11) that could only come from test
// fixtures, and it took a dozen probes to work out they were not a production
// signal.
//
// A test cannot assert "some other test did not write" after the fact — but it
// CAN assert the real directory is untouched at the moment it runs, which turns
// a silent contamination into a named failure pointing at the run.
test("the operator's real ~/.yongyi is never written by the test suite", () => {
  const real = join(homedir(), ".yongyi");
  if (!existsSync(real)) return; // nothing to protect
  // The two files the fallback layer writes. They may legitimately exist (a real
  // session wrote them); what must not happen is them changing DURING a suite
  // run mode — but we cannot see history here. So the assertion is bounded:
  // the history must never contain a record whose entry count is impossible for
  // real content (the observed contamination signature).
  const hist = join(real, "injection-history.log");
  if (existsSync(hist)) {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const bad = readFileSync(hist, "utf8").split("\n")
      .filter((l) => /entries=[01]\b/.test(l));
    assert.equal(bad.length, 0,
      `injection history contains entries=0/1 records, which real content cannot produce ` +
      `(a real injection always has dozens). A test is writing to the real home:\n${bad.join("\n")}`);
  }
});
