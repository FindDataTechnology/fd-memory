#!/usr/bin/env node
// build-freshness: is the RUNNING service older than the source?
//
// 2026-11-18, learned the hard way. I fixed a bug, the repo showed the fix,
// every test passed — and the service still had the old behaviour, because the
// compiled dist/ had been restored from a pre-fix backup. Three checks all
// said "fixed" while the one thing that mattered (the binary actually serving
// requests) was stale.
//
// The lesson generalised: for a compiled service, "the repo is correct" is not
// a fact about production. This script answers the only question that is:
// **has src/ changed since dist/ was built, and has dist/ changed since the
// process started?**
//
// Exit codes: 0 = in sync · 1 = stale (rebuild + restart required) · 2 = can't
// tell (no process / no dist — absence of evidence is not freshness).
//
// Usage: node scripts/build-freshness.mjs [--root <dir>] [--pid <pid>]
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function args(argv) {
  const out = { root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = argv[++i];
    else if (argv[i] === "--pid") out.pid = Number(argv[++i]);
  }
  return out;
}

// Newest mtime under a directory, following the tree but skipping the usual
// noise. Returns 0 when nothing is there — the caller decides what that means.
function newestMtime(dir, { skip = [] } = {}) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.some((s) => e.name === s || e.name.endsWith(s))) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch { /* raced */ }
    }
  };
  walk(dir);
  return newest;
}

function processStartMs(pid) {
  // `etimes` is a GNU extension — macOS `ps` rejects it ("keyword not found"),
  // and because execFileSync throws, the symptom was a silent `0` that the
  // script then reported as "no service running". Use `lstart`, which both
  // BSD and GNU accept, and parse it with Date().
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const ms = out ? new Date(out).getTime() : 0;
    return Number.isFinite(ms) ? ms : 0;
  } catch { return 0; }
}

function findServicePid() {
  // The launchd job name is the stable handle; `pgrep -f` on the entrypoint is
  // the fallback for non-launchd runs.
  try {
    const label = execFileSync("launchctl", ["list"], { encoding: "utf8" })
      .split("\n").find((l) => /yongyi-server/.test(l));
    const pid = Number((label ?? "").trim().split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch { /* no launchctl (Linux) */ }
  try {
    const out = execFileSync("pgrep", ["-f", "fd-memory/dist/index.js serve"], { encoding: "utf8" }).trim();
    const pid = Number(out.split("\n")[0]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch { /* none */ }
  return 0;
}

function fmt(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "(none)";
}

function main() {
  const a = args(process.argv.slice(2));
  const srcDir = join(a.root, "src");
  const distDir = join(a.root, "dist");
  if (!existsSync(srcDir) || !existsSync(distDir)) {
    console.log(`判不出：缺少 ${existsSync(srcDir) ? "dist" : "src"}/（不是新鲜，是没得判）`);
    return 2;
  }
  const srcNewest = newestMtime(srcDir, { skip: [".DS_Store"] });
  const distNewest = newestMtime(distDir, { skip: [".DS_Store"] });
  const pid = a.pid ?? findServicePid();
  const startedAt = pid ? processStartMs(pid) : 0;

  console.log(`src  最新改动: ${fmt(srcNewest)}`);
  console.log(`dist 最新构建: ${fmt(distNewest)}`);
  console.log(`进程     启动: ${fmt(startedAt)}${pid ? ` (pid ${pid})` : "（没有在跑的服务）"}`);

  let rc = 0;
  if (srcNewest > distNewest) {
    console.log("✗ dist 比 src 旧 —— 源码改了但没重新构建，跑的是旧代码");
    rc = 1;
  }
  if (startedAt && distNewest > startedAt) {
    console.log("✗ dist 比进程新 —— 构建过但没重启，跑的还是旧代码");
    rc = 1;
  }
  if (!startedAt) {
    console.log("判不出：找不到在跑的服务进程（不是新鲜，是没得判）");
    return 2;
  }
  if (rc === 0) console.log("✓ 源码 / 构建 / 运行 三者一致");
  return rc;
}

process.exit(main());
