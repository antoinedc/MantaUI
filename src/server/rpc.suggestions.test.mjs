// `agents:suggestions`, `agents:suggestion-seen`, `agents:suggestion-act` and the `agentSuggestions` setting (spec 2026-11-28-research-layer.md §6.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stubRpcDeps } from "./fixtures/rpcStubDeps.mjs";
import { dispatch, buildHandlers } from "./rpc.mjs";

function rig({ suggestions, writes = [] } = {}) {
  const deps = stubRpcDeps({
    suggestions,
    local: { configGet: async () => ({ projects: [] }), configUpdate: async (patch) => (writes.push(patch), { projects: [], ...patch }) },
    oc: {},
  });
  return { handlers: buildHandlers(deps), writes };
}

test("the three channels pass the contract's inputs to the engine and return its answer unchanged", async () => {
  const seen = [];
  const suggestions = {
    list: async (a) => (seen.push(["list", a]), { offers: [{ id: "o_1" }] }),
    seen: async (a) => (seen.push(["seen", a]), { ok: true, seenAt: "2026-11-28T10:00:00.000Z" }),
    act: async (a) => (seen.push(["act", a]), { ok: true, already: "later" }),
  };
  const { handlers } = rig({ suggestions });
  assert.deepEqual(await dispatch(handlers, "agents:suggestions", [{ sessionId: "ses_1" }]), { offers: [{ id: "o_1" }] });
  assert.deepEqual(await dispatch(handlers, "agents:suggestion-seen", [{ id: "o_1", sessionId: "ses_1" }]), { ok: true, seenAt: "2026-11-28T10:00:00.000Z" });
  assert.deepEqual(await dispatch(handlers, "agents:suggestion-act", [{ id: "o_1", action: "agent" }]), { ok: true, already: "later" });
  assert.deepEqual(seen, [["list", { sessionId: "ses_1" }], ["seen", { id: "o_1", sessionId: "ses_1" }], ["act", { id: "o_1", action: "agent" }]]);
});

test("a missing session id reads as an empty session id, not a crash", async () => {
  const { handlers } = rig({ suggestions: { list: async (a) => ({ offers: [], got: a }) } });
  assert.deepEqual((await dispatch(handlers, "agents:suggestions", [undefined])).got, { sessionId: "" });
});

test("an engine that throws answers a safe sentence (500), never the raw error; not wired answers 503", async () => {
  const { handlers } = rig({ suggestions: { act: async () => { throw new Error("EACCES /home/x/.manta/agents/.suggestions.json"); } } });
  await assert.rejects(dispatch(handlers, "agents:suggestion-act", [{ id: "o", action: "agent" }]), (e) => e.rpcStatus === 500 && !/EACCES|\.manta/.test(e.message));
  const none = rig();
  await assert.rejects(dispatch(none.handlers, "agents:suggestions", [{ sessionId: "s" }]), (e) => e.rpcStatus === 503);
});

test("config:update accepts agentSuggestions true/false and refuses anything else", async () => {
  const { handlers, writes } = rig();
  await dispatch(handlers, "config:update", [{ agentSuggestions: false }]);
  assert.deepEqual(writes, [{ agentSuggestions: false }]);
  await assert.rejects(dispatch(handlers, "config:update", [{ agentSuggestions: "no" }]), (e) => e.rpcStatus === 400);
});
