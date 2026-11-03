import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seatLoad,
  seatLoadWindow,
  isWindowActive,
  activeWindows,
  leastLoadedSeat,
  aggregateSnapshot,
  windowAppliesToModel,
  nextResetAt,
  soonestResettingSeat,
  windowSpanMs,
  shortWindowState,
  longWindows,
  windowSlackPts,
  seatSlackPts,
  seatDeadlineAt,
  legacyMode,
  seatRank,
  bestSeatByRank,
} from "./seatChoice.mjs";
import { normalizeWindow } from "../server/usageAdapters/normalizeWindow.mjs";

const win = (kind, pct, extra = {}) => ({ kind, label: kind, pct, ...extra });
const seat = (seatId, windows, extra = {}) => ({
  provider: "claude",
  providerIDs: ["anthropic"],
  accountId: "acct-1",
  accountLabel: "Work",
  seatId,
  seatLabel: seatId,
  windows,
  fetchedAt: 1,
  ...extra,
});

test("isWindowActive / activeWindows: only an explicit active:false is inactive", () => {
  assert.equal(isWindowActive({ pct: 1 }), true);
  assert.equal(isWindowActive({ pct: 1, active: true }), true);
  assert.equal(isWindowActive({ pct: 1, active: false }), false);
  assert.deepEqual(activeWindows([{ pct: 1 }, { pct: 2, active: false }, null]), [{ pct: 1 }]);
  assert.deepEqual(activeWindows(undefined), []);
});

test("seatLoad: max pct over active windows", () => {
  assert.equal(seatLoad(seat("a", [win("session", 15), win("weekly", 62)])), 62);
});

test("seatLoad: an inactive window never counts, even at 100", () => {
  assert.equal(seatLoad(seat("a", [win("session", 15), win("weekly_scoped:fable", 100, { active: false })])), 15);
});

test("seatLoad: stale windows are ignored; all-stale reads as 0, not unknown", () => {
  assert.equal(seatLoad(seat("a", [win("session", 95, { stale: true }), win("weekly", 40)])), 40);
  assert.equal(seatLoad(seat("a", [win("session", 95, { stale: true })])), 0);
});

test("seatLoad: no windows at all is unknown (null)", () => {
  assert.equal(seatLoad(seat("a", [])), null);
  assert.equal(seatLoad(null), null);
});

test("leastLoadedSeat: lowest load wins", () => {
  const a = seat("a", [win("session", 80)]);
  const b = seat("b", [win("session", 20)]);
  const c = seat("c", [win("session", 50)]);
  assert.equal(leastLoadedSeat([a, b, c]).seatId, "b");
});

test("leastLoadedSeat: ties go to the active seat, then to input order", () => {
  const a = seat("a", [win("session", 30)]);
  const b = seat("b", [win("session", 30)]);
  assert.equal(leastLoadedSeat([a, b], { activeSeatId: "b" }).seatId, "b");
  assert.equal(leastLoadedSeat([a, b], { activeSeatId: "zzz" }).seatId, "a");
  assert.equal(leastLoadedSeat([a, b]).seatId, "a");
});

test("leastLoadedSeat: unknown-load seats rank after known ones; exhausted after seats with room", () => {
  const unknown = seat("u", []);
  const known = seat("k", [win("session", 90)]);
  const full = seat("f", [win("session", 100)], { exhausted: true });
  assert.equal(leastLoadedSeat([unknown, known]).seatId, "k");
  assert.equal(leastLoadedSeat([full, known]).seatId, "k");
  assert.equal(leastLoadedSeat([full, unknown]).seatId, "u");
  assert.equal(leastLoadedSeat([]), null);
});

test("aggregateSnapshot: auto picks the least-loaded seat and strips seat identity", () => {
  const a = seat("a", [win("session", 80)]);
  const b = seat("b", [win("session", 10)]);
  const agg = aggregateSnapshot([a, b], { mode: "auto", activeSeatId: "a" });
  assert.equal(agg.windows[0].pct, 10);
  for (const f of ["accountId", "seatId", "seatLabel", "accountLabel"]) assert.equal(f in agg, false);
  assert.equal(agg.provider, "claude");
});

test("aggregateSnapshot: manual follows the active seat even when another is lighter", () => {
  const a = seat("a", [win("session", 80)]);
  const b = seat("b", [win("session", 10)]);
  assert.equal(aggregateSnapshot([a, b], { mode: "manual", activeSeatId: "a" }).windows[0].pct, 80);
});

test("aggregateSnapshot: manual falls back to the least-loaded seat when the active seat has no reading", () => {
  const b = seat("b", [win("session", 10)]);
  assert.equal(aggregateSnapshot([b], { mode: "manual", activeSeatId: "gone" }).windows[0].pct, 10);
});

test("aggregateSnapshot: auto is exhausted only when ALL seats are", () => {
  const full = seat("a", [win("session", 100)], { exhausted: true });
  const room = seat("b", [win("session", 40)]);
  assert.equal("exhausted" in aggregateSnapshot([full, room], { mode: "auto" }), false);
  const both = aggregateSnapshot([full, seat("c", [win("session", 100)], { exhausted: true })], { mode: "auto" });
  assert.equal(both.exhausted, true);
});

test("aggregateSnapshot: auto never inherits exhausted from a chosen seat when another has room", () => {
  // A stale 100% makes `a` read load 0 yet carry exhausted:true from the adapter.
  const staleFull = seat("a", [win("session", 100, { stale: true })], { exhausted: true });
  const room = seat("b", [win("session", 50)]);
  const agg = aggregateSnapshot([staleFull, room], { mode: "auto" });
  assert.equal("exhausted" in agg, false);
});

test("aggregateSnapshot: manual exhausted mirrors the active seat only", () => {
  const full = seat("a", [win("session", 100)], { exhausted: true });
  const room = seat("b", [win("session", 40)]);
  assert.equal(aggregateSnapshot([full, room], { mode: "manual", activeSeatId: "a" }).exhausted, true);
  assert.equal("exhausted" in aggregateSnapshot([full, room], { mode: "manual", activeSeatId: "b" }), false);
});

test("aggregateSnapshot: ONE seat is the seat's snapshot unchanged, minus identity", () => {
  const only = seat("a", [win("session", 15), win("weekly", 3)], {
    planLabel: "Team",
    extras: [{ label: "x", value: "1%" }],
  });
  const agg = aggregateSnapshot([only], { mode: "auto" });
  const { accountId, accountLabel, seatId, seatLabel, ...expected } = only;
  void accountId; void accountLabel; void seatId; void seatLabel;
  assert.deepEqual(agg, expected);
  assert.equal(agg.windows, only.windows);
});

test("aggregateSnapshot: empty input → null; does not mutate its input", () => {
  assert.equal(aggregateSnapshot([]), null);
  const a = seat("a", [win("session", 5)], { exhausted: true });
  aggregateSnapshot([a], { mode: "auto" });
  assert.equal(a.seatId, "a");
  assert.equal(a.exhausted, true);
});

test("seatLoadWindow: the active, fresh window that defines the load; null when none counts", () => {
  assert.deepEqual(seatLoadWindow(seat("a", [win("session", 91), win("weekly", 62)])), { kind: "session", pct: 91 });
  assert.deepEqual(seatLoadWindow(seat("a", [win("session", 15), win("weekly", 62)])), { kind: "weekly", pct: 62 });
  assert.deepEqual(seatLoadWindow(seat("a", [win("session", 15), win("weekly_scoped:fable", 100, { active: false })])), { kind: "session", pct: 15 });
  assert.deepEqual(seatLoadWindow(seat("a", [win("session", 99, { stale: true })])), null);
  assert.equal(seatLoadWindow(seat("a", [])), null);
  assert.equal(seatLoadWindow(null), null);
  assert.equal(seatLoad(seat("a", [win("session", 99, { stale: true })])), 0, "seatLoad is unchanged: windows reported, none in force → 0");
});

// ---- model-scoped windows -----------------------------------------------------

const fable = (pct, extra = {}) => win("weekly_scoped:fable", pct, { scope: "Fable", ...extra });

test("windowAppliesToModel: an unscoped window applies to every model, known or not", () => {
  assert.equal(windowAppliesToModel(win("session", 100), "claude-opus-5-5"), true);
  assert.equal(windowAppliesToModel(win("weekly", 100), null), true);
  assert.equal(windowAppliesToModel(win("weekly", 100), undefined), true);
});

test("windowAppliesToModel: a scope matches a hyphen/dot/slash/colon-separated token of the model id", () => {
  assert.equal(windowAppliesToModel(fable(100), "claude-fable-5"), true);
  assert.equal(windowAppliesToModel(fable(100), "claude-fable-5-1"), true);
  assert.equal(windowAppliesToModel(fable(100), "anthropic/claude-fable-5"), true);
  assert.equal(windowAppliesToModel(fable(100), "Claude-FABLE-5"), true, "case-insensitive");
  assert.equal(windowAppliesToModel(win("weekly_scoped:opus", 100, { scope: "Opus" }), "claude-opus-5-5"), true);
  assert.equal(windowAppliesToModel(fable(100), "claude_fable_5"), true, "underscore separates tokens too");
  assert.equal(windowAppliesToModel(win("weekly_scoped:opus", 100, { scope: " OPUS! " }), "claude-opus-5-5"), true, "the scope name is normalized");
});

test("windowAppliesToModel: a scope never matches another model, a substring of a token, or an unknown model", () => {
  assert.equal(windowAppliesToModel(fable(100), "claude-opus-5-5"), false);
  assert.equal(windowAppliesToModel(fable(100), "claude-unfabled-5"), false, "token match, not a raw substring");
  assert.equal(windowAppliesToModel(fable(100), null), false);
  assert.equal(windowAppliesToModel(fable(100), undefined), false);
  assert.equal(windowAppliesToModel(fable(100), ""), false);
  assert.equal(windowAppliesToModel({ kind: "weekly_scoped:fable", pct: 1 }, "claude-fable-5"), true, "scope falls back to the kind suffix");
});

test("seatLoad: a 100% model-scoped window is ignored with no model or another model, counted for its own model", () => {
  const s = seat("a", [win("session", 0), win("weekly", 10), fable(100)]);
  assert.equal(seatLoad(s), 10, "model unknown → scoped ignored");
  assert.equal(seatLoad(s, { model: null }), 10);
  assert.equal(seatLoad(s, { model: "claude-opus-5-5" }), 10);
  assert.equal(seatLoad(s, { model: "claude-fable-5" }), 100);
  assert.deepEqual(seatLoadWindow(s), { kind: "weekly", pct: 10 });
  assert.deepEqual(seatLoadWindow(s, { model: "claude-fable-5" }), { kind: "weekly_scoped:fable", pct: 100 });
});

test("seatLoad: a seat that only reports a scoped window reads 0 for another model (reported, none applicable), not unknown", () => {
  assert.equal(seatLoad(seat("a", [fable(100)]), { model: "claude-opus-5-5" }), 0);
});

test("leastLoadedSeat: a seat full only on a scoped window ranks by its other windows for another model, last for that model", () => {
  const capped = seat("capped", [win("session", 0), fable(100)]);
  const busy = seat("busy", [win("session", 60)]);
  assert.equal(leastLoadedSeat([busy, capped], { model: "claude-opus-5-5" }).seatId, "capped");
  assert.equal(leastLoadedSeat([busy, capped]).seatId, "capped", "no model → scoped ignored");
  assert.equal(leastLoadedSeat([busy, capped], { model: "claude-fable-5" }).seatId, "busy");
});

test("nextResetAt: soonest future reset over active, fresh, applicable windows; none → Infinity", () => {
  const now = 1_000_000;
  assert.equal(nextResetAt(seat("a", [win("session", 40, { resetsAt: now + 30 }), win("weekly", 10, { resetsAt: now + 90 })]), { nowMs: now }), now + 30);
  assert.equal(nextResetAt(seat("a", [win("session", 0)]), { nowMs: now }), Infinity, "a window that has not started");
  assert.equal(nextResetAt(seat("a", [win("session", 40, { resetsAt: now - 1 })]), { nowMs: now }), Infinity, "already reset");
  assert.equal(nextResetAt(seat("a", [win("session", 40, { resetsAt: now + 30, stale: true })]), { nowMs: now }), Infinity);
  assert.equal(nextResetAt(seat("a", [win("session", 40, { resetsAt: now + 30, active: false })]), { nowMs: now }), Infinity);
  const scoped = seat("a", [win("weekly_scoped:fable", 50, { resetsAt: now + 30 })]);
  assert.equal(nextResetAt(scoped, { nowMs: now }), Infinity, "no model → scoped ignored");
  assert.equal(nextResetAt(scoped, { nowMs: now, model: "claude-fable-5" }), now + 30);
});

test("soonestResettingSeat: soonest within the horizon; resets under a minute apart tie to least-loaded; none → null", () => {
  const now = 10 * 3_600_000;
  const at = (id, pct, inMs) => seat(id, [win("session", pct, { resetsAt: now + inMs })]);
  const opts = { nowMs: now, withinMs: 3_600_000 };
  assert.equal(soonestResettingSeat([at("late", 10, 2 * 3_600_000), at("soon", 60, 20 * 60_000)], opts).seatId, "soon");
  assert.equal(soonestResettingSeat([at("a", 60, 20 * 60_000), at("b", 30, 20 * 60_000 + 30_000)], opts).seatId, "b", "a tie goes to the emptier seat");
  assert.equal(soonestResettingSeat([at("a", 60, 10 * 60_000), at("b", 30, 40 * 60_000)], opts).seatId, "a");
  assert.equal(soonestResettingSeat([at("late", 10, 2 * 3_600_000), seat("fresh", [win("session", 0)])], opts), null);
});

// ---------------------------------------------------------------------------
// windowAppliesToModel — `models` precedence (spec §5.1)
// ---------------------------------------------------------------------------

test("windowAppliesToModel: explicit models wins over scope; empty/unnormalisable models falls back to scope", () => {
  const opus = "anthropic/claude-opus-5-5";
  const fable = "claude-fable-5-1";
  // models says Opus even though the scope says Fable: models wins.
  const w = { kind: "weekly_scoped:fable", scope: "Fable", models: ["opus"] };
  assert.equal(windowAppliesToModel(w, opus), true);
  assert.equal(windowAppliesToModel(w, fable), false);
  assert.equal(windowAppliesToModel(w, null), false);
  // models on an otherwise unscoped window scopes it.
  const only = { kind: "weekly", models: ["fable"] };
  assert.equal(windowAppliesToModel(only, fable), true);
  assert.equal(windowAppliesToModel(only, opus), false);
  assert.equal(windowAppliesToModel(only, null), false);
  // several tokens: any matches.
  assert.equal(windowAppliesToModel({ kind: "weekly", models: ["fable", "opus"] }, opus), true);
  // [] / ["—"] are absent → legacy scope, then unscoped.
  assert.equal(windowAppliesToModel({ kind: "weekly_scoped:fable", scope: "Fable", models: [] }, opus), false);
  assert.equal(windowAppliesToModel({ kind: "weekly_scoped:fable", scope: "Fable", models: ["—"] }, fable), true);
  assert.equal(windowAppliesToModel({ kind: "weekly", models: [] }, opus), true);
  assert.equal(windowAppliesToModel({ kind: "weekly", models: [] }, null), true);
  // no scope, no models: every model, including unknown.
  assert.equal(windowAppliesToModel({ kind: "session" }, null), true);
});

test("windowAppliesToModel: byte-identical for the windows the adapter emits, with and without `models`", () => {
  const raws = [
    { kind: "session", label: "5h", pct: 10 },
    { kind: "weekly", label: "7d", pct: 20, resetsAt: 2_000_000_000_000 },
    { kind: "weekly_scoped:fable", label: "7d · Fable", pct: 100, scope: "Fable" },
    { kind: "weekly_scoped:opus", label: "7d · Opus", pct: 5, scope: "Opus" },
    { kind: "weekly_scoped:sonnet 4.5", label: "7d · Sonnet 4.5", pct: 5, scope: "Sonnet 4.5" },
    { kind: "weekly_scoped:—", label: "x", pct: 5, scope: "—" },
  ];
  const modelsList = ["anthropic/claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "sonnet-4.5-x", null];
  for (const raw of raws) {
    const withModels = normalizeWindow({ ...raw, ...(raw.scope ? { models: [raw.scope] } : {}) });
    const scopeOnly = normalizeWindow(raw);
    const legacy = { ...scopeOnly };
    delete legacy.models; // an older server's snapshot: no `models` at all
    for (const m of modelsList) {
      const a = windowAppliesToModel(withModels, m);
      assert.equal(windowAppliesToModel(scopeOnly, m), a, `${raw.kind} / ${m} (scope-derived)`);
      assert.equal(windowAppliesToModel(legacy, m), a, `${raw.kind} / ${m} (legacy, no models)`);
    }
  }
});

// ---------------------------------------------------------------------------
// Weekly-deadline helpers (spec §2, §5.2)
// ---------------------------------------------------------------------------

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const K = (kind) => (kind === "weekly" ? 7.5 : kind.startsWith("weekly_scoped:") ? 3.75 : null);
const sess = (pct, resetsInH, extra = {}) =>
  win("session", pct, resetsInH === null ? extra : { resetsAt: NOW + resetsInH * H, ...extra });
const wk = (pct, resetsInH, extra = {}) => win("weekly", pct, { resetsAt: NOW + resetsInH * H, ...extra });

test("windowSpanMs: reported span when plausible; else provider default by kind; else null", () => {
  assert.equal(windowSpanMs({ kind: "session" }), 5 * H);
  assert.equal(windowSpanMs({ kind: "weekly" }), 168 * H);
  assert.equal(windowSpanMs({ kind: "weekly_scoped:fable" }, "claude"), 168 * H);
  assert.equal(windowSpanMs({ kind: "session", startedAt: 0, resetsAt: 3 * H }, "claude"), 3 * H);
  // implausible reported spans (< 1h, > 31d) are ignored
  assert.equal(windowSpanMs({ kind: "session", startedAt: 0, resetsAt: 60_000 }, "claude"), 5 * H);
  assert.equal(windowSpanMs({ kind: "weekly", startedAt: 0, resetsAt: 40 * 24 * H }, "claude"), 168 * H);
  // unknown provider has no default; an unknown kind never does
  assert.equal(windowSpanMs({ kind: "session" }, "someone"), null);
  assert.equal(windowSpanMs({ kind: "session", startedAt: 0, resetsAt: 2 * H }, "someone"), 2 * H);
  assert.equal(windowSpanMs({ kind: "monthly" }, "claude"), null);
});

test("shortWindowState: running / not-started / unknown / stale", () => {
  assert.deepEqual(shortWindowState(seat("a", [sess(16, 1)]), { nowMs: NOW }), { state: "running", roomNow: 84, nextResetAt: NOW + H });
  assert.deepEqual(shortWindowState(seat("a", [sess(0, null)]), { nowMs: NOW }), { state: "not-started", roomNow: 100, nextResetAt: NOW + 5 * H });
  assert.equal(shortWindowState(seat("a", [wk(10, 20)]), { nowMs: NOW }).state, "unknown");
  assert.equal(shortWindowState(seat("a", []), { nowMs: NOW }).state, "unknown");
  assert.equal(shortWindowState(null, { nowMs: NOW }).state, "unknown");
  assert.equal(shortWindowState(seat("a", [sess(50, 1, { stale: true })]), { nowMs: NOW }).state, "unknown");
  // a reset instant already passed, not yet re-read → unknown, not "running"
  assert.equal(shortWindowState(seat("a", [sess(50, -0.1)]), { nowMs: NOW }).state, "unknown");
  // a full window has no room
  assert.equal(shortWindowState(seat("a", [sess(100, 2)]), { nowMs: NOW }).roomNow, 0);
});

test("windowSlackPts: seat 8 — weekly 98% left, R in 12h, short running with 84% room → ≈ 350", () => {
  const s = seat("s8", [sess(16, 1), wk(2, 12)]);
  const slack = windowSlackPts(s, s.windows[1], { nowMs: NOW, K: 7.5 });
  assert.ok(Math.abs(slack - 350) <= 5, `slack ${slack}`);
  assert.equal(slack, 98 * 7.5 - (84 + 100 * 3));
});

test("windowSlackPts: seat 1 — weekly 100% left, R in 48h, r in 40 min → not slack (−347)", () => {
  const s = seat("s1", [sess(3, 40 / 60), wk(0, 48)]);
  const slack = windowSlackPts(s, s.windows[1], { nowMs: NOW, K: 7.5 });
  assert.equal(slack, 750 - (97 + 1000));
  assert.ok(slack < 0);
});

test("windowSlackPts: not-started with R in 1h → capPts 100 (the window a request opens now outlives R)", () => {
  const s = seat("a", [sess(0, null), wk(50, 1)]);
  assert.equal(windowSlackPts(s, s.windows[1], { nowMs: NOW, K: 7.5 }), 50 * 7.5 - 100);
});

test("windowSlackPts: null when R unknown, K null, long window stale, or the short window is unknown/stale", () => {
  const base = [sess(10, 1), wk(10, 12)];
  const s = seat("a", base);
  assert.notEqual(windowSlackPts(s, s.windows[1], { nowMs: NOW, K: 7.5 }), null);
  const noR = { kind: "weekly", pct: 10 };
  assert.equal(windowSlackPts(s, noR, { nowMs: NOW, K: 7.5 }), null);
  assert.equal(windowSlackPts(s, { ...s.windows[1], resetsAt: NOW - 1 }, { nowMs: NOW, K: 7.5 }), null);
  assert.equal(windowSlackPts(s, s.windows[1], { nowMs: NOW, K: null }), null);
  assert.equal(windowSlackPts(s, { ...s.windows[1], stale: true }, { nowMs: NOW, K: 7.5 }), null);
  const staleShort = seat("a", [sess(10, 1, { stale: true }), wk(10, 12)]);
  assert.equal(windowSlackPts(staleShort, staleShort.windows[1], { nowMs: NOW, K: 7.5 }), null);
  const noShort = seat("a", [wk(10, 12)]);
  assert.equal(windowSlackPts(noShort, noShort.windows[0], { nowMs: NOW, K: 7.5 }), null);
});

test("longWindows / seatSlackPts / seatDeadlineAt: inactive and stale excluded; a Fable cap only counts for Fable", () => {
  const fableCap = win("weekly_scoped:fable", 10, { scope: "Fable", resetsAt: NOW + 3 * H });
  const s = seat("a", [sess(10, 1), wk(10, 40), fableCap, win("weekly_scoped:opus", 0, { scope: "Opus", resetsAt: NOW + H, active: false })]);
  assert.deepEqual(longWindows(s, { model: "claude-opus-5-5" }).map((w) => w.kind), ["weekly"]);
  assert.deepEqual(longWindows(s, { model: "claude-fable-5" }).map((w) => w.kind), ["weekly", "weekly_scoped:fable"]);
  assert.deepEqual(longWindows(s, { model: null }).map((w) => w.kind), ["weekly"]);
  assert.equal(seatDeadlineAt(s, { nowMs: NOW, model: "claude-opus-5-5" }), NOW + 40 * H);
  assert.equal(seatDeadlineAt(s, { nowMs: NOW, model: "claude-fable-5" }), NOW + 3 * H);
  // the inactive Opus cap (R in 1h) never makes it into the deadline
  assert.equal(seatDeadlineAt(seat("a", [sess(1, 1), win("weekly_scoped:opus", 0, { scope: "Opus", resetsAt: NOW + H, active: false })]), { nowMs: NOW, model: "opus" }), null);
  // slack takes the max over the applicable long windows with a known K
  const only = seatSlackPts(s, { nowMs: NOW, model: "claude-opus-5-5", kFor: K });
  assert.equal(only, windowSlackPts(s, s.windows[1], { nowMs: NOW, K: 7.5 }));
  assert.equal(seatSlackPts(s, { nowMs: NOW, model: "claude-opus-5-5", kFor: () => null }), null);
  assert.equal(seatSlackPts(s, { nowMs: NOW, model: "claude-opus-5-5" }), null);
  const staleLong = seat("a", [sess(10, 1), wk(10, 12, { stale: true })]);
  assert.equal(seatSlackPts(staleLong, { nowMs: NOW, model: null, kFor: K }), null);
  assert.equal(seatDeadlineAt(staleLong, { nowMs: NOW, model: null }), null);
});

test("a stale SHORT window does not change which window is long", () => {
  const fresh = seat("a", [sess(10, 1), wk(10, 12)]);
  const stale = seat("a", [sess(10, 1, { stale: true }), wk(10, 12)]);
  assert.deepEqual(longWindows(stale, { model: null }).map((w) => w.kind), longWindows(fresh, { model: null }).map((w) => w.kind));
  assert.equal(seatDeadlineAt(stale, { nowMs: NOW, model: null }), seatDeadlineAt(fresh, { nowMs: NOW, model: null }));
  assert.equal(seatSlackPts(stale, { nowMs: NOW, model: null, kFor: K }), null);
});

test("legacyMode: true for 5h-only, all-inactive weeklies, unknown resets; false once any seat has a fresh weekly with a reset", () => {
  assert.equal(legacyMode([], { nowMs: NOW }), true);
  assert.equal(legacyMode([seat("a", [sess(10, 1)]), seat("b", [sess(20, 2)])], { nowMs: NOW, model: null }), true);
  assert.equal(legacyMode([seat("a", [sess(10, 1), wk(10, 12, { active: false })])], { nowMs: NOW, model: null }), true);
  assert.equal(legacyMode([seat("a", [sess(10, 1), win("weekly", 10)])], { nowMs: NOW, model: null }), true);
  assert.equal(legacyMode([seat("a", [sess(10, 1), wk(10, 12, { stale: true })])], { nowMs: NOW, model: null }), true);
  assert.equal(legacyMode([seat("a", [sess(10, 1)]), seat("b", [sess(10, 1), wk(10, 12)])], { nowMs: NOW, model: null }), false);
  // a Fable-only weekly reset does not leave legacy mode for an Opus decision
  const fableOnly = seat("a", [sess(10, 1), win("weekly_scoped:fable", 10, { scope: "Fable", resetsAt: NOW + 5 * H })]);
  assert.equal(legacyMode([fableOnly], { nowMs: NOW, model: "claude-opus-5-5" }), true);
  assert.equal(legacyMode([fableOnly], { nowMs: NOW, model: "claude-fable-5" }), false);
});

test("seatRank: earlier deadline beats more slack; equal deadline → more slack → load → active seat", () => {
  const rk = (s, activeSeatId = null) => seatRank(s, { nowMs: NOW, model: null, kFor: K, activeSeatId });
  const early = seat("early", [sess(10, 1), wk(90, 2)]); // little to lose, but resets first
  const slacky = seat("slacky", [sess(16, 1), wk(2, 12)]); // slack ≈ 350, resets later
  assert.ok(rk(early)[0] < rk(slacky)[0]);
  assert.ok(rk(slacky)[1] < 0, "slack encoded as a negative key");
  assert.equal(bestSeatByRank([slacky, early], { nowMs: NOW, model: null, kFor: K }).seatId, "early");

  // equal deadline: more slack first
  const lowSlack = seat("lowSlack", [sess(16, 1), wk(50, 12)]);
  const hiSlack = seat("hiSlack", [sess(16, 1), wk(2, 12)]);
  assert.equal(bestSeatByRank([lowSlack, hiSlack], { nowMs: NOW, model: null, kFor: K }).seatId, "hiSlack");
  // no slack known (kFor missing): load decides, then the active seat
  const loaded = seat("loaded", [sess(80, 1), wk(80, 12)]);
  const light = seat("light", [sess(5, 1), wk(5, 12)]);
  assert.equal(bestSeatByRank([loaded, light], { nowMs: NOW, model: null }).seatId, "light");
  const t1 = seat("t1", [sess(10, 1), wk(10, 12)]);
  const t2 = seat("t2", [sess(10, 1), wk(10, 12)]);
  assert.equal(bestSeatByRank([t1, t2], { nowMs: NOW, model: null, activeSeatId: "t2" }).seatId, "t2");
  assert.equal(bestSeatByRank([t1, t2], { nowMs: NOW, model: null, activeSeatId: null }).seatId, "t1");
  assert.deepEqual(rk(t2, "t2")[3], 0);
  assert.deepEqual(rk(t1, "t2")[3], 1);
});

test("seatRank: unknown / Infinity deadlines rank last; slack key is never −0", () => {
  const known = seat("known", [sess(95, 1), wk(99, 100)]);
  const unknown = seat("unknown", [sess(0, 1)]);
  const r = seatRank(unknown, { nowMs: NOW, model: null, kFor: K });
  assert.equal(r[0], Infinity);
  assert.ok(Object.is(r[1], 0));
  assert.equal(bestSeatByRank([unknown, known], { nowMs: NOW, model: null, kFor: K }).seatId, "known");
  // exhausted seat with an early deadline is still ranked by deadline — callers pass eligible pools
  assert.equal(bestSeatByRank([], { nowMs: NOW }), null);
  // nobody has a deadline: the rest of the key decides (load)
  const a = seat("a", [sess(50, 1)]);
  const b = seat("b", [sess(5, 1)]);
  assert.equal(bestSeatByRank([a, b], { nowMs: NOW, model: null }).seatId, "b");
});

test("bestSeatByRank: the tie group is anchored on the earliest deadline (transitive; deadlines at 0 / 50 / 100 s)", () => {
  const at = (id, secs, load) => seat(id, [sess(load, 1), win("weekly", load, { resetsAt: NOW + 10 * H + secs * 1000 })]);
  const first = at("first", 0, 60);
  const mid = at("mid", 50, 20);
  const last = at("last", 100, 1); // least loaded, but 100 s > 0 + 60 s: outside the group
  for (const order of [[first, mid, last], [last, mid, first], [mid, last, first], [last, first, mid]]) {
    assert.equal(bestSeatByRank(order, { nowMs: NOW, model: null }).seatId, "mid", order.map((s) => s.seatId).join());
  }
  // with a wider tie window all three are one group → least loaded
  assert.equal(bestSeatByRank([first, mid, last], { nowMs: NOW, model: null, tieMs: 120_000 }).seatId, "last");
});
