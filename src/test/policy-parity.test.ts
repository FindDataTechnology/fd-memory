// Cross-implementation parity for the process axis (task 3.5).
//
// The resolver exists twice on purpose: fd-agent-graph validates declarations
// offline (Python), fd-memory executes them at runtime (TypeScript). Two
// implementations of one inheritance rule WILL drift unless something compares
// them, and the drift surfaces as "the policy face reports a value the worker
// does not use" — the failure this change exists to remove.
//
// Both suites read ../../fixtures/memory-policy-cases.json. Changing the rule
// on one side breaks the other side's test, which is the point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROCESS_KEYS, normalizePolicy, resolvePolicy, unexecuted } from "../policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../fixtures/memory-policy-cases.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    levels: Array<[string, Record<string, string | number>]>;
    deployment: Record<string, string | number>;
    expect: Record<string, { declared: unknown; inherited_from: string | null; effective: unknown; executed: boolean }>;
    not_executed: string[];
  }>;
  rejections: Array<{ name: string; doc: Record<string, unknown>; expect_key: string }>;
};

test("parity: both resolvers agree on every fixture case", () => {
  for (const c of fixture.cases) {
    const rows = resolvePolicy(c.levels, c.deployment);
    for (const key of PROCESS_KEYS) {
      assert.deepEqual(
        rows[key],
        c.expect[key],
        `${c.name}: ${key} disagrees with the shared fixture`,
      );
    }
    assert.deepEqual(unexecuted(rows), c.not_executed, `${c.name}: not_executed differs`);
  }
});

test("parity: both implementations refuse the same offending key", () => {
  for (const r of fixture.rejections) {
    const res = normalizePolicy(r.doc, "process");
    assert.equal(res.ok, false, `${r.name}: must be refused`);
    if (res.ok) continue;
    assert.equal(res.errors[0].key, r.expect_key, `${r.name}: wrong offending key named`);
  }
});
