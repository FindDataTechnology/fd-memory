// Cross-harness memory contract tests (add-yongyi-complete-solution, spec
// yongyi-cross-harness-memory): one person root, many harnesses. Union recall
// (write face = read face), deployment-root isolation, and persistence after a
// harness goes silent (disconnect is client-side; the root owns the pages).
// Cross-source supersede is root-level by construction and covered by
// distill.test.ts; the full connect→hook→observe→disconnect e2e lives in
// connect.test.ts. These hit a REAL service over a REAL port.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { __resetEmbedGate } from "../embed-gate.js";
import { __resetObserveRateLimiter } from "../observe.js";

const dirs: string[] = [];
afterEach(() => {
  __resetObserveRateLimiter();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  __resetEmbedGate();
  __resetObserveRateLimiter();
  const data = mkdtempSync(join(tmpdir(), "fdm-crossharness-"));
  dirs.push(data);
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

test("cross-harness: two harnesses write one person root, digest recalls the union with both badges", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;

    // harness A (claude-code) writes via the platform-side /observe tap
    const viaObserve = await fetch(`${base}/observe`, {
      method: "POST",
      headers: json(person),
      body: JSON.stringify({
        type: "turn_outcome",
        idempotency_key: "cc-1",
        title: "部署脚本要加 --frozen-lockfile",
        body: "claude-code 会话里用户明确要求，部署口径",
        harness: "claude-code",
      }),
    });
    assert.equal(viaObserve.status, 202);

    // harness B (zcode) writes via the MCP-backed /pages face, same root
    const viaPages = await fetch(`${base}/pages`, {
      method: "POST",
      headers: json(person),
      body: JSON.stringify({
        project: "default",
        title: "周报模板定稿",
        body: "zcode 会话里沉淀的模板口径",
        metadata: { harness: "zcode" },
      }),
    });
    assert.equal(viaPages.status, 200);

    // write face = read face: the union is recallable from the same root
    const dg = await fetch(`${base}/digest?project=default&q=部署`, { headers: json(person) });
    assert.equal(dg.status, 200);
    const { digest } = (await dg.json()) as { digest: string };
    assert.ok(digest.includes("部署脚本要加 --frozen-lockfile"), "harness A page recalled from harness B's world");
    assert.ok(digest.includes("（来自 claude-code）"), "harness A badge");

    const dg2 = await fetch(`${base}/digest?project=default&q=周报`, { headers: json(person) });
    const { digest: digest2 } = (await dg2.json()) as { digest: string };
    assert.ok(digest2.includes("周报模板定稿"), "harness B page recalled");
    assert.ok(digest2.includes("（来自 zcode）"), "harness B badge");

    // portal-visible provenance: GET /pages carries the metadata column (a
    // JSON string per row) whose harness field the Portal badge renders
    const pagesRes = await fetch(`${base}/pages?project=default`, { headers: json(person) });
    const pagesDoc = (await pagesRes.json()) as { pages?: Array<{ title: string; metadata: string | null }> };
    const harnesses = (pagesDoc.pages ?? [])
      .map((p) => { try { return JSON.parse(p.metadata ?? "{}") as Record<string, unknown>; } catch { return {}; } })
      .map((m) => m.harness)
      .filter(Boolean);
    assert.ok(harnesses.includes("claude-code") && harnesses.includes("zcode"), "both sources visible in the read face");
  } finally {
    await close();
  }
});

test("cross-harness: deployment roots stay isolated — a d/ page never leaks into the person root's faces", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;

    // a fleet member's PRIVATE page lands in its own partition (d/pk root)
    const depWrite = await fetch(`${base}/pages`, {
      method: "POST",
      headers: json(dep),
      body: JSON.stringify({ project: "agentA", title: "岗位私有草稿", body: "turn 私有输出" }),
    });
    assert.equal(depWrite.status, 200);

    // the owner browsing their own root sees nothing of it
    const dg = await fetch(`${base}/digest?project=default&q=草稿`, { headers: json(person) });
    const { digest } = (await dg.json()) as { digest: string };
    assert.ok(!digest.includes("岗位私有草稿"), "deployment private page absent from the person digest");
    const mem = await fetch(`${base}/memory?project=default`, { headers: json(person) });
    const body = await mem.text();
    assert.ok(!body.includes("岗位私有草稿"), "deployment private page absent from the person read face");
  } finally {
    await close();
  }
});

test("cross-harness: a harness going silent (disconnect is client-side) leaves its pages recallable", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/bob").token;
    await fetch(`${base}/observe`, {
      method: "POST",
      headers: json(person),
      body: JSON.stringify({
        type: "turn_outcome",
        idempotency_key: "cc-9",
        title: "卸载前的记忆",
        body: "claude-code 时期写入",
        harness: "claude-code",
      }),
    });
    // disconnect removes config artifacts only — the server has no per-harness
    // session to end, and the pages belong to the person root. Simulate the
    // after-disconnect world: no further claude-code writes, recall continues.
    const dg = await fetch(`${base}/digest?project=default&q=卸载`, { headers: json(person) });
    const { digest } = (await dg.json()) as { digest: string };
    assert.ok(digest.includes("卸载前的记忆"), "pages persist, owned by the root not the tool");
  } finally {
    await close();
  }
});
