// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { tierChangeLedgerEntry, TIER_CHANGE_KIND } from "./ctoTier.mjs";

test("a real Low → Medium switch yields a user ledger entry", () => {
  const entry = tierChangeLedgerEntry({ prev: { ctoTier: "low" }, next: { ctoTier: "medium" } });
  assert.deepEqual(entry, {
    actor: "user",
    kind: TIER_CHANGE_KIND,
    source: "settings",
    reason: "effort: low → medium",
  });
});

test("any real tier change (High → Low) is captured", () => {
  const entry = tierChangeLedgerEntry({ prev: { ctoTier: "high" }, next: { ctoTier: "low" } });
  assert.equal(entry.reason, "effort: high → low");
});

test("re-selecting the SAME tier is not a switch → null", () => {
  assert.equal(
    tierChangeLedgerEntry({ prev: { ctoTier: "medium" }, next: { ctoTier: "medium" } }),
    null,
  );
});

test("a config update that never touched ctoTier is not a switch → null", () => {
  assert.equal(tierChangeLedgerEntry({ prev: {}, next: {} }), null);
});

test("missing tier / defaults treat the tier as 'low'", () => {
  const entry = tierChangeLedgerEntry({ prev: null, next: { ctoTier: "high" } });
  assert.equal(entry.reason, "effort: low → high");
});
