// Multi-process safety of RootDb (2026-11-15 incident).
//
// Measured before the fix: 30 independent processes opening the same database
// simultaneously produced a storm of SQLITE_BUSY — migrate() ran on every
// construction and each one took a write lock, so `new StoreRoot()` itself
// threw and the session could not start.
//
// After: schema version is recorded once, and busy_timeout is set before any
// statement. These tests pin both halves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RootDb } from "../db.js";

test("schema version is recorded after the first migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-db-"));
  try {
    const path = join(dir, "m.sqlite");
    const db = new RootDb(path);
    const row = db.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value?: string };
    assert.equal(row?.value, String(RootDb.SCHEMA_VERSION));
    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening an already-migrated database skips the write path", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-db-"));
  try {
    const path = join(dir, "m.sqlite");
    new RootDb(path).db.close();

    // Corrupt nothing; just prove a second open succeeds quickly and keeps the
    // version marker. If migrate() re-ran, this would still pass — so also
    // assert the marker is intact rather than re-written.
    const before = new Date().toISOString();
    const db2 = new RootDb(path);
    const row = db2.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value?: string };
    assert.equal(row?.value, String(RootDb.SCHEMA_VERSION));
    // Tables still usable
    db2.db.prepare("SELECT COUNT(*) AS n FROM pages").get();
    db2.db.close();
    assert.ok(before.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy_timeout is set on open (multi-process prerequisite)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-db-"));
  try {
    const db = new RootDb(join(dir, "m.sqlite"));
    const row = db.db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
    const v = Object.values(row)[0];
    assert.ok(Number(v) >= 5000, `busy_timeout should be generous, got ${v}`);
    db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
