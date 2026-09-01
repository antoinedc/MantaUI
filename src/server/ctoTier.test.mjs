// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

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
