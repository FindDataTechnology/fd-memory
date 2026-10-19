// HTTP wiring: /mcp (JSON-RPC over streamable-http), /capture (hooks-shaped
// event ingest), /healthz, /admin/* (token ops, root-scoped). Auth on every
// route except /healthz; auth failures are structured JSON.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { TokenStore, Scope, namespaceParts, scopeAllowsNamespace } from "./auth.js";
import { StoreRoot } from "./store.js";
import { CaptureIngest, CaptureEvent } from "./capture.js";
import { buildTools } from "./mcp.js";

export interface ServiceOptions {
  dataDir: string;
  port: number;
  pepper: string;
  host?: string;
}

export class Service {
  readonly tokens: TokenStore;
  readonly ingest: CaptureIngest;
  private roots = new Map<string, StoreRoot>();

  constructor(readonly opts: ServiceOptions) {
    this.tokens = new TokenStore(opts.dataDir + "/tokens.db", opts.pepper);
    this.ingest = new CaptureIngest(this.roots, (key) => new StoreRoot(opts.dataDir, key));
  }

  rootFor(scope: Scope): StoreRoot {
    const { rootKey } = namespaceParts(scope.namespace);
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
    console.log(`[fd-memory] listening on ${host}:${this.opts.port} data=${this.opts.dataDir}`);
  }

  private auth(req: IncomingMessage): Scope | null {
    const h = String(req.headers.authorization ?? "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    return this.tokens.verify(m[1].trim());
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
      const body = await this.body<{ events?: CaptureEvent[]; namespace?: string } | CaptureEvent[]>(req);
      const events = Array.isArray(body) ? body : (body.events ?? [body as CaptureEvent]);
      // Deployment/person tokens always land in their own namespace (a
      // payload namespace is ignored, never honored). Runner tokens are
      // capture-only and carry the target d/ namespace per batch.
      const ns = scope.kind === "runner" ? String((body as { namespace?: string }).namespace ?? "") : scope.namespace;
      if (scope.kind === "runner" && !scopeAllowsNamespace(scope, ns)) {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "forbidden_namespace" }));
      }
      const { rootKey, project } = namespaceParts(ns);
      const out = this.ingest.ingest(rootKey, project, events);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(out));
    }

    if (path === "/mcp" && req.method === "POST") {
      if (scope.kind === "runner") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "runner tokens are capture-only" } }));
      }
      return this.mcp(req, res, scope);
    }

    // namespace overrides never apply: the wire protocol has no namespace
    // parameter; a query-string attempt is ignored, not honored.
    if (path.startsWith("/admin/")) {
      return this.admin(req, res, scope, path);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path }));
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

    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: buildTools(session.scope, session.root).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      }));
    }

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = buildTools(session.scope, session.root).find((t) => t.name === name);
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
      // Runner-only (add-fleet-memory-v1): the platform seam mints per-deployment
      // tokens at first spawn; runner tokens themselves stay capture-only.
      if (scope.kind !== "runner") {
        res.writeHead(403, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "runner_only" }));
      }
      const ns = String(body.namespace ?? "");
      if (!ns.startsWith("d/") || ns.split("/").length !== 3) {
        res.writeHead(400, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "invalid_namespace", hint: "d/<packId>/<agentId>" }));
      }
      const out = this.tokens.mint("deployment", ns, String(body.label ?? "runner-minted"));
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(out));
    }

    if (path === "/admin/reindex") {
      const root = this.rootFor(scope);
      const count = root.db.reindexFromWiki(root.wikiDir);
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ reindexed: count }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }
}
