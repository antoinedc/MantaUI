import { test } from "node:test";
import assert from "node:assert/strict";
import { startPoller, MAX_TIMER_MS, LONG_INTERVAL_CHECK_MS } from "./startPoller.mjs";

test("startPoller: an interval beyond the 32-bit timer limit does not degrade to 1 ms", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;
  let runs = 0;
  const month = 30 * 24 * 60 * 60 * 1000;
  assert.ok(month > MAX_TIMER_MS);
  const p = startPoller(async () => { runs++; }, { intervalMs: month, immediate: false, now: () => clock });
  // Many check ticks well inside the month: nothing runs.
  for (let i = 0; i < 24 * 10; i++) { clock += LONG_INTERVAL_CHECK_MS; t.mock.timers.tick(LONG_INTERVAL_CHECK_MS); }
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 0);
  // Past the due time: exactly one run, then the next month is waited for again.
  clock = month + 1; t.mock.timers.tick(LONG_INTERVAL_CHECK_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
  clock += LONG_INTERVAL_CHECK_MS; t.mock.timers.tick(LONG_INTERVAL_CHECK_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
  p.stop();
});

test("startPoller: a normal interval still ticks on its cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const p = startPoller(async () => { runs++; }, { intervalMs: 1000, immediate: false });
  t.mock.timers.tick(1000); await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1000); await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  p.stop();
});
