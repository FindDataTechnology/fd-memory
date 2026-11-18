#!/usr/bin/env node
// db-stats: one place to answer "how big is the memory database, and what is
// growing?" (2026-11-18).
//
// Why it exists: I measured the same four numbers by hand (db size, page
// count, per-type counts, freelist) on every drift-check pass, and each time
// had to re-derive them from raw sqlite3 calls in a different order. Worse,
// twice I got the growth rate WRONG because `updated_at` is ISO text
// (`2026-11-18T06:30:58.123Z`) while `datetime('now', ...)` produces a
// space-separated string — comparing them silently matches everything, and I
// reported "6,181 pages in 5 minutes, growth is exploding" when the truth was
// 172. A script that computes the cutoff the same way every time removes that
// class of mistake.
//
// Read-only. Exits 0 always (it is a report, not a gate); the caller decides
// what the numbers mean.
//
// Usage: node scripts/db-stats.mjs [--root u-chengsishi] [--data <dir>] [--days N]
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

function args(argv) {
  const out = { root: "u-chengsishi", days: 1 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = argv[++i];
    else if (argv[i] === "--data") out.data = argv[++i];
    else if (argv[i] === "--days") out.days = Number(argv[++i]);
  }
  if (!out.data) out.data = join(homedir(), "Library", "Application Support", "fd-memory");
  return out;
}

function q(db, sql) {
  try {
    return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// The cutoff must be built from the SAME clock format the column stores:
// `toISOString()` → "2026-11-18T06:30:58.123Z". Anything else compares as a
// string against a different shape and silently matches every row.
function isoCutoff(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

const a = args(process.argv.slice(2));
const db = join(a.data, "owners", a.root, "db", "memory.sqlite");
if (!existsSync(db)) {
  console.log(`判不出：找不到 ${db}`);
  process.exit(0);
}

const size = statSync(db).size;
const walPath = `${db}-wal`;
const wal = existsSync(walPath) ? statSync(walPath).size : 0;
const pageCount = Number(q(db, "SELECT page_count FROM pragma_page_count();")) || 0;
const freelist = Number(q(db, "SELECT freelist_count FROM pragma_freelist_count();")) || 0;
const cutoff = isoCutoff(a.days);

console.log(`库      ${db}`);
console.log(`体积    ${mb(size)}${wal ? ` + WAL ${mb(wal)}` : "（无 WAL）"}`);
console.log(`页      总 ${pageCount}，空闲 ${freelist}（空闲为 0 ⇒ VACUUM 回收不到空间）`);
console.log("");
console.log(`按类型（总数 / 最近 ${a.days} 天新增）：`);
const types = q(db, "SELECT type, COUNT(*) FROM pages GROUP BY type ORDER BY 2 DESC;")
  .split("\n").filter(Boolean);
for (const line of types) {
  const [type, total] = line.split("|");
  const recent = Number(q(db, `SELECT COUNT(*) FROM pages WHERE type='${type.replace(/'/g, "''")}' AND updated_at > '${cutoff}';`)) || 0;
  const pct = total ? ((recent / Number(total)) * 100).toFixed(0) : "0";
  console.log(`  ${String(type).padEnd(14)} ${String(total).padStart(6)}  ${String(recent).padStart(6)}  (${pct}%)`);
}
console.log("");
const allRecent = Number(q(db, `SELECT COUNT(*) FROM pages WHERE updated_at > '${cutoff}';`)) || 0;
console.log(`最近 ${a.days} 天合计新增 ${allRecent} 页`);

// Where the bytes actually are. Matters because a large `pages_fts_data` means
// the FTS index dominates, and that has a different remedy than a large `pages`.
const tables = q(db, "SELECT name, SUM(pgsize)/1048576.0 FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 5;")
  .split("\n").filter(Boolean);
if (tables.length) {
  console.log("体积构成（前 5）：");
  for (const line of tables) {
    const [name, sizeMb] = line.split("|");
    console.log(`  ${String(name).padEnd(22)} ${Number(sizeMb).toFixed(1)} MB`);
  }
}
