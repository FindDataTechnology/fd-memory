#!/usr/bin/env node
// leak-check: guard the public repo against internal infrastructure fingerprints.
//
// Scans every tracked file (git ls-files) for classes of internal identifiers —
// node names, cluster/namespace coords, internal IPs & NodePort ranges, private
// repo names, platform codenames, and credential shapes. The repo ships only
// generalized patterns; deployers may extend with an external rules file.
//
// usage: node scripts/leak-check.mjs [--path <file-or-dir>] [--rules <file>]
//        --path    limit the scan (default: all tracked files)
//        --rules   extra rules file, format `<category> | <literal or /regex/>`
//                  (case-insensitive literals; /.../ wrapped regex) — keep it
//                  OUT of the repo; it is the non-public companion of this gate.
// exit: 0 = clean, 1 = hits (printed as file:line: [category] pattern :: snippet)

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// Generalized pattern classes. Deliberately: no exact internal hosts, ports or
// project names in this list — the values live in the non-public rules file.
const BUILTIN = [
  ["节点与主机", /cheap-\d+/i],
  ["节点与主机", /xinru-/i],
  ["节点与主机", /yizuo\.local/i],
  ["节点与主机", /testaction/],
  ["集群与命名空间", /fd-prod\b/],
  ["集群与命名空间", /fd-postgres\b/],
  ["集群与命名空间", /\.svc\.cluster\.local:3\d{4}/],
  ["私有仓库", /fd-(craw|text|industry|scraw|cn-report|cn-gov|law|memory-internal)\b/],
  ["私有仓库", /finddata\.cloud/],
  ["私有仓库", /@finddata\b/],
  ["网络坐标", /100\.64\.\d+\.\d+/],
  ["网络坐标", /10\.43\.\d+\.\d+/],
  ["网络坐标", /103\.236\.89\.\d+/],
  ["网络坐标", /tailscale|tailnet/i],
  ["网络坐标", /:(?:3[01]\d{3}|32[0-7]\d{2})\b/],
  ["网络坐标", /nodeport[^0-9\n]{0,6}\d{4,5}/i],
  ["镜像与端口坐标", /hkccr|tencentyun/i],
  ["内部系统名", /sub2api/],
  ["内部系统名", /dsh[-_]?(home|profile)|\bdsh\b/],
  ["内部系统名", /registry-maintenance|fd-build-(channel|snapshot)/],
  ["内部代号", /county-data-node|drillcust|lex-trial|lextrial/],
  ["平台叙述", /壹座|萬星|万星/],
  ["人名机器", /u-shi\b|shichengsi|chengsishi/],
  ["凭据形制", /sk-[A-Za-z0-9_-]{12,}/],
  ["凭据形制", /(api[_-]?key|token|password)\s*[:=]\s*["']?[A-Za-z0-9_+/.-]{12,}/i],
  ["凭据形制", /Bearer\s+[A-Za-z0-9._-]{20,}/],
];


// reading an env var is not a credential shape: `api_key=os.environ.get("X")`
// is the sanctioned pattern for lane credentials
function isEnvSafe(line) {
  return /os\.environ|process\.env|os\.getenv/.test(line);
}

function parseExternalRules(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const bar = t.indexOf("|");
    if (bar < 0) continue;
    const cat = t.slice(0, bar).trim();
    let pat = t.slice(bar + 1).trim();
    if (!pat) continue;
    if (pat.startsWith("/") && pat.endsWith("/")) out.push([cat, new RegExp(pat.slice(1, -1), "i")]);
    else out.push([cat, new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]);
  }
  return out;
}

const rules = [...BUILTIN];
const rulesFile = arg("rules");
if (rulesFile) {
  if (!existsSync(rulesFile)) { console.error(`[leak-check] rules file absent: ${rulesFile}`); process.exit(2); }
  rules.push(...parseExternalRules(rulesFile));
}
if (rules.length === 0) { console.error("[leak-check] no rules — gate is fail-closed"); process.exit(2); }

let files;
const limit = arg("path");
if (limit) {
  files = execFileSync("git", ["ls-files", "--", limit], { encoding: "utf8" }).split("\n").filter(Boolean);
} else {
  files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

let hits = 0;
const skip = /^(\.git\/|node_modules\/|dist\/|package-lock\.json$|scripts\/leak-check\.mjs$)/;
for (const f of files) {
  if (skip.test(f)) continue;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; } // binary or gone
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("leak-check:allow")) continue;
    if (isEnvSafe(line)) continue;
    for (const [cat, re] of rules) {
      const m = line.match(re);
      if (m) {
        hits++;
        const snip = line.trim().slice(0, 120);
        console.log(`${f}:${i + 1}: [${cat}] 命中 '${m[0].slice(0, 40)}' :: ${snip}`);
        break;
      }
    }
  }
}

if (hits) {
  console.error(`[leak-check] FAIL: ${hits} 命中 — 公开面前不得含内部标识，改写为通用占位或删除该叙述`);
  process.exitCode = 1;
} else {
  console.log(`[leak-check] PASS: ${files.length} tracked files, 0 hits`);
}
