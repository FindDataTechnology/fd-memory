#!/usr/bin/env node
// ── Bilingual parity check for the YongYi landing site ───────────────────────
//
// The site is a static two-file build (site/index.html = EN, site/zh-CN/index.html
// = ZH), sharing one style.css and one script.js. There is no build step and no
// i18n runtime on purpose: both files must be independently readable.
//
// The failure mode that choice creates is silent divergence — one language gains
// a section, an anchor, or an asset and the other silently rots. This check fails
// the moment the two stop describing the same page:
//
//   1. the set of element #ids is identical
//   2. every in-page anchor resolves to a real id in its own document
//   3. both point at the same shared assets (style.css / script.js)
//   4. each links to the other (language switch works in both directions)
//
// Exit 0 = in parity, 1 = divergence (details printed), 2 = a file is missing.
//
//   node scripts/check-site-locales.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, "..", "site");
const FILES = { en: path.join(SITE, "index.html"), zh: path.join(SITE, "zh-CN", "index.html") };

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    console.error(`missing: ${file}`);
    process.exit(2);
  }
}

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const anchors = (html) =>
  new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((a) => a !== "main"));
const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();

const docs = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(f)]));
const problems = [];

const enIds = ids(docs.en);
const zhIds = ids(docs.zh);
for (const missing of diff(enIds, zhIds)) problems.push(`element id only in EN: #${missing}`);
for (const missing of diff(zhIds, enIds)) problems.push(`element id only in ZH: #${missing}`);

for (const [lang, doc] of Object.entries(docs)) {
  const own = ids(doc);
  for (const a of anchors(doc)) {
    if (!own.has(a)) problems.push(`${lang}: href="#${a}" has no matching id`);
  }
}

for (const [lang, doc] of Object.entries(docs)) {
  for (const asset of ["style.css", "script.js"]) {
    if (!doc.includes(asset)) problems.push(`${lang}: does not reference ${asset}`);
  }
}

if (!/href="zh-CN\/index\.html"/.test(docs.en)) problems.push("EN does not link to the ZH version");
if (!/href="\.\.\/index\.html"/.test(docs.zh)) problems.push("ZH does not link back to EN");

if (problems.length) {
  console.error("site locale parity FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `site locale parity OK — ${enIds.size} ids, ${anchors(docs.en).size} in-page anchors, both directions linked`,
);
