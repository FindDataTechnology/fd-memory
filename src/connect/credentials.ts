// Identity binding + credential storage for `yongyi connect`
// (add-yongyi-complete-solution D4, tasks 3.1).
//
// The person token NEVER lands in a harness config file: harness configs
// reference an environment variable (YONGYI_TOKEN_<HARNESS>), and the token
// itself lives in a dedicated credential file with 0600 permissions, consumed
// by `yongyi hook` at capture time. Binding is per harness so two harnesses
// bound to different identities keep routing their hooks to the right root.

import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { TokenStore } from "../auth.js";

export type Harness = "claude-code" | "zcode" | "mcp";

export interface Binding {
  url: string;
  namespace: string; // u/<user>
  token: string;
  project: string;
  bound_at: string;
}

export interface CredentialFile {
  version: 1;
  updated_at: string;
  bindings: Record<string, Binding>;
}

export interface IdentityPlan {
  namespace: string;
  token: string;
  reused: boolean; // token reused from an existing binding (no new mint)
}

export function envVarFor(harness: Harness): string {
  return "YONGYI_TOKEN_" + harness.replace(/-/g, "_").toUpperCase();
}

export function loadCredentials(path: string): CredentialFile {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialFile>;
    if (doc && typeof doc === "object" && doc.bindings && typeof doc.bindings === "object") {
      return { version: 1, updated_at: doc.updated_at ?? "", bindings: doc.bindings as Record<string, Binding> };
    }
  } catch {
    /* absent or corrupt — start fresh */
  }
  return { version: 1, updated_at: "", bindings: {} };
}

// --as <id> → mint or reuse a person token. Reuse rule: any existing binding
// holding the same u/<id> namespace lends its token (the spec scenario "同一
// 身份重复接入" — two harnesses, one person root). Otherwise mint locally via
// the same TokenStore `yongyi token mint` uses (connect is a local-CLI flow).
export function planIdentity(opts: {
  identity: string;
  harness: Harness;
  creds: CredentialFile;
  dataDir: string;
  pepper: string;
}): IdentityPlan {
  const namespace = "u/" + opts.identity;
  for (const b of Object.values(opts.creds.bindings)) {
    if (b.namespace === namespace && b.token) return { namespace, token: b.token, reused: true };
  }
  const store = new TokenStore(opts.dataDir + "/tokens.db", opts.pepper);
  const { token } = store.mint("person", namespace, `connect ${opts.harness}`);
  return { namespace, token, reused: false };
}

export function saveCredentials(path: string, creds: CredentialFile): void {
  mkdirSync(dirname(path), { recursive: true });
  creds.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // in case a pre-existing file had looser modes
}

// The source-able env file: one YONGYI_TOKEN_<HARNESS> per bound harness plus
// YONGYI_URL. Same 0600 discipline — it carries the tokens too.
export function writeEnvFile(path: string, creds: CredentialFile, url: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    "# yongyi (fd-memory) harness credentials — source this file in your shell profile.",
    "# Managed by `yongyi connect`; rewritten on every connect.",
    `export YONGYI_URL="${url}"`,
  ];
  for (const [harness, b] of Object.entries(creds.bindings)) {
    lines.push(`export ${envVarFor(harness as Harness)}="${b.token}"`);
  }
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function credentialPaths(yongyiDir: string): { creds: string; env: string } {
  return { creds: yongyiDir + "/credentials.json", env: yongyiDir + "/env" };
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
