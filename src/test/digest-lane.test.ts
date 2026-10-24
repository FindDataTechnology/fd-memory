// /digest platform-seam face tests (add-cluster-digest-injection task 1.2):
// permission matrix (person own-root / platform+rootKey / agent refused),
// embed-lane degradation (keyword fallback + model_note, request still 200),
// server-side parameter clamps, end-to-end assembly with annotations and
// handoffs section. No sidecar needed — the vector lane is absent in tests,
// which is itself the degradation path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-digestlane-"));
}

test("/digest: permission matrix, degradation, clamps, assembly", async () => {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p" });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const platform = svc.tokens.mint("platform", "*").token;
    const dep = svc.tokens.mint("deployment", "d/pk/agentA").token;
    const root = svc.rootForKey("u-alice");
    root.writeDistillPage("cluster-42", "experience", {
      id: "exp_d1", engine: "engine:test/1", confidence: 0.8,
      task: "集群回合巡检排障", search_keys: ["巡检", "集群"], solution: "## Task\n集群回合巡检排障\n## Solution\n先读 digest 再分派",
      sources: [], supersedes: [],
    });
    root.writeDistillPage("cluster-42", "fact", {
      id: "fact_d1", engine: "engine:test/1", confidence: 0.7,
      statement: "集群共享记忆在 owner root 的 cluster project", subject: "cluster",
      sources: [], supersedes: [],
    });
    root.db.upsertHandoff({
      id: "ho-digest-1", project: "cluster-42", from_agent: "member-a",
      summary: "上轮巡检发现队列积压待处理", open_questions: "[]", next_steps: "[\"复核积压\"]", files_touched: "[]",
      to_agent: null, state: "open", accepted_by: null, accepted_at: null, created_at: new Date().toISOString(),
    });

    server = createServer((req, res) => { void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const H = { "content-type": "application/json", authorization: `Bearer ${person}` };

    // person own-root: 200 with assembled digest (annotations + handoffs +
    // keyword fallback note because no sidecar in tests)
    const r1 = await fetch(base + "/digest?project=cluster-42&q=集群回合巡检", { headers: H });
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()) as { digest: string; items: number; truncated: boolean; model_note?: string };
    assert.ok(d1.items >= 1);
    assert.match(d1.digest, /〔L2·experience｜置信 0\.80｜/);
    assert.match(d1.digest, /### 待认领交接/);
    assert.match(d1.digest, /上轮巡检发现队列积压/);
    assert.ok(!d1.digest.includes("## Solution"), "section headers stripped from excerpt");
    assert.match(d1.model_note ?? "", /keyword-only/, "no sidecar in tests → degradation note");
    assert.equal(d1.truncated, false);

    // platform with rootKey reaches the same root; platform without rootKey → 400
    const r2 = await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=集群", { headers: { authorization: `Bearer ${platform}` } });
    assert.equal(r2.status, 200);
    assert.equal((await fetch(base + "/digest?project=cluster-42&q=x", { headers: { authorization: `Bearer ${platform}` } })).status, 400);
    // agent refused even with rootKey; person with rootKey rejected
    assert.equal((await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: { authorization: `Bearer ${dep}` } })).status, 403);
    assert.equal((await fetch(base + "/digest?rootKey=u-alice&project=cluster-42&q=x", { headers: H })).status, 400);

    // clamps: k=50/budget=99999 clamped server-side, still 200
    const r3 = await fetch(base + "/digest?project=cluster-42&q=集群&k=50&budget=99999", { headers: H });
    assert.equal(r3.status, 200);

    // empty project → 400
    assert.equal((await fetch(base + "/digest?q=x", { headers: H })).status, 400);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    rmSync(data, { recursive: true, force: true });
  }
});
