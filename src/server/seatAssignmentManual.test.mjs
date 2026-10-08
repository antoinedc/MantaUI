// Multi-account phase 3: manual mode in the resolver, plus the hooks and
// accessors the accounts:* channels read (assignments / sessionAssignment /
// forgetSeat, onChange / onMoved).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeatAssigner, decideSeat } from "./seatAssignment.mjs";

const quiet = { warn() {}, log() {} };
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
const three = (over = {}) => ({
  mode: "manual",
  activeSeatId: "seat-1",
  seats: [seat(1, { live: true, dir: null, credential: null, file: null }), seat(2), seat(3)],
  ...over,
});

// ---- decideSeat, manual ------------------------------------------------------

test("manual: a new conversation takes the active seat, loads notwithstanding", () => {
  const d = decideSeat({ existing: null, mode: "manual", activeSeatId: "seat-2", seats: three().seats, seatSnapshots: [snap(1, 0), snap(2, 99), snap(3, 0)] });
  assert.deepEqual(d, { seatId: "seat-2", reason: "assigned" });
});

test("manual: a conversation on ANOTHER seat is moved to the active one, recorded as a manual move", () => {
  const d = decideSeat({ existing: { seatId: "seat-3" }, mode: "manual", activeSeatId: "seat-2", seats: three().seats, seatSnapshots: [] });
  assert.deepEqual(d, { seatId: "seat-2", reason: "moved", from: "seat-3", why: "manual" });
});

test("manual: a conversation already on the active seat stays (even when that seat is full — no automatic move)", () => {
  const d = decideSeat({ existing: { seatId: "seat-2" }, mode: "manual", activeSeatId: "seat-2", seats: three().seats, seatSnapshots: [snap(2, 100, { exhausted: true }), snap(3, 0)] });
  assert.deepEqual(d, { seatId: "seat-2", reason: "kept" });
});

test("manual: a conversation whose seat no longer exists is simply placed (not 'moved' from a ghost)", () => {
  const d = decideSeat({ existing: { seatId: "seat-9" }, mode: "manual", activeSeatId: "seat-2", seats: three().seats, seatSnapshots: [] });
  assert.deepEqual(d, { seatId: "seat-2", reason: "assigned" });
});

test("manual: when the active seat cannot serve, the request falls back exactly as chooseSeat does", () => {
  const seats = [seat(1, { live: true, dir: null }), seat(2, { usable: false }), seat(3)];
  const d = decideSeat({ existing: { seatId: "seat-3" }, mode: "manual", activeSeatId: "seat-2", seats, seatSnapshots: [snap(1, 50), snap(3, 10)] });
  assert.equal(d.seatId, "seat-3", "least-loaded usable seat; the conversation is already there");
  assert.equal(d.reason, "kept");
});

test("auto mode is unchanged: an existing seat with room is kept whatever the active seat is", () => {
  const d = decideSeat({ existing: { seatId: "seat-3" }, mode: "auto", activeSeatId: "seat-2", seats: three().seats, seatSnapshots: [snap(3, 40), snap(2, 0)] });
  assert.deepEqual(d, { seatId: "seat-3", reason: "kept" });
});

// ---- the service -------------------------------------------------------------

function harness(state, over = {}) {
  const accounts = { async seatStates() { return state; } };
  let saved = null;
  let t = 1_000_000;
  const changes = [];
  const moves = [];
  const svc = createSeatAssigner({
    accounts,
    listSeatSnapshots: () => over.snaps ?? [],
    refreshSeatCredentials: async () => ({ ok: true }),
    load: () => saved,
    save: async (d) => {
      saved = structuredClone(d);
    },
    now: () => t,
    notePluginSeen: () => {},
    onChange: (p) => changes.push(p),
    onMoved: (e) => moves.push(e),
    log: quiet,
  });
  return { svc, changes, moves, state, tick: (ms) => (t += ms), get saved() { return saved; } };
}

test("manual resolve: switching the active seat moves EVERY known conversation on its next request, recording lastMove(reason 'manual') and NO accounts.moved", async () => {
  const state = three({ activeSeatId: "seat-2" });
  const h = harness(state);
  assert.equal((await h.svc.resolve("claude", "a")).seatId, "seat-2");
  assert.equal((await h.svc.resolve("claude", "b")).seatId, "seat-2");
  h.state.activeSeatId = "seat-3";
  h.tick(1000);
  const r = await h.svc.resolve("claude", "a");
  assert.equal(r.seatId, "seat-3");
  assert.equal(r.live, false);
  const a = h.svc.assignments("claude").a;
  assert.equal(a.seatId, "seat-3");
  assert.equal(a.movedFrom, "seat-2");
  assert.equal(a.reason, "manual");
  assert.equal(h.moves.length, 0, "a deliberate switch is not an 'moved' event");
  assert.equal((await h.svc.resolve("claude", "b")).seatId, "seat-3");
  assert.deepEqual(h.svc.assignments("claude").b.seatId, "seat-3");
});

test("manual resolve: a sub-agent follows its parent's seat after a switch too", async () => {
  const state = three({ activeSeatId: "seat-2" });
  const h = harness(state);
  await h.svc.resolve("claude", "parent");
  await h.svc.resolve("claude", "kid", "parent");
  h.state.activeSeatId = "seat-3";
  assert.equal((await h.svc.resolve("claude", "kid", "parent")).seatId, "seat-3");
  assert.equal(h.svc.assignments("claude").parent.seatId, "seat-3");
});

test("auto resolve: an automatic move publishes onMoved with the conversation (root) id; onChange fires for placements", async () => {
  const state = three({ mode: "auto", activeSeatId: "seat-1" });
  const snaps = [snap(1, 50), snap(2, 10), snap(3, 90)];
  const h = harness(state, { snaps });
  const first = await h.svc.resolve("claude", "conv", null);
  assert.equal(first.seatId, "seat-2");
  assert.deepEqual(h.changes, ["claude"], "a new placement changes the list (counts)");
  h.changes.length = 0;
  await h.svc.resolve("claude", "conv");
  assert.deepEqual(h.changes, [], "a kept conversation changes nothing");
  snaps.splice(0, 3, snap(1, 5), snap(2, 100, { exhausted: true }), snap(3, 90));
  h.tick(1000);
  const moved = await h.svc.resolve("claude", "kid", "conv");
  assert.equal(moved.seatId, "seat-1");
  assert.deepEqual(h.moves, [{ sessionId: "conv", provider: "claude", from: "seat-2", to: "seat-1", fromLabel: "seat-2", toLabel: "seat-1", reason: "exhausted", trigger: { kind: "session", pct: 100 }, crossOrg: false }]);
  assert.deepEqual(h.changes, ["claude"]);
});

test("a listener that throws never fails the request", async () => {
  const svc = createSeatAssigner({
    accounts: { async seatStates() { return three(); } },
    listSeatSnapshots: () => [],
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: async () => {},
    notePluginSeen: () => {},
    onChange: () => {
      throw new Error("boom");
    },
    log: quiet,
  });
  assert.equal((await svc.resolve("claude", "c")).seatId, "seat-1");
});

test("assignments(): a COPY (mutating it cannot change the store)", async () => {
  const h = harness(three());
  await h.svc.resolve("claude", "c");
  const copy = h.svc.assignments("claude");
  copy.c.seatId = "hacked";
  assert.equal(h.svc.assignments("claude").c.seatId, "seat-1");
});

test("sessionAssignment: by conversation, by sub-agent (through the child→root map), null when none", async () => {
  const h = harness(three());
  assert.equal(h.svc.sessionAssignment("nope"), null);
  await h.svc.resolve("claude", "root");
  await h.svc.resolve("claude", "kid", "root");
  const direct = h.svc.sessionAssignment("root");
  assert.equal(direct.provider, "claude");
  assert.equal(direct.assignment.seatId, "seat-1");
  assert.equal(h.svc.sessionAssignment("kid").conversation, "root");
});

test("sessionAssignment: a conversation that used both providers answers with the most recently used one", async () => {
  let t = 9_000_000;
  const accounts = {
    async seatStates(p) {
      return p === "codex" ? { mode: "manual", activeSeatId: "seat-2", seats: [seat(1, { live: true }), seat(2)] } : three();
    },
  };
  const svc = createSeatAssigner({ accounts, listSeatSnapshots: () => [], refreshSeatCredentials: async () => ({}), load: () => null, save: async () => {}, now: () => t, notePluginSeen: () => {}, log: quiet });
  await svc.resolve("claude", "x");
  t += 10_000;
  await svc.resolve("codex", "x");
  assert.equal(svc.sessionAssignment("x").provider, "codex");
  assert.equal(svc.sessionAssignment("x").assignment.seatId, "seat-2");
});

test("forgetSeat: drops every assignment on that seat (and only those), persists, and tells onChange", async () => {
  const h = harness(three({ mode: "auto" }), { snaps: [snap(1, 50), snap(2, 10), snap(3, 90)] });
  await h.svc.resolve("claude", "a");
  await h.svc.resolve("claude", "b");
  h.state.mode = "manual";
  h.state.activeSeatId = "seat-3";
  await h.svc.resolve("claude", "c");
  h.state.mode = "auto";
  h.changes.length = 0;
  assert.equal(await h.svc.forgetSeat("claude", "seat-9"), false, "nothing on that seat: no write, no event");
  assert.deepEqual(h.changes, []);
  const onTwo = Object.entries(h.svc.assignments("claude")).filter(([, v]) => v.seatId === "seat-2").map(([k]) => k);
  assert.ok(onTwo.length >= 1);
  assert.equal(await h.svc.forgetSeat("claude", "seat-2"), true);
  const left = h.svc.assignments("claude");
  for (const k of onTwo) assert.equal(left[k], undefined);
  assert.equal(left.c.seatId, "seat-3", "other seats' conversations are untouched");
  assert.equal(h.saved.providers.claude.c.seatId, "seat-3", "persisted");
  assert.deepEqual(h.changes, ["claude"]);
});
