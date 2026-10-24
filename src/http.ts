// HTTP wiring: /mcp (JSON-RPC over streamable-http), /capture (hooks-shaped
// event ingest), /pages (platform-seam project read/write face — the wire
// carries a project NAME resolved inside the caller's own root, never a
// namespace), /healthz, /admin/* (token ops, root-scoped). Auth on every
// route except /healthz; auth failures are structured JSON.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { TokenStore, Scope, namespaceParts } from "./auth.js";
import { StoreRoot } from "./store.js";
import { CaptureIngest, CaptureEvent } from "./capture.js";
import { buildTools, writeNotePage } from "./mcp.js";
import { DistillScheduler, hybridCandidates, sidecarEmbed } from "./distill-scheduler.js";
import { renderDigest, DigestItem } from "./digest.js";

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
  private roots = new Map<string, StoreRoot>();

  constructor(readonly opts: ServiceOptions) {
    this.tokens = new TokenStore(opts.dataDir + "/tokens.db", opts.pepper);
    this.ingest = new CaptureIngest(this.roots, (key) => new StoreRoot(opts.dataDir, key));
    this.distill = new DistillScheduler({
      roots: this.roots,
      openRoot: (key) => this.rootForKey(key),
      tokens: this.tokens,
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
      const embed = async (texts: string[]): Promise<{ vectors: number[][]; model: string; tokens: number }> => {
        try {
          return await sidecarEmbed(process.env, texts);
        } catch (e) {
          modelNote = `vector lane unavailable — keyword-only recall (${(e as Error)?.message ?? e})`;
          throw e; // hybridCandidates catches and falls back to keyword
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
          excerpt: String(c.solution ?? "").replace(/^#{1,3} [^\n]*$/gm, "").replace(/[ \t]+/g, " ").trim().slice(0, 400),
          confidence, updated_at,
        };
      });
      const handoffs = dRoot.db.openHandoffs([project]).map((h) => ({ id: h.id, summary: h.summary, to_agent: h.to_agent, created_at: h.created_at }));
      const digest = renderDigest({ items, handoffs, budgetTokens: budget, now: new Date().toISOString() });
      const rendered = (digest.match(/〔L/g) ?? []).length;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ project, digest, items: items.length, truncated: rendered < items.length, ...(modelNote ? { model_note: modelNote } : {}) }));
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
      const layerOf = (type: string) => (type === "observation" ? "L0" : type === "fact" || type === "experience" ? "L2" : "L1");
      const inWindow = (ts: string) => (!since || ts >= since) && (!until || ts <= until);
      const pages = root.db
        .recentPages(500, projects)
        .filter((p) => (!layer || layerOf(p.type) === layer) && inWindow(p.updated_at))
        .map((p) => ({ path: p.path, title: p.title, project: p.project, layer: layerOf(p.type), sources: JSON.parse(p.sources || "[]"), ts: p.updated_at }));
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
    const tools = () => buildTools(session.scope, session.root, { allows: (ns, mode) => this.tokens.allows(session.scope.tokenId, ns, mode) });

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
