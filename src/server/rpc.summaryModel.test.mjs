// The Summary model rpc surface (cold-cache handoff spec A1/A2/A5): the three
// channels, the server-owned config keys, session titles and the reconciler nudges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildHandlers } from "./rpc.mjs";

function rig({ summaryModel, oc = {}, localOver = {} } = {}) {
  const updates = [];
  const deps = {
    tmux: { listProjects: async () => [] },
    pty: {},
    bus: {},
    syncState: { refreshNow: async () => {}, applyConfig: () => {}, snapshot: () => ({ projects: [] }), payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }), everSucceeded: () => true },
    local: {
      configGet: async () => ({ projects: [], summaryModel: { providerID: "a", modelID: "m", source: "user", pickedAt: 1 } }),
      configUpdate: async (p) => (updates.push(p), { ...p }),
      ...localOver,
    },
    push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
    oc,
    ...(summaryModel ? { summaryModel } : {}),
  };
  return { handlers: buildHandlers(deps), updates };
}

test("config:update strips the two server-owned summary-model keys — a generic write can never set or clobber them", async () => {
  const { handlers, updates } = rig();
  await dispatch(handlers, "config:update", [{ summaryModel: { providerID: "x", modelID: "y", source: "user" }, summaryModelOptOut: true, handoffMode: "off" }]);
  assert.deepEqual(updates, [{ handoffMode: "off" }]);
  await dispatch(handlers, "config:update", [{ summaryModelOptOut: false }]);
  assert.deepEqual(updates.at(-1), {});
});

test("summary-model:status / search / set pass their payloads straight to the module and return its answers", async () => {
  const log = [];
  const status = { current: null, state: "unset", reason: "r", betterAvailable: false, candidates: [] };
  const summaryModel = {
    status: async () => (log.push(["status"]), status),
    search: async (i) => (log.push(["search", i]), { models: [] }),
    set: async (i) => (log.push(["set", i]), status),
  };
  const { handlers } = rig({ summaryModel });
  assert.deepEqual(await dispatch(handlers, "summary-model:status", []), status);
  assert.deepEqual(await dispatch(handlers, "summary-model:search", [{ query: "haiku" }]), { models: [] });
  assert.deepEqual(await dispatch(handlers, "summary-model:set", [{ providerID: "a", modelID: "m" }]), status);
  assert.deepEqual(await dispatch(handlers, "summary-model:set", [{ none: true }]), status);
  assert.deepEqual(log, [["status"], ["search", { query: "haiku" }], ["set", { providerID: "a", modelID: "m" }], ["set", { none: true }]]);
});

test("a refused set surfaces the module's 400 (rpcStatus + the human sentence); unwired boxes answer 503", async () => {
  const summaryModel = { set: async () => { throw Object.assign(new Error("That model isn't available as a summary model."), { rpcStatus: 400 }); } };
  const { handlers } = rig({ summaryModel });
  await assert.rejects(dispatch(handlers, "summary-model:set", [{ providerID: "x", modelID: "y" }]), (e) => e.rpcStatus === 400 && /isn't available as a summary model/.test(e.message));
  const bare = rig();
  await assert.rejects(dispatch(bare.handlers, "summary-model:status", []), (e) => e.rpcStatus === 503);
});

test("opencode:generate-title writes on the resolved cheap writer, and skips ('') when there is none — opencode never chooses", async () => {
  const calls = [];
  const oc = { generateSessionTitle: async (a) => (calls.push(a), "A title") };
  const writers = { ses_sum: { providerID: "p", modelID: "summary", from: "summary" }, ses_own: { providerID: "q", modelID: "own", from: "session" } };
  const summaryModel = { resolveCheapWriter: async (sid) => writers[sid] ?? null };
  const { handlers } = rig({ summaryModel, oc });
  assert.equal(await dispatch(handlers, "opencode:generate-title", [{ directory: "/w", instruction: "i", sessionId: "ses_sum" }]), "A title");
  assert.deepEqual(calls[0], { directory: "/w", instruction: "i", model: { providerID: "p", modelID: "summary" } });
  await dispatch(handlers, "opencode:generate-title", [{ directory: "/w", instruction: "i", sessionId: "ses_own" }]);
  assert.deepEqual(calls[1].model, { providerID: "q", modelID: "own" });
  assert.equal(await dispatch(handlers, "opencode:generate-title", [{ directory: "/w", instruction: "i", sessionId: "ses_none" }]), "");
  assert.equal(await dispatch(handlers, "opencode:generate-title", [{ directory: "/w", instruction: "i" }]), "");
  assert.equal(calls.length, 2, "no call at all without a writer");
  const bare = rig({ oc });
  assert.equal(await dispatch(bare.handlers, "opencode:generate-title", [{ directory: "/w", instruction: "i", sessionId: "ses_sum" }]), "", "no module wired → skipped, never an opencode-chosen model");
  assert.equal(calls.length, 2);
});

test("connecting or disconnecting a provider nudges the reconciler (detached); a failed connect does not", async () => {
  let nudges = 0;
  const summaryModel = { reconcile: async () => { nudges++; } };
  const oc = {
    setProviderApiKey: async (id) => ({ ok: id === "good" }),
    removeProviderAuth: async () => ({ ok: true }),
    readAuthedProviderIds: async () => [],
  };
  const handlersWithRestart = buildHandlers({
    tmux: { listProjects: async () => [] }, pty: {}, bus: {},
    syncState: { applyConfig: () => {} }, local: { configGet: async () => ({}) }, push: {},
    oc, summaryModel, restartOpencode: async () => ({ ok: true }),
  });
  await dispatch(handlersWithRestart, "opencode:provider-auth", [{ action: "key", id: "good", key: "k" }]);
  await dispatch(handlersWithRestart, "opencode:provider-auth", [{ action: "key", id: "bad", key: "k" }]);
  assert.equal(nudges, 1);
  await dispatch(handlersWithRestart, "opencode:provider-auth", [{ action: "disconnect", id: "good" }]);
  assert.equal(nudges, 2);
});
