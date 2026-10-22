// Distiller candidate retrieval (add-memory-distiller, design D6): v1 has no
// embeddings — candidates are the project's (plus the pack's shared)
// experience/fact pages ranked by keyword overlap with the draft-side query,
// top-8, falling back to "all (≤8)" which is exactly the shape S1 fed the
// reconciler. Forgotten pages and pages already superseded are never
// candidates, and supersede targets resolve only among live candidates.

import { StoreRoot } from "./store.js";
import { readPageFile } from "./okf.js";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export interface DistillCandidate {
  id: string;
  kind: "fact" | "experience";
  task: string; // fact: statement
  search_keys: string[];
  solution: string;
  boundary_envs: string;
  supersedes: string[];
}

function readCandidateFile(root: StoreRoot, rel: string): DistillCandidate | null {
  const page = readPageFile(join(root.wikiDir, rel));
  const fm = page.frontmatter as Record<string, unknown>;
  if (fm.forgotten_at) return null;
  const type = String(fm.type ?? "");
  if (type !== "experience" && type !== "fact") return null;
  const id = rel.split("/").pop()!.replace(/\.md$/, "");
  return {
    id,
    kind: type,
    task: String(fm.task ?? fm.statement ?? fm.title ?? ""),
    search_keys: Array.isArray(fm.search_keys) ? (fm.search_keys as string[]) : [],
    solution: String(page.body).slice(0, 2000),
    boundary_envs: String(fm.boundary_envs ?? ""),
    supersedes: Array.isArray(fm.supersedes) ? (fm.supersedes as string[]) : [],
  };
}

function listCandidateRels(root: StoreRoot, project: string): string[] {
  const out: string[] = [];
  for (const kindDir of ["experiences", "facts"]) {
    const dir = join(root.wikiDir, project, kindDir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".md")) out.push(`${project}/${kindDir}/${entry}`);
    }
  }
  return out;
}

// candidates(root, [project, shared]): live pages, superseded ones filtered
// (a page referenced by another live page's supersedes is history), ranked by
// keyword overlap with `queryFor` (task + search_keys of the new items' most
// recent session — callers pass the observed text digest), top-k.
export function distillCandidates(root: StoreRoot, projects: string[], queryFor: string, k = 8): DistillCandidate[] {
  const live: DistillCandidate[] = [];
  for (const project of projects) {
    for (const rel of listCandidateRels(root, project)) {
      const c = readCandidateFile(root, rel);
      if (c) live.push(c);
    }
  }
  const superseded = new Set(live.flatMap((c) => c.supersedes));
  const active = live.filter((c) => !superseded.has(c.id));
  if (active.length === 0) return [];
  // keyword overlap ranking; empty query degrades to recency-ish (order kept)
  const terms = String(queryFor ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return active.slice(0, k);
  const scored = active.map((c) => {
    const hay = `${c.task} ${c.search_keys.join(" ")} ${c.solution}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.c);
}
