// The knowledge rpc surface: the generic config write can never set the Knowledge settings,
// and the `knowledge:*` channels reach the engine (503 when it isn't wired).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildHandlers } from "./rpc.mjs";

function rig({ knowledge } = {}) {
  const updates = [];
  const deps = {
    tmux: { listProjects: async () => [] },
    pty: {},
    bus: {},
    syncState: { refreshNow: async () => {}, applyConfig: () => {}, snapshot: () => ({ projects: [] }), payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }), everSucceeded: () => true },
    local: { configGet: async () => ({ projects: [] }), configUpdate: async (p) => (updates.push(p), { ...p }) },
    push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
    oc: {},
    ...(knowledge ? { knowledge } : {}),
  };
  return { handlers: buildHandlers(deps), updates };
}

test("config:update strips `knowledge` (and dotted knowledge.* keys): settings are written only by knowledge:settings-set", async () => {
  const { handlers, updates } = rig();
  await dispatch(handlers, "config:update", [{ knowledge: { enabled: false, dailyCapUsd: 999 }, handoffMode: "off" }]);
  assert.deepEqual(updates, [{ handoffMode: "off" }]);
  await dispatch(handlers, "config:update", [{ "knowledge.projects.x": { sharing: "private" }, "knowledge.enabled": false }]);
  assert.deepEqual(updates.at(-1), {});
});

test("knowledge:* channels call the engine; settings-set takes {patch}", async () => {
  const log = [];
  const knowledge = {
    status: async () => (log.push(["status"]), { state: "on" }),
    settingsGet: async () => (log.push(["get"]), { enabled: true }),
    settingsSet: async (p) => (log.push(["set", p]), { enabled: false }),
    changes: async (a) => (log.push(["changes", a]), { items: [], nextCursor: null }),
    undo: async (a) => (log.push(["undo", a]), { ok: true }),
  };
  const { handlers } = rig({ knowledge });
  assert.deepEqual(await dispatch(handlers, "knowledge:status", []), { state: "on" });
  assert.deepEqual(await dispatch(handlers, "knowledge:settings-get", []), { enabled: true });
  assert.deepEqual(await dispatch(handlers, "knowledge:settings-set", [{ patch: { enabled: false } }]), { enabled: false });
  assert.deepEqual(await dispatch(handlers, "knowledge:changes", [{ cursor: "5" }]), { items: [], nextCursor: null });
  assert.deepEqual(await dispatch(handlers, "knowledge:undo", [{ id: "c_1" }]), { ok: true });
  assert.deepEqual(log, [["status"], ["get"], ["set", { enabled: false }], ["changes", { cursor: "5" }], ["undo", { id: "c_1" }]]);
});

test("an unwired box answers 503 on every knowledge channel", async () => {
  const { handlers } = rig();
  for (const ch of ["knowledge:status", "knowledge:settings-get", "knowledge:settings-set", "knowledge:changes", "knowledge:undo"]) {
    await assert.rejects(dispatch(handlers, ch, [{}]), (e) => e.rpcStatus === 503, ch);
  }
});

// ---- opencode:prompt: origin lowering (§9.2) and the project pin at the first prompt (§3.1) ----

function promptRig({ session = { state: "found", session: { directory: "/work/wt" } }, cached = null } = {}) {
  const sends = [];
  const pins = [];
  const oc = {
    sendPrompt: async (a) => void sends.push(a),
    readSession: async () => session,
    cachedSessionDirectory: () => cached,
  };
  const knowledge = { pinSession: async (a) => void pins.push(a) };
  const handlers = buildHandlers({
    tmux: { listProjects: async () => [] },
    pty: {},
    bus: {},
    syncState: { refreshNow: async () => {}, applyConfig: () => {}, snapshot: () => ({ projects: [] }), payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }), everSucceeded: () => true },
    local: { configGet: async () => ({ projects: [] }), configUpdate: async (p) => p },
    push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
    oc,
    knowledge,
  });
  return { handlers, sends, pins };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("opencode:prompt stamps `user`; a client-sent origin is ignored; `appGenerated: true` lowers it to unknown and never travels on", async () => {
  const { handlers, sends } = promptRig();
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "hi" }]);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "forged", origin: "user" }]);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "claims", origin: "schedule" }]);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "the plan", appGenerated: true, origin: "user" }]);
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "not a boolean", appGenerated: "yes" }]);
  assert.deepEqual(sends.map((s) => [s.text, s.origin]), [["hi", "user"], ["forged", "user"], ["claims", "user"], ["the plan", "unknown"], ["not a boolean", "user"]]);
  assert.ok(sends.every((s) => !("appGenerated" in s)), "the flag is consumed here");
});

test("opencode:prompt pins the session to its CURRENT directory with force, without blocking or failing the send", async () => {
  const { handlers, sends, pins } = promptRig();
  await dispatch(handlers, "opencode:prompt", [{ sessionId: "ses_a", text: "hi" }]);
  await tick();
  assert.deepEqual(pins, [{ sessionID: "ses_a", directory: "/work/wt", force: true }]);
  assert.equal(sends.length, 1);

  // the cached directory is the fallback when the session can't be read
  const c = promptRig({ session: { state: "unknown" }, cached: "/cached/dir" });
  await dispatch(c.handlers, "opencode:prompt", [{ sessionId: "ses_b", text: "hi" }]);
  await tick();
  assert.deepEqual(c.pins, [{ sessionID: "ses_b", directory: "/cached/dir", force: true }]);

  // no known directory → no pin; a failing pin never fails the send
  const n = promptRig({ session: { state: "missing" } });
  await dispatch(n.handlers, "opencode:prompt", [{ sessionId: "ses_c", text: "hi" }]);
  await tick();
  assert.deepEqual(n.pins, []);
  assert.equal(n.sends.length, 1);
  const real = console.warn;
  console.warn = () => {};
  try {
    const h2 = buildHandlers({ ...{ tmux: { listProjects: async () => [] }, pty: {}, bus: {}, syncState: {}, local: { configGet: async () => ({}) }, push: {} }, oc: { sendPrompt: async () => {}, readSession: async () => ({ state: "found", session: { directory: "/d" } }) }, knowledge: { pinSession: async () => { throw new Error("boom"); } } });
    await dispatch(h2, "opencode:prompt", [{ sessionId: "ses_d", text: "hi" }]);
    await tick();
  } finally {
    console.warn = real;
  }
});
