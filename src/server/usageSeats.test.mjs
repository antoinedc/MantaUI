// Per-seat usage polling + the provider aggregate (multi-account spec §5.4 / §6).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUsagePoller,
  recordWindowObservations,
  getUsageHistory,
  recheckAdapterAtLimit,
} from "./usage.mjs";

// A fake adapter whose reading depends on the seat's `deps.token`; a token maps
// to `{pct5h, pctWeekly, throw}` in `readings`.
function makeSeatAdapter(readings, calls = []) {
  return {
    id: "claude",
    providerIDs: ["anthropic"],
    async detect(deps) {
      return typeof deps?.token === "string" ? deps.token.length > 0 : true;
    },
    async fetch(deps) {
      const key = deps?.token ?? "single";
      calls.push(key);
      const r = readings[key];
      if (r?.throw) throw r.throw;
      const windows = [
        { kind: "session", label: "5h", pct: r.pct5h, resetsAt: r.resetsAt },
        { kind: "weekly", label: "7d", pct: r.pctWeekly ?? 0 },
        ...(r.extraWindows ?? []),
      ];
      return { provider: "claude", kind: "subscription", windows, ...(r.exhausted ? { exhausted: true } : {}) };
    },
  };
}

const seatDef = (n, token = `tok-${n}`) => ({
  accountId: "acct-1",
  accountLabel: "Work",
  seatId: `seat-${n}`,
  seatLabel: `Seat ${n}`,
  deps: { token },
});
const plan = (mode, activeSeatId, ...seats) => ({ mode, activeSeatId, seats });
const seatsOf = (p) => ({ seatsFor: async (id) => (id === "claude" ? p : null) });
const T0 = 1_800_000_000_000;

function newPoller(adapter, seats, extra = {}) {
  const published = [];
  const poller = createUsagePoller({
    adapters: [adapter],
    seats,
    now: () => T0,
    publish: (e) => published.push(e),
    ...extra,
  });
  return { poller, published };
}

test("single seat: the aggregate is byte-identical in meaning to today's single-credential snapshot", async () => {
  const readings = { single: { pct5h: 15, pctWeekly: 3 }, "tok-1": { pct5h: 15, pctWeekly: 3 } };
  const legacy = newPoller(makeSeatAdapter(readings), null);
  await legacy.poller.tick();
  const seated = newPoller(makeSeatAdapter(readings), seatsOf(plan("manual", "seat-1", seatDef(1))));
  await seated.poller.tick();

  assert.deepEqual(seated.poller.snapshots, legacy.poller.snapshots);
  assert.equal(seated.poller.seatSnapshots.length, 1);
  assert.equal(seated.poller.seatSnapshots[0].seatId, "seat-1");
});

test("two seats, auto: snapshots = the least-loaded seat; seatSnapshots = both, each with its identity", async () => {
  const { poller, published } = newPoller(
    makeSeatAdapter({ "tok-1": { pct5h: 80, pctWeekly: 10 }, "tok-2": { pct5h: 20, pctWeekly: 30 } }),
    seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))),
  );
  await poller.tick();

  assert.equal(poller.snapshots.length, 1);
  assert.equal(poller.snapshots[0].windows[0].pct, 20);
  for (const f of ["accountId", "seatId", "seatLabel", "accountLabel"]) assert.equal(f in poller.snapshots[0], false);

  assert.deepEqual(
    poller.seatSnapshots.map((s) => [s.seatId, s.seatLabel, s.accountId, s.accountLabel, s.windows[0].pct]),
    [["seat-1", "Seat 1", "acct-1", "Work", 80], ["seat-2", "Seat 2", "acct-1", "Work", 20]],
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "usage.updated");
  assert.equal(published[0].payload.snapshots, poller.snapshots);
  assert.equal(published[0].payload.seatSnapshots.length, 2);
});

test("two seats, manual: snapshots follow the active seat even when the other is lighter", async () => {
  const { poller } = newPoller(
    makeSeatAdapter({ "tok-1": { pct5h: 80 }, "tok-2": { pct5h: 20 } }),
    seatsOf(plan("manual", "seat-1", seatDef(1), seatDef(2))),
  );
  await poller.tick();
  assert.equal(poller.snapshots[0].windows[0].pct, 80);
});

test("aggregate exhausted: auto only when ALL seats are; manual mirrors the active seat", async () => {
  const readings = {
    "tok-1": { pct5h: 100, exhausted: true },
    "tok-2": { pct5h: 40 },
  };
  const autoRoom = newPoller(makeSeatAdapter(readings), seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))));
  await autoRoom.poller.tick();
  assert.equal("exhausted" in autoRoom.poller.snapshots[0], false);

  const allFull = newPoller(
    makeSeatAdapter({ "tok-1": { pct5h: 100, exhausted: true }, "tok-2": { pct5h: 100, exhausted: true } }),
    seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))),
  );
  await allFull.poller.tick();
  assert.equal(allFull.poller.snapshots[0].exhausted, true);

  const manualFull = newPoller(makeSeatAdapter(readings), seatsOf(plan("manual", "seat-1", seatDef(1), seatDef(2))));
  await manualFull.poller.tick();
  assert.equal(manualFull.poller.snapshots[0].exhausted, true);
});

test("a stale window never counts toward seat load when choosing the aggregate", async () => {
  // seat-1's 5h reading belongs to a window that already reset (stale) — its
  // real load is its weekly (30). seat-2 is at 50. seat-1 must win.
  const { poller } = newPoller(
    makeSeatAdapter({
      "tok-1": { pct5h: 99, pctWeekly: 30, resetsAt: T0 - 1_000 },
      "tok-2": { pct5h: 50, pctWeekly: 0 },
    }),
    seatsOf(plan("auto", "seat-2", seatDef(1), seatDef(2))),
    { timers: { setTimeout: () => null, clearTimeout() {} } },
  );
  await poller.tick();
  assert.equal(poller.seatSnapshots[0].windows[0].stale, true);
  assert.equal(poller.snapshots[0].windows[0].pct, 99, "seat-1 (stale 5h) was chosen");
});

test("an inactive scoped window does not drive the aggregate's choice or exhaustion", async () => {
  const scoped = { kind: "weekly_scoped:fable", label: "7d · Fable", pct: 100, scope: "Fable", active: false };
  const { poller } = newPoller(
    makeSeatAdapter({ "tok-1": { pct5h: 10, extraWindows: [scoped] }, "tok-2": { pct5h: 60 } }),
    seatsOf(plan("auto", "seat-2", seatDef(1), seatDef(2))),
  );
  await poller.tick();
  assert.equal(poller.snapshots[0].windows[0].pct, 10);
  assert.equal(poller.snapshots[0].windows.at(-1).active, false, "still delivered, greyed, to the dial");
});

test("per-seat 429 backs off only that seat; the sibling keeps polling", async () => {
  const calls = [];
  const err = Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 0 });
  let t = T0;
  const adapter = makeSeatAdapter({ "tok-1": { throw: err }, "tok-2": { pct5h: 20 } }, calls);
  const poller = createUsagePoller({
    adapters: [adapter],
    seats: seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))),
    now: () => t,
    publish: () => {},
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await poller.tick();
    t += 60_000; // inside the 2 min backoff floor
    await poller.tick();
  } finally {
    console.warn = warn;
  }
  assert.equal(calls.filter((c) => c === "tok-1").length, 1, "seat-1 skipped while backed off");
  assert.equal(calls.filter((c) => c === "tok-2").length, 2, "seat-2 polled both ticks");
  assert.equal(poller.snapshots[0].windows[0].pct, 20);
});

test("a failed seat fetch carries that seat's previous reading forward", async () => {
  let fail = false;
  const adapter = {
    id: "claude",
    providerIDs: ["anthropic"],
    detect: async () => true,
    async fetch(deps) {
      if (deps.token === "tok-1" && fail) throw new Error("boom");
      return { provider: "claude", kind: "subscription", windows: [{ kind: "session", label: "5h", pct: deps.token === "tok-1" ? 70 : 20 }] };
    },
  };
  let t = T0;
  const poller = createUsagePoller({
    adapters: [adapter],
    seats: seatsOf(plan("auto", "seat-2", seatDef(1), seatDef(2))),
    now: () => t,
    publish: () => {},
  });
  await poller.tick();
  fail = true;
  t += 600_000;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await poller.tick();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(poller.seatSnapshots.map((s) => [s.seatId, s.windows[0].pct]), [["seat-1", 70], ["seat-2", 20]]);
});

test("a seat whose credential is gone (detect false) simply has no snapshot", async () => {
  const { poller } = newPoller(
    makeSeatAdapter({ "tok-2": { pct5h: 20 } }),
    seatsOf(plan("auto", "seat-2", seatDef(1, ""), seatDef(2))),
  );
  await poller.tick();
  assert.deepEqual(poller.seatSnapshots.map((s) => s.seatId), ["seat-2"]);
});

test("seat lookup failure or no seats → the single-credential path, exactly as before", async () => {
  const readings = { single: { pct5h: 33 } };
  const throwing = newPoller(makeSeatAdapter(readings), { seatsFor: async () => { throw new Error("store down"); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await throwing.poller.tick();
  } finally {
    console.warn = warn;
  }
  assert.equal(throwing.poller.snapshots[0].windows[0].pct, 33);
  assert.deepEqual(throwing.poller.seatSnapshots, []);

  const none = newPoller(makeSeatAdapter(readings), seatsOf(null));
  await none.poller.tick();
  assert.equal(none.poller.snapshots[0].windows[0].pct, 33);
});

test("publish dedupe: unchanged seats publish once; a change in ONE seat alone republishes", async () => {
  const readings = { "tok-1": { pct5h: 80 }, "tok-2": { pct5h: 20 } };
  let t = T0;
  const published = [];
  const poller = createUsagePoller({
    adapters: [makeSeatAdapter(readings)],
    seats: seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))),
    now: () => t,
    publish: (e) => published.push(e),
  });
  await poller.tick();
  t += 600_000;
  await poller.tick();
  assert.equal(published.length, 1);
  // seat-1 moves, but it stays the heavier seat, so the AGGREGATE is unchanged
  // — only seatSnapshots differ, and that alone must republish.
  readings["tok-1"].pct5h = 85;
  t += 600_000;
  await poller.tick();
  assert.equal(published.length, 2);
});

test("observe is called with the aggregate and the per-seat snapshots", async () => {
  const seen = [];
  const { poller } = newPoller(
    makeSeatAdapter({ "tok-1": { pct5h: 80 }, "tok-2": { pct5h: 20 } }),
    seatsOf(plan("auto", "seat-1", seatDef(1), seatDef(2))),
    { observe: (agg, seatSnaps) => seen.push([agg.length, seatSnaps.length]) },
  );
  await poller.tick();
  assert.deepEqual(seen, [[1, 2]]);
});

test("history keys: aggregate keeps <provider>:<kind>; seats add <provider>:<seatId>:<kind>; inactive windows are not history", () => {
  const snap = (extra = {}) => ({
    provider: "claude",
    providerIDs: ["anthropic"],
    fetchedAt: T0,
    windows: [
      { kind: "session", label: "5h", pct: 12 },
      { kind: "weekly_scoped:fable", label: "7d · Fable", pct: 100, active: false },
    ],
    ...extra,
  });
  recordWindowObservations([snap()], [snap({ seatId: "seat-7" })]);
  const history = getUsageHistory();
  assert.ok(history["claude:session"]);
  assert.ok(history["claude:seat-7:session"]);
  assert.equal(history["claude:weekly_scoped:fable"], undefined);
  assert.equal(history["claude:seat-7:weekly_scoped:fable"], undefined);
});

test("recheckAdapterAtLimit with seats: auto = every seat at its limit; manual = the active seat", async () => {
  const full = { windows: [{ kind: "session", label: "5h", pct: 100 }] };
  const room = { windows: [{ kind: "session", label: "5h", pct: 10 }] };
  const readings = { "tok-1": full, "tok-2": room, "tok-3": full };
  // recheckAdapterAtLimit resolves the real adapter registry by id, so patch
  // the fetch through the seat deps instead: the real claude adapter takes
  // `readCredentials` + `fetchImpl`.
  const fetchImpl = async (_url, init) => {
    const tok = String(init.headers.Authorization).replace("Bearer ", "");
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ five_hour: { utilization: readings[tok].windows[0].pct } }) };
  };
  const seatDeps = (n) => ({ ...seatDef(n), deps: { readCredentials: async () => ({ accessToken: `tok-${n}` }) } });
  const run = (p) => recheckAdapterAtLimit("claude", { fetchImpl, seatsFor: async () => p });

  assert.equal(await run(plan("auto", "seat-1", seatDeps(1), seatDeps(2))), false);
  assert.equal(await run(plan("auto", "seat-1", seatDeps(1), seatDeps(3))), true);
  assert.equal(await run(plan("manual", "seat-1", seatDeps(1), seatDeps(2))), true);
  assert.equal(await run(plan("manual", "seat-2", seatDeps(1), seatDeps(2))), false);
});
