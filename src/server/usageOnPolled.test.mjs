// The poller's `onPolled` hook (seat-placement spec 2026-11-03 §6): fires after
// every successful tick with the per-seat snapshots actually fetched that tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsagePoller } from "./usage.mjs";

function makeAdapter(readings, calls = []) {
  return {
    id: "claude",
    providerIDs: ["anthropic"],
    async detect() {
      return true;
    },
    async fetch(deps) {
      const r = readings[deps.token];
      calls.push(deps.token);
      if (r?.throw) throw r.throw;
      return {
        provider: "claude",
        windows: [
          { kind: "session", label: "5h", pct: r.pct5h, resetsAt: r.resetsAt },
          { kind: "weekly", label: "7d", pct: r.pctWeekly },
        ],
      };
    },
  };
}

const seat = (n) => ({ accountId: "a", accountLabel: "A", seatId: `seat-${n}`, seatLabel: `Seat ${n}`, deps: { token: `tok-${n}` } });
const plan = (...seats) => ({ mode: "auto", activeSeatId: seats[0].seatId, seats });
const seatsOf = (p) => ({ seatsFor: async (id) => (id === "claude" ? p : null) });

function setup(readings, seats = [seat(1), seat(2)]) {
  let nowMs = 1_800_000_000_000;
  const polled = [];
  const published = [];
  const poller = createUsagePoller({
    adapters: [makeAdapter(readings)],
    seats: seatsOf(plan(...seats)),
    now: () => nowMs,
    publish: (e) => published.push(e),
    onPolled: (fresh) => polled.push(fresh),
  });
  return { poller, polled, published, advance: (ms) => (nowMs += ms), clock: () => nowMs };
}

test("onPolled fires on every successful tick, even when the content is unchanged (observe/publish would not)", async () => {
  const t = setup({ "tok-1": { pct5h: 10, pctWeekly: 1 }, "tok-2": { pct5h: 20, pctWeekly: 2 } });
  await t.poller.tick();
  const first = t.clock();
  t.advance(10 * 60_000);
  await t.poller.tick();
  assert.equal(t.published.length, 1, "identical content publishes once");
  assert.equal(t.polled.length, 2, "…but the hook fires on both ticks");
  assert.deepEqual(
    t.polled.map((fresh) => fresh.map((s) => s.fetchedAt)),
    [[first, first], [first + 600_000, first + 600_000]],
    "each carries its real fetchedAt",
  );
  assert.deepEqual(t.polled[0].map((s) => s.seatId), ["seat-1", "seat-2"]);
});

test("a carried-forward reading is left out; a tick that fetched nothing does not fire", async () => {
  const readings = { "tok-1": { pct5h: 10, pctWeekly: 1 }, "tok-2": { pct5h: 20, pctWeekly: 2 } };
  const t = setup(readings);
  await t.poller.tick();
  t.advance(10 * 60_000);
  readings["tok-2"] = { throw: new Error("boom") };
  await t.poller.tick();
  assert.equal(t.polled.length, 2);
  assert.deepEqual(t.polled[1].map((s) => s.seatId), ["seat-1"], "seat-2 failed: its carried reading is not a new observation");

  t.advance(10 * 60_000);
  readings["tok-1"] = { throw: new Error("boom") };
  await t.poller.tick();
  assert.equal(t.polled.length, 2, "every seat carried forward → nothing to report");
});

test("a throwing onPolled never fails the tick", async () => {
  const poller = createUsagePoller({
    adapters: [makeAdapter({ "tok-1": { pct5h: 10, pctWeekly: 1 } })],
    seats: seatsOf(plan(seat(1))),
    now: () => 1_800_000_000_000,
    onPolled: () => {
      throw new Error("hook down");
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await poller.tick();
  } finally {
    console.warn = warn;
  }
  assert.equal(poller.seatSnapshots.length, 1);
});

test("no seats (single credential): the hook has no per-seat snapshots to report", async () => {
  const polled = [];
  const poller = createUsagePoller({
    adapters: [makeAdapter({ undefined: { pct5h: 10, pctWeekly: 1 } })],
    now: () => 1_800_000_000_000,
    onPolled: (f) => polled.push(f),
  });
  await poller.tick();
  assert.equal(polled.length, 0);
});
