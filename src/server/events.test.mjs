import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBus, attachEventsWs } from "./events.mjs";

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
