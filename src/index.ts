#!/usr/bin/env node
// YongYi entry: `serve` (default), `token mint|list|revoke`, `reindex`,
// `connect|disconnect|hook` (add-yongyi-complete-solution).

import { Service } from "./http.js";
import { TokenStore } from "./auth.js";
import { StoreRoot } from "./store.js";
import { runConnect, runDisconnect, runHook } from "./connect/cli.js";
import { mkdirSync } from "node:fs";

function dataDir(): string {
  return process.env.FD_MEMORY_DATA ?? process.env.HOME + "/Library/Application Support/fd-memory";
}

function pepper(): string {
  return process.env.FD_MEMORY_PEPPER ?? "fd-memory-dev-pepper";
}

const cmd = process.argv[2] ?? "serve";

if (cmd === "--help" || cmd === "help") {
  console.log(`yongyi (永忆) — long-term working-memory service
usage:
  yongyi serve [--port N]        start the HTTP service (default)
  yongyi token mint --kind deployment|person|runner|platform --namespace <ns|*> [--label L]
  yongyi token list
  yongyi token revoke --id <id>
  yongyi connect claude-code|zcode|mcp|dify|coze --url U --as user [--project P] [--dir D]
  yongyi disconnect <harness>
  yongyi hook <harness> <event>      stdin: hook event JSON (capture, fail-drop)
  yongyi replay --root <rootKey>     rebuild observations index from the append-only log
  yongyi import claude-code|zcode|summary --root <rootKey> [--project P] [--dry-run] [--batch N] [--profile light|full] [--yes]
  yongyi import-retract --root <rootKey> --harness <claude-code|zcode|summary> [--dry-run]
  yongyi index --root <rootKey> [--project P]   sync cross-harness memory index
  yongyi deliver --root <rootKey> --project P --file <instructionFile> [--off] [--limit N]
env:
  FD_MEMORY_DATA     data directory (default ~/Library/Application Support/fd-memory)
  FD_MEMORY_PEPPER   token hash pepper (set this in production)
  FD_MEMORY_PORT     listen port (default 49375)
  FD_MEMORY_HOST     bind host (default 127.0.0.1; containers set 0.0.0.0)`);
  process.exit(0);
}

mkdirSync(dataDir(), { recursive: true });

if (cmd === "serve") {
  const port = Number(process.env.FD_MEMORY_PORT ?? argValue("--port") ?? 49375);
  new Service({ dataDir: dataDir(), port, host: process.env.FD_MEMORY_HOST ?? "127.0.0.1", pepper: pepper() }).listen();
} else if (cmd === "token") {
  const store = new TokenStore(dataDir() + "/tokens.db", pepper());
  const sub = process.argv[3];
  if (sub === "mint") {
    const kind = argValue("--kind") as "deployment" | "person" | "runner" | "platform";
    const namespace = argValue("--namespace");
    const label = argValue("--label");
    if (!kind || !namespace || !["deployment", "person", "runner", "platform"].includes(kind)) {
      console.error("usage: token mint --kind deployment|person|runner|platform --namespace <ns|*> [--label L]");
      process.exit(2);
    }
    if (kind === "deployment" && !namespace.startsWith("d/")) {
      console.error("deployment tokens must bind a d/<packId>/<agentId> namespace");
      process.exit(2);
    }
    if (kind === "person" && !namespace.startsWith("u/")) {
      console.error("person tokens must bind a u/<user> namespace");
      process.exit(2);
    }
    if (kind === "runner" && namespace !== "*") {
      console.error("runner tokens use --namespace * (capture-only, any d/ target)");
      process.exit(2);
    }
    if (kind === "platform" && namespace !== "*") {
      console.error("platform tokens use --namespace * (minting-only, mints u/ person tokens)");
      process.exit(2);
    }
    const out = store.mint(kind, namespace, label);
    console.log(JSON.stringify(out, null, 1));
  } else if (sub === "list") {
    console.log(JSON.stringify(store.list(), null, 1));
  } else if (sub === "revoke") {
    const id = argValue("--id");
    if (!id) { console.error("usage: token revoke --id <id>"); process.exit(2); }
    console.log(JSON.stringify({ revoked: store.revoke(id) }));
  } else {
    console.error("token subcommand: mint|list|revoke");
    process.exit(2);
  }
} else if (cmd === "replay") {
  // Rebuild the observations index from the append-only JSONL truth. This is
  // the recovery path for "the SQLite index was lost / went out of sync" —
  // the log under <project>/observations/_log/ is the source of record.
  const rootKey = argValue("--root");
  if (!rootKey) {
    console.error("usage: yongyi replay --root <rootKey>");
    console.error("  rebuilds the observations index from <wiki>/<project>/observations/_log/*.jsonl");
    process.exit(2);
  }
  const root = new StoreRoot(dataDir(), rootKey);
  const out = root.db.replayObservationsFromLog(root.wikiDir);
  console.log(JSON.stringify({ rootKey, logFiles: out.projects, rows: out.rows }));
} else if (cmd === "import") {
  // Import historical memory from an AI harness's local storage.
  //   yongyi import claude-code --root <rootKey> [--project P] [--dry-run]
  //                             [--dir <projectsDir>] [--batch N] [--pause MS]
  const harness = process.argv[3];
  if (harness !== "claude-code" && harness !== "zcode" && harness !== "summary") {
    console.error("usage: yongyi import claude-code|zcode|summary --root <rootKey> [--project P] [--dry-run]");
    console.error("  summary = harness's distilled memory layer (memories/**.md)");
    console.error("  (Cursor / Codex extractors are not implemented yet)");
    process.exit(2);
  }
  const rootKey = argValue("--root");
  if (!rootKey) {
    console.error(`usage: yongyi import ${harness} --root <rootKey> [--project P] [--dry-run]`);
    process.exit(2);
  }
  const project = argValue("--project") ?? "default";
  const dryRun = process.argv.includes("--dry-run");
  // Profile gate (add-harness-memory-import 2.3): `full` is the "不过滤" mode
  // the spec refuses to run silently — it turns every extracted turn into a
  // candidate, so on an 84 万-row source it would recreate the lock outage the
  // whole import design exists to avoid. Unconfirmed, it is refused WITH an
  // estimate of what it would write; --yes is the explicit confirmation.
  const profileArg = argValue("--profile") ?? "light";
  if (profileArg !== "light" && profileArg !== "full") {
    console.error("--profile must be light (rule-filtered, default) or full (unfiltered, requires --yes)");
    process.exit(2);
  }
  const profile = profileArg as "light" | "full";
  const yes = process.argv.includes("--yes");
  const batchSize = Number(argValue("--batch") ?? 200);
  const batchPauseMs = Number(argValue("--pause") ?? 200);
  const limitArg = argValue("--limit");
  const limit = limitArg ? Number(limitArg) : undefined;

  const projectsDir = argValue("--dir") ?? process.env.HOME + "/.claude/projects";
  const memoryRoot = argValue("--memory-root") ?? process.env.HOME + "/.zcode/cli/memories/projects/finddata-e7fc7cd97a773655/memory";
  const dbPath = argValue("--db") ?? process.env.HOME + "/.zcode/cli/db/db.sqlite";

  const root = new StoreRoot(dataDir(), rootKey);
  import("./connect/import/orchestrator.js")
    .then(async (m) => {
      const rules = m.rulesForProfile(profile);

      // Full profile without confirmation: refuse with an estimate, computing
      // it WITHOUT stamping the source ledger (a refusal must leave no state
      // that changes what the confirmed rerun would do).
      if (m.fullProfileNeedsConfirmation(profile, yes) && !dryRun) {
        const est =
          harness === "summary"
            ? m.planSummaryImport(root, { memoryRoot, project, stamp: false })
            : harness === "zcode"
              ? m.planZcodeImport(root, { dbPath, limit, project, rules, stamp: false })
              : m.planClaudeImport(root, { projectsDir, project, rules, stamp: false });
        console.log(
          JSON.stringify(
            {
              refused: "profile full writes every extracted turn — pass --yes to confirm",
              profile,
              harness,
              scanned: est.scanned,
              filtered: est.filtered,
              alreadyImported: est.alreadyImported,
              duplicateContent: est.duplicateContent,
              estimatedWrites: est.estimatedWrites,
              hint: "preview with --dry-run, or re-run with --yes to execute",
            },
            null,
            1,
          ),
        );
        console.error(
          `拒绝：--profile full 不过滤，将全量写入约 ${est.estimatedWrites} 条（扫描 ${est.scanned.turns} 条）。确认执行请显式加 --yes。`,
        );
        process.exit(1);
      }

      const plan =
        harness === "summary"
          ? m.planSummaryImport(root, { memoryRoot, project })
          : harness === "zcode"
            ? m.planZcodeImport(root, { dbPath, limit, project, rules })
            : m.planClaudeImport(root, { projectsDir, project, rules });

      if (dryRun) {
        console.log(JSON.stringify(plan, null, 1));
        console.log("\n(dry run — nothing written)");
        return;
      }

      const res =
        harness === "summary"
          ? await m.runSummaryImport(root, project, { memoryRoot, batchSize, batchPauseMs, project })
          : harness === "zcode"
            ? await m.runZcodeImport(root, project, { dbPath, limit, batchSize, batchPauseMs, project, rules })
            : await m.runClaudeImport(root, project, { projectsDir, batchSize, batchPauseMs, project, rules });
      console.log(
        JSON.stringify(
          {
            harness: res.plan.harness,
            scanned: res.plan.scanned,
            filtered: res.plan.filtered,
            alreadyImported: res.plan.alreadyImported,
            duplicateContent: res.plan.duplicateContent,
            written: res.written,
            degraded: res.degraded,
            batches: res.batches,
          },
          null,
          1,
        ),
      );
    })
    .catch((e: unknown) => fail(e));
} else if (cmd === "import-retract") {
  // Take back everything one harness imported, and nothing else.
  //   yongyi import-retract --root <rootKey> --harness <claude-code|zcode|summary> [--dry-run]
  //
  // Why a sibling command instead of `import <harness> --retract`: the import
  // branch resolves a source, a profile and a plan before it writes anything, and
  // retract has none of those inputs — bolting it on would make every one of them
  // optional-in-one-direction and ambiguous. The two acts share a write path
  // (StoreRoot.retractObservations), which is where the sharing belongs.
  const rk = argValue("--root");
  const target = argValue("--harness");
  if (!rk || !target) {
    console.error("usage: yongyi import-retract --root <rootKey> --harness <claude-code|zcode|summary> [--dry-run]");
    console.error("  withdraws every page and observation that harness imported; source files are never touched");
    process.exit(2);
  }
  const retractRoot = new StoreRoot(dataDir(), rk);
  import("./connect/import/retract.js")
    .then((m) => {
      const report = m.retractHarness(retractRoot, {
        harness: target,
        dryRun: process.argv.includes("--dry-run"),
      });
      console.log(JSON.stringify(report, null, 1));
      if (report.dryRun) console.error("(dry run — nothing written)");
    })
    .catch((e: unknown) => fail(e));
} else if (cmd === "index") {
  // Sync the cross-harness memory index (see MEMORY-ARCHITECTURE.md).
  //   yongyi index --root <rootKey> [--project P]
  // Reads every harness's own memory files (ZCode / Claude Code), stores only
  // their descriptions here, and leaves the bodies at their source. Incremental
  // by content hash, so a scheduled run costs ~0.1 s when nothing changed.
  const rootKey = argValue("--root");
  if (!rootKey) {
    console.error("usage: yongyi index --root <rootKey> [--project P]");
    process.exit(2);
  }
  const project = argValue("--project") ?? "default";
  const root = new StoreRoot(dataDir(), rootKey);
  import("./connect/index/sync.js")
    .then((m) => {
      const r = m.syncIndex(root, project);
      console.log(
        JSON.stringify(
          {
            scanned: r.scanned.indexed,
            byHarness: r.scanned.byHarness,
            written: r.written,
            unchanged: r.unchanged,
            removed: r.removed,
            descriptionTokens: Math.round(r.scanned.descriptionBytes / 3),
          },
          null,
          1,
        ),
      );
    })
    .catch((e: unknown) => fail(e));
} else if (cmd === "deliver") {
  // Put project memories where a harness already looks (managed block in its
  // instruction file). Never touches the harness's conversation store.
  //   yongyi deliver --root <rootKey> --project P --file <path> [--off] [--limit N]
  const rootKey = argValue("--root");
  const project = argValue("--project");
  const file = argValue("--file");
  if (!rootKey || !project || !file) {
    console.error("usage: yongyi deliver --root <rootKey> --project P --file <instructionFile> [--off] [--limit N] [--max-chars N]");
    console.error("  writes a managed block into a file the harness already reads");
    console.error("  (CLAUDE.md / AGENTS.md); never modifies conversation history.");
    process.exit(2);
  }
  const root = new StoreRoot(dataDir(), rootKey);
  import("./connect/import/deliver.js")
    .then((m) => {
      const res = m.deliverToTarget(
        root,
        { id: "cli", file, format: "markdown" },
        {
          project,
          off: process.argv.includes("--off"),
          limit: Number(argValue("--limit") ?? 50),
          maxChars: Number(argValue("--max-chars") ?? 8000),
        },
      );
      console.log(JSON.stringify(res, null, 1));
    })
    .catch((e: unknown) => fail(e));
} else if (cmd === "connect") {
  runConnect(process.argv.slice(3)).catch((e: unknown) => fail(e));
} else if (cmd === "disconnect") {
  try {
    runDisconnect(process.argv.slice(3));
  } catch (e) {
    fail(e);
  }
} else if (cmd === "hook") {
  runHook(process.argv.slice(3), readStdin).catch((e: unknown) => fail(e));
} else {
  console.error(`unknown command: ${cmd} (see --help)`);
  process.exit(2);
}

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
