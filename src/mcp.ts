// MCP tool surface (streamable-http, protocol 2025-03-26). Eight tools; the
// wire protocol carries NO namespace on purpose — no client can even name
// another namespace. v2 (add-memory-scopes-and-cluster-sharing) adds the
// RELATIVE selector `target: "own" | "shared"`: reads default to the union of
// the token's accessible partitions (each row tagged with its source), writes
// default to own (a pod token's default is shared). Grant checks run per
// call, so revoking a grant narrows the face immediately.

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

// Grant consult, provided by the HTTP layer (fresh query per call).
export interface GrantCheck {
  allows(ns: string, mode: "r" | "rw"): boolean;
}

// Layer is derived, never stored: observation→L0, fact/experience→L2, the
// rest (handoff/note/session) →L1. sources ride L2 rows only.
function layerOf(type: string): "L0" | "L1" | "L2" {
  if (type === "observation") return "L0";
  if (type === "fact" || type === "experience") return "L2";
  return "L1";
}

function parseSources(raw: unknown): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const TARGET_SCHEMA = { type: "string", enum: ["own", "shared"], description: 'Relative partition selector: "own" (this member\'s private area) or "shared" (the pack\'s shared area). Reads default to the union; writes default to own (pod tokens default to shared).' };

function text(content: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 1) }] };
}

export interface ToolResult { content: Array<{ type: string; text: string }>; isError?: boolean }

function err(code: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, ...extra }) }], isError: true };
}

export function buildTools(scope: Scope, root: StoreRoot, grants: GrantCheck, notify?: (rootKey: string, project: string) => void): McpTool[] {
  const { project: baseProject } = namespaceParts(scope.namespace);
  const isDeploy = scope.kind === "deployment" || scope.kind === "pod";
  const packNs = isDeploy ? "d/" + namespaceParts(scope.namespace).rootKey.slice(2) : null;
  const ownProject = scope.kind === "pod" ? null : baseProject;
  const auditOf = (project: string) => ({ principal: `${scope.kind}:${scope.tokenId}`, scope: nsOfProject(project) });
  // Write-triggered distillation (add-write-triggered-distill): a successful
  // note write or handoff begin IS a distill-raw-material event — notify the
  // scheduler immediately instead of waiting for the fallback scan. Optional:
  // callers that don't wire it keep the pre-existing behavior byte-identical.
  const notifyWrite = (project: string) => {
    try {
      notify?.(namespaceParts(scope.namespace).rootKey, project);
    } catch { /* never fail the write because the notify path hiccuped */ }
  };

  // A project of this root as a namespace the grant table can judge.
  const nsOfProject = (project: string): string =>
    scope.kind === "person" ? `${scope.namespace}/p/${project}` : project === "shared" ? packNs! : `${packNs}/${project}`;
  const may = (project: string, mode: "r" | "rw") => grants.allows(nsOfProject(project), mode);
  const sourceOf = (project: string): "own" | "shared" => (isDeploy && project === "shared" ? "shared" : "own");

  // Readable partitions for the DEFAULT (union) read: deployment members get
  // [own, shared], pods [shared]; a person's owner grant covers their whole
  // root (null = no project filter), preserving the v1 face.
  function readProjects(target: unknown): { projects: string[] | null; error?: ToolResult } {
    if (target === undefined || target === null || target === "") {
      if (scope.kind === "person") return { projects: null };
      const out: string[] = [];
      if (ownProject != null && may(ownProject, "r")) out.push(ownProject);
      if (isDeploy && may("shared", "r")) out.push("shared");
      if (out.length === 0) return { projects: [], error: err("no_accessible_partition") };
      return { projects: out };
    }
    const t = String(target);
    if (t === "own") {
      if (ownProject == null) return { projects: [], error: err("pod_token_has_no_own_partition") };
      if (!may(ownProject, "r")) return { projects: [], error: err("forbidden_partition", { partition: "own" }) };
      return { projects: [ownProject] };
    }
    if (t === "shared") {
      if (!isDeploy) return { projects: [], error: err("shared_is_deployment_pack_only") };
      if (!may("shared", "r")) return { projects: [], error: err("forbidden_partition", { partition: "shared" }) };
      return { projects: ["shared"] };
    }
    return { projects: [], error: err("invalid_target", { target: t }) };
  }

  // The single partition a write lands in. Default = own; a pod's default is
  // shared (it has no own).
  function writeProject(target: unknown): { project?: string; error?: ToolResult } {
    const t = target === undefined || target === null || target === "" ? null : String(target);
    if (t === null || t === "own") {
      if (t === "own" && ownProject == null) return { error: err("pod_token_has_no_own_partition") };
      if (ownProject != null && may(ownProject, "rw")) return { project: ownProject };
      if (t === null && ownProject == null && isDeploy && may("shared", "rw")) return { project: "shared" };
      return { error: err(ownProject == null ? "no_accessible_partition" : "forbidden_partition", { partition: "own" }) };
    }
    if (t === "shared") {
      if (!isDeploy) return { error: err("shared_is_deployment_pack_only") };
      if (!may("shared", "rw")) return { error: err("forbidden_partition", { partition: "shared" }) };
      return { project: "shared" };
    }
    return { error: err("invalid_target", { target: t }) };
  }

  const targetProps = { target: TARGET_SCHEMA };

  return [
    {
      name: "memory_handoff_begin",
      description: "Write a typed handoff at session end: summary, open questions, next steps, files touched. Default lands in your own area; target 'shared' writes the pack's shared area and may carry to_agent (an agent-to-agent handoff).",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          open_questions: { type: "array", items: { type: "string" } },
          next_steps: { type: "array", items: { type: "string" } },
          files_touched: { type: "array", items: { type: "string" } },
          to_agent: { type: "string", description: "Addressed member (requires target 'shared')." },
          ...targetProps,
        },
        required: ["summary"],
      },
      handler: (args) => {
        const w = writeProject(args.target);
        if (w.error) return w.error;
        if (args.to_agent != null && w.project !== "shared") return err("to_agent_requires_shared");
        const row = root.beginHandoff(w.project!, String(args.agent ?? scope.kind), {
          summary: String(args.summary ?? ""),
          open_questions: (args.open_questions as string[]) ?? [],
          next_steps: (args.next_steps as string[]) ?? [],
          files_touched: (args.files_touched as string[]) ?? [],
          ...(args.to_agent != null ? { to_agent: String(args.to_agent) } : {}),
        }, auditOf(w.project!));
        notifyWrite(row.project);
        return text({ handoff_id: row.id, state: row.state, project: row.project, source: sourceOf(row.project) });
      },
    },
    {
      name: "memory_handoff_list",
      description: "List open handoffs — default across your accessible partitions, each tagged with its source.",
      inputSchema: { type: "object", properties: { ...targetProps } },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const rows = root.db.openHandoffs(r.projects).map((row) => ({ ...row, source: sourceOf(row.project) }));
        return text({ handoffs: rows });
      },
    },
    {
      name: "memory_handoff_accept",
      description: "Claim an open handoff exactly once by its id.",
      inputSchema: { type: "object", properties: { handoff_id: { type: "string" } }, required: ["handoff_id"] },
      handler: (args) => {
        const id = String(args.handoff_id);
        const row = root.db.getHandoff(id);
        if (!row) return err("not_found");
        if (!may(row.project, "r")) return err("forbidden_project");
        const res = root.acceptHandoff(id, String(args.agent ?? scope.kind), auditOf(row.project));
        if (!res.claimed && res.already === undefined) return err("not_found");
        return text(res.claimed ? { status: "claimed", handoff: res.handoff } : { status: "already_claimed", accepted_by: res.already });
      },
    },
    {
      name: "memory_handoff_cancel",
      description: "Cancel an open handoff by id.",
      inputSchema: { type: "object", properties: { handoff_id: { type: "string" } }, required: ["handoff_id"] },
      handler: (args) => {
        const id = String(args.handoff_id);
        const row = root.db.getHandoff(id);
        if (!row) return err("not_found");
        if (!may(row.project, "rw")) return err("forbidden_project");
        return text({ cancelled: root.cancelHandoff(id, auditOf(row.project)) });
      },
    },
    {
      name: "memory_query",
      description: "Full-text search across your accessible partitions (each result carries its source).",
      inputSchema: { type: "object", properties: { q: { type: "string" }, limit: { type: "number" }, ...targetProps }, required: ["q"] },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const results = root.db.searchPages(String(args.q), Number(args.limit ?? 20), r.projects).map((row) => ({
          ...row,
          source: sourceOf(row.project),
          layer: layerOf(row.type),
          ...(layerOf(row.type) === "L2" ? { sources: parseSources(row.sources) } : {}),
        }));
        return text({ results });
      },
    },
    {
      name: "memory_recent",
      description: "Recent pages and observations across your accessible partitions (each row carries its source).",
      inputSchema: { type: "object", properties: { limit: { type: "number" }, ...targetProps } },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const limit = Number(args.limit ?? 20);
        return text({
          pages: root.db.recentPages(limit, r.projects).map((p) => ({
            ...p,
            source: sourceOf(p.project),
            layer: layerOf(p.type),
            ...(layerOf(p.type) === "L2" ? { sources: parseSources(p.sources) } : {}),
          })),
          observations: root.db.recentObservations(limit, r.projects).map((o) => ({ ...o, source: sourceOf(o.project), layer: "L0" })),
        });
      },
    },
    {
      name: "memory_read_page",
      description: "Read a page by its wiki-relative path — only within partitions your grants cover.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: (args) => {
        const rel = String(args.path);
        const seg = rel.split(/[\\/]/)[0];
        if (!seg || !may(seg, "r")) return err("forbidden_project");
        const page = root.readPageByRel(rel);
        if (!page) return err("not_found");
        return text({ frontmatter: page.frontmatter, body: page.body, source: sourceOf(seg) });
      },
    },
    {
      name: "memory_write_page",
      description: "Write a durable note page — default into your own area, target 'shared' into the pack's shared area. Use it whenever the user explicitly asks you to remember something, or you learn a preference/fact worth carrying into later sessions; recent notes are recalled automatically at later session starts.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          // Unified memory & outputs: reference pages point at library/output
          // artifacts. type defaults to "note"; "reference" requires
          // source_ref and caps tags at five; tier is draft|stable|canonical.
          type: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          tier: { type: "string" },
          source_ref: { type: "string" },
          origin: { type: "string" },
          ...targetProps,
        },
        required: ["title", "body"],
      },
      handler: (args) => {
        const w = writeProject(args.target);
        if (w.error) return w.error;
        const type = String(args.type ?? "note");
        const dir = type === "reference" ? "references" : type === "note" ? "notes" : null;
        if (!dir) return err(`unknown_page_type: ${type}`);
        const extra: Record<string, unknown> = {};
        if (type === "reference") {
          const sourceRef = String(args.source_ref ?? "").trim();
          if (!sourceRef) return err("reference_requires_source_ref");
          extra.source_ref = sourceRef;
          if (Array.isArray(args.tags)) extra.tags = args.tags.map(String).slice(0, 5);
          const tier = String(args.tier ?? "draft");
          if (["draft", "stable", "canonical"].includes(tier)) extra.tier = tier;
          if (args.origin) extra.origin = String(args.origin);
        }
        const rel = root.writePage(w.project!, dir, randomUUID().slice(0, 8), newPage(type, String(args.title), String(args.body), extra), auditOf(w.project!));
        notifyWrite(w.project!);
        return text({ path: rel, source: sourceOf(w.project!) });
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
