import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seatLoad,
  seatLoadWindow,
  isWindowActive,
  activeWindows,
  leastLoadedSeat,
  aggregateSnapshot,
} from "./seatChoice.mjs";

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
