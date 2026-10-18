// fd-memory entry: `serve` (default), `token mint|list|revoke`, `reindex`.

import { Service } from "./http.js";
import { TokenStore } from "./auth.js";
import { mkdirSync } from "node:fs";

function dataDir(): string {
  return process.env.FD_MEMORY_DATA ?? process.env.HOME + "/Library/Application Support/fd-memory";
}

function pepper(): string {
  return process.env.FD_MEMORY_PEPPER ?? "fd-memory-dev-pepper";
}

const cmd = process.argv[2] ?? "serve";

if (cmd === "--help" || cmd === "help") {
  console.log(`fd-memory — fleet working-memory service
usage:
  fd-memory serve [--port N]        start the HTTP service (default)
  fd-memory token mint --kind deployment|person --namespace <ns> [--label L]
  fd-memory token list
  fd-memory token revoke --id <id>
env:
  FD_MEMORY_DATA     data directory (default ~/Library/Application Support/fd-memory)
  FD_MEMORY_PEPPER   token hash pepper (set this in production)
  FD_MEMORY_PORT     listen port (default 49375)`);
  process.exit(0);
}

mkdirSync(dataDir(), { recursive: true });

if (cmd === "serve") {
  const port = Number(process.env.FD_MEMORY_PORT ?? argValue("--port") ?? 49375);
  new Service({ dataDir: dataDir(), port, pepper: pepper() }).listen();
} else if (cmd === "token") {
  const store = new TokenStore(dataDir() + "/tokens.db", pepper());
  const sub = process.argv[3];
  if (sub === "mint") {
    const kind = argValue("--kind") as "deployment" | "person";
    const namespace = argValue("--namespace");
    const label = argValue("--label");
    if (!kind || !namespace || !["deployment", "person"].includes(kind)) {
      console.error("usage: token mint --kind deployment|person --namespace <ns> [--label L]");
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
} else {
  console.error(`unknown command: ${cmd} (see --help)`);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
