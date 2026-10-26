// Auto-handoff ownership continuity (spec §6.3) on the delegate side: a job's
// settlement defers while a `send` handoff is pending on its own session, a
// commit re-points parent / child ids, and a parent's job list spans its whole
// replacement chain. In-memory store; nothing live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegateEngine, listJobs, repointJobSessions, settleV2Job } from "./delegate.mjs";

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
  assert.equal(await engine.repointSessions({ fromSessionId: "a", toSessionId: "a2" }), 1);
});
