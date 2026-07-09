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
