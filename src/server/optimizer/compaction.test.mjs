// Tests for optimizer/compaction.mjs — the background compaction scheduler
// (Optimizer P2.4, BET-1346). Pure/injected throughout: `determine`/`compact`
// are stubs, `load`/`save` are in-memory, `now` is a controlled clock, and
// `isBusy` is a controllable function. Run via `npm run test:server`
// (node:test). Makes no model calls — everything is injected or mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCompact,
  createCompactionScheduler,
  COMPACT_CTX_THRESHOLD,
  COMPACT_IDLE_MS,
  COMPACT_COOLDOWN_MS,
  COMPACT_MAX_PER_TICK,
} from "./compaction.mjs";

const NOW = 1_000_000_000_000;

// A candidate that satisfies every condition so a test can flip ONE input at a
// time and assert the named failing reason.
function okCandidate(over = {}) {
  return {
    sessionID: "s1",
    contextTokens: 90_000,
    contextLimit: 100_000, // 90% > 85% threshold
    idleMs: 20 * 60_000, // > 10m idle
    cacheDead: true,
    busy: false,
    lastAttemptMs: NOW - 2 * COMPACT_COOLDOWN_MS, // far past cooldown
    now: NOW,
    enabled: true,
    ...over,
  };
}

// ---- shouldCompact: each condition individually blocks and names itself ----

test("shouldCompact: disabled blocks first and names it", () => {
  const d = shouldCompact(okCandidate({ enabled: false }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "disabled");
});

test("shouldCompact: busy blocks and names it", () => {
  const d = shouldCompact(okCandidate({ busy: true }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "busy");
});

test("shouldCompact: contextLimit 0 / undefined never compacts", () => {
  assert.equal(shouldCompact(okCandidate({ contextLimit: 0 })).reason, "no-context-limit");
  assert.equal(shouldCompact(okCandidate({ contextLimit: undefined })).reason, "no-context-limit");
  assert.equal(shouldCompact(okCandidate({ contextLimit: -5 })).reason, "no-context-limit");
});

test("shouldCompact: low context blocks below the 85% threshold", () => {
  const d = shouldCompact(okCandidate({ contextTokens: COMPACT_CTX_THRESHOLD * 100_000 }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "low-context");
});

test("shouldCompact: not idle blocks within 10m", () => {
  const d = shouldCompact(okCandidate({ idleMs: COMPACT_IDLE_MS }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "not-idle");
});

test("shouldCompact: warm cache blocks even at 99% context", () => {
  const d = shouldCompact(okCandidate({ contextTokens: 99_000, cacheDead: false }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "cache-warm");
});

test("shouldCompact: cooldown blocks a second attempt", () => {
  const d = shouldCompact(okCandidate({ lastAttemptMs: NOW - COMPACT_COOLDOWN_MS + 1 }));
  assert.equal(d.compact, false);
  assert.equal(d.reason, "cooldown");
});

test("shouldCompact: all true → compact with reason 'compact'", () => {
  const d = shouldCompact(okCandidate());
  assert.deepEqual(d, { compact: true, reason: "compact" });
});

// ---- createCompactionScheduler ----

function makeScheduler({ listCandidates, compact, isBusy, now = () => NOW, enabled = () => true, initial = {} } = {}) {
  let state = initial;
  const compactCalls = [];
  const saves = [];
  const scheduler = createCompactionScheduler({
    listCandidates: listCandidates ?? (async () => []),
    compact: compact ?? (async (sid) => { compactCalls.push(sid); }),
    isBusy: isBusy ?? (() => false),
    now,
    load: async () => JSON.parse(JSON.stringify(state)),
    save: async (s) => {
      state = JSON.parse(JSON.stringify(s));
      saves.push(state);
    },
    enabled,
  });
  return { scheduler, compactCalls, saves, getState: () => state };
}

function candidate(sid, over = {}) {
  return {
    sessionID: sid,
    contextTokens: 90_000,
    contextLimit: 100_000,
    lastActivityMs: NOW - 20 * 60_000, // 20m idle
    cacheTtlMs: 300_000, // idle 20m > ttl 5m → cacheDead
    ...over,
  };
}

test("scheduler: compacts a fully-eligible candidate and persists lastAttempt", async () => {
  const { scheduler, compactCalls, getState } = makeScheduler({
    listCandidates: async () => [candidate("s1")],
  });
  const result = await scheduler.tick();
  assert.deepEqual(result.compacted, ["s1"]);
  assert.deepEqual(compactCalls, ["s1"]);
  assert.equal(getState().sessions.s1.lastResult, "ok");
  assert.equal(getState().sessions.s1.lastAttemptMs, NOW);
});

test("scheduler: MAX_PER_TICK caps a tick with 5 candidates", async () => {
  const { scheduler, compactCalls } = makeScheduler({
    listCandidates: async () => [1, 2, 3, 4, 5].map((i) => candidate(`s${i}`)),
  });
  await scheduler.tick();
  assert.equal(compactCalls.length, COMPACT_MAX_PER_TICK);
  assert.deepEqual(compactCalls, ["s1", "s2"]);
});

test("scheduler: disabled pass-through → no compaction", async () => {
  const { scheduler, compactCalls } = makeScheduler({
    listCandidates: async () => [candidate("s1")],
    enabled: () => false,
  });
  await scheduler.tick();
  assert.deepEqual(compactCalls, []);
});

test("scheduler: busy blocks a candidate (isBusy during evaluation)", async () => {
  const { scheduler, compactCalls, getState } = makeScheduler({
    listCandidates: async () => [candidate("s1")],
    isBusy: () => true,
  });
  await scheduler.tick();
  assert.deepEqual(compactCalls, []);
  assert.equal(getState()?.sessions?.s1, undefined);
});

test("scheduler: isBusy re-checked immediately before the call — a turn starting between evaluation and the call aborts it", async () => {
  // `isBusy` starts returning false (so the candidate passes evaluation), then
  // flips to true on the SECOND call — the immediate re-check right before
  // compact — modelling a turn that starts between evaluation and the call.
  const calls = [];
  let busy = false;
  const sched2 = createCompactionScheduler({
    listCandidates: async () => [candidate("s1")],
    compact: async () => { calls.push("compact"); },
    isBusy: () => {
      const v = busy;
      busy = true; // evaluation=false (passes) → re-check=true (aborts)
      return v;
    },
    now: () => NOW,
    load: async () => ({ sessions: {} }),
    save: async () => {},
    enabled: () => true,
  });
  await sched2.tick();
  assert.deepEqual(calls, [], "compact must NOT be called when busy flipped before the call");
});

test("scheduler: cooldown blocks a second attempt from persisted state", async () => {
  const { scheduler, compactCalls } = makeScheduler({
    listCandidates: async () => [candidate("s1")],
    initial: { sessions: { s1: { lastAttemptMs: NOW - COMPACT_COOLDOWN_MS + 1, lastResult: "ok" } } },
  });
  await scheduler.tick();
  assert.deepEqual(compactCalls, [], "cooldown must block a fresh compaction");
});

test("scheduler: the in-flight set blocks a re-entrant tick", async () => {
  // compact returns a deferred (never-yet-resolved) promise so the first tick
  // is genuinely in flight when the second tick runs.
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { scheduler } = makeScheduler({
    listCandidates: async () => [candidate("s1")],
    compact: async () => { calls.push("compact"); await deferred; },
  });
  const t1 = scheduler.tick(); // begins, adds s1 to in-flight, awaits compact
  await Promise.resolve(); // let t1 reach the in-flight claim
  const t2 = scheduler.tick(); // re-entrant: s1 is in-flight → must skip
  await Promise.resolve();
  release(); // let both settle
  await Promise.all([t1, t2]);
  assert.deepEqual(calls, ["compact"], "the same in-flight session must not be compacted twice");
});

// BET-1356: the injected `compact` may return the post-compaction token count,
// and the scheduler must flow it through to onCompacted (and pass null when it
// returns nothing, so callers fall back to the no-count wording).
test("scheduler: forwards compact's post-compaction token count to onCompacted", async () => {
  let notified = null;
  const scheduler = createCompactionScheduler({
    listCandidates: async () => [candidate("s1")],
    compact: async () => 31_000,
    isBusy: () => false,
    now: () => NOW,
    load: async () => ({ sessions: {} }),
    save: async () => {},
    enabled: () => true,
    onCompacted: async (info) => { notified = info; },
  });
  await scheduler.tick();
  assert.equal(notified.sessionID, "s1");
  assert.equal(notified.contextTokens, 90_000, "before stays contextTokens");
  assert.equal(notified.afterTokens, 31_000, "after is compact's return value");
});

test("scheduler: onCompacted gets afterTokens null when compact returns nothing", async () => {
  let notified = null;
  const scheduler = createCompactionScheduler({
    listCandidates: async () => [candidate("s1")],
    compact: async () => undefined, // legacy/no-measure stub
    isBusy: () => false,
    now: () => NOW,
    load: async () => ({ sessions: {} }),
    save: async () => {},
    enabled: () => true,
    onCompacted: async (info) => { notified = info; },
  });
  await scheduler.tick();
  assert.equal(notified.afterTokens, null, "unknown after → null (renderer falls back)");
});

test("scheduler: non-finite/zero compact return is coerced to null", async () => {
  let notified = null;
  const scheduler = createCompactionScheduler({
    listCandidates: async () => [candidate("s1")],
    compact: async () => Number.NaN,
    isBusy: () => false,
    now: () => NOW,
    load: async () => ({ sessions: {} }),
    save: async () => {},
    enabled: () => true,
    onCompacted: async (info) => { notified = info; },
  });
  await scheduler.tick();
  assert.equal(notified.afterTokens, null);
});
