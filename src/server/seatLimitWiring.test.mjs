// seatLimitWiring.test.mjs — the REAL usage-stop engine + the REAL seat assigner
// + the real limit-signal handler, wired as index.mjs wires them, with injected
// usage snapshots: a 429 on a conversation whose seat reads 90% forces an
// immediate usage tick and moves the conversation to the 10% seat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageStopEngine } from "./usageStopEnroll.mjs";
import { createSeatAssigner } from "./seatAssignment.mjs";
import { createLimitSignalHandler } from "./seatLimitSignal.mjs";

const quiet = { warn() {}, log() {} };
const seat = (n) => ({ seatId: `seat-${n}`, accountId: "acct-1", live: false, usable: true, dir: `/d/${n}`, file: `/d/${n}/c.json`, credential: { expiresAt: 5_000_000 } });
const snap = (n, pct) => ({ provider: "claude", seatId: `seat-${n}`, windows: [{ kind: "session", pct }] });

test("429 on a conversation on seat-1 (90%) → immediate usage tick → moved to seat-2, accounts.moved announced", async () => {
  const snaps = [snap(1, 90), snap(2, 10)];
  const moved = [];
  const ticks = [];
  const assigner = createSeatAssigner({
    accounts: { async seatStates() { return { mode: "auto", activeSeatId: "seat-1", seats: [seat(1), seat(2)] }; } },
    listSeatSnapshots: () => snaps,
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: async () => {},
    notePluginSeen: () => {},
    onMoved: (e) => moved.push(e),
    log: quiet,
  });
  // The conversation was placed earlier, when seat-1 was the lighter one.
  const early = [snap(1, 5), snap(2, 30)];
  snaps.splice(0, 2, ...early);
  assert.equal((await assigner.resolve("claude", "conv")).seatId, "seat-1");
  snaps.splice(0, 2, snap(1, 90), snap(2, 10)); // the (lagging) reading: 90% — below the 95% move threshold
  assert.equal((await assigner.resolve("claude", "conv")).seatId, "seat-1", "90% alone: it stays");

  const engine = createUsageStopEngine({
    upsert: async () => {},
    recheckAtLimit: async () => false,
    onLimitSignal: createLimitSignalHandler({
      refreshUsage: async () => void ticks.push("usage tick"),
      assigner,
      log: quiet,
    }),
  });
  engine.observeEvent({ type: "session.next.step.ended", properties: { sessionID: "conv", providerID: "anthropic", modelID: "claude-opus-4-7", tokens: { cache: { read: 1, write: 1 } } } });
  await engine.observeEvent({
    type: "session.error",
    properties: { sessionID: "conv", error: { name: "ApiError", httpStatus: 429, data: { message: "Too Many Requests: rate_limit_error" } } },
  });
  await new Promise((r) => setTimeout(r, 20)); // the signal is fire-and-forget

  assert.deepEqual(ticks, ["usage tick"]);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].from, "seat-1");
  assert.equal(moved[0].to, "seat-2");
  assert.equal(assigner.assignments("claude").conv.seatId, "seat-2");
  assert.equal((await assigner.resolve("claude", "conv")).seatId, "seat-2", "the next request resolves to seat-2");
});
