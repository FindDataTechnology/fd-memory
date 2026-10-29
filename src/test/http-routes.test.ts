// Route-boundary contracts (harden-memory-surfaces §1). These hit a REAL
// service over a REAL port: the bugs this repo actually shipped lived in the
// parameter-parsing / scope-branch seams (`q ?? ""`, clamp expressions,
// kind checks) — mocking those would test the mock, not the surface.
//
//   npm test  (tsc + node --test dist/test/*.test.js)

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { newPage } from "../okf.js";
import { metricsSnapshot, __resetMetrics } from "../metrics.js";
import { __resetEmbedGate } from "../embed-gate.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(prefix = "fdm-routes-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function boot() {
  __resetEmbedGate();
  __resetMetrics();
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { svc, base, close };
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

test("/digest: missing project is a named 400, never an empty 200", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const r = await fetch(`${base}/digest?rootKey=d-probe&q=x`, { headers: json(platform) });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "project_required");
  } finally { await close(); }
});

test("/digest: scope taxonomy — platform needs rootKey, person must not send it, agents refused", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const person = svc.tokens.mint("person", "u/alice").token;
    const agent = svc.tokens.mint("deployment", "d/pk/agentA").token;

    const a = await fetch(`${base}/digest?project=default&q=x`, { headers: json(platform) });
    assert.equal(a.status, 400);
    assert.equal(((await a.json()) as { error: string }).error, "rootKey_required");

    const b = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=x`, { headers: json(person) });
    assert.equal(b.status, 400);
    assert.equal(((await b.json()) as { error: string }).error, "rootKey_is_platform_seam_only");

    const c = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=x`, { headers: json(agent) });
    assert.equal(c.status, 403);
    assert.equal(((await c.json()) as { error: string }).error, "person_token_required");
  } finally { await close(); }
});

test("/digest: blank q (empty / spaces / newlines) is a normal 200 with NO model_note, counted as `empty`", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const root = svc.rootForKey("d-probe");
    root.writePage("default", "facts", "f1", newPage("fact", "结算口径", "T+1 结算以回单为准", { tags: ["财务"] }));
    const before = (metricsSnapshot() as { digest: { empty: number; vector_ratio: number | null; total: number } }).digest;

    for (const q of ["", "   ", "\n\t"]) {
      const r = await fetch(`${base}/digest?rootKey=d-probe&project=default&k=3&q=${encodeURIComponent(q)}`, { headers: json(platform) });
      assert.equal(r.status, 200, `blank q variant ${JSON.stringify(q)} must be a normal 200`);
      const doc = (await r.json()) as Record<string, unknown>;
      assert.equal("model_note" in doc, false, "a blank query never lost a vector rung — no degradation note");
    }
    const after = (metricsSnapshot() as { digest: { empty: number; vector_ratio: number | null; total: number } }).digest;
    assert.equal(after.empty - before.empty, 3, "blank queries ride their own rung");
    assert.equal(after.total, before.total, "the empty rung stays out of the degraded denominator");
    assert.equal(after.vector_ratio, before.vector_ratio, "an idle call must not move vector_ratio");
  } finally { await close(); }
});

test("/digest: k and budget extremes clamp instead of erroring", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    svc.rootForKey("d-probe").writePage("default", "facts", "f1", newPage("fact", "口径", "内容"));
    for (const qs of ["k=0&budget=1", "k=-5&budget=999999999", "k=999&budget=0"]) {
      const r = await fetch(`${base}/digest?rootKey=d-probe&project=default&q=${encodeURIComponent("口径")}&${qs}`, { headers: json(platform) });
      assert.equal(r.status, 200, `${qs} must complete, not error`);
      const doc = (await r.json()) as { items: number };
      assert.ok(Number.isInteger(doc.items) && doc.items >= 0);
    }
  } finally { await close(); }
});

test("/pages/mutate: unknown tier and unknown op are 400s that touch nothing", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const root = svc.rootForKey("d-probe");
    root.writePage("default", "facts", "f1", newPage("fact", "口径", "内容", { tier: "draft" }));
    const rel = "default/facts/f1.md";

    const t = await fetch(`${base}/pages/mutate?rootKey=d-probe`, {
      method: "POST", headers: json(platform), body: JSON.stringify({ path: rel, op: "set_tier", tier: "verified" }),
    });
    assert.equal(t.status, 400);
    assert.equal(((await t.json()) as { error: string }).error, "invalid_tier");
    assert.equal(String(root.readPageByRel(rel)?.frontmatter?.tier ?? "draft"), "draft", "rejected write must not land");

    const o = await fetch(`${base}/pages/mutate?rootKey=d-probe`, {
      method: "POST", headers: json(platform), body: JSON.stringify({ path: rel, op: "delete_page" }),
    });
    assert.equal(o.status, 400);
    const od = (await o.json()) as { error: string; allowed: string[] };
    assert.equal(od.error, "unknown_op");
    assert.deepEqual(od.allowed, ["set_tier", "set_tags"]);
  } finally { await close(); }
});

test("/pages/write: an invalid tier is normalized to draft (documented, deterministic)", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    // /pages/write serves the note|reference face (fact/experience are the
    // distiller's to write); reference needs a source_ref.
    const r = await fetch(`${base}/pages/write?rootKey=d-probe`, {
      method: "POST", headers: json(platform),
      body: JSON.stringify({
        project: "default", type: "reference", title: "口径", body: "内容",
        source_ref: "resource:probe/x.json", slug: "tier-probe", tier: "verified",
      }),
    });
    assert.equal(r.status, 201, "page creation answers 201");
    const page = svc.rootForKey("d-probe").readPageByRel("default/references/tier-probe.md");
    assert.ok(page, "page must exist");
    // the arbitrary string never reaches the page — behavior is "normalize to draft"
    assert.equal(String(page!.frontmatter?.tier ?? "draft"), "draft");
  } finally { await close(); }
});

test("/pages/write: unsupported page type is a named 400 (fact/experience are distiller-written)", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const r = await fetch(`${base}/pages/write?rootKey=d-probe`, {
      method: "POST", headers: json(platform),
      body: JSON.stringify({ project: "default", type: "fact", title: "口径", body: "内容" }),
    });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "unknown_page_type");
  } finally { await close(); }
});

test("/memory: junk filters answer 200 (no 500), agents are refused", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    const agent = svc.tokens.mint("deployment", "d/pk/agentA").token;
    svc.rootForKey("d-probe").writePage("default", "facts", "f1", newPage("fact", "口径", "内容"));

    for (const qs of ["tier=verified", "tier=&tag=,,,", "tag=%00&layer=XYZ", "since=not-a-date&until="]) {
      const r = await fetch(`${base}/memory?rootKey=d-probe&${qs}`, { headers: json(platform) });
      assert.equal(r.status, 200, `${qs} must not blow up the read face`);
      assert.ok(Array.isArray(((await r.json()) as { items: unknown[] }).items));
    }
    const a = await fetch(`${base}/memory?rootKey=d-probe`, { headers: json(agent) });
    assert.equal(a.status, 403);
  } finally { await close(); }
});
