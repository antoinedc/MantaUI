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
  const calls = { newWindow: [], newWindowGetIndex: [], createSession: [], forkSession: [] };
  return {
    calls,
    deps: {
      tmux: {
        listProjects: async () => [],
        newWindow: async (i) => { calls.newWindow.push(i); return []; },
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
