// usageStopEnroll.mjs — the enrolment path: turns a raw opencode event stream
// into durable "stopped conversation" records (BET-1047 stage 1).
//
// Detection is two independent signals (spec §4) that fail in opposite
// directions: the refusal MATCH (classifier over seen wordings — precise but
// blind to rewording) and the METER CORRELATION (the provider's usage re-
// checked immediately on the failure — fuzzy but catches everything). Either
// enrols.
//
// To run either signal we need the conversation's provider — which the
// `session.error` event does not carry. It comes from `session.next.step.ended`
// events, which DO carry `properties.providerID` + `properties.modelID` and the
// token breakdown (cached prefix). This module keeps a small per-session record
// of (adapterId, model, cachedTokens) fed by step events, and consumes it when
// a session errors. Scope is the three subscription providers (spec §3); a
// session whose provider is never seen (or is a pay-as-you-go key) never
// enrols.
//
// Instrumentation (spec §4.3): the COMPLETE error payload of every failed turn
// is logged, so an unfamiliar refusal hands us its wording directly instead of
// a morning of log archaeology.
//
// Pure-ish + dependency-injected for tests: the per-session model bookkeeping
// is synchronous and testable; the async work (re-check + store write) is
// injected.

import { classifyUsageStopped, decideUsageEnrolment } from "./usageStopper.mjs";
import { adapterForProviderID } from "./usage.mjs";

/**
 * Extract the cached-token count from a step event's props (the sum of the
 * cached prefix — cache.read + cache.write — that will be re-read on a resume).
 * @param {object} props  evt.properties of a `session.next.step.ended` event
 * @returns {number}
 */
export function cachedTokensFromStep(props = {}) {
  const cache = props?.tokens?.cache ?? props?.usage?.cache ?? {};
  const read = Number.isFinite(cache?.read) ? cache.read : 0;
  const write = Number.isFinite(cache?.write) ? cache.write : 0;
  return (read || 0) + (write || 0);
}

/** @returns {{conversation:string, adapterId:string|null, model?:string, cachedTokens:number}} */
function freshModel(sessionId) {
  return { conversation: sessionId, adapterId: null, model: undefined, cachedTokens: 0 };
}

/**
 * Build the usage-stop enrolment engine.
 *
 * @param {object} deps
 * @param {(input: object) => Promise<void>} deps.upsert       wire to upsertStopped(input, {publish})
 * @param {(adapterId: string) => Promise<boolean>|boolean} deps.recheckAtLimit  wire to recheckAdapterAtLimit
 * @param {(sessionId: string) => Promise<string|undefined>|string|undefined} [deps.resolveWorkspace]  best-effort project label
 * @param {() => number} [deps.now]
 * @returns {{ observeEvent: (evt: object) => void, getSessionModel: (sessionId: string) => {adapterId:string|null, model?:string, cachedTokens:number}|null }}
 */
export function createUsageStopEngine({ upsert, recheckAtLimit, resolveWorkspace = () => "", now = () => Date.now() } = {}) {
  const sessionModel = new Map(); // sessionId -> {conversation, adapterId, model?, cachedTokens}

  function applyStep(sessionId, props) {
    let m = sessionModel.get(sessionId);
    if (!m) {
      m = freshModel(sessionId);
      sessionModel.set(sessionId, m);
    }
    const adapterId = adapterForProviderID(props?.providerID);
    if (adapterId) m.adapterId = adapterId;
    if (typeof props?.modelID === "string" && props.modelID) m.model = props.modelID;
    m.cachedTokens = cachedTokensFromStep(props);
  }

  async function performEnrolment(evt) {
    const props = evt?.properties ?? {};
    const sessionId = props.sessionID;
    if (!sessionId) return;
    const m = sessionModel.get(sessionId);
    const adapterId = m?.adapterId;
    // Unknown provider (never seen a step event, or a pay-as-you-go key) →
    // out of scope. This is what keeps signal 2 from firing for a provider we
    // cannot attribute the conversation to.
    if (!adapterId) return;

    const err = props.error ?? {};
    const errorName = typeof err?.name === "string" ? err.name : undefined;
    const errorMessage =
      typeof err?.data?.message === "string" ? err.data.message : typeof err?.message === "string" ? err.message : undefined;

    // The classifier distinguishes "no match" from "explicit never-enrol"
    // (auth failures, aborts/context-overflow, affirmative NOT-quota phrases);
    // decideUsageEnrolment lets a never-enrol suppress the correlation signal,
    // so no separate exclusion gate is needed here.
    const match = classifyUsageStopped({ provider: adapterId, errorName, errorMessage, error: err });

    let atLimit = false;
    try {
      atLimit = !!(await recheckAtLimit(adapterId));
    } catch {
      atLimit = false; // a failed re-check must never over-enrol
    }

    const decision = decideUsageEnrolment({ match, atLimit });
    if (!decision.enrol) return;

    let workspace = "";
    try {
      workspace = (await resolveWorkspace(sessionId)) ?? "";
    } catch {
      workspace = "";
    }

    await upsert({
      conversation: sessionId,
      workspace,
      provider: adapterId,
      model: m.model,
      window: decision.window,
      stoppedAt: now(),
      cachedTokens: m.cachedTokens,
    });
  }

  function observeEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "session.next.step.ended": {
        const props = evt.properties ?? {};
        if (props.sessionID) applyStep(props.sessionID, props);
        return;
      }
      case "session.error": {
        // Instrumentation (spec §4.3): log the COMPLETE error payload so the
        // next unfamiliar refusal hands us its wording directly.
        console.warn(
          "[usage-stop] failed turn",
          JSON.stringify({ sessionID: evt.properties?.sessionID, error: evt.properties?.error ?? null }),
        );
        // Return the promise so tests can await the async enrolment; the event
        // pump ignores the return (fire-and-forget), and a rejection is
        // swallowed so it can never escape into the pump.
        return performEnrolment(evt).catch((e) =>
          console.warn("[usage-stop] enrolment failed:", e?.message ?? e),
        );
      }
      default:
        return;
    }
  }

  // Read-only view of the per-session provider record this engine already
  // keeps (fed by `session.next.step.ended` — the ONLY event that carries the
  // provider). Stage 4's provider-health record reads the SAME cache rather
  // than building a second one (BET-1230). Returns null for a session whose
  // provider was never observed.
  function getSessionModel(sessionId) {
    const m = sessionModel.get(sessionId);
    if (!m) return null;
    return { adapterId: m.adapterId, model: m.model, cachedTokens: m.cachedTokens };
  }

  return { observeEvent, getSessionModel };
}
