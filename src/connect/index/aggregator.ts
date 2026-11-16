// Cross-harness memory index.
//
// 问题的真形状（2026-11-16 实测 + 业界模式调研）：
//   各 AI harness 都有自己的记忆层，格式惊人地一致——markdown + frontmatter
//   {name, description, metadata.type, originSessionId}。它们是**活文档**：
//   ZCode 的 1,614 个里 1,117 个在一周内被改过（69%）。Claude Code 有 845 个，
//   同样是这个形状。
//
//   所以「把记忆搬进 fd-memory」是错的：
//     · 双份真源 → 源改了副本不知道 → 分叉
//     · 每次改动都要重搬（69% 周改动率）
//     · 用 LLM 抽取或 embedding 重建，是对已经提炼过的结论再做一遍
//       （Graphiti 实测 $0.0277/条，每周 1,117 次改动 = $31/周，永远追不上）
//
// 正确的做法是**只建索引，不复制正文**：
//   一行 = 来源 harness + 主题文件绝对路径 + description + type。
//   读的时候按路径回源文件；源改了下次扫描自然看到新内容，没有分叉可能。
//
// 这也符合 memory-persistence-pattern 的两条黄金法则：
//   · 索引有界、主题文件按需加载（索引每轮都加载，必须小）
//   · 按作用域分层，不合并在一个存储里

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Where one harness keeps its memory files. */
export interface MemorySource {
  harness: string;
  /** Directories to scan; non-existent ones are skipped silently. */
  dirs: string[];
}

export interface IndexedMemory {
  /** `<harness>:<basename>` — stable across scans. */
  key: string;
  harness: string;
  /** Basename without .md. */
  name: string;
  /** One-line hook. This is all the index stores. */
  description: string;
  /** Harness vocabulary: project | feedback | reference | user | unknown. */
  type: string;
  /** Absolute path to the topic file — the read face follows this. */
  sourcePath: string;
  /** Session that produced it, when the harness records one. */
  originSessionId?: string;
  /** sha256 of the description — change detection without reading the body. */
  hash: string;
}

export interface ScanStats {
  scannedFiles: number;
  indexed: number;
  skippedNoFrontmatter: number;
  skippedIndexFile: number;
  byHarness: Record<string, number>;
  byType: Record<string, number>;
  descriptionBytes: number;
}

export interface ScanResult {
  memories: IndexedMemory[];
  stats: ScanStats;
}

/** Index files (tables of contents) are pointers, not memories. */
function isIndexFile(base: string): boolean {
  return base.startsWith("INDEX-") || base.startsWith("MEMORY") || base.startsWith("_more");
}

/** Minimal frontmatter reader: flat keys + one nested `metadata:` block. */
function readFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const raw = text.slice(3, end);
  const out: Record<string, unknown> = {};
  let nested: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const sub = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (sub && nested) {
      const bucket = (out[nested] as Record<string, unknown>) ?? {};
      bucket[sub[1]] = sub[2].trim().replace(/^["']|["']$/g, "");
      out[nested] = bucket;
      continue;
    }
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!top) continue;
    const [, k, v] = top;
    if (v === "") {
      nested = k;
      out[k] = {};
    } else {
      nested = null;
      out[k] = v.replace(/^["']|["']$/g, "").trim();
    }
  }
  return out;
}

/** The memory directories each harness uses on this machine. */
export function defaultSources(home = homedir()): MemorySource[] {
  const zcodeProjects = join(home, ".zcode", "cli", "memories", "projects");
  const zcodeDirs: string[] = [];
  try {
    for (const p of readdirSync(zcodeProjects)) {
      const m = join(zcodeProjects, p, "memory");
      if (existsSync(m)) zcodeDirs.push(m);
    }
  } catch {
    /* no zcode memories */
  }

  const claudeDirs: string[] = [];
  const claudeProjects = join(home, ".claude", "projects");
  try {
    for (const p of readdirSync(claudeProjects)) {
      const m = join(claudeProjects, p, "memory");
      if (existsSync(m)) claudeDirs.push(m);
    }
  } catch {
    /* no claude memories */
  }

  const sources: MemorySource[] = [];
  if (zcodeDirs.length) sources.push({ harness: "zcode", dirs: zcodeDirs });
  if (claudeDirs.length) sources.push({ harness: "claude-code", dirs: claudeDirs });
  return sources;
}

/**
 * Scan every configured source and produce index entries.
 *
 * Only `description` is carried — the body stays in the topic file, read on
 * demand. That keeps the index small enough to inject at session start and
 * makes a source edit visible without any re-import step.
 */
export function scanSources(sources: MemorySource[] = defaultSources()): ScanResult {
  const stats: ScanStats = {
    scannedFiles: 0, indexed: 0, skippedNoFrontmatter: 0, skippedIndexFile: 0,
    byHarness: {}, byType: {}, descriptionBytes: 0,
  };
  const memories: IndexedMemory[] = [];
  const seen = new Set<string>();

  for (const src of sources) {
    for (const dir of src.dirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const base = entry.slice(0, -3);
        if (isIndexFile(base)) {
          stats.skippedIndexFile++;
          continue;
        }
        const file = join(dir, entry);
        let text: string;
        try {
          if (!statSync(file).isFile()) continue;
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        stats.scannedFiles++;

        const fm = readFrontmatter(text);
        if (!fm) {
          stats.skippedNoFrontmatter++;
          continue;
        }
        const description = typeof fm.description === "string" ? fm.description.trim() : "";
        if (!description) {
          stats.skippedNoFrontmatter++;
          continue;
        }

        const meta = (fm.metadata as Record<string, unknown>) ?? {};
        const type = typeof meta.type === "string" ? meta.type : "unknown";
        const originSessionId = typeof meta.originSessionId === "string" ? meta.originSessionId : undefined;
        const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : base;

        // Same memory reachable from two roots (a project dir scanned twice)
        // must not double-index.
        const key = `${src.harness}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);

        stats.byHarness[src.harness] = (stats.byHarness[src.harness] ?? 0) + 1;
        stats.byType[type] = (stats.byType[type] ?? 0) + 1;
        stats.descriptionBytes += Buffer.byteLength(description, "utf8");

        memories.push({
          key, harness: src.harness, name, description, type,
          sourcePath: file,
          originSessionId,
          hash: createHash("sha256").update(description).digest("hex"),
        });
      }
    }
  }

  stats.indexed = memories.length;
  return { memories, stats };
}
