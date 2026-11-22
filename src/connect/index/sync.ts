// Persist the cross-harness index into fd-memory pages.
//
// 分工很关键（见 MEMORY-ARCHITECTURE.md）：
//   · 主题文件（正文）留在各 harness 自己的目录 —— 唯一真源，不动
//   · fd-memory 只存「索引页」：type='memory-index'，正文就是 description
//   · 页面 metadata 记源绝对路径，读面要看全文就回源文件
//
// 这样 fd-memory 的存储不随记忆总量线性增长（每条只有一个 description），
// 源改了下次扫描自然看到新内容，不存在「副本过期」这种分叉。

import { statSync } from "node:fs";
import type { StoreRoot } from "../../store.js";
import { newPage } from "../../okf.js";
import { scanSources, type IndexedMemory, type MemorySource, type ScanStats } from "./aggregator.js";

export interface SyncResult {
  scanned: ScanStats;
  /** Newly written or changed index pages. */
  written: number;
  /** Entries whose description hash matched what is already stored. */
  unchanged: number;
  /** Index pages removed because the source file disappeared. */
  removed: number;
}

const INDEX_TYPE = "memory-index";

/** Source file mtime in ms, or 0 when unreadable. */
function sourceMtime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

function slugFor(m: IndexedMemory): string {
  // stable across scans: harness + name
  return `${m.harness}--${m.name}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 120);
}

/**
 * Sync the index into `root`.
 *
 * Incremental by description hash: an entry whose description is unchanged is
 * skipped entirely (no page write). A source edit changes the description →
 * one page rewritten. Deleting a memory file removes its index page.
 */
export function syncIndex(root: StoreRoot, project: string, sources?: MemorySource[]): SyncResult {
  const { memories, stats } = scanSources(sources);

  // Current state of the index: slug -> hash. One query, not one per entry.
  const existing = new Map<string, string>();
  const rows = root.db.db
    .prepare(
      `SELECT path, json_extract(metadata,'$.description_hash') AS h
       FROM pages WHERE type = ? AND project = ?`,
    )
    .all(INDEX_TYPE, project) as Array<{ path: string; h: string | null }>;
  for (const r of rows) {
    const slug = String(r.path).split("/").pop()?.replace(/\.md$/, "") ?? "";
    if (slug) existing.set(slug, r.h ?? "");
  }

  let written = 0;
  let unchanged = 0;
  const liveSlugs = new Set<string>();

  for (const m of memories) {
    const slug = slugFor(m);
    liveSlugs.add(slug);
    if (existing.get(slug) === m.hash) {
      unchanged++;
      continue;
    }
    const page = newPage(INDEX_TYPE, `${m.description}`.slice(0, 200), m.description, {
      metadata: {
        harness: m.harness,
        memory_name: m.name,
        memory_type: m.type,
        source_path: m.sourcePath,
        description_hash: m.hash,
        // mtime rides the index so the read face never has to stat 2 683
        // files per request (measured 2026-11-16: 1.4–2.2 s, which blew the
        // 2 s session-start hook budget). Refresh happens on the next sync.
        source_mtime: sourceMtime(m.sourcePath),
        ...(m.originSessionId ? { origin_session: m.originSessionId } : {}),
      },
    });
    root.writePage(project, "memory-index", slug, page);
    written++;
  }

  let removed = 0;
  for (const slug of existing.keys()) {
    if (liveSlugs.has(slug)) continue;
    try {
      // forgetPage marks the page retired and drops it from the index — the
      // right semantic for "this memory file no longer exists at the source".
      // A file that comes back later reappears on the next scan under the same
      // slug, which is why the slug is derived from harness+name and not random.
      root.forgetPage(`${project}/memory-index/${slug}.md`);
      removed++;
    } catch {
      /* best effort: a stale index row is harmless, a crash is not */
    }
  }

  return { scanned: stats, written, unchanged, removed };
}
