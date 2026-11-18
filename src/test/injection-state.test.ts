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
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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
