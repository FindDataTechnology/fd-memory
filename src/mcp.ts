// MCP tool surface (streamable-http, protocol 2025-03-26). Eight tools; the
// wire protocol carries NO namespace on purpose — no client can even name
// another namespace. v2 (add-memory-scopes-and-cluster-sharing) adds the
// RELATIVE selector `target: "own" | "shared"`: reads default to the union of
// the token's accessible partitions (each row tagged with its source), writes
// default to own (a pod token's default is shared). Grant checks run per
// call, so revoking a grant narrows the face immediately.

import { StoreRoot, rootKeyForNamespace, normalizeMetadata } from "./store.js";
import { namespaceParts, Scope } from "./auth.js";
import { PageFilter, pageFilterSql } from "./db.js";
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

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(String(raw ?? ""));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const TARGET_SCHEMA = { type: "string", enum: ["own", "shared"], description: 'Relative partition selector: "own" (this member\'s private area) or "shared" (the pack\'s shared area). Reads default to the union; writes default to own (pod tokens default to shared). A member agent that passes "shared" on a WRITE gets shared_is_deployment_pack_only — that area is writable by deployment packs only; omit target or pass "own".' };

// shared 的拒收要自带「那我该写哪」——实测 135 次调用都撞在这上面（cell 1da519d4c1c0bf89，
// 2026-11-15）：工具描述把 shared 列为合法枚举值、却没说普通成员写它会被拒。
const SHARED_HINT = {
  hint: "target='shared' is the deployment pack's area — a member agent cannot write it. Omit target (writes default to your own area) or pass target='own'; reads may still use 'shared'.",
};

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
      if (!isDeploy) return { projects: [], error: err("shared_is_deployment_pack_only", SHARED_HINT) };
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
      if (!isDeploy) return { error: err("shared_is_deployment_pack_only", SHARED_HINT) };
      if (!may("shared", "rw")) return { error: err("forbidden_partition", { partition: "shared" }) };
      return { project: "shared" };
    }
    return { error: err("invalid_target", { target: t }) };
  }

  // Read-surface caps (optimize-yongyi-read-surfaces). Every read face states
  // its ceiling and proves when it truncated — a capped page must never read as
  // the whole set. Measured on the production deployment (2026-11-10): after
  // fix-memory-handoff-list-cost the list was STILL 92% of all YongYi tool
  // bytes (297 calls / 3.49 MB in 24h, 12.3 KB per call), because each row
  // carried its full summary even though the row count was capped.
  const envInt = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  // Handoff-list page size (fix-memory-handoff-list-cost): the default keeps a
  // routine turn's "anything for me?" check cheap; the ceiling lets a caller
  // page deliberately. Both are stated to the caller via total/truncated.
  const HANDOFF_LIST_LIMIT = envInt("FD_MEMORY_HANDOFF_LIST_LIMIT", 20);
  const HANDOFF_LIST_MAX = envInt("FD_MEMORY_HANDOFF_LIST_MAX", 100);
  // Per-row gist: the list is a decision surface ("is one mine and how recent"),
  // not a body transfer. The full text is claimed through memory_handoff_accept.
  const HANDOFF_SUMMARY_CHARS = envInt("FD_MEMORY_HANDOFF_SUMMARY_CHARS", 200);
  // List faces (query/recent): the caller's limit is clamped, never trusted.
  const LIST_LIMIT_DEFAULT = envInt("FD_MEMORY_LIST_LIMIT", 20);
  const LIST_LIMIT_MAX = envInt("FD_MEMORY_LIST_LIMIT_MAX", 50);
  // Body faces: read_page pages by byte offset; accept caps each field.
  const READ_BODY_MAX_BYTES = envInt("FD_MEMORY_READ_BODY_MAX_BYTES", 32 * 1024);
  const ACCEPT_SUMMARY_CHARS = envInt("FD_MEMORY_ACCEPT_SUMMARY_CHARS", 4 * 1024);
  const ACCEPT_LIST_ITEMS = envInt("FD_MEMORY_ACCEPT_LIST_ITEMS", 20);
  const ACCEPT_ITEM_CHARS = envInt("FD_MEMORY_ACCEPT_ITEM_CHARS", 500);
  const ACCEPT_FILES_ITEMS = envInt("FD_MEMORY_ACCEPT_FILES_ITEMS", 200);
  // Overview caps (fix-memory-overview-cost): a person root can hold hundreds of
  // partitions; listing every one with ten titles is a bulk export wearing an
  // overview's name.
  const OVERVIEW_PARTITIONS = 25;
  const OVERVIEW_TITLES = 3;
  // Domain lookups are "what do we have on this thing" — a compass, not an
  // export. Capped like the overview so a broad value (a party shared by many
  // matters) cannot turn one call into a bulk dump.
  const DOMAIN_LOOKUP_LIMIT = 50;

  const clampListLimit = (raw: unknown): number => {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return LIST_LIMIT_DEFAULT;
    return Math.min(n, LIST_LIMIT_MAX);
  };
  const clip = (raw: unknown, max: number): { text: string; truncated: boolean } => {
    const v = String(raw ?? "");
    if (v.length <= max) return { text: v, truncated: false };
    return { text: v.slice(0, max), truncated: true };
  };
  // JSON-encoded list column (handoff fields live as strings) → capped array.
  const clipList = (raw: unknown, maxItems: number, maxChars: number): { items: string[]; truncated: boolean } => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw ?? "[]")); } catch { return { items: [], truncated: false }; }
    if (!Array.isArray(parsed)) return { items: [], truncated: false };
    const all = parsed.map(String);
    const items = all.slice(0, maxItems).map((s) => clip(s, maxChars).text);
    return { items, truncated: all.length > items.length || all.some((s, i) => i < maxItems && s.length > maxChars) };
  };

  const targetProps = { target: TARGET_SCHEMA };

  // Structured read filter (add-agent-memory-foundation): optional `filter`
  // object on the query/recent tools. layer maps through the same layerOf the
  // rows carry; unknown layers are a named error, never a silent match-all.
  const FILTER_SCHEMA = {
    type: "object",
    properties: {
      metadata: { type: "object", description: "Key/value filter; scalar = equality, array = contains." },
      since: { type: "string", description: "Inclusive lower bound on write time (ISO)." },
      until: { type: "string", description: "Inclusive upper bound on write time (ISO)." },
      layer: { type: "string", enum: ["L0", "L1", "L2"] },
    },
    description: "Optional structured filter, composable with the query.",
  };
  function readFilter(args: Record<string, unknown>): { filter?: PageFilter; error?: ToolResult } {
    const raw = args.filter;
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) return { error: err("invalid_filter", { reason: "filter must be an object" }) };
    const src = raw as { metadata?: unknown; since?: unknown; until?: unknown; layer?: unknown };
    const meta = normalizeMetadata(src.metadata);
    if (meta === null) return { error: err("invalid_metadata", { reason: "metadata values must be scalars or arrays of scalars" }) };
    const filter: PageFilter = {};
    if (meta && Object.keys(meta).length > 0) filter.metadata = meta;
    if (src.since != null) filter.since = String(src.since);
    if (src.until != null) filter.until = String(src.until);
    if (src.layer != null) {
      const l = String(src.layer);
      if (!["L0", "L1", "L2"].includes(l)) return { error: err("invalid_filter", { reason: `unknown layer ${l}` }) };
      // layerOf is derived from type; L0 rows are observations (not pages), so
      // a page-only filter maps L0 to an empty type set — handled by callers
      // that also query observations (memory_recent). Here: L2 = the distilled
      // types, L1 = everything else page-shaped.
      filter.types = l === "L2" ? ["fact", "experience", "reference"] : l === "L1" ? ["note", "handoff"] : [];
    }
    return { filter };
  }

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
      // Cap + projection (fix-memory-handoff-list-cost): this tool is called at
      // the START of most turns (the discipline tells agents to), and it used to
      // return EVERY open handoff with every column — 10.6MB across one cell's
      // traces, the single largest tool result on the deployment, and a direct
      // contributor to the context-compaction storms that burn a fleet round's
      // whole budget. The list is for DECIDING whether a handoff is yours, so it
      // carries the decision fields newest-first and says how many it left out;
      // the body (open_questions / next_steps / files_touched) is fetched by
      // memory_handoff_accept on the one the agent actually claims.
      description:
        "List open handoffs (newest first, capped) — default across your accessible partitions, each tagged with its source. " +
        "Returns id/summary/to_agent/from_agent/created_at plus total + truncated; claim one with memory_handoff_accept to get its full body.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProps,
          limit: { type: "number", description: `Max handoffs to return (default ${HANDOFF_LIST_LIMIT}, max ${HANDOFF_LIST_MAX}).` },
        },
      },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const requested = Number(args.limit);
        const cap = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), HANDOFF_LIST_MAX) : HANDOFF_LIST_LIMIT;
        // Newest first is the useful order for "is one addressed to me, and how
        // recent is it" — the old query sorted ascending and the caller read the
        // whole list anyway.
        //
        // `reverse()`, not a comparator, and that matters: `created_at` is
        // millisecond ISO text, so handoffs opened in one tick (a fleet round, a
        // batch import, a 30-iteration loop) compare EQUAL. `openHandoffs`
        // returns `ORDER BY created_at, rowid ASC`, so reversing yields
        // created_at DESC *and* rowid DESC — "later is newer" holds for ties too.
        // Sorting by created_at alone is stable, which preserves the ties in
        // ASCENDING rowid order, i.e. oldest-first among same-millisecond rows:
        // that is precisely the ~1-in-6 flake seen 2026-11-18 in
        // `mcp tools: handoff list is capped, newest-first`.
        // (Ordering by `id` would not help — ids are randomUUID.)
        const all = root.db.openHandoffs(r.projects).slice().reverse();
        let summariesTruncated = 0;
        const handoffs = all.slice(0, cap).map((row) => {
          const gist = clip(row.summary, HANDOFF_SUMMARY_CHARS);
          if (gist.truncated) summariesTruncated += 1;
          return {
            id: row.id,
            summary: gist.text,
            ...(gist.truncated ? { summary_truncated: true } : {}),
            from_agent: row.from_agent,
            to_agent: row.to_agent ?? null,
            project: row.project,
            created_at: row.created_at,
            source: sourceOf(row.project),
          };
        });
        // truncated is honest about EITHER dimension: more open handoffs than the
        // page carries, or any row whose summary was cut. A caller deciding
        // "anything for me?" must not read a gist as the full summary.
        return text({
          handoffs,
          total: all.length,
          truncated: all.length > handoffs.length || summariesTruncated > 0,
          ...(summariesTruncated ? { truncated_summaries: summariesTruncated } : {}),
        });
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
        if (!res.claimed) return text({ status: "already_claimed", accepted_by: res.already });
        // Accept is the ONE face that carries the body, so it is capped field by
        // field and says which fields were cut — a claimed handoff must not
        // arrive looking complete while its next steps were silently clipped.
        // Uncut fields keep their stored bytes exactly (the list columns stay
        // JSON strings, as before).
        const h = res.handoff!;
        const summary = clip(h.summary, ACCEPT_SUMMARY_CHARS);
        const questions = clipList(h.open_questions, ACCEPT_LIST_ITEMS, ACCEPT_ITEM_CHARS);
        const steps = clipList(h.next_steps, ACCEPT_LIST_ITEMS, ACCEPT_ITEM_CHARS);
        const files = clipList(h.files_touched, ACCEPT_FILES_ITEMS, ACCEPT_ITEM_CHARS);
        const truncatedFields: string[] = [];
        if (summary.truncated) truncatedFields.push("summary");
        if (questions.truncated) truncatedFields.push("open_questions");
        if (steps.truncated) truncatedFields.push("next_steps");
        if (files.truncated) truncatedFields.push("files_touched");
        return text({
          status: "claimed",
          handoff: {
            ...h,
            summary: summary.text,
            open_questions: questions.truncated ? JSON.stringify(questions.items) : h.open_questions,
            next_steps: steps.truncated ? JSON.stringify(steps.items) : h.next_steps,
            files_touched: files.truncated ? JSON.stringify(files.items) : h.files_touched,
          },
          ...(truncatedFields.length ? { truncated: true, truncated_fields: truncatedFields } : {}),
        });
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
      description: "Full-text search across your accessible partitions (each result carries its source). Optional filter: metadata key/values, time window, layer.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          limit: { type: "number" },
          filter: FILTER_SCHEMA,
          include_superseded: { type: "boolean", description: "Include pages retired by a newer page (history opt-in)." },
          ...targetProps,
        },
        required: ["q"],
      },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const f = readFilter(args);
        if (f.error) return f.error;
        const cap = clampListLimit(args.limit);
        const meta: { total?: number } = {};
        // `_total` is the window-function count from the same statement (see
        // StoreDb.searchPages): the true match count, not the page size.
        const results = root.db.searchPages(String(args.q), cap, r.projects, f.filter, meta, { includeSuperseded: args.include_superseded === true }).map((row) => {
          const { _total, ...rest } = row as typeof row & { _total?: number };
          void _total;
          return {
            ...rest,
            source: sourceOf(row.project),
            layer: layerOf(row.type),
            ...(layerOf(row.type) === "L2" ? { sources: parseSources(row.sources) } : {}),
            ...(row.metadata ? { metadata: parseMetadata(row.metadata) } : {}),
          };
        });
        const total = Number(meta.total ?? results.length);
        return text({ results, total, truncated: total > results.length });
      },
    },
    {
      name: "memory_recent",
      description: "Recent pages and observations across your accessible partitions (each row carries its source). Optional filter: metadata key/values, time window, layer.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          filter: FILTER_SCHEMA,
          include_superseded: { type: "boolean", description: "Include pages retired by a newer page (history opt-in)." },
          ...targetProps,
        },
      },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const f = readFilter(args);
        if (f.error) return f.error;
        const limit = clampListLimit(args.limit);
        const filter = f.filter ?? {};
        // L0 rows are observations, not pages: the pages leg drops for an
        // L0-only ask, and L1/L2 asks never carry observations.
        const layer = (args.filter as { layer?: string } | undefined)?.layer;
        const pagesMeta: { total?: number } = {};
        const obsMeta: { total?: number } = {};
        const pages = layer === "L0" ? [] : root.db.recentPages(limit, r.projects, filter, pagesMeta, { includeSuperseded: args.include_superseded === true }).map((p) => {
          const { _total, ...rest } = p as typeof p & { _total?: number };
          void _total;
          return {
            ...rest,
            source: sourceOf(p.project),
            layer: layerOf(p.type),
            ...(layerOf(p.type) === "L2" ? { sources: parseSources(p.sources) } : {}),
            ...(p.metadata ? { metadata: parseMetadata(p.metadata) } : {}),
          };
        });
        const observations = layer === "L2" || layer === "L1"
          ? []
          : root.db.recentObservations(limit, r.projects, filter.since, filter.until, obsMeta).map((o) => {
            const { _total, ...rest } = o as typeof o & { _total?: number };
            void _total;
            return { ...rest, source: sourceOf(o.project), layer: "L0" as const };
          });
        // Both legs are capped independently, so the total spans both: a caller
        // asking "what happened recently" must not read one capped leg as all.
        const total = Number(pagesMeta.total ?? pages.length) + Number(obsMeta.total ?? observations.length);
        return text({ pages, observations, total, truncated: total > pages.length + observations.length });
      },
    },
    {
      name: "memory_read_page",
      description: "Read a page by its wiki-relative path — only within partitions your grants cover. Large pages come back in byte-bounded slices: pass the returned next_offset back as offset to continue; truncated/total_bytes say what is left.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "Byte offset to continue from (the previous response's next_offset)." },
          limit_bytes: { type: "number", description: `Max body bytes for this read (default and max ${READ_BODY_MAX_BYTES}).` },
        },
        required: ["path"],
      },
      handler: (args) => {
        const rel = String(args.path);
        const seg = rel.split(/[\\/]/)[0];
        if (!seg || !may(seg, "r")) return err("forbidden_project");
        const page = root.readPageByRel(rel);
        if (!page) return err("not_found");
        // forgotten_at is the store's one definition of "withdrawn" (forgetPage /
        // retractHarness frontmark it) — the search and recent faces filter it
        // via the dropped index row, so this body face must too, or a retracted
        // import stays readable by path (add-harness-memory-import 4.2).
        if (page.frontmatter?.forgotten_at) return err("not_found");
        const bodyText = String(page.body ?? "");
        // Byte-bounded paging (optimize-yongyi-read-surfaces 2.2). Measured on
        // production the largest page is 10.7 KB, so this cap never fires today
        // — it is the guard that keeps one pathological page from eating a
        // turn's window. A cut page always says so and hands back the offset;
        // a page that fits keeps the pre-existing bytes exactly.
        const buf = Buffer.from(bodyText, "utf8");
        const total = buf.byteLength;
        const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
        const requested = Math.floor(Number(args.limit_bytes ?? READ_BODY_MAX_BYTES)) || READ_BODY_MAX_BYTES;
        const width = Math.min(READ_BODY_MAX_BYTES, Math.max(1, requested));
        const start = Math.min(offset, total);
        let end = Math.min(start + width, total);
        // Never split a UTF-8 sequence: back off to a lead byte.
        while (end > start && end < total && (buf[end] & 0xc0) === 0x80) end -= 1;
        const body = buf.subarray(start, end).toString("utf8");
        const partial = start > 0 || end < total;
        return text({
          frontmatter: page.frontmatter,
          body,
          source: sourceOf(seg),
          ...(partial ? { truncated: true, total_bytes: total, offset: start, next_offset: end < total ? end : null } : {}),
        });
      },
    },
    {
      name: "memory_write_page",
      description: "Write a durable page. `type` is a filing lane with exactly two legal values: 'note' (default) and 'reference' (requires source_ref) — any other value is rejected with unknown_page_type carrying the allowed list; your own category taxonomy belongs in `metadata`, never in `type`. Writes land in your own area; target='shared' is writable by deployment packs only. Use it whenever the user explicitly asks you to remember something, or you learn a preference/fact worth carrying into later sessions; recent notes are recalled automatically at later session starts.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          // Unified memory & outputs: reference pages point at library/output
          // artifacts. type defaults to "note"; "reference" requires
          // source_ref and caps tags at five; tier is draft|stable|canonical.
          //
          // Enum, not a bare string (2026-11-15): the ledger of real calls showed
          // 20+ invented lanes — fact / experience / decision_log / round-log /
          // dutylog / patrol-board / shift_log — all rejected, one of them with a
          // whole sentence stuffed into the field. A free-text `type` invites a
          // taxonomy per post; the enum states the two lanes before the call.
          type: {
            type: "string",
            enum: ["note", "reference"],
            description: "Filing lane: 'note' (default; anything you decided or observed) or 'reference' (a pointer at an external artifact; requires source_ref). Categories go in metadata.",
          },
          tags: { type: "array", items: { type: "string" } },
          tier: { type: "string" },
          source_ref: { type: "string" },
          origin: { type: "string" },
          // Structured metadata (add-agent-memory-foundation): machine
          // addressing rides HERE, never in the title string.
          metadata: { type: "object", description: "Optional structured key/values (scalars or arrays of scalars) — the structured filter lane reads this." },
          // Explicit correction (2026-11-20). Before this the write face had NO
          // way to say "this replaces an earlier conclusion": supersedes existed
          // in the page model, the edge table, and the distill lane, but
          // appeared 0 times in this file — and MCP is the ONLY way a session
          // writes memory. Measured: 16 of 57,852 pages had ever used it, so
          // changing a conclusion three times left three pages side by side and
          // readers had no way to tell which was current.
          //
          // Values are page ids (basename minus .md — the vocabulary
          // superseded_edges already speaks), NOT paths: a path changes when a
          // page is rewritten, an id does not. Superseded pages stay readable
          // through read_page/history; they simply stop being current.
          supersedes: {
            type: "array",
            items: { type: "string" },
            description: "Page ids this page replaces (the `page` field returned when the old page was written, or a path's basename without .md). Those pages leave the injection and digest faces but remain readable via read_page. Unknown ids are ignored rather than rejected, so a typo never blocks the write.",
          },
          ...targetProps,
        },
        required: ["title", "body"],
      },
      handler: (args) => {
        const w = writeProject(args.target);
        if (w.error) return w.error;
        const type = String(args.type ?? "note");
        const dir = type === "reference" ? "references" : type === "note" ? "notes" : null;
        if (!dir) return err(`unknown_page_type: ${type}`, {
          allowed: ["note", "reference"],
          hint: "type is a filing lane, not a category. Use 'note' for anything you decided or observed, or 'reference' (with source_ref) for a pointer at an external artifact; put your own taxonomy in metadata.",
        });
        const meta = normalizeMetadata(args.metadata);
        if (meta === null) return err("invalid_metadata", { reason: "metadata must be an object of scalar/array-of-scalar values" });
        const extra: Record<string, unknown> = {};
        if (meta && Object.keys(meta).length > 0) extra.metadata = meta;
        if (type === "reference") {
          const sourceRef = String(args.source_ref ?? "").trim();
          if (!sourceRef) return err("reference_requires_source_ref");
          extra.source_ref = sourceRef;
          if (Array.isArray(args.tags)) extra.tags = args.tags.map(String).slice(0, 5);
          const tier = String(args.tier ?? "draft");
          if (["draft", "stable", "canonical"].includes(tier)) extra.tier = tier;
          if (args.origin) extra.origin = String(args.origin);
        }
        // Explicit correction rides the page model's existing `supersedes`
        // frontmatter key, so the edge table and every read face pick it up
        // through the same path a distilled correction takes.
        //
        // Unknown ids are IGNORED, not rejected: a correction is a deliberate
        // act the user asked for, and failing the whole write because one id
        // was misspelled would lose the new conclusion too. The tool
        // description says so, so the behaviour is not a surprise.
        if (Array.isArray(args.supersedes)) {
          const ids = args.supersedes.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20);
          if (ids.length > 0) extra.supersedes = ids;
        }
        const rel = root.writePage(w.project!, dir, randomUUID().slice(0, 8), newPage(type, String(args.title), String(args.body), extra), auditOf(w.project!));
        notifyWrite(w.project!);
        // Domain-key hint (add-domain-memory-schema). Reported, never enforced:
        // the storage layer's standing rule is that the truth write happens
        // first and is never undone, so a missing companion key must not turn a
        // deliberate memory into a failed one. Making it visible is the point —
        // a hint nobody can see is the same as no schema at all.
        const hint = root.db.domainHintFor(meta as Record<string, unknown> | null);
        if (hint && hint.missing.length > 0) {
          return text({
            path: rel,
            source: sourceOf(w.project!),
            domain_hint: {
              domain: hint.domain,
              present: hint.present,
              missing: hint.missing,
              note: `这条记忆已按 ${hint.domain} 域保存，但缺少同域的 ${hint.missing.join(", ")}。补上之后可以按该键聚拢与召回；不补也能读，只是召回时只能按别的条件找。`,
            },
          });
        }
        return text({ path: rel, source: sourceOf(w.project!) });
      },
    },
    {
      name: "memory_by_domain",
      description:
        "Recall everything filed under a domain value — the instrument, party, case number, supplier or SKU — WITHOUT knowing which metadata key the writer used. " +
        "Answers 'what do we have on this thing' directly: pass the value you already have (a ticker, a party name) and it finds which domain key carries it, then returns those pages. " +
        "If the value matches more than one domain key, all of them are reported rather than one being guessed. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string", description: "The domain value to look up, e.g. a ticker '600519' or a party name." },
          limit: { type: "number", description: `Max pages to return (default ${DOMAIN_LOOKUP_LIMIT}).` },
          // Composable with the same filter shape the other read tools take
          // (add-domain-memory-schema: "MUST 与既有的 project、时间窗口、类型等
          // 过滤条件可组合"). Without it a caller could not ask "this
          // instrument, since the last review, notes only" — the spec requires
          // the three conditions to intersect rather than one being ignored.
          filter: FILTER_SCHEMA,
          ...targetProps,
        },
        required: ["value"],
      },
      handler: (args) => {
        const r = readProjects(args.target);
        if (r.error) return r.error;
        const value = String(args.value ?? "").trim();
        if (!value) return err("missing_domain_value", { hint: "pass the value you want to look up, e.g. a ticker or a party name" });
        const cap = Math.min(clampListLimit(args.limit), DOMAIN_LOOKUP_LIMIT);
        const matches = root.db.domainKeysForValue(value, r.projects);
        if (matches.length === 0) {
          return text({
            value, matches: [], pages: [],
            note: "没有任何领域键带这个值。可能是没人按领域记过，或值拼写不同（例如带交易所前缀）。",
          });
        }
        // Query each matching key separately and merge, so a value that is both
        // a party and a case number returns both sets instead of whichever key
        // happened to be checked first.
        const seen = new Set<string>();
        const pages: Array<Record<string, unknown>> = [];
        // `projects: null` means "no partition restriction" (a person token owns
        // its whole root) — it is not an empty list. Passing JSON.stringify(null)
        // into json_each yields the single value "null", which matches no row,
        // so the lookup silently returned nothing for exactly the callers who
        // have the broadest access.
        const projectClause = r.projects ? "AND project IN (SELECT value FROM json_each(?))" : "";
        // Composable filters (add-domain-memory-schema). Reuses the same
        // readFilter the other read faces take, so the three conditions
        // INTERSECT — a caller asking "instrument X, since last week, notes
        // only" gets the intersection, never just one of them.
        const f = readFilter(args);
        if (f.error) return f.error;
        const extra = pageFilterSql(f.filter, null, "project", "updated_at", "type");
        for (const m of matches) {
          const args: unknown[] = [];
          if (r.projects) args.push(JSON.stringify(r.projects));
          args.push(`$."${m.key}"`, value, ...(extra.args as unknown[]), cap);
          const rows = root.db.db
            .prepare(`SELECT path, project, type, title, updated_at FROM pages WHERE 1=1 ${projectClause} AND json_extract(metadata, ?) = ?${extra.clause} ORDER BY updated_at DESC LIMIT ?`)
            .all(...(args as never[])) as Array<{ path: string; project: string; type: string; title: string; updated_at: string }>;
          for (const row of rows) {
            if (seen.has(row.path)) continue;
            seen.add(row.path);
            pages.push({ ...row, domain: m.domain, domain_key: m.key, source: sourceOf(row.project) });
          }
        }
        pages.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        return text({
          value,
          matches,
          total: pages.length,
          truncated: pages.length > cap,
          pages: pages.slice(0, cap),
        });
      },
    },
    {
      name: "memory_overview",
      description:
        "A self-awareness snapshot of YOUR memory: which partitions your grants can reach, how many pages each holds, and the most recent titles. " +
        `Read-only, hard-capped (${OVERVIEW_PARTITIONS} partitions, ${OVERVIEW_TITLES} recent titles each) — it is a compass, not a bulk export. ` +
        "total_partitions / truncated say whether anything was left out.",
      inputSchema: {
        type: "object",
        properties: {
          recent: { type: "number", description: `Recent titles per partition (default ${OVERVIEW_TITLES}, cap ${OVERVIEW_TITLES}).` },
        },
      },
      handler: (args) => {
        // Cap the page, not just the partition count (fix-memory-overview-cost):
        // the old guard was `truncated: partitions.length >= 50`, so a root with
        // 40 partitions × 10 titles each reported truncated=false while shipping
        // megabytes — measured at 2.2MB on the deployment. Both dimensions are
        // now bounded and both are stated.
        const recent = Math.min(OVERVIEW_TITLES, Math.max(1, Number(args.recent ?? OVERVIEW_TITLES) || OVERVIEW_TITLES));
        // Same source of truth as the read faces: readProjects' union for
        // deploy tokens, the whole root for persons (their grant covers it),
        // shared-only for pods. Oversight partitions ride separately, tagged.
        let partitions: Array<{ project: string; source: "own" | "shared" | "owner" | string; pages: number; last_write: string | null; recent: Array<{ path: string; title: string; updated_at: string; layer: string }> }>;
        if (scope.kind === "person") {
          const stats = root.db.projectStats();
          partitions = stats.map((s) => ({
            project: s.project, source: "owner", pages: Number(s.pages), last_write: s.last_write,
            recent: root.db.recentPages(recent, [s.project]).map((p) => ({ path: p.path, title: p.title, updated_at: p.updated_at, layer: layerOf(p.type) })),
          }));
        } else {
          const r = readProjects(undefined);
          if (r.error) return r.error;
          partitions = (r.projects ?? []).map((project) => {
            const s = root.db.projectStats([project])[0] ?? { project, pages: 0, last_write: null };
            return {
              project, source: sourceOf(project), pages: Number(s.pages), last_write: s.last_write,
              recent: root.db.recentPages(recent, [project]).map((p) => ({ path: p.path, title: p.title, updated_at: p.updated_at, layer: layerOf(p.type) })),
            };
          });
        }
        const total = partitions.length;
        const shown = partitions.slice(0, OVERVIEW_PARTITIONS);
        return text({
          kind: scope.kind,
          partitions: shown,
          total_partitions: total,
          // Honest on BOTH dimensions: more partitions than the cap, or any
          // partition whose title list was itself clipped.
          // A partition with 100 pages and 3 listed titles IS truncated — the
          // old rule only looked at the partition count and called that page
          // complete.
          truncated: total > shown.length || shown.some((p) => p.pages > p.recent.length),
        });
      },
    },
  ];
}

// `memory_write_page` is intentionally excluded from the seven-tool v1 wire
// face (spec: seven tools) — page writes flow through capture/handoff. Kept
// here as an internal helper for the HTTP write face used by consolidation
// tooling later.
export function writeNotePage(root: StoreRoot, project: string, title: string, body: string, metadata?: Record<string, unknown>): string {
  const extra: Record<string, unknown> = {};
  if (metadata && Object.keys(metadata).length > 0) extra.metadata = metadata;
  return root.writePage(project, "notes", randomUUID().slice(0, 8), newPage("note", title, body, extra));
}

export { rootKeyForNamespace };
