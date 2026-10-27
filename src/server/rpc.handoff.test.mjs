// The auto-handoff rpc channels (spec §15) and the admission seam on the client
// send / command channels. The engine is a stub: its own behaviour is covered in
// src/server/handoff/*.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildHandlers, handleRpcRequest } from "./rpc.mjs";
import { HandoffError } from "./handoff/engine.mjs";

const stubDeps = () => ({
  tmux: { listProjects: async () => [] },
  pty: {},
  bus: {},
  syncState: { refreshNow: async () => {}, applyConfig: () => {}, snapshot: () => ({ projects: [] }), payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }), everSucceeded: () => true },
  local: { configGet: async () => ({ projects: [] }), configUpdate: async (p) => p },
  push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
});

function rig(handoffOver = {}) {
  const log = [];
  const oc = { sendPrompt: async (i) => log.push(["rawSend", i]), runCommand: async (i) => log.push(["rawRun", i]) };
  const handoff = {
    create: async (i) => (log.push(["create", i]), { id: "hof_1", state: "generating" }),
    list: (i) => (log.push(["list", i]), { records: [], links: {} }),
    get: (id) => (id === "hof_1" ? { id } : null),
    start: async (id, i) => (log.push(["start", id, i]), { id, state: "committed" }),
    retry: async (id) => ({ id, state: "ready" }),
    dismiss: async (id) => (log.push(["dismiss", id]), { id, state: "dismissed" }),
    setMode: async (sid, mode) => (log.push(["setMode", sid, mode]), mode),
    draftConsumed: async (id, rev) => void log.push(["draftConsumed", id, rev]),
    admitPrompt: async (i) => (log.push(["admit", i]), { deliveredTo: "ses_live" }),
    guardCommand: (sid) => ({ target: sid === "ses_old" ? "ses_live" : sid }),
    ...handoffOver,
  };
  return { handlers: buildHandlers({ oc, handoff, ...stubDeps() }), log, handoff };
}

test("the handoff:* channels are the REST routes' twins: same payloads, {handoff} wrappers", async () => {
  const { handlers, log } = rig();
  assert.deepEqual(await dispatch(handlers, "handoff:create", [{ sessionId: "s", trigger: "user" }]), { handoff: { id: "hof_1", state: "generating" } });
  assert.deepEqual(await dispatch(handlers, "handoff:list", [{ sessionId: "s" }]), { records: [], links: {} });
  assert.deepEqual(await dispatch(handlers, "handoff:get", [{ id: "hof_1" }]), { handoff: { id: "hof_1" } });
  assert.deepEqual(await dispatch(handlers, "handoff:start", [{ id: "hof_1", how: "clear", disposition: "send", text: "t" }]), { handoff: { id: "hof_1", state: "committed" } });
  assert.deepEqual(log.find((l) => l[0] === "start"), ["start", "hof_1", { id: "hof_1", how: "clear", disposition: "send", text: "t" }]);
  assert.deepEqual(await dispatch(handlers, "handoff:retry", [{ id: "hof_1" }]), { handoff: { id: "hof_1", state: "ready" } });
  assert.equal(await dispatch(handlers, "handoff:draft-consumed", [{ id: "hof_1", draftRevision: 2 }]), undefined);
  assert.deepEqual(log.at(-1), ["draftConsumed", "hof_1", 2]);
});

test("handoff:dismiss and handoff:set-mode answer {handoff} / {mode}", async () => {
  const { handlers, log } = rig();
  assert.deepEqual(await dispatch(handlers, "handoff:dismiss", [{ id: "hof_1" }]), { handoff: { id: "hof_1", state: "dismissed" } });
  assert.deepEqual(await dispatch(handlers, "handoff:set-mode", [{ sessionId: "ses_a", mode: "off" }]), { mode: "off" });
  assert.deepEqual(log, [["dismiss", "hof_1"], ["setMode", "ses_a", "off"]]);
  const refuse = rig({ dismiss: async () => { throw new HandoffError("not_ready", "This handoff can no longer be dismissed."); } });
  await assert.rejects(dispatch(refuse.handlers, "handoff:dismiss", [{ id: "hof_1" }]), (e) => e.code === "not_ready");
});

test("handoff:get of a missing record throws the expired code", async () => {
  const { handlers } = rig();
  await assert.rejects(dispatch(handlers, "handoff:get", [{ id: "hof_x" }]), (e) => e.code === "expired" && e.name === "HandoffError");
});

test("without an engine the channels answer an actionable error and sends take the raw route", async () => {
  const log = [];
  const handlers = buildHandlers({ oc: { sendPrompt: async (i) => log.push(i), runCommand: async (i) => log.push(i) }, ...stubDeps() });
  await assert.rejects(dispatch(handlers, "handoff:list", [{ sessionId: "s" }]), /isn't available/);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "x" }]);
  assert.deepEqual(log, [{ sessionId: "ses_a", text: "x" }]);
});

test("opencode:prompt goes through the admission seam and returns where it landed", async () => {
  const { handlers, log } = rig();
  const res = await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_old", text: "hi", messageID: "msg_1" }]);
  assert.deepEqual(res, { deliveredTo: "ses_live" });
  assert.deepEqual(log, [["admit", { sessionId: "ses_old", text: "hi", messageID: "msg_1" }]]);
});

test("opencode:run-command is resolved to the live session, or refused while a handoff owns it", async () => {
  const { handlers, log } = rig();
  await dispatch(handlers, "opencode:run-command", [{ sessionId: "ses_old", command: "init", arguments: "" }]);
  assert.equal(log[0][0], "rawRun");
  assert.equal(log[0][1].sessionId, "ses_live");
  const busy = rig({ guardCommand: () => { throw new HandoffError("busy", "A handoff is starting — try again in a moment."); } });
  await assert.rejects(dispatch(busy.handlers, "opencode:run-command", [{ sessionId: "ses_a", command: "init" }]), /handoff is starting/);
  assert.equal(busy.log.length, 0);
});

test("config:update validates handoffMode", async () => {
  const { handlers } = rig();
  await assert.rejects(dispatch(handlers, "config:update", [{ handoffMode: "sometimes" }]), /handoffMode must be/);
  for (const mode of ["auto", "suggest", "off"]) {
    const r = await dispatch(handlers, "config:update", [{ handoffMode: mode }]).then(() => null, (e) => e);
    assert.ok(!r || !/handoffMode must be/.test(String(r.message)), `${mode} is accepted`);
  }
});

function exchange() {
  const listeners = {};
  const req = { headers: {}, on(ev, fn) { listeners[ev] = fn; return req; }, _fire: (ev, a) => listeners[ev]?.(a) };
  const res = { status: null, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  return { req, res };
}

test("over HTTP a HandoffError keeps its status and code: {error: code, message, handoff?}", async () => {
  const handlers = {
    "x:conflict": () => { throw new HandoffError("already_started", "This handoff was already started.", { handoff: { id: "hof_1" } }); },
    "x:other": () => { throw new Error("plain failure"); },
  };
  for (const [channel, status, want] of [
    ["x:conflict", 409, { error: "already_started", message: "This handoff was already started.", handoff: { id: "hof_1" } }],
    ["x:other", 500, { error: "plain failure" }],
  ]) {
    const { req, res } = exchange();
    const done = handleRpcRequest(handlers, channel, req, res);
    req._fire("data", JSON.stringify({ args: [] }));
    await req._fire("end");
    await done;
    assert.equal(res.status, status);
    assert.deepEqual(JSON.parse(res.body), want);
  }
});
