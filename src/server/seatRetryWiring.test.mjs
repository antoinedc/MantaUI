// seatRetryWiring.test.mjs — the REAL seat assigner + limit handler + retry watch
// + accounts route, wired as index.mjs wires them (the watch is late-bound into the
// assigner's onMoved), with injected usage snapshots and opencode calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSeatAssigner } from "./seatAssignment.mjs";
import { createLimitSignalHandler } from "./seatLimitSignal.mjs";
import { createSeatRetryWatch } from "./seatRetryWatch.mjs";
import { createAccountsRouteHandler } from "./accountsRoute.mjs";
import { KEEP_GOING_PROMPT } from "./usageResume.mjs";

const quiet = { warn() {}, log() {} };
const seat = (n) => ({ seatId: `seat-${n}`, accountId: "acct-1", live: false, usable: true, dir: `/d/${n}`, file: `/d/${n}/c.json`, credential: { expiresAt: 5_000_000 } });
const snap = (n, pct) => ({ provider: "claude", seatId: `seat-${n}`, windows: [{ kind: "session", pct }] });
const retryEvt = (sessionID) => ({
  type: "session.status",
  properties: { sessionID, status: { type: "retry", attempt: 1, message: "This request would exceed your account's rate limit." } },
});

function stack() {
  const snaps = [snap(1, 5), snap(2, 10)];
  const calls = [];
  let watch = null;
  const assigner = createSeatAssigner({
    accounts: { async seatStates() { return { mode: "auto", activeSeatId: "seat-1", seats: [seat(1), seat(2)] }; } },
    listSeatSnapshots: () => snaps,
    refreshSeatCredentials: async () => ({}),
    load: () => null,
    save: async () => {},
    notePluginSeen: () => {},
    onMoved: (e) => void watch?.onMoved(e),
    log: quiet,
  });
  const limit = createLimitSignalHandler({ refreshUsage: async () => void calls.push(["tick"]), assigner, log: quiet });
  watch = createSeatRetryWatch({
    sessionAssignment: (sid) => assigner.sessionAssignment(sid),
    onLimitSignal: limit,
    abortSession: async (sid) => void calls.push(["abort", sid]),
    lastUserModel: async () => ({ providerID: "anthropic", modelID: "claude-opus-4" }),
    deliver: async (a) => void calls.push(["deliver", a]),
    log: quiet,
  });
  const sent = [];
  const route = createAccountsRouteHandler({
    seatAssigner: assigner,
    readJson: async (req) => req.body,
    respondJson: (_r, status, body) => sent.push([status, body]),
    refreshUsageInBackground: (p) => limit.refreshInBackground(p),
  });
  const post = async (body) => {
    sent.length = 0;
    await route({ method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: {}, body }, {}, new URL("/api/accounts/limit", "http://x"));
    return sent[0];
  };
  return { snaps, calls, assigner, watch, post };
}

test("POST /limit: marks the seat, moves the conversation, answers with the new seat + moved:true, refresh runs in the background", async () => {
  const s = stack();
  assert.equal((await s.assigner.resolve("claude", "conv")).seatId, "seat-1");
  const [status, body] = await s.post({ provider: "claude", sessionID: "conv" });
  assert.equal(status, 200);
  assert.equal(body.seatId, "seat-2");
  assert.equal(body.moved, true);
  assert.equal(s.assigner.assignments("claude").conv.seatId, "seat-2");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls, [["tick"]], "the usage refresh ran; nothing was aborted (the conversation was not retrying)");
});

test("a retrying conversation whose seat is limited is moved, aborted and told to keep going", async () => {
  const s = stack();
  await s.assigner.resolve("claude", "conv");
  await s.watch.observeEvent(retryEvt("conv"));
  assert.equal(s.assigner.assignments("claude").conv.seatId, "seat-2");
  assert.deepEqual(s.calls, [
    ["tick"],
    ["abort", "conv"],
    ["deliver", { sessionId: "conv", text: KEEP_GOING_PROMPT, model: { providerID: "anthropic", modelID: "claude-opus-4" } }],
  ]);
});

test("a retrying sub-agent is only aborted; the move is the ROOT conversation's", async () => {
  const s = stack();
  await s.assigner.resolve("claude", "kid", "root");
  await s.watch.observeEvent(retryEvt("kid"));
  assert.equal(s.assigner.assignments("claude").root.seatId, "seat-2");
  assert.deepEqual(s.calls, [["tick"], ["abort", "kid"]]);
});

test("a move by the usage poller while the conversation sleeps in a retry wakes it", async () => {
  const s = stack();
  await s.assigner.resolve("claude", "conv");
  // No other seat has room yet: the limit handler cannot move it, the retry stays.
  s.snaps.splice(0, 2, snap(1, 100), { ...snap(2, 100), exhausted: true });
  await s.watch.observeEvent(retryEvt("conv"));
  assert.deepEqual(s.calls, [["tick"]]);
  // The 10-minute poll later finds seat-2 with room; the next placement decision moves it.
  s.snaps.splice(0, 2, { ...snap(1, 100), exhausted: true }, snap(2, 10));
  await s.assigner.resolve("claude", "conv");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.calls.map((c) => c[0]), ["tick", "abort", "deliver"]);
});
