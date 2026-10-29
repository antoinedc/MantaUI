// Auto-handoff ownership continuity (spec §6.3) on the delegate side: a job's
// settlement defers while a `send` handoff is pending on its own session, a
// commit re-points parent / child ids, and a parent's job list spans its whole
// replacement chain. In-memory store; nothing live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completionOwnerOf, createDelegateEngine, listJobs, pauseJob, repointJobSessions, settleV2Job, stopJob, sweepDelegateJobs } from "./delegate.mjs";

const job = (over) => ({ id: "aaaa1111", status: "running", launchState: "running", completionOwner: "opencode", submittedAt: 1, parentSessionID: "ses_parent", childSessionID: "ses_child", ...over });
function store(seed) {
  let jobs = seed.map((j) => ({ ...j }));
  return {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => {
      jobs = next.map((j) => ({ ...j }));
    },
    get: () => jobs,
  };
}

test("settleV2Job defers while a send handoff is pending on the job's own session — and settles normally when it is not", async () => {
  const s = store([job()]);
  let pending = true;
  const deps = {
    load: s.load,
    save: s.save,
    listActiveIds: async () => [],
    readSession: async () => ({ state: "found", session: { outcome: "succeeded", time: { idle: 10 } } }),
    deferSettlement: (sid) => pending && sid === "ses_child",
    publish: () => {},
  };
  const res = await settleV2Job(s.get()[0], deps);
  assert.deepEqual(res, { settled: false, reason: "handoff-pending" });
  assert.equal(s.get()[0].status, "running", "still running");
  pending = false; // the handoff failed: the deferred settlement runs
  const after = await settleV2Job(s.get()[0], { ...deps, finishV2Job: undefined });
  assert.notEqual(after.reason, "handoff-pending");
});

test("repointJobSessions: parent jobs follow the successor; a replaced job session is re-pointed; others untouched; idempotent", async () => {
  const s = store([
    job({ id: "j1", parentSessionID: "ses_old" }),
    job({ id: "j2", parentSessionID: "ses_other", childSessionID: "ses_old" }),
    job({ id: "j3", parentSessionID: "ses_other", childSessionID: "ses_x" }),
  ]);
  const deps = { load: s.load, save: s.save, publish: () => {} };
  assert.equal(await repointJobSessions({ fromSessionId: "ses_old", toSessionId: "ses_new" }, deps), 2);
  const byId = Object.fromEntries(s.get().map((j) => [j.id, j]));
  assert.equal(byId.j1.parentSessionID, "ses_new");
  assert.equal(byId.j2.childSessionID, "ses_new");
  assert.equal(byId.j2.parentSessionID, "ses_other");
  assert.equal(byId.j3.childSessionID, "ses_x");
  assert.equal(await repointJobSessions({ fromSessionId: "ses_old", toSessionId: "ses_new" }, deps), 0, "a recovery re-run changes nothing");
  assert.equal(await repointJobSessions({ fromSessionId: "ses_new", toSessionId: "ses_z", child: false }, deps), 1, "parent-only option");
  assert.equal(byId.j2.childSessionID, "ses_new");
});

test("listJobs: a set of session ids covers the whole replacement chain; the single-id form is unchanged", async () => {
  const s = store([job({ id: "j1", parentSessionID: "a" }), job({ id: "j2", parentSessionID: "b" }), job({ id: "j3", parentSessionID: "c" })]);
  const deps = { load: s.load, readProgress: async () => null };
  assert.deepEqual((await listJobs({ sessionIDs: ["a", "b"] }, deps)).map((j) => j.id), ["j1", "j2"]);
  assert.deepEqual((await listJobs({ sessionID: "c" }, deps)).map((j) => j.id), ["j3"]);
  assert.equal((await listJobs({}, deps)).length, 3);
});

test("the engine's listJobs expands a session to its replacement chain", async () => {
  const s = store([job({ id: "j1", parentSessionID: "a" }), job({ id: "j2", parentSessionID: "b" }), job({ id: "j3", parentSessionID: "z" })]);
  const engine = createDelegateEngine({ load: s.load, save: s.save, readProgress: async () => null, replacementChain: (sid) => (sid === "b" ? ["a", "b"] : [sid]) });
  assert.deepEqual((await engine.listJobs({ sessionID: "b" })).map((j) => j.id), ["j1", "j2"]);
  assert.deepEqual((await engine.listJobs({ sessionID: "z" })).map((j) => j.id), ["j3"]);
  assert.equal(await engine.isRunningJobSession("ses_child"), true);
  assert.equal(await engine.isRunningJobSession("ses_none"), false);
  // The read-only-job guard's cheap read: the raw records, with no progress reads at all.
  let progressReads = 0;
  const lean = createDelegateEngine({ load: s.load, save: s.save, readProgress: async () => (progressReads++, null) });
  assert.deepEqual((await lean.loadRecords()).map((j) => j.id), ["j1", "j2", "j3"]);
  assert.equal(progressReads, 0);
  assert.equal(await engine.repointSessions({ fromSessionId: "a", toSessionId: "a2" }), 1);
});

// ---- background jobs hand off on their own (spec 2026-10-29-handoff-jobs-auto) ----

test("runningJobOwner: manta / opencode for a running record on the session, null for none, paused or finished; isRunningJobSession derives from it", async () => {
  const s = store([
    job({ id: "m", childSessionID: "ses_m", completionOwner: "manta" }),
    job({ id: "o", childSessionID: "ses_o", completionOwner: "opencode" }),
    job({ id: "p", childSessionID: "ses_p", completionOwner: "manta", status: "paused" }),
    job({ id: "d", childSessionID: "ses_d", completionOwner: "manta", status: "done" }),
    job({ id: "a", childSessionID: "ses_a", completionOwner: undefined, origin: "subagent" }),
  ]);
  const engine = createDelegateEngine({ load: s.load, save: s.save, readProgress: async () => null });
  assert.equal(completionOwnerOf(s.get()[4]), "opencode");
  assert.equal(await engine.runningJobOwner("ses_m"), "manta");
  assert.equal(await engine.runningJobOwner("ses_o"), "opencode");
  assert.equal(await engine.runningJobOwner("ses_a"), "opencode", "a record from before the field existed: an adopted subagent is opencode's");
  for (const sid of ["ses_p", "ses_d", "ses_none"]) assert.equal(await engine.runningJobOwner(sid), null, sid);
  assert.equal(await engine.isRunningJobSession("ses_m"), true);
  assert.equal(await engine.isRunningJobSession("ses_o"), true, "the armed-trigger skip still covers every running record");
  assert.equal(await engine.isRunningJobSession("ses_p"), false);
});

function stopDeps(s, extra = {}) {
  return { load: s.load, save: s.save, publish: () => {}, abortSession: async () => {}, ...extra };
}

test("stopJob cancels the handoff pending on the job's session, and does it BEFORE aborting the turn", async () => {
  const s = store([job({ id: "j1", childSessionID: "ses_child" })]);
  const order = [];
  const res = await stopJob("j1", stopDeps(s, { cancelPendingHandoff: async (sid) => void order.push(["cancel", sid]), abortSession: async (sid) => void order.push(["abort", sid]) }));
  assert.equal(res.ok, true);
  assert.deepEqual(order, [["cancel", "ses_child"], ["abort", "ses_child"]]);
  assert.equal(s.get()[0].status, "stopped");
});

test("a failing handoff cancel never blocks a stop; a stop on a missing / finished job cancels nothing", async () => {
  const s = store([job({ id: "j1" }), job({ id: "j2", status: "done" })]);
  const calls = [];
  const deps = stopDeps(s, { cancelPendingHandoff: async (sid) => (calls.push(sid), Promise.reject(new Error("boom"))) });
  assert.equal((await stopJob("j1", deps)).ok, true);
  assert.deepEqual(calls, ["ses_child"]);
  assert.equal((await stopJob("j2", deps)).ok, false);
  assert.equal((await stopJob("nope", deps)).ok, false);
  assert.deepEqual(calls, ["ses_child"]);
});

test("pauseJob cancels the handoff pending on the job's session; a refused pause cancels nothing", async () => {
  const s = store([job({ id: "j1", childSessionID: "ses_m", completionOwner: "manta" }), job({ id: "j2", childSessionID: "ses_o", completionOwner: "opencode" })]);
  const calls = [];
  const deps = stopDeps(s, { cancelPendingHandoff: async (sid) => void calls.push(sid) });
  assert.equal((await pauseJob("j1", deps)).ok, true);
  assert.deepEqual(calls, ["ses_m"]);
  assert.equal((await pauseJob("j2", deps)).ok, false, "pause isn't available for an opencode-owned job");
  assert.deepEqual(calls, ["ses_m"]);
});

test("the sweeper does not time out a job that has a send handoff pending — and does once it is gone; the limit itself is unchanged", async () => {
  const started = 1_700_000_000_000;
  const mk = () => store([job({ id: "old", completionOwner: "manta", engine: "v2", startedAt: started, worktree: null, completionMessageId: "msg_x" })]);
  const run = async (s, pending) => {
    await sweepDelegateJobs({
      load: s.load,
      save: s.save,
      now: () => started + 31 * 60_000,
      publish: () => {},
      postSynthetic: async () => {},
      deferSettlement: (sid) => pending && sid === "ses_child",
    });
    return s.get()[0].status;
  };
  assert.equal(await run(mk(), true), "running", "deferred while a handoff is pending");
  assert.equal(await run(mk(), false), "failed", "timed out as before once nothing is pending");
});
