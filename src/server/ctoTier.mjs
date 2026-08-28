// src/server/ctoTier.mjs
// BET-1386 §10.5 card 1 — the effort dial is a real, persisted selection AND
// ledgered on change. This pure module decides WHAT gets written to the
// Activity ledger when a user switches Low/Med/High (via `configUpdate`), so
// the audit-trace rule is unit-testable without a live box. rpc.mjs calls it
// and appends the returned row (ts stamped at append).

/** The ledger `kind` a tier change is recorded under (actor `user`, source `settings`). */
export const TIER_CHANGE_KIND = "cto.tier_change";

/**
 * Return the Activity-ledger entry for an effort-dial change, or `null` when
 * the tier did not actually change (re-selecting the same tier is NOT a
 * switch, and a config update that never touched `ctoTier` is not either).
 *
 * @param {{ prev?: {ctoTier?: string}|null, next?: {ctoTier?: string}|null }} snap
 */
export function tierChangeLedgerEntry({ prev, next }) {
  const prevTier = prev?.ctoTier ?? "low";
  const nextTier = next?.ctoTier ?? "low";
  if (prevTier === nextTier) return null;
  return {
    actor: "user",
    kind: TIER_CHANGE_KIND,
    source: "settings",
    reason: `effort: ${prevTier} → ${nextTier}`,
  };
}
