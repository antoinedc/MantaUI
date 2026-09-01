// BET-1490: shared fail-fast MANTA_STATE_HOME guard for every
// src/server/cto*.test.mjs file. BET-1469/1489 mandated the guard be copied
// verbatim into each test file; that byte-identical mirror is what the
// duplication-gate flags, so this module replaces the mirror. Importing it
// as the FIRST import of a test file preserves (and tightens) the fail-fast
// semantics: with no MANTA_STATE_HOME set, module evaluation aborts HERE,
// before any store module in the importing file is evaluated, and nothing is
// written to the live box state (~/.manta).
//
// `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}
