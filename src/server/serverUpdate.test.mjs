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
  manifestUrl,
  createOpencodeUpdateForwarder,
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
    // The bus envelope nests per-kind fields inside `payload` (see
    // src/server/events.mjs comment + the publish call in serverUpdate.mjs) —
    // the renderer's dispatchFrame destructures `{kind, payload}` so the
    // listener sees `{version, notesUrl}` as the payload object.
    assert.equal(evt.payload?.version, "9.9.9");
    assert.equal(evt.payload?.notesUrl, "https://mantaui.com/releases");
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
      payload: { version: r.version, notesUrl: r.notesUrl ?? null },
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
      payload: { version: r.version, notesUrl: r.notesUrl ?? null },
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
  assert.equal(updateEvents(bus)[0].payload?.version, "9.9.9");
  assert.equal(updateEvents(bus)[1].payload?.version, "10.0.0");
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

// ---------------------------------------------------------------------------
// Channel routing.
//
// THE BUG THIS LOCKS IN: the manifest URL was a hardcoded prod constant, so a
// box installed with MANTA_CHANNEL=staging checked the PROD manifest and
// updated itself onto PROD builds. The staging track was published and live,
// but nothing could follow it — staging drifted versions behind and no one
// noticed, because the failure is silent and looks exactly like "no update".
// ---------------------------------------------------------------------------

// Run `fn` with MANTA_CHANNEL set to `value` (or unset when null), always
// restoring the previous value. Shared because these cases differ only in the
// channel and the expected URL — repeating the save/restore dance per test is
// what the duplication gate flagged.
function withChannel(value, fn) {
  const prev = process.env.MANTA_CHANNEL;
  if (value === null) delete process.env.MANTA_CHANNEL;
  else process.env.MANTA_CHANNEL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MANTA_CHANNEL;
    else process.env.MANTA_CHANNEL = prev;
  }
}

const PROD_FEED = "https://mantaui.com/updates/server.json";

// prod / staging / dev / unset / garbage, in one table. The staging row is THE
// regression: it used to resolve to PROD_FEED, so a staging box updated itself
// onto prod builds.
for (const { name, channel, expected } of [
  { name: "prod → the prod feed", channel: "prod", expected: PROD_FEED },
  {
    name: "REGRESSION staging → the STAGING feed, not prod",
    channel: "staging",
    expected: "https://mantaui.com/staging/updates/server.json",
  },
  { name: "dev has no feed at all (null, never a prod fallback)", channel: "dev", expected: null },
  { name: "unset falls back to prod", channel: null, expected: PROD_FEED },
  { name: "unrecognised falls back to prod", channel: "banana", expected: PROD_FEED },
]) {
  test(`manifestUrl: ${name}`, () => {
    withChannel(channel, () => {
      assert.equal(manifestUrl(), expected);
    });
  });
}

test("createUpdateCheck fetches the channel's feed, not a hardcoded one", async () => {
  const seen = [];
  const check = createUpdateCheck({
    currentVersion: "0.0.1",
    url: "https://mantaui.com/staging/updates/server.json",
    fetchManifest: async (u) => {
      seen.push(u);
      return { version: "9.9.9" };
    },
  });
  const res = await check.tick();
  assert.deepEqual(seen, ["https://mantaui.com/staging/updates/server.json"]);
  assert.equal(res.available, true);
});

test("createUpdateCheck on a feedless (dev) build reports no update and never fetches", async () => {
  let called = 0;
  const check = createUpdateCheck({
    currentVersion: "0.0.1",
    url: null,
    fetchManifest: async () => {
      called++;
      return { version: "9.9.9" };
    },
  });
  const res = await check.tick();
  assert.equal(res.available, false);
  assert.equal(called, 0, "a dev build must not reach for a public feed");
});

// ---------------------------------------------------------------------------
// createOpencodeUpdateForwarder (BET-1016).
//
// Maps opencode's own `installation.update-available` onto the EXISTING
// serverUpdateAvailable bus event. The dedup gate is the exact behaviour the
// issue asks to lock in: opencode may emit the same version repeatedly and the
// banner must not re-raise for a version already shown.
// ---------------------------------------------------------------------------

const opencodeUpdate = (v) => ({
  type: "installation.update-available",
  properties: { version: v },
});

test("forwarder: maps an opencode update onto serverUpdateAvailable", () => {
  const onEvent = createOpencodeUpdateForwarder();
  assert.deepEqual(onEvent(opencodeUpdate("1.18.18")), {
    kind: "serverUpdateAvailable",
    payload: { version: "1.18.18", notesUrl: null },
  });
});

test("forwarder: returns null for non-update opencode events", () => {
  const onEvent = createOpencodeUpdateForwarder();
  assert.equal(onEvent({ type: "message.updated", properties: {} }), null);
  assert.equal(onEvent(null), null);
  assert.equal(onEvent(undefined), null);
});

test("forwarder: ignores events without a usable version", () => {
  const onEvent = createOpencodeUpdateForwarder();
  // missing properties / missing version / non-string version
  assert.equal(onEvent({ type: "installation.update-available" }), null);
  assert.equal(onEvent({ type: "installation.update-available", properties: {} }), null);
  assert.equal(onEvent(opencodeUpdate("")), null);
  assert.equal(onEvent({ type: "installation.update-available", properties: { version: 42 } }), null);
});

test("forwarder: dedup — repeated same-version events publish ONCE", () => {
  const onEvent = createOpencodeUpdateForwarder();
  assert.ok(onEvent(opencodeUpdate("1.18.18")));
  assert.equal(onEvent(opencodeUpdate("1.18.18")), null, "same version must not re-raise");
  assert.equal(onEvent(opencodeUpdate("1.18.18")), null);
});

test("forwarder: gate advances — a strictly newer version re-raises", () => {
  const onEvent = createOpencodeUpdateForwarder();
  assert.deepEqual(onEvent(opencodeUpdate("1.18.10")), {
    kind: "serverUpdateAvailable",
    payload: { version: "1.18.10", notesUrl: null },
  });
  assert.equal(onEvent(opencodeUpdate("1.18.10")), null);
  // a genuinely newer version bumps the gate and publishes again
  assert.deepEqual(onEvent(opencodeUpdate("1.18.18")), {
    kind: "serverUpdateAvailable",
    payload: { version: "1.18.18", notesUrl: null },
  });
  assert.equal(onEvent(opencodeUpdate("1.18.18")), null);
});

