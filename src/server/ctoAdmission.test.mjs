// BET-P3a2: src/server/ctoAdmission.test.mjs — the durable per-CTO
// conversation admission queue (unified-cto-spec §8.3). Synthetic oc +
// injected stores for the state-machine tests; one production-composition
// test drives the REAL opencode.mjs client through `_setOcTransport` to pin
// the P0-proven messageID receipt on the wire. No live opencode, no network,
// no model calls.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  CtoAdmissionError,
  MAX_ENTRIES,
  canonicalRequestHash,
  createCtoAdmission,
  normalizeAdmissionPayload,
  turnCompletionFromTranscript,
} from "./ctoAdmission.mjs";
import { admissionStore } from "./ctoStores.mjs";
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
// transcript map, and can fail sends in the three meaningful ways.
function fakeOc({
  sendOutcome = "ok", // "ok" | "http400" | "http500" | "network"
  receiptLands = true,
  transcriptRows = [],
} = {}) {
  const oc = {
    sends: [],
    aborts: [],
    transcript: new Map(), // messageID → receipt row
    rows: [...transcriptRows],
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
      }
      return undefined; // the 204
    },
    async getMessage(sessionId, messageId) {
      return oc.transcript.get(messageId) ?? null;
    },
    async listMessages(sessionId) {
      return oc.rows;
    },
    async abortSession(sessionId) {
      oc.aborts.push(sessionId);
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
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
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
// Concurrency + priority
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
  // That turn's terminal → the background synthesis is next (FIFO within
  // each origin; humans have drained).
  clock.t += 1;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  await svc.tick();
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[1].text, "bg first in line");
  const bgRecord = (await svc.list()).submissions.find((s) => s.id === bg.id);
  assert.equal(bgRecord.status, "accepted");
  const hRecord = (await svc.list()).submissions.find((s) => s.id === h.id);
  assert.equal(hRecord.status, "completed");
  assert.equal(hRecord.outcome.kind, "idle");
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
// Ack is not completion
// ---------------------------------------------------------------------------

test("204 ack + receipt is ACCEPTED, not completed; only the terminal event completes", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted");
  clock.t += 5;
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "idle");
  assert.ok(record.completedAt > 1_000_000);
});

test("session.error is a terminal event carrying the error name", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  clock.t += 5;
  svc.observeEvent({
    type: "session.error",
    properties: { sessionID: "ses_cto", error: { name: "ProviderAuthError" } },
  });
  await flush();
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "error");
  assert.equal(record.outcome.errorName, "ProviderAuthError");
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

test("same id + same payload is idempotent; same id + different payload is an error and the original is untouched", async () => {
  const { svc, oc, store } = buildService();
  const first = await svc.submit({ id: "evt_dup", text: "original", origin: "human" });
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
  const crashed = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(crashed.status, "dispatching", "the store still holds the crash-window state");
  assert.equal(crashed.messageID, sentMessageId);
  // Reopen on the SAME store with a fresh oc; the role session's transcript
  // (the durable side) kept the receipt.
  const oc2 = fakeOc();
  oc2.transcript = oc.transcript;
  const { svc: svc2 } = buildService({ store, oc: oc2 });
  await svc2.reconcile();
  const record = (await svc2.list()).submissions.find((s) => s.id === res.id);
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
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(record.status, "unknown");
  assert.equal(record.staleUnknown, true);
  assert.ok(record.unknownMs >= 120_000);
  assert.equal(oc.sends.length, 1, "still never resent");
});

test("definitive 4xx refusal is failed (proven not accepted); 5xx is unknown", async () => {
  const { svc, oc } = buildService({ oc: fakeOc({ sendOutcome: "http400" }) });
  const a = await svc.submit({ id: "evt_400", text: "refused", origin: "human" });
  await svc.tick();
  const recA = (await svc.list()).submissions.find((s) => s.id === a.id);
  assert.equal(recA.status, "failed");
  assert.equal(recA.errorStatus, 400);
  assert.equal(oc.sends.length, 1);

  const { svc: svc5, oc: oc5 } = buildService({ oc: fakeOc({ sendOutcome: "http500" }) });
  const b = await svc5.submit({ id: "evt_500", text: "maybe", origin: "human" });
  await svc5.tick();
  const recB = (await svc5.list()).submissions.find((s) => s.id === b.id);
  assert.equal(recB.status, "unknown", "a 5xx is uncertainty, not proof of refusal");
  assert.equal(oc5.sends.length, 1);
});

// ---------------------------------------------------------------------------
// Binding generation: pending retargets, accepted stays
// ---------------------------------------------------------------------------

test("stale generation: pending submissions retarget the replacement binding; accepted turns keep their original sid", async () => {
  const { svc, oc, binding } = buildService();
  const a = await svc.submit({ text: "first", origin: "human" });
  await svc.tick(); // accepted against ses_cto / generation 3
  const pending = await svc.submit({ text: "still queued", origin: "human" });
  binding.advance("ses_cto_v2"); // role session replaced → generation 4
  svc.observeEvent({ type: "session.idle", properties: { sessionID: "ses_cto" } });
  await flush();
  await svc.tick(); // admits the pending submission against the CURRENT binding
  assert.equal(oc.sends.length, 2);
  assert.equal(oc.sends[0].sessionId, "ses_cto");
  assert.equal(oc.sends[1].sessionId, "ses_cto_v2", "pending work retargets the replacement binding");
  const aRecord = (await svc.list()).submissions.find((s) => s.id === a.id);
  assert.equal(aRecord.sessionId, "ses_cto", "accepted turns stay associated with their original session");
  const pRecord = (await svc.list()).submissions.find((s) => s.id === pending.id);
  assert.equal(pRecord.sessionId, "ses_cto_v2");
  assert.equal(pRecord.retargeted, true);
  assert.equal(pRecord.submitGeneration, 3);
  assert.equal(pRecord.dispatchGeneration, 4);
});

test("submit with an explicit expectedGeneration refuses on mismatch (optimistic CAS)", async () => {
  const { svc } = buildService();
  await assert.rejects(
    () => svc.submit({ text: "stale client", origin: "human", expectedGeneration: 2 }),
    (err) => err instanceof CtoAdmissionError && err.code === "stale-generation",
  );
  const ok = await svc.submit({ text: "fresh client", origin: "human", expectedGeneration: 3 });
  assert.equal(ok.status, "queued");
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
// Interrupt — the explicit operation
// ---------------------------------------------------------------------------

test("interrupt: queued → cancelled without any abort; accepted → abortSession runs exactly once", async () => {
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
  await svc.interrupt("evt_running", { reason: "stop the turn" });
  await flush();
  assert.equal(oc.aborts.length, 1, "explicit interrupt of an accepted turn aborts once");
  assert.equal(oc.aborts[0], "ses_cto");
  const rec = (await svc.list()).submissions.find((s) => s.id === "evt_running");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.interruptReason, "stop the turn");
  await assert.rejects(
    () => svc.interrupt("evt_running"),
    (err) => err instanceof CtoAdmissionError && err.code === "already-terminal",
  );
});

test("interrupt on an unknown record cancels it and unblocks the queue", async () => {
  const { svc, oc, clock } = buildService({ oc: fakeOc({ sendOutcome: "network" }) });
  await svc.submit({ id: "evt_unknown", text: "stuck", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, "evt_unknown"), "unknown");
  clock.t += 1;
  await svc.submit({ id: "evt_next", text: "next", origin: "human" });
  await svc.tick();
  assert.equal(oc.sends.length, 1, "unknown holds the gate");
  await svc.interrupt("evt_unknown", { reason: "abandon" });
  assert.equal(await statusOf(svc, "evt_unknown"), "cancelled");
  await svc.tick();
  assert.equal(oc.sends.length, 2, "the gate is released");
});

// ---------------------------------------------------------------------------
// Transcript-based turn completion (restart mid-turn)
// ---------------------------------------------------------------------------

test("reconcile completes an accepted turn when the transcript shows a finished assistant row", async () => {
  const { svc, oc, clock } = buildService();
  const res = await svc.submit({ text: "q", origin: "human" });
  await svc.tick();
  assert.equal(await statusOf(svc, res.id), "accepted");
  // No terminal event ever arrives (restart lost it); the transcript shows
  // the assistant's turn COMPLETED after our user message.
  clock.t += 20_000;
  oc.rows = [
    { info: { id: oc.sends[0].messageID, role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "asst_1", role: "assistant", time: { created: 2, completed: 9_000 } }, parts: [] },
  ];
  await svc.tick();
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(record.status, "completed");
  assert.equal(record.outcome.kind, "reconciled");
});

test("turnCompletionFromTranscript: running assistant row is NOT completion; missing receipt is not proof", () => {
  const user = { info: { id: "msg_u", role: "user" }, parts: [] };
  assert.deepEqual(turnCompletionFromTranscript([user], "msg_u"), { completed: false });
  assert.deepEqual(
    turnCompletionFromTranscript(
      [user, { info: { id: "a", role: "assistant", time: { created: 1 } } }],
      "msg_u",
    ),
    { completed: false },
  );
  assert.deepEqual(
    turnCompletionFromTranscript(
      [user, { info: { id: "a", role: "assistant", time: { created: 1, completed: 2 } } }],
      "msg_u",
    ),
    { completed: true, via: "transcript" },
  );
  assert.equal(turnCompletionFromTranscript([{ info: { id: "other", role: "user" } }], "msg_u"), null);
});

// ---------------------------------------------------------------------------
// No store lock across the opencode external await
// ---------------------------------------------------------------------------

test("a submit during an in-flight send completes promptly (no store lock held across the external await)", async () => {
  let releaseSend;
  const gate = new Promise((resolve) => (releaseSend = resolve));
  const oc = fakeOc();
  oc.sendPrompt = async (args) => {
    oc.sends.push(args);
    await gate;
    oc.transcript.set(args.messageID, { info: { id: args.messageID, role: "user", time: { created: 1 } }, parts: [] });
  };
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
  const record = (await svc.list()).submissions.find((s) => s.id === res.id);
  assert.equal(record.status, "unknown", "a deadline hit is uncertainty, never a resend trigger");
  assert.equal(record.unknownReason.includes("deadline"), true);
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the late rejection land
});

// ---------------------------------------------------------------------------
// Strict store validation
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
});

// ---------------------------------------------------------------------------
// Production composition: the REAL opencode.mjs client on the wire
// ---------------------------------------------------------------------------

test("production composition: real opencode.mjs sendPrompt carries the caller messageID on the wire and getMessage reads the receipt back", async () => {
  const calls = [];
  const prev = ocModule._setOcTransport(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
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
    const record = (await svc.list()).submissions.find((s) => s.id === res.id);
    assert.equal(record.status, "accepted", "204 + wire receipt → accepted");
    assert.match(record.messageID, /^msg_/);
    const prodPost = calls.filter((c) => c.method === "POST" && c.path === "/session/ses_live/prompt_async").at(-1);
    assert.equal(prodPost.body.messageID, record.messageID);
    assert.equal(prodPost.body.parts.at(-1).text, "production admission");
  } finally {
    ocModule._setOcTransport(prev);
    ocModule._resetSessionDirectoryCache();
  }
});

test("the default store resolves inside the state-home sandbox (never the live box)", async () => {
  const { statePath } = await import("../shared/paths.mjs");
  assert.equal(admissionStore.path, statePath("cto", "admission.json"));
  assert.ok(admissionStore.path.startsWith(process.env.MANTA_STATE_HOME));
});

test("MAX_ENTRIES and the lifecycle constants are part of the published contract", () => {
  assert.equal(MAX_ENTRIES, 500);
});
