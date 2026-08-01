// devices.mjs — per-device bearer-credential registry (BET-490, Stage 2).
//
// PROBLEM: until now every paired device + the desktop held the SAME shared
// `box_token` (auth.mjs), so `/auth/revoke` regenerated the whole box identity
// and locked out EVERY device at once. §6.3/§6.4 of the pairing rework require
// distinct devices, each with its own credential, so one can be revoked one-tap
// without touching the others.
//
// SOLUTION: a durable registry of distinct device credentials, one opaque
// `device_id` + a distinct 32-hex token per device, persisted 0600 at
// `~/.manta/devices.json` (via `statePath` + the atomic-0600 `writeJsonAtomic`
// pattern — the same store discipline as auth.json, schedule.json, …).
//
// COEXISTENCE (the standing constraint — existing paired devices MUST keep
// working): the registry is authoritative for /authorize, and the shared
// `box_token` from auth.json is registered as a `primary` device whose token IS
// that box_token. So the existing desktop (holds box_token) and the manta-
// native AI tools (read ~/.manta/auth.json per call) keep authenticating,
// while additionally-claimed devices get distinct per-device tokens. On a box
// with no devices.json yet (an upgrade), the primary is seeded from the
// existing box_token on first engine construction — nothing already paired is
// invalidated.
//
// Pure engine + injected I/O (mirrors auth.mjs): `createDeviceRegistry` holds
// an in-memory array and calls an injected `save` on mutations; callers (auth
// engine, tests) inject their writers so no test ever touches the live store.
// No live box, no HTTP — just the registry + persist shape.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

export const DEVICES_STORE_PATH = statePath("devices.json");

// Device ids / tokens are 32 lowercase hex chars (128 bits) — the same shape
// as box_id / box_token. Strict so a value can never smuggle a path-traversal
// or header-injection payload.
export function isValidDeviceToken(token) {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

// Constant-time token compare. Both args must be valid 32-hex tokens.
function tokenMatches(expectedValue, presentedValue) {
  if (!isValidDeviceToken(expectedValue) || !isValidDeviceToken(presentedValue)) {
    return false;
  }
  const a = Buffer.from(expectedValue, "utf-8");
  const b = Buffer.from(presentedValue, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function gen() {
  return randomBytes(16).toString("hex"); // 32-char, 128-bit
}

// Load the persisted registry { devices: [...] } from disk. Returns null on a
// missing/corrupt file (caller then starts from an empty registry).
export function loadDevicesRaw(path = DEVICES_STORE_PATH) {
  return readJsonSync(path, null);
}

// Atomic 0600 writer (same store discipline as auth.json).
export async function saveDevicesRaw(state, path = DEVICES_STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * In-memory device registry engine. Mutations mutate in-memory state and call
 * the injected `save` (via `persist`); `authorize`/`touch` update `last_seen`
 * in memory so a device-list endpoint can show it without blocking on I/O.
 *
 * Store shape (serialized via `serialize`):
 *   { devices: [ { device_id, token, name, last_seen, created_at, revoked, primary } ] }
 *
 * @param {object} deps
 *   load   — () => parsed store or null (default: read `DEVICES_STORE_PATH`)
 *   save   — (serializedState) => Promise  (default: write 0600)
 *   now    — () => epoch ms (injectable clock for tests)
 */
export function createDeviceRegistry({
  load = () => loadDevicesRaw(),
  save = async (state) => saveDevicesRaw(state),
  now = () => Date.now(),
} = {}) {
  let devices = [];
  const parsed = load();
  if (parsed && Array.isArray(parsed.devices)) {
    devices = parsed.devices.filter(
      (d) =>
        d &&
        isValidDeviceToken(d.token) &&
        typeof d.device_id === "string" &&
        d.device_id !== "",
    );
  }

  const byId = (id) => (typeof id === "string" ? devices.find((d) => d.device_id === id) : null);
  const liveByToken = (tk) =>
    typeof tk === "string" ? devices.find((d) => !d.revoked && tokenMatches(d.token, tk)) : null;
  const findPrimary = () => devices.find((d) => d.primary);

  function persist() {
    return save({ devices });
  }

  // Seed (or re-sync) the primary device — the shared box_token holder that
  // keeps existing paired devices + the manta-native AI tools working. On a
  // box being upgraded, this is the first thing the engine does, so the
  // existing desktop never loses access.
  function seedPrimary(token) {
    const p = findPrimary();
    if (p) {
      p.token = token; // re-sync after a whole-box reset / migration
      return p;
    }
    const entry = {
      device_id: gen(),
      token,
      name: "desktop",
      last_seen: now(),
      created_at: now(),
      revoked: false,
      primary: true,
    };
    devices.unshift(entry);
    return entry;
  }

  // Resolve a presented bearer token to a live (non-revoked) device — primary
  // OR any additionally-claimed device. Returns the device (last_seen bumped)
  // or null. This is the /authorize gate's sole credential check.
  function authorize(token) {
    const dev = liveByToken(token);
    if (!dev) return null;
    dev.last_seen = now();
    return dev;
  }

  // Provision or resume a per-device entry:
  //   • deviceId supplied + a live entry with that id → RESUME it (return its
  //     existing distinct token), updating name if given.
  //   • deviceId absent → RESUME the PRIMARY (shared box_token) device. This
  //     is the legacy claim path: a client that sends no device identity gets
  //     the shared token exactly as before, so existing paired devices keep
  //     working unchanged (coexistence constraint).
  //   • otherwise → PROVISION a new device with the given deviceId and a
  //     fresh, distinct token.
  // A revoked device is never resurrected — a re-claim after a revoke gets a
  // brand new entry. Returns { entry, resumed }.
  function claim({ deviceId = null, name = null } = {}) {
    if (deviceId) {
      const existing = byId(deviceId);
      if (existing && !existing.revoked) {
        if (name && typeof name === "string" && name !== "") existing.name = name;
        existing.last_seen = now();
        return { entry: existing, resumed: true };
      }
    } else {
      const prim = findPrimary();
      if (prim) {
        prim.last_seen = now();
        return { entry: prim, resumed: true };
      }
    }
    let token = gen();
    while (devices.some((d) => d.token === token)) token = gen(); // distinct
    // Only ever reuse the client-supplied device_id when NO entry already has
    // it — live OR revoked. Otherwise the new live entry would duplicate the
    // stale revoked id and `byId`/`revokeDevice` (which return the FIRST match)
    // would resolve to the revoked entry, silently breaking one-tap revoke of
    // the resurrected device (§6.3). A revoked device is never resurrected, so
    // a re-claim under a revoked id gets a brand-new device_id.
    let newId = gen();
    if (typeof deviceId === "string" && !devices.some((d) => d.device_id === deviceId)) {
      newId = deviceId;
    }
    const entry = {
      device_id: newId,
      token,
      name: name && typeof name === "string" && name !== "" ? name : "device",
      last_seen: now(),
      created_at: now(),
      revoked: false,
      primary: false,
    };
    devices.push(entry);
    return { entry, resumed: false };
  }

  // Look up a device by id (live or revoked) — for per-device revoke routing.
  function getDevice(deviceId) {
    return byId(deviceId);
  }

  // Mark a device revoked (by id). Returns the device, or null if not found.
  function revokeDevice(deviceId) {
    const dev = byId(deviceId);
    if (!dev) return null;
    dev.revoked = true;
    return dev;
  }

  // Non-revoked devices with their public metadata (NO tokens — a caller must
  // never learn another device's credential).
  function listDevices() {
    return devices
      .filter((d) => !d.revoked)
      .map(({ device_id, name, last_seen, created_at, primary }) => ({
        device_id,
        name,
        last_seen,
        created_at,
        primary,
      }));
  }

  // Whole-box reset: drop every device and re-seed a single fresh primary with
  // the given (new) box_token. Used by /auth/revoke with no device target.
  function resetAll(token) {
    devices = [];
    seedPrimary(token);
  }

  function primary() {
    return findPrimary();
  }

  return {
    seedPrimary,
    authorize,
    claim,
    getDevice,
    revokeDevice,
    listDevices,
    resetAll,
    primary,
    persist,
    serialize: () => ({ devices }),
  };
}
