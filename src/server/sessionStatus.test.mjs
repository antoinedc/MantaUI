import { test } from "node:test";
import assert from "node:assert/strict";
import { computeJobNesting, annotateJobs, sessionsWithActiveWork, deriveWindowStatus, createSessionStatus } from "./sessionStatus.mjs";

const mkProject = (name, windows) => ({ tmuxSession: name, windows });

// ---- nesting (ported from the desktop's chatUtils tests) ----
const jobs = {
  child1: { id: "j1", status: "running", parentSessionID: "parent", childSessionID: "child1" },
  child2: { id: "j2", status: "running", parentSessionID: "parent", childSessionID: "child2" },
  doneJob: { id: "j3", status: "done", parentSessionID: "parent", childSessionID: "doneChild" },
  orphanJob: { id: "j4", status: "running", parentSessionID: "goneParent", childSessionID: "orphanChild" },
};

test("nesting: running job children nest under their parent window and are hidden from the top level", () => {
  const p = mkProject("p", [{ index: 0, opencodeSessionId: "parent" }, { index: 1, opencodeSessionId: "child1" }, { index: 2, opencodeSessionId: "child2" }]);
  const res = computeJobNesting(p, jobs);
  assert.deepEqual([...res.hidden], [1, 2]);
  assert.deepEqual(res.children.get(0), [1, 2]);
});

test("nesting: a terminal job stays nested; a job whose parent window is gone stays top-level; foreign jobs are ignored", () => {
  const nested = computeJobNesting(mkProject("p", [{ index: 0, opencodeSessionId: "parent" }, { index: 3, opencodeSessionId: "doneChild" }]), jobs);
  assert.ok(nested.hidden.has(3));
  assert.equal(computeJobNesting(mkProject("p", [{ index: 5, opencodeSessionId: "orphanChild" }]), jobs).hidden.has(5), false);
  const none = computeJobNesting(mkProject("p", [{ index: 0, opencodeSessionId: "parent" }]), jobs);
  assert.equal(none.hidden.size + none.children.size, 0);
});

test("nesting: the display parent wins, a nested parent is lifted to the top-level ancestor, a cycle stays top-level", () => {
  const p = mkProject("p", [{ index: 0, opencodeSessionId: "root" }, { index: 1, opencodeSessionId: "mid" }, { index: 2, opencodeSessionId: "leaf" }]);
  const lifted = computeJobNesting(p, {
    a: { status: "running", parentSessionID: "x", displayParentID: "root", childSessionID: "mid" },
    b: { status: "running", parentSessionID: "mid", childSessionID: "leaf" },
  });
  assert.deepEqual(lifted.children.get(0), [1, 2]);
  const cyc = computeJobNesting(p, {
    a: { status: "running", parentSessionID: "mid", childSessionID: "root" },
    b: { status: "running", parentSessionID: "root", childSessionID: "mid" },
  });
  assert.equal(cyc.hidden.size, 0);
});

test("annotateJobs: windows carry job {id, status, parentWindowIndex}; others null", () => {
  const out = annotateJobs([mkProject("p", [{ index: 0, opencodeSessionId: "parent" }, { index: 1, opencodeSessionId: "child1" }, { index: 5, opencodeSessionId: "orphanChild" }, { index: 6 }])], Object.values(jobs));
  const w = out[0].windows;
  assert.equal(w[0].job, null);
  assert.deepEqual(w[1].job, { id: "j1", status: "running", parentWindowIndex: 0 });
  assert.deepEqual(w[2].job, { id: "j4", status: "running", parentWindowIndex: null }, "a job window whose parent is gone stays top-level");
  assert.equal(w[3].job, null);
  assert.equal(annotateJobs([mkProject("p", [{ index: 0, opencodeSessionId: "x", job: "stale" }])], [])[0].windows[0].job, null);
});

test("nesting: a job row nests by displayParentID ?? parentSessionID; superseded records are invisible", () => {
  const projects = mkProject("p", [{ index: 1, opencodeSessionId: "driver" }, { index: 2, opencodeSessionId: "child1" }, { index: 3, opencodeSessionId: "other" }]);
  const base = { status: "running", parentSessionID: "old", childSessionID: "child1" };
  const a = computeJobNesting(projects, { j: { ...base, displayParentID: "driver" } });
  assert.deepEqual(a.children.get(1), [2]);
  assert.deepEqual([...a.hidden], [2]);
  const b = computeJobNesting(projects, { j: { ...base, parentSessionID: "other", displayParentID: "driver" } });
  assert.deepEqual(b.children.get(1), [2]);
  assert.equal(b.children.has(3), false);
  assert.deepEqual(computeJobNesting(projects, { j: { ...base, parentSessionID: "other", displayParentID: null } }).children.get(3), [2]);
  assert.equal(computeJobNesting(projects, { j: base }).children.size, 0, "a windowless real parent leaves the row top-level");
  const old = { status: "done", parentSessionID: "driver", childSessionID: "child1", supersededBy: "next" };
  assert.equal(computeJobNesting(projects, { old }).children.size, 0);
  assert.deepEqual(computeJobNesting(projects, { old, live: { status: "running", parentSessionID: "driver", childSessionID: "child1" } }).children.get(1), [2]);
});

// ---- busy beneath (ported) ----
test("active work: running sessions plus every ancestor; empty when idle; terminates on a cycle", () => {
  assert.deepEqual([...sessionsWithActiveWork(["grandchild"], { grandchild: "child", child: "root" }, {})].sort(), ["child", "grandchild", "root"]);
  assert.equal(sessionsWithActiveWork([], { c: "p" }, {}).size, 0);
  assert.deepEqual([...sessionsWithActiveWork(["a"], { a: "b", b: "a" }, {})].sort(), ["a", "b"]);
});

test("active work: a running job rolls up to its display parent, not the windowless real parent; superseded running records are ignored", () => {
  const base = { status: "running", parentSessionID: "old", childSessionID: "child1" };
  assert.deepEqual([...sessionsWithActiveWork([], { child1: "old" }, { j: { ...base, displayParentID: "driver" } })].sort(), ["child1", "driver"]);
  assert.deepEqual([...sessionsWithActiveWork([], { child1: "old" }, { j: base })].sort(), ["child1", "old"]);
  assert.equal(sessionsWithActiveWork([], {}, { j: { ...base, supersededBy: "n" } }).size, 0);
});

test("active work: a running job marks child and parent; finished jobs do not; a mid-start job keeps the parent busy", () => {
  const run = sessionsWithActiveWork([], {}, { j: { status: "running", parentSessionID: "parent", childSessionID: "jobChild" } });
  assert.ok(run.has("jobChild") && run.has("parent"));
  assert.equal(sessionsWithActiveWork([], {}, { j: { status: "done", parentSessionID: "parent", childSessionID: "jobChild" } }).size, 0);
  assert.deepEqual([...sessionsWithActiveWork([], {}, { j: { status: "running", parentSessionID: "parent", childSessionID: null } })], ["parent"]);
});

// ---- the aggregator ----
function harness({ windowed = ["p", "c", "g"], active = [], parents = {}, jobRecords = [], stopped = [] } = {}) {
  const published = [];
  const calls = { parent: [], active: 0 };
  const timers = [];
  let jobsNow = jobRecords;
  const st = createSessionStatus({
    publish: (e) => published.push(e),
    windowedSessionIds: () => windowed,
    loadJobs: async () => jobsNow,
    loadStopped: async () => stopped,
    listActiveSessionIds: async () => { calls.active++; if (active instanceof Error) throw active; return active; },
    getSessionParent: async (id) => { calls.parent.push(id); const r = typeof parents === "function" ? parents(id) : parents[id]; return r ?? { status: "ok", parentID: null }; },
    schedule: () => {},
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  const frames = (sid) => published.filter((e) => e.sessionId === sid).map((e) => e.payload);
  return { st, published, calls, timers, frames, setJobs: (j) => { jobsNow = j; } };
}
const stream = (sub, sessionId, payload) => ({ kind: "stream", sub, sessionId, payload });
const last = (h, sid) => h.frames(sid).at(-1);

test("emits one frame per CHANGED payload only (coalesced), ancestors included", () => {
  const h = harness();
  h.st.observe(stream("childSession", "p", { childSessionId: "c", parentSessionId: "p" }));
  h.st.flush();
  assert.equal(h.published.length, 3, "first flush reports every windowed session once");
  h.st.flush();
  assert.equal(h.published.length, 3, "nothing changed → nothing emitted");
  h.st.observe(stream("running", "c", { running: true, type: "busy", since: 100 }));
  h.st.flush();
  assert.deepEqual(last(h, "c"), { running: true, busy: true, startedAt: 100, attention: null, subagents: 0, stopped: false });
  assert.equal(last(h, "p").busy, true, "a child starting flips its parent's busy");
  assert.equal(last(h, "p").subagents, 1);
  assert.equal(h.published.length, 5, "only the two sessions that changed");
});

test("a task tool that completed after launching background work: the parent stays busy with subagents:1 until the child's OWN turnComplete", () => {
  const h = harness();
  h.st.observe(stream("childSession", "p", { childSessionId: "c", parentSessionId: "p" }));
  h.st.observe(stream("running", "p", { running: true, since: 1 }));
  h.st.observe(stream("running", "c", { running: true, since: 2 }));
  // The parent's task tool completes (the interpreter's liveChildStatus goes idle) and the parent's own turn ends.
  h.st.observe(stream("toolEnded", "p", { idx: "t", ok: true }));
  h.st.observe(stream("turnComplete", "p", { complete: true, running: false, since: null }));
  h.st.flush();
  assert.equal(last(h, "p").running, false, "parent idle before the child completes");
  assert.equal(last(h, "p").busy, true);
  assert.equal(last(h, "p").subagents, 1);
  h.st.observe(stream("turnComplete", "c", { complete: true, running: false, since: null }));
  h.st.flush();
  assert.equal(last(h, "p").busy, false);
  assert.equal(last(h, "p").subagents, 0);
});

test("a windowless grandchild running keeps its windowed grandparent busy (any depth)", () => {
  const h = harness({ windowed: ["g"] });
  h.st.observe(stream("childSession", "g", { childSessionId: "mid", parentSessionId: "g" }));
  h.st.observe(stream("childSession", "mid", { childSessionId: "leaf", parentSessionId: "mid" }));
  h.st.observe(stream("running", "leaf", { running: true, since: 5 }));
  h.st.flush();
  assert.equal(last(h, "g").busy, true);
  assert.equal(last(h, "g").subagents, 0, "subagents counts DIRECT children only (mid is idle)");
});

test("busy through a running delegate job (and its display parent)", () => {
  const h = harness({ windowed: ["p"], jobRecords: [{ id: "j", status: "running", parentSessionID: "p", childSessionID: "jc" }] });
  h.st._state.jobs = [{ id: "j", status: "running", parentSessionID: "p", childSessionID: "jc" }];
  h.st.observe(stream("running", "jc", { running: true, since: 1 }));
  h.st.flush();
  assert.equal(last(h, "p").busy, true);
  assert.equal(last(h, "p").subagents, 1);
});

test("attention and stopped ride the payload; the attention latch is the interpreter's", () => {
  const h = harness({ windowed: ["p"], stopped: ["p"] });
  h.st._state.stopped = ["p"];
  h.st.observe(stream("attention", "p", { kind: "question" }));
  h.st.flush();
  assert.equal(last(h, "p").attention, "question");
  assert.equal(last(h, "p").stopped, true);
  h.st.observe(stream("attention", "p", { kind: null }));
  h.st.flush();
  assert.equal(last(h, "p").attention, null);
});

test("hydration after a reconnect with NO open chat rebuilds running + ancestry from opencode's own reads", async () => {
  const h = harness({ windowed: ["p"], active: ["leaf"], parents: { leaf: { status: "ok", parentID: "mid" }, mid: { status: "ok", parentID: "p" }, p: { status: "ok", parentID: null } } });
  assert.equal(await h.st.hydrate(), true);
  h.st.flush();
  assert.equal(last(h, "p").busy, true, "the windowed ancestor is busy though nothing was open or in memory");
  assert.deepEqual([...h.st._state.parentOf], [["leaf", "mid"], ["mid", "p"]]);
});

test("an active grandchild whose parent is far older than any listing page, with a windowless child elsewhere: the ancestry walk (not a listing) keeps the ancestor busy", async () => {
  const ancient = (id) => (id === "gc" ? { status: "ok", parentID: "child-other-dir" } : id === "child-other-dir" ? { status: "ok", parentID: "ancient-root" } : { status: "ok", parentID: null });
  const h = harness({ windowed: ["ancient-root"], active: ["gc"], parents: ancient });
  await h.st.hydrate();
  h.st.flush();
  assert.equal(last(h, "ancient-root").busy, true);
});

test("a running delegate job's child is hydrated too even when it is not in the active list", async () => {
  const h = harness({ windowed: ["p"], active: [], jobRecords: [{ id: "j", status: "running", parentSessionID: "p", childSessionID: "jc" }], parents: { jc: { status: "ok", parentID: "p" } } });
  await h.st.hydrate();
  assert.ok(h.calls.parent.includes("jc"));
});

test("getSessionParent ERROR during hydration: edges kept, a retry is scheduled on the backoff, nothing cleared", async () => {
  const h = harness({ windowed: ["p"], active: ["c"], parents: () => ({ status: "error" }) });
  h.st._state.parentOf.set("known", "p");
  h.st._state.running.add("old");
  assert.equal(await h.st.hydrate(), false);
  assert.equal(h.st._state.parentOf.get("known"), "p");
  assert.equal(h.st._state.retryScheduled, true);
  assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  await h.timers[0].fn();
  await h.st.hydrate();
  assert.equal(h.timers.at(-1).ms, 2000, "the next failure backs off");
});

test("an active list that cannot be read keeps the running set; not-found removes exactly that edge", async () => {
  const bad = harness({ windowed: ["p"], active: new Error("down") });
  bad.st._state.running.add("c");
  assert.equal(await bad.st.hydrate(), false);
  assert.ok(bad.st._state.running.has("c"), "absence of an answer is not evidence the session stopped");

  const h = harness({ windowed: ["p"], active: ["c"], parents: { c: { status: "not-found" } } });
  h.st._state.parentOf.set("c", "p");
  h.st._state.parentOf.set("other", "p");
  await h.st.hydrate();
  assert.equal(h.st._state.parentOf.has("c"), false);
  assert.equal(h.st._state.parentOf.get("other"), "p", "other edges are untouched");
});

test("the active list is a COMPLETE set: hydration replaces, it does not merge", async () => {
  const h = harness({ windowed: ["p"], active: ["a"] });
  h.st._state.running.add("stale");
  await h.st.hydrate();
  assert.deepEqual([...h.st._state.running], ["a"]);
});

test("snapshot replay is a full replacement of every windowed session; the map channel matches it", () => {
  const h = harness({ windowed: ["p", "c"] });
  h.st.observe(stream("running", "p", { running: true, since: 9 }));
  const frames = h.st.snapshotFrames();
  assert.deepEqual(frames.map((f) => f.sessionId).sort(), ["c", "p"]);
  assert.ok(frames.every((f) => f.kind === "stream" && f.sub === "windowStatus"));
  const map = h.st.windowStatusMap();
  assert.deepEqual(Object.keys(map).sort(), ["c", "p"]);
  assert.deepEqual(map.c, { running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false });
});

test("runningSet replaces the running set; delegate.updated re-reads jobs and tells the list; the status poller's own frames are ignored", async () => {
  let changed = 0;
  const h = harness({ windowed: ["p"] });
  h.st.observe(stream("running", "x", { running: true }));
  h.st.observe({ kind: "runningSet", payload: { sessions: [{ sessionId: "p", since: 7 }] } });
  assert.deepEqual([...h.st._state.running], ["p"]);
  h.st.observe({ kind: "stream", sub: "windowStatus", sessionId: "p", payload: {} });
  assert.equal(h.st._state.running.size, 1);
  const h2 = createSessionStatus({ publish: () => {}, windowedSessionIds: () => [], loadJobs: async () => [{ id: "j" }], listActiveSessionIds: async () => [], getSessionParent: async () => ({ status: "ok", parentID: null }), schedule: () => {}, onJobsChanged: () => { changed++; } });
  h2.observe({ kind: "delegate.updated", payload: { id: "j" } });
  await new Promise((r) => setImmediate(r));
  await h2.settled();
  assert.equal(changed, 1);
  assert.equal(h2._state.jobs.length, 1);
  // An activity-only update (same ids/statuses/windows) does not re-read the session list.
  h2.observe({ kind: "delegate.updated", payload: { id: "j" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(changed, 1);
});

test("deriveWindowStatus is pure over the maps", () => {
  const out = deriveWindowStatus({ running: new Set(["c"]), parentOf: new Map([["c", "p"]]), jobs: [], own: new Map(), stopped: new Set() }, "p");
  assert.equal(out.subagents, 1);
  assert.equal(out.busy, true);
});

test("edges are evicted beyond the bound, keeping running/windowed sessions' chains", () => {
  const h = harness({ windowed: ["w"] });
  h.st._state.running.add("r");
  h.st._state.parentOf.set("r", "rp");
  h.st._state.parentOf.set("w", "wp");
  for (let i = 0; i < 5100; i++) h.st._state.parentOf.set(`idle${i}`, "x");
  h.st.observe(stream("childSession", "p", { childSessionId: "n", parentSessionId: "p" }));
  assert.ok(h.st._state.parentOf.size <= 5000);
  assert.equal(h.st._state.parentOf.get("r"), "rp");
  assert.equal(h.st._state.parentOf.get("w"), "wp");
});
