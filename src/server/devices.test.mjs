// devices.test.mjs — BET-490 stage 2: per-device credential registry + the
// auth engine's per-device claim / revoke / list behaviour. Pure engine logic
// + injected I/O only — no live box. Complements auth.test.mjs (which pins the
// legacy pairing/claim + whole-box reset back-compat).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import {
  createDeviceRegistry,
  loadDevicesRaw,
  saveDevicesRaw,
  isValidDeviceToken,
  DEVICES_STORE_PATH,
  DEVICE_IDLE_TTL_MS,
} from "./devices.mjs";
import { createAuthEngine } from "./auth.mjs";

const HEX32 = "0123456789abcdef0123456789abcdef";
const PRIMARY_TOKEN = "fedcba9876543210fedcba9876543210";
const AUTH = { box_id: HEX32, box_token: PRIMARY_TOKEN, created_at: 0 };

// Monotonic clock so the 1s last_seen persist throttle never wedges a test.
let nowms = 0;
function now() {
  nowms += 1;
  return nowms;
}

// Isolated engine: a device registry backed by an in-memory state object (so
// persistence is exercised without touching the real/sandboxed filesystem) +
// no-op auth writers. SAFETY: never createAuthEngine directly here — revoke
// with a matching token writes the real box store if the writers aren't
// injected.
function makeEngine() {
  let state = { devices: [] };
  const devices = createDeviceRegistry({
    load: () => ({ devices: state.devices }),
    save: (s) => {
      state.devices = s.devices;
      return Promise.resolve(true);
    },
    now,
  });
  const eng = createAuthEngine({
    auth: AUTH,
    saveAuth: async () => {},
    deleteAuth: async () => {},
    devices,
    now,
  });
  return { eng, devices, getState: () => state };
}

// Claim a fresh device via a fresh one-time pairing code.
function doClaim(eng, overrides = {}) {
  const code = eng.pair().pairing_code;
  return eng.claim({ pairing_code: code, ...overrides });
}

const gate = (eng, tok) =>
  eng.authorize({ method: "GET", path: "/api/projects", authorization: `Bearer ${tok}` });

// A settable monotonic clock for idle-expiry tests, plus a registry + engine
// wired with a small idleTtlMs so we don't advance 90 simulated days per case.
function makeClockEngine({ idleTtlMs = 1000, start = 1000 } = {}) {
  let t = start;
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  let state = { devices: [] };
  const devices = createDeviceRegistry({
    load: () => ({ devices: state.devices }),
    save: (s) => {
      state.devices = s.devices;
      return Promise.resolve(true);
    },
    now: clock.now,
    idleTtlMs,
  });
  const eng = createAuthEngine({
    auth: AUTH,
    saveAuth: async () => {},
    deleteAuth: async () => {},
    devices,
    now: clock.now,
    idleTtlMs,
  });
  return { eng, devices, clock };
}

// ---------------------------------------------------------------------------
// Stage 3 — device token idle expiry (90 days, §6.4)
// ---------------------------------------------------------------------------

test("idle expiry: a device idle past the threshold is revoked on its NEXT request", () => {
  const { eng, devices, clock } = makeClockEngine();
  const a = doClaim(eng, { device_id: "devA" });
  // admitted once, so last_seen = now
  assert.equal(gate(eng, a.box_token).ok, true);
  const lastSeenA = devices.getDevice(a.device_id).last_seen;

  // goes idle WITHOUT further use for more than the window
  clock.advance(1001); // idleTtlMs=1000 → idle = 1001 > 1000
  assert.equal(gate(eng, a.box_token).ok, false); // revoked on its next request
  // and it stays revoked — it can never "come back" (last_seen not bumped)
  assert.equal(gate(eng, a.box_token).ok, false);
  // the revocation is durable-flagged for the gate to force-persist
  assert.equal(devices.needPersist(), true);
  assert.ok(lastSeenA > 0);
});

test("idle expiry: a device idle AT the boundary (not past it) is accepted — not spuriously expired", () => {
  const { eng, clock } = makeClockEngine();
  const a = doClaim(eng, { device_id: "devA" });
  assert.equal(gate(eng, a.box_token).ok, true); // admission, last_seen = now
  clock.advance(999); // idle = 999 < 1000
  assert.equal(gate(eng, a.box_token).ok, true);
});

test("idle expiry: an ACTIVE device (recent auth) is never expired", () => {
  const { eng, clock } = makeClockEngine();
  const a = doClaim(eng, { device_id: "devA" });
  // use it at a pace just inside the window, forever
  for (let i = 0; i < 5; i++) {
    clock.advance(999);
    assert.equal(gate(eng, a.box_token).ok, true, `iteration ${i} must stay live`);
  }
  assert.equal(gate(eng, a.box_token).ok, true);
});

test("idle expiry: the PRIMARY (shared box_token) device is NEVER expired, even idle past the threshold", () => {
  const { eng, clock } = makeClockEngine();
  // primary is the shared box_token holder (desktop + manta-native tools)
  clock.advance(10 ** 7); // way past 90 days of simulated idle
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);
});

test("idle expiry: other devices are unaffected when one expires", () => {
  const { eng, clock } = makeClockEngine();
  const a = doClaim(eng, { device_id: "devA" });
  const b = doClaim(eng, { device_id: "devB" });
  const c = doClaim(eng, { device_id: "devC" });
  // keep B and C fresh, let A go idle
  for (let i = 0; i < 3; i++) {
    clock.advance(999);
    assert.equal(gate(eng, b.box_token).ok, true);
    assert.equal(gate(eng, c.box_token).ok, true);
  }
  clock.advance(2); // A now idle past threshold
  assert.equal(gate(eng, a.box_token).ok, false); // only A dies
  assert.equal(gate(eng, b.box_token).ok, true);
  assert.equal(gate(eng, c.box_token).ok, true);
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);
  // revoked A drops out of the linked-device list; B/C/primary remain
  const ids = eng.listDevices().map((d) => d.device_id);
  assert.equal(ids.includes(a.device_id), false);
  assert.equal(ids.includes(b.device_id), true);
  assert.equal(ids.includes(c.device_id), true);
});

test("idle expiry: IN-FLIGHT behaviour — admitted requests complete (never torn down mid-flight); the next request once the idle window has elapsed 401s cleanly without refreshing", () => {
  const { eng, clock } = makeClockEngine({ idleTtlMs: 1000 });
  const a = doClaim(eng, { device_id: "devA" });
  // (a) an admitted request RUNS to completion — expiry is evaluated exactly
  //     once, at admission, and never re-checked mid-request.
  assert.equal(gate(eng, a.box_token).ok, true);
  // (b) the device is then abandoned (a lost phone): a full idle window elapses
  //     with no use, so the NEXT request is rejected cleanly — 401.
  clock.advance(1001); // idle from last use = 1001 > 1000
  const r = eng.authorize({ method: "GET", path: "/api/projects", authorization: `Bearer ${a.box_token}` });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  // (c) the rejected request did NOT refresh the device — it stays revoked.
  assert.equal(gate(eng, a.box_token).ok, false);
});

test("idle expiry: the 90-day SWEEP marks every long-idle device revoked in one pass", () => {
  const { devices, clock, eng } = makeClockEngine();
  const a = doClaim(eng, { device_id: "devA" });
  const b = doClaim(eng, { device_id: "devB" });
  assert.equal(gate(eng, a.box_token).ok, true);
  assert.equal(gate(eng, b.box_token).ok, true);
  // sweep while both fresh → nothing expires, nothing revoked
  assert.deepEqual(devices.sweepIdleExpired(), []);
  // let both go idle, then sweep
  clock.advance(10 ** 5);
  const swept = devices.sweepIdleExpired().map((d) => d.device_id);
  assert.deepEqual(swept.sort(), [a.device_id, b.device_id].sort());
  // both tokens are now dead on their next request
  assert.equal(gate(eng, a.box_token).ok, false);
  assert.equal(gate(eng, b.box_token).ok, false);
  // primary survives the sweep (exempt)
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);
  // a fresh use re-provisions a NEW device (a revoked device is never resurrected)
  const again = doClaim(eng, { device_id: "devA" });
  assert.notEqual(again.device_id, a.device_id);
  assert.equal(gate(eng, again.box_token).ok, true);
});

test("DEVICE_IDLE_TTL_MS is 90 days", () => {
  assert.equal(DEVICE_IDLE_TTL_MS, 90 * 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// Pure registry
// ---------------------------------------------------------------------------

test("registry: seedPrimary makes the shared token authorize, absent a claim", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  assert.notEqual(reg.authorize(PRIMARY_TOKEN), null);
  assert.equal(reg.authorize("a".repeat(32)), null);
  // primary device surfaces in the list (no token leak)
  const list = reg.listDevices();
  assert.equal(list.length, 1);
  assert.equal(list[0].primary, true);
  assert.equal("token" in list[0], false);
});

test("registry: claim with a distinct deviceId provisions a DISTINCT token", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  const a = reg.claim({ deviceId: "d1", name: "phone" }).entry;
  const b = reg.claim({ deviceId: "d2" }).entry;
  const c = reg.claim({ deviceId: "d10" }).entry;
  // all three per-device tokens are distinct from each other AND from primary
  for (const tok of [a.token, b.token, c.token]) {
    assert.equal(isValidDeviceToken(tok), true);
    assert.notEqual(tok, PRIMARY_TOKEN);
  }
  assert.notEqual(a.token, b.token);
  assert.notEqual(b.token, c.token);
  assert.notEqual(a.token, c.token);
  assert.notEqual(a.device_id, b.device_id);
});

test("registry: claim without a deviceId resumes the primary (legacy shared token)", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  const r = reg.claim({}).entry;
  assert.equal(r.primary, true);
  assert.equal(r.token, PRIMARY_TOKEN);
});

test("registry: a renewed claim RESUMES the same device (same token, same id)", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  const first = reg.claim({ deviceId: "d1", name: "phone" }).entry;
  const second = reg.claim({ deviceId: "d1" }).entry;
  assert.equal(second.device_id, first.device_id);
  assert.equal(second.token, first.token);
});

test("registry: revoking a device kills only it; others + primary stay live", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  const a = reg.claim({ deviceId: "d1" }).entry;
  const b = reg.claim({ deviceId: "d2" }).entry;
  // all live initially
  assert.notEqual(reg.authorize(a.token), null);
  assert.notEqual(reg.authorize(b.token), null);
  assert.notEqual(reg.authorize(PRIMARY_TOKEN), null);

  const revoked = reg.revokeDevice(a.device_id);
  assert.notEqual(revoked, null);

  assert.equal(reg.authorize(a.token), null); // dead
  assert.notEqual(reg.authorize(b.token), null); // unaffected
  assert.notEqual(reg.authorize(PRIMARY_TOKEN), null); // primary unaffected

  // list no longer includes the revoked device
  const ids = reg.listDevices().map((d) => d.device_id);
  assert.equal(ids.includes(a.device_id), false);
  assert.equal(ids.includes(b.device_id), true);
});

test("registry REGRESSION: re-claim after a revoke gets a FRESH id (no duplicate), stays revocable by id", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary(PRIMARY_TOKEN);
  const victim = reg.claim({ deviceId: "D", name: "phone" }).entry;
  reg.revokeDevice("D");
  assert.equal(reg.authorize(victim.token), null);

  // Re-claim with the SAME device_id — must NOT resurrect or duplicate id D.
  const again = reg.claim({ deviceId: "D", name: "phone" }).entry;
  assert.notEqual(again.device_id, "D"); // fresh id, never a duplicate
  assert.notEqual(again.token, victim.token); // fresh token too
  // exactly one entry ever holds id "D" (the stale revoked one)
  assert.equal(reg.serialize().devices.filter((d) => d.device_id === "D").length, 1);

  // The resurrected device is LIVE and one-tap revocable by its own id.
  assert.notEqual(reg.authorize(again.token), null);
  assert.notEqual(reg.revokeDevice(again.device_id), null);
  assert.equal(reg.authorize(again.token), null);
  assert.equal(reg.listDevices().some((d) => d.device_id === again.device_id), false);
});

test("registry: whole-box reset drops every device and re-seeds one primary", () => {
  const reg = createDeviceRegistry({ load: () => null, save: async () => {}, now });
  reg.seedPrimary("a".repeat(32));
  reg.claim({ deviceId: "d1" });
  const newTok = "b".repeat(32);
  reg.resetAll(newTok);
  const list = reg.listDevices();
  assert.equal(list.length, 1);
  assert.equal(list[0].primary, true);
  assert.equal(reg.authorize("a".repeat(32)), null); // old primary + d1 are gone
  assert.notEqual(reg.authorize(newTok), null); // fresh primary works
});

// ---------------------------------------------------------------------------
// Auth engine integration — per-device claim / revoke / list
// ---------------------------------------------------------------------------

test("claim provisions a distinct per-device token the gate accepts", () => {
  const { eng } = makeEngine();
  const dev = doClaim(eng, { device_id: "phone-1", name: "A phone" });
  assert.equal(dev.ok, true);
  assert.notEqual(dev.box_token, PRIMARY_TOKEN); // distinct from shared box_token
  assert.equal(isValidDeviceToken(dev.box_token), true);
  assert.ok(dev.device_id);
  assert.equal(gate(eng, dev.box_token).ok, true); // the new token authorizes
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true); // primary still authorizes
});

test("second and tenth devices each get a DISTINCT token", () => {
  const { eng } = makeEngine();
  const d1 = doClaim(eng, { device_id: "d1" });
  const d2 = doClaim(eng, { device_id: "d2" });
  const d10 = doClaim(eng, { device_id: "d10" });
  const tokens = [d1.box_token, d2.box_token, d10.box_token, PRIMARY_TOKEN];
  assert.equal(new Set(tokens).size, tokens.length); // all pairwise distinct
});

test("a claim always provisions or resumes an entry: repeated claim resumes", () => {
  const { eng } = makeEngine();
  const first = doClaim(eng, { device_id: "phone-1" });
  const renewed = doClaim(eng, { device_id: "phone-1" }); // same device re-pairs
  assert.equal(renewed.box_token, first.box_token); // resumes, same token
  assert.equal(renewed.device_id, first.device_id);
});

test("listDevices returns per-device metadata only — no tokens", () => {
  const { eng } = makeEngine();
  doClaim(eng, { device_id: "phone-1", name: "A phone" });
  doClaim(eng, { device_id: "tablet-1", name: "Tablet" });
  const list = eng.listDevices();
  // primary + the two devices
  assert.equal(list.length, 3);
  const ids = list.map((d) => d.device_id);
  assert.equal(ids.filter((id) => id).length, 3);
  for (const d of list) {
    assert.equal("token" in d, false, "list must never expose a device token");
    assert.equal(typeof d.device_id, "string");
    assert.equal(typeof d.last_seen, "number");
    assert.equal(typeof d.created_at, "number");
    assert.equal(typeof d.primary, "boolean");
  }
});

test("per-device revoke kills ONLY that device; other devices + primary still pass", async () => {
  const { eng } = makeEngine();
  const a = doClaim(eng, { device_id: "devA", name: "phone" });
  const b = doClaim(eng, { device_id: "devB", name: "tablet" });

  assert.equal(gate(eng, a.box_token).ok, true);
  assert.equal(gate(eng, b.box_token).ok, true);
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);

  // Device B revokes device A, one-tap (a live device's own token is the
  // credential that authorises the revoke of another).
  const r = await eng.revoke({ token: b.box_token, device_id: "devA" });
  assert.equal(r.ok, true);
  assert.equal(r.reset, false);
  assert.equal(r.device_id, "devA");
  assert.equal(r.box_id, HEX32); // identity unchanged — not a whole-box reset

  // A's token is rejected on its very next request…
  assert.equal(gate(eng, a.box_token).ok, false);
  // …while B and the desktop/primary token are untouched.
  assert.equal(gate(eng, b.box_token).ok, true);
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);

  // A can no longer use its (revoked) token to revoke anything → 401.
  const viaRevoked = await eng.revoke({ token: a.box_token, device_id: "devB" });
  assert.equal(viaRevoked.ok, false);
  assert.equal(viaRevoked.status, 401);

  // revoking an unknown device → 404, nothing changes
  const missing = await eng.revoke({ token: b.box_token, device_id: "nope" });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(gate(eng, b.box_token).ok, true);
});

test("REGRESSION: per-device revoke still works after a re-claim with a revoked device_id", async () => {
  const { eng } = makeEngine();
  const a1 = doClaim(eng, { device_id: "devA" });
  assert.equal(gate(eng, a1.box_token).ok, true);

  // revoke the first incarnation of "devA" by id
  const r1 = await eng.revoke({ token: PRIMARY_TOKEN, device_id: "devA" });
  assert.equal(r1.ok, true);
  assert.equal(eng.listDevices().some((d) => d.device_id === "devA"), false);

  // the SAME physical device re-pairs under the same claim id → the server
  // must mint a fresh device, leave the stale revoked one untouched, and
  // return something that stays revocable one-tap.
  const a2 = doClaim(eng, { device_id: "devA" });
  assert.notEqual(a2.device_id, "devA");
  assert.ok(a2.device_id);
  assert.equal(gate(eng, a2.box_token).ok, true); // resurrected + live

  // one-tap revoke by the resurrected device's ACTUAL id now works
  const r2 = await eng.revoke({ token: PRIMARY_TOKEN, device_id: a2.device_id });
  assert.equal(r2.ok, true);
  assert.equal(gate(eng, a2.box_token).ok, false); // dead on next request
});

test("whole-box reset (no device_id) kills the shared token AND every per-device token", async () => {
  const { eng } = makeEngine();
  const dev = doClaim(eng, { device_id: "devA" });
  assert.equal(gate(eng, dev.box_token).ok, true);
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, true);

  const r = await eng.revoke({ token: PRIMARY_TOKEN }); // legacy whole-box reset
  assert.equal(r.ok, true);
  assert.equal(r.reset, true);
  assert.equal(r.device_id, null);

  // old per-device token + old shared token are all dead
  assert.equal(gate(eng, dev.box_token).ok, false);
  assert.equal(gate(eng, PRIMARY_TOKEN).ok, false);

  // a fresh no-device_id claim returns the NEW primary identity, which works
  const c = doClaim(eng);
  assert.equal(c.ok, true);
  assert.notEqual(c.box_token, PRIMARY_TOKEN);
  assert.equal(gate(eng, c.box_token).ok, true);
});

// ---------------------------------------------------------------------------
// Store: 0600 + statePath sandbox
// ---------------------------------------------------------------------------

test("saveDevicesRaw writes 0600 and loadDevicesRaw round-trips", async () => {
  const path = join(tmpdir(), `manta-devices-test-${process.pid}-${Date.now()}.json`);
  const state = {
    devices: [
      { device_id: "d1", token: PRIMARY_TOKEN, name: "d", last_seen: 1, created_at: 1, revoked: false, primary: true },
    ],
  };
  try {
    await saveDevicesRaw(state, path);
    const st = await stat(path);
    assert.equal(st.mode & 0o777, 0o600);
    assert.deepEqual(loadDevicesRaw(path), state);
  } finally {
    await rm(path, { force: true });
  }
});

test("DEVICES_STORE_PATH resolves under the sandboxed state home (no fresh homedir join)", () => {
  const home = process.env.MANTA_STATE_HOME;
  if (home) {
    assert.ok(
      DEVICES_STORE_PATH.startsWith(home),
      `devices store must live under MANTA_STATE_HOME (${home}), got ${DEVICES_STORE_PATH}`,
    );
  }
  assert.ok(DEVICES_STORE_PATH.endsWith("devices.json"));
});

