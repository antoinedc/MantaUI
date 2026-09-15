// BET-P3a3: src/server/ctoConversation.test.mjs — the RPC-level production
// composition: the REAL createCtoBinding + createCtoAdmission engines over
// injected memory stores + a synthetic oc, wrapped in
// createCtoConversationService and dispatched through the REAL buildHandlers
// channel map (the exact channels the renderer's httpApi calls). Covers the
// P3a3 acceptance list: concurrent open creates once; submit dedup + queue
// projection; the direct-send seams (route plain text / reject slash+file);
// background prompt-delivery into the SAME queue; ordinary project traffic
// byte-identical; composition at boot touches zero oc; signals forwarded to
// the raw oc. No live opencode, no network, no model calls.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { dispatch, buildHandlers } from "./rpc.mjs";
import {
  CTO_CONVERSATION_UNSUPPORTED_MESSAGE,
  backgroundDeliveryId,
  createCtoConversationService,
} from "./ctoConversation.mjs";
import { createCtoBinding } from "./ctoBinding.mjs";
import { createCtoAdmission } from "./ctoAdmission.mjs";
import { createPromptDelivery } from "./promptDelivery.mjs";
import { createWebhookEngine } from "./webhooks.mjs";
import { statePath } from "../shared/paths.mjs";

const noopSleep = async () => {};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function memoryStore(name) {
  let payload = { v: 1 };
  return {
    name,
    path: `${name}-${randomUUID()}.json`,
    async load() {
      return payload;
    },
    async save(next) {
      payload = next;
    },
  };
}

// A synthetic oc covering BOTH engines' surface: the binding's
// create/list/read (+ the sendPrompt tripwire the binding must never hit) and
// the admission's send/getMessage/listMessages/abortSession. `calls` records
// EVERY method invocation with its args — the boot-wiring proof. `pdSends`
// records only promptDelivery's raw sends (ordinary background traffic).
function fakeOc() {
  let sessionSeq = 0;
  let asstSeq = 0;
  const oc = {
    calls: [],
    created: [],
    sends: [],
    pdSends: [],
    aborts: [],
    commandCalls: [],
    transcript: new Map(),
    rows: [],
    async sendPrompt(args) {
      oc.calls.push(["sendPrompt", args]);
      oc.sends.push(args);
      // parkSends installs onSend to hold the send in flight (LATCH, not a
      // timer) — the record above lands at claim time, deterministically.
      if (oc.onSend) await oc.onSend(args);
      oc.transcript.set(args.messageID, {
        info: { id: args.messageID, role: "user", time: { created: 1 } },
        parts: [],
      });
      oc.rows.push({
        info: { id: args.messageID, role: "user", time: { created: 1 } },
        parts: [],
      });
      return undefined;
    },
    async createSession(input) {
      oc.calls.push(["createSession", input]);
      const session = {
        id: `ses_cto${++sessionSeq}`,
        title: input.title,
        directory: input.directory,
        projectID: "global",
        time: { created: 1, updated: 1 },
        metadata: structuredClone(input.metadata ?? null),
      };
      oc.created.push(session);
      return structuredClone(session);
    },
    async listSessions() {
      oc.calls.push(["listSessions"]);
      return structuredClone([...oc.created]);
    },
    async readSession(id) {
      oc.calls.push(["readSession", id]);
      const session = oc.created.find((s) => s.id === id);
      return session ? { state: "found", session: structuredClone(session) } : { state: "missing" };
    },
    async getMessage(sessionId, messageId) {
      oc.calls.push(["getMessage", sessionId, messageId]);
      // receiptVisible=false parks the record in `unknown`: the send landed
      // but the messageID receipt is not visible to reconcile (the reviewer's
      // blocker path (a)).
      if (oc.receiptVisible === false) return null;
      return oc.transcript.get(messageId) ?? null;
    },
    async listMessages() {
      oc.calls.push(["listMessages"]);
      return oc.rows;
    },
    async abortSession(sessionId, opts = {}) {
      oc.calls.push(["abortSession", sessionId, opts]);
      oc.aborts.push({ sessionId, signal: opts.signal ?? null });
    },
    async runCommand(input) {
      oc.calls.push(["runCommand", input]);
      oc.commandCalls.push(input);
      return { messageID: `cmd_${oc.commandCalls.length}` };
    },
    /** A finished assistant row LINKED to our user message (finish: stop) —
     * transcript proof the turn ended (mirrors ctoAdmission.test's fake). */
    completeTurn(messageID) {
      oc.rows.push({
        info: {
          id: `asst_${(asstSeq += 1)}`,
          role: "assistant",
          parentID: messageID,
          finish: "stop",
          time: { created: 2, completed: 9_000 },
        },
        parts: [],
      });
    },
  };
  return oc;
}

// Park oc.sendPrompt behind a manually-released latch so the queue state is
// deterministic while asserting (the admitted turn stays in `dispatching`).
// The send is RECORDED at claim time (before the gate) so assertions on
// oc.sends / the claimed record are stable while parked.
function parkSends(oc) {
  let release;
  const gate = new Promise((r) => (release = r));
  oc.onSend = async () => {
    await gate;
  };
  return {
    release: () => {
      release();
      delete oc.onSend;
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// Condition-based settle (the pump's dispatch chain crosses several async
// hops; a fixed round count would race). Waits until pred() is true, bounded.
const waitFor = async (pred, rounds = 500) => {
  for (let i = 0; i < rounds; i += 1) {
    if (await pred()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
};

// Minimal tmux/local/syncState stubs — buildHandlers only closes over them;
// the cto:conversation-* and opencode:prompt seam tests never touch them.
const stubDeps = () => ({
  tmux: { listProjects: async () => [] },
  pty: {},
  bus: {},
  syncState: {
    refreshNow: async () => {},
    applyConfig: () => {},
    snapshot: () => ({ projects: [] }),
    payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }),
    everSucceeded: () => true,
  },
  local: { configGet: async () => ({ projects: [] }) },
  push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
});

// Compose the FULL production triangle (mirrors src/server/index.mjs): ONE
// binding + ONE admission + the conversation service, the prompt-delivery
// engine with its redirect, and the real channel map. Agent name is a stub
// stand-in for providers.CTO_AGENT_NAME.
function compose({ stamp, abortRaw, bindingStore, admissionOptions } = {}) {
  const oc = fakeOc();
  const bStore = bindingStore ?? memoryStore("binding");
  const binding = createCtoBinding({
    oc,
    store: bStore,
    controlDir: statePath("cto-conversation-test", randomUUID()),
    sleep: noopSleep,
  });
  // The service closure resolves at deliver() time — same TDZ-safe shape as
  // the production wiring.
  const pd = createPromptDelivery({
    sendPrompt: (args) => {
      oc.pdSends.push(args);
      return oc.sendPrompt(args);
    },
    redirect: (args) => svc.redirectDelivery(args),
  });
  const admission = createCtoAdmission({
    store: memoryStore("admission"),
    binding,
    sendPrompt: (...a) => oc.sendPrompt(...a),
    getMessage: (sid, mid) => oc.getMessage(sid, mid),
    listMessages: (sid, opts) => oc.listMessages(sid, opts),
    abortSession: (sid, opts) => oc.abortSession(sid, opts),
    // The shared busy view (promptDelivery's set is never fed here → not busy).
    isBusy: (sessionId) => pd.isBusy(sessionId),
    ...admissionOptions,
  });
  const svc = createCtoConversationService({
    binding,
    admission,
    agentName: "cto-test-agent",
    ...(stamp ? { stamp } : {}),
    // Production wiring: the raw oc abort is ALWAYS available to the seam's
    // fallback paths (uncertain / refused / cancel_requested / untracked).
    abortSession: abortRaw ?? ((sid) => oc.abortSession(sid)),
  });
  const handlers = buildHandlers({ oc, ctoConversation: svc, ...stubDeps() });
  return { oc, binding, admission, svc, pd, handlers, bStore };
}

/** Drive the admitted turn for `ctoId` to its terminal `completed` state:
 * transcript proof (a finished linked assistant row) + the session idle
 * event, then wait for reconcile. */
async function completeTurn(t, ctoId) {
  assert.ok(t.oc.sends.length >= 1, "a send is in flight to complete");
  t.oc.completeTurn(t.oc.sends.at(-1).messageID);
  t.admission.observeEvent({
    type: "session.idle",
    properties: { sessionID: t.oc.sends.at(-1).sessionId },
  });
  const done = await waitFor(async () => {
    const q = await t.admission.list();
    return q.submissions.find((r) => r.id === ctoId)?.status === "completed";
  });
  assert.ok(done, `turn ${ctoId} settled completed`);
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

test("composition touches zero oc at boot; state() and empty tick() never create or invoke the model", async () => {
  const t = compose();
  // Boot must not create a role session, list sessions, or send anything.
  assert.equal(t.oc.calls.length, 0);

  // state() is a pure store read: unbound binding, empty queue, still zero oc.
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.deepEqual(st.binding, { sessionId: null, generation: 0 });
  assert.deepEqual(st.submissions, []);
  assert.deepEqual(st.counts, { queued: { human: 0, background: 0 }, unresolved: 0, terminal: 0 });
  assert.equal(t.oc.calls.length, 0);

  // The poller body (tick) on an empty queue is also oc-free.
  await t.svc.tick();
  assert.equal(t.oc.calls.length, 0);
});

test("cto:conversation-open creates exactly one role session under concurrency, with no model invocation", async () => {
  const t = compose();
  const [a, b] = await Promise.all([
    dispatch(t.handlers, "cto:conversation-open", []),
    dispatch(t.handlers, "cto:conversation-open", []),
  ]);
  assert.equal(t.oc.created.length, 1);
  assert.equal(a.sessionId, t.oc.created[0].id);
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(a.generation, 1);
  assert.equal(b.generation, 1);
  assert.equal(t.oc.sends.length, 0);
  // The state view now shows the bound session.
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.binding.sessionId, a.sessionId);
  assert.equal(st.binding.generation, 1);
});

test("cto:conversation-* channels answer an actionable error when the runtime is not wired", async () => {
  const handlers = buildHandlers({ oc: {}, ...stubDeps() });
  await assert.rejects(
    () => dispatch(handlers, "cto:conversation-open", []),
    /cto conversation APIs are not wired on this box/,
  );
  await assert.rejects(
    () => dispatch(handlers, "cto:conversation-state", []),
    /cto conversation APIs are not wired on this box/,
  );
});

// ---------------------------------------------------------------------------
// submit — stable id, dedup, queue projection
// ---------------------------------------------------------------------------

test("cto:conversation-submit: stable id, durable queue projection, server-owned agent and origin", async () => {
  const t = compose();
  await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    const receipt = await dispatch(t.handlers, "cto:conversation-submit", [
      { id: "m_human_1", text: "check the board", expectedGeneration: 1 },
    ]);
    // The submit receipt is the caller's stable id, stamped server-side.
    assert.equal(receipt.id, "m_human_1");
    assert.equal(receipt.origin, "human");
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.persisted, true);
    assert.equal(receipt.text, "check the board");
    assert.equal(receipt.agent, "cto-test-agent");
    // Wait for the parked dispatch claim: the raw send firing implies the
    // record was claimed (status dispatching) with its stable messageID.
    assert.ok(await waitFor(() => t.oc.sends.length >= 1), "admission dispatched the queued record");

    // The record is live in the queue projection: claimed, stable opencode
    // messageID allocated, payload stripped.
    const st = await dispatch(t.handlers, "cto:conversation-state", []);
    const row = st.submissions.find((s) => s.id === "m_human_1");
    assert.ok(row, "submitted record is in the durable queue");
    assert.equal(row.status, "dispatching");
    assert.ok(row.messageID?.startsWith("msg_"), "stable messageID allocated and persisted");
    assert.equal(row.text, undefined);
    assert.equal(st.counts.unresolved, 1);

    // Same id + same payload → replay: existing record, nothing new written.
    const replay = await dispatch(t.handlers, "cto:conversation-submit", [
      { id: "m_human_1", text: "check the board", expectedGeneration: 1 },
    ]);
    assert.equal(replay.persisted, false);
    assert.equal(replay.id, "m_human_1");

    // Same id + different payload → actionable error, never fake success.
    await assert.rejects(
      () =>
        dispatch(t.handlers, "cto:conversation-submit", [
          { id: "m_human_1", text: "a different ask" },
        ]),
      /different payload/,
    );
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// Seams: direct sends / slash commands at the conversation session
// ---------------------------------------------------------------------------

test("opencode:prompt at the conversation session routes plain text through admission and rejects attachments and slash commands", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    // Plain text (with a caller-chosen agent that must be DROPPED) → routed
    // through the same durable queue with the caller's stable messageID.
    await dispatch(t.handlers, "opencode:prompt", [
      { sessionId: open.sessionId, text: "status please", agent: "build", messageID: "m_direct_1" },
    ]);
    assert.ok(await waitFor(() => t.oc.sends.length >= 1), "routed direct send was dispatched by admission");
    const st = await dispatch(t.handlers, "cto:conversation-state", []);
    const row = st.submissions.find((s) => s.id === "m_direct_1");
    assert.ok(row, "direct send was admitted through the queue");
    assert.equal(row.origin, "human");
    // The send that reaches the raw oc is ADMISSION's dispatch — server-owned
    // agent, admission-allocated stable messageID, not a byte pass-through.
    const send = t.oc.sends[0];
    assert.equal(send.sessionId, open.sessionId);
    assert.equal(send.agent, "cto-test-agent");
    assert.ok(send.messageID.startsWith("msg_"));

    // File attachments → the clear rejection; nothing queued.
    await assert.rejects(
      () =>
        dispatch(t.handlers, "opencode:prompt", [
          {
            sessionId: open.sessionId,
            text: "see file",
            attachments: [{ mime: "text/plain", remotePath: "/tmp/x" }],
          },
        ]),
      (e) => e.message === CTO_CONVERSATION_UNSUPPORTED_MESSAGE,
    );

    // Slash commands → the clear rejection (not admitted until a later phase).
    await assert.rejects(
      () =>
        dispatch(t.handlers, "opencode:run-command", [
          { sessionId: open.sessionId, command: "compact" },
        ]),
      (e) => e.message === CTO_CONVERSATION_UNSUPPORTED_MESSAGE,
    );
    const stAfter = await dispatch(t.handlers, "cto:conversation-state", []);
    assert.equal(stAfter.submissions.length, 1, "rejected inputs never queued");
  } finally {
    release();
  }
});

test("ordinary project traffic is byte-identical: direct sends, slash commands, and background deliveries", async () => {
  const t = compose();
  // A direct send at an ordinary session passes through raw, SAME object,
  // including the caller's own agent choice.
  const input = {
    sessionId: "ses_project",
    text: "fix the bug",
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  };
  await dispatch(t.handlers, "opencode:prompt", [input]);
  assert.equal(t.oc.sends.length, 1);
  assert.equal(t.oc.sends[0], input);

  // A slash command at an ordinary session runs the raw route.
  const cmd = { sessionId: "ses_project", command: "compact" };
  await dispatch(t.handlers, "opencode:run-command", [cmd]);
  assert.deepEqual(t.oc.commandCalls, [cmd]);

  // Ordinary background delivery still flows through promptDelivery's engine.
  const d = await t.pd.deliver({ sessionId: "ses_project", text: "hello" });
  assert.equal(d.delivered, true);
  assert.equal(t.oc.pdSends.length, 1);

  // And nothing ever entered the CTO conversation queue.
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 0);
});

// ---------------------------------------------------------------------------
// Background prompt delivery → the SAME queue
// ---------------------------------------------------------------------------

test("promptDelivery redirects conversation-targeted background deliveries into the same admission queue", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    const r1 = await t.pd.deliver({
      sessionId: open.sessionId,
      text: "overnight check",
      model: { providerID: "p", modelID: "m" },
    });
    assert.equal(r1.delivered, false);
    assert.equal(r1.queued, true);
    assert.ok(r1.ctoId, "a stable id was minted for the delivery");
    assert.ok(await waitFor(() => t.oc.sends.length >= 1), "background submission dispatched by admission");

    const st = await dispatch(t.handlers, "cto:conversation-state", []);
    const row = st.submissions.find((s) => s.id === r1.ctoId);
    assert.ok(row, "background delivery landed in the durable queue");
    assert.equal(row.origin, "background");
    assert.equal(row.agent, "cto-test-agent", "server-stamped agent, never from a body");
    assert.deepEqual(row.model, { providerID: "p", modelID: "m" });
    assert.equal(t.oc.pdSends.length, 0, "never sent raw through the delivery engine");
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// Background dedupe identity = the CALLER's delivery identity, never content
// (blocker 1: a content-derived id made a recurring identical schedule fire
// exactly once ever — admission dedups by id even against terminal records).
// ---------------------------------------------------------------------------

test("three identical recurring deliveries (no caller identity) are three submissions and three sends", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // Delivery #1 → dispatched → fully completed.
  const r1 = await t.pd.deliver({ sessionId: open.sessionId, text: "overnight check" });
  assert.ok(await waitFor(() => t.oc.sends.length >= 1));
  await completeTurn(t, r1.ctoId);
  // Delivery #2 — IDENTICAL text, a NEW occurrence: must be a NEW submission.
  const r2 = await t.pd.deliver({ sessionId: open.sessionId, text: "overnight check" });
  assert.notEqual(r2.ctoId, r1.ctoId, "identical content is never the dedupe identity");
  assert.equal(r2.persisted, true);
  assert.ok(await waitFor(() => t.oc.sends.length >= 2));
  await completeTurn(t, r2.ctoId);
  // Delivery #3 — same again.
  const r3 = await t.pd.deliver({ sessionId: open.sessionId, text: "overnight check" });
  assert.notEqual(r3.ctoId, r1.ctoId);
  assert.notEqual(r3.ctoId, r2.ctoId);
  assert.ok(await waitFor(() => t.oc.sends.length >= 3));
  await completeTurn(t, r3.ctoId);

  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 3, "three occurrences, three records");
  assert.equal(t.oc.sends.length, 3, "every occurrence actually fired");
  assert.deepEqual(
    st.counts,
    { queued: { human: 0, background: 0 }, unresolved: 0, terminal: 3 },
  );
});

test("a genuine retry with the same caller identity dedups to one submission, even against a completed record", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // First fire of schedule job j1 at minute 15:05 → admitted + completed.
  const r1 = await t.pd.deliver({
    sessionId: open.sessionId,
    text: "check the deploy",
    ctoKey: "sched:j1:2026-06-20T15:05",
  });
  assert.equal(r1.ctoId, "sched:j1:2026-06-20T15:05", "caller identity IS the admission id");
  assert.ok(await waitFor(() => t.oc.sends.length >= 1));
  await completeTurn(t, r1.ctoId);
  // A RETRY of the same logical delivery (same identity): dedups — the
  // completed record is returned, nothing re-fires.
  const retry = await t.pd.deliver({
    sessionId: open.sessionId,
    text: "check the deploy",
    ctoKey: "sched:j1:2026-06-20T15:05",
  });
  assert.equal(retry.ctoId, r1.ctoId);
  assert.equal(retry.persisted, false, "replay, nothing new written");
  assert.equal(retry.ctoStatus, "completed");
  assert.equal(t.oc.sends.length, 1, "the retry did not re-send");
  // The NEXT firing minute is a NEW occurrence even though the text is
  // identical — this is the recurring-schedule case the content hash broke.
  const next = await t.pd.deliver({
    sessionId: open.sessionId,
    text: "check the deploy",
    ctoKey: "sched:j1:2026-06-20T15:10",
  });
  assert.notEqual(next.ctoId, r1.ctoId);
  assert.equal(next.persisted, true);
  assert.ok(await waitFor(() => t.oc.sends.length >= 2), "the next occurrence fired");
});

test("per-caller identity mapping: schedule job+minute and capability job+status map 1:1 to admission ids", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    const sched = await t.pd.deliver({
      sessionId: open.sessionId,
      text: "x",
      ctoKey: "sched:job1:2026-06-20T15:05",
    });
    const cap = await t.pd.deliver({
      sessionId: open.sessionId,
      text: "y",
      ctoKey: "cap:job9:done",
    });
    assert.equal(sched.ctoId, "sched:job1:2026-06-20T15:05");
    assert.equal(cap.ctoId, "cap:job9:done");
    // Distinct identities never collide into one record.
    const st = await dispatch(t.handlers, "cto:conversation-state", []);
    assert.equal(st.submissions.filter((r) => r.origin === "background").length, 2);
  } finally {
    release();
  }
});

test("backgroundDeliveryId passes caller identity through and truncates only oversized keys", () => {
  assert.equal(backgroundDeliveryId("sched:job1:2026-06-20T15:05"), "sched:job1:2026-06-20T15:05");
  assert.equal(backgroundDeliveryId(undefined), null);
  assert.equal(backgroundDeliveryId(""), null);
  const long = `cap:${"x".repeat(300)}`;
  const mapped = backgroundDeliveryId(long);
  assert.ok(mapped.startsWith("bg_"), "oversized identity maps to a bounded id");
  assert.equal(mapped, backgroundDeliveryId(long), "the mapping itself is stable");
});

// ---------------------------------------------------------------------------
// Signals forwarded to the raw oc
// ---------------------------------------------------------------------------

test("admission dispatch and interrupt forward their bounded signals to the raw oc; an interrupt on a live turn retains the barrier", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    await dispatch(t.handlers, "cto:conversation-submit", [{ id: "m_sig", text: "hi" }]);
    // The raw send received admission's bounded deadline signal.
    assert.ok(await waitFor(() => t.oc.sends.length >= 1), "admission dispatched");
    assert.ok(t.oc.sends[0]?.signal instanceof AbortSignal, "sendPrompt carries a signal");
  } finally {
    release();
  }
  await flush();

  // Interrupt the accepted turn: the abort must carry a signal too, targeted
  // at the bound role session.
  const rc = await dispatch(t.handlers, "cto:conversation-interrupt", [{ id: "m_sig" }]);
  assert.equal(rc.ok, true);
  assert.equal(rc.id, "m_sig");
  assert.ok(await waitFor(() => t.oc.aborts.length >= 1), "abort issued for the interrupt");
  assert.equal(t.oc.aborts.length, 1);
  assert.equal(t.oc.aborts[0].sessionId, open.sessionId);
  assert.ok(t.oc.aborts[0].signal instanceof AbortSignal, "abortSession carries a signal");

  // No assistant row exists, so the turn end is unproven: the request marker
  // stays interrupt_pending and the queue stays held (an interrupt on a live
  // turn does NOT release admission — doc limitation 1).
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  const row = st.submissions.find((s) => s.id === "m_sig");
  assert.equal(row.status, "interrupt_pending");
  assert.equal(st.counts.unresolved, 1);
});

// ---------------------------------------------------------------------------
// Blocker 3: the opencode:abort seam — a raw abort is invisible to
// admission's abortState, so the bound role session's abort routes onto the
// tracked interrupt path.
// ---------------------------------------------------------------------------

// Shared prologue for the abort-seam cases: compose with a raw-fallback
// counter, open the conversation, and submit an admitted turn whose raw send
// stays parked until released (deterministic dispatching/accepted states).
async function composeWithSubmittedTurn({ id, text } = {}) {
  const fallbackCount = { n: 0, sid: null };
  const t = compose({
    abortRaw: async (sid) => {
      fallbackCount.n += 1;
      fallbackCount.sid = sid;
    },
  });
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  await dispatch(t.handlers, "cto:conversation-submit", [{ id, text }]);
  assert.ok(await waitFor(() => t.oc.sends.length >= 1), "admission dispatched the turn");
  return { t, open, release, fallbackCount };
}

test("opencode:abort at the bound session tracks the accepted turn as interrupt_pending with a forwarded signal", async () => {
  const { t, open, release, fallbackCount } = await composeWithSubmittedTurn({
    id: "m_abort",
    text: "long turn",
  });
  release();
  // The send landed its receipt → the record is the ACCEPTED turn.
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_abort")?.status === "accepted",
    ),
    "the turn is accepted before the abort",
  );

  // THE SEAM: the caller only knows the session id — the accepted record is
  // resolved server-side and interrupted through admission's tracked path.
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_abort")?.status ===
      "interrupt_pending",
    ),
    "the abort is VISIBLE to abortState (tracked interrupt)",
  );
  assert.equal(t.oc.aborts.length, 1, "the tracked abort reached the raw oc");
  assert.equal(t.oc.aborts[0].sessionId, open.sessionId);
  assert.ok(t.oc.aborts[0].signal instanceof AbortSignal, "the abort carries a bounded signal");
  assert.equal(fallbackCount.n, 0, "the tracked path handled it — no raw fallback");
  // And the queue stays held (interrupt_pending is a barrier until reconcile).
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.counts.unresolved, 1);
});

test("opencode:abort with nothing unresolved on the session falls back to the raw abort", async () => {
  let rawFallbacks = 0;
  let rawFallbackSid = null;
  const t = compose({
    abortRaw: async (sid) => {
      rawFallbacks += 1;
      rawFallbackSid = sid;
    },
  });
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // Empty queue: there is no admission turn to track — honor the stop request
  // via the documented raw fallback.
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.equal(rawFallbacks, 1);
  assert.equal(rawFallbackSid, open.sessionId);
  assert.equal(t.oc.aborts.length, 0, "the tracked path never fired");
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 0);
});

test("opencode:abort while the admitted turn is mid-dispatch is an actionable refusal, not a raw abort", async () => {
  const { t, open, release, fallbackCount } = await composeWithSubmittedTurn({
    id: "m_dispatch",
    text: "go",
  });
  try {
    assert.ok(
      await waitFor(async () =>
        (await t.admission.list()).submissions.find((r) => r.id === "m_dispatch")?.status ===
        "dispatching",
      ),
      "the record is mid-dispatch (send parked)",
    );
    await assert.rejects(
      () => dispatch(t.handlers, "opencode:abort", [open.sessionId]),
      /mid-dispatch/,
    );
    assert.equal(fallbackCount.n, 0);
    assert.equal(t.oc.aborts.length, 0, "no untracked abort escapes");
  } finally {
    release();
  }
});

test("opencode:abort at an ordinary session passes through raw, byte-identically", async () => {
  const t = compose();
  await dispatch(t.handlers, "opencode:abort", ["ses_project"]);
  assert.equal(t.oc.aborts.length, 1);
  assert.equal(t.oc.aborts[0].sessionId, "ses_project");
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 0);
});

// ---------------------------------------------------------------------------
// Re-review blocker: a marker (interrupt_pending / cancel_requested) must
// NEVER make Stop a silent no-op. The idempotent return is honest ONLY while
// an abort is genuinely in flight or already confirmed.
// ---------------------------------------------------------------------------

test("Stop on a parked-unknown record: the second press actually aborts the running turn (never silent success)", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // The send lands but its receipt is NOT visible → the record parks `unknown`
  // while the turn is genuinely running on the session.
  t.oc.receiptVisible = false;
  await dispatch(t.handlers, "cto:conversation-submit", [{ id: "m_unknown", text: "long turn" }]);
  assert.ok(await waitFor(() => t.oc.sends.length >= 1), "the turn is live");
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_unknown")?.status === "unknown",
    ),
    "the record is parked unknown (receipt invisible)",
  );

  // Press 1: the contract's visible request — cancel_requested, NO abort
  // issued (the send's outcome is unreconciled; admission must not guess).
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_unknown")?.status ===
      "cancel_requested",
    ),
    "press 1 converts the record to the visible cancel_requested marker",
  );
  assert.equal(t.oc.aborts.length, 0, "press 1 issues no abort by contract");

  // Press 2 (and any later press): the marker previously made Stop a SILENT
  // no-op returning success while the model kept running. It must fall
  // through to the REAL raw abort — the turn is untrackable, so stopping it
  // is the honest action.
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.ok(t.oc.aborts.length >= 1, "the second press actually aborts the turn");
  assert.equal(t.oc.aborts[0].sessionId, open.sessionId);
  // The barrier itself stays admission's business (reconcile proves it out).
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions[0].status, "cancel_requested");
});

test("Stop after an uncertain abort (abortState uncertain, barrier permanent) issues the real abort", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  await dispatch(t.handlers, "cto:conversation-submit", [{ id: "m_unc", text: "long turn" }]);
  assert.ok(await waitFor(() => t.oc.sends.length >= 1));
  release();
  await flush();
  // The abort transport fails NON-DEFINITIVELY (no .status → permanent
  // uncertainty). Press 1: tracked attempt, abortState → "uncertain".
  t.oc.abortSession = async () => {
    throw new Error("network reset");
  };
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_unc")?.abortState ===
      "uncertain",
    ),
    "press 1 leaves the permanent uncertain barrier",
  );
  // Press 2: previously 0 oc calls returning undefined = fake success while
  // the turn may still run. Now: the REAL abort is issued.
  t.oc.aborts = []; // count only what press 2 does
  let press2Aborts = 0;
  t.oc.abortSession = async (sid, opts = {}) => {
    press2Aborts += 1;
    t.oc.aborts.push({ sessionId: sid, signal: opts.signal ?? null });
  };
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.equal(press2Aborts, 1, "the wedged record's Stop still stops the turn");
  assert.equal(
    (await t.admission.list()).submissions.find((r) => r.id === "m_unc")?.status,
    "interrupt_pending",
    "the barrier itself stays admission's business",
  );
});

test("Stop while an abort is genuinely in flight stays idempotent (no duplicate abort)", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  await dispatch(t.handlers, "cto:conversation-submit", [{ id: "m_live", text: "long turn" }]);
  assert.ok(await waitFor(() => t.oc.sends.length >= 1));
  release();
  await flush();
  // Hold the tracked abort IN FLIGHT (claimed, not settled).
  let releaseAbort;
  const abortGate = new Promise((r) => (releaseAbort = r));
  const realAbort = t.oc.abortSession.bind(t.oc);
  t.oc.abortSession = async (sid, opts) => {
    await abortGate;
    return realAbort(sid, opts);
  };
  // Press 1 is IN FLIGHT until the gate releases — do not await it yet.
  const press1 = dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.ok(
    await waitFor(async () =>
      (await t.admission.list()).submissions.find((r) => r.id === "m_live")?.abortState ===
      "claimed",
    ),
    "the tracked abort is in flight (claimed)",
  );
  // Press 2 while in flight: idempotent — no duplicate abort request.
  await dispatch(t.handlers, "opencode:abort", [open.sessionId]);
  assert.equal(
    (await t.admission.list()).submissions.find((r) => r.id === "m_live")?.attemptCount,
    1,
    "no second attempt was claimed",
  );
  releaseAbort();
  await press1;
  assert.equal(t.oc.aborts.length, 1, "exactly one abort was ever issued");
});

// ---------------------------------------------------------------------------
// Previous-generation retarget: a delivery aimed at a REPLACED role session
// must still flow through admission (which dispatches to the CURRENT
// binding), not fire into the dead session.
// ---------------------------------------------------------------------------

test("a delivery to a previous-generation role session retargets through admission to the live session", async () => {
  const t = compose();
  const open1 = await dispatch(t.handlers, "cto:conversation-open", []);
  // Force a rebind: evict the bound session from opencode so recovery sees it
  // DEFINITIVELY missing, then recover → replace with a new generation.
  t.oc.created = [];
  await t.binding.recover();
  const bound = await t.binding.getBinding();
  assert.equal(bound.generation, 2, "the binding advanced");
  assert.ok(bound.previousSessionIds.includes(open1.sessionId), "the old id is archived");

  const { release } = parkSends(t.oc);
  try {
    // A background delivery aimed at the OLD (dead) session id.
    const r = await t.pd.deliver({ sessionId: open1.sessionId, text: "pre-rebind schedule" });
    assert.equal(r.queued, true, "classified as the conversation — retargeted, not ordinary");
    assert.ok(await waitFor(() => t.oc.sends.length >= 1));
    assert.equal(
      t.oc.sends[0].sessionId,
      bound.currentSessionId,
      "admission dispatched the turn to the LIVE session",
    );
    assert.equal(t.oc.pdSends.length, 0, "never fired raw into the dead session");
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// Blocker 2 end-to-end: an IDLE CTO-session webhook goes through the shared
// delivery engine into the admission queue (it used to bypass via raw send).
// ---------------------------------------------------------------------------

test("an idle webhook aimed at the CTO conversation is admitted (202) — not raw-sent", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // A real hooks store with one unsigned manta hook targeting the conversation.
  const hooksDir = statePath("cto-conversation-test", randomUUID());
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(hooksDir, { recursive: true });
  const hook = {
    id: "h_cto",
    token: "b".repeat(32),
    secret: "whsec_x",
    unsigned: true,
    label: "board",
    instructions: "",
    sessionID: open.sessionId,
    deliveries: 0,
    lastDeliveredAt: null,
  };
  await writeFile(join(hooksDir, "hooks.json"), JSON.stringify({ hooks: [hook] }));
  let webhookRawSends = 0;
  const engine = createWebhookEngine({
    sendPrompt: async () => {
      webhookRawSends += 1;
    },
    delivery: t.pd,
    publish: () => {},
    storePath: join(hooksDir, "hooks.json"),
  });
  const res = await engine.deliver({ token: "b".repeat(32), rawBody: '{"n":1}' });
  assert.equal(res.status, 202, "the durable queue accepted it — reported honestly as queued");
  assert.equal(res.queued, true);
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 1, "the webhook landed in the admission queue");
  assert.equal(st.submissions[0].origin, "background");
  assert.equal(webhookRawSends, 0, "never bypassed via the raw webhook sendPrompt");
  assert.equal(t.oc.pdSends.length, 0, "and never via the delivery engine's raw send");
});

// ---------------------------------------------------------------------------
// admitDirect forwards the optimistic-generation guard (finding N3).
// ---------------------------------------------------------------------------

test("admitDirect forwards expectedGeneration from the direct-send input", async () => {
  const t = compose();
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  const { release } = parkSends(t.oc);
  try {
    const receipt = await dispatch(t.handlers, "opencode:prompt", [
      { sessionId: open.sessionId, text: "status", expectedGeneration: 1 },
    ]);
    assert.equal(receipt.expectedGeneration, 1, "the optimistic-generation guard survives the seam");
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// Stamp-validated classification cache (finding N4): an ordinary project
// prompt must not pay a binding.json read+parse on every send.
// ---------------------------------------------------------------------------

test("seam classification is stamp-cached; a stamp change invalidates", async () => {
  let stampValue = "s1";
  let loads = 0;
  let payload = { v: 1 };
  const countingStore = {
    name: "binding",
    path: `binding-${randomUUID()}.json`,
    async load() {
      loads += 1;
      return payload;
    },
    async save(next) {
      payload = next;
    },
  };
  const t = compose({ stamp: () => stampValue, bindingStore: countingStore });
  await dispatch(t.handlers, "cto:conversation-open", []);
  loads = 0; // count only the SEAM classifications below
  // Three ordinary project prompts → three classifications.
  for (let i = 0; i < 3; i += 1) {
    await dispatch(t.handlers, "opencode:prompt", [{ sessionId: "ses_project", text: `p${i}` }]);
  }
  assert.equal(loads, 1, "one binding read serves all classifications at the same stamp");
  // The stamp changes (a binding write) → the very next classification re-reads.
  stampValue = "s2";
  await dispatch(t.handlers, "opencode:prompt", [{ sessionId: "ses_project", text: "p3" }]);
  assert.equal(loads, 2, "a changed stamp invalidates the cache");
  // The open itself still worked — and the open path is unaffected.
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.binding.sessionId, "ses_cto1");
});

test("a stamp (stat) failure degrades to a cache miss, never to a failed classification", async () => {
  const t = compose({
    stamp: async () => {
      throw new Error("stat boom");
    },
  });
  const open = await dispatch(t.handlers, "cto:conversation-open", []);
  // Before the fix the stamp error failed the classification OPEN, treating
  // the CTO session as ordinary — a raw send past the admission queue.
  const receipt = await dispatch(t.handlers, "opencode:prompt", [
    { sessionId: open.sessionId, text: "still routed" },
  ]);
  assert.ok(receipt.id, "the conversation send was still admitted through the queue");
  assert.equal(receipt.origin, "human");
  const st = await dispatch(t.handlers, "cto:conversation-state", []);
  assert.equal(st.submissions.length, 1);
});
