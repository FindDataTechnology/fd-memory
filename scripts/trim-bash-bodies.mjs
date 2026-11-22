#!/usr/bin/env node
// trim-bash-bodies: shrink already-landed shell-command captures to the new
// per-kind budget (2026-11-20).
//
// Why: `tool_call Bash` pages landed before bodyCapFor() existed carry the full
// `cwd/session/tool/input{raw JSON}` blob — 38,842 rows, 19MB of body, ~14.6MB
// of which is duplicated into the FTS index. The live path now caps them at 256
// bytes; this brings the backlog in line so the saving is not only forward.
//
// The hard part is that the wiki is the byte-level truth: `pages`/`pages_fts`
// are rebuildable indexes over the markdown files. So trimming ONLY the DB
// would be undone by the next `reconcile-index` run, which reads each file back
// and re-indexes it. This script therefore rewrites the .md file first and the
// index row second, in that order, for the same reason appendObservation does:
// truth first, index second — an index failure must never lose content.
//
// Safety:
//   - default is a dry run; `--apply` writes
//   - only rows matching the shell-capture title AND over the budget
//   - the title is never touched (it carries the command; that is the part that
//     keeps "which session ran what" answerable)
//   - the cut lands on a UTF-8 boundary and the annotation names the real cap
//   - a page whose frontmatter fails to parse is left alone, not guessed at

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { parsePage, dumpPage } = require("../dist/okf.js");
const { DatabaseSync } = require("node:sqlite");

const CAP = 256;

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "u-chengsishi" },
    data: { type: "string" },
    apply: { type: "boolean", default: false },
    limit: { type: "string" },
  },
});

const dataDir = values.data ?? join(homedir(), "Library", "Application Support", "fd-memory");
const ownerDir = join(dataDir, "owners", values.root);
const wikiDir = join(ownerDir, "wiki");
const dbPath = join(ownerDir, "db", "memory.sqlite");

if (!existsSync(dbPath)) {
  console.log(`判不出：找不到 ${dbPath}`);
  process.exit(2);
}

// Same cut as observe.ts truncateObserveBody: walk back over UTF-8 continuation
// bytes so the prefix is never replacement-garbled.
function cut(body, capBytes) {
  if (Buffer.byteLength(body, "utf8") <= capBytes) return null;
  const buf = Buffer.from(body, "utf8");
  let end = capBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const label = capBytes >= 1024 ? `${Math.round(capBytes / 1024)}KB` : `${capBytes} 字节`;
  return buf.subarray(0, end).toString("utf8") + `\n\n…（正文超过 ${label} 上限，已截断）`;
}

const db = new DatabaseSync(dbPath);
// The service owns this database and 39 sessions write to it continuously, so
// a bulk rewrite WILL collide ("database is locked"). Waiting a while beats
// failing fast: each file rewrite is small and the whole run is idempotent, so
// patience costs seconds while a lock failure leaves the index out of step with
// the file (the first run lost 14,566 rows that way).
db.exec("PRAGMA busy_timeout = 30000");
const limit = values.limit ? Number(values.limit) : undefined;
const rows = db
  .prepare(
    `SELECT path, length(body) AS n FROM pages
      WHERE type='observation' AND title LIKE 'tool_call Bash%' AND length(body) > ?
      ORDER BY updated_at DESC${limit ? ` LIMIT ${limit}` : ""}`,
  )
  .all(CAP + 124);

console.log(`库        ${dbPath}`);
console.log(`候选      ${rows.length} 条（body > ${CAP + 124} 字节）`);

if (rows.length === 0) {
  console.log("");
  console.log("✅ 存量已全部符合新预算");
  db.close();
  process.exit(0);
}

let willSave = 0;
const plan = [];
let unreadable = 0;
for (const r of rows) {
  const full = join(wikiDir, r.path);
  if (!existsSync(full)) { unreadable++; continue; }
  let page;
  try {
    page = parsePage(readFileSync(full, "utf8"));
  } catch { unreadable++; continue; }
  const next = cut(page.body ?? "", CAP);
  if (!next) continue;
  willSave += Buffer.byteLength(page.body, "utf8") - Buffer.byteLength(next, "utf8");
  plan.push({ rel: r.path, full, page, next });
}

console.log(`可处理    ${plan.length} 条`);
console.log(`读不到    ${unreadable} 条（跳过，不猜）`);
console.log(`预计省    ${(willSave / 1048576).toFixed(1)} MB 正文（FTS 再一份 ⇒ 约 ${(willSave * 2 / 1048576).toFixed(1)} MB）`);

if (!values.apply) {
  console.log("");
  console.log("（dry run）要写入请加 --apply");
  db.close();
  process.exit(1);
}

const upd = db.prepare("UPDATE pages SET body=? WHERE path=?");
const updFts = db.prepare("DELETE FROM pages_fts WHERE path=?");
const insFts = db.prepare("INSERT INTO pages_fts (title, body, path, project, updated_at) VALUES (?,?,?,?,?)");

let files = 0, ftsRows = 0, failed = 0;
for (const p of plan) {
  // Truth first, index second — but in SEPARATE try blocks.
  //
  // The first run of this script wrapped both in one try: a lock failure on the
  // UPDATE skipped the index write AFTER the file had already been rewritten,
  // leaving 14,566 rows where the markdown said 256 bytes and the index still
  // held the old blob. The file is the truth, so it must not be rolled back to
  // match a stale index; what matters is that the index write is retried.
  try {
    writeFileSync(p.full, dumpPage({ ...p.page, body: p.next }));
    files++;
  } catch (err) {
    failed++;
    if (failed <= 3) console.error(`  文件失败 ${p.rel}: ${err.message}`);
    continue; // no file change ⇒ leave the index alone too
  }

  try {
    const meta = p.page.frontmatter ?? {};
    upd.run(p.next, p.rel);
    // Same conditional-retire discipline as indexPage: path is an UNINDEXED
    // fts5 column, so the DELETE is a full scan — pay it only when the row is
    // known to exist (it is: we just selected it from `pages`).
    updFts.run(p.rel);
    insFts.run(String(meta.title ?? ""), p.next, p.rel, p.rel.split("/")[0], new Date().toISOString());
    ftsRows++;
  } catch (err) {
    // The file is already trimmed. Report it loudly: the fix is to re-run (the
    // script is idempotent — an already-short file no longer matches the
    // "body > cap" selection) or to run reconcile-index, which re-reads the
    // markdown truth and overwrites any stale index row.
    failed++;
    if (failed <= 3) console.error(`  索引失败 ${p.rel}（文件已改，重跑或跑 reconcile-index 收敛）: ${err.message}`);
  }
}

db.close();
console.log("");
console.log(`✅ 文件 ${files} 个 / FTS ${ftsRows} 行${failed ? `，失败 ${failed}` : ""}`);
process.exit(failed ? 1 : 0);
