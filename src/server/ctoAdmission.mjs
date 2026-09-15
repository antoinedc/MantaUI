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
//   queued ──claim(persist intent)──▶ dispatching ──204+receipt──▶ accepted
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
//     abortState: "pending" (durable request, NO attempt marker — nothing
//                   proved issued) --claim under admission lock--
//                → "claimed" (durable attempt token: attemptId +
//                   attemptStartedAt + attemptCount persisted BEFORE the HTTP
//                   call; no lock across the external await)
//                → "ok" (2xx) | "refused" (4xx) | "uncertain" (deadline /
//                   network) — the owner settles ONLY its matching attemptId
//     recovery: ANY attempted-but-unsettled state ("claimed" with no live
//                   owner) and any "pending" found after a restart downgrade
//                   to "uncertain" — NEVER retried; uncertainty is permanent
//                   (reason abort_outcome_unknown), fail-closed
//     settle: abortState "ok" AND the transcript proves the turn ENDED
//             (last linked assistant row no longer running — finish-agnostic,
//             an aborted row qualifies) ⇒ interrupted;
//             abortState "refused" AND turn ended ⇒ completed (natural finish)
//     an uncertain abort NEVER settles and NEVER releases the queue.
//
//   accepted ──receipt-specific reconciliation──▶ completed
//   (ONLY transcript proof: our user message + the LAST assistant row whose
//   parentID == our messageID carrying a TERMINAL finish via the shared
//   assistantCompletion helper. A session.idle/error EVENT triggers that
//   reconciliation — it never blindly completes; a stale/idle event for an
//   unrelated turn cannot release the queue, and an event NEVER terminalizes
//   an interrupt_pending record whose abort is unresolved.)
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
//    the server didn't accept — a deadline hit preserves unknown. The same
//    rule governs ABORTS: a timed-out/uncertain abort keeps its barrier.
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
//    aborts a running turn (a busy session simply holds the queue). The ABORT
//    is tracked as its own active+durable uncertain state, SEPARATE from the
//    turn's terminal state: same-session admission stays blocked until the
//    abort itself is known-settled (definitive server response), so a late
//    session-wide abort can never kill the NEXT admitted turn.
// 8. LINEARIZABLE CLAIM (blocker 3). The dispatch claim runs through the
//    binding service's `claimGeneration(reserve)` — the reserve callback
    //    executes under the SAME serialized store seam as ensure()/recover(),
//    reads the binding FRESH inside that section, and reserves the admission
//    record against that exact generation (lock order binding → admission;
//    the locks are released BEFORE the external POST). A generation change
//    before the claim is observed (pending work targets current); a change
//    after the claim serializes behind it and the claimed delivery stays on
//    its own session.
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
// the NONTERMINAL request markers: a caller's cancel/interrupt request is
// VISIBLE but never erases a possibly-landed POST or a possibly-landing
// ABORT — the barrier holds until reconciliation proves the outcome.
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

// Abort operation states on an interrupt_pending record (blocker 2 — tracked
// separately from the turn's terminal state):
//   pending   the durable interrupt request exists; NO attempt reservation
//             marker yet (a crash here provably precedes any HTTP: the
//             reservation is persisted BEFORE the call). Recovery treats it
//             as uncertain — fail-closed, no attempt is issued from recovery.
//   claimed   an attempt is RESERVED (durable attemptId + attemptStartedAt +
//             attemptCount written under the admission lock BEFORE the HTTP
//             call) but its outcome is not persisted. After a restart this
//             means attempted-but-unsettled ⇒ uncertain (the HTTP may or may
//             not have been issued / may still land) — never retried.
//   ok        the owner's DEFINITIVE 2xx response for ITS matching attemptId.
//   refused   the owner's definitive 4xx response for its attemptId.
//   uncertain PERMANENT barrier with reason abort_outcome_unknown: the
//             original request's outcome is unknown and monotonic — no new
//             attempt may be issued, no later response may erase it, and
//             same-session admission stays blocked until a future EXPLICIT
//             management operation resolves it (not built here).
export const ABORT_STATES = Object.freeze([
  "pending",
  "claimed",
  "ok",
  "refused",
  "uncertain",
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
// P3a3-review: bounded retention for TERMINAL BACKGROUND receipts. Unique
// per-occurrence ids (sched job+minute keys, webhook/delegate minted ids)
// mean terminal background records accumulate one per delivery forever —
// invariant 5's "retained forever" would wedge the WHOLE conversation at
// MAX_ENTRIES (~500 deliveries: a */5 schedule hits it unattended in under
// two days), refusing even the human's own message with no management op.
// Terminal background receipts past this bound are evicted into compact
// durable TOMBSTONES (id + payloadHash + status) so a genuine same-id retry
// still dedups. Eviction is safe because occurrence identities never recur
// (sched keys embed the full-date minute key; a same-fire retry only re-fires
// through the crash window between sendPrompt and the lastFiredMinute save —
// minutes, not the ~200-delivery horizon). Human receipts are NEVER evicted.
export const MAX_TERMINAL_BACKGROUND = 200;
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
  // Tombstones (P3a3-review): compact durable receipts for evicted terminal
  // background submissions — the dedup identity survives eviction.
  const tombstones = p.tombstones ?? [];
  if (!Array.isArray(tombstones)) throw invalidRecord("tombstones", p.tombstones);
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
      if (r.abortState !== undefined && !ABORT_STATES.includes(r.abortState)) {
        throw invalidRecord(`submissions[${index}].abortState`, r.abortState);
      }
      return r;
    }),
    // Tombstones keep only the dedup identity — never the payload text.
    tombstones: tombstones.map((raw, index) => {
      const t = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return {
        id: assertStr(t.id, `tombstones[${index}].id`),
        payloadHash: assertStr(t.payloadHash, `tombstones[${index}].payloadHash`),
        status: t.status ?? "completed",
        origin: t.origin ?? "background",
        createdAt: Number.isInteger(t.createdAt) ? t.createdAt : 0,
      };
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
 * The LAST assistant row LINKED to our user message via parentID, or null.
 * Shared by the strict-completion and turn-ended readers below.
 */
function lastLinkedAssistantRow(messages, userMessageId) {
  const rows = Array.isArray(messages) ? messages : [];
  const start = rows.findIndex((m) => rowRole(m) === "user" && rowId(m) === userMessageId);
  if (start === -1) return { found: false, row: null };
  let lastLinked = null;
  for (let i = start + 1; i < rows.length; i += 1) {
    if (rowRole(rows[i]) !== "assistant") continue;
    if (rowParentId(rows[i]) !== userMessageId) continue; // unlinked: not our turn
    lastLinked = rows[i];
  }
  return { found: true, row: lastLinked };
}

/**
 * Transcript proof that OUR turn FINISHED (blocker 1): the LAST assistant row
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
  const { found, row } = lastLinkedAssistantRow(messages, userMessageId);
  if (!found) return null;
  if (!row) return { completed: false };
  const completion = assistantCompletion(rowInfo(row));
  return completion !== null
    ? { completed: true, via: "transcript", outcome: completion }
    : { completed: false };
}

/**
 * Weaker, finish-agnostic "did OUR turn END" reader for interrupt_pending
 * records (blocker 2): the last LINKED assistant row is no longer running
 * (time.completed set, or an error) — whatever its finish, an aborted row
 * qualifies. Strict terminal-finish classification stays in
 * turnCompletionFromTranscript for the `accepted` completion path. Returns
 *   { ended: true|false } — or null when the receipt is not visible yet.
 */
export function turnEndedFromTranscript(messages, userMessageId) {
  const { found, row } = lastLinkedAssistantRow(messages, userMessageId);
  if (!found) return null;
  if (!row) return { ended: false };
  const info = rowInfo(row);
  const completed = info?.time?.completed;
  const ended = Number.isFinite(completed) || info?.error != null;
  return { ended };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Build the durable CTO conversation admission service.
 *
 * @param {object} deps
 * @param {{ getBinding: (opts?: object) => Promise<{generation:number, currentSessionId:string|null}>,
 *           claimGeneration: (reserve: (binding: object) => Promise<T>) => Promise<{binding: object, result: T}> }} deps.binding
 *        The P3a1 binding service. Dispatch claims through claimGeneration —
 *        the LINEARIZABLE reservation under the binding store's serialized
 *        seam (blocker 3). submit resolves getBinding only for NEW records
 *        (a dedup replay never touches the binding — blocker 6).
 * @param {(args:{sessionId:string, text:string, model?:object, agent?:string, messageID:string, signal?:AbortSignal})=>Promise<unknown>} deps.sendPrompt
 *        The opencode prompt injector (messageID + bounded signal, P0-proven).
 * @param {(sessionId:string, messageId:string)=>Promise<object|null>} deps.getMessage
 *        Single-message receipt read (production: opencode.mjs getMessage).
 *        null = not visible / read failed — never proof of absence.
 * @param {(sessionId:string)=>Promise<Array>} [deps.listMessages]
 *        Transcript read for receipt-specific reconciliation (production:
 *        opencode.mjs listMessages). Absent → event-driven completion is
 *        impossible and the record stays (barrier held).
 * @param {(sessionId:string, opts?:{signal?:AbortSignal})=>Promise<void>} [deps.abortSession]
 *        Explicit interrupt of an accepted turn (production: opencode.mjs
 *        abortSession — idempotent, signal-capable). Absent → interrupt stays
 *        interrupt_pending (barrier; surfaced abortError) — it never
 *        terminalizes on events alone.
 * @param {(sessionId:string)=>boolean} [deps.isBusy]
 *        Shared busy view (production: promptDelivery.isBusy). Absent → an
 *        internal firehose-derived busy set is used instead.
 * @param {object} [deps.store] admission store (default ctoStores.admissionStore, strict)
 * @param {Function} [deps.now] @param {Function} [deps.newId] @param {Function} [deps.sleep]
 * @param {number} [deps.requestDeadlineMs] Bounded wait for every oc call.
 * @param {number} [deps.receiptReadAttempts] @param {number} [deps.receiptReadBackoffMs]
 * @param {number} [deps.unknownStaleMs] list() flags unknown records older than this.
 * @param {number} [deps.turnRecheckIntervalMs] Min spacing of transcript-based
 *        rechecks and abort re-issues per record.
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
  maxTerminalBackground = MAX_TERMINAL_BACKGROUND,
} = {}) {
  if (!binding || typeof binding.getBinding !== "function" || typeof binding.claimGeneration !== "function") {
    throw new Error(
      "createCtoAdmission requires a binding service with getBinding AND claimGeneration (linearizable claim, blocker 3)",
    );
  }
  if (typeof sendPrompt !== "function" || typeof getMessage !== "function") {
    throw new Error("createCtoAdmission requires sendPrompt and getMessage");
  }

  // Firehose-derived busy set — the fallback when no shared isBusy is wired.
  const busySessions = new Set();
  // sessionId → submissionId currently dispatched/accepted on that session.
  // Hydrated at construction so a restart-mid-turn still observes its record.
  const acceptedBySession = new Map();
  // submissionId → the operation this instance currently awaits ("dispatch"
  // or "abort"). Lease: reconcile never touches a record whose operation is
  // in flight on this instance.
  const activeOps = new Map();
  // submissionId → last transcript-based recheck (ms epoch).
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
  // the classification; the signal is passed through for transports that
  // support real cancellation (opencode.mjs propagates it through the
  // directory gate AND the POST — send AND abort). A deadline hit — including
  // an aborted client request — is UNCERTAINTY, never a definitive refusal
  // (the server may still process it; the timeout waiter is not proof).
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

  /** Same-status field update under the store mutex (no lifecycle change). */
  async function markFields(id, from, extra = {}) {
    return markTransition(id, from, from, extra);
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
    // under the same id is a caller error. Tombstoned (evicted terminal
    // background) ids keep their dedup identity: same payload replays the
    // tombstone, a different payload is still a caller error.
    let existing = null;
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        existing =
          normalized.submissions.find((r) => r.id === submissionId) ??
          normalized.tombstones.find((t) => t.id === submissionId) ??
          null;
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
        if (normalized.submissions.length >= maxEntries) {
          // P3a3-review: before refusing, make room by tombstoning the OLDEST
          // terminal BACKGROUND receipts (their dedup identity survives in
          // the tombstone list). A human submit must NEVER be refused because
          // background receipts filled the store — if nothing evictable
          // remains, the cap refusal is honest (only unresolved/human state
          // fills the store at that point).
          const evictable = normalized.submissions
            .filter((r) => TERMINAL.has(r.status) && r.origin === "background")
            .sort((a, b) => a.createdAt - b.createdAt);
          const needed = normalized.submissions.length + 1 - maxEntries;
          if (evictable.length < needed) {
            throw new CtoAdmissionError(
              `admission store at cap (${maxEntries} records) and nothing evictable ` +
                `(${evictable.length} terminal background receipts) — unresolved/human records hold the gate`,
              "at-cap",
            );
          }
          const evictedIds = new Set(evictable.slice(0, needed).map((r) => r.id));
          const tombstoned = evictable
            .slice(0, needed)
            .map((r) => ({
              id: r.id,
              payloadHash: r.payloadHash,
              status: r.status,
              origin: r.origin,
              createdAt: r.createdAt,
            }));
          const kept = normalized.submissions.filter((r) => !evictedIds.has(r.id));
          // Tombstones are themselves bounded: drop the OLDEST identities —
          // a retry landing after a double eviction creates a fresh record
          // (occurrence identities never recur; see MAX_TERMINAL_BACKGROUND).
          const keptTombstones = [...normalized.tombstones, ...tombstoned].slice(
            -maxTerminalBackground,
          );
          record = created;
          wrote = true;
          return { submissions: [...kept, created], tombstones: keptTombstones };
        }
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
  // Dispatch (the pump) — single-flight AND joinable. The CLAIM is
  // linearizable against binding generation changes (blocker 3): it runs
  // through binding.claimGeneration, whose reserve callback executes under
  // the binding store's serialized seam, reads the binding FRESH there, and
  // re-verifies the gate/priority/CAS before persisting the dispatch intent.
  // Locks are released BEFORE the external POST.
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
          const claim = await binding.claimGeneration(async (b) => {
            // Under the binding store's serialized seam (blocker 3): the
            // binding snapshot b was read FRESH inside that section. The
            // busy gate is an in-memory view — checked here, BEFORE the
            // admission mutation. EVERYTHING store-derived (unresolved gate,
            // human-FIFO priority, selected-still-queued) is re-validated
            // INSIDE the same admission-mutex section that reserves
            // (blocker P2) — never against an outside read.
            if (!b.currentSessionId) return { skip: "unbound" };
            if (busyCheck(b.currentSessionId)) return { skip: "busy" }; // hold, never abort
            const result = await claimDispatch(next, b, `msg_${newId()}`);
            if (result.kind === "reserved") {
              // Lease + session map set INSIDE the claim so any reconcile
              // that observes the record as "dispatching" always sees the
              // lease.
              activeOps.set(result.claimed.id, "dispatch");
              acceptedBySession.set(b.currentSessionId, result.claimed.id);
            }
            return result;
          });
          const result = claim.result;
          if (result.kind === "skip") return; // hold the queue (unbound/busy)
          if (result.kind === "retry") continue; // priority/CAS lost — reload and retry
          // --- external awaits: ALL locks released (invariants 6+8) ---
          await sendAndClassify(result.claimed, claim.binding);
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

  /**
   * Phase-1 reservation: persist the dispatch intent BEFORE any external
   * call (invariant 1). Runs inside the binding claim's serialized section,
   * and the WHOLE decision — fresh load, unresolved gate, human-FIFO
   * priority re-validation, selected-still-queued CAS, reservation — happens
   * in ONE admission-mutex section (blocker P2): a submission that commits
   * before the reservation is seen by the very mutation that reserves.
   */
  async function claimDispatch(record, target, messageID) {
    let outcome = null; // { kind: "reserved", claimed } | { kind: "retry" } | { kind: "skip", reason }
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        if (normalized.submissions.some((r) => UNRESOLVED.has(r.status))) {
          outcome = { kind: "skip", reason: "unresolved" };
          return {};
        }
        const pick = pickNext(normalized.submissions);
        if (!pick) {
          outcome = { kind: "skip", reason: "empty" };
          return {};
        }
        if (pick.id !== record.id) {
          outcome = { kind: "retry" }; // priority changed → the pump re-picks
          return {};
        }
        return casSubmission(normalized, record.id, (r) => {
          if (r.status !== "queued") {
            outcome = { kind: "retry" }; // CAS lost (concurrent claim/cancel)
            return null;
          }
          const claimed = {
            ...r,
            status: "dispatching",
            sessionId: target.currentSessionId,
            messageID,
            dispatchGeneration: target.generation ?? 0,
            dispatchStartedAt: now(),
            retargeted: (target.generation ?? 0) !== r.submitGeneration || undefined,
          };
          outcome = { kind: "reserved", claimed };
          return claimed;
        });
      });
    } catch (err) {
      wrapStoreError(err, "dispatch"); // loud: a store failure must not stall silently
    }
    return outcome ?? { kind: "retry" };
  }

  /** The external send + outcome classification. ALL locks are released. */
  async function sendAndClassify(claimed, targetBinding) {
    const sessionId = claimed.sessionId;
    let sendError = null;
    try {
      await bounded(
        (signal) =>
          sendPrompt({
            sessionId,
            text: claimed.text,
            model: claimed.model,
            agent: claimed.agent,
            messageID: claimed.messageID,
            signal,
          }),
        `sendPrompt (${claimed.id})`,
      );
    } catch (err) {
      sendError = err;
    }

    if (sendError) {
      activeOps.delete(claimed.id);
      acceptedBySession.delete(sessionId);
      // Definitive client-side refusal (4xx) proves non-acceptance. Anything
      // else (network, deadline — including an aborted client request, 5xx)
      // is uncertainty → unknown, never resend (blocker 3).
      const definitive = typeof sendError.status === "number" && sendError.status >= 400 && sendError.status < 500;
      await markTransition(
        claimed.id,
        "dispatching",
        definitive ? "failed" : "unknown",
        definitive
          ? { failedAt: now(), error: describeErr(sendError), errorStatus: sendError.status }
          : { unknownAt: now(), unknownReason: describeErr(sendError) },
      );
      return;
    }

    const receipt = await readReceiptUntilVisible(sessionId, claimed.messageID);
    activeOps.delete(claimed.id);
    if (receipt) {
      await markTransition(claimed.id, "dispatching", "accepted", { acceptedAt: now() });
    } else {
      // 204 was observed but the receipt is not (yet) visible. This is NOT
      // proof of non-acceptance — mark unknown; reconcile() keeps checking.
      acceptedBySession.delete(sessionId);
      await markTransition(claimed.id, "dispatching", "unknown", {
        unknownAt: now(),
        unknownReason: "prompt accepted (204) but messageID receipt not visible",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Receipt-specific reconciliation (blockers 1+2): a session.idle/error
  // EVENT triggers a transcript check for THIS record — it never blindly
  // completes and never terminalizes an unresolved abort.
  //  - accepted: completes ONLY on strict transcript proof (terminal finish).
  //  - interrupt_pending: the transcript decides whether the turn ENDED
  //    (finish-agnostic); the record settles ONLY when its abort is settled
  //    ("ok" → interrupted; "refused" → completed). An unresolved abort
  //    keeps the barrier even when the turn finished naturally — a late
  //    session-wide abort must never kill the next admitted turn.
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

  async function transcriptTurnEnded(record) {
    if (!listMessages || !record.sessionId || !record.messageID) return null;
    try {
      const messages = await bounded(() => listMessages(record.sessionId), `listMessages (${record.sessionId})`);
      return turnEndedFromTranscript(messages, record.messageID);
    } catch (err) {
      console.warn(`[ctoAdmission] transcript check for ${record.id} failed:`, describeErr(err));
      return null;
    }
  }

  /**
   * Settle an interrupt_pending record once BOTH facts are proven: the turn
   * ENDED (finish-agnostic transcript proof) and the abort is SETTLED
   * (definitive server response). Records the turn-end separately from the
   * abort state so an outstanding abort never fakes a terminal record.
   */
  async function settleInterruptPending(record, kind) {
    const ended = await transcriptTurnEnded(record);
    if (ended === null || !ended.ended) return null; // running / unreadable / no receipt yet
    if (record.abortState === "ok") {
      return markTransition(record.id, "interrupt_pending", "interrupted", {
        confirmedIdleAt: now(),
        outcome: { kind, via: "transcript", at: now() },
      });
    }
    if (record.abortState === "refused") {
      // The abort was definitively refused — the turn ended naturally.
      return markTransition(record.id, "interrupt_pending", "completed", {
        completedAt: now(),
        abortRefused: record.abortError,
        outcome: { kind, via: "transcript", at: now() },
      });
    }
    // Abort unresolved: record the turn end (visibility) and keep the
    // PERMANENT barrier — the original abort's outcome stays unknown
    // (monotonic); no retry, no settlement, explicit reason surfaced.
    await markFields(record.id, "interrupt_pending", {
      turnEndedAt: now(),
      abortOutcomeReason: record.abortOutcomeReason ?? "abort_outcome_unknown",
    });
    return null;
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
        // Receipt-specific: does the transcript prove the turn ENDED?
        const ended = await transcriptTurnEnded(record);
        if (ended === null || !ended.ended) return; // stale event / running / unreadable
        // Turn over; now the ABORT settlement decides the record's terminal.
        await settleInterruptPending(record, kind);
      }
    })();
  }

  // -------------------------------------------------------------------------
  // observeEvent — same firehose tap promptDelivery sits on: busy tracking
  // (fallback when no shared isBusy) + receipt-specific reconciliation of the
  // session's accepted/interrupt_pending record. Events are TRIGGERS for the
  // transcript check, never proof by themselves.
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
// Abort operations (blocker 2, final round): the attempt is RESERVED
// durably BEFORE the HTTP call — an atomic token (abortState "claimed" +
// attemptId + attemptStartedAt + attemptCount) is written under the admission
// lock, the lock is released, and only then is the abort POST issued (a local
// active-operation lease marks the owner). A crash can therefore never lose
// the fact that an attempt MIGHT be outstanding: recovery downgrades any
// claimed-without-owner (and any pending) to a PERMANENT uncertain barrier —
// no attempt is ever issued from recovery, and no retry ever runs. The live
// owner settles ONLY its own matching attemptId, so a late response can never
// overwrite a recovery downgrade (monotonic uncertainty).
// -------------------------------------------------------------------------
async function claimAndAttemptAbort(record) {
  // Local lease BEFORE the claim so a concurrent reconcile on this instance
  // never races the reservation/outcome writes.
  activeOps.set(record.id, "abort");
  const attemptId = `abt_${newId()}`;
  let claimed = false;
  try {
    // 1. Durable reservation under the admission lock — BEFORE any HTTP.
    await patchStore(store, (fresh) =>
      casSubmission(normalizeAdmissionPayload(fresh), record.id, (r) => {
        if (r.status !== "interrupt_pending" || r.abortState !== "pending") return null; // already claimed/settled
        claimed = true;
        return {
          ...r,
          abortState: "claimed",
          attemptId,
          attemptStartedAt: now(),
          attemptCount: (r.attemptCount ?? 0) + 1,
        };
      }),
    );
    if (!claimed) return null; // exactly-once: the attempt is owned elsewhere
    if (typeof abortSession !== "function") {
      // Nothing will ever be issued: release the claim back to pending with
      // the surfaced reason (recovery will fail-closed it to uncertain).
      await markFields(record.id, "interrupt_pending", {
        abortState: "pending",
        attemptId: undefined,
        attemptStartedAt: undefined,
        abortError: "abort-unsupported: no abortSession transport wired",
      });
      return { abortState: "pending", abortError: "abort-unsupported: no abortSession transport wired" };
    }

    // 2. External await — NO store lock held (invariant 6).
    let outcome;
    try {
      await bounded(
        (signal) => abortSession(record.sessionId, { signal }), // signal-propagated
        `abortSession (${record.sessionId})`,
      );
      outcome = { abortState: "ok" }; // definitive: server confirmed
    } catch (err) {
      const definitive = typeof err?.status === "number" && err.status >= 400 && err.status < 500;
      outcome = definitive
        ? { abortState: "refused", abortError: describeErr(err) }
        : // deadline/network: the ORIGINAL request may still land — the
          // timeout waiter is not proof; uncertainty is permanent.
          { abortState: "uncertain", abortOutcomeReason: "abort_outcome_unknown", abortError: describeErr(err) };
    }

    // 3. Settle ONLY the matching attempt: a recovery downgrade or any newer
    // state must never be overwritten by this (possibly stale) response.
    await patchStore(store, (fresh) =>
      casSubmission(normalizeAdmissionPayload(fresh), record.id, (r) => {
        if (r.status !== "interrupt_pending" || r.abortState !== "claimed" || r.attemptId !== attemptId) return null;
        return {
          ...r,
          abortState: outcome.abortState,
          ...(outcome.abortOutcomeReason ? { abortOutcomeReason: outcome.abortOutcomeReason } : {}),
          ...(outcome.abortError ? { abortError: outcome.abortError } : {}),
          abortSettledAt: now(),
        };
      }),
    );
    return outcome;
  } finally {
    if (activeOps.get(record.id) === "abort") activeOps.delete(record.id);
  }
}

  // -------------------------------------------------------------------------
  // reconcile — restart + uncertainty recovery. Joinable single-flight.
  // Records with an active operation (dispatch/abort this instance is
  // awaiting) are SKIPPED — never raced, never double-classified (blocker 3).
  // NEVER resends: found receipts advance, absent receipts stay put.
  // -------------------------------------------------------------------------
  let reconciling = null;

  function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const fresh = await loadStore();
      for (const record of fresh.submissions) {
        if (activeOps.has(record.id)) continue; // own in-flight operation
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
        if (record.status === "interrupt_pending") {
          if (record.abortState === "ok" || record.abortState === "refused") {
            // Abort SETTLED definitively: the transcript decides settlement.
            const last = turnCheckedAt.get(record.id) ?? 0;
            if (now() - last < turnRecheckIntervalMs) continue;
            turnCheckedAt.set(record.id, now());
            await settleInterruptPending(record, "reconciled");
            continue;
          }
          // "claimed" (attempted-but-unsettled: the HTTP may still land) and
          // "pending" (no attempt reservation proved) both downgrade to the
          // PERMANENT uncertain barrier at recovery — FAIL-CLOSED: no attempt
          // is ever issued from reconcile, no retry ever runs, and no settle
          // happens even when the transcript proves the turn ended. Only the
          // turn-end fact is recorded for visibility.
          const last = turnCheckedAt.get(record.id) ?? 0;
          if (now() - last >= turnRecheckIntervalMs) {
            turnCheckedAt.set(record.id, now());
            const ended = await transcriptTurnEnded(record);
            const downgrade = {
              abortState: "uncertain",
              abortOutcomeReason: record.abortOutcomeReason ?? "abort_outcome_unknown",
              recoveredAt: now(),
            };
            if (ended?.ended) {
              await markFields(record.id, "interrupt_pending", {
                ...downgrade,
                turnEndedAt: record.turnEndedAt ?? now(),
              });
            } else {
              await markFields(record.id, "interrupt_pending", downgrade);
            }
          }
          continue;
        }
        if (record.status === "accepted") {
          // No observed terminal event (restart mid-turn, lost event): ask
          // the transcript, spaced per record so a polling tick stays cheap.
          const last = turnCheckedAt.get(record.id) ?? 0;
          if (now() - last < turnRecheckIntervalMs) continue;
          turnCheckedAt.set(record.id, now());
          const proof = await transcriptTurnState(record);
          if (proof?.completed) {
            await markTransition(record.id, "accepted", "completed", {
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
  // interrupt — the EXPLICIT interruption operation (blockers 1+2). submit
  // never aborts. A request is VISIBLE immediately (cancel_requested /
  // interrupt_pending) but the nonterminal barrier is retained until the
  // outcome is proven: the ABORT is its own active+durable state
  // (abortState) tracked SEPARATELY from the turn's terminal state, and an
  // unresolved abort keeps the barrier even after the turn finishes
  // naturally — a late session-wide abort must never kill the next turn.
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
              abortState: "pending",
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
      // The attempt is claimed durably (BEFORE the HTTP) and issued exactly
      // once by THIS call; the outcome settles only the matching attemptId.
      await claimAndAttemptAbort(resulting);
      return { ok: true, id: submissionId, status: "interrupt_pending" };
    }
    onTransition(resulting);
    return { ok: true, id: submissionId, status: resulting.status };
  }

  // -- retention (P3a3-review) ----------------------------------------------
  // Tombstone every terminal BACKGROUND receipt beyond the bound, oldest
  // first. The dedup identity survives in the durable tombstone list, so a
  // genuine same-id retry still replays instead of double-sending; occurrence
  // identities never recur (sched keys embed the full-date minute key,
  // webhook/delegate ids are unique), so eviction cannot resurrect a turn.
  // Human receipts are NEVER evicted (invariant 5 holds for the human side).
  // Called by the shared CTO store sweeper (no second timer) and inline by
  // submit's cap path. Serialized with all other store ops via patchStore.
  async function trimTerminalBackground() {
    try {
      let evicted = 0;
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        const evictable = normalized.submissions
          .filter((r) => TERMINAL.has(r.status) && r.origin === "background")
          .sort((a, b) => a.createdAt - b.createdAt);
        const excess = evictable.length - maxTerminalBackground;
        if (excess <= 0) return {};
        const gone = evictable.slice(0, excess);
        const goneIds = new Set(gone.map((r) => r.id));
        const tombstoned = gone.map((r) => ({
          id: r.id,
          payloadHash: r.payloadHash,
          status: r.status,
          origin: r.origin,
          createdAt: r.createdAt,
        }));
        evicted = gone.length;
        return {
          submissions: normalized.submissions.filter((r) => !goneIds.has(r.id)),
          tombstones: [...normalized.tombstones, ...tombstoned].slice(-maxTerminalBackground),
        };
      });
      return { evicted };
    } catch (err) {
      // Best-effort: the sweeper must never die on a transient store error;
      // submit's inline cap path is the guarantee that still holds.
      console.warn("[ctoAdmission] terminal-background trim failed:", describeErr(err));
      return { evicted: 0 };
    }
  }

  return { submit, list, tick, reconcile, interrupt, observeEvent, trimTerminalBackground };
}
