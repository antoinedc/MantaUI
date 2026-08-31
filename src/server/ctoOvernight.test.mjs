// src/server/ctoOvernight.test.mjs
// BET-1402 — pure-logic tests for the overnight scheduler CORE (node:test,
// injected I/O only — no live tmux/opencode/network).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ABSENCE_SILENCE_MIN_MS,
  CANDIDATE_CATEGORIES,
  CONFIDENCE_LATTICE,
  COUNTDOWN_ABANDON_GRACE_MS,
  DEFAULT_PREDICTED_COST,
  HYGIENE_FLOOR_SHARE,
  VALUE_LATTICE,
  absenceSignal,
  createOvernightScheduler,
  decayFactor,
  evaluateGates,
  evaluateWindow,
  expireDrafts,
  foldVerdictIntoCounters,
  gitOnlyJobRule,
  lambdaFromSpendable,
  normalizeWindow,
  preemptOnReturn,
  reconcileOnRestart,
  routeRequestShaped,
  scheduleCountdown,
  scoreCandidates,
  selectPortfolio,
  snapToLattice,
  thompsonMultiplier,
} from "./ctoOvernight.mjs";

const H = 3_600_000;
const T0 = 1_800_000_000_000; // arbitrary fixed epoch
const TROUGH = { startMs: T0, endMs: T0 + 6 * H };

function tickInput(over = {}) {
  return {
    now: T0 + H,
    trough: TROUGH,
    presence: "gone",
    hasDesktop: true,
    lastUserEventMs: T0 - H,
    candidateCount: 3,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §11.1 — window state machine
// ---------------------------------------------------------------------------

test("window opens on presence-gone inside the trough", () => {
  const { window, ledgerRows } = evaluateWindow(null, tickInput());
  assert.equal(window.state, "open");
  assert.equal(window.openedBy, "presence-gone");
  assert.equal(window.openedMs, T0 + H);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.open"));
});

test("window opens on ≥60 min of zero user events inside the trough (no-desktop box)", () => {
  const { window } = evaluateWindow(
    null,
    tickInput({ presence: null, hasDesktop: false, now: T0 + ABSENCE_SILENCE_MIN_MS + 1, lastUserEventMs: T0 - 5 * 60_000 }),
  );
  assert.equal(window.state, "open");
  assert.equal(window.openedBy, "event-silence");
});

test("pre-trough quiet does not count toward the 60-min silence (signal must be inside the trough)", () => {
  // Last user event 2h before the trough; only 30 min of trough-internal silence.
  const { window } = evaluateWindow(null, tickInput({ presence: null, hasDesktop: false, now: T0 + 30 * 60_000, lastUserEventMs: T0 - 2 * H }));
  assert.equal(window.state, "closed");
});

test("sub-60-min silence never opens (no-desktop box)", () => {
  const { window } = evaluateWindow(
    null,
    tickInput({ presence: null, hasDesktop: false, now: T0 + 59 * 60_000, lastUserEventMs: T0 }),
  );
  assert.equal(window.state, "closed");
});

test("prolonged signal ABSENCE alone never opens (desktop box, presence unknown/present)", () => {
  for (const presence of [null, "present"]) {
    const { window } = evaluateWindow(null, tickInput({ presence, lastUserEventMs: T0 - 48 * H }));
    assert.equal(window.state, "closed", `presence=${presence}`);
    assert.equal(absenceSignal({ now: T0 + H, presence, hasDesktop: true, lastUserEventMs: T0 - 48 * H }), null);
  }
});

test("window closes at trough end", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const { window: closed, ledgerRows } = evaluateWindow(window, tickInput({ now: TROUGH.endMs }));
  assert.equal(closed.state, "closed");
  assert.equal(closed.closeReason, "trough-end");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.close" && r.reason === "trough-end"));
});

test("window closes on user return (presence flip)", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const { window: closed, ledgerRows } = evaluateWindow(window, tickInput({ now: T0 + 2 * H, presence: "present" }));
  assert.equal(closed.state, "closed");
  assert.equal(closed.closeReason, "user-return");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.close" && r.reason === "user-return"));
});

test("window closes on a fresh user-originated event after open", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const { window: closed } = evaluateWindow(window, tickInput({ now: T0 + 90 * 60_000, lastUserEventMs: T0 + 80 * 60_000 }));
  assert.equal(closed.state, "closed");
  assert.equal(closed.closeReason, "user-event");
});

test("run-now override opens immediately, even outside the trough", () => {
  const { window, ledgerRows } = evaluateWindow(null, tickInput({ now: T0 - 3 * H, trough: null, runNow: true }));
  assert.equal(window.state, "open");
  assert.equal(window.openedBy, "run-now");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.open"));
});

test("a run-now window opened while the user is present is NOT closed by presence alone — the next user event closes it", () => {
  const { window } = evaluateWindow(null, tickInput({ presence: "present", runNow: true }));
  assert.equal(window.openedDuringPresence, true);
  const stillOpen = evaluateWindow(window, tickInput({ presence: "present", runNow: true, now: T0 + 2 * H }));
  assert.equal(stillOpen.window.state, "open");
  const closed = evaluateWindow(window, tickInput({ presence: "present", runNow: true, now: T0 + 2 * H, lastUserEventMs: T0 + 2 * H }));
  assert.equal(closed.window.state, "closed");
  assert.equal(closed.window.closeReason, "user-event");
});

test("zero candidates → no window at all (§11.4 graceful-empty), even on run-now", () => {
  for (const runNow of [false, true]) {
    const { window, ledgerRows } = evaluateWindow(null, tickInput({ candidateCount: 0, runNow }));
    assert.equal(window.state, "closed", `runNow=${runNow}`);
    assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.no-candidates"), `runNow=${runNow}`);
  }
});

// BET-1466 item 2: the no-candidates row is stamped with its trough (one row
// per trough, not one per tick) and an unchanged window state is not re-saved.
test("no-candidates row emits once per trough; idle trough ticks skip the save", async () => {
  let saves = 0;
  let saved = { v: 1, window: null };
  const ledgerRows = [];
  let clock = T0 + H;
  const scheduler = createOvernightScheduler({
    store: {
      load: async () => saved,
      save: async (d) => {
        saves += 1;
        saved = d;
      },
    },
    now: () => clock,
    budget: async () => FAT,
    ledger: { append: async (row) => ledgerRows.push(row) },
  });
  // The scheduler reads its clock from the injected `now` (input.now is not
  // consulted by tick), so the test advances the clock between ticks.
  const input = (trough) => tickInput({ candidateCount: 0, candidates: [], trough });
  const t1 = await scheduler.tick(input(TROUGH));
  assert.equal(t1.ledgerRows.filter((r) => r.kind === "cto.overnight.no-candidates").length, 1);
  assert.equal(saves, 1, "the first report stamps the trough start and saves");
  // Same trough, a minute later: no new row, and the save is skipped.
  clock = T0 + H + 60_000;
  const t2 = await scheduler.tick(input(TROUGH));
  assert.equal(t2.ledgerRows.filter((r) => r.kind === "cto.overnight.no-candidates").length, 0);
  assert.equal(saves, 1, "an unchanged window state is not re-saved");
  // A NEW trough reports again (the old stamp expires with its trough).
  const nextTrough = { startMs: T0 + 24 * H, endMs: T0 + 30 * H };
  clock = T0 + 25 * H;
  const t3 = await scheduler.tick(input(nextTrough));
  assert.equal(t3.ledgerRows.filter((r) => r.kind === "cto.overnight.no-candidates").length, 1);
  assert.equal(saves, 2, "the new trough's stamp is persisted");
});

test("a fulfilled veto countdown is cleared by the open it announced", () => {
  const due = T0 + 30 * 60_000;
  let window = scheduleCountdown(null, { now: T0, dueMs: due });
  assert.equal(window.countdown.dueMs, due);
  const { window: opened } = evaluateWindow(window, tickInput({ now: due + 60_000 }));
  assert.equal(opened.state, "open");
  assert.equal(opened.countdown, null);
});

test("a veto countdown elapsed unmet past the grace window is abandoned + ledgered, never executed late", () => {
  const due = T0 + 30 * 60_000;
  const window = scheduleCountdown(null, { now: T0, dueMs: due });
  // Due passed, but the box was down: no trough membership now (or no signal).
  const { window: after, ledgerRows } = evaluateWindow(window, tickInput({ now: due + COUNTDOWN_ABANDON_GRACE_MS + 60_000, trough: null }));
  assert.equal(after.state, "closed");
  assert.equal(after.countdown, null);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.countdown-abandoned"));
});

test("restart mid-window: window re-derived and kept, spendable recompute required", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const { window: after, recomputeSpendable, ledgerRows } = reconcileOnRestart(window, { now: T0 + 2 * H, trough: TROUGH });
  assert.equal(after.state, "open");
  assert.equal(after.openedMs, T0 + H);
  assert.equal(recomputeSpendable, true);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.restart"));
});

test("restart with the window's trough fully elapsed: skipped, never run retroactively (no-catch-up)", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const { window: after, recomputeSpendable, ledgerRows } = reconcileOnRestart(window, { now: TROUGH.endMs + 3 * H, trough: TROUGH });
  assert.equal(after.state, "closed");
  assert.equal(recomputeSpendable, false);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.close" && r.reason === "trough-end"));
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.no-catch-up"));
});

test("restart with an elapsed pending veto countdown abandons it", () => {
  const due = T0 + 30 * 60_000;
  const window = scheduleCountdown(null, { now: T0, dueMs: due });
  const { window: after, ledgerRows } = reconcileOnRestart(window, { now: due + 2 * H, trough: TROUGH });
  assert.equal(after.countdown, null);
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.countdown-abandoned"));
});

test("normalizeWindow never throws on garbage and degrades to a closed window", () => {
  for (const garbage of [null, undefined, 42, "x", { state: "bogus" }, { state: "open" }]) {
    const w = normalizeWindow(garbage);
    assert.equal(w.state, garbage?.state === "open" ? "open" : "closed");
    assert.equal(Array.isArray(w.pinnedOrder) || w.pinnedOrder === null, true);
  }
});

// ---------------------------------------------------------------------------
// §11.4 — portfolio scorer
// ---------------------------------------------------------------------------

const FAT = { spendableFrac: 0.8, remainingFrac: 0.9 };
const THIN = { spendableFrac: 0.25, remainingFrac: 0.4 };

function candidate(over = {}) {
  return {
    id: over.id ?? "c1",
    category: "suggestion",
    value: 2,
    confidence: 1.0,
    pUse: 1,
    predictedCost: 2,
    lastTouchedMs: T0 + H, // fresh → decay 1
    ...over,
  };
}

test("Score = p_use · Value · Confidence · Decay / (λ·PredictedCost), formula verbatim (fat budget → λ=0, no counters → θ=0.5)", () => {
  const [scored] = scoreCandidates([candidate()], { now: T0 + H, spendable: FAT });
  // λ=0 → denominator resolved to 1; numerator = 1·2·1·1·0.5
  assert.equal(scored.lambda, 0);
  assert.equal(scored.thompson, 0.5);
  assert.ok(Math.abs(scored.score - 1) < 1e-12);
});

test("Thompson blend uses the category's acceptance posterior (all-success → 1, all-rejection → 0)", () => {
  const c = [candidate()];
  const yes = scoreCandidates(c, { now: T0 + H, spendable: FAT, counters: { suggestion: { alpha: 4, beta: 0 } } });
  const no = scoreCandidates(c, { now: T0 + H, spendable: FAT, counters: { suggestion: { alpha: 0, beta: 4 } } });
  assert.equal(yes[0].thompson, 1);
  assert.equal(no[0].thompson, 0);
  assert.ok(yes[0].score > no[0].score);
});

test("Value and Confidence snap to the coarse lattices; unscoreable candidates are dropped", () => {
  assert.deepEqual(snapToLattice(2.4, VALUE_LATTICE), 2);
  assert.deepEqual(snapToLattice(0.9, VALUE_LATTICE), 1);
  assert.deepEqual(snapToLattice(0.75, CONFIDENCE_LATTICE), 0.8);
  assert.equal(snapToLattice("high", VALUE_LATTICE), null);
  const scored = scoreCandidates([candidate({ id: "good", value: 2.4, confidence: 0.75 }), candidate({ id: "bad", value: "huge" })], {
    now: T0 + H,
    spendable: FAT,
  });
  assert.deepEqual(scored.map((c) => c.id), ["good"]);
  assert.equal(scored[0].value, 2);
  assert.equal(scored[0].confidence, 0.8);
});

test("missing/invalid predictedCost falls back to the default (unknown-cost maintenance stays scoreable)", () => {
  const [scored] = scoreCandidates([candidate({ category: "maintenance", predictedCost: null })], { now: T0 + H, spendable: THIN });
  assert.equal(scored.predictedCost, DEFAULT_PREDICTED_COST);
});

test("λ rises as spendable thins; a thin budget makes the cheap job win near dawn", () => {
  assert.equal(lambdaFromSpendable({ spendableFrac: 0.5 }), 0);
  assert.equal(lambdaFromSpendable({ spendableFrac: 0.25 }), 5);
  assert.equal(lambdaFromSpendable({ spendableFrac: 0 }), 10);
  assert.equal(lambdaFromSpendable({ spendableFrac: null }), 0); // windowless → no shadow price
  assert.equal(lambdaFromSpendable({}), 0); // unreadable budget → graceful fat default

  const expensive = candidate({ id: "expensive", value: 3, confidence: 1.0, predictedCost: 8 });
  const cheap = candidate({ id: "cheap", value: 1, confidence: 1.0, predictedCost: 1 });
  const fat = scoreCandidates([expensive, cheap], { now: T0 + H, spendable: FAT });
  assert.deepEqual(fat.map((c) => c.id), ["expensive", "cheap"]); // one expensive high-value job wins early
  const thin = scoreCandidates([expensive, cheap], { now: T0 + H, spendable: THIN });
  assert.deepEqual(thin.map((c) => c.id), ["cheap", "expensive"]); // cheap jobs win near dawn
});

test("Decay: staleness per-category τ, rising-urgency boost for untouched projects", () => {
  const stale = candidate({ lastTouchedMs: T0 + H - 4 * 24 * H }); // 4 days old
  const freshTau = decayFactor(stale, { now: T0 + H }); // suggestion τ = 3d
  assert.ok(freshTau < 1 && freshTau > 0);
  const urgent = decayFactor({ ...stale, untouchedProjectDays: 9 }, { now: T0 + H });
  assert.ok(Math.abs(urgent - freshTau * 1.5) < 1e-12);
  const noAge = decayFactor(candidate({ lastTouchedMs: null }), { now: T0 + H });
  assert.equal(noAge, 1); // no staleness evidence is not staleness
});

test("hygiene floor: maintenance is guaranteed 20% of the night's budget when maintenance candidates exist", () => {
  const ranked = [
    candidate({ id: "g1", predictedCost: 0.5 }),
    candidate({ id: "g2", predictedCost: 0.5 }),
    candidate({ id: "m1", category: "maintenance", predictedCost: 0.2, value: 0.25 }),
  ];
  const plan = selectPortfolio(ranked, { budgetFrac: 1 });
  assert.equal(plan.hasMaintenance, true);
  assert.equal(plan.floorFrac, HYGIENE_FLOOR_SHARE);
  const ids = plan.selected.map((c) => c.id);
  assert.ok(ids.includes("m1"), "the maintenance candidate is selected despite the low score");
  assert.ok(!ids.includes("g2"), "a general job is shed to honor the floor");
  assert.ok(plan.reservedMaintenanceFrac > 0);
});

test("hygiene floor applies only when maintenance candidates exist", () => {
  const plan = selectPortfolio([candidate({ predictedCost: 0.6 }), candidate({ id: "c2", predictedCost: 0.4 })], { budgetFrac: 1 });
  assert.equal(plan.hasMaintenance, false);
  assert.equal(plan.floorFrac, 0);
  assert.equal(plan.selected.length, 2);
});

test("graceful-empty everywhere: empty classes allocate nothing; empty in → empty out", () => {
  assert.deepEqual(scoreCandidates([], { now: T0 + H, spendable: FAT }), []);
  const plan = selectPortfolio([], { budgetFrac: 1 });
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.hasMaintenance, false);
});

test("a manual pinnedOrder pins that order for the window, exempt from re-scoring", () => {
  const ranked = [candidate({ id: "a" }), candidate({ id: "b", value: 3 }), candidate({ id: "c", value: 0.5 })];
  const plan = selectPortfolio(ranked, { budgetFrac: 10, pinnedOrder: ["c", "a", "b"] });
  assert.deepEqual(plan.selected.map((x) => x.id), ["c", "a", "b"]);
  // The pin survives re-scoring with different inputs (the window machine
  // carries pinnedOrder; selectPortfolio keeps honoring it).
  const rescored = scoreCandidates(ranked, { now: T0 + 2 * H, spendable: THIN, counters: { suggestion: { alpha: 9, beta: 0 } } });
  const plan2 = selectPortfolio(rescored, { budgetFrac: 10, pinnedOrder: ["c", "a", "b"] });
  assert.deepEqual(plan2.selected.map((x) => x.id), ["c", "a", "b"]);
});

test("the window state carries the pin across ticks", () => {
  const { window } = evaluateWindow(null, tickInput());
  const pinned = normalizeWindow({ ...window, pinnedOrder: ["c", "a"] });
  assert.deepEqual(pinned.pinnedOrder, ["c", "a"]);
});

test("candidate categories are the spec's five classes; unknown categories fall back to suggestion", () => {
  assert.deepEqual([...CANDIDATE_CATEGORIES], ["queue-tonight", "suggestion", "data-source", "maintenance", "watcher"]);
  const [s] = scoreCandidates([candidate({ category: "mystery" })], { now: T0 + H, spendable: FAT });
  assert.equal(s.category, "suggestion");
});

test("foldVerdictIntoCounters feeds the two counters per category from verdicts", () => {
  let counters = {};
  counters = foldVerdictIntoCounters(counters, { category: "queue-tonight", verdict: "accept" });
  counters = foldVerdictIntoCounters(counters, { category: "queue-tonight", verdict: "edit" });
  counters = foldVerdictIntoCounters(counters, { category: "queue-tonight", verdict: "veto" });
  counters = foldVerdictIntoCounters(counters, { category: "queue-tonight", verdict: "open", never: true });
  assert.deepEqual(counters["queue-tonight"], { alpha: 2, beta: 2 });
  // thompsonMultiplier consumes the same shape.
  assert.equal(thompsonMultiplier({ queueTonightX: { alpha: 1, beta: 0 } }, "nope"), 0.5);
});

// ---------------------------------------------------------------------------
// §11.5 — execution-contract helpers
// ---------------------------------------------------------------------------

test("empty gate set passes with a `no-gates` note; defined gates list their names", () => {
  const empty = evaluateGates({});
  assert.deepEqual(empty, { pass: true, gates: [], note: "no-gates" });
  const none = evaluateGates(null);
  assert.equal(none.note, "no-gates");
  const full = evaluateGates({ gates: { typecheck: "npm run typecheck", tests: "npm test", lint: null } });
  assert.deepEqual(full, { pass: true, gates: ["typecheck", "tests"], note: null });
});

test("git-only rule: non-git projects never receive file-editing jobs; read-only work is fine", () => {
  assert.deepEqual(gitOnlyJobRule({ git: false }, { fileEditing: true }), { allowed: false, reason: "non-git" });
  assert.deepEqual(gitOnlyJobRule({}, { fileEditing: true }), { allowed: false, reason: "non-git" });
  assert.deepEqual(gitOnlyJobRule({ git: false }, { fileEditing: false }), { allowed: true, reason: null });
  assert.deepEqual(gitOnlyJobRule({ git: true }, { fileEditing: true }), { allowed: true, reason: null });
});

test("batch-flagged request-shaped tasks route to a batch pool only where the adapter reports one", () => {
  const providers = { anthropic: { batchPool: true }, groq: {} };
  assert.deepEqual(routeRequestShaped({ provider: "anthropic", requestShaped: true }, providers), { provider: "anthropic", pool: "batch", reason: null });
  assert.deepEqual(routeRequestShaped({ provider: "groq", requestShaped: true }, providers).pool, "interactive");
  assert.deepEqual(routeRequestShaped({ provider: "anthropic", requestShaped: false }, providers).pool, "interactive");
  assert.deepEqual(routeRequestShaped({ provider: "unknown", requestShaped: true }, providers).pool, "interactive");
  assert.equal(routeRequestShaped({}, providers).provider, null);
});

test("draft expiry: unreviewed 7d → closed with an `expire` verdict + one-line digest note", () => {
  const old = { id: "d1", title: "old draft", createdMs: T0 - 7 * 24 * H };
  const fresh = { id: "d2", createdMs: T0 - 6 * 24 * H };
  const reviewed = { id: "d3", createdMs: T0 - 30 * 24 * H, reviewed: true };
  const { expired, keep } = expireDrafts([old, fresh, reviewed, null], T0);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].draft.id, "d1");
  assert.equal(expired[0].verdict, "expire");
  assert.match(expired[0].digestNote, /old draft/);
  assert.deepEqual(keep.map((d) => d?.id ?? null), ["d2", "d3", null]);
});

test("preempt-on-return: present flip → pause list + window close; run-now-during-presence windows are exempt", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  const decision = preemptOnReturn({ presence: "present", window, runningJobs: ["j1", "j2", 7] });
  assert.equal(decision.shouldPause, true);
  assert.equal(decision.closeWindow, true);
  assert.deepEqual(decision.pauseJobs, ["j1", "j2"]);

  const runNowOpen = evaluateWindow(null, tickInput({ presence: "present", runNow: true })).window;
  const exempt = preemptOnReturn({ presence: "present", window: runNowOpen, runningJobs: ["j1"] });
  assert.equal(exempt.shouldPause, false);

  const closedWindow = normalizeWindow({ ...window, state: "closed" });
  assert.equal(preemptOnReturn({ presence: "present", window: closedWindow }).shouldPause, false);
  assert.equal(preemptOnReturn({ presence: "gone", window }).shouldPause, false);
});

// ---------------------------------------------------------------------------
// The accessor (injected I/O, end-to-end pure-logic glue)
// ---------------------------------------------------------------------------

function memoryScheduler(over = {}) {
  let saved = { v: 1, window: null };
  const ledgerRows = [];
  const scheduler = createOvernightScheduler({
    store: {
      load: async () => saved,
      save: async (d) => {
        saved = d;
      },
    },
    now: () => T0 + H,
    budget: over.budget ?? (async () => FAT),
    ledger: { append: async (row) => ledgerRows.push(row) },
    ...over,
  });
  return { scheduler, saved: () => saved, ledgerRows };
}

test("tick: opens on the absence signal, scores + selects the plan under the live spendable, persists", async () => {
  const { scheduler, saved, ledgerRows } = memoryScheduler();
  const out = await scheduler.tick(tickInput({ candidates: [candidate({ id: "a", predictedCost: 0.5 }), candidate({ id: "b", predictedCost: 0.3 })] }));
  assert.equal(out.window.state, "open");
  assert.deepEqual(out.plan.selected.map((c) => c.id), ["a", "b"]);
  assert.equal(out.plan.budgetFrac, FAT.spendableFrac);
  assert.equal(saved().window.state, "open");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.open"));

  // The user returns → the next tick closes the window (and the plan is gone).
  const closed = await scheduler.tick(tickInput({ now: T0 + 2 * H, presence: "present", candidates: [] }));
  assert.equal(closed.window.state, "closed");
  assert.equal(closed.plan, null);
});

test("tick with an unreadable budget still plans (graceful λ=0 fat default)", async () => {
  const { scheduler } = memoryScheduler({ budget: async () => { throw new Error("budget down"); } });
  const out = await scheduler.tick(tickInput({ candidates: [candidate({ predictedCost: 0.5 })] }));
  assert.equal(out.window.state, "open");
  assert.equal(out.plan.selected.length, 1);
  assert.equal(out.plan.selected[0].lambda, 0);
});

test("reconcile persists the re-derived window and reports the spendable recompute", async () => {
  const { scheduler, saved } = memoryScheduler();
  await scheduler.tick(tickInput({ candidates: [candidate()] }));
  const out = await scheduler.reconcile({ now: T0 + 2 * H, trough: TROUGH });
  assert.equal(out.window.state, "open");
  assert.equal(out.recomputeSpendable, true);
  assert.equal(saved().window.state, "open");
});

test("every pure entry point survives garbage input (graceful, never throws)", () => {
  assert.doesNotThrow(() => evaluateWindow(undefined, undefined));
  assert.doesNotThrow(() => scoreCandidates(undefined, undefined));
  assert.doesNotThrow(() => selectPortfolio(undefined, undefined));
  assert.doesNotThrow(() => expireDrafts(undefined, undefined));
  assert.doesNotThrow(() => reconcileOnRestart(null, null));
  assert.doesNotThrow(() => lambdaFromSpendable(null));
  assert.doesNotThrow(() => betaMeanGuards());
  function betaMeanGuards() {
    // imported indirectly through the module — presence checked via thompson path
    thompsonMultiplier(null, null, () => 0.5);
  }
});

// ---------------------------------------------------------------------------
// BET-1419: the scheduler mutators the engine's tonight verbs ride on
// ---------------------------------------------------------------------------

test("readWindow returns the persisted row (null before anything was written)", async () => {
  const { scheduler } = memoryScheduler();
  assert.equal(await scheduler.readWindow(), null);
  await scheduler.tick(tickInput({ candidates: [candidate()] }));
  assert.equal((await scheduler.readWindow()).state, "open");
});

test("updateWindow applies a pure transition (arm/clear/pin) and persists it", async () => {
  const { scheduler, saved } = memoryScheduler();
  const armed = await scheduler.updateWindow((prev) =>
    scheduleCountdown(prev, { now: T0 - 30 * 60_000, dueMs: T0 }),
  );
  assert.equal(armed.countdown.dueMs, T0);
  assert.equal(saved().window.countdown.dueMs, T0);

  const cleared = await scheduler.updateWindow((prev) =>
    normalizeWindow({ ...normalizeWindow(prev), countdown: null }),
  );
  assert.equal(cleared.countdown, null);
  assert.equal(saved().window.countdown, null);

  // A no-op (null) mutator writes nothing.
  const noop = await scheduler.updateWindow(() => null);
  assert.equal(noop, null);
});

test("foldCounters folds a verdict into the persisted Thompson counters; readCounters reads them back", async () => {
  const { scheduler, saved } = memoryScheduler();
  const c1 = await scheduler.foldCounters({ category: "queue-tonight", verdict: "accept" });
  assert.deepEqual(c1["queue-tonight"], { alpha: 1, beta: 0 });
  const c2 = await scheduler.foldCounters({ category: "queue-tonight", verdict: "veto" });
  assert.deepEqual(c2["queue-tonight"], { alpha: 1, beta: 1 });
  assert.deepEqual(saved().counters["queue-tonight"], { alpha: 1, beta: 1 });
  const back = await scheduler.readCounters();
  assert.deepEqual(back["queue-tonight"], { alpha: 1, beta: 1 });
});

test("closing the window clears the manual pin — the pin governs one window only (§10.4)", async () => {
  const clock = { ms: T0 + H };
  const { scheduler, saved } = memoryScheduler({ now: () => clock.ms });
  // Open on the trough signal.
  await scheduler.tick(tickInput({ candidates: [candidate()] }));
  assert.equal(saved().window.state, "open");
  // Pin an order mid-window.
  await scheduler.updateWindow((prev) =>
    normalizeWindow({ ...normalizeWindow(prev), pinnedOrder: ["b", "a"] }),
  );
  assert.deepEqual(saved().window.pinnedOrder, ["b", "a"]);
  // The trough ends → close clears the pin.
  clock.ms = TROUGH.endMs + 1;
  await scheduler.tick(tickInput({ candidates: [candidate()] }));
  assert.equal(saved().window.state, "closed");
  assert.equal(saved().window.pinnedOrder, null);
});

// ---------------------------------------------------------------------------
// §9.2 — the per-trough veto stamp (BET-1419 review fix)
// ---------------------------------------------------------------------------

test("a per-trough veto stamp blocks the auto-open for that trough; run-now overrides; the next trough is unaffected", () => {
  // The user canceled: the window row carries vetoedTroughStartMs = TROUGH.startMs.
  const vetoed = normalizeWindow({ state: "closed", vetoedTroughStartMs: TROUGH.startMs });
  assert.equal(vetoed.vetoedTroughStartMs, TROUGH.startMs, "normalizeWindow preserves the stamp");

  const refused = evaluateWindow(vetoed, tickInput({ now: T0 + H, lastUserEventMs: T0 - 2 * H }));
  assert.equal(refused.window.state, "closed", "the machine refuses to auto-open a vetoed trough");
  assert.equal(refused.ledgerRows.length, 0, "silently closed — no open row, no dispatch");

  // run-now is explicit consent AFTER the cancel — it overrides the stamp,
  // and the open supersedes it (a fresh window is not a vetoed one).
  const rn = evaluateWindow(vetoed, tickInput({ now: T0 + H, runNow: true }));
  assert.equal(rn.window.state, "open");
  assert.equal(rn.window.vetoedTroughStartMs, null, "an open clears the veto stamp");

  // A different trough (tomorrow) does not inherit the stamp — it expires
  // naturally with the trough it named.
  const tomorrow = evaluateWindow(
    vetoed,
    tickInput({ now: T0 + 24 * H, trough: { startMs: T0 + 24 * H, endMs: T0 + 30 * H }, lastUserEventMs: T0 + 22 * H }),
  );
  assert.equal(tomorrow.window.state, "open", "the stamp never suppresses a later night");
});

test("a trough-opened window closes when the profile re-derives the trough away from its opening (trough-shift guard)", () => {
  const { window } = evaluateWindow(null, tickInput({ now: T0 + H }));
  assert.equal(window.state, "open");

  // The G refit moves the quiet trough forward — it no longer contains
  // openedMs, which would make the trough-end close unreachable.
  const shifted = { startMs: T0 + 24 * H, endMs: T0 + 30 * H };
  const { window: closed, ledgerRows } = evaluateWindow(window, tickInput({ now: T0 + 2 * H, trough: shifted }));
  assert.equal(closed.state, "closed");
  assert.equal(closed.closeReason, "trough-end");
  assert.ok(ledgerRows.some((r) => r.kind === "cto.overnight.close" && r.reason === "trough-end"));

  // run-now windows are exempt — they open outside any trough on explicit
  // consent and close on the user's return / fresh event, not on re-derivation.
  const rn = evaluateWindow(null, tickInput({ now: T0 + 2 * H, trough: shifted, runNow: true }));
  assert.equal(rn.window.state, "open");
});

// ---------------------------------------------------------------------------
// BET-1404 — §7.6 data-source candidate source (p_use composition,
// experiment-first, chain + consent gates)
// ---------------------------------------------------------------------------

import { dataAnalysisCandidatesFromTools, dataAnalysisPrompt } from "./ctoOvernight.mjs";

function deepTool(overrides = {}) {
  return {
    tool: "github",
    displayName: "GitHub",
    status: "integrated",
    consent: { metadata: "yes", deep_read: "yes", write: null },
    asSourceDecayed: false,
    asSource: { reports: 0, accepted: 0 },
    relevance: { alpha: 0.7, beta: 0.3 },
    vitality: { ewma: 0.8, last_event: 1, inflow_rate: 3, last_probed: 1 },
    ...overrides,
  };
}

test("dataAnalysisCandidatesFromTools: one candidate per deep-consented tool at argmax relevance; p_use = ewma × max(relevance)", () => {
  const out = dataAnalysisCandidatesFromTools([deepTool()]);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.id, "data-source:github");
  assert.equal(c.project, "alpha", "argmax relevance picks the project");
  assert.equal(c.category, "data-source");
  assert.ok(Math.abs(c.pUse - 0.8 * 0.7) < 1e-9, `p_use = ewma × max(relevance), got ${c.pUse}`);
  assert.equal(c.requestShaped, true, "§11.2 batch routing flag");
  assert.deepEqual(c.refs, ["github"]);
  assert.equal(c.value, 1);
  assert.equal(c.confidence, 0.5);
  assert.equal(c.predictedCost, 0.5, "reports=0 → the experiment-first shape (halved cost)");
});

test("dataAnalysisCandidatesFromTools: the gates exclude non-consented, non-integrated, decayed, vitality-dead, and relevance-less tools", () => {
  const out = dataAnalysisCandidatesFromTools([
    deepTool({ consent: { metadata: "yes", deep_read: null, write: null } }), // not deep-consented
    deepTool({ status: "candidate" }), // probes never ran
    deepTool({ asSourceDecayed: true }), // chain tripped → analyses stopped
    deepTool({ vitality: { ewma: 0, last_event: 1, inflow_rate: 0, last_probed: 1 } }), // ewma=0 is not 'high' (Q1)
    deepTool({ relevance: { alpha: 0.1 } }), // no relevance ≥ threshold... argmax exists but pUse>0 still — relevance score exists
    deepTool({ relevance: {} }), // no relevance score at all → not emitted
    deepTool(), // the eligible one
  ]);
  assert.equal(out.length, 2, "the 0.1-relevance tool emits (score exists; p_use carries selectivity); the empty-relevance one does not");
  assert.deepEqual(out.map((c) => c.project).sort(), ["alpha", "alpha"]);
});

test("dataAnalysisCandidatesFromTools: experiment-first — the FIRST analysis is flagged small, later ones are full-size", () => {
  const first = dataAnalysisCandidatesFromTools([deepTool({ asSource: { reports: 0, accepted: 0 } })]);
  assert.equal(first.length, 1);
  assert.equal(first[0].predictedCost, 0.5, "halved predicted cost for the experiment");
  assert.match(first[0].prompt, /EXPERIMENT-FIRST CONSTRAINTS/);
  assert.match(first[0].prompt, /single most recent probe window/);
  assert.match(first[0].prompt, /half the normal context budget/);
  const later = dataAnalysisCandidatesFromTools([deepTool({ asSource: { reports: 2, accepted: 1 } })]);
  assert.equal(later.length, 1);
  assert.equal(later[0].predictedCost, 1);
  assert.ok(!later[0].prompt.includes("EXPERIMENT-FIRST"));
  // every prompt carries the §11.5 report-artifact contract
  assert.match(first[0].prompt, /REPORT-github\.md/);
  assert.match(first[0].prompt, /no code gates/);
});

test("dataAnalysisCandidatesFromTools: survives garbage input (graceful-empty)", () => {
  assert.deepEqual(dataAnalysisCandidatesFromTools(null), []);
  assert.deepEqual(dataAnalysisCandidatesFromTools([null, 42, { tool: "" }, "x"]), []);
});

test("dataAnalysisPrompt: concrete intent names the tool and the project", () => {
  const p = dataAnalysisPrompt("GitHub", "alpha", { experiment: false });
  assert.match(p, /GitHub/);
  assert.match(p, /alpha/);
  assert.match(p, /REPORT/);
});
