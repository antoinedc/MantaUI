// endpointAttempts.mjs — the attempt-lifecycle store (endpoint-health spec §4).
//
// W2/W3 of the endpoint-health epic (BET-1534): every dispatched operation
// (runSynchronousSession) writes exactly one operation record (§4.1) and every
// observed model outcome writes one provider attempt (§4.2). The causative
// assistant message is captured BEFORE session deletion (D7) and classified
// with the status buckets of W3 — the cause is never discarded again (D6).
//
// All records persist to statePath("endpoint-attempts.json") — a top-level
// state file like auth.json, keyed by shared/endpointKey identity. Per endpoint
// the store keeps lastSuccessAt, a consecutive-failure streak, and a bounded
// ring of provider attempts (200 entries or 30 days, whichever binds first);
// operation records keep their own bounded ring. Everything downstream
// (registers, statistics, routing) is a projection read in later issues —
// this file only writes the raw evidence.
//
// Conventions inherited from ctoStores.mjs: atomic writes, `v` schema stamp
// (§13.2 — a NEWER schema throws loudly and is never destroyed), patchStore
// as the only read-modify-write path. One deliberate delta: a CORRUPT payload
// is quarantined aside and rebuilt empty with an alarm row (W7.3 reads the
// ledger), because an unreadable attempt store must never wedge the runner.

import { randomUUID } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { classifyFinish } from "../shared/streamInterpretation.mjs";
import { patchStore, ledgerStore, createQuarantinedJsonStore } from "./ctoStores.mjs";

export const ENDPOINT_ATTEMPTS_VERSION = 1;
export const ATTEMPT_RING_CAP = 200;
export const ATTEMPT_RING_WINDOW_MS = 30 * 86_400_000;
export const ABANDON_GRACE_MS = 60_000;

const ALARM_RATE_LIMIT_MS = 300_000;

const ATTRIBUTIONS = new Set([
  "not-dispatched", "intended", "dispatched-unattributed", "observed",
]);
const STAGES = new Set(["create", "prompt", "poll", "model", "cleanup"]);

export function endpointAttemptsPath() {
  return statePath("endpoint-attempts.json");
}

export function createEndpointAttemptsPayload() {
  return { v: ENDPOINT_ATTEMPTS_VERSION, operations: [], endpoints: {} };
}

// Shape validator: throws on a top-level non-object (corrupt) or a NEWER `v`
// (never silently truncate — §13.2). Missing arrays/objects normalize to empty.
export function validateEndpointAttemptsPayload(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("endpoint-attempts: payload is not an object (corrupt)");
  }
  const v = "v" in data ? data.v : ENDPOINT_ATTEMPTS_VERSION;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`endpoint-attempts: invalid schema version ${JSON.stringify(data.v)}`);
  }
  if (v > ENDPOINT_ATTEMPTS_VERSION) {
    throw new Error(
      `endpoint-attempts: schema version ${v} is newer than the supported version ` +
        `${ENDPOINT_ATTEMPTS_VERSION} — refusing to read (never silently truncate)`,
    );
  }
  return {
    v: ENDPOINT_ATTEMPTS_VERSION,
    operations: Array.isArray(data.operations) ? data.operations : [],
    endpoints: data.endpoints && typeof data.endpoints === "object" && !Array.isArray(data.endpoints)
      ? data.endpoints
      : {},
  };
}

// Bounded ring (W2): "200 entries or 30 days, whichever binds first". Keeps
// the newest entries (append order is chronological) after dropping anything
// older than the window.
export function capAttemptRing(entries, { nowMs, cap = ATTEMPT_RING_CAP, windowMs = ATTEMPT_RING_WINDOW_MS } = {}) {
  const cutoff = nowMs - windowMs;
  const fresh = entries.filter((e) => {
    const t = e?.at ?? e?.startedAt;
    return typeof t !== "number" || t >= cutoff;
  });
  return fresh.length > cap ? fresh.slice(fresh.length - cap) : fresh;
}

// §4.4 — which provider failures are health-eligible (may increment the
// streak). Aborts, content filters, output caps and refusals say the endpoint
// answered or the content was refused — none of that is the endpoint's state.
export function isHealthEligibleFailure(attempt) {
  if (!attempt || attempt.outcome !== "failure") return false;
  if (attempt.errorName === "MessageAbortedError" || attempt.errorName === "ContentFilterError") return false;
  if (!attempt.errorName && attempt.finish) {
    const f = String(attempt.finish).toLowerCase().replaceAll("-", "_");
    if (classifyFinish(f)) return false; // output/context caps
    if (f === "content_filter" || f === "refusal") return false;
  }
  return true;
}

// Pure reducer: fold one provider attempt into the per-endpoint aggregates.
// Probe attempts (W8/BET-1536) are recorded in the ring as evidence but NEVER
// move the aggregates — probe evidence is weaker than production evidence, so
// it must not reset a streak (a probe success) nor drive `dead` (a probe
// failure). The health register derives identically, so a reload can never
// disagree with the live fold.
export function applyAttempt(attempt, endpoint) {
  const next = {
    ...(endpoint ?? {}),
    attempts: [...(Array.isArray(endpoint?.attempts) ? endpoint.attempts : [])],
  };
  if (attempt?.probe === true) {
    // Probe rows are evidence only — the aggregates keep their shape but
    // never move.
    next.failureStreak = typeof next.failureStreak === "number" ? next.failureStreak : 0;
    return next;
  }
  if (attempt.outcome === "success") {
    next.lastSuccessAt = attempt.at;
    next.failureStreak = 0;
  } else {
    // Any failure keeps the streak a number: health-eligible ones increment
    // it (§4.4), ineligible ones leave it untouched — neither resets it, only
    // a success does.
    const prev = typeof endpoint?.failureStreak === "number" ? endpoint.failureStreak : 0;
    next.failureStreak = isHealthEligibleFailure(attempt) ? prev + 1 : prev;
  }
  return next;
}

// §4.3 self-terminalizing: records past `deadlineAt + grace` with no terminal
// are closed as `abandoned` — an outcome, not a deletion, and being
// unattributed it excludes nothing.
export function abandonExpiredOperations(operations, { nowMs, graceMs = ABANDON_GRACE_MS } = {}) {
  let changed = false;
  const swept = operations.map((op) => {
    if (op?.terminal || typeof op?.deadlineAt !== "number") return op;
    if (nowMs <= op.deadlineAt + graceMs) return op;
    changed = true;
    return { ...op, terminal: { at: nowMs, code: "abandoned", stage: null } };
  });
  return { operations: swept, changed };
}

// ---------------------------------------------------------------------------
// Store — load (quarantine on corruption) + save, over a path-keyed mutex.
// ---------------------------------------------------------------------------

export function createEndpointAttemptsStore({
  path = endpointAttemptsPath(),
  ledger = ledgerStore,
  warn = (msg) => console.warn(msg),
  now = Date.now,
} = {}) {
  // The load/quarantine/alarm/save dance is the SHARED quarantined-store
  // factory in ctoStores.mjs (one contract, one quarantine semantics); this
  // wrapper only supplies the attempts schema and alarm kind.
  return createQuarantinedJsonStore({
    path,
    name: "endpoint-attempts",
    createPayload: createEndpointAttemptsPayload,
    validate: validateEndpointAttemptsPayload,
    alarmKind: "cto.endpoint_attempts_quarantined",
    ledger,
    warn,
    now,
  });
}

// ---------------------------------------------------------------------------
// Recorder — the runner-facing API. Every method is guarded: a persistence
// failure must never skip cleanup, never change what the caller sees, and
// never be silent (W7.3 reads the alarm rows).
// ---------------------------------------------------------------------------

export function createEndpointAttemptRecorder({
  store = createEndpointAttemptsStore(),
  now = Date.now,
  ledger = ledgerStore,
  warn = (msg) => console.warn(msg),
  onAttempt = null,
} = {}) {
  let lastPersistAlarm = -Infinity;

  function persistFailed(operation, e) {
    warn(`[endpoint-attempts] persist failed (${operation}): ${e?.message ?? e}`);
    if (now() - lastPersistAlarm < ALARM_RATE_LIMIT_MS) return;
    lastPersistAlarm = now();
    try {
      void ledger
        .append({ actor: "cto", ts: now(), kind: "cto.endpoint_attempts_persist_failed", operation })
        .catch(() => {});
    } catch { /* best-effort */ }
  }

  // §4.1 skeleton at dispatch start: written immediately so a killed server
  // leaves something the sweep can terminalize as `abandoned`. Attribution
  // starts as "not-dispatched" and is refined at terminalize. `probe: true`
  // (W8, BET-1536) marks a health probe's operation so downstream consumers
  // (register statistics, class watchers) can exclude probe evidence.
  async function beginOperation({ attemptId, operation, startedAt, deadlineAt, intendedEndpointKey = null, probe = false }) {
    try {
      await patchStore(store, (fresh) => {
        const ops = Array.isArray(fresh?.operations) ? fresh.operations : [];
        if (ops.some((op) => op?.attemptId === attemptId)) return {};
        return {
          operations: capAttemptRing(
            [...ops, {
              attemptId, operation, startedAt, deadlineAt,
              intendedEndpointKey: intendedEndpointKey || null,
              attribution: "not-dispatched",
              ...(probe ? { probe: true } : {}),
            }],
            { nowMs: now() },
          ),
        };
      });
    } catch (e) {
      persistFailed("begin", e);
    }
  }

  // First-writer-wins on attemptId (§4.3 idempotency): a duplicate delivery or
  // a racing sweep is dropped, not merged.
  async function terminalizeOperation({ attemptId, attribution, terminal, cleanupCode }) {
    // BET-1537 (§W7.3): an operation that settles while its attribution is
    // STILL "not-dispatched" never reached a provider — one discrete loss
    // event. The row feeds the infrastructure watcher's sustained-rate signal.
    let settledAttribution = null;
    try {
      await patchStore(store, (fresh) => {
        const ops = Array.isArray(fresh?.operations) ? fresh.operations : [];
        const i = ops.findIndex((op) => op?.attemptId === attemptId);
        if (i === -1) return {}; // begin never landed; nothing to terminalize
        if (ops[i].terminal) return {}; // first writer wins
        const settled = {
          ...ops[i],
          ...(ATTRIBUTIONS.has(attribution) ? { attribution } : {}),
          terminal: { at: terminal?.at ?? now(), code: terminal?.code ?? "unknown-error",
            ...(terminal?.stage && STAGES.has(terminal.stage) ? { stage: terminal.stage } : {}) },
          ...(cleanupCode ? { cleanupCode } : {}),
        };
        const next = [...ops];
        next[i] = settled;
        settledAttribution = settled.attribution;
        return { operations: next };
      });
    } catch (e) {
      persistFailed("terminalize", e);
    }
    if (settledAttribution === "not-dispatched") {
      try {
        void ledger
          .append({ actor: "cto", ts: now(), kind: "cto.operation_not_dispatched", operation: attemptId })
          .catch(() => {});
      } catch { /* best-effort — the loss row must never break the caller */ }
    }
  }

  // Refine the in-flight skeleton the moment the prompt POST is attempted, so
  // a killed server's abandoned record states whether the request left for a
  // provider (§4.1's attribution table). First writer wins; best-effort.
  async function markDispatched(attemptId, pinned) {
    try {
      await patchStore(store, (fresh) => {
        const ops = Array.isArray(fresh?.operations) ? fresh.operations : [];
        const i = ops.findIndex((op) => op?.attemptId === attemptId);
        if (i === -1 || ops[i].terminal) return {};
        const next = [...ops];
        next[i] = { ...ops[i], attribution: pinned ? "intended" : "dispatched-unattributed" };
        return { operations: next };
      });
    } catch (e) {
      persistFailed("dispatched", e);
    }
  }

  async function recordProviderAttempt(attempt) {
    if (!attempt?.endpointKey) return; // no identity → never key an attempt
    let persisted = false;
    try {
      await patchStore(store, (fresh) => {
        const endpoints = (fresh && typeof fresh.endpoints === "object" && !Array.isArray(fresh.endpoints))
          ? fresh.endpoints : {};
        const key = attempt.endpointKey;
        const prev = endpoints[key] && typeof endpoints[key] === "object" ? endpoints[key] : {};
        const attempts = Array.isArray(prev.attempts) ? prev.attempts : [];
        if (attempts.some((a) => a?.attemptId === attempt.attemptId)) return {}; // idempotent
        persisted = true;
        const ring = capAttemptRing([...attempts, attempt], { nowMs: now() });
        const settled = applyAttempt(attempt, { ...prev, attempts });
        settled.attempts = ring;
        return { endpoints: { ...endpoints, [key]: settled } };
      });
    } catch (e) {
      persistFailed("attempt", e);
    }
    // Post-persist hook (W4/BET-1536): the health registers fold the attempt
    // AFTER the evidence is durable — and only ONCE (a duplicate delivery
    // took the idempotent no-op branch above and must not double-fold
    // downstream). Guarded — a health failure must never break the recorder
    // contract.
    if (persisted && typeof onAttempt === "function") {
      try {
        await onAttempt(attempt);
      } catch (e) {
        persistFailed("onAttempt", e);
      }
    }
  }

  // The store sweep's hook: close abandoned operation records.
  async function sweepAbandoned({ nowMs = now() } = {}) {
    // BET-1537 (§W7.3): every closure here is an abandoned outcome — the
    // batch lands as ONE weighted row for the infrastructure watcher's
    // sustained-rate signal.
    let closed = 0;
    try {
      await patchStore(store, (fresh) => {
        const ops = Array.isArray(fresh?.operations) ? fresh.operations : [];
        const { operations, changed } = abandonExpiredOperations(ops, { nowMs });
        if (!changed) return {};
        closed = operations.length - ops.filter((o) => o?.terminal).length;
        return { operations };
      });
    } catch (e) {
      persistFailed("sweep", e);
    }
    if (closed > 0) {
      try {
        void ledger
          .append({ actor: "cto", ts: now(), kind: "cto.operations_abandoned", count: closed })
          .catch(() => {});
      } catch { /* best-effort */ }
    }
  }

  return {
    beginOperation, markDispatched, terminalizeOperation, recordProviderAttempt, sweepAbandoned,
    // The engine's read path (W4/BET-1536) reads the durable aggregates —
    // expose the store so callers never reach into closure state.
    store,
  };
}

// An ordinary session's failed assistant turn → a provider attempt for the
// health registers (2026-09-25: a CTO turn 429'd 37 times on an exhausted
// plan, and the registers — fed only by the server's own internal runs —
// still reported the endpoint healthy). Only account-level refusals (402
// out of credit, 429 usage/rate limit) are folded; anything else is left to
// the existing paths. Idempotent per assistant message id. The retry hint
// comes from Retry-After / the provider's reset headers when present. Pure.
export function attemptFromAssistantError(info, nowMs = Date.now()) {
  const err = info?.error;
  const status = err?.data?.statusCode;
  if (info?.role !== "assistant" || !err || (status !== 429 && status !== 402)) return null;
  const providerID = info.providerID;
  const modelID = info.modelID;
  if (typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) return null;
  if (typeof info.id !== "string" || !info.id) return null;
  const h = err?.data?.responseHeaders && typeof err.data.responseHeaders === "object" ? err.data.responseHeaders : {};
  let retryAfterMs;
  const ra = Number(h["retry-after"]);
  if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
  for (const k of ["x-codex-primary-reset-after-seconds", "x-ratelimit-reset-requests", "anthropic-ratelimit-unified-reset"]) {
    const v = Number(h[k]);
    if (retryAfterMs === undefined && Number.isFinite(v) && v > 0 && v < 1e8) retryAfterMs = v * 1000;
  }
  return {
    attemptId: `observed:${info.id}`,
    endpointKey: `${providerID}/${modelID}`,
    accountKey: providerID,
    at: nowMs,
    attribution: "observed",
    outcome: "failure",
    errorName: typeof err.name === "string" ? err.name : null,
    httpStatus: status,
    retryable: err?.data?.isRetryable ?? null,
    finish: null,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

// The singleton's LATE-BOUND health hook: the health engine is composed in
// index.mjs AFTER this module loads, so the composition root registers the
// fold here. One setter, one wiring point; a test recorder injects `onAttempt`
// directly instead.
let singletonOnAttempt = null;
export function setOnProviderAttempt(fn) {
  singletonOnAttempt = typeof fn === "function" ? fn : null;
}

// Process singleton for the runner default. Tests inject their own recorder.
export const endpointAttempts = createEndpointAttemptRecorder({
  onAttempt: (attempt) => (singletonOnAttempt ? singletonOnAttempt(attempt) : undefined),
});

export function newAttemptId() {
  return randomUUID();
}
