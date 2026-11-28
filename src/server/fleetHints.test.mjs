// The Fleet page refetches on the `agentFleet` hint. A chat starting or stopping work, or a progress report, changes what it shows
// without any job event, so the box turns those frames into the same hint (throttled: one per window).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetHint, isFleetRelevant } from "./fleetHints.mjs";

test("isFleetRelevant: a session's status frame and a progress report are; a text delta is not", () => {
  assert.equal(isFleetRelevant({ kind: "stream", sub: "windowStatus", sessionId: "s" }), true);
  assert.equal(isFleetRelevant({ kind: "progress.updated", payload: { sessionID: "s" } }), true);
  assert.equal(isFleetRelevant({ kind: "stream", sub: "flush", sessionId: "s" }), false);
  assert.equal(isFleetRelevant({ kind: "status" }), false);
  assert.equal(isFleetRelevant(null), false);
});

test("createFleetHint: a burst is one hint, the first at once and the rest as one trailing hint; later bursts hint again", () => {
  const fired = [];
  const timers = [];
  let t = 1000;
  const hint = createFleetHint({
    publish: () => fired.push(t),
    intervalMs: 2000,
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, ms };
      timers.push(h);
      return h;
    },
    clearTimer: () => {},
  });
  hint.observe({ kind: "stream", sub: "windowStatus", sessionId: "a" });
  assert.equal(fired.length, 1);
  t = 1500;
  hint.observe({ kind: "stream", sub: "windowStatus", sessionId: "b" });
  hint.observe({ kind: "progress.updated", payload: {} });
  assert.equal(fired.length, 1, "inside the window nothing more is published yet");
  assert.equal(timers.length, 1, "one trailing timer, however many frames");
  t = 3000;
  timers[0].fn();
  assert.equal(fired.length, 2, "the trailing hint carries what arrived meanwhile");
  t = 6000;
  hint.observe({ kind: "stream", sub: "windowStatus", sessionId: "c" });
  assert.equal(fired.length, 3);
  hint.observe({ kind: "stream", sub: "flush" });
  assert.equal(fired.length, 3, "irrelevant frames never hint");
});
