// Adaptive CTO — evidence ingestion + presence/absence state (spec §4.1, §5.4,
// §5.1-Scope, §3.4 rule 3). Pure, dependency-free logic (the node:test surface
// is src/server/ctoEvidence.test.mjs); the engine that wires this is
// src/server/ctoEngine.mjs.
//
// Two concerns, both testable without any live tmux/opencode/push:
//
//  1. Evidence normalization — consume the box event stream (§4.1) and reduce
//     each meaningful event to an evidence row
//     `{ts, sessionID?, project?, kind, salience: "none"|"high", refs[]}`
//     appended to the A1 ledger. The event stream is ambient + unranked, so
//     most rows are salience "none" (statistical only); error / permission /
//     question subtypes carry salience "high".
//
//  2. Pipeline-scope rule (§5.1-Scope) — only `user`- and `job`-owned
//     sessions produce evidence; `cto`-owned sessions are dropped at
//     ingestion so the CTO never observes itself.
//
//  3. Presence/absence (§5.4) — last_seen = max(desktop heartbeat, app
//     open/focus, user prompt submission); state ∈ present|away|gone|unknown.
//     Desktop present/away/gone reuse the thresholds already in push.mjs
//     (computeAwayAt / desktopState — imported, not copied). A box that has
//     NEVER heartbeated this uptime is `unknown` unless app-open/prompt
//     activity within PRESENT_PROOF_MS proves `present`. `unknown` is treated
//     as `present` by every etiquette consumer — quiet is the safe default
//     (§3.4 rule 3), so heavy work runs only in away/gone.

import { desktopState } from "./push.mjs";

// Who may produce pipeline evidence. `cto`-owned sessions are excluded so the
// CTO does not observe its own activity (spec §5.1-Scope). Absent/unknown
// owners default to the spec's `user`.
export const PIPELINE_OWNERS = Object.freeze(["user", "job"]);

export function isPipelineSession(owner) {
  return typeof owner === "string" && PIPELINE_OWNERS.includes(owner);
}

// Ledger-row discriminator for evidence rows (the A1 ledger also carries
// cto.pause / cto.resume / … activity rows under the same `actor:"cto"`).
export const CHANNEL_EVENT = "event";

// A no-heartbeat box stays `unknown` unless positive activity (app open or a
// user prompt) landed within this window — then it counts as `present`.
export const PRESENT_PROOF_MS = 10 * 60_000;

// last_seen (spec §5.4) = max of the three presence signals; any may be
// absent (ignored). Returns the max finite epoch-ms, or 0 when nothing seen.
export function computeLastSeen({ desktopHeartbeatTs, appOpenTs, promptTs } = {}) {
  let max = 0;
  for (const v of [desktopHeartbeatTs, appOpenTs, promptTs]) {
    if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

// Presence/absence state (§5.4). `heartbeats` is the live desktop presence
// record from push.getDesktopPresence() — `{lastSeen, awayAt, …}` — or a bare
// boolean `true` for "has heartbeated" (then only lastSeen is known). Desktop
// present/away/gone delegate to push.desktopState (the shared thresholds).
// With no desktop heartbeat this uptime → `unknown`, unless lastSeen
// (app-open/prompt) is within PRESENT_PROOF_MS → `present`.
export function presenceState({ heartbeats, lastSeen, now }) {
  let desktop = heartbeats;
  if (desktop === true) desktop = { lastSeen };
  const hasBeat =
    !!desktop && typeof desktop?.lastSeen === "number" && desktop.lastSeen > 0;
  if (!hasBeat) {
    if (typeof lastSeen === "number" && lastSeen > 0 && now - lastSeen <= PRESENT_PROOF_MS) {
      return "present";
    }
    return "unknown";
  }
  return desktopState(desktop, now);
}

// §3.4 rule 3 (etiquette): heavy autonomous work runs only while away/gone.
// `unknown` is treated as `present` — i.e. heavy work does NOT run — the
// spec's safe default. Pure mapping so consumers + this contract are testable.
export function heavyWorkAllowed(state) {
  return state === "away" || state === "gone";
}

// ----- Event classification (evidence row source) -----

// The opencode session an event belongs to, if any.
export function eventSessionID(evt) {
  return evt?.properties?.sessionID || evt?.properties?.info?.sessionID || null;
}

function messageRole(evt) {
  return (
    evt?.properties?.message?.role ||
    evt?.properties?.info?.message?.role ||
    evt?.properties?.info?.role ||
    null
  );
}

// A user prompt submission — positive "user is here" activity. Accepts the
// canonical opencode `user.message.created` or a user-role message update.
export function isUserPromptEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (evt.type === "user.message.created") return true;
  if (evt.type !== "message.part.updated" && evt.type !== "message.updated") return false;
  return messageRole(evt) === "user";
}

// Reduce one opencode stream event to `{kind, salience, refs, sessionID}` or
// null for pure noise (streaming deltas, config churn, agent switches). The
// event stream is ambient + unranked — most rows are salience "none";
// error/permission/question carry "high".
export function classifyEvent(evt) {
  if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return null;
  const type = evt.type;
  const lowered = type.toLowerCase();
  const sessionID = eventSessionID(evt) || null;
  const refs = sessionID ? [sessionID] : [];

  if (
    type === "session.error" ||
    lowered.includes("error")
  ) {
    return { kind: "error", salience: "high", refs, sessionID };
  }
  if (type === "permission.asked" || lowered.includes("question")) {
    return { kind: type === "permission.asked" ? "permission" : "question", salience: "high", refs, sessionID };
  }
  if (type === "session.idle") {
    return { kind: "turn.done", salience: "none", refs, sessionID };
  }
  if (type === "session.created") {
    return { kind: "session.created", salience: "none", refs, sessionID };
  }
  if (type === "session.deleted") {
    return { kind: "session.deleted", salience: "none", refs, sessionID };
  }
  if (isUserPromptEvent(evt)) {
    return { kind: "prompt", salience: "none", refs, sessionID };
  }
  return null;
}

// Best-effort free-text hint for an evidence row (BET-1398). The A5 stream is
// primarily structured (`kind`), but the standing-query engine's
// `event-pattern` predicate matches "evidence text" too — pull a snippet from
// the raw event when it has one (error messages, permission texts, part text).
// Never fabricates; returns undefined when the event carries no readable text.
export function evidenceText(evt) {
  if (!evt || typeof evt !== "object") return undefined;
  for (const key of ["message", "error", "title", "text"]) {
    const v = evt[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 512);
  }
  const props = evt.properties;
  if (props && typeof props === "object") {
    for (const key of ["message", "error", "level", "title", "text"]) {
      const v = props[key];
      if (typeof v === "string" && v.trim()) return v.slice(0, 512);
      if (v && typeof v === "object" && typeof v.message === "string" && v.message.trim()) {
        return v.message.slice(0, 512);
      }
    }
  }
  const text = evt.text;
  if (typeof text === "string" && text.trim()) return text.slice(0, 512);
  return undefined;
}

// Full evidence-row normalization: applies the pipeline-scope rule (cto-owned
// → null) then classifies. Pure — `now` injected for determinism.
export function normalizeEvidence(
  evt,
  { owner = "user", project, now = Date.now() } = {},
) {
  if (!isPipelineSession(owner)) return null;
  const classified = classifyEvent(evt);
  if (!classified) return null;
  return {
    ts: now,
    sessionID: classified.sessionID || undefined,
    project,
    kind: classified.kind,
    salience: classified.salience,
    refs: classified.refs ?? [],
    text: evidenceText(evt),
  };
}
