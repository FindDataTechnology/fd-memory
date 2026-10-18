// Local end-to-end (task 7.1): the full fleet-memory loop against an
// in-process service — runner mint, manager-shaped capture, agent-A handoff
// begin over MCP, agent-B accept (claim-once), query hits. Exits non-zero on
// any assertion failure. Run: node scripts/e2e-local.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../dist/http.js";

const data = mkdtempSync(join(tmpdir(), "fdm-e2e-"));
const svc = new Service({ dataDir: data, port: 0, pepper: "e2e" });
const server = createServer((req, res) => svc.route(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const json = { "content-type": "application/json" };
try {
  // 1. runner token + per-deployment mint (spawn path)
  const runner = svc.tokens.mint("runner", "*").token;
  const dep = (await (await fetch(`${base}/admin/mint`, { method: "POST", headers: { ...json, authorization: `Bearer ${runner}` }, body: JSON.stringify({ namespace: "d/pack-e2e/agent-e2e" }) })).json()).token;
  assert.ok(dep.startsWith("fdm_"));

  // 2. manager-shaped capture (platform seam): a couple of turn observations
  for (const [i, summary] of ["turn ok tokens=210 (1400ms)", "turn ok tokens=180 (900ms)"].entries()) {
    const r = await fetch(`${base}/capture`, { method: "POST", headers: { ...json, authorization: `Bearer ${runner}` }, body: JSON.stringify({ namespace: "d/pack-e2e/agent-e2e", events: [{ event: i === 0 ? "session-start" : "stop", session_id: "sess-e2e", agent: "platform-manager", summary }] }) });
    assert.equal(r.status, 200);
  }

  // 3. agent A (any harness) writes a handoff over MCP
  const mcp = async (token, sid, name, args) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { ...json, authorization: `Bearer ${token}`, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }) });
    const body = await r.json();
    return JSON.parse(body.result.content[0].text);
  };
  const initA = await fetch(`${base}/mcp`, { method: "POST", headers: { ...json, authorization: `Bearer ${dep}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const sidA = initA.headers.get("mcp-session-id");
  const begin = await mcp(dep, sidA, "memory_handoff_begin", {
    summary: "e2e stage 1 done: parser shipped",
    open_questions: ["anchor semantics?"],
    next_steps: ["stage 2 validation"],
    files_touched: ["check-links.mjs"],
    agent: "harness-A",
  });
  assert.equal(begin.state, "open");

  // 4. agent B claims exactly once; agent C is rejected
  const initB = await fetch(`${base}/mcp`, { method: "POST", headers: { ...json, authorization: `Bearer ${dep}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const sidB = initB.headers.get("mcp-session-id");
  const claimed = await mcp(dep, sidB, "memory_handoff_accept", { handoff_id: begin.handoff_id, agent: "harness-B" });
  assert.equal(claimed.status, "claimed");
  assert.ok(claimed.handoff.summary.includes("stage 1"));
  const again = await mcp(dep, sidB, "memory_handoff_accept", { handoff_id: begin.handoff_id, agent: "harness-C" });
  assert.equal(again.status, "already_claimed");
  assert.equal(again.accepted_by, "harness-B");

  // 5. query surface sees both the observations and the handoff page
  const q1 = await mcp(dep, sidB, "memory_query", { q: "tokens=210" });
  const q2 = await mcp(dep, sidB, "memory_query", { q: "parser shipped" });
  assert.ok(q1.results.length >= 1, "observation searchable");
  assert.ok(q2.results.length >= 1, "handoff page searchable");

  console.log("E2E PASS: mint → capture → handoff begin → claim-once → query (both surfaces)");
} finally {
  server.close();
  rmSync(data, { recursive: true, force: true });
}
