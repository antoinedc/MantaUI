// Hand-written type declarations for configMigration.mjs. The implementation
// is plain JS so it can be imported by both Node-side modules (.mjs natively)
// and the renderer test suite (vitest .ts file). Keep this in sync with
// src/shared/configMigration.mjs.

export function migrateLegacyCapConfig(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown>;

// One-time correction of the wrong `cacheTtl: "1h"` default → "5m", marked by
// `cacheTtlDefaultMigrated` so a deliberate re-pick of "1h" sticks.
export function migrateCacheTtlDefault(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown>;

// One-time switch of the box handoff-mode default "auto" → "suggest", marked by
// `handoffModeDefaultMigrated` so a deliberate re-pick sticks.
export function migrateHandoffModeDefault(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown>;
