// Portal hosting (add-yongyi-complete-solution): the service process itself
// serves the bundled web face at /portal — no second process, no external
// dependency. Assets are hand-written vanilla ES modules/CSS shipped with the
// package (portal/ at the package root); they carry NO data. Every data call
// the page makes hits the existing faces (/memory, /memory/promotions*,
// /pages, /digest) with the person token's own Bearer header — paste-login
// per design D2 — so authentication stays exactly where it lives today.
//
// Wiring (one line in src/http.ts route(), placed right after the /healthz
// branch and BEFORE the auth check, so a browser can load the page from the
// address bar and present the token from the page itself):
//
//   if (await handlePortal(req, res, path)) return;
//
// handlePortal answers every /portal* request and returns false for anything
// outside that namespace, so the caller's router falls through unchanged.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

// Compiled at dist/portal-server.js → assets at <package root>/portal. The
// same relative layout holds in the repo (dist/../portal) and inside an
// npm-installed package (dist/../portal), so no env knob is needed.
const PORTAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "portal");

// Allowlist only — no path construction from user input, so traversal is
// structurally impossible.
const ASSETS: Record<string, { file: string; type: string }> = {
  "/portal": { file: "index.html", type: "text/html; charset=utf-8" },
  "/portal/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/portal/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/portal/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/portal/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

function json(res: ServerResponse, status: number, doc: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(doc));
}

export async function handlePortal(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== "/portal" && !pathname.startsWith("/portal/")) return false;
  const method = String(req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const asset = ASSETS[pathname];
  if (!asset) {
    json(res, 404, { error: "not_found", path: pathname });
    return true;
  }
  let body: string;
  try {
    body = readFileSync(join(PORTAL_DIR, asset.file), "utf8");
  } catch {
    json(res, 404, { error: "portal_asset_missing", path: pathname });
    return true;
  }
  // no-store: the face is three small files — correctness beats caching, and
  // an updated package must never serve a stale UI.
  res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
  res.end(body);
  return true;
}
