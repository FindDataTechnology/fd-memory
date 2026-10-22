#!/usr/bin/env node
// One-shot re-embed: give every fact/experience page a companion vector via
// the sidecar /embed (add-embedding-recall task 2.3). Pages already carrying
// a vector are skipped unless --force (stale-model rows included).
//
// usage: node scripts/reembed.mjs --data <fdMemoryData> [--force] [--dry-run]
// env:   DISTILLER_URL (default http://127.0.0.1:8100), DISTILLER_SHARED_TOKEN

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { StoreRoot } from "../dist/store.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const dataIdx = args.indexOf("--data");
const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : process.env.FD_MEMORY_DATA;
const sidecarUrl = (process.env.DISTILLER_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
if (!dataDir) { console.error("need --data <dir> or FD_MEMORY_DATA"); process.exit(1); }

async function embedBatch(texts) {
  const r = await fetch(`${sidecarUrl}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DISTILLER_SHARED_TOKEN ?? ""}` },
    body: JSON.stringify({ texts }),
  });
  const doc = await r.json();
  if (!doc.vectors?.length) throw new Error(`embed failed: ${JSON.stringify(doc.errors ?? doc).slice(0, 160)}`);
  return doc;
}

async function main() {
  const health = await fetch(`${sidecarUrl}/healthz`).then((r) => r.json()).catch(() => null);
  if (!health) { console.log("[reembed] SKIP: sidecar unreachable at", sidecarUrl); process.exit(0); }
  console.log(`[reembed] sidecar ${health.engine}, data=${dataDir}${dryRun ? " (dry-run)" : ""}${force ? " --force" : ""}`);

  let embedded = 0;
  let skipped = 0;
  const ownersDir = join(dataDir, "owners");
  for (const rootDir of readdirSync(ownersDir)) {
    if (rootDir.endsWith(".v1-backup")) continue;
    const dbPath = join(dataDir, "owners", rootDir, "db", "memory.sqlite");
    if (!existsSync(dbPath)) continue;
    const root = new StoreRoot(dataDir, rootDir);

    // collect candidate rows: fact/experience pages, lacking vector (or force)
    const rows = root.db.db.prepare("SELECT path, title, body FROM pages WHERE type IN ('fact','experience') ORDER BY path").all();
    const batch = [];
    for (const row of rows) {
      const has = root.db.getPageVector(row.path);
      if (has && !force) { skipped++; continue; }
      batch.push({ rel: row.path, text: `${row.title}\n${String(row.body).slice(0, 1200)}` });
      if (batch.length >= 64) {
        if (!dryRun) {
          const doc = await embedBatch(batch.map((b) => b.text));
          batch.forEach((b, i) => root.db.setPageVector(b.rel, doc.model, new Float32Array(doc.vectors[i])));
        }
        embedded += batch.length;
        batch.length = 0;
      }
    }
    if (batch.length) {
      if (!dryRun) {
        const doc = await embedBatch(batch.map((b) => b.text));
        batch.forEach((b, i) => root.db.setPageVector(b.rel, doc.model, new Float32Array(doc.vectors[i])));
      }
      embedded += batch.length;
    }
    const counts = root.db.vectorModelCounts();
    if (counts.length) console.log(`[reembed] ${rootDir}: vectors=${JSON.stringify(counts)}`);
  }
  console.log(`[reembed] done: embedded=${embedded} skipped(with vector)=${skipped}${dryRun ? " (dry-run: nothing written)" : ""}`);
}

main().catch((e) => { console.error("[reembed] ERROR", e); process.exit(1); });
