// `agents:autonomy-get` / `agents:autonomy-set` (Agents Phase 3 §2): the user's settings through the one config writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubRpcDeps } from "./fixtures/rpcStubDeps.mjs";
import { dispatch, buildHandlers } from "./rpc.mjs";
import { MODES } from "../shared/autonomyShared.mjs";

function rig({ stored, readFails = false, writeFails = false } = {}) {
  let current = stored;
  const writes = [];
  const deps = stubRpcDeps({
    local: {
      configGet: async () => ({ projects: [] }),
      readAgentAutonomyStrict: async () => {
        if (readFails) throw new Error("/home/x/.manta/config.json: EACCES");
        return current;
      },
      configUpdate: async (patch) => {
        if (writeFails) throw new Error("/home/x/.manta/config.json: ENOSPC");
        writes.push(patch);
        current = patch.agentAutonomy;
        return { projects: [], ...patch };
      },
    },
    oc: {},
    syncState: { applyConfig: () => {}, refreshNow: async () => {}, snapshot: () => ({ projects: [] }), everSucceeded: () => true },
  });
  return { handlers: buildHandlers(deps), writes };
}

test("agents:autonomy-get: Balanced when nothing is stored; otherwise the stored mode and overrides plus every kind's answer", async () => {
  const fresh = rig();
  assert.deepEqual(await dispatch(fresh.handlers, "agents:autonomy-get", []), { mode: "balanced", overrides: {}, effective: MODES.balanced });
  const set = rig({ stored: { mode: "autonomous", overrides: { deploy: "ask" } } });
  assert.deepEqual(await dispatch(set.handlers, "agents:autonomy-get", []), { mode: "autonomous", overrides: { deploy: "ask" }, effective: { ...MODES.autonomous, deploy: "ask" } });
});

test("agents:autonomy-set: validates, writes the FULL block through the config writer and answers the settings", async () => {
  const r = rig();
  const out = await dispatch(r.handlers, "agents:autonomy-set", [{ mode: "cautious", overrides: { merge: "never", edit_code: "ask" } }]);
  assert.deepEqual(r.writes, [{ agentAutonomy: { mode: "cautious", overrides: { merge: "never", edit_code: "never" } } }]);
  assert.deepEqual(out, { mode: "cautious", overrides: { merge: "never", edit_code: "never" }, effective: { ...MODES.cautious, merge: "never", edit_code: "never" } });
  const back = await dispatch(r.handlers, "agents:autonomy-set", [{ mode: "balanced", overrides: {} }]);
  assert.deepEqual(back, { mode: "balanced", overrides: {}, effective: MODES.balanced });
});

test("agents:autonomy-set: an unknown mode, kind or level is a sentence (400) and nothing is written", async () => {
  const r = rig();
  for (const bad of [{ mode: "wild", overrides: {} }, { mode: "balanced", overrides: { nope: "auto" } }, { mode: "balanced", overrides: { merge: "maybe" } }, null]) {
    await assert.rejects(dispatch(r.handlers, "agents:autonomy-set", [bad]), (e) => e.rpcStatus === 400 && /\S/.test(e.message));
  }
  assert.deepEqual(r.writes, []);
});

test("autonomy channels: an fs failure is a safe sentence — no path on the user's screen", async () => {
  for (const [r, channel, args] of [[rig({ readFails: true }), "agents:autonomy-get", []], [rig({ writeFails: true }), "agents:autonomy-set", [{ mode: "balanced", overrides: {} }]]]) {
    await assert.rejects(dispatch(r.handlers, channel, args), (e) => e.rpcStatus === 500 && e.message === "Couldn't read your autonomy settings; try again" && !/home|EACCES|ENOSPC/.test(e.message));
  }
});
