// Hand-written type declarations for configMigration.mjs. The implementation
// is plain JS so it can be imported by both Node-side modules (.mjs natively)
// and the renderer test suite (vitest .ts file). Keep this in sync with
// src/shared/configMigration.mjs.

export function migrateLegacyCapConfig(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown>;
