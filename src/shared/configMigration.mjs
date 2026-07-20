// configMigration.mjs — pure migration from the v1 capability-executor
// config (capExecutorEnabled / iosBuildRepoPath / iosSimulatorName) to the
// v2 plugins config (pluginsEnabled). Electron-free so it's unit-testable
// with vitest and reusable from any future context (relay, server, etc).
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
