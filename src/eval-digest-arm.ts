// Digest-arm block construction, extracted from scripts/eval-continue.mjs so the
// merged-vs-split comparison is unit-testable (add-digest-merge-eval-arm 2.1).
//
// Why this has to be a module and not script-local code: the whole comparison is
// "same retrieval, same budget, different partition segmentation". If the two
// arms drifted in *any* other respect — a different k, an un-labelled merged
// block, a budget that silently doubled — the difference the judge scores would
// no longer be the merge, and the run would still produce numbers.
import type { StoreRoot } from "./store.js";
import type { ContinueScene } from "./continue-scenes.js";
import { hybridCandidates } from "./distill-scheduler.js";
import { renderDigest } from "./digest.js";
import type { DigestItem } from "./digest.js";

export type EmbedFn = (texts: string[]) => Promise<{ vectors: number[][]; model: string; tokens: number }>;

export interface DigestBlockOptions {
  /** Partitions to read in ONE request. Single-partition callers omit it. */
  projects?: string[];
  /** Token ceiling for this render. Omitted → EVAL_BUDGET_TOKENS ?? 1500. */
  budget?: number;
  k?: number;
  embed: EmbedFn;
  /** Freeze the render's "now" so two arms are comparable byte-for-byte. */
  now?: string;
  /** Ablation switch carried over from the script (EVAL_NO_HANDOFFS). */
  noHandoffs?: boolean;
  /** Partition tag per entry — on for merged (matches production), off for
   *  single-partition reads (matches the legacy /digest shape). */
  labelSources?: boolean;
  log?: { warn: (msg: string) => void };
}

export interface DigestBlockResult {
  block: string;
  nItems: number;
  projects: string[];
}

const NOTES_LIMIT = 5;

/** One `/digest`-shaped render over the requested partitions. Mirrors the
 *  production face: L2 recall via hybridCandidates, references by name, L1 notes
 *  recent-first, open handoffs capped at 3. The ONLY thing `projects` changes is
 *  how many partitions that single recall spans. */
export async function buildDigestBlock(
  root: StoreRoot,
  scene: ContinueScene,
  ownProject: string,
  opts: DigestBlockOptions
): Promise<DigestBlockResult> {
  const k = opts.k ?? 5;
  const budget = Number(opts.budget ?? 1500);
  const projects = opts.projects && opts.projects.length ? [...new Set(opts.projects)] : [ownProject];
  const now = opts.now ?? new Date().toISOString();
  const tasks = scene.task?.trim() ?? "";

  // Metadata lookup must cover BOTH partitions: a shared candidate looked up
  // only in the own fixture loses its confidence/date, and the merged block
  // would then differ from the split blocks for a reason unrelated to merging.
  const byId = new Map<string, { confidence?: number | null; updated_at?: string }>();
  for (const p of scene.history.pages) byId.set(p.id, p);
  for (const p of scene.history.sharedPages ?? []) byId.set(p.id, p);

  const candidates = await hybridCandidates({
    root,
    project: ownProject,
    projects,
    queryFor: scene.task,
    k,
    embed: opts.embed,
    log: opts.log ?? { warn: () => {} },
  });

  const items: DigestItem[] = candidates.map((c) => {
    const meta = byId.get(c.id);
    return {
      id: c.id,
      layer: "L2",
      kind: c.kind,
      title: c.task,
      // Partition tag, EXACTLY as the production face sets it (http.ts:
      // `source: c.project ?? primary`). labelSources alone renders nothing —
      // the tag only appears when the item carries a source. Missing this made
      // the merged arm an untagged block that also differed from production.
      ...(opts.labelSources ? { source: c.project ?? ownProject } : {}),
      // page bodies carry "## Task/## Solution" headers — strip for the excerpt
      excerpt: String(c.solution ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 150),
      confidence: meta?.confidence ?? null,
      updated_at: meta?.updated_at ?? null,
    };
  });

  // References by name (add-unified-memory-and-outputs): citation-by-name rides
  // ahead of L2/notes, canonical first, drafts never on a query miss. Read from
  // the own partition only — the shared partition carries no reference lane in
  // production either.
  const refLimit = Math.min(3, Math.max(1, Math.floor(k / 2)));
  const refs = root.db.queryReferences(ownProject, tasks, refLimit);
  const refItems: DigestItem[] = refs.map((p) => ({
    id: p.path,
    layer: "L2",
    kind: "reference",
    ...(opts.labelSources ? { source: String(p.path).split("/")[0] } : {}),
    title: `见资料库《${p.title}》`,
    excerpt: String(p.body ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    confidence: null,
    updated_at: p.updated_at,
  }));

  // L1 notes: query-matched first, then recent, capped — per partition, so a
  // merged read sees both partitions' notes exactly as production does.
  const noteItems: DigestItem[] = [];
  for (const p of projects) {
    const matched = tasks ? root.db.queryNotes(p, tasks, 3) : [];
    const matchedPaths = new Set(matched.map((x) => x.path));
    const picked = [...matched, ...root.db.recentNotes(p, NOTES_LIMIT).filter((x) => !matchedPaths.has(x.path))].slice(0, NOTES_LIMIT);
    for (const note of picked) {
      const page = root.readPageByRel(note.path);
      noteItems.push({
        id: note.path,
        layer: "L1",
        kind: "note",
        // Same rule as production (http.ts): the tag is the path's first
        // segment, which IS the partition a note lives in.
        ...(opts.labelSources ? { source: String(note.path).split("/")[0] } : {}),
        title: note.title,
        excerpt: String(page?.body ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 100),
        confidence: null,
        updated_at: note.updated_at,
      });
    }
  }

  const HANDOFF_MAX_AGE_MS = 48 * 3600_000;
  const handoffs = opts.noHandoffs
    ? []
    : scene.history.handoffs
        .filter((h) => h.state === "open" && Date.now() - Date.parse(h.created_at) < HANDOFF_MAX_AGE_MS)
        .slice(0, 3)
        .map((h) => ({ id: h.id, summary: h.summary, to_agent: h.to_agent, created_at: h.created_at }));

  const allItems = [...refItems, ...items, ...noteItems];
  const block = renderDigest({
    items: allItems,
    handoffs,
    budgetTokens: budget,
    now,
    ...(opts.labelSources ? { labelSources: true } : {}),
  });
  return { block, nItems: allItems.length, projects };
}

export interface ArmBlocks {
  /** Own+shared in ONE request, one unified budget, per-entry source tags. */
  merged: DigestBlockResult;
  /** Two single-partition requests, each half the total budget. */
  split: DigestBlockResult & { parts: { project: string; block: string }[] };
  totalBudget: number;
}

/** The two comparison arms (design D3): identical retrieval and identical TOTAL
 *  budget; only the partition segmentation differs. Giving the merged arm the
 *  whole budget without halving the split arm's segments would turn "merging
 *  saves a request" into "merging buys more context" — a different question. */
export async function buildMergeArms(
  root: StoreRoot,
  scene: ContinueScene,
  ownProject: string,
  opts: Omit<DigestBlockOptions, "projects" | "budget" | "labelSources"> & { totalBudget?: number; sharedProject?: string }
): Promise<ArmBlocks> {
  const total = Number(opts.totalBudget ?? 800);
  const sharedProject = opts.sharedProject ?? "shared";
  const seg = Math.max(64, Math.floor(total / 2));

  const merged = await buildDigestBlock(root, scene, ownProject, { ...opts, projects: [ownProject, sharedProject], budget: seg * 2, labelSources: true });

  const parts: { project: string; block: string }[] = [];
  for (const p of [ownProject, sharedProject]) {
    const r = await buildDigestBlock(root, scene, ownProject, { ...opts, projects: [p], budget: seg });
    parts.push({ project: p, block: r.block });
  }
  // Join with a blank line: the split arm must be ONE injected block to the
  // judge, or the transcript differs structurally from the merged arm's.
  const splitBlock = parts.map((p) => p.block).filter((b) => b.trim()).join("\n\n");
  const split = {
    block: splitBlock,
    nItems: parts.length, // informational only; nItems is not the comparison metric
    projects: [ownProject, sharedProject],
    parts,
  };

  return { merged, split, totalBudget: seg * 2 };
}
