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
  cancelClaudeLogin(out.sessionKey);
  assert.equal(_getClaudeLoginSessions().size, 0);
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
  cancelClaudeLogin(sessionKey);
});

test("pty:spawn: an ordinary spawn gets NO extraEnv, even when the client sends one; a regular (non-seat) claude login gets none either", async () => {
  _resetClaudeLoginSessions();
  const { deps: d, spawned } = deps();
  const handlers = buildHandlers(d);
  await handlers["pty:spawn"]({ sessionKey: "k1", cwd: "/home", cols: 80, rows: 24, extraEnv: { EVIL: "1" } });
  await handlers["pty:spawn"]({ sessionKey: "k2", cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude-auth-login" }, extraEnv: { EVIL: "1" } });
  assert.equal("extraEnv" in spawned[0], false);
  assert.equal("extraEnv" in spawned[1], false);
  // A seat session key used with a DIFFERENT launcher does not leak the env.
  const { sessionKey } = await startClaudeLogin("anthropic", { configDir: "/seat/dir" });
  await handlers["pty:spawn"]({ sessionKey, cwd: "/home", cols: 80, rows: 24, launcher: { id: "claude" } });
  assert.equal("extraEnv" in spawned[2], false);
  cancelClaudeLogin(sessionKey);
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

test("setProviderAuthEntry: PUT /auth/<id> with ONLY the known auth fields; result carries no secret", async () => {
  const calls = [];
  _setOcTransport(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  });
  try {
    const r = await setProviderAuthEntry("openai", { type: "oauth", access: "A", refresh: "R", expires: 5, accountId: "gpt-1", sneaky: "x" });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls[0].method, "PUT");
    assert.match(calls[0].url, /\/auth\/openai$/);
    assert.deepEqual(calls[0].body, { type: "oauth", access: "A", refresh: "R", expires: 5, accountId: "gpt-1" });
  } finally {
    _setOcTransport(null);
  }
  _setOcTransport(async () => new Response("nope", { status: 500 }));
  try {
    const bad = await setProviderAuthEntry("openai", { type: "oauth", access: "A" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "bad_response");
    assert.doesNotMatch(JSON.stringify(bad), /"A"/);
  } finally {
    _setOcTransport(null);
  }
  _setOcTransport(async () => {
    throw new Error("down");
  });
  try {
    assert.equal((await setProviderAuthEntry("openai", { type: "oauth" })).error, "unreachable");
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
