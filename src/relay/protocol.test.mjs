import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  FRAME_TYPES,
  encodeFrame,
  decodeFrame,
  PendingRequests,
  StreamRegistry,
  RoutingTable,
  createFakeTransport,
} from "./protocol.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_B = "fedcba9876543210fedcba9876543210";

// ---------------------------------------------------------------------------
// Framing — encode/decode round-trips + validation
// ---------------------------------------------------------------------------

test("encode/decode round-trips every frame type", () => {
  const samples = [
    { type: FRAME_TYPES.REQUEST, id: 1, method: "GET", path: "/x", boxId: BOX_A },
    { type: FRAME_TYPES.RESPONSE, id: 1, status: 200, body: "ok" },
    { type: FRAME_TYPES.STREAM_OPEN, id: 2, stream: "s1", method: "GET", path: "/sse" },
    { type: FRAME_TYPES.STREAM_DATA, id: 2, stream: "s1", data: "chunk" },
    { type: FRAME_TYPES.STREAM_END, id: 2, stream: "s1" },
    { type: FRAME_TYPES.STREAM_ABORT, id: 3, stream: "s2", reason: "cancel" },
    { type: FRAME_TYPES.ERROR, id: 4, code: 500, message: "boom" },
    { type: FRAME_TYPES.PING },
    { type: FRAME_TYPES.PONG, id: 7 },
  ];
  for (const s of samples) {
    const raw = encodeFrame(s);
    assert.equal(typeof raw, "string", `${s.type} encodes to a string`);
    const back = decodeFrame(raw);
    assert.notEqual(back, null, `${s.type} decodes`);
    assert.equal(back.v, PROTOCOL_VERSION);
    for (const [k, v] of Object.entries(s)) {
      assert.deepEqual(back[k], v, `${s.type}.${k} round-trips`);
    }
  }
});

test("decodeFrame accepts a Buffer / Uint8Array (binary WS frame)", () => {
  const raw = encodeFrame({ type: FRAME_TYPES.PING });
  assert.notEqual(decodeFrame(Buffer.from(raw, "utf8")), null);
  assert.notEqual(decodeFrame(new TextEncoder().encode(raw)), null);
});

test("decodeFrame rejects malformed input (returns null, never throws)", () => {
  for (const bad of [
    "",
    "not json",
    "{",
    "null",
    "42",
    "[]", // array, not object
    JSON.stringify([1, 2, 3]),
    JSON.stringify({ v: PROTOCOL_VERSION }), // no type
    JSON.stringify({ v: PROTOCOL_VERSION, type: "bogus", id: 1 }), // unknown type
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.REQUEST }), // missing id
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.REQUEST, id: 1, method: "GET" }), // no path
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.RESPONSE, id: 1 }), // no status
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s" }), // no data
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.STREAM_DATA, id: 1, data: "x" }), // no stream
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.REQUEST, id: -1, method: "G", path: "/" }), // bad id
    JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.REQUEST, id: 1, method: "G", path: "/", boxId: "nothex" }), // bad boxId
    null,
    undefined,
    {},
    12345,
  ]) {
    assert.equal(decodeFrame(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test("decodeFrame rejects unknown protocol versions", () => {
  const future = JSON.stringify({ v: PROTOCOL_VERSION + 1, type: FRAME_TYPES.PING });
  const past = JSON.stringify({ v: 0, type: FRAME_TYPES.PING });
  assert.equal(decodeFrame(future), null);
  assert.equal(decodeFrame(past), null);
});

test("oversized frames are rejected on encode (throw) and decode (null)", () => {
  const big = "x".repeat(MAX_FRAME_BYTES + 10);
  assert.throws(() => encodeFrame({ type: FRAME_TYPES.RESPONSE, id: 1, status: 200, body: big }));
  // Construct an oversized-but-valid-JSON raw string directly for decode.
  const rawBig = JSON.stringify({ v: PROTOCOL_VERSION, type: FRAME_TYPES.RESPONSE, id: 1, status: 200, body: big });
  assert.ok(Buffer.byteLength(rawBig, "utf8") > MAX_FRAME_BYTES);
  assert.equal(decodeFrame(rawBig), null);
  assert.equal(decodeFrame(Buffer.from(rawBig, "utf8")), null);
});

test("encodeFrame throws on structurally invalid frames", () => {
  assert.throws(() => encodeFrame(null));
  assert.throws(() => encodeFrame("x"));
  assert.throws(() => encodeFrame({ type: "nope", id: 1 }));
  assert.throws(() => encodeFrame({ type: FRAME_TYPES.REQUEST, id: 1 })); // no method/path
});

test("encodeFrame rejects STREAM_OPEN without method (request form) or status (response form)", () => {
  // Method required on the request form…
  assert.throws(
    () => encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: 1, stream: "s", path: "/x" }),
    /exactly one of method or status/,
  );
  // …and status required on the response form.
  assert.throws(
    () => encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: 2, stream: "s", headers: {} }),
    /exactly one of method or status/,
  );
  // Both present → also rejected.
  assert.throws(
    () =>
      encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: 3, stream: "s", method: "GET", status: 200 }),
    /exactly one of method or status/,
  );
  // Each form encodes cleanly.
  assert.ok(encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: 4, stream: "s", method: "GET", path: "/sse" }));
  assert.ok(encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: 5, stream: "s", status: 200, headers: { "content-type": "text/event-stream" } }));
});

test("decodeFrame drops STREAM_OPEN that violates exactly-one-of (BET-156)", () => {
  // Method + status (both) → wire error, decode returns null.
  // Build the raw string directly because encodeFrame refuses to emit it.
  const both = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: FRAME_TYPES.STREAM_OPEN,
    id: 1,
    stream: "s",
    method: "GET",
    status: 200,
  });
  assert.equal(decodeFrame(both), null);
  // Neither method nor status → wire error, decode returns null.
  const neither = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: FRAME_TYPES.STREAM_OPEN,
    id: 1,
    stream: "s",
  });
  assert.equal(decodeFrame(neither), null);
});

// ---------------------------------------------------------------------------
// PendingRequests — correlation
// ---------------------------------------------------------------------------

// A tiny controllable fake clock: timers fire only when we call advance().
function makeFakeClock() {
  let nowMs = 0;
  let seq = 1;
  const timers = new Map(); // handle -> { fn, at }
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const h = seq++;
      timers.set(h, { fn, at: nowMs + ms });
      return h;
    },
    clearTimer: (h) => timers.delete(h),
    advance: (ms) => {
      nowMs += ms;
      for (const [h, t] of [...timers.entries()]) {
        if (t.at <= nowMs) {
          timers.delete(h);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

test("PendingRequests resolves on matching response and assigns monotonic ids", async () => {
  const pr = new PendingRequests();
  const { id: id1, promise: p1 } = pr.create();
  const { id: id2, promise: p2 } = pr.create();
  assert.equal(id2, id1 + 1, "ids are monotonic");
  assert.equal(pr.size, 2);

  pr.resolve({ type: FRAME_TYPES.RESPONSE, id: id2, status: 200, body: "two" });
  const r2 = await p2;
  assert.equal(r2.body, "two");
  assert.equal(pr.size, 1);
  assert.equal(pr.has(id1), true);

  pr.resolve({ type: FRAME_TYPES.RESPONSE, id: id1, status: 200, body: "one" });
  assert.equal((await p1).body, "one");
  assert.equal(pr.size, 0);
});

test("PendingRequests.resolve returns false for unknown/late ids", () => {
  const pr = new PendingRequests();
  assert.equal(pr.resolve({ id: 999, status: 200 }), false);
});

test("PendingRequests rejects on timeout via injected fake clock (no real timers)", async () => {
  const clock = makeFakeClock();
  const pr = new PendingRequests(clock);
  const { promise } = pr.create({ timeoutMs: 1000 });
  assert.equal(clock.pending(), 1);

  clock.advance(999);
  assert.equal(pr.size, 1, "not yet timed out");
  clock.advance(1);
  await assert.rejects(promise, /timed out/);
  assert.equal(pr.size, 0);
  assert.equal(clock.pending(), 0, "timer cleaned up");
});

test("PendingRequests clears the timer when a response arrives first", async () => {
  const clock = makeFakeClock();
  const pr = new PendingRequests(clock);
  const { id, promise } = pr.create({ timeoutMs: 1000 });
  pr.resolve({ type: FRAME_TYPES.RESPONSE, id, status: 200 });
  await promise;
  assert.equal(clock.pending(), 0, "timer was cleared on resolve");
  clock.advance(5000); // must not reject anything
});

test("PendingRequests rejects on a matching error frame", async () => {
  const pr = new PendingRequests();
  const { id, promise } = pr.create();
  const matched = pr.rejectFromError({ type: FRAME_TYPES.ERROR, id, code: 502, message: "bad gateway" });
  assert.equal(matched, true);
  const err = await promise.then(() => null, (e) => e);
  assert.equal(err.message, "bad gateway");
  assert.equal(err.code, 502);
  // Bare error (no matching id) is not consumed.
  assert.equal(pr.rejectFromError({ type: FRAME_TYPES.ERROR, code: 1 }), false);
});

test("PendingRequests.rejectAll rejects every in-flight request on transport close", async () => {
  const clock = makeFakeClock();
  const pr = new PendingRequests(clock);
  const { promise: p1 } = pr.create({ timeoutMs: 1000 });
  const { promise: p2 } = pr.create({ timeoutMs: 1000 });
  pr.rejectAll(new Error("transport closed"));
  await assert.rejects(p1, /transport closed/);
  await assert.rejects(p2, /transport closed/);
  assert.equal(pr.size, 0);
  assert.equal(clock.pending(), 0, "all timers cleared — nothing left open");
});

// ---------------------------------------------------------------------------
// StreamRegistry — mux
// ---------------------------------------------------------------------------

function collectingConsumer() {
  const data = [];
  const opens = [];
  let ended = false;
  let aborted = null;
  return {
    data,
    opens,
    get ended() { return ended; },
    get aborted() { return aborted; },
    onOpen: (frame) => { opens.push(frame); },
    onData: (payload) => data.push(payload),
    onEnd: () => { ended = true; },
    onAbort: (reason) => { aborted = reason ?? "aborted"; },
  };
}

test("StreamRegistry delivers STREAM_OPEN to the consumer's onOpen (BET-156)", () => {
  // Response-side opens carry { status, headers } — the consumer reads those
  // out of the onOpen frame. The registry doesn't parse; it just delivers.
  const reg = new StreamRegistry();
  const c = collectingConsumer();
  reg.open("s1", c);
  const headFrame = { type: FRAME_TYPES.STREAM_OPEN, id: 1, stream: "s1", status: 200, headers: { "content-type": "text/event-stream" } };
  assert.equal(reg.handleFrame(headFrame), true, "delivered");
  assert.equal(c.opens.length, 1);
  assert.equal(c.opens[0].status, 200);
  assert.equal(c.opens[0].headers["content-type"], "text/event-stream");
  // A STREAM_OPEN for an unknown stream id is dropped (no consumer subscribed).
  const c2 = collectingConsumer();
  const reg2 = new StreamRegistry();
  assert.equal(reg2.handleFrame(headFrame), false, "dropped — no consumer");
});

test("StreamRegistry keeps two concurrent streams isolated + routes to correct consumer", () => {
  const reg = new StreamRegistry();
  const c1 = collectingConsumer();
  const c2 = collectingConsumer();
  reg.open("s1", c1);
  reg.open("s2", c2);
  assert.equal(reg.size, 2);

  reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "a1" });
  reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 2, stream: "s2", data: "b1" });
  reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "a2" });

  assert.deepEqual(c1.data, ["a1", "a2"]);
  assert.deepEqual(c2.data, ["b1"]);
});

test("StreamRegistry: end cleans up and frees the id for reuse", () => {
  const reg = new StreamRegistry();
  const c1 = collectingConsumer();
  reg.open("s1", c1);
  reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "x" });
  assert.equal(reg.handleFrame({ type: FRAME_TYPES.STREAM_END, id: 1, stream: "s1" }), true);
  assert.equal(c1.ended, true);
  assert.equal(reg.has("s1"), false, "id freed after end");

  // Reuse the same id with a fresh consumer — must not receive old consumer's data.
  const c1b = collectingConsumer();
  reg.open("s1", c1b);
  reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 9, stream: "s1", data: "fresh" });
  assert.deepEqual(c1b.data, ["fresh"]);
  assert.deepEqual(c1.data, ["x"], "old consumer unaffected");
});

test("StreamRegistry: late data after end is dropped, not misrouted", () => {
  const reg = new StreamRegistry();
  const c1 = collectingConsumer();
  reg.open("s1", c1);
  reg.handleFrame({ type: FRAME_TYPES.STREAM_END, id: 1, stream: "s1" });
  const delivered = reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "late" });
  assert.equal(delivered, false, "late data dropped");
  assert.deepEqual(c1.data, []);
});

test("StreamRegistry: abort cleans up and fires onAbort", () => {
  const reg = new StreamRegistry();
  const c1 = collectingConsumer();
  reg.open("s1", c1);
  assert.equal(reg.handleFrame({ type: FRAME_TYPES.STREAM_ABORT, id: 1, stream: "s1", reason: "peer" }), true);
  assert.equal(c1.aborted, "peer");
  assert.equal(reg.has("s1"), false);
  // Data after abort is dropped.
  assert.equal(reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "z" }), false);
  assert.deepEqual(c1.data, []);
});

test("StreamRegistry: data for an unknown stream is dropped", () => {
  const reg = new StreamRegistry();
  assert.equal(reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "ghost", data: "x" }), false);
});

test("StreamRegistry: local abort + abortAll tear down live streams", () => {
  const reg = new StreamRegistry();
  const c1 = collectingConsumer();
  const c2 = collectingConsumer();
  reg.open("s1", c1);
  reg.open("s2", c2);
  assert.equal(reg.abort("s1", "cancelled"), true);
  assert.equal(c1.aborted, "cancelled");
  reg.abortAll("transport closed");
  assert.equal(c2.aborted, "transport closed");
  assert.equal(reg.size, 0);
});

test("StreamRegistry: opening a live id twice throws (mux bug guard)", () => {
  const reg = new StreamRegistry();
  reg.open("s1", collectingConsumer());
  assert.throws(() => reg.open("s1", collectingConsumer()), /already open/);
});

test("StreamRegistry isolates a throwing consumer callback", () => {
  const reg = new StreamRegistry();
  reg.open("s1", { onData: () => { throw new Error("consumer boom"); } });
  // Must not throw out of handleFrame.
  assert.equal(reg.handleFrame({ type: FRAME_TYPES.STREAM_DATA, id: 1, stream: "s1", data: "x" }), true);
});

// ---------------------------------------------------------------------------
// RoutingTable — boxId → handle
// ---------------------------------------------------------------------------

function fakeHandle() {
  const h = {
    closed: false,
    sent: [],
    send: (f) => h.sent.push(f),
    close: () => { h.closed = true; },
  };
  return h;
}

test("RoutingTable register/lookup/list/unregister", () => {
  const rt = new RoutingTable();
  const ha = fakeHandle();
  const hb = fakeHandle();
  assert.equal(rt.register(BOX_A, ha), null, "no eviction on first register");
  rt.register(BOX_B, hb);
  assert.equal(rt.size, 2);
  assert.equal(rt.lookup(BOX_A), ha);
  assert.equal(rt.has(BOX_B), true);
  assert.deepEqual(rt.list().sort(), [BOX_A, BOX_B].sort());

  assert.equal(rt.unregister(BOX_A), true);
  assert.equal(rt.lookup(BOX_A), null);
  assert.equal(rt.unregister(BOX_A), false, "second unregister is a no-op");
  assert.equal(rt.size, 1);
});

test("RoutingTable: re-registering a live boxId evicts + closes the stale socket", () => {
  const evicts = [];
  const rt = new RoutingTable({ onEvict: (id, h) => evicts.push([id, h]) });
  const stale = fakeHandle();
  const fresh = fakeHandle();
  rt.register(BOX_A, stale);
  const evicted = rt.register(BOX_A, fresh);

  assert.equal(evicted, stale, "returns the evicted handle");
  assert.equal(stale.closed, true, "stale socket closed");
  assert.equal(fresh.closed, false, "fresh socket stays open");
  assert.equal(rt.lookup(BOX_A), fresh, "fresh socket is now live");
  assert.equal(rt.size, 1, "single live socket per box");
  assert.deepEqual(evicts, [[BOX_A, stale]], "onEvict fired once");
});

test("RoutingTable.register rejects an invalid boxId or handle", () => {
  const rt = new RoutingTable();
  assert.throws(() => rt.register("nothex", fakeHandle()), /invalid boxId/);
  assert.throws(() => rt.register(BOX_A, {}), /send\(\)/);
});

test("RoutingTable.unregister(handle) only removes the matching handle", () => {
  const rt = new RoutingTable();
  const stale = fakeHandle();
  const fresh = fakeHandle();
  rt.register(BOX_A, stale);
  rt.register(BOX_A, fresh); // evicts stale, fresh is live
  // A late unregister carrying the stale handle must NOT remove fresh.
  assert.equal(rt.unregister(BOX_A, stale), false);
  assert.equal(rt.lookup(BOX_A), fresh);
  assert.equal(rt.unregister(BOX_A, fresh), true);
  assert.equal(rt.has(BOX_A), false);
});

test("RoutingTable.send routes to a live handle and reports connectivity", () => {
  const rt = new RoutingTable();
  const ha = fakeHandle();
  rt.register(BOX_A, ha);
  assert.equal(rt.send(BOX_A, "frame1"), true);
  assert.deepEqual(ha.sent, ["frame1"]);
  assert.equal(rt.send(BOX_B, "frame2"), false, "unknown box → false");
});

// ---------------------------------------------------------------------------
// Fake transport + end-to-end integration through the pieces
// ---------------------------------------------------------------------------

test("createFakeTransport delivers frames both directions and closes once", () => {
  const { a, b } = createFakeTransport();
  const gotA = [];
  const gotB = [];
  let aClosed = 0;
  let bClosed = 0;
  a.onMessage((m) => gotA.push(m));
  b.onMessage((m) => gotB.push(m));
  a.onClose(() => aClosed++);
  b.onClose(() => bClosed++);

  a.send("to-b");
  b.send("to-a");
  assert.deepEqual(gotB, ["to-b"]);
  assert.deepEqual(gotA, ["to-a"]);

  a.close();
  a.close(); // idempotent
  b.close();
  assert.equal(aClosed, 1);
  assert.equal(bClosed, 1);
  // Sends after close are dropped.
  a.send("dropped");
  assert.deepEqual(gotB, ["to-b"]);
});

test("end-to-end: request/response + a muxed stream over one fake transport", async () => {
  const { a, b } = createFakeTransport();

  // Side A: caller. Owns PendingRequests + StreamRegistry, wires demux.
  const pr = new PendingRequests();
  const reg = new StreamRegistry();
  a.onMessage((raw) => {
    const f = decodeFrame(raw);
    if (!f) return;
    if (f.type === FRAME_TYPES.RESPONSE) pr.resolve(f);
    else if (f.type === FRAME_TYPES.ERROR) pr.rejectFromError(f);
    else if (f.type.startsWith("stream-")) reg.handleFrame(f);
  });
  a.onClose(() => { pr.rejectAll(new Error("closed")); reg.abortAll("closed"); });

  // Side B: responder. Echoes a response and pushes a 2-chunk stream.
  b.onMessage((raw) => {
    const f = decodeFrame(raw);
    if (!f) return;
    if (f.type === FRAME_TYPES.REQUEST) {
      b.send(encodeFrame({ type: FRAME_TYPES.RESPONSE, id: f.id, status: 200, body: `re:${f.path}` }));
    }
    if (f.type === FRAME_TYPES.STREAM_OPEN) {
      b.send(encodeFrame({ type: FRAME_TYPES.STREAM_DATA, id: f.id, stream: f.stream, data: "c1" }));
      b.send(encodeFrame({ type: FRAME_TYPES.STREAM_DATA, id: f.id, stream: f.stream, data: "c2" }));
      b.send(encodeFrame({ type: FRAME_TYPES.STREAM_END, id: f.id, stream: f.stream }));
    }
  });

  // Fire a request.
  const { id, promise } = pr.create({ timeoutMs: 1000 });
  a.send(encodeFrame({ type: FRAME_TYPES.REQUEST, id, method: "GET", path: "/hello", boxId: BOX_A }));
  const resp = await promise;
  assert.equal(resp.status, 200);
  assert.equal(resp.body, "re:/hello");

  // Open a stream and collect chunks.
  const c = collectingConsumer();
  reg.open("sX", c);
  a.send(encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: pr.nextId(), stream: "sX", method: "GET", path: "/sse" }));
  assert.deepEqual(c.data, ["c1", "c2"]);
  assert.equal(c.ended, true);
  assert.equal(reg.has("sX"), false, "stream cleaned up after end");

  // Closing the transport rejects any straggler + tears down streams.
  const { promise: hanging } = pr.create({ timeoutMs: 1000 });
  a.close();
  await assert.rejects(hanging, /closed/);
});
