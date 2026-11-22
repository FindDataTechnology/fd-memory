// FD_MEMORY_EMBED=off must silence the VECTOR LANE EVERYWHERE, not just in the
// scheduler (2026-11-18).
//
// Measured: the switch was set (launchd showed `FD_MEMORY_EMBED => off`) and the
// service still logged an embed 404 on every read —
//   "[hybrid] embed query failed — keyword-only candidates: embed NotFoundError:
//    Model "Qwen/Qwen3-Embedding-8B" is not supported by any configured account"
// Cause: `EMBED_DISABLED` was consulted only inside DistillScheduler.embed().
// `hybridCandidates` — the seam EVERY read face goes through — never looked at
// it, so /digest and /memory each paid a doomed round-trip before falling back.
// A kill switch that one seam honours and another ignores is worse than none:
// the logs say "the lane is unavailable" while the setting says "we turned it
// off", and the operator cannot tell which is true.
//
// These tests pin the contract at the seam, not at the call sites, so a new
// caller cannot silently re-open the lane.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreRoot } from "../store.js";
import { DistillScheduler, hybridCandidates, embedDisabled } from "../distill-scheduler.js";
import { TokenStore } from "../auth.js";

function fixture() {
  const data = mkdtempSync(join(tmpdir(), "fd-embedoff-"));
  const root = new StoreRoot(data, "d-kill");
  root.writePage("agentA", "facts", "f1", {
    frontmatter: { type: "fact", title: "毛利率口径", statement: "按扣除退货后口径", tier: "draft" },
    body: "口径说明\n",
  } as never);
  return { data, root };
}

test("embedDisabled parses the documented spellings and nothing else", () => {
  for (const off of ["off", "OFF", "0", "false", "no", " off "]) {
    assert.equal(embedDisabled({ FD_MEMORY_EMBED: off } as never), true, `${JSON.stringify(off)} must disable`);
  }
  for (const on of ["on", "1", "true", "", "yes"]) {
    assert.equal(embedDisabled({ FD_MEMORY_EMBED: on } as never), false, `${JSON.stringify(on)} must NOT disable`);
  }
  // Unset keeps today's behaviour: a real model must not be switched off by
  // omission.
  assert.equal(embedDisabled({} as never), false, "unset must leave the lane enabled");
});

test("hybridCandidates never calls embed when the lane is disabled", async () => {
  const { data, root } = fixture();
  try {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      // Mirrors the production gateway: the model does not exist.
      throw new Error('Model "Qwen/Qwen3-Embedding-8B" is not supported by any configured account');
    };
    const saved = process.env.FD_MEMORY_EMBED;
    process.env.FD_MEMORY_EMBED = "off";
    try {
      const out = await hybridCandidates({ root, project: "agentA", queryFor: "毛利率", k: 5, embed });
      assert.equal(calls, 0, "the disabled lane must not be called at all — not called-and-failed");
      // Keyword recall still answers: disabling vectors degrades, never empties.
      assert.ok(Array.isArray(out), "recall still returns a list");
    } finally {
      if (saved === undefined) delete process.env.FD_MEMORY_EMBED; else process.env.FD_MEMORY_EMBED = saved;
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("…and the same seam DOES call embed when the lane is enabled", async () => {
  // The pair matters: without it, a gate that is accidentally always-on would
  // pass the test above while silently killing vector recall for everyone.
  const { data, root } = fixture();
  try {
    let calls = 0;
    const embed = async () => {
      calls += 1;
      return { vectors: [[0.1, 0.2]], model: "m-test", tokens: 3 };
    };
    const saved = process.env.FD_MEMORY_EMBED;
    delete process.env.FD_MEMORY_EMBED;
    try {
      await hybridCandidates({ root, project: "agentA", queryFor: "毛利率", k: 5, embed });
      assert.equal(calls, 1, "an enabled lane must be consulted exactly once");
    } finally {
      if (saved !== undefined) process.env.FD_MEMORY_EMBED = saved;
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("the scheduler honours the same switch through its own opts.env", async () => {
  const data = mkdtempSync(join(tmpdir(), "fd-embedoff-s-"));
  try {
    const tokens = new TokenStore(join(data, "tokens.db"), "p");
    const root = new StoreRoot(join(data, "owners"), "d-kill");
    const roots = new Map([["d-kill", root]]);
    let calls = 0;
    const sched = new DistillScheduler({
      roots,
      openRoot: (k: string) => roots.get(k)!,
      tokens,
      env: { FD_MEMORY_DISTILLER_URL: "http://sidecar.test", FD_MEMORY_DISTILL_ENABLED: "1", FD_MEMORY_EMBED: "off" } as unknown as NodeJS.ProcessEnv,
      fetchImpl: (async (url: RequestInfo | URL) => {
        if (String(url).includes("/embed")) calls += 1;
        return { ok: true, status: 200, json: async () => ({ vectors: [], model: "", tokens: 0, errors: [] }) };
      }) as unknown as typeof fetch,
    });
    // embedViaSidecar is private; exercise it through the public shape that
    // matters — a distill run must not reach for embeddings when disabled.
    const anySched = sched as unknown as { embed: (t: string[]) => Promise<unknown> };
    if (typeof anySched.embed === "function") {
      await anySched.embed(["毛利率"]);
      assert.equal(calls, 0, "scheduler embed must be inert under FD_MEMORY_EMBED=off");
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
