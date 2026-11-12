import { test } from "node:test";
import assert from "node:assert/strict";
import { installShutdownFlush } from "./shutdownFlush.mjs";

function fakeProc() {
  const handlers = new Map();
  return { once: (sig, fn) => handlers.set(sig, fn), emit: (sig) => handlers.get(sig)?.() };
}
const settle = () => new Promise((r) => setImmediate(r));

test("SIGTERM flushes, then exits 143; SIGINT exits 130 — it exits itself instead of re-raising the signal", async () => {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const proc = fakeProc();
    const exits = [];
    let flushed = 0;
    installShutdownFlush({ flush: async () => void flushed++ }, { proc, exit: (c) => exits.push(c) });
    proc.emit(signal);
    await settle();
    assert.equal(flushed, 1);
    assert.deepEqual(exits, [code]);
  }
});

test("a flush that never finishes is cut off by the cap; a flush that throws still exits", async () => {
  const proc = fakeProc();
  const exits = [];
  const timers = [];
  installShutdownFlush({ flush: () => new Promise(() => {}) }, { proc, exit: (c) => exits.push(c), setTimer: (fn, ms) => (timers.push([fn, ms]), timers.length), clearTimer: () => {}, capMs: 3_000 });
  proc.emit("SIGTERM");
  await settle();
  assert.deepEqual(exits, [], "still waiting for the flush");
  assert.equal(timers[0][1], 3_000);
  timers[0][0]();
  assert.deepEqual(exits, [143]);

  const proc2 = fakeProc();
  const exits2 = [];
  installShutdownFlush({ flush: async () => { throw new Error("disk"); } }, { proc: proc2, exit: (c) => exits2.push(c) });
  proc2.emit("SIGINT");
  await settle();
  assert.deepEqual(exits2, [130]);
});

test("it runs once: a second signal, or the other signal, does not flush or exit again", async () => {
  const proc = fakeProc();
  const exits = [];
  let flushed = 0;
  installShutdownFlush({ flush: async () => void flushed++ }, { proc, exit: (c) => exits.push(c) });
  proc.emit("SIGTERM");
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  await settle();
  assert.equal(flushed, 1);
  assert.deepEqual(exits, [143]);
});
