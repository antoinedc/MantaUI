// Multi-account phase 3 wiring: the pieces that connect the accounts:* flows to
// the existing sign-in machinery — the seat launcher's environment, the isolated
// claude-status poll, opencode's auth write, and the "a login landed" signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHandlers, startClaudeLogin, cancelClaudeLogin, onProviderOauthLanded, _getClaudeLoginSessions, _resetClaudeLoginSessions, _resetOauthCallbacks } from "./rpc.mjs";
import { pollClaudeLogin, setProviderAuthEntry, _setOcTransport } from "./opencode.mjs";
import { spawn as ptySpawn, _setSpawnShellPty, kill as ptyKill, spawnShellPty } from "./pty.mjs";

function deps(over = {}) {
  const spawned = [];
  return {
    spawned,
    deps: {
      tmux: {},
      oc: { getProviders: async () => ({ connected: ["anthropic"] }), ...(over.oc ?? {}) },
      pty: { spawn: (opts) => spawned.push(opts) },
      bus: { publish() {} },
      local: {},
      push: {},
      ...(over.deps ?? {}),
    },
  };
}

// ---- startClaudeLogin with a configDir ---------------------------------------

test("startClaudeLogin(configDir): registers the seat directory on the session, takes NO credentials backup, same connect shape", async () => {
  _resetClaudeLoginSessions();
  const out = await startClaudeLogin("anthropic", { configDir: "/seat/dir", seatId: "seat-3" });
  assert.equal(out.action, "start");
  assert.equal(out.shape, "claude-login");
  assert.match(out.sessionKey, /^claude-login-/);
  assert.equal(typeof out.startedAt, "number");
  const entry = _getClaudeLoginSessions().get(out.sessionKey);
  assert.equal(entry.configDir, "/seat/dir");
  assert.equal(entry.seatId, "seat-3");
  assert.equal(entry.backupPath, null);
  // A client-side card teardown does NOT drop a seat sign-in; only the
  // accounts manager (force) does.
  cancelClaudeLogin(out.sessionKey);
  assert.equal(_getClaudeLoginSessions().size, 1);
  cancelClaudeLogin(out.sessionKey, { force: true });
  assert.equal(_getClaudeLoginSessions().size, 0);
});

test("pty:spawn: a Claude sign-in with no registered session is refused (it would overwrite the live login)", async () => {
  _resetClaudeLoginSessions();
  const { deps: d, spawned } = deps();
  const handlers = buildHandlers(d);
  // StrictMode-style sequence: register, client teardown, respawn.
  const { sessionKey } = await startClaudeLogin("anthropic", { configDir: "/seat/dir", seatId: "seat-9" });
  cancelClaudeLogin(sessionKey); // card unmount — must not drop the seat record
  await handlers["pty:spawn"]({ sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" } });
  assert.deepEqual(spawned[0].extraEnv, { CLAUDE_CONFIG_DIR: "/seat/dir" });
  cancelClaudeLogin(sessionKey, { force: true });
  await assert.rejects(
    async () => handlers["pty:spawn"]({ sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" } }),
    /expired/,
  );
  assert.equal(spawned.length, 1);
});

// ---- pty:spawn applies CLAUDE_CONFIG_DIR — from the SERVER registry only ------

test("pty:spawn: a seat sign-in's launcher gets CLAUDE_CONFIG_DIR from the registry; a client-sent extraEnv is dropped", async () => {
  _resetClaudeLoginSessions();
  const { sessionKey } = await startClaudeLogin("anthropic", { configDir: "/seat/dir", seatId: "seat-3" });
  const { deps: d, spawned } = deps();
  const handlers = buildHandlers(d);
  await handlers["pty:spawn"]({ sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" }, extraEnv: { EVIL: "1", CLAUDE_CONFIG_DIR: "/etc" } });
  assert.deepEqual(spawned[0].extraEnv, { CLAUDE_CONFIG_DIR: "/seat/dir" });
  assert.equal(spawned[0].sessionKey, sessionKey);
  cancelClaudeLogin(sessionKey, { force: true });
});

test("pty:spawn: an ordinary spawn gets NO extraEnv, even when the client sends one; a regular (non-seat) claude login gets none either", async () => {
  _resetClaudeLoginSessions();
  const { deps: d, spawned } = deps();
  const handlers = buildHandlers(d);
  await handlers["pty:spawn"]({ sessionKey: "k1", cwd: "/home", cols: 80, rows: 24, extraEnv: { EVIL: "1" } });
  const regular = await startClaudeLogin("anthropic");
  await handlers["pty:spawn"]({ sessionKey: regular.sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" }, extraEnv: { EVIL: "1" } });
  assert.equal("extraEnv" in spawned[0], false);
  assert.equal("extraEnv" in spawned[1], false);
  cancelClaudeLogin(regular.sessionKey);
  // A seat session key used with a DIFFERENT launcher does not leak the env.
  const { sessionKey } = await startClaudeLogin("anthropic", { configDir: "/seat/dir" });
  await handlers["pty:spawn"]({ sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude" } });
  assert.equal("extraEnv" in spawned[2], false);
  cancelClaudeLogin(sessionKey, { force: true });
});

test("pty.spawn forwards extraEnv to spawnShellPty (and spawnShellPty only applies it to launchers)", () => {
  const seen = [];
  _setSpawnShellPty((o) => {
    seen.push(o);
    return { onData() {}, onExit() {} };
  });
  try {
    ptySpawn({ sessionKey: "seatlogin-x", cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" }, extraEnv: { CLAUDE_CONFIG_DIR: "/seat/dir" } }, () => {});
  } finally {
    _setSpawnShellPty(null);
    ptyKill("seatlogin-x");
  }
  assert.deepEqual(seen[0].extraEnv, { CLAUDE_CONFIG_DIR: "/seat/dir" });
  assert.equal(typeof spawnShellPty, "function");
});

// ---- claude-status for a seat sign-in ------------------------------------------

test("claude-status for a seat sign-in reads the SEAT's credentials file and never restarts opencode", async () => {
  _resetClaudeLoginSessions();
  const dir = await mkdtemp(join(tmpdir(), "seat-login-"));
  try {
    const { sessionKey, startedAt } = await startClaudeLogin("anthropic", { configDir: dir, seatId: "seat-3" });
    let restarts = 0;
    const { deps: d } = deps();
    d.restartOpencode = async () => {
      restarts++;
      return { ok: true };
    };
    const handlers = buildHandlers(d);
    const none = await handlers["opencode:provider-auth"]({ action: "claude-status", sessionKey, startedAt });
    assert.deepEqual(none.progress, { state: "no-file" });
    await writeFile(join(dir, ".credentials.json"), "{}");
    const done = await handlers["opencode:provider-auth"]({ action: "claude-status", sessionKey, startedAt });
    assert.equal(done.ok, true);
    assert.equal(done.progress.state, "completed");
    assert.equal(done.progress.restart.ok, true);
    assert.equal(done.progress.connected, true);
    assert.equal(restarts, 0, "the live login is untouched, so opencode is not bounced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pollClaudeLogin isolated: reads the given path; no restart, no rollback, no providers probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seat-poll-"));
  try {
    const file = join(dir, ".credentials.json");
    const calls = { restart: 0, providers: 0 };
    const common = {
      credentialsPath: file,
      isolated: true,
      restartOpencode: async () => (calls.restart++, { ok: true }),
      getProviders: async () => (calls.providers++, { connected: [] }),
    };
    assert.deepEqual(await pollClaudeLogin({ startedAt: Date.now(), ...common }), { state: "no-file" });
    await writeFile(file, "{}");
    const r = await pollClaudeLogin({ startedAt: 0, ...common });
    assert.equal(r.state, "completed");
    assert.deepEqual(r.restore, { restored: false, reason: "isolated" });
    assert.deepEqual(calls, { restart: 0, providers: 0 });
    assert.equal((await pollClaudeLogin({ startedAt: Date.now() + 60_000, ...common })).state, "pre-existing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- setProviderAuthEntry --------------------------------------------------------

// V2 shapes (pinned 2.0.30, verified against a sandboxed server): the OAuth methods are looked up
// at GET /api/integration/<id>, and the entry is stored with POST /api/credential
// `{integrationID, value:{type:"oauth", methodID, refresh, access, expires, metadata?}}`. V2 answers
// 200 and silently DROPS a top-level `accountId`, so the account id must ride in `metadata.accountID`.
const OPENAI_INTEGRATION = { data: { id: "openai", methods: [{ type: "key" }, { id: "chatgpt-token-sharing", type: "oauth" }] } };

/** A fake opencode: records every request, answers the integration lookup and the credential write. */
function fakeV2({ credential = () => new Response(JSON.stringify({ data: { id: "cred_1" } }), { status: 200 }) } = {}) {
  const calls = [];
  _setOcTransport(async (url, init) => {
    const u = new URL(String(url));
    const call = { path: u.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.method === "GET" && call.path === "/api/integration/openai") return new Response(JSON.stringify(OPENAI_INTEGRATION), { status: 200 });
    return credential(call);
  });
  return calls;
}

test("setProviderAuthEntry: oauth entry → POST /api/credential with ONLY the known fields, the account id in metadata; result carries no secret", async () => {
  const calls = fakeV2();
  try {
    const r = await setProviderAuthEntry("openai", {
      type: "oauth", access: "SECRET-A", refresh: "SECRET-R", expires: 5, accountId: "gpt-1", enterpriseUrl: "https://ent.example", sneaky: "x",
    });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/integration/openai", "POST /api/credential"]);
    assert.deepEqual(calls[1].body, {
      integrationID: "openai",
      value: {
        type: "oauth", methodID: "chatgpt-token-sharing", refresh: "SECRET-R", access: "SECRET-A", expires: 5,
        metadata: { accountID: "gpt-1", enterpriseUrl: "https://ent.example" },
      },
    });
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
    // The V1 shape must be gone: nothing at the top level of the value, and no unknown field forwarded.
    assert.equal("accountId" in calls[1].body.value, false);
    assert.doesNotMatch(JSON.stringify(calls[1].body), /sneaky/);
  } finally {
    _setOcTransport(null);
  }
});

test("setProviderAuthEntry: an entry with no account id sends no metadata at all", async () => {
  const calls = fakeV2();
  try {
    assert.deepEqual(await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5 }), { ok: true });
    assert.equal("metadata" in calls[1].body.value, false);
    // An empty / non-string id is not an id.
    await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5, accountId: "", enterpriseUrl: 7 });
    assert.equal("metadata" in calls[3].body.value, false);
  } finally {
    _setOcTransport(null);
  }
});

test("setProviderAuthEntry: an api/key entry goes to connect/key with ONLY the key (no integration lookup, no credential POST)", async () => {
  const calls = fakeV2();
  try {
    assert.deepEqual(await setProviderAuthEntry("openai", { type: "api", key: "sk-secret", sneaky: "x" }), { ok: true });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/integration/openai/connect/key"]);
    assert.deepEqual(calls[0].body, { key: "sk-secret" });
  } finally {
    _setOcTransport(null);
  }
});

test("setProviderAuthEntry: a rejected write → bad_response / unauthorized, never carrying the entry", async () => {
  fakeV2({ credential: () => new Response("nope", { status: 500 }) });
  try {
    const bad = await setProviderAuthEntry("openai", { type: "oauth", access: "SECRET-A", refresh: "SECRET-R", expires: 5 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "bad_response");
    assert.doesNotMatch(JSON.stringify(bad), /SECRET/);
  } finally {
    _setOcTransport(null);
  }
  fakeV2({ credential: () => new Response("no", { status: 401 }) });
  try {
    assert.equal((await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5 })).error, "unauthorized");
  } finally {
    _setOcTransport(null);
  }
});

test("setProviderAuthEntry: opencode unreachable → unreachable (on the lookup, and on the write)", async () => {
  _setOcTransport(async () => {
    throw new Error("down");
  });
  try {
    assert.equal((await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5 })).error, "unreachable");
  } finally {
    _setOcTransport(null);
  }
  _setOcTransport(async (url) => {
    if (new URL(String(url)).pathname === "/api/credential") throw new Error("reset");
    return new Response(JSON.stringify(OPENAI_INTEGRATION), { status: 200 });
  });
  try {
    assert.equal((await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5 })).error, "unreachable");
  } finally {
    _setOcTransport(null);
  }
});

// ---- the "a login landed" signal ---------------------------------------------------

function oauthAutoDeps(completes) {
  const { deps: d } = deps();
  d.oc.listProviderAuthMethods = async () => ({ ok: true, methods: { openai: [{ type: "oauth", label: "ChatGPT headless" }] } });
  d.oc.startProviderOauth = async () => ({ ok: true, url: "https://auth.example/device", method: "auto" });
  d.oc.completeProviderOauth = completes;
  return d;
}

test("onProviderOauthLanded: fires with the wait's epoch when a device wait approves, never on failure; typed-code success has no epoch", async () => {
  _resetOauthCallbacks();
  const seen = [];
  const off = onProviderOauthLanded((e) => seen.push(e));
  try {
    let settle;
    const d = oauthAutoDeps(() => new Promise((res) => (settle = res)));
    const handlers = buildHandlers(d);
    await handlers["opencode:provider-auth"]({ action: "start", id: "openai" });
    assert.deepEqual(seen, []);
    settle({ ok: true });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen, [{ id: "openai", epoch: 1 }]);

    _resetOauthCallbacks();
    seen.length = 0;
    const failing = buildHandlers(oauthAutoDeps(async () => ({ ok: false, error: "expired" })));
    await failing["opencode:provider-auth"]({ action: "start", id: "openai" });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen, []);

    const code = buildHandlers(oauthAutoDeps(async () => ({ ok: true })));
    await code["opencode:provider-auth"]({ action: "code", id: "openai", methodIndex: 0, code: "abc" });
    assert.deepEqual(seen, [{ id: "openai", epoch: undefined }]);
  } finally {
    off();
  }
});

test("a listener that throws or rejects never breaks the oauth flow", async () => {
  _resetOauthCallbacks();
  const off1 = onProviderOauthLanded(() => {
    throw new Error("sync boom");
  });
  const off2 = onProviderOauthLanded(async () => {
    throw new Error("async boom");
  });
  try {
    const handlers = buildHandlers(oauthAutoDeps(async () => ({ ok: true })));
    const r = await handlers["opencode:provider-auth"]({ action: "code", id: "openai", methodIndex: 0, code: "abc" });
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 5));
  } finally {
    off1();
    off2();
  }
});

// ---- accounts channels are registered only when a manager is wired -----------------

test("buildHandlers: the accounts:* channels come from the manager; absent without one", async () => {
  const names = ["list", "set-mode", "set-active", "rename", "add-seat", "seat-status", "add-seat-confirm", "cancel-seat", "remove-seat", "session-seat"].map((n) => `accounts:${n}`);
  const { deps: d } = deps();
  const without = buildHandlers(d);
  for (const n of names) assert.equal(without[n], undefined, n);
  const channels = Object.fromEntries(names.map((n) => [n, async () => n]));
  const withMgr = buildHandlers({ ...d, accountsManager: { channels } });
  for (const n of names) assert.equal(await withMgr[n](), n);
  assert.equal(typeof withMgr["accounts:retry"], "function", "the existing accounts channels are untouched");
});
