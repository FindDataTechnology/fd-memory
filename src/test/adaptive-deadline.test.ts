// Adaptive per-call embed budget (fix-digest-adaptive-embed-deadline).
//
// The old code bet a fixed number on every request: a lane drifting between
// 5s and 13s either burned the full wait or degraded a request that would have
// finished. These tests pin the replacement contract:
//   · fast recent samples  → budget tightens (no more paying the cap)
//   · slow recent samples  → budget relaxes but never exceeds the cap
//   · no samples           → stay generous (the cap), never 0
//   · timeouts are labelled `timeout`, and record the REAL elapsed wait
//   · failed samples never feed the budget (they are truncated at the budget,
//     so feeding them back would make the budget feed on itself)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { __resetEmbedGate } from "../embed-gate.js";
import { __resetMetrics, noteEmbedSample, recentEmbedP90, recentEmbedTimeoutFloor, metricsSnapshot } from "../metrics.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-adaptivedl-"));
}

// ── unit: the p90 read itself ──────────────────────────────────────────────

test("recentEmbedP90 ignores failures and needs enough evidence", () => {
  __resetMetrics();
  assert.equal(recentEmbedP90(5), null, "no samples → null (caller stays generous)");
  for (const ms of [100, 200]) noteEmbedSample({ ms, ok: true });
  assert.equal(recentEmbedP90(5), null, "2 samples < 5 → still null, do not adapt on noise");
  for (const ms of [300, 400, 500]) noteEmbedSample({ ms, ok: true });
  assert.equal(recentEmbedP90(5), 500, "5 successes → p90 of [100..500]");
});

test("slow failures never inflate the budget input", () => {
  __resetMetrics();
  for (const ms of [100, 110, 120, 130, 140]) noteEmbedSample({ ms, ok: true });
  const before = recentEmbedP90(5);
  // A timeout sample carries the budget length, not a real completion time.
  // If it were counted, every timeout would raise the budget, which raises the
  // next sample, and so on — the budget would feed on itself.
  for (let i = 0; i < 20; i++) noteEmbedSample({ ms: 8000, ok: false, reason: "timeout" });
  assert.equal(recentEmbedP90(5), before, "failure samples must not move the p90");
});

// ── integration: the budget actually applied to a request ──────────────────

async function withLane<T>(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  env: Record<string, string>,
  fn: (ctx: { base: string; svc: Service }) => Promise<T>,
): Promise<T> {
  // Both gates are module-level state. Without resetting them, a previous test's
  // timeout samples raise this test's budget floor, and a leftover cooldown makes
  // this test skip the lane entirely — failures that read like product bugs but
  // are test bleed.
  __resetEmbedGate();
  __resetMetrics();
  const lane = createServer(handler);
  await new Promise<void>((r) => lane.listen(0, "127.0.0.1", () => r()));
  const lanePort = (lane.address() as { port: number }).port;
  const saved: Record<string, string | undefined> = {};
  for (const k of ["FD_MEMORY_DISTILLER_URL", "DISTILLER_SHARED_TOKEN", ...Object.keys(env)]) {
    saved[k] = process.env[k];
  }
  process.env.FD_MEMORY_DISTILLER_URL = `http://127.0.0.1:${lanePort}`;
  process.env.DISTILLER_SHARED_TOKEN = "t";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(r: unknown, s: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    return await fn({ base, svc });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    lane.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(data, { recursive: true, force: true });
  }
}

test("fast lane: budget tightens so a slow request degrades instead of paying the cap", async () => {
  // Cap 8000 but the lane answers in ~5ms after the first warm-up. With a tight
  // budget the deliberately slow request must be cut off well before 8000ms.
  let calls = 0;
  await withLane(
    (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls += 1;
        const n = (JSON.parse(body || "{}").texts ?? [""]).length;
        // First few calls answer fast (this is what the budget learns from);
        // after that it stalls so we can observe the budget being enforced.
        const delay = calls <= 6 ? 5 : 6000;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ vectors: Array.from({ length: n }, () => [0.2, 0.3]), model: "fast", tokens: n }));
        }, delay);
      });
    },
    { FD_MEMORY_DIGEST_EMBED_DEADLINE_MS: "8000" },
    async ({ base, svc }) => {
      const person = svc.tokens.mint("person", "u/alice").token;
      const H = { authorization: `Bearer ${person}` };
      // Warm the lane so p90 reflects the fast path.
      for (let i = 0; i < 6; i++) {
        await fetch(`${base}/digest?project=default&q=warm${i}`, { headers: H });
      }
      const p90 = recentEmbedP90(3);
      assert.ok(p90 != null && p90 < 500, `expected a fast p90, got ${p90}`);

      const t0 = Date.now();
      const r = await fetch(`${base}/digest?project=default&q=slow-now`, { headers: H });
      const ms = Date.now() - t0;
      const d = (await r.json()) as { model_note?: string };
      assert.equal(r.status, 200);
      assert.match(d.model_note ?? "", /deadline/, "the stalled request degrades");
      assert.ok(ms < 5000, `cut off in ${ms}ms — well under the 8000ms cap, so the budget really did tighten`);
    },
  );
});

test("timeout samples are labelled and record the real elapsed wait", async () => {
  await withLane(
    (req, res) => {
      req.on("data", () => {});
      // Never answer: force our own deadline to fire.
      req.on("end", () => setTimeout(() => { try { res.destroy(); } catch {} }, 30_000));
    },
    { FD_MEMORY_DIGEST_EMBED_DEADLINE_MS: "300" },
    async ({ base, svc }) => {
      __resetMetrics();
      const person = svc.tokens.mint("person", "u/alice").token;
      const t0 = Date.now();
      const r = await fetch(`${base}/digest?project=default&q=stall`, { headers: { authorization: `Bearer ${person}` } });
      const ms = Date.now() - t0;
      assert.equal(r.status, 200);
      const m = metricsSnapshot() as {
        embed: { failure_reasons: Record<string, number>; failed: number };
      };
      assert.equal(m.embed.failed, 1);
      assert.equal(m.embed.failure_reasons["timeout"], 1, "our own deadline gets a stable label, not a free-form message");
      // The recorded wait must be the real elapsed time (≈ the 300ms budget),
      // not 0 and not the cap of some other request.
      assert.ok(ms >= 250 && ms < 3000, `request returned in ${ms}ms`);
    },
  );
});

test("no samples: budget falls back to the configured cap, never zero", async () => {
  await withLane(
    (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const n = (JSON.parse(body || "{}").texts ?? [""]).length;
        // Answer slower than the floor so only a non-zero budget can succeed.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ vectors: Array.from({ length: n }, () => [0.5, 0.6]), model: "m", tokens: n }));
        }, 400);
      });
    },
    { FD_MEMORY_DIGEST_EMBED_DEADLINE_MS: "2000" },
    async ({ base, svc }) => {
      __resetMetrics();
      const person = svc.tokens.mint("person", "u/alice").token;
      const r = await fetch(`${base}/digest?project=default&q=cold`, { headers: { authorization: `Bearer ${person}` } });
      const d = (await r.json()) as { model_note?: string };
      assert.equal(r.status, 200);
      assert.equal(d.model_note, undefined, "first call with no samples must not be starved into degrading");
    },
  );
});

// Real-machine finding (2026-10-29): the success-only p90 made the budget
// COLLAPSE on a bimodal lane. Half the calls took 2s, half 12s; every slow call
// timed out, so the sample window only ever saw 2s, the budget ratcheted down
// to the floor, and the slow half could never be observed again. Timeouts are
// censored observations — "at least this long" — and must push the budget up.
test("timeouts push the budget up instead of letting it collapse", () => {
  __resetMetrics();
  // Bimodal lane: fast successes + timeouts that were cut at an 8s budget.
  for (let i = 0; i < 10; i++) noteEmbedSample({ ms: 2000, ok: true });
  for (let i = 0; i < 10; i++) noteEmbedSample({ ms: 8000, ok: false, reason: "timeout" });

  const p90 = recentEmbedP90(5);
  assert.equal(p90, 2000, "the success-only p90 looks fast — this is the trap");

  const provenTooSmall = recentEmbedTimeoutFloor();
  assert.equal(provenTooSmall, 8000, "an 8s timeout proves 8s was not enough");

  // The composed budget must NOT sit near the fast p90.
  const cap = 8000;
  const floor = 3000;
  const target = Math.max(p90! * 1.5, provenTooSmall * 1.2);
  const budget = Math.min(cap, Math.max(floor, Math.round(target)));
  assert.equal(budget, cap, "budget stays at the cap — it must not starve the slow half");
});

test("a single timeout raises the floor without pinning it forever", () => {
  __resetMetrics();
  // One historic timeout at 5s, then a sustained fast lane.
  noteEmbedSample({ ms: 5000, ok: false, reason: "timeout" });
  for (let i = 0; i < 40; i++) noteEmbedSample({ ms: 300, ok: true });

  const floorFromTimeout = recentEmbedTimeoutFloor();
  assert.equal(floorFromTimeout, 5000);
  // The timeout sample ages out of the 200-entry window; until then the budget
  // is held above 5s, which is the correct reading of "5s was once not enough".
  const budget = Math.min(8000, Math.max(3000, Math.round(Math.max(300 * 1.5, floorFromTimeout * 1.2))));
  assert.equal(budget, 6000, "budget respects the proven-too-small floor (5000 × 1.2)");
});

test("non-timeout failures do not raise the floor", () => {
  __resetMetrics();
  // An upstream 500 says nothing about how long a good call would take.
  noteEmbedSample({ ms: 120, ok: false, reason: "embed HTTP 500" });
  noteEmbedSample({ ms: 0, ok: false, reason: "cooling_down" });
  assert.equal(recentEmbedTimeoutFloor(), 0, "only timeouts are censored latency evidence");
});
