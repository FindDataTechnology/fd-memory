#!/usr/bin/env node
// reconcile-index: bring the SQLite index in line with the actual wikface on
// disk WITHOUT rebuilding it (2026-11-19).
//
// The problem this solves: `reindexFromWiki` is the only existing repair path,
// and it is unusable in production. It does `DELETE FROM pages` then re-indexes
// every file, and `indexPage` stamps `updated_at = new Date().toISOString()`.
// So a reindex moves EVERY page's timestamp to "now": recency ordering is
// destroyed, and the distill cursors (which are `updated_at` watermarks) jump
// past the entire corpus at once. `src/eval-fixtures.ts` documents the same
// trap and hand-patches `updated_at` afterwards to work around it. That is why
// the index has been allowed to rot instead of being repaired: observed
// 2026-11-19, 4,628 markdown files were on disk and reachable by nothing —
// absent from both `pages` and `pages_fts`, so no read face could see them.
//
// This script is the missing third option: ADD ONLY.
//   - walks the wiki, skipping `_meta.md` and `_slots/` exactly like reindex
//   - for every page not already indexed, indexes it
//   - takes `updated_at` from the page's own frontmatter (`generated.at`,
//     falling back to a file mtime) so a backfilled page lands at the time it
//     was actually written, not at the time of the repair
//   - never touches a row that is already indexed, so existing order is intact
//   - skips `forgotten_at` pages, matching reindexFromWiki
//
// It never deletes. Rows in the index with no file on disk are reported and
// left alone: dropping them is a separate decision (an index entry can outlive
// its file by design when a page is retracted), and this script's contract is
// "make what exists on disk visible", nothing more.
//
// Default is a dry run. `--apply` writes. Exit code: 0 = already consistent or
// applied, 1 = differences remain (dry run found work).

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
// Resolve the build the same way the service does, so the script can never
// disagree with production about a schema detail.
const { RootDb } = require("../dist/db.js");
const { readPageFile } = require("../dist/okf.js");
const { DatabaseSync } = require("node:sqlite");

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "u-chengsishi" },
    data: { type: "string" },
    apply: { type: "boolean", default: false },
    "repair-stale": { type: "boolean", default: false },
    project: { type: "string" },
  },
});

const dataDir = values.data ?? join(homedir(), "Library", "Application Support", "fd-memory");
const ownerDir = join(dataDir, "owners", values.root);
const wikiDir = join(ownerDir, "wiki");
const dbPath = join(ownerDir, "db", "memory.sqlite");

// Must track reindexFromWiki's walk exactly, or this and a real reindex would
// disagree about what "the wiki" means.
const SKIP_FILE = "_meta.md";
const SKIP_DIR = "/_slots/";

function isoFromFrontmatter(fm, fullPath) {
  // `generated.at` is what every writer stamps (okf.ts newPage). Falling back
  // to mtime keeps a hand-written page from landing at "now" on repair.
  const g = fm?.generated;
  const at = typeof g === "object" && g !== null ? g.at : undefined;
  if (typeof at === "string" && at) {
    const t = Date.parse(at);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  try {
    return new Date(statSync(fullPath).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".md")) {
      const rel = full.slice(wikiDir.length + 1);
      if (entry === SKIP_FILE || rel.includes(SKIP_DIR)) continue;
      out.push({ full, rel });
    }
  }
  return out;
}

let wikiIsDir = false;
try { wikiIsDir = statSync(wikiDir).isDirectory(); } catch { /* missing root */ }
if (!wikiIsDir) {
  console.log(`判不出：找不到 ${wikiDir}`);
  process.exit(2);
}

const db = new RootDb(dbPath);
db.db.exec("PRAGMA busy_timeout = 30000");
const files = walk(wikiDir, []);
const indexed = new Set(db.db.prepare("SELECT path FROM pages").all().map((r) => r.path));

// Content staleness (2026-11-20). The add-only path above only notices pages
// that are ABSENT from the index. It cannot see the other divergence: a row
// whose body no longer matches its markdown. That gap is real — trimming the
// Bash backlog with scripts/trim-bash-bodies.mjs rewrote 20k files and then hit
// "database is locked" on the index half (39 live sessions), leaving 12,724
// rows where the truth said 256 bytes and the index still held the old blob.
// Add-only reconcile reported "待补 0" through all of it, which is exactly the
// kind of green that means nothing.
//
// `--repair-stale` closes that: compare the indexed body against the file's and
// re-index on mismatch. Off by default because it reads every file (slow on a
// 55k-page wiki) and is only needed after a bulk rewrite.
const staleRows = [];
if (values["repair-stale"]) {
  const rows = db.db.prepare("SELECT path, body, updated_at FROM pages").all();
  for (const r of rows) {
    const f = files.find((x) => x.rel === r.path);
    if (!f) continue; // orphans are reported separately, never "repaired"
    let page;
    try { page = readPageFile(f.full); } catch { continue; }
    if (page.body !== r.body) staleRows.push({ rel: r.path, page, keepUpdatedAt: r.updated_at });
  }
}

const missing = [];
const forgotten = [];
let alreadyOk = 0;
for (const f of files) {
  if (values.project && !f.rel.startsWith(values.project + "/")) continue;
  if (indexed.has(f.rel)) { alreadyOk++; continue; }
  const page = readPageFile(f.full);
  if (page.frontmatter.forgotten_at) { forgotten.push(f.rel); continue; }
  missing.push({ ...f, page });
}

const stale = [...indexed].filter((p) => !files.some((f) => f.rel === p));

console.log(`wiki      ${wikiDir}`);
console.log(`盘上页面  ${files.length}`);
console.log(`已索引    ${alreadyOk}`);
console.log(`待补      ${missing.length}${values.project ? ` (project=${values.project})` : ""}`);
console.log(`已遗忘    ${forgotten.length}（frontmatter 标记，跳过，与 reindex 一致）`);
console.log(`孤儿索引  ${stale.length}（索引有、磁盘无；本脚本只报告，不删）`);
if (values["repair-stale"]) console.log(`内容过期  ${staleRows.length}（索引正文与文件不符，--repair-stale 重索引）`);

if (missing.length === 0 && staleRows.length === 0) {
  console.log("");
  console.log("✅ 索引与盘面一致，无需修补");
  db.close();
  process.exit(0);
}

// Sample what would be written so the dry run is checkable, not just a count.
if (missing.length > 0) {
  console.log("");
  console.log("待补样例（前 5 条，含将要采用的 updated_at）：");
  for (const m of missing.slice(0, 5)) {
    const at = isoFromFrontmatter(m.page.frontmatter, m.full);
    console.log(`  ${m.rel}  updated_at=${at}`);
  }
}

if (!values.apply) {
  console.log("");
  console.log(`（dry run）要写入请加 --apply`);
  db.close();
  process.exit(1);
}

let written = 0;
let failed = 0;

// Stale repair first: these rows exist, so their frontmatter timestamp is the
// one already in the index — keep it, only the body changes. Re-using
// indexPage would stamp updated_at = now and reorder history, which is the
// whole reason this script does not call reindexFromWiki.
for (const s of staleRows) {
  try {
    const project = s.rel.split(/[\\/]/)[0];
    db.indexPage(project, s.rel, String(s.page.frontmatter.type ?? "note"),
      String(s.page.frontmatter.title ?? s.rel), s.page.body, {
        sources: Array.isArray(s.page.frontmatter.sources) ? s.page.frontmatter.sources : [],
        supersedes: Array.isArray(s.page.frontmatter.supersedes) ? s.page.frontmatter.supersedes : [],
      });
    const at = s.keepUpdatedAt;
    db.db.prepare("UPDATE pages SET updated_at=? WHERE path=?").run(at, s.rel);
    db.db.prepare("UPDATE pages_fts SET updated_at=? WHERE path=?").run(at, s.rel);
    written++;
  } catch (err) {
    failed++;
    if (failed <= 3) console.error(`  过期行修复失败 ${s.rel}: ${err.message}`);
  }
}
for (const m of missing) {
  try {
    const project = m.rel.split(/[\\/]/)[0];
    db.indexPage(project, m.rel, String(m.page.frontmatter.type ?? "note"),
      String(m.page.frontmatter.title ?? m.rel), m.page.body, {
        sources: Array.isArray(m.page.frontmatter.sources) ? m.page.frontmatter.sources : [],
        supersedes: Array.isArray(m.page.frontmatter.supersedes) ? m.page.frontmatter.supersedes : [],
      });
    // indexPage stamps updated_at at call time; overwrite with the frontmatter
    // time on BOTH tables so the repair does not reorder history.
    const at = isoFromFrontmatter(m.page.frontmatter, m.full);
    db.db.prepare("UPDATE pages SET updated_at=? WHERE path=?").run(at, m.rel);
    db.db.prepare("UPDATE pages_fts SET updated_at=? WHERE path=?").run(at, m.rel);
    written++;
  } catch (err) {
    failed++;
    if (failed <= 3) console.error(`  写入失败 ${m.rel}: ${err.message}`);
  }
}

db.close();
console.log("");
console.log(`✅ 已补 ${written} 条${failed ? `，失败 ${failed} 条` : ""}`);
process.exit(failed ? 1 : 0);
