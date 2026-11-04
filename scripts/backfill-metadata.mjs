#!/usr/bin/env node
// Backfill (add-agent-memory-foundation): legacy fleet-fact titles encoded
// their structured fields as `[kind][memberId] ` prefixes. Parse them into
// first-class metadata (frontmatter truth + SQLite mirror), keep the title
// byte-identical (double-track reads keep legacy callers working), never
// touch anything the pattern doesn't strictly match.
//
// Idempotent: a page that already carries metadata.kind is skipped, so
// re-running reports zero changes. Strict word list = the five fleet fact
// kinds (fleet-turn-memory spec); anything else is counted, not guessed.
//
// usage: node scripts/backfill-metadata.mjs [--data <dir>] [--dry-run]

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
// Runs against BUILT output (dist/) — the same rule the serving binary
// follows: npm test / npm run build materialize dist before this script runs.
import { readPageFile, writePageFile } from "../dist/okf.js";
import { StoreRoot } from "../dist/store.js";

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const data = arg("--data") ?? process.env.FD_MEMORY_DATA ?? process.env.HOME + "/Library/Application Support/fd-memory";

// The closed five-kind set (spec: fleet-turn-memory). Parse failures are
// counted and skipped — 宁漏不过.
const KINDS = ["turn", "health", "decision-opened", "decision-resolved", "swap"];
const PREFIX_RE = new RegExp(`^\\[(${KINDS.join("|")})\\]\\[([^\\]]+)\\] `);

const ownersDir = join(data, "owners");
if (!existsSync(ownersDir)) {
  console.error(`[backfill] no owners dir under ${data} — nothing to do`);
  process.exit(0);
}

const report = { roots: 0, scanned: 0, backfilled: 0, skipped_with_metadata: 0, unmatched: 0, files: 0 };
for (const rootKey of readdirSync(ownersDir)) {
  const rootPath = join(ownersDir, rootKey);
  if (!statSync(rootPath).isDirectory() || !existsSync(join(rootPath, "wiki"))) continue;
  report.roots += 1;
  const root = new StoreRoot(data, rootKey);
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(full).isDirectory()) { walk(full, relPath); continue; }
      if (!entry.endsWith(".md") || entry === "_meta.md" || relPath.includes("/_slots/")) continue;
      report.files += 1;
      const page = readPageFile(full);
      if (page.frontmatter.forgotten_at) continue;
      report.scanned += 1;
      const fm = page.frontmatter;
      if (fm.metadata && typeof fm.metadata === "object" && fm.metadata.kind) { report.skipped_with_metadata += 1; continue; }
      const m = String(fm.title ?? "").match(PREFIX_RE);
      if (!m) { report.unmatched += 1; continue; }
      const metadata = { kind: m[1], memberId: m[2] };
      if (dryRun) { report.backfilled += 1; continue; }
      // Truth first, then the derived index — the same order writePage uses.
      fm.metadata = metadata;
      writePageFile(full, { frontmatter: fm, body: page.body });
      root.db.indexPage(relPath.split("/")[0], relPath, String(fm.type ?? "note"), String(fm.title ?? entry), page.body, {
        sources: Array.isArray(fm.sources) ? fm.sources : [],
        supersedes: Array.isArray(fm.supersedes) ? fm.supersedes : [],
        metadata,
      });
      report.backfilled += 1;
    }
  };
  walk(join(rootPath, "wiki"), "");
  root.db.close();
}
console.log(JSON.stringify({ dry_run: dryRun, ...report }, null, 1));
