// HTTP wiring: /mcp (JSON-RPC over streamable-http), /capture (hooks-shaped
// event ingest), /pages (platform-seam project read/write face — the wire
// carries a project NAME resolved inside the caller's own root, never a
// namespace), /healthz, /admin/* (token ops, root-scoped). Auth on every
// route except /healthz; auth failures are structured JSON.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { TokenStore, Scope, namespaceParts } from "./auth.js";
import { StoreRoot } from "./store.js";
import { CaptureIngest, CaptureEvent } from "./capture.js";
import { buildTools, writeNotePage } from "./mcp.js";
import { DistillScheduler, hybridCandidates, sidecarEmbed } from "./distill-scheduler.js";
import { startEmbedKeepwarm } from "./keepwarm.js";
import { serializeEmbed, embedLaneCoolingDown, noteEmbedOutcome } from "./embed-gate.js";
import { noteDigestRung, noteEmbedSample, metricsSnapshot } from "./metrics.js";
import { renderDigest, DigestItem } from "./digest.js";
import { newPage } from "./okf.js";

export interface ServiceOptions {
  dataDir: string;
  port: number;
  pepper: string;
  host?: string;
}

export class Service {
  readonly tokens: TokenStore;
  readonly ingest: CaptureIngest;
  readonly distill: DistillScheduler;
  private keepwarm: { stop: () => void } | null = null;
  private roots = new Map<string, StoreRoot>();

  constructor(readonly opts: ServiceOptions) {
    this.tokens = new TokenStore(opts.dataDir + "/tokens.db", opts.pepper);
    this.ingest = new CaptureIngest(this.roots, (key) => new StoreRoot(opts.dataDir, key));
    this.distill = new DistillScheduler({
      roots: this.roots,
      openRoot: (key) => this.rootForKey(key),
      tokens: this.tokens,
      discoverRoots: () => {
        try {
          return readdirSync(join(this.opts.dataDir, "owners")).filter((d: string) => existsSync(join(this.opts.dataDir, "owners", d, "wiki")));
        } catch { return []; }
      },
      env: process.env,
    });
  }

  rootFor(scope: Scope): StoreRoot {
    const { rootKey } = namespaceParts(scope.namespace);
    return this.rootForKey(rootKey);
  }

  rootForKey(rootKey: string): StoreRoot {
    let root = this.roots.get(rootKey);
    if (!root) {
      root = new StoreRoot(this.opts.dataDir, rootKey);
      this.roots.set(rootKey, root);
    }
    return root;
  }

  listen(): void {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        console.error("[fd-memory] internal error on", req.method, req.url, String(err?.stack ?? err));
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal", message: String(err?.message ?? err) }));
      });
    });
    const host = this.opts.host ?? "127.0.0.1";
    server.listen(this.opts.port, host);
    this.distill.start();
    this.keepwarm = startEmbedKeepwarm({ env: process.env });
    console.log(`[fd-memory] listening on ${host}:${this.opts.port} data=${this.opts.dataDir}`);
  }

  private auth(req: IncomingMessage): Scope | null {
    const h = String(req.headers.authorization ?? "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    return this.tokens.verify(m[1].trim());
  }

  private async rawBody(req: IncomingMessage): Promise<string> {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text;
  }

  private async body<T>(req: IncomingMessage): Promise<T> {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ status: "ok", service: "fd-memory" }));
    }

    const scope = this.auth(req);
    if (!scope) {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }

    if (path === "/capture" && req.method === "POST") {
      if (scope.kind === "platform") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "platform_is_minting_only" }));
      }
      // Pod tokens are mount credentials for the MCP face; the capture lane
      // stays runner (per-batch target) or self-namespace.
      if (scope.kind === "pod") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "pod_tokens_are_mcp_only" }));
      }
      const body = await this.body<{ events?: CaptureEvent[]; namespace?: string } | CaptureEvent[]>(req);
      const events = Array.isArray(body) ? body : (body.events ?? [body as CaptureEvent]);
      // Deployment/person tokens always land in their own namespace (a
      // payload namespace is ignored, never honored). Runner tokens are
      // capture-only and carry the target d/ namespace per batch.
      const ns = scope.kind === "runner" ? String((body as { namespace?: string }).namespace ?? "") : scope.namespace;
      if (scope.kind === "runner" && !ns.startsWith("d/")) {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "forbidden_namespace" }));
      }
      const { rootKey, project } = namespaceParts(ns);
      const out = this.ingest.ingest(rootKey, project, events, { principal: `${scope.kind}:${scope.tokenId}`, scope: ns });
      this.distill.notifyCapture(rootKey, project, events as Array<{ event?: string }>);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(out));
    }

    // ── /hook compat face (add-memory-federation-v1): the upstream ai-memory
    // wire protocol, verbatim from the spike — POST /hook?event&agent&cwd&
    // ingest_key with the raw hook payload as body and a person token bearer.
    // Person tokens only: this is the local-node federation lane (u/ roots).
    if (path === "/hook" && req.method === "POST") {
      if (scope.kind !== "person") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const q = new URL(req.url ?? "/", "http://local").searchParams;
      const event = String(q.get("event") ?? "");
      const agent = String(q.get("agent") ?? "unknown");
      const cwd = String(q.get("cwd") ?? "");
      const ingestKey = String(q.get("ingest_key") ?? "");
      const ALLOWED = ["session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop", "session-end"];
      if (!ALLOWED.includes(event) || !ingestKey) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_hook", allowed_events: ALLOWED }));
      }
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(await this.rawBody(req)); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_body" }));
      }
      const sessionId = String(payload.session_id ?? "");
      if (!sessionId) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "session_id_required" }));
      }
      // namespace: person root + project from cwd basename (empty → "cell")
      const project = (cwd.split("/").filter(Boolean).pop() ?? "cell") || "cell";
      const { rootKey } = namespaceParts(`${scope.namespace}/p/${project}`);
      const root = this.rootFor(scope);
      const at = new Date().toISOString();
      if (!root.db.claimHookEvent(ingestKey, sessionId, event, at)) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ stored: 0, duplicate: true }));
      }
      const ev: CaptureEvent = {
        event: event as CaptureEvent["event"],
        session_id: sessionId,
        agent,
        cwd: cwd || undefined,
        tool_name: payload.tool_name != null ? String(payload.tool_name) : undefined,
        summary: payload.prompt != null ? String(payload.prompt) : payload.summary != null ? String(payload.summary) : undefined,
        tool_input: payload.tool_input != null ? String(payload.tool_input) : undefined,
        at,
      };
      const out = this.ingest.ingest(rootKey, project, [ev], { principal: `person:${scope.tokenId}`, scope: `${scope.namespace}/p/${project}` });
      this.distill.notifyCapture(rootKey, project, [ev]);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(out));
    }

    if (path === "/mcp" && req.method === "POST") {
      if (scope.kind === "runner" || scope.kind === "platform") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "service tokens carry no data-plane identity" } }));
      }
      return this.mcp(req, res, scope);
    }

    // ── /pages (add-memory-scopes-and-cluster-sharing): the platform-seam
    // project face. Callers name a project INSIDE their own root (the wire
    // carries no namespace); authorization is the grant table, writes are
    // audited. This is the lane the cell's cluster-turn orchestration (and
    // later the distiller) uses — trusted platform seams, not model-facing.
    if (path === "/pages" && (req.method === "GET" || req.method === "POST")) {
      if (scope.kind === "runner" || scope.kind === "platform") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "service_tokens_carry_no_data_plane_identity" }));
      }
      const isDeploy = scope.kind === "deployment" || scope.kind === "pod";
      const packNs = isDeploy ? "d/" + namespaceParts(scope.namespace).rootKey.slice(2) : null;
      const nsOfProject = (project: string): string =>
        scope.kind === "person" ? `${scope.namespace}/p/${project}` : project === "shared" ? packNs! : `${packNs}/${project}`;
      const projectOf = (raw: unknown): string => String(raw ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
      const auditOf = (project: string) => ({ principal: `${scope.kind}:${scope.tokenId}`, scope: nsOfProject(project) });
      if (req.method === "GET") {
        const project = projectOf(url.searchParams.get("project"));
        if (!project) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "project_required" }));
        }
        if (!this.tokens.allows(scope.tokenId, nsOfProject(project), "r")) {
          res.writeHead(403, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "forbidden_project", project }));
        }
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
        const root = this.rootFor(scope);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ project, pages: root.db.recentPages(limit, [project]) }));
      }
      const body = await this.body<{ project?: string; title?: string; body?: string }>(req);
      const project = projectOf(body.project);
      const title = String(body.title ?? "").trim();
      const pageBody = String(body.body ?? "");
      if (!project || !title || !pageBody) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "project_title_body_required" }));
      }
      if (!this.tokens.allows(scope.tokenId, nsOfProject(project), "rw")) {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "forbidden_project", project }));
      }
      const root = this.rootFor(scope);
      // Pages from this face are plain notes — reindex treats them like any
      // other page; the audit row names the platform-seam principal.
      const rel = writeNotePage(root, project, title, pageBody);
      this.auditRoot(root, auditOf(project), rel, "page_write");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ project, path: rel }));
    }

    // ── /digest (add-cluster-digest-injection): the platform-seam digest read
    // face — ONE server-side render per request through the same retrieval
    // (hybridCandidates) and renderer (src/digest.ts) the continuation eval
    // validated. Auth mirrors /memory: persons read their own root, platform/
    // runner reach a named root via explicit rootKey, agents refused. Embed
    // lane trouble degrades to keyword recall with a model_note — never a
    // failed request. Server-side clamps: k ≤ 8, budget ≤ 2000.
    if (path === "/digest" && req.method === "GET") {
      const rootKeyParam = url.searchParams.get("rootKey");
      let dRoot: StoreRoot;
      if (scope.kind === "platform" || scope.kind === "runner") {
        if (!rootKeyParam) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_required" }));
        }
        dRoot = this.rootForKey(rootKeyParam);
      } else if (scope.kind === "person") {
        if (rootKeyParam) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_is_platform_seam_only" }));
        }
        dRoot = this.rootFor(scope);
      } else {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const project = String(url.searchParams.get("project") ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
      if (!project) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "project_required" }));
      }
      const q = String(url.searchParams.get("q") ?? "");
      const k = Math.min(8, Math.max(1, Number(url.searchParams.get("k") ?? 5) || 5));
      const budget = Math.min(2000, Math.max(64, Number(url.searchParams.get("budget") ?? 1500) || 1500));
      let modelNote: string | undefined;
      const t0 = Date.now();
      // Internal deadline (add-u-root-distillation D4): the caller (cell) gives
      // the whole request ~5s; a slow sidecar embed used to eat all of it and
      // the entire digest face timed out into the title-list rung. Bound the
      // embed attempt so keyword recall — still a digest block, with a
      // model_note — always wins the race inside the caller's budget.
      const EMBED_DEADLINE_MS = Number(process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS ?? 3500);
      const embed = async (texts: string[]): Promise<{ vectors: number[][]; model: string; tokens: number }> => {
        if (embedLaneCoolingDown()) {
          noteEmbedSample({ ms: 0, ok: false, reason: "cooling_down" });
          throw new Error("embed lane cooling down (recent slow streak) — keyword recall");
        }
        let timer: NodeJS.Timeout | undefined;
        const e0 = Date.now();
        try {
          const out = await Promise.race([
            serializeEmbed((t) => sidecarEmbed(process.env, t), texts),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => rej(new Error(`embed deadline ${EMBED_DEADLINE_MS}ms exceeded`)), EMBED_DEADLINE_MS);
            }),
          ]);
          noteEmbedOutcome(true);
          noteEmbedSample({ ms: Date.now() - e0, ok: true });
          return out;
        } catch (e) {
          noteEmbedOutcome(false);
          noteEmbedSample({ ms: Date.now() - e0, ok: false, reason: String((e as Error)?.message ?? e) });
          modelNote = `vector lane unavailable — keyword-only recall (${(e as Error)?.message ?? e})`;
          throw e; // hybridCandidates catches and falls back to keyword
        } finally {
          clearTimeout(timer);
        }
      };
      const candidates = await hybridCandidates({ root: dRoot, project, queryFor: q, k, embed });
      // Enrich candidates with confidence/updated_at from the page index +
      // frontmatter (render annotations must not depend on the caller).
      const pageMeta = new Map(dRoot.db.recentPages(1000, [project]).map((p) => [p.path, p.updated_at]));
      const items: DigestItem[] = candidates.map((c) => {
        let updated_at: string | null = null;
        let confidence: number | null = null;
        for (const p2 of project === "shared" ? ["shared"] : [project, "shared"]) {
          const rel = `${p2}/${c.kind === "fact" ? "facts" : "experiences"}/${c.id}.md`;
          if (!pageMeta.has(rel)) continue;
          updated_at = pageMeta.get(rel)!;
          const page = dRoot.readPageByRel(rel);
          const conf = page?.frontmatter?.confidence;
          confidence = conf != null ? Number(conf) : null;
          break;
        }
        return {
          id: c.id, layer: "L2", kind: c.kind, title: c.task,
          // page bodies carry "## Task/## Solution" section headers — strip
          // for the excerpt (producer-side hygiene, same as the eval)
          // L2 gist (2026-10-26 benchmark): 400-char excerpts made ~350-token
          // lines — three retrieval hits consumed most of the budget and
          // crowded notes out. Titles+short gist carry the signal (the titles
          // arm won on titles alone); 150 keeps ~8-10 lines per block.
          excerpt: String(c.solution ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 150),
          confidence, updated_at,
        };
      });
      // Recent notes ride as L1 items AFTER the L2 candidates (add-digest-
      // note-recall): the cluster-turn write-back is a note, and without this
      // rung every turn's digest had no reader of the previous turn's
      // write-back — the loop was open (production counter-evidence §15.31
      // 补记三: turn 2 got a byte-identical empty digest with turn 1's note on
      // disk). Renderer budget discipline carries the ordering: handoffs
      // section first, then array order (L2 before notes), tail truncated.
      // L1 recall depth (benchmark+eval finding, 2026-10-26): the only
      // benchmark miss and the wx titles-beats-digest eval gap both traced to
      // rank-4/5 notes — their TITLES alone carry the signal. Segment widens
      // to 5 with gist-sized lines (title + ~100-char excerpt).
      const NOTES_LIMIT = 5;
      // Query-relevant notes ride FIRST (the "remember it, find it" lane that
      // doesn't wait for distillation latency), then recency fills the rest.
      // Empty/no-match query → pure recency, byte-identical to before.
      const matched = q.trim() ? dRoot.db.queryNotes(project, q, 3) : [];
      const matchedPaths = new Set(matched.map((p) => p.path));
      // Reference lane (add-unified-memory-and-outputs): thin index entries
      // for library/output artifacts render as citation-by-name lines (「见
      // 资料库《title》— summary」) — never the body. Caps mirror the notes
      // segment; canonical rides first under budget pressure (renderer keeps
      // array order).
      const k_refs = Math.min(3, Math.max(1, Math.floor(k / 2)));
      const refs = q.trim() ? dRoot.db.queryReferences(project, q, k_refs) : dRoot.db.queryReferences(project, "", k_refs);
      const refItems: DigestItem[] = refs.map((p) => ({
        id: p.path, layer: "L2" as const, kind: "reference",
        title: `见资料库《${p.title}》`,
        excerpt: String(p.body ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        confidence: null, updated_at: p.updated_at,
      }));
      const merged = [
        ...matched,
        ...dRoot.db.recentNotes(project, NOTES_LIMIT).filter((p) => !matchedPaths.has(p.path)),
      ].slice(0, NOTES_LIMIT);
      const noteItems: DigestItem[] = merged.map((p) => {
        const page = dRoot.readPageByRel(p.path);
        return {
          id: p.path, layer: "L1" as const, kind: "note", title: p.title,
          excerpt: String(page?.body ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 100),
          confidence: null, updated_at: p.updated_at,
        };
      });
      // Handoffs cap (add-chat-memory-injection drill, 2026-10-25): the
      // renderer spends budget handoffs-first, so an owner root with a pile
      // of open handoffs (e.g. a day of fleet drills) starved the L1 notes
      // segment to zero — the chat lane's core recall — while cluster roots
      // never noticed (they carry 0-2 handoffs). Cap the sample at 3; the
      // renderer's ordering is untouched.
      // Recency gate (run12 micro-A/B, 2026-10-26): "待认领" means actionable
      // NOW. Week-old open handoffs (drifted state — the round that created
      // them already moved on) led every digest turn and pulled the agent into
      // claiming stale work over the current task. Created within the max-age
      // window only; older ones stay queryable via /pages and the MCP face.
      const HANDOFF_MAX_AGE_MS = Number(process.env.FD_MEMORY_DIGEST_HANDOFF_MAX_AGE_H ?? 48) * 3600_000;
      const freshEnough = (iso: string) => Date.now() - Date.parse(iso) < HANDOFF_MAX_AGE_MS;
      const handoffs = dRoot.db.openHandoffs([project]).filter((h) => freshEnough(h.created_at)).slice(0, 3).map((h) => ({ id: h.id, summary: h.summary, to_agent: h.to_agent, created_at: h.created_at }));
      const allItems = [...refItems, ...items, ...noteItems];
      const digest = renderDigest({ items: allItems, handoffs, budgetTokens: budget, now: new Date().toISOString() });
      const rendered = (digest.match(/〔L/g) ?? []).length;
      const renderedNotes = (digest.match(/〔L1·/g) ?? []).length;
      // served-rung line (add-u-root-distillation D4): hit-rate is observable
      // from the logs — vector vs keyword, load, ms. rootKey stays server-side.
      const logRoot = scope.kind === "platform" || scope.kind === "runner" ? rootKeyParam : namespaceParts(scope.namespace).rootKey;
      noteDigestRung(modelNote ? "keyword" : "vector");
      console.log(`[digest] ${logRoot}:${project} rung=${modelNote ? "keyword" : "vector"} items=${rendered - renderedNotes} notes=${renderedNotes} ms=${Date.now() - t0}${modelNote ? ` note="${modelNote.slice(0, 120)}"` : ""}`);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ project, digest, items: items.length, notes: renderedNotes, truncated: rendered < allItems.length, ...(modelNote ? { model_note: modelNote } : {}) }));
    }

    if (path === "/pages/write" && req.method === "POST") {
      const rootKeyParam = url.searchParams.get("rootKey");
      let wRoot: StoreRoot;
      let principal: string;
      if (scope.kind === "platform" || scope.kind === "runner") {
        if (!rootKeyParam) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "rootKey_required" })); }
        wRoot = this.rootForKey(rootKeyParam);
        principal = `${scope.kind}:${scope.tokenId}`;
      } else if (scope.kind === "person") {
        if (rootKeyParam) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "rootKey_is_platform_seam_only" })); }
        wRoot = this.rootFor(scope);
        principal = `person:${scope.tokenId}`;
      } else {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const body = await this.body<{ project?: unknown; type?: unknown; title?: unknown; body?: unknown; tags?: unknown; tier?: unknown; source_ref?: unknown; origin?: unknown; slug?: unknown }>(req);
      const project = String(body.project ?? "default");
      const type = String(body.type ?? "note");
      const dir = type === "reference" ? "references" : type === "note" ? "notes" : null;
      if (!dir) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "unknown_page_type" })); }
      const title = String(body.title ?? "").trim();
      if (!title) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "title_required" })); }
      const extra: Record<string, unknown> = {};
      if (type === "reference") {
        const sourceRef = String(body.source_ref ?? "").trim();
        if (!sourceRef) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "reference_requires_source_ref" })); }
        extra.source_ref = sourceRef;
      }
      if (Array.isArray(body.tags)) extra.tags = body.tags.map(String).slice(0, 5);
      const tier = String(body.tier ?? "draft");
      if (["draft", "stable", "canonical"].includes(tier)) extra.tier = tier;
      if (body.origin) extra.origin = String(body.origin);
      const slug = String(body.slug ?? randomUUID().slice(0, 8));
      const rel = `${project}/${dir}/${slug}.md`;
      const relOut = wRoot.writePage(project, dir, slug, newPage(type, title, String(body.body ?? ""), extra), { principal, scope: `${project}/${rel}` });
      res.writeHead(201, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ path: relOut, created: true }));
    }

    // ── /pages/mutate (add-unified-memory-and-outputs): the single-writer
    // gesture face for tier/tags. Write master lives here (gesture UIs and
    // capture handlers never touch the index directly); every mutation lands
    // frontmatter + index + audit + a correction note the tagging lane reads.
    if (path === "/pages/mutate" && req.method === "POST") {
      const rootKeyParam = url.searchParams.get("rootKey");
      let mRoot: StoreRoot;
      let principal: string;
      if (scope.kind === "platform" || scope.kind === "runner") {
        if (!rootKeyParam) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "rootKey_required" })); }
        mRoot = this.rootForKey(rootKeyParam);
        principal = `${scope.kind}:${scope.tokenId}`;
      } else if (scope.kind === "person") {
        if (rootKeyParam) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "rootKey_is_platform_seam_only" })); }
        mRoot = this.rootFor(scope);
        principal = `person:${scope.tokenId}`;
      } else {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const body = await this.body<{ path?: unknown; op?: unknown; origin?: unknown; tier?: unknown; tags?: unknown }>(req);
      const rel = String(body.path ?? "");
      const op = String(body.op ?? "");
      const origin = String(body.origin ?? "human");
      if (!["set_tier", "set_tags"].includes(op)) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "unknown_op", allowed: ["set_tier", "set_tags"] })); }
      const page = mRoot.readPageByRel(rel);
      if (!page) { res.writeHead(404, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "not_found" })); }
      const seg = rel.split("/")[0];
      const project = seg === "shared" ? "shared" : seg;
      const changes: string[] = [];
      const fm: Record<string, unknown> = { ...page.frontmatter };
      if (op === "set_tier") {
        const tier = String(body.tier ?? "");
        if (!["draft", "stable", "canonical"].includes(tier)) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "invalid_tier" })); }
        if (String(page.frontmatter.tier ?? "draft") !== tier) { changes.push(`tier: ${String(page.frontmatter.tier ?? "draft")} → ${tier}`); fm.tier = tier; fm.tier_origin = origin; }
      }
      if (op === "set_tags") {
        if (!Array.isArray(body.tags)) { res.writeHead(400, { "content-type": "application/json" }); return void res.end(JSON.stringify({ error: "tags_must_be_array" })); }
        const next = body.tags.map(String).slice(0, 5);
        const prev = Array.isArray(page.frontmatter.tags) ? (page.frontmatter.tags as unknown[]).map(String) : [];
        if (JSON.stringify(prev) !== JSON.stringify(next)) { changes.push(`tags: [${prev.join(", ")}] → [${next.join(", ")}]`); fm.tags = next; fm.tags_origin = origin; }
      }
      if (changes.length === 0) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ path: rel, changed: false }));
      }
      const newPg = { frontmatter: fm, body: page.body };
      mRoot.writePage(project, rel.split("/")[1], rel.split("/").pop()!.replace(/\.md$/, ""), newPg as never, { principal, scope: `${project}/${rel}` });
      // Correction note — the tagging lane's vocabulary feed (title prefix is
      // the machine marker; never a user's own note).
      mRoot.writePage(project, "notes", randomUUID().slice(0, 8), newPage("note", `修正：${rel}`, changes.join("\n"), { origin, correction_of: rel }), { principal, scope: `${project}/${rel}` });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ path: rel, changed: true, changes }));
    }

    // ── /memory + /forget (add-memory-distiller, memory-visibility): the
    // owner's read face. Person tokens only — agents keep their MCP face and
    // gain no owner-level enumeration. forget is a logical delete: the page
    // leaves every derived read face, its markdown truth and audit row stay.
    if (path === "/memory" && req.method === "GET") {
      // Platform-seam variant (add-facade-memory-read-lane): platform/runner
      // tokens reach a named root via explicit rootKey (same trust tier as
      // /admin/report — the deployer mapping is the CALLER's job); agents are
      // refused outright; persons always resolve their own root.
      const rootKeyParam = url.searchParams.get("rootKey");
      let memRoot: StoreRoot;
      let auditScopeBase: string;
      if (scope.kind === "platform" || scope.kind === "runner") {
        if (!rootKeyParam) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_required" }));
        }
        memRoot = this.rootForKey(rootKeyParam);
        auditScopeBase = rootKeyParam;
      } else if (scope.kind === "person") {
        if (rootKeyParam) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_is_platform_seam_only" }));
        }
        memRoot = this.rootFor(scope);
        auditScopeBase = memRoot.rootDir.split("/").pop()!;
      } else {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const root = memRoot;
      const projectFilter = url.searchParams.get("scope");
      const layer = url.searchParams.get("layer"); // L0 | L1 | L2
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      const projects = projectFilter ? [projectFilter] : null;
      // Unified-memory variant: tier/tag filters (composable with scope/layer/
      // time); a reference page reports L2 like facts/experiences; every item
      // carries tier/tags/source_ref (absent values degrade to empty, never
      // breaking older rows whose columns read as empty/NULL).
      const tierFilter = url.searchParams.get("tier");
      const tagsWanted = (url.searchParams.getAll("tag") ?? []).flatMap((v) => String(v).split(",")).map((t) => t.trim()).filter(Boolean);
      const layerOf = (type: string) => (type === "observation" ? "L0" : type === "fact" || type === "experience" || type === "reference" ? "L2" : "L1");
      const inWindow = (ts: string) => (!since || ts >= since) && (!until || ts <= until);
      const matchTag = (raw: string | null) => {
        if (!tagsWanted.length) return true;
        let arr: string[] = [];
        try { arr = JSON.parse(raw || "[]") as string[]; } catch { /* malformed */ }
        return tagsWanted.some((t) => arr.includes(t));
      };
      const pages = root.db
        .recentPages(500, projects)
        .filter((p) => (!layer || layerOf(p.type) === layer) && inWindow(p.updated_at) && (!tierFilter || p.tier === tierFilter) && matchTag(p.tags))
        .map((p) => ({
          path: p.path, title: p.title, project: p.project, layer: layerOf(p.type),
          sources: JSON.parse(p.sources || "[]"), tags: JSON.parse(p.tags || "[]"), tier: p.tier || "draft",
          source_ref: p.source_ref ?? null, type: p.type, ts: p.updated_at,
        }));
      const obs = root.db
        .recentObservations(500, projects)
        .filter((o) => (!layer || layer === "L0") && inWindow(o.created_at))
        .map((o) => ({ path: `${o.project}/${o.session_id}/${o.event}`, title: `${o.event}${o.tool ? " " + o.tool : ""}`, project: o.project, layer: "L0", sources: [], ts: o.created_at }));
      const items = [...pages, ...obs].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(offset, offset + limit);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ items, offset, limit }));
    }

    if (path === "/forget" && req.method === "POST") {
      const body = await this.body<{ path?: string; confirm?: boolean; rootKey?: string }>(req);
      let fRoot: StoreRoot;
      let principal: string;
      let fScope: string;
      if (scope.kind === "platform" || scope.kind === "runner") {
        const rk = String(body.rootKey ?? url.searchParams.get("rootKey") ?? "");
        if (!rk) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_required" }));
        }
        fRoot = this.rootForKey(rk);
        principal = `${scope.kind}:${scope.tokenId}`;
        fScope = rk;
      } else if (scope.kind === "person") {
        if (body.rootKey || url.searchParams.get("rootKey")) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_is_platform_seam_only" }));
        }
        fRoot = this.rootFor(scope);
        principal = `person:${scope.tokenId}`;
        fScope = scope.namespace;
      } else {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "person_token_required" }));
      }
      const rel = String(body.path ?? "");
      if (body.confirm !== true) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "confirm_required" }));
      }
      const root = fRoot;
      // paths resolve inside the caller's own root only (join is guarded by
      // the wiki root)
      const page = root.readPageByRel(rel);
      if (!page) {
        res.writeHead(404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "not_found" }));
      }
      const ok = root.forgetPage(rel, { principal, scope: fScope });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ forgotten: ok ? rel : null, already: !ok }));
    }

    // namespace overrides never apply: the wire protocol has no namespace
    // parameter; a query-string attempt is ignored, not honored.
    if (path.startsWith("/admin/")) {
      return this.admin(req, res, scope, path);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path }));
  }

  private auditRoot(root: StoreRoot, a: { principal: string; scope: string }, pageRel: string, op: string): void {
    try {
      root.db.addWrite(a.principal, a.scope, pageRel, op);
    } catch {
      /* companion record only */
    }
  }

  // -- MCP (streamable-http) -------------------------------------------------

  private sessions = new Map<string, { scope: Scope; root: StoreRoot }>();

  private async mcp(req: IncomingMessage, res: ServerResponse, scope: Scope): Promise<void> {
    const msg = await this.body<{ jsonrpc: string; id?: number | string; method: string; params?: Record<string, unknown> }>(req);
    const sid = String(req.headers["mcp-session-id"] ?? "");

    if (msg.method === "initialize") {
      const sessionId = randomUUID();
      const root = this.rootFor(scope);
      this.sessions.set(sessionId, { scope, root });
      // revocation check per call: token re-verified on every request by
      // route(); sessions just cache the resolved root
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      });
      return void res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fd-memory", version: "0.1.0" },
        },
      }));
    }

    const session = this.sessions.get(sid);
    if (!session) {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: "session not initialized" } }));
    }

    if (msg.method === "notifications/initialized" || msg.method?.startsWith("notifications/")) {
      res.writeHead(202);
      return void res.end();
    }

    // Grants consulted per call (fresh table read): revoking a grant narrows
    // the tool face immediately, mirroring the token's own no-cache rule.
    const tools = () => buildTools(session.scope, session.root, { allows: (ns, mode) => this.tokens.allows(session.scope.tokenId, ns, mode) }, (rootKey, project) => {
      // Write-triggered distillation (add-write-triggered-distill): a
      // successful note/handoff write marks the project pending — the
      // isDistillableRoot gate and FD_MEMORY_DISTILL_U switch apply inside.
      this.distill.notifyCapture(rootKey, project, [{ event: "session-end" }]);
    });

    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      }));
    }

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = tools().find((t) => t.name === name);
      if (!tool) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } }));
      }
      try {
        const result = tool.handler(args);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(err) }], isError: true } }));
      }
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `method not found: ${msg.method}` } }));
  }

  // -- admin -----------------------------------------------------------------

  private async admin(req: IncomingMessage, res: ServerResponse, scope: Scope, path: string): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "method_not_allowed" }));
    }
    const body = await this.body<Record<string, string>>(req);
    if (path === "/admin/mint") {
      // Split authority (add-memory-federation-v1): runner mints deployment
      // tokens (d/), platform mints person tokens (u/) for its users. Every
      // other kind — and every cross-target ask — is refused. A d/ namespace
      // of TWO segments mints a pod token (the pack's shared mount); THREE
      // segments mint a member token (add-memory-scopes-and-cluster-sharing).
      const ns = String(body.namespace ?? "");
      if (scope.kind === "runner") {
        if (!ns.startsWith("d/")) {
          res.writeHead(403, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "cross_family_mint", runner_mints: "d/<packId>[/<agentId>]" }));
        }
        const segs = ns.slice(2).split("/").filter(Boolean);
        if (segs.length === 2) {
          const out = this.tokens.mint("deployment", ns, String(body.label ?? "runner-minted"));
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify(out));
        }
        if (segs.length === 1) {
          const out = this.tokens.mint("pod", ns, String(body.label ?? "runner-minted"));
          res.writeHead(200, { "content-type": "application/json" });
          return void res.end(JSON.stringify(out));
        }
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_namespace", hint: "d/<packId> (pod) | d/<packId>/<agentId> (member)" }));
      }
      if (scope.kind === "platform") {
        if (!ns.startsWith("u/")) {
          res.writeHead(403, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "cross_family_mint", platform_mints: "u/<user>" }));
        }
        if (ns.split("/").length !== 2 || !ns.slice(2)) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "invalid_namespace", hint: "u/<user>" }));
        }
        const out = this.tokens.mint("person", ns, String(body.label ?? "platform-minted"));
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(out));
      }
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "minting_face_forbidden", allowed: ["runner:deployment|pod", "platform:person"] }));
    }

    // Operational snapshot (add-memory-metrics): one curl answers "is the
    // vector rung holding up, how slow is embed, is distillation yielding".
    // Runner/platform only — the counters carry root activity cadence.
    if (path === "/admin/metrics") {
      // POST per the admin face convention (mint/reindex/report); body unused.
      if (scope.kind !== "runner" && scope.kind !== "platform") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "service_token_required" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(metricsSnapshot()));
    }

    if (path === "/admin/reindex") {
      const root = this.rootFor(scope);
      const count = root.db.reindexFromWiki(root.wikiDir);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ reindexed: count }));
    }

    // Memory report for one root: the grants that reach into it (with their
    // token identities) and the root's recent write audit. Persons and data
    // tokens see their own root; runner/platform may name any root (ops).
    if (path === "/admin/report") {
      let rootKey: string;
      if (scope.kind === "runner" || scope.kind === "platform") {
        rootKey = String(body.rootKey ?? "");
        if (!rootKey) {
          res.writeHead(400, { "content-type": "application/json" });
          return void res.end(JSON.stringify({ error: "rootKey_required" }));
        }
      } else {
        rootKey = namespaceParts(scope.namespace).rootKey;
      }
      const root = this.rootForKey(rootKey);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({
        rootKey,
        grants: this.tokens.grantsForRoot(rootKey),
        recent_writes: root.db.recentWrites(50),
        distill: this.tokens.distillBudgetRows(rootKey),
      }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path }));
  }
}
