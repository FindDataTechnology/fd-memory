// Static pre-storage redaction (four classes, aligned with the ai-memory
// upstream scrubber family). Best-effort by contract — callers still avoid
// feeding credential-shaped content when they can.

const PEM_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{30,}|xox[bp]-[A-Za-z0-9-]{10,}|fdm_[A-Za-z0-9]{32,}|wgk--[A-Za-z0-9-]{16,})\b/g;
const BEARER = /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g;
const LABELED_SECRET = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|token)\b["'\s:=]{1,3}["']?([A-Za-z0-9._~+/=-]{6,})/gi;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

export function sanitize(text: string): string {
  if (!text) return text;
  let out = text.replace(BIDI, "\uFFFD");
  out = out.replace(PEM_BLOCK, "[REDACTED PRIVATE KEY]");
  out = out.replace(KNOWN_TOKEN, "[REDACTED CREDENTIAL]");
  out = out.replace(BEARER, "bearer [REDACTED]");
  out = out.replace(LABELED_SECRET, (_m, label: string) => `${label}=[REDACTED]`);
  return out;
}

// ATX headings at line start. Fenced code is NOT special-cased: a `# ` line
// inside a fence still reads as a heading to every Markdown parser, so leaving
// it would keep the ambiguity this exists to remove.
const ATX_HEADING = /^#{1,6}[ \t]+/gm;

/**
 * Neutralise model-authored document structure inside a FIELD (R1 of
 * distill-output-contract). The page's own skeleton \u2014 `## Statement`,
 * `## Solution` \u2014 is written by the renderer; a field that carries `##` of its
 * own either collides with those sections or invents new ones, and the read
 * faces that split on headings then mis-slice the page.
 *
 * Demotion, not rejection: a model formatting a solution with headings is
 * still telling us something true, and refusing the whole memory over
 * presentation would lose it. The text is kept verbatim; only its claim to be
 * a section is dropped.
 */
export function demoteHeadings(text: string): string {
  if (!text) return text;
  return text.replace(ATX_HEADING, "");
}
