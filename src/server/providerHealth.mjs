// providerHealth.mjs — the provider-health COMPATIBILITY facade (BET-1536).
//
// S4 replaced the in-memory provider-keyed event tracker this module used to
// be (BET-1240) with the two health registers in endpointHealth.mjs: the
// account register (providerID → out-of-credit/unauthorized) and the endpoint
// register (endpointKey → unproven/dead/degraded/not-found/forbidden/
// rate-limited). The old content moved there — this file is the thin read
// surface the Accounts channels and the router's provider-keyed
// `services.health` consume, so their callers do not change. There is nothing
// here to keep in sync: every method delegates to the engine, and the
// provider-level view (account state first, then the endpoint rollup —
// rate-limited → "rate-limited", dead → "failing") lives in the engine.
//
// What was DELETED (W4/BET-1536): `observeEvent` and `attributedProvider`
// (the per-session {adapterId, model} cache reuse from usageStopEnroll.mjs) —
// attribution belongs to the attempts pipeline now. The engine consumes S2's
// provider attempts only, fed by the attempts recorder's post-persist hook
// (wired in index.mjs). Health-eligible classification (BET-1230) lives in
// the attempts pipeline, not here.

import { createEndpointHealth } from "./endpointHealth.mjs";
import { endpointAttempts } from "./endpointAttempts.mjs";

export { PROVIDER_HEALTH_STATE } from "./endpointHealth.mjs";

// Kept exported for compatibility with the pre-S4 export (tests of the old
// tracker asserted it); the engine's `dead` streak replaced it as the
// deprioritisation threshold.
export const MIN_FAILURES_TO_DEPRIORITIZE = 2;

/**
 * The Accounts/router-facing health surface over the endpoint-health engine.
 *
 * @param {object} deps
 * @param {() => number} [deps.now]
 * @param {(evt: {kind:string, payload:object}) => void} [deps.publish]  bus publish
 *   (a `provider-health.needs-attention` event fires ONCE per transition)
 * @param {(adapterId: string) => Promise<boolean>|boolean} [deps.recheckAtLimit]
 *   wire to recheckAdapterAtLimit — a cheap metadata fetch, ZERO model calls
 * @param {(adapterId: string) => string|null} [deps.providerIDForAdapter]
 *   adapter id -> opencode providerID (usage.mjs)
 * @param {(providerID: string) => string|null} [deps.adapterForProvider]
 *   opencode providerID -> its usage adapter id, for the meter recheck
 * @param {({providerID: string, modelID: string, kind: string}) =>
 *   Promise<{outcome: string, code?: string|null}|null>} [deps.probeRun]
 *   ONE bounded real probe (W8) — a pinned runSynchronousSession with
 *   probe:true. Absent → the manual reset clears without a probe.
 * @param {() => number|null} [deps.lastRecoverySuccessAt]  the timestamp of
 *   the last SUCCESSFUL credential recovery, in SECONDS (§4.5a), exposed by
 *   opencode.mjs. Reserved for the recovery evidence path.
 * @param {object} [deps.engine]  test seam — a pre-built engine to delegate to
 * @returns {{ state, all, retry, retryIn, deliverSnapshots, engine }}
 */
export function createProviderHealth({
  now = Date.now,
  publish = () => {},
  recheckAtLimit = async () => false,
  providerIDForAdapter = () => null,
  adapterForProvider = () => null,
  probeRun = null,
  lastRecoverySuccessAt = () => null,
  attempts = endpointAttempts,
  engine = null,
} = {}) {
  const health = engine ?? createEndpointHealth({
    now,
    publish,
    attempts,
    meterAtLimit: recheckAtLimit,
    adapterForProvider,
    providerIDForAdapter,
    probeRun,
    lastRecoverySuccessAt,
  });

  return {
    engine: health,
    /** The provider-keyed compatibility view (account precedence + rollup). */
    state: (providerID) => health.providerState(providerID),
    /** Every known provider mapped to its current state. */
    all: () => health.all(),
    /** The Accounts "Try again" action (W8 manual reset + bounded probe). */
    retry: (providerID) => health.retry(providerID),
    /** Remaining ms of the provider's longest active rate-limit deadline. */
    retryIn: (providerID) => health.retryIn(providerID),
    /** Recovery path #4: a supported provider's reader reporting funds. */
    deliverSnapshots: (snapshots) => health.deliverSnapshots(snapshots),
  };
}
