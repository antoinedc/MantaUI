// src/server/ctoSegments.test.mjs — BET-1380 work segmentation (§5.1), segment
// summaries (§5.2), turn completion, and the G refit. Pure logic only —
// injected stores/seams/now, no live tmux/opencode/network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_G_MINUTES,
  G_MIN,
  G_MAX,
  MINUTE_MS,
  segmentEventKind,
  isIdleEvent,
  isBusyEvent,
  isAbortEvent,
  isTurnCompletion,
  userPromptText,
  truncatePrompt,
  validOneLiner,
  parseSegmentSummaryText,
  validateSegmentSummary,
  degradedSegmentSummary,
  refitG,
  emGaussianMixture,
  createSegmenter,
} from "./ctoSegments.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const idle = (sid = "s1") => ({ type: "session.idle", properties: { sessionID: sid } });
const status = (s, sid = "s1") => ({
  type: "session.status",
  properties: { sessionID: sid, status: { type: s } },
});
const busy = (sid = "s1") => status("busy", sid);
const prompt = (text = "do the thing", sid = "s1") => ({
  type: "user.message.created",
  properties: { sessionID: sid, message: { role: "user", text } },
});
const abort = (sid = "s1") => ({
  type: "session.error",
  properties: { sessionID: sid, error: { name: "MessageAbortedError" } },
});
const otherError = (sid = "s1") => ({
  type: "session.error",
  properties: { sessionID: sid, error: { name: "SomeOtherError" } },
});
const noise = (sid = "s1") => ({
  type: "message.part.delta",
  properties: { sessionID: sid },
});

function fakeStores() {
  const segments = new Map();
  const ledger = [];
  return {
    segmentsStore: {
      name: "segments",
      pathFor: (id) => id,
      async load(id) {
        return segments.get(id) ?? { v: 1 };
      },
      async save(id, data) {
        segments.set(id, data);
      },
      peek() {
        return segments;
      },
    },
    ledgerStore: {
      async append(row) {
        ledger.push(row);
      },
      peek() {
        return ledger;
      },
    },
    engineState: {
      payload: {},
      async load() {
        return this.payload;
      },
      async save(p) {
        this.payload = p;
      },
      peek() {
        return this.payload;
      },
    },
  };
}

function validSummary(over = {}) {
  return {
    v: 1,
    sessionID: "s1",
    project: "p1",
    window: [1000, 2000],
    intent: "fixed login",
    outcome: "done",
    key_events: [{ t: 1000, text: "submitted prompt", refs: ["s1"] }],
    files_touched: ["src/login.ts"],
    prs: [],
    importance: 5,
    one_liner: "Fixed the login redirect",
    ...over,
  };
}

// A controllable clock + segmenter wired to fake stores.
function makeSeg({ g = DEFAULT_G_MINUTES, summarize, computeOneLiner, stores = fakeStores() } = {}) {
  let t = 0;
  const now = () => t;
  const seg = createSegmenter({
    segments: stores.segmentsStore,
    ledger: stores.ledgerStore,
    engineState: stores.engineState,
    summarize: summarize ?? (async () => ({ ok: false, gated: false })),
    computeOneLiner: computeOneLiner ?? (async () => null),
    now,
    initialGMinutes: g,
  });
  return {
    seg,
    stores,
    set(tv) {
      t = tv;
    },
    now: () => t,
  };
}

async function flushClose(seg, sid = "s1") {
  const st = seg._sessions.get(sid);
  if (st?.closeChain) await st.closeChain;
}
async function flushTurns(seg, sid = "s1") {
  const st = seg._sessions.get(sid);
  if (st?.turnChain) await st.turnChain;
}

// ---------------------------------------------------------------------------
// Event interpretation
// ---------------------------------------------------------------------------

test("segmentEventKind classifies busy/idle/abort/prompt/touch and drops noise", () => {
  assert.equal(segmentEventKind(busy()), "busy");
  assert.equal(segmentEventKind(idle()), "idle");
  assert.equal(segmentEventKind(status("idle")), "idle");
  assert.equal(segmentEventKind(abort()), "abort");
  assert.equal(segmentEventKind(otherError()), "touch");
  assert.equal(segmentEventKind(prompt()), "prompt");
  assert.equal(segmentEventKind({ type: "session.created", properties: {} }), "touch");
  assert.equal(segmentEventKind(noise()), null);
  assert.equal(segmentEventKind(null), null);
  assert.equal(segmentEventKind({ type: "message.part.updated", properties: { message: { role: "assistant" } } }), null);
});

test("isIdleEvent / isBusyEvent / isAbortEvent accept both shapes", () => {
  assert.ok(isIdleEvent(idle()));
  assert.ok(isIdleEvent(status("idle")));
  assert.ok(!isIdleEvent(status("busy")));
  assert.ok(isBusyEvent(busy()));
  assert.ok(isBusyEvent(status("retry")));
  assert.ok(!isBusyEvent(idle()));
  assert.ok(isAbortEvent(abort()));
  assert.ok(!isAbortEvent(otherError()));
  assert.ok(!isAbortEvent(idle()));
});

test("userPromptText extracts the prompt body best-effort", () => {
  assert.equal(userPromptText(prompt("hello")), "hello");
  assert.equal(userPromptText({ type: "user.message.created", properties: { info: { message: { text: "from info" } } } }), "from info");
  assert.equal(userPromptText({ type: "user.message.created", properties: {} }), "");
});

// ---------------------------------------------------------------------------
// Turn completion (§5.1-c)
// ---------------------------------------------------------------------------

test("turn completion: idle after a seen busy (and a prompt touch)", () => {
  const h = makeSeg();
  h.set(0);
  h.seg.observe(busy("a"), { sessionID: "a", project: "p", ts: h.now() });
  const st = h.seg._sessions.get("a");
  assert.ok(isTurnCompletion(idle("a"), st));
  st.sawBusy = false;
  assert.ok(!isTurnCompletion(idle("a"), st));
});

test("turn completion: idle without busy is NOT a completion", () => {
  const h = makeSeg();
  const st = { sawBusy: false, abort: false };
  assert.ok(!isTurnCompletion(idle(), st));
  assert.ok(!isTurnCompletion(status("idle"), { sawBusy: false }));
});

test("turn completion: an idle caused by MessageAbortedError is NOT a completion", () => {
  const st = { sawBusy: true, abort: true };
  assert.ok(!isTurnCompletion(idle(), st));
  // a non-idle event is never a completion even with busy
  assert.ok(!isTurnCompletion(prompt(), { sawBusy: true, abort: false }));
});

test("user abort (queued-drain) never caches a one-liner or flags a completion", async () => {
  const calls = [];
  const h = makeSeg({ computeOneLiner: async () => { calls.push(1); return "nope"; } });
  h.set(0);
  h.seg.observe(busy(), { sessionID: "s1", project: "p", ts: h.now() }); // busy
  h.set(1000);
  h.seg.observe(abort(), { sessionID: "s1", ts: h.now() }); // abort
  h.set(2000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() }); // idle after abort
  await flushTurns(h.seg);
  assert.equal(calls.length, 0, "abort idle must not run a one-liner compute");
  assert.equal(h.seg.getOneLiner("s1"), null);
});

// ---------------------------------------------------------------------------
// Segmentation: gap close, idle close (§5.1-a,b)
// ---------------------------------------------------------------------------

test("events closer than G stay in one segment; idle closes it", async () => {
  const calls = [];
  const h = makeSeg({
    g: 1, // G = 1 minute
    summarize: async (data) => { calls.push(data); return { ok: true, summary: validSummary({ window: data.start ? [0, 0] : [0, 0] }) }; },
  });
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", project: "p", ts: h.now() });
  h.set(30_000);
  h.seg.observe(prompt("b"), { sessionID: "s1", ts: h.now() }); // within G
  h.set(60_000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() }); // idle closes
  await flushClose(h.seg);
  assert.equal(h.stores.segmentsStore.peek().size, 1, "one segment persisted");
  const file = [...h.stores.segmentsStore.peek().values()][0];
  assert.equal(file.summary.outcome, "done");
  assert.equal(file.ts, 60_000);
  assert.deepEqual(file.window, [0, 60_000]);
  assert.equal(calls.length, 1, "one summarize call on close");
});

test("an inter-event gap exceeding G closes the segment and opens a new one", async () => {
  const h = makeSeg({
    g: 1, // G = 60000 ms
    summarize: async () => ({ ok: true, summary: validSummary() }),
  });
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", project: "p", ts: h.now() });
  h.set(30_000);
  h.seg.observe(prompt("b"), { sessionID: "s1", ts: h.now() }); // gap 30s < G
  h.set(200_000);
  h.seg.observe(prompt("c"), { sessionID: "s1", ts: h.now() }); // gap 170s > G → closes seg1, opens seg2
  h.set(250_000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() }); // idle closes seg2
  await flushClose(h.seg);
  const files = [...h.stores.segmentsStore.peek().values()];
  assert.equal(files.length, 2, "two segments");
  const segs = files.map((f) => f.window).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(segs[0], [0, 30_000], "seg1 ends at last activity before the gap");
  assert.deepEqual(segs[1], [200_000, 250_000], "seg2 opens at the gap-triggering event");
});

test("idle leaves the session windowed; the next activity starts a fresh segment", async () => {
  const h = makeSeg({
    g: 10,
    summarize: async () => ({ ok: true, summary: validSummary() }),
  });
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", project: "p", ts: h.now() });
  h.set(1000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() }); // closes seg1
  await flushClose(h.seg);
  h.set(5000);
  // next activity (well within G of nothing open) opens a fresh segment
  h.seg.observe(prompt("b"), { sessionID: "s1", ts: h.now() });
  h.set(6000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() });
  await flushClose(h.seg);
  const files = [...h.stores.segmentsStore.peek().values()].map((f) => f.window).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(files, [[0, 1000], [5000, 6000]]);
});

test("the deltas that flooded during a turn are noise and do not extend the segment", () => {
  const h = makeSeg({ g: 1 });
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", ts: h.now() });
  h.set(1000);
  h.seg.observe(noise(), { sessionID: "s1", ts: h.now() }); // deltas ignored
  h.set(2000);
  h.seg.observe(noise(), { sessionID: "s1", ts: h.now() });
  const st = h.seg._sessions.get("s1");
  assert.equal(st.segment.events.length, 1, "only the prompt is a segment event");
  assert.equal(st.segment.lastTs, 0, "lastTs unchanged by noise");
});

// ---------------------------------------------------------------------------
// One-liner: computed at turn completion, cached, reused at close (§5.2)
// ---------------------------------------------------------------------------

test("one-liner computed at turn completion is cached and reused at segment close", async () => {
  const oneLinerSeen = [];
  const summarizeData = [];
  const h = makeSeg({
    computeOneLiner: async () => { oneLinerSeen.push(1); return "Fixed the login redirect"; },
    summarize: async (data) => {
      summarizeData.push(data);
      return { ok: true, summary: validSummary({ one_liner: "model would say something else" }) };
    },
  });
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", project: "p", ts: h.now() });
  h.set(1000);
  h.seg.observe(busy(), { sessionID: "s1", ts: h.now() });
  h.set(2000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() }); // turn completion → one-liner
  await flushTurns(h.seg);
  await flushClose(h.seg);
  assert.equal(oneLinerSeen.length, 1, "one-liner computed exactly once, at turn completion");
  assert.equal(h.seg.getOneLiner("s1"), "Fixed the login redirect", "cached");
  assert.equal(summarizeData[0].oneLiner, "Fixed the login redirect", "close feeds the cached one-liner");
  const file = [...h.stores.segmentsStore.peek().values()][0];
  assert.equal(file.summary.one_liner, "Fixed the login redirect", "persisted summary reuses the cache, not a recompute");
});

test("a failed/absent one-liner degrades to the truncated last user prompt", async () => {
  const h = makeSeg({ computeOneLiner: async () => null });
  h.set(0);
  h.seg.observe(prompt("do the thing now"), { sessionID: "s1", ts: h.now() });
  h.set(1000);
  h.seg.observe(busy(), { sessionID: "s1", ts: h.now() });
  h.set(2000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() });
  await flushTurns(h.seg);
  assert.equal(h.seg.getOneLiner("s1"), "do the thing now", "fallback is the truncated prompt");
});

// ---------------------------------------------------------------------------
// Summary failure handling (§5.2)
// ---------------------------------------------------------------------------

test("a non-gated validation failure persists a degraded summary and records the failure", async () => {
  const h = makeSeg({ summarize: async () => ({ ok: false, gated: false }) });
  h.set(0);
  h.seg.observe(prompt("fix the bug please"), { sessionID: "s1", project: "p", ts: h.now() });
  h.set(1000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() });
  await flushClose(h.seg);
  const file = [...h.stores.segmentsStore.peek().values()][0];
  assert.equal(file.summary.outcome, "in-progress");
  assert.equal(file.summary.one_liner, "fix the bug please");
  assert.ok(
    h.stores.ledgerStore.peek().some((r) => r.kind === "cto.segment_summary_failed"),
    "failure recorded in the ledger",
  );
});

test("a gated summary (disabled/paused) degrades without recording a failure", async () => {
  const h = makeSeg({ summarize: async () => ({ ok: false, gated: true }) });
  h.set(0);
  h.seg.observe(prompt("work"), { sessionID: "s1", ts: h.now() });
  h.set(1000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() });
  await flushClose(h.seg);
  const file = [...h.stores.segmentsStore.peek().values()][0];
  assert.equal(file.summary.outcome, "in-progress");
  assert.ok(
    !h.stores.ledgerStore.peek().some((r) => r.kind === "cto.segment_summary_failed"),
    "gating is expected, not a failure",
  );
});

// ---------------------------------------------------------------------------
// Schema validation (§5.2)
// ---------------------------------------------------------------------------

test("validateSegmentSummary accepts a well-formed summary and rejects bad ones", () => {
  assert.ok(validateSegmentSummary(validSummary()));
  assert.ok(!validateSegmentSummary(validSummary({ outcome: "nope" })));
  assert.ok(!validateSegmentSummary(validSummary({ v: 2 })));
  assert.ok(!validateSegmentSummary(validSummary({ importance: 11 })));
  assert.ok(!validateSegmentSummary(validSummary({ one_liner: "x".repeat(141) })));
  assert.ok(!validateSegmentSummary(validSummary({ window: [2000, 1000] })));
  assert.ok(!validateSegmentSummary(validSummary({ key_events: [{ t: 1, text: "a" }, { t: 2 }, { t: 3 }, { t: 4 }, { t: 5 }, { t: 6 }] })));
  assert.ok(!validateSegmentSummary(null));
});

test("parseSegmentSummaryText extracts JSON from fenced/prose model output", () => {
  const obj = parseSegmentSummaryText('Here you go:\n```json\n{"v":1,"sessionID":"s1"}\n```');
  assert.equal(obj.sessionID, "s1");
  assert.equal(parseSegmentSummaryText("no json here"), null);
  assert.equal(parseSegmentSummaryText('{"broken"'), null);
  assert.equal(parseSegmentSummaryText(null), null);
});

test("validOneLiner enforces the <=140 char bound and non-emptiness", () => {
  assert.equal(validOneLiner("short"), "short");
  assert.equal(validOneLiner("x".repeat(140)), "x".repeat(140));
  assert.equal(validOneLiner("x".repeat(141)), null);
  assert.equal(validOneLiner("   "), null);
  assert.equal(validOneLiner(null), null);
});

test("degradedSegmentSummary carries outcome in-progress and a truncated one-liner", () => {
  const d = degradedSegmentSummary({ start: 0, end: 1000, lastUserPrompt: "y".repeat(200) });
  assert.equal(d.outcome, "in-progress");
  assert.equal(d.one_liner.length, 140);
  assert.deepEqual(d.window, [0, 1000]);
});

// ---------------------------------------------------------------------------
// G refit math (§5.1-d)
// ---------------------------------------------------------------------------

let rngSeed = 987654321;
function rng() {
  rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
  return rngSeed / 4294967296;
}
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function cluster(logMean, logSd, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(logMean + gauss() * logSd);
  return out;
}

test("refitG finds the valley between two inter-arrival clusters, within [20,90] min", () => {
  const mid = (Math.log(30 * MINUTE_MS) + Math.log(60 * MINUTE_MS)) / 2; // ~42.6 min in log-ms
  const logs = [...cluster(Math.log(30 * MINUTE_MS), 0.05, 150), ...cluster(Math.log(60 * MINUTE_MS), 0.05, 150)];
  const out = refitG(logs, { currentGMinutes: DEFAULT_G_MINUTES });
  assert.equal(out.reused, false);
  assert.ok(out.gMinutes >= G_MIN && out.gMinutes <= G_MAX, `gMinutes ${out.gMinutes} within clamp`);
  const expected = Math.exp(mid) / MINUTE_MS;
  assert.ok(Math.abs(out.gMinutes - expected) < 5, `gMinutes ${out.gMinutes} near expected ${expected}`);
});

test("refitG clamps to G_MIN when the natural valley is below 20 minutes", () => {
  const logs = [...cluster(Math.log(2 * MINUTE_MS), 0.05, 150), ...cluster(Math.log(5 * MINUTE_MS), 0.05, 150)];
  const out = refitG(logs);
  assert.equal(out.reused, false);
  assert.equal(out.gMinutes, G_MIN);
});

test("refitG clamps to G_MAX when the natural valley is above 90 minutes", () => {
  const logs = [...cluster(Math.log(200 * MINUTE_MS), 0.05, 150), ...cluster(Math.log(400 * MINUTE_MS), 0.05, 150)];
  const out = refitG(logs);
  assert.equal(out.reused, false);
  assert.equal(out.gMinutes, G_MAX);
});

test("refitG reuses the current G on degenerate / insufficient samples", () => {
  assert.equal(refitG([]).reused, true);
  assert.equal(refitG([Math.log(1000), Math.log(1001)]).reused, true); // < 8 samples
  // single cluster — no between-means valley
  const logs = Array.from({ length: 40 }, () => Math.log(60 * MINUTE_MS + (rng() * 2 - 1)));
  assert.equal(refitG(logs, { currentGMinutes: 60 }).reused, true);
  assert.equal(refitG(logs, { currentGMinutes: 60 }).gMinutes, 60);
});

// ---------------------------------------------------------------------------
// Monthly refit wiring + persistence
// ---------------------------------------------------------------------------

test("monthlyRefit fits on accumulated gaps, persists G, and resets the window", async () => {
  const stores = fakeStores();
  const h = makeSeg({ stores, g: DEFAULT_G_MINUTES });
  // Feed prompts whose inter-arrival gaps alternate between two rhythms so the
  // mixture fit has two distinct clusters (and persists a refit, not default).
  const start = 1_000_000;
  let t = start;
  for (let i = 1; i < 40; i++) {
    t = i % 2 === 0 ? t + 120_000 : t + 3_600_000; // 2-min vs 60-min gaps
    h.set(t);
    h.seg.observe(prompt(`p${i}`), { sessionID: "s1", ts: h.now() });
  }
  assert.ok(h.seg.gapSampleCount > 0, "gap samples collected");
  const out = await h.seg.monthlyRefit();
  assert.equal(out.reused, false, "a two-cluster fit is reusable");
  assert.ok(out.gMinutes >= G_MIN && out.gMinutes <= G_MAX);
  assert.equal(typeof stores.engineState.peek().segmentGMinutes, "number", "G persisted to engine-state");
  assert.equal(h.seg.gapSampleCount, 0, "sample window reset after refit");
});

test("boot loads a stored G from engine-state", async () => {
  const stores = fakeStores();
  stores.engineState.payload = { segmentGMinutes: 33 };
  const h = makeSeg({ stores });
  await h.seg.boot();
  assert.equal(h.seg.getGMinutes(), 33);
  // and a fresh boot without a stored value falls back to the default
  const stores2 = fakeStores();
  const h2 = makeSeg({ stores: stores2 });
  await h2.seg.boot();
  assert.equal(h2.seg.getGMinutes(), DEFAULT_G_MINUTES);
});

// ---------------------------------------------------------------------------
// Engine-exposure sanity
// ---------------------------------------------------------------------------

test("createSegmenter exposes diagnostics without leaking internals into the API surface", () => {
  const h = makeSeg();
  h.set(0);
  h.seg.observe(prompt("a"), { sessionID: "s1", ts: h.now() });
  assert.equal(h.seg.openSegmentCount, 1);
  h.set(1000);
  h.seg.observe(idle(), { sessionID: "s1", ts: h.now() });
  assert.equal(h.seg.openSegmentCount, 1); // session retained (closed) for bookkeeping
  assert.equal(typeof h.seg.monthlyRefit, "function");
  assert.equal(typeof h.seg.boot, "function");
});
