// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";
import { makeMemoryStores } from "./ctoTestStores.mjs";

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
  RATE_LIMIT_COOLDOWN_MS,
  isRunningCtoRow,
  buildFactsContext,
  defaultGetCounts,
} from "./ctoEngine.mjs";
import { createSegmenter } from "./ctoSegments.mjs";
import { startOfDay } from "./ctoRollups.mjs";
import { createFactsEngine } from "./ctoFacts.mjs";
import { windowFor } from "./ctoRollups.mjs";
import { BLOCKER_AFTER_MS, CONTENTLESS_CARD_PRUNE_KEY, createCtoCards, splitOrphanedShedCards } from "./ctoCards.mjs";
import { inboxStore, sweepInbox, INBOX_TTL_MS } from "./ctoStores.mjs";
import { createCtoInbound } from "./cto.mjs";
import { WATCHER_HIT_KIND, WATCHER_HIT_SALIENCE, EVENT_PATTERN, RATE_THRESHOLD, USAGE_BURN } from "./ctoWatchers.mjs";
import { findingIdOf } from "./ctoTriage.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a fully-injected engine harness: no real fs, no real stores, a fake
// clock we can advance. Everything the engine touches goes through these
// seams, so the tests assert pure behavior. `clock` is shared so the watchdog
// and the engine observe the same time.

function makeHarness({ ctoEnabled = false, counts = {}, rollups, facts, realCards = false, engineStateInit = {} } = {}) {
  const clock = { ms: 1_000_000 };
  const now = () => clock.ms;
  const ledgerRows = [];
  let pendingBlockers = [];
  let pendingAsks = Array.isArray(engineStateInit?.pendingAsks) ? engineStateInit.pendingAsks : [];
  let killSwitchPaused = false;
  let published = [];
  let currentConfig = { ctoEnabled };
  const cardCalls = [];
  const state = { v: 1, pendingBlockers: [], ...(engineStateInit ?? {}) };
  const budgetCfg = { budgetIsHit: false, tier: "low" };
  const memStores = makeMemoryStores();
  memStores.ledger.append = async (row) => ledgerRows.push(row);
  // BET-1407: with `realCards` the engine builds its REAL cards manager over
  // the bundle's cards store — captured here so tests can assert cards.json
  // contents without real fs.
  let cardsPayload = { v: 1, cards: [] };
  if (realCards) {
    memStores.cards = {
      load: async () => ({ ...cardsPayload }),
      save: async (p) => {
        cardsPayload = { ...p };
      },
    };
  }

  const engine = createCtoEngine({
    configGet: async () => ({ ...currentConfig }),
    stores: memStores,
    ...(realCards
      ? {}
      : {
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
        }),
    engineState: {
      load: async () => ({ ...state }),
      save: async (payload) => {
        pendingBlockers = Array.isArray(payload?.pendingBlockers)
          ? payload.pendingBlockers
          : [];
        state.pendingBlockers = pendingBlockers;
        pendingAsks = Array.isArray(payload?.pendingAsks) ? payload.pendingAsks : [];
        state.pendingAsks = pendingAsks;
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
    get pendingAsks() {
      return pendingAsks;
    },
    cardsStore: () => cardsPayload,
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

// makeWatchdog + a spy over the engine's escalation verbs (prototype
// delegation, so the engine's lazy getters are never touched) — shared by the
// BET-1462 escalation tests (was a 17-line intra-file clone).
function makeSpyWatchdog(harness, { spend }) {
  const calls = { hardPause: 0, setThrifty: 0 };
  const spyEngine = Object.create(harness.engine);
  spyEngine.hardPause = async (arg) => {
    calls.hardPause += 1;
    return harness.engine.hardPause(arg);
  };
  spyEngine.setThrifty = async (v, opts) => {
    calls.setThrifty += 1;
    return harness.engine.setThrifty(v, opts);
  };
  const w = createWatchdog({
    engine: spyEngine,
    getSpendPerHour: async () => spend,
    expectedHourlyBurn: async () => 1,
    livenessMs: 120_000,
    now: () => harness.clock.ms,
    ledger: { append: async (row) => harness.ledgerRows.push(row) },
  });
  return { w, calls };
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
  await tripSessionCreationLimit(h);
  const trip = h.ledgerRows.find((r) => r.kind === "cto.ratelimit_trip");
  assert.ok(trip, "rate-limit trip ledgered");
  assert.equal(trip.reason, "sessionCreationsPerHour");
  assert.equal(trip.actor, "cto");
  assert.equal(h.pendingBlockers.length, 1);
  assert.equal(h.pendingBlockers[0].source, "rate_limit");
});

test("concurrent ephemeral cap SHEDS the call but does not pause the engine", async () => {
  const h = makeHarness({ ctoEnabled: true });
  await tripEphemeralLimit(h);
  // The rejected caller degrades gracefully; the ENGINE keeps working —
  // a concurrency blip is a per-call backoff, not a whole-engine pause.
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.equal(h.pendingBlockers.length, 0, "no needs-you card for a routine shed");
  const trip = h.ledgerRows.find((r) => r.kind === "cto.ratelimit_trip");
  assert.ok(trip, "the shed is ledgered for the drill-down");
  assert.equal(trip.reason, "concurrentEphemeral");
});

test("concurrent delegate cap sheds without pausing", async () => {
  const h = makeHarness({ ctoEnabled: true });
  for (let i = 0; i < RATE_LIMITS.concurrentDelegate; i++) {
    assert.equal((await h.engine.beginDelegateJob()).ok, true);
  }
  const third = await h.engine.beginDelegateJob();
  assert.equal(third.ok, false);
  assert.equal(third.error, "rate_limit:concurrentDelegate");
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.equal(h.pendingBlockers.length, 0);
});

// ----- BET-1508: a rate-limit self-pause is a BACKOFF, not a policy -----

// Shared setup: saturate the concurrent-ephemeral cap and take the shed.
async function tripEphemeralLimit(h) {
  for (let i = 0; i < RATE_LIMITS.concurrentEphemeral; i++) {
    assert.equal((await h.engine.beginEphemeral()).ok, true);
  }
  const sixth = await h.engine.beginEphemeral();
  assert.equal(sixth.ok, false);
  assert.equal(sixth.error, "rate_limit:concurrentEphemeral");
}

// Shared setup: trip the RUNAWAY limit (the one that pauses) and prove the
// self-pause shape.
async function tripSessionCreationLimit(h) {
  for (let i = 0; i < RATE_LIMITS.sessionCreationsPerHour; i++) {
    h.engine.rateTracker.recordSessionCreation();
  }
  const gate = await h.engine.checkCanCreateSession();
  assert.equal(gate.ok, false);
  assert.equal(gate.error, "rate_limit:sessionCreationsPerHour");
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
}

test("BET-1508: the rate-limit self-pause auto-clears after the cool-down and never touches the kill switch", async () => {
  const h = makeHarness({ ctoEnabled: true });
  await tripSessionCreationLimit(h);
  // The trip raised the rate_limit health escalation…
  assert.equal(h.pendingBlockers.length, 1);
  assert.equal(h.pendingBlockers[0].source, "rate_limit");

  // …which stays up through the cool-down itself…
  h.clock.ms += RATE_LIMIT_COOLDOWN_MS - 1000;
  await h.engine.tick();
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  assert.equal(h.ledgerRows.some((r) => r.kind === "cto.self_resume"), false);

  // …and auto-clears once it has elapsed: the engine resumes ITSELF, the
  // backoff is ledgered, and the health escalation resolves.
  h.clock.ms += 2000;
  await h.engine.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  const selfResume = h.ledgerRows.find((r) => r.kind === "cto.self_resume");
  assert.ok(selfResume, "self_resume ledgered");
  assert.equal(selfResume.reason, "rate_limit_cooldown_elapsed");
  assert.equal(h.cardCalls.some((c) => c.fn === "onHealthRecovered"), true);

  // The auto-clear must NOT touch the persisted kill switch: the flag was
  // never set by the trip, and it is still unset now.
  assert.equal(h.killSwitchPaused, false);
});

test("BET-1508: a human kill-switch pause is NEVER auto-cleared by the cool-down", async () => {
  const h = makeHarness({ ctoEnabled: true });
  await h.engine.pause({ reason: "manual" });

  // Well past any cool-down…
  h.clock.ms += RATE_LIMIT_COOLDOWN_MS * 3;
  await h.engine.tick();

  // …the manual pause (flag file path) still holds: the cool-down only ever
  // clears the in-memory rate-limit backoff.
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
  assert.equal(h.ledgerRows.some((r) => r.kind === "cto.self_resume"), false);
  assert.equal(h.killSwitchPaused, true);
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

test("watchdog: a second tick while already paused does not re-escalate (BET-1462)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const { w, calls } = makeSpyWatchdog(h, { spend: 5 });
  await w.tick(); // 5 > 4×1 → the one legitimate hard pause
  assert.equal(calls.hardPause, 1);
  assert.equal(h.killSwitchPaused, true);
  assert.equal(h.pendingBlockers.length, 1);
  await w.tick(); // still burning, but the pause is already in effect
  assert.equal(calls.hardPause, 1);
  assert.equal(h.pendingBlockers.length, 1);
  assert.equal(h.ledgerRows.filter((r) => r.kind === "cto.hard_pause").length, 1);
  assert.equal((await h.engine.getState()).dot, DOT.PAUSED);
});

test("watchdog: already thrifty is never re-asserted (BET-1462)", async () => {
  const h = makeHarness({ ctoEnabled: true });
  const { w, calls } = makeSpyWatchdog(h, { spend: 3 });
  await w.tick(); // 3 > 2×1 → the one legitimate thrifty flip
  assert.equal(calls.setThrifty, 1);
  assert.equal((await h.engine.getState()).dot, DOT.THRIFTY);
  await w.tick(); // still >2×, but thrifty is already on → no re-assert
  assert.equal(calls.setThrifty, 1);
  assert.equal(h.ledgerRows.filter((r) => r.kind === "cto.thrifty_on").length, 1);
});

test("watchdog: the 2026-08-31 live values no longer pause the engine (BET-1462)", async () => {
  // Incident: 7-day ambient total $5.173744e-05 against the live $2.50 cap.
  // The fixed baseline floors at the cap-equivalent pace ($2.50/24), so the
  // measured burn that tripped the old code ($4.1668e-06/hr) is far below
  // even the 2× thrifty line.
  const h = makeHarness({ ctoEnabled: true });
  const w = makeWatchdog(h, { spend: 4.166828969341808e-6, expected: 2.5 / 24 });
  await w.tick();
  assert.equal((await h.engine.getState()).dot, DOT.ACTIVE);
  assert.equal(h.killSwitchPaused, false);
  assert.ok(!h.ledgerRows.some((r) => r.kind === "cto.hard_pause"));
  assert.ok(!h.ledgerRows.some((r) => r.kind.startsWith("cto.thrifty")));
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

test("defaultGetCounts counts only open cards with content from an injected cards store (BET-1469, BET-1476)", async () => {
  const { defaultGetCounts } = await import("./ctoEngine.mjs");
  // The counting logic needs no real store: the cards store is injectable, so
  // this test no longer writes cards.json (sandboxed or otherwise).
  // BET-1476: a contentless open card is the §10.3-invisible residue BET-1469
  // stopped writing — it must NOT increment the needs-you count (the badge
  // would advertise an answerable item no pane section renders), while a
  // titled open card still does.
  let payload = {
    v: 1,
    cards: [
      { id: "a", state: "open" },
      { id: "b", state: "open", title: "Probe failing", body: "update \"GROQ\" on the secrets surface" },
      { id: "c", state: "resolved", title: "Probe failing" },
    ],
  };
  const cardStore = {
    name: "cards",
    load: async () => payload,
    save: async (p) => {
      payload = p;
    },
  };
  assert.deepEqual(await defaultGetCounts(cardStore), {
    needsYouCount: 1,
    generationInFlight: false,
    tonightCount: 0,
  });
// ---------------------------------------------------------------------------
});

// ---------------------------------------------------------------------------
// BET-1498: the one-time prune of the pre-BET-1469 residue — contentless OPEN
// cards in cards.json that render in no pane section and (since BET-1476) no
// longer count toward the badge, so nothing could ever resolve or dismiss
// them. Retired at boot by a marker-guarded prune reusing the shared
// cardHasContent predicate.
// ---------------------------------------------------------------------------

test("BET-1498: pruneLegacyOpenCards retires contentless open cards once (marker-guarded) and keeps every other row", async () => {
  let cardPayload = {
    v: 1,
    cards: [
      { id: "a", state: "open" }, // the BET-1469 fixture-pollution shape
      { id: "b", state: "open", title: "Probe failing", body: "rotate the key" },
      { id: "c", state: "resolved" }, // not open → untouched
      { id: "d" }, // no state → untouched
    ],
  };
  let saves = 0;
  const cardStore = {
    name: "cards",
    load: async () => cardPayload,
    save: async (p) => {
      saves += 1;
      cardPayload = p;
    },
  };
  let engineState = { v: 1 };
  const patchEngineState = async (mutation) => {
    const patch = typeof mutation === "function" ? await mutation(engineState) : mutation;
    engineState = { ...engineState, ...patch };
  };
  const cards = createCtoCards({
    cardStore,
    engineState: {
      load: async () => engineState,
      save: async (p) => {
        engineState = p;
      },
    },
    ledger: { append: async () => true },
    now: () => 1_000_000,
    patchEngineState,
  });

  const r1 = await cards.pruneLegacyOpenCards();
  assert.deepEqual(r1, { pruned: 1, marked: true });
  assert.deepEqual(
    cardPayload.cards.map((c) => c.id),
    ["b", "c", "d"],
    "the contentless open row is retired; titled open, resolved and stateless rows survive",
  );
  assert.equal(engineState[CONTENTLESS_CARD_PRUNE_KEY].pruned, true);
  assert.equal(engineState[CONTENTLESS_CARD_PRUNE_KEY].at, 1_000_000);

  // The guarded re-run is a pure no-op: the marker short-circuits before any
  // cards.json read-write (no save fired).
  const r2 = await cards.pruneLegacyOpenCards();
  assert.deepEqual(r2, { pruned: 0, marked: false });
  assert.equal(saves, 1, "the marker-guarded re-run never rewrites cards.json");

  // A box whose engine-state already carries the marker (re-deploy) prunes
  // nothing and skips the stamp.
  const fresh = createCtoCards({
    cardStore: {
      name: "cards",
      load: async () => cardPayload,
      save: async () => {},
    },
    engineState: {
      load: async () => engineState,
      save: async () => {},
    },
    ledger: { append: async () => true },
    now: () => 1_000_000,
    patchEngineState,
  });
  assert.deepEqual(await fresh.pruneLegacyOpenCards(), { pruned: 0, marked: false });

  // The counting module agrees with the retired store — the badge now counts
  // exactly the rows a pane section can render (BET-1476 parity, BET-1498 hygiene).
  assert.deepEqual(await defaultGetCounts(cardStore), {
    needsYouCount: 1,
    generationInFlight: false,
    tonightCount: 0,
  });
});

test("BET-1498: engine start() prunes the contentless open cards from cards.json at boot", async () => {
  const h = makeHarness({ realCards: true });
  // Seed the residue straight into the store, like a box that still carries a
  // fixture-polluted cards.json from before BET-1469.
  h.cardsStore().cards = [
    { id: "a", state: "open" },
    { id: "b", state: "open", title: "Question waiting", body: "answer me" },
  ];
  await h.engine.start();
  h.engine.dispose();
  assert.deepEqual(
    h.cardsStore().cards.map((c) => c.id),
    ["b"],
    "boot retires the dead row; the actionable card survives",
  );
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
    stores: makeMemoryStores(),
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
    stores: makeMemoryStores(),
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

test("drainInbox mark-read is a patchStore section: a concurrent sweep + append BOTH survive the mark-read (BET-1492)", async () => {
  // Seeded on the REAL clock — the append (createCtoInbound) and the sweep
  // purge with their own real now(), not the engine's virtual clock.
  await inboxStore.save({
    v: 1,
    entries: [
      { id: "unread", kind: "finding", message: "flaky", sender: { sessionID: "s1" }, read: false, count: 1, expires: Date.now() + 100_000 },
      { id: "old", kind: "fyi", message: "expired", read: true, count: 1, expires: Date.now() - 1 },
    ],
  });
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores: makeMemoryStores(),
    ledger: { append: async () => true },
    engineState: { load: async () => ({ v: 1, entries: [] }), save: async () => {} },
    cards: {},
    inbox: inboxStore,
    // The drain's (delayed) reliability lookup is where the patch section
    // parks: the sweep and the append must queue behind it and re-derive.
    // The old unlocked drain spread-save rewrote `entries` from its stale
    // snapshot and dropped the note appended mid-drain.
    facts: { getState: async () => { await delay(25); return { senderReliability: {} }; } },
    now: () => 1_000_000,
    publish: () => {},
  });
  const inbound = createCtoInbound({ registerBlocker: async () => {} });
  const drain = engine.drainInbox(); // parks mid-patch at the delayed getState
  await delay(5); // let the drain issue its load / take the mutex
  const sweep = sweepInbox(Date.now());
  const append = inbound.inbound({ surface: "session", payload: { kind: "fyi", message: "appended mid-drain" } });
  const [drainRes] = await Promise.all([drain, sweep, append]);
  assert.equal(drainRes.drained, 1);
  await delay(30); // let every in-flight write land before reading the verdict
  const after = await inboxStore.load();
  assert.deepEqual(
    after.entries.map((e) => e.message).sort(),
    ["appended mid-drain", "flaky"],
    "the mid-drain append survived the drain's mark-read; the expired note did not resurrect",
  );
  assert.equal(after.entries.find((e) => e.message === "flaky")?.read, true, "mark-read landed");
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

// ---------------------------------------------------------------------------
// BET-1466 stage-3A
// ---------------------------------------------------------------------------

test("overnightTick reads the ledger with a 24h lower bound instead of the whole file (BET-1466 item 3)", async () => {
  const readCalls = [];
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true, ctoOvernight: true }),
    stores: makeMemoryStores(),
    ledger: {
      append: async () => {},
      read: async (opts) => {
        readCalls.push(opts ?? null);
        return [];
      },
    },
    engineState: {
      load: async () => ({}),
      save: async () => {},
    },
    killSwitch: { isPaused: async () => false, pause: async () => {}, resume: async () => {} },
    tierGet: async () => "high",
    overnight: { tick: async () => ({ window: null, ledgerRows: [] }) },
    now: () => 5_000_000_000_000,
  });
  await engine.tick();
  assert.equal(readCalls.length >= 1, true, "the overnight tick read the ledger");
  const HOUR = 3_600_000;
  for (const opts of readCalls) {
    assert.ok(opts && typeof opts === "object", "read() is called with an options object");
    assert.equal(opts.from, 5_000_000_000_000 - 24 * HOUR, "the read is bounded to the last 24h");
  }
});

test("dispose unregisters the verdict counter sinks (BET-1466 item 7)", async () => {
  let esState = {};
  let verdictsState = { entries: [] };
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores: makeMemoryStores(),
    ledger: { append: async () => {} },
    engineState: {
      load: async () => esState,
      save: async (p) => {
        esState = p;
      },
    },
    killSwitch: { isPaused: async () => false, pause: async () => {}, resume: async () => {} },
    verdicts: {
      load: async () => verdictsState,
      save: async (p) => {
        verdictsState = p;
      },
    },
    now: () => 5_000_000_000_000,
  });
  const res = await engine.recordVerdict({ subject: { type: "fact", id: "f1", sender: "user" }, verdict: "accept" });
  assert.equal(res.ok, true, "the verdict itself records");
  // The sink folds asynchronously (best-effort void promise) — let it land.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const before = esState.factReliability?.user?.confirmed ?? 0;
  assert.ok(before >= 1, "the sink folded the verdict into sender reliability");
  engine.dispose();
  await engine.recordVerdict({ subject: { type: "fact", id: "f2", sender: "user" }, verdict: "accept" });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const after = esState.factReliability?.user?.confirmed ?? 0;
  assert.equal(after, before, "a post-dispose verdict no longer folds into reliability");
});

test("the engine surface declares get cards() exactly once (BET-1466 item 7: duplicate key deleted)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./ctoEngine.mjs", import.meta.url), "utf8");
  const count = src.split("get cards()").length - 1;
  assert.equal(count, 1, "a duplicated object-literal key silently shadows its twin");
});

// ---------------------------------------------------------------------------
// BET-1407: the in-flight ask registry survives restarts. `start()` seeds it
// from the persisted half (engine-state.json `pendingAsks`) so an ask that
// crossed the 10-min card threshold while the box was down still promotes on
// the next card tick, and a promoted ask is consumed from both halves.
// ---------------------------------------------------------------------------

test("BET-1407: engine start() seeds pendingAsks from the persisted registry and an ask past the 10-min threshold promotes on the next card tick", async () => {
  // The harness clock starts at 1_000_000 — askedAt literals are relative to
  // that. One ask crossed BLOCKER_AFTER_MS while the box was down; one is
  // still young.
  const h = makeHarness({
    realCards: true,
    engineStateInit: {
      pendingAsks: [
        { sourceKind: "question", sourceId: "que_old", sessionID: "s_old", body: "Old ask", askedAt: 1_000_000 - (BLOCKER_AFTER_MS + 60_000) },
        { sourceKind: "question", sourceId: "que_new", sessionID: "s_new", body: "Young ask", askedAt: 1_000_000 - 60_000 },
      ],
    },
  });
  await h.engine.start();
  // Seeded: both rows are live in memory, and the file kept them (nothing
  // was stale — the seed write is a pure no-op).
  assert.deepEqual(h.pendingAsks.map((a) => a.sessionID).sort(), ["s_new", "s_old"]);
  // The straddled ask promotes on the next card tick (called directly —
  // deterministic stand-in for the 60s poller) and is CONSUMED from both
  // registry halves.
  await h.engine.cards.promoteDue();
  const open = h.cardsStore().cards.filter((c) => c.variant === "blocker" && c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sessionID, "s_old");
  assert.equal(open[0].pendingSince, 1_000_000 - (BLOCKER_AFTER_MS + 60_000));
  assert.deepEqual(h.pendingAsks.map((a) => a.sessionID), ["s_new"]);
  assert.deepEqual(h.pendingAsks, h.state.pendingAsks, "memory and the persisted half agree");
  h.engine.dispose();
});

test("BET-1407: engine start() drops a persisted ask past the blocker retention window", async () => {
  const h = makeHarness({
    realCards: true,
    engineStateInit: {
      pendingAsks: [
        // 8 days old — past the existing blocker retention window.
        { sourceKind: "question", sourceId: "que_rot", sessionID: "s_rot", body: "rotted", askedAt: 1_000_000 - 8 * 24 * 60 * 60_000 },
        { sourceKind: "question", sourceId: "que_new", sessionID: "s_new", body: "Young ask", askedAt: 1_000_000 - 60_000 },
      ],
    },
  });
  await h.engine.start();
  assert.deepEqual(h.pendingAsks.map((a) => a.sessionID), ["s_new"]);
  assert.deepEqual(h.state.pendingAsks.map((a) => a.sessionID), ["s_new"], "the stale row is dropped from the persisted half too");
  h.engine.dispose();
});

// ---------------------------------------------------------------------------
// BET-1472 (BET-1436 decision c): project-less watcher hits are dropped from
// overnight candidacy at the source. A usage-burn hit (or any pre-BET-1428 hit
// row) carries no `project`, so §11.5 dispatch could never host its job and
// re-skipped it on every tick of the open window. The B4 suggestion path
// (ctoSuggest.mjs) is untouched and still surfaces these hits during the day.
// ---------------------------------------------------------------------------

test("BET-1472: project-less watcher.hit rows (usage-burn and pre-BET-1428 shapes) produce NO overnight candidate", () => {
  const h = makeHarness();
  const rows = [
    { kind: WATCHER_HIT_KIND, salience: WATCHER_HIT_SALIENCE, watcherId: "w_usage", predicateKind: USAGE_BURN, text: "Usage burn", refs: [], ts: 1 },
    { kind: WATCHER_HIT_KIND, salience: WATCHER_HIT_SALIENCE, watcherId: "w_pre1428", predicateKind: EVENT_PATTERN, text: "Pre-BET-1428 hit", refs: [], ts: 2 },
  ];
  assert.deepEqual(h.engine.watcherCandidatesFromRows(rows), []);
});

test("BET-1472: a watcher.hit row with an empty-string project produces NO overnight candidate", () => {
  const h = makeHarness();
  const rows = [
    { kind: WATCHER_HIT_KIND, salience: WATCHER_HIT_SALIENCE, watcherId: "w_empty", predicateKind: RATE_THRESHOLD, text: "Empty project", project: "", refs: [], ts: 3 },
  ];
  assert.deepEqual(h.engine.watcherCandidatesFromRows(rows), []);
});

test("BET-1472: a watcher.hit row WITH a project still becomes a candidate carrying that project (BET-1428 hostable path intact)", () => {
  const h = makeHarness();
  const rows = [
    { kind: WATCHER_HIT_KIND, salience: WATCHER_HIT_SALIENCE, watcherId: "w_hosted", predicateKind: EVENT_PATTERN, text: "Hostable hit", project: "better-ui", refs: ["m:1"], ts: 4 },
  ];
  const out = h.engine.watcherCandidatesFromRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "wh:w_hosted");
  assert.equal(out[0].category, "watcher");
  assert.equal(out[0].name, "Hostable hit");
  assert.equal(out[0].project, "better-ui");
  assert.deepEqual(out[0].refs, ["m:1"]);
});

// ---------------------------------------------------------------------------
// BET-1516 — the pending-findings drain (blockers enter the pipeline, §9.1)
// ---------------------------------------------------------------------------

// The shared engine scaffold for the drain/cardTick tests in this section:
// memory stores, captured ledger, fake clock, neutral sender reliability.
// `clock` and `ledgerRows` are passed in by reference so the test keeps
// asserting on its own handles; extra deps (e.g. `cards: {}` to fake the
// cards manager in the pure drain tests) merge on top via `overrides`.
function makeFindingsEngine({ clock, ledgerRows, ...overrides } = {}) {
  const stores = makeMemoryStores();
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async (row) => ledgerRows.push(row) },
    facts: { getState: async () => ({ senderReliability: {} }) },
    now: () => clock.ms,
    publish: () => {},
    ...overrides,
  });
  return { engine, stores };
}

test("drainFindings turns queued inbox findings into high-salience B1-weighted evidence and marks the note read", async () => {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const stores = makeMemoryStores();
  // The inbox note the finding came from: still unread, so the breakpoint
  // drain (drainInbox) would fold it too — the mark-read below is what keeps
  // the pipeline from double-counting the same blocker.
  await stores.inbox.save({
    v: 1,
    entries: [{ id: "note-1", kind: "blocker", message: "deploy failed", refs: ["BET-9"], sender: { sessionID: "s1" }, tag: "deploy", read: false, count: 1, expires: clock.ms + 1000 }],
  });
  await stores.findings.save({
    v: 1,
    findings: [
      { source: "inbox", ts: clock.ms, noteId: "note-1", noteKind: "blocker", message: "deploy failed", title: "Deploy", tag: "deploy", refs: ["BET-9"], sender: { sessionID: "s1", name: "w" } },
    ],
  });
  const rel = { "session:s1": { confirmed: 3, rejected: 0 } };
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async (row) => ledgerRows.push(row) },
    cards: {},
    facts: { getState: async () => ({ senderReliability: rel }) },
    now: () => clock.ms,
    publish: () => {},
  });

  const r = await engine.drainFindings();
  assert.equal(r.drained, 1);

  // The queue is empty after the drain.
  assert.deepEqual((await stores.findings.load()).findings, []);
  // The source note is marked read — drainInbox will not re-fold it.
  assert.equal((await stores.inbox.load()).entries[0].read, true);

  // One high-salience evidence row, byte-shape-identical to what drainInbox
  // writes for the same note (incl. the B1 weight of the sending session).
  const rows = ledgerRows.filter((row) => row.kind === "inbox.blocker");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].salience, "high");
  assert.ok(Math.abs(rows[0].senderReliability - 4 / 5) < 1e-9, "3/0 confirmed → Beta mean (1+3)/(1+3+0+1) = 4/5");
  assert.deepEqual(rows[0].refs, ["BET-9", "s1"]);
  assert.equal(rows[0].tag, "deploy");
  assert.equal(rows[0].sessionID, "s1");

  // The breakpoint drain no longer sees it (already read).
  const after = await engine.drainInbox();
  assert.equal(after.drained, 0);
});

test("drainFindings maps a promoted ask finding to an ask.<sourceKind> evidence row and leaves the inbox alone", async () => {
  const clock = { ms: 2_000_000 };
  const ledgerRows = [];
  const { engine, stores } = makeFindingsEngine({ clock, ledgerRows, cards: {} });
  await stores.findings.save({
    v: 1,
    findings: [
      { source: "ask", ts: clock.ms, sourceKind: "permission", sourceId: "perm_1", sessionID: "s2", message: "Allow rm -rf?", title: "Permission needed", refs: [] },
    ],
  });
  const r = await engine.drainFindings();
  assert.equal(r.drained, 1);
  const row = ledgerRows.find((x) => x.kind === "ask.permission");
  assert.ok(row, "the ask's pipeline entry is an ask.* evidence row");
  assert.equal(row.salience, "high");
  assert.equal(row.sessionID, "s2");
  assert.equal(row.message, "Allow rm -rf?");
  assert.equal(row.tag, undefined);
  // Neutral sender (no reliability history) and no note to mark read.
  assert.ok(Math.abs(row.senderReliability - 1 / 2) < 1e-9);
  assert.deepEqual((await stores.inbox.load()).entries, []);
});

test("drainFindings maps a health escalation finding to a health.blocker evidence row (third producer, §9.1)", async () => {
  const clock = { ms: 3_000_000 };
  const ledgerRows = [];
  const { engine, stores } = makeFindingsEngine({ clock, ledgerRows, cards: {} });
  await stores.findings.save({
    v: 1,
    findings: [
      { source: "health", sourceKind: "health", sourceId: "watchdog", ts: clock.ms, message: "ambient spend 7 > 4x expected", title: "Health check", refs: [], pendingSince: clock.ms - 500, tag: "watchdog" },
    ],
  });
  const r = await engine.drainFindings();
  assert.equal(r.drained, 1);
  assert.deepEqual((await stores.findings.load()).findings, []);
  const row = ledgerRows.find((x) => x.kind === "health.blocker");
  assert.ok(row, "the health escalation folds as a health.* evidence row");
  assert.equal(row.salience, "high");
  assert.equal(row.message, "ambient spend 7 > 4x expected");
  assert.equal(row.tag, "watchdog", "the trip source rides the tag");
  assert.equal(row.sessionID, undefined, "health escalations have no sender session");
  assert.deepEqual(row.refs, []);
  // Keyless sender → neutral reliability, same as an unseen ask sender.
  assert.ok(Math.abs(row.senderReliability - 1 / 2) < 1e-9);
});

test("cardTick enqueues the third blocker source (health escalation) and folds it into evidence on the same tick", async () => {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const { engine, stores } = makeFindingsEngine({ clock, ledgerRows });
  // The watchdog wrote a pendingBlockers entry (the recordBlocker shape).
  await stores.engineState.save({
    v: 1,
    pendingBlockers: [{ id: "b1", kind: "blocker", source: "rate_limit", reason: "sessionCreationsPerHour", ts: clock.ms, resolved: false }],
  });
  clock.ms += 1;
  await engine.cardTick();
  // The full third-source path in ONE tick: ingest → enqueue → drain →
  // evidence, with the queue empty again and the health card open.
  assert.equal(ledgerRows.filter((x) => x.kind === "health.blocker").length, 1);
  assert.deepEqual((await stores.findings.load()).findings, []);
  const open = (await stores.cards.load()).cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].sourceKind, "health");
  // The consumed entry cannot re-enqueue on a later tick.
  clock.ms += 1;
  await engine.cardTick();
  assert.equal(ledgerRows.filter((x) => x.kind === "health.blocker").length, 1);
});

test("cardTick drains the queue and runs the inbox-card liveness pass; a promoted ask enters the pipeline on the next tick", async () => {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const { engine, stores } = makeFindingsEngine({ clock, ledgerRows });
  // A worker ask registered through the REAL cards manager (not a fake) —
  // the engine's own cards wiring must queue the finding at promotion, and
  // the SAME tick's drain consumes it into the pipeline: one pass,
  // promotion → queue → ledger row, queue empty again.
  engine.cards.onAskStart({ sourceKind: "question", sourceId: "que_1", sessionID: "s1", body: "Pick one?", ts: clock.ms });
  clock.ms += 10 * 60_000 + 1;
  await engine.cardTick();
  assert.equal(ledgerRows.filter((x) => x.kind === "ask.question").length, 1);
  assert.deepEqual((await stores.findings.load()).findings, []);
  // The liveness pass ran too (an inbox card past its TTL auto-resolves on
  // the same tick rather than lingering).
  await stores.cards.save({
    v: 1,
    cards: [{ id: "gone", variant: "blocker", state: "open", sourceKind: "inbox", sourceId: "g", title: "t", body: "b", refs: [], pendingSince: clock.ms - INBOX_TTL_MS.blocker - 1, created: clock.ms, updatedAt: clock.ms }],
  });
  clock.ms += 1;
  await engine.cardTick();
  const left = (await stores.cards.load()).cards.filter((c) => c.state === "open");
  assert.equal(left.length, 0);
});

// ---------------------------------------------------------------------------
// BET-1517 — the triage stage: drain → one gated model call per finding →
// 0–3 validated resolution plans in plans.json, keyed by finding id.
// ---------------------------------------------------------------------------

test("cardTick triages drained findings: one gated triage call per finding, plans keyed by finding id", async () => {
  const clock = { ms: 1_000_000 };
  const stores = makeMemoryStores();
  const modelCalls = [];
  const INBOX_ROW = {
    source: "inbox",
    ts: clock.ms,
    noteId: "note-1",
    noteKind: "blocker",
    message: "deploy failed",
    title: "Deploy",
    tag: "deploy",
    refs: ["BET-9"],
    condition: "session s1 active",
    sender: { sessionID: "s1", name: "w" },
  };
  await stores.findings.save({ v: 1, findings: [INBOX_ROW] });
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async () => true },
    facts: { getState: async () => ({ senderReliability: {} }) },
    runEphemeral: async (args) => {
      modelCalls.push(args);
      return {
        ok: true,
        text: JSON.stringify({
          plans: [
            {
              class: "job-redispatch",
              diagnosis: "The deploy job died; rerun it.",
              steps: ["Restart the deploy job"],
              access: [],
              verify: { kind: "condition-gone" },
              undo: "none",
              confidence: 0.7,
              report: { one_liner: "Rerunning the failed deploy", bullets: [] },
            },
          ],
        }),
      };
    },
    now: () => clock.ms,
    publish: () => {},
  });

  // The drain returns the rows (the triage seam's input shape).
  const drained = await engine.drainFindings();
  assert.equal(drained.drained, 1);
  assert.deepEqual(drained.rows, [INBOX_ROW]);
  assert.deepEqual((await stores.findings.load()).findings, []);

  // Re-queue, then run the WHOLE tick: drain → triage → plans store.
  await stores.findings.save({ v: 1, findings: [INBOX_ROW] });
  await engine.cardTick();
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].taskClass, "triage", "the call runs as the §12.3 triage class");
  assert.deepEqual((await stores.findings.load()).findings, []);
  const records = (await stores.plans.load()).records;
  assert.equal(Object.keys(records).length, 1, "one record, keyed by finding id");
  const fid = findingIdOf(INBOX_ROW);
  const rec = records[fid];
  assert.ok(rec, `record keyed ${fid} exists`);
  assert.equal(rec.plans.length, 1);
  assert.equal(rec.plans[0].class, "job-redispatch");
  assert.equal(rec.plans[0].finding.text, "deploy failed", "the verbatim finding rides the plan");
  assert.equal(rec.plans[0].verify.kind, "condition-gone");
  assert.equal(rec.triagedAt, clock.ms);
  // The context carried the untrusted finding block.
  const findingBlock = modelCalls[0].context.find((b) => typeof b.text === "string" && b.text.includes("deploy failed"));
  assert.ok(findingBlock && /untrusted DATA/.test(findingBlock.text));
});

test("triageDrained: thrifty keeps ALL §9.1 blocker sources (inbox/ask/health) to the last token, sheds only non-blocker findings (§12.2)", async () => {
  const clock = { ms: 3_000_000 };
  const stores = makeMemoryStores();
  const modelCalls = [];
  const INBOX_ROW = {
    source: "inbox",
    ts: clock.ms,
    noteId: "note-1",
    noteKind: "blocker",
    message: "deploy failed",
    title: "Deploy",
    tag: "deploy",
    refs: [],
    sender: { sessionID: "s1" },
  };
  const ASK_ROW = {
    source: "ask",
    ts: clock.ms,
    sourceKind: "permission",
    sourceId: "perm_1",
    sessionID: "s2",
    message: "Allow rm -rf?",
    title: "Permission needed",
    refs: [],
  };
  const HEALTH_ROW = {
    source: "health",
    ts: clock.ms,
    sourceKind: "health",
    sourceId: "h1",
    message: "watchdog tripped",
    title: "Host health",
    refs: [],
  };
  // The future evidence-driven finding (later ticket) — the ONLY class the
  // shed rung may drop.
  const EVIDENCE_ROW = {
    source: "evidence",
    ts: clock.ms,
    message: "tests flaky",
    title: "Flake",
    refs: [],
  };
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async () => true },
    facts: { getState: async () => ({ senderReliability: {} }) },
    runEphemeral: async (args) => {
      modelCalls.push(args);
      return { ok: true, text: '{"plans":[]}' };
    },
    now: () => clock.ms,
    publish: () => {},
  });
  await engine.setThrifty(true, { reason: "test", source: "test" });
  const res = await engine.triageDrained([INBOX_ROW, ASK_ROW, HEALTH_ROW, EVIDENCE_ROW]);
  assert.deepEqual(res, { triaged: 3, shed: 1 });
  assert.equal(modelCalls.length, 3);
  const allCallsText = modelCalls.map((c) => c.context.map((b) => b?.text ?? "").join("\n")).join("\n");
  assert.ok(allCallsText.includes("deploy failed"), "the inbox blocker is triaged");
  assert.ok(allCallsText.includes("Allow rm -rf?"), "the promoted ask is triaged (shed would lose it — consumed at promotion)");
  assert.ok(allCallsText.includes("watchdog tripped"), "the health escalation is triaged");
  assert.ok(!allCallsText.includes("tests flaky"), "the non-blocker finding is shed");
  // Records for every kept blocker landed; nothing for the shed finding.
  const records = (await stores.plans.load()).records;
  assert.equal(Object.keys(records).length, 3);
  assert.ok(records[findingIdOf(INBOX_ROW)]);
  assert.ok(records[findingIdOf(ASK_ROW)]);
  assert.ok(records[findingIdOf(HEALTH_ROW)]);
});

test("triageDrained: no runEphemeral wired → calls gate out, plans store untouched, tick survives", async () => {
  const clock = { ms: 4_000_000 };
  const stores = makeMemoryStores();
  const ledgerRows = [];
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async (row) => ledgerRows.push(row) },
    facts: { getState: async () => ({ senderReliability: {} }) },
    now: () => clock.ms,
    publish: () => {},
  });
  const res = await engine.triageDrained([{ source: "inbox", ts: clock.ms, noteId: "n", noteKind: "blocker", message: "m", refs: [] }]);
  assert.deepEqual(res, { triaged: 0, shed: 0 }, "a gated call is neither a triage nor a shed");
  assert.deepEqual((await stores.plans.load()).records, {});
  assert.ok(ledgerRows.some((r) => r.kind === "cto.triage" && r.gated === true), "the gated call leaves its ledger trail");
  // And the whole card tick still completes with a queued finding.
  await stores.findings.save({
    v: 1,
    findings: [{ source: "inbox", ts: clock.ms, noteId: "n2", noteKind: "blocker", message: "m2", refs: [] }],
  });
  await engine.cardTick();
  assert.deepEqual((await stores.findings.load()).findings, []);
  assert.deepEqual((await stores.plans.load()).records, {}, "gated tick stores no plans");
});

test("BET-1516: start() prunes the orphaned concurrentEphemeral health card (marker-guarded)", async () => {
  const stores = makeMemoryStores();
  await stores.cards.save({
    v: 1,
    cards: [
      { id: "orphan", variant: "blocker", state: "open", sourceKind: "health", sourceId: "rate_limit", body: "concurrentEphemeral", refs: [] },
    ],
  });
  await stores.engineState.save({
    v: 1,
    pendingBlockers: [{ id: "b1", kind: "blocker", source: "rate_limit", reason: "concurrentEphemeral", ts: 1, resolved: false }],
  });
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: true }),
    stores,
    ledger: { append: async () => true },
    now: () => 1_000_000,
    publish: () => {},
  });
  await engine.start();
  assert.equal((await stores.cards.load()).cards.length, 0);
  assert.deepEqual((await stores.engineState.load()).pendingBlockers, []);
  // Marker stamped — a rebuild is a no-op re-prune of a clean store.
  assert.equal((await stores.engineState.load()).shedCardPrune?.pruned, true);
  engine.dispose();
});
