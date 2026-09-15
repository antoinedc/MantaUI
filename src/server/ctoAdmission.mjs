// ctoAdmission.mjs — the durable per-CTO conversation admission queue
// (unified-cto-spec §8.3, P3a2).
//
// ALL prompts to the CTO role session — desktop/native CEO submissions and
// background synthesis alike — pass through this ONE server-owned seam. The
// service owns a durable queue (ctoStores.admissionStore, strict) and admits
// at most one turn at a time into the role session resolved from the P3a1
// binding AT DISPATCH TIME (never at submit time). Ordinary project delivery
// is untouched: promptDelivery keeps its own in-memory engine for webhooks,
// schedules, peers and capability jobs; admission shares only its BUSY VIEW
// (production passes promptDelivery.isBusy) and sits on the same firehose
// tap (observeEvent, same event shapes).
//
// EXPLICIT STATE MATRIX (keep simple; no generic framework):
//
//   queued ──dispatch(persist intent)──▶ dispatching ──204+receipt──▶ accepted
//      │                                     │                          │
//      │                 4xx refusal ─▶ failed│ deadline/5xx/invisible    │
//      │                                     ▼        └──▶ unknown       │
//      │                                  unknown ──receipt found──▶ accepted
//      │                                     │  ▲
//      ├─interrupt─▶ cancelled               └─┐│ (reconcile keeps checking;
//      │  (never dispatched: safe)             │|  receipt found ⇒ accepted)
//      │                                       ▼|
//      └──────────────────────────▶ cancel_requested (NONTERMINAL: the POST
//                                    may still be landing — barrier held; a
//                                    found receipt flips it to accepted with
//                                    cancelRequested retained)
//
//   accepted ──interrupt──▶ interrupt_pending (NONTERMINAL barrier)
//                 abort ok + session confirmed idle (terminal event or
//                 transcript proof) ─▶ interrupted; abort
//                 unsupported/failed/timeout/restart RETAINS interrupt_pending
//
//   accepted ──receipt-specific reconciliation──▶ completed
//   (ONLY a transcript proof: our user message + the LAST assistant row whose
//   parentID == our messageID carrying a TERMINAL finish via the shared
//   assistantCompletion helper. A session.idle/error EVENT triggers that
//   reconciliation — it never blindly completes; a stale/idle event for an
//   unrelated turn cannot release the queue.)
//
// The invariants this module exists for:
//
// 1. DURABLE BEFORE SEND. Stable ID + canonical request hash (agent, text,
//    model, origin — key-order canonical) + expected binding generation are
//    persisted before anything is sent; the dispatched sessionId + allocated
//    opencode messageID persist BEFORE the POST. A crash never loses the
//    reconciliation identity.
// 2. ONE TURN AT A TIME. No dispatch while any record is unresolved
//    (dispatching / accepted / unknown / cancel_requested / interrupt_pending).
//    Human FIFO outranks queued background — re-verified AT CLAIM TIME under
//    the store mutex, so a human arriving while the pump awaited the binding
//    still wins before the dispatch commits. An accepted turn is never
//    reordered.
// 3. ACK IS NOT COMPLETION. prompt_async's 204 (plus the P0-proven messageID
//    receipt) only proves ACCEPTANCE. See the matrix for what completes.
// 4. NO BLIND RESEND. reconcile() reads the messageID receipt back: found →
//    accepted (never resent); absent → stays unknown/cancel_requested
//    (surfaced, barrier held). Only a definitive 4xx observed live proves
//    non-acceptance ("failed"). Aborting the client request does NOT prove
//    the server didn't accept — a deadline hit preserves unknown.
// 5. TERMINAL RECEIPTS RETAINED FOREVER. completed / failed / cancelled /
//    interrupted records are never evicted; growth is bounded by refusing NEW
//    submissions at MAX_ENTRIES — never by pruning receipts.
// 6. NO STORE LOCK ACROSS OPENCODE AWAITS. Every store transition is a short
//    patchStore section with a sync mutator; binding resolution, sends and
//    receipt reads happen OUTSIDE the lock. Mutations are serialized by the
//    store mutex + from-status CAS, and each dispatch holds an in-memory
//    active-operation lease so reconcile never touches the send it (or
//    another engine instance) is currently awaiting.
// 7. EXPLICIT INTERRUPTION. interrupt is its own operation; submit NEVER
//    aborts a running turn (a busy session simply holds the queue).
//
// Cross-process: single-writer-process design (one manta-server per box
// composes one admission engine), mirroring ctoBinding.mjs. The patchStore
// CAS narrows but does not guarantee multi-writer safety.
//
// NOT in scope here (parent phases wire them): routes/UI, the poller that
// calls tick(), routine work-event entries that need no model turn, and any
// resend/resubmit operation. See docs/cto-admission-contract.md.

import { createHash, randomUUID } from "node:crypto";

import { admissionStore, patchStore } from "./ctoStores.mjs";
import { assistantCompletion } from "./ctoRunOutcome.mjs";

// ---------------------------------------------------------------------------
// Public constants + error type (the stable contract surface)
// ---------------------------------------------------------------------------

export const ORIGINS = Object.freeze(["human", "background"]);

// Lifecycle. "dispatching" is the crash-window marker: persisted before the
// POST, resolved by reconcile() after a restart. "unknown" is the
// cannot-prove-acceptance state. "cancel_requested" / "interrupt_pending" are
// the NONTERMINAL request markers from blocker 2: a caller's cancel/interrupt
// request is VISIBLE but never erases a possibly-landed POST — the barrier
// holds until reconciliation proves the outcome.
export const STATUSES = Object.freeze([
  "queued",
  "dispatching",
  "accepted",
  "completed",
  "failed",
  "unknown",
  "cancel_requested",
  "interrupt_pending",
  "cancelled",
  "interrupted",
]);

// Statuses that hold the one-turn-at-a-time gate: while any of these exist
// the admit loop must not dispatch another submission.
const UNRESOLVED = new Set([
  "dispatching",
  "accepted",
  "unknown",
  "cancel_requested",
  "interrupt_pending",
]);

// Terminal receipts. Retained forever (invariant 5); never re-dispatched.
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export const MAX_ENTRIES = 500;
export const DEFAULT_REQUEST_DEADLINE_MS = 15_000;
export const RECEIPT_READ_ATTEMPTS = 3;
export const RECEIPT_READ_BACKOFF_MS = 150;
export const UNKNOWN_STALE_MS = 60_000;
export const TURN_RECHECK_INTERVAL_MS = 10_000;

export class CtoAdmissionError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "CtoAdmissionError";
    this.code = code;
  }
}

const describeErr = (err) => String(err?.message ?? err);
const noopSleep = async () => {};

/** Key-order-canonical JSON (sorted object keys, arrays in order). */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Canonical request hash: sha256 over a stable encoding of EVERY semantic
 * request field (origin, text, model, agent) with key-order canonicalization,
 * so a caller that re-serializes its model object with reordered keys still
 * replays idempotently. Same ID + same hash = same submission; same ID + a
 * different hash (e.g. a different agent) is a caller error.
 */
export function canonicalRequestHash({ origin, text, model, agent } = {}) {
  return createHash("sha256")
    .update(stableStringify({ agent: agent ?? null, model: model ?? null, origin, text }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Record normalization — strict, like the binding store: a shape violation is
// corruption (fail loudly), never silently reinterpreted.
// ---------------------------------------------------------------------------

function invalidRecord(what, value) {
  return new CtoAdmissionError(
    `admission store payload has invalid ${what}: ${JSON.stringify(value)}`,
    "invalid-state",
  );
}

function assertStr(value, label) {
  if (typeof value !== "string" || value.length === 0) throw invalidRecord(label, value);
  return value;
}

export function normalizeAdmissionPayload(payload) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const submissions = p.submissions ?? [];
  if (!Array.isArray(submissions)) throw invalidRecord("submissions", p.submissions);
  const seen = new Set();
  return {
    v: 1,
    submissions: submissions.map((raw, index) => {
      const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const id = assertStr(r.id, `submissions[${index}].id`);
      if (seen.has(id)) throw invalidRecord(`submissions[${index}] (duplicate id)`, id);
      seen.add(id);
      if (!ORIGINS.includes(r.origin)) throw invalidRecord(`submissions[${index}].origin`, r.origin);
      assertStr(r.text, `submissions[${index}].text`);
      assertStr(r.payloadHash, `submissions[${index}].payloadHash`);
      if (!STATUSES.includes(r.status)) throw invalidRecord(`submissions[${index}].status`, r.status);
      if (!Number.isInteger(r.createdAt) || r.createdAt < 0) {
        throw invalidRecord(`submissions[${index}].createdAt`, r.createdAt);
      }
      if (!Number.isInteger(r.submitGeneration) || r.submitGeneration < 0) {
        throw invalidRecord(`submissions[${index}].submitGeneration`, r.submitGeneration);
      }
      // Every dispatched-or-later record carries its resolved target + the
      // P0-receipt identity it was sent under (crash reconciliation needs
      // BOTH, which is why dispatch persists them before the POST).
      if (r.status !== "queued" && r.status !== "cancelled") {
        assertStr(r.sessionId, `submissions[${index}].sessionId (required once dispatched)`);
        assertStr(r.messageID, `submissions[${index}].messageID (required once dispatched)`);
      }
      return r;
    }),
  };
}

// ---------------------------------------------------------------------------
// Transcript row readers — tolerant of both wire shapes (flat opencode message
// rows and the {info, parts} wrapper the HTTP layer returns).
// ---------------------------------------------------------------------------

function rowInfo(m) {
  return m?.info && typeof m?.info === "object" ? m.info : m;
}

function rowId(m) {
  const id = m?.id ?? m?.info?.id;
  return typeof id === "string" ? id : null;
}

function rowRole(m) {
  const r = m?.role ?? m?.info?.role;
  return typeof r === "string" ? r.toLowerCase() : "";
}

function rowParentId(m) {
  const p = m?.parentID ?? m?.parentid ?? m?.info?.parentID ?? m?.info?.parentid;
  return typeof p === "string" ? p : null;
}

/**
 * Transcript proof that OUR turn finished (blocker 1): the LAST assistant row
 * LINKED to our user message via parentID == the submitted messageID whose
 * finish classifies terminal via the shared `assistantCompletion` helper.
 * Intermediate assistant rows (tool steps, finish "tool_use") and UNLINKED
 * assistant rows are never proof; a running linked row is never proof.
 * Messages are ascending (oldest first). Returns:
 *   { completed: true, via: "transcript", outcome }  — terminal proof
 *   { completed: false }                             — running / no linked row
 *   null                                             — receipt not visible yet
 */
export function turnCompletionFromTranscript(messages, userMessageId) {
  const rows = Array.isArray(messages) ? messages : [];
  const start = rows.findIndex((m) => rowRole(m) === "user" && rowId(m) === userMessageId);
  if (start === -1) return null;
  let lastLinked = null;
  for (let i = start + 1; i < rows.length; i += 1) {
    if (rowRole(rows[i]) !== "assistant") continue;
    if (rowParentId(rows[i]) !== userMessageId) continue; // unlinked: not our turn
    lastLinked = rows[i];
  }
  if (!lastLinked) return { completed: false };
  const completion = assistantCompletion(rowInfo(lastLinked));
  return completion !== null
    ? { completed: true, via: "transcript", outcome: completion }
    : { completed: false };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Build the durable CTO conversation admission service.
 *
 * @param {object} deps
 * @param {{ getBinding: () => Promise<{generation:number, currentSessionId:string|null}> }} deps.binding
 *        The P3a1 binding service. Dispatch resolves the CURRENT binding at
 *        dispatch time; submit resolves it only for NEW records (a dedup
 *        replay never touches the binding — blocker 6).
 * @param {(args:{sessionId:string, text:string, model?:object, agent?:string, messageID:string, signal?:AbortSignal})=>Promise<unknown>} deps.sendPrompt
 *        The opencode prompt injector. Production: opencode.mjs sendPrompt,
 *        which (P3a2) propagates the signal through the directory gate AND
 *        the actual POST (bounded headers/body). Aborting the client request
 *        does NOT prove the server didn't accept — classified unknown.
 * @param {(sessionId:string, messageId:string)=>Promise<object|null>} deps.getMessage
 *        Single-message receipt read (production: opencode.mjs getMessage).
 *        null = not visible / read failed — never proof of absence.
 * @param {(sessionId:string)=>Promise<Array>} [deps.listMessages]
 *        Transcript read for receipt-specific reconciliation (production:
 *        opencode.mjs listMessages). Absent → event-driven completion is
 *        impossible and the record stays accepted (barrier held).
 * @param {(sessionId:string)=>Promise<void>} [deps.abortSession]
 *        Explicit interrupt of an accepted turn (production: opencode.mjs
 *        abortSession). Absent → interrupt stays interrupt_pending (barrier).
 * @param {(sessionId:string)=>boolean} [deps.isBusy]
 *        Shared busy view (production: promptDelivery.isBusy). Absent → an
 *        internal firehose-derived busy set is used instead.
 * @param {object} [deps.store] admission store (default ctoStores.admissionStore, strict)
 * @param {Function} [deps.now] @param {Function} [deps.newId] @param {Function} [deps.sleep]
 * @param {number} [deps.requestDeadlineMs] Bounded wait for every oc call.
 * @param {number} [deps.receiptReadAttempts] @param {number} [deps.receiptReadBackoffMs]
 * @param {number} [deps.unknownStaleMs] list() flags unknown records older than this.
 * @param {number} [deps.turnRecheckIntervalMs] Min spacing of transcript-based
 *        turn-completion rechecks per accepted record.
 * @param {number} [deps.maxEntries] Hard cap on total records.
 * @returns {{ submit, list, tick, reconcile, interrupt, observeEvent }}
 */
export function createCtoAdmission({
  binding,
  sendPrompt,
  getMessage,
  listMessages = null,
  abortSession = null,
  isBusy = null,
  store = admissionStore,
  now = () => Date.now(),
  newId = () => randomUUID(),
  sleep = noopSleep,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
  receiptReadAttempts = RECEIPT_READ_ATTEMPTS,
  receiptReadBackoffMs = RECEIPT_READ_BACKOFF_MS,
  unknownStaleMs = UNKNOWN_STALE_MS,
  turnRecheckIntervalMs = TURN_RECHECK_INTERVAL_MS,
  maxEntries = MAX_ENTRIES,
} = {}) {
  if (!binding || typeof binding.getBinding !== "function") {
    throw new Error("createCtoAdmission requires a binding service with getBinding");
  }
  if (typeof sendPrompt !== "function" || typeof getMessage !== "function") {
    throw new Error("createCtoAdmission requires sendPrompt and getMessage");
  }

  // Firehose-derived busy set — the fallback when no shared isBusy is wired.
  const busySessions = new Set();
  // sessionId → submissionId currently dispatched/accepted on that session.
  // Hydrated at construction so a restart-mid-turn still observes its record.
  const acceptedBySession = new Map();
  // submissionId → the operation this instance currently awaits ("dispatch").
  // Lease: reconcile never touches a record whose dispatch is in flight.
  const activeOps = new Map();
  // submissionId → last transcript-based turn-completion check (ms epoch).
  const turnCheckedAt = new Map();

  function busyCheck(sessionId) {
    return isBusy ? isBusy(sessionId) : busySessions.has(sessionId);
  }

  async function loadStore() {
    return normalizeAdmissionPayload(await store.load());
  }

  function wrapStoreError(err, op) {
    if (err instanceof CtoAdmissionError) throw err;
    throw new CtoAdmissionError(
      `admission store unavailable during ${op}: ${describeErr(err)}`,
      "store-unavailable",
      { cause: err },
    );
  }

  /** Sync CAS body over a fresh payload; returns a patch, or {} on CAS loss. */
  function casSubmission(fresh, id, mutate) {
    const submissions = [...fresh.submissions];
    const index = submissions.findIndex((r) => r.id === id);
    if (index === -1) return {};
    const next = mutate({ ...submissions[index] });
    if (next === null) return {}; // CAS lost / no-op
    submissions[index] = next;
    return { submissions };
  }

  // Hydrate the in-memory dispatch map so late terminal events still land.
  void loadStore()
    .then((fresh) => {
      for (const r of fresh.submissions) {
        if ((r.status === "accepted" || r.status === "dispatching" || r.status === "interrupt_pending") && r.sessionId) {
          acceptedBySession.set(r.sessionId, r.id);
        }
      }
    })
    .catch(() => {}); // health surfaces through the first real operation

  // -------------------------------------------------------------------------
  // Bounded oc wait: the deadline bounds how long admission WAITS and drives
  // the unknown classification; the signal is passed through for transports
  // that support real cancellation (opencode.mjs sendPrompt propagates it
  // through the directory gate AND the POST). A deadline hit — including an
  // aborted client request — is uncertainty, never a definitive refusal.
  // -------------------------------------------------------------------------
  async function bounded(run, label) {
    const signal = AbortSignal.timeout(requestDeadlineMs);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new CtoAdmissionError(`${label} exceeded its ${requestDeadlineMs}ms deadline`, "deadline-exceeded")),
        requestDeadlineMs,
      );
    });
    const runPromise = Promise.resolve()
      .then(() => run(signal))
      .finally(() => clearTimeout(timer));
    runPromise.catch(() => {}); // a losing-side failure is not unhandled
    try {
      return await Promise.race([runPromise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readReceiptUntilVisible(sessionId, messageID) {
    for (let attempt = 0; attempt < receiptReadAttempts; attempt += 1) {
      if (attempt > 0) await sleep(receiptReadBackoffMs);
      const row = await bounded(() => getMessage(sessionId, messageID), `receipt read (${messageID})`);
      if (row) return row;
    }
    return null;
  }

  /** CAS status transition under the store mutex. from: required prior status. */
  async function markTransition(id, from, status, extra = {}) {
    try {
      let updated = null;
      await patchStore(store, (fresh) => {
        const patch = casSubmission(normalizeAdmissionPayload(fresh), id, (r) => {
          if (r.status !== from) return null;
          updated = { ...r, status, ...extra };
          return updated;
        });
        return patch;
      });
      if (updated) onTransition(updated);
      return updated;
    } catch (err) {
      console.warn(`[ctoAdmission] transition of ${id} to ${status} failed:`, describeErr(err));
      return null;
    }
  }

  function onTransition(record) {
    if (
      (record.status === "accepted" || record.status === "interrupt_pending" || record.status === "dispatching") &&
      record.sessionId
    ) {
      acceptedBySession.set(record.sessionId, record.id);
    }
    if (TERMINAL.has(record.status) && record.sessionId) {
      if (acceptedBySession.get(record.sessionId) === record.id) acceptedBySession.delete(record.sessionId);
      turnCheckedAt.delete(record.id);
      // The session just freed (or the entry was cancelled): the queue may
      // proceed. Fire-and-forget; pump is single-flight and never rejects.
      if (record.status === "completed" || record.status === "interrupted") void pump();
    }
  }

  // -------------------------------------------------------------------------
  // submit — validate, DEDUP FIRST (a replay of an existing id succeeds even
  // after a binding replacement — blocker 6), then generation-validate and
  // persist new records. Never sends from here.
  // -------------------------------------------------------------------------
  async function submit({ text, origin, id, model, expectedGeneration, agent } = {}) {
    if (typeof text !== "string" || text.length === 0) {
      throw new CtoAdmissionError("submit requires a non-empty text", "invalid-argument");
    }
    if (!ORIGINS.includes(origin)) {
      throw new CtoAdmissionError(
        `submit origin must be one of ${ORIGINS.join("|")}`,
        "invalid-argument",
      );
    }
    if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 200)) {
      throw new CtoAdmissionError("submit id must be a non-empty string (≤200 chars)", "invalid-argument");
    }
    if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 0)) {
      throw new CtoAdmissionError("submit expectedGeneration must be a non-negative integer", "invalid-argument");
    }
    if (model !== undefined && (model === null || typeof model !== "object" || Array.isArray(model))) {
      throw new CtoAdmissionError("submit model must be an object when provided", "invalid-argument");
    }
    if (agent !== undefined && (typeof agent !== "string" || agent.length === 0)) {
      throw new CtoAdmissionError("submit agent must be a non-empty string when provided", "invalid-argument");
    }

    const submissionId = id ?? `evt_${newId()}`;
    const payloadHash = canonicalRequestHash({ origin, text, model, agent });

    // Phase A: dedup / at-cap probe. A same-payload replay returns the
    // EXISTING record without ever reading the binding; a different payload
    // under the same id is a caller error.
    let existing = null;
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        existing = normalized.submissions.find((r) => r.id === submissionId) ?? null;
        if (existing && existing.payloadHash !== payloadHash) {
          throw new CtoAdmissionError(
            `duplicate submission id ${submissionId} with a different payload`,
            "duplicate-id-different-payload",
          );
        }
        return {}; // probe only — no write
      });
    } catch (err) {
      wrapStoreError(err, "submit");
    }
    if (existing) {
      void pump();
      return { ...existing, persisted: false };
    }

    // Phase B: new record — binding generation resolved OUTSIDE the lock
    // (invariant 6) and validated only here, never for replays.
    let currentGeneration = 0;
    try {
      currentGeneration = (await binding.getBinding()).generation ?? 0;
    } catch (err) {
      throw new CtoAdmissionError(
        `binding unavailable — refusing to admit against unresolved role identity: ${describeErr(err)}`,
        "binding-unavailable",
        { cause: err },
      );
    }
    if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
      throw new CtoAdmissionError(
        `stale generation: expected ${expectedGeneration}, current binding generation is ${currentGeneration}`,
        "stale-generation",
      );
    }
    let record = null;
    let wrote = false;
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        const raced = normalized.submissions.find((r) => r.id === submissionId);
        if (raced) {
          // A concurrent submit inserted the same id between the phases.
          if (raced.payloadHash !== payloadHash) {
            throw new CtoAdmissionError(
              `duplicate submission id ${submissionId} with a different payload`,
              "duplicate-id-different-payload",
            );
          }
          record = raced; // dedup semantics still apply
          return {};
        }
        if (normalized.submissions.length >= maxEntries) {
          throw new CtoAdmissionError(
            `admission store at cap (${maxEntries} records); terminal receipts are never evicted`,
            "at-cap",
          );
        }
        const created = {
          id: submissionId,
          origin,
          text,
          payloadHash,
          status: "queued",
          createdAt: now(),
          submitGeneration: currentGeneration,
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
          ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
        };
        record = created;
        wrote = true;
        return { submissions: [...normalized.submissions, created] };
      });
    } catch (err) {
      wrapStoreError(err, "submit");
    }
    void pump(); // low-latency dispatch kick; tick() is the deterministic path
    return { ...record, persisted: wrote };
  }

  // -------------------------------------------------------------------------
  // Dispatch (the pump) — single-flight AND joinable; resolves the binding at
  // dispatch time; verifies the priority pick AT CLAIM TIME under the store
  // mutex (blocker 5); persists the dispatch intent BEFORE the POST.
  // -------------------------------------------------------------------------
  let pumping = null;

  function pickNext(submissions) {
    for (const origin of ORIGINS) {
      const found = submissions.find((r) => r.status === "queued" && r.origin === origin);
      if (found) return found;
    }
    return null;
  }

  function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      try {
        for (let guard = 0; guard < 10; guard += 1) {
          const fresh = await loadStore();
          if (fresh.submissions.some((r) => UNRESOLVED.has(r.status))) return;
          const next = pickNext(fresh.submissions);
          if (!next) return;
          // Binding resolved OUTSIDE the lock, at dispatch time (§8.3): a
          // pending submission always targets the CURRENT binding; an
          // accepted turn never moves (its sessionId was fixed at dispatch).
          let target;
          try {
            target = await binding.getBinding();
          } catch (err) {
            console.warn("[ctoAdmission] binding unavailable, holding queue:", describeErr(err));
            return;
          }
          if (!target.currentSessionId) return; // unbound role: submissions stay queued
          if (busyCheck(target.currentSessionId)) return; // busy → hold, never abort
          // NOTE: a submission arriving DURING the await above is re-checked
          // inside dispatch's phase-1 claim (under the store mutex) — a human
          // outranking this pick restarts the loop (blocker 5).
          const dispatched = await dispatch(next, target);
          if (!dispatched) continue; // claim lost (priority/CAS) — reload and retry
          return; // one turn at a time: the next admission waits for its terminal
        }
      } catch (err) {
        console.warn("[ctoAdmission] pump failed:", describeErr(err));
      }
    })();
    return pumping.finally(() => {
      pumping = null;
    });
  }

  /** Returns true when this call performed the dispatch, false on claim loss. */
  async function dispatch(record, target) {
    // Lease taken BEFORE any store mutation: a reconcile that observes the
    // record as "dispatching" must always see the lease (blocker 3 — no
    // window between the phase-1 save and the lease).
    activeOps.set(record.id, "dispatch");
    try {
      return await dispatchInner(record, target);
    } finally {
      if (activeOps.get(record.id) === "dispatch") activeOps.delete(record.id);
    }
  }

  async function dispatchInner(record, target) {
    const messageID = `msg_${newId()}`;
    const sessionId = target.currentSessionId;
    const dispatchGeneration = target.generation ?? 0;
    let proceed = false;
    // Phase 1: persist the dispatch intent BEFORE any external call
    // (invariant 1). The claim re-verifies, UNDER THE STORE MUTEX, that this
    // record is still the correct priority pick — a human that arrived while
    // we awaited the binding wins before the dispatch commits (blocker 5) —
    // and that the record is still "queued" (CAS; also stops two engine
    // instances over one store from double-dispatching).
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        const pick = pickNext(normalized.submissions);
        if (!pick || pick.id !== record.id) return {}; // stale pick → re-select
        return casSubmission(normalized, record.id, (r) => {
          if (r.status !== "queued") return null;
          proceed = true;
          return {
            ...r,
            status: "dispatching",
            sessionId,
            messageID,
            dispatchGeneration,
            dispatchStartedAt: now(),
            retargeted: dispatchGeneration !== r.submitGeneration || undefined,
          };
        });
      });
    } catch (err) {
      wrapStoreError(err, "dispatch"); // loud: a store failure must not stall silently
    }
    if (!proceed) return false;

    // --- external awaits: NO store lock held from here (invariant 6) ---
    acceptedBySession.set(sessionId, record.id);
    let sendError = null;
    try {
      await bounded(
        (signal) =>
          sendPrompt({ sessionId, text: record.text, model: record.model, agent: record.agent, messageID, signal }),
        `sendPrompt (${record.id})`,
      );
    } catch (err) {
      sendError = err;
    }

    if (sendError) {
      acceptedBySession.delete(sessionId);
      // Definitive client-side refusal (4xx) proves non-acceptance. Anything
      // else (network, deadline — including an aborted client request, 5xx)
      // is uncertainty → unknown, never resend (blocker 3).
      const definitive = typeof sendError.status === "number" && sendError.status >= 400 && sendError.status < 500;
      await markTransition(
        record.id,
        "dispatching",
        definitive ? "failed" : "unknown",
        definitive
          ? { failedAt: now(), error: describeErr(sendError), errorStatus: sendError.status }
          : { unknownAt: now(), unknownReason: describeErr(sendError) },
      );
      return true;
    }

    const receipt = await readReceiptUntilVisible(sessionId, messageID);
    if (receipt) {
      await markTransition(record.id, "dispatching", "accepted", { acceptedAt: now() });
    } else {
      // 204 was observed but the receipt is not (yet) visible. This is NOT
      // proof of non-acceptance — mark unknown; reconcile() keeps checking.
      acceptedBySession.delete(sessionId);
      await markTransition(record.id, "dispatching", "unknown", {
        unknownAt: now(),
        unknownReason: "prompt accepted (204) but messageID receipt not visible",
      });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Receipt-specific reconciliation (blockers 1+2): a session.idle/error
  // EVENT triggers a transcript check for THIS record — it never blindly
  // completes. accepted completes ONLY on transcript proof; interrupt_pending
  // settles on the confirmed idle (the explicit abort was honored) or on
  // transcript proof. A stale/idle event for an unrelated turn cannot
  // release the queue.
  // -------------------------------------------------------------------------
  async function transcriptTurnState(record) {
    if (!listMessages || !record.sessionId || !record.messageID) return null;
    try {
      const messages = await bounded(() => listMessages(record.sessionId), `listMessages (${record.sessionId})`);
      return turnCompletionFromTranscript(messages, record.messageID);
    } catch (err) {
      console.warn(`[ctoAdmission] transcript check for ${record.id} failed:`, describeErr(err));
      return null;
    }
  }

  function settleAcceptedForSession(sessionId, kind, error) {
    const id = acceptedBySession.get(sessionId);
    if (!id) return; // hot path: no store read for unrelated sessions
    void (async () => {
      let record = null;
      try {
        const fresh = await loadStore();
        record = fresh.submissions.find((r) => r.id === id) ?? null;
      } catch (err) {
        console.warn("[ctoAdmission] settle load failed:", describeErr(err));
        return;
      }
      if (!record) {
        acceptedBySession.delete(sessionId);
        return;
      }
      if (record.status === "accepted") {
        // Strict: only the transcript proves OUR turn finished.
        const proof = await transcriptTurnState(record);
        if (proof?.completed) {
          await markTransition(record.id, "accepted", "completed", {
            completedAt: now(),
            outcome: { kind, completion: proof.outcome, via: proof.via, at: now() },
          });
          acceptedBySession.delete(sessionId);
        }
        // No proof (running, intermediate tool step, stale/unrelated event,
        // or no transcript transport): the barrier holds; reconcile retries.
        return;
      }
      if (record.status === "interrupt_pending") {
        // Confirmed idle for receipt: the requested abort took effect.
        await markTransition(record.id, "interrupt_pending", "interrupted", {
          confirmedIdleAt: now(),
          outcome: { kind, via: "event", at: now() },
        });
      }
    })();
  }

  // -------------------------------------------------------------------------
  // observeEvent — same firehose tap promptDelivery sits on: busy tracking
  // (fallback when no shared isBusy) + receipt-specific reconciliation of the
  // session's accepted/interrupt_pending record.
  // -------------------------------------------------------------------------
  function observeEvent(evt) {
    const sid = evt?.properties?.sessionID;
    if (typeof sid !== "string" || !sid) return;
    if (evt.type === "session.idle" || evt.type === "session.error") {
      busySessions.delete(sid);
      settleAcceptedForSession(sid, evt.type === "session.error" ? "error" : "idle", evt.properties?.error);
      return;
    }
    if (evt.type === "session.status") {
      const t = evt.properties?.status?.type;
      if (t === "busy" || t === "retry") busySessions.add(sid);
      else if (t === "idle") {
        busySessions.delete(sid);
        settleAcceptedForSession(sid, "idle", null);
      }
    }
  }

  // -------------------------------------------------------------------------
  // reconcile — restart + uncertainty recovery. Joinable single-flight.
  // Records with an active dispatch lease (a send this instance is currently
  // awaiting) are SKIPPED — never raced, never double-classified (blocker 3).
  // NEVER resends: found receipts advance, absent receipts stay put.
  // -------------------------------------------------------------------------
  let reconciling = null;

  function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const fresh = await loadStore();
      for (const record of fresh.submissions) {
        if (activeOps.has(record.id)) continue; // own currently-awaited send
        if (record.status === "dispatching" || record.status === "unknown" || record.status === "cancel_requested") {
          if (!record.sessionId || !record.messageID) continue; // never dispatched
          const row = await readReceiptUntilVisible(record.sessionId, record.messageID);
          if (row) {
            await markTransition(record.id, record.status, "accepted", {
              acceptedAt: record.acceptedAt ?? now(),
              reconciledAt: now(),
              cancelRequested: record.status === "cancel_requested" || undefined,
            });
            acceptedBySession.set(record.sessionId, record.id);
          } else {
            await markTransition(record.id, record.status, record.status === "cancel_requested" ? "cancel_requested" : "unknown", {
              unknownAt: record.unknownAt ?? now(),
              unknownReason: record.unknownReason ?? "acceptance unproven after recovery",
              lastReceiptCheckAt: now(),
              receiptChecks: (record.receiptChecks ?? 0) + 1,
            });
          }
          continue;
        }
        if (record.status === "accepted" || record.status === "interrupt_pending") {
          // No observed terminal event (restart mid-turn, lost event): ask
          // the transcript, spaced per record so a polling tick stays cheap.
          const last = turnCheckedAt.get(record.id) ?? 0;
          if (now() - last < turnRecheckIntervalMs) continue;
          turnCheckedAt.set(record.id, now());
          const proof = await transcriptTurnState(record);
          if (proof?.completed) {
            await markTransition(record.id, record.status, record.status === "accepted" ? "completed" : "interrupted", {
              completedAt: now(),
              outcome: { kind: "reconciled", completion: proof.outcome, via: proof.via, at: now() },
            });
          }
        }
      }
    })();
    return reconciling.finally(() => {
      reconciling = null;
    });
  }

  // -------------------------------------------------------------------------
  // tick — the poller entry: reconcile, then admit.
  // -------------------------------------------------------------------------
  async function tick() {
    await reconcile();
    await pump();
  }

  // -------------------------------------------------------------------------
  // list — the queue projection clients render (§8.3: clients render server
  // queue state instead of draining independently).
  // -------------------------------------------------------------------------
  async function list() {
    try {
      const fresh = await loadStore();
      const t = now();
      return {
        submissions: fresh.submissions.map((r) => {
          const projected = { ...r };
          delete projected.text; // payloads stay out of queue listings
          if (r.status === "unknown" || r.status === "cancel_requested") {
            projected.unknownMs = t - (r.unknownAt ?? r.createdAt);
            projected.staleUnknown = projected.unknownMs > unknownStaleMs || undefined;
          }
          return projected;
        }),
        counts: {
          queued: {
            human: fresh.submissions.filter((r) => r.status === "queued" && r.origin === "human").length,
            background: fresh.submissions.filter((r) => r.status === "queued" && r.origin === "background").length,
          },
          unresolved: fresh.submissions.filter((r) => UNRESOLVED.has(r.status)).length,
          terminal: fresh.submissions.filter((r) => TERMINAL.has(r.status)).length,
        },
      };
    } catch (err) {
      wrapStoreError(err, "list");
    }
  }

  // -------------------------------------------------------------------------
  // interrupt — the EXPLICIT interruption operation (blocker 2). submit never
  // aborts. A request is VISIBLE immediately (cancel_requested /
  // interrupt_pending) but the nonterminal barrier is retained until the
  // outcome is proven: an abort that is unsupported/failed/timed out keeps
  // interrupt_pending, and cancelling an unknown keeps cancel_requested (the
  // possibly-landed POST must not be erased).
  // -------------------------------------------------------------------------
  async function interrupt(submissionId, { reason } = {}) {
    if (typeof submissionId !== "string" || submissionId.length === 0) {
      throw new CtoAdmissionError("interrupt requires a submission id", "invalid-argument");
    }
    let prior = null;
    let resulting = null;
    try {
      await patchStore(store, (fresh) => {
        const patch = casSubmission(normalizeAdmissionPayload(fresh), submissionId, (r) => {
          prior = r;
          if (r.status === "queued") {
            // Never dispatched: nothing can be in flight — safe to cancel.
            resulting = {
              ...r,
              status: "cancelled",
              cancelledAt: now(),
              ...(reason ? { cancelReason: reason } : {}),
            };
            return resulting;
          }
          if (r.status === "unknown") {
            // The POST may still be landing: REQUEST the cancel visibly,
            // retain the barrier; reconcile settles by receipt.
            resulting = {
              ...r,
              status: "cancel_requested",
              cancelRequestedAt: now(),
              ...(reason ? { cancelReason: reason } : {}),
            };
            return resulting;
          }
          if (r.status === "accepted") {
            resulting = {
              ...r,
              status: "interrupt_pending",
              interruptRequestedAt: now(),
              ...(reason ? { interruptReason: reason } : {}),
            };
            return resulting;
          }
          return null; // dispatching / request-markers / terminal: handled below
        });
        return patch;
      });
    } catch (err) {
      wrapStoreError(err, "interrupt");
    }
    if (!prior) {
      throw new CtoAdmissionError(`interrupt: no such submission ${submissionId}`, "not-found");
    }
    if (prior.status === "dispatching") {
      throw new CtoAdmissionError(
        `interrupt: ${submissionId} is mid-dispatch; retry after it resolves`,
        "dispatch-in-flight",
      );
    }
    if (TERMINAL.has(prior.status)) {
      throw new CtoAdmissionError(
        `interrupt: ${submissionId} is already terminal (${prior.status})`,
        "already-terminal",
      );
    }
    // Idempotent re-request of an already-requested cancel/interrupt.
    if (prior.status === "cancel_requested" || prior.status === "interrupt_pending") {
      return { ok: true, id: submissionId, status: prior.status };
    }
    if (prior.status === "accepted") {
      if (typeof abortSession !== "function") {
        // Barrier RETAINED: the request stands but nothing aborted.
        await markTransition(submissionId, "interrupt_pending", "interrupt_pending", {
          abortError: "abort-unsupported: no abortSession transport wired",
        });
        return { ok: true, id: submissionId, status: "interrupt_pending" };
      }
      let abortError;
      try {
        await bounded(() => abortSession(prior.sessionId), `abortSession (${prior.sessionId})`);
      } catch (err) {
        abortError = describeErr(err);
      }
      if (abortError) {
        // Abort failed/timed out: the turn may still be running. RETAIN the
        // nonterminal barrier and surface the failure (blocker 2).
        await markTransition(submissionId, "interrupt_pending", "interrupt_pending", { abortError });
        return { ok: true, id: submissionId, status: "interrupt_pending" };
      }
      // Abort succeeded: interrupt_pending UNTIL the session is confirmed
      // idle (terminal event via observeEvent, or transcript proof via
      // reconcile) — only then does the record become terminal "interrupted".
      return { ok: true, id: submissionId, status: "interrupt_pending" };
    }
    onTransition(resulting);
    return { ok: true, id: submissionId, status: resulting.status };
  }

  return { submit, list, tick, reconcile, interrupt, observeEvent };
}
