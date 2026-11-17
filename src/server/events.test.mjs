import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBus, attachEventsWs, handleEventsRequest, createEventFilter, parseKindsParam, applyControlMessage, HEAVY_STREAM_SUBS } from "./events.mjs";

test("bus delivers published events to subscribers and stops after unsubscribe", () => {
  const bus = createBus();
  const got = [];
  const off = bus.subscribe((e) => got.push(e));
  bus.publish({ kind: "opencode", payload: { type: "x" } });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "opencode");
  off();
  bus.publish({ kind: "opencode", payload: { type: "y" } });
  assert.equal(got.length, 1);
});

test("bus replays the registered snapshot to a new subscriber (state recovery on connect)", () => {
  const bus = createBus();
  bus.setSnapshot(() => [
    { kind: "stream", sub: "running", sessionId: "ses_1", payload: { running: true, since: 1234 } },
  ]);
  const got = [];
  const off = bus.subscribe((e) => got.push(e));
  assert.equal(got.length, 1, "snapshot events reach the new subscriber immediately");
  assert.equal(got[0].sub, "running");
  assert.equal(got[0].payload.since, 1234);
  // A second subscriber gets its own replay.
  const got2 = [];
  bus.subscribe((e) => got2.push(e));
  assert.equal(got2.length, 1);
  // Live events still flow after the snapshot replay.
  bus.publish({ kind: "stream", sub: "flush", sessionId: "ses_1", payload: {} });
  assert.equal(got.filter((e) => e.sub === "flush").length, 1);
  off();
});

test("bus replays only the snapshot registered at subscribe time", () => {
  const bus = createBus();
  // No snapshot set yet -> new subscriber gets nothing replayed.
  const got = [];
  bus.subscribe((e) => got.push(e));
  assert.equal(got.length, 0);
  bus.setSnapshot(() => [
    { kind: "stream", sub: "running", sessionId: "ses_1", payload: { running: true, since: 99 } },
  ]);
  const got2 = [];
  bus.subscribe((e) => got2.push(e));
  assert.equal(got2.length, 1, "subsequent subscriber replays the now-registered snapshot");
});

// ---------------------------------------------------------------------------
// attachEventsWs heartbeat (BET-115 fix A, server side)
//
// The WS protocol ping() alone is invisible to browser JS — it's answered by
// the network stack, not the page. attachEventsWs must ALSO send an
// app-level `{kind:"heartbeat"}` text frame on its 15s interval so the
// renderer's liveness watchdog can see frames are still arriving.
// ---------------------------------------------------------------------------

/** Minimal fake ws satisfying the members attachEventsWs touches:
 *  readyState, ping(), send(), on("close"/"error"). */
function fakeWs() {
  const emitter = new EventEmitter();
  return {
    readyState: 1, // OPEN
    sent: [],
    pinged: 0,
    ping() { this.pinged += 1; },
    send(data) { this.sent.push(data); },
    on(event, fn) { emitter.on(event, fn); },
    _emit(event, ...args) { emitter.emit(event, ...args); },
  };
}

test("attachEventsWs sends a {kind:heartbeat} frame on the 15s ping interval", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const bus = createBus();
    const ws = fakeWs();
    attachEventsWs(bus, ws);

    assert.equal(ws.sent.length, 0, "no heartbeat before the interval fires");

    mock.timers.tick(15000);
    assert.equal(ws.sent.length, 1);
    const frame = JSON.parse(ws.sent[0]);
    assert.equal(frame.kind, "heartbeat");
    assert.equal(typeof frame.ts, "number");
    assert.equal(ws.pinged, 1, "protocol ping still fires alongside the app frame");

    mock.timers.tick(15000);
    assert.equal(ws.sent.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("attachEventsWs stops sending heartbeats after the socket closes", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const bus = createBus();
    const ws = fakeWs();
    attachEventsWs(bus, ws);
    ws._emit("close");
    mock.timers.tick(30000);
    assert.equal(ws.sent.length, 0, "interval was cleared on close");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Subscription filter (iOS stability spec, C1)
// ---------------------------------------------------------------------------

const stream = (sub, sessionId) => ({ kind: "stream", sub, ...(sessionId !== undefined ? { sessionId } : {}), payload: {} });

test("filter: no kinds and no focus delivers everything (desktop unchanged)", () => {
  const f = createEventFilter();
  for (const evt of [stream("flush", "a"), { kind: "pty", payload: {} }, { kind: "status", payload: [] }, { kind: "heartbeat" }]) {
    assert.equal(f.accepts(evt), true);
  }
});

test("filter: kinds limits envelopes, heartbeat always passes, unknown kinds are inert", () => {
  const f = createEventFilter({ kinds: ["stream", "runningSet", "nonsense"] });
  assert.equal(f.accepts(stream("running", "a")), true);
  assert.equal(f.accepts({ kind: "runningSet", payload: {} }), true);
  assert.equal(f.accepts({ kind: "pty", payload: {} }), false);
  assert.equal(f.accepts({ kind: "opencode", payload: {} }), false);
  assert.equal(f.accepts({ kind: "heartbeat" }), true);
});

test("filter: an empty, missing or oversized kinds list delivers everything", () => {
  const warned = [];
  assert.equal(createEventFilter({ kinds: [] }).accepts({ kind: "pty" }), true);
  assert.equal(createEventFilter({ kinds: parseKindsParam("") }).accepts({ kind: "pty" }), true);
  const many = Array.from({ length: 65 }, (_, i) => `k${i}`);
  const f = createEventFilter({ kinds: many, warn: (m) => warned.push(m) });
  assert.equal(f.accepts({ kind: "pty" }), true);
  assert.equal(warned.length, 1);
  const ok = createEventFilter({ kinds: many.slice(0, 64) });
  assert.equal(ok.accepts({ kind: "pty" }), false);
  assert.equal(ok.accepts({ kind: "k3" }), true);
  assert.deepEqual(parseKindsParam("a,b"), ["a", "b"]);
  assert.equal(parseKindsParam(null), null);
});

test("filter: heavy stream subs follow the focus set; every other sub always passes", () => {
  assert.deepEqual([...HEAVY_STREAM_SUBS].sort(), ["flush", "messageChanged", "toolOutput"]);
  const f = createEventFilter();
  // Before any focus message: heavy subs reach everyone (back-compat).
  assert.equal(f.accepts(stream("flush", "other")), true);
  f.setFocus(["a"]);
  for (const sub of HEAVY_STREAM_SUBS) {
    assert.equal(f.accepts(stream(sub, "a")), true, `${sub} focused`);
    assert.equal(f.accepts(stream(sub, "b")), false, `${sub} unfocused`);
  }
  for (const sub of ["running", "questions", "permissions", "attention", "turnComplete", "transcriptStale", "todos", "subagent", "windowStatus"]) {
    assert.equal(f.accepts(stream(sub, "b")), true, `${sub} always delivered`);
  }
  assert.equal(f.accepts(stream("flush")), true, "a stream envelope with no sessionId is always delivered");
  assert.equal(f.accepts({ kind: "opencode", payload: { sessionID: "b" } }), true, "focus only touches stream envelopes");
  f.setFocus([]);
  assert.equal(f.accepts(stream("flush", "a")), false, "an empty focus set = no heavy subs at all");
});

test("filter: focus is capped at 32 ids and ignores malformed input; the focus filter works without kinds and with them", () => {
  const f = createEventFilter({ kinds: ["stream"] });
  f.setFocus(Array.from({ length: 40 }, (_, i) => `s${i}`));
  assert.equal(f.accepts(stream("flush", "s31")), true);
  assert.equal(f.accepts(stream("flush", "s32")), false);
  f.setFocus("not-an-array");
  assert.equal(f.accepts(stream("flush", "s0")), true, "malformed focus leaves the previous set");
  f.setFocus([1, null, "x"]);
  assert.equal(f.accepts(stream("flush", "x")), true);
  assert.equal(f.accepts(stream("flush", "s0")), false);
});

test("applyControlMessage: kinds and focus messages apply; garbage is ignored", () => {
  const f = createEventFilter();
  applyControlMessage(f, JSON.stringify({ type: "kinds", kinds: ["stream"] }));
  assert.equal(f.accepts({ kind: "pty" }), false);
  applyControlMessage(f, Buffer.from(JSON.stringify({ type: "kinds", kinds: ["stream", "pty"] })));
  assert.equal(f.accepts({ kind: "pty" }), true);
  applyControlMessage(f, JSON.stringify({ type: "kinds" }));
  assert.equal(f.accepts({ kind: "anything" }), true, "a missing list = deliver all");
  applyControlMessage(f, JSON.stringify({ type: "focus", sessions: ["a"] }));
  assert.equal(f.accepts(stream("flush", "b")), false);
  for (const junk of ["not json", "null", "[]", '{"type":"nope"}', "", undefined, "x".repeat(70_000)]) applyControlMessage(f, junk);
  assert.equal(f.accepts(stream("flush", "a")), true);
  assert.equal(f.accepts(stream("flush", "b")), false);
});

test("attachEventsWs: ?kinds filter, snapshot replay filtered, runtime kinds + focus messages, heartbeat never filtered", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const bus = createBus();
    bus.setSnapshot(() => [{ kind: "runningSet", payload: { sessions: [] } }, { kind: "pty", payload: "snap" }]);
    const ws = fakeWs();
    attachEventsWs(bus, ws, { kinds: ["runningSet", "stream"] });
    assert.deepEqual(ws.sent.map((s) => JSON.parse(s).kind), ["runningSet"], "snapshot is filtered like live frames");
    bus.publish({ kind: "pty", payload: "x" });
    bus.publish(stream("flush", "a"));
    assert.equal(ws.sent.length, 2);
    ws._emit("message", JSON.stringify({ type: "focus", sessions: ["b"] }));
    bus.publish(stream("flush", "a"));
    bus.publish(stream("flush", "b"));
    bus.publish(stream("running", "a"));
    assert.deepEqual(ws.sent.slice(2).map((s) => JSON.parse(s).sessionId + ":" + JSON.parse(s).sub), ["b:flush", "a:running"]);
    ws._emit("message", JSON.stringify({ type: "kinds", kinds: ["stream", "pty"] }));
    bus.publish({ kind: "pty", payload: "y" });
    assert.equal(JSON.parse(ws.sent.at(-1)).payload, "y");
    mock.timers.tick(15000);
    assert.equal(JSON.parse(ws.sent.at(-1)).kind, "heartbeat");
    ws._emit("message", "garbage");
    bus.publish(stream("running", "z"));
    assert.equal(JSON.parse(ws.sent.at(-1)).sessionId, "z", "a malformed message never breaks the socket");
  } finally {
    mock.timers.reset();
  }
});

test("attachEventsWs without any filter input delivers everything, snapshot included", () => {
  const bus = createBus();
  bus.setSnapshot(() => [{ kind: "pty", payload: "snap" }]);
  const ws = fakeWs();
  attachEventsWs(bus, ws);
  bus.publish(stream("flush", "a"));
  bus.publish({ kind: "status", payload: [] });
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).kind), ["pty", "stream", "status"]);
});

test("attachEventsWs: focusing a session replays its in-flight text to that connection only, before later flushes", () => {
  const open = { a: [{ messageID: "m1", partID: "m1:text:0", field: "text", text: "Hel" }, { messageID: "m1", partID: "m1:reasoning:0", field: "reasoning", text: "hm" }], b: [{ messageID: "m2", partID: "m2:text:0", field: "text", text: "x" }] };
  const asked = [];
  const inFlightText = (sid) => { asked.push(sid); return open[sid] ?? []; };
  const bus = createBus();
  const ws = fakeWs();
  const other = fakeWs();
  attachEventsWs(bus, ws, { inFlightText });
  attachEventsWs(bus, other, { inFlightText });

  ws._emit("message", JSON.stringify({ type: "focus", sessions: ["a", "none"] }));
  const frames = ws.sent.map((s) => JSON.parse(s));
  assert.deepEqual(frames, [
    { kind: "stream", sub: "flush", sessionId: "a", payload: { messageID: "m1", partID: "m1:text:0", field: "text", text: "Hel", replay: true } },
    { kind: "stream", sub: "flush", sessionId: "a", payload: { messageID: "m1", partID: "m1:reasoning:0", field: "reasoning", text: "hm", replay: true } },
  ], "one replay frame per open part, nothing for a session with no in-flight text");
  assert.equal(other.sent.length, 0, "other connections are unaffected");

  bus.publish({ kind: "stream", sub: "flush", sessionId: "a", payload: { partID: "m1:text:0", text: "lo" } });
  assert.equal(JSON.parse(ws.sent.at(-1)).payload.text, "lo", "live frames come after the replay");

  ws.sent.length = 0;
  asked.length = 0;
  ws._emit("message", JSON.stringify({ type: "focus", sessions: ["a", "b"] }));
  assert.deepEqual(asked, ["b"], "an already-focused id is not replayed again");
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).sessionId), ["b"]);
});

test("attachEventsWs: no focus message or no reader means no replay; a reader that throws is tolerated", () => {
  const bus = createBus();
  const withReader = fakeWs();
  attachEventsWs(bus, withReader, { inFlightText: () => [{ messageID: "m", partID: "m:text:0", field: "text", text: "t" }] });
  bus.publish(stream("running", "a"));
  assert.deepEqual(withReader.sent.map((s) => JSON.parse(s).sub), ["running"], "connecting alone replays nothing");

  const noReader = fakeWs();
  attachEventsWs(bus, noReader);
  noReader._emit("message", JSON.stringify({ type: "focus", sessions: ["a"] }));
  assert.equal(noReader.sent.length, 0);

  const throwing = fakeWs();
  attachEventsWs(bus, throwing, { inFlightText: () => { throw new Error("boom"); } });
  throwing._emit("message", JSON.stringify({ type: "focus", sessions: ["a"] }));
  assert.equal(throwing.sent.length, 0);

  const noStream = fakeWs();
  attachEventsWs(bus, noStream, { kinds: ["pty"], inFlightText: () => [{ messageID: "m", partID: "m:text:0", field: "text", text: "t" }] });
  noStream._emit("message", JSON.stringify({ type: "focus", sessions: ["a"] }));
  assert.equal(noStream.sent.length, 0, "a connection that excluded `stream` gets no replay");
});

test("handleEventsRequest: ?kinds narrows the SSE stream; no param delivers everything", () => {
  const run = (url) => {
    const bus = createBus();
    const written = [];
    const req = new EventEmitter();
    req.url = url;
    const res = { writeHead() {}, write: (s) => written.push(s), flushHeaders() {} };
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      handleEventsRequest(bus, req, res);
      bus.publish({ kind: "pty", payload: 1 });
      bus.publish({ kind: "status", payload: 2 });
      req.emit("close");
    } finally {
      mock.timers.reset();
    }
    return written.filter((w) => w.startsWith("data:")).map((w) => JSON.parse(w.slice(5)).kind);
  };
  assert.deepEqual(run("/events"), ["pty", "status"]);
  assert.deepEqual(run("/events?kinds=status"), ["status"]);
});
