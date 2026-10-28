// Eval v0 (add-memory-scopes-and-cluster-sharing): handoff recall + project
// isolation over sanitized real-transcript fixtures. Zero LLM, deterministic;
// runs inside `npm test` and doubles as the baseline the distiller change
// will be judged against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { TokenStore, namespaceParts } from "../auth.js";
import { StoreRoot } from "../store.js";
import { CaptureIngest, CaptureEvent } from "../capture.js";
import { buildTools } from "../mcp.js";

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../fixtures/eval/${name}`, import.meta.url), "utf8"));
}

function tmpData(): string {
  return mkdtempSync(join(tmpdir(), "fdm-eval-"));
}

function toolsFor(store: TokenStore, data: string, ns: string, kind: "deployment" | "person") {
  const minted = store.mint(kind, ns);
  const scope = store.verify(minted.token)!;
  const root = new StoreRoot(data, namespaceParts(ns).rootKey);
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const out = buildTools(scope, root, { allows: (n, m) => store.allows(scope.tokenId, n, m) })
      .find((t) => t.name === name)!.handler(args) as { content: [{ text: string }]; isError?: boolean };
    return { isError: out.isError === true, body: JSON.parse(out.content[0].text) };
  };
  return { scope, root, call };
}

test("eval v0: site-heal cluster handoff recall", () => {
  const fx = loadFixture("site-heal-cluster.json");
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "pepper");
    // Replay the cluster turn: member observations (runner lane → agent
    // project) + the end-of-turn shared handoff (member MCP lane).
    const roots = new Map<string, StoreRoot>();
    const ingest = new CaptureIngest(roots, (k) => {
      const r = new StoreRoot(data, k);
      roots.set(k, r);
      return r;
    });
    for (const e of fx.capture_events as CaptureEvent[]) {
      ingest.ingest("d-" + fx.pack, "site-heal", [e], { principal: "runner:eval", scope: `d/${fx.pack}/site-heal` });
    }
    const member = toolsFor(store, data, `d/${fx.pack}/site-heal`, "deployment");
    member.call("memory_handoff_begin", { ...fx.handoff, target: fx.handoff.project });

    // Recall: task-derived queries must surface the handoff page in top-5.
    let hit = 0;
    let total = 0;
    for (const q of fx.queries as Array<{ q: string; expect_hit: boolean }>) {
      const res = member.call("memory_query", { q: q.q, limit: 5 });
      assert.equal(res.isError, false, q.q);
      const found = (res.body.results as Array<{ path: string }>).some((r) => String(r.path).includes("/handoffs/"));
      assert.equal(found, q.expect_hit, `query "${q.q}" handoff recall`);
      if (q.expect_hit) { total++; if (found) hit++; }
    }
    console.log(`[eval-v0] cluster handoff recall: ${hit}/${total}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("eval v0: serving turn — shared page recall + member isolation", () => {
  const fx = loadFixture("serving-turn.json");
  const data = tmpData();
  try {
    const store = new TokenStore(join(data, "tokens.db"), "pepper");
    const roots = new Map<string, StoreRoot>();
    const ingest = new CaptureIngest(roots, (k) => {
      const r = new StoreRoot(data, k);
      roots.set(k, r);
      return r;
    });
    const pack = "d-" + fx.pack;
    for (const agent of fx.agents as Array<{ agent_id: string; events: CaptureEvent[]; private_note: { title: string; body: string } }>) {
      for (const e of agent.events) ingest.ingest(pack, agent.agent_id, [e]);
      const t = toolsFor(store, data, `d/${fx.pack}/${agent.agent_id}`, "deployment");
      t.call("memory_write_page", agent.private_note);
    }
    const sharedWriter = toolsFor(store, data, `d/${fx.pack}/${fx.agents[0].agent_id}`, "deployment");
    sharedWriter.call("memory_write_page", { ...fx.shared_page, target: "shared" });

    for (const q of fx.queries as Array<{ agent: string; q: string; expect_hit: boolean; allow_shared?: boolean }>) {
      const t = toolsFor(store, data, `d/${fx.pack}/${q.agent}`, "deployment");
      const res = t.call("memory_query", { q: q.q, limit: 5 });
      assert.equal(res.isError, false, q.q);
      const paths = (res.body.results as Array<{ path: string; source: string }>).map((r) => r.path);
      const anyHit = paths.length > 0;
      assert.equal(anyHit, q.expect_hit, `query "${q.q}" by ${q.agent} — got ${JSON.stringify(paths)}`);
      // A member's default query NEVER returns another member's private pages
      const foreign = paths.filter((p) => !p.startsWith(`${q.agent}/`) && !p.startsWith("shared/"));
      assert.equal(foreign.length, 0, `isolation breach by ${q.agent}: ${JSON.stringify(foreign)}`);
    }
    console.log("[eval-v0] serving isolation: PASS (no cross-member leakage)");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
