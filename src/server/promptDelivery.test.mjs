// Tests for src/server/promptDelivery.mjs — the single defer-while-busy
// prompt-delivery engine shared by all four senders (webhook, schedule,
// peer, capability). The busy/pending mechanics were lifted verbatim from
// the webhook engine; these tests pin that behaviour so a future change to
// the shared engine can't silently regress the three senders that just
// gained deferral (BET-375).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPromptDelivery } from "./promptDelivery.mjs";

// Build an engine with a fake sendPrompt that records every call in order.
// `rejectTexts` is a Set of texts whose sendPrompt call should reject.
function makeEngine({ rejectTexts = new Set(), ...opts } = {}) {
  const calls = [];
  const sendPrompt = async (args) => {
    calls.push(args);
    if (rejectTexts.has(args?.text)) {
      throw new Error(`synthetic sendPrompt failure for "${args?.text}"`);
    }
  };
  const engine = createPromptDelivery({ sendPrompt, ...opts });
  return { engine, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const status = (sid, type) => ({ type: "session.status", properties: { sessionID: sid, status: { type } } });
const idleEvt = (sid) => ({ type: "session.idle", properties: { sessionID: sid } });
// One turn boundary as opencode emits it: status idle + session.idle together.
const boundary = (engine, sid) => {
  engine.observeEvent(status(sid, "idle"));
  engine.observeEvent(idleEvt(sid));
};

// Deterministic clock + timers: nothing sleeps; tests advance time by hand.
function makeFakeTime() {
  let t = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => t,
    advance(ms) { t += ms; },
    timers: {
      setTimeout: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, at: t + ms }); return { id, unref() {} }; },
      clearTimeout: (h) => { timeouts.delete(h?.id); },
      setInterval: (fn) => { const id = nextId++; intervals.set(id, fn); return { id, unref() {} }; },
      clearInterval: (h) => { intervals.delete(h?.id); },
    },
    // Advance the clock and fire every timeout that has come due.
    async elapse(ms) {
      t += ms;
      for (const [id, { fn, at }] of [...timeouts]) {
        if (at <= t) { timeouts.delete(id); fn(); }
      }
      await tick();
    },
    pendingTimeouts: () => timeouts.size,
    intervalCount: () => intervals.size,
  };
}

// Timed engine, session busy, "one" + "two" queued, then a boundary drains
// "one" (awaiting start, timer armed) with "two" still waiting.
async function drainedOneOfTwo() {
  const time = makeFakeTime();
  const { engine, calls } = makeEngine({ now: time.now, timers: time.timers });
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "one" });
  await engine.deliver({ sessionId: "s1", text: "two" });
  boundary(engine, "s1");
  await tick();
  return { time, engine, calls };
}

// Busy session with one waiting item, silent past the stale threshold, swept once.
async function sweepSilentBusy(engine, time) {
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "waiting" });
  time.advance(601_000);
  await engine.sweepStale();
  await tick();
}

test("1. idle session → deliver calls sendPrompt once and reports delivered:true", async () => {
  const { engine, calls } = makeEngine();
  const res = await engine.deliver({ sessionId: "s1", text: "hi" });
  assert.equal(res.delivered, true);
  assert.equal(res.queued, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "s1", text: "hi" });
});

test("2. busy session → sendPrompt NOT called; reports queued:true", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  const res = await engine.deliver({ sessionId: "s1", text: "deferred" });
  assert.equal(res.delivered, false);
  assert.equal(res.queued, true);
  assert.equal(calls.length, 0);
});

test("3. busy then two delivers then idle → sent one per turn, in submission order", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "first" });
  await engine.deliver({ sessionId: "s1", text: "second" });
  assert.equal(calls.length, 0, "nothing sent while busy");
  engine.observeEvent(idleEvt("s1"));
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["first"]);
  // The first drained turn starts and ends → the second goes out.
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["first", "second"]);
});

test("4. session.status{type:\"retry\"} also marks busy", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "retry" } },
  });
  assert.equal(engine.isBusy("s1"), true);
  const res = await engine.deliver({ sessionId: "s1", text: "x" });
  assert.equal(res.queued, true);
  assert.equal(calls.length, 0);
});

test("5. session.error clears busy and drains", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "queued-on-error" });
  engine.observeEvent({ type: "session.error", properties: { sessionID: "s1" } });
  await new Promise((r) => setTimeout(r, 5));
  // The drained item is now the in-flight turn, so the session reads busy.
  assert.equal(engine.isBusy("s1"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "queued-on-error");
});

test("6. session.status{type:\"idle\"} clears busy and drains", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "queued-on-idle" });
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" } },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.isBusy("s1"), true, "drained item is the in-flight turn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "queued-on-idle");
});

test("7. a sendPrompt rejection does not reject deliver and does not stop the queue draining", async () => {
  const { engine, calls } = makeEngine({ rejectTexts: new Set(["will-fail", "boom"]) });
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "will-fail" });
  await engine.deliver({ sessionId: "s1", text: "after-fail" });
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  await new Promise((r) => setTimeout(r, 5));
  // The first threw, so the second goes out immediately with no further event.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, "will-fail");
  assert.equal(calls[1].text, "after-fail");
  // A direct deliver to an idle session that rejects must not reject.
  const res = await engine.deliver({ sessionId: "s2", text: "boom" });
  assert.equal(res.delivered, false);
  assert.equal(res.queued, false);
});

test("8. events with no properties.sessionID are ignored without throwing", async () => {
  const { engine } = makeEngine();
  assert.doesNotThrow(() => engine.observeEvent({ type: "session.idle" }));
  assert.doesNotThrow(() => engine.observeEvent({ type: "session.status", properties: {} }));
  assert.doesNotThrow(() => engine.observeEvent(undefined));
  assert.doesNotThrow(() => engine.observeEvent(null));
  assert.doesNotThrow(() =>
    engine.observeEvent({ type: "session.status", properties: { sessionID: 123 } }),
  );
});

test("9. isBusy reflects the tracked state", async () => {
  const { engine } = makeEngine();
  assert.equal(engine.isBusy("s1"), false);
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  assert.equal(engine.isBusy("s1"), true);
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  assert.equal(engine.isBusy("s1"), false);
});

test("10. pending queue is bounded: deliveries beyond the cap are rejected+surfaced, not queued (BET-772)", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });

  // The cap is MAX_PENDING_PER_SESSION = 20; the first 20 queue normally.
  const queued = [];
  for (let i = 0; i < 20; i++) {
    const res = await engine.deliver({ sessionId: "s1", text: `q${i}` });
    queued.push(res);
  }
  assert.equal(queued.length, 20);
  assert.ok(
    queued.every((r) => r.delivered === false && r.queued === true && !r.rejected),
    "first 20 deferred deliveries all queued",
  );
  assert.equal(calls.length, 0, "nothing sent while busy");

  // The 21st+ are rejected+surfaced, not pushed.
  for (let i = 0; i < 5; i++) {
    const res = await engine.deliver({ sessionId: "s1", text: `overflow${i}` });
    assert.equal(res.delivered, false);
    assert.equal(res.queued, false);
    assert.equal(res.rejected, true, "overflow delivery surfaced as rejected");
  }

  // One turn boundary per queued item drains exactly the queued 20 (one at a
  // time); the rejected ones are NOT delivered.
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  await tick();
  for (let i = 1; i < 20; i++) {
    engine.observeEvent(status("s1", "busy"));
    boundary(engine, "s1");
    await tick();
  }
  assert.equal(calls.length, 20);
  assert.deepEqual(
    calls.map((c) => c.text),
    Array.from({ length: 20 }, (_, i) => `q${i}`),
  );
});

test("11. bounding is per-session: a full queue for one session does not reject another's deliveries", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s2", status: { type: "busy" } },
  });

  for (let i = 0; i < 20; i++) {
    await engine.deliver({ sessionId: "s1", text: `s1-${i}` });
  }
  // s1 is at the cap...
  assert.equal((await engine.deliver({ sessionId: "s1", text: "s1-over" })).rejected, true);
  // ...but s2 queues normally.
  const s2 = await engine.deliver({ sessionId: "s2", text: "s2-first" });
  assert.equal(s2.queued, true);
  assert.equal(s2.rejected, undefined);
});

test("12. idle deliver with a model forwards it; without one omits the key (BET-947)", async () => {
  const { engine, calls } = makeEngine();
  const model = { providerID: "anthropic", modelID: "claude-opus-4-5" };
  const withModel = await engine.deliver({ sessionId: "s1", text: "hi", model });
  assert.equal(withModel.delivered, true);
  assert.deepEqual(calls[0], { sessionId: "s1", text: "hi", model });
});

test("13. deliver without a model leaves sendPrompt byte-identical to pre-model (BET-947)", async () => {
  const { engine, calls } = makeEngine();
  const res = await engine.deliver({ sessionId: "s1", text: "hi" });
  assert.equal(res.delivered, true);
  assert.deepEqual(calls[0], { sessionId: "s1", text: "hi" });
  assert.equal("model" in calls[0], false, "no model key when one was not given");
});

test("14. deferred delivery preserves the model across the busy drain (BET-947)", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  const model = { providerID: "deepseek", modelID: "deepseek-chat" };
  const res = await engine.deliver({ sessionId: "s1", text: "deferred", model });
  assert.equal(res.queued, true);
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "s1", text: "deferred", model });
});

// ---------------------------------------------------------------------------
// Pacing / coalescing / stale-busy (2026-09-30 incident)
// ---------------------------------------------------------------------------

test("15. incident: 25 deliveries with one coalesceKey → one waiting item (newest text), one send after idle", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  const results = [];
  for (let i = 0; i < 25; i++) {
    results.push(
      await engine.deliver({ sessionId: "s1", text: `tick ${i}`, coalesceKey: "sched:j1", ctoKey: `sched:j1:${i}` }),
    );
  }
  assert.deepEqual(results[0], { delivered: false, queued: true });
  for (const r of results.slice(1)) {
    assert.deepEqual(r, { delivered: false, queued: true, coalesced: true });
  }
  assert.equal(results.some((r) => r.rejected), false, "coalesced deliveries are never rejected");
  boundary(engine, "s1");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "tick 24");
  // Nothing else is waiting: later boundaries send nothing more.
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.equal(calls.length, 1);
});

test("16. coalescing keeps queue position and replaces the model", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "a", coalesceKey: "k" });
  await engine.deliver({ sessionId: "s1", text: "b" });
  const m = { providerID: "p", modelID: "m" };
  await engine.deliver({ sessionId: "s1", text: "a2", model: m, coalesceKey: "k" });
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls[0], { sessionId: "s1", text: "a2", model: m });
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.equal(calls[1].text, "b");
});

test("17. identical text merged without a coalesceKey; different text / different model are not", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  const m1 = { providerID: "p", modelID: "m" };
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "done" }), { delivered: false, queued: true });
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "done" }), { delivered: false, queued: true, coalesced: true });
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "other" }), { delivered: false, queued: true });
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "done", model: m1 }), { delivered: false, queued: true });
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "done", model: { ...m1, variant: "high" } }), { delivered: false, queued: true });
  assert.deepEqual(await engine.deliver({ sessionId: "s1", text: "done", model: { ...m1 } }), { delivered: false, queued: true, coalesced: true });
  for (let i = 0; i < 5; i++) {
    boundary(engine, "s1");
    await tick();
    engine.observeEvent(status("s1", "busy"));
  }
  // Exactly the 4 distinct items were queued; the 5th boundary sent nothing.
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.text), ["done", "other", "done", "done"]);
});

test("18. one send per turn boundary; stale session.idle after the send does not release the next", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  for (const t of ["one", "two", "three"]) await engine.deliver({ sessionId: "s1", text: t });
  // status idle + session.idle together (and a session.error) → exactly one send.
  boundary(engine, "s1");
  engine.observeEvent({ type: "session.error", properties: { sessionID: "s1" } });
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one"]);
  // The previous turn's late idle arrives after the send: ignored.
  engine.observeEvent(idleEvt("s1"));
  engine.observeEvent(status("s1", "idle"));
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one"]);
  // busy (turn started) then idle → releases the second.
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one", "two"]);
  engine.observeEvent(idleEvt("s1")); // stale again
  await tick();
  assert.equal(calls.length, 2);
  engine.observeEvent(status("s1", "retry"));
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one", "two", "three"]);
});

test("19. awaiting-start timeout: no busy ever arrives → next item goes out after the timeout", async () => {
  const time = makeFakeTime();
  const { engine, calls } = makeEngine({ now: time.now, timers: time.timers, startTimeoutMs: 60_000 });
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "one" });
  await engine.deliver({ sessionId: "s1", text: "two" });
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one"]);
  await time.elapse(59_000);
  assert.equal(calls.length, 1, "not before the timeout");
  await time.elapse(2_000);
  assert.deepEqual(calls.map((c) => c.text), ["one", "two"]);
  await time.elapse(120_000);
  assert.equal(engine.isBusy("s1"), false, "queue empty → released after the last timeout");
});

test("19b. a busy event cancels the start timeout", async () => {
  const { time, engine, calls } = await drainedOneOfTwo();
  engine.observeEvent(status("s1", "busy"));
  assert.equal(time.pendingTimeouts(), 0);
  await time.elapse(300_000);
  assert.equal(calls.length, 1, "turn is running; second waits for its idle");
});

test("20. a drained send that throws → the next item goes out without waiting for any event", async () => {
  const { engine, calls } = makeEngine({ rejectTexts: new Set(["bad1", "bad2"]) });
  engine.observeEvent(status("s1", "busy"));
  for (const t of ["bad1", "bad2", "good"]) await engine.deliver({ sessionId: "s1", text: t });
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["bad1", "bad2", "good"]);
});

test("21. a delivery arriving while a drained item is awaiting start is queued, not sent", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "one" });
  boundary(engine, "s1");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(engine.isBusy("s1"), true);
  const res = await engine.deliver({ sessionId: "s1", text: "late" });
  assert.deepEqual(res, { delivered: false, queued: true });
  assert.equal(calls.length, 1);
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one", "late"]);
});

function makeStaleEngine(getSessionStatus) {
  const time = makeFakeTime();
  const made = makeEngine({
    now: time.now,
    timers: time.timers,
    getSessionStatus,
    staleAfterMs: 600_000,
  });
  return { ...made, time };
}

test("22. stale sweep: silent busy session that opencode reports idle → drains", async () => {
  const asked = [];
  const { engine, calls, time } = makeStaleEngine(async (sid) => { asked.push(sid); return "idle"; });
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "waiting" });
  time.advance(601_000);
  await engine.sweepStale();
  await tick();
  assert.deepEqual(asked, ["s1"]);
  assert.deepEqual(calls.map((c) => c.text), ["waiting"]);
});

test("22b. stale sweep: opencode says busy or retry → untouched", async () => {
  for (const answer of ["busy", "retry"]) {
    const { engine, calls, time } = makeStaleEngine(async () => answer);
    await sweepSilentBusy(engine, time);
    assert.equal(calls.length, 0);
    assert.equal(engine.isBusy("s1"), true);
  }
});

test("22c. stale sweep: status check rejects → untouched, retried on the next sweep", async () => {
  let mode = "throw";
  const { engine, calls, time } = makeStaleEngine(async () => {
    if (mode === "throw") throw new Error("opencode down");
    return "idle";
  });
  await sweepSilentBusy(engine, time);
  assert.equal(calls.length, 0);
  assert.equal(engine.isBusy("s1"), true);
  mode = "ok";
  await engine.sweepStale();
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["waiting"]);
});

test("22d. stale sweep: a recent event (any type) keeps the session from being checked", async () => {
  let asked = 0;
  const { engine, calls, time } = makeStaleEngine(async () => { asked++; return "idle"; });
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "waiting" });
  time.advance(601_000);
  engine.observeEvent({ type: "message.part.updated", properties: { sessionID: "s1" } });
  time.advance(60_000);
  await engine.sweepStale();
  await tick();
  assert.equal(asked, 0);
  assert.equal(calls.length, 0);
});

test("22e. stale sweep with an empty queue still releases the busy mark", async () => {
  const { engine, time } = makeStaleEngine(async () => "idle");
  engine.observeEvent(status("s1", "busy"));
  time.advance(601_000);
  await engine.sweepStale();
  assert.equal(engine.isBusy("s1"), false);
  assert.equal(engine.anyBusy(), false);
});

test("23. no getSessionStatus injected → sweep is a no-op and nothing throws", async () => {
  const time = makeFakeTime();
  const { engine, calls } = makeEngine({ now: time.now, timers: time.timers });
  engine.observeEvent(status("s1", "busy"));
  await engine.deliver({ sessionId: "s1", text: "waiting" });
  time.advance(10_000_000);
  await engine.sweepStale();
  const sweep = engine.startStaleSweep();
  assert.equal(time.intervalCount(), 1);
  sweep.stop();
  assert.equal(time.intervalCount(), 0);
  assert.equal(engine.isBusy("s1"), true);
  assert.equal(calls.length, 0);
});

test("24. the factory starts no timers (only startStaleSweep does)", () => {
  const time = makeFakeTime();
  makeEngine({ now: time.now, timers: time.timers });
  assert.equal(time.intervalCount(), 0);
  assert.equal(time.pendingTimeouts(), 0);
});

test("25. F2: two idle-path delivers without awaiting → one send, second queued; sent after the turn boundary", async () => {
  const { engine, calls } = makeEngine();
  const p1 = engine.deliver({ sessionId: "s1", text: "one" });
  const p2 = engine.deliver({ sessionId: "s1", text: "two" });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(calls.map((c) => c.text), ["one"]);
  assert.deepEqual(r1, { delivered: true, queued: false });
  assert.deepEqual(r2, { delivered: false, queued: true });
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.deepEqual(calls.map((c) => c.text), ["one", "two"]);
});

test("25b. F2: two identical idle-path delivers → one send, second coalesced", async () => {
  const { engine, calls } = makeEngine();
  const [r1, r2] = await Promise.all([
    engine.deliver({ sessionId: "s1", text: "same" }),
    engine.deliver({ sessionId: "s1", text: "same" }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(r1, { delivered: true, queued: false });
  assert.deepEqual(r2, { delivered: false, queued: true, coalesced: true });
  engine.observeEvent(status("s1", "busy"));
  boundary(engine, "s1");
  await tick();
  assert.equal(calls.length, 1, "nothing left to send");
});

test("25c. F2: idle-path send failure reports delivered:false, queued:false and never rejects", async () => {
  const { engine, calls } = makeEngine({ rejectTexts: new Set(["boom"]) });
  const r = await engine.deliver({ sessionId: "s1", text: "boom" });
  assert.deepEqual(r, { delivered: false, queued: false });
  assert.equal(calls.length, 1);
  assert.equal(engine.isBusy("s1"), false);
});

test("26. F3: session.deleted clears busy, queue, awaiting-start and its timer", async () => {
  for (const shape of [
    { sessionID: "s1" },
    { info: { id: "s1" } },
    { info: { sessionID: "s1" } },
  ]) {
    // "one" sent → awaiting start, timer armed, "two" queued
    const { time, engine, calls } = await drainedOneOfTwo();
    assert.equal(calls.length, 1);
    assert.equal(time.pendingTimeouts(), 1);
    engine.observeEvent({ type: "session.deleted", properties: shape });
    assert.equal(engine.isBusy("s1"), false);
    assert.equal(engine.anyBusy(), false);
    assert.equal(time.pendingTimeouts(), 0);
    boundary(engine, "s1");
    await tick();
    assert.equal(calls.length, 1, "queued item was dropped with the session");
  }
});
