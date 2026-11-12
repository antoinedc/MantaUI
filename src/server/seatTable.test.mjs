// The seat table (spec §3.1): background-only rebuilds, single-flight, a first-build wait.
// Injected readers, timers and watcher — no disk, no real time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeatTable, SEAT_TABLE_REFRESH_MS, SEAT_TABLE_WATCH_DEBOUNCE_MS } from "./seatTable.mjs";

const quiet = { warn() {}, log() {} };

/** Manual timers: `due` holds what is armed; `fireAll()` is "the time arrived". */
function manualTimers() {
  const armed = new Map();
  let id = 0;
  return {
    armed,
    set(fn, ms) {
      const h = ++id;
      armed.set(h, { fn, ms });
      return h;
    },
    clear(h) {
      armed.delete(h);
    },
    fireAll() {
      const due = [...armed.entries()];
      armed.clear();
      for (const [, t] of due) t.fn();
    },
    fireWhere(pred) {
      for (const [h, t] of [...armed.entries()]) {
        if (pred(t)) {
          armed.delete(h);
          t.fn();
        }
      }
    },
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("a build reads every provider; get() is synchronous and null before the first build", async () => {
  const calls = [];
  const t = createSeatTable({ readStates: async (p) => (calls.push(p), p === "claude" ? { seats: [{ seatId: "s1" }] } : null), timers: manualTimers(), log: quiet });
  assert.equal(t.get("claude"), null);
  assert.equal(t.has("claude"), false);
  await t.rebuild();
  assert.deepEqual(calls.sort(), ["claude", "codex"]);
  assert.equal(t.get("claude").seats[0].seatId, "s1");
  assert.equal(t.get("codex"), null, "no seats is a build result too");
  assert.equal(t.has("codex"), true);
});

test("single flight: rebuild requests during a build coalesce into ONE more build, which sees newer state", async () => {
  let version = 0;
  const gate = [];
  let reads = 0;
  const t = createSeatTable({
    providers: ["claude"],
    readStates: async () => {
      reads++;
      const v = version;
      const d = deferred();
      gate.push(d);
      await d.promise;
      return { v };
    },
    timers: manualTimers(),
    log: quiet,
  });
  const first = t.rebuild();
  version = 1;
  const second = t.rebuild();
  const third = t.rebuild();
  assert.equal(reads, 1, "only one read is running");
  gate[0].resolve();
  await first;
  await Promise.resolve();
  assert.equal(reads, 2, "exactly one more build was queued for the callers that came in meanwhile");
  version = 2;
  gate[1].resolve();
  await Promise.all([second, third]);
  assert.equal(reads, 2);
  assert.equal(t.get("claude").v, 1, "the queued build started after the change, so it sees it");
});

test("ready(): waits for the first build only; answers true at once afterwards", async () => {
  const d = deferred();
  const t = createSeatTable({ providers: ["claude"], readStates: async () => (await d.promise, { seats: [] }), timers: manualTimers(), log: quiet });
  const waiting = t.ready("claude", 3_000);
  let done = false;
  waiting.then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  d.resolve();
  assert.equal(await waiting, true);
  assert.equal(await t.ready("claude", 3_000), true);
});

test("ready(): a build that outlasts the wait resolves false at the timeout", async () => {
  const timers = manualTimers();
  const never = new Promise(() => {});
  const t = createSeatTable({ providers: ["claude"], readStates: () => never, timers, log: quiet });
  const waiting = t.ready("claude", 3_000);
  const timeout = [...timers.armed.values()].find((x) => x.ms === 3_000);
  assert.ok(timeout, "a 3 s timer is armed");
  timeout.fn();
  assert.equal(await waiting, false);
});

test("a failing rebuild keeps the previous table and warns once per streak", async () => {
  const warnings = [];
  let fail = false;
  const t = createSeatTable({
    providers: ["claude"],
    readStates: async () => {
      if (fail) throw new Error("disk gone");
      return { seats: [{ seatId: "s1" }] };
    },
    timers: manualTimers(),
    log: { warn: (...a) => warnings.push(a.join(" ")) },
  });
  await t.rebuild();
  fail = true;
  await t.rebuild();
  await t.rebuild();
  assert.equal(t.get("claude").seats[0].seatId, "s1", "the last good table survives");
  assert.equal(warnings.length, 1, "one warning for the whole streak");
  assert.match(warnings[0], /disk gone/);
  fail = false;
  await t.rebuild();
  fail = true;
  await t.rebuild();
  assert.equal(warnings.length, 2, "a new streak warns again");
});

test("a first build that fails settles waiters with false right away (the route answers warming)", async () => {
  const t = createSeatTable({ providers: ["claude"], readStates: async () => { throw new Error("nope"); }, timers: manualTimers(), log: quiet });
  assert.equal(await t.ready("claude", 3_000), false);
});

test("start(): builds now, then rebuilds every SEAT_TABLE_REFRESH_MS; stop() ends it", async () => {
  const timers = manualTimers();
  let reads = 0;
  const t = createSeatTable({ providers: ["claude"], readStates: async () => (reads++, { seats: [] }), timers, log: quiet });
  t.start();
  await t.rebuild();
  assert.equal(reads >= 1, true);
  await Promise.resolve();
  const periodic = [...timers.armed.values()].find((x) => x.ms === SEAT_TABLE_REFRESH_MS);
  assert.ok(periodic, "the 10 s timer is armed after the first build");
  const before = reads;
  timers.fireWhere((x) => x.ms === SEAT_TABLE_REFRESH_MS);
  await t.rebuild();
  assert.ok(reads > before, "the timer caused a rebuild");
  t.stop();
  assert.equal(timers.armed.size, 0, "nothing left armed");
});

test("fs watch: events are debounced into one rebuild; temp files are ignored; a watcher that fails to start only warns", async () => {
  const timers = manualTimers();
  let reads = 0;
  let listener = null;
  const closed = [];
  const watch = (root, opts, cb) => {
    assert.equal(root, "/seats");
    assert.equal(opts.recursive, true);
    listener = cb;
    return { on() {}, close: () => closed.push(true), unref() {} };
  };
  const t = createSeatTable({ providers: ["claude"], readStates: async () => (reads++, { seats: [] }), watchRoot: "/seats", watch, timers, log: quiet });
  t.start();
  await t.rebuild();
  const base = reads;
  listener("rename", "claude/seat-1/.credentials.json.tmp-1-2-a");
  const debounceBefore = [...timers.armed.values()].filter((x) => x.ms === SEAT_TABLE_WATCH_DEBOUNCE_MS).length;
  assert.equal(debounceBefore, 0, "a temp file is ignored");
  listener("rename", "claude/seat-1/.credentials.json");
  listener("change", "claude/seat-1/.credentials.json");
  const debounces = [...timers.armed.values()].filter((x) => x.ms === SEAT_TABLE_WATCH_DEBOUNCE_MS);
  assert.equal(debounces.length, 1, "two events, one pending rebuild");
  timers.fireWhere((x) => x.ms === SEAT_TABLE_WATCH_DEBOUNCE_MS);
  await t.rebuild();
  assert.ok(reads > base);
  t.stop();
  assert.equal(closed.length, 1, "the watcher is closed on stop");

  const warnings = [];
  const t2 = createSeatTable({
    providers: ["claude"],
    readStates: async () => ({ seats: [] }),
    watchRoot: "/missing",
    watch: () => {
      throw new Error("ENOENT");
    },
    timers: manualTimers(),
    log: { warn: (...a) => warnings.push(a.join(" ")) },
  });
  t2.start();
  await t2.rebuild();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /periodic rebuild still runs/);
  assert.equal(t2.has("claude"), true, "the table works without a watcher");
  t2.stop();
});
