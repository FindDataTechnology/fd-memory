#!/usr/bin/env node
// Scene skeleton builder (add-continuation-eval task 2.1): cuts one scene at
// a session/time boundary from a production dump and appends it (sanitized,
// review:"pending") to fixtures/eval/continue-scenes.json. The dump is produced
// by the in-pod export script (see docs/eval-continue.md); this script only
// cuts locally — it never talks to the cluster.
//
// usage:
//   node scripts/mk-continue-scenes.mjs --dump /tmp/fdm-scenes-dump.json \
//     --project serve --at 2026-10-24T08:00:00Z --id sh-1
// Task and expected_background are HUMAN-authored afterwards (edit the JSON,
// set review:"reviewed" once the sanitization pass is eyeballed).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sanitize } from "../dist/sanitize.js";

const FIXTURE = new URL("../fixtures/eval/continue-scenes.json", import.meta.url);
const MAX_OBS = 400; // fixture carries recent L0 for provenance/judge context, not scratch loading

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dumpFile = arg("dump");
const project = arg("project");
const at = arg("at");
const id = arg("id");
if (!dumpFile || !project || !at || !id) {
  console.error("usage: mk-continue-scenes.mjs --dump <file> --project <p> --at <iso> --id <scene-id>");
  process.exit(1);
}

const dump = JSON.parse(readFileSync(dumpFile, "utf8"));
const src = dump.find((d) => d.project === project);
if (!src) { console.error(`project ${project} not in dump`); process.exit(1); }

const cut = new Date(at).toISOString();
const scene = {
  id,
  source: { root: src.root, project },
  review: "pending",
  boundary_at: cut,
  task: "",
  expected_background: [],
  history: {
    observations: src.observations
      .filter((o) => o.created_at <= cut)
      .slice(-MAX_OBS)
      .map((o) => ({ session_id: o.session_id, event: o.event, tool: o.tool ?? null, summary: sanitize(String(o.summary ?? "")), created_at: o.created_at })),
    handoffs: src.handoffs
      .filter((h) => h.created_at <= cut)
      .map((h) => ({ id: h.id, summary: sanitize(String(h.summary ?? "")), next_steps: sanitize(String(h.next_steps ?? "")), to_agent: h.to_agent ?? null, state: h.state, created_at: h.created_at })),
    pages: src.pages
      .filter((p) => p.updated_at <= cut)
      .map((p) => ({ id: p.id, kind: p.kind, task: sanitize(String(p.task ?? "")), search_keys: (p.search_keys ?? []).map((k) => sanitize(String(k))), solution: sanitize(String(p.solution ?? "").slice(0, 2000)), boundary_envs: p.boundary_envs ? sanitize(String(p.boundary_envs)) : undefined, confidence: p.confidence ?? null, updated_at: p.updated_at, supersedes: p.supersedes ?? [] })),
  },
};

const scenes = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : [];
const prev = scenes.findIndex((s) => s.id === id);
if (prev >= 0) scenes[prev] = scene; else scenes.push(scene);
writeFileSync(FIXTURE, JSON.stringify(scenes, null, 2) + "\n");
console.log(`[mk-continue-scenes] ${id}: ${scene.history.observations.length} obs, ${scene.history.handoffs.length} handoffs, ${scene.history.pages.length} L2 pages (boundary ${cut}) — review: pending, task/expected_background 待人工撰写`);
