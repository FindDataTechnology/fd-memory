// ── Memory policy: the process axis, resolved and reported honestly ──────────
//
// What this module owns and what it deliberately does not:
//
//   owns   — the `process` axis (distill / promote_after / cold_after_days) and
//            the three-column resolution an operator needs (declared,
//            inherited-from, effective) plus an `executed` flag per sub-key.
//   not    — `store` / `read` / `write`. Storage is resolved from identity, read
//            scope and budget are the platform's injection ladder, and write
//            authority is prompt discipline. Implementing them here would create
//            a second source for the same vocabulary.
//
// Why `executed` exists: a sub-key can be declared, resolve to a value, and have
// no consumer in the running version. `cold_after_days` is exactly that today.
// Reporting it as "in force" would make the declaration decoration, which is the
// failure mode this whole change is about (a declared memory scope that no host
// ever honoured).
//
// Parity discipline: the resolver is duplicated between fd-agent-graph (Python,
// offline validation) and here (TypeScript, runtime). They MUST agree, so a
// fixture is fed to both and the outputs compared (task 3.5). Change one, change
// the other.

export const DISTILL_ON = "on";
export const DISTILL_OFF = "off";
export const DISTILL_INHERIT = "inherit";
export const DISTILL_VALUES = [DISTILL_ON, DISTILL_OFF, DISTILL_INHERIT] as const;

export const PROCESS_KEYS = ["distill", "promote_after", "cold_after_days"] as const;
export type ProcessKey = (typeof PROCESS_KEYS)[number];

/**
 * Sub-keys that resolve to a value AND have a consumer in this version.
 *
 * Only `distill` is here. `promote_after` and `cold_after_days` resolve and are
 * reported as NOT executed, because this version has no data to act on them with:
 * the promotion lane selects pages by tier and cursor (there is no per-page
 * evidence counter to threshold), and there is no cold-store/eviction pass. Wiring
 * them to a nearby-looking field would produce a policy that "exists" and does
 * nothing — the exact failure this change removes.
 */
export const EXECUTED_SUBKEYS: ReadonlySet<string> = new Set(["distill"]);

/** Platform defaults. Authority has none; process defaults live here. */
export const PLATFORM_DEFAULTS: Record<ProcessKey, string | number> = {
  distill: DISTILL_ON,
  promote_after: 3,
  cold_after_days: 0,
};

export interface PolicyError {
  key: string;
  code: string;
  message: string;
}

export type PolicyDoc = Partial<Record<ProcessKey, string | number>>;

export type NormalizeResult =
  | { ok: true; doc: PolicyDoc }
  | { ok: false; errors: PolicyError[] };

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Validate + canonicalise one level's policy document.
 *
 * Only mentioned keys survive: omission is what lets the next level inherit.
 * Unknown keys are refused rather than ignored — a typo'd `distil` that silently
 * did nothing is worse than a loud rejection (same discipline as the knowledge
 * profile's closed key set).
 */
export function normalizePolicy(raw: unknown, where = "process"): NormalizeResult {
  if (raw === undefined || raw === null) return { ok: true, doc: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          key: where,
          code: "policy_invalid",
          message: `${where} must be an object of ${JSON.stringify([...PROCESS_KEYS])}`,
        },
      ],
    };
  }
  const errors: PolicyError[] = [];
  const doc: PolicyDoc = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = `${where}.${key}`;
    if (!(PROCESS_KEYS as readonly string[]).includes(key)) {
      errors.push({
        key: path,
        code: "policy_key_unknown",
        message: `${path} is not a known key (known: ${JSON.stringify([...PROCESS_KEYS])})`,
      });
      continue;
    }
    if (key === "distill") {
      if (typeof value !== "string" || !(DISTILL_VALUES as readonly string[]).includes(value)) {
        errors.push({
          key: path,
          code: "policy_distill_invalid",
          message: `${path} must be one of ${JSON.stringify([...DISTILL_VALUES])}`,
        });
        continue;
      }
      doc.distill = value;
      continue;
    }
    if (key === "promote_after") {
      if (!isInt(value) || value < 1) {
        errors.push({
          key: path,
          code: "policy_promote_after_invalid",
          message: `${path} must be an integer >= 1`,
        });
        continue;
      }
      doc.promote_after = value;
      continue;
    }
    // cold_after_days
    if (!isInt(value) || value < 0) {
      errors.push({
        key: path,
        code: "policy_cold_after_days_invalid",
        message: `${path} must be an integer >= 0 (0 = never cold-store)`,
      });
      continue;
    }
    doc.cold_after_days = value;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc };
}

export interface PolicyRow {
  declared: string | number | null;
  inherited_from: string | null;
  effective: string | number | null;
  executed: boolean;
}

export type PolicyRowMap = Record<ProcessKey, PolicyRow>;

/**
 * Resolve the inheritance chain into one row per sub-key.
 *
 * `levels` is most-specific first, each `[label, doc]` — typically
 * `[["project", p], ["root", r]]`; the deployment default closes the chain, so
 * `deploymentDefault` plays the part of the author-side "platform default".
 */
export function resolvePolicy(
  levels: Array<[string, PolicyDoc]>,
  deploymentDefault: Partial<Record<ProcessKey, string | number>> = {},
): PolicyRowMap {
  const out = {} as PolicyRowMap;
  for (const key of PROCESS_KEYS) {
    let declared: string | number | null = null;
    for (const [, doc] of levels) {
      if (doc[key] !== undefined) {
        declared = doc[key] as string | number;
        break;
      }
    }
    let effective: string | number | null = null;
    let source: string | null = null;
    for (const [label, doc] of levels) {
      const value = doc[key];
      // `inherit` is not a value — it is an instruction to keep looking upward.
      if (value === undefined || (key === "distill" && value === DISTILL_INHERIT)) continue;
      effective = value as string | number;
      source = label;
      break;
    }
    if (effective === null) {
      // Two labels, on purpose: "deployment" means the deployment actually
      // expressed an opinion (an env switch, a fleet default), "platform" means
      // nobody did and the built-in default applies. Collapsing them would hide
      // which layer an operator can change.
      if (deploymentDefault[key] !== undefined) {
        effective = deploymentDefault[key] as string | number;
        source = "deployment";
      } else if (PLATFORM_DEFAULTS[key] !== undefined) {
        effective = PLATFORM_DEFAULTS[key];
        source = "platform";
      }
    }
    out[key] = {
      declared,
      inherited_from: source,
      effective,
      executed: EXECUTED_SUBKEYS.has(key),
    };
  }
  return out;
}

/** Effective distill switch for one project, with the deployment default closing the chain. */
export function distillEnabled(
  levels: Array<[string, PolicyDoc]>,
  deploymentDefault: Partial<Record<ProcessKey, string | number>> = {},
): boolean {
  return resolvePolicy(levels, deploymentDefault).distill.effective !== DISTILL_OFF;
}

/**
 * Sub-keys someone DECLARED that no consumer will act on.
 *
 * Filtered to declared values on purpose: the per-row `executed` flag already
 * tells the truth about every key, including ones that resolve from a default.
 * This list is the actionable subset — "you asked for this and nothing does it" —
 * so it stays empty until someone declares something the version cannot honour.
 */
export function unexecuted(rows: PolicyRowMap): ProcessKey[] {
  return PROCESS_KEYS.filter(
    (k) => rows[k].declared !== null && !rows[k].executed,
  );
}

/**
 * The deployment's own opinion, demoted to "a default value source".
 *
 * Before this change `FD_MEMORY_DISTILL_U=0` was the ONLY way to switch
 * distillation for a root family, which meant a team that wanted it on could not
 * say so and a team that wanted it off had to ask an operator. Now it closes the
 * inheritance chain instead: an explicit declaration at any level wins, and the
 * env var only fills the levels nobody declared.
 *
 * Kept here (not in the scheduler and again in the HTTP face) so the two cannot
 * disagree about what "no declaration" means — that disagreement is exactly how a
 * policy face starts reporting a value the worker does not use.
 */
export function deploymentDefaults(
  rootKey: string,
  env: NodeJS.ProcessEnv | undefined,
): Partial<Record<ProcessKey, string | number>> {
  const uOptOut = String(env?.FD_MEMORY_DISTILL_U ?? "") === "0";
  // u/ (person) roots are the ones the operator switch exists for; fleet roots
  // have always distilled, and the switch never applied to them.
  const distill = rootKey.startsWith("u-") && uOptOut ? DISTILL_OFF : DISTILL_ON;
  return { distill };
}

