// providerHealth.mjs — Automatic Manta Routing, Stage 4 (BET-1240), box-side.
//
// Tracks whether each AI provider is currently WORKING or NOT, from the ONE
// signal every provider emits without being asked: the HTTP status of a failed
// turn. A custom provider has no account state by design, so it cannot be
// asked "are you usable?" — but every provider still answers it: requests
// either succeed or they do not. That is a fact, not an inference, and it
// needs no balance endpoint and no knowledge of the provider.
//
// Four states per provider (issue §Three states):
//   rate-limited   HTTP 429  excluded for the cooldown; AUTO-RECOVERS on expiry
//   out-of-credit  HTTP 402  excluded from Auto (never from manual); recovers
//                            ONLY by evidence — never by a clock
//   failing        repeated non-402/429 failures — deprioritised (soft);
//                            cleared on the next success
//   ok             default
//
// Why out-of-credit must NOT recover by a clock: a credit exhaustion does not
// reset on a window boundary, so there is nothing for a timer to observe. The
// previous usage-resume implementation fired at a fixed reset+60s and was
// deleted for exactly that reason — see the rationale comment at the top of
// usageResume.mjs. Three free ways it clears, all evidence:
//   1. a successful turn on that provider (Auto-exclusion only; manual always
//      works, and a manual success is itself the clearing evidence);
//   2. `retry(providerID)` — supported providers re-read the meter (zero model
//      calls) and clear only if it reports funds; custom providers clear
//      optimistically with NO traffic — the user is the evidence, the next
//      routed turn is the real test, and a repeat refusal re-flags it;
//   3. a supported provider's reader reporting funds on a normal poll.
//   No background polling, no liveness pings, no timer re-admission.
//
// Shape: the same per-resource epoch-deadline-in-a-Map the repo already uses
// twice for "unhealthy resource" — `backoffUntil` in usage.mjs and
// `coolingUntil` in forge/index.mjs. Flat deadlines, no exponential back-off.
//
// Attribution: `session.error` carries no providerID. This module REUSES the
// per-session {adapterId, model} cache built from `session.next.step.ended` in
// usageStopEnroll.mjs (exposed as getSessionModel) — it does NOT write a
// second cache. The adapter id is mapped back to an opencode providerID via
// providerIDForAdapter; a session whose provider was never observed (or a
// pay-as-you-go key) cannot be attributed and is skipped.
//
// Surfacing: per the `NEVER STUB A CONTROL TO DO NOTHING` rule in AGENTS.md an
// excluded provider must surface, not silently disappear. A needs-attention
// bus event fires ON the transition only, never on every check — precedent and
// rationale at usageResume.mjs (~line 326 and ~344-346).

import {
  adapterForProviderID,
  MIN_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
} from "./usage.mjs";

export const PROVIDER_HEALTH_STATE = Object.freeze({
  OK: "ok",
  RATE_LIMITED: "rate-limited",
  OUT_OF_CREDIT: "out-of-credit",
  FAILING: "failing",
});

// A provider is only deprioritised after this many CONSECUTIVE non-402/429
// failures. Deliberately >1 so a single transient network blip does not
// down-rank a healthy provider; small so a genuinely broken one surfaces fast.
export const MIN_FAILURES_TO_DEPRIORITIZE = 2;

// Clamp a provider's requested Retry-After into the band the usage engine
// already uses for the same case (a real provider answers 429 with
// `retry-after: 0`; honouring it hot-loops; a provider asking for an hour must
// not take a resource dark for an hour). Reuses the named constants from
// usage.mjs — the numbers have one home, with their rationale, there.
function clampRetryAfterMs(retryAfterMs) {
  const ms = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, ms));
}

/**
 * The working/not-working tracker for AI providers.
 *
 * @param {object} deps
 * @param {() => number} [deps.now]
 * @param {(evt: {kind:string, payload:object}) => void} [deps.publish]  bus publish
 *   (a `provider-health.needs-attention` event fires ONCE per transition)
 * @param {(sessionId: string) => ({adapterId:string|null, model?:string}|null)|null}
 *   [deps.getSessionModel]  the per-session provider cache from
 *   usageStopEnroll.mjs (BET-1230 exposes it) — reused, never duplicated
 * @param {(adapterId: string) => string|null} [deps.providerIDForAdapter]
 *   adapter id -> opencode providerID (usage.mjs)
 * @param {(adapterId: string) => Promise<boolean>|boolean} [deps.recheckAtLimit]
 *   wire to recheckAdapterAtLimit — a cheap metadata fetch, ZERO model calls
 * @param {number} [deps.minFailuresToDeprioritize]
 * @returns {{
 *   observeEvent: (evt: object|null|undefined) => void,
 *   state: (providerID: string) => string,
 *   retry: (providerID: string) => Promise<{cleared: boolean, state: string}>,
 *   all: () => Record<string, string>,
 * }}
 */
export function createProviderHealth({
  now = Date.now,
  publish = () => {},
  getSessionModel = () => null,
  providerIDForAdapter = () => null,
  recheckAtLimit = async () => false,
  minFailuresToDeprioritize = MIN_FAILURES_TO_DEPRIORITIZE,
} = {}) {
  // Flat cooldown deadline per provider — auto-recovers on expiry.
  const rateLimitedUntil = new Map(); // providerID -> epoch ms
  // Evidence-only exclusion — NEVER cleared by a clock.
  const outOfCredit = new Set(); // providerID
  // Soft failure streak per provider; cleared on the next success.
  const consecutiveFailures = new Map(); // providerID -> count
  // Every provider we have attributed, so all() can enumerate the live picture.
  const known = new Set();
  // The last non-ok state published per provider, so the needs-attention event
  // fires ONCE at the transition and never re-fires per observation.
  const published = new Map(); // providerID -> state

  function failuresOf(providerID) {
    return consecutiveFailures.get(providerID) ?? 0;
  }

  /** The effective state of a provider RIGHT NOW (rate-limit expiry resolved). */
  function state(providerID) {
    if (outOfCredit.has(providerID)) return PROVIDER_HEALTH_STATE.OUT_OF_CREDIT;
    const until = rateLimitedUntil.get(providerID);
    if (until != null && until > now()) return PROVIDER_HEALTH_STATE.RATE_LIMITED;
    if (failuresOf(providerID) >= minFailuresToDeprioritize) {
      return PROVIDER_HEALTH_STATE.FAILING;
    }
    return PROVIDER_HEALTH_STATE.OK;
  }

  // Surface a non-ok state ONCE per transition into that state. Moving back to
  // ok clears the marker so a later relapse re-publishes.
  function mark(providerID, newState) {
    known.add(providerID);
    if (newState === PROVIDER_HEALTH_STATE.OK) {
      published.delete(providerID);
      return;
    }
    if (published.get(providerID) === newState) return;
    published.set(providerID, newState);
    publish({ kind: "provider-health.needs-attention", payload: { providerID, state: newState } });
  }

  // A successful turn on the provider is evidence of life: it clears the
  // evidence-only out-of-credit flag and the soft failure streak. The
  // rate-limited flag is deliberately NOT touched here — it recovers by its
  // own cooldown expiry, not by success.
  function clearForSuccess(providerID) {
    known.add(providerID);
    outOfCredit.delete(providerID);
    consecutiveFailures.delete(providerID);
    published.delete(providerID);
  }

  function attributedProvider(sessionId) {
    const m = getSessionModel(sessionId);
    const adapterId = m?.adapterId;
    if (!adapterId) return null;
    return providerIDForAdapter(adapterId);
  }

  function applyFailure(providerID, error) {
    const httpStatus = Number.isFinite(error?.httpStatus) ? error.httpStatus : null;
    const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : undefined;

    if (httpStatus === 402) {
      // Out of credit: excluded until evidence (never a clock). A 402 is not a
      // soft-failure streak — re-failing for the same reason must not also
      // accrue `failing`.
      consecutiveFailures.delete(providerID);
      if (!outOfCredit.has(providerID)) {
        outOfCredit.add(providerID);
        mark(providerID, PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
      }
      return;
    }

    if (httpStatus === 429) {
      // Rate limited: flat cooldown, clamped, auto-recovers on expiry.
      consecutiveFailures.delete(providerID);
      rateLimitedUntil.set(providerID, now() + clampRetryAfterMs(retryAfterMs));
      // Resolve the effective state — a lingering out-of-credit outranks a new
      // rate-limit, and the transition surfacing must reflect that.
      mark(providerID, state(providerID));
      return;
    }

    // Any other failure (including an unscoped HTTP status): a soft-failure
    // streak — deprioritised once it repeats, cleared on the next success.
    known.add(providerID);
    consecutiveFailures.set(providerID, failuresOf(providerID) + 1);
    if (failuresOf(providerID) >= minFailuresToDeprioritize) {
      mark(providerID, PROVIDER_HEALTH_STATE.FAILING);
    }
  }

  /**
   * Feed the opencode event stream (from the pump in index.mjs, alongside the
   * other observers). Step events carry the provider via the shared session
   * cache and are the success signal; error events carry the preserved HTTP
   * status (BET-1230 enriches them before this runs).
   * @param {object|null|undefined} evt
   */
  function observeEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    const props = evt.properties ?? {};
    const sessionId = props.sessionID;
    if (typeof sessionId !== "string" || !sessionId) return;
    const providerID = attributedProvider(sessionId);
    if (!providerID) return;

    if (evt.type === "session.next.step.ended") {
      // The model produced a step → the provider is demonstrably working.
      clearForSuccess(providerID);
      return;
    }
    if (evt.type === "session.error") {
      applyFailure(providerID, props.error ?? {});
    }
  }

  /**
   * The Accounts "Try again" action. Supported providers re-read their meter
   * (zero model calls) and clear only if it reports funds; custom providers
   * clear optimistically with NO traffic — the user is the evidence.
   * @param {string} providerID
   * @returns {Promise<{cleared: boolean, state: string}>}
   */
  async function retry(providerID) {
    const adapterId = adapterForProviderID(providerID);
    if (!adapterId) {
      // Custom provider: no meter exists to re-read. Clear optimistically and
      // send no traffic; the next routed turn is the real test.
      outOfCredit.delete(providerID);
      consecutiveFailures.delete(providerID);
      published.delete(providerID);
      return { cleared: true, state: state(providerID) };
    }
    let atLimit = false;
    try {
      atLimit = !!(await recheckAtLimit(adapterId));
    } catch {
      atLimit = false; // a failed re-check must never clear on an absent reading
    }
    if (!atLimit) {
      outOfCredit.delete(providerID);
      consecutiveFailures.delete(providerID);
      published.delete(providerID);
    }
    return { cleared: !atLimit, state: state(providerID) };
  }

  /** Every attributed provider mapped to its current state. */
  function all() {
    const out = {};
    for (const providerID of known) out[providerID] = state(providerID);
    return out;
  }

  return { observeEvent, state, retry, all };
}
