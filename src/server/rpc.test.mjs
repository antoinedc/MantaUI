import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatch,
  buildHandlers,
  handleRpcRequest,
  acceptsGzip,
  GZIP_MIN_BYTES,
  SELF_UPDATE_SCRIPT,
  _getOauthCallbacks,
  _resetOauthCallbacks,
} from "./rpc.mjs";
import { gunzipSync } from "node:zlib";
import { rm } from "node:fs/promises";
import { savePages } from "./servePage.mjs";
import { snapshotFrom, saveTopology, planRestore, TOPOLOGY_PATH } from "./topology.mjs";
import { statePath } from "../shared/paths.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeContextBreakdown,
} from "../shared/streamInterpretation.mjs";

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
        // BET-1043: default no-op for the detached oauth-auto callback so
        // oauth-auto tests that don't care about it just settle cleanly.
        // Tests that assert the callback behaviour override this.
        completeProviderOauth: async () => ({ ok: true }),
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

test("opencode:provider-auth status reports connected from the AUTH STORE, not /provider (BET-1319)", async () => {
  const { deps } = makeDeps([]);
  // GET /provider still (incorrectly) reports openai as connected until a
  // restart — that is exactly the stale-cache bug. The status branch must
  // read opencode's auth store instead.
  deps.oc.getProviders = async () => ({ connected: ["anthropic", "openai"] });
  deps.oc.readAuthedProviderIds = async () => ["anthropic"];
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({ action: "status" });
  assert.equal(result.action, "status");
  assert.ok(Array.isArray(result.providers));
  // anthropic is in the auth store → connected. openai is in /provider but
  // NOT in the auth store (a completed DELETE /auth/openai) → disconnected.
  const byId = Object.fromEntries(result.providers.map((p) => [p.id, p.connected]));
  assert.equal(byId.anthropic, true);
  assert.equal(byId.openai, false);
  assert.equal(byId["kimi-for-coding"], false);
});

test("opencode:provider-auth status rejects with the upstream error (no try/catch in handler)", async () => {
  const { deps } = makeDeps([]);
  deps.oc.readAuthedProviderIds = async () => { throw new Error("upstream gone"); };
  const handlers = buildHandlers(deps);
  // The status branch awaits `oc.readAuthedProviderIds()` directly (no
  // try/catch in the handler) — a thrown upstream surfaces as a rejected
  // promise that the renderer's typed result would treat as an error. Pin
  // the current behavior so a future "wrap with try/catch" change is a
  // conscious one.
  await assert.rejects(
    () => handlers["opencode:provider-auth"]({ action: "status" }),
    /upstream gone/,
  );
});

// ---- BET-1319: opencode:provider-auth `disconnect` finishes the job -------
//
// A DELETE /auth/{id} removes the credential from opencode's auth store, but
// opencode keeps the provider loaded in-process (its models still appear in
// the picker) until a restart. The disconnect branch must bounce opencode and
// never report success while it still holds the credential. restartOpencode is
// injected via buildHandlers deps so no systemd unit is touched here.

// Shared disconnect wiring (BET-1459): stub the credential delete with the
// given result, count opencode restarts, and run the disconnect once.
async function runDisconnect(removeResult) {
  const { deps } = makeDeps([]);
  let restarts = 0;
  deps.oc.removeProviderAuth = async () => removeResult;
  deps.restartOpencode = async () => { restarts += 1; return { ok: true }; };
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({ action: "disconnect", id: "openai" });
  return { result, restartCount: () => restarts };
}

test("opencode:provider-auth disconnect restarts opencode exactly once on success (BET-1319)", async () => {
  const { result, restartCount } = await runDisconnect({ ok: true });
  assert.equal(result.action, "disconnect");
  assert.equal(result.ok, true);
  assert.equal(restartCount(), 1, "restart called exactly once on a successful delete");
});

test("opencode:provider-auth disconnect does NOT restart when the delete failed (BET-1319)", async () => {
  const { result, restartCount } = await runDisconnect({ ok: false, error: "upstream rejected" });
  assert.equal(result.action, "disconnect");
  assert.equal(result.ok, false);
  assert.equal(result.error, "upstream rejected");
  assert.equal(restartCount(), 0, "no restart when the delete did not succeed");
});

test("opencode:provider-auth disconnect returns ok:false when the restart fails (BET-1319)", async () => {
  const { deps } = makeDeps([]);
  deps.oc.removeProviderAuth = async () => ({ ok: true });
  deps.restartOpencode = async () => ({ ok: false, error: "unit restart failed" });
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({ action: "disconnect", id: "openai" });
  // Success must NEVER be reported while opencode still holds the credential.
  assert.equal(result.action, "disconnect");
  assert.equal(result.ok, false);
  assert.equal(result.error, "unit restart failed");
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

test("server:update-check routes to the injected checkServerUpdate and returns its verdict", async () => {
  // The channel behind Settings → About's "Check for updates" button. It must
  // hand back the poller's verdict verbatim — including `available:false`,
  // which is a real answer ("up to date"), not an absence of one. A wrapper
  // that dropped the return value would leave the button unable to distinguish
  // "checked, nothing new" from "check failed".
  const { deps } = makeDeps([]);
  let calls = 0;
  deps.checkServerUpdate = async () => {
    calls += 1;
    return { available: true, version: "9.9.9", notesUrl: "https://mantaui.com/releases" };
  };
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-check"]();
  assert.equal(calls, 1, "checkServerUpdate invoked exactly once");
  assert.deepEqual(result, {
    available: true,
    version: "9.9.9",
    notesUrl: "https://mantaui.com/releases",
  });
});

test("server:update-check defaults to 'no update' when the dep is not wired", async () => {
  // buildHandlers is constructed BEFORE the update poller is started in
  // src/server/index.mjs, so the dep is a late-bound thunk. If a future reorder
  // ever left it unset, a check must report "nothing available" rather than
  // throwing at the renderer — a dead spinner is worse than a boring answer.
  const { deps } = makeDeps([]);
  delete deps.checkServerUpdate;
  const handlers = buildHandlers(deps);
  assert.deepEqual(await handlers["server:update-check"](), { available: false });
});

test("server:update-check attaches CLI `targets` from the cliDetector", async () => {
  // BET-1096 stage 2: the box-update check gains the box-side CLI targets so
  // the renderer can assemble ONE UpdateTarget list without a second call.
  const { deps } = makeDeps([]);
  deps.checkServerUpdate = async () => ({ available: false });
  deps.cliDetector = {
    detect: async () => [
      { id: "opencode", label: "opencode", current: "1.0.0", latest: "1.1.0", available: true, ok: true, manual: false, disruption: "ends-turns" },
    ],
  };
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-check"]();
  assert.equal(result.available, false);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].id, "opencode");
});

test("server:update-check swallows a throwing cliDetector and keeps the box verdict", async () => {
  // A CLI probe must NEVER break the box-update check. Detection throwing or
  // timing out → the payload comes back WITHOUT `targets`, box verdict intact.
  const { deps } = makeDeps([]);
  deps.checkServerUpdate = async () => ({ available: true, version: "9.9.9" });
  deps.cliDetector = { detect: async () => { throw new Error("probe exploded"); } };
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-check"]();
  assert.deepEqual(result, { available: true, version: "9.9.9" });
});

test("server:update-check swallows a timing-out cliDetector and keeps the box verdict", async () => {
  // The handler bounds the probe with a hard timeout. A probe that never
  // resolves (wedged network fetch) must not hang the click — it is dropped.
  const { deps } = makeDeps([]);
  deps.checkServerUpdate = async () => ({ available: false });
  deps.cliDetector = { detect: () => new Promise(() => {}) }; // never resolves
  deps.cliProbeTimeoutMs = 20; // tiny bound for the test
  const handlers = buildHandlers(deps);
  const result = await handlers["server:update-check"]();
  assert.deepEqual(result, { available: false });
});

test("server:update-check works with no cliDetector wired (older box)", async () => {
  // buildHandlers must not require the dep: a non-wired detector is the same
  // shape as an older box with no CLI probe — desktop + server only.
  const { deps } = makeDeps([]);
  deps.checkServerUpdate = async () => ({ available: false });
  const handlers = buildHandlers(deps);
  assert.deepEqual(await handlers["server:update-check"](), { available: false });
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

// ---- BET-1162: `server:cli-update` routing (per-row single-CLI upgrade) ----

test("server:cli-update routes to the injected upgradeCli with the passed cliId and returns its result", async () => {
  // The per-row action behind the renderer's per-row split (BET-1159). The
  // channel must hand the catalog id to the injected upgradeCli and return its
  // verdict verbatim — a typo in `ctx.cliId` or a dropped return value would
  // silently break the per-row update button.
  const { deps } = makeDeps([]);
  const cliIds = [];
  deps.upgradeCli = async (cliId) => {
    cliIds.push(cliId);
    return { ok: true, before: "1.0.0", after: "2.0.0", changed: true };
  };
  const handlers = buildHandlers(deps);
  const result = await handlers["server:cli-update"]({ cliId: "claude" });
  assert.deepEqual(cliIds, ["claude"], "cliId passed through verbatim");
  assert.deepEqual(result, { ok: true, before: "1.0.0", after: "2.0.0", changed: true });
});

test("server:cli-update: unknown/blank cliId handled without throwing", async () => {
  // Blank/absent cliId must resolve a clean `{ok:false, error:"no upgrade
  // path"}` result rather than throwing — a throw would crash the RPC
  // dispatcher into a 500 the renderer can't act on. The injected upgradeCli
  // must NOT be called (there is nothing to upgrade).
  const { deps } = makeDeps([]);
  const cliIds = [];
  deps.upgradeCli = async (cliId) => {
    cliIds.push(cliId);
    return { ok: true };
  };
  const handlers = buildHandlers(deps);
  for (const ctx of [{}, { cliId: "" }, { cliId: 42 }, null]) {
    const result = await handlers["server:cli-update"](ctx);
    assert.deepEqual(result, { ok: false, error: "no upgrade path" });
  }
  assert.equal(cliIds.length, 0, "upgradeCli must not be called for blank/unknown cliId");
});

test("server:cli-update: resolves 'no upgrade path' when the dep is not wired", async () => {
  // Older box / not-yet-wired upgradeCli → the per-row button degrades to the
  // same clean "no upgrade path" result, never a rejected promise.
  const { deps } = makeDeps([]);
  const handlers = buildHandlers(deps);
  const result = await handlers["server:cli-update"]({ cliId: "claude" });
  assert.deepEqual(result, { ok: false, error: "no upgrade path" });
});

test("server:cli-update: invalidates the cliDetector cache on a SUCCESSFUL upgrade", async () => {
  // The whole point of the unified-update flow (BET-1162): after a per-row CLI
  // upgrade succeeds, the shared detector's 5-min cache must be dropped so the
  // next server:update-check reflects the new version immediately — otherwise
  // the UI's "has an update available" lingers for the TTL. A failed upgrade
  // must NOT invalidate (the old state is still accurate).
  const { deps } = makeDeps([]);
  let invalidated = 0;
  deps.upgradeCli = async () => ({ ok: true, before: "1.0.0", after: "2.0.0", changed: true });
  deps.cliDetector = { detect: async () => [], invalidate: () => { invalidated += 1; } };
  const handlers = buildHandlers(deps);

  const ok = await handlers["server:cli-update"]({ cliId: "claude" });
  assert.equal(ok.ok, true);
  assert.equal(invalidated, 1, "successful upgrade must invalidate the detector cache");
});

test("server:cli-update: does NOT invalidate the cache when the upgrade fails", async () => {
  const { deps } = makeDeps([]);
  let invalidated = 0;
  deps.upgradeCli = async () => ({ ok: false, error: "claude update exited with code 1" });
  deps.cliDetector = { detect: async () => [], invalidate: () => { invalidated += 1; } };
  const handlers = buildHandlers(deps);

  const res = await handlers["server:cli-update"]({ cliId: "claude" });
  assert.equal(res.ok, false);
  assert.equal(invalidated, 0, "failed upgrade must NOT invalidate the cache");
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

// BET-795: the work inbox's "Delegate in background" must route through the
// existing delegate engine (spec §3), not a foreground session.
test("delegate:start routes the inbox delegation through the delegate engine + clear no-engine fallback", async () => {
  let startCalled = null;
  const { deps } = makeDeps([]);
  deps.delegate = {
    startJob: async (input) => {
      startCalled = input;
      return { ok: true, job: { id: "jid" } };
    },
  };
  const handlers = buildHandlers(deps);
  const res = await handlers["delegate:start"]({
    prompt: "Complete u",
    sessionID: "ses_active",
    directory: "/repo",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(startCalled, {
    prompt: "Complete u",
    model: undefined,
    parentSessionID: "ses_active",
    parentDirectory: "/repo",
  });

  const noEngine = await buildHandlers(makeDeps([]).deps)["delegate:start"]({
    prompt: "x",
    sessionID: "s",
    directory: "/",
  });
  assert.equal(noEngine.ok, false);
  assert.equal(noEngine.error, "no engine");
});

test("forge:ship returns the forge result unchanged and performs no config write", async () => {
  // BET-870: forge:ship no longer carries an onPrOpened handler, so opening a
  // PR can never write to the config store from the forge:ship path. Feed it a
  // cwd with no forge; the ship must fail fast with no_forge (the forge
  // result, returned unchanged) and record zero project-meta writes.
  const { deps, calls } = makeDeps([]);
  const handlers = buildHandlers(deps);
  const cwd = mkdtempSync(join(tmpdir(), "bet870-noforge-"));
  const res = await handlers["forge:ship"]({ cwd });
  assert.deepEqual(res, { ok: false, error: "no_forge" });
  assert.equal(calls.projectMetaUpsert.length, 0);
});

test("opencode:context derives a breakdown from a billed assistant message", async () => {
  const tokens = { input: 50_000, cache: { read: 10_000, write: 0 } };
  const listCalls = [];
  const deps = makeDeps([]).deps;
  deps.oc.listMessages = async (sessionId, opts) => {
    assert.equal(sessionId, "ses_idle");
    listCalls.push(opts);
    return [{ info: { role: "assistant", tokens, providerID: "anthropic", modelID: "claude-sonnet-4-6" } }];
  };
  const handlers = buildHandlers({ ...deps, contextLimitFor: () => 400_000 });
  const res = await handlers["opencode:context"]("ses_idle");
  assert.deepEqual(listCalls, [{ slim: true }]);
  assert.deepEqual(res, computeContextBreakdown(tokens, 400_000));
  assert.equal(res.hasLimit, true);
});

test("opencode:context uses contextLimitFor; unknown limit yields hasLimit:false", async () => {
  const tokens = { input: 100_000, cache: { read: 0, write: 0 } };
  const deps = makeDeps([]).deps;
  deps.oc.listMessages = async () => [
    { info: { role: "assistant", tokens, providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
  ];

  const withLimit = buildHandlers({
    ...deps,
    contextLimitFor: () => 400_000,
  });
  const limited = await withLimit["opencode:context"]("s");
  assert.deepEqual(limited, computeContextBreakdown(tokens, 400_000));
  assert.equal(limited.hasLimit, true);

  const unknown = buildHandlers({
    ...deps,
    contextLimitFor: () => null,
  });
  const noLimit = await unknown["opencode:context"]("s");
  assert.deepEqual(noLimit, computeContextBreakdown(tokens, null));
  assert.equal(noLimit.hasLimit, false);
  assert.equal(noLimit.pct, null);
});

test("opencode:context returns null for an empty transcript", async () => {
  const deps = makeDeps([]).deps;
  deps.oc.listMessages = async () => [];
  const handlers = buildHandlers(deps);
  const res = await handlers["opencode:context"]("ses_empty");
  assert.equal(res, null);
});

// ---- BET-1043: oauth-auto detached callback + oauth-status ----
//
// The oauth-auto (Codex headless) callback BLOCKS until the user approves on
// the device page, so the rpc `start` branch fires it DETACHED with an empty
// code and the renderer polls its outcome via `oauth-status` instead of
// watching `connected[]`.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Shared setup: openai resolves to the headless oauth method → oauth-auto
// shape. The caller overrides `completeProviderOauth` as needed.
function setupOauthAutoDeps(deps) {
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: { openai: [{ type: "oauth", label: "ChatGPT headless" }] },
  });
  deps.oc.startProviderOauth = async () => ({
    ok: true,
    url: "https://auth.openai.com/codex/device",
    method: "auto",
  });
}

test("opencode:provider-auth start fires the oauth-auto callback detached with empty code and returns immediately (BET-1043)", async () => {
  const { deps } = makeDeps([]);
  setupOauthAutoDeps(deps);
  const calls = [];
  // Never settles — the handler must STILL resolve with the oauth-auto shape
  // without waiting on the blocking callback.
  deps.oc.completeProviderOauth = (id, index, code) => {
    calls.push({ id, index, code });
    return new Promise(() => {});
  };
  _resetOauthCallbacks();
  const handlers = buildHandlers(deps);
  const result = await handlers["opencode:provider-auth"]({ action: "start", id: "openai" });
  assert.equal(result.action, "start");
  assert.equal(result.shape, "oauth-auto");
  assert.equal(result.methodIndex, 0);
  assert.deepEqual(calls, [{ id: "openai", index: 0, code: "" }],
    "must call completeProviderOauth exactly once, with the RESOLVED index and empty code");
});

// Shared setup for the oauth-status polls (BET-1459): fire the detached
// callback against a never-settling gate, then hand the caller the gate (to
// resolve per scenario) plus the built handlers — the start call is already
// in flight when the helper returns.
async function startGatedOauth() {
  const gate = deferred();
  const { deps } = makeDeps([]);
  setupOauthAutoDeps(deps);
  deps.oc.completeProviderOauth = () => gate.promise;
  _resetOauthCallbacks();
  const handlers = buildHandlers(deps);
  await handlers["opencode:provider-auth"]({ action: "start", id: "openai" });
  return { gate, handlers };
}

test("opencode:provider-auth oauth-status reports pending then ok, then clears (BET-1043)", async () => {
  const { gate, handlers } = await startGatedOauth();

  // In flight → pending.
  const pending = await handlers["opencode:provider-auth"]({ action: "oauth-status", id: "openai" });
  assert.deepEqual(pending, { action: "oauth-status", state: "pending" });

  // Approve → next poll reports ok.
  gate.resolve({ ok: true });
  await gate.promise;
  const ok = await handlers["opencode:provider-auth"]({ action: "oauth-status", id: "openai" });
  assert.deepEqual(ok, { action: "oauth-status", state: "ok" });

  // Terminal state clears the entry → a later poll is not_started.
  const again = await handlers["opencode:provider-auth"]({ action: "oauth-status", id: "openai" });
  assert.deepEqual(again, { action: "oauth-status", state: "error", error: "not_started" });
});

test("opencode:provider-auth oauth-status surfaces a failed callback as error (BET-1043)", async () => {
  const { gate, handlers } = await startGatedOauth();
  gate.resolve({ ok: false, error: "bad_response" });
  await gate.promise;
  const r = await handlers["opencode:provider-auth"]({ action: "oauth-status", id: "openai" });
  assert.deepEqual(r, { action: "oauth-status", state: "error", error: "bad_response" });
});

test("opencode:provider-auth oauth-status for an unknown provider returns not_started (BET-1043)", async () => {
  const { deps } = makeDeps([]);
  _resetOauthCallbacks();
  const handlers = buildHandlers(deps);
  const r = await handlers["opencode:provider-auth"]({ action: "oauth-status", id: "openai" });
  assert.deepEqual(r, { action: "oauth-status", state: "error", error: "not_started" });
});

test("opencode:provider-auth start does NOT fire the detached callback for claude-login or api-key providers (BET-1043)", async () => {
  const { deps } = makeDeps([]);
  deps.oc.listProviderAuthMethods = async () => ({
    ok: true,
    methods: {
      // anthropic (claude-login via empty URL) and kimi (no methods → api-key)
      anthropic: [{ type: "oauth", label: "Switch Claude Code account" }],
      "kimi-for-coding": [],
    },
  });
  deps.oc.startProviderOauth = async () => ({ ok: true, url: "", method: "auto" });
  let called = 0;
  deps.oc.completeProviderOauth = async () => { called++; return { ok: true }; };
  _resetOauthCallbacks();
  const handlers = buildHandlers(deps);

  await handlers["opencode:provider-auth"]({ action: "start", id: "anthropic" });
  assert.equal(called, 0, "claude-login must NOT fire the callback");

  await handlers["opencode:provider-auth"]({ action: "start", id: "kimi-for-coding" });
  assert.equal(called, 0, "api-key (kimi) must NOT fire the callback");
});

// ---- BET-1244: routing:choose / accounts:retry channels ----

// Shared deps for the routing:choose tests (BET-1459): turning routing ON is
// one configGet override (preset + optional declaredModels); routable models
// and the health-state fn are the other per-test knobs. Omitting `preset`
// keeps the makeDeps default configGet ({ projects } only → routing off).
// Tests needing exotic stubs (throwing deps, recording wrappers) mutate the
// returned deps BEFORE buildHandlers, exactly as before. `catalogIndex` is
// folded into the returned deps object so callers can buildHandlers it
// directly.
function makeRoutingDeps({ preset, declaredModels, routableModels, healthState, catalogIndex } = {}) {
  const { deps } = makeDeps([]);
  if (preset !== undefined) {
    const modelRouting = { preset };
    if (declaredModels) modelRouting.declaredModels = declaredModels;
    deps.local.configGet = async () => ({ projects: [], modelRouting });
  }
  if (routableModels) deps.routingListRoutableModels = async () => routableModels;
  if (healthState) deps.routingProviderHealthState = healthState;
  return catalogIndex ? { ...deps, routingCatalogIndex: catalogIndex } : deps;
}

// The seven-field routing:choose envelope, with the defaults every test here
// repeats (ses_1 / /w / build / main / 0 tokens / no needs / the opus
// incumbent). Per-test knobs — surface, incumbent, overrides — override them.
function chooseRouting(handlers, { surface = "main", incumbent = { providerID: "anthropic", modelID: "claude-opus-4" }, overrides } = {}) {
  return handlers["routing:choose"]({
    sessionId: "ses_1",
    directory: "/w",
    agent: "build",
    surface,
    contextTokens: 0,
    needs: {},
    incumbent,
    ...(overrides && { overrides }),
  });
}

// A catalogue index so buildRoutingServices resolves identity + quality (the
// SAME seam the BET-1265 log test and the 6e Block regression use).
const routingFakeCatalog = (entries) => ({
  matchModel: (id) => ({ kind: "exact", candidates: [{ id, name: id }] }),
  lookupModel: (id) => ({ id }),
  allModels: () => entries,
});

// The sonnet fixture shared by the [router]-log test and the 6e Block
// regression: declared in config, priced in the catalogue, benchmarked at 0.8.
const SONNET_DECLARED = { "anthropic/claude-sonnet-4": { catalogId: "claude-sonnet-4" } };
const SONNET_ROUTABLE = [{
  providerID: "anthropic",
  id: "claude-sonnet-4",
  status: "active",
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
}];
const SONNET_CATALOG = [{ id: "claude-sonnet-4", benchmarks: [{ name: "SWE-Bench Verified", score: 0.8 }] }];

// The bare opus catalog row the incumbent-health tests route against.
const OPUS_ROUTABLE = [{ providerID: "anthropic", id: "claude-opus-4", status: "active" }];

// routing:choose is read-only and never throws. A policy with no routing
// directive (no preset / no perAgent) resolves to routing being unusable, and
// the decision returns the incumbent unchanged — never a hidden switch and
// never a throw.
test("routing:choose returns the incumbent unchanged when routing is not activated", async () => {
  // No preset → local.configGet returns { projects } only — no modelRouting →
  // routing off.
  const deps = makeRoutingDeps({
    routableModels: [{ providerID: "anthropic", id: "claude-sonnet-4", status: "active" }],
  });
  const handlers = buildHandlers(deps);
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  const out = await chooseRouting(handlers, { incumbent });
  assert.deepEqual(out.model, incumbent, "off-path keeps the incumbent");
  assert.equal(out.changed, false);
  assert.deepEqual(out.alternatives, []);
  assert.equal(out.reason, "routing not activated for this conversation");
});

// routing:choose must NEVER throw — even when every dependency rejects. It
// degrades to the incumbent unchanged rather than propagating the failure.
test("routing:choose never throws when its dependencies reject", async () => {
  const deps = makeRoutingDeps({});
  deps.local.configGet = async () => { throw new Error("config down"); };
  deps.routingListRoutableModels = async () => { throw new Error("catalogue down"); };
  const handlers = buildHandlers(deps);
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  // Must RESOLVE (not reject) with the incumbent unchanged, never a throw.
  const out = await chooseRouting(handlers, { incumbent });
  assert.deepEqual(out.model, incumbent);
  assert.equal(out.changed, false);
  assert.deepEqual(out.alternatives, []);
  assert.ok(typeof out.reason === "string" && out.reason.length > 0);
});

// routing:choose must be handed the FILTERED catalogue — listRoutableModels
// with the right surface — never a second filter and never raw listModels.
test("routing:choose is handed the filtered catalogue for the requested surface (not listModels)", async () => {
  // Config that ACTIVATES routing so the decision core actually runs against
  // the returned catalogue.
  const deps = makeRoutingDeps({ preset: "economy" });
  let surfaceSeen = null;
  let calls = 0;
  deps.routingListRoutableModels = async (surface) => {
    surfaceSeen = surface;
    calls++;
    return [
      { providerID: "anthropic", id: "claude-opus-4", status: "active" },
      { providerID: "anthropic", id: "claude-sonnet-4", status: "active" },
      { providerID: "anthropic", id: "claude-haiku-4", status: "active" },
    ];
  };
  const handlers = buildHandlers(deps);
  const out = await chooseRouting(handlers, { surface: "sub" });
  assert.equal(calls, 1);
  assert.equal(surfaceSeen, "sub", "listRoutableModels must be called with the requested surface");
  // A real decision was produced from the injected (filtered) catalogue — a
  // selected model normalised into {providerID, modelID}.
  assert.equal(out.model?.providerID, "anthropic");
  assert.ok(typeof out.model?.modelID === "string" && out.model.modelID.length > 0);
  assert.equal("id" in (out.model ?? {}), false, "the routed model carries modelID, not the catalog's id");
  assert.deepEqual(out.alternatives, out.alternatives.filter((a) => a && a.modelID), "alternatives are well-formed {providerID, modelID}");
});

// BET-1265: routing:choose emits exactly one `[router]` line (the box-side
// signal that routing ran) whenever an activated routing decision is made.
// Format: [router] <surface>/<agent> → <provider>/<model> · <basis> ·
// considered=<n> dropped=<n> mix=<measured|default>. Gated on nothing.
test("routing:choose logs exactly one well-formed [router] line on a routed decision", async () => {
  const deps = makeRoutingDeps({
    preset: "economy",
    declaredModels: SONNET_DECLARED,
    routableModels: SONNET_ROUTABLE,
    catalogIndex: routingFakeCatalog(SONNET_CATALOG),
  });
  const handlers = buildHandlers(deps);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await chooseRouting(handlers);
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1, "exactly one [router] line, no debug flag");
  // BET-1301: the decision line now carries the decision's INPUTS — the real
  // conversation size (ctx=0, verbatim — a caller bug stays visible) and what
  // the turn needed (needs=none) — alongside its outputs. Deterministic for
  // this injected catalogue: a real winner (sonnet, no account → cost basis
  // "unknown"), zero drops, mix=default (no measured ledger mix on today's
  // wiring — the evidence BET-1265 exists to surface).
  assert.ok(
    lines[0].startsWith(
      "[router] main/build → anthropic/claude-sonnet-4 · ctx=0 needs=none · considered=1 dropped=0 · unknown mix=default ·",
    ),
    `expected the BET-1301 input-carrying format; got: ${lines[0]}`,
  );
  assert.ok(/ · [^·]+$/.test(lines[0]), "reason is present and the final field");
});

// BET-1270 6e: routing:choose reports the box's facts about the incumbent it
// was handed — `incumbentHealthy` (its provider not excluded/failing) and
// `incumbentStillEligible` (the same autoEligibility gate the router uses) — so
// the renderer's shouldSwitch can force an ineligible/unhealthy incumbent out
// on the SAME round trip, without holding health state of its own.
test("routing:choose reports incumbentHealthy=false when the incumbent's provider is failing (6e)", async () => {
  const deps = makeRoutingDeps({
    preset: "economy",
    routableModels: OPUS_ROUTABLE,
    healthState: (pid) => (pid === "anthropic" ? "failing" : null),
  });
  const handlers = buildHandlers(deps);
  const out = await chooseRouting(handlers);
  assert.equal(out.incumbentHealthy, false, "failing provider ⇒ incumbent unhealthy");
  assert.equal(
    typeof out.incumbentStillEligible,
    "boolean",
    "incumbentStillEligible is reported as a boolean",
  );
});

test("routing:choose reports incumbentHealthy=true for a healthy incumbent (6e)", async () => {
  const deps = makeRoutingDeps({
    preset: "economy",
    routableModels: OPUS_ROUTABLE,
    healthState: () => null, // provider healthy (absent state)
  });
  const handlers = buildHandlers(deps);
  const out = await chooseRouting(handlers);
  assert.equal(out.incumbentHealthy, true);
});

// 6e reviewer Block regression: incumbentStillEligible must be computed from the
// incumbent's FULL catalog endpoint (cost/capabilities/catalogue identity), not
// a price-less {providerID,id} stub — otherwise a perfectly describable incumbent
// reads ineligible and shouldSwitch force-switches every boundary-crossing turn.
test("routing:choose reports incumbentStillEligible=true for a describable incumbent (6e Block regression)", async () => {
  const handlers = buildHandlers(makeRoutingDeps({
    preset: "economy",
    declaredModels: SONNET_DECLARED,
    routableModels: SONNET_ROUTABLE,
    catalogIndex: routingFakeCatalog(SONNET_CATALOG),
  }));
  const out = await chooseRouting(handlers, { incumbent: { providerID: "anthropic", modelID: "claude-sonnet-4" } });
  assert.equal(out.incumbentStillEligible, true, "a describable incumbent must read eligible");
});

// BET-1276 12a: the dev-only overrides bag on routing:choose. When NODE_ENV is
// not "production" (the harness / local box), enabledMain restricts the
// candidate pool to the listed endpoint keys, and accounts/health replace their
// services keys for ONE call — read-only, side-effect-free.

test("routing:choose honours enabledMain by restricting the candidate pool (12a)", async () => {
  const handlers = buildHandlers(makeRoutingDeps({
    preset: "balanced",
    declaredModels: {
      "anthropic/claude-opus-4": { catalogId: "claude-opus-4" },
      "anthropic/claude-sonnet-4": { catalogId: "claude-sonnet-4" },
    },
    routableModels: [
      { providerID: "anthropic", id: "claude-opus-4", status: "active", cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 15 } },
      { providerID: "anthropic", id: "claude-sonnet-4", status: "active", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } },
    ],
    catalogIndex: routingFakeCatalog([
      { id: "claude-opus-4", benchmarks: [{ name: "SWE-Bench Verified", score: 0.95 }] },
      { id: "claude-sonnet-4", benchmarks: [{ name: "SWE-Bench Verified", score: 0.8 }] },
    ]),
  }));
  // Both are build-qualified (deep); unfiltered the higher-quality opus wins.
  // Restricting the pool to sonnet proves the decision saw ONLY sonnet.
  const out = await chooseRouting(handlers, { overrides: { enabledMain: ["anthropic/claude-sonnet-4"] } });
  assert.equal(out.changed, true, "switching off the restricted-out incumbent");
  assert.equal(out.model?.modelID, "claude-sonnet-4", "winner must come from the enabledMain pool");
});

// 12a: a health override replaces services.health for one call, so an
// excluded/failing provider reads unhealthy on the SAME round trip the decision
// core responds to the override.
test("routing:choose applies a health override to the incumbent-health report (12a)", async () => {
  const deps = makeRoutingDeps({
    preset: "economy",
    routableModels: OPUS_ROUTABLE,
    healthState: () => null, // real health: ok
  });
  const handlers = buildHandlers(deps);
  const out = await chooseRouting(handlers, { overrides: { health: { anthropic: "failing" } } });
  assert.equal(out.incumbentHealthy, false, "health override must flip the incumbent-health report");
});

// 12a gate: in production the overrides bag is IGNORED silently — a stale
// client reaching prod must not change a real turn. Neither the candidate pool
// nor the incumbent-health report may react to it.
test("routing:choose ignores the overrides bag when NODE_ENV is production (12a gate)", async () => {
  const handlers = buildHandlers(makeRoutingDeps({
    preset: "balanced",
    routableModels: [
      { providerID: "anthropic", id: "claude-opus-4", status: "active", cost: { input: 15, output: 75 } },
      { providerID: "anthropic", id: "claude-haiku-4", status: "active", cost: { input: 1, output: 5 } },
    ],
    catalogIndex: routingFakeCatalog([
      { id: "claude-opus-4", benchmarks: [{ name: "SWE-Bench Verified", score: 0.9 }] },
    ]),
  }));
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const out = await chooseRouting(handlers, {
      overrides: {
        enabledMain: ["anthropic/claude-haiku-4"],
        health: { anthropic: "failing" },
      },
    });
    // build wants deep → opus stays (the pool was NOT restricted to haiku).
    assert.equal(out.model?.modelID, "claude-opus-4", "overrides must be inert in production");
    assert.equal(out.incumbentHealthy, true, "health override must be inert in production");
  } finally {
    process.env.NODE_ENV = prev;
  }
});


// accounts:retry always reports an outcome — a non-empty message in BOTH the
// cleared and not-cleared cases (AGENTS.md: it does the thing and says so,
// or fails and says why; a swallowed bare return is a dead button).
test("accounts:retry returns a non-empty message in both cleared and not-cleared cases", async () => {
  const { deps } = makeDeps([]);
  deps.providerHealth = { retry: async () => ({ cleared: true, state: "working" }) };
  const handlers = buildHandlers(deps);

  const cleared = await handlers["accounts:retry"]({ providerID: "anthropic" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.state, "working");
  assert.ok(typeof cleared.message === "string" && cleared.message.length > 0, "cleared case needs a message");

  deps.providerHealth = { retry: async () => ({ cleared: false, state: "out_of_credit" }) };
  const handlers2 = buildHandlers(deps);
  const notCleared = await handlers2["accounts:retry"]({ providerID: "anthropic" });
  assert.equal(notCleared.ok, false);
  assert.equal(notCleared.state, "out_of_credit");
  assert.ok(typeof notCleared.message === "string" && notCleared.message.length > 0, "not-cleared case needs a message");
});

// ---- BET-1457: the two topology-restore rpc channels ------------------------
// The pure engine beneath them (planRestore / executeRestore / describeRestore)
// is fully covered in topology.test.mjs; what was untested is the CHANNEL GLUE:
// the no-snapshot shapes, the dead-tmux catch (a failed listing plans against
// an EMPTY live tree instead of throwing), the plan passthrough (preview must
// return exactly what planRestore plans — the same plan apply runs), the
// {ok:true, ...result, message} shape with its refreshNow() push, and
// restoreChatWindow's field adaptation (snapshot vocabulary → tmux vocabulary).

// The handlers read the snapshot from the DEFAULT path (TOPOLOGY_PATH), so the
// sandbox redirect (MANTA_STATE_HOME, set by scripts/testSandbox.mjs before
// any module loads) is what keeps these tests off the live box. Seed / clear
// that file per test — each node:test file is its own process with its own
// sandbox dir, so nothing else in the run can collide with it.
async function clearTopologyFile() {
  await rm(TOPOLOGY_PATH, { force: true });
}

async function seedTopologyFile(snapshot) {
  await saveTopology(snapshot);
}

// A saved tree (listProjects shape) with three chat windows chosen so each
// skip rule can fire through the glue: ses_live survives the known-id filter,
// ses_gone is dropped by it, and index 7 sits under a live TUI window.
const CAPTURED_AT = 1725000000000;
function savedTree() {
  return [{
    tmuxSession: "app",
    defaultCwd: "/srv/app",
    mantaOwned: true,
    windows: [
      { index: 2, name: "chat-a", opencodeSessionId: "ses_live", paneCurrentPath: "/srv/app", worktreePath: null, active: true },
      { index: 5, name: "chat-b", opencodeSessionId: "ses_gone", paneCurrentPath: "/srv/app/wt", worktreePath: "/srv/app/wt", active: false },
      { index: 7, name: "chat-c", opencodeSessionId: "ses_new", paneCurrentPath: "/srv/app", worktreePath: null, active: false },
    ],
  }];
}

// Minimal deps for the restore channels (mirrors makeDeps above, restricted to
// the namespaces the two handlers touch). `ocListSessions` mirrors the two
// production shapes of knownOpencodeSessionIds: a throw → null (filter OFF),
// a session list → a Set (filter ON).
function makeRestoreDeps({
  liveProjects = [],
  listProjectsError = null,
  ocListSessions = async () => { throw new Error("opencode unreachable"); },
} = {}) {
  const calls = { restoreChatWindow: [], refreshNow: 0 };
  return {
    calls,
    deps: {
      tmux: {
        listProjects: async () => {
          if (listProjectsError) throw listProjectsError;
          return liveProjects;
        },
        restoreChatWindow: async (op) => { calls.restoreChatWindow.push(op); },
      },
      oc: { listSessions: ocListSessions },
      pty: {},
      bus: {},
      syncState: {
        refreshNow: async () => { calls.refreshNow++; },
        applyConfig: () => {},
        snapshot: () => ({ projects: liveProjects }),
        payloadSince: (s, g) => ({ gen: g, seq: 0, changed: {} }),
        everSucceeded: () => true,
      },
      local: {
        configGet: async () => ({ projects: [] }),
        projectMetaUpsert: async () => ({}),
        projectMetaDelete: async () => ({}),
      },
      push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
    },
  };
}

test("tmux:restore-preview without a snapshot returns the unavailable shape", async () => {
  await clearTopologyFile();
  const { deps } = makeRestoreDeps();
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-preview"]();
  assert.deepEqual(out, { available: false, capturedAt: null, ops: [], skipped: [], restorable: 0 });
});

test("tmux:restore-preview returns exactly the planRestore plan (ops, skipped, restorable)", async () => {
  const snapshot = snapshotFrom(savedTree(), CAPTURED_AT);
  await seedTopologyFile(snapshot);
  const liveProjects = [{
    tmuxSession: "app",
    defaultCwd: "/srv/app",
    mantaOwned: true,
    windows: [
      { index: 7, name: "terminal", opencodeSessionId: null, paneCurrentPath: "/srv/app", worktreePath: null, active: false },
    ],
  }];
  const { deps } = makeRestoreDeps({
    liveProjects,
    ocListSessions: async () => [{ id: "ses_live" }, { id: "ses_new" }],
  });
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-preview"]();
  const expected = planRestore(snapshot, liveProjects, new Set(["ses_live", "ses_new"]));
  assert.equal(out.available, true);
  assert.equal(out.capturedAt, CAPTURED_AT);
  assert.deepEqual(out.ops, expected.ops);
  assert.deepEqual(out.skipped, expected.skipped);
  assert.equal(out.restorable, out.ops.length);
  // The skip reasons prove both glue-side filters ran: the gone-id drop comes
  // from knownOpencodeSessionIds, the occupied slot from the live tree.
  assert.deepEqual(out.skipped.map((s) => s.reason), ["opencode-session-gone", "index-occupied"]);
});

test("tmux:restore-preview plans against an empty live tree when tmux is dead", async () => {
  const snapshot = snapshotFrom(savedTree(), CAPTURED_AT);
  await seedTopologyFile(snapshot);
  const { deps } = makeRestoreDeps({
    listProjectsError: new Error("no server running on /tmp/tmux-1000/default"),
  });
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-preview"]();
  const expected = planRestore(snapshot, [], null);
  assert.equal(out.available, true);
  assert.deepEqual(out.ops, expected.ops);
  assert.deepEqual(out.skipped, expected.skipped);
  // Session "app" is not live → its first window must be a create-session op.
  assert.equal(out.ops[0].kind, "create-session");
  assert.equal(out.restorable, 3);
});

test("tmux:restore-topology plans against an empty live tree when tmux is dead", async () => {
  const snapshot = snapshotFrom(savedTree(), CAPTURED_AT);
  await seedTopologyFile(snapshot);
  const { deps, calls } = makeRestoreDeps({
    listProjectsError: new Error("no server running on /tmp/tmux-1000/default"),
  });
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-topology"]();
  // Same catch as the preview channel: the dead-box scenario must APPLY
  // (rebuild everything) rather than throw.
  assert.equal(out.ok, true);
  assert.equal(out.created, 3);
  assert.equal(out.failed, 0);
  // The rebuilt dead box: its first window needed create-session, the rest
  // landed as plain create-windows at their saved indices.
  assert.deepEqual(
    calls.restoreChatWindow.map((op) => op.createSession),
    [true, false, false],
  );
  assert.deepEqual(
    calls.restoreChatWindow.map((op) => op.windowIndex),
    [2, 5, 7],
  );
  assert.equal(calls.refreshNow, 1);
});

test("tmux:restore-topology without a snapshot returns the error shape and touches nothing", async () => {
  await clearTopologyFile();
  const { deps, calls } = makeRestoreDeps();
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-topology"]();
  assert.deepEqual(out, { ok: false, error: "No saved window layout to restore from.", created: 0, failed: 0 });
  assert.equal(calls.refreshNow, 0);
  assert.equal(calls.restoreChatWindow.length, 0);
});

test("tmux:restore-topology applies the plan, calls refreshNow and passes describeRestore's message through", async () => {
  const snapshot = snapshotFrom(savedTree(), CAPTURED_AT);
  await seedTopologyFile(snapshot);
  const { deps, calls } = makeRestoreDeps();
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-topology"]();
  assert.equal(out.ok, true);
  assert.equal(out.created, 3);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.failures, []);
  assert.deepEqual(out.windows, [
    { tmuxSession: "app", index: 2, name: "chat-a", opencodeSessionId: "ses_live" },
    { tmuxSession: "app", index: 5, name: "chat-b", opencodeSessionId: "ses_gone" },
    { tmuxSession: "app", index: 7, name: "chat-c", opencodeSessionId: "ses_new" },
  ]);
  assert.equal(out.message, "Restored 3 windows.");
  assert.equal(calls.refreshNow, 1);
  // Field adaptation: the first op (empty live tree → create-session) reaches
  // restoreChatWindow in tmux's vocabulary; mantaOwned + worktreePath ride
  // through from the snapshot.
  assert.deepEqual(calls.restoreChatWindow[0], {
    createSession: true,
    sessionName: "app",
    windowIndex: 2,
    windowName: "chat-a",
    cwd: "/srv/app",
    opencodeSessionId: "ses_live",
    worktreePath: null,
    mantaOwned: true,
  });
  assert.equal(calls.restoreChatWindow[1].createSession, false);
  assert.equal(calls.restoreChatWindow[1].worktreePath, "/srv/app/wt");
});

test("tmux:restore-topology stays ok:true past a per-window failure and reports it in the message", async () => {
  const snapshot = snapshotFrom(savedTree(), CAPTURED_AT);
  await seedTopologyFile(snapshot);
  const { deps, calls } = makeRestoreDeps();
  deps.tmux.restoreChatWindow = async (op) => {
    calls.restoreChatWindow.push(op);
    // restoreChatWindow receives the ADAPTED op (tmux vocabulary), so the
    // index arrives as windowIndex.
    if (op.windowIndex === 5) throw new Error("cwd vanished");
  };
  const handlers = buildHandlers(deps);
  const out = await handlers["tmux:restore-topology"]();
  assert.equal(out.ok, true);
  assert.equal(out.created, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.failures, [
    { tmuxSession: "app", index: 5, name: "chat-b", opencodeSessionId: "ses_gone", error: "cwd vanished" },
  ]);
  assert.equal(out.message, "Restored 2 windows · 1 failed.");
  assert.equal(calls.refreshNow, 1);
});
