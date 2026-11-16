// Per-source retract for the harness memory import (change
// add-harness-memory-import, requirement "导入记忆 MUST 标注来源并可整批撤回").
//
// Why a whole-harness retract rather than "delete these rows": an import is a
// bulk act, and the thing a user regrets is the bulk — "take the ZCode import
// back out". Per-record deletion exists already (`forgetPage`); the missing
// capability was "everything this harness ever imported, and nothing else".
//
// Three write shapes, three different mechanisms, on purpose:
//
//   1. Pages  — logical delete (`forgetPage`): frontmark `forgotten_at`, drop the
//               index row and the vector. That is the store's one existing
//               definition of "not visible on any read face", so retract uses it
//               instead of inventing a second one.
//   2. Observations — append a withdraw marker to the append-only log, then drop
//               the index rows (see StoreRoot.retractObservations).
//   3. Sources — NOTHING. The source is read-only evidence; retracting an import
//               must leave every byte of it alone (task 4.3). This module never
//               opens a source file for writing, and deliberately does not even
//               hash them here — the proof lives in the test, not in a side
//               effect at runtime.
//
// The cursor and ledger are left in place on purpose: retract is durable. A
// re-import would otherwise silently put the same rows straight back, which
// would make "撤回" mean "pause". To deliberately start over, delete
// `import/<harness>.cursor.json` — the same documented lever the cursor error
// message already points at.

import type { StoreRoot } from "../../store.js";

/** Agent labels each harness stamps onto what it imports. */
export const HARNESS_IMPORT_LABELS: Record<string, string[]> = {
  "claude-code": ["import:claude-code"],
  zcode: ["import:zcode"],
  // The summary layer rides the zcode harness for cursor purposes but labels its
  // rows `import:summary` (see runSummaryImport) — retracting it must not touch
  // raw zcode turns, so it is its own entry.
  summary: ["import:summary"],
};

export interface RetractReport {
  harness: string;
  labels: string[];
  dryRun: boolean;
  pagesForgotten: number;
  pagesAlreadyForgotten: number;
  observationsDeleted: number;
  markersWritten: number;
  projects: string[];
  /** Retract never writes to a source; reported so the caller can print it. */
  sourcesTouched: 0;
  /** Cursor/ledger are intentionally kept (retract is durable, not a pause). */
  cursorKept: boolean;
}

export interface RetractOptions {
  harness: string;
  /** Count what would happen, change nothing. */
  dryRun?: boolean;
}

/** Labels for a harness, or undefined when the harness is unknown. */
export function labelsForHarness(harness: string): string[] | undefined {
  return HARNESS_IMPORT_LABELS[harness];
}

/**
 * Retract everything `harness` imported into this root.
 *
 * Throws for an unknown harness rather than reporting "0 rows retracted": a typo
 * and an empty import produce the same counters, and only one of them is what the
 * user meant.
 */
export function retractHarness(root: StoreRoot, opts: RetractOptions): RetractReport {
  const labels = labelsForHarness(opts.harness);
  if (!labels) {
    throw new Error(
      `Unknown harness "${opts.harness}". Known: ${Object.keys(HARNESS_IMPORT_LABELS).join(", ")}`,
    );
  }
  const dryRun = opts.dryRun === true;

  const pages = root.db.pagesByMetadataSource(labels);
  let pagesForgotten = 0;
  let pagesAlreadyForgotten = 0;
  for (const page of pages) {
    if (dryRun) {
      // Reading is enough to count; forgetting would write.
      const current = root.readPageByRel(page.path);
      if (current && !current.frontmatter.forgotten_at) pagesForgotten++;
      else pagesAlreadyForgotten++;
      continue;
    }
    if (root.forgetPage(page.path)) pagesForgotten++;
    else pagesAlreadyForgotten++;
  }

  if (dryRun) {
    const projects = root.db.projectsForAgentLabels(labels);
    const observationsDeleted = projects.reduce(
      (n, p) => n + root.db.observationsForAgentLabels(labels, p).length,
      0,
    );
    return {
      harness: opts.harness,
      labels,
      dryRun,
      pagesForgotten,
      pagesAlreadyForgotten,
      observationsDeleted,
      markersWritten: 0,
      projects,
      sourcesTouched: 0,
      cursorKept: true,
    };
  }

  const obs = root.retractObservations(labels);
  return {
    harness: opts.harness,
    labels,
    dryRun,
    pagesForgotten,
    pagesAlreadyForgotten,
    observationsDeleted: obs.deleted,
    markersWritten: obs.markers,
    projects: obs.projects,
    sourcesTouched: 0,
    cursorKept: true,
  };
}
