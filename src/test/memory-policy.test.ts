// Memory policy (add-agent-memory-declaration): the process axis resolves, the
// read face reports declared vs effective vs executed, and the distill switch
// stops being an operator-only env var.
//
// Two behaviours carry the whole point of the change, and both are tested from
// both sides because a one-sided green is how "declared but not in force" passed
// review last time:
//   ① deployment default OFF + team declares ON  → distillation happens
//   ② deployment default ON  + project declares OFF → distillation does not
//
// Real service, real port (harden-memory-surfaces §1: the shipped bugs lived in
// the parameter/scope seams, and a mock tests the mock).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Service } from "../http.js";
import { StoreRoot } from "../store.js";
import { TokenStore } from "../auth.js";
import { DistillScheduler } from "../distill-scheduler.js";
import {
  DISTILL_INHERIT,
  deploymentDefaults,
  distillEnabled,
  normalizePolicy,
  resolvePolicy,
  unexecuted,
} from "../policy.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpData(prefix = "fdm-policy-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function boot(env: Record<string, string> = {}) {
  const data = tmpData();
  const svc = new Service({ dataDir: data, port: 0, pepper: "p", env });
  const server = createServer((req, res) => {
    void (svc as unknown as { route(req: unknown, res: unknown): Promise<void> }).route(req as never, res as never);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { svc, base, close };
}

const json = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

// ── normalize: closed key set, named rejections ────────────────────────────

test("normalize: unknown sub-key is refused and names the known set", () => {
  const res = normalizePolicy({ distil: "off" }, "process");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.errors[0].code, "policy_key_unknown");
  assert.equal(res.errors[0].key, "process.distil");
  assert.match(res.errors[0].message, /distill/);
});

test("normalize: bounds are refused, never clamped", () => {
  for (const [body, code] of [
    [{ promote_after: 0 }, "policy_promote_after_invalid"],
    [{ promote_after: "3" }, "policy_promote_after_invalid"],
    [{ cold_after_days: -1 }, "policy_cold_after_days_invalid"],
    [{ distill: "maybe" }, "policy_distill_invalid"],
  ] as const) {
    const res = normalizePolicy(body, "process");
    assert.equal(res.ok, false, JSON.stringify(body));
    if (!res.ok) assert.equal(res.errors[0].code, code);
  }
});

test("normalize: omission survives (it is what lets the next level inherit)", () => {
  const res = normalizePolicy({ distill: "off" }, "process");
  assert.ok(res.ok);
  if (res.ok) assert.deepEqual(res.doc, { distill: "off" });
});

test("normalize: an empty document is a valid empty declaration", () => {
  const res = normalizePolicy({}, "process");
  assert.ok(res.ok);
  if (res.ok) assert.deepEqual(res.doc, {});
});

// ── resolve: three columns + executed ──────────────────────────────────────

test("resolve: project beats root beats deployment default, with provenance", () => {
  const rows = resolvePolicy(
    [
      ["project", { distill: "off" }],
      ["root", { distill: "on", promote_after: 7 }],
    ],
    { distill: "on" },
  );
  assert.equal(rows.distill.effective, "off");
  assert.equal(rows.distill.inherited_from, "project");
  assert.equal(rows.distill.declared, "off");
  assert.equal(rows.promote_after.effective, 7);
  assert.equal(rows.promote_after.inherited_from, "root");
});

test("resolve: inherit keeps looking upward instead of meaning 'unset'", () => {
  const rows = resolvePolicy(
    [
      ["project", { distill: DISTILL_INHERIT }],
      ["root", { distill: "off" }],
    ],
    { distill: "on" },
  );
  assert.equal(rows.distill.declared, DISTILL_INHERIT);
  assert.equal(rows.distill.effective, "off");
  assert.equal(rows.distill.inherited_from, "root");
});

test("resolve: nothing declared anywhere lands on the deployment default", () => {
  const rows = resolvePolicy([["project", {}], ["root", {}]], { distill: "off" });
  assert.equal(rows.distill.effective, "off");
  assert.equal(rows.distill.inherited_from, "deployment");
  assert.equal(rows.distill.declared, null);
});

test("resolve: promote_after and cold_after_days resolve but report unexecuted", () => {
  const rows = resolvePolicy(
    [["project", { promote_after: 5, cold_after_days: 90 }], ["root", {}]],
    {},
  );
  assert.equal(rows.promote_after.effective, 5);
  assert.equal(rows.cold_after_days.effective, 90);
  assert.equal(rows.distill.executed, true);
  assert.equal(rows.promote_after.executed, false);
  assert.equal(rows.cold_after_days.executed, false);
  assert.deepEqual(unexecuted(rows), ["promote_after", "cold_after_days"]);
});

test("deployment default demotes FD_MEMORY_DISTILL_U to a default value", () => {
  assert.equal(deploymentDefaults("u-alice", { FD_MEMORY_DISTILL_U: "0" }).distill, "off");
  assert.equal(deploymentDefaults("u-alice", {}).distill, "on");
  // The switch never applied to fleet roots; it still does not.
  assert.equal(deploymentDefaults("d-pack", { FD_MEMORY_DISTILL_U: "0" }).distill, "on");
  // A declaration at any level wins over this default.
  assert.equal(distillEnabled([["root", { distill: "on" }]], { distill: "off" }), true);
});

// ── /policy route: the read face and its rejections ────────────────────────

test("/policy: PUT refuses an unknown key by name, GET reports executed flags", async () => {
  const { svc, base, close } = await boot();
  try {
    const platform = svc.tokens.mint("platform", "*").token;

    const bad = await fetch(`${base}/policy?rootKey=d-pk&project=agentA`, {
      method: "PUT",
      headers: json(platform),
      body: JSON.stringify({ process: { distil: "off" } }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { error: string; errors: Array<{ key: string }>; known_keys: string[] };
    assert.equal(badBody.error, "policy_invalid");
    assert.equal(badBody.errors[0].key, "process.distil");
    assert.ok(badBody.known_keys.includes("distill"));

    const put = await fetch(`${base}/policy?rootKey=d-pk&project=agentA`, {
      method: "PUT",
      headers: json(platform),
      body: JSON.stringify({ process: { distill: "off", cold_after_days: 90 } }),
    });
    assert.equal(put.status, 200);

    const got = await fetch(`${base}/policy?rootKey=d-pk&project=agentA`, { headers: json(platform) });
    assert.equal(got.status, 200);
    const view = (await got.json()) as {
      rows: Record<string, { declared: unknown; inherited_from: string | null; effective: unknown; executed: boolean }>;
      not_executed: string[];
    };
    assert.equal(view.rows.distill.effective, "off");
    assert.equal(view.rows.distill.executed, true);
    assert.equal(view.rows.cold_after_days.effective, 90);
    assert.equal(view.rows.cold_after_days.executed, false, "declared value must not read as in force");
    assert.deepEqual(view.not_executed, ["cold_after_days"]);

    // Clearing is the rollback path: row gone, inherited values return.
    const cleared = await fetch(`${base}/policy?rootKey=d-pk&project=agentA`, {
      method: "PUT",
      headers: json(platform),
      body: JSON.stringify({ process: {} }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as { cleared: boolean }).cleared, true);
    const after = await fetch(`${base}/policy?rootKey=d-pk&project=agentA`, { headers: json(platform) });
    const afterView = (await after.json()) as { rows: Record<string, { inherited_from: string | null }> };
    assert.equal(afterView.rows.distill.inherited_from, "deployment");
  } finally {
    await close();
  }
});

test("/policy: tenant tokens cannot name a sibling root; platform tokens must", async () => {
  const { svc, base, close } = await boot();
  try {
    const person = svc.tokens.mint("person", "u/alice").token;
    const platform = svc.tokens.mint("platform", "*").token;

    const a = await fetch(`${base}/policy?rootKey=d-other&project=x`, { headers: json(person) });
    assert.equal(a.status, 400);
    assert.equal(((await a.json()) as { error: string }).error, "rootKey_is_platform_seam_only");

    const b = await fetch(`${base}/policy?project=x`, { headers: json(platform) });
    assert.equal(b.status, 400);
    assert.equal(((await b.json()) as { error: string }).error, "rootKey_required");

    const own = await fetch(`${base}/policy?project=default`, { headers: json(person) });
    assert.equal(own.status, 200, "a person token resolves its own root");
  } finally {
    await close();
  }
});

// ── the two distill behaviours, both directions ────────────────────────────

function schedulerFixture(env: Record<string, string>) {
  const data = tmpData("fdm-policy-distill-");
  const tokens = new TokenStore(join(data, "tokens.db"), "p");
  const roots = new Map<string, StoreRoot>();
  const openRoot = (key: string) => {
    let r = roots.get(key);
    if (!r) {
      r = new StoreRoot(data, key);
      roots.set(key, r);
    }
    return r;
  };
  const calls: string[] = [];
  const sched = new DistillScheduler({
    roots,
    openRoot,
    tokens,
    env,
    policyFor: (rootKey: string) => {
      const root = openRoot(rootKey);
      const projects: Record<string, Record<string, string | number>> = {};
      for (const scope of root.db.memoryPolicyScopes()) {
        if (scope === "root") continue;
        projects[scope] = root.db.getMemoryPolicy(scope);
      }
      return { root: root.db.getMemoryPolicy("root"), projects };
    },
    fetchImpl: (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/embed")) {
        return { ok: true, status: 200, json: async () => ({ vectors: [[0.1, 0.2]], model: "m-test", tokens: 3, errors: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          facts: [],
          experiences: [],
          cursor_next: {},
          llm_calls: [{ stage: "distill_extract", ok: true, prompt_tokens: 10, completion_tokens: 5 }],
          tokens: 15,
          errors: [],
        }),
      };
    }) as unknown as typeof fetch,
    now: () => Date.now(),
  });
  return { sched, openRoot, calls };
}

const GATES = { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1" };

test("policy ON beats a deployment default OFF (the switch is no longer the only voice)", async () => {
  const fx = schedulerFixture({ ...GATES, FD_MEMORY_DISTILL_U: "0" });
  const root = fx.openRoot("u-carol@test");
  root.db.setMemoryPolicy("root", { distill: "on" });
  root.writePage("default", "notes", "n1", {
    frontmatter: { type: "note", title: "偏好", generated: { by: "test", at: "2026-11-12T00:00:00.000Z" } },
    body: "正文",
  } as never);
  await new Promise((r) => setTimeout(r, 5));

  await fx.sched.distillNow("u-carol@test", "default");
  assert.ok(
    fx.calls.some((u) => u.endsWith("/distill")),
    "a declared root policy on must override the deployment default off",
  );
  const state = root.db.getDistillState("default");
  assert.ok(state && state.note_cursor !== "", "the note cursor advanced");
});

test("rollback: clearing the policy row returns the decision to the deployment default", async () => {
  const env = { ...GATES, FD_MEMORY_DISTILL_U: "0" };
  const fx = schedulerFixture(env);
  const root = fx.openRoot("u-dave@test");
  const writeNote = (rel: string, at: string) =>
    root.writePage("default", "notes", rel, {
      frontmatter: { type: "note", title: "偏好", generated: { by: "test", at } },
      body: "正文",
    } as never);

  // With a declared policy on, the drain distils despite the deployment default off.
  root.db.setMemoryPolicy("root", { distill: "on" });
  writeNote("n1", "2026-11-12T00:00:00.000Z");
  await new Promise((r) => setTimeout(r, 5));
  await fx.sched.distillNow("u-dave@test", "default");
  const withPolicy = fx.calls.filter((u) => u.endsWith("/distill")).length;
  assert.ok(withPolicy > 0, "declared on must distil");

  // Clearing the row is the rollback: no code change, the env default takes over.
  root.db.deleteMemoryPolicy("root");
  assert.deepEqual(root.db.getMemoryPolicy("root"), {}, "row cleared");
  fx.calls.length = 0;
  writeNote("n2", "2026-11-12T01:00:00.000Z");
  await new Promise((r) => setTimeout(r, 5));
  await fx.sched.distillNow("u-dave@test", "default");
  assert.equal(
    fx.calls.filter((u) => u.endsWith("/distill")).length,
    0,
    "after the row is gone the deployment default (off) decides again",
  );
});

test("rollback: GET /policy reports the inherited source after a clear", async () => {
  const { svc, base, close } = await boot({ FD_MEMORY_DISTILL_U: "0" });
  try {
    const platform = svc.tokens.mint("platform", "*").token;
    await fetch(`${base}/policy?rootKey=u-erin&project=default&scope=root`, {
      method: "PUT",
      headers: json(platform),
      body: JSON.stringify({ process: { distill: "on" } }),
    });
    const before = (await (await fetch(`${base}/policy?rootKey=u-erin&project=default`, { headers: json(platform) })).json()) as {
      rows: Record<string, { effective: unknown; inherited_from: string | null }>;
    };
    assert.equal(before.rows.distill.effective, "on");
    assert.equal(before.rows.distill.inherited_from, "root");

    await fetch(`${base}/policy?rootKey=u-erin&project=default&scope=root`, {
      method: "PUT",
      headers: json(platform),
      body: JSON.stringify({ process: {} }),
    });
    const after = (await (await fetch(`${base}/policy?rootKey=u-erin&project=default`, { headers: json(platform) })).json()) as {
      rows: Record<string, { effective: unknown; inherited_from: string | null }>;
    };
    assert.equal(after.rows.distill.effective, "off", "deployment default (env 0) decides again");
    assert.equal(after.rows.distill.inherited_from, "deployment");
  } finally {
    await close();
  }
});

test("policy OFF beats a deployment default ON", async () => {
  const fx = schedulerFixture({ ...GATES });
  const root = fx.openRoot("d-pk");
  root.db.addObservation({
    session_id: "s1",
    agent: "a",
    event: "stop",
    summary: "定位",
    tool: null,
    created_at: "2026-11-12T00:00:00.000Z",
    project: "agentA",
  });
  root.db.setMemoryPolicy("agentA", { distill: "off" });

  await fx.sched.distillNow("d-pk", "agentA");
  assert.equal(
    fx.calls.filter((u) => u.endsWith("/distill")).length,
    0,
    "a project declaration off must stop the drain",
  );
  const state = root.db.getDistillState("agentA");
  assert.ok(!state || !state.obs_cursor, "no cursor movement for a project that declared off");
});
