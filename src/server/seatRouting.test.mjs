// Seat routing, the server half (docs/superpowers/specs/2026-11-12-claude-seat-routing.md):
// the in-memory seat table on the request path, no global lock, write-behind saves, pin
// pruning, answers with `reason`, `/limit {reason:"auth"}`, pacing of forced moves.
// All I/O injected: fake accounts, fake timers, no disk, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  AUTH_FAILED_MARK_MS,
  MAX_CHILD_LINKS,
  MAX_PINS_PER_PROVIDER,
  MOVE_BACK_BLOCK_MS,
  MOVE_PACING_WINDOW_MS,
  PIN_IDLE_TTL_MS,
  PRUNE_EVERY_MS,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  SEAT_TABLE_WARMING_CODE,
  TOUCH_SAVE_MS,
  createSeatAssigner,
  emptyAssignments,
  pruneAssignments,
} from "./seatAssignment.mjs";
import { createAccountsRouteHandler } from "./accountsRoute.mjs";

const quiet = { warn() {}, log() {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW0 = 50 * 24 * HOUR;

const seat = (n, over = {}) => ({
  seatId: `seat-${n}`,
  accountId: "acct-A",
  orgId: "org-A",
  label: `Seat ${n}`,
  live: false,
  usable: true,
  dir: `/d/${n}`,
  file: `/d/${n}/.credentials.json`,
  credential: { expiresAt: 9e12 },
  ...over,
});
const snap = (n, pct, extra = {}) => ({ provider: "claude", seatId: `seat-${n}`, windows: [{ kind: "session", pct }], ...extra });
const states = (seats, over = {}) => ({ mode: "auto", activeSeatId: "seat-1", seats, ...over });

/** Manual timers: `pending` holds everything armed; `fire(pred)` is "that time arrived". */
function manualTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    set(fn, ms) {
      const h = ++id;
      pending.set(h, { fn, ms });
      return h;
    },
    clear(h) {
      pending.delete(h);
    },
    msList: () => [...pending.values()].map((x) => x.ms).sort((a, b) => a - b),
    async fire(pred = () => true) {
      for (const [h, t] of [...pending.entries()]) {
        if (!pred(t) || !pending.has(h)) continue; // a timer cleared by an earlier one never fires
        pending.delete(h);
        await t.fn();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** An assigner over a fake accounts service whose answer is `acc.state`, with everything countable. */
function rig({ initial, snaps = [], load = null, refresh = async () => ({ ok: true }), now0 = NOW0, warm = true, onMoved = null } = {}) {
  const acc = {
    state: initial,
    calls: 0,
    seatsRoot: undefined,
    async seatStates() {
      acc.calls++;
      return acc.state ?? null;
    },
  };
  const timers = manualTimers();
  const saves = [];
  const refreshed = [];
  let t = now0;
  const svc = createSeatAssigner({
    accounts: acc,
    listSeatSnapshots: () => (typeof snaps === "function" ? snaps() : snaps),
    refreshSeatCredentials: async (provider, target) => {
      refreshed.push([provider, target.seatId]);
      return refresh(provider, target);
    },
    load: () => load,
    save: async (d) => void saves.push(structuredClone(d)),
    now: () => t,
    notePluginSeen: () => {},
    attribution: { record() {} },
    onMoved,
    timers,
    log: quiet,
  });
  const ready = async () => {
    await svc.refreshSeatTable();
  };
  return { svc, acc, timers, saves, refreshed, tick: (ms) => (t += ms), now: () => t, ready };
}

// ---------------------------------------------------------------------------
// §3.1 / §3.2 — the request path is a memory read
// ---------------------------------------------------------------------------

test("20 concurrent new conversations: p99 ≤ 5 ms, none answered live, and the accounts service is never asked", async () => {
  const seats = Array.from({ length: 10 }, (_, i) => seat(i + 1, { accountId: `acct-${i < 5 ? "A" : "B"}`, orgId: `org-${i < 5 ? "A" : "B"}` }));
  const snaps = seats.map((s, i) => ({
    provider: "claude",
    seatId: s.seatId,
    windows: [
      { kind: "session", pct: 10 + i * 5, resetsAt: NOW0 + 3 * HOUR },
      { kind: "weekly", pct: 30 + i, resetsAt: NOW0 + (i + 1) * 12 * HOUR },
    ],
  }));
  const r = rig({ initial: states(seats), snaps });
  await r.ready();
  // Steady state, as in a running server: warm up until the engine has tiered the code up (five fast batches
  // in a row) — cold start is a startup cost, not the request path's.
  let fastInARow = 0;
  for (let batch = 0; batch < 300 && fastInARow < 5; batch++) {
    const started = performance.now();
    await Promise.all(Array.from({ length: 20 }, (_, i) => r.svc.resolve("claude", `warmup-${batch}-${i}`)));
    fastInARow = performance.now() - started < 2 ? fastInARow + 1 : 0;
  }
  const callsAfterWarm = r.acc.calls;
  // From now on a question to the accounts service would hang forever: the request path must not ask it.
  r.acc.seatStates = () => new Promise(() => {});

  // Two views of the same 100 requests (5 batches of 20 concurrent new conversations): what each call costs the
  // caller (the decision is computed inside the call), and how long a whole batch of 20 takes on the one thread —
  // judged on the median batch, so one GC pause does not decide a pass. Wall-clock timing on a loaded machine can
  // catch a scheduler pause, so the best of up to three rounds is what is judged (a real slowness shows in all).
  const answers = [];
  const round = async (n) => {
    const timings = [];
    const batchTotals = [];
    for (let batch = 0; batch < 5; batch++) {
      const batchStart = performance.now();
      const pending = Array.from({ length: 20 }, (_, i) => {
        const start = performance.now();
        const p = r.svc.resolve("claude", `conv-${n}-${batch}-${i}`);
        timings.push(performance.now() - start);
        return p;
      });
      answers.push(...(await Promise.all(pending)));
      batchTotals.push(performance.now() - batchStart);
    }
    timings.sort((a, b) => a - b);
    batchTotals.sort((a, b) => a - b);
    return { p99: timings[Math.ceil(timings.length * 0.99) - 1], medianBatch: batchTotals[2] };
  };
  const rounds = [];
  for (let n = 0; n < 3; n++) {
    rounds.push(await round(n));
    if (rounds[n].p99 <= 5 && rounds[n].medianBatch <= 5) break;
  }
  const best = rounds.reduce((a, b) => (a.p99 + a.medianBatch <= b.p99 + b.medianBatch ? a : b));
  assert.ok(best.p99 <= 5, `p99 resolve was ${best.p99.toFixed(2)} ms`);
  assert.ok(best.medianBatch <= 5, `the median batch of 20 took ${best.medianBatch.toFixed(2)} ms`);
  for (const a of answers) {
    assert.ok(a.seatId, "a seat was chosen");
    assert.equal(a.live, false, "never answered live while seats exist");
    assert.ok(a.credentialFile);
    assert.equal(a.reason, undefined);
  }
  assert.equal(r.acc.calls, callsAfterWarm, "no seatStates call on the request path");
});

test("a slow accounts service does not slow a request: only the background rebuild waits on it", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  const releases = [];
  r.acc.seatStates = () => new Promise((res) => releases.push(() => res(states([seat(1), seat(2)]))));
  const rebuilding = r.svc.refreshSeatTable(); // the slow background rebuild
  const started = performance.now();
  const answer = await r.svc.resolve("claude", "c1");
  assert.ok(performance.now() - started < 50);
  assert.equal(answer.seatId, "seat-1");
  releases.forEach((release) => release());
  await rebuilding;
});

test("parent and sub-agent first requests, concurrent, land on ONE seat — a grandchild through the child link too", async () => {
  // Loads rotate on EVERY read, so two independent decisions would pick different seats.
  let reads = 0;
  const snaps = () => {
    reads++;
    return [snap(1, reads % 2 ? 10 : 60), snap(2, reads % 2 ? 60 : 10)];
  };
  for (const warm of [true, false]) {
    const r = rig({ initial: states([seat(1), seat(2)]), snaps });
    if (warm) await r.ready();
    const [p, c, g] = await Promise.all([r.svc.resolve("claude", "p"), r.svc.resolve("claude", "c", "p"), r.svc.resolve("claude", "g", "c")]);
    assert.equal(c.seatId, p.seatId, `sub-agent shares the parent's seat (table warm: ${warm})`);
    assert.equal(g.seatId, p.seatId, `grandchild follows the recorded link (table warm: ${warm})`);
    assert.equal(Object.keys(r.svc.assignments("claude")).length, 1, "one conversation, one pin");
  }
  // The sub-agent arriving FIRST still leaves one pin on the parent.
  const r = rig({ initial: states([seat(1), seat(2)]), snaps });
  await r.ready();
  const [c, p] = await Promise.all([r.svc.resolve("claude", "c", "p"), r.svc.resolve("claude", "p")]);
  assert.equal(c.seatId, p.seatId);
});

test("no global lock: a rebuild in flight never delays decisions, and a seat refresh does not hold up a resolve", async () => {
  let release;
  const r = rig({
    initial: states([seat(1), seat(2)]),
    snaps: [snap(1, 10), snap(2, 20)],
    refresh: () => new Promise((res) => (release = () => res({ ok: true }))),
  });
  await r.ready();
  const refreshing = r.svc.refreshSeat("claude", "seat-2"); // stuck in the CLI
  await new Promise((res) => setImmediate(res));
  const answer = await Promise.race([r.svc.resolve("claude", "c"), new Promise((res) => setTimeout(() => res("blocked"), 200))]);
  assert.notEqual(answer, "blocked");
  release();
  await refreshing;
});

// ---------------------------------------------------------------------------
// §3.1 — the table is not ready
// ---------------------------------------------------------------------------

test("table not ready: resolve waits for the first build (≤ 3 s), then the route answers 503 warming", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 1), snap(2, 2)] });
  r.acc.seatStates = () => new Promise(() => {}); // the first build never finishes
  const sent = [];
  const handle = createAccountsRouteHandler({
    seatAssigner: r.svc,
    readJson: async (req) => req.body,
    respondJson: (_res, status, body) => sent.push([status, body]),
  });
  const request = handle({ method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: {} }, {}, new URL("/api/accounts/resolve?provider=claude&sessionID=s", "http://x"));
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(sent, [], "still waiting for the build");
  assert.ok([...r.timers.pending.values()].some((x) => x.ms === 3_000), "the wait is capped at 3 s");
  await r.timers.fire((x) => x.ms === 3_000);
  await request;
  assert.deepEqual(sent, [[503, { error: "warming" }]]);
});

test("table not ready: the first request is answered as soon as the build lands, inside the wait", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 1), snap(2, 2)] });
  const releases = [];
  const real = r.acc.seatStates;
  r.acc.seatStates = (...a) => new Promise((res) => releases.push(() => res(real.apply(r.acc, a))));
  const answer = r.svc.resolve("claude", "s");
  await new Promise((res) => setImmediate(res));
  releases.forEach((release) => release());
  const out = await answer;
  assert.equal(out.seatId, "seat-1");
});

test("a warming error carries the code the route keys on", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]) });
  r.acc.seatStates = () => new Promise(() => {});
  const attempt = r.svc.resolve("claude", "s").catch((e) => e);
  await new Promise((res) => setImmediate(res));
  await r.timers.fire((x) => x.ms === 3_000);
  const err = await attempt;
  assert.equal(err.code, SEAT_TABLE_WARMING_CODE);
  assert.equal(err.message, "warming");
});

// ---------------------------------------------------------------------------
// §3.3 — write-behind saves, pruning
// ---------------------------------------------------------------------------

test("saves: a burst of placements produces ONE save, after the debounce; nothing is written before", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  for (let i = 0; i < 12; i++) await r.svc.resolve("claude", `c${i}`);
  assert.equal(r.saves.length, 0, "no write on the request path");
  assert.deepEqual(r.timers.msList(), [SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS], "a 2 s debounce and a 10 s max wait, however many changes");
  await r.timers.fire();
  assert.equal(r.saves.length, 1);
  assert.equal(Object.keys(r.saves[0].providers.claude).length, 12);
  assert.equal(r.timers.pending.size, 0);
});

test("saves: flush() writes at once and clears the timers; shutdown loses nothing", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  await r.svc.resolve("claude", "c");
  assert.equal(r.saves.length, 0);
  await r.svc.flush();
  assert.equal(r.saves.length, 1);
  assert.equal(r.timers.pending.size, 0);
  await r.svc.flush();
  assert.equal(r.saves.length, 1, "nothing dirty → no write");
});

test("saves: a change made while a save is running gets its own save afterwards (single flight, nothing lost)", async () => {
  const timers = manualTimers();
  const gates = [];
  const saves = [];
  const acc = { async seatStates() { return states([seat(1), seat(2)]); } };
  const svc = createSeatAssigner({
    accounts: acc,
    listSeatSnapshots: () => [snap(1, 10), snap(2, 20)],
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: (d) => {
      const copy = structuredClone(d); // what a real save serialises at the moment of the call
      return new Promise((res) => gates.push(() => (saves.push(copy), res())));
    },
    now: () => NOW0,
    notePluginSeen: () => {},
    attribution: { record() {} },
    timers,
    log: quiet,
  });
  await svc.refreshSeatTable();
  await svc.resolve("claude", "a");
  const first = svc.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 1);
  await svc.resolve("claude", "b"); // lands during the save
  gates[0]();
  await first;
  await timers.fire();
  assert.equal(gates.length, 2, "exactly one more save, and only one at a time");
  gates[1]();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(Object.keys(saves[0].providers.claude), ["a"]);
  assert.deepEqual(Object.keys(svc.assignments("claude")).sort(), ["a", "b"]);
});

test("saves: a failed save is retried by the next change, not in a tight loop", async () => {
  const timers = manualTimers();
  let attempts = 0;
  const svc = createSeatAssigner({
    accounts: { async seatStates() { return states([seat(1), seat(2)]); } },
    listSeatSnapshots: () => [snap(1, 10), snap(2, 20)],
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: async () => {
      attempts++;
      if (attempts === 1) throw new Error("disk full");
    },
    now: () => NOW0,
    notePluginSeen: () => {},
    attribution: { record() {} },
    timers,
    log: quiet,
  });
  await svc.refreshSeatTable();
  await svc.resolve("claude", "a");
  await timers.fire();
  assert.equal(attempts, 1);
  assert.equal(timers.pending.size, 0, "no retry timer after a failure");
  await svc.resolve("claude", "b");
  await timers.fire();
  assert.equal(attempts, 2, "the next change saves both");
});

test("saves: a pure lastUsedAt touch is written at most every 10 minutes", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  await r.svc.resolve("claude", "c");
  await r.timers.fire();
  assert.equal(r.saves.length, 1);
  for (let i = 0; i < 8; i++) {
    r.tick(MIN);
    await r.svc.resolve("claude", "c");
  }
  assert.equal(r.timers.pending.size, 0, "touches inside the window arm no save");
  r.tick(TOUCH_SAVE_MS);
  await r.svc.resolve("claude", "c");
  assert.equal(r.timers.pending.size, 2, "the first touch past 10 minutes does");
  await r.timers.fire();
  assert.equal(r.saves.length, 2);
  assert.equal(r.saves[1].providers.claude.c.lastUsedAt, r.now(), "the saved touch is the latest one");
});

test("a touch that rides along with a real change is saved with it", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  await r.svc.resolve("claude", "c");
  await r.svc.flush();
  r.tick(MIN);
  await r.svc.resolve("claude", "c"); // touch only
  await r.svc.resolve("claude", "d"); // a placement
  await r.timers.fire();
  assert.equal(r.saves.length, 2);
  assert.equal(r.saves[1].providers.claude.c.lastUsedAt, r.now());
});

test("pruning: pins idle for over 6 h are dropped on load, and a stale pin met on a request is placed afresh", async () => {
  const load = {
    version: 1,
    providers: {
      claude: {
        stale: { seatId: "seat-2", assignedAt: NOW0 - 9 * HOUR, lastUsedAt: NOW0 - PIN_IDLE_TTL_MS - 1 },
        fresh: { seatId: "seat-2", assignedAt: NOW0 - 3 * HOUR, lastUsedAt: NOW0 - HOUR },
      },
      codex: {},
    },
    children: { kidStale: { root: "stale", at: NOW0 - PIN_IDLE_TTL_MS - 1 }, kid: { root: "fresh", at: NOW0 - MIN } },
  };
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 5), snap(2, 80)], load });
  await r.ready();
  assert.deepEqual(Object.keys(r.svc.assignments("claude")), ["fresh"]);
  assert.deepEqual(Object.keys(r.svc._store().children), ["kid"]);
  assert.equal((await r.svc.resolve("claude", "fresh")).seatId, "seat-2", "a live pin is honoured even though seat-1 is emptier");

  // An in-memory pin that outlives its TTL between prunes is as good as gone.
  r.tick(PIN_IDLE_TTL_MS + 1);
  assert.equal((await r.svc.resolve("claude", "fresh")).seatId, "seat-1", "placed again on the emptier seat");
});

test("pruning: the periodic prune drops idle pins and saves the result", async () => {
  const load = {
    version: 1,
    providers: { claude: { old: { seatId: "seat-1", assignedAt: NOW0 - 5 * HOUR, lastUsedAt: NOW0 - 5.9 * HOUR }, ok: { seatId: "seat-1", assignedAt: NOW0, lastUsedAt: NOW0 } }, codex: {} },
    children: {},
  };
  const r = rig({ initial: states([seat(1), seat(2)]), load });
  r.svc.start();
  await r.ready();
  assert.equal(Object.keys(r.svc.assignments("claude")).length, 2);
  r.tick(PRUNE_EVERY_MS + 5 * MIN);
  await r.timers.fire((x) => x.ms === PRUNE_EVERY_MS);
  assert.deepEqual(Object.keys(r.svc.assignments("claude")), ["ok"]);
  assert.equal(r.saves.length, 1, "the prune was saved");
  assert.deepEqual(Object.keys(r.saves[0].providers.claude), ["ok"]);
  r.svc.stop();
});

test("pruning: caps are enforced least-recently-used first", () => {
  assert.equal(MAX_PINS_PER_PROVIDER, 5_000);
  assert.equal(MAX_CHILD_LINKS, 10_000);
  const store = emptyAssignments();
  const now = NOW0;
  for (let i = 0; i < MAX_PINS_PER_PROVIDER + 5; i++) store.providers.claude[`c${i}`] = { seatId: "seat-1", assignedAt: now - i, lastUsedAt: now - i };
  for (let i = 0; i < MAX_CHILD_LINKS + 7; i++) store.children[`k${i}`] = { root: "c0", at: now - i };
  const out = pruneAssignments(store, now);
  assert.equal(Object.keys(out.providers.claude).length, MAX_PINS_PER_PROVIDER);
  assert.equal(Object.keys(out.children).length, MAX_CHILD_LINKS);
  for (let i = 0; i < 5; i++) assert.equal(out.providers.claude[`c${MAX_PINS_PER_PROVIDER + i}`], undefined, "the least recently used pins went first");
  assert.ok(out.providers.claude.c0 && out.providers.claude[`c${MAX_PINS_PER_PROVIDER - 1}`]);
  for (let i = 0; i < 7; i++) assert.equal(out.children[`k${MAX_CHILD_LINKS + i}`], undefined);
  assert.equal(pruneAssignments(out, now), out, "under the caps and the TTL → the same object");
  // custom caps, per provider
  const small = pruneAssignments(store, now, PIN_IDLE_TTL_MS, { maxPins: 2, maxChildren: 3 });
  assert.deepEqual(Object.keys(small.providers.claude), ["c0", "c1"]);
  assert.deepEqual(Object.keys(small.children), ["k0", "k1", "k2"]);
});

test("pruning: a 5 h move-back block survives while the pin is alive (it is not lost to the 6 h TTL)", async () => {
  const seats = [seat(1), seat(2), seat(3)];
  const snaps = [snap(1, 10), snap(2, 30), snap(3, 60)];
  const r = rig({ initial: states(seats), snaps });
  await r.ready();
  const t0 = r.now();
  assert.equal((await r.svc.resolve("claude", "c")).seatId, "seat-1");
  // seat-1 fills up: the conversation moves to the least loaded seat that has room (seat-2) and records that it left seat-1.
  snaps.splice(0, 3, snap(1, 100, { exhausted: true }), snap(2, 30), snap(3, 60));
  assert.equal((await r.svc.resolve("claude", "c")).seatId, "seat-2");
  // It keeps working for 4 more hours (so the pin stays alive); seat-1 recovers, seat-2 fills.
  for (let i = 0; i < 4; i++) {
    r.tick(HOUR);
    await r.svc.resolve("claude", "c");
    await r.svc.flush(); // saves run on the way (and prune)
  }
  assert.ok(r.now() - t0 < MOVE_BACK_BLOCK_MS, "still inside the 5 h block");
  snaps.splice(0, 3, snap(1, 5), snap(2, 100, { exhausted: true }), snap(3, 60));
  assert.equal((await r.svc.resolve("claude", "c")).seatId, "seat-3", "seat-1 is emptier but the conversation left it 4 h ago");
  assert.ok(r.svc.assignments("claude").c.left["seat-2"], "and the new move is remembered too");
});

test("pruning: a child link's `at` is touched when it is used, so a used link outlives the TTL and an unused one does not", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 10), snap(2, 20)] });
  await r.ready();
  await r.svc.resolve("claude", "p");
  await r.svc.resolve("claude", "used", "p");
  await r.svc.resolve("claude", "idle", "p");
  const linkedAt = r.now();
  for (let i = 0; i < 4; i++) {
    r.tick(2 * HOUR);
    await r.svc.resolve("claude", "used"); // follows its link without the parent header
  }
  assert.equal(r.svc._store().children.used.at, r.now(), "touched on use");
  assert.equal(r.svc._store().children.idle.at, linkedAt, "an unused link keeps its old stamp");
  await r.svc.flush(); // a save prunes
  assert.ok(r.svc._store().children.used, "8 h after it was made, but used 0 h ago → alive");
  assert.equal(r.svc._store().children.idle, undefined, "unused for 8 h → gone");
  assert.ok(r.svc.assignments("claude").p, "the conversation's pin lived on through its sub-agent's requests");
});

// ---------------------------------------------------------------------------
// §3.6 — answers
// ---------------------------------------------------------------------------

test("answers: no seats → reason no-seats; seats but none usable → reason no-usable-seat", async () => {
  const none = rig({ initial: null });
  assert.deepEqual(await none.svc.resolve("claude", "s"), { seatId: null, live: true, reason: "no-seats" });
  const empty = rig({ initial: states([]) });
  assert.deepEqual(await empty.svc.resolve("claude", "s"), { seatId: null, live: true, reason: "no-seats" });
  const dead = rig({ initial: states([seat(1, { usable: false, credential: null }), seat(2, { usable: false, credential: null })]) });
  assert.deepEqual(await dead.svc.resolve("claude", "s"), { seatId: null, live: true, reason: "no-usable-seat" });
  const oneDead = rig({ initial: states([seat(1, { usable: false, credential: null })]) });
  assert.deepEqual(await oneDead.svc.resolve("claude", "s"), { seatId: null, live: true, reason: "no-usable-seat" });
});

test("answers: exactly one seat → its own file when it has a directory, live when it IS the live login", async () => {
  const dir = rig({ initial: states([seat(1)]) });
  assert.deepEqual(await dir.svc.resolve("claude", "s"), { seatId: "seat-1", live: false, provider: "claude", credentialFile: "/d/1/.credentials.json", expiresAt: 9e12 });
  const live = rig({ initial: states([seat(1, { live: true, dir: null, file: null, credential: null })]) });
  assert.deepEqual(await live.svc.resolve("claude", "s"), { seatId: "seat-1", live: true });
  assert.equal(dir.saves.length, 0);
  assert.deepEqual(Object.keys(dir.svc.assignments("claude")), [], "a single seat records no pin");
});

test("answers: a request that finds the live seat answers live:true without a reason", async () => {
  const r = rig({ initial: states([seat(1, { live: true, dir: null, file: null, credential: null }), seat(2)]), snaps: [snap(1, 5), snap(2, 50)] });
  assert.deepEqual(await r.svc.resolve("claude", "c"), { seatId: "seat-1", live: true });
});

// ---------------------------------------------------------------------------
// §3.6 — /limit {reason: "auth"}
// ---------------------------------------------------------------------------

function limitRoute(r) {
  const sent = [];
  const handle = createAccountsRouteHandler({
    seatAssigner: r.svc,
    readJson: async (req) => req.body,
    respondJson: (_res, status, body) => sent.push([status, body]),
    refreshUsageInBackground: () => r.usageRefreshes?.push(1),
  });
  return async (body) => {
    sent.length = 0;
    await handle({ method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: {}, body }, {}, new URL("/api/accounts/limit", "http://x"));
    return sent[0];
  };
}
// seats 1+2 in org A, seat 3 in org B; seat 3 is the emptiest.
const orgB = (n, over = {}) => seat(n, { accountId: "acct-B", orgId: "org-B", ...over });

test("/limit reason:auth: the seat is unusable for 5 min and the conversation moves to a same-org seat first", async () => {
  // seat-1 and seat-2 are org A, seat-3 is org B and emptier than seat-2.
  const r = rig({ initial: states([seat(1), seat(2), orgB(3)]), snaps: [snap(1, 5), snap(2, 60), snap(3, 20)], refresh: async () => ({ ok: false, reason: "failed" }) });
  r.usageRefreshes = [];
  await r.ready();
  const post = limitRoute(r);
  assert.equal((await r.svc.resolve("claude", "c")).seatId, "seat-1");
  const callsBefore = r.acc.calls;
  const out = await post({ provider: "claude", sessionID: "c", reason: "auth" });
  assert.equal(out[0], 200);
  assert.equal(out[1].seatId, "seat-2", "same org (seat-2 at 60) before another org (seat-3 at 20)");
  assert.equal(out[1].moved, true);
  assert.equal(r.usageRefreshes.length, 0, "an auth failure is not a usage signal");
  await new Promise((res) => setImmediate(res));
  assert.ok(r.acc.calls > callsBefore, "the table was rebuilt");
  assert.deepEqual(r.refreshed, [["claude", "seat-1"]], "one more refresh of that seat, in the background");

  // Not usable in ANY decision for 5 minutes.
  assert.equal((await r.svc.resolve("claude", "new-1")).seatId, "seat-3", "a NEW conversation avoids the marked seat although it is the emptiest");
  r.tick(AUTH_FAILED_MARK_MS - 1);
  assert.equal((await r.svc.resolve("claude", "new-2")).seatId, "seat-3");
  r.tick(1);
  assert.equal((await r.svc.resolve("claude", "new-3")).seatId, "seat-1", "the mark expired after 5 minutes");
});

test("auth mark: a successful refresh of that seat clears it early (reported outcome, or the background refresh itself)", async () => {
  const make = (refresh) => rig({ initial: states([seat(1), seat(2), orgB(3)]), snaps: [snap(1, 5), snap(2, 60), snap(3, 20)], refresh });
  const reported = make(async () => ({ ok: false }));
  await reported.ready();
  await reported.svc.resolve("claude", "c");
  assert.equal(reported.svc.markAuthFailed("claude", "c"), "seat-1");
  assert.equal((await reported.svc.resolve("claude", "x")).seatId, "seat-3");
  reported.svc.noteRefreshOutcome("claude", "seat-1", { ok: true });
  assert.equal((await reported.svc.resolve("claude", "y")).seatId, "seat-1", "cleared at once by a successful refresh");

  const background = make(async () => ({ ok: true }));
  await background.ready();
  await background.svc.resolve("claude", "c");
  assert.equal(background.svc.markAuthFailed("claude", "c"), "seat-1");
  for (let i = 0; i < 4; i++) await new Promise((res) => setImmediate(res));
  assert.equal((await background.svc.resolve("claude", "z")).seatId, "seat-1", "the background refresh worked and cleared the mark");
});

test("/limit reason: limit (and no reason) mark the seat limited as before; any other reason is a 400", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 5), snap(2, 60)] });
  r.usageRefreshes = [];
  await r.ready();
  const post = limitRoute(r);
  await r.svc.resolve("claude", "c");
  const withReason = await post({ provider: "claude", sessionID: "c", reason: "limit" });
  assert.equal(withReason[0], 200);
  assert.equal(withReason[1].seatId, "seat-2");
  assert.equal(r.usageRefreshes.length, 1, "a limit still kicks the usage refresh");
  assert.equal(r.refreshed.length, 0, "and no credential refresh");
  for (const reason of ["nope", "", 7, "AUTH"]) {
    assert.deepEqual(await post({ provider: "claude", sessionID: "c", reason }), [400, { error: "invalid" }], `reason ${JSON.stringify(reason)}`);
  }
  const bare = await post({ provider: "claude", sessionID: "c" });
  assert.equal(bare[0], 200);
});

test("/limit reason:auth on a single-seat box marks that seat: the answer is no-usable-seat until it is refreshed", async () => {
  const r = rig({ initial: states([seat(1)]), refresh: async () => ({ ok: false }) });
  await r.ready();
  const post = limitRoute(r);
  const out = await post({ provider: "claude", sessionID: "c", reason: "auth" });
  assert.deepEqual(out[1], { seatId: null, live: true, reason: "no-usable-seat", moved: false });
  r.svc.noteRefreshOutcome("claude", "seat-1", { ok: true });
  assert.equal((await r.svc.resolve("claude", "c")).seatId, "seat-1");
});

test("a refresh success clears a limited mark too", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 5), snap(2, 60)] });
  await r.ready();
  await r.svc.resolve("claude", "c");
  r.svc.markLimited("claude", "c");
  assert.equal(r.svc.conversationSeatFull("claude", "c"), true);
  r.svc.noteRefreshOutcome("claude", "seat-1", { ok: false, reason: "failed" });
  assert.equal(r.svc.conversationSeatFull("claude", "c"), true, "a failed refresh clears nothing");
  r.svc.noteRefreshOutcome("claude", "seat-1", { ok: true });
  assert.equal(r.svc.conversationSeatFull("claude", "c"), false);
});

test("refreshSeat answers through a forced rebuild: the state after the refresh is the table's", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]) });
  await r.ready();
  r.refreshedState = null;
  const answer = await (async () => {
    const run = r.svc.refreshSeat("claude", "seat-2");
    // the refresh rewrote the file: the next build sees the new expiry
    r.acc.state = states([seat(1), seat(2, { credential: { expiresAt: 123 } })]);
    return run;
  })();
  assert.equal(answer.expiresAt, 123);
  assert.equal(r.svc.seatTable.get("claude").seats[1].credential.expiresAt, 123, "the answer and the table agree");
});

// ---------------------------------------------------------------------------
// §3.7 — pacing of forced moves
// ---------------------------------------------------------------------------

test("pacing: conversations forced off one seat spread across same-org targets instead of piling on the least loaded", async () => {
  const snaps = [snap(1, 0), snap(2, 20), snap(3, 24)];
  const r = rig({ initial: states([seat(1), seat(2), seat(3)]), snaps });
  await r.ready();
  const convs = ["c1", "c2", "c3", "c4", "c5"];
  for (const c of convs) assert.equal((await r.svc.resolve("claude", c)).seatId, "seat-1", "all start on the emptiest seat");
  // seat-1 dies: every conversation on it is forced away within seconds, while the readings still say 20 / 24.
  r.acc.state = states([seat(1, { usable: false, credential: null }), seat(2), seat(3)]);
  await r.ready();
  const landed = [];
  for (const c of convs) landed.push((await r.svc.resolve("claude", c)).seatId);
  const count = (id) => landed.filter((x) => x === id).length;
  assert.ok(count("seat-2") >= 2 && count("seat-3") >= 2, `spread: ${landed.join(", ")}`);
  assert.equal(count("seat-1"), 0);
  assert.deepEqual(landed, ["seat-2", "seat-3", "seat-2", "seat-3", "seat-2"], "each forced move projects +5 onto its target");
});

test("pacing: new placements add nothing — five new conversations still take the least loaded seat", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 30), snap(2, 20)] });
  await r.ready();
  const landed = [];
  for (let i = 0; i < 5; i++) landed.push((await r.svc.resolve("claude", `n${i}`)).seatId);
  assert.deepEqual(landed, Array(5).fill("seat-2"));
});

test("pacing: optional moves add nothing, and the projection is gone after 10 minutes", async () => {
  // An optional (load 95) move to seat-2 leaves seat-2's reading alone: a second one still sees 20.
  const snaps = [snap(1, 96), snap(2, 20), snap(3, 25)];
  const r = rig({ initial: states([seat(1), seat(2), seat(3)]), snaps });
  await r.ready();
  for (const c of ["a", "b"]) {
    snaps.splice(0, 3, snap(1, 0), snap(2, 99), snap(3, 99));
    await r.svc.resolve("claude", c); // placed on seat-1
  }
  snaps.splice(0, 3, snap(1, 96), snap(2, 20), snap(3, 25));
  const first = await r.svc.resolve("claude", "a");
  const second = await r.svc.resolve("claude", "b");
  assert.deepEqual([first.seatId, second.seatId], ["seat-2", "seat-2"], "optional moves are not paced");

  // Forced moves are paced, for MOVE_PACING_WINDOW_MS only.
  const forcedPair = async (waitMs) => {
    const p = rig({ initial: states([seat(1), seat(2), seat(3)]), snaps: [snap(1, 0), snap(2, 20), snap(3, 24)] });
    await p.ready();
    await p.svc.resolve("claude", "x");
    await p.svc.resolve("claude", "y");
    p.acc.state = states([seat(1, { usable: false, credential: null }), seat(2), seat(3)]);
    await p.ready();
    const first = (await p.svc.resolve("claude", "x")).seatId;
    p.tick(waitMs);
    return [first, (await p.svc.resolve("claude", "y")).seatId];
  };
  assert.deepEqual(await forcedPair(MIN), ["seat-2", "seat-3"], "inside the window the second one sees seat-2 as 25");
  assert.deepEqual(await forcedPair(MOVE_PACING_WINDOW_MS), ["seat-2", "seat-2"], "after 10 minutes the projection is gone: seat-2 is the least loaded again");
});

test("pacing: never pushes a conversation OFF the seat it is on — the bump only applies to a seat evaluated as a target", async () => {
  // seats 1 and 2 are org A, seat 3 is org B and nearly empty.
  const snaps = [snap(1, 0), snap(2, 50), snap(3, 60)];
  const r = rig({ initial: states([seat(1), seat(2), orgB(3)]), snaps });
  await r.ready();
  for (const c of ["f1", "f2", "f3", "f4"]) assert.equal((await r.svc.resolve("claude", c)).seatId, "seat-1");
  snaps.splice(0, 3, snap(1, 90), snap(2, 10), snap(3, 60));
  assert.equal((await r.svc.resolve("claude", "old")).seatId, "seat-2", "a long-standing conversation on seat-2");
  // seat-1 dies; seat-2 now reads 80 and seat-3 (other org) 10.
  snaps.splice(0, 3, snap(1, 0), snap(2, 80), snap(3, 10));
  r.acc.state = states([seat(1, { usable: false, credential: null }), seat(2), orgB(3)]);
  await r.ready();
  for (const c of ["f1", "f2", "f3", "f4"]) assert.equal((await r.svc.resolve("claude", c)).seatId, "seat-2", "forced moves go to the same org first");
  // 4 forced moves onto seat-2 project +20 on it (80 → 99): for a NEWCOMER seat-2 looks full…
  const asTarget = r.svc.assignments("claude");
  assert.equal(asTarget.old.seatId, "seat-2");
  // …but the conversation already on it is not moved by that projection.
  const old = await r.svc.resolve("claude", "old");
  assert.equal(old.seatId, "seat-2", "kept: its own seat's reading is the real one (80), not the projected one");
  assert.equal(r.svc.assignments("claude").old.movedFrom, undefined);
  assert.equal(r.svc.conversationSeatFull("claude", "old"), false);
  // The same holds for the conversations that were just forced there.
  assert.equal((await r.svc.resolve("claude", "f1")).seatId, "seat-2");
  assert.equal(r.svc.assignments("claude").f1.movedFrom, "seat-1", "still the one move it made, no second move");
});

test("pacing: a NEW placement still sees the bump on every seat", async () => {
  const snaps = [snap(1, 0), snap(2, 20), snap(3, 22)];
  const r = rig({ initial: states([seat(1), seat(2), seat(3)]), snaps });
  await r.ready();
  await r.svc.resolve("claude", "c1");
  r.acc.state = states([seat(1, { usable: false, credential: null }), seat(2), seat(3)]);
  await r.ready();
  assert.equal((await r.svc.resolve("claude", "c1")).seatId, "seat-2", "forced move onto the emptier seat-2 (reads 20)");
  assert.equal((await r.svc.resolve("claude", "newcomer")).seatId, "seat-3", "seat-2 now projects 25: the newcomer takes seat-3 (22)");
});

// ---------------------------------------------------------------------------
// credential recovery's view of the assigner
// ---------------------------------------------------------------------------

test("isLiveServed: true with no seats or on the live seat; false on a directory seat (also through a child link)", async () => {
  const none = rig({ initial: null });
  await none.ready();
  assert.equal(none.svc.isLiveServed("claude", "any"), true);

  const mixed = rig({ initial: states([seat(1, { live: true, dir: null, file: null, credential: null }), seat(2)]), snaps: [snap(1, 5), snap(2, 50)] });
  await mixed.ready();
  await mixed.svc.resolve("claude", "onLive"); // → seat-1, the live one
  await mixed.svc.resolve("claude", "kid", "onLive");
  assert.equal(mixed.svc.isLiveServed("claude", "onLive"), true);
  assert.equal(mixed.svc.isLiveServed("claude", "kid"), true);

  const onDir = rig({ initial: states([seat(1, { live: true, dir: null, file: null, credential: null }), seat(2)]), snaps: [snap(1, 80), snap(2, 5)] });
  await onDir.ready();
  await onDir.svc.resolve("claude", "p"); // → seat-2, a directory seat
  await onDir.svc.resolve("claude", "kid", "p");
  assert.equal(onDir.svc.isLiveServed("claude", "p"), false);
  assert.equal(onDir.svc.isLiveServed("claude", "kid"), false);
  assert.equal(onDir.svc.isLiveServed("claude", "never-seen"), false, "several seats and no pin: not the live login's business");

  const singleDir = rig({ initial: states([seat(1)]) });
  await singleDir.ready();
  assert.equal(singleDir.svc.isLiveServed("claude", "s"), false);
  const singleLive = rig({ initial: states([seat(1, { live: true, dir: null, file: null, credential: null })]) });
  await singleLive.ready();
  assert.equal(singleLive.svc.isLiveServed("claude", "s"), true);
  const unbuilt = rig({ initial: states([seat(1)]) });
  assert.equal(unbuilt.svc.isLiveServed("claude", "s"), true, "before the first build: today's behaviour");
});

test("forgetSeat is synchronous, rebuilds the table, and its pins are saved write-behind", async () => {
  const r = rig({ initial: states([seat(1), seat(2)]), snaps: [snap(1, 5), snap(2, 50)] });
  await r.ready();
  await r.svc.resolve("claude", "c");
  const before = r.acc.calls;
  assert.equal(r.svc.forgetSeat("claude", "seat-1"), true);
  assert.deepEqual(r.svc.assignments("claude"), {});
  await new Promise((res) => setImmediate(res));
  assert.ok(r.acc.calls > before, "the table is rebuilt after a seat is forgotten");
  assert.equal(r.svc.forgetSeat("claude", "seat-1"), false);
  await r.timers.fire();
  assert.equal(r.saves.length, 1, "the placement and the forget went out as one write");
  assert.deepEqual(r.saves[0].providers.claude, {});
});

test("/api/accounts/resolve on the warm path never touches accounts.seatStates (50 resolves, spy sees zero calls)", async () => {
  const r = rig({ initial: states([seat(1), seat(2), seat(3)]), snaps: [snap(1, 10), snap(2, 20), snap(3, 30)] });
  await r.ready();
  let spied = 0;
  r.acc.seatStates = async () => {
    spied++;
    return r.acc.state;
  };
  const sent = [];
  const handle = createAccountsRouteHandler({ seatAssigner: r.svc, readJson: async () => null, respondJson: (_res, status, body) => sent.push([status, body]) });
  for (let i = 0; i < 50; i++) {
    await handle({ method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: {} }, {}, new URL(`/api/accounts/resolve?provider=claude&sessionID=ses_${i}${i % 3 ? "&parentSessionID=ses_0" : ""}`, "http://x"));
  }
  assert.equal(sent.length, 50);
  assert.ok(sent.every(([status, body]) => status === 200 && body.seatId && body.live === false));
  assert.equal(spied, 0, "no seatStates call on the warm resolve path");
});
