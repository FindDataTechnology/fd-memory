// Import orchestrator (change add-harness-memory-import, design D3–D6).
//
// Ties extractor → rules → store together, with the three properties the spec
// requires and that a naive "read it all and write it" would violate:
//
//   1. Idempotent  — the dedupe key is derived from the SOURCE (harness +
//                    session + record uuid), never from the import run. Rerunning
//                    an unchanged import inserts nothing.
//   2. Incremental — a per-harness cursor records how far we got, so a growing
//                    source is not rescanned from the top.
//   3. Bounded     — writes go in small batches with a pause between them.
//                    Verified in production: 8 concurrent writers against the
//                    8.4 GB SQLite index already fail 75% of the time, so an
//                    unpaced import would recreate that outage.
//
// Dry-run is the default posture: `plan` computes everything and writes nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { StoreRoot } from "../../store.js";
import { newPage } from "../../okf.js";
import { extractClaudeProjects } from "./claude-code.js";
import { extractZcode } from "./zcode.js";
import { extractSummaryLayer, summaryAsTurns } from "./summary.js";
import type { ExtractedTurn, HarnessId } from "./types.js";
import { applyRules, BUILTIN_RULES, type FilterRule } from "./rules.js";

/** Import depth. `light` (default) applies the filter rules; `full` keeps everything. */
export type ImportProfile = "light" | "full";

/**
 * Rules for a profile. `full` is the "不过滤" mode the spec scenario refuses to
 * run silently: every extracted turn is a candidate, so the estimated write
 * volume equals the whole source and the CLI must gate it behind `--yes`.
 */
export function rulesForProfile(profile: ImportProfile): FilterRule[] {
  if (profile === "full") {
    return [{ id: "profile-full", description: "全量档：不过滤（需显式 --yes）", test: () => true }];
  }
  return BUILTIN_RULES;
}

/** Does this invocation need the explicit-confirmation gate? Pure predicate. */
export function fullProfileNeedsConfirmation(profile: ImportProfile, yes: boolean): boolean {
  return profile === "full" && !yes;
}

export interface ZcodeImportOptions {
  dbPath: string;
  rules?: FilterRule[];
  /** Hard cap on extracted turns (trial runs). */
  limit?: number;
  sessionIds?: string[];
  /** Project whose existing memories seed the content-dedupe set. */
  project?: string;
  /** Stamp the source ledger while planning (default true) — see ImportOptions. */
  stamp?: boolean;
}

export interface ImportOptions {
  /** Batch size — how many memories to write before pausing. */
  batchSize?: number;
  /** Pause between batches, milliseconds. */
  batchPauseMs?: number;
  /** Rules to apply (defaults to BUILTIN_RULES). */
  rules?: FilterRule[];
  /** Override the source directory (tests / non-default installs). */
  projectsDir?: string;
  /** Project whose existing memories seed the content-dedupe set. */
  project?: string;
  /**
   * Stamp the source ledger while planning (default true). The full-profile
   * confirmation gate plans WITHOUT stamping: a refusal must leave no state
   * that would change the outcome of the confirmed rerun.
   */
  stamp?: boolean;
}

export interface ImportPlan {
  harness: HarnessId;
  scanned: { files: number; lines: number; turns: number };
  filtered: { kept: number; dropped: number; hits: Record<string, number> };
  /** Turns that survived filtering AND were not already imported. */
  toWrite: Array<{ turn: ExtractedTurn; ruleId: string }>;
  /** Turns skipped because the dedupe key was already recorded. */
  alreadyImported: number;
  /** Turns skipped because the same words are already remembered. */
  duplicateContent: number;
  /** Turns skipped because their source file is byte-identical to last time. */
  skippedUnchanged: number;
  /** Estimated writes, useful before committing to a large import. */
  estimatedWrites: number;
}

export interface ImportResult {
  plan: ImportPlan;
  written: number;
  degraded: number;
  batches: number;
}

/** Cursor file: which source keys have been imported, per harness. */
interface ImportCursor {
  harness: string;
  /** Set of sourceKey values already written. */
  keys: string[];
  updatedAt: string;
}

function cursorPath(root: StoreRoot, harness: string): string {
  return join(root.rootDir, "import", `${harness}.cursor.json`);
}

function loadCursor(root: StoreRoot, harness: string): Set<string> {
  const p = cursorPath(root, harness);
  if (!existsSync(p)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ImportCursor;
    return new Set(Array.isArray(raw.keys) ? raw.keys : []);
  } catch {
    // A corrupt cursor must not silently cause a full re-import (which would
    // double-write). Fail loudly instead.
    throw new Error(
      `Import cursor is unreadable: ${p}\n` +
        `Refusing to proceed — a full re-import would duplicate memories. ` +
        `Delete the file to deliberately start over.`,
    );
  }
}

function saveCursor(root: StoreRoot, harness: string, keys: Set<string>): void {
  const p = cursorPath(root, harness);
  mkdirSync(dirname(p), { recursive: true });
  const doc: ImportCursor = { harness, keys: [...keys].sort(), updatedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(doc), "utf8");
}

/**
 * Content fingerprint for cross-source dedupe.
 *
 * Measured problem: a recurring instruction ("执行 finddata 爬取项目 30 分钟
 * 深度巡检…") appeared 170 times in the imported set because each recurrence is
 * a distinct `part.id`. Deduping by record identity is correct for the cursor
 * (we must not re-read the same row twice) but wrong for memory: the user wants
 * to remember the RULE once, not how many times it was issued.
 *
 * Normalizing whitespace keeps trivial reflows from producing twins.
 */
export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}


/**
 * Content fingerprints already in the store for this project.
 *
 * Read from the observation index (not the log) because this is a planning
 * question, and the index is the fast path. If the index is behind, the worst
 * case is one duplicate slipping in — acceptable, and the record-level cursor
 * still prevents re-importing the same row.
 */
function existingContentFingerprints(root: StoreRoot, project: string): Set<string> {
  const out = new Set<string>();
  const rows = root.db.recentObservations(100000, [project]);
  for (const r of rows) {
    // Imported summaries are `[rule] text`; strip the prefix so a fresh turn
    // hashes to the same value as the one already stored.
    const body = r.summary.replace(/^\[[a-z-]+\] /, "");
    out.add(contentFingerprint(body));
  }
  return out;
}

/**
 * Per-source-file content hash ledger.
 *
 * Why (2026-11-16): memory files are LIVING documents — measured 1 117 of
 * 1 614 were modified within the last 7 days. Re-importing an unchanged file
 * is pure waste; re-importing a changed one is correct but must replace, not
 * duplicate. Keying on the file's sha256 answers both: same hash → skip,
 * different hash → the old records for that file are stale and get replaced.
 *
 * This is the cheap half of the "don't burn tokens on living documents"
 * decision. The expensive half (LLM extraction) is intentionally not done at
 * all for this layer: memory files are ALREADY distilled conclusions.
 */
interface SourceLedger {
  [sourceFile: string]: { hash: string; keys: string[]; importedAt: string };
}

function ledgerPath(root: StoreRoot, harness: string): string {
  return join(root.rootDir, "import", `${harness}.sources.json`);
}

function loadLedger(root: StoreRoot, harness: string): SourceLedger {
  const p = ledgerPath(root, harness);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SourceLedger;
  } catch {
    // A corrupt ledger must not silently cause a full re-import.
    throw new Error(
      `Source ledger is unreadable: ${p}\n` +
        `Refusing to proceed — a full re-import would duplicate memories. Delete it to start over.`,
    );
  }
}

function saveLedger(root: StoreRoot, harness: string, ledger: SourceLedger): void {
  const p = ledgerPath(root, harness);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 1), "utf8");
}

/** sha256 of a source file's bytes, or null when it cannot be read. */
function fileHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Harness-agnostic planning: given already-extracted turns, decide what lands.
 * Extracted separately from the Claude-specific entry point so a second
 * extractor (ZCode) reuses the exact same cursor/filter/dedupe semantics
 * instead of growing its own slightly-different copy.
 */
export function planFromTurns(
  root: StoreRoot,
  harness: HarnessId,
  turns: ExtractedTurn[],
  scanned: ImportPlan["scanned"],
  rules: FilterRule[] = BUILTIN_RULES,
  existingFingerprints?: Set<string>,
  /** Persist the source ledger (default true). The estimate path plans without stamping. */
  stamp = true,
): ImportPlan {
  const filtered = applyRules(turns, rules);
  const cursor = loadCursor(root, harness);
  const ledger = loadLedger(root, harness);

  // Files whose bytes are unchanged since the last import contribute nothing.
  // Computed once per file, not per turn.
  const fileHashCache = new Map<string, string | null>();
  const hashOf = (f: string): string | null => {
    if (!fileHashCache.has(f)) fileHashCache.set(f, fileHash(f));
    return fileHashCache.get(f) ?? null;
  };
  const unchangedFiles = new Set<string>();
  // Snapshot which files were ALREADY in the ledger before this run stamps
  // anything. Without this, stamping file F on its first turn makes the second
  // turn of the same file look "unchanged" against the stamp we just wrote —
  // measured 2026-11-16: any file with ≥2 turns imported 0 memories.
  const stampedBefore = new Set(Object.keys(ledger));
  for (const item of filtered.kept) {
    const prev = ledger[item.turn.sourceFile];
    const cur = hashOf(item.turn.sourceFile);
    if (!cur) continue;
    // A keys:[] ledger entry is a PLAN-ONLY stamp (a dry-run or a full-profile
    // estimate touched this file but nothing was written from it). It must not
    // suppress the file's turns: without the keys guard, "dry-run then real
    // run" silently imported nothing — the real run saw the plan's stamp,
    // called the file unchanged, and skipped every turn (measured 2026-11-16).
    if (prev && prev.keys.length > 0 && stampedBefore.has(item.turn.sourceFile) && cur === prev.hash) {
      unchangedFiles.add(item.turn.sourceFile);
      continue;
    }
    // First sighting (or a changed file): stamp it NOW, even if every turn in
    // it ends up filtered out or deduped. Otherwise a file whose content never
    // wins the content-dedupe check would be re-read on every run forever —
    // which is exactly the cost this ledger exists to avoid.
    if (!prev) ledger[item.turn.sourceFile] = { hash: cur, keys: [], importedAt: new Date().toISOString() };
  }

  const toWrite: ImportPlan["toWrite"] = [];
  let alreadyImported = 0;
  let duplicateContent = 0;
  let skippedUnchanged = 0;
  const seen = new Set<string>();
  const seenContent = new Set<string>(existingFingerprints ?? []);

  for (const item of filtered.kept) {
    const key = item.turn.sourceKey;
    if (unchangedFiles.has(item.turn.sourceFile)) {
      skippedUnchanged++;
      continue;
    }
    if (cursor.has(key) || seen.has(key)) {
      alreadyImported++;
      continue;
    }
    seen.add(key);

    // Same words, different record → already remembered. Counted separately so
    // a dry-run can report why the write count differs from the filter count.
    const fp = contentFingerprint(item.turn.text);
    if (seenContent.has(fp)) {
      duplicateContent++;
      continue;
    }
    seenContent.add(fp);
    toWrite.push(item);
  }

  // Persist immediately: this function owns the stamps it just computed, and
  // runPlan loads its own copy. Leaving the save to runPlan silently discarded
  // every stamp (measured 2026-11-16: ledger stayed at 9 entries across runs).
  // The estimate path (stamp=false) leaves the ledger untouched — a refusal or
  // a dry-run must not leave state that changes the confirmed rerun.
  if (stamp) saveLedger(root, harness, ledger);

  return {
    harness,
    scanned,
    filtered: { kept: filtered.kept.length, dropped: filtered.dropped, hits: filtered.hits },
    toWrite,
    alreadyImported,
    duplicateContent,
    skippedUnchanged,
    estimatedWrites: toWrite.length,
  };
}

/**
 * Compute what an import WOULD do. Pure with respect to the memory store —
 * it reads the cursor but writes nothing.
 */
export function planClaudeImport(root: StoreRoot, opts: ImportOptions = {}): ImportPlan {
  const projectsDir = opts.projectsDir;
  if (!projectsDir) {
    throw new Error("projectsDir is required (usually ~/.claude/projects)");
  }
  const { turns, stats } = extractClaudeProjects(projectsDir);
  return planFromTurns(
    root,
    "claude-code",
    turns,
    { files: stats.files, lines: stats.lines, turns: stats.turns },
    opts.rules ?? BUILTIN_RULES,
    existingContentFingerprints(root, opts.project ?? "default"),
    opts.stamp ?? true,
  );
}

export interface SummaryImportOptions {
  /** Directory holding the *.md summary memories. */
  memoryRoot: string;
  project?: string;
  projectDir?: string;
  rules?: FilterRule[];
  /** Stamp the source ledger while planning (default true) — see ImportOptions. */
  stamp?: boolean;
}

/**
 * Plan a summary-layer import.
 *
 * Summary memories skip the noise rules: they are already distilled, carry no
 * harness injection, and their `description` is authored text. Running them
 * through the raw-turn filters would be wrong in both directions — the length
 * and keyword heuristics are tuned for transcripts, not for conclusions.
 */
export function planSummaryImport(root: StoreRoot, opts: SummaryImportOptions): ImportPlan {
  const { memories, stats } = extractSummaryLayer(opts.memoryRoot, opts.projectDir ?? "");
  // Permissive rule set: a summary memory is a memory by construction.
  const keepAll: FilterRule[] = [{ id: "summary-layer", description: "总结层条目全部保留", test: () => true }];
  return planFromTurns(
    root,
    "zcode",
    summaryAsTurns(memories),
    { files: stats.files, lines: stats.withFrontmatter, turns: memories.length },
    keepAll,
    existingContentFingerprints(root, opts.project ?? "default"),
    opts.stamp ?? true,
  );
}

/** Plan a ZCode import. Reads the DB but writes nothing. */
export function planZcodeImport(root: StoreRoot, opts: ZcodeImportOptions): ImportPlan {
  const { turns, stats } = extractZcode(opts.dbPath, { limit: opts.limit, sessionIds: opts.sessionIds });
  return planFromTurns(
    root,
    "zcode",
    turns,
    { files: 1, lines: stats.messages, turns: stats.turns },
    opts.rules ?? BUILTIN_RULES,
    existingContentFingerprints(root, opts.project ?? "default"),
    opts.stamp ?? true,
  );
}

/**
 * Execute an import. Writes in bounded batches, pausing between them, and
 * records each source key as it lands so an interruption is resumable.
 *
 * Harness-agnostic: `plan` decides what lands, this only decides how.
 */
async function runPlan(
  root: StoreRoot,
  project: string,
  plan: ImportPlan,
  harness: HarnessId,
  batchSize: number,
  pauseMs: number,
  /** Source label for provenance. Summary layer and raw turns must be distinguishable. */
  agentLabel?: string,
): Promise<ImportResult> {
  const cursor = loadCursor(root, harness);
  const ledger = loadLedger(root, harness);
  let written = 0;
  let degraded = 0;
  let batches = 0;

  for (let i = 0; i < plan.toWrite.length; i += batchSize) {
    const batch = plan.toWrite.slice(i, i + batchSize);
    batches++;
    for (const { turn, ruleId } of batch) {
      // Imported turns land as L0 observations with full provenance. They go
      // through appendObservation, so the append-only log is their truth and a
      // locked index degrades instead of losing the import.
      const summary = `[${ruleId}] ${turn.text.slice(0, 2000)}`;
      const r = root.appendObservation({
        session_id: turn.sessionId,
        agent: agentLabel ?? `import:${harness}`,
        event: "turn_outcome",
        tool: null,
        summary,
        created_at: turn.ts,
        project,
      });
      if (!r.indexed) degraded++;

      // Also land a PAGE, not just an observation row.
      //
      // Why (2026-11-16): `/digest` — the face every session reads at startup —
      // is built from pages (L1) via hybridCandidates. Imported memories only
      // existed as observation rows, so 3 455 imported memories were invisible
      // to the digest while 980 auto-captured tool-call pages were all it ever
      // showed. Two write paths, one read path: the import must write the shape
      // the reader uses.
      //
      // Pages are deduped by slug, so re-import cannot double-land.
      try {
        const slug = createHash("sha256").update(turn.sourceKey).digest("hex").slice(0, 16);
        const page = newPage("note", summary.slice(0, 120), summary, {
          metadata: { source: agentLabel ?? `import:${harness}`, rule: ruleId, origin: turn.sourceKey },
        });
        root.writePage(project, "notes", slug, page);
      } catch (err) {
        // A failed page write must not abort the batch — the observation (and
        // its append-only truth) is already durable.
        degraded++;
        console.error(`[import] page write failed for ${turn.sourceKey}: ${(err as Error).message}`);
      }

      cursor.add(turn.sourceKey);
      // Track per-file provenance so the next run can skip unchanged files.
      const entry = ledger[turn.sourceFile] ?? { hash: "", keys: [], importedAt: "" };
      if (!entry.keys.includes(turn.sourceKey)) entry.keys.push(turn.sourceKey);
      ledger[turn.sourceFile] = entry;
      written++;
    }
    saveCursor(root, harness, cursor);
    if (i + batchSize < plan.toWrite.length && pauseMs > 0) {
      await new Promise((res) => setTimeout(res, pauseMs));
    }
  }

  // Stamp each touched file with its CURRENT hash (computed after the read, so
  // an edit during the run leaves the old hash and is picked up next time).
  // Only files we actually wrote something from are stamped — stamping a file
  // the filters rejected would hide its future content from a wider profile.
  for (const [file, entry] of Object.entries(ledger)) {
    if (entry.keys.length === 0) continue;
    const h = fileHash(file);
    if (h) {
      entry.hash = h;
      entry.importedAt = new Date().toISOString();
    }
  }

  // Persist the cursor even when nothing was written, so a no-op run is still
  // recorded as "we have seen these".
  saveCursor(root, harness, cursor);
  saveLedger(root, harness, ledger);

  return { plan, written, degraded, batches };
}

/** Import from Claude Code transcripts. */
export async function runClaudeImport(
  root: StoreRoot,
  project: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  return runPlan(
    root, project,
    planClaudeImport(root, opts),
    "claude-code",
    Math.max(1, opts.batchSize ?? 200),
    Math.max(0, opts.batchPauseMs ?? 200),
  );
}

/** Import from a ZCode database. */
export async function runZcodeImport(
  root: StoreRoot,
  project: string,
  opts: ZcodeImportOptions & { batchSize?: number; batchPauseMs?: number },
): Promise<ImportResult> {
  return runPlan(
    root, project,
    planZcodeImport(root, opts),
    "zcode",
    Math.max(1, opts.batchSize ?? 200),
    Math.max(0, opts.batchPauseMs ?? 200),
  );
}

/** Import a harness summary layer. */
export async function runSummaryImport(
  root: StoreRoot,
  project: string,
  opts: SummaryImportOptions & { batchSize?: number; batchPauseMs?: number },
): Promise<ImportResult> {
  return runPlan(
    root, project,
    planSummaryImport(root, opts),
    "zcode",
    Math.max(1, opts.batchSize ?? 200),
    Math.max(0, opts.batchPauseMs ?? 200),
    "import:summary",
  );
}
