// ctoWatchers.test.mjs — standing-query watcher engine (BET-1398 / §4.3, §13.4).
// Pure logic + injected I/O (fake store/ledger/engineState), no live services:
//   - predicate validation (closed set of 3 kinds; unknown/bad params rejected)
//   - event-pattern matching over evidence text/kind
//   - rate-threshold window counting fires at threshold, then resets
//   - usage-burn fires when burst spend vs cap fraction (once per window)
//   - upsert keying (auto-created watchers never duplicate; re-arm on resurface)
//   - retirement (30d inactive, or the underlying signature archived)
//   - migration idempotency (run twice = once, marker-guarded)
//   - auto-creation from day-rollup bullets (>=2 distinct days, 7-day window)
//   - hit → B4 candidate-source wiring (sourceKind, incl. watcher-hit-rate)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREDICATE_KINDS,
  EVENT_PATTERN,
  RATE_THRESHOLD,
  USAGE_BURN,
  validatePredicate,
  eventPatternMatches,
  rateEventCounts,
  usageBurnHit,
  makeWatcher,
  patternSignatureFor,
  upsertWatchers,
  retireWatchers,
  migrateLegacyWatches,
  extractSignifiers,
  extractRecurringThemes,
  watcherHitPayload,
  collectWatcherHitsFromLedger,
  pruneRetiredWatchers,
  createStandingQueryEngine,
} from "./ctoWatchers.mjs";
import { RETENTION_MS } from "./ctoStores.mjs";
import { NOTIFY_RECURRENCE_KINDS, collectFindings } from "./ctoSuggest.mjs";

function makeEngineDeps(overrides = {}) {
  const state = { watchers: [] };
  const ledgerRows = [];
  const es = {};
  return {
    store: {
      load: async () => state,
      save: async (p) => {
        state.watchers = p.watchers;
      },
    },
    ledger: {
      append: async (row) => ledgerRows.push(row),
    },
    engineState: {
      load: async () => es,
      save: async (p) => {
        Object.assign(es, p);
      },
    },
    now: () => 1_000_000,
    publish: () => {},
    getSpendInWindow: async () => 0,
    getCapUsd: async () => 100,
    ledgerRows,
    es,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Predicate validation (closed set)
// ---------------------------------------------------------------------------

test("PREDICATE_KINDS is exactly the closed set of three", () => {
  assert.deepEqual([...PREDICATE_KINDS].sort(), ["event-pattern", "rate-threshold", "usage-burn"]);
});

test("validatePredicate accepts the three valid kinds with required params", () => {
  assert.equal(validatePredicate({ kind: EVENT_PATTERN, params: { pattern: "P0" } }).ok, true);
  assert.equal(validatePredicate({ kind: RATE_THRESHOLD, params: { threshold: 3, windowMs: 6000 } }).ok, true);
  assert.equal(validatePredicate({ kind: USAGE_BURN, params: { windowMs: 6000, capFraction: 0.5 } }).ok, true);
});

test("validatePredicate rejects unknown kinds and bad params", () => {
  assert.equal(validatePredicate({ kind: "pager" }).ok, false);
  assert.equal(validatePredicate(null).ok, false);
  assert.equal(validatePredicate({ kind: EVENT_PATTERN, params: {} }).ok, false);
  assert.equal(validatePredicate({ kind: EVENT_PATTERN, params: { pattern: "[" } }).ok, false);
  assert.equal(validatePredicate({ kind: RATE_THRESHOLD, params: { threshold: 0, windowMs: 1 } }).ok, false);
  assert.equal(validatePredicate({ kind: USAGE_BURN, params: { windowMs: 1, capFraction: 2 } }).ok, false);
});

// ---------------------------------------------------------------------------
// event-pattern
// ---------------------------------------------------------------------------

test("eventPatternMatches matches against evidence text and kind", () => {
  const ep = { kind: EVENT_PATTERN, params: { pattern: "P0|cli" } };
  assert.equal(eventPatternMatches(ep, { text: "a P0 opens", kind: "error" }), true);
  assert.equal(eventPatternMatches(ep, { text: "nothing here", kind: "prompt" }), false);
  assert.equal(eventPatternMatches({ kind: EVENT_PATTERN, params: { pattern: "cli", fields: "kind" } }, { text: "foo cli", kind: "tool.cli" }), true);
  assert.equal(eventPatternMatches({ kind: EVENT_PATTERN, params: { pattern: "cli", fields: "text" } }, { text: "foo cli", kind: "tool.cli" }), true);
});

// ---------------------------------------------------------------------------
// Standing-query engine — rate-threshold + usage-burn + hits
// ---------------------------------------------------------------------------

test("rate-threshold watcher fires when the count in the window reaches threshold, then resets", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: RATE_THRESHOLD, params: { threshold: 3, windowMs: 6000 } } });
  // three matching events within the window trip the hit
  await eng.evaluateEvent({ text: "click", kind: "error" });
  await eng.evaluateEvent({ text: "click", kind: "error" });
  await eng.evaluateEvent({ text: "click", kind: "error" });
  const hits = deps.ledgerRows.filter((r) => r.kind === "watcher.hit");
  assert.equal(hits.length, 1);
  // window restarted — needs a fresh burst of 3 before firing again
  await eng.evaluateEvent({ text: "click", kind: "error" });
  await eng.evaluateEvent({ text: "click", kind: "error" });
  assert.equal(deps.ledgerRows.filter((r) => r.kind === "watcher.hit").length, 1);
});

test("rate-threshold honors an eventKind filter (other kinds don't count)", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: RATE_THRESHOLD, params: { threshold: 2, windowMs: 6000, eventKind: "error" } } });
  await eng.evaluateEvent({ text: "boom", kind: "prompt" });
  await eng.evaluateEvent({ text: "boom", kind: "prompt" });
  assert.equal(deps.ledgerRows.filter((r) => r.kind === "watcher.hit").length, 0);
});

test("usage-burn fires when burst spend is at/above the cap fraction (once per window)", async () => {
  const deps = makeEngineDeps({
    getSpendInWindow: async () => 60, // windowMs 6000 of a day = huge share
    getCapUsd: async () => 100,
  });
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: USAGE_BURN, params: { windowMs: 6000, capFraction: 0.5 } } });
  // 60 >= 0.5 * (100 * 6000 / 86400000)=0.0035 → true
  await eng.runTick();
  assert.equal(deps.ledgerRows.filter((r) => r.kind === "watcher.hit").length, 1);
});

test("usage-burn does not fire when spend is below the cap share", async () => {
  const deps = makeEngineDeps({
    getSpendInWindow: async () => 0,
    getCapUsd: async () => 100,
  });
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: USAGE_BURN, params: { windowMs: 6000, capFraction: 0.5 } } });
  await eng.runTick();
  assert.equal(deps.ledgerRows.filter((r) => r.kind === "watcher.hit").length, 0);
});

test("event-pattern watcher hit becomes a high-salience evidence event", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: EVENT_PATTERN, params: { pattern: "refactor" } } });
  await eng.evaluateEvent({ text: "time to refactor the store", kind: "tool", refs: ["a", "b"] });
  const hits = deps.ledgerRows.filter((r) => r.kind === "watcher.hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].salience, "high");
  assert.deepEqual(hits[0].refs, ["a", "b"], "refs carried through");
});

// ---------------------------------------------------------------------------
// Upsert (auto-created watchers never duplicate) + retirement
// ---------------------------------------------------------------------------

test("upsertWatchers keys by patternSignature — never duplicates, re-arms a retired one", () => {
  const t = 1;
  let { next, added } = upsertWatchers([], [{ patternSignature: "bet_123", predicate: { kind: EVENT_PATTERN, params: { pattern: "BET-123" } }, source: "auto" }], { now: () => t });
  assert.equal(added.length, 1);
  assert.equal(next.length, 1);
  // same signature again → no new watcher
  const second = upsertWatchers(next, [{ patternSignature: "bet_123", predicate: { kind: EVENT_PATTERN, params: { pattern: "BET-123" } }, source: "auto" }], { now: () => t });
  assert.equal(second.added.length, 0);
  assert.equal(second.next.length, 1);
  // retirement then resurface re-arms in place (retired watcher kept, flagged)
  const { next: retiredNext } = retireWatchers(second.next, { nowMs: 1 + 31 * 24 * 3_600_000 });
  assert.equal(retiredNext.length, 1);
  assert.equal(retiredNext[0].retired, true);
  const rearm = upsertWatchers(retiredNext, [{ patternSignature: "bet_123", predicate: { kind: EVENT_PATTERN, params: { pattern: "BET-123" } }, source: "auto" }], { now: () => t + 1 });
  assert.equal(rearm.updated[0].rearmed, true);
  assert.equal(rearm.next[0].retired, false);
});

test("retireWatchers retires inactive watchers and archived signatures", () => {
  const nowMs = 3_000_000_000_000;
  const DAY = 86_400_000;
  const list = [
    { id: "w1", patternSignature: "s1", created: nowMs - 60 * DAY, lastHit: nowMs - 40 * DAY, retired: false }, // inactive (40d)
    { id: "w2", patternSignature: "s2", created: nowMs - 10, lastHit: nowMs - 5, retired: false }, // active
    { id: "w3", patternSignature: "s3", created: nowMs, lastHit: null, retired: false }, // archived signature
  ];
  const { next, retired } = retireWatchers(list, { nowMs, archivedSignatures: ["s3"] });
  // w2 stays active; w1/w3 stay present but flagged retired.
  assert.deepEqual(next.map((w) => w.id).sort(), ["w1", "w2", "w3"]);
  assert.deepEqual(
    next
      .filter((w) => !w.retired)
      .map((w) => w.id),
    ["w2"],
  );
  assert.deepEqual(retired.map((r) => r.id).sort(), ["w1", "w3"]);
  assert.equal(retired.find((r) => r.id === "w3").reason, "archived");
  assert.equal(next.find((w) => w.id === "w1").retired, true);
});

// BET-1466 item 1: retired rows used to accumulate forever — the tick now
// drops them past the day-rollup retention bound.
test("pruneRetiredWatchers drops retired rows past the day-rollup retention, keeps the rest", () => {
  const nowMs = 3_000_000_000_000;
  const retention = RETENTION_MS["rollups/day"];
  const list = [
    { id: "old", retired: true, retiredAt: nowMs - retention - 1, patternSignature: "s-old" },
    { id: "edge", retired: true, retiredAt: nowMs - retention, patternSignature: "s-edge" }, // exactly at the bound → kept
    { id: "fresh", retired: true, retiredAt: nowMs - 1_000, patternSignature: "s-fresh" },
    { id: "active", retired: false, patternSignature: "s-live" },
    { id: "no-ts", retired: true, patternSignature: "s-nots" }, // malformed — defensive keep
  ];
  const { next, dropped } = pruneRetiredWatchers(list, { nowMs });
  assert.deepEqual(next.map((w) => w.id).sort(), ["active", "edge", "fresh", "no-ts"]);
  assert.deepEqual(dropped, [{ id: "old", patternSignature: "s-old" }]);
});

test("runTick drops retired rows past the retention bound from the store (BET-1466 item 1)", async () => {
  const state = { watchers: [] };
  const deps = makeEngineDeps({
    store: {
      load: async () => state,
      save: async (p) => {
        state.watchers = p.watchers;
      },
    },
  });
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: EVENT_PATTERN, params: { pattern: "boom" } } });
  await eng.register({ predicate: { kind: EVENT_PATTERN, params: { pattern: "calm" } } });
  const retention = RETENTION_MS["rollups/day"];
  const t = 3_000_000_000_000;
  // Age one watcher's retirement past the bound and leave the other fresh.
  state.watchers[0].retired = true;
  state.watchers[0].retiredAt = t - retention - 1;
  state.watchers[1].retired = true;
  state.watchers[1].retiredAt = t - 1_000;
  // A later tick (far future) runs the same retirement+prune pass.
  const agedEng = createStandingQueryEngine({ ...deps, now: () => t });
  await agedEng.runTick();
  // Only the fresh-retired row survives; the past-bound one is gone.
  assert.equal(state.watchers.length, 1);
  assert.equal(state.watchers[0].retired, true);
  assert.equal(state.watchers[0].retiredAt, t - 1_000);
  // Idempotent: a second tick drops nothing further.
  await agedEng.runTick();
  assert.equal(state.watchers.length, 1);
});

test("engine list reads are fresh but per-event evaluation reads the file once per burst (BET-1466 item 1b)", async () => {
  let loads = 0;
  const deps = makeEngineDeps();
  deps.store = {
    load: async () => {
      loads += 1;
      return { watchers: deps.savedWatchers ?? [] };
    },
    save: async (p) => {
      deps.savedWatchers = p.watchers;
    },
  };
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: EVENT_PATTERN, params: { pattern: "boom" } } });
  const loadsAfterRegister = loads;
  // A burst of evidence events: one file read total (the cache from the burst's
  // first evaluation is reused; the register's own write refreshed it).
  await eng.evaluateEvent({ text: "nothing", kind: "prompt" });
  await eng.evaluateEvent({ text: "still nothing", kind: "prompt" });
  await eng.evaluateEvent({ text: "quiet", kind: "tool" });
  assert.equal(loads, loadsAfterRegister, "the burst reuses one read; no per-event file reads");
  assert.equal(deps.ledgerRows.filter((r) => r.kind === "watcher.hit").length, 0);
  // list() stays a fresh read (user-facing surface).
  const list = await eng.list();
  assert.equal(list.length, 1);
  assert.equal(loads > loadsAfterRegister, true);
});

// ---------------------------------------------------------------------------
// Auto-creation from day rollups
// ---------------------------------------------------------------------------

test("extractRecurringThemes picks patterns appearing in >=2 distinct day bullets within 7 days", () => {
  const nowMs = 1_000_000;
  const day = nowMs - 86_400_000;
  const dayRollups = [
    { level: "day", window: [day, day + 86_400_000], bullets: [{ text: "BET-123 still failing in deploy" }] },
    { level: "day", window: [day, day + 86_400_000], bullets: [{ text: "BET-123 reappears; CLI broke" }] },
    { level: "day", window: [day, day + 86_400_000], bullets: [{ text: "random unrelated work" }] },
  ];
  const themes = extractRecurringThemes(dayRollups, { now: () => nowMs, minOccurrences: 2 });
  const sigs = themes.map((t) => t.patternSignature);
  assert.ok(sigs.includes("bet_123"), "BET-123 recurs in 2 bullets");
  assert.ok(!sigs.includes("cli"), "single-occurrence "); // cli appears in one bullet only
});

test("engine.autoCreate upserts recurring themes by patternSignature", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  const day = 1_000_000 - 86_400_000;
  const rollups = [
    { level: "day", window: [day, day + 86_400_000], bullets: [{ text: "deploy failed on BET-99" }] },
    { level: "day", window: [day, day + 86_400_000], bullets: [{ text: "BET-99 flaky again" }] },
  ];
  const first = await eng.autoCreate(rollups);
  assert.ok(first.added.some((a) => a.patternSignature === "bet_99"));
  const second = await eng.autoCreate(rollups);
  assert.equal(second.added.length, 0, "second pass never dups");
});

// ---------------------------------------------------------------------------
// Migration idempotency
// ---------------------------------------------------------------------------

test("migrateLegacy converts cto.json watches once and is a no-op on re-run", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  const legacy = [
    { id: "w1", surface: "schedule", query: "read board", condition: "a P0 opens", active: true, createdAt: 10 },
    { id: "w2", surface: "delegate", query: "q", condition: "deploy failed", active: true, createdAt: 11 },
    { id: "w3", surface: "session", query: "q", condition: "a P0 opens", active: false, createdAt: 12 }, // inactive → skipped
  ];
  const firstRun = await eng.migrateLegacy(legacy);
  assert.equal(firstRun.migrated, true);
  assert.equal(firstRun.count, 2);
  assert.equal((await eng.list()).length, 2);
  // re-run is a no-op (marker in engine-state)
  const secondRun = await eng.migrateLegacy(legacy);
  assert.equal(secondRun.migrated, false);
  assert.equal(secondRun.count, 0);
  assert.equal((await eng.list()).length, 2);
});

test("migrateLegacyWatches is pure and skips un-matchable conditions", () => {
  const converted = migrateLegacyWatches(
    [
      { id: "a", surface: "schedule", query: "q", condition: "deploy failed", active: true, createdAt: 1 },
      { id: "b", surface: "session", condition: "the", active: true, createdAt: 2 }, // stopwords only → dropped
    ],
    { now: () => 5 },
  );
  assert.equal(converted.length, 1);
  assert.equal(converted[0].id, "a");
  assert.equal(converted[0].predicate.kind, EVENT_PATTERN);
  assert.equal(converted[0].legacy.surface, "schedule");
});

// ---------------------------------------------------------------------------
// Watcher hits → B4 candidate source
// ---------------------------------------------------------------------------

test("watcherHitPayload carries predicate-kind → sourceKind mapping", () => {
  const ep = makeWatcher({ predicate: { kind: EVENT_PATTERN, params: { pattern: "x" } }, now: () => 1 }).watch;
  const rt = makeWatcher({ predicate: { kind: RATE_THRESHOLD, params: { threshold: 2, windowMs: 5 } }, now: () => 1 }).watch;
  assert.equal(watcherHitPayload(ep, {}).sourceKind, "watcher-hit");
  assert.equal(watcherHitPayload(rt, {}).sourceKind, "watcher-hit-rate");
});

test("watcherHitPayload keeps the evidence event's project (BET-1428), omits it when absent", () => {
  const ep = makeWatcher({ predicate: { kind: EVENT_PATTERN, params: { pattern: "x" } }, now: () => 1 }).watch;
  assert.equal(watcherHitPayload(ep, { project: "/repo" }).project, "/repo");
  assert.equal("project" in watcherHitPayload(ep, {}), false, "no project → no key (existing rows stay shape-identical)");
  assert.equal("project" in watcherHitPayload(ep, { project: "" }), false);
  assert.equal("project" in watcherHitPayload(ep, { project: 7 }), false);
});

test("collectWatcherHitsFromLedger produces B4 findings (rate-threshold → watcher-hit-rate)", () => {
  const rows = [
    { kind: "watcher.hit", salience: "high", watcherId: "w1", predicateKind: RATE_THRESHOLD, text: "burst of failures", ts: 1 },
    { kind: "watcher.hit", salience: "high", watcherId: "w2", predicateKind: EVENT_PATTERN, text: "theme", ts: 2 },
    { kind: "other", salience: "high", watcherId: "w3", text: "nope" },
  ];
  const findings = collectWatcherHitsFromLedger(rows);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.sourceKind).sort(), ["watcher-hit", "watcher-hit-rate"]);
  assert.deepEqual(findings.map((f) => f.id).sort(), ["wh:w1", "wh:w2"]);
});

test("collectWatcherHitsFromLedger passes the hit row's hosting project through (BET-1428)", () => {
  const rows = [
    { kind: "watcher.hit", salience: "high", watcherId: "w1", predicateKind: RATE_THRESHOLD, text: "burst", project: "/repo", ts: 1 },
    { kind: "watcher.hit", salience: "high", watcherId: "w2", predicateKind: EVENT_PATTERN, text: "theme", ts: 2 },
    { kind: "watcher.hit", salience: "high", watcherId: "w3", predicateKind: EVENT_PATTERN, text: "bad", project: 42, ts: 3 },
  ];
  const findings = collectWatcherHitsFromLedger(rows);
  assert.equal(findings[0].project, "/repo");
  assert.equal(findings[1].project, undefined);
  assert.equal(findings[2].project, undefined, "non-string project degrades to undefined");
});

test("an evidence event's project rides the hit into the ledger (BET-1428)", async () => {
  const deps = makeEngineDeps();
  const eng = createStandingQueryEngine(deps);
  await eng.register({ predicate: { kind: EVENT_PATTERN, params: { pattern: "boom" } } });
  await eng.evaluateEvent({ text: "boom", kind: "prompt", project: "/repo" });
  const hit = deps.ledgerRows.find((r) => r.kind === "watcher.hit");
  assert.ok(hit, "one hit row");
  assert.equal(hit.project, "/repo", "the hosting project is captured at hit time");
});

test("the steep-decay notify rule set gained watcher-hit-rate", () => {
  assert.ok(NOTIFY_RECURRENCE_KINDS.includes("watcher-hit-rate"));
  assert.ok(NOTIFY_RECURRENCE_KINDS.includes("failure-recurrence"));
});

test("collectFindings wires watcher hits into the candidate source input set", () => {
  const ledgerRows = [
    { kind: "watcher.hit", salience: "high", watcherId: "w1", predicateKind: EVENT_PATTERN, text: "theme match", ts: 1 },
  ];
  const findings = collectFindings([], [], { ledgerRows });
  assert.ok(findings.some((f) => f.sourceKind === "watcher-hit" && f.text.includes("theme match")));
  // without ledger rows no watcher findings
  const none = collectFindings([], [], {});
  assert.equal(none.some((f) => f.sourceKind === "watcher-hit"), false);
});
