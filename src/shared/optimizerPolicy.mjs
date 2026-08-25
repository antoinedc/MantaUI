// optimizerPolicy.mjs — the Manta Optimizer's policy resolution (BET-1343).
// PURE: no node:* imports, no Date.now(), no I/O — everything arrives as an
// argument, so the resolution order is testable without a box. This module is
// the single source of truth for the optimizer's knobs; later stages (the
// masking transformer, lambda/pacing, compaction) read the policy it resolves.
//
// Resolution order, LAST WINS:
//   1. DEFAULT_POLICY
//   2. the global config (optimizerEnabled)
//   3. the per-repo tuner table entry (maskAfterUses / batchTokens /
//      protectTailTokens only — unknown keys are ignored, never merged)
//   4. cacheTtlMs when a finite number is supplied (from the measured summary
//      TTL, never from the repo table)

export const MASK_AFTER_TOOL_USES   = 12;
export const MIN_BATCH_TOKENS       = 20_000;
export const PROTECT_TAIL_TOKENS    = 40_000;
export const PLACEHOLDER_ARGS_MAX   = 200;
export const POLICY_CACHE_MS        = 60_000;
// 2.6x the largest session ever recorded on the reference box (measured over
// opencode.db: 522 sessions, p50 85 parts, p90 359, p99 893, max 1544).
export const MAX_TRANSFORM_PARTS    = 4_000;
export const TRANSFORM_BUDGET_MS    = 25;

/** The fail-open policy: the optimizer is OFF until opted in. */
export const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  maskAfterUses: MASK_AFTER_TOOL_USES,
  batchTokens: MIN_BATCH_TOKENS,
  protectTailTokens: PROTECT_TAIL_TOKENS,
  placeholderFormat: "[manta: trimmed — re-run `{tool}` with {args} to see this again]",
  cacheTtlMs: 300_000,
  maxTransformParts: MAX_TRANSFORM_PARTS,
  transformBudgetMs: TRANSFORM_BUDGET_MS,
});

// The only keys a per-repo tuner entry may carry. Unknown keys in a repo entry
// are ignored (never merged) — the tuner's surface is deliberately narrow.
const REPO_NUMERIC_KEYS = ["maskAfterUses", "batchTokens", "protectTailTokens"];

// Coerce a knob to a positive finite number; anything else falls back to the
// given default. A declared 0 / negative / NaN / non-number is junk — treated
// as "not set", never honoured.
function coerceNum(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * PURE. Resolve the effective policy from defaults ← global config ← per-repo
 * tuner table ← measured cache TTL. Never returns null, never throws; every
 * numeric field is coerced with a DEFAULT_POLICY fallback.
 */
export function resolvePolicy({ config, repoTable, directory, cacheTtlMs } = {}) {
  const policy = { ...DEFAULT_POLICY };
  // Strict: only the literal boolean true enables the optimizer.
  policy.enabled = config?.optimizerEnabled === true;
  const repo = repoTable?.repos?.[directory];
  if (repo && typeof repo === "object" && !Array.isArray(repo)) {
    for (const key of REPO_NUMERIC_KEYS) {
      if (repo[key] !== undefined) policy[key] = coerceNum(repo[key], DEFAULT_POLICY[key]);
    }
  }
  if (typeof cacheTtlMs === "number" && Number.isFinite(cacheTtlMs) && cacheTtlMs > 0) {
    policy.cacheTtlMs = cacheTtlMs;
  }
  return policy;
}

/**
 * PURE. Normalize a raw `optimizer-policy.json` value into the repo-table
 * shape `{ repos: { "<absolute directory>": { maskAfterUses?, batchTokens?,
 * protectTailTokens? } } }`. Anything malformed degrades to `{ repos: {} }`.
 * Only positive finite numerics survive; unknown keys are dropped.
 */
export function validateRepoTable(raw) {
  const clean = { repos: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  if (!raw.repos || typeof raw.repos !== "object" || Array.isArray(raw.repos)) return clean;
  for (const [dir, entry] of Object.entries(raw.repos)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const repo = {};
    for (const key of REPO_NUMERIC_KEYS) {
      if (typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] > 0) {
        repo[key] = entry[key];
      }
    }
    clean.repos[dir] = repo;
  }
  return clean;
}

/**
 * PURE. Pick the optimizer's cache TTL from the optimizer summary's `ttl`
 * slice: prefer the measured value when the measurement is conclusive, else
 * the configured value, else the 300_000ms default. This is the ONLY way a
 * policy's cacheTtlMs is derived server-side — the route never re-measures.
 */
export function optimizerCacheTtlMs(ttl) {
  if (
    ttl &&
    ttl.confidence === "measured" &&
    typeof ttl.measuredMs === "number" &&
    Number.isFinite(ttl.measuredMs) &&
    ttl.measuredMs > 0
  ) {
    return ttl.measuredMs;
  }
  if (
    ttl &&
    typeof ttl.configuredMs === "number" &&
    Number.isFinite(ttl.configuredMs) &&
    ttl.configuredMs > 0
  ) {
    return ttl.configuredMs;
  }
  return 300_000;
}
