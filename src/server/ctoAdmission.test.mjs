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
function fakeBinding({ generation = 3, currentSessionId = "ses_cto" } = {}) {
  const state = { generation, currentSessionId };
  return {
    state,
    async getBinding() {
      return { ...state };
    },
    advance(newSessionId) {
      state.generation += 1;
      state.currentSessionId = newSessionId;
    },
  };
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
    aborts: [],
    getMessageCalls: 0,
    transcript: new Map(), // messageID → receipt row
    rows: [...rows],
    async sendPrompt({ sessionId, text, model, agent, messageID }) {
      oc.sends.push({ sessionId, text, model, agent, messageID });
      if (sendOutcome === "http400") {
        const err = new Error("opencode sendPrompt 400: bad request");
        err.status = 400;
        throw err;
      }
      if (sendOutcome === "http500") {
        const err = new Error("opencode sendPrompt 500: boom");
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
      return undefined; // the 204
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
  };
  return oc;
}

function buildService({ store = memoryStore(`t-${randomUUID()}`), binding = fakeBinding(), oc = fakeOc(), clock = { t: 1_000_000 }, ...rest } = {}) {
  const svc = createCtoAdmission({
    store,
    binding,
    sendPrompt: oc.sendPrompt.bind(oc),
    getMessage: oc.getMessage.bind(oc),
    listMessages: oc.listMessages.bind(oc),
    abortSession: oc.abortSession.bind(oc),
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
  // Latch ONLY the pump's binding resolution (call 2): the submits' own
  // generation reads (calls 1 and 3) resolve immediately, so both records
  // are durably queued while the pump is parked mid-selection.
  let releaseBinding;
  const gate = new Promise((resolve) => (releaseBinding = resolve));
  let bindingCalls = 0;
  binding.getBinding = async () => {
    bindingCalls += 1;
    if (bindingCalls === 2) await gate;
    return { generation: 3, currentSessionId: "ses_cto" };
  };
  const bg = await svc.submit({ id: "evt_bg", text: "background picked first", origin: "background" });
  const h = await svc.submit({ id: "evt_h", text: "human arrives during the await", origin: "human" });
  await flush();
  assert.equal(oc.sends.length, 0, "pump is parked on the binding latch");
  releaseBinding();
  await flush();
  await svc.tick();
  assert.equal(oc.sends.length, 1);
  assert.equal(oc.sends[0].text, "human arrives during the await", "the stale background pick was re-verified at claim time");
  assert.equal(await statusOf(svc, h.id), "accepted");
  assert.equal(await statusOf(svc, bg.id), "queued", "the background submission waits its turn");
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

test("interrupt: queued → cancelled without any abort; accepted → abort runs once then interrupt_pending until confirmed idle", async () => {
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
  assert.equal(res.status, "interrupt_pending", "NOT terminal yet: the session is not confirmed idle");
  assert.equal(await statusOf(svc, "evt_running"), "interrupt_pending");
  assert.equal(await recInterruptBarrier(svc), true, "the nonterminal barrier still holds");
  // Confirmed idle for receipt → terminal interrupted with the outcome.
  clock.t += 5;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  const rec = await recordOf(svc, "evt_running");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.interruptReason, "stop the turn");
  assert.equal(rec.outcome.kind, "idle");
  await assert.rejects(
    () => svc.interrupt("evt_running"),
    (err) => err instanceof CtoAdmissionError && err.code === "already-terminal",
  );
});

const recInterruptBarrier = async (svc) => {
  const l = await svc.list();
  return l.counts.unresolved >= 1;
};

test("a failed/unsupported abort RETAINS the interrupt_pending barrier (blocker 2)", async () => {
  const oc = fakeOc();
  oc.abortSession = async () => {
    throw new Error("abort transport hung");
  };
  const { svc, oc: _oc, clock } = buildService({ oc });
  await svc.submit({ id: "evt_run", text: "run", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_run"), "accepted");
  const res = await svc.interrupt("evt_run", { reason: "stop" });
  assert.equal(res.status, "interrupt_pending", "abort failure keeps the request pending");
  const rec = await recordOf(svc, "evt_run");
  assert.equal(rec.status, "interrupt_pending");
  assert.ok(rec.abortError.includes("abort transport hung"));
  // Barrier retained: a queued submission does NOT jump the fence.
  clock.t += 1;
  await svc.submit({ id: "evt_next", text: "next", origin: "human" });
  clock.t += 1;
  await svc.tick();
  assert.equal(oc.sends.length, 1, "no new dispatch while interrupt_pending");
  // No abortSession transport wired at all: same retained barrier.
  const { svc: svc2, oc: oc2 } = buildService({ abortSession: null });
  await svc2.submit({ id: "evt_run2", text: "run", origin: "human" });
  await svc2.tick();
  const res2 = await svc2.interrupt("evt_run2");
  assert.equal(res2.status, "interrupt_pending");
  const rec2 = await recordOf(svc2, "evt_run2");
  assert.ok(rec2.abortError.includes("abort-unsupported"));
  assert.equal(oc2.aborts.length, 0);
});

test("reconcile settles an interrupt_pending record from transcript proof (restart mid-interrupt)", async () => {
  const { svc, oc, clock } = buildService();
  await svc.submit({ id: "evt_run", text: "run", origin: "human" });
  await svc.tick();
  oc.abortSession = async () => {}; // silent success (restart lost the outcome)
  await svc.interrupt("evt_run");
  assert.equal(await statusOf(svc, "evt_run"), "interrupt_pending");
  // The transcript proves the turn ended (aborts often leave no terminal
  // finish, but a completed linked row does prove it).
  oc.completeTurn(oc.sends[0].messageID);
  clock.t += 20_000;
  await svc.tick();
  const rec = await recordOf(svc, "evt_run");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.outcome.kind, "reconciled");
});

// ---------------------------------------------------------------------------
// Receipts retained forever; hard cap on NEW entries
// ---------------------------------------------------------------------------

test("terminal receipts are retained: the store never evicts; new submissions are refused at the cap", async () => {
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
  // fills (the priority of this test is retention, not admission).
  svc.observeEvent({ type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } });
  clock.t += 1;
  await svc.submit({ id: "evt_b", text: "b", origin: "human" });
  clock.t += 1;
  await svc.submit({ id: "evt_c", text: "c", origin: "human" }); // fills the cap
  clock.t += 1;
  await assert.rejects(
    () => svc.submit({ id: "evt_d", text: "d", origin: "human" }),
    (err) => err instanceof CtoAdmissionError && err.code === "at-cap",
  );
  const raw = await store.load();
  assert.equal(raw.submissions.length, 3, "no eviction: the completed receipt and queued entries stay");
  assert.equal(oc.sends.length, 1);
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
  const calls = [];
  const prev = ocModule._setOcTransport(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, signal: init.signal });
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
      binding: { getBinding: async () => ({ generation: 1, currentSessionId: "ses_live" }) },
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
    ocModule._setOcTransport(prev);
    ocModule._resetSessionDirectoryCache();
  }
});

test("the default store resolves inside the state-home sandbox (never the live box)", async () => {
  assert.equal(admissionStore.path, statePath("cto", "admission.json"));
  assert.ok(admissionStore.path.startsWith(process.env.MANTA_STATE_HOME));
});

test("MAX_ENTRIES and the lifecycle constants are part of the published contract", () => {
  assert.equal(MAX_ENTRIES, 500);
});
