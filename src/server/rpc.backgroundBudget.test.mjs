// The background-budget rpc surface: `config:update` validates and MERGES `backgroundWork`, ignores the retired
// per-subsystem caps, and `background:status` reaches the budget (503 when it isn't wired).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubRpcDeps } from "./fixtures/rpcStubDeps.mjs";
import { dispatch, buildHandlers } from "./rpc.mjs";

function rig({ stored, backgroundBudget } = {}) {
  const updates = [];
  const applied = [];
  const deps = stubRpcDeps({
    local: { configGet: async () => ({ projects: [], ...(stored ? { backgroundWork: stored } : {}) }), configUpdate: async (p) => (updates.push(p), { ...p }) },
    oc: {},
    syncState: { applyConfig: (c) => applied.push(c), refreshNow: async () => {}, snapshot: () => ({ projects: [] }), everSucceeded: () => true },
    ...(backgroundBudget ? { backgroundBudget } : {}),
  });
  return { handlers: buildHandlers(deps), updates, applied };
}

test("config:update merges a partial backgroundWork into the stored one (level alone keeps the cap) and syncs the result", async () => {
  const { handlers, updates, applied } = rig({ stored: { level: "light", dailyCapUsd: 8 } });
  await dispatch(handlers, "config:update", [{ backgroundWork: { level: "off" } }]);
  assert.deepEqual(updates, [{ backgroundWork: { level: "off", dailyCapUsd: 8 } }]);
  assert.deepEqual(applied.at(-1), { backgroundWork: { level: "off", dailyCapUsd: 8 } });
  await dispatch(handlers, "config:update", [{ backgroundWork: { dailyCapUsd: 12.345 }, handoffMode: "off" }]);
  assert.deepEqual(updates.at(-1), { handoffMode: "off", backgroundWork: { level: "light", dailyCapUsd: 12.35 } });
});

test("config:update accepts dotted backgroundWork.* keys and defaults a missing stored value", async () => {
  const { handlers, updates } = rig();
  await dispatch(handlers, "config:update", [{ "backgroundWork.level": "off", "backgroundWork.dailyCapUsd": 2 }]);
  assert.deepEqual(updates, [{ backgroundWork: { level: "off", dailyCapUsd: 2 } }]);
  await dispatch(handlers, "config:update", [{ "backgroundWork.level": "light" }]);
  assert.deepEqual(updates.at(-1), { backgroundWork: { level: "light", dailyCapUsd: 5 } });
});

test("config:update rejects an invalid backgroundWork with a 400 sentence and writes nothing", async () => {
  const { handlers, updates } = rig({ stored: { level: "normal", dailyCapUsd: 5 } });
  for (const bad of [{ backgroundWork: { level: "max" } }, { backgroundWork: { dailyCapUsd: -1 } }, { backgroundWork: { dailyCapUsd: 101 } }, { backgroundWork: "x" }, { backgroundWork: null }, { "backgroundWork.dailyCapUsd": "5" }, { backgroundWork: { nope: 1 } }]) {
    await assert.rejects(dispatch(handlers, "config:update", [{ ...bad, handoffMode: "off" }]), (e) => e.rpcStatus === 400 && /\w/.test(e.message), JSON.stringify(bad));
  }
  assert.deepEqual(updates, []);
});

test("config:update ignores the retired caps (an older desktop's save still succeeds) and leaves the rest of the patch", async () => {
  const { handlers, updates } = rig();
  await dispatch(handlers, "config:update", [{ ctoAmbientCap: 9, ctoAmbientCapUsd: 9, ctoNightCapUsd: 9, handoffMode: "off" }]);
  assert.deepEqual(updates, [{ handoffMode: "off" }]);
  await dispatch(handlers, "config:update", [{ ctoNightCapUsd: 1 }]);
  assert.deepEqual(updates.at(-1), {});
});

test("background:status reaches the budget; an unwired box answers 503", async () => {
  const status = { level: "normal", dailyCapUsd: 5, payg: {}, plans: [], waitingBatch: [], byWork: [] };
  const { handlers } = rig({ backgroundBudget: { status: async () => status } });
  assert.deepEqual(await dispatch(handlers, "background:status", []), status);
  const bare = rig();
  await assert.rejects(dispatch(bare.handlers, "background:status", []), (e) => e.rpcStatus === 503);
});
