// A `task` subagent never hands off into a successor (its parent addresses it by session id), and the one-time
// repair of the links such handoffs left behind. Spec: 2026-11-08-background-results-and-viewer-windows.md §A.
import { test } from "node:test";
import assert from "node:assert/strict";
import { completionOwnerOf } from "../delegate.mjs";
import { HandoffError } from "./engine.mjs";
import { isTaskChild, jobCompletionOwner, SUBAGENT_HANDOFF_MESSAGE } from "./taskChild.mjs";
import { FULL_BODY, createWorld, settle } from "./testWorld.mjs";

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

// ---- the one-time repair -------------------------------------------------------------------------

const rec = (id, from, to) => ({ id, fromSessionId: from, successorId: to, kind: "replace", trigger: "agent", state: "committed", text: "", createdAt: 1, updatedAt: 1, internal: {} });
const link = (replaces, replacedBy) => ({ ...(replaces ? { replaces } : {}), ...(replacedBy ? { replacedBy } : {}), branches: [] });

/** Disk state: X → X1 → X2 (X a subagent), Y → Y1 → Y2 (Y1 carries the parent of a Manta-made successor), Z → Z1 (a delegate job's child). */
function repairWorld() {
  const w = createWorld({ mode: "off" });
  w.addSession("X", { parentID: "ses_root" });
  w.addSession("X1", { parentID: "ses_root" });
  w.addSession("X2", { parentID: "ses_root" });
  w.addSession("Y");
  w.addSession("Y1", { parentID: "ses_root" });
  w.addSession("Y2", { parentID: "ses_root" });
  w.addSession("Z", { parentID: "ses_root" });
  w.addSession("Z1", { parentID: "ses_root" });
  w.jobs = [{ childSessionID: "Z", completionOwner: "manta" }];
  w.disk.json = JSON.stringify({
    version: 1,
    records: { hof_x: rec("hof_x", "X", "X1"), hof_x1: rec("hof_x1", "X1", "X2"), hof_y: rec("hof_y", "Y", "Y1"), hof_y1: rec("hof_y1", "Y1", "Y2"), hof_z: rec("hof_z", "Z", "Z1") },
    links: { X: link(null, "X1"), X1: link("X", "X2"), X2: link("X1", null), Y: link(null, "Y1"), Y1: link("Y", "Y2"), Y2: link("Y1", null), Z: link(null, "Z1"), Z1: link("Z", null) },
    continuations: {},
    fences: {},
    held: {},
  });
  w.changed = 0;
  w.engine = w.build({ onLinksChanged: () => void w.changed++ });
  return w;
}

test("repair: cuts only links whose predecessor is an ORIGINAL task child; Manta-made successors and delegate children keep theirs", async () => {
  const w = repairWorld();
  const out = await w.engine.repairTaskChildLinks();
  assert.deepEqual(out, { split: 1, failed: 0 });
  const links = w.engine._state.links;
  assert.equal(links.X, undefined, "X is its own conversation again (its empty entry is dropped)");
  assert.deepEqual(links.X1, link(null, "X2"), "X1 → X2 stays: X1 is a Manta-made successor, never addressed by a parent");
  assert.deepEqual(links.X2, link("X1", null));
  assert.deepEqual(links.Y, link(null, "Y1"), "a session without a parent");
  assert.deepEqual(links.Y1, link("Y", "Y2"), "a Manta-made successor that copied a parent");
  assert.deepEqual(links.Z, link(null, "Z1"), "a delegate job's child is repointed at commit");
  assert.equal(Object.keys(w.engine._state.records).length, 5, "records are never touched");
  assert.equal(w.changed, 1, "the session graph is told once");
  const disk = JSON.parse(w.disk.json);
  assert.match(disk.repairs.taskChildLinks, /^\d{4}-\d\d-\d\dT/, "the marker is persisted with the cut");
  assert.equal(disk.links.X, undefined);
  assert.equal(w.engine.successorOf("X"), null);
  assert.equal(w.engine.successorOf("X1"), "X2");
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

test("repair: a link whose predecessor can't be read stays and keeps the marker unset, other cuts still land, the next run finishes", async () => {
  const w = repairWorld();
  w.addSession("W", { parentID: "ses_root" });
  w.addSession("W1");
  w.engine._state.links.W = link(null, "W1");
  w.engine._state.links.W1 = link("W", null);
  w.unreadable.add("W");
  const first = await w.engine.repairTaskChildLinks();
  assert.deepEqual(first, { split: 1, failed: 1 });
  assert.equal(w.engine._state.links.X, undefined, "the readable one was cut");
  assert.deepEqual(w.engine._state.links.W, link(null, "W1"), "the unreadable one is left");
  assert.equal(w.engine._state.repairs.taskChildLinks, undefined);
  assert.equal(JSON.parse(w.disk.json).repairs.taskChildLinks, undefined, "no marker on disk either");
  w.unreadable.clear();
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 1, failed: 0 });
  assert.equal(w.engine._state.links.W, undefined);
  assert.ok(w.engine._state.repairs.taskChildLinks);
});

test("repair: an unreadable job store counts as a failure for every parented predecessor — nothing is cut, no marker", async () => {
  const w = repairWorld();
  w.engine = w.build({ loadJobs: async () => { throw new Error("jobs.json unreadable"); } });
  assert.deepEqual(await w.engine.repairTaskChildLinks(), { split: 0, failed: 2 }, "X and Z both have a parent");
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
  assert.equal(peak, 4);
  assert.equal(w.changed, 0, "nothing changed: the graph is not poked");
  assert.ok(w.engine._state.repairs.taskChildLinks);
  assert.equal(Object.keys(w.engine._state.links).length, 24);
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
