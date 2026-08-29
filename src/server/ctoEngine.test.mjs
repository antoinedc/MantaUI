import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCtoEngine,
  createWatchdog,
  createRateTracker,
  createKillSwitch,
  computeDot,
  DOT,
  HOUR_MS,
  RATE_LIMITS,
  isRunningCtoRow,
  buildFactsContext,
} from "./ctoEngine.mjs";
import { createSegmenter } from "./ctoSegments.mjs";
import { startOfDay } from "./ctoRollups.mjs";
import { createFactsEngine } from "./ctoFacts.mjs";
import { windowFor } from "./ctoRollups.mjs";

// Build a fully-injected engine harness: no real fs, no real stores, a fake
// clock we can advance. Everything the engine touches goes through these
// seams, so the tests assert pure behavior. `clock` is shared so the watchdog
// and the engine observe the same time.
function makeHarness({ ctoEnabled = false, counts = {}, rollups, facts } = {}) {
  const clock = { ms: 1_000_000 };
  const now = () => clock.ms;
  const ledgerRows = [];
  let pendingBlockers = [];
  let killSwitchPaused = false;
  let published = [];
  let currentConfig = { ctoEnabled };
  const cardCalls = [];
  const state = { v: 1, pendingBlockers: [] };
  const budgetCfg = { budgetIsHit: false, tier: "low" };

  const engine = createCtoEngine({
    configGet: async () => ({ ...currentConfig }),
    ledger: { append: async (row) => ledgerRows.push(row) },
    cards: {
      onAskStart: (...a) => (cardCalls.push({ fn: "onAskStart", args: a }), Promise.resolve()),
      onAskResolved: (...a) => (
        cardCalls.push({ fn: "onAskResolved", args: a }),
        Promise.resolve({ changed: false })
      ),
      onHealthRecovered: (...a) => (cardCalls.push({ fn: "onHealthRecovered", args: a }), Promise.resolve()),
      promoteDue: async () => ({}),
      ingestHealthEscalations: async () => ({}),
    },
    engineState: {
      load: async () => ({ ...state }),
      save: async (payload) => {
        pendingBlockers = Array.isArray(payload?.pendingBlockers)
          ? payload.pendingBlockers
          : [];
        state.pendingBlockers = pendingBlockers;
        if (payload?.rollupCursor) state.rollupCursor = payload.rollupCursor;
        if (payload?.segmentGMinutes != null) state.segmentGMinutes = payload.segmentGMinutes;
      },
    },
    killSwitch: {
      isPaused: async () => killSwitchPaused,
      pause: async () => {
        killSwitchPaused = true;
      },
      resume: async () => {
        killSwitchPaused = false;
      },
    },
    publish: (evt) => published.push(evt),
    now,
    getCounts: async () => ({
      needsYouCount: 0,
      generationInFlight: false,
      tonightCount: 0,
      ...counts,
    }),
    // BET-1388: hermetic budget for all engine tests (never touches the real
    // budget.json). Cap tests override `budgetCfg.budget`.
    budget: {
      isCapHit: async () => budgetCfg.budgetIsHit,
      record: async () => ({ usd: 0, dayKey: "0" }),
    },
    tierGet: async () => budgetCfg.tier,
    ...(rollups ? { rollups } : {}),
    ...(facts ? { facts } : {}),
  });

  return {
    engine,
    clock,
    ledgerRows,
    published,
    cardCalls,
    state,
    budgetCfg,
    get pendingBlockers() {
      return pendingBlockers;
    },
    get killSwitchPaused() {
      return killSwitchPaused;
    },
    set killSwitchPaused(v) {
      killSwitchPaused = v;
    },
    setEnabled(v) {
      currentConfig.ctoEnabled = v;
    },
    advance(ms) {
      clock.ms += ms;
    },
  };
}

// A watchdog deps object for tests: throttle spend/expected/now over the same
// harness clock so spend thresholds + liveness are deterministic.
function makeWatchdog(harness, { spend = 0, expected = 0, livenessMs = 120_000 } = {}) {
  return createWatchdog({
    engine: harness.engine,
    getSpendPerHour: async () => spend,
    expectedHourlyBurn: async () => expected,
    livenessMs,
    now: () => harness.clock.ms,
    ledger: { append: async (row) => harness.ledgerRows.push(row) },
  });
}

test("disabled by default when ctoEnabled is false (config default)", async () => {
  const h = makeHarness({ ctoEnabled: false });
  const s = await h.engine.getState();
  assert.equal(s.enabled, false);
  assert.equal(s.dot, DOT.DISABLED);
  assert.equal(s.needsYouCount, 0);
  assert.equal(s.generationInFlight, false);
  assert.equal(s.tonightCount, 0);
});

test("active when enabled, and reflects counts from getCounts", async () => {
  const h = makeHarness({
    ctoEnabled: true,
    counts: { needsYouCount: 3, generationInFlight: true, tonightCount: 2 },
  });
  const s = await h.engine.getState();
  assert.equal(s.enabled, true);
  assert.equal(s.dot, DOT.ACTIVE);
  assert.equal(s.needsYouCount, 3);
  assert.equal(s.generationInFlight, true);
  assert.equal(s.tonightCount, 2);
});

test("ctoState fires only on change (no spam)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  assert.equal(h.published.length, 0);
  await h.engine.getState();
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].kind, "ctoState");
  // same state again → no re-publish
  await h.engine.getState();
  assert.equal(h.published.length, 1);
  // state change → re-publish
  h.setEnabled(false);
  await h.engine.getState();
  assert.equal(h.published.length, 2);
});

test("kill-switch flag is honored at every tick", async () => {
  const h = makeHarness({ ctoEnabled: true });
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  // externally-written flag → the next tick reflects paused and does no work
  h.killSwitchPaused = true;
  await h.engine.tick();
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  // clearing the flag externally → tick returns to active
  h.killSwitchPaused = false;
  await h.engine.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
});

test("kill-switch flag is honored before job/session start", async () => {
  const h = makeHarness({ ctoEnabled: true });
  assert.deepEqual(await h.engine.checkCanCreateSession(), { ok: true });
  h.killSwitchPaused = true;
  assert.deepEqual(await h.engine.checkCanCreateSession(), {
    ok: false,
    error: "cto_paused",
  });
  assert.deepEqual(await h.engine.beginEphemeral(), {
    ok: false,
    error: "cto_paused",
  });
  assert.deepEqual(await h.engine.beginDelegateJob(), {
    ok: false,
    error: "cto_paused",
  });
});

test("disabled engine refuses to start sessions", async () => {
  const h = makeHarness({ ctoEnabled: false });
  assert.deepEqual(await h.engine.checkCanCreateSession(), {
    ok: false,
    error: "cto_disabled",
  });
});

test("session-creations-per-hour limit trips to paused + health escalation", async () => {
  const h = makeHarness({ ctoEnabled: true });
  for (let i = 0; i < RATE_LIMITS.sessionCreationsPerHour; i++) {
    h.engine.rateTracker.recordSessionCreation();
  }
  const gate = await h.engine.checkCanCreateSession();
  assert.equal(gate.ok, false);
  assert.equal(gate.error, "rate_limit:sessionCreationsPerHour");
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  const trip = h.ledgerRows.find((r) => r.kind === "cto.ratelimit_trip");
  assert.ok(trip, "rate-limit trip ledgered");
  assert.equal(trip.reason, "sessionCreationsPerHour");
  assert.equal(trip.actor, "cto");
  assert.equal(h.pendingBlockers.length, 1);
  assert.equal(h.pendingBlockers[0].source, "rate_limit");
});

test("concurrent ephemeral cap trips to paused", async () => {
  const h = makeHarness({ ctoEnabled: true });
  for (let i = 0; i < RATE_LIMITS.concurrentEphemeral; i++) {
    assert.equal((await h.engine.beginEphemeral()).ok, true);
  }
  const sixth = await h.engine.beginEphemeral();
  assert.equal(sixth.ok, false);
  assert.equal(sixth.error, "rate_limit:concurrentEphemeral");
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
});

test("concurrent delegate cap trips to paused", async () => {
  const h = makeHarness({ ctoEnabled: true });
  for (let i = 0; i < RATE_LIMITS.concurrentDelegate; i++) {
    assert.equal((await h.engine.beginDelegateJob()).ok, true);
  }
  const third = await h.engine.beginDelegateJob();
  assert.equal(third.ok, false);
  assert.equal(third.error, "rate_limit:concurrentDelegate");
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
});

test("releasing an ephemeral/delegate slot frees the cap", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const a = await h.engine.beginEphemeral();
  assert.equal(a.ok, true);
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  a.release();
  // release then begin again at the cap → ok
  const b = await h.engine.beginEphemeral();
  assert.equal(b.ok, true);
  b.release();
});

test("pause() and resume() flip the flag, stop/restart state, and ledger", async () => {
  const h = makeHarness({ ctoEnabled: true });
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);

  await h.engine.pause({ reason: "manual" });
  assert.equal(h.killSwitchPaused, true);
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.pause"));

  await h.engine.resume({ reason: "manual" });
  assert.equal(h.killSwitchPaused, false);
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.resume"));
});

test("computeDot maps the four states", () => {
  assert.equal(computeDot({ enabled: true, paused: false, thrifty: false }), "active");
  assert.equal(computeDot({ enabled: false, paused: false, thrifty: false }), "disabled");
  assert.equal(computeDot({ enabled: true, paused: true, thrifty: false }), "paused");
  assert.equal(computeDot({ enabled: true, paused: false, thrifty: true }), "thrifty");
});

test("BET-1388: hard cap blocks beginEphemeral (cap hit → cto_cap_hit + thrifty)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  assert.equal((await h.engine.beginEphemeral()).ok, true);
  h.budgetCfg.budgetIsHit = true;
  const gate = await h.engine.beginEphemeral();
  assert.equal(gate.ok, false);
  assert.equal(gate.error, "cto_cap_hit");
  // cap-hit flips thrifty (§10.6-6)
  assert.equal((await h.engine.getState()).dot, DOT.THRIFTY);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.thrifty_on" && r.source === "cap"));
});

test("BET-1388: reportAmbientSpend records spend and flips thrifty on cap", async () => {
  const h = makeHarness({ ctoEnabled: true });
  await h.engine.reportAmbientSpend({ model: {}, tokens: 1000 });
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  h.budgetCfg.budgetIsHit = true;
  await h.engine.reportAmbientSpend({ model: {}, tokens: 1000 });
  assert.equal((await h.engine.getState()).dot, DOT.THRIFTY);
});

test("BET-1388: thrifty auto-clears at the daily reset", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const sod = startOfDay(h.clock.ms);
  h.clock.ms = sod + 60_000; // just past local midnight
  await h.engine.setThrifty(true, { reason: "cap_hit", source: "cap" });
  assert.equal((await h.engine.getState()).dot, DOT.THRIFTY);
  // advance into the next local day, then tick → thrifty cleared
  h.clock.ms = sod + 86_400_000 + 60_000;
  await h.engine.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.thrifty_off" && r.reason === "daily_reset"));
});

test("BET-1388: tierAllowsFeature reads the A12 dial and gates features", async () => {
  const h = makeHarness({ ctoEnabled: true });
  // default low tier
  assert.equal(await h.engine.tierAllowsFeature("rollups"), true);
  assert.equal(await h.engine.tierAllowsFeature("suggestion"), false);
  assert.equal(await h.engine.tierAllowsFeature("overnight"), false);
  h.budgetCfg.tier = "high";
  assert.equal(await h.engine.tierAllowsFeature("overnight"), true);
  assert.equal(await h.engine.tierAllowsFeature("probe"), true);
});

test("BET-1388: thrifty sheds hourly rollups (§12.2 rung 4) — no hour reduces", async () => {
  const levelsCalled = [];
  const rollups = {
    processDue: async (items) => {
      for (const it of items || []) levelsCalled.push(it.level);
      return (items || []).map((it) => ({ level: it.level, window: it.window, saved: true }));
    },
  };

  const h = makeHarness({ ctoEnabled: true, rollups });
  // First tick: initialize the rollup cursor.
  await h.engine.tick();
  levelsCalled.length = 0;

  // Normal mode: 3 closed hours → hour reduces run.
  h.advance(3 * HOUR_MS);
  await h.engine.tick();
  assert.ok(levelsCalled.includes("hour"), "hour reduces run when not thrifty");

  // Thrifty mode: the same 3 closed hours are shed (no hour reduces), cursor
  // advances past them so they are never re-attempted.
  levelsCalled.length = 0;
  h.advance(3 * HOUR_MS);
  await h.engine.setThrifty(true, { reason: "cap_hit", source: "cap" });
  await h.engine.tick();
  assert.ok(!levelsCalled.includes("hour"), "hour reduces shed while thrifty");
});

test("watchdog: > 2x expected burn → auto-thrifty", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const w = makeWatchdog(h, { spend: 3, expected: 1 });
  await w.tick();
  assert.equal((await h.engine.getState()).dot, DOT.THRIFTY);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.thrifty_on"));
});

test("watchdog: > 4x expected burn → auto-pause + blocker card", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const w = makeWatchdog(h, { spend: 5, expected: 1 });
  await w.tick();
  assert.equal(h.killSwitchPaused, true);
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.hard_pause"));
  assert.equal(h.pendingBlockers.length, 1);
  assert.equal(h.pendingBlockers[0].kind, "blocker");
  assert.equal(h.pendingBlockers[0].source, "watchdog");
});

test("watchdog: safe defaults (0 spend / 0 expected) never pause or thrift", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const w = makeWatchdog(h, { spend: 0, expected: 0 });
  await w.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.equal(h.killSwitchPaused, false);
  assert.ok(!h.ledgerRows.some((r) => r.kind.startsWith("cto.thrifty")));
  assert.ok(!h.ledgerRows.some((r) => r.kind === "cto.hard_pause"));
});

test("watchdog: stale engine heartbeat is flagged, state untouched", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const w = makeWatchdog(h, { spend: 0, expected: 0, livenessMs: 120_000 });
  // move the clock far past the engine's last heartbeat (no tick/event yet)
  h.advance(10 * 60_000);
  await w.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.ok(h.ledgerRows.find((r) => r.kind === "cto.watchdog_stale"));
});

test("rate tracker slides the hourly window", async () => {
  const clock = { ms: 5_000 };
  const now = () => clock.ms;
  const t = createRateTracker({ now });
  t.recordSessionCreation();
  assert.equal(t.sessionCreationsPerHour(), 1);
  clock.ms += HOUR_MS + 1;
  assert.equal(t.sessionCreationsPerHour(), 0);
  assert.equal(t.ephemeral, 0);
  assert.equal(t.delegate, 0);
});

test("createKillSwitch uses a real flag file (sandboxed state home)", async () => {
  // The engine never hardcodes the path; the default kill switch resolves it
  // through A1's ctoPath → statePath, so under the test sandbox it lands in
  // the ephemeral state dir, never production data.
  const ks = createKillSwitch();
  assert.equal(await ks.isPaused(), false);
  await ks.pause();
  assert.equal(await ks.isPaused(), true);
  await ks.resume();
  assert.equal(await ks.isPaused(), false);
});

test("observeEvent: question.asked registers a pending blocker card (no notify)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  h.engine.observeEvent({
    type: "question.asked",
    id: "evt_q1",
    properties: { sessionID: "s1", id: "que_1", questions: [{ question: "Pick a file?" }] },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.cardCalls.some((c) => c.fn === "onAskStart"));
  const call = h.cardCalls.find((c) => c.fn === "onAskStart");
  assert.equal(call.args[0].sourceKind, "question");
  assert.equal(call.args[0].sessionID, "s1");
  // The engine/card path never produces a notification — observeEvent only
  // forwards to the card machinery.
  assert.ok(h.ledgerRows.every((r) => !String(r.kind).toLowerCase().includes("notify")));
});

test("observeEvent: permission.replied resolves the open card for that session", async () => {
  const h = makeHarness({ ctoEnabled: true });
  h.engine.observeEvent({
    type: "permission.replied",
    id: "evt_p1",
    properties: { sessionID: "s2" },
  });
  await new Promise((r) => setTimeout(r, 0));
  const call = h.cardCalls.find((c) => c.fn === "onAskResolved");
  assert.ok(call, "permission.replied forwards to onAskResolved");
  assert.equal(call.args[0].sessionID, "s2");
});

test("observeEvent: session.deleted (abort) resolves the open card", async () => {
  const h = makeHarness({ ctoEnabled: true });
  h.engine.observeEvent({
    type: "session.deleted",
    id: "evt_del",
    properties: { sessionID: "s3" },
  });
  await new Promise((r) => setTimeout(r, 0));
  const call = h.cardCalls.find((c) => c.fn === "onAskResolved");
  assert.ok(call, "session.deleted forwards to onAskResolved");
  assert.equal(call.args[0].sessionID, "s3");
});

test("resume() clears health-escalation blocker cards (health recovered)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  await h.engine.resume();
  assert.ok(h.cardCalls.some((c) => c.fn === "onHealthRecovered"));
});

test("defaultGetCounts counts open cards from the real cards store", async () => {
  const { defaultGetCounts } = await import("./ctoEngine.mjs");
  const { cardsStore } = await import("./ctoStores.mjs");
  // The real cards store resolves under the test-sandbox state home; write a
  // card there and confirm it is counted only while open.
  await cardsStore.save({ v: 1, cards: [
    { id: "a", state: "open" },
    { id: "b", state: "resolved" },
  ] });
  assert.deepEqual(await defaultGetCounts(), {
    needsYouCount: 1,
    generationInFlight: false,
    tonightCount: 0,
  });
// ---------------------------------------------------------------------------
});
// A6 segmentation wiring (observeEvent → segmenter) (§5.1)
// ---------------------------------------------------------------------------

function fakeSegStores() {
  const map = new Map();
  const ledger = [];
  return {
    map,
    segments: {
      name: "segments",
      pathFor: (id) => id,
      async load(id) {
        return map.get(id) ?? { v: 1 };
      },
      async save(id, data) {
        map.set(id, data);
      },
    },
    ledger: { append: async (r) => ledger.push(r) },
    peekLedger: () => ledger,
  };
}

// Shared A6 segmenter-wiring setup: fake stores + a real segmenter + an engine
// wired to it, plus event builders. `owner` optionally sets getSessionInfo so
// cto-owned sessions exercise the exclusion path.
function makeSegEngine({ owner } = {}) {
  const stores = fakeSegStores();
  const seg = createSegmenter({
    segments: stores.segments,
    ledger: stores.ledger,
    engineState: { load: async () => ({}), save: async () => {} },
    summarize: async () => ({ ok: false, gated: false }),
    computeOneLiner: async () => null,
    now: () => 0,
  });
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: false }),
    ledger: { append: async () => {} },
    engineState: { load: async () => ({ v: 1, pendingBlockers: [] }), save: async () => {} },
    publish: () => {},
    now: () => 0,
    segmenterOverride: seg,
    ...(owner ? { getSessionInfo: async () => ({ owner, project: undefined }) } : {}),
  });
  const prompt = (text, sid) => ({
    type: "user.message.created",
    id: `id-${text}-0`,
    properties: { sessionID: sid, message: { role: "user", text } },
  });
  const idle = (sid, idSuffix) => ({
    type: "session.idle",
    id: `idle-${idSuffix}`,
    properties: { sessionID: sid },
  });
  return { stores, engine, seg, prompt, idle };
}

test("observeEvent feeds pipeline (user) sessions into the segmenter", async () => {
  const { stores, engine, seg, prompt, idle } = makeSegEngine();
  engine.observeEvent(prompt("first task", "s-user"));
  engine.observeEvent(idle("s-user", 1));
  await new Promise((r) => setTimeout(r, 10)); // let the async owner-resolve + feed land
  const st = seg._sessions.get("s-user");
  await st?.closeChain;
  assert.equal(stores.map.size, 1, "a pipeline session's work is segmented");
});

test("cto-owned sessions are never segmented", async () => {
  const { stores, engine } = makeSegEngine({ owner: "cto" });
  engine.observeEvent({
    type: "user.message.created",
    id: "cto-evt-1",
    properties: { sessionID: "s-cto", message: { role: "user", text: "x" } },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stores.map.size, 0, "cto-owned work is excluded from segmentation");
});


// ---------------------------------------------------------------------------
// BET-1381 §5.3 rollups — window-close timers + persisted cursor on the tick
// ---------------------------------------------------------------------------

// A rollup-enabled engine harness with an injected runner that records every
// window passed to processDue (and a stub which marks it finalized). Shared by
// the rollup tick tests so the boilerplate lives in one place.
function makeRollupHarness() {
  const d = windowFor("day", Date.UTC(2026, 0, 15, 12, 0, 0))[0];
  const received = [];
  const runner = {
    processDue: async (windows) => {
      received.push(...windows);
      return windows.map((w) => ({ saved: true, level: w.level, window: w.window, id: String(w.window[0]) }));
    },
  };
  const h = makeHarness({ ctoEnabled: true, rollups: runner });
  h.clock.ms = windowFor("hour", d)[0];
  return {
    h,
    d,
    runner,
    get received() {
      return received;
    },
  };
}

test("tick folds a closed hour window into the rollup runner and persists the cursor", async () => {
  const { h, d, received } = makeRollupHarness();
  // First tick at the top of an hour: cursor persists there; nothing due.
  await h.engine.tick();
  assert.equal(received.length, 0, "current (not-yet-closed) window is not due");

  // Advance 90 minutes → the first hour has closed → exactly one hour is due.
  h.advance(90 * 60_000);
  await h.engine.tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].level, "hour");
  assert.equal(received[0].window[0], windowFor("hour", d)[0]);

  // The cursor advanced to the closed hour's end; the next tick yields nothing new.
  assert.equal(h.state.rollupCursor.hour, windowFor("hour", d)[1]);
  await h.engine.tick();
  assert.equal(received.length, 1);
});

test("rollups do not run while paused", async () => {
  const { h, received } = makeRollupHarness();
  await h.engine.tick(); // cursor initializes + persists
  h.advance(60 * 60_000);
  await h.engine.tick(); // hour closed → rollup runs
  assert.equal(received.length, 1);

  // Now paused: advancing another hour does not fold a rollup.
  await h.engine.hardPause({ reason: "test" });
  h.advance(60 * 60_000);
  const before = received.length;
  await h.engine.tick();
  assert.equal(received.length, before);
});


// ---------------------------------------------------------------------------
// BET-1389 blackboard wiring: the engine exposes a facts engine and pumps the
// proposal queue on tick. Uses an injected in-memory facts engine so no real
// store is touched.
// ---------------------------------------------------------------------------

// Local facts-engine fixture: in-memory stores for facts + archive and a
// persisted engineState, so no real store is touched. Returns the engine plus
// the raw inmemory map for assertions.
function makeFactsFixture() {
  const inmemory = new Map();
  const fstate = { v: 1 };
  const facts = createFactsEngine({
    engineState: {
      load: async () => ({ ...fstate }),
      save: async (s) => {
        Object.keys(fstate).forEach((k) => delete fstate[k]);
        Object.assign(fstate, s);
      },
    },
    facts: { load: async (p) => inmemory.get(p) ?? { v: 1, facts: [] }, save: async (p, d) => inmemory.set(p, d), dir: "x" },
    archive: { load: async (p) => inmemory.get("a" + p) ?? { v: 1, entries: [] }, save: async (p, d) => inmemory.set("a" + p, d) },
  });
  return { facts, inmemory, fstate };
}

test("engine exposes .facts and pumps proposals on tick (%40 enabled)", async () => {
  const { facts, inmemory } = makeFactsFixture();
  const harness = makeHarness({ ctoEnabled: true, facts });
  // Enable + a proposal for alpha, then a tick should drain it into the store.
  await harness.engine.resume();
  await facts.submitProposal({ proposalId: "ep", project: "alpha", kind: "status", statement: "engine wired", refs: ["r1"], sender: "cto" });
  assert.equal(harness.engine.facts, facts);
  await harness.engine.tick();
  const saved = inmemory.get("alpha")?.facts ?? [];
  assert.equal(saved.filter((f) => !f.superseded_by).length, 1);
});

test("proposeFact enqueues, resolves via the gatekeeper, and reports the verdict", async () => {
  const { facts } = makeFactsFixture();
  const harness = makeHarness({ ctoEnabled: true, facts });
  await harness.engine.resume();

  // zero-ref is rejected with the attach-evidence message, never enqueued
  const rejected = await harness.engine.proposeFact({
    project: "alpha",
    kind: "status",
    statement: "no evidence",
    refs: [],
    sessionID: "ses_1",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? "", /attach evidence/i);

  // a valid proposal resolves (degraded gatekeeper → add) with an idempotent id
  const first = await harness.engine.proposeFact({
    project: "alpha",
    kind: "decision",
    statement: "moved to postgres",
    refs: ["m1"],
    sessionID: "ses_1",
  });
  assert.equal(first.ok, true);
  assert.equal(first.applied, true);
  assert.equal(first.outcome.action, "add");
  assert.ok(first.proposalId && first.proposalId.startsWith("cto:"));

  // same-content re-submission is idempotent: same proposalId, not re-applied
  const again = await harness.engine.proposeFact({
    project: "alpha",
    kind: "decision",
    statement: "moved to postgres",
    refs: ["m1"],
    sessionID: "ses_1",
  });
  assert.equal(again.proposalId, first.proposalId);
  assert.equal(again.applied, false, "idempotent — an already-applied proposal is not applied twice");
  assert.equal(again.outcome.action, "add");
});

// ---------------------------------------------------------------------------
// buildFactsContext (BET-1390 / §6.9) — spawn-context facts seed
// ---------------------------------------------------------------------------

test("buildFactsContext returns null without project or providers", async () => {
  assert.equal(await buildFactsContext({}), null);
  assert.equal(await buildFactsContext({ project: "alpha" }), null);
  assert.equal(
    await buildFactsContext({ project: "alpha", getTopFacts: async () => [], touchFacts: async () => ({}) }),
    null,
  );
});

test("buildFactsContext formats the block, caps at K, and touches only surfaced facts", async () => {
  const nowMs = 5000 * 3600_000;
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `cto:${i}`,
    kind: "status",
    statement: `fact ${i}`,
    created: nowMs - 3600_000,
    retention: 20 - i,
  }));
  const touched = [];
  const block = await buildFactsContext({
    project: "alpha",
    cap: 15,
    nowMs,
    getTopFacts: async (project, k) => many, // provider is sloppy: returns more than K
    touchFacts: async ({ project, ids }) => touched.push({ project, ids }),
  });
  assert.ok(block);
  assert.equal(block.priority, 60);
  const lines = block.text.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(lines.length, 15, "block is capped at K even when the provider over-returns");
  assert.ok(touched.length === 1 && touched[0].project === "alpha");
  assert.equal(touched[0].ids.length, 15, "touch records exactly the surfaced facts");
  assert.ok(touched[0].ids.includes("cto:0") && touched[0].ids.includes("cto:14"), "touches the highest-retention facts");
});

// ---------------------------------------------------------------------------
// BET-1397 inbox drain (unread notes → evidence, marked read, B1-weighted)
// ---------------------------------------------------------------------------

test("drainInbox folds unread notes into high-salience B1-weighted evidence and marks them read", async () => {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const state = { v: 1, entries: [] };
  const store = {
    load: async () => state,
    save: async (s) => {
      state.entries = s?.entries ?? [];
    },
  };
  // Low-reliability sender (0 confirmed / 5 rejected → Beta mean 1/7) and a
  // neutral one (0/0 → 1/2). Keys match `senderKey` (session:<id>) so the
  // drain's reliability lookup resolves them.
  const rel = {
    "session:low-ses": { confirmed: 0, rejected: 5 },
    "session:neutral-ses": { confirmed: 0, rejected: 0 },
  };
  const facts = { getState: async () => ({ senderReliability: rel }) };
  state.entries = [
    { id: "a", kind: "finding", message: "flaky", refs: ["BET-1"], sender: { sessionID: "low-ses" }, tag: null, read: false, count: 1, expires: clock.ms + 1000 },
    { id: "b", kind: "fyi", message: "heads up", refs: [], sender: { sessionID: "neutral-ses" }, tag: null, read: false, count: 1, expires: clock.ms + 1000 },
    { id: "c", kind: "blocker", message: "already seen", refs: [], sender: null, tag: null, read: true, count: 1, expires: clock.ms + 1000 },
  ];

  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    ledger: { append: async (row) => ledgerRows.push(row) },
    engineState: { load: async () => ({ v: 1, entries: [] }), save: async () => {} },
    cards: {},
    inbox: store,
    facts,
    now: () => clock.ms,
    publish: () => {},
  });

  const r = await engine.drainInbox();
  assert.equal(r.drained, 2); // a + b drained; c was already read

  // Both unread entries marked read in the persisted store.
  assert.equal(state.entries.find((e) => e.id === "a").read, true);
  assert.equal(state.entries.find((e) => e.id === "b").read, true);

  // High-salience inbox.* evidence rows emitted with B1 weights applied.
  const rows = ledgerRows.filter((row) => String(row.kind).startsWith("inbox."));
  assert.equal(rows.length, 2);
  const rowA = rows.find((row) => row.message === "flaky");
  assert.equal(rowA.kind, "inbox.finding");
  assert.equal(rowA.salience, "high");
  assert.ok(Math.abs(rowA.senderReliability - 1 / 7) < 1e-9, "low-reliability sender weighted");
  assert.deepEqual(rowA.refs, ["BET-1", "low-ses"]); // note refs + sender sessionID
  const rowB = rows.find((row) => row.message === "heads up");
  assert.ok(Math.abs(rowB.senderReliability - 1 / 2) < 1e-9, "neutral sender weighted 1/2");
  // No evidence for the already-read entry.
  assert.ok(!rows.some((row) => row.message === "already seen"));
});

test("isRunningCtoRow: single shared definition of a running CTO job row (BET-1427)", () => {
  assert.equal(isRunningCtoRow({ actor: "cto", status: "running" }), true);
  assert.equal(isRunningCtoRow({ actor: "cto", status: "paused" }), false);
  assert.equal(isRunningCtoRow({ actor: "cto", status: "done" }), false);
  assert.equal(isRunningCtoRow({ actor: "user", status: "running" }), false);
  assert.equal(isRunningCtoRow({ status: "running" }), false);
  assert.equal(isRunningCtoRow({ actor: "cto" }), false);
  assert.equal(isRunningCtoRow(null), false);
  assert.equal(isRunningCtoRow(undefined), false);
  assert.equal(isRunningCtoRow("cto/running"), false);
});
