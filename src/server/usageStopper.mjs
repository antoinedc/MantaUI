// usageStopper.mjs — the "was this conversation stopped by a plan-usage limit?"
// classifier + the pure enrolment decision. BET-1047 stage 1, box-side only.
//
// Given a failed turn's provider (a usage-engine adapter id: "claude" | "codex"
// | "kimi"), the error's name and the error's message, this answers whether the
// conversation was stopped by a subscription plan-usage limit, and — when the
// wording names one — which reset window to wait for.
//
// The refusal wordings live in ONE table, as data (STOP_STRINGS, spec §4.2), so
// adding a wording a vendor rewrote is a one-line edit. Matching is
// case-insensitive substring, against both the error name and the error message.
//
// Two signals feed the enrolment path (spec §4); this module owns the FIRST
// (the refusal match) and the pure decision that combines both. The second
// (meter correlation — provider already at its limit) is computed by the usage
// engine and passed in as a boolean.
//
// Pure. No I/O. Tests in src/server/usageStopper.test.mjs.

import { isClaudeCredentialError } from "./claudeAuth.mjs";

/**
 * @typedef {"claude"|"codex"|"kimi"} StoppedProvider
 *   The usage-engine adapter id. Only the three subscription providers are in
 *   scope (spec §3); a pay-as-you-go API-key provider never appears here.
 */

/**
 * @typedef {"session"|"weekly"|"monthly"} UsageWindowKind
 *   The reset window the refusal wording named, when it named one.
 */

/**
 * Every positive refusal wording per provider, with the window it implies.
 * The `match` is matched case-insensitively as a substring of the error's
 * name OR message. `window` is the reset window when the wording names one,
 * else null (enrol with no window — the meter correlation still lands it).
 *
 * Source: docs/usage-resume.md §4.2. Keep every wording here; do not scatter
 * refusal strings through call sites.
 *
 * @type {Record<StoppedProvider, { positive: Array<{match:string, window:UsageWindowKind|null}>, negative: string[] }>}
 */
export const STOP_STRINGS = {
  claude: {
    positive: [
      { match: "usage limit reached", window: null },
      { match: "you've hit your session limit", window: "session" },
      { match: "you've hit your weekly limit", window: "weekly" },
      { match: "you've hit your Opus limit", window: "weekly" },
    ],
    // "temporarily limiting requests" / "not your usage limit" are throttles or
    // explicit denials; "usage credits are required" is a credit/overage refusal
    // (spec §4.1) — none is a plan window, none may enrol.
    negative: [
      "temporarily limiting requests",
      "not your usage limit",
      "usage credits are required",
    ],
  },
  // Codex is the ONLY provider with a structural marker: error type
  // `usage_limit_reached` / stream code `insufficient_quota`. The negative list
  // guards the momentary-throttle / overload wordings that share status codes.
  codex: {
    positive: [{ match: "usage_limit_reached", window: null }, { match: "insufficient_quota", window: null }],
    negative: ["rate_limit_exceeded", "server_is_overloaded", "slow_down"],
  },
  kimi: {
    positive: [
      { match: "reached your usage limit for this billing cycle", window: "weekly" },
      { match: "reached your usage limit for this period", window: "session" },
      { match: "reached kimi monthly usage limit", window: "monthly" },
    ],
    // "engine is currently overloaded" / "receiving too many requests" are
    // momentary throttle wordings; "does not have access to" is a tier-
    // entitlement denial, not quota.
    negative: [
      "engine is currently overloaded",
      "receiving too many requests",
      "does not have access to",
    ],
  },
};

const KNOWN_PROVIDERS = new Set(Object.keys(STOP_STRINGS));

// Structural "definitely NOT a plan-limit stop" error names (spec §4.1's
// "Never enrol" rows that are identifiable by name rather than wording):
// a user abort (incl. the queued-message drain abort) and a context overflow.
// Unlike the positive/negative wording table these are provider-agnostic and
// must suppress BOTH signals — a context overflow or abort that happens to
// occur while a meter reads at 100% must still not land a stopped record.
export const NON_LIMIT_ERROR_NAMES = new Set(["MessageAbortedError", "ContextOverflowError"]);

/**
 * Is a failure structurally excluded from ever being a plan-limit stop (a user
 * abort, or a context overflow)? Provider-agnostic; suppresses both signals.
 * @param {unknown} errorName
 * @returns {boolean}
 */
export function isNonLimitFailure(errorName) {
  return typeof errorName === "string" && NON_LIMIT_ERROR_NAMES.has(errorName);
}

/**
 * Is this provider one the usage-stopped feature covers? Only the three
 * subscription providers (spec §3). Anything else (a pay-as-you-go key, an
 * unlisted provider) is out of scope and never enrols.
 *
 * @param {string|undefined} provider  usage-engine adapter id
 * @returns {boolean}
 */
export function isStoppedProvider(provider) {
  return typeof provider === "string" && KNOWN_PROVIDERS.has(provider);
}

function asString(v) {
  return typeof v === "string" ? v : "";
}

/**
 * Classify a failed turn. Pure.
 *
 * @param {object} input
 * @param {string|undefined} input.provider       usage-engine adapter id ("claude"|"codex"|"kimi")
 * @param {unknown} [input.errorName]             the typed error name (e.g. `usage_limit_reached`, `ApiError`)
 * @param {unknown} [input.errorMessage]          the human/immediate error message (spec §4.2 "body")
 * @param {unknown} [input.error]                 the full error object, when available (used to reuse the
 *                                                existing auth-error predicate for exclusion)
 * @returns {{ enrolled: false } | { enrolled: true, window: UsageWindowKind|null }}
 */
export function classifyUsageStopped({ provider, errorName, errorMessage, error }) {
  // Unknown provider → out of scope by construction (spec §3).
  if (!isStoppedProvider(provider)) return { enrolled: false };

  const name = asString(errorName).toLowerCase();
  const msg = asString(errorMessage).toLowerCase();

  // A user abort or a context overflow is structurally never a plan-limit stop,
  // by name — suppress the match signal here too (defense in depth; the
  // enrolment path additionally skips these before the meter correlation runs).
  if (isNonLimitFailure(errorName)) return { enrolled: false };

  // Auth/credential failures must NEVER enrol. Reuse the existing auth-error
  // predicate rather than writing a second one (spec §4.1, issue Build §1).
  // It only matches Claude credential errors and returns false harmlessly for
  // everything else.
  if (isClaudeCredentialError(error ?? { name: errorName, data: { message: errorMessage } })) {
    return { enrolled: false };
  }

  const hay = name + "\n" + msg;
  const table = STOP_STRINGS[provider];

  // The negative list is as load-bearing as the positive one — momentary
  // throttles / overload / tier / credit refusals share tokens and status codes
  // with real limits and must never enrol. A negative always wins.
  for (const neg of table.negative) {
    if (hay.includes(neg)) return { enrolled: false };
  }

  for (const entry of table.positive) {
    if (hay.includes(String(entry.match).toLowerCase())) {
      return { enrolled: true, window: entry.window };
    }
  }

  return { enrolled: false };
}

/**
 * Is a provider's usage already at its limit? Pure — used by the meter-
 * correlation signal (spec §4 signal 2). Accepts an array of normalised
 * UsageWindow (from the usage engine / an adapter fetch).
 *
 * "At its limit" = any window is exhausted: percentage at/over 100, or the
 * absolute used count at/over the limit.
 *
 * @param {Array<{pct?:number, used?:number, limit?:number}>|undefined} windows
 * @returns {boolean}
 */
export function isUsageAtLimit(windows) {
  if (!Array.isArray(windows)) return false;
  return windows.some(
    (w) =>
      (typeof w?.pct === "number" && w.pct >= 100) ||
      (typeof w?.used === "number" && typeof w?.limit === "number" && w.limit > 0 && w.used >= w.limit),
  );
}

/**
 * The pure enrolment decision (spec §4): EITHER signal enrols. They fail in
 * opposite directions — the match is precise but only knows seen wordings; the
 * correlation is fuzzy but catches everything.
 *
 * @param {object} input
 * @param {{enrolled:boolean, window:UsageWindowKind|null}} input.match   classifier result
 * @param {boolean} input.atLimit                                           provider's meter re-checked on the failure
 * @returns {{ enrol: false } | { enrol: true, window: UsageWindowKind|null }}
 */
export function decideUsageEnrolment({ match, atLimit }) {
  if (match?.enrolled || atLimit) {
    return { enrol: true, window: match?.enrolled ? match.window : null };
  }
  return { enrol: false };
}
