# PRODUCT.md

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

**永忆（YongYi，fd-memory）** serves two audiences: (1) the agent runtime developers who run LLM agents and multi-agent crews (debugger, team lead, architect) — they need an agent to come back from a session break without re-deriving the background, and to run many agents with a shared ownership boundary rather than a single chat pod's private state; (2) the platform operators who want to ship agents-as-a-service reliably — they need working memory that is a service, observable, tokenized per owner, not a pile of JSON files next to the chat server. Our product home is FindData Technology (寻数科技) internal platform since 2026-10; the open-source product home is the public user who ships agents on any runtime.

## Product Purpose

YongYi is a durable memory service for agentic platforms: everything an agent has learned — notes, handoffs, facts, experiences — becomes layered, self-distilling knowledge that the next turn can query and run as code. It treats long-term memory like gravity: not a feature added to the session layer, but a different layer entirely (L0 observations → L1 handoffs/notes → L2 facts/experiences → L3 profiles roadmap). Success means an agent never starts cold, a fleet never repeats the same round's reasoning, and memory is infrastructure you can query, constrain, budget, and audit rather than hope for.

## Positioning

Not a vector store (raw recall never sees the session file), and not a chat framework (sessions come and go; memory lives on). The outputs are digest blocks that go straight into an agent's prompt, with evidence: working-memory pages, superseded leads, handoff claim rates, distillation spend, and rung-by-rung quality. Ship it cheaply: one process, no external dependencies, one SQLite, and degrades to keyword recall when the vector lane is down instead of failing.

## Operating Context

- **Product type:** long-term working-memory service, agentic infrastructure (not a consumer assistant, not a data lake)
- **Run modes:** single-process Node service (`fd-memory serve`), all layers included; optional Python/LLM sidecar for hybrid retrieval/distillation
- **Fundamentals:** markdown truth wiki + derived SQLite indexes; token authority by family (runner / platform / person / deployment/pod); root isolation per owner; supersede-aware L2; echo dedup; full-scan vector + field-weighted keyword recall; dual-dimension notes
- **Built on it (internal):** agent work platform, IM bridge, cluster and cron engine, agent sessions — deployer-side context, not part of the OSS surface
- **Design home:** Chinese-first. zh-CN leads every surface; en is readable but secondary, never the lead.
- **Packaging reality:** multi-root memory per user/agent/pack; a public OSS build path exists (`Dockerfile` + `npm pack`; decided 2026-10-26 the public package name is `@finddatatechnology/yongyi`).

## Capabilities and Constraints

Confirmed capabilities: four-layer memory with digest render discipline (budget hard cap, handoffs notification segment, gist-shaped lines, title caps and prefix coalescing); full-scan vector recall beyond keyword-candidate gates (semantic-only hits are now reachable); field-weighted keyword recall (title ×3 / search_keys ×2 / body ×1); dual-dimension note recall (query-related top-3 + recency top-5); write-trigger distillation (note/handoff marks a project pending, ~1–2 min cadence); echo dedup (new L2 with the same 16-char prefix supersedes stale variants, files kept for audit); supersede-aware L2 read faces; chat-injection ladders (three-level digest, titles fallback, cell-first control); internal embed deadlines with serial gating and adaptive cooldown; operational metrics surface at `/admin/metrics`; OpenSpec-governed reads/writes (`token mint/list/revoke`, person/deployment/platform; credentials never in plaintext, browsers never see rootKey).

Confirmed constraints:

- **Chinese-first.** zh-CN leads every design, package name, and message; en follows, never the other way round.
- **No token, internal IP, or secrets in src/ or output.** The service runs on markdown truth plus derived SQLite only.
- **Degrade-open everywhere it can fail** — keyword lane for embeds, no read face ever 5xxs for a lane scream; anything graceful wins first.
- **Never claims shipping capability or facts it doesn't produce**: no prices, no benchmarks, no production customers' faces absent from spec.

## Brand Commitments

Name canon: **永忆（YongYi）** — owner choice on 2026-10-26 as fd-memory's public brand. Package name corrected to `@finddatatechnology/yongyi` on 2026-10-27 (publish org follows the owner's npm account, not the runtime scope). `fd-memory` stays as the internal code root and Docker image during transition; public surfaces use 永忆 first. License MIT. Typeface/identity are new (no reuse of deployer-side identity assets).

## Evidence on Hand

- Working product in production: digest face, MCP faces, write-trigger distillation, echo dedup, supersede-aware read faces, full-scan vector retrieval, field-weighted keywords — live behind metrics at `/admin/metrics`.
- Documentation: `README.md` + MIT license, `docs/DEPLOYMENT.md` (self-hosting tutorial), `docs/eval-continue.md` (eval runbook, headroom win 100%), `docs/federation-recipe.md`, `docs/spike-hook-wire.md`.
- Specification: `openspec/changes/` + `openspec/specs/` (fleet-memory, memory-distiller, memory-federation, chat-memory, memory-eval) — binding requirements with scenario-level acceptance.
- Tests: 70+ units + production witnesses in `src/test/` and `scripts/`.
- Absences the build must not invent: no logo yet, no product screenshots of the website, no press voices, no prices, no benchmarked endpoints.
