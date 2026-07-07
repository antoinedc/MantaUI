import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch, buildHandlers } from "./rpc.mjs";

test("dispatch routes a known channel to its handler with args", async () => {
  const handlers = { "echo:it": async (a, b) => ({ sum: a + b }) };
  const out = await dispatch(handlers, "echo:it", [2, 3]);
  assert.deepEqual(out, { sum: 5 });
});

test("dispatch throws a descriptive error for unknown channel", async () => {
  await assert.rejects(() => dispatch({}, "nope:nope", []),
    /unknown rpc channel: nope:nope/);
});

// Minimal stubs for buildHandlers — only the namespaces touched by the cwd
// resolution tests need real behavior; everything else can be a no-op.
function makeDeps(projects) {
  const calls = { newWindow: [], newSession: [], newWindowGetIndex: [], createSession: [], forkSession: [] };
  return {
    calls,
    deps: {
      tmux: {
        listProjects: async () => [],
        newWindow: async (i) => { calls.newWindow.push(i); return []; },
        newSession: async (i) => { calls.newSession.push(i); return []; },
        newWindowGetIndex: async (sessionName, windowName, cwd) => {
          calls.newWindowGetIndex.push({ sessionName, windowName, cwd });
          return 1;
        },
        restampSessionId: async () => {},
      },
      oc: {
        createSession: async (i) => { calls.createSession.push(i); return { id: "ses_new" }; },
        forkSession: async (i) => { calls.forkSession.push(i); return { id: "ses_forked" }; },
      },
      pty: {},
      bus: {},
      local: { configGet: async () => ({ projects }) },
    },
  };
}

test("tmux:new-window resolves empty cwd from project defaultCwd", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "better-ui", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/better-ui");
});

test("tmux:new-window resolves literal '~' from project defaultCwd", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "better-ui", windowName: "session", cwd: "~" });
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/better-ui");
});

test("tmux:new-window preserves an explicit non-tilde cwd from the renderer", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "better-ui", windowName: "wt", cwd: "/home/dev/projects/better-ui/worktrees/feat" });
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/better-ui/worktrees/feat");
});

test("tmux:new-window falls through to '~' when project meta is missing", async () => {
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "unknown", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "~");
});

test("opencode:clear-session passes resolved defaultCwd to oc.createSession", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  const out = await handlers["opencode:clear-session"]({
    sessionName: "better-ui",
    windowIndex: 2,
    cwd: "",
    title: "cleared",
  });
  assert.equal(out.newSessionId, "ses_new");
  assert.equal(calls.createSession.at(-1).directory, "/home/dev/projects/better-ui");
});

test("opencode:clear-session respects an explicit absolute cwd over defaultCwd", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["opencode:clear-session"]({
    sessionName: "better-ui",
    windowIndex: 2,
    cwd: "/home/dev/projects/better-ui/worktrees/feat",
    title: "cleared",
  });
  assert.equal(calls.createSession.at(-1).directory, "/home/dev/projects/better-ui/worktrees/feat");
});

test("opencode:fork-session creates the new tmux window in the resolved defaultCwd", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["opencode:fork-session"]({
    sessionId: "ses_old",
    sessionName: "better-ui",
    windowName: "fork-1",
    cwd: "",
  });
  assert.equal(calls.newWindowGetIndex.at(-1).cwd, "/home/dev/projects/better-ui");
});

// ---- BET-113: chatMode must reach the tmux layer with the oc client -------
// The regression was the tmux:new-window / tmux:new-session handlers dropping
// chatMode and never giving the tmux layer an opencode client to create a
// session with. These assert the handler forwards both.

test("tmux:new-window forwards chatMode + oc client to tmux.newWindow", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({
    sessionName: "better-ui",
    windowName: "chat",
    cwd: "",
    chatMode: true,
  });
  const last = calls.newWindow.at(-1);
  assert.equal(last.chatMode, true, "chatMode forwarded");
  assert.equal(last.cwd, "/home/dev/projects/better-ui", "cwd resolved from defaultCwd");
  assert.ok(last.oc && typeof last.oc.createSession === "function", "oc client forwarded");
});

test("tmux:new-window forwards oc even for a non-chat window (chatMode falsy)", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "better-ui", windowName: "term", cwd: "" });
  const last = calls.newWindow.at(-1);
  assert.ok(!last.chatMode, "chatMode not set for a plain window");
  assert.ok(last.oc && typeof last.oc.createSession === "function", "oc client still forwarded");
});

test("tmux:new-session forwards chatMode + oc client and resolves cwd", async () => {
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-session"]({
    name: "newproj",
    windowName: "chat",
    cwd: "/home/dev/projects/newproj",
    chatMode: true,
  });
  const last = calls.newSession.at(-1);
  assert.equal(last.chatMode, true, "chatMode forwarded");
  assert.equal(last.cwd, "/home/dev/projects/newproj", "explicit cwd preserved");
  assert.ok(last.oc && typeof last.oc.createSession === "function", "oc client forwarded");
});

// REGRESSION (Refresh in Settings → "unreachable: could not reach the
// endpoint"): httpApi + preload both send discover-models as POSITIONAL args
// — rpc(channel, baseURL, apiKey) — and dispatch() spreads args into the
// handler. The old handler destructured a single object (`input?.baseURL`),
// so it read `.baseURL` off the baseURL STRING → undefined → discovery ran
// against "" for EVERY refresh. This drives the real positional path through
// dispatch() with fetch mocked, and asserts the request hits
// <baseURL>/models with the provided key.
test("opencode:discover-models accepts positional (baseURL, apiKey) args", async () => {
  const { deps } = makeDeps([]);
  const handlers = buildHandlers(deps);
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), auth: opts?.headers?.Authorization ?? "" });
    return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await dispatch(handlers, "opencode:discover-models", [
      "https://api.example.com/v1", "explicit-key",
    ]);
    assert.equal(seen.length, 1, "exactly one discovery request");
    assert.equal(seen[0].url, "https://api.example.com/v1/models");
    assert.equal(seen[0].auth, "Bearer explicit-key");
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [{ id: "m1" }]);
  } finally {
    globalThis.fetch = origFetch;
  }
});
