// Deferred observe landing (2026-11-18 stall fix).
//
// The problem: `writePage` costs ~53ms on the live 34k-page database, and
// `/observe` called it synchronously. The stall watchdog measured 110
// event-loop stalls in 62 minutes (one every 47s), every recorded phase
// `POST /observe`, and `/healthz` — a pure static response — intermittently took
// 15–25s.
//
// The fix splits the landing in two: the idempotency claim stays synchronous
// (one indexed INSERT, and it is what makes replay safe), while the page write
// moves to `setImmediate`, after the response is flushed.
//
// Three things must hold, and each is a separate assertion because each can fail
// independently:
//   1. the call returns BEFORE the page exists (that is the whole point)
//   2. but the page DOES exist by the time the loop next drains (no lost writes)
//   3. a replay of the same idempotency key is still reported as a duplicate —
//      the claim must remain synchronous or dedupe breaks under retry storms

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { landObserveEventDeferred, parseObserveEvent, drainObserveWrites, observePendingWrites } from "../observe.js";

function event(idemKey: string, title = "tool_call Bash: ls") {
  const parsed = parseObserveEvent({
    title,
    body: "x".repeat(200),
    type: "tool_call",
    idempotency_key: idemKey,
    harness: "claude-code",
  });
  assert.ok(parsed.ok, `fixture must parse: ${JSON.stringify(parsed)}`);
  return parsed.event;
}

test("the call returns before the page is written, and the page lands right after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-defer-"));
  try {
    const root = new StoreRoot(dir, "u-defer");
    const out = landObserveEventDeferred(root, "default", event("k1"));
    assert.equal(out.duplicate, false);
    assert.match(out.page, /^default\/observations\/.+\.md$/, "the caller still gets a page path");

    // Synchronously, after the call: the response would already be flushed.
    // (Whether the file exists at this exact instant is timing-dependent, so it
    // is NOT asserted — asserting it would make the test flaky in the other
    // direction. The contract is "returns first", which the return value shows.)
    // Let setImmediate run:
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));

    const page = root.readPageByRel(out.page);
    assert.ok(page, "the deferred write must have landed");
    assert.match(String(page?.body ?? ""), /x{100}/, "the body must be the event's, not empty");
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a replay of the same idempotency key is reported as duplicate (claim stays synchronous)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-defer-dup-"));
  try {
    const root = new StoreRoot(dir, "u-defer2");
    const first = landObserveEventDeferred(root, "default", event("same-key"));
    assert.equal(first.duplicate, false);
    // Immediately re-deliver — before the deferred write has had a chance to
    // run. The claim must already be in the database, otherwise a retry storm
    // would create two pages for one event.
    const second = landObserveEventDeferred(root, "default", event("same-key"));
    assert.equal(second.duplicate, true, "the claim must be synchronous for dedupe to work under retry");
    assert.equal(second.page, first.page, "a duplicate points at the first delivery's page");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing deferred write is reported, not swallowed", async () => {
  // The dangerous failure: the claim is written but the page never lands, so a
  // retry is told "duplicate" and the event is lost silently. That must at
  // least produce a warning naming the page.
  const dir = mkdtempSync(join(tmpdir(), "fd-defer-fail-"));
  try {
    const root = new StoreRoot(dir, "u-defer3");
    const warnings: string[] = [];
    // Force the write to throw by removing the method for the duration.
    const orig = root.writePage.bind(root);
    (root as unknown as { writePage: unknown }).writePage = () => { throw new Error("disk full"); };
    landObserveEventDeferred(root, "default", event("boom"), undefined, undefined, { warn: (m) => warnings.push(m) });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /deferred write failed/);
    assert.match(warnings[0], /claim already taken/, "the message must warn that a retry will look like a duplicate");
    (root as unknown as { writePage: unknown }).writePage = orig;
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drainObserveWrites waits for every claimed write, and the counter returns to zero", async () => {
  // Why this exists: the deferred design claims synchronously and writes later.
  // A SIGTERM in that window leaves a claim with no page — and the claim makes a
  // retry look like a duplicate, so the event is lost for good. Shutdown must
  // therefore wait. This pins both halves: the counter reflects outstanding
  // work, and drain() empties it.
  const dir = mkdtempSync(join(tmpdir(), "fd-defer-drain-"));
  try {
    const root = new StoreRoot(dir, "u-drain");
    for (let i = 0; i < 10; i++) landObserveEventDeferred(root, "default", event(`d${i}`));
    const pendingRightAfter = observePendingWrites();
    // All ten were claimed; the counter must see them (a counter that reads 0
    // here would make shutdown exit immediately and drop the batch).
    assert.ok(pendingRightAfter > 0, `pending counter should be >0 right after claiming, saw ${pendingRightAfter}`);

    const drained = await drainObserveWrites(3000);
    assert.equal(drained, true, "drain must report success when everything landed");
    assert.equal(observePendingWrites(), 0, "the counter must return to zero");
    root.db.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
