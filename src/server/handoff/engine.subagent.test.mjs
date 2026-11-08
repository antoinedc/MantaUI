// A `task` subagent never hands off into a successor (its parent addresses it by session id), and the one-time
// repair of the links such handoffs left behind. Spec: 2026-11-08-background-results-and-viewer-windows.md §A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completionOwnerOf } from "../delegate.mjs";
import { HandoffError } from "./engine.mjs";
import { isTaskChild, jobCompletionOwner, SUBAGENT_HANDOFF_MESSAGE } from "./taskChild.mjs";
import { FULL_BODY, createWorld, readyRecord, settle } from "./testWorld.mjs";

const OPUS = { providerID: "anthropic", modelID: "claude-opus-4-8" };

/** One turn over the context budget, replayed as lifecycle events. */
async function overBudgetTurn(engine, sid, ctx = 250_000) {
  const ev = (type, properties) => engine.observeEvent({ type, properties: { sessionID: sid, ...properties } });
  ev("session.status", { status: { type: "busy" } });
  ev("session.next.step.ended", { tokens: { input: ctx, cache: { read: 0, write: 0 } }, ...OPUS });
  ev("session.status", { status: { type: "idle" } });
  ev("session.idle", {});
  await settle(10);
}

const worldWith = (sessionProps, { mode = "auto", jobs = [] } = {}) => {
  const w = createWorld({ mode });
  w.addSession("ses_p", sessionProps);
  w.addWindow("proj", 3, "work", "ses_p");
  w.jobs = jobs;
  w.engine = w.build();
  return w;
};

// ---- the predicate ---------------------------------------------------------------------------

test("isTaskChild: a parent makes a child, unless the session is a job record Manta completes", () => {
  const child = { id: "ses_c", parentID: "ses_root" };
  assert.equal(isTaskChild({ session: { id: "ses_c" }, jobs: [] }), false, "no parent: a normal conversation");
  assert.equal(isTaskChild({ session: null, jobs: [] }), false, "unreadable");
  assert.equal(isTaskChild({ session: child, jobs: [] }), true);
  assert.equal(isTaskChild({ session: child, jobs: null }), true);
  assert.equal(isTaskChild({ session: child, jobs: [{ childSessionID: "ses_other", completionOwner: "manta" }] }), true, "another session's job");
  assert.equal(isTaskChild({ session: child, jobs: [{ childSessionID: "ses_c", completionOwner: "manta" }] }), false, "a delegate launch");
  assert.equal(isTaskChild({ session: child, jobs: [{ childSessionID: "ses_c", origin: "command" }] }), false, "a wrapped command (owner defaults to manta)");
  assert.equal(isTaskChild({ session: child, jobs: [{ childSessionID: "ses_c", completionOwner: "opencode" }] }), true, "opencode reports it: addressed by id");
  assert.equal(isTaskChild({ session: child, jobs: [{ childSessionID: "ses_c", origin: "subagent" }] }), true, "an adopted subagent record");
});

test("the local job-owner rule agrees with the delegate engine's", () => {
  for (const job of [{}, { origin: "subagent" }, { origin: "command" }, { origin: "observed" }, { completionOwner: "opencode" }, { completionOwner: "manta", origin: "subagent" }]) {
    assert.equal(jobCompletionOwner(job), completionOwnerOf(job), JSON.stringify(job));
  }
});

// ---- the policy --------------------------------------------------------------------------------

test("the armed trigger skips a task child; a plain session and a delegate job's child still hand off", async () => {
  const child = worldWith({ parentID: "ses_root" });
  await overBudgetTurn(child.engine, "ses_p");
  assert.deepEqual(Object.keys(child.engine._state.records), [], "no record for a subagent");
  assert.equal(child.created.length, 0);

  const plain = worldWith({});
  await overBudgetTurn(plain.engine, "ses_p");
  assert.equal(Object.values(plain.engine._state.records)[0]?.state, "committed", "control: a conversation hands off");

  const job = worldWith({ parentID: "ses_root" }, { jobs: [{ childSessionID: "ses_p", completionOwner: "manta" }] });
  await overBudgetTurn(job.engine, "ses_p");
  assert.equal(Object.values(job.engine._state.records)[0]?.state, "committed", "a delegate job's child is repointed, so it may");
});

test("an unreadable session or job store fails open: the armed trigger behaves as before", async () => {
  const noJobs = worldWith({ parentID: "ses_root" });
  noJobs.engine = noJobs.build({ loadJobs: async () => { throw new Error("jobs.json unreadable"); } });
  await overBudgetTurn(noJobs.engine, "ses_p");
  assert.equal(Object.values(noJobs.engine._state.records)[0]?.state, "committed", "unreadable job store: not treated as a task child");

  const unreadable = worldWith({ parentID: "ses_root" });
  unreadable.unreadable.add("ses_p");
  await overBudgetTurn(unreadable.engine, "ses_p");
  assert.equal(Object.keys(unreadable.engine._state.records).length, 1, "unreadable session: the policy does not block (the handoff itself then fails to read it)");
});

test("the agent's handoff tool is refused for a task child (both actions) with the subagent message; user and button are not", async () => {
  const w = worldWith({ parentID: "ses_root" }, { mode: "suggest" });
  for (const action of ["suggest", "handoff"]) {
    await assert.rejects(
      w.engine.create({ sessionId: "ses_p", trigger: "agent", action, body: FULL_BODY }),
      (e) => e instanceof HandoffError && e.code === "subagent" && e.message === SUBAGENT_HANDOFF_MESSAGE,
      action,
    );
  }
  assert.match(SUBAGENT_HANDOFF_MESSAGE, /^This session is a subagent: its parent addresses it by this session id, so a handoff would orphan the new session\. Don't hand off\. Finish your task and report back; opencode compacts this session itself if it runs out of room\.$/);
  assert.deepEqual(Object.keys(w.engine._state.records), [], "no record for the refused calls");
  for (const trigger of ["user", "button"]) {
    const rec = await w.engine.create({ sessionId: "ses_p", trigger });
    assert.equal(rec.state, "generating", trigger);
    await settle();
    assert.equal(w.engine.get(rec.id).state, "ready", trigger);
  }
});

test("the agent's handoff tool still works for a plain session", async () => {
  const w = worldWith({}, { mode: "suggest" });
  const rec = await w.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.state, "ready");
});

// ---- successors are exempt from the live policy (durable provenance) ----------------------------------

const diskWith = (w, extra) => {
  w.disk.json = JSON.stringify({ version: 1, records: {}, links: {}, continuations: {}, fences: {}, held: {}, ...extra });
};

test("a handoff successor is never a task child: the armed trigger and the agent's tool both work for it", async () => {
  // a long-running monitor session that is itself a successor, with its predecessor's parent
  const w = createWorld({ mode: "auto" });
  w.addSession("ses_p", { parentID: "ses_root" });
  w.addWindow("proj", 3, "work", "ses_p");
  diskWith(w, { successors: { ses_p: true } });
  w.engine = w.build();
  await overBudgetTurn(w.engine, "ses_p");
  assert.equal(Object.values(w.engine._state.records)[0]?.state, "committed", "auto handoff is allowed");

  const s = createWorld({ mode: "suggest" });
  s.addSession("ses_p", { parentID: "ses_root" });
  diskWith(s, { successors: { ses_p: true } });
  s.engine = s.build();
  const rec = await s.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  assert.equal(rec.state, "ready");

  const orig = createWorld({ mode: "suggest" });
  orig.addSession("ses_p", { parentID: "ses_root" });
  orig.engine = orig.build();
  await assert.rejects(orig.engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY }), (e) => e.code === "subagent", "control: the same session without provenance is refused");
});

test("provenance is written at commit (replacement and branch), persisted, and survives the record retention", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession("ses_p", { parentID: "ses_root" });
  w.addWindow("proj", 3, "work", "ses_p");
  w.jobs = [{ childSessionID: "ses_p", completionOwner: "manta" }];
  w.engine = w.build();
  const r = await readyRecord(w);
  const out = await w.engine.start(r.id, { how: "clear", disposition: "send" });
  assert.equal(w.engine._state.successors[out.successorId], true);
  assert.equal(JSON.parse(w.disk.json).successors[out.successorId], true, "persisted with the link");
  // the records age out; the provenance does not
  w.clock += 400 * 24 * 3600_000;
  await w.engine.sweep();
  assert.equal(w.engine._state.records[r.id], undefined, "the record was pruned");
  assert.equal(w.engine._state.successors[out.successorId], true);
  assert.equal(w.build().get(r.id), null);
  assert.equal(JSON.parse(w.disk.json).successors[out.successorId], true);
});

test("provenance is backfilled at boot from the links and the committed records, and never from a handoff that did not commit", async () => {
  const w = createWorld({ mode: "off" });
  diskWith(w, {
    records: { hof_a: rec("hof_a", "A", "A1"), hof_b: { ...rec("hof_b", "B", "B1"), state: "failed" }, hof_s: { ...rec("hof_s", "S", "S1"), state: "starting" } },
    links: { A: link(null, "A1"), A1: link("A", "A2"), A2: link("A1", null), C: { branches: ["C1"] }, C1: { branchedFrom: "C", branches: [] } },
  });
  const engine = w.build();
  assert.deepEqual(Object.keys(engine._state.successors).sort(), ["A1", "A2", "C1"], "links[x].replaces / branchedFrom, and committed records' successorId");
  // the next persist carries it
  await engine.sweep();
  assert.deepEqual(Object.keys(JSON.parse(w.disk.json).successors).sort(), ["A1", "A2", "C1"]);
});

// ---- the one-time repair -------------------------------------------------------------------------

const T0 = 10_000_000; // when the successors were created
const rec = (id, from, to, created = T0) => ({ id, fromSessionId: from, successorId: to, kind: "replace", trigger: "agent", state: "committed", text: "", createdAt: 1, updatedAt: 1, internal: { successorCreatedAt: created } });
const link = (replaces, replacedBy) => ({ ...(replaces ? { replaces } : {}), ...(replacedBy ? { replacedBy } : {}), branches: [] });
const DRIVEN = T0 + 120_000; // the parent resumed the session two minutes after the handoff
/** The session's `user` records (what a parent resuming it through `task` posts) and `synthetic` ones (background results). */
const userAt = (w, sid, created) => w.timelines.set(sid, [...(w.timelines.get(sid) ?? []), { id: `msg_u_${sid}_${created}`, type: "user", time: { created } }]);
const resultAt = (w, sid, created) => w.timelines.set(sid, [...(w.timelines.get(sid) ?? []), { id: `msg_s_${sid}_${created}`, type: "synthetic", metadata: { source: "subagent", childID: "ses_c" }, time: { created } }]);

/**
 * Disk state:
 *   X  → X1 → X2   X an original subagent the parent resumed after the handoff (cantina "J early"); the X1 → X2 record was pruned
 *   Y  → Y1        Y a plain conversation (no parent)
 *   Z  → Z1        Z a delegate job's child, REPOINTED at commit (the job record names Z1 now), whatever its timeline
 *   W  → W1        W an original with a parent that only got background results after the handoff (a synthetic wake)
 *   U  → U1        U an original with a parent and no records after the handoff at all
 */
function repairWorld() {
  const w = createWorld({ mode: "off" });
  for (const [sid, props] of [
    ["X", { parentID: "ses_root" }], ["X1", { parentID: "ses_root", time: { created: T0 } }], ["X2", { parentID: "ses_root", time: { created: T0 + 5 } }],
    ["Y", {}], ["Y1", { time: { created: T0 } }],
    ["Z", { parentID: "ses_root" }], ["Z1", { parentID: "ses_root", time: { created: T0 } }],
    ["W", { parentID: "ses_root" }], ["W1", { time: { created: T0 } }],
    ["U", { parentID: "ses_root" }], ["U1", { time: { created: T0 } }],
  ]) w.addSession(sid, props);
  userAt(w, "X", DRIVEN);
  userAt(w, "X1", DRIVEN + 1); // a successor that was later driven: still Manta-made
  userAt(w, "Y", DRIVEN);
  userAt(w, "Z", DRIVEN);
  userAt(w, "W", T0 - 5); // before the handoff
  resultAt(w, "W", T0 + 30_000); // a background result woke it after: synthetic, not a parent resume
  w.jobs = [{ childSessionID: "Z1", completionOwner: "manta" }];
  diskWith(w, {
    records: { hof_x: rec("hof_x", "X", "X1"), hof_y: rec("hof_y", "Y", "Y1"), hof_z: rec("hof_z", "Z", "Z1"), hof_w: rec("hof_w", "W", "W1"), hof_u: rec("hof_u", "U", "U1") },
    links: { X: link(null, "X1"), X1: link("X", "X2"), X2: link("X1", null), Y: link(null, "Y1"), Y1: link("Y", null), Z: link(null, "Z1"), Z1: link("Z", null), W: link(null, "W1"), W1: link("W", null), U: link(null, "U1"), U1: link("U", null) },
  });
  w.changed = 0;
  w.engine = w.build({ onLinksChanged: () => void w.changed++ });
  return w;
}

test("repair: cuts only an ORIGINAL subagent the parent resumed (a user record after the handoff); successors, repointed delegate children, parentless and synthetic-only wakes keep their links", async () => {
  const w = repairWorld();
  const out = await w.engine.repairTaskChildLinks();
  assert.deepEqual(out, { split: 1, failed: 0 });
  const links = w.engine._state.links;
  assert.equal(links.X, undefined, "X is its own conversation again (its empty entry is dropped)");
  assert.deepEqual(links.X1, link(null, "X2"), "X1 → X2 stays: X1 is a Manta-made successor even though it has a parent and was driven (its record was pruned: provenance is what tells)");
  assert.deepEqual(links.X2, link("X1", null));
  assert.deepEqual(links.Y, link(null, "Y1"), "no parent");
  assert.deepEqual(links.Z, link(null, "Z1"), "the job record names the successor now: a repoint, not evidence");
  assert.deepEqual(links.W, link(null, "W1"), "a background result is synthetic: not a parent resume");
  assert.deepEqual(links.U, link(null, "U1"), "no evidence yet");
  assert.equal(Object.keys(w.engine._state.records).length, 5, "records are never touched");
  assert.equal(w.changed, 1, "the session graph is told once");
  const disk = JSON.parse(w.disk.json);
  assert.match(disk.repairs.taskChildLinks, /^\d{4}-\d\d-\d\dT/, "the marker (initial scan done) is persisted with the cut");
  assert.deepEqual(Object.keys(disk.repairs.pendingTaskLinks).sort(), ["U", "W"], "met a–c but not d: watched for a later resume");
  assert.equal(disk.repairs.pendingTaskLinks.W.succ, "W1");
  assert.equal(typeof disk.repairs.pendingTaskLinks.W.since, "number");
  assert.equal(disk.links.X, undefined);
  assert.equal(disk.successors.X1, true, "X1's provenance outlives the cut link");
  assert.equal(w.engine.successorOf("X"), null);
  assert.equal(w.engine.successorOf("X1"), "X2");
});

test("repair: a real repoint followed by a restart never cuts, whatever the pred's timeline says", async () => {
  // a delegate job's child C is handed off to C1; the job record is repointed to C1; the box restarts
  const w = createWorld({ mode: "off" });
  w.addSession("C", { parentID: "ses_root" });
  w.addSession("C1", { parentID: "ses_root", time: { created: T0 } });
  w.addWindow("proj", 3, "work", "C");
  userAt(w, "C", DRIVEN);
  w.jobs = [{ childSessionID: "C", completionOwner: "manta" }];
  w.engine = w.build();
  const r = await readyRecord(w, { sessionId: "C" });
  const out = await w.engine.start(r.id, { how: "clear", disposition: "send" });
  w.jobs = [{ childSessionID: out.successorId, completionOwner: "manta" }]; // what ownership.repoint did
  const reborn = w.build();
  assert.deepEqual(await reborn.repairTaskChildLinks(), { split: 0, failed: 0 });
  assert.equal(reborn.successorOf("C"), out.successorId);
  assert.equal(reborn._state.repairs.pendingTaskLinks, undefined, "and it is not even watched: criterion c failed");
});

test("repair: a user record must be AFTER the successor's creation (strictly); the creation time falls back to the successor session when the record is gone", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession("E", { parentID: "ses_root" });
  w.addSession("E1", { time: { created: T0 } });
  w.addSession("F", { parentID: "ses_root" });
  w.addSession("F1", { time: { created: T0 } });
  userAt(w, "E", T0); // at the creation instant: not after
  userAt(w, "F", T0 + 1);
  diskWith(w, { links: { E: link(null, "E1"), E1: link("E", null), F: link(null, "F1"), F1: link("F", null) } }); // no records at all
  w.engine = w.build();
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 1, failed: 0 });
  assert.deepEqual(w.engine._state.links.E, link(null, "E1"));
  assert.equal(w.engine._state.links.F, undefined);
  assert.deepEqual(Object.keys(w.engine._state.repairs.pendingTaskLinks), ["E"]);
  assert.ok(w.timelineReads.filter(([sid]) => sid === "E" || sid === "F").every(([, o]) => o.type === "user"), "only user records of the original are read");
});

test("repair: idempotent — a second run, and a run after a restart, read nothing and change nothing", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  let reads = 0;
  w.beforeRead = async () => void reads++;
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { skipped: true, split: 0, failed: 0 });
  const reborn = w.build();
  assert.deepEqual(await reborn.repairTaskChildLinks(), { skipped: true, split: 0, failed: 0 });
  assert.equal(reads, 0);
});

test("repair: anything unreadable leaves the link, the marker unset and the other cuts landed; the next run finishes", async () => {
  const w = repairWorld();
  w.addSession("V", { parentID: "ses_root" });
  w.addSession("V1", { time: { created: T0 } });
  userAt(w, "V", DRIVEN);
  w.engine._state.links.V = link(null, "V1");
  w.engine._state.links.V1 = link("V", null);
  w.unreadable.add("V"); // the predecessor
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 1, failed: 1 });
  assert.equal(w.engine._state.links.X, undefined, "the readable one was cut");
  assert.deepEqual(w.engine._state.links.V, link(null, "V1"), "the unreadable one is left");
  assert.equal(w.engine._state.repairs.taskChildLinks, undefined);
  assert.equal(JSON.parse(w.disk.json).repairs.taskChildLinks, undefined, "no marker on disk either");
  // …and so is a successor that can't be read when its creation time isn't recorded
  w.unreadable.clear();
  w.unreadable.add("V1");
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 0, failed: 1 });
  w.unreadable.clear();
  // …and so is the original's timeline
  w.failReads.add("V");
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 0, failed: 1 });
  assert.deepEqual(w.engine._state.links.V, link(null, "V1"));
  w.failReads.clear();
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 1, failed: 0 });
  assert.equal(w.engine._state.links.V, undefined);
  assert.ok(w.engine._state.repairs.taskChildLinks);
});

test("repair: a deleted successor or predecessor is settled (nothing to cut), not a failure", async () => {
  const w = createWorld({ mode: "off" });
  w.addSession("G", { parentID: "ses_root" }); // G1 was deleted
  userAt(w, "G", DRIVEN);
  w.addSession("H1", { time: { created: T0 } }); // H was deleted
  diskWith(w, { links: { G: link(null, "G1"), G1: link("G", null), H: link(null, "H1"), H1: link("H", null) } });
  w.engine = w.build();
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 0, failed: 0 });
  assert.ok(w.engine._state.repairs.taskChildLinks);
});

test("repair: an unreadable job store is no evidence — nothing is cut and the marker stays unset", async () => {
  const w = repairWorld();
  w.engine = w.build({ loadJobsStrict: async () => { throw new Error("jobs.json unreadable"); } });
  const out = await w.engine.repairTaskChildLinks();
  assert.equal(out.split, 0);
  assert.ok(out.failed >= 1);
  assert.deepEqual(w.engine._state.links.X, link(null, "X1"));
  assert.equal(w.engine._state.repairs.taskChildLinks, undefined);
});

test("repair: reads are bounded to 4 at a time and the marker is set even when there is nothing to cut", async () => {
  const w = createWorld({ mode: "off" });
  const links = {};
  for (let i = 0; i < 12; i++) {
    w.addSession(`P${i}`);
    w.addSession(`S${i}`);
    links[`P${i}`] = link(null, `S${i}`);
    links[`S${i}`] = link(`P${i}`, null);
  }
  w.disk.json = JSON.stringify({ version: 1, records: {}, links });
  let inflight = 0;
  let peak = 0;
  w.beforeRead = async () => {
    peak = Math.max(peak, ++inflight);
    await new Promise((r) => setImmediate(r));
    inflight--;
  };
  w.changed = 0;
  w.engine = w.build({ onLinksChanged: () => void w.changed++ });
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 0, failed: 0 });
  assert.equal(w.changed, 0, "nothing changed: the graph is not poked");
  assert.ok(w.engine._state.repairs.taskChildLinks);
  assert.equal(Object.keys(w.engine._state.links).length, 24);
  assert.equal(peak <= 4, true);
});

test("repair: a link that changed while the sessions were being read is left alone", async () => {
  const w = repairWorld();
  w.beforeRead = async (sid) => {
    if (sid === "X") {
      // X was handed off again in the meantime: its link now points elsewhere
      w.engine._state.links.X = link(null, "X9");
      w.beforeRead = null;
    }
  };
  const out = await w.engine.repairTaskChildLinks();
  assert.equal(out.split, 0);
  assert.deepEqual(w.engine._state.links.X, link(null, "X9"));
});

// ---- watched links: the periodic re-check (the initial scan only sees the past) ---------------------------

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

test("a parent that resumes the original AFTER the initial scan is caught by the next maintenance pass; a synthetic-only wake is not", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  assert.deepEqual(w.engine._state.links.W, link(null, "W1"));
  // another background result arrives (still synthetic): nothing changes, the link stays watched
  resultAt(w, "W", T0 + 90_000);
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.W, link(null, "W1"));
  assert.ok(w.engine._state.repairs.pendingTaskLinks.W);
  // the parent resumes W through `task`: a user record
  userAt(w, "W", T0 + 200_000);
  w.changed = 0;
  await w.engine.maintain();
  assert.equal(w.engine._state.links.W, undefined, "cut");
  assert.equal(w.engine.successorOf("W"), null);
  assert.deepEqual(Object.keys(w.engine._state.repairs.pendingTaskLinks), ["U"], "W is no longer watched");
  assert.equal(w.changed, 1, "the session graph is told");
  assert.equal(w.engine._state.successors.W1, true, "provenance is untouched");
  assert.equal(Object.keys(w.engine._state.records).length, 5, "records are untouched");
  const disk = JSON.parse(w.disk.json);
  assert.equal(disk.links.W, undefined);
  assert.deepEqual(Object.keys(disk.repairs.pendingTaskLinks), ["U"]);
});

test("watched links expire after 7 days, and a link that is gone or points elsewhere is dropped from the watch", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  w.engine._state.links.U = link(null, "U9"); // re-pointed meanwhile
  await w.engine.maintain();
  assert.deepEqual(Object.keys(w.engine._state.repairs.pendingTaskLinks), ["W"], "U no longer matches");
  w.clock += 8 * 24 * 3600_000;
  await w.engine.maintain();
  assert.equal(w.engine._state.repairs.pendingTaskLinks, undefined, "expired");
  assert.deepEqual(w.engine._state.links.W, link(null, "W1"), "expiry never cuts");
});

test("a re-check never cuts while a handoff of the chain is in flight (including `starting` after its fence is gone), and cuts once it is terminal", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  userAt(w, "W", T0 + 200_000); // the evidence is there
  const inFlight = { ...rec("hof_w1", "W1", "W2"), state: "starting" }; // the successor's own handoff, mid-commit: no fence left
  w.engine._state.records.hof_w1 = inFlight;
  await w.engine.maintain();
  assert.deepEqual(w.engine._state.links.W, link(null, "W1"), "busy: not cut");
  assert.ok(w.engine._state.repairs.pendingTaskLinks.W, "still watched");
  inFlight.state = "committed";
  await w.engine.maintain();
  assert.equal(w.engine._state.links.W, undefined);
});

test("a re-check queued behind a commit waits for the chain's exclusion and revalidates after it", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  userAt(w, "W", T0 + 200_000);
  // W1 (a successor) is handed off while the check runs: park the start inside its commit (which holds the chain's lock)
  w.addWindow("proj", 3, "work", "W1");
  const reached = gate();
  const release = gate();
  const starter = w.build({ hooks: { step: async (n) => { if (n === "attach") { reached.open(); await release.p; } } } });
  w.engine = starter;
  const r = await readyRecord(w, { sessionId: "W1", engine: starter });
  const started = starter.start(r.id, { how: "clear", disposition: "send" });
  await reached.p;
  const pass = starter.maintain();
  await settle();
  assert.deepEqual(starter._state.links.W, link(null, "W1"), "not cut while the commit holds the chain");
  release.open();
  await started;
  await pass;
  await settle();
  const succ2 = starter._state.records[r.id].successorId;
  assert.equal(starter._state.records[r.id].state, "committed");
  assert.equal(starter._state.links.W1.replacedBy, succ2, "the commit's own link is intact");
  // the pass that queued behind the commit saw its record still `starting` (the commit's last steps run after it let go of the
  // chain): busy, so not cut — the next pass, with the record committed, is the one that cuts
  await starter.maintain();
  assert.equal(starter.successorOf("W"), null, "cut once nothing of the chain is in flight, on fresh reads");
  assert.equal(starter._state.links.W1.replacedBy, succ2, "and the successor's own link survives the cut");
  assert.equal(starter._state.links.W1.replaces, undefined);
});

test("the periodic pass also runs from boot recovery", async () => {
  const w = repairWorld();
  await w.engine.repairTaskChildLinks();
  userAt(w, "W", T0 + 200_000);
  const reborn = w.build();
  await reborn.recover();
  await settle(10);
  assert.equal(reborn._state.links.W, undefined);
});
