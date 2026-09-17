// BET-P3a2: src/server/ctoAdmission.test.mjs — the durable per-CTO
// conversation admission queue (unified-cto-spec §8.3, round 2: six review
// blockers). Synthetic oc + injected stores for the state-machine tests; one
// production-composition test drives the REAL opencode.mjs client through
// `_setOcTransport` to pin the P0-proven messageID receipt AND the bounded
// signal propagation on the wire. No live opencode, no network, no model
// calls. All negative races use LATCHES (manually resolved promises), never
// timers.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

import {
  CtoAdmissionError,
  MAX_ENTRIES,
  canonicalRequestHash,
  createCtoAdmission,
  normalizeAdmissionPayload,
  turnCompletionFromTranscript,
} from "./ctoAdmission.mjs";
import { admissionStore } from "./ctoStores.mjs";
import { statePath } from "../shared/paths.mjs";
import * as ocModule from "./opencode.mjs";
import { createCtoBinding } from "./ctoBinding.mjs";
import { spyOcWire } from "./ctoTestWireSpy.mjs";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function memoryStore(name, { failSaveCalls = null } = {}) {
  let payload = { v: 1, submissions: [] };
  let saveCalls = 0;
  return {
    name,
    path: `admission-${name}-${randomUUID()}.json`,
    failSaveCalls,
    async load() {
      return payload;
    },
    async save(next) {
      saveCalls += 1;
      if (failSaveCalls && failSaveCalls.includes(saveCalls)) {
        throw new Error(`simulated crash on save #${saveCalls}`);
      }
      payload = next;
    },
  };
}

// A synthetic CTO role binding that tests can advance (generation + session).
// `claimGeneration` mirrors the real binding service's contract: the reserve
// callback runs with the CURRENT state snapshot (the real service additionally
// serializes it against ensure/recover — that serialization is proven
// separately against createCtoBinding itself).
function fakeBinding({ generation = 3, currentSessionId = "ses_cto" } = {}) {
  const state = { generation, currentSessionId };
  return {
    state,
    async getBinding() {
      return { ...state };
    },
    async claimGeneration(reserve) {
      const binding = { ...state };
      const result = await reserve(binding);
      return { binding, result };
    },
    advance(newSessionId) {
      state.generation += 1;
      state.currentSessionId = newSessionId;
    },
  };
}

// The shared sendOutcome knob for BOTH fake senders: fail the send in the
// meaningful ways (definitive 400 / definitive 500 / unknown network), else
// land the receipt in the transcript. `label` names the failing endpoint in
// the thrown error ("sendPrompt" vs "runCommand") so tests can tell the two
// dispatch paths apart — the ONLY difference between the senders.
function applySendOutcome(oc, { sendOutcome, receiptLands, messageID, label }) {
  if (sendOutcome === "http400") {
    const err = new Error(`opencode ${label} 400: bad request`);
    err.status = 400;
    throw err;
  }
  if (sendOutcome === "http500") {
    const err = new Error(`opencode ${label} 500: boom`);
    err.status = 500;
    throw err;
  }
  if (sendOutcome === "network") {
    throw new Error("socket hang up");
  }
  if (receiptLands) {
    oc.transcript.set(messageID, { info: { id: messageID, role: "user", time: { created: 1 } }, parts: [] });
    // The transcript (listMessages view) also gains the user row — the
    // receipt-specific reconciliation links assistant rows to it.
    oc.rows.push({ info: { id: messageID, role: "user", time: { created: 1 } }, parts: [] });
  }
}

// A synthetic opencode: records sends/aborts, serves receipts from a
// transcript map, and can fail sends in the meaningful ways. `rows` is the
// transcript (ascending) used by listMessages; `completeTurn` appends a
// TERMINAL assistant row LINKED to the user message via parentID (the only
// proof the reconciliation accepts).
function fakeOc({ sendOutcome = "ok", receiptLands = true, rows = [] } = {}) {
  let asstSeq = 0;
  const oc = {
    sends: [],
    commandSends: [],
    aborts: [],
    getMessageCalls: 0,
    transcript: new Map(), // messageID → receipt row
    rows: [...rows],
    async sendPrompt({ sessionId, text, model, agent, attachments, mentions, messageID }) {
      oc.sends.push({ sessionId, text, model, agent, attachments, mentions, messageID });
      applySendOutcome(oc, { sendOutcome, receiptLands, messageID, label: "sendPrompt" });
      return undefined; // the 204
    },
    // P3a3 full-parity widening: the slash-command sender (a DIFFERENT
    // opencode endpoint — mirrors sendPrompt's outcome knobs so the same
    // sendOutcome fixture drives both dispatch paths in the new tests below).
    async sendCommand({ sessionId, command, arguments: argumentsStr, attachments, model, agent, messageID }) {
      oc.commandSends.push({ sessionId, command, arguments: argumentsStr, attachments, model, agent, messageID });
      applySendOutcome(oc, { sendOutcome, receiptLands, messageID, label: "runCommand" });
      return undefined;
    },
    async getMessage(sessionId, messageId) {
      oc.getMessageCalls += 1;
      return oc.transcript.get(messageId) ?? null;
    },
    async listMessages(sessionId) {
      return oc.rows;
    },
    async abortSession(sessionId) {
      oc.aborts.push(sessionId);
    },
    /** A finished assistant row linked to our user message (finish: stop). */
    completeTurn(messageID, { finish = "stop", completedAt = 9_000, error = null } = {}) {
      oc.rows.push({
        info: {
          id: `asst_${(asstSeq += 1)}`,
          role: "assistant",
          parentID: messageID,
          finish,
          time: { created: 2, completed: error ? undefined : completedAt },
          ...(error ? { error } : {}),
        },
        parts: [],
      });
    },
    /** An ABORTED assistant row: finished (no longer running) but with a
     * non-terminal finish — the turn-ended reader accepts it, the strict
     * completion reader does not. */
    abortTurnRow(messageID) {
      oc.rows.push({
        info: {
          id: `asst_${(asstSeq += 1)}`,
          role: "assistant",
          parentID: messageID,
          finish: "abort",
          time: { created: 2, completed: 8_000 },
        },
        parts: [],
      });
    },
  };
  return oc;
}

/** Late-binding oc dep wrappers so tests can swap implementations mid-test. */
function ocDeps(oc) {
  return {
    sendPrompt: (...a) => oc.sendPrompt(...a),
    sendCommand: (...a) => oc.sendCommand(...a),
    getMessage: (...a) => oc.getMessage(...a),
    listMessages: (...a) => oc.listMessages(...a),
    abortSession: (...a) => oc.abortSession(...a),
  };
}

/** Latch the pump's FIRST dispatch claim before its serialized section. */
function latchFirstClaim(binding) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const realClaim = binding.claimGeneration.bind(binding);
  let claimCalls = 0;
  binding.claimGeneration = async (reserve) => {
    claimCalls += 1;
    if (claimCalls === 1) await gate;
    return realClaim(reserve);
  };
  return { release };
}

function buildService({ store = memoryStore(`t-${randomUUID()}`), binding = fakeBinding(), oc = fakeOc(), clock = { t: 1_000_000 }, ...rest } = {}) {
  const svc = createCtoAdmission({
    store,
    binding,
    ...ocDeps(oc),
    now: () => clock.t,
    sleep: async () => {},
    ...rest,
  });
  return { svc, store, binding, oc, clock };
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const statusOf = (svc, id) =>
  svc.list().then((l) => l.submissions.find((s) => s.id === id)?.status);

const recordOf = async (svc, id) => (await svc.list()).submissions.find((s) => s.id === id);

/** A fake oc whose abortSession PARKS on a manually-released latch — the
 * standard "abort hangs past its deadline ⇒ uncertain" fixture. `onAbort`
 * (optional) runs INSIDE the abort call before it parks (e.g. to snapshot
 * the store at crash time). */
function hangingAbortOc({ onAbort } = {}) {
  let releaseAbort;
  const abortGate = new Promise((resolve) => (releaseAbort = resolve));
  const oc = fakeOc();
  oc.abortSession = async (sessionId, { signal } = {}) => {
    oc.aborts.push({ sessionId, signal: signal ?? null });
    if (onAbort) await onAbort();
    await abortGate;
  };
  return { oc, releaseAbort };
}

/**
 * A fake oc whose sendPrompt PARKS on a manually-released latch (the standard
 * "send in flight" fixture for the race tests). The parked send lands its
 * receipt — transcript map AND listMessages user row — when released.
 */
function parkedSendOc() {
  let releaseSend;
  const gate = new Promise((resolve) => (releaseSend = resolve));
  const oc = fakeOc();
  oc.sendPrompt = async (args) => {
    oc.sends.push(args);
    try {
      await gate;
    } finally {
      const row = { info: { id: args.messageID, role: "user", time: { created: 1 } }, parts: [] };
      oc.transcript.set(args.messageID, row);
      oc.rows.push(row);
    }
  };
  return { oc, releaseSend };
}

// ---------------------------------------------------------------------------
// Submit: durable identity before send
// ---------------------------------------------------------------------------

test("submit persists stable id + canonical hash + origin + generation BEFORE any send", async () => {
  const { svc, oc } = buildService();
  const res = await svc.submit({ text: "hold the release", origin: "human" });
  assert.equal(res.status, "queued");
  assert.equal(res.persisted, true);
  assert.match(res.id, /^evt_/);
  assert.equal(res.payloadHash, canonicalRequestHash({ origin: "human", text: "hold the release" }));
  assert.equal(res.submitGeneration, 3);
  assert.equal(oc.sends.length, 0, "nothing sent until the pump admits");
});

test("dispatch resolves the CURRENT binding at dispatch time and persists receipt identity before the POST", async () => {
  const { svc, oc } = buildService();
  const res = await svc.submit({ text: "status?", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].sessionId, "ses_cto");
  assert.match(oc.sends[0].messageID, /^msg_/);
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "accepted", "receipt found → accepted, not completed");
  assert.equal(record.sessionId, "ses_cto");
  assert.equal(record.dispatchGeneration, 3);
  assert.equal(record.messageID, oc.sends[0].messageID);
});

test("unbound role: submissions stay queued and nothing is sent", async () => {
  const { svc, oc } = buildService({ binding: fakeBinding({ currentSessionId: null }) });
  await svc.submit({ text: "hi", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 0);
  assert.equal(await statusOf(svc, (await svc.list()).submissions[0].id), "queued");
});

// ---------------------------------------------------------------------------
// Concurrency + priority (blocker 5)
// ---------------------------------------------------------------------------

test("concurrent human clients + background: racing submits all persist; same-id racers dedup to ONE record", async () => {
  const { svc, oc } = buildService();
  const [h1, h2, b1, dupSame, dupSame2] = await Promise.all([
    svc.submit({ text: "from desktop", origin: "human" }),
    svc.submit({ text: "from phone", origin: "human" }),
    svc.submit({ text: "synthesis A", origin: "background" }),
    svc.submit({ id: "evt_fixed", text: "once", origin: "human" }),
    svc.submit({ id: "evt_fixed", text: "once", origin: "human" }),
  ]);
  assert.notEqual(h1.id, h2.id);
  assert.equal(dupSame.id, "evt_fixed");
  assert.equal(dupSame2.id, "evt_fixed");
  assert.equal(dupSame2.persisted, false, "the racer that lost the insert joins the existing record");
  const l = await svc.list();
  assert.equal(l.submissions.length, 4);
  // Origins are immutable, so contention counts hold regardless of how far
  // the fire-and-forget pump got while the submits were racing.
  assert.equal(l.submissions.filter((s) => s.origin === "human").length, 3);
  assert.equal(l.submissions.filter((s) => s.origin === "background").length, 1);
  assert.ok(l.counts.unresolved <= 1, "at most one turn in flight");
  await svc.tick();
  assert.ok(oc.sends.length <= 1, "never more than one send per admitted turn");
});

test("human FIFO outranks queued background synthesis; accepted turns are never reordered", async () => {
  const { svc, oc, clock } = buildService();
  // Contention: the role session is busy while BOTH submissions queue, so
  // the priority decision is made by one pump pass, not by submit timing.
  svc.observeEvent({ type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } });
  clock.t += 1;
  const bg = await svc.submit({ text: "bg first in line", origin: "background" });
  const h = await svc.submit({ text: "human arrives later", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 0, "busy: nothing admitted yet");
  // The turn ends → the pump admits the HUMAN despite the background
  // submission being earlier in the store.
  clock.t += 1;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].text, "human arrives later");
  // That turn's terminal (transcript proof) → the background synthesis is
  // next (FIFO within each origin; humans have drained).
  clock.t += 1;
  oc.completeTurn(oc.sends[0].messageID);
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  clock.t += 20_000;
  await svc.tick();
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[1].text, "bg first in line");
  const bgRecord = await recordOf(svc, bg.id);
  assert.equal(bgRecord.status, "accepted");
  const hRecord = await recordOf(svc, h.id);
  assert.equal(hRecord.status, "completed");
  assert.equal(hRecord.outcome.kind, "idle");
  assert.equal(hRecord.outcome.completion, "ok");
  assert.equal(hRecord.outcome.via, "transcript");
});

test("priority race (blocker 5): a human arriving while the pump awaits the binding wins before the dispatch commits", async () => {
  const { svc, oc, binding } = buildService();
  // Latch ONLY the pump's dispatch claim (the binding claimGeneration call):
  // the submits' own generation reads resolve immediately, so both records
  // are durably queued while the claim is parked mid-selection.
  const { release: releaseBinding } = latchFirstClaim(binding);
  const bg = await svc.submit({ id: "evt_bg", text: "background picked first", origin: "background" });
  const h = await svc.submit({ id: "evt_h", text: "human arrives during the await", origin: "human" });
  await flush();
  assert.equal(oc.sends.length, 0, "pump is parked on the binding claim latch");
  releaseBinding();
  await flush();
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].text, "human arrives during the await", "the stale background pick was re-verified at claim time");
  assert.equal(await statusOf(svc, h.id), "accepted");
  assert.equal(await statusOf(svc, bg.id), "queued", "the background submission waits its turn");
});

test("P2: the priority re-validation runs INSIDE the reservation mutation — a human committing before the claim's mutex section wins it", async () => {
  const { svc, oc, binding } = buildService();
  // Latch the pump's dispatch claim BEFORE its serialized section: the
  // pre-check has selected the earlier background record; the human then
  // COMMITS while the claim is parked. The reservation mutation must
  // re-validate the pick from a fresh load under the same admission mutex
  // that reserves — the human wins there, never the stale pick.
  const { release: releaseBinding } = latchFirstClaim(binding);
  const bg = await svc.submit({ id: "evt_bg2", text: "background selected by the pre-check", origin: "background" });
  const h = await svc.submit({ id: "evt_h2", text: "human committed before the claim", origin: "human" });
  await flush();
  assert.equal(oc.sends.length, 0, "the claim is parked before its reservation mutation");
  releaseBinding();
  await flush();
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].text, "human committed before the claim", "the reservation mutation re-validated human FIFO");
  assert.equal(await statusOf(svc, h.id), "accepted");
  assert.equal(await statusOf(svc, bg.id), "queued");
});

test("P2: verification and reservation share ONE admission mutex section — a commit cannot interleave between them", async () => {
  const { oc, binding, clock } = { oc: fakeOc(), binding: fakeBinding(), clock: { t: 1_000_000 } };
  // Park the FIRST admission-store load that happens once the claim is in
  // flight — that load is the reservation mutation's own fresh read, taken
  // under the admission mutex. While it is parked, the mutex is HELD: a
  // concurrent human submit can only commit AFTER the reservation.
  let claimInFlight = false;
  let parked = false;
  let releaseLoad;
  const loadGate = new Promise((resolve) => (releaseLoad = resolve));
  const realClaim = binding.claimGeneration.bind(binding);
  binding.claimGeneration = async (reserve) => {
    claimInFlight = true;
    try {
      return await realClaim(reserve);
    } finally {
      claimInFlight = false;
    }
  };
  const suspender = memoryStore(`mutex-${randomUUID()}`);
  const underlyingLoad = suspender.load.bind(suspender);
  suspender.load = async () => {
    if (claimInFlight && !parked) {
      parked = true;
      await loadGate;
    }
    return underlyingLoad();
  };
  const svc = createCtoAdmission({
    store: suspender,
    binding,
    ...ocDeps(oc),
    now: () => clock.t,
  });
  const bg = await svc.submit({ id: "evt_bg3", text: "background claims first", origin: "background" });
  await flush();
  assert.equal(parked, true, "the reservation mutation's load is parked under the mutex");
  // Commit a human WHILE the reservation mutation is parked: the mutex queues
  // its insert behind the reservation — it can never land between the
  // verification and the reservation.
  const humanPromise = svc.submit({ id: "evt_h3", text: "human during the mutation", origin: "human" });
  releaseLoad();
  const human = await humanPromise;
  await flush();
  // The background turn completes → the human is admitted by the next pass.
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick();
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[0].text, "background claims first", "the reservation committed atomically first");
  assert.equal(oc.sends[1].text, "human during the mutation", "the later commit is picked by the next pass, never reordered in");
  assert.equal((await recordOf(svc, bg.id)).status, "completed");
  assert.equal(await statusOf(svc, "evt_h3"), "accepted");
});

// ---------------------------------------------------------------------------
// Busy semantics: enqueue, never abort
// ---------------------------------------------------------------------------

test("busy session (an externally-started turn): submit queues durably, never sends, never aborts", async () => {
  const { svc, oc, clock } = buildService();
  // The firehose says the role session is mid-turn — a turn admission did
  // NOT start (e.g. a prompt from another path). The queue must hold.
  svc.observeEvent({ type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } });
  clock.t += 1;
  const res = await svc.submit({ text: "queued while busy", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 0, "no send while busy");
  assert.equal(oc.aborts.length, 0, "submit never aborts");
  assert.equal(await statusOf(svc, res.id), "queued");
  // The turn ends → the queue proceeds.
  clock.t += 1;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.aborts.length, 0);
  assert.equal(await statusOf(svc, res.id), "accepted");
});

// ---------------------------------------------------------------------------
// Ack is not completion (blocker 1: receipt-specific reconciliation)
// ---------------------------------------------------------------------------

test("204 ack + receipt is ACCEPTED; the terminal event completes only with transcript proof", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted");
  clock.t += 5;
  oc.completeTurn(oc.sends[0].messageID);
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "idle");
  assert.equal(record.outcome.completion, "ok");
  assert.equal(record.outcome.via, "transcript");
  assert.ok(record.completedAt > 1_000_000);
});

test("a stale session.idle cannot release an unrelated turn: no transcript proof → still accepted", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted");
  clock.t += 5;
  // No assistant row exists for our message — an idle event for the session
  // (e.g. from an unrelated turn) must NOT complete ours.
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  assert.equal(await statusOf(svc, res.id), "accepted", "blind completion is banned");
  assert.ok(oc.sends.length === 1);
  // Later the transcript proves the turn finished → reconcile completes it.
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick();
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "reconciled");
});

test("intermediate assistant tool steps never complete the turn (blocker 1)", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  const sent = oc.sends[0].messageID;
  // Step 1: a tool-use assistant row — completed but finish "tool_use".
  oc.rows.push({
    info: { id: "asst_tool", role: "assistant", parentID: sent, finish: "tool_use", time: { created: 2, completed: 5_000 } },
    parts: [],
  });
  clock.t += 20_000;
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted", "a completed tool step is not a completed turn");
  // Stale events for the session must not complete it either.
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  assert.equal(await statusOf(svc, res.id), "accepted");
  // Step 2: the final assistant row with a terminal finish → completes.
  clock.t += 20_000;
  oc.completeTurn(sent);
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "completed");
});

test("an UNLINKED assistant row (parentID != our messageID) is never proof (blocker 1)", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  const sent = oc.sends[0].messageID;
  oc.completeTurn("msg_someone_else"); // finished assistant, different parent
  clock.t += 20_000;
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted");
  oc.completeTurn(sent);
  clock.t += 20_000;
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "completed");
});

test("session.error is a terminal event only with transcript proof of our turn's error", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  clock.t += 5;
  // No proof yet → the error event must not complete.
  svc.observeEvent({
    type: "session.error",
    properties: { sessionID: "ses_cto", error: { name: "ProviderAuthError" } },
  });
  await flush();
  assert.equal(await statusOf(svc, res.id), "accepted");
  // Transcript shows our linked assistant row errored → completes.
  oc.completeTurn(oc.sends[0].messageID, { error: { name: "ProviderAuthError" } });
  clock.t += 20_000;
  await svc.tick();
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "reconciled");
  assert.equal(record.outcome.completion, "model-error");
});

// ---------------------------------------------------------------------------
// Dedup (blocker 6)
// ---------------------------------------------------------------------------

test("same id + same payload is idempotent; same id + different payload is an error and the original is untouched", async () => {
  const { svc, oc, store } = buildService();
  await svc.submit({ id: "evt_dup", text: "original", origin: "human" });
  const again = await svc.submit({ id: "evt_dup", text: "original", origin: "human" });
  assert.equal(again.id, "evt_dup");
  assert.equal(again.persisted, false);
  await assert.rejects(
    () => svc.submit({ id: "evt_dup", text: "DIFFERENT", origin: "human" }),
    (err) => err instanceof CtoAdmissionError && err.code === "duplicate-id-different-payload",
  );
  const l = await svc.list();
  assert.equal(l.submissions.length, 1);
  assert.equal(l.submissions[0].payloadHash, canonicalRequestHash({ origin: "human", text: "original" }));
  const raw = await store.load();
  assert.equal(raw.submissions[0].text, "original");
  await svc.tick();
  assert.equal(oc.sends.length, 1, "a deduped re-ack never causes a second send");
});

test("a different agent under the same id is a DIFFERENT payload → rejected (blocker 6)", async () => {
  const { svc } = buildService();
  await svc.submit({ id: "evt_agent", text: "go", origin: "background", agent: "synthesizer" });
  await assert.rejects(
    () => svc.submit({ id: "evt_agent", text: "go", origin: "background", agent: "reviewer" }),
    (err) => err instanceof CtoAdmissionError && err.code === "duplicate-id-different-payload",
  );
  const ok = await svc.submit({ id: "evt_agent", text: "go", origin: "background", agent: "synthesizer" });
  assert.equal(ok.persisted, false, "same agent replays idempotently");
});

test("reordered model object keys replay idempotently (key-order canonical hash, blocker 6)", async () => {
  const { svc } = buildService();
  const first = await svc.submit({
    id: "evt_model",
    text: "go",
    origin: "human",
    model: { providerID: "anthropic", modelID: "claude" },
  });
  const replay = await svc.submit({
    id: "evt_model",
    text: "go",
    origin: "human",
    model: { modelID: "claude", providerID: "anthropic" }, // reordered keys
  });
  assert.equal(replay.persisted, false);
  assert.equal(replay.id, first.id);
});

test("a replay of an existing id succeeds even AFTER the binding generation advanced (dedup precedes generation validation, blocker 6)", async () => {
  const { svc, binding } = buildService();
  await svc.submit({ id: "evt_replay", text: "once", origin: "human", expectedGeneration: 3 });
  binding.advance("ses_cto_v2"); // generation 4 — the submitter's CAS is now stale
  const replay = await svc.submit({ id: "evt_replay", text: "once", origin: "human", expectedGeneration: 3 });
  assert.equal(replay.persisted, false, "replay returns the existing record");
  assert.equal(replay.status, "queued");
  // A NEW record (different id) with the stale expectation still refuses.
  await assert.rejects(
    () => svc.submit({ text: "fresh", origin: "human", expectedGeneration: 3 }),
    (err) => err instanceof CtoAdmissionError && err.code === "stale-generation",
  );
});

// ---------------------------------------------------------------------------
// Crash + recovery (the P0 messageID receipt)
// ---------------------------------------------------------------------------

test("crash after receipt before persist: restart reconcile finds the receipt → accepted, NEVER resent", async () => {
  const store = memoryStore(`crash-${randomUUID()}`, { failSaveCalls: [3] }); // save #3 = the accepted persist
  const { svc, oc } = buildService({ store });
  const res = await svc.submit({ text: "survive the crash", origin: "human" });
  await svc.tick(); // send + receipt read-back succeed, then the persist "crashes"
  assert.equal(oc.sends.length, 1);
  const sentMessageId = oc.sends[0].messageID;
  const crashed = await recordOf(svc, res.id);
  assert.equal(crashed.status, "dispatching", "the store still holds the crash-window state");
  assert.equal(crashed.messageID, sentMessageId);
  // Reopen on the SAME store with a fresh oc; the role session's transcript
  // (the durable side) kept the receipt.
  const oc2 = fakeOc();
  oc2.transcript = oc.transcript;
  const { svc: svc2 } = buildService({ store, oc: oc2 });
  await svc2.reconcile();
  const record = await recordOf(svc2, res.id);
  assert.equal(record.status, "accepted");
  assert.ok(record.reconciledAt);
  assert.equal(oc2.sends.length, 0, "no resend: the receipt proves acceptance");
});

test("restart receipt: a persisted dispatching record with the receipt present is adopted; receipt absent stays unknown pending", async () => {
  const store = memoryStore(`restart-${randomUUID()}`);
  // Seed the EXACT crash-window states a restart can find on disk.
  await store.save({
    v: 1,
    submissions: [
      {
        id: "evt_land",
        origin: "human",
        text: "landed?",
        payloadHash: canonicalRequestHash({ origin: "human", text: "landed?" }),
        status: "dispatching",
        createdAt: 1,
        submitGeneration: 3,
        sessionId: "ses_cto",
        messageID: "msg_land",
        dispatchGeneration: 3,
        dispatchStartedAt: 2,
      },
      {
        id: "evt_lost",
        origin: "background",
        text: "lost?",
        payloadHash: canonicalRequestHash({ origin: "background", text: "lost?" }),
        status: "dispatching",
        createdAt: 1,
        submitGeneration: 3,
        sessionId: "ses_cto",
        messageID: "msg_lost",
        dispatchGeneration: 3,
        dispatchStartedAt: 2,
      },
    ],
  });
  const oc2 = fakeOc();
  oc2.transcript.set("msg_land", { info: { id: "msg_land", role: "user", time: { created: 1 } }, parts: [] });
  const { svc: svc2, clock } = buildService({ store, oc: oc2 });
  clock.t += 10_000;
  await svc2.reconcile();
  const after = await svc2.list();
  const landed = after.submissions.find((s) => s.id === "evt_land");
  assert.equal(landed.status, "accepted", "the receipt proves acceptance");
  const lost = after.submissions.find((s) => s.id === "evt_lost");
  assert.equal(lost.status, "unknown", "cannot prove acceptance → NEVER resend, surface pending");
  assert.ok(lost.receiptChecks >= 1);
  assert.equal(oc2.sends.length, 0);
  // And the unknown holds the one-turn gate until resolved or interrupted.
  await svc2.submit({ text: "next", origin: "human" });
  await svc2.tick();
  assert.equal(oc2.sends.length, 0, "admission stays held behind the unknown");
});

test("unknown submissions are surfaced (stale flag), never resent, and tick keeps them unknown", async () => {
  const { svc, oc, clock } = buildService({ oc: fakeOc({ sendOutcome: "network" }) });
  const res = await svc.submit({ text: "uncertain", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "unknown");
  assert.equal(oc.sends.length, 1);
  clock.t += 120_000; // past UNKNOWN_STALE_MS
  await svc.tick();
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "unknown");
  assert.equal(record.staleUnknown, true);
  assert.ok(record.unknownMs >= 120_000);
  assert.equal(oc.sends.length, 1, "still never resent");
});

test("definitive 4xx refusal is failed (proven not accepted); 5xx is unknown", async () => {
  const { svc, oc } = buildService({ oc: fakeOc({ sendOutcome: "http400" }) });
  await svc.submit({ id: "evt_400", text: "refused", origin: "human" });
  await svc.tick();
  const recA = await recordOf(svc, "evt_400");
  assert.equal(recA.status, "failed");
  assert.equal(recA.errorStatus, 400);
  assert.equal(oc.sends.length, 1);

  const { svc: svc5, oc: oc5 } = buildService({ oc: fakeOc({ sendOutcome: "http500" }) });
  await svc5.submit({ id: "evt_500", text: "maybe", origin: "human" });
  await svc5.tick();
  const recB = await recordOf(svc5, "evt_500");
  assert.equal(recB.status, "unknown", "a 5xx is uncertainty, not proof of refusal");
  assert.equal(oc5.sends.length, 1);
});

// ---------------------------------------------------------------------------
// Blocker 3: reconcile vs an active dispatch; cancellation vs a late send
// ---------------------------------------------------------------------------

test("reconcile skips the send this instance is currently awaiting (active-operation lease)", async () => {
  const { oc, releaseSend } = parkedSendOc();
  const { svc } = buildService({ oc, requestDeadlineMs: 5_000 });
  const res = await svc.submit({ text: "in flight", origin: "human" });
  // The submit's fire-and-forget pump claims the record and parks in the
  // send. Wait for that state (bounded poll, no timers-as-latches).
  for (let i = 0; i < 100 && (await statusOf(svc, res.id)) !== "dispatching"; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await statusOf(svc, res.id), "dispatching");
  const before = oc.getMessageCalls;
  await svc.reconcile(); // must NOT race the in-flight dispatch
  assert.equal(oc.getMessageCalls, before, "no receipt probe against an awaited send");
  releaseSend();
  await flush();
  const rec = await recordOf(svc, res.id);
  assert.equal(rec.status, "accepted", "the dispatch completed normally after the latch released");
  assert.equal(rec.receiptChecks ?? 0, 0, "reconcile never re-classified the awaited send");
});

test("delayed send + interrupt + follow-up tick: NEVER a second send; a late-landing POST is adopted, not erased (blockers 2+3)", async () => {
  let releaseSend;
  const gate = new Promise((resolve) => (releaseSend = resolve));
  const oc = fakeOc();
  oc.sendPrompt = async (args) => {
    oc.sends.push(args);
    try {
      await gate; // the POST is hanging past the deadline
    } finally {
      // The late 204: the server DID accept after the client gave up.
      oc.transcript.set(args.messageID, { info: { id: args.messageID, role: "user", time: { created: 1 } }, parts: [] });
      oc.rows.push({ info: { id: args.messageID, role: "user", time: { created: 1 } }, parts: [] });
    }
  };
  const { svc, clock } = buildService({ oc, requestDeadlineMs: 40 });
  await svc.submit({ id: "evt_slow", text: "slow", origin: "human" });
  await svc.tick(); // deadline fires → unknown
  assert.equal(await statusOf(svc, "evt_slow"), "unknown");
  await svc.interrupt("evt_slow", { reason: "user gave up" });
  assert.equal(await statusOf(svc, "evt_slow"), "cancel_requested", "visible request, POST not erased");
  clock.t += 1_000;
  await svc.tick(); // receipt not yet visible → stays, barrier held
  assert.equal(await statusOf(svc, "evt_slow"), "cancel_requested");
  assert.equal(oc.sends.length, 1, "follow-up tick never sends again");
  releaseSend(); // the late POST lands its receipt
  await flush();
  clock.t += 1_000;
  await svc.tick(); // reconcile finds the receipt → accepted (not cancelled)
  const record = await recordOf(svc, "evt_slow");
  assert.equal(record.status, "accepted");
  assert.equal(record.cancelRequested, true, "the request stays visible on the adopted record");
  assert.equal(oc.sends.length, 1);
  // The adopted turn finishes normally → the gate releases → next dispatches.
  clock.t += 1_000;
  oc.completeTurn(record.messageID);
  clock.t += 20_000;
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_slow"), "completed");
  await svc.submit({ id: "evt_next", text: "next", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 2);
});

// ---------------------------------------------------------------------------
// Interrupt (blocker 2)
// ---------------------------------------------------------------------------

test("interrupt: queued → cancelled without any abort; accepted → abort once → interrupted only on confirmed idle WITH transcript proof", async () => {
  const { svc, oc, clock } = buildService();
  // Contention so submit-order (not the fire-and-forget pump) decides which
  // record is accepted when the session frees: the EARLIER submission goes.
  svc.observeEvent({ type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } });
  clock.t += 1;
  await svc.submit({ id: "evt_running", text: "running", origin: "human" });
  await svc.submit({ id: "evt_q", text: "queued", origin: "human" });
  clock.t += 1;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_running"), "accepted");
  assert.equal(await statusOf(svc, "evt_q"), "queued");
  assert.equal(oc.aborts.length, 0, "no implicit abort from submit or tick");
  await svc.interrupt("evt_q", { reason: "user cancelled" });
  assert.equal(await statusOf(svc, "evt_q"), "cancelled");
  assert.equal(oc.aborts.length, 0);
  const res = await svc.interrupt("evt_running", { reason: "stop the turn" });
  await flush();
  assert.equal(oc.aborts.length, 1, "explicit interrupt of an accepted turn aborts once");
  assert.equal(oc.aborts[0], "ses_cto");
  assert.equal(res.status, "interrupt_pending", "NOT terminal yet");
  assert.equal(await statusOf(svc, "evt_running"), "interrupt_pending");
  // A stale idle BEFORE the transcript proves the turn ended must NOT settle
  // (events are triggers for receipt-specific reconciliation, never proof).
  clock.t += 5;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  assert.equal(await statusOf(svc, "evt_running"), "interrupt_pending", "no generic event proof");
  // Confirmed idle + transcript proof the turn ENDED → terminal interrupted.
  clock.t += 5;
  oc.completeTurn(oc.sends[0].messageID);
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  const rec = await recordOf(svc, "evt_running");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.interruptReason, "stop the turn");
  assert.equal(rec.outcome.kind, "idle");
  assert.equal(rec.abortState, "ok", "the abort settled definitively before terminalization");
  await assert.rejects(
    () => svc.interrupt("evt_running"),
    (err) => err instanceof CtoAdmissionError && err.code === "already-terminal",
  );
});

test("stale idle/error never terminalizes interrupt_pending when the abort is unsupported (blocker 1); no second send", async () => {
  const { svc, oc, clock } = buildService({ abortSession: null });
  await svc.submit({ id: "evt_run", text: "run", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_run"), "accepted");
  const res = await svc.interrupt("evt_run", { reason: "stop" });
  assert.equal(res.status, "interrupt_pending");
  const rec = await recordOf(svc, "evt_run");
  assert.equal(rec.abortState, "pending");
  assert.ok(rec.abortError.includes("abort-unsupported"));
  // Stale idle AND stale error events: receipt-specific reconciliation only —
  // no transcript proof of an ended turn → nothing terminalizes.
  clock.t += 5;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  clock.t += 5;
  svc.observeEvent({ type: "session.error", properties: { sessionID: "ses_cto", error: { name: "X" } } });
  await flush();
  assert.equal(await statusOf(svc, "evt_run"), "interrupt_pending", "unsupported abort keeps the barrier");
  // Even a finished turn does NOT settle it — the abort itself is unresolved.
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 5;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  const still = await recordOf(svc, "evt_run");
  assert.equal(still.status, "interrupt_pending");
  assert.ok(still.turnEndedAt, "the turn end is recorded separately from the abort state");
  // The barrier holds: a queued submission is never admitted, no second send.
  clock.t += 1;
  await svc.submit({ id: "evt_next", text: "next", origin: "human" });
  clock.t += 1;
  await svc.tick();
  assert.equal(oc.sends.length, 1, "no dispatch while the abort is unresolved");
});

test("an UNCERTAIN abort is never retried and its barrier is permanent (fail-closed, abort_outcome_unknown) — the late original abort can never kill a next turn (blocker 2 final)", async () => {
  const { oc, releaseAbort } = hangingAbortOc();
  const { svc, clock } = buildService({ oc, requestDeadlineMs: 40 });
  await svc.submit({ id: "evt_t1", text: "first", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_t1"), "accepted");
  await svc.interrupt("evt_t1", { reason: "stop" });
  await flush();
  const afterInterrupt = await recordOf(svc, "evt_t1");
  assert.equal(afterInterrupt.abortState, "uncertain", "deadline ≠ proof of server accept");
  assert.equal(afterInterrupt.abortOutcomeReason, "abort_outcome_unknown");
  assert.equal(oc.aborts.length, 1);
  // The turn finishes NATURALLY while the abort is outstanding.
  clock.t += 1_000;
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick(); // reconcile: records the turn end, NEVER retries
  const t1 = await recordOf(svc, "evt_t1");
  assert.equal(t1.status, "interrupt_pending", "turn terminal ≠ abort settled");
  assert.ok(t1.turnEndedAt);
  assert.equal(t1.abortState, "uncertain");
  assert.equal(t1.abortOutcomeReason, "abort_outcome_unknown");
  assert.equal(oc.aborts.length, 1, "NO automatic retry after uncertainty (monotonic)");
  assert.equal(t1.attemptCount, 1);
  // A hypothetical second attempt / next turn: never issued, no matter how
  // long the poller runs.
  clock.t += 60_000;
  await svc.tick();
  clock.t += 60_000;
  await svc.tick();
  assert.equal(oc.aborts.length, 1, "still no second attempt");
  assert.equal(oc.sends.length, 1, "no next send on that sid while the barrier holds");
  // The ORIGINAL abort lands LATE (the server processed it after all) —
  // exactly the scenario a retry would have raced: nothing else was ever
  // sent, so it kills nothing.
  releaseAbort();
  await flush();
  clock.t += 20_000;
  await svc.tick();
  assert.equal(oc.aborts.length, 1);
  assert.equal(oc.sends.length, 1, "the late original abort had no second turn to kill");
  const final = await recordOf(svc, "evt_t1");
  assert.equal(final.status, "interrupt_pending", "the barrier persists (explicit management op is future work)");
  assert.equal(final.abortOutcomeReason, "abort_outcome_unknown");
});

test("an abort timeout retains the barrier ACROSS RESTART with no re-issue; explicit reason persists (blocker 2 final)", async () => {
  let releaseAbort;
  const abortGate = new Promise((resolve) => (releaseAbort = resolve));
  const oc = fakeOc();
  oc.abortSession = async () => {
    await abortGate; // hangs → deadline → uncertain
  };
  const store = memoryStore(`abort-restart-${randomUUID()}`);
  const { svc } = buildService({ store, oc, requestDeadlineMs: 40 });
  await svc.submit({ id: "evt_r", text: "run", origin: "human" });
  await svc.tick();
  await svc.interrupt("evt_r");
  await flush();
  assert.equal((await recordOf(svc, "evt_r")).abortState, "uncertain");
  // RESTART: a fresh service instance over the same store. The uncertainty is
  // durable and monotonic — the new instance must NOT re-issue the abort and
  // must NOT settle the record, even with a perfectly healthy transport.
  let restartAborts = 0;
  oc.abortSession = async () => {
    restartAborts += 1;
  };
  const { svc: svc2, clock } = buildService({ store, oc });
  clock.t += 60_000;
  await svc2.submit({ id: "evt_next", text: "next", origin: "human" });
  await svc2.tick();
  await svc2.tick();
  const rec = await recordOf(svc2, "evt_r");
  assert.equal(rec.status, "interrupt_pending", "restart barrier holds");
  assert.equal(rec.abortState, "uncertain");
  assert.equal(rec.abortOutcomeReason, "abort_outcome_unknown");
  assert.equal(restartAborts, 0, "no automatic re-issue after uncertainty");
  assert.equal(oc.sends.length, 1, "no next send on that sid");
  assert.equal((await recordOf(svc2, "evt_next")).status, "queued", "the queued submission waits behind the barrier");
});

test("recovery fail-closes BOTH pending and claimed (attempted-but-unsettled) to uncertain — zero attempts, zero sends, monotonic", async () => {
  // "claimed": the crash snapshot INSIDE the abort mock proves the durable
  // reservation (attempt token) landed BEFORE the HTTP — the restart cannot
  // know whether the request was issued, so it NEVER issues one.
  let crashSnapshot = null;
  const store = memoryStore(`claim-crash-${randomUUID()}`);
  const { oc, releaseAbort } = hangingAbortOc({
    // Crash snapshot taken INSIDE the abort call: it must already show the
    // durable attempt reservation (the token landed BEFORE the HTTP).
    onAbort: async () => {
      crashSnapshot = JSON.parse(JSON.stringify(await store.load()));
    },
  });
  const { svc } = buildService({ store, oc, requestDeadlineMs: 60_000 });
  await svc.submit({ id: "evt_c", text: "run", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_c"), "accepted");
  // Fire the interrupt and ABANDON it (the crash): the owner stays parked on
  // the in-flight HTTP; its outcome is never persisted.
  void svc.interrupt("evt_c", { reason: "stop" });
  await flush();
  assert.equal((await recordOf(svc, "evt_c")).abortState, "claimed");
  assert.ok(crashSnapshot, "the snapshot was taken inside the abort call");
  const snapRec = crashSnapshot.submissions.find((s) => s.id === "evt_c");
  assert.equal(snapRec.abortState, "claimed", "the attempt token was durable BEFORE the HTTP");
  assert.match(snapRec.attemptId, /^abt_/);
  assert.equal(snapRec.attemptCount, 1);
  assert.ok(snapRec.attemptStartedAt);
  // RESTART: a fresh instance over the same store. Startup must issue ZERO
  // aborts and ZERO next sends: claimed-without-owner ⇒ uncertain barrier.
  const oc2 = fakeOc();
  const { svc: svc2, clock } = buildService({ store, oc: oc2 });
  clock.t += 60_000;
  await svc2.submit({ id: "evt_next", text: "next", origin: "human" });
  await svc2.tick();
  await svc2.tick();
  const rec = await recordOf(svc2, "evt_c");
  assert.equal(rec.status, "interrupt_pending", "restart barrier holds");
  assert.equal(rec.abortState, "uncertain");
  assert.equal(rec.abortOutcomeReason, "abort_outcome_unknown");
  assert.ok(rec.recoveredAt);
  assert.equal(oc2.aborts.length, 0, "startup issued zero aborts");
  assert.equal(oc2.sends.length, 0, "startup issued zero next sends");
  assert.equal(await statusOf(svc2, "evt_next"), "queued");
  // Release the ORIGINAL request (the server processed it late): the dead
  // owner's response must NOT settle the record (its state was downgraded —
  // matching-attempt guard), and the barrier persists.
  releaseAbort();
  await flush();
  clock.t += 20_000;
  await svc2.tick();
  const final = await recordOf(svc2, "evt_c");
  assert.equal(final.status, "interrupt_pending", "the barrier persists after the original abort landed");
  assert.equal(final.abortState, "uncertain");
  assert.equal(oc2.sends.length, 0, "still no send on that sid");

  // "pending": a durable request with NO attempt reservation (a crash before
  // the claim) — recovery also fail-closes it, never attempting.
  const store2 = memoryStore(`pending-recovery-${randomUUID()}`);
  await store2.save({
    v: 1,
    submissions: [
      {
        id: "evt_p",
        origin: "human",
        text: "interrupted before any attempt",
        payloadHash: canonicalRequestHash({ origin: "human", text: "interrupted before any attempt" }),
        status: "interrupt_pending",
        createdAt: 1,
        submitGeneration: 3,
        sessionId: "ses_cto",
        messageID: "msg_p",
        dispatchGeneration: 3,
        interruptRequestedAt: 2,
        abortState: "pending",
      },
    ],
  });
  const oc3 = fakeOc();
  oc3.rows.push({ info: { id: "msg_p", role: "user", time: { created: 1 } }, parts: [] });
  oc3.abortTurnRow("msg_p");
  const { svc: svc3, clock: clock3 } = buildService({ store: store2, oc: oc3 });
  clock3.t += 60_000;
  await svc3.tick();
  const recP = await recordOf(svc3, "evt_p");
  assert.equal(recP.status, "interrupt_pending");
  assert.equal(recP.abortState, "uncertain", "pending at recovery ⇒ uncertain (simpler fail-closed recovery)");
  assert.equal(recP.abortOutcomeReason, "abort_outcome_unknown");
  assert.equal(oc3.aborts.length, 0, "recovery never issues an abort");
  clock3.t += 60_000;
  await svc3.tick();
  assert.equal(oc3.aborts.length, 0, "and never does — uncertainty is final");
});

test("concurrent interrupt + reconcile claims AT MOST ONE abort attempt; a double interrupt issues exactly one", async () => {
  const { oc, releaseAbort } = hangingAbortOc();
  const { svc, clock } = buildService({ oc, requestDeadlineMs: 40 });
  await svc.submit({ id: "evt_race", text: "run", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_race"), "accepted");
  // Interrupt and reconcile race: only the interrupt claims an attempt.
  const [interruptRes] = await Promise.all([
    svc.interrupt("evt_race", { reason: "stop" }),
    svc.reconcile(),
    svc.reconcile(),
  ]);
  await flush();
  assert.equal(interruptRes.status, "interrupt_pending");
  const rec = await recordOf(svc, "evt_race");
  assert.equal(oc.aborts.length, 1, "exactly one abort attempt was claimed and issued");
  assert.equal(rec.abortState, "uncertain");
  assert.equal(rec.attemptCount, 1);
  // A second interrupt on the SAME record is idempotent: no new claim/POST.
  const again = await svc.interrupt("evt_race", { reason: "still stop" });
  assert.equal(again.status, "interrupt_pending");
  clock.t += 20_000;
  releaseAbort();
  await flush();
  assert.equal(oc.aborts.length, 1, "no second attempt ever");
});

test("reconcile settles an interrupt_pending record from transcript proof (restart mid-interrupt)", async () => {
  const { svc, oc, clock } = buildService();
  await svc.submit({ id: "evt_run", text: "run", origin: "human" });
  await svc.tick();
  oc.abortSession = async () => {}; // silent success (restart lost the outcome)
  await svc.interrupt("evt_run");
  assert.equal(await statusOf(svc, "evt_run"), "interrupt_pending");
  // The transcript proves the turn ended (aborts often leave no terminal
  // finish — the finish-agnostic turn-ended reader accepts this row).
  oc.abortTurnRow(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick();
  const rec = await recordOf(svc, "evt_run");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.outcome.kind, "reconciled");
});

// ---------------------------------------------------------------------------
// Receipts retained forever; hard cap on NEW entries
// ---------------------------------------------------------------------------

test("at-cap inline eviction: the oldest terminal receipt is tombstoned to admit a new submission (P3a3 review)", async () => {
  const store = memoryStore(`cap-${randomUUID()}`);
  const { svc, oc, clock } = buildService({ store, maxEntries: 3 });
  const a = await svc.submit({ id: "evt_a", text: "a", origin: "human" });
  await svc.tick();
  clock.t += 1;
  oc.completeTurn(oc.sends[0].messageID);
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  assert.equal(await statusOf(svc, a.id), "completed");
  // Hold the session busy so the queued entries stay queued while the cap
  // fills (the priority of this test is the cap path, not admission).
  svc.observeEvent({ type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } });
  clock.t += 1;
  await svc.submit({ id: "evt_b", text: "b", origin: "human" });
  clock.t += 1;
  await svc.submit({ id: "evt_c", text: "c", origin: "human" }); // fills the cap
  clock.t += 1;
  // At cap the completed receipt is queue BOOKKEEPING, not conversation
  // history: it yields (tombstoned — dedupe identity survives) instead of
  // refusing the new submission.
  const d = await svc.submit({ id: "evt_d", text: "d", origin: "human" });
  assert.equal(d.persisted, true, "the new submission is admitted, never refused");
  assert.equal(d.status, "queued");
  const q = await svc.list();
  assert.ok(!q.submissions.some((r) => r.id === "evt_a"), "the OLDEST terminal receipt was evicted");
  assert.ok(q.submissions.some((r) => r.id === "evt_b" && r.status === "queued"), "unresolved entries stay");
  assert.ok(q.submissions.some((r) => r.id === "evt_c" && r.status === "queued"), "unresolved entries stay");
  assert.ok(q.submissions.some((r) => r.id === "evt_d" && r.status === "queued"), "the new submission is queued");
  const raw = await store.load();
  assert.equal(raw.submissions.length, 3, "the store stays at cap (1 evicted + 1 created)");
  const tomb = (raw.tombstones ?? []).find((t) => t.id === "evt_a");
  assert.ok(tomb, "the evicted receipt's dedupe identity survives in the tombstone list");
  assert.equal(tomb.status, "completed");
  assert.equal(oc.sends.length, 1);
});

test("a human submit at cap drops the OLDEST QUEUED BACKGROUND delivery (cancelled-by-policy) — the human is never refused", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const tickHash = canonicalRequestHash({ origin: "background", text: "tick 1", agent: "cto-test" });
  await seedQueuedBackground(store, tickHash);
  // Hold the session busy: the pump must never dispatch here — the only
  // thing under test is the cap path and the tombstone replay, so a stray
  // send can never race the assertions.
  const { svc, oc } = buildService({ store, maxEntries: 3, isBusy: () => true });
  // A permanent barrier + a recurring schedule has filled the store with
  // QUEUED background deliveries. The human's own message must still get
  // in: the OLDEST queued background record yields instead.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  let receipt;
  try {
    receipt = await svc.submit({ origin: "human", text: "hello", id: "m_human", agent: "a" });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(receipt.persisted, true, "the human submit is ADMITTED, never refused at cap");
  assert.equal(receipt.status, "queued");
  const q = await svc.list();
  assert.ok(!q.submissions.some((r) => r.id === "sched:j1:m1"), "the OLDEST queued background delivery was dropped");
  assert.ok(q.submissions.some((r) => r.id === "sched:j1:m2" && r.status === "queued"), "younger queued deliveries stay");
  assert.ok(q.submissions.some((r) => r.id === "sched:j1:m3" && r.status === "queued"), "younger queued deliveries stay");
  assert.ok(q.submissions.some((r) => r.id === "m_human"), "the human record is present");
  const raw = await store.load();
  const tomb = (raw.tombstones ?? []).find((t) => t.id === "sched:j1:m1");
  assert.ok(tomb, "the dropped delivery's identity survives in the tombstone list");
  assert.equal(tomb.status, "cancelled", "cancelled-by-policy, never dispatched");
  // A retry of the dropped identity replays the tombstone — never re-fires.
  const replay = await svc.submit({
    origin: "background",
    text: "tick 1",
    id: "sched:j1:m1",
    agent: "cto-test",
  });
  assert.equal(replay.persisted, false, "replay — nothing new written");
  assert.equal(replay.status, "cancelled", "the cancelled-by-policy outcome is returned");
  assert.equal(oc.sends.length, 0, "no double-send");
  // Round 4: the drop must be OBSERVABLE. A one-shot schedule job deletes
  // itself the moment it fires, so a silently dropped reminder would never
  // happen AND leave no trace; a webhook already answered 202 vanishes the
  // same way. Name the drop on the server console and project it in the
  // queue listing.
  assert.ok(
    warns.some((w) => w.includes("sched:j1:m1") && w.includes("dropped-by-policy")),
    `the dropped delivery is named in a console.warn, got: ${warns.join(" | ")}`,
  );
  const listed = await svc.list();
  assert.deepEqual(
    listed.droppedByPolicy,
    [{ id: "sched:j1:m1", origin: "background", createdAt: 1 }],
    "dropped-by-policy deliveries are projected in the queue listing",
  );
});

test("a pump held by the unbound/busy gate stays silent — the skip shape reaches the pump (round 4, pre-existing from #1512)", async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    // Busy gate: queued work exists, the role session is busy — the pump
    // must hold SILENTLY. A malformed skip result fell through to
    // sendAndClassify(undefined) and logged a swallowed TypeError that
    // masked real pump failures.
    const busy = buildService({ isBusy: () => true });
    await busy.svc.submit({ origin: "background", text: "tick", id: "bg_1", agent: "cto-test" });
    await flush();
    // Unbound gate: same, with no bound session.
    const unbound = buildService({
      binding: fakeBinding({ generation: 1, currentSessionId: null }),
    });
    await unbound.svc.submit({ origin: "background", text: "tick", id: "bg_2", agent: "cto-test" });
    await flush();
    assert.ok(
      !warns.some((w) => w.includes("[ctoAdmission] pump failed")),
      `the pump must hold silently at the gates, got: ${warns.join(" | ")}`,
    );
  } finally {
    console.warn = origWarn;
  }
});

test("HUMAN dedupe identities outlive the tombstone horizon — a client resend never double-sends (round 4)", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const humanHash = canonicalRequestHash({ origin: "human", text: "hello", agent: "a" });
  await store.save({
    v: 1,
    submissions: [
      terminalRecord("bg_a", { origin: "background", payloadHash: "ha", createdAt: 1000 }),
      terminalRecord("bg_b", { origin: "background", payloadHash: "hb", createdAt: 1001 }),
      terminalRecord("bg_c", { origin: "background", payloadHash: "hc", createdAt: 1002 }),
    ],
    tombstones: [
      // The human identity is the composer's STABLE messageID — a client may
      // legitimately resend it, so it must never expire from the dedup set.
      { id: "m_human", payloadHash: humanHash, status: "completed", origin: "human", createdAt: 1 },
      ...Array.from({ length: 200 }, (_, i) => ({
        id: `bg_${i}`,
        payloadHash: `h${i}`,
        status: "completed",
        origin: "background",
        createdAt: 2 + i,
      })),
    ],
  });
  const { svc, oc } = buildService({ store, maxTerminalBackground: 2 });
  // Three terminal receipts against a bound of 2: the trim evicts the oldest
  // AND re-caps the tombstone list — under a horizon that also applies to
  // human ids, the human identity is dropped here.
  await svc.trimTerminal();
  // The human identity must have survived the cap. A resend of the same
  // message id replays the tombstone — a fresh record here would
  // DOUBLE-SEND the human's message.
  const resend = await svc.submit({ origin: "human", text: "hello", id: "m_human", agent: "a" });
  assert.equal(resend.persisted, false, "the client's resend dedups — never a fresh dispatch");
  assert.equal(resend.status, "completed", "the tombstoned outcome is returned");
  assert.equal(oc.sends.length, 0, "no double-send of the human message");
});

test("the TERMINAL comment no longer claims the repealed 'retained forever' (round 4)", () => {
  const source = readFileSync(new URL("./ctoAdmission.mjs", import.meta.url), "utf8");
  const lines = source.split("\n");
  const terminalIdx = lines.findIndex((l) => l.includes("const TERMINAL = new Set"));
  assert.ok(terminalIdx > 0, "the TERMINAL definition is present");
  const above = lines.slice(terminalIdx - 6, terminalIdx + 1).join("\n");
  assert.ok(
    !above.includes("Retained forever"),
    "invariant 5 no longer retains forever — the comment must not claim it",
  );
  assert.ok(
    above.includes("bounded"),
    "the comment carries the current bounded-bookkeeping contract",
  );
});

test("a BACKGROUND submit at cap cannot sacrifice its own queued peers — it refuses honestly", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  await seedQueuedBackground(store, "h1");
  const { svc } = buildService({ store, maxEntries: 3 });
  // Only a HUMAN submit may drop queued background records; a background
  // submit with nothing terminal to yield refuses (human FIFO outranks
  // background synthesis — the cap never reshuffles background order).
  await assert.rejects(
    () => svc.submit({ origin: "background", text: "tick 4", id: "sched:j1:m4", agent: "cto-test" }),
    /nothing evictable/,
  );
});

test("a human submit at cap with nothing queued-background to yield refuses honestly", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  await store.save({
    v: 1,
    submissions: [
      { id: "m_1", origin: "human", text: "one", payloadHash: "h1", status: "queued", createdAt: 1, submitGeneration: 1 },
      { id: "m_2", origin: "human", text: "two", payloadHash: "h2", status: "queued", createdAt: 2, submitGeneration: 1 },
      { id: "m_3", origin: "human", text: "three", payloadHash: "h3", status: "queued", createdAt: 3, submitGeneration: 1 },
    ],
  });
  const { svc } = buildService({ store, maxEntries: 3 });
  await assert.rejects(
    () => svc.submit({ origin: "human", text: "four", id: "m_4", agent: "a" }),
    /nothing background-queued remains/,
  );
});

// ---------------------------------------------------------------------------
// Binding generation: pending retargets, accepted stays
// ---------------------------------------------------------------------------

test("stale generation: pending submissions retarget the replacement binding; accepted turns keep their original sid", async () => {
  const { svc, oc, binding, clock } = buildService();
  const a = await svc.submit({ text: "first", origin: "human" });
  await svc.tick(); // accepted against ses_cto / generation 3
  const pending = await svc.submit({ text: "still queued", origin: "human" });
  binding.advance("ses_cto_v2"); // role session replaced → generation 4
  // Finish the accepted turn (transcript proof + terminal event) so the
  // pending submission can be admitted against the CURRENT binding.
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 1;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  clock.t += 20_000;
  await svc.tick();
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[0].sessionId, "ses_cto");
  assert.equal(oc.sends[1].sessionId, "ses_cto_v2", "pending work retargets the replacement binding");
  const aRecord = await recordOf(svc, a.id);
  assert.equal(aRecord.sessionId, "ses_cto", "accepted turns stay associated with their original session");
  const pRecord = await recordOf(svc, pending.id);
  assert.equal(pRecord.sessionId, "ses_cto_v2");
  assert.equal(pRecord.retargeted, true);
  assert.equal(pRecord.submitGeneration, 3);
  assert.equal(pRecord.dispatchGeneration, 4);
});

// ---------------------------------------------------------------------------
// No store lock across the opencode external await
// ---------------------------------------------------------------------------

test("a submit during an in-flight send completes promptly (no store lock held across the external await)", async () => {
  const { oc, releaseSend } = parkedSendOc();
  const { svc, clock } = buildService({ oc, requestDeadlineMs: 500 });
  const first = svc.submit({ text: "slow send", origin: "human" });
  await svc.tick(); // enters the send and parks on the gate
  const started = Date.now();
  clock.t += 1;
  const second = await svc.submit({ text: "while sending", origin: "human" });
  const elapsed = Date.now() - started;
  assert.equal(second.status, "queued");
  assert.ok(elapsed < 1000, `submit must not wait on the in-flight send (took ${elapsed}ms)`);
  releaseSend();
  await first;
  await flush();
  assert.equal(oc.sends.length, 1, "the parked dispatch completed exactly once");
});

test("a send that hangs past the deadline is classified unknown, and its late failure is not unhandled", async () => {
  const oc = fakeOc();
  oc.sendPrompt = async (args) => {
    oc.sends.push(args);
    await new Promise((_, reject) => setTimeout(() => reject(new Error("late socket failure")), 120));
  };
  const { svc } = buildService({ oc, requestDeadlineMs: 30 });
  const res = await svc.submit({ text: "hangs", origin: "human" });
  await svc.tick();
  const record = await recordOf(svc, res.id);
  assert.equal(record.status, "unknown", "a deadline hit (aborted client request) is uncertainty, never a resend trigger");
  assert.equal(record.unknownReason.includes("deadline"), true);
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the late rejection land
});

// ---------------------------------------------------------------------------
// Strict store validation + the real strict store file (blocker 4)
// ---------------------------------------------------------------------------

test("normalizeAdmissionPayload fails loudly on corruption; the default payload is empty and valid", () => {
  assert.deepEqual(normalizeAdmissionPayload({}).submissions, []);
  assert.throws(() => normalizeAdmissionPayload({ submissions: [{ id: "x" }] }), CtoAdmissionError);
  assert.throws(
    () =>
      normalizeAdmissionPayload({
        submissions: [
          {
            id: "x",
            origin: "human",
            text: "t",
            payloadHash: "h",
            status: "accepted",
            createdAt: 1,
            submitGeneration: 0,
            sessionId: "s",
          },
        ],
      }),
    /messageID/,
    "an accepted record without its receipt identity is corruption",
  );
  assert.throws(() => normalizeAdmissionPayload({ submissions: "nope" }), /submissions/);
  assert.doesNotThrow(
    () =>
      normalizeAdmissionPayload({
        submissions: [
          {
            id: "x",
            origin: "human",
            text: "t",
            payloadHash: "h",
            status: "interrupt_pending",
            createdAt: 1,
            submitGeneration: 0,
            sessionId: "s",
            messageID: "msg_x",
          },
        ],
      }),
    "interrupt_pending is a valid nonterminal barrier state",
  );
});

test("the strict admission store FAILS on malformed/null payload and preserves the file (blocker 4)", async () => {
  const file = statePath("cto", "admission.json");
  await mkdir(statePath("cto"), { recursive: true });
  try {
    // Top-level null: corruption → throw, file preserved byte-for-byte.
    await writeFile(file, "null", "utf-8");
    await assert.rejects(() => admissionStore.load(), /admission/);
    assert.equal(await readFile(file, "utf-8"), "null", "never reset/overwritten");
    // Unparsable JSON: throw, file preserved.
    await writeFile(file, "{ oops", "utf-8");
    await assert.rejects(() => admissionStore.load());
    assert.equal(await readFile(file, "utf-8"), "{ oops", "never reset/overwritten");
    // A read error (unreadable) also fails rather than falling back.
    await writeFile(file, "[]", "utf-8");
    await assert.rejects(() => admissionStore.load(), /array/);
    assert.equal(await readFile(file, "utf-8"), "[]", "never reset/overwritten");
  } finally {
    await rm(file, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Transcript reader unit behavior
// ---------------------------------------------------------------------------

test("turnCompletionFromTranscript: linkage + terminal finish only; running/tool/unlinked rows are not proof", () => {
  const user = { info: { id: "msg_u", role: "user" }, parts: [] };
  assert.deepEqual(turnCompletionFromTranscript([user], "msg_u"), { completed: false });
  assert.deepEqual(
    turnCompletionFromTranscript([user, { info: { id: "a", role: "assistant", parentID: "msg_u", time: { created: 1 } } }], "msg_u"),
    { completed: false },
  );
  assert.deepEqual(
    turnCompletionFromTranscript(
      [user, { info: { id: "a", role: "assistant", parentID: "msg_u", finish: "tool_use", time: { created: 1, completed: 2 } } }],
      "msg_u",
    ),
    { completed: false },
    "a completed tool step is not a completed turn",
  );
  assert.deepEqual(
    turnCompletionFromTranscript(
      [user, { info: { id: "unlinked", role: "assistant", parentID: "msg_other", finish: "stop", time: { created: 1, completed: 2 } } }],
      "msg_u",
    ),
    { completed: false },
    "an unlinked assistant row is never proof",
  );
  assert.deepEqual(
    turnCompletionFromTranscript(
      [
        user,
        { info: { id: "a1", role: "assistant", parentID: "msg_u", finish: "tool_use", time: { created: 1, completed: 2 } } },
        { info: { id: "a2", role: "assistant", parentID: "msg_u", finish: "stop", time: { created: 3, completed: 4 } } },
      ],
      "msg_u",
    ),
    { completed: true, via: "transcript", outcome: "ok" },
    "the LAST linked row decides: intermediate tool steps do not block the final proof",
  );
  assert.equal(turnCompletionFromTranscript([{ info: { id: "other", role: "user" } }], "msg_u"), null);
});

// ---------------------------------------------------------------------------
// Production composition: the REAL opencode.mjs client on the wire
// ---------------------------------------------------------------------------

test("production composition: real opencode.mjs sendPrompt carries the caller messageID AND the bounded signal on the wire; getMessage reads the receipt back", async () => {
  const { calls, reset } = spyOcWire(({ u, method, body }) => {
    if (method === "GET" && u.pathname === "/session/ses_live") {
      return new Response(
        JSON.stringify({ id: "ses_live", directory: "/tmp/cto-control", projectID: "global" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "POST" && u.pathname === "/session/ses_live/prompt_async") {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && u.pathname.startsWith("/session/ses_live/message/")) {
      // P0-proven behavior: the client messageID is persisted verbatim as the
      // user message id and is readable back — this IS the receipt.
      const mid = decodeURIComponent(u.pathname.slice("/session/ses_live/message/".length));
      return new Response(
        JSON.stringify({ info: { id: mid, role: "user", time: { created: 1 } }, parts: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${u.pathname}` }), { status: 500 });
  });
  ocModule._resetSessionDirectoryCache();
  try {
    await ocModule.sendPrompt({ sessionId: "ses_live", text: "wire probe", messageID: "msg_probe" });
    const post = calls.find((c) => c.method === "POST" && c.path === "/session/ses_live/prompt_async");
    assert.ok(post, "prompt_async hit the wire");
    assert.equal(post.body.messageID, "msg_probe", "the client messageID rides the prompt_async body");
    assert.equal(post.query.directory, "/tmp/cto-control");
    assert.equal(post.signal, undefined, "no signal given → none on the wire (pre-P3a2 compat)");
    // And WITHOUT a messageID the body omits it entirely (pre-P3a2 behavior).
    await ocModule.sendPrompt({ sessionId: "ses_live", text: "bare" });
    const bare = calls.filter((c) => c.method === "POST" && c.path === "/session/ses_live/prompt_async")[1];
    assert.equal(bare.body.messageID, undefined);

    const receipt = await ocModule.getMessage("ses_live", "msg_probe");
    assert.equal(receipt.info.id, "msg_probe", "the receipt read-back round-trips");

    // Production composition end-to-end: the admission service over the REAL
    // client functions, with a real binding store snapshot as the binding.
    const { svc } = buildService({
      binding: {
        getBinding: async () => ({ generation: 1, currentSessionId: "ses_live" }),
        claimGeneration: async (reserve) => {
          const b = { generation: 1, currentSessionId: "ses_live" };
          return { binding: b, result: await reserve(b) };
        },
      },
      sendPrompt: (args) => ocModule.sendPrompt(args),
      getMessage: (sid, mid) => ocModule.getMessage(sid, mid),
      store: memoryStore(`composition-${randomUUID()}`),
    });
    const res = await svc.submit({ text: "production admission", origin: "human" });
    await svc.tick();
    const record = await recordOf(svc, res.id);
    assert.equal(record.status, "accepted", "204 + wire receipt → accepted");
    assert.match(record.messageID, /^msg_/);
    const prodPost = calls.filter((c) => c.method === "POST" && c.path === "/session/ses_live/prompt_async").at(-1);
    assert.equal(prodPost.body.messageID, record.messageID);
    assert.equal(prodPost.body.parts.at(-1).text, "production admission");
    assert.ok(prodPost.signal instanceof AbortSignal, "the admission deadline bounds the real POST");
  } finally {
    reset();
  }
});

test("the default store resolves inside the state-home sandbox (never the live box)", async () => {
  assert.equal(admissionStore.path, statePath("cto", "admission.json"));
  assert.ok(admissionStore.path.startsWith(process.env.MANTA_STATE_HOME));
});

test("MAX_ENTRIES and the lifecycle constants are part of the published contract", () => {
  assert.equal(MAX_ENTRIES, 500);
});

// ---------------------------------------------------------------------------
// Blocker 3: the LINEARIZABLE binding claim (real ctoBinding service)
// ---------------------------------------------------------------------------

// A real ctoBinding over a memory store, pre-bound to ses_cto/generation 3.
// No opencode calls happen in these tests (ensure() is never invoked).
function realBindingService() {
  const store = memoryStore(`binding-${randomUUID()}`);
  const tripwire = () => {
    throw new Error("unexpected opencode call in the binding-claim test");
  };
  const binding = createCtoBinding({
    oc: { createSession: tripwire, listSessions: tripwire, readSession: tripwire },
    store,
    controlDir: statePath("cto-binding-test", `claim-${randomUUID()}`, "conversation"),
    sleep: async () => {},
  });
  return { binding, store };
}

const SEEDED_BINDING = {
  v: 1,
  generation: 3,
  currentSessionId: "ses_cto",
  currentOperation: "op-1",
  previousSessionIds: [],
};

test("binding claimGeneration is serialized against the store queue and reads the binding FRESH inside it (blocker 3)", async () => {
  const { binding, store } = realBindingService();
  await store.save({ ...SEEDED_BINDING });
  let releaseReserve;
  const gate = new Promise((resolve) => (releaseReserve = resolve));
  let firstEntered = false;
  const p1 = binding.claimGeneration(async (b) => {
    firstEntered = true;
    await gate; // hold the serialized section
    return { saw: b.generation };
  });
  const p2 = binding.claimGeneration(async (b) => ({ saw: b.generation }));
  await flush();
  assert.equal(firstEntered, true, "the first claim is running (holds the seam)");
  // A replacement commits DIRECTLY on the store while the first claim holds
  // the serialized section — the queued second claim must read it fresh.
  await store.save({ ...SEEDED_BINDING, generation: 9, currentSessionId: "ses_v9" });
  releaseReserve();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.binding.generation, 3, "the suspended claim keeps the binding it reserved against");
  assert.equal(r2.binding.generation, 9, "the follow-up claim reads FRESH — never a stale self-comparison");
});

test("a generation change committed BEFORE the dispatch claim is observed: pending work targets the CURRENT sid (blocker 3)", async () => {
  const { binding, store } = realBindingService();
  await store.save({ ...SEEDED_BINDING });
  const { svc, oc, clock } = buildService({ binding });
  const first = await svc.submit({ text: "first", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends[0].sessionId, "ses_cto");
  // A pending submission queues while turn 1 is unresolved; it was born
  // against generation 3.
  const pending = await svc.submit({ text: "pending retargets", origin: "human" });
  assert.equal((await recordOf(svc, pending.id)).submitGeneration, 3);
  // A replacement commits on the binding store (the ensure/recover seam writes
  // exactly this shape) BEFORE the next dispatch claim runs.
  await store.save({ ...SEEDED_BINDING, generation: 4, currentSessionId: "ses_cto_v2" });
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick();
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[1].sessionId, "ses_cto_v2", "the claim read the CURRENT binding inside the serialized section");
  const rec = await recordOf(svc, pending.id);
  assert.equal(rec.dispatchGeneration, 4);
  assert.equal(rec.retargeted, true);
});

test("a generation change DURING a suspended claim cannot steal the delivery: the claim keeps its own sid (blocker 3)", async () => {
  const { binding, store } = realBindingService();
  await store.save({ ...SEEDED_BINDING });
  // Suspend the claim INSIDE its serialized section: park the admission
  // store's first load after the claim has begun (the claim's re-verify load).
  let claimStarted = false;
  let parked = false;
  let releaseClaim;
  const claimGate = new Promise((resolve) => (releaseClaim = resolve));
  const realClaim = binding.claimGeneration.bind(binding);
  binding.claimGeneration = async (reserve) =>
    realClaim(async (b) => {
      claimStarted = true;
      return reserve(b);
    });
  const suspender = memoryStore(`suspender-${randomUUID()}`);
  const underlyingLoad = suspender.load.bind(suspender);
  suspender.load = async () => {
    if (claimStarted && !parked) {
      parked = true;
      await claimGate;
    }
    return underlyingLoad();
  };
  const { svc, oc, clock } = buildService({ binding, store: suspender });
  await svc.submit({ id: "evt_claimed", text: "claimed turn", origin: "human" });
  await flush();
  assert.equal(parked, true, "the claim is suspended inside the serialized section");
  // While the claim is suspended, a replacement commits on the binding store
  // AND queues behind the claim on the same seam.
  await store.save({ ...SEEDED_BINDING, generation: 4, currentSessionId: "ses_cto_v2" });
  let followUpSaw = null;
  const followUp = binding.claimGeneration(async (b) => {
    followUpSaw = { generation: b.generation, sid: b.currentSessionId };
  });
  releaseClaim();
  await flush();
  await followUp;
  assert.equal(followUpSaw.generation, 4, "the replacement serialized BEHIND the claim and read its change");
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].sessionId, "ses_cto", "the claimed delivery stays on its own session");
  const rec = await recordOf(svc, "evt_claimed");
  assert.equal(rec.sessionId, "ses_cto");
  assert.equal(rec.dispatchGeneration, 3);
  assert.equal(rec.status, "accepted");
});

// The claim path is load-bearing in production composition: the REAL binding
// service's claimGeneration drives the dispatch end-to-end.
test("production dispatch claims through the real binding service's claimGeneration", async () => {
  const { binding, store } = realBindingService();
  await store.save({ ...SEEDED_BINDING });
  const { svc, oc } = buildService({ binding });
  const res = await svc.submit({ text: "via the real claim", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].sessionId, "ses_cto");
  const rec = await recordOf(svc, res.id);
  assert.equal(rec.status, "accepted");
  assert.equal(rec.dispatchGeneration, 3);
});

// ---------------------------------------------------------------------------
// P3a3-review: bounded retention for terminal BACKGROUND receipts. Unique
// per-occurrence ids (schedule job+minute, webhook/delegate minted) make
// them grow one per delivery forever — invariant 5's "retained forever"
// would wedge the WHOLE conversation at MAX_ENTRIES (a */5 schedule hits it
// unattended in under two days), refusing even the human's own message.
// Terminal background receipts are evicted into durable tombstones; human
// receipts are never evicted.
// ---------------------------------------------------------------------------

function terminalRecord(id, { origin, payloadHash, text = "tick", createdAt }) {
  return {
    id,
    origin,
    text,
    payloadHash,
    status: "completed",
    createdAt,
    submitGeneration: 1,
    sessionId: "ses_cto",
    messageID: `msg_${id}`,
  };
}

/** A store holding exactly MAX_ENTRIES QUEUED BACKGROUND deliveries — the
 * "permanent barrier + recurring schedule" fixture for the at-cap tests. */
async function seedQueuedBackground(store, tick1Hash) {
  await store.save({
    v: 1,
    submissions: [
      { id: "sched:j1:m1", origin: "background", text: "tick 1", payloadHash: tick1Hash, status: "queued", createdAt: 1, submitGeneration: 1 },
      { id: "sched:j1:m2", origin: "background", text: "tick 2", payloadHash: "h2", status: "queued", createdAt: 2, submitGeneration: 1 },
      { id: "sched:j1:m3", origin: "background", text: "tick 3", payloadHash: "h3", status: "queued", createdAt: 3, submitGeneration: 1 },
    ],
  });
}

test("a human submit is never refused because terminal background receipts filled the store (inline tombstoning at cap)", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  await store.save({
    v: 1,
    submissions: Array.from({ length: 10 }, (_, i) =>
      terminalRecord(`bg_${i}`, { origin: "background", payloadHash: `h${i}`, createdAt: i }),
    ),
  });
  const { svc } = buildService({ store, maxEntries: 10, maxTerminalBackground: 3 });
  // BEFORE the fix: refused with at-cap ("terminal receipts are never evicted").
  const receipt = await svc.submit({ origin: "human", text: "hello", id: "m_human", agent: "a" });
  assert.equal(receipt.persisted, true, "the human submit succeeds");
  assert.equal(receipt.status, "queued");
  const q = await svc.list();
  assert.equal(q.submissions.length, 10, "the store stays at cap (1 evicted + 1 created)");
  assert.ok(q.submissions.some((r) => r.id === "m_human"), "the human record is present");
  assert.ok(!q.submissions.some((r) => r.id === "bg_0"), "the OLDEST background receipt was evicted");
  assert.ok(q.submissions.some((r) => r.id === "bg_9"), "the newest background receipt stays");
});

test("a genuine retry of an evicted (tombstoned) id still dedups and never double-sends", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const retryPayload = { origin: "background", text: "board check", agent: "cto-test" };
  const hash = canonicalRequestHash(retryPayload);
  await store.save({
    v: 1,
    submissions: [],
    tombstones: [
      {
        id: "sched:j1:2026-09-15T10:30",
        payloadHash: hash,
        status: "completed",
        origin: "background",
        createdAt: 1,
      },
    ],
  });
  const { svc, oc } = buildService({ store });
  // Same id + same payload → the tombstone replays the terminal receipt.
  const replay = await svc.submit({
    origin: "background",
    text: "board check",
    id: "sched:j1:2026-09-15T10:30",
    agent: "cto-test",
  });
  assert.equal(replay.persisted, false, "replay — nothing new written");
  assert.equal(replay.status, "completed", "the tombstoned outcome is returned");
  assert.equal(oc.sends.length, 0, "no double-send");
  // Same id + DIFFERENT payload under a tombstoned id stays a caller error.
  await assert.rejects(
    () =>
      svc.submit({
        origin: "background",
        text: "a different ask",
        id: "sched:j1:2026-09-15T10:30",
        agent: "cto-test",
      }),
    /different payload/,
  );
});

test("a NEW occurrence after eviction is a fresh submission (identities never recur, tombstones never resurrect)", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const hash = canonicalRequestHash({ origin: "background", text: "board check", agent: "cto-test" });
  await store.save({
    v: 1,
    submissions: [],
    tombstones: [
      {
        id: "sched:j1:2026-09-15T10:30",
        payloadHash: hash,
        status: "completed",
        origin: "background",
        createdAt: 1,
      },
    ],
  });
  const { svc } = buildService({ store });
  const next = await svc.submit({
    origin: "background",
    text: "board check",
    id: "sched:j1:2026-09-15T10:35", // the NEXT firing minute — a new identity
    agent: "cto-test",
  });
  assert.equal(next.persisted, true, "a new occurrence is a new submission");
});

test("trimTerminal tombstones the oldest terminal receipts beyond the bound, EITHER origin (sweeper hook)", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const humanPayload = { origin: "human", text: "hello", agent: "a" };
  await store.save({
    v: 1,
    submissions: [
      terminalRecord("bg_old", { origin: "background", payloadHash: "h_old", createdAt: 1 }),
      terminalRecord("h_old", {
        origin: "human",
        payloadHash: canonicalRequestHash(humanPayload),
        text: "hello",
        createdAt: 2,
      }),
      terminalRecord("bg_mid", { origin: "background", payloadHash: "h_mid", createdAt: 3 }),
      terminalRecord("h_new", { origin: "human", payloadHash: "h_new", createdAt: 4 }),
      terminalRecord("bg_new", { origin: "background", payloadHash: "h_newest", createdAt: 5 }),
    ],
  });
  const { svc, oc } = buildService({ store, maxTerminalBackground: 3 });
  const { evicted } = await svc.trimTerminal();
  assert.equal(evicted, 2, "the two OLDEST terminal receipts are evicted regardless of origin");
  const q = await svc.list();
  assert.equal(q.submissions.length, 3);
  assert.ok(!q.submissions.some((r) => r.id === "bg_old"), "the oldest background receipt is evicted");
  assert.ok(!q.submissions.some((r) => r.id === "h_old"), "the oldest HUMAN receipt is evicted too — queue bookkeeping, not conversation history");
  assert.ok(q.submissions.some((r) => r.id === "h_new"), "the newest human receipt stays");
  // Same tombstone treatment: a genuine same-id retry of the evicted HUMAN
  // receipt still dedups and never double-sends.
  const replay = await svc.submit({ origin: "human", text: "hello", id: "h_old", agent: "a" });
  assert.equal(replay.persisted, false, "replay — nothing new written");
  assert.equal(replay.status, "completed", "the tombstoned outcome is returned");
  assert.equal(oc.sends.length, 0, "no double-send");
});

test("UNRESOLVED records hold the gate: the at-cap refusal names them (terminal receipts never do anymore)", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  await store.save({
    v: 1,
    submissions: [
      { id: "m_1", origin: "human", text: "one", payloadHash: "h1", status: "accepted", createdAt: 1, submitGeneration: 1, sessionId: "ses_cto", messageID: "msg_1" },
      { id: "m_2", origin: "human", text: "two", payloadHash: "h2", status: "accepted", createdAt: 2, submitGeneration: 1, sessionId: "ses_cto", messageID: "msg_2" },
      { id: "m_3", origin: "human", text: "three", payloadHash: "h3", status: "accepted", createdAt: 3, submitGeneration: 1, sessionId: "ses_cto", messageID: "msg_3" },
    ],
  });
  const { svc } = buildService({ store, maxEntries: 3, maxTerminalBackground: 3 });
  await assert.rejects(
    () => svc.submit({ origin: "human", text: "one more", id: "m_more", agent: "a" }),
    (err) => err instanceof CtoAdmissionError && err.code === "at-cap" && /hold the gate/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// P3a3 full-parity widening: attachments, mentions, slash commands
// ---------------------------------------------------------------------------

const SAMPLE_ATTACHMENTS = [
  { remotePath: "/tmp/upload/a.png", mime: "image/png", filename: "a.png" },
];
const SAMPLE_MENTIONS = [{ name: "build", source: { value: "@build", start: 0, end: 6 } }];

test("canonicalRequestHash includes attachments/mentions/kind/command/args: a different value changes the hash", () => {
  const base = { origin: "human", text: "hi", agent: "a" };
  const baseHash = canonicalRequestHash(base);
  assert.notEqual(canonicalRequestHash({ ...base, attachments: SAMPLE_ATTACHMENTS }), baseHash);
  assert.notEqual(canonicalRequestHash({ ...base, mentions: SAMPLE_MENTIONS }), baseHash);
  assert.notEqual(canonicalRequestHash({ ...base, kind: "command", command: "init", args: "" }), baseHash);
  assert.notEqual(
    canonicalRequestHash({ ...base, kind: "command", command: "init", args: "a" }),
    canonicalRequestHash({ ...base, kind: "command", command: "init", args: "b" }),
  );
  // Same payload, same hash — determinism (round-trip identity for dedup).
  assert.equal(
    canonicalRequestHash({ ...base, attachments: SAMPLE_ATTACHMENTS, mentions: SAMPLE_MENTIONS }),
    canonicalRequestHash({ ...base, attachments: SAMPLE_ATTACHMENTS, mentions: SAMPLE_MENTIONS }),
  );
});

test("attachments and mentions round-trip through a persisted record and reach sendPrompt verbatim on dispatch", async () => {
  const { svc, oc } = buildService();
  const res = await svc.submit({
    text: "look at this",
    origin: "human",
    agent: "a",
    attachments: SAMPLE_ATTACHMENTS,
    mentions: SAMPLE_MENTIONS,
  });
  const stored = await recordOf(svc, res.id);
  assert.deepEqual(stored.attachments, SAMPLE_ATTACHMENTS, "persisted verbatim before any send (invariant 1)");
  assert.deepEqual(stored.mentions, SAMPLE_MENTIONS);
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.deepEqual(oc.sends[0].attachments, SAMPLE_ATTACHMENTS, "dispatch hands them to sendPrompt unchanged");
  assert.deepEqual(oc.sends[0].mentions, SAMPLE_MENTIONS);
  assert.equal((await recordOf(svc, res.id)).status, "accepted");
});

test("a same-id replay with the SAME attachments dedups; the SAME id with DIFFERENT attachments is a caller error", async () => {
  const { svc, oc } = buildService();
  const first = await svc.submit({
    text: "hi",
    origin: "human",
    id: "evt_att",
    agent: "a",
    attachments: SAMPLE_ATTACHMENTS,
  });
  assert.equal(first.persisted, true);
  const replay = await svc.submit({
    text: "hi",
    origin: "human",
    id: "evt_att",
    agent: "a",
    attachments: SAMPLE_ATTACHMENTS,
  });
  assert.equal(replay.persisted, false, "identical payload — dedups, no new record");
  await assert.rejects(
    () =>
      svc.submit({
        text: "hi",
        origin: "human",
        id: "evt_att",
        agent: "a",
        attachments: [{ remotePath: "/tmp/upload/different.png", mime: "image/png" }],
      }),
    (err) => err instanceof CtoAdmissionError && err.code === "duplicate-id-different-payload",
  );
  // The pump is kicked fire-and-forget by every submit() (including the
  // dedup replay); by now it may have dispatched the ONE legitimate record.
  // What matters is no DOUBLE-send happened — the replay/rejected-payload
  // calls never triggered a second send for the same submission.
  await flush(20);
  assert.ok(oc.sends.length <= 1, "no double-send from the replay or the rejected different-payload attempt");
});

test("submit rejects a malformed caller-supplied attachment/mention (loose-but-correct input validation)", async () => {
  const { svc } = buildService();
  await assert.rejects(
    () => svc.submit({ text: "hi", origin: "human", attachments: [{ mime: "image/png" }] }),
    (err) => err instanceof CtoAdmissionError && err.code === "invalid-argument" && /remotePath/.test(err.message),
  );
  await assert.rejects(
    () => svc.submit({ text: "hi", origin: "human", mentions: [{ name: "build" }] }),
    (err) => err instanceof CtoAdmissionError && err.code === "invalid-argument" && /source/.test(err.message),
  );
});

test("a kind:\"command\" submission dispatches via sendCommand (not sendPrompt) and carries model/agent/attachments", async () => {
  const { svc, oc } = buildService();
  const res = await svc.submit({
    origin: "human",
    kind: "command",
    command: "init",
    args: "--force",
    agent: "a",
    model: { providerID: "anthropic", modelID: "claude" },
    attachments: SAMPLE_ATTACHMENTS,
  });
  // submit()'s own return value carries the record UNPROJECTED (list()'s
  // stripping of `text` is a queue-listing concern, not submit()'s contract).
  assert.equal(res.kind, "command");
  assert.equal(res.command, "init");
  assert.equal(res.text, "/init --force", "a synthesized display form — never sent to opencode");
  const stored = await recordOf(svc, res.id);
  assert.equal(stored.kind, "command");
  assert.equal(stored.command, "init");
  await svc.tick();
  assert.equal(oc.sends.length, 0, "sendPrompt was NOT called for a command");
  assert.equal(oc.commandSends.length, 1, "sendCommand WAS called");
  const sent = oc.commandSends[0];
  assert.equal(sent.command, "init");
  assert.equal(sent.arguments, "--force", "the record's `args` maps to sendCommand's `arguments` param");
  assert.deepEqual(sent.attachments, SAMPLE_ATTACHMENTS);
  assert.equal(sent.agent, "a");
  assert.deepEqual(sent.model, { providerID: "anthropic", modelID: "claude" });
  assert.equal((await recordOf(svc, res.id)).status, "accepted");
});

test("a command with no args still dispatches (empty string, never undefined) and a bare command needs no text", async () => {
  const { svc, oc } = buildService();
  const res = await svc.submit({ origin: "human", kind: "command", command: "undo", agent: "a" });
  assert.equal(res.text, "/undo");
  await svc.tick();
  assert.equal(oc.commandSends[0].arguments, "", "args defaults to the empty string, never undefined");
});

test("a definitive 4xx from sendCommand fails the record; anything else is unknown — same classification as sendPrompt", async () => {
  {
    const { svc, oc } = buildService({ oc: fakeOc({ sendOutcome: "http400" }) });
    const res = await svc.submit({ origin: "human", kind: "command", command: "bad", agent: "a" });
    await svc.tick();
    assert.equal((await recordOf(svc, res.id)).status, "failed");
    assert.equal(oc.commandSends.length, 1);
  }
  {
    const { svc, oc } = buildService({ oc: fakeOc({ sendOutcome: "network" }) });
    const res = await svc.submit({ origin: "human", kind: "command", command: "flaky", agent: "a" });
    await svc.tick();
    assert.equal((await recordOf(svc, res.id)).status, "unknown", "uncertainty — never resend");
    assert.equal(oc.commandSends.length, 1);
  }
});

test("submit refuses kind:\"command\" outright — before persisting anything — when no sendCommand transport is wired", async () => {
  const store = memoryStore(`t-${randomUUID()}`);
  const svc = createCtoAdmission({
    store,
    binding: fakeBinding(),
    sendPrompt: async () => {},
    getMessage: async () => null,
    now: () => 1,
    sleep: async () => {},
    // sendCommand deliberately omitted
  });
  await assert.rejects(
    () => svc.submit({ origin: "human", kind: "command", command: "init", agent: "a" }),
    (err) => err instanceof CtoAdmissionError && err.code === "invalid-argument" && /no sendCommand transport/.test(err.message),
  );
  const raw = await store.load();
  assert.equal((raw?.submissions ?? []).length, 0, "nothing was ever persisted for the refused command");
});

test("submit rejects an unknown kind, and command/args without kind:\"command\"", async () => {
  const { svc } = buildService();
  await assert.rejects(
    () => svc.submit({ origin: "human", text: "hi", kind: "bogus" }),
    (err) => err instanceof CtoAdmissionError && err.code === "invalid-argument",
  );
  await assert.rejects(
    () => svc.submit({ origin: "human", text: "hi", command: "init" }),
    (err) => err instanceof CtoAdmissionError && err.code === "invalid-argument" && /kind:"command"/.test(err.message),
  );
});

test("list() strips a command's free-text args (payload) but keeps attachments/mentions/command/kind (metadata)", async () => {
  const { svc } = buildService();
  const promptRes = await svc.submit({
    text: "hi",
    origin: "human",
    agent: "a",
    attachments: SAMPLE_ATTACHMENTS,
    mentions: SAMPLE_MENTIONS,
  });
  const cmdRes = await svc.submit({ origin: "human", kind: "command", command: "init", args: "secret-ish", agent: "b" });
  const { submissions } = await svc.list();
  const projectedPrompt = submissions.find((r) => r.id === promptRes.id);
  const projectedCmd = submissions.find((r) => r.id === cmdRes.id);
  assert.equal(projectedPrompt.text, undefined, "text stays out of the projection");
  assert.deepEqual(projectedPrompt.attachments, SAMPLE_ATTACHMENTS, "attachments are metadata, not payload");
  assert.deepEqual(projectedPrompt.mentions, SAMPLE_MENTIONS);
  assert.equal(projectedCmd.kind, "command");
  assert.equal(projectedCmd.command, "init");
  assert.equal(projectedCmd.args, undefined, "a command's free-text argument body is stripped, same as text");
  assert.equal(projectedCmd.text, undefined);
});

// ---------------------------------------------------------------------------
// P3a3 full-parity widening: normalizeAdmissionPayload strict corruption
// ---------------------------------------------------------------------------

function baseRecord(overrides = {}) {
  return {
    id: "evt_1",
    origin: "human",
    text: "hi",
    payloadHash: "h",
    status: "queued",
    createdAt: 1,
    submitGeneration: 1,
    ...overrides,
  };
}

test("normalizeAdmissionPayload refuses a malformed attachments/mentions shape in the store (corruption fails loudly)", () => {
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ attachments: [] })] }),
    /attachments/,
    "an empty-but-present array is itself a corruption signal (submit() never writes one)",
  );
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ attachments: [{ mime: "image/png" }] })] }),
    /remotePath/,
  );
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ mentions: [{ name: "x", source: { value: "@x" } }] })] }),
    /source/,
  );
});

test("normalizeAdmissionPayload refuses kind:\"command\" without a command, and command/args without kind:\"command\"", () => {
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ kind: "command" })] }),
    /command/,
  );
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ command: "init", args: "" })] }),
    /command\/args/,
  );
  assert.throws(
    () => normalizeAdmissionPayload({ submissions: [baseRecord({ kind: "bogus" })] }),
    /kind/,
  );
  // A valid command record normalizes cleanly.
  const ok = normalizeAdmissionPayload({
    submissions: [baseRecord({ kind: "command", command: "init", args: "--force" })],
  });
  assert.equal(ok.submissions[0].command, "init");
});
