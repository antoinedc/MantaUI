// routingOverrides.mjs — the dev-only overrides bag on routing:choose (BET-1276
// 12a).
//
// The Deck A replay harness varies the routing decision without genuinely
// exhausting a subscription or breaking satellite state. It does this by
// replacing the decision's inputs for ONE call. Without this the harness would
// need real exhaustion (a "consume the subscription to prove pacing" test) and
// real health flips to observe a filter fire — neither is survivable on a box
// a human is using.
//
// The bag is deliberately dev-only, read-only and side-effect-free:
//   • It replaces values in the services object and filters the candidate pool
//     for one call and writes nothing — a shallow merge at the decision had
//     already been reached, never a new code path through it.
//   • Gated on `process.env.NODE_ENV !== "production"` (the caller supplies
//     the gate). When gated off the field is IGNORED silently — a stale client
//     must never break a real turn.
//   • It must not be reachable from any UI — it travels only on the
//     routing:choose request and the harness, never a Settings control.
//
// Pure and shared here so the routing:choose handler (src/server/rpc.mjs) and
// the Deck A runner (scripts/routing/deck-a.mjs) apply the merge through
// exactly ONE implementation — never two code paths that could drift into two
// behaviours (the exact defect this set repairs).

import { endpointKey } from "./endpointKey.mjs";

const isObj = (v) => v !== null && typeof v === "object";

/**
 * Shallow-merge the overrides bag onto the decision inputs for one call.
 *
 * `accounts` and `health` replace the corresponding keys on the services
 * object; `enabledMain` / `enabledSub` (endpoint keys, providerID/modelID)
 * restrict the candidate pool for the matching surface. The bag is applied
 * ONLY when `gated === true`; otherwise the inputs pass through untouched.
 *
 * @param {object} o
 * @param {object} [o.services]   the RoutingServices object built from live state
 * @param {Array}  [o.catalog]    the candidate endpoint list for the surface
 * @param {"main"|"sub"} [o.surface]
 * @param {object} [o.overrides]  the overrides bag from the request
 * @param {boolean} [o.gated]     true when NODE_ENV !== "production"
 * @returns {{ services: object, catalog: Array }}
 */
export function applyRoutingOverrides({ services, catalog, surface, overrides, gated }) {
  if (gated !== true || !isObj(overrides)) {
    return { services, catalog };
  }
  let next = services;
  if (isObj(overrides.accounts)) {
    next = { ...(isObj(next) ? next : {}), accounts: overrides.accounts };
  }
  if (isObj(overrides.health)) {
    next = { ...(isObj(next) ? next : {}), health: overrides.health };
  }
  let nextCatalog = catalog;
  // A PROVIDED array (including []) restricts the pool to exactly those
  // endpoint keys — present-but-empty means "no candidates", the A15 harness
  // scenario (keepsIncumbent). Absent/undefined means no restriction.
  const enabled = surface === "sub" ? overrides.enabledSub : overrides.enabledMain;
  if (Array.isArray(enabled)) {
    const keys = new Set(enabled);
    nextCatalog = Array.isArray(catalog) ? catalog.filter((c) => keys.has(endpointKey(c))) : catalog;
  }
  return { services: next, catalog: nextCatalog };
}

/**
 * Resolve the decision's injected clock. The router already takes injected
 * time; this lets the harness hold `nowMs` fixed so pacing scenarios (A19) are
 * reproducible. Gated: when off (or absent) the caller's own clock wins.
 *
 * @param {object} [overrides]
 * @param {boolean} [gated]
 * @param {number} [fallback]
 * @returns {number}
 */
export function resolveNowOverride(overrides, gated, fallback) {
  if (
    gated === true &&
    isObj(overrides) &&
    typeof overrides.nowMs === "number" &&
    Number.isFinite(overrides.nowMs)
  ) {
    return overrides.nowMs;
  }
  return fallback;
}

/**
 * The health map the incumbent-health report should consult, or null when the
 * bag is gated off / carries no health override. Lets a harness scenario (A21,
 * A22) observe the incumbent READING as unhealthy on the same round trip the
 * decision core responds to the override.
 *
 * @param {object} [overrides]
 * @param {boolean} [gated]
 * @returns {Record<string,string>|null}
 */
export function resolveHealthOverride(overrides, gated) {
  if (gated === true && isObj(overrides) && isObj(overrides.health)) {
    return overrides.health;
  }
  return null;
}
