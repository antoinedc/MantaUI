// ptyWs.test.mjs — tests for the box server's /pty WS handler (BET-158).
//
// The handler bridges a WebSocket to the ephemeral pty module. We inject a
// fake `pty` module so the integration can be exercised without node-pty +
// a real binary; the test asserts against the calls the fake receives and
// the frames the fake ws sends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { attachPtyWs, parsePtyQuery } from "./ptyWs.mjs";

// ---------------------------------------------------------------------------
// parsePtyQuery — pure URL → parameter extraction
// ---------------------------------------------------------------------------

test("parsePtyQuery: required sessionKey is read from `session=`", () => {
  const url = new URL("ws://localhost/pty?session=foo&cols=100&rows=30");
  const p = parsePtyQuery(url);
  assert.equal(p.sessionKey, "foo");
  assert.equal(p.cols, 100);
  assert.equal(p.rows, 30);
});

test("parsePtyQuery: sessionKey falls back to sessionKey=", () => {
  // Older devices may use sessionKey=; accept both spellings so a future
  // rename in the renderer doesn't break the box server.
  const url = new URL("ws://localhost/pty?sessionKey=abc");
  assert.equal(parsePtyQuery(url).sessionKey, "abc");
});

test("parsePtyQuery: missing sessionKey is empty string (the handler rejects)", () => {
  const url = new URL("ws://localhost/pty?cols=80");
  assert.equal(parsePtyQuery(url).sessionKey, "");
});

test("parsePtyQuery: cols/rows are clamped to safe bounds, with sensible defaults", () => {
  const url = new URL("ws://localhost/pty?session=x");
  const defaults = parsePtyQuery(url);
  assert.equal(defaults.cols, 80);
  assert.equal(defaults.rows, 24);
  assert.equal(parsePtyQuery(new URL("ws://x/pty?session=x&cols=5")).cols, 20);
  assert.equal(parsePtyQuery(new URL("ws://x/pty?session=x&cols=9999")).cols, 500);
  assert.equal(parsePtyQuery(new URL("ws://x/pty?session=x&rows=1")).rows, 5);
  assert.equal(parsePtyQuery(new URL("ws://x/pty?session=x&rows=9999")).rows, 200);
  assert.equal(parsePtyQuery(new URL("ws://x/pty?session=x&cols=abc")).cols, 80);
});

test("parsePtyQuery: launcher JSON parses when valid; malformed falls back to undefined", () => {
  const valid = parsePtyQuery(new URL('ws://x/pty?session=x&launcher={"id":"claude"}'));
  assert.deepEqual(valid.launcher, { id: "claude" });
  const malformed = parsePtyQuery(new URL("ws://x/pty?session=x&launcher={not-json"));
  assert.equal(malformed.launcher, undefined);
});

test("parsePtyQuery: cwd defaults to process.cwd() when absent", () => {
  const p = parsePtyQuery(new URL("ws://x/pty?session=x"));
  assert.equal(p.cwd, process.cwd());
});

// ---------------------------------------------------------------------------
// attachPtyWs — WS↔pty wiring (with a fake pty module)
// ---------------------------------------------------------------------------

// Minimal fake ws that satisfies the members attachPtyWs touches: send,
// close, on("message"/"close"/"error").
function fakeWs() {
  const emitter = new EventEmitter();
  return {
    sent: [],
    closed: null,
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closed = { code, reason }; this._emit("close"); },
    on(event, fn) { emitter.on(event, fn); },
    _emit(event, ...args) { emitter.emit(event, ...args); },
  };
}

// A fake pty module that records every call so a test can assert against
// the WS↔pty contract directly. Mirrors the real module's signature so
// attachPtyWs doesn't need to special-case anything.
function makeFakePty() {
  const calls = { spawn: [], write: [], resize: [], kill: [] };
  let onEvent = null;
  return {
    calls,
    spawn(opts, ev) {
      calls.spawn.push(opts);
      onEvent = ev;
    },
    write(sessionKey, data) { calls.write.push({ sessionKey, data }); },
    resize(sessionKey, cols, rows) { calls.resize.push({ sessionKey, cols, rows }); },
    kill(sessionKey) { calls.kill.push(sessionKey); },
    // Test helper: simulate a pty event flowing through to the WS.
    emit(event) { onEvent?.(event); },
  };
}

test("attachPtyWs: missing sessionKey rejects with 1008 + error frame, no spawn", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  const url = new URL("ws://x/pty?cols=80");

  attachPtyWs(ws, url, { pty });
  // Rejection is sync (sessionKey check fires before the pty module
  // resolution), but give a microtask to drain so any future reorder
  // doesn't show a false negative here.
  await new Promise((r) => setImmediate(r));

  assert.equal(ws.closed?.code, 1008, "rejected with policy-violation close code");
  assert.equal(ws.closed?.reason, "session_required");
  assert.equal(ws.sent.length, 1);
  const errFrame = JSON.parse(ws.sent[0]);
  assert.equal(errFrame.error, "session_required");
  assert.equal(pty.calls.spawn.length, 0, "no pty spawn for an invalid request");
});

test("attachPtyWs: parses session/cwd/cols/rows/launcher and forwards to pty.spawn", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  const url = new URL(
    'ws://x/pty?session=abc&cwd=/tmp&cols=120&rows=40&launcher={"id":"claude"}',
  );

  attachPtyWs(ws, url, { pty });
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.spawn.length, 1);
  const spawn = pty.calls.spawn[0];
  assert.equal(spawn.sessionKey, "abc");
  assert.equal(spawn.cwd, "/tmp");
  assert.equal(spawn.cols, 120);
  assert.equal(spawn.rows, 40);
  assert.deepEqual(spawn.launcher, { id: "claude" });
});

test("attachPtyWs: a {type:'data'} WS message → pty.write with the same sessionKey", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("message", JSON.stringify({ type: "data", data: "ls\n" }));
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.write.length, 1);
  assert.equal(pty.calls.write[0].sessionKey, "abc");
  assert.equal(pty.calls.write[0].data, "ls\n");
});

test("attachPtyWs: a binary {type:'data'} WS message is decoded as utf8 before pty.write", async () => {
  // The device contract is text JSON control strings; a binary frame is
  // unusual but possible if the device protocol ever sends raw input. The
  // handler decodes with toString("utf8") so the pty module receives a
  // string regardless of frame shape.
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("message", Buffer.from(JSON.stringify({ type: "data", data: "echo hi\n" })));
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.write.length, 1);
  assert.equal(pty.calls.write[0].data, "echo hi\n");
});

test("attachPtyWs: a {type:'resize'} WS message → pty.resize", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("message", JSON.stringify({ type: "resize", cols: 90, rows: 30 }));
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.resize.length, 1);
  assert.equal(pty.calls.resize[0].sessionKey, "abc");
  assert.equal(pty.calls.resize[0].cols, 90);
  assert.equal(pty.calls.resize[0].rows, 30);
  assert.equal(pty.calls.write.length, 0, "resize is not a write");
});

test("attachPtyWs: malformed JSON messages are dropped silently (no pty call)", async () => {
  // Garbage input must not crash the handler or pollute the pty stream.
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  for (const bad of ["not-json", "", "{", '{"oops":true}', '{"type":"unknown"}', '{"type":"resize"}']) {
    ws._emit("message", bad);
  }
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.write.length, 0, "no spurious writes");
  assert.equal(pty.calls.resize.length, 0, "no spurious resizes");
});

test("attachPtyWs: a {type:'data'} message with non-string data is dropped", async () => {
  // The contract is `{type:"data", data: string}` — a non-string `data`
  // field (number, object, null) is dropped to prevent type confusion at
  // the pty layer. A real terminal would never send this; defending
  // against a buggy device.
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("message", JSON.stringify({ type: "data", data: 42 }));
  ws._emit("message", JSON.stringify({ type: "data", data: null }));
  ws._emit("message", JSON.stringify({ type: "data" })); // missing data
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.write.length, 0);
});

test("attachPtyWs: a {type:'resize'} with non-integer cols/rows is dropped", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("message", JSON.stringify({ type: "resize", cols: "wide", rows: 30 }));
  ws._emit("message", JSON.stringify({ type: "resize", cols: 80 })); // missing rows
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.resize.length, 0);
});

test("attachPtyWs: a pty {kind:'data'} event → ws.send with the raw bytes", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  // String data is forwarded verbatim (the pty module emits string data
  // for normal terminal output).
  pty.emit({ kind: "data", sessionKey: "abc", data: "\x1b[32mok\x1b[0m\n" });

  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0], "\x1b[32mok\x1b[0m\n");

  // Buffer data is also forwarded — the WS package decides between text vs
  // binary framing internally.
  pty.emit({ kind: "data", sessionKey: "abc", data: Buffer.from([0x00, 0x01, 0xff]) });
  assert.equal(ws.sent.length, 2);
  assert.deepEqual([...ws.sent[1]], [0x00, 0x01, 0xff]);
});

test("attachPtyWs: a pty {kind:'exit'} event → ws.close(1000) with the exit code in the reason", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  pty.emit({ kind: "exit", sessionKey: "abc", code: 0 });

  assert.equal(ws.closed?.code, 1000, "normal closure");
  assert.match(ws.closed?.reason, /"code":0/);
});

test("attachPtyWs: a pty {kind:'exit'} event with code=null still closes cleanly", async () => {
  // node-pty emits null exit codes on signal-kills; the handler must NOT
  // crash and must still close the socket so the device reconnects.
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  pty.emit({ kind: "exit", sessionKey: "abc", code: null });

  assert.equal(ws.closed?.code, 1000);
});

test("attachPtyWs: ws 'close' → pty.kill(sessionKey) so the pty dies with the socket", async () => {
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("close");
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.kill.length, 1);
  assert.equal(pty.calls.kill[0], "abc");
});

test("attachPtyWs: ws 'error' does NOT crash; cleanup runs on 'close'", async () => {
  // ws fires 'error' then 'close' on a transport-level error; the handler
  // must NOT pty.kill on 'error' alone (the pty lives until the socket
  // actually closes).
  const ws = fakeWs();
  const pty = makeFakePty();
  attachPtyWs(ws, new URL("ws://x/pty?session=abc"), { pty });
  await new Promise((r) => setImmediate(r));

  ws._emit("error", new Error("ECONNRESET"));
  await new Promise((r) => setImmediate(r));

  assert.equal(pty.calls.kill.length, 0, "no kill on error alone");
  ws._emit("close");
  await new Promise((r) => setImmediate(r));
  assert.equal(pty.calls.kill.length, 1, "kill runs on the subsequent close");
});
