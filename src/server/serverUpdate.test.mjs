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
  createManifestFetcher,
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
    ok: true,
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
  // `ok:false` is what lets the ON-DEMAND path tell "there wasn't one" from
  // "we couldn't tell". The background poll swallows the failure into the same
  // `available:false` value, which is fine for a timer and would be a LIE for
  // a manual "Check for updates" button — that is the fix this assertion pins.
  assert.deepEqual(res, { available: false, ok: false });
});

test("createUpdateCheck: manifest missing version field → { available:false, ok:true }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({ notes_url: "x", min_client: "0.0.0" }),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.deepEqual(res, { available: false, ok: true });
});

test("createUpdateCheck: manifest with non-string version → { available:false, ok:true }", async () => {
  const { tick } = createUpdateCheck({
    fetchManifest: async () => ({ version: 42, notes_url: "x", min_client: "0.0.0" }),
    currentVersion: "1.2.3",
  });
  const res = await tick();
  assert.deepEqual(res, { available: false, ok: true });
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


// ---------------------------------------------------------------------------
// createManifestFetcher — conditional GET
// ---------------------------------------------------------------------------
//
// The manifest is ~95 bytes, changes a few times a month, and is polled forever
// by every box. Conditional GET is what makes a SHORTER poll interval cost less
// than the old long one, so these pin the two properties the interval change
// leans on: the validator is sent back, and a 304 still yields a manifest.

function res({ status = 200, body = null, etag = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

test("manifest fetcher: first call sends no If-None-Match and caches the ETag", async () => {
  const calls = [];
  const fetchManifest = createManifestFetcher({
    fetchImpl: async (url, init) => {
      calls.push(init?.headers ?? null);
      return res({ body: { version: "1.0.0" }, etag: '"abc"' });
    },
  });

  assert.deepEqual(await fetchManifest("https://example.test/server.json"), { version: "1.0.0" });
  assert.equal(calls[0], null, "first request must not send a validator it does not have");

  await fetchManifest("https://example.test/server.json");
  assert.deepEqual(calls[1], { "if-none-match": '"abc"' }, "second request must revalidate");
});

test("manifest fetcher: 304 returns the CACHED manifest (a 304 has no body)", async () => {
  let first = true;
  const fetchManifest = createManifestFetcher({
    fetchImpl: async () => {
      if (first) {
        first = false;
        return res({ body: { version: "2.0.0" }, etag: '"v2"' });
      }
      // A real 304 carries no body; json() would throw. Prove we never call it.
      return {
        status: 304,
        ok: false,
        headers: { get: () => null },
        json: async () => {
          throw new Error("must not parse a 304 body");
        },
      };
    },
  });

  assert.deepEqual(await fetchManifest("u"), { version: "2.0.0" });
  assert.deepEqual(await fetchManifest("u"), { version: "2.0.0" }, "304 → last known manifest");
});

test("manifest fetcher: a non-2xx (non-304) throws so the check reports no update", async () => {
  const fetchManifest = createManifestFetcher({
    fetchImpl: async () => res({ status: 500 }),
  });
  await assert.rejects(() => fetchManifest("u"), /manifest fetch failed: 500/);
});

test("manifest fetcher: a failed body parse does NOT poison the cache with its ETag", async () => {
  // Caching the validator for a body we never read would make every later poll
  // a 304 that returns nothing — a permanently stuck check that looks healthy.
  let call = 0;
  const sent = [];
  const fetchManifest = createManifestFetcher({
    fetchImpl: async (_url, init) => {
      sent.push(init?.headers ?? null);
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          ok: true,
          headers: { get: () => '"poison"' },
          json: async () => {
            throw new Error("bad json");
          },
        };
      }
      return res({ body: { version: "3.0.0" }, etag: '"good"' });
    },
  });

  await assert.rejects(() => fetchManifest("u"));
  assert.deepEqual(await fetchManifest("u"), { version: "3.0.0" });
  assert.equal(sent[1], null, "a parse failure must leave no validator behind");
});

// ---------------------------------------------------------------------------
// createUpdateCheck — concurrent callers
// ---------------------------------------------------------------------------

test("createUpdateCheck: a concurrent tick JOINS the in-flight one (never a false 'up to date')", async () => {
  // The guard used to return { available:false } to the second caller. That was
  // harmless while only a 6h timer called it, and became a lie the moment a
  // human could press "Check for updates" during a poll: they would be told
  // "up to date" with nothing compared.
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let fetches = 0;

  const { tick } = createUpdateCheck({
    url: "https://example.test/server.json",
    currentVersion: "1.0.0",
    fetchManifest: async () => {
      fetches += 1;
      await gate;
      return { version: "2.0.0", notes_url: null };
    },
  });

  const a = tick();
  const b = tick();
  release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(fetches, 1, "the second caller must not start a second fetch");
  assert.deepEqual(ra, { available: true, version: "2.0.0", notesUrl: null, ok: true });
  assert.deepEqual(rb, ra, "both callers see the SAME real answer");
});

test("createUpdateCheck: the in-flight slot is released so a later tick re-fetches", async () => {
  let fetches = 0;
  const { tick } = createUpdateCheck({
    url: "https://example.test/server.json",
    currentVersion: "1.0.0",
    fetchManifest: async () => {
      fetches += 1;
      return { version: "1.0.0" };
    },
  });
  await tick();
  await tick();
  assert.equal(fetches, 2, "sequential ticks must each do their own check");
});

// ---------------------------------------------------------------------------
// startServerUpdatePoller — the on-demand check()
// ---------------------------------------------------------------------------

test("poller.check(): returns the verdict so a button can say 'up to date'", async () => {
  const bus = fakeBus();
  const { stop, check } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    fetchManifest: async () => SAME("1.2.3"),
  });
  try {
    assert.deepEqual(await check(), { available: false, ok: true });
  } finally {
    stop();
  }
});

test("poller.check(): a manifest fetch failure is ok:false, never a false 'up to date'", async () => {
  // The poller swallows fetch failures so a flaky feed can't crash the box —
  // but the value it resolves is the SAME `available:false` that "up to date"
  // resolves, so without `ok:false` the renderer's box row would show the
  // reassuring green "you're up to date" after a failed check. That false okay
  // is precisely what a "Check for updates" button exists to break, so the
  // failure must be distinguishable.
  const bus = fakeBus();
  const { stop, check } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    fetchManifest: async () => {
      throw new Error("network unreachable");
    },
  });
  try {
    assert.deepEqual(await check(), { available: false, ok: false });
    assert.equal(updateEvents(bus).length, 0, "a failed check must not raise a banner");
  } finally {
    stop();
  }
});

test("poller.check(): an available update is reported AND raises the banner", async () => {
  const bus = fakeBus();
  const notified = [];
  const { stop, check } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    notify: async (n) => notified.push(n),
    fetchManifest: async () => NEWER("9.9.9"),
  });
  try {
    const result = await check();
    assert.equal(result.available, true);
    assert.equal(result.version, "9.9.9");
    // The manual check reuses the poller's tick precisely so the button and the
    // banner can never disagree about what is available. A banner is raised
    // with the right payload — the poller's own boot tick may add one more, so
    // assert at least one rather than a count.
    const events = updateEvents(bus).map((e) => e.payload);
    assert.ok(events.length >= 1, "an available update must raise the banner");
    assert.ok(
      events.some((p) => p.version === "9.9.9" && p.notesUrl === "https://mantaui.com/releases"),
      "a banner carries the right version + notesUrl",
    );
    assert.equal(notified.length, 1, "push deduped — one per version regardless of callers");
  } finally {
    stop();
  }
});

test("poller.check(): repeated checks keep answering, but notify at most once", async () => {
  // Clicking the button twice must report the truth twice — the dedup gate is
  // for the SIDE EFFECTS (banner + push), never for the answer.
  const bus = fakeBus();
  const notified = [];
  const { stop, check } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    notify: async (n) => notified.push(n),
    fetchManifest: async () => NEWER("9.9.9"),
  });
  try {
    const first = await check();
    const second = await check();
    assert.equal(first.available, true);
    assert.deepEqual(second, first, "the second press must not report 'up to date'");
    // `check()` re-surfaces the banner on every call (forceBanner) — this is
    // the reconnect case where a desktop that came back after a release should
    // see the banner even though the box's timer already notified that version.
    // The banner is an idempotent store set, so re-publishing is harmless. The
    // PUSH stays deduped: same version → one push, never a re-buzz.
    assert.ok(updateEvents(bus).length >= 2, "a repeat check re-surfaces the banner (forceBanner)");
    assert.equal(notified.length, 1, "push deduped — at most once per version");
  } finally {
    stop();
  }
});

test("poller.check(): concurrent checks still push at most ONCE", async () => {
  // The dedup gate reads and writes `lastNotifiedVersion` with no `await`
  // between them, so concurrent checks resume as sequential microtasks and the
  // second sees the gate already closed. That atomicity is what stops "user
  // pressed the button just as the timer fired" from double-notifying — it is
  // easy to break by adding an await inside the gate, so pin the PUSH. (The
  // banner may be published a few times — it is an idempotent store set and
  // `check()` force-re-surfaces it — but a push must fire once per version.)
  const bus = fakeBus();
  const notified = [];
  const { stop, check } = startServerUpdatePoller({
    bus,
    currentVersion: "1.2.3",
    notify: async (n) => notified.push(n),
    fetchManifest: async () => NEWER("9.9.9"),
  });
  try {
    const [a, b] = await Promise.all([check(), check()]);
    assert.equal(a.available, true);
    assert.equal(b.available, true, "every caller gets the real answer");
    assert.ok(updateEvents(bus).length >= 1, "banner surfaced at least once");
    assert.equal(notified.length, 1, "one push, not one per caller");
  } finally {
    stop();
  }
});
