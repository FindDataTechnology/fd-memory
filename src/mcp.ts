// MCP tool surface (streamable-http, protocol 2025-03-26). Seven tools; every
// operation is scoped to the requesting token's namespace — the wire protocol
// carries no namespace parameter on purpose, so no client can even name
// another namespace.

import { StoreRoot, rootKeyForNamespace } from "./store.js";
import { namespaceParts, Scope } from "./auth.js";
import { newPage } from "./okf.js";
import { randomUUID } from "node:crypto";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

function text(content: unknown): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 1) }] };
}

export function buildTools(scope: Scope, root: StoreRoot): McpTool[] {
  const { project } = namespaceParts(scope.namespace);

  return [
    {
      name: "memory_handoff_begin",
      description: "Write a typed handoff at session end: summary, open questions, next steps, files touched.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          open_questions: { type: "array", items: { type: "string" } },
          next_steps: { type: "array", items: { type: "string" } },
          files_touched: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
      },
      handler: (args) => {
        const row = root.beginHandoff(project, String(args.agent ?? scope.kind), {
          summary: String(args.summary ?? ""),
          open_questions: (args.open_questions as string[]) ?? [],
          next_steps: (args.next_steps as string[]) ?? [],
          files_touched: (args.files_touched as string[]) ?? [],
        });
        return text({ handoff_id: row.id, state: row.state });
      },
    },
    {
      name: "memory_handoff_list",
      description: "List open handoffs in this namespace.",
      inputSchema: { type: "object", properties: {} },
      handler: () => text({ handoffs: root.db.openHandoffs() }),
    },
    {
      name: "memory_handoff_accept",
      description: "Claim an open handoff exactly once by its id.",
      inputSchema: { type: "object", properties: { handoff_id: { type: "string" } }, required: ["handoff_id"] },
      handler: (args) => {
        const res = root.acceptHandoff(String(args.handoff_id), String(args.agent ?? scope.kind));
        if (!res.claimed && res.already === undefined) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }], isError: true };
        }
        return text(res.claimed ? { status: "claimed", handoff: res.handoff } : { status: "already_claimed", accepted_by: res.already });
      },
    },
    {
      name: "memory_handoff_cancel",
      description: "Cancel an open handoff by id.",
      inputSchema: { type: "object", properties: { handoff_id: { type: "string" } }, required: ["handoff_id"] },
      handler: (args) => text({ cancelled: root.cancelHandoff(String(args.handoff_id)) }),
    },
    {
      name: "memory_query",
      description: "Full-text search over this namespace's pages.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      handler: (args) => text({ results: root.db.searchPages(String(args.q)) }),
    },
    {
      name: "memory_recent",
      description: "Recent pages and observations in this namespace.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      handler: (args) =>
        text({
          pages: root.db.recentPages(Number(args.limit ?? 20)),
          observations: root.db.recentObservations(Number(args.limit ?? 20)),
        }),
    },
    {
      name: "memory_read_page",
      description: "Read a page by its wiki-relative path.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: (args) => {
        const page = root.readPageByRel(String(args.path));
        if (!page) return { content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }], isError: true };
        return text({ frontmatter: page.frontmatter, body: page.body });
      },
    },
    {
      name: "memory_write_page",
      description: "Write a durable note page into this namespace.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      handler: (args) => {
        const rel = root.writePage(project, "notes", randomUUID().slice(0, 8), newPage("note", String(args.title), String(args.body)));
        return text({ path: rel });
      },
    },
  ];
}

// `memory_write_page` is intentionally excluded from the seven-tool v1 wire
// face (spec: seven tools) — page writes flow through capture/handoff. Kept
// here as an internal helper for the HTTP write face used by consolidation
// tooling later.
export function writeNotePage(root: StoreRoot, project: string, title: string, body: string): string {
  return root.writePage(project, "notes", randomUUID().slice(0, 8), newPage("note", title, body));
}

export { rootKeyForNamespace };
