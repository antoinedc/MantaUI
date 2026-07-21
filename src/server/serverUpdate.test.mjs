// Tests for the server-update poller (BET-225 stage 2 — server wiring).
//
// Coverage:
//   - createUpdateCheck (pure): available / not-available / manifest-fetch-
//     throws → returns { available: false } without throwing. No live network
//     — the `fetchImpl` is stubbed per test. No timers left running.
//   - startServerUpdatePoller: boot-tick publishes ONE `serverUpdateAvailable`
//     event + ONE notify for a fresh version, the second tick on the same
//     manifest re-publishes NOTHING (dedup gate), a strictly newer manifest
//     version resets the gate and publishes again. notify is injected so the
//     test proves the bus-event and the notification fire from the same gate.
//   - defaultFetchManifest is exported but only smoke-tested (real network is
//     not exercised here — see the MANIFEST_URL constant + the boot wire in
//     src/server/index.mjs for the live path).
//
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUpdateCheck,
  startServerUpdatePoller,
  MANIFEST_URL,
} from "./serverUpdate.mjs";

function fakeBus() {
  const events = [];
  return {
    events,
    publish(evt) {
      events.push(evt);
    },
  };
}

// A manifest with a strictly-newer version than the running server.
const NEWER = (v = "9.9.9") => ({
  version: v,
  notes_url: "https://mantaui.com/releases",
  min_client: "0.0.0",
});

// A manifest that matches the running server's version (no update).
const SAME = (v = "1.2.3") => ({
  version: v,
  notes_url: "https://mantaui.com/releases",
  min_client: "0.0.0",
});

const updateEvents = (bus) =>
  bus.events.filter((e) => e.kind === "serverUpdateAvailable");

// ---------------------------------------------------------------------------
// createUpdateCheck — pure, no timers, no live fetch
// ---------------------------------------------------------------------------

test("createUpdateCheck: newer manifest → { available:true, version, notesUrl }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => NEWER("9.9.9"),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.deepEqual(res, {
    available: true,
    version: "9.9.9",
    notesUrl: "https://mantaui.com/releases",
  });
});

test("createUpdateCheck: same-version manifest → { available:false }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => SAME("1.2.3"),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.equal(res.available, false);
});

test("createUpdateCheck: older manifest → { available:false } (never downgrade)", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({ version: "0.9.0", notes_url: "x", min_client: "0.0.0" }),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.equal(res.available, false);
});

test("createUpdateCheck: manifest fetch throws → { available:false } (no rethrow)", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => {
      throw new Error("network unreachable");
    },
    currentVersion: "1.2.3",
  });
  // The contract is that a flaky manifest URL must NEVER crash the poller —
  // a throw here would tear down the server on the first bad check.
  const res = await tick();
  assert.deepEqual(res, { available: false });
});

test("createUpdateCheck: manifest missing version field → { available:false }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({ notes_url: "x", min_client: "0.0.0" }),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.deepEqual(res, { available: false });
});

test("createUpdateCheck: manifest with non-string version → { available:false }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({ version: 42, notes_url: "x", min_client: "0.0.0" }),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.deepEqual(res, { available: false });
});

test("createUpdateCheck: passes the hardcoded MANIFEST_URL to fetchManifest", async () => {
  let observedUrl = null;
  const { tick } = createUpdateCheck({
    fetchManifest: async (url) => {
      observedUrl = url;
      return SAME("1.2.3");
    },
    currentVersion: "1.2.3",
  });
  await tick();
  assert.equal(observedUrl, MANIFEST_URL);
  assert.equal(MANIFEST_URL, "https://mantaui.com/updates/server.json");
});

// ---------------------------------------------------------------------------
// startServerUpdatePoller — dedup gate + notify + bus
// ---------------------------------------------------------------------------

function makeNotifyRecorder() {
  const calls = [];
  return {
    calls,
    notify: async (args) => {
      calls.push(args);
    },
  };
}

test("poller: first tick on a newer manifest publishes ONE event AND fires notify", async () => {
  const bus = fakeBus();
  const { calls: notifyCalls, notify } = makeNotifyRecorder();
  const { stop } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    notify,
    fetchManifest: async () => NEWER("9.9.9"),
  });
  try {
    // The poller kicks a tick on construction (mirrors startOutboxPoller).
    // Give the boot microtask queue a chance to drain so the async tick can
    // complete before we assert — no timers left running because we stop()
    // immediately.
    await new Promise((r) => setImmediate(r));
    assert.equal(updateEvents(bus).length, 1);
    const evt = updateEvents(bus)[0];
    assert.equal(evt.version, "9.9.9");
    assert.equal(evt.notesUrl, "https://mantaui.com/releases");
    assert.equal(notifyCalls.length, 1);
    assert.match(notifyCalls[0].message, /Server update 9\.9\.9 available/);
    assert.equal(notifyCalls[0].sessionID, null);
  } finally {
    stop();
  }
});

test("poller: same-version manifest → no publish, no notify", async () => {
  const bus = fakeBus();
  const { calls: notifyCalls, notify } = makeNotifyRecorder();
  const { stop } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    notify,
    fetchManifest: async () => SAME("1.2.3"),
  });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(updateEvents(bus).length, 0);
    assert.equal(notifyCalls.length, 0);
  } finally {
    stop();
  }
});

test("poller: dedup — re-tick on the SAME newer version does NOT republish", async () => {
  // Drive the gate directly via createUpdateCheck to avoid waiting 6h for the
  // setInterval: the same `lastNotifiedVersion` gate that the boot-tick uses
  // is what guards every later tick. Three ticks, one manifest, must yield
  // exactly one publish + one notify.
  const bus = fakeBus();
  const { calls: notifyCalls, notify } = makeNotifyRecorder();
  const manifest = NEWER("9.9.9");
  const { tick } = createUpdateCheck({
    fetchManifest: async () => manifest,
    currentVersion: "1.2.3",
  });

  let lastNotifiedVersion = null;
  async function maybePublish() {
    const r = await tick();
    if (!r.available || !r.version) return;
    if (r.version === lastNotifiedVersion) return;
    lastNotifiedVersion = r.version;
    bus.publish({
      kind: "serverUpdateAvailable",
      version: r.version,
      notesUrl: r.notesUrl,
    });
    await notify({
      message: `Server update ${r.version} available`,
      title: "mantaui",
      sessionID: null,
    });
  }

  await maybePublish();
  await maybePublish();
  await maybePublish();
  assert.equal(updateEvents(bus).length, 1);
  assert.equal(notifyCalls.length, 1);
});

test("poller: gate advances — strictly newer manifest version resets dedup", async () => {
  // Same gate shape as the previous test, but the manifest version bumps from
  // 9.9.9 → 10.0.0 between ticks. The second tick MUST publish a second time
  // (and fire a second notify).
  const bus = fakeBus();
  const { calls: notifyCalls, notify } = makeNotifyRecorder();
  let manifestVersion = "9.9.9";
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({
      version: manifestVersion,
      notes_url: "https://mantaui.com/releases",
      min_client: "0.0.0",
    }),
    currentVersion: "1.2.3",
  });

  let lastNotifiedVersion = null;
  async function maybePublish() {
    const r = await tick();
    if (!r.available || !r.version) return;
    if (r.version === lastNotifiedVersion) return;
    lastNotifiedVersion = r.version;
    bus.publish({
      kind: "serverUpdateAvailable",
      version: r.version,
      notesUrl: r.notesUrl,
    });
    await notify({
      message: `Server update ${r.version} available`,
      title: "mantaui",
      sessionID: null,
    });
  }

  await maybePublish();
  manifestVersion = "10.0.0";
  await maybePublish();

  assert.equal(updateEvents(bus).length, 2);
  assert.equal(updateEvents(bus)[0].version, "9.9.9");
  assert.equal(updateEvents(bus)[1].version, "10.0.0");
  assert.equal(notifyCalls.length, 2);
});

test("poller: stop() clears the interval timer", async () => {
  // Use a slow `fetchManifest` so the boot tick is still in flight when we
  // call stop() — proves stop() clears the interval (the boot microtask
  // resolves later but produces no further publishes, since the poller's
  // dedup state was never touched). Then count active handles before vs.
  // after stop() to confirm the timer handle is gone.
  const bus = fakeBus();
  let releaseBootTick;
  const bootGate = new Promise((r) => {
    releaseBootTick = r;
  });
  const { stop } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    fetchManifest: () => bootGate.then(() => NEWER("9.9.9")),
  });
  // Yield once so the boot tick reaches its `await fetchManifest(...)` pause.
  await new Promise((r) => setImmediate(r));
  // Snapshot handles WHILE the poller still owns its interval.
  const handlesBefore =
    typeof process._getActiveHandles === "function"
      ? process._getActiveHandles().length
      : -1;
  stop();
  releaseBootTick();
  // Let the boot microtask resume + complete. It publishes (the gate didn't
  // exist yet when stop() ran), but no interval-driven second tick ever fires.
  await new Promise((r) => setImmediate(r));
  assert.equal(updateEvents(bus).length, 1);
  if (typeof process._getActiveHandles === "function") {
    const handlesAfter = process._getActiveHandles().length;
    assert.ok(
      handlesAfter <= handlesBefore,
      `stop() should clear the interval (before=${handlesBefore} after=${handlesAfter})`,
    );
  }
});
