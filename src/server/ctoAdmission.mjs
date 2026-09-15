// ctoAdmission.mjs — the durable per-CTO conversation admission queue
// (unified-cto-spec §8.3, P3a2).
//
// ALL prompts to the CTO role session — desktop/native CEO submissions and
// background synthesis alike — pass through this ONE server-owned seam. The
// service owns a durable queue (ctoStores.admissionStore) and admits at most
// one turn at a time into the role session resolved from the P3a1 binding AT
// DISPATCH TIME (never at submit time). Ordinary project delivery is
// untouched: promptDelivery keeps its own in-memory engine for webhooks,
// schedules, peers and capability jobs; admission shares only its BUSY VIEW
// (production passes promptDelivery.isBusy) and sits on the same firehose
// tap (observeEvent, same event shapes).
//
// The invariants this module exists for:
//
// 1. DURABLE BEFORE SEND. A submission's stable ID, canonical request hash,
//    origin and expected binding generation are persisted before anything is
//    sent. Dispatch persists the allocated opencode messageID + resolved
//    target session (status "dispatching") before the prompt_async POST. A
//    crash can therefore never lose the identity needed to reconcile.
// 2. ONE TURN AT A TIME. The admit loop refuses to dispatch while any
//    submission is unresolved (dispatching / accepted / unknown). Human
//    submissions drain FIFO ahead of queued background synthesis; an already
//    accepted turn is never reordered (it is already in the session).
// 3. ACK IS NOT COMPLETION. prompt_async's 204 (plus the messageID read-back
//    receipt, P0-proven) only proves ACCEPTANCE. A submission becomes
//    "completed" only on an actual terminal event (session.idle /
//    session.error for its session) or a transcript-based reconciliation.
// 4. NO BLIND RESEND. If a crash (or an uncertain send outcome) leaves the
//    acceptance unproven, reconcile() reads the messageID receipt back from
//    the transcript: found → accepted (outcome linked, never resent);
//    absent → the submission stays "unknown" and is surfaced, never resent.
//    Only a definitive transport refusal (4xx) observed in the live process
//    proves non-acceptance ("failed").
// 5. TERMINAL RECEIPTS ARE RETAINED FOREVER. completed / failed / cancelled /
//    interrupted records are never evicted (eviction would re-enable a
//    duplicate send of the same ID). Growth is bounded by rejecting NEW
//    submissions at MAX_ENTRIES — never by pruning receipts.
// 6. NO STORE LOCK ACROSS OPENCODE AWAITS. Every store transition is a short
//    patchStore mutex section with a sync mutator; binding resolution, sends
//    and receipt reads happen OUTSIDE the lock. Dispatch itself is
//    single-writer per service instance (in-memory single-flight); the store
//    phase-1 CAS re-verifies under the mutex, so even two instances over one
//    store cannot double-dispatch the same submission.
// 7. EXPLICIT INTERRUPTION. Interrupt is its own operation; submit NEVER
//    aborts a running turn (a busy session simply holds the queue).
//
// Cross-process: single-writer-process design (one manta-server per box
// composes one admission engine), mirroring ctoBinding.mjs. The patchStore
// CAS narrows but does not guarantee multi-writer safety.
//
// NOT in scope here (parent phases wire them): routes/UI, the poller that
// calls tick(), routine work-event entries that need no model turn, and any
// resend/resubmit operation (unknown submissions are surfaced, the caller
// decides). See docs/cto-admission-contract.md.

import { createHash, randomUUID } from "node:crypto";

import { admissionStore, patchStore } from "./ctoStores.mjs";

// ---------------------------------------------------------------------------
// Public constants + error type (the stable contract surface)
// ---------------------------------------------------------------------------

export const ORIGINS = Object.freeze(["human", "background"]);

// Lifecycle. "dispatching" is the crash-window marker: persisted before the
// POST, resolved by reconcile() after a restart. "unknown" is the
// cannot-prove-acceptance state: surfaced, reconciled, never auto-resent.
export const STATUSES = Object.freeze([
  "queued",
  "dispatching",
  "accepted",
  "completed",
  "failed",
  "unknown",
  "cancelled",
  "interrupted",
]);

// Statuses that hold the one-turn-at-a-time gate: while any of these exist
// the admit loop must not dispatch another submission.
const UNRESOLVED = new Set(["dispatching", "accepted", "unknown"]);

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

/**
 * Canonical request hash: sha256 over a stable JSON encoding of the request
 * fields that identity depends on (origin, text, model). Two submits with
 * the same ID and the same canonical payload are the same submission
 * (idempotent); the same ID with a different hash is a caller error.
 */
export function canonicalRequestHash({ origin, text, model } = {}) {
  const canonical = JSON.stringify({ model: model ?? null, origin, text });
  return createHash("sha256").update(canonical).digest("hex");
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

function rowId(m) {
  const id = m?.id ?? m?.info?.id;
  return typeof id === "string" ? id : null;
}

function rowRole(m) {
  const r = m?.role ?? m?.info?.role;
  return typeof r === "string" ? r.toLowerCase() : "";
}

function rowCompleted(m) {
  const t = m?.time?.completed ?? m?.info?.time?.completed;
  return Number.isFinite(t) ? t : null;
}

function rowError(m) {
  return m?.error ?? m?.info?.error ?? null;
}

/**
 * True when the transcript proves our turn FINISHED: an assistant message
 * strictly after our user message whose time.completed is set (or that
 * carries an error). A running assistant row (no completed) is NOT proof.
 * Messages are ascending (oldest first), matching lastAssistantText's scan.
 */
export function turnCompletionFromTranscript(messages, userMessageId) {
  const rows = Array.isArray(messages) ? messages : [];
  const start = rows.findIndex((m) => rowRole(m) === "user" && rowId(m) === userMessageId);
  if (start === -1) return null; // receipt not visible yet — not proof either way
  for (let i = start + 1; i < rows.length; i += 1) {
    if (rowRole(rows[i]) !== "assistant") continue;
    if (rowCompleted(rows[i]) !== null || rowError(rows[i]) !== null) {
      return { completed: true, via: "transcript" };
    }
    return { completed: false }; // a still-running assistant row after ours
  }
  return { completed: false }; // no assistant row after ours (yet)
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Build the durable CTO conversation admission service.
 *
 * @param {object} deps
 * @param {{ getBinding: () => Promise<{generation:number, currentSessionId:string|null}> }} deps.binding
 *        The P3a1 binding service. Dispatch resolves the CURRENT binding
 *        (session id + generation) at dispatch time; submit resolves it once
 *        to stamp submitGeneration and check an optional expectedGeneration.
 * @param {(args:{sessionId:string, text:string, model?:object, agent?:string, messageID:string, signal?:AbortSignal})=>Promise<unknown>} deps.sendPrompt
 *        The opencode prompt injector. Production: opencode.mjs sendPrompt
 *        (messageID param added P3a2, P0-proven accepted + persisted
 *        verbatim). The signal is honored when the transport supports it;
 *        the deadline race below bounds the wait regardless.
 * @param {(sessionId:string, messageId:string)=>Promise<object|null>} deps.getMessage
 *        Single-message receipt read (production: opencode.mjs getMessage).
 *        null = not visible / read failed — never proof of absence.
 * @param {(sessionId:string)=>Promise<Array>} [deps.listMessages]
 *        Transcript read for turn-completion reconciliation (production:
 *        opencode.mjs listMessages). Absent → that reconcile step is skipped.
 * @param {(sessionId:string)=>Promise<void>} [deps.abortSession]
 *        Explicit interrupt of an accepted turn (production: opencode.mjs
 *        abortSession). Absent → interrupting an accepted turn refuses.
 * @param {(sessionId:string)=>boolean} [deps.isBusy]
 *        Shared busy view (production: promptDelivery.isBusy). Absent → an
 *        internal firehose-derived busy set is used instead.
 * @param {object} [deps.store] admission store (default ctoStores.admissionStore)
 * @param {Function} [deps.now] @param {Function} [deps.newId] @param {Function} [deps.sleep]
 * @param {number} [deps.requestDeadlineMs] Bounded wait for every oc call.
 * @param {number} [deps.receiptReadAttempts] @param {number} [deps.receiptReadBackoffMs]
 * @param {number} [deps.unknownStaleMs] list() flags unknown records older than this.
 * @param {number} [deps.turnRecheckIntervalMs] Min spacing of transcript-based
 *        turn-completion rechecks per accepted record.
 * @param {number} [deps.maxEntries] Hard cap on total records (new submissions
 *        are refused at the cap; terminal receipts are never evicted).
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
  // Same derivation promptDelivery uses (session.status busy/retry → busy;
  // session.status idle / session.idle / session.error → idle).
  const busySessions = new Set();
  // sessionId → submissionId currently dispatched to that session. Kept in
  // memory so the hot firehose path never reads the store per event. Hydrated
  // once at construction so a restart-mid-turn still observes the accepted
  // record's (late) terminal event.
  const acceptedBySession = new Map();
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

  // Hydrate the in-memory dispatch map from the durable store so terminal
  // events arriving shortly after construction still land on their record.
  void loadStore()
    .then((fresh) => {
      for (const r of fresh.submissions) {
        if ((r.status === "accepted" || r.status === "dispatching") && r.sessionId) {
          acceptedBySession.set(r.sessionId, r.id);
        }
      }
    })
    .catch(() => {}); // health surfaces through the first real operation

  // -------------------------------------------------------------------------
  // Bounded oc wait: the deadline bounds how long admission WAITS and drives
  // the unknown classification; the signal is passed through for transports
  // that support real cancellation. A deadline hit is uncertainty, never a
  // definitive refusal.
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
    // A losing-side rejection (the transport failing AFTER the deadline won
    // the race) must not surface as an unhandled rejection — the winner
    // already classified the outcome as uncertainty.
    runPromise.catch(() => {});
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
    if (record.status === "accepted" && record.sessionId) {
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
  // submit — validate, dedup, persist durably, then kick the admit pump.
  // Never sends from here; dispatch happens on the pump/tick.
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

    // Binding resolution happens OUTSIDE the store lock (invariant 6). The
    // generation is stamped for identity/diagnostics; dispatch re-resolves.
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

    const submissionId = id ?? `evt_${newId()}`;
    const payloadHash = canonicalRequestHash({ origin, text, model });
    let record = null;
    let wrote = false;
    try {
      await patchStore(store, (fresh) => {
        const normalized = normalizeAdmissionPayload(fresh);
        const existing = normalized.submissions.find((r) => r.id === submissionId);
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new CtoAdmissionError(
              `duplicate submission id ${submissionId} with a different payload`,
              "duplicate-id-different-payload",
            );
          }
          record = existing; // idempotent re-ack: return the existing record
          return {}; // pure no-op: no save
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
  // Dispatch (the pump) — single-flight; resolves the binding at dispatch
  // time; persists the dispatch intent BEFORE the POST; classifies the send
  // outcome into accepted / failed / unknown.
  // -------------------------------------------------------------------------
  let pumping = null;

  function pickNext(submissions) {
    for (const origin of ORIGINS) {
      const found = submissions.find((r) => r.status === "queued" && r.origin === origin);
      if (found) return found;
    }
    return null;
  }

  /** Single-flight AND joinable: concurrent callers await the SAME run. */
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
          const dispatched = await dispatch(next, target);
          if (!dispatched) continue; // phase-1 CAS lost — reload and retry
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

  /** Returns true when this call performed the dispatch, false on CAS loss. */
  async function dispatch(record, target) {
    const messageID = `msg_${newId()}`;
    const sessionId = target.currentSessionId;
    const dispatchGeneration = target.generation ?? 0;
    let proceed = false;
    // Phase 1: persist the dispatch intent BEFORE any external call
    // (invariant 1). The CAS re-verifies "queued" under the store mutex, so
    // even a second engine instance over the same store cannot double-send.
    try {
      await patchStore(store, (fresh) =>
        casSubmission(normalizeAdmissionPayload(fresh), record.id, (r) => {
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
        }),
      );
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
      // else (network, deadline, 5xx) is uncertainty → unknown, never resend.
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
  // observeEvent — same firehose tap promptDelivery sits on. Two jobs:
  // track busy (fallback when no shared isBusy) and observe the accepted
  // turn's ACTUAL terminal event (ack ≠ completion).
  // -------------------------------------------------------------------------
  function observeEvent(evt) {
    const sid = evt?.properties?.sessionID;
    if (typeof sid !== "string" || !sid) return;
    if (evt.type === "session.idle" || evt.type === "session.error") {
      busySessions.delete(sid);
      completeAcceptedForSession(sid, evt.type === "session.error" ? "error" : "idle", evt.properties?.error);
      return;
    }
    if (evt.type === "session.status") {
      const t = evt.properties?.status?.type;
      if (t === "busy" || t === "retry") busySessions.add(sid);
      else if (t === "idle") {
        busySessions.delete(sid);
        completeAcceptedForSession(sid, "idle", null);
      }
    }
  }

  function completeAcceptedForSession(sessionId, kind, error) {
    const id = acceptedBySession.get(sessionId);
    if (!id) return; // hot path: no store read for unrelated sessions
    void (async () => {
      const updated = await markTransition(
        id,
        "accepted",
        "completed",
        {
          completedAt: now(),
          outcome: error
            ? { kind, errorName: typeof error?.name === "string" ? error.name : undefined, at: now() }
            : { kind, at: now() },
        },
      );
      if (updated) acceptedBySession.delete(sessionId);
    })();
  }

  // -------------------------------------------------------------------------
  // reconcile — restart + uncertainty recovery. Receipt read-backs for
  // dispatching/unknown records (P0-proven messageID receipt), transcript-
  // based completion for accepted records whose terminal event was missed.
  // NEVER resends: found receipts advance, absent receipts stay unknown.
  // -------------------------------------------------------------------------
  async function reconcile() {
    const fresh = await loadStore();
    for (const record of fresh.submissions) {
      if (record.status === "dispatching" || record.status === "unknown") {
        if (!record.sessionId || !record.messageID) continue; // never dispatched
        const row = await readReceiptUntilVisible(record.sessionId, record.messageID);
        if (row) {
          await markTransition(record.id, record.status, "accepted", {
            acceptedAt: record.acceptedAt ?? now(),
            reconciledAt: now(),
          });
          acceptedBySession.set(record.sessionId, record.id);
        } else {
          await markTransition(record.id, record.status, "unknown", {
            unknownAt: record.unknownAt ?? now(),
            unknownReason: record.unknownReason ?? "acceptance unproven after recovery",
            lastReceiptCheckAt: now(),
            receiptChecks: (record.receiptChecks ?? 0) + 1,
          });
        }
      }
      if (record.status === "accepted" && record.sessionId && listMessages) {
        // Accepted without an OBSERVED terminal event (a live turn in flight,
        // a restart mid-turn, or an event the firehose never delivered): ask
        // the transcript, spaced per record so a polling tick stays cheap. A
        // still-running assistant row is correctly NOT completion.
        const last = turnCheckedAt.get(record.id) ?? 0;
        if (now() - last < turnRecheckIntervalMs) continue;
        turnCheckedAt.set(record.id, now());
        try {
          const messages = await bounded(() => listMessages(record.sessionId), `listMessages (${record.sessionId})`);
          const completion = turnCompletionFromTranscript(messages, record.messageID);
          if (completion?.completed) {
            await markTransition(record.id, "accepted", "completed", {
              completedAt: now(),
              outcome: { kind: "reconciled", via: completion.via, at: now() },
            });
          }
        } catch (err) {
          console.warn(`[ctoAdmission] turn recheck for ${record.id} failed:`, describeErr(err));
        }
      }
    }
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
          if (r.status === "unknown") {
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
  // interrupt — the EXPLICIT interruption operation. submit never aborts.
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
          if (r.status === "queued" || r.status === "unknown") {
            resulting = {
              ...r,
              status: "cancelled",
              cancelledAt: now(),
              ...(reason ? { cancelReason: reason } : {}),
              ...(r.status === "unknown" ? { abandonedUnknown: true } : {}),
            };
            return resulting;
          }
          if (r.status === "accepted") {
            resulting = {
              ...r,
              status: "interrupted",
              interruptedAt: now(),
              ...(reason ? { interruptReason: reason } : {}),
            };
            return resulting;
          }
          return null; // dispatching / terminal: handled below
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
    if (prior.status === "accepted") {
      if (typeof abortSession !== "function") {
        throw new CtoAdmissionError(
          "interrupt: no abortSession transport wired — cannot interrupt an accepted turn",
          "abort-unsupported",
        );
      }
      if (prior.sessionId && acceptedBySession.get(prior.sessionId) === prior.id) {
        acceptedBySession.delete(prior.sessionId);
      }
      let abortError;
      try {
        await bounded(() => abortSession(prior.sessionId), `abortSession (${prior.sessionId})`);
      } catch (err) {
        abortError = describeErr(err);
      }
      // The turn may still be running if the abort failed — the terminal
      // event will still land and is recorded as the interrupted turn's
      // outcome. Never implicit: this abort happened because interrupt ran.
      await markTransition(submissionId, "interrupted", "interrupted", {
        ...(reason ? { interruptReason: reason } : {}),
        ...(abortError ? { abortError } : {}),
      });
      void pump(); // the session is (being) freed; the queue may proceed
    }
    onTransition(resulting);
    return { ok: true, id: submissionId, status: resulting.status };
  }

  return { submit, list, tick, reconcile, interrupt, observeEvent };
}
