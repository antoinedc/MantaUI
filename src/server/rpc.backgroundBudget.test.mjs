// The background-budget rpc surface: `config:update` validates and MERGES `backgroundWork`, ignores the retired
// per-subsystem caps, and `background:status` reaches the budget (503 when it isn't wired).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubRpcDeps } from "./fixtures/rpcStubDeps.mjs";
import { dispatch, buildHandlers } from "./rpc.mjs";

function rig({ stored, backgroundBudget } = {}) {
  const updates = [];
  const applied = [];
  const removals = [];
  const deps = stubRpcDeps({
    local: { configGet: async () => ({ projects: [], ...(stored ? { backgroundWork: stored } : {}) }), configUpdate: async (p, opts) => (updates.push(p), removals.push(opts?.remove ?? []), { ...p }) },
    oc: {},
    syncState: { applyConfig: (c) => applied.push(c), refreshNow: async () => {}, snapshot: () => ({ projects: [] }), everSucceeded: () => true },
    ...(backgroundBudget ? { backgroundBudget } : {}),
  });
  return { handlers: buildHandlers(deps), updates, applied, removals };
}

test("config:update merges a partial backgroundWork into the stored one (level alone keeps the cap) and syncs the result", async () => {
  const { handlers, updates, applied } = rig({ stored: { level: "light", dailyCapUsd: 8 } });
  await dispatch(handlers, "config:update", [{ backgroundWork: { level: "off" } }]);
  assert.deepEqual(updates, [{ backgroundWork: { level: "off", dailyCapUsd: 8, runWhenBusy: false } }]);
  assert.deepEqual(applied.at(-1), { backgroundWork: { level: "off", dailyCapUsd: 8, runWhenBusy: false } });
  await dispatch(handlers, "config:update", [{ backgroundWork: { dailyCapUsd: 12.345 }, handoffMode: "off" }]);
  assert.deepEqual(updates.at(-1), { handoffMode: "off", backgroundWork: { level: "light", dailyCapUsd: 12.35, runWhenBusy: false } });
});

test("config:update stores runWhenBusy, merged with the stored level and cap (alone, dotted, or with others)", async () => {
  const { handlers, updates, applied } = rig({ stored: { level: "light", dailyCapUsd: 8 } });
  await dispatch(handlers, "config:update", [{ backgroundWork: { runWhenBusy: true } }]);
  assert.deepEqual(updates.at(-1), { backgroundWork: { level: "light", dailyCapUsd: 8, runWhenBusy: true } });
  assert.deepEqual(applied.at(-1), { backgroundWork: { level: "light", dailyCapUsd: 8, runWhenBusy: true } });
  const again = rig({ stored: { level: "normal", dailyCapUsd: 5, runWhenBusy: true } });
  await dispatch(again.handlers, "config:update", [{ "backgroundWork.level": "off" }]);
  assert.deepEqual(again.updates.at(-1), { backgroundWork: { level: "off", dailyCapUsd: 5, runWhenBusy: true } }, "a level change keeps the override");
  await dispatch(again.handlers, "config:update", [{ "backgroundWork.runWhenBusy": false }]);
  assert.equal(again.updates.at(-1).backgroundWork.runWhenBusy, false);
});

test("config:update accepts dotted backgroundWork.* keys and defaults a missing stored value", async () => {
  const { handlers, updates } = rig();
  await dispatch(handlers, "config:update", [{ "backgroundWork.level": "off", "backgroundWork.dailyCapUsd": 2 }]);
  assert.deepEqual(updates, [{ backgroundWork: { level: "off", dailyCapUsd: 2, runWhenBusy: false } }]);
  await dispatch(handlers, "config:update", [{ "backgroundWork.level": "light" }]);
  assert.deepEqual(updates.at(-1), { backgroundWork: { level: "light", dailyCapUsd: 5, runWhenBusy: false } });
});

test("config:update rejects an invalid backgroundWork with a 400 sentence and writes nothing", async () => {
  const { handlers, updates } = rig({ stored: { level: "normal", dailyCapUsd: 5 } });
  for (const bad of [{ backgroundWork: { level: "max" } }, { backgroundWork: { dailyCapUsd: -1 } }, { backgroundWork: { dailyCapUsd: 101 } }, { backgroundWork: "x" }, { backgroundWork: null }, { "backgroundWork.dailyCapUsd": "5" }, { backgroundWork: { nope: 1 } }, { backgroundWork: { runWhenBusy: "yes" } }, { "backgroundWork.runWhenBusy": 1 }]) {
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

test("config:update also strips the retired caps from the STORED config on any write (spec §9)", async () => {
  const { handlers, removals } = rig();
  await dispatch(handlers, "config:update", [{ handoffMode: "off" }]);
  assert.deepEqual(removals.at(-1), ["ctoAmbientCap", "ctoAmbientCapUsd", "ctoNightCapUsd"]);
  await dispatch(handlers, "config:update", [{ ctoNightCapUsd: 1 }]);
  assert.deepEqual(removals.at(-1), ["ctoAmbientCap", "ctoAmbientCapUsd", "ctoNightCapUsd"], "even a write that carried only a retired key");
});

test("background:status reaches the budget; an unwired box answers 503", async () => {
  const status = { level: "normal", dailyCapUsd: 5, payg: {}, plans: [], waitingBatch: [], byWork: [] };
  const { handlers } = rig({ backgroundBudget: { status: async () => status } });
  assert.deepEqual(await dispatch(handlers, "background:status", []), status);
  const bare = rig();
  await assert.rejects(dispatch(bare.handlers, "background:status", []), (e) => e.rpcStatus === 503);
});
