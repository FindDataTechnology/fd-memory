// OKF v0.2-compatible markdown page layer. Markdown files are the source of
// truth; every derived index can be rebuilt from them. Unknown frontmatter
// keys are preserved verbatim on round-trip.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

export interface OkfPage {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FM_OPEN = /^---\r?\n/;
const FM_CLOSE = /\r?\n---\r?\n/;

export function parsePage(raw: string): OkfPage {
  let rest = raw;
  let fm: Record<string, unknown> = {};
  if (FM_OPEN.test(rest)) {
    rest = rest.replace(FM_OPEN, "");
    const close = rest.search(FM_CLOSE);
    if (close >= 0) {
      const fmText = rest.slice(0, close);
      rest = rest.slice(close).replace(FM_CLOSE, "");
      const parsed = yamlParse(fmText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fm = parsed as Record<string, unknown>;
      }
    }
  }
  return { frontmatter: fm, body: rest };
}

export function dumpPage(page: OkfPage): string {
  const fmText = yamlStringify(page.frontmatter, { lineWidth: 120 }).trimEnd();
  return `---\n${fmText}\n---\n${page.body}`;
}

export function readPageFile(path: string): OkfPage {
  return parsePage(readFileSync(path, "utf8"));
}

export function writePageFile(path: string, page: OkfPage): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, dumpPage(page), "utf8");
}

// Monthly hook ledger: `## [ts] event | title` lines, no frontmatter.
export function ledgerFile(projectDir: string, at = new Date()): string {
  return join(projectDir, `log-${at.toISOString().slice(0, 7)}.md`);
}

export function appendLedger(projectDir: string, event: string, title: string, at = new Date()): void {
  const line = `## [${at.toISOString()}] ${event} | ${title}\n`;
  appendFileSync(ledgerFile(projectDir, at), line, "utf8");
}

export function projectManifest(projectDir: string, name: string): void {
  const meta = join(projectDir, "_meta.md");
  if (!existsSync(meta)) {
    writePageFile(meta, {
      frontmatter: { type: "meta", title: name, generated: { by: "process:fd-memory/0.1", at: new Date().toISOString() } },
      body: `project: ${name}\n`,
    });
  }
}

export function nowStamp(): string {
  return new Date().toISOString();
}

export function newPage(type: string, title: string, body: string, extra: Record<string, unknown> = {}): OkfPage {
  return {
    frontmatter: {
      type,
      title,
      generated: { by: "process:fd-memory/0.1", at: nowStamp() },
      ...extra,
    },
    body: body.endsWith("\n") ? body : body + "\n",
  };
}
