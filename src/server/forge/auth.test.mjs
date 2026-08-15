// auth.test.mjs — the §3.3 auth ladder (BET-788). No live network, no real gh
// subprocess, no real secrets vault: shell + loadSecretsFn are injected.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveToken, invalidateToken, normalizeUserCode, startDeviceGrant, pollDeviceGrant, ExpiredCodeError, DeviceFlowNotConfiguredError, DEVICE_CLIENT_ID, DEVICE_CLIENT_ID_PLACEHOLDER } from "./auth.mjs";

// The module-level auth cache persists across test cases in this file — clear
// it before each so a cached github.com resolution from one test can't leak
// into the next.
beforeEach(() => {
  invalidateToken("github.com");
  invalidateToken("gitlab.com");
  invalidateToken("");
});

// A mutable clock so tests can simulate the TTL elapsing / staying put.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// shell that yields a given token (or rejects → "no CLI token").
function shellReturning(token) {
  return async () => ({ stdout: token });
}

function loadWith(secrets) {
  return () => secrets;
}

const NO_ENV = {};
const STORED = [{ id: "s1", key: "GITHUB_TOKEN", value: "ghp_stored", scope: "shared", sessionID: null, project: null }];

test("resolveToken: CLI wins over stored", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_cli", source: "cli" });
});

test("resolveToken: stored secret used when no CLI token", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_stored", source: "stored" });
});

test("resolveToken: env var wins over CLI and stored", async () => {
  const r = await resolveToken("github.com", {
    env: { MANTA_GITHUB_TOKEN: "ghp_env" },
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_env", source: "env" });
});

test("resolveToken: legacy github.token secret still resolves", async () => {
  const legacy = [{ id: "s1", key: "github.token", value: "ghp_legacy", scope: "shared", sessionID: null, project: null }];
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith(legacy),
  });
  assert.deepEqual(r, { token: "ghp_legacy", source: "stored" });
});

test("resolveToken: canonical GITHUB_TOKEN wins over legacy github.token", async () => {
  const both = [
    { id: "s1", key: "github.token", value: "ghp_legacy", scope: "shared", sessionID: null, project: null },
    { id: "s2", key: "GITHUB_TOKEN", value: "ghp_canonical", scope: "shared", sessionID: null, project: null },
  ];
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith(both),
  });
  assert.deepEqual(r, { token: "ghp_canonical", source: "stored" });
});

test("resolveToken: gitlab env var + legacy secret resolve", async () => {
  const legacy = [{ id: "s1", key: "gitlab.token", value: "glpat_legacy", scope: "shared", sessionID: null, project: null }];
  const r = await resolveToken("gitlab.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith(legacy),
  });
  assert.deepEqual(r, { token: "glpat_legacy", source: "stored" });
  invalidateToken("gitlab.com"); // drop the cached legacy resolution so the env leg is re-tried
  const envR = await resolveToken("gitlab.com", {
    env: { MANTA_GITLAB_TOKEN: "glpat_env" },
    shell: shellReturning(""),
    loadSecretsFn: loadWith([]),
  });
  assert.deepEqual(envR, { token: "glpat_env", source: "env" });
});

test("resolveToken: neither → null", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith([]),
  });
  assert.equal(r, null);
});

test("resolveToken: unknown/empty host → null without touching anything", async () => {
  let shellCalls = 0;
  const r = await resolveToken("", {
    env: NO_ENV,
    shell: async () => (shellCalls++, { stdout: "x" }),
    loadSecretsFn: loadWith([]),
  });
  assert.equal(r, null);
  assert.equal(shellCalls, 0);
});

test("resolveToken: CLI failure (gh missing) falls through to stored", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: async () => {
      throw new Error("gh not found");
    },
    loadSecretsFn: loadWith(STORED),
  });
  assert.deepEqual(r, { token: "ghp_stored", source: "stored" });
});

test("resolveToken: persisted disconnect flag returns null even when every rung matches", async () => {
  // Env var AND gh CLI AND a stored secret would all match — but the box has
  // been explicitly disconnected, so the ladder resolves nothing.
  const r = await resolveToken("github.com", {
    env: { MANTA_GITHUB_TOKEN: "ghp_env" },
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith(STORED),
    getConfig: async () => ({ forgeDisconnected: true }),
  });
  assert.equal(r, null);
});

test("resolveToken: disconnected flag resolves null without invoking the shell or secrets", async () => {
  let shellCalls = 0;
  const r = await resolveToken("github.com", {
    env: { MANTA_GITHUB_TOKEN: "ghp_env" },
    shell: async () => (shellCalls++, { stdout: "ghp_cli\n" }),
    loadSecretsFn: loadWith(STORED),
    getConfig: async () => ({ forgeDisconnected: true }),
  });
  assert.equal(r, null);
  assert.equal(shellCalls, 0, "disconnect short-circuits before the CLI rung");
});

test("resolveToken: absent/other config leaves the ladder unchanged", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith([]),
    getConfig: async () => ({}),
  });
  assert.deepEqual(r, { token: "ghp_cli", source: "cli" });
});

test("resolveToken: an unreadable config resolves normally (not treated as disconnected)", async () => {
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning("ghp_cli\n"),
    loadSecretsFn: loadWith([]),
    getConfig: async () => {
      throw new Error("corrupt config");
    },
  });
  assert.deepEqual(r, { token: "ghp_cli", source: "cli" });
});

test("resolveToken: cached hit within TTL does not re-invoke the shell", async () => {
  const clock = makeClock();
  const seen = [];
  const shell = async () => (seen.push(1), { stdout: "ghp_cached" });
  await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(seen.length, 1, "second resolve within TTL is served from cache");
});

test("resolveToken: cache expires after TTL and re-reads", async () => {
  const clock = makeClock();
  let token = "ghp_v1";
  const shell = async () => ({ stdout: token });
  const a = await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(a.token, "ghp_v1");
  token = "ghp_v2"; // rotated out-of-band while the box stayed up
  clock.advance(61_000);
  const b = await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(b.token, "ghp_v2", "rotation picked up after TTL");
});

test("invalidateToken clears the cache immediately", async () => {
  const clock = makeClock();
  let token = "ghp_a";
  const shell = async () => ({ stdout: token });
  await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  token = "ghp_b";
  invalidateToken("github.com");
  const r = await resolveToken("github.com", { env: NO_ENV, shell, loadSecretsFn: loadWith([]), now: clock.now });
  assert.equal(r.token, "ghp_b", "invalidate forces a re-read before TTL");
});

// ---- §7.4 case C: device grant (BET-796) -----------------------------------

// A programmable fake fetch: route the two GitHub endpoints by URL. `/login/
// device/code` always mints a grant; `/login/oauth/access_token` is driven by
// an `onToken` callback so a single fake can script pending → slow_down →
// expired → success sequences.
function makeFetch(onToken) {
  return async (url, opts) => {
    const body = JSON.parse(opts?.body ?? "{}");
    if (url === "https://github.com/login/device/code") {
      return {
        ok: true,
        json: async () => ({
          device_code: "DEVICE_CODE_SECRET",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      };
    }
    const outcome = await onToken(body);
    return { ok: true, json: async () => outcome };
  };
}
const okStore = async (t) => ({ ok: true });

test("device grant: happy path returns a RENDERER-SAFE shape and stores the token", async () => {
  const clock = makeClock();
  const seen = [];
  let calls = 0;
  const fetchFn = makeFetch(async (body) => {
    seen.push(body.device_code);
    calls++;
    if (calls === 1) return { error: "authorization_pending", error_description: "wait" };
    return { access_token: "ghp_device_ok", token_type: "bearer" };
  });
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  // device_code MUST never cross RPC (spec rule 1 + acceptance criterion 6).
  assert.equal("device_code" in started, false, "start result has no device_code");
  assert.equal(Object.prototype.hasOwnProperty.call(started, "deviceCode"), false);
  assert.ok(!JSON.stringify(started).includes("device_code"));
  assert.equal(started.userCode, "WDJB-MJHT");
  assert.equal(started.verificationUri, "https://github.com/login/device");
  assert.equal(started.expiresIn, 900);
  assert.equal(started.pollInterval, 5);
  assert.equal(typeof started.grantId, "string");

  let stored = null;
  const pending = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: async (t) => (stored = t, { ok: true }), clearDisconnect: async () => {} });
  assert.deepEqual(pending, { status: "pending", pollInterval: 5 });
  const done = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: async (t) => (stored = t, { ok: true }), clearDisconnect: async () => {} });
  assert.deepEqual(done, { status: "done" });
  assert.equal(stored, "ghp_device_ok", "token stored under GITHUB_TOKEN");
  // The device_code used on the wire is the box-side secret, never surfaced.
  assert.ok(seen.every((d) => d === "DEVICE_CODE_SECRET"));
});

test("device grant: slow_down without an interval falls back to previous + 5", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "slow_down", error_description: "slow" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  assert.equal(started.pollInterval, 5);
  const p1 = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.equal(p1.pollInterval, 10);
  const p2 = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.equal(p2.pollInterval, 15);
});

test("device grant: slow_down trusts GitHub's authoritative interval field", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "slow_down", interval: 12 }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  const p1 = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.equal(p1.pollInterval, 12, "the server-returned interval wins, not the +5 guess");
  const p2 = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.equal(p2.pollInterval, 12, "the same interval is reused, not incremented again");
});

test("device grant: slow_down with an invalid interval falls back to previous + 5", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "slow_down", interval: "nope" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  const p1 = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.equal(p1.pollInterval, 10);
});

test("device grant: authorization_pending keeps polling at the same interval", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "authorization_pending" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  const p = await pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore });
  assert.deepEqual(p, { status: "pending", pollInterval: 5 });
});

test("device grant: expired_token surfaces as ExpiredCodeError ([E2])", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "expired_token", error_description: "expired" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  await assert.rejects(
    () => pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore }),
    ExpiredCodeError,
  );
});

test("device grant: grant past its TTL throws ExpiredCodeError too", async () => {
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "authorization_pending" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  clock.advance(16 * 60_000); // GitHub's 15-min cap elapsed
  await assert.rejects(
    () => pollDeviceGrant(started.grantId, { fetch: fetchFn, now: clock.now, storeToken: okStore }),
    ExpiredCodeError,
  );
});

test("device grant: token is reused at next boot (stored secret resolves)", async () => {
  // Simulate: device flow stored ghp_device_ok, then a fresh resolveToken (no
  // CLI, no env) finds it via the stored GITHUB_TOKEN secret.
  const stored = [{ id: "s1", key: "GITHUB_TOKEN", value: "ghp_device_ok", scope: "shared", sessionID: null, project: null }];
  const r = await resolveToken("github.com", {
    env: NO_ENV,
    shell: shellReturning(""),
    loadSecretsFn: loadWith(stored),
  });
  assert.deepEqual(r, { token: "ghp_device_ok", source: "stored" });
  invalidateToken("github.com");
});

test("device grant: success path clears the persisted disconnect flag (reconnect)", async () => {
  // A box that was disconnected stays disconnected until a successful device
  // sign-in — which must clear the opt-out so the ladder resolves again.
  const clock = makeClock();
  let cleared = 0;
  const fetchFn = makeFetch(async () => ({ access_token: "ghp_reconnect", token_type: "bearer" }));
  const started = await startDeviceGrant({ clientId: "Iv1.realclientid", fetch: fetchFn, now: clock.now });
  const done = await pollDeviceGrant(started.grantId, {
    fetch: fetchFn,
    now: clock.now,
    storeToken: okStore,
    clearDisconnect: async () => {
      cleared++;
    },
  });
  assert.deepEqual(done, { status: "done" });
  assert.equal(cleared, 1, "a successful device sign-in reconnects by clearing the flag");
});

test("normalizeUserCode strips dashes/whitespace and uppercases", () => {
  assert.equal(normalizeUserCode("wdjb-mjht "), "WDJBMJHT");
  assert.equal(normalizeUserCode("wdjb mjht"), "WDJBMJHT");
  assert.equal(normalizeUserCode("WDJB-MJHT"), "WDJBMJHT");
  assert.equal(normalizeUserCode("  "), "");
  assert.equal(normalizeUserCode(""), "");
});

test("device grant: placeholder client_id refuses to start (guard, BET-849)", async () => {
  let fetched = false;
  const clock = makeClock();
  const fetchFn = async () => { fetched = true; throw new Error("should not be called"); };
  await assert.rejects(
    () => startDeviceGrant({ clientId: DEVICE_CLIENT_ID_PLACEHOLDER, fetch: fetchFn, now: clock.now }),
    DeviceFlowNotConfiguredError,
  );
  await assert.rejects(
    () => startDeviceGrant({ clientId: "", fetch: fetchFn, now: clock.now }),
    DeviceFlowNotConfiguredError,
  );
  assert.equal(fetched, false, "no GitHub call is made for a placeholder id");
});

test("device grant: the production default client_id is real, not the placeholder (BET-849)", async () => {
  assert.notEqual(DEVICE_CLIENT_ID, DEVICE_CLIENT_ID_PLACEHOLDER);
  assert.notEqual(DEVICE_CLIENT_ID, "");
  const clock = makeClock();
  const fetchFn = makeFetch(async () => ({ error: "authorization_pending" }));
  const started = await startDeviceGrant({ fetch: fetchFn, now: clock.now });
  assert.equal(started.pollInterval, 5, "the default id is unguarded — the device flow actually runs");
});
