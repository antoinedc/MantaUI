import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWindow, createUsagePoller, ADAPTERS, rateLimitBackoffMs, carryForward } from "./usage.mjs";
import { claudeAdapter } from "./usageAdapters/claude.mjs";
import { codexAdapter } from "./usageAdapters/codex.mjs";
import { kimiAdapter } from "./usageAdapters/kimi.mjs";

// ----------------------------------------------------------------------------
// Test harness: a fake `fetch`-shaped Response — never touches the network.
// ----------------------------------------------------------------------------

function fakeResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    json: async () => body,
  };
}

function makeAdapter(id, { detect, fetch: doFetch }) {
  return { id, providerIDs: [id], detect, fetch: doFetch };
}

// ----------------------------------------------------------------------------
// normalizeWindow — pure
// ----------------------------------------------------------------------------

test("normalizeWindow: pct passthrough, rounded and clamped to 0-100", () => {
  assert.equal(normalizeWindow({ pct: 55 }).pct, 55);
  assert.equal(normalizeWindow({ pct: 55.6 }).pct, 56);
  assert.equal(normalizeWindow({ pct: 130 }).pct, 100);
  assert.equal(normalizeWindow({ pct: -5 }).pct, 0);
});

test("normalizeWindow: derives pct from used + limit", () => {
  const w = normalizeWindow({ used: 139, limit: 200 });
  assert.equal(w.pct, 70); // round(139/200*100) = round(69.5) = 70
  assert.equal(w.used, 139);
  assert.equal(w.limit, 200);
});

test("normalizeWindow: derives used from remaining + limit, then pct", () => {
  const w = normalizeWindow({ remaining: 61, limit: 200 });
  assert.equal(w.used, 139);
  assert.equal(w.limit, 200);
  assert.equal(w.pct, 70);
});

test("normalizeWindow: counts may arrive as strings", () => {
  const w = normalizeWindow({ used: "139", limit: "200" });
  assert.equal(w.used, 139);
  assert.equal(w.limit, 200);
  assert.equal(w.pct, 70);

  const w2 = normalizeWindow({ remaining: "61", limit: "200" });
  assert.equal(w2.used, 139);
  assert.equal(w2.pct, 70);
});

test("normalizeWindow: limit === 0 (or missing denominators) drops the window", () => {
  assert.equal(normalizeWindow({ used: 5, limit: 0 }), null);
  assert.equal(normalizeWindow({ remaining: 5, limit: 0 }), null);
  assert.equal(normalizeWindow({ used: 5 }), null); // no limit at all
  assert.equal(normalizeWindow({ limit: 200 }), null); // no used/remaining
  assert.equal(normalizeWindow({}), null);
  assert.equal(normalizeWindow(null), null);
  assert.equal(normalizeWindow(undefined), null);
});

// Reviewer Nit 1: pct-passthrough wins over a `limit: 0` (correct, per the
// rule order), but `limit: 0` must never ride along onto the window — a
// popover doing `used / limit` would render "5 / 0".
test("normalizeWindow: an explicit pct never lets a limit:0 reach the window", () => {
  const w = normalizeWindow({ pct: 50, limit: 0 });
  assert.equal(w.pct, 50);
  assert.equal("limit" in w, false);

  // used:5 + limit:0, but pct also given → pct wins, used still reported,
  // limit still dropped (used alone without a limit is a normal, already-
  // supported shape — e.g. claude never sends absolutes at all).
  const w2 = normalizeWindow({ pct: 50, used: 5, limit: 0 });
  assert.equal(w2.used, 5);
  assert.equal("limit" in w2, false);
});

test("normalizeWindow: resetsAt — epoch seconds vs epoch ms vs ISO string", () => {
  // < 1e12 → treated as epoch seconds.
  assert.equal(normalizeWindow({ pct: 10, resetsAt: 1735689600 }).resetsAt, 1735689600000);
  // >= 1e12 → already ms.
  assert.equal(normalizeWindow({ pct: 10, resetsAt: 1735689600000 }).resetsAt, 1735689600000);
  // ISO string → Date.parse.
  const iso = normalizeWindow({ pct: 10, resetsAt: "2025-01-01T00:00:00.000Z" });
  assert.equal(iso.resetsAt, Date.parse("2025-01-01T00:00:00.000Z"));
  // Unparseable string → field dropped, window still valid (pct alone is enough).
  const bad = normalizeWindow({ pct: 10, resetsAt: "not-a-date" });
  assert.equal(bad.resetsAt, undefined);
  assert.equal(bad.pct, 10);
});

test("normalizeWindow: non-finite counts are dropped, not coerced to NaN/Infinity", () => {
  // used fails to coerce → falls through to "missing denominators" → null.
  assert.equal(normalizeWindow({ used: "abc", limit: 200 }), null);
  assert.equal(normalizeWindow({ remaining: "abc", limit: 200 }), null);
  assert.equal(normalizeWindow({ pct: "abc" }), null);
  // A window's own output never carries NaN/Infinity.
  const w = normalizeWindow({ used: 139, limit: 200 });
  assert.equal(Number.isFinite(w.pct), true);
});

test("normalizeWindow: kind/label/binding pass through", () => {
  const w = normalizeWindow({ kind: "weekly", label: "Weekly", pct: 41, binding: true });
  assert.equal(w.kind, "weekly");
  assert.equal(w.label, "Weekly");
  assert.equal(w.binding, true);
  // binding omitted entirely when not explicitly true.
  const w2 = normalizeWindow({ pct: 41 });
  assert.equal("binding" in w2, false);
});

// ----------------------------------------------------------------------------
// ADAPTERS registry
// ----------------------------------------------------------------------------

test("ADAPTERS registers exactly the three built-in providers", () => {
  const ids = ADAPTERS.map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude", "codex", "kimi"]);
  for (const a of ADAPTERS) {
    assert.equal(typeof a.detect, "function");
    assert.equal(typeof a.fetch, "function");
    assert.equal(Array.isArray(a.providerIDs), true);
  }
});

// This repo's real opencode providerID for Kimi is "kimi-for-coding" — NOT
// "moonshot" or "kimi" — everywhere else in the codebase (src/server/
// subscriptionProviders.mjs, src/renderer/chatUtils.ts). Pinning the exact
// array (not just "contains") so a stray extra id can't silently creep back
// in and never match the active model in BET-USAGE-B's dial.
test("kimi adapter's providerIDs is exactly [\"kimi-for-coding\"]", () => {
  assert.deepEqual(kimiAdapter.providerIDs, ["kimi-for-coding"]);
});

// ----------------------------------------------------------------------------
// createUsagePoller
// ----------------------------------------------------------------------------

test("poller skips an adapter whose detect() is false — no snapshot, no fetch call", async () => {
  let fetchCalls = 0;
  const off = makeAdapter("off", {
    detect: async () => false,
    fetch: async () => {
      fetchCalls++;
      return { windows: [{ kind: "session", label: "s", pct: 1 }] };
    },
  });
  const on = makeAdapter("on", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 50 }] }),
  });
  const poller = createUsagePoller({ adapters: [off, on], now: () => 1000 });
  await poller.tick();
  assert.equal(fetchCalls, 0);
  assert.equal(poller.snapshots.length, 1);
  assert.equal(poller.snapshots[0].provider, "on");
  // BET-USAGE-B matches the renderer's active model against `providerIDs`,
  // not `provider` — pin that the poller copies it straight from the
  // adapter's own registry entry.
  assert.deepEqual(poller.snapshots[0].providerIDs, ["on"]);
});

test("poller quarantines a throwing adapter — the others' snapshots stay intact", async () => {
  const broken = makeAdapter("broken", {
    detect: async () => true,
    fetch: async () => {
      throw new Error("upstream shape changed");
    },
  });
  const healthy = makeAdapter("healthy", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 33 }] }),
  });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const poller = createUsagePoller({ adapters: [broken, healthy], now: () => 1000 });
    await poller.tick();
    assert.equal(poller.snapshots.length, 1);
    assert.equal(poller.snapshots[0].provider, "healthy");
    assert.equal(warnings.some((a) => String(a[0]).includes("broken")), true);
  } finally {
    console.warn = originalWarn;
  }
});

test("poller drops an adapter whose response has zero usable windows", async () => {
  const empty = makeAdapter("empty", {
    detect: async () => true,
    fetch: async () => ({ windows: [] }),
  });
  const poller = createUsagePoller({ adapters: [empty], now: () => 1000 });
  await poller.tick();
  assert.equal(poller.snapshots.length, 0);
});

test("poller: a 429 with Retry-After backs off only that adapter, for exactly that long", async () => {
  let nowMs = 1_700_000_000_000;
  let rlFetchCalls = 0;
  const rateLimited = makeAdapter("rl", {
    detect: async () => true,
    fetch: async () => {
      rlFetchCalls++;
      if (rlFetchCalls === 1) {
        const err = new Error("rate limited");
        err.status = 429;
        err.retryAfterMs = 5 * 60_000; // 5 min — above floor, below ceiling, honoured verbatim
        throw err;
      }
      return { windows: [{ kind: "session", label: "s", pct: 10 }] };
    },
  });
  let okFetchCalls = 0;
  const ok = makeAdapter("ok", {
    detect: async () => true,
    fetch: async () => {
      okFetchCalls++;
      return { windows: [{ kind: "session", label: "s", pct: 20 }] };
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({ adapters: [rateLimited, ok], now: () => nowMs });

    await poller.tick(); // rl fails (429, backoff 5 min); ok succeeds
    assert.equal(rlFetchCalls, 1);
    assert.equal(okFetchCalls, 1);
    assert.equal(poller.snapshots.some((s) => s.provider === "rl"), false);

    nowMs += 2 * 60_000; // still inside the 5-minute backoff window
    await poller.tick();
    assert.equal(rlFetchCalls, 1, "rl must not be fetched again while backed off");
    assert.equal(okFetchCalls, 2);

    nowMs += 4 * 60_000; // 6 minutes elapsed since the 429 — backoff has expired
    await poller.tick();
    assert.equal(rlFetchCalls, 2, "rl is fetched again once its backoff expires");
    assert.equal(poller.snapshots.find((s) => s.provider === "rl").windows[0].pct, 10);
  } finally {
    console.warn = originalWarn;
  }
});

test("poller: a bare 429 with no Retry-After floors at 2 minutes", async () => {
  let nowMs = 0;
  let calls = 0;
  const rl = makeAdapter("rl", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      const err = new Error("rate limited");
      err.status = 429; // no retryAfterMs
      throw err;
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({ adapters: [rl], now: () => nowMs });
    await poller.tick();
    assert.equal(calls, 1);

    nowMs += 1 * 60_000; // just under the 2-minute floor (even retry-after: 0 lands here)
    await poller.tick();
    assert.equal(calls, 1);

    nowMs += 2 * 60_000; // now past 2 minutes total — retried
    await poller.tick();
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("rateLimitBackoffMs: clamps into the 2-15 minute band", () => {
  assert.equal(rateLimitBackoffMs(undefined), 120_000);
  assert.equal(rateLimitBackoffMs(0), 120_000);
  assert.equal(rateLimitBackoffMs(30_000), 120_000); // below floor
  assert.equal(rateLimitBackoffMs(300_000), 300_000); // in band
  assert.equal(rateLimitBackoffMs(3_600_000), 900_000); // above ceiling
});

test("poller: a 429 carrying retry-after: 0 backs off 2 minutes, not 15 (regression)", async () => {
  let nowMs = 0;
  let calls = 0;
  const rl = makeAdapter("rl", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      const err = new Error("rate limited");
      err.status = 429;
      err.retryAfterMs = 0; // Anthropic's literal retry-after: 0
      throw err;
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({ adapters: [rl], now: () => nowMs });
    await poller.tick();
    assert.equal(calls, 1);

    nowMs += 1 * 60_000; // before the 2-minute floor → still backed off
    await poller.tick();
    assert.equal(calls, 1);

    nowMs += 2 * 60_000; // past 2 minutes → retried (NOT after 15)
    await poller.tick();
    assert.equal(calls, 2);
  } finally {
    console.warn = originalWarn;
  }
});

test("poller: a failing adapter's snapshot is carried forward (same ref, unchanged fetchedAt, nothing republished)", async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return { windows: [{ kind: "session", label: "s", pct: 42 }] };
    },
  });
  const published = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({
      adapters: [adapter],
      now: () => nowMs,
      publish: (evt) => published.push(evt),
    });

    await poller.tick(); // success
    const first = poller.snapshots[0];
    assert.equal(first.fetchedAt, 1_000_000);
    assert.equal(published.length, 1);

    nowMs += 60_000; // 1 minute later the adapter throws
    await poller.tick();
    assert.equal(calls, 2);
    assert.equal(poller.snapshots.length, 1, "snapshot still present after the failed tick");
    assert.equal(poller.snapshots[0], first, "the SAME object reference is carried forward");
    assert.equal(poller.snapshots[0].fetchedAt, 1_000_000, "fetchedAt untouched");
    assert.equal(published.length, 1, "the failed tick put nothing on the bus");
  } finally {
    console.warn = originalWarn;
  }
});

test("poller: carry-forward across the backoff window keeps the snapshot present", async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      if (calls === 2) {
        const err = new Error("rate limited");
        err.status = 429;
        throw err;
      }
      return { windows: [{ kind: "session", label: "s", pct: 42 }] };
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs });
    await poller.tick(); // success
    assert.equal(poller.snapshots.length, 1);
    const first = poller.snapshots[0];

    nowMs += 1 * 60_000; // 1 min later — bare 429 sets the 2-minute floor backoff
    await poller.tick();
    assert.equal(calls, 2, "adapter was called on the failing tick");
    assert.equal(poller.snapshots.length, 1, "snapshot present after the 429");

    nowMs += 30_000; // still inside the 2-min backoff — adapter not even called
    await poller.tick();
    assert.equal(calls, 2, "adapter not called while backed off");
    assert.equal(poller.snapshots.length, 1, "snapshot carried across the backoff window");
    assert.equal(poller.snapshots[0], first, "same reference carried");
  } finally {
    console.warn = originalWarn;
  }
});

test("poller: carry-forward expires after 30 minutes with no successful fetch", async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return { windows: [{ kind: "session", label: "s", pct: 42 }] };
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs });
    await poller.tick(); // success
    assert.equal(poller.snapshots.length, 1);

    nowMs += 31 * 60_000; // past the 30-minute carry-forward cap
    await poller.tick(); // fails again
    assert.equal(calls, 2);
    assert.equal(poller.snapshots.length, 0, "snapshot dropped once older than the carry cap");
  } finally {
    console.warn = originalWarn;
  }
});

test("poller: detect() flips to false → snapshot dropped on the very next tick, no carry-forward", async () => {
  let nowMs = 1_000_000;
  let detected = true;
  const adapter = makeAdapter("a", {
    detect: async () => detected,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 42 }] }),
  });
  const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs });
  await poller.tick(); // detected — snapshot present
  assert.equal(poller.snapshots.length, 1);

  nowMs += 60_000;
  detected = false; // credential gone — genuinely not connected
  await poller.tick();
  assert.equal(poller.snapshots.length, 0, "a missing credential clears the snapshot immediately");
});

// Reviewer Block (cycle 1): a content-identical tick must still refresh
// `fetchedAt` — the frozen typedef says it means "epoch ms of the
// successful fetch", not "epoch ms of the last tick whose content changed".
// The dedupe rule from the issue governs the BUS PUBLISH only, so this
// asserts BOTH halves with an advancing clock across three ticks whose
// numbers never change: publish fires exactly once, AND
// poller.snapshots[0].fetchedAt keeps advancing tick after tick (the poller
// is alive and re-confirming, not frozen).
test("poller: identical consecutive results publish exactly once, but fetchedAt still advances every tick", async () => {
  let nowMs = 1_000_000;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 42 }] }),
  });
  const published = [];
  const poller = createUsagePoller({
    adapters: [adapter],
    now: () => nowMs,
    publish: (evt) => published.push(evt),
  });

  await poller.tick();
  assert.equal(poller.snapshots[0].fetchedAt, 1_000_000);

  nowMs += 600_000; // a full poll interval (10 min) later, same numbers
  await poller.tick();
  assert.equal(poller.snapshots[0].fetchedAt, 1_600_000, "fetchedAt must advance on a healthy re-confirm");

  nowMs += 600_000;
  await poller.tick();
  assert.equal(poller.snapshots[0].fetchedAt, 2_200_000);

  // Content never changed across all three ticks — the bus stayed quiet.
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "usage.updated");
});

test("poller: a genuine content change publishes again", async () => {
  let pct = 10;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct }] }),
  });
  const published = [];
  const poller = createUsagePoller({
    adapters: [adapter],
    now: () => 1000,
    publish: (evt) => published.push(evt),
  });
  await poller.tick();
  pct = 11;
  await poller.tick();
  assert.equal(published.length, 2);
});

test("poller: in-flight guard prevents overlapping ticks", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return { windows: [{ kind: "session", label: "s", pct: 1 }] };
    },
  });
  const poller = createUsagePoller({ adapters: [adapter], now: () => 1000 });
  const p1 = poller.tick();
  const p2 = poller.tick(); // must be a same-tick no-op — inFlight is already true
  await Promise.all([p1, p2]);
  assert.equal(maxConcurrent, 1);
  assert.equal(calls, 1);
});

// ----------------------------------------------------------------------------
// Adapter: claude — captured sample payloads, fed inline (no fixture files)
// ----------------------------------------------------------------------------

test("claude adapter: utilization fraction (0-1) is converted to a percentage", async () => {
  const sample = {
    rate_limits: {
      five_hour: { utilization: 0.78, resets_at: 1735689600 },
      seven_day: { utilization: 0.41, resets_at: "2025-01-07T09:00:00.000Z" },
      seven_day_opus: { utilization: 0.64 },
      seven_day_sonnet: { used_percentage: 18 },
    },
  };
  const snap = await claudeAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readCredentials: async () => ({ accessToken: "tok" }),
  });
  assert.equal(snap.provider, "claude");
  assert.equal(snap.windows.length, 2);
  const session = snap.windows.find((w) => w.kind === "session");
  assert.equal(session.label, "Session (5h)");
  assert.equal(session.pct, 78);
  assert.equal(session.resetsAt, 1735689600000);
  const weekly = snap.windows.find((w) => w.kind === "weekly");
  assert.equal(weekly.pct, 41);
  assert.equal(weekly.resetsAt, Date.parse("2025-01-07T09:00:00.000Z"));
  assert.equal(snap.extras.find((e) => e.label === "Opus (7d)").value, "64%");
  assert.equal(snap.extras.find((e) => e.label === "Sonnet (7d)").value, "18%");
});

test("claude adapter: used_percentage is preferred over utilization when both are present", async () => {
  const sample = { rate_limits: { five_hour: { utilization: 0.5, used_percentage: 93 } } };
  const snap = await claudeAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readCredentials: async () => ({ accessToken: "tok" }),
  });
  assert.equal(snap.windows.find((w) => w.kind === "session").pct, 93);
});

test("claude adapter: live shape (2026-08) — pools at the top level, no rate_limits wrapper, utilization already 0-100", async () => {
  // Captured live against api.anthropic.com/api/oauth/usage (2026-08): NOT
  // wrapped in `rate_limits`, and `utilization` is already a 0-100
  // percentage rather than the documented 0-1 fraction.
  const sample = {
    five_hour: {
      utilization: 58.0,
      resets_at: "2026-08-13T14:20:00.464248+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day: {
      utilization: 64.0,
      resets_at: "2026-08-13T22:00:00.464272+00:00",
      limit_dollars: null,
      used_dollars: null,
      remaining_dollars: null,
    },
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
  const snap = await claudeAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readCredentials: async () => ({ accessToken: "tok" }),
  });
  assert.equal(snap.windows.length, 2);
  assert.equal(snap.windows.find((w) => w.kind === "session").pct, 58);
  assert.equal(snap.windows.find((w) => w.kind === "weekly").pct, 64);
  assert.equal("extras" in snap, false); // both per-model pools are null
});

test("claude adapter: still honours a rate_limits wrapper if a future build reintroduces one", async () => {
  const sample = { rate_limits: { five_hour: { utilization: 78.0 } } };
  const snap = await claudeAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readCredentials: async () => ({ accessToken: "tok" }),
  });
  assert.equal(snap.windows.find((w) => w.kind === "session").pct, 78);
});

test("claude adapter: no absolutes, no planLabel — never fabricated", async () => {
  const sample = { rate_limits: { five_hour: { utilization: 0.1 } } };
  const snap = await claudeAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readCredentials: async () => ({ accessToken: "tok" }),
  });
  assert.equal("planLabel" in snap, false);
  assert.equal("used" in snap.windows[0], false);
  assert.equal("limit" in snap.windows[0], false);
});

test("claude adapter: detect() requires a non-empty accessToken", async () => {
  assert.equal(await claudeAdapter.detect({ readCredentials: async () => ({ accessToken: "x" }) }), true);
  assert.equal(await claudeAdapter.detect({ readCredentials: async () => null }), false);
  assert.equal(await claudeAdapter.detect({ readCredentials: async () => ({}) }), false);
});

test("claude adapter: propagates 429 status + Retry-After as retryAfterMs", async () => {
  await assert.rejects(
    claudeAdapter.fetch({
      fetchImpl: async () => fakeResponse(429, {}, { "Retry-After": "30" }),
      readCredentials: async () => ({ accessToken: "tok" }),
    }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 30000);
      return true;
    },
  );
});

// ----------------------------------------------------------------------------
// Adapter: codex
// ----------------------------------------------------------------------------

test("codex adapter: prefers reset_at, falls back to now + reset_after_seconds", async () => {
  const sample = {
    rate_limit: {
      primary_window: { used_percent: 36, reset_after_seconds: 13200 },
      secondary_window: { used_percent: 91, reset_at: 1735700000000 },
    },
    plan_type: "plus",
    credits: { balance: 14.2 },
  };
  const snap = await codexAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readToken: async () => "tok",
    now: () => 1_700_000_000_000,
  });
  assert.equal(snap.planLabel, "Plus");
  const session = snap.windows.find((w) => w.kind === "session");
  assert.equal(session.pct, 36);
  assert.equal(session.resetsAt, 1_700_000_000_000 + 13200 * 1000);
  const weekly = snap.windows.find((w) => w.kind === "weekly");
  assert.equal(weekly.pct, 91);
  assert.equal(weekly.resetsAt, 1735700000000);
  assert.equal(snap.extras.find((e) => e.label === "Credits balance").value, "14.2");
});

test("codex adapter: no credits, no plan_type — extras/planLabel omitted, not fabricated", async () => {
  const sample = { rate_limit: { primary_window: { used_percent: 5, reset_after_seconds: 60 } } };
  const snap = await codexAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readToken: async () => "tok",
    now: () => 0,
  });
  assert.equal("planLabel" in snap, false);
  assert.equal("extras" in snap, false);
});

test("codex adapter: detect() requires a non-empty token", async () => {
  assert.equal(await codexAdapter.detect({ readToken: async () => "tok" }), true);
  assert.equal(await codexAdapter.detect({ readToken: async () => null }), false);
  assert.equal(await codexAdapter.detect({ readToken: async () => "" }), false);
});

// ----------------------------------------------------------------------------
// Adapter: kimi — string counts + remaining-only cases
// ----------------------------------------------------------------------------

test("kimi adapter: weekly (string counts) + session (300-minute limits entry, remaining-only)", async () => {
  const sample = {
    usage: { limit: "7168", used: "2214", resetTime: "2025-01-12T16:00:00.000Z" },
    limits: [
      { window: { duration: 1, timeUnit: "day" }, detail: { limit: 1000, used: 500 } }, // decoy
      { window: { duration: 300, timeUnit: "minute" }, detail: { limit: 200, remaining: 61, resetTime: 1735700000 } },
    ],
  };
  const snap = await kimiAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readKey: async () => "key",
  });
  assert.equal(snap.provider, "kimi");
  assert.equal("planLabel" in snap, false); // no planLabel on this endpoint, per spec
  assert.equal(snap.windows[0].kind, "session"); // shortest-first ordering contract

  const weekly = snap.windows.find((w) => w.kind === "weekly");
  assert.equal(weekly.used, 2214);
  assert.equal(weekly.limit, 7168);
  assert.equal(weekly.pct, Math.round((2214 / 7168) * 100));
  assert.equal(weekly.resetsAt, Date.parse("2025-01-12T16:00:00.000Z"));

  const session = snap.windows.find((w) => w.kind === "session");
  assert.equal(session.used, 139); // 200 - 61 (remaining-only plan)
  assert.equal(session.limit, 200);
  assert.equal(session.pct, 70);
  assert.equal(session.resetsAt, 1735700000000); // epoch seconds → ms
});

test("kimi adapter: a 5h window given in hours (not minutes) still resolves", async () => {
  const sample = {
    usage: { limit: 100, used: 10 },
    limits: [{ window: { duration: 5, timeUnit: "hour" }, detail: { limit: 200, used: 50 } }],
  };
  const snap = await kimiAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readKey: async () => "key",
  });
  const session = snap.windows.find((w) => w.kind === "session");
  assert.ok(session);
  assert.equal(session.used, 50);
});

test("kimi adapter: no matching 300-minute entry → session window simply absent", async () => {
  const sample = {
    usage: { limit: 100, used: 10 },
    limits: [{ window: { duration: 1, timeUnit: "day" }, detail: { limit: 1000, used: 1 } }],
  };
  const snap = await kimiAdapter.fetch({
    fetchImpl: async () => fakeResponse(200, sample),
    readKey: async () => "key",
  });
  assert.equal(snap.windows.some((w) => w.kind === "session"), false);
  assert.equal(snap.windows.some((w) => w.kind === "weekly"), true);
});

test("kimi adapter: detect() requires a non-empty key", async () => {
  assert.equal(await kimiAdapter.detect({ readKey: async () => "key" }), true);
  assert.equal(await kimiAdapter.detect({ readKey: async () => null }), false);
  assert.equal(await kimiAdapter.detect({ readKey: async () => "" }), false);
});

// ----------------------------------------------------------------------------
// Stale-window handling (BET-965)
// ----------------------------------------------------------------------------

test("poller: a window past its reset instant is published stale, values carried forward unchanged", async () => {
  let nowMs = 1000;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => ({
      windows: [{ kind: "session", label: "s", pct: 78, used: 78, resetsAt: 500 }],
    }),
  });
  const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs });
  await poller.tick();
  const w = poller.snapshots[0].windows[0];
  assert.equal(w.stale, true);
  assert.equal(w.pct, 78, "carry-forward must not alter the pct");
  assert.equal(w.used, 78, "carry-forward must not alter reported absolutes");
});

test("poller: a window with resetsAt in the future has no stale key", async () => {
  let nowMs = 1000;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 50, resetsAt: 5000 }] }),
  });
  const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs });
  await poller.tick();
  const w = poller.snapshots[0].windows[0];
  assert.equal("stale" in w, false, "future resetsAt must not attach stale (only-attach-when-true)");
});

test("poller: a window with no resetsAt is never marked stale", async () => {
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => ({ windows: [{ kind: "session", label: "s", pct: 50 }] }),
  });
  const poller = createUsagePoller({ adapters: [adapter], now: () => 1000 });
  await poller.tick();
  const w = poller.snapshots[0].windows[0];
  assert.equal("stale" in w, false);
});

test("poller: a waiting window re-polls a bounded number of times, then stops", async () => {
  let nowMs = 1000;
  let fetchCalls = 0;
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      fetchCalls++;
      // resetsAt stays in the past: the provider never publishes replacements,
      // which is the idle-user case the bound exists for.
      return { windows: [{ kind: "session", label: "s", pct: 78, resetsAt: 500 }] };
    },
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs, staleRetryMs: 5 });

  await poller.tick(); // retry 1 armed
  assert.equal(fetchCalls, 1);

  // Each armed retry is itself a tick that arms the next, up to the cap of 3.
  await sleep(60);
  assert.equal(fetchCalls, 4, "the initial tick plus exactly MAX_STALE_RETRIES re-polls");

  await sleep(60);
  assert.equal(fetchCalls, 4, "the budget is spent — no further re-poll while it stays stale");
});

test("poller: the retry budget re-arms once the window stops waiting", async () => {
  let nowMs = 1000;
  let fetchCalls = 0;
  let resetsAt = 500; // in the past → waiting
  const adapter = makeAdapter("a", {
    detect: async () => true,
    fetch: async () => {
      fetchCalls++;
      return { windows: [{ kind: "session", label: "s", pct: 78, resetsAt }] };
    },
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poller = createUsagePoller({ adapters: [adapter], now: () => nowMs, staleRetryMs: 5 });

  await poller.tick();
  await sleep(60);
  const spent = fetchCalls;
  assert.ok(spent >= 2, "budget was used while waiting");

  resetsAt = 99999; // provider published the new window
  await poller.tick();
  await sleep(30);
  const afterFresh = fetchCalls;

  resetsAt = 500; // a later boundary
  await poller.tick();
  await sleep(60);
  assert.ok(fetchCalls > afterFresh + 1, "a fresh boundary gets a fresh retry budget");
});
