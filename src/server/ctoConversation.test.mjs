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
function compose() {
  const oc = fakeOc();
  const binding = createCtoBinding({
    oc,
    store: memoryStore("binding"),
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
  });
  const svc = createCtoConversationService({
    binding,
    admission,
    agentName: "cto-test-agent",
  });
  const handlers = buildHandlers({ oc, ctoConversation: svc, ...stubDeps() });
  return { oc, binding, admission, svc, pd, handlers };
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
    assert.ok(r1.ctoId.startsWith("bg_"), "stable content-mapped background id");
    assert.ok(await waitFor(() => t.oc.sends.length >= 1), "background submission dispatched by admission");

    const st = await dispatch(t.handlers, "cto:conversation-state", []);
    const row = st.submissions.find((s) => s.id === r1.ctoId);
    assert.ok(row, "background delivery landed in the durable queue");
    assert.equal(row.origin, "background");
    assert.equal(row.agent, "cto-test-agent", "server-stamped agent, never from a body");
    assert.deepEqual(row.model, { providerID: "p", modelID: "m" });
    assert.equal(t.oc.pdSends.length, 0, "never sent raw through the delivery engine");

    // An identical redelivery maps to the SAME stable id → dedup replay.
    const r2 = await t.pd.deliver({
      sessionId: open.sessionId,
      text: "overnight check",
      model: { providerID: "p", modelID: "m" },
    });
    assert.equal(r2.ctoId, r1.ctoId);
    assert.equal(r2.persisted, false);
    const st2 = await dispatch(t.handlers, "cto:conversation-state", []);
    assert.equal(st2.submissions.length, 1, "no duplicate submitted turn");
  } finally {
    release();
  }
});

test("backgroundDeliveryId is stable across identical content and distinct otherwise", () => {
  const a = backgroundDeliveryId({ text: "x", model: { providerID: "p", modelID: "m" } });
  const b = backgroundDeliveryId({ text: "x", model: { providerID: "p", modelID: "m" } });
  const c = backgroundDeliveryId({ text: "y", model: { providerID: "p", modelID: "m" } });
  assert.equal(a, b);
  assert.notEqual(a, c);
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
