// The renderer-facing views (spec §8): shape, counts, nextSeatId, status, and
// the guarantee that nothing secret is carried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderView, buildSessionSeat, countConversations, findSeatView, moveTargetFor, nextSeatFor, seatViewStatus } from "./accountsViews.mjs";

const seat = (n, over = {}) => ({ id: `seat-${n}`, label: `Seat ${n}`, email: `s${n}@example.com`, accountUuid: `u-${n}`, credentialDir: `/secret/dir/${n}`, status: "ok", ...over });
const state = (over = {}) => ({
  mode: "auto",
  activeSeatId: "seat-1",
  accounts: [
    { id: "acct-1", label: "Work", orgId: "org-A", orgName: "Useronda", plan: "Team · Max 5x", seats: [seat(1), seat(2)] },
    { id: "acct-2", label: "Home", orgId: "org-B", orgName: null, plan: null, seats: [seat(3)] },
  ],
  ...over,
});
const states = (over = {}) => ({
  mode: "auto",
  activeSeatId: "seat-1",
  seats: [
    { seatId: "seat-1", live: true, usable: true },
    { seatId: "seat-2", live: false, usable: true },
    { seatId: "seat-3", live: false, usable: true },
  ],
  ...over,
});
const win = (kind, pct, extra = {}) => ({ kind, label: kind, pct, ...extra });
const snap = (n, windows, extra = {}) => ({ provider: "claude", seatId: `seat-${n}`, windows, fetchedAt: 1000 + n, ...extra });
const MOVE_COPY_1 = {
  text: "Moved to Work · Seat 2 (Seat 1 was at its limit).",
  line: "Moved from Seat 1 · seat was at its limit",
  resentText: null,
};
// The wording is pinned in accountsCopy.test.mjs; these tests pin the move fields.
const bareMove = ({ text: _t, line: _l, resentText: _r, ...rest }) => rest;
const asg = (seatId, extra = {}) => ({ seatId, assignedAt: 1, lastUsedAt: 1, ...extra });

test("seatViewStatus: live is ok; stored expired/signed-out stay; an unreadable seat is signed-out; unknown stays unknown", () => {
  assert.equal(seatViewStatus({ storedStatus: "expired", live: true, usable: true }), "ok");
  assert.equal(seatViewStatus({ storedStatus: "ok", live: false, usable: true }), "ok");
  assert.equal(seatViewStatus({ storedStatus: "expired", live: false, usable: false }), "expired");
  assert.equal(seatViewStatus({ storedStatus: "signed-out", live: false, usable: false }), "signed-out");
  assert.equal(seatViewStatus({ storedStatus: "ok", live: false, usable: false }), "signed-out");
  assert.equal(seatViewStatus({ storedStatus: "unknown", live: false, usable: true }), "unknown");
  assert.equal(seatViewStatus({ storedStatus: "weird", live: false, usable: true }), "unknown");
});

test("countConversations: auto counts per seat; manual counts EVERY assignment toward the seat the resolver now uses", () => {
  const seats = [{ seatId: "seat-1", usable: true }, { seatId: "seat-2", usable: true }, { seatId: "seat-3", usable: true }];
  const assignments = { a: asg("seat-1"), b: asg("seat-2"), c: asg("seat-2") };
  assert.deepEqual(countConversations({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [], assignments }), { "seat-1": 1, "seat-2": 2 });
  assert.deepEqual(countConversations({ mode: "manual", activeSeatId: "seat-3", seats, seatSnapshots: [], assignments }), { "seat-3": 3 });
  const downSeats = [{ seatId: "seat-1", usable: true }, { seatId: "seat-2", usable: true }, { seatId: "seat-3", usable: false }];
  assert.deepEqual(
    countConversations({ mode: "manual", activeSeatId: "seat-3", seats: downSeats, seatSnapshots: [snap(1, [win("session", 50)]), snap(2, [win("session", 10)])], assignments }),
    { "seat-2": 3 },
    "active seat unusable → the seat the resolver falls back to",
  );
  assert.deepEqual(countConversations({ mode: "manual", activeSeatId: "seat-3", seats, seatSnapshots: [], assignments: {} }), {});
});

test("nextSeatFor: auto = the seat a NEW conversation takes (least loaded, ties to active); manual = the active seat", () => {
  const seats = [{ seatId: "seat-1", usable: true }, { seatId: "seat-2", usable: true }, { seatId: "seat-3", usable: true }];
  const snaps = [snap(1, [win("session", 60)]), snap(2, [win("session", 20)]), snap(3, [win("session", 20)])];
  assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-3", seats, seatSnapshots: snaps }), "seat-3", "tie → active");
  assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps }), "seat-2");
  assert.equal(nextSeatFor({ mode: "manual", activeSeatId: "seat-1", seats, seatSnapshots: snaps }), "seat-1");
  assert.equal(nextSeatFor({ mode: "auto", activeSeatId: null, seats: [{ seatId: "seat-1", usable: false }], seatSnapshots: [] }), null);
});

test("nextSeatFor: auto prefers a seat whose org has another seat under 70 (org A {10, 90}, org B {30, 30} → B)", () => {
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-A", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-A", orgId: "org-A" },
    { seatId: "seat-3", usable: true, accountId: "acct-B", orgId: "org-B" },
    { seatId: "seat-4", usable: true, accountId: "acct-B", orgId: "org-B" },
  ];
  const snaps = [snap(1, [win("session", 10)]), snap(2, [win("session", 90)]), snap(3, [win("session", 30)]), snap(4, [win("session", 30)])];
  assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps }), "seat-3");
  assert.equal(nextSeatFor({ mode: "manual", activeSeatId: "seat-1", seats, seatSnapshots: snaps }), "seat-1", "manual is unchanged");
  const roomy = [snap(1, [win("session", 10)]), snap(2, [win("session", 40)]), snap(3, [win("session", 30)]), snap(4, [win("session", 30)])];
  assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: roomy }), "seat-1");
});

test("buildProviderView: the contract's shape, end to end", () => {
  const v = buildProviderView({
    provider: "claude",
    state: state(),
    states: states(),
    seatSnapshots: [snap(1, [win("session", 40), win("weekly", 71)]), snap(2, [win("session", 5)]), snap(3, [win("session", 90)], { exhausted: false })],
    assignments: { a: asg("seat-1"), b: asg("seat-1"), c: asg("seat-3") },
    routingActive: true,
  });
  assert.equal(v.provider, "claude");
  assert.equal(v.mode, "auto");
  assert.equal(v.activeSeatId, "seat-1");
  assert.equal(v.routingActive, true);
  assert.equal(v.nextSeatId, "seat-2");
  assert.equal(v.accounts.length, 2);
  assert.deepEqual({ id: v.accounts[0].id, label: v.accounts[0].label, orgName: v.accounts[0].orgName, plan: v.accounts[0].plan }, { id: "acct-1", label: "Work", orgName: "Useronda", plan: "Team · Max 5x" });
  assert.equal(v.accounts[1].orgName, null);
  const s1 = v.accounts[0].seats[0];
  assert.deepEqual(Object.keys(s1).sort(), ["conversations", "deadlineAt", "email", "fetchedAt", "id", "label", "live", "load", "slack", "status", "windows"]);
  assert.equal(s1.live, true);
  assert.equal(s1.load, 71);
  assert.equal(s1.conversations, 2);
  assert.equal(s1.fetchedAt, 1001);
  assert.equal(s1.windows.length, 2);
  assert.equal(findSeatView(v, "seat-3").conversations, 1);
  assert.equal(findSeatView(v, "nope"), null);
});

test("buildProviderView: a seat with no reading has windows [], load null, fetchedAt null; mode defaults safely", () => {
  const v = buildProviderView({ provider: "codex", state: state({ mode: "weird" }), states: states(), seatSnapshots: [], assignments: {}, routingActive: false });
  const s = findSeatView(v, "seat-2");
  assert.deepEqual([s.windows, s.load, s.fetchedAt, s.conversations], [[], null, null, 0]);
  assert.equal(v.mode, "manual");
  assert.equal(v.routingActive, false);
});

test("buildProviderView: null when the provider has no seat", () => {
  assert.equal(buildProviderView({ provider: "claude", state: { mode: "manual", activeSeatId: null, accounts: [] }, states: null, seatSnapshots: [], assignments: {}, routingActive: false }), null);
});

test("buildProviderView: carries nothing secret — no credential path, no token field", () => {
  const v = buildProviderView({ provider: "claude", state: state(), states: states(), seatSnapshots: [snap(1, [win("session", 1)])], assignments: {}, routingActive: true });
  const text = JSON.stringify(v);
  assert.doesNotMatch(text, /secret|credentialDir|accountUuid|token|\/d\//i);
});

test("buildProviderView: a seat the state does not know is not usable → signed-out; expired stays expired", () => {
  const v = buildProviderView({
    provider: "claude",
    state: state({ accounts: [{ id: "acct-1", label: "W", orgId: null, orgName: null, plan: null, seats: [seat(1), seat(2, { status: "expired" }), seat(3)] }] }),
    states: states({ seats: [{ seatId: "seat-1", live: true, usable: true }, { seatId: "seat-2", live: false, usable: false }] }),
    seatSnapshots: [],
    assignments: {},
    routingActive: false,
  });
  assert.equal(findSeatView(v, "seat-2").status, "expired");
  assert.equal(findSeatView(v, "seat-3").status, "signed-out");
});

// ---- session-seat ------------------------------------------------------------

test("buildSessionSeat: null without an assignment or when its seat is gone", () => {
  assert.equal(buildSessionSeat({ found: null, state: state(), states: states(), seatSnapshots: [] }), null);
  assert.equal(buildSessionSeat({ found: { provider: "claude", assignment: asg("seat-9") }, state: state(), states: states(), seatSnapshots: [] }), null);
});

test("buildSessionSeat (auto): the assigned seat with account + seat labels; lastMove from movedFrom/movedAt/reason", () => {
  const found = { provider: "claude", assignment: asg("seat-2", { movedFrom: "seat-1", movedAt: 555, reason: "exhausted" }) };
  assert.deepEqual(buildSessionSeat({ found, state: state(), states: states(), seatSnapshots: [] }), {
    provider: "claude",
    seatId: "seat-2",
    seatLabel: "Seat 2",
    accountLabel: "Work",
    lastMove: { from: "seat-1", fromLabel: "Seat 1", at: 555, reason: "exhausted", ...MOVE_COPY_1 },
  });
  const noMove = buildSessionSeat({ found: { provider: "claude", assignment: asg("seat-3") }, state: state(), states: states(), seatSnapshots: [] });
  assert.equal(noMove.lastMove, undefined);
  assert.equal(noMove.accountLabel, "Home");
});

test("buildSessionSeat: a seat the conversation LEFT that was since removed is labelled by its id", () => {
  const found = { provider: "claude", assignment: asg("seat-2", { movedFrom: "seat-77", movedAt: 1, reason: "manual" }) };
  assert.equal(buildSessionSeat({ found, state: state(), states: states(), seatSnapshots: [] }).lastMove.fromLabel, "seat-77");
});

test("buildSessionSeat (manual): answers with the seat the NEXT request will use; a pending switch has no lastMove yet", () => {
  const manual = state({ mode: "manual", activeSeatId: "seat-3" });
  const found = { provider: "claude", assignment: asg("seat-2", { movedFrom: "seat-1", movedAt: 9, reason: "manual" }) };
  const r = buildSessionSeat({ found, state: manual, states: states(), seatSnapshots: [] });
  assert.equal(r.seatId, "seat-3");
  assert.equal(r.lastMove, undefined);
  const settled = buildSessionSeat({ found: { provider: "claude", assignment: asg("seat-3", { movedFrom: "seat-2", movedAt: 12, reason: "manual" }) }, state: manual, states: states(), seatSnapshots: [] });
  assert.deepEqual(bareMove(settled.lastMove), { from: "seat-2", fromLabel: "Seat 2", at: 12, reason: "manual" });
});

// ---- phase 4: moveTargetSeatId + lastMove detail ------------------------------

test("moveTargetFor: where a conversation on the most loaded in-use seat (≥95) would go — the resolver's own decision", () => {
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-3", usable: true, accountId: "acct-2", orgId: "org-B" },
  ];
  const snaps = [snap(1, [win("session", 97)]), snap(2, [win("session", 40)]), snap(3, [win("session", 5)])];
  const counts = { "seat-1": 2 };
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps, counts }), "seat-2", "same org first");
  assert.equal(moveTargetFor({ mode: "manual", activeSeatId: "seat-1", seats, seatSnapshots: snaps, counts }), null, "manual mode never moves");
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps, counts: {} }), null, "nobody on it");
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", 94)]), snap(2, []), snap(3, [])], counts }), null, "below 95");
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", 97)]), snap(2, [win("session", 96)]), snap(3, [win("session", 75)])], counts }), null, "no same-org seat under 95 and none elsewhere under 70 → it would stay");
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", 97)]), snap(2, [win("session", 80)]), snap(3, [win("session", 5)])], counts }), "seat-2", "a same-org seat at 80 is a free move and beats the empty other-org seat");
  // the MOST loaded one is the one asked about
  assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", 96)]), snap(2, [win("session", 98)]), snap(3, [win("session", 5)])], counts: { "seat-1": 1, "seat-2": 1 } }), "seat-3");
});

test("moveTargetFor regression: 94% has no move target, 95% does (the move line is 95)", () => {
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-1", orgId: "org-A" },
  ];
  const at = (pct) => moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", pct)]), snap(2, [win("session", 5)])], counts: { "seat-1": 1 } });
  assert.equal(at(94), null);
  assert.equal(at(95), "seat-2");
});

test("moveTargetFor with a weekly deadline in play: a seat high only on its WEEKLY gets no hint; one at 95+ on its 5h does (R4); a full one does (R3)", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-1", orgId: "org-A" },
  ];
  const wk = (n, session, weekly) => snap(n, [win("session", session, { resetsAt: NOW + 2 * H }), win("weekly", weekly, { resetsAt: NOW + (n === 1 ? 60 : 30) * H })]);
  const at = (s1, w1) => moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [wk(1, s1, w1), wk(2, 5, 5)], counts: { "seat-1": 1 }, nowMs: NOW });
  assert.equal(at(40, 97), null, "weekly at 97, 5h at 40: the resolver does not move it, so no hint");
  assert.equal(at(97, 10), "seat-2", "5h at 97");
  assert.equal(at(94, 10), null, "5h at 94");
  assert.equal(at(40, 100), "seat-2", "a full weekly is a full seat (R3)");
  // legacy mode (no weekly deadline anywhere) keeps the old reading: the highest window of any kind
  const legacy = (s1, w1) => moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: [snap(1, [win("session", s1), win("weekly", w1)]), snap(2, [win("session", 5)])], counts: { "seat-1": 1 }, nowMs: NOW });
  assert.equal(legacy(40, 97), "seat-2");
});

test("countConversations (manual) asks the same dispatcher as the resolver", () => {
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-1", orgId: "org-A" },
  ];
  const counts = countConversations({ mode: "manual", activeSeatId: "seat-2", seats, seatSnapshots: [snap(1, []), snap(2, [])], assignments: { a: { seatId: "seat-1" }, b: { seatId: "seat-1" } } });
  assert.deepEqual(counts, { "seat-2": 2 });
});

test("buildProviderView: moveTargetSeatId rides along; nextSeatId is still rule 1 (a NEW conversation)", () => {
  const v = buildProviderView({
    provider: "claude",
    state: state(),
    states: states(),
    seatSnapshots: [snap(1, [win("session", 97)]), snap(2, [win("session", 30)]), snap(3, [win("session", 2)])],
    assignments: { a: asg("seat-1") },
    routingActive: true,
  });
  assert.equal(v.nextSeatId, "seat-3", "the least-loaded seat for a new conversation");
  assert.equal(v.moveTargetSeatId, "seat-2", "org-A seats share a cache: same org first");
  const quiet = buildProviderView({ provider: "claude", state: state(), states: states(), seatSnapshots: [snap(1, [win("session", 10)])], assignments: { a: asg("seat-1") }, routingActive: true });
  assert.equal(quiet.moveTargetSeatId, null);
});

test("buildSessionSeat: lastMove carries trigger + crossOrg when recorded, and omits them otherwise", () => {
  const auto = buildSessionSeat({ found: { provider: "claude", assignment: asg("seat-2", { movedFrom: "seat-1", movedAt: 9, reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false }) }, state: state(), states: states(), seatSnapshots: [] });
  assert.deepEqual(bareMove(auto.lastMove), { from: "seat-1", fromLabel: "Seat 1", at: 9, reason: "load", trigger: { kind: "session", pct: 96 }, crossOrg: false });
  const old = buildSessionSeat({ found: { provider: "claude", assignment: asg("seat-2", { movedFrom: "seat-1", movedAt: 9, reason: "exhausted" }) }, state: state(), states: states(), seatSnapshots: [] });
  assert.deepEqual(bareMove(old.lastMove), { from: "seat-1", fromLabel: "Seat 1", at: 9, reason: "exhausted" });
});

// ---- weekly-deadline rules through the views --------------------------------

{
  const NOW = 100 * 3_600_000;
  const H = 3_600_000;
  const withWeekly = (n, sessionPct, weeklyPct, weeklyInH) =>
    snap(n, [win("session", sessionPct, { resetsAt: NOW + 2 * H }), win("weekly", weeklyPct, { resetsAt: NOW + weeklyInH * H })]);
  const seats = [
    { seatId: "seat-1", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-2", usable: true, accountId: "acct-1", orgId: "org-A" },
    { seatId: "seat-3", usable: true, accountId: "acct-2", orgId: "org-B" },
  ];

  test("nextSeatFor: with a clock and weekly deadlines the seat resetting first wins; without a clock it is the legacy chooser", () => {
    const snaps = [withWeekly(1, 10, 20, 48), withWeekly(2, 50, 2, 12), withWeekly(3, 10, 20, 40)];
    assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps, nowMs: NOW }), "seat-2");
    assert.equal(nextSeatFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps }), "seat-1", "no clock → least loaded, as before");
  });

  test("moveTargetFor: a conversation at 96% of its 5h goes to the same-org seat resetting first", () => {
    const snaps = [withWeekly(1, 96, 20, 48), withWeekly(2, 50, 2, 12), withWeekly(3, 10, 20, 40)];
    assert.equal(moveTargetFor({ mode: "auto", activeSeatId: "seat-1", seats, seatSnapshots: snaps, counts: { "seat-1": 1 }, nowMs: NOW }), "seat-2");
  });

  test("buildProviderView: each seat carries {slack, deadlineAt}; slack needs a K, the deadline does not", () => {
    // seat 2: weekly 98% left, resets in 12h → ≈ 350 5h-points unreachable with K = 7.5 (spec §2.3)
    const snaps = [withWeekly(1, 10, 0, 48), withWeekly(2, 10, 2, 12), snap(3, [win("session", 10)])];
    const args = { provider: "claude", state: state(), states: states(), seatSnapshots: snaps, assignments: {}, routingActive: true, nowMs: NOW };
    const noK = buildProviderView(args);
    assert.deepEqual([findSeatView(noK, "seat-2").slack, findSeatView(noK, "seat-2").deadlineAt], [false, NOW + 12 * H]);
    const withK = buildProviderView({ ...args, kFor: (kind) => (kind === "weekly" ? 7.5 : null) });
    assert.equal(findSeatView(withK, "seat-2").slack, true);
    assert.equal(findSeatView(withK, "seat-1").slack, false);
    assert.deepEqual([findSeatView(withK, "seat-3").slack, findSeatView(withK, "seat-3").deadlineAt], [false, null], "no weekly → no deadline");
    assert.equal(withK.nextSeatId, "seat-2");
  });
}
