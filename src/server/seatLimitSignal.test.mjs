// seatLimitSignal.test.mjs — a failed turn that hit a rate/usage limit forces a
// usage refresh and re-places the conversation. Pure / injected only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLimitSignal, isOverloadFailure } from "./usageStopper.mjs";
import { createLimitSignalHandler, LIMIT_REFRESH_DEBOUNCE_MS } from "./seatLimitSignal.mjs";
import { createSeatAssigner, LIMITED_MARK_MS } from "./seatAssignment.mjs";

const quiet = { warn() {}, log() {} };

// ---- classifier ---------------------------------------------------------------

test("limit signal: 429 / rate-limit wordings are limit signals", () => {
  const yes = [
    { provider: "claude", errorName: "ApiError", errorMessage: "Too Many Requests: slow", error: { httpStatus: 429 } },
    { provider: "claude", errorName: "ApiError", errorMessage: '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}' },
    { provider: "claude", errorName: "ApiError", errorMessage: "Rate limit exceeded for this organization" },
    { provider: "codex", errorName: "ApiError", errorMessage: "too many requests" },
    { provider: "codex", errorName: "usage_limit_reached", errorMessage: "" },
  ];
  for (const c of yes) assert.ok(classifyLimitSignal(c), JSON.stringify(c));
});

test("limit signal: a positive refusal match is a limit signal (kind refusal)", () => {
  assert.deepEqual(classifyLimitSignal({ provider: "claude", errorName: "Error", errorMessage: "You've hit your weekly limit" }), { kind: "refusal" });
});

test("limit signal: overloaded / 529 / 5xx never trigger, even next to rate-limit words", () => {
  const no = [
    { provider: "claude", errorName: "ApiError", errorMessage: "Overloaded", error: { httpStatus: 529 } },
    { provider: "claude", errorName: "overloaded_error", errorMessage: "Overloaded" },
    { provider: "claude", errorName: "ApiError", errorMessage: "overloaded: too many requests right now" },
    { provider: "codex", errorName: "ApiError", errorMessage: "server_is_overloaded" },
    { provider: "claude", errorName: "ApiError", errorMessage: "Internal Server Error", error: { httpStatus: 500 } },
  ];
  for (const c of no) assert.equal(classifyLimitSignal(c), null, JSON.stringify(c));
  assert.equal(isOverloadFailure({ error: { httpStatus: 529 } }), true);
});

test("limit signal: auth errors, aborts, context overflow and unrelated failures do not trigger", () => {
  const no = [
    { provider: "claude", errorName: "ProviderAuthError", errorMessage: "rate limit?" },
    { provider: "claude", errorName: "ApiError", errorMessage: "Unauthorized", error: { httpStatus: 401 } },
    { provider: "claude", errorName: "MessageAbortedError", errorMessage: "too many requests" },
    { provider: "claude", errorName: "ContextOverflowError", errorMessage: "" },
    { provider: "claude", errorName: "ApiError", errorMessage: "some unrelated failure" },
    { provider: undefined, errorName: "ApiError", errorMessage: "rate limit" },
  ];
  for (const c of no) assert.equal(classifyLimitSignal(c), null, JSON.stringify(c));
});

// ---- handler / debounce --------------------------------------------------------

function handlerHarness() {
  let t = 1_000_000;
  const calls = [];
  const assigner = {
    markLimited: (p, s) => calls.push(["mark", p, s]),
    reconsider: async (p, s) => (calls.push(["reconsider", p, s]), { moved: true, from: "a", to: "b" }),
  };
  const h = createLimitSignalHandler({ refreshUsage: async () => void calls.push(["tick"]), assigner, now: () => t, log: quiet });
  return { h, calls, advance: (ms) => (t += ms) };
}

test("handler: marks, refreshes usage, then reconsiders — in that order", async () => {
  const { h, calls } = handlerHarness();
  const res = await h({ sessionId: "s1", adapterId: "claude", kind: "rate-limit" });
  assert.deepEqual(calls, [["mark", "claude", "s1"], ["tick"], ["reconsider", "claude", "s1"]]);
  assert.equal(res.moved, true);
});

test("handler: a burst of failures costs ONE refresh per provider per 30s, but every conversation is reconsidered", async () => {
  const { h, calls, advance } = handlerHarness();
  await Promise.all([1, 2, 3].map((n) => h({ sessionId: `s${n}`, adapterId: "claude" })));
  assert.equal(calls.filter((c) => c[0] === "tick").length, 1);
  assert.equal(calls.filter((c) => c[0] === "reconsider").length, 3);
  advance(LIMIT_REFRESH_DEBOUNCE_MS - 1);
  await h({ sessionId: "s4", adapterId: "claude" });
  assert.equal(calls.filter((c) => c[0] === "tick").length, 1, "still inside the window");
  await h({ sessionId: "s5", adapterId: "codex" });
  assert.equal(calls.filter((c) => c[0] === "tick").length, 2, "another provider refreshes on its own clock");
  advance(2);
  await h({ sessionId: "s6", adapterId: "claude" });
  assert.equal(calls.filter((c) => c[0] === "tick").length, 3, "window elapsed");
});

test("handler: out-of-scope providers do nothing; a failing refresh still reconsiders", async () => {
  const { h, calls } = handlerHarness();
  assert.equal(await h({ sessionId: "s", adapterId: "kimi" }), null);
  assert.deepEqual(calls, []);
  const seen = [];
  const h2 = createLimitSignalHandler({
    refreshUsage: async () => {
      throw new Error("offline");
    },
    assigner: { markLimited: () => {}, reconsider: async () => (seen.push("r"), { moved: false }) },
    log: quiet,
  });
  assert.deepEqual(await h2({ sessionId: "s", adapterId: "claude" }), { moved: false });
  assert.deepEqual(seen, ["r"]);
});

// ---- assigner: markLimited + reconsider -----------------------------------------

const seat = (n, over = {}) => ({
  seatId: `seat-${n}`,
  accountId: "acct-1",
  live: false,
  usable: true,
  dir: `/d/${n}`,
  file: `/d/${n}/.credentials.json`,
  credential: { expiresAt: 5_000_000 },
  ...over,
});
const snap = (n, pct, extra = {}) => ({ provider: "claude", seatId: `seat-${n}`, windows: [{ kind: "session", pct }], ...extra });

function assignerHarness(state, snaps) {
  let t = 1_000_000;
  const moves = [];
  const svc = createSeatAssigner({
    accounts: { async seatStates() { return state; } },
    listSeatSnapshots: () => snaps,
    refreshSeatCredentials: async () => ({ ok: true }),
    load: () => null,
    save: async () => {},
    now: () => t,
    notePluginSeen: () => {},
    onMoved: (e) => moves.push(e),
    log: quiet,
  });
  return { svc, moves, tick: (ms) => (t += ms) };
}
const two = (over = {}) => ({ mode: "auto", activeSeatId: "seat-1", seats: [seat(1), seat(2)], ...over });


test("reconsider: moves off a limited seat despite a lagging 90% reading, announces it", async () => {
  const snaps = [snap(1, 5), snap(2, 10)];
  const h = assignerHarness(two(), snaps);
  assert.equal((await h.svc.resolve("claude", "conv")).seatId, "seat-1");
  snaps.splice(0, 2, snap(1, 90), snap(2, 10));
  assert.equal((await h.svc.resolve("claude", "conv")).seatId, "seat-1", "90% alone does not move it");
  assert.equal(h.svc.markLimited("claude", "conv"), "seat-1");
  const res = await h.svc.reconsider("claude", "conv");
  assert.deepEqual(res, { moved: true, from: "seat-1", to: "seat-2", reason: "exhausted" });
  assert.equal(h.svc.assignments("claude").conv.seatId, "seat-2");
  assert.equal(h.moves.length, 1);
  assert.equal(h.moves[0].from, "seat-1");
  assert.equal(h.moves[0].to, "seat-2");
  assert.equal((await h.svc.resolve("claude", "conv")).seatId, "seat-2", "the next request lands on the new seat");
});

test("the limited mark is global to the seat, and expires after 5 minutes", async () => {
  const snaps = [snap(1, 5), snap(2, 10)];
  const h = assignerHarness(two(), snaps);
  await h.svc.resolve("claude", "a");
  h.svc.markLimited("claude", "a");
  assert.equal((await h.svc.resolve("claude", "fresh")).seatId, "seat-2", "a new conversation avoids the limited seat");
  h.tick(LIMITED_MARK_MS + 1);
  assert.equal((await h.svc.resolve("claude", "later")).seatId, "seat-1", "mark gone: least-loaded again");
});

test("reconsider: manual mode never moves", async () => {
  const h = assignerHarness(two({ mode: "manual" }), [snap(1, 90), snap(2, 10)]);
  await h.svc.resolve("claude", "conv");
  h.svc.markLimited("claude", "conv");
  assert.deepEqual(await h.svc.reconsider("claude", "conv"), { moved: false });
  assert.equal(h.svc.assignments("claude").conv.seatId, "seat-1");
  assert.equal(h.moves.length, 0);
});

test("reconsider: no move when no other seat has room, or the conversation has no assignment / one seat only", async () => {
  const h = assignerHarness(two(), [snap(1, 90), snap(2, 100, { exhausted: true })]);
  await h.svc.resolve("claude", "conv");
  h.svc.markLimited("claude", "conv");
  assert.deepEqual(await h.svc.reconsider("claude", "conv"), { moved: false });
  assert.equal(h.svc.assignments("claude").conv.seatId, "seat-1");
  assert.deepEqual(await h.svc.reconsider("claude", "never-seen"), { moved: false });
  assert.equal(h.svc.markLimited("claude", "never-seen"), null);
  const one = assignerHarness({ mode: "auto", activeSeatId: "seat-1", seats: [seat(1)] }, []);
  assert.deepEqual(await one.svc.reconsider("claude", "x"), { moved: false });
});

test("reconsider: a sub-agent's failure re-places its ROOT conversation", async () => {
  const snaps = [snap(1, 5), snap(2, 10)];
  const h = assignerHarness(two(), snaps);
  await h.svc.resolve("claude", "kid", "root");
  h.svc.markLimited("claude", "kid");
  const res = await h.svc.reconsider("claude", "kid");
  assert.equal(res.moved, true);
  assert.equal(h.svc.assignments("claude").root.seatId, "seat-2");
});
