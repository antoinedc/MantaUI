// configMigration.mjs — pure, electron-free config migrations, unit-testable
// with vitest and reusable from any context (desktop main, box server).
// Holds two unrelated one-time migrations:
//   1. migrateLegacyCapConfig  — v1 capability-executor → v2 plugins
//   2. migrateCacheTtlDefault  — the wrong "1h" prompt-cache default → "5m"
//
// Extracted from src/main/config.ts (BET-190) so the migration is its own
// source of truth and the runtime config reader stays a thin file-loader.
//
// Migration rules (BET-190 spec):
//   - empty input / null → {}
//   - capExecutorEnabled set, no pluginsEnabled → set pluginsEnabled from
//     it, drop the legacy key
//   - all three legacy keys present → set pluginsEnabled from
//     capExecutorEnabled, drop the legacy keys (the repo path + simulator
//     name are deliberately dropped — the user recreates the plugin via
//     the AI, see BET-190 §"Config" note about "user recreates via the AI
//     in one prompt")
//   - new pluginsEnabled already set → legacy keys ignored, do not
//     overwrite
//   - legacy value present AND pluginsEnabled also set → new wins
//
// The function does NOT mutate the input. It returns a NEW object the
// caller spreads into the saved config.

/**
 * @typedef {object} LegacyConfig
 * @property {boolean} [capExecutorEnabled]
 * @property {string}  [iosBuildRepoPath]
 * @property {string}  [iosSimulatorName]
 */

/**
 * @typedef {object} MigratedConfig
 * @property {boolean} [pluginsEnabled]
 */

/**
 * @param {LegacyConfig|null|undefined} raw
 * @returns {MigratedConfig}
 */
export function migrateLegacyCapConfig(raw) {
  if (raw == null || typeof raw !== "object") return {};
  const out = { ...raw };
  const legacyOn = out.capExecutorEnabled === true;
  // If pluginsEnabled is NOT set, derive it from the legacy cap flag.
  if (out.pluginsEnabled === undefined) {
    if (legacyOn) out.pluginsEnabled = true;
  }
  // Drop the legacy keys unconditionally — they no longer exist on
  // AppConfig, and silently carrying them forward would re-trigger
  // duplication after every save.
  delete out.capExecutorEnabled;
  delete out.iosBuildRepoPath;
  delete out.iosSimulatorName;
  return out;
}

// ===== cacheTtl: the "1h" default that was never true =====
//
// `cacheTtl` predicts when a session's Anthropic prompt cache has gone cold
// (it drives the SessionHeader context pill's warn state). It shipped with a
// default of "1h", which was a GUESS and is wrong: opencode's applyCaching()
// stamps its cache breakpoints `{type:"ephemeral"}` with no `ttl` field, so
// Anthropic applies its default 5-minute TTL. Measured on the wire against
// /v1/messages — a request shaped the way opencode shapes one reports
// `usage.cache_creation.ephemeral_5m_input_tokens: 4421` with
// `ephemeral_1h_input_tokens: 0`.
//
// Flipping the schema default alone does not reach an existing box: "1h" is
// PERSISTED in ~/.manta/config.json for anyone who ever reset a section (a
// reset writes every key to its then-current default) or touched the control
// while "1h" was the default. Those users would keep the wrong prediction —
// warm-looking pill, full cache re-write on the next message — forever.
//
// So this rewrites a persisted "1h" to "5m" ONCE, marked by
// `cacheTtlDefaultMigrated` so a user who deliberately re-selects "1h"
// afterwards keeps it. "1h" stays a legitimate choice for a box whose
// requests are rewritten in front of opencode; it is just never the right
// value on a stock box, which is why the one-time correction is safe.
//
// Does NOT mutate the input; returns a NEW object for the caller to persist.

/**
 * @param {Record<string, any>|null|undefined} raw
 * @returns {Record<string, any>}
 */
export function migrateCacheTtlDefault(raw) {
  if (raw == null || typeof raw !== "object") return {};
  const out = { ...raw };
  // Already corrected once — never second-guess the user again.
  if (out.cacheTtlDefaultMigrated === true) return out;
  out.cacheTtlDefaultMigrated = true;
  // Only the stale default is rewritten. An absent key already resolves to
  // the new "5m" default, and an explicit "5m" is already correct.
  if (out.cacheTtl === "1h") out.cacheTtl = "5m";
  return out;
}
