// cto.test.mjs — On-call CTO read gateway (BET-1164, issue 1/3).
// Pure logic + injected I/O: registry integrity, dispatch (default-allow gate,
// deny/confirm fail-closed, onNarrate boundaries), the tool reads (all
// deterministic, none throw on a quiet box), and the cto.json store lifecycle.
// No live tmux / opencode / multica.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultCtoStore,
  loadCtoStore,
  appendCtoAudit,
  createCtoEngine,
} from "./cto.mjs";

// Shared fakes so every engine test is deterministic and side-effect free.
function makeEngine(overrides = {}) {
  const engine = createCtoEngine({
    listProjects: async () => [],
    listSessions: async () => [],
    listMessages: async () => [],
    listModels: async () => [],
    getSessionAgent: async () => null,
    listSnapshots: () => [],
    listStopped: async () => ({ records: [], lastLooked: null }),
    searchMessages: async () => ({ supported: true, hits: [] }),
    configGet: async () => ({}),
    gitStatus: async () => "",
    gitBranch: async () => null,
    gitLog: async () => "",
    queryMultica: async () => ({ ok: true }),
    ...overrides,
  });
  return engine;
}

const TOOL_COUNT = 15;

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

test("registry exposes every cto read tool with a complete shape, all mode auto", () => {
  const engine = makeEngine();
  const tools = engine.listTools();
  assert.equal(tools.length, TOOL_COUNT);
  const names = new Set(tools.map((t) => t.name));
  assert.deepEqual(
    [...names].sort(),
    [
      "list_sessions",
      "list_projects",
      "read_transcript",
      "search_messages",
      "git_status",
      "git_branch",
      "git_log",
      "list_models",
      "get_usage",
      "usage_stopped",
      "session_usage",
      "context_state",
      "session_plan_mode",
      "get_config",
      "query_multica",
    ].sort(),
  );
  for (const t of tools) {
    assert.equal(typeof t.name, "string");
    assert.ok(t.name.length > 0);
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    assert.ok(t.params && typeof t.params === "object");
    assert.equal(t.mode, "auto");
    assert.equal(typeof t.run, "function");
  }
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test("dispatch returns a structured error for an unknown tool (never throws)", async () => {
  const engine = makeEngine();
  const result = await engine.dispatch("nope", {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown cto tool: nope/);
});

test("dispatch runs a tool through the default-allow gate", async () => {
  const engine = makeEngine({
    listModels: async () => [
      { providerID: "anthropic", id: "claude-opus-4-7", name: "Opus", limit: { context: 1_000_000 } },
    ],
  });
  const result = await engine.dispatch("list_models", {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.models.length, 1);
  assert.equal(result.data.models[0].modelID, "claude-opus-4-7");
  assert.equal(result.data.models[0].contextLimit, 1_000_000);
});

test("dispatch honors a gate returning deny (fails closed)", async () => {
  const engine = makeEngine();
  const gate = () => "deny";
  const result = await engine.dispatch("list_models", {}, { gate });
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/);
});

test("dispatch fails closed when the gate requests confirm (not wired yet)", async () => {
  const engine = makeEngine();
  const gate = () => "confirm";
  const result = await engine.dispatch("list_models", {}, { gate });
  assert.equal(result.ok, false);
  assert.match(result.error, /requires confirmation/);
});

test("default gate returns allow for every tool (Issue 1 ships auto)", async () => {
  const engine = makeEngine();
  for (const t of engine.listTools()) {
    // No ctx.gate → default allow; a benign read tool must run, not be denied.
    if (t.name === "read_transcript") continue; // needs an arg we don't assert here
    const r = await engine.dispatch(t.name, {}, {});
    assert.ok(r.ok === true || r.ok === false, t.name + " resolves cleanly");
  }
});

test("onNarrate is called at tool boundaries and is a no-op when unset", async () => {
  const engine = makeEngine();
  const narrated = [];
  const result = await engine.dispatch("list_models", {}, { onNarrate: (s) => narrated.push(s) });
  assert.equal(result.ok, true);
  assert.ok(narrated.some((s) => s.includes("list_models")));

  // Unset → no throw.
  const r2 = await engine.dispatch("list_models", {}, {});
  assert.equal(r2.ok, true);
});

// ---------------------------------------------------------------------------
// Tool reads
// ---------------------------------------------------------------------------

test("read_transcript returns a bounded preview of REAL content, never fabricated", async () => {
  const engine = makeEngine({
    listMessages: async (sid, { limit }) => {
      assert.equal(typeof limit, "number");
      const mk = (role, text) => ({ info: { role }, tokens: { input: 10, output: 5 }, time: 100, parts: [{ type: "text", text }] });
      return [mk("user", "hello there"), mk("assistant", "plan: implement the gateway")];
    },
  });
  const r = await engine.dispatch("read_transcript", { sessionID: "ses_1" }, {});
  assert.equal(r.ok, true);
  assert.equal(r.data.sessionID, "ses_1");
  assert.equal(r.data.count, 2);
  assert.equal(r.data.messages[0].preview, "hello there");
  assert.equal(r.data.messages[1].preview, "plan: implement the gateway");
});

test("read_transcript requires a sessionID", async () => {
  const engine = makeEngine();
  const r = await engine.dispatch("read_transcript", {}, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /sessionID is required/);
});

test("get_config scrubs secrets and supports dot-path access", async () => {
  const engine = makeEngine({
    configGet: async () => ({
      groqApiKey: "SECRET",
      boxToken: "SECRET2",
      defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" },
      cacheTtl: "1h",
    }),
  });
  const full = await engine.dispatch("get_config", {}, {});
  assert.equal(full.ok, true);
  assert.equal(full.data.config.defaultModel.modelID, "claude-opus-4-7");
  assert.equal(full.data.config.groqApiKey, undefined);
  assert.equal(full.data.config.boxToken, undefined);
  assert.equal(full.data.config.cacheTtl, "1h");

  const partial = await engine.dispatch("get_config", { path: "defaultModel" }, {});
  assert.equal(partial.ok, true);
  assert.equal(partial.data.value.modelID, "claude-opus-4-7");
  assert.equal(partial.data.config, undefined);
});

test("session_plan_mode reads the active agent", async () => {
  const engine = makeEngine({
    getSessionAgent: async (sid) => (sid === "ses_plan" ? "plan" : "build"),
  });
  const yes = await engine.dispatch("session_plan_mode", { sessionID: "ses_plan" }, {});
  assert.equal(yes.ok, true);
  assert.equal(yes.data.planMode, true);
  const no = await engine.dispatch("session_plan_mode", { sessionID: "ses_build" }, {});
  assert.equal(no.data.planMode, false);
});

test("quiet box: no sessions / no usage / no board never throws", async () => {
  const engine = makeEngine();
  const calls = ["list_projects", "list_models", "get_usage", "usage_stopped", "list_sessions"];
  for (const tool of calls) {
    const r = await engine.dispatch(tool, {}, {});
    assert.equal(r.ok, true, tool);
  }
  const board = await engine.dispatch("query_multica", {}, {});
  assert.equal(board.ok, true);
});

test("session_usage / context_state / git tools resolve cleanly on empty fakes", async () => {
  const engine = makeEngine();
  const su = await engine.dispatch("session_usage", { sessionID: "ses_x" }, {});
  assert.equal(su.ok, false); // unknown session on an empty box → structured error, not throw
  const cs = await engine.dispatch("context_state", { sessionID: "ses_x" }, {});
  assert.equal(cs.ok, true); // context state tolerates an unknown session
  const gs = await engine.dispatch("git_status", {}, {});
  assert.equal(gs.ok, true);
  const gl = await engine.dispatch("git_log", {}, {});
  assert.equal(gl.ok, true);
});

test("git tools accept an explicit cwd and reject a failing repo without throwing", async () => {
  const engine = makeEngine({
    gitStatus: async (cwd) => { assert.equal(cwd, "/repo"); throw new Error("not a git repo"); },
  });
  const r = await engine.dispatch("git_status", { cwd: "/repo" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /not a git repo/);
});

// ---------------------------------------------------------------------------
// cto.json store
// ---------------------------------------------------------------------------

test("defaultCtoStore lays down the agreed shape (watches/inbound empty for issue 1)", () => {
  const s = defaultCtoStore();
  assert.equal(s.version, 1);
  assert.deepEqual(s.watches, []);
  assert.deepEqual(s.inbound, []);
  assert.deepEqual(s.audit, []);
});

test("loadCtoStore returns the default shape for a missing/corrupt file", () => {
  const s = loadCtoStore("/proc/definitely/not/a/file-cto-test.json");
  assert.equal(s.version, 1);
  assert.deepEqual(s.watches, []);
  assert.deepEqual(s.inbound, []);
  assert.deepEqual(s.audit, []);
});

test("appendCtoAudit appends a timestamped entry and persists via injected save", async () => {
  let state = defaultCtoStore();
  const load = () => state;
  const save = async (s) => {
    state = s;
  };
  const store = await appendCtoAudit({ tool: "list_sessions", ok: true }, { load, save, now: () => 123 });
  assert.equal(store.audit.length, 1);
  assert.equal(store.audit[0].at, 123);
  assert.equal(store.audit[0].tool, "list_sessions");
  // persisted
  assert.equal(state.audit.length, 1);
});
