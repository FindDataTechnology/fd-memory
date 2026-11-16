// Summary-layer memory extractor (change add-harness-memory-import,
// spec yongyi-summary-layer-import).
//
// What this imports and why it leads with this rather than raw transcripts:
//
//   ZCode keeps a distilled layer under
//   ~/.zcode/cli/memories/projects/<project>/memory/*.md — one file per lesson,
//   each with frontmatter (name / description / metadata.type /
//   originSessionId). Measured 2026-11-15: 1 505 files, 5.9 MB of body, of which
//   the `description` lines total 224 KB.
//
// Raw sessions are 858 160 messages (~17 亿 tokens if embedded wholesale).
// Summary layers are the distilled conclusions and cost 1/26 of their own body
// to embed if you only embed the description — which is all recall needs, since
// the description IS the hook.
//
// So: this extractor reads frontmatter + body, keeps the links, and leaves the
// embedding decision to the caller (policy: summary-only by default).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedTurn } from "./types.js";

export interface SummaryMemory {
  /** `<harness>:<project>:<name>` — stable across re-imports. */
  sourceKey: string;
  harness: "zcode" | "claude-code";
  /** Memory name from frontmatter (also the file basename). */
  name: string;
  /** One-line hook. This is the vectorization target. */
  description: string;
  /** Distilled type: project | feedback | reference | user (harness vocabulary). */
  type: string;
  /** Full body including any `[[links]]`. */
  body: string;
  /** Which conversation produced it, when the harness records it. */
  originSessionId?: string;
  /** Absolute path of the source file — provenance and re-import anchor. */
  sourceFile: string;
  /** Coarse grouping (the enclosing project directory). */
  projectDir: string;
}

export interface SummaryImportStats {
  files: number;
  withFrontmatter: number;
  skippedIndex: number;
  skippedNoFrontmatter: number;
  malformed: number;
  byType: Record<string, number>;
  /** Total bytes of description lines — the embedding budget. */
  descriptionBytes: number;
}

export interface SummaryImportResult {
  memories: SummaryMemory[];
  stats: SummaryImportStats;
}

/** Minimal YAML frontmatter reader: flat keys plus one nested block (`metadata`). */
function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const raw = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n+/, "");

  const data: Record<string, unknown> = {};
  let nestedKey: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (nested && nestedKey) {
      const bucket = (data[nestedKey] as Record<string, unknown>) ?? {};
      bucket[nested[1]] = nested[2].trim();
      data[nestedKey] = bucket;
      continue;
    }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      const [, k, v] = top;
      if (v === "") {
        nestedKey = k;
        data[k] = {};
      } else {
        nestedKey = null;
        // Strip surrounding quotes; keep the rest verbatim (descriptions contain
        // backticks and punctuation that YAML quoting rules would otherwise eat).
        data[k] = v.replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return { data, body };
}

/**
 * Read every summary-layer memory under `<memoryRoot>/*.md`.
 *
 * Index files (`INDEX-*.md`, `MEMORY*.md`) are skipped: they are tables of
 * contents over the memories, not memories themselves. Importing them would
 * double the corpus with pointers.
 */
export function extractSummaryLayer(memoryRoot: string, projectDir = ""): SummaryImportResult {
  const stats: SummaryImportStats = {
    files: 0, withFrontmatter: 0, skippedIndex: 0, skippedNoFrontmatter: 0,
    malformed: 0, byType: {}, descriptionBytes: 0,
  };
  const memories: SummaryMemory[] = [];

  let entries: string[];
  try {
    entries = readdirSync(memoryRoot);
  } catch {
    throw new Error(
      `Summary-layer directory not found: ${memoryRoot}\n` +
        `Expected e.g. ~/.zcode/cli/memories/projects/<id>/memory`,
    );
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const base = entry.slice(0, -3);
    if (base.startsWith("INDEX-") || base.startsWith("MEMORY")) {
      stats.skippedIndex++;
      continue;
    }
    const file = join(memoryRoot, entry);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    stats.files++;

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      stats.malformed++;
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed) {
      // The four files measured without frontmatter are legitimate older
      // memories. Counting them separately keeps the report honest without
      // pretending they parsed.
      stats.skippedNoFrontmatter++;
      continue;
    }
    stats.withFrontmatter++;

    const name = typeof parsed.data.name === "string" ? parsed.data.name : base;
    const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
    if (!description) {
      stats.malformed++;
      continue;
    }
    const meta = (parsed.data.metadata as Record<string, unknown>) ?? {};
    const type = typeof meta.type === "string" ? meta.type : "unknown";
    const originSessionId = typeof meta.originSessionId === "string" ? meta.originSessionId : undefined;

    stats.byType[type] = (stats.byType[type] ?? 0) + 1;
    stats.descriptionBytes += Buffer.byteLength(description, "utf8");

    memories.push({
      sourceKey: `zcode:${projectDir || "summary"}:${name}`,
      harness: "zcode",
      name,
      description,
      type,
      body: parsed.body,
      originSessionId,
      sourceFile: file,
      projectDir,
    });
  }

  // Loud failure: files exist but nothing parsed means the format moved.
  if (stats.files > 0 && memories.length === 0) {
    throw new Error(
      `Found ${stats.files} summary file(s) but parsed 0 memories.\n` +
        `This usually means the frontmatter format changed. ` +
        `No-frontmatter: ${stats.skippedNoFrontmatter}, malformed: ${stats.malformed}`,
    );
  }

  return { memories, stats };
}

/**
 * Adapt summary memories to the shared turn shape so the same filter/dedupe/
 * cursor machinery applies.
 *
 * The mapping is deliberate: `description` becomes the text (that is what gets
 * matched and embedded), and the type rides in the role-independent prefix so
 * downstream can tell a distilled lesson from a raw turn.
 */
export function summaryAsTurns(memories: SummaryMemory[]): ExtractedTurn[] {
  return memories.map((m) => ({
    sourceKey: m.sourceKey,
    harness: m.harness,
    sessionId: m.originSessionId ?? m.projectDir ?? "summary",
    sourceFile: m.sourceFile,
    uuid: m.name,
    role: "user" as const,
    text: `[${m.type}] ${m.description}`,
    ts: new Date().toISOString(),
    projectDir: m.projectDir,
  }));
}
