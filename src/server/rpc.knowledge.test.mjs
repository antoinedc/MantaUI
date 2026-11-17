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
