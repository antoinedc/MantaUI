import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatch,
  buildHandlers,
  handleRpcRequest,
  acceptsGzip,
  GZIP_MIN_BYTES,
  SELF_UPDATE_SCRIPT,
} from "./rpc.mjs";
import { gunzipSync } from "node:zlib";
import { savePages } from "./servePage.mjs";
import { statePath } from "../shared/paths.mjs";

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
function makeDeps(projects, liveProjects = []) {
  const calls = {
    newWindow: [],
    newSession: [],
    newWindowGetIndex: [],
    createSession: [],
    forkSession: [],
    projectMetaUpsert: [],
  };
  return {
    calls,
    deps: {
      tmux: {
        listProjects: async () => liveProjects,
        newWindow: async (i) => {
          calls.newWindow.push(i);
          return { sessionId: null, windowIndex: 1, projects: liveProjects };
        },
        newSession: async (i) => {
          calls.newSession.push(i);
          return { sessionId: "ses_new", windowIndex: 1, projects: [] };
        },
        newWindowGetIndex: async (sessionName, windowName, cwd, chatMode) => {
          // BET-307: tmux.newWindowGetIndex now takes an optional 4th chatMode
          // arg (default false). Mirror the production arity so callers and
          // tests stay aligned. Old 3-arg call → chatMode is undefined →
          // production default false; behaviour is byte-identical.
          calls.newWindowGetIndex.push({ sessionName, windowName, cwd, chatMode });
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
      // BET-675: minimal syncState stub — the cwd-resolution tests only need
      // it to not throw; the materialized-state behaviour is covered by the
      // dedicated syncState.test.mjs.
      syncState: {
        refreshNow: async () => {},
        applyConfig: () => {},
        snapshot: () => ({ projects: liveProjects }),
        payloadSince: (s, g) => ({ gen: g, seq: 0, changed: {} }),
        everSucceeded: () => true,
      },
      local: {
        configGet: async () => ({ projects }),
        // BET-307: server-side projectMetaUpsert fires from tmux:new-session
        // — desktop + onboarding + mobile all go through one path now. This
        // mock records the calls so the test below can assert the absolute
        // defaultCwd was persisted.
        projectMetaUpsert: async (meta) => {
          calls.projectMetaUpsert.push(meta);
          return { projects: [...projects.filter((p) => p.tmuxSession !== meta.tmuxSession), meta] };
        },
        projectMetaDelete: async () => ({ projects }),
      },
      push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
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

test("tmux:new-window falls through to '~' when no stored meta and no live tmux session", async () => {
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "unknown", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "~");
});

test("tmux:new-window falls back to the LIVE tmux session cwd when stored meta is missing", async () => {
  // Config has no meta for this session (the common case: the session was not
  // created via the desktop project-create flow), but tmux knows where it lives.
  const { deps, calls } = makeDeps(
    [],
    [{ tmuxSession: "Leasebot", defaultCwd: "/home/dev/projects/leasebot" }],
  );
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "Leasebot", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/leasebot");
});

test("tmux:new-window ignores a live tmux defaultCwd of '~' (no useful info)", async () => {
  const { deps, calls } = makeDeps(
    [],
    [{ tmuxSession: "Leasebot", defaultCwd: "~" }],
  );
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "Leasebot", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "~");
});

test("stored project meta takes precedence over the live tmux cwd", async () => {
  const { deps, calls } = makeDeps(
    [{ tmuxSession: "Leasebot", defaultCwd: "/home/dev/projects/leasebot" }],
    [{ tmuxSession: "Leasebot", defaultCwd: "/home/dev" }],
  );
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-window"]({ sessionName: "Leasebot", windowName: "session", cwd: "" });
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/leasebot");
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
  const call = calls.newWindowGetIndex.at(-1);
  assert.equal(call.cwd, "/home/dev/projects/better-ui", "resolved cwd forwarded");
  assert.equal(call.sessionName, "better-ui");
  assert.equal(call.windowName, "fork-1");
  // BET-307: rpc.mjs:376 fork-session calls `newWindowGetIndex` with three
  // args (no chatMode). The new tmux-side signature defaults the 4th arg
  // to false, so the mock records chatMode as undefined.
  assert.equal(call.chatMode, undefined, "3-arg call → chatMode undefined → defaults to false in tmux.mjs");
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

// BET-161: the `auth:pair` /rpc channel. authEngine.pair() returns snake_case
// ({ pairing_code, box_id, expiresAt }); the handler translates to the
// camelCase AuthPairResult the renderer expects. Failures must surface as
// { ok:false, error } — a rejected promise would crash the renderer, which
// expects the classified result shape (see Settings.tsx).
test("auth:pair translates snake_case authEngine.pair() output to AuthPairResult", async () => {
  const { deps } = makeDeps([]);
  deps.authPair = async () => ({
    pairing_code: "123456",
    box_id: "abc",
    expiresAt: "2026-01-01T00:00:00Z",
  });
  const handlers = buildHandlers(deps);
  const result = await dispatch(handlers, "auth:pair", []);
  assert.deepEqual(result, {
    ok: true,
    pairingCode: "123456",
    boxId: "abc",
    expiresAt: "2026-01-01T00:00:00Z",
  });
});

test("auth:pair returns { ok:false, error } when authEngine.pair() throws", async () => {
  const { deps } = makeDeps([]);
  deps.authPair = async () => {
    throw new Error("rate limited");
  };
  const handlers = buildHandlers(deps);
  const result = await dispatch(handlers, "auth:pair", []);
  assert.deepEqual(result, { ok: false, error: "rate limited" });
});

// ---- BET-307: server-side projectMetaUpsert on tmux:new-session ----------
//
// The whole defect-D chain (desktop never records the project's folder;
// mobile does it twice) collapsed to a single server-side write inside the
// tmux:new-session handler. The renderer never has to remember to do it —
// and the persisted path is the EXPANDED absolute cwd, never the raw
// `~`-prefixed form the UI defaults to.

test("tmux:new-session persists the EXPANDED absolute cwd via projectMetaUpsert", async () => {
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-session"]({
    name: "newproj",
    cwd: "~/projects/newproj",
    windowName: "default",
    chatMode: true,
  });
  // Exactly one upsert, with the expanded absolute path.
  assert.equal(calls.projectMetaUpsert.length, 1, "one projectMetaUpsert call");
  const upserted = calls.projectMetaUpsert[0];
  assert.equal(upserted.tmuxSession, "newproj");
  assert.match(
    upserted.defaultCwd,
    /^\/home\/[^/]+\/projects\/newproj$/,
    `expanded absolute cwd, got ${upserted.defaultCwd}`,
  );
  assert.ok(!upserted.defaultCwd.startsWith("~"), "no leading tilde in persisted cwd");
});

test("tmux:new-session passes the resolved cwd to tmux.newSession", async () => {
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  await handlers["tmux:new-session"]({
    name: "newproj",
    cwd: "~/projects/newproj",
    windowName: "default",
    chatMode: true,
  });
  // The handler resolves via resolveProjectCwd → falls through to the
  // passed cwd (no stored meta, no live tmux yet) — passed verbatim to
  // tmux.newSession. The tmux-side chokepoint (resolveCwdOrThrow) is
  // responsible for expanding `~` and rejecting missing dirs from there.
  const last = calls.newSession.at(-1);
  assert.equal(last.cwd, "~/projects/newproj", "raw tilde forwarded to tmux layer");
});

test("tmux:new-session swallows projectMetaUpsert failures (best-effort)", async () => {
  const { deps } = makeDeps([]);
  deps.local.projectMetaUpsert = async () => { throw new Error("disk full"); };
  const handlers = buildHandlers(deps);
  // Must NOT throw — the rpc handler wraps with `.catch(() => {})` so a
  // config-write failure never fails project creation. Matches how the
  // old mobile sheet did it.
  const result = await handlers["tmux:new-session"]({
    name: "newproj",
    cwd: "/home/dev/projects/newproj",
    windowName: "default",
    chatMode: true,
  });
  // tmux.newSession result returned (no throw), NOT unboxed to projects.
  assert.deepEqual(result, { sessionId: "ses_new", windowIndex: 1, projects: [] });
});

// The create return contract: the renderer needs the newly-created window's
// identity (sessionId + windowIndex) from the RPC response so it can navigate
// + send the first prompt to the RIGHT session (previously it re-located by
// name, which mixed new sessions up with existing ones on name collisions).
test("tmux:new-window surfaces the created window's sessionId + windowIndex", async () => {
  const { deps, calls } = makeDeps([{ tmuxSession: "better-ui", defaultCwd: "/home/dev/projects/better-ui" }]);
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:new-window"]({
    sessionName: "better-ui",
    windowName: "chat",
    cwd: "",
    chatMode: true,
  });
  assert.equal(out.sessionId, null);
  assert.equal(out.windowIndex, 1);
  assert.deepEqual(out.projects, []);
  // the window's cwd was resolved before hitting tmux.newWindow
  assert.equal(calls.newWindow.at(-1).cwd, "/home/dev/projects/better-ui");
});

// ---- BET-309 follow-up (BET-318): opencode:provider-auth `status` -------
//
// Regression: BET-309 wired the `status` action to call
// `providers.getProviders()`, but no such export existed → every status call
// 500'd. Fix lifts the `GET /provider` fetch into a named export in
// opencode.mjs (oc.getProviders) and switches the rpc handler to that.
//
// These tests assert the end-to-end shape the renderer sees from the rpc
// channel, with the underlying opencode call stubbed via the `oc` dep.

test("opencode:provider-auth status returns subscriptionStatuses for the connected set", async () => {
  const { deps } = makeDeps([]);
  deps.oc.getProviders = async () => ({
    connected: ["anthropic", "openai"],
  });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({ action: "status" });
  assert.equal(result.action, "status");
  assert.ok(Array.isArray(result.providers));
  // anthropic + openai show as connected; kimi-for-coding is the third
  // SUBSCRIPTION_PROVIDERS entry — must NOT be connected.
  const byId = Object.fromEntries(result.providers.map((p) => [p.id, p.connected]));
  assert.equal(byId.anthropic, true);
  assert.equal(byId.openai, true);
  assert.equal(byId["kimi-for-coding"], false);
});

test("opencode:provider-auth status rejects with the upstream error (no try/catch in handler)", async () => {
  const { deps } = makeDeps([]);
  deps.oc.getProviders = async () => { throw new Error("upstream gone"); };
  const handlers = buildHandlers(deps);
  // The status branch awaits `oc.getProviders()` directly (no try/catch in
  // the handler) — a thrown upstream surfaces as a rejected promise that
  // the renderer's typed result would treat as an error. Pin the
  // current behavior so a future "wrap with try/catch" change is a
  // conscious one.
  await assert.rejects(
    () => handlers["opencode:provider-auth"]({ action: "status" }),
    /upstream gone/,
  );
});

// ---- BET-348: pty:spawn forwards tmuxTarget through the rpc envelope -------
//
// The server-side spawn primitive (`tmux attach-session -t <target>`) is
// already in src/server/pty.mjs (merged in BET-346, commit 66ad8a2). The
// rpc layer's `pty:spawn` handler is `(opts) => pty.spawn(opts, onEvent)`
// — a literal forwarder. This test pins that the wire payload's
// `tmuxTarget` reaches the pty.spawn() entry point unchanged. Combined
// with the pty.test.mjs spawn-wiring tests, this proves the full chain:
// renderer → rpc envelope → pty.spawn → spawnShellPty → resolvePtyCommand
// → tmux attach-session argv.

test("pty:spawn forwards tmuxTarget to pty.spawn unchanged", async () => {
  const { deps } = makeDeps([]);
  const seen = [];
  deps.pty.spawn = async (opts) => { seen.push(opts); };
  deps.bus.publish = () => {};
  const handlers = buildHandlers(deps);
  await handlers["pty:spawn"]({
    sessionKey: "tmux:myproject:0",
    cwd: "/home/dev/projects/myproject",
    cols: 80,
    rows: 24,
    tmuxTarget: "myproject:0",
  });
  assert.equal(seen.length, 1, "pty.spawn called exactly once");
  assert.equal(seen[0].tmuxTarget, "myproject:0", "tmuxTarget forwarded verbatim");
  assert.equal(seen[0].sessionKey, "tmux:myproject:0");
  assert.equal(seen[0].cwd, "/home/dev/projects/myproject");
});

// ---- BET-354: opencode:provider-auth `start` returns claude-login shape ---
//
// When describeConnectShape resolves to "claude-login" (anthropic oauth +
// empty URL), the rpc handler must hand back a sessionKey + startedAt
// stamp so the renderer's connect card can mount a Terminal pane and
// poll claude-status. We test the shape directly; the underlying IO
// lives in opencode.mjs (already covered by its own tests).

test("opencode:provider-auth start routes anthropic → claude-login shape (BET-354)", async () => {
  const { deps } = makeDeps([]);
  // opencode reports the standard anthropic oauth method with an EMPTY
  // url (the verified shape per BET-352 POC). describeConnectShape
  // picks "claude-login" — the handler then stamps a sessionKey.
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: {
      anthropic: [
        { type: "oauth", label: "Switch Claude Code account" },
      ],
    },
  });
  deps.oc.startProviderOauth = async () => ({
    ok: true,
    url: "",
    method: "auto",
    instructions: "Using Claude Max — credentials loaded from credentials file.",
  });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({
    action: "start",
    id: "anthropic",
  });
  assert.equal(result.action, "start");
  assert.equal(result.shape, "claude-login");
  assert.ok(typeof result.sessionKey === "string" && result.sessionKey.length > 0,
    `expected a non-empty sessionKey; got ${JSON.stringify(result)}`);
  assert.ok(result.sessionKey.startsWith("claude-login-"),
    `sessionKey should carry the claude-login- prefix for debugging; got ${result.sessionKey}`);
  assert.equal(typeof result.startedAt, "number");
  assert.equal(typeof result.cwd, "string");
});

test("opencode:provider-auth start returns claude-login when authorize FAILS on a fresh box (BET-610)", async () => {
  // THE fresh-box bug. A box that has never run `claude` has no
  // ~/.claude/.credentials.json, so the opencode-claude-auth plugin's
  // authorize() throws (it indexes accounts[0] on an empty list) and
  // startProviderOauth comes back not-ok.
  //
  // The handler used to return shape:"api-key" here — a catch-22, because
  // claude-login is the flow that RUNS `claude auth login` to create those
  // very credentials. Every fresh box was therefore asked for an API key and
  // could never connect a subscription at all.
  //
  // The authorize failure must NOT decide the shape: describeConnectShape is
  // asked with a null response and still yields claude-login for anthropic.
  const { deps } = makeDeps([]);
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: {
      anthropic: [{ type: "oauth", label: "Switch Claude Code account" }],
    },
  });
  deps.oc.startProviderOauth = async () => ({
    ok: false,
    error: "Cannot read properties of undefined (reading 'source')",
  });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({
    action: "start",
    id: "anthropic",
  });
  assert.equal(result.shape, "claude-login",
    `a fresh box must still get the Claude login terminal, not the API-key form; got ${JSON.stringify(result)}`);
  assert.ok(typeof result.sessionKey === "string" && result.sessionKey.length > 0,
    "claude-login must still stamp a sessionKey when authorize failed");
});

test("opencode:provider-auth start still falls back to api-key when authorize fails for a NON-claude provider (BET-610)", async () => {
  // The counterpart: the relaxation above is anthropic-only. A provider whose
  // shape is not claude-login and whose authorize failed genuinely has no
  // OAuth to offer, so the key form remains correct.
  const { deps } = makeDeps([]);
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: { openai: [{ type: "oauth", label: "ChatGPT headless" }] },
  });
  deps.oc.startProviderOauth = async () => ({ ok: false, error: "boom" });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({
    action: "start",
    id: "openai",
  });
  assert.equal(result.shape, "api-key");
});

test("opencode:provider-auth start keeps oauth-auto for non-anthropic with empty url (BET-354)", async () => {
  // Belt-and-braces: an "empty url" response from opencode for a
  // non-anthropic provider is NOT the Claude-specific path — we fall
  // through to the regular oauth-auto shape. Use openai (which has
  // prefer rules for "headless" / "chatgpt", not the empty-URL Claude
  // special case) with an oauth method that DOES match openai's prefer
  // rule so resolveAuthMethod returns a non-null result and we
  // actually exercise describeConnectShape's branch.
  const { deps } = makeDeps([]);
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: {
      openai: [
        { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
      ],
    },
  });
  deps.oc.startProviderOauth = async () => ({
    ok: true,
    url: "",
    method: "auto",
  });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({
    action: "start",
    id: "openai",
  });
  assert.equal(result.action, "start");
  assert.equal(result.shape, "oauth-auto");
  assert.equal(result.sessionKey, undefined, "non-claude providers must NOT get a sessionKey");
});

test("claude:login-cancel removes the session from the registry (BET-354)", async () => {
  const { deps } = makeDeps([]);
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: { anthropic: [{ type: "oauth", label: "Switch Claude Code account" }] },
  });
  deps.oc.startProviderOauth = async () => ({ ok: true, url: "", method: "auto" });
  const handlers = buildHandlers(deps);
  const start = await handlers["opencode:provider-auth"]({ action: "start", id: "anthropic" });
  assert.equal(start.shape, "claude-login");
  const sessionKey = start.sessionKey;

  // Cancel it.
  const cancelResult = await handlers["claude:login-cancel"](sessionKey);
  assert.equal(cancelResult.ok, true);

  // A subsequent claude-status for the same sessionKey must return
  // unknown_session (the metadata was dropped, so the registry has no
  // record).
  deps.oc.getProviders = async () => ({ connected: [] });
  const status = await handlers["opencode:provider-auth"]({
    action: "claude-status",
    sessionKey,
    startedAt: start.startedAt,
  });
  assert.equal(status.ok, false);
  assert.equal(status.error, "unknown_session");
});

// ---- BET-357 §3 (BET-366): regression guard on the `server:update-apply` -----
//
// IPC channel routing. The issue's test bullet requires a fake-spawn test
// asserting the desktop's "Upgrade box" button fires a chain that ends up
// invoking the box's self-update. Two pieces:
//
//   1. `runServerSelfUpdate(SELF_UPDATE_SCRIPT)` spawns the script. This
//      is covered directly in opencodeAdmin.test.mjs — the function takes
//      the script path and spawns it detached + unref'd.
//
//   2. The `server:update-apply` IPC channel in rpc.mjs calls (1) with
//      SELF_UPDATE_SCRIPT. Nothing in (1)'s tests covers this — a typo
//      in the channel body, a rename of the constant, or a wrong path
//      would slip past opencodeAdmin.test.mjs entirely because that
//      suite never imports the RPC dispatcher.
//
// This test is the regression guard for (2). The IPC layer is what the
// renderer's UpdateBar hits; if it stops invoking the self-update path,
// the renderer's "Upgrade box" button is a silent no-op. The test stubs
// `runServerSelfUpdate` via the new buildHandlers dep so the spawn
// never actually fires — and asserts both the script path argument
// (matched against the exported SELF_UPDATE_SCRIPT constant) AND the
// return-value pass-through so a future refactor that breaks either
// edge of the channel surfaces here.

test("server:update-apply routes to runServerSelfUpdate with SELF_UPDATE_SCRIPT and returns its result", async () => {
  const { deps } = makeDeps([]);
  const spawnCalls = [];
  deps.runServerSelfUpdate = async (scriptPath) => {
    spawnCalls.push(scriptPath);
    return { ok: true, pid: 9999 };
  };
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-apply"]();
  // Exactly one call, with the production script path constant. A typo
  // in the channel body, a wrong path argument, or an accidental
  // second call all break here.
  assert.equal(spawnCalls.length, 1, "runServerSelfUpdate invoked exactly once");
  assert.equal(
    spawnCalls[0],
    SELF_UPDATE_SCRIPT,
    "channel passes the production SELF_UPDATE_SCRIPT — not a typo'd path",
  );
  // The channel returns whatever the spawn returns, so the renderer's
  // `serverUpdateApply` IPC promise can await it. Today the UpdateBar
  // is fire-and-forget, but the contract is "promise resolves to the
  // spawn's verdict" — pin it so a future wrapper that drops the
  // return value fails here.
  assert.deepEqual(result, { ok: true, pid: 9999 });
});

test("server:update-apply propagates runServerSelfUpdate's failure result through the RPC", async () => {
  // Defense-in-depth: when the spawn throws (script missing, no exec
  // bit, EACCES), the channel must surface that to the caller as
  // `{ ok: false, error }` — NOT as a thrown promise. A thrown
  // promise would crash the RPC dispatcher (handleRpcRequest catches
  // and returns 500), which the renderer treats as a transport error
  // and never reaches the user-visible "couldn't upgrade" state.
  const { deps } = makeDeps([]);
  deps.runServerSelfUpdate = async () => ({
    ok: false,
    error: "spawn /abs/scripts/self-update.sh EACCES",
  });
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-apply"]();
  assert.deepEqual(result, {
    ok: false,
    error: "spawn /abs/scripts/self-update.sh EACCES",
  });
});

// ===== /rpc response compression (mobile session-load perf) =====

/** Minimal fake req/res pair for handleRpcRequest. */
function fakeExchange({ acceptEncoding } = {}) {
  const listeners = {};
  const req = {
    headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
    on(ev, fn) {
      listeners[ev] = fn;
      return req;
    },
    _fire(ev, arg) {
      return listeners[ev]?.(arg);
    },
  };
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(buf) {
      this.body = buf;
    },
  };
  return { req, res };
}

test("acceptsGzip only matches a real gzip token", () => {
  assert.equal(acceptsGzip("gzip"), true);
  assert.equal(acceptsGzip("gzip, deflate, br"), true);
  assert.equal(acceptsGzip("deflate, gzip"), true);
  assert.equal(acceptsGzip("br, deflate"), false);
  assert.equal(acceptsGzip("xgzip"), false, "must not match a token it is only a suffix of");
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(""), false);
});

test("a large /rpc response is gzipped when the client accepts it", async () => {
  // A transcript is highly repetitive JSON; sending it raw over a phone's
  // connection was most of the wait to open a session.
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: "repetitive payload" })) };
  const handlers = { "x:big": () => big };
  const { req, res } = fakeExchange({ acceptEncoding: "gzip, deflate" });
  const done = handleRpcRequest(handlers, "x:big", req, res);
  req._fire("data", JSON.stringify({ args: [] }));
  await req._fire("end");
  await done;

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-encoding"], "gzip");
  assert.equal(res.headers["vary"], "accept-encoding");
  const raw = Buffer.from(JSON.stringify({ result: big }), "utf8");
  assert.ok(res.body.length < raw.length / 2, "gzip must actually shrink a repetitive payload");
  assert.deepEqual(JSON.parse(gunzipSync(res.body).toString("utf8")), { result: big });
});

test("a /rpc response is sent raw without a gzip Accept-Encoding, and when small", async () => {
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: "repetitive payload" })) };

  // No Accept-Encoding → raw, whatever the size.
  {
    const { req, res } = fakeExchange();
    const done = handleRpcRequest({ "x:big": () => big }, "x:big", req, res);
    req._fire("data", JSON.stringify({ args: [] }));
    await req._fire("end");
    await done;
    assert.equal(res.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { result: big });
  }

  // Under the threshold → raw even though gzip is offered (the header bytes
  // and the CPU cost outweigh the saving on a small body).
  {
    const { req, res } = fakeExchange({ acceptEncoding: "gzip" });
    const done = handleRpcRequest({ "x:small": () => ({ ok: true }) }, "x:small", req, res);
    req._fire("data", JSON.stringify({ args: [] }));
    await req._fire("end");
    await done;
    assert.ok(res.body.length < GZIP_MIN_BYTES);
    assert.equal(res.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), { result: { ok: true } });
  }
});

test("serve-page:list exposes the published-page registry (read-only)", async () => {
  // Seed the sandboxed store directly so the handler reads real entries.
  const storePath = statePath("serve-page.json");
  await savePages(
    [
      { subdomain: "preview", expiresAt: null, createdAt: 1700000000000, sessionID: "ses_1" },
      { subdomain: "hero", expiresAt: 1700003600000, createdAt: 1700000001000, sessionID: null },
    ],
    storePath,
  );
  const { deps } = makeDeps([]);
  const handlers = buildHandlers(deps);
  const pages = await handlers["serve-page:list"]();
  assert.equal(pages.length, 2);
  assert.equal(pages[0].subdomain, "preview");
  assert.equal(pages[0].sessionID, "ses_1");
  assert.equal(pages[0].expiresAt, null);
  assert.equal(pages[1].subdomain, "hero");
  assert.equal(pages[1].sessionID, null);
  assert.equal(pages[1].expiresAt, 1700003600000);
  assert.ok(pages.every((p) => typeof p.url === "string" && typeof p.createdAt === "number"));
});

test("serve-page:list returns an empty list when the store is empty", async () => {
  await savePages([], statePath("serve-page.json"));
  const { deps } = makeDeps([]);
  const handlers = buildHandlers(deps);
  const pages = await handlers["serve-page:list"]();
  assert.deepEqual(pages, []);
});

// BET-685: sync:snapshot must carry the same first-tick guard as tmux:list.
// A box that just booted (`everSucceeded() === false`) must do a synchronous
// refresh before serving its snapshot, so the renderer's boot load never
// receives a confident zero-project snapshot.
function makeSnapshotDeps({ everSucceeded, refreshNow }) {
  const calls = { refreshNow: 0 };
  const base = makeDeps([]);
  base.deps.syncState = {
    refreshNow: async () => {
      calls.refreshNow += 1;
      if (refreshNow) await refreshNow();
    },
    applyConfig: () => {},
    snapshot: () => ({ projects: [], config: null, stale: false }),
    payloadSince: () => ({ gen: "g", seq: 0, changed: [] }),
    everSucceeded: () => everSucceeded,
  };
  return { deps: base.deps, calls };
}

test("sync:snapshot triggers a synchronous refresh when never succeeded", async () => {
  const { deps, calls } = makeSnapshotDeps({ everSucceeded: false });
  const handlers = buildHandlers(deps);
  await handlers["sync:snapshot"]({});
  assert.equal(calls.refreshNow, 1);
});

test("sync:snapshot serves from memory (no refresh) once a tick has succeeded", async () => {
  const { deps, calls } = makeSnapshotDeps({ everSucceeded: true });
  const handlers = buildHandlers(deps);
  const out = await handlers["sync:snapshot"]({ sinceSeq: 1, sinceGen: "g" });
  assert.equal(calls.refreshNow, 0);
  assert.deepEqual(out.changed, []);
});

// BET-681: tmux:select-window must publish its materialized-state delta
// immediately (mirrors the create/kill/rename handlers from BET-675). The
// switch changes which window is `active` in the projects payload, so the
// sync delta should fire now instead of at the next 2s poller tick.
test("tmux:select-window triggers exactly one syncState.refreshNow", async () => {
  const { deps, calls } = makeSnapshotDeps({ everSucceeded: true });
  deps.tmux.selectWindow = async (i) => ({ selected: i });
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:select-window"]({ sessionName: "s", windowIndex: 2 });
  assert.equal(calls.refreshNow, 1);
  assert.deepEqual(out, { selected: { sessionName: "s", windowIndex: 2 } });
});
