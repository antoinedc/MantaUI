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
  unauthorized: "Sign-in expired",
  failing: "Not responding",
});

// BET-1537 (S5, §W9): the human words for an ENDPOINT-register state — the
// Accounts custom-endpoint rows and the Models list badges read these. ONE
// source of truth for both surfaces (same discipline as the provider labels
// above): the state a model badge shows must be the state that gates Auto.
// Only non-ok states have words; a missing entry means "unproven OR unknown"
// and the surfaces say "Unproven" for missing-but-declared endpoints.
export const ENDPOINT_STATE_LABEL = Object.freeze({
  unproven: "Unproven",
  dead: "Dead",
  degraded: "Degraded",
  "not-found": "Not found",
  forbidden: "Blocked",
  "rate-limited": "Rate limited",
});

/** The human label for an endpoint-register state, or null when unknown. */
export function endpointStateLabel(state) {
  return ENDPOINT_STATE_LABEL[state] ?? null;
}

/** The human label for a provider-health state, or null when unknown/ok. */
export function providerStateLabel(state) {
  return PROVIDER_STATE_LABEL[state] ?? null;
}
