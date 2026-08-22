// providerHealthLabel.mjs — the human words for a provider-health state.
//
// ONE source of truth for the words the two surfaces that show them must not
// disagree on (BET-1270 6d): the Accounts row (renderer) and the needs-attention
// notification body (server). If the wording drifts, a user reads "Out of
// credit" in Settings and "Not responding" in the push for the same provider.
//
// Only the non-ok states have words; `ok` is the default and needs no label.
// Pure, no I/O, no imports.

export const PROVIDER_STATE_LABEL = Object.freeze({
  "out-of-credit": "Out of credit",
  "rate-limited": "Rate limited",
  failing: "Not responding",
});

/** The human label for a provider-health state, or null when unknown/ok. */
export function providerStateLabel(state) {
  return PROVIDER_STATE_LABEL[state] ?? null;
}
