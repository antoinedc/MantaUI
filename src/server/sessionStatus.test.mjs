import { test } from "node:test";
import assert from "node:assert/strict";
import { computeJobNesting, annotateJobs, sessionsWithActiveWork, deriveWindowStatus, runningChildCounts, createSessionStatus } from "./sessionStatus.mjs";

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

test("hydration does not wipe a turn that STARTED (or ended) while its active-list read was in flight", async () => {
  let release;
  const published = [];
  const st = createSessionStatus({
    publish: (e) => published.push(e),
    windowedSessionIds: () => ["p", "q"],
    loadJobs: async () => [],
    listActiveSessionIds: () => new Promise((resolve) => { release = () => resolve(["q"]); }), // the list: only q running
    getSessionParent: async () => ({ status: "ok", parentID: null }),
    runningSince: (id) => (id === "q" ? 111 : null),
    schedule: () => {},
    setTimer: () => {},
  });
  st.observe({ kind: "stream", sub: "running", sessionId: "q", payload: { running: true, since: 50 } }); // before: q running
  const done = st.hydrate();
  // While the read is in flight: p starts a turn, q's turn ends.
  st.observe({ kind: "stream", sub: "running", sessionId: "p", payload: { running: true, since: 200 } });
  st.observe({ kind: "stream", sub: "turnComplete", sessionId: "q", payload: { complete: true, running: false, since: null } });
  release();
  await done;
  assert.deepEqual([...st._state.running], ["p"], "p's live start survives, q's live end survives");
  assert.equal(st._state.own.get("p").since, 200);
  st.flush();
  const last = (sid) => published.filter((e) => e.sessionId === sid).at(-1).payload;
  assert.equal(last("p").running, true);
  assert.equal(last("p").startedAt, 200);
  assert.equal(last("q").running, false);
});

test("a hydrated running session gets its start time from the interpreter", async () => {
  const published = [];
  const st = createSessionStatus({
    publish: (e) => published.push(e),
    windowedSessionIds: () => ["p"],
    loadJobs: async () => [],
    listActiveSessionIds: async () => ["p"],
    getSessionParent: async () => ({ status: "ok", parentID: null }),
    runningSince: () => 777,
    schedule: () => {},
    setTimer: () => {},
  });
  await st.hydrate();
  st.flush();
  assert.equal(published.at(-1).payload.startedAt, 777);
});

test("rootIds is cleared at the start of each hydration (bounded)", async () => {
  const h = harness({ windowed: ["p"], active: ["c"], parents: { c: { status: "ok", parentID: null } } });
  h.st._state.rootIds.add("stale-root");
  await h.st.hydrate();
  assert.deepEqual([...h.st._state.rootIds], ["c", "p"], "the running set AND every windowed session are hydration candidates");
});

test("sessions.nesting: published once, AFTER the sync delta that carries the new nesting; never for activity-only changes", () => {
  const h = harness({ windowed: ["p"] });
  const proj = [mkProject("proj", [{ index: 0, opencodeSessionId: "p" }, { index: 1, opencodeSessionId: "c" }])];
  h.st.annotateProjects(proj); // baseline
  assert.equal(h.published.filter((e) => e.kind === "sessions.nesting").length, 0);
  h.st._state.jobs = [{ id: "j1", status: "running", parentSessionID: "p", childSessionID: "c", activity: "a" }];
  h.st.annotateProjects(proj);
  assert.equal(h.published.filter((e) => e.kind === "sessions.nesting").length, 0, "not before the list is readable");
  h.st.observe({ kind: "sync", payload: { changed: { projects: [] } } });
  assert.equal(h.published.filter((e) => e.kind === "sessions.nesting").length, 1);
  // Activity text changes: the nesting is the same → nothing.
  h.st._state.jobs = [{ id: "j1", status: "running", parentSessionID: "p", childSessionID: "c", activity: "b" }];
  h.st.annotateProjects(proj);
  h.st.observe({ kind: "sync", payload: { changed: { projects: [] } } });
  assert.equal(h.published.filter((e) => e.kind === "sessions.nesting").length, 1);
  // The job finishes: the nested window's job status changes → one more.
  h.st._state.jobs = [{ id: "j1", status: "done", parentSessionID: "p", childSessionID: "c" }];
  h.st.annotateProjects(proj);
  h.st.observe({ kind: "sync", payload: { changed: { projects: [] } } });
  assert.equal(h.published.filter((e) => e.kind === "sessions.nesting").length, 2);
});

test("direct-child counts are computed once per flush (runningChildCounts) and match deriveWindowStatus", () => {
  const m = { running: new Set(["a", "b"]), parentOf: new Map([["a", "p"], ["b", "p"], ["x", "p"]]), jobs: [], own: new Map(), stopped: new Set() };
  assert.equal(runningChildCounts(m).get("p"), 2);
  assert.equal(deriveWindowStatus(m, "p").subagents, 2);
});

// ---- the session graph (stage (a)): parentWindowIndex is a projection of the graph ----
const win = (index, sid, owner = "user") => ({ index, name: `w${index}`, opencodeSessionId: sid, owner });
const proj1 = (name, windows) => [{ tmuxSession: name, windows }];
const delegateRec = (id, child, parent, extra = {}) => ({ id, status: "running", origin: "delegate", completionOwner: "manta", childSessionID: child, parentSessionID: parent, ...extra });
const adoptedRec = (id, child, parent, extra = {}) => ({ id, status: "running", origin: "observed", completionOwner: "opencode", childSessionID: child, parentSessionID: parent, ...extra });
const flushAll = async (h) => {
  await h.st.settleBackground();
  await new Promise((r) => setImmediate(r));
  await h.st.settleBackground();
};

function graphHarness({ projects, parents = {}, jobRecords = [], chains = {}, succ = {}, refs = null, active = [], isCto, isInternal } = {}) {
  const calls = { parent: [], refs: [], changed: 0 };
  const clock = { t: 1_000_000 };
  const state = { projects, jobs: jobRecords, fail: false };
  const published = [];
  const windowedIds = () => state.projects.flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean));
  const h = { calls, clock, state, published };
  h.st = createSessionStatus({
    publish: (e) => published.push(e),
    windowedSessionIds: windowedIds,
    loadJobs: async () => state.jobs,
    listActiveSessionIds: async () => active,
    getSessionParent: async (id) => {
      calls.parent.push(id);
      if (state.fail) return { status: "error" };
      const p = typeof parents === "function" ? parents(id) : parents[id];
      return { status: "ok", parentID: p ?? null };
    },
    schedule: () => {},
    setTimer: () => {},
    chainOf: (sid) => chains[sid] ?? [sid],
    successorOf: (sid) => succ[sid] ?? null,
    findSessionReferences: refs ? async (a) => { calls.refs.push(a); return refs(a); } : undefined,
    isCtoConversationSession: isCto,
    isInternalSession: isInternal,
    now: () => clock.t,
    // the session list is re-read at once, as index.mjs's syncState.refreshNow does
    onJobsChanged: () => { calls.changed++; h.st.annotateProjects(state.projects); },
  });
  h.annotate = () => h.st.annotateProjects(state.projects);
  /** { windowIndex: parentWindowIndex } of every job window of project `name` (default: the first). */
  h.nesting = (name) => {
    const p = h.annotate().find((x) => (name ? x.tmuxSession === name : true));
    return Object.fromEntries(p.windows.filter((w) => w.job).map((w) => [w.index, w.job.parentWindowIndex]));
  };
  return h;
}

test("graph: before the first hydration the projection is exactly today's (display parents included)", async () => {
  const projects = proj1("p", [win(1, "driver"), win(2, "child")]);
  const rec = adoptedRec("j", "child", "gone", { displayParentID: "driver" });
  const h = graphHarness({ projects, jobRecords: [rec] });
  await h.st.refreshJobs();
  assert.deepEqual(h.nesting(), { 2: 1 }, "cold: today's displayParentID nesting");
  assert.equal(h.st._state.hydratedOnce, false);
  await h.st.hydrate();
  assert.deepEqual(h.nesting(), { 2: null }, "hydrated: the graph says the adopted row's opencode parent is a root, displayParentID is not read");
});

test("graph: property — for windowed parents the projection equals computeJobNesting over the existing fixtures", async () => {
  const fixtures = [
    [[win(0, "parent"), win(1, "child1"), win(2, "child2")], jobs],
    [[win(0, "parent"), win(3, "doneChild")], jobs],
    [[win(5, "orphanChild")], jobs],
    [[win(0, "parent")], jobs],
    [[win(0, "root"), win(1, "mid"), win(2, "leaf")], { b: { id: "b", status: "running", parentSessionID: "mid", childSessionID: "leaf" }, a: { id: "a", status: "running", parentSessionID: "root", childSessionID: "mid" } }],
    [[win(0, "root"), win(1, "mid")], { a: { id: "a", status: "running", parentSessionID: "mid", childSessionID: "root" }, b: { id: "b", status: "running", parentSessionID: "root", childSessionID: "mid" } }],
    [[win(1, "driver"), win(2, "child1"), win(3, "other")], { j: { id: "j", status: "running", parentSessionID: "other", childSessionID: "child1" } }],
    [[win(1, "driver"), win(2, "child1")], { old: { id: "old", status: "done", parentSessionID: "driver", childSessionID: "child1", supersededBy: "next" }, live: { id: "live", status: "running", parentSessionID: "driver", childSessionID: "child1" } }],
  ];
  const rows = (p) => p[0].windows.map((w) => w.job?.parentWindowIndex ?? "none");
  for (const [windows, records] of fixtures) {
    const projects = proj1("p", windows);
    const legacy = rows(annotateJobs(projects, Object.values(records)));
    const h = graphHarness({ projects, jobRecords: Object.values(records) });
    await h.st.hydrate();
    assert.deepEqual(rows(h.annotate()), legacy, "first pass");
    await flushAll(h);
    assert.deepEqual(rows(h.annotate()), legacy, "after the background reads");
  }
});

test("graph: A → B → C in three windows lifts both B and C to A", async () => {
  const projects = proj1("p", [win(0, "A"), win(1, "B"), win(2, "C")]);
  const h = graphHarness({ projects, jobRecords: [delegateRec("b", "B", "A"), delegateRec("c", "C", "B")] });
  await h.st.hydrate();
  assert.deepEqual(h.nesting(), { 1: 0, 2: 0 });
});

test("graph: a job under a windowless subagent nests under the windowed ancestor, whether or not the subagent has a window", async () => {
  const records = [delegateRec("j", "J", "S")];
  const parents = { S: "D", J: "S" };
  const noWin = graphHarness({ projects: proj1("p", [win(1, "D"), win(2, "J", "job")]), jobRecords: records, parents });
  await noWin.st.hydrate();
  assert.deepEqual(noWin.nesting(), { 2: 1 });
  const withWin = graphHarness({ projects: proj1("p", [win(1, "D"), win(2, "J", "job"), win(3, "S", "job")]), jobRecords: [...records, adoptedRec("s", "S", "D")], parents });
  await withWin.st.hydrate();
  assert.deepEqual(withWin.nesting(), { 2: 1, 3: 1 }, "the adopted subagent's window and its job both sit under D");
});

test("graph: a wrapped command record (manta-owned) is a rule-1 edge; an adopted record's parentSessionID is NOT read", async () => {
  const projects = proj1("p", [win(1, "P"), win(2, "cmd", "job"), win(3, "adopted", "job")]);
  const records = [delegateRec("c", "cmd", "P", { origin: "command" }), adoptedRec("a", "adopted", "P")];
  const h = graphHarness({ projects, jobRecords: records, parents: { cmd: null, adopted: null } });
  await h.st.refreshJobs();
  assert.deepEqual(h.nesting(), { 2: 1, 3: 1 }, "cold: today's output nests both under P");
  await h.st.hydrate();
  assert.deepEqual(h.nesting(), { 2: 1, 3: null }, "hydrated: the command is nested by its record; the adopted row's opencode parent is a root");
  const named = graphHarness({ projects, jobRecords: records, parents: { cmd: null, adopted: "P" } });
  await named.st.hydrate();
  assert.deepEqual(named.nesting(), { 2: 1, 3: 1 }, "an adopted row whose opencode parent is windowed still nests (rule 2)");
});

test("graph: a window in another project is not an ancestor; a cycle makes a root without looping", async () => {
  const cross = [{ tmuxSession: "p", windows: [win(1, "P")] }, { tmuxSession: "q", windows: [win(1, "J", "job")] }];
  const h = graphHarness({ projects: cross, jobRecords: [delegateRec("j", "J", "P")] });
  await h.st.hydrate();
  assert.deepEqual(h.nesting("q"), { 1: null });

  const cyc = graphHarness({
    projects: proj1("p", [win(1, "J", "job")]),
    jobRecords: [delegateRec("j", "J", "X")],
    parents: { X: "Y", Y: "X" },
  });
  await cyc.st.hydrate();
  assert.deepEqual(cyc.nesting(), { 1: null });
  const winCyc = graphHarness({ projects: proj1("p", [win(1, "A", "job"), win(2, "B", "job")]), jobRecords: [delegateRec("a", "A", "B"), delegateRec("b", "B", "A")] });
  await winCyc.st.hydrate();
  assert.deepEqual(winCyc.nesting(), { 1: null, 2: null });
});

test("graph: a handoff chain is one node — a job whose parent is the predecessor projects to the successor's window, and a commit moves nothing", async () => {
  const records = [delegateRec("j", "J", "pred")];
  // Before the commit: the predecessor has the window.
  const before = graphHarness({ projects: proj1("p", [win(1, "pred"), win(2, "J", "job")]), jobRecords: records });
  await before.st.hydrate();
  assert.deepEqual(before.nesting(), { 2: 1 });
  // After: the window is stamped with the successor; the record still names the predecessor.
  const chain = ["pred", "succ"];
  const after = graphHarness({
    projects: proj1("p", [win(1, "succ"), win(2, "J", "job")]),
    jobRecords: records,
    chains: { pred: chain, succ: chain },
    succ: { pred: "succ" },
  });
  await after.st.hydrate();
  assert.deepEqual(after.nesting(), { 2: 1 });
  after.annotate();
  const changedBefore = after.calls.changed;
  after.st.observe({ kind: "handoff", payload: { id: "h", fromSessionId: "pred", state: "committed" } });
  await flushAll(after);
  assert.equal(after.calls.changed, changedBefore, "a commit changes no projection → no list refresh");
  // The canonical member is the lowest-index windowed one when several members have windows.
  const two = ["P", "Q"];
  const dup = graphHarness({ projects: proj1("p", [win(3, "P"), win(1, "Q"), win(4, "J", "job")]), jobRecords: [delegateRec("j", "J", "P")], chains: { P: two, Q: two } });
  await dup.st.hydrate();
  assert.deepEqual(dup.nesting(), { 4: 1 });
});

test("graph: a session whose parent read failed keeps its last-known projection; a session nobody has read yet is not a root", async () => {
  const projects = proj1("p", [win(1, "D"), win(2, "J", "job")]);
  const h = graphHarness({ projects, jobRecords: [delegateRec("j", "J", "S")], parents: { S: "D", J: "S" } });
  await h.st.hydrate();
  assert.deepEqual(h.nesting(), { 2: 1 });
  // The edge S → D is lost (eviction) and the box cannot be read: unknown, so the old placement stands.
  h.st._state.parentOf.delete("S");
  h.st._state.rootIds.delete("S");
  h.state.fail = true;
  assert.deepEqual(h.nesting(), { 2: 1 }, "not demoted to a root");
  await flushAll(h);
  assert.deepEqual(h.nesting(), { 2: 1 }, "a failed background read changes nothing");
  h.state.fail = false;
  h.clock.t += 6000;
  h.annotate();
  await flushAll(h);
  assert.deepEqual(h.nesting(), { 2: 1 }, "the retry re-learned the edge");
  assert.ok(h.calls.parent.filter((s) => s === "S").length >= 2);
});

test("graph: a parent first seen after hydration is read in the background, then placed (until then: today's output)", async () => {
  const projects = proj1("p", [win(1, "D"), win(2, "J", "job")]);
  const h = graphHarness({ projects, jobRecords: [], parents: { S: "D" } });
  await h.st.hydrate();
  h.state.jobs = [delegateRec("j", "J", "S")];
  await h.st.refreshJobs();
  assert.deepEqual(h.nesting(), { 2: null }, "S is unknown: today's output (S has no window → top-level)");
  await flushAll(h);
  assert.equal(h.calls.changed, 1, "the list was refreshed once the read placed it");
  assert.deepEqual(h.nesting(), { 2: 1 });
});

// ---- rule 4: the inferred driver ----
function cantina({ withSubagentWindows = true, refs } = {}) {
  const base = [win(16, "D"), win(10, "J1", "job"), win(12, "J2", "job")];
  const subs = [win(1, "S1", "job"), win(2, "S2", "job")];
  const h = graphHarness({
    projects: proj1("cantina", withSubagentWindows ? [...base, ...subs] : base),
    jobRecords: [adoptedRec("s1", "S1", "R"), adoptedRec("s2", "S2", "R"), delegateRec("j1", "J1", "S1"), delegateRec("j2", "J2", "S2")],
    parents: { S1: "R", S2: "R", J1: "S1", J2: "S2" },
    refs: refs ?? ((a) => ({ hits: [{ target: "S1", sessionId: "D", t: 9 }, { target: "S2", sessionId: "D", t: 8 }], complete: true })),
  });
  h.setSubagentWindows = (on) => { h.state.projects = proj1("cantina", on ? [...base, ...subs] : base); };
  return h;
}

for (const withSubagentWindows of [true, false]) {
  test(`graph: the cantina scenario (subagent windows ${withSubagentWindows ? "present" : "absent"} at first) — jobs stay under the driver across 12 alternations of the subagent windows`, async () => {
    const h = cantina({ withSubagentWindows });
    await h.st.hydrate();
    h.annotate();
    await flushAll(h);
    assert.equal(h.calls.refs.length, 1, "one transcript lookup");
    assert.deepEqual(h.calls.refs[0].sessionIds, ["D"], "only windowed sessions that are not job children are candidates");
    assert.ok(["R", "S1", "S2"].every((t) => h.calls.refs[0].targets.includes(t)), "the root and the collapsed sessions below it are targets");
    assert.equal(h.calls.changed, 1, "the new inferred edge refreshed the list once");
    assert.equal(h.st._state.inferred.size, 1);
    let on = withSubagentWindows;
    for (let i = 0; i < 12; i++) {
      on = !on;
      h.setSubagentWindows(on);
      const n = h.nesting();
      assert.equal(n[10], 16, `J1 under D (round ${i}, subagent windows ${on})`);
      assert.equal(n[12], 16, `J2 under D (round ${i})`);
      if (on) {
        assert.equal(n[1], 16, "the adopted subagent's own window is under D");
        assert.equal(n[2], 16);
      }
      await flushAll(h);
    }
    assert.equal(h.calls.refs.length, 1, "the cached edge is never looked up again");
    assert.equal(h.calls.changed, 1, "nothing else triggered a list refresh");
  });
}

test("graph: an inferred edge is cached once and never revised; a later materialised user window on the root does not revoke it", async () => {
  let answer = "D";
  const h = graphHarness({
    projects: proj1("p", [win(1, "D"), win(2, "D2"), win(3, "J", "job")]),
    jobRecords: [delegateRec("j", "J", "R")],
    parents: { J: "R" },
    refs: () => ({ hits: [{ target: "R", sessionId: answer, t: 5 }], complete: true }),
  });
  await h.st.hydrate();
  h.annotate();
  await flushAll(h);
  assert.deepEqual(h.nesting(), { 3: 1 });
  answer = "D2";
  h.clock.t += 10 * 60_000;
  h.annotate();
  await flushAll(h);
  assert.equal(h.calls.refs.length, 1, "no second lookup");
  assert.deepEqual(h.nesting(), { 3: 1 }, "not revised");
  // The user materialises the root (a user-owned window for R) afterwards.
  h.state.projects = proj1("p", [win(1, "D"), win(2, "D2"), win(3, "J", "job"), win(4, "R", "user")]);
  assert.deepEqual(h.nesting(), { 3: 4 }, "the job now has a windowed ancestor of its own (R); the cached edge is untouched");
  assert.equal(h.st._state.inferred.size, 1);
});

test("graph: a user-opened root is never inferred under anything; an incomplete or failing lookup caches nothing; lookups are throttled per root", async () => {
  // A finished job window the user reopened (owner user) — a root the user opened.
  const userRoot = graphHarness({
    projects: proj1("p", [win(1, "D"), win(2, "R", "user")]),
    jobRecords: [adoptedRec("r", "R", null, { status: "done" })],
    refs: () => ({ hits: [{ target: "R", sessionId: "D", t: 5 }], complete: true }),
  });
  await userRoot.st.hydrate();
  userRoot.annotate();
  await flushAll(userRoot);
  assert.equal(userRoot.calls.refs.length, 0, "ineligible → no lookup at all");
  assert.deepEqual(userRoot.nesting(), { 2: null });

  let mode = "incomplete";
  const h = graphHarness({
    projects: proj1("p", [win(1, "D"), win(2, "J", "job")]),
    jobRecords: [delegateRec("j", "J", "R")],
    parents: { J: "R" },
    refs: () => {
      if (mode === "throw") throw new Error("db down");
      if (mode === "null") return null;
      return { hits: [{ target: "R", sessionId: "D", t: 5 }], complete: mode !== "incomplete" };
    },
  });
  await h.st.hydrate();
  h.annotate();
  await flushAll(h);
  assert.equal(h.calls.refs.length, 1);
  assert.equal(h.st._state.inferred.size, 0, "complete:false caches nothing");
  h.annotate();
  await flushAll(h);
  assert.equal(h.calls.refs.length, 1, "a second pass inside 60 s does not call the DB");
  for (const m of ["throw", "null"]) {
    mode = m;
    h.clock.t += 61_000;
    h.annotate();
    await flushAll(h);
    assert.equal(h.st._state.inferred.size, 0, `${m} caches nothing`);
  }
  assert.equal(h.calls.refs.length, 3, "one lookup per minute per root");
  mode = "ok";
  h.clock.t += 61_000;
  h.annotate();
  await flushAll(h);
  assert.equal(h.st._state.inferred.size, 1);
  assert.deepEqual(h.nesting(), { 2: 1 });
});

test("graph: a driver that descends from the root, or is itself a live job's child, is never chosen", async () => {
  const h = graphHarness({
    projects: proj1("p", [win(1, "D"), win(2, "X"), win(3, "K", "job"), win(4, "J", "job")]),
    jobRecords: [delegateRec("j", "J", "R"), delegateRec("k", "K", "Y")],
    parents: { J: "R", X: "R", K: "Y", Y: null },
    refs: () => ({
      hits: [
        { target: "R", sessionId: "X", t: 9 }, // X is a child of R: a cycle
        { target: "R", sessionId: "K", t: 8 }, // K is a live job's child
        { target: "R", sessionId: "D", t: 1 },
      ],
      complete: true,
    }),
  });
  await h.st.hydrate();
  h.annotate();
  await flushAll(h);
  assert.ok(!h.calls.refs[0].sessionIds.includes("K"), "a live job's child is never a candidate");
  assert.deepEqual(h.nesting(), { 3: null, 4: 1 }, "J nests under D, not under X (a child of R) or K (the newer hits)");
  assert.equal(h.st._state.inferred.size, 1, "only R was inferred");
});

test("graph: the CTO conversation and Manta-internal sessions are never nested by inference; a failing check fails closed without caching", async () => {
  const mk = (extra) =>
    graphHarness({
      projects: proj1("p", [win(1, "D"), win(2, "J", "job")]),
      jobRecords: [delegateRec("j", "J", "R")],
      parents: { J: "R" },
      refs: () => ({ hits: [{ target: "R", sessionId: "D", t: 5 }], complete: true }),
      ...extra,
    });
  for (const [label, extra] of [
    ["CTO conversation", { isCto: async (sid) => sid === "R", isInternal: async () => false }],
    ["internal session", { isCto: async () => false, isInternal: async (sid) => sid === "R" }],
  ]) {
    const h = mk(extra);
    await h.st.hydrate();
    h.annotate();
    await flushAll(h);
    assert.equal(h.calls.refs.length, 0, `${label}: no transcript lookup`);
    assert.equal(h.st._state.inferred.size, 0, `${label}: nothing cached`);
    assert.equal(h.st._state.eligibility.get("R"), false, `${label}: decided once`);
    assert.deepEqual(h.nesting(), { 2: null });
    h.clock.t += 10 * 60_000;
    h.annotate();
    await flushAll(h);
    assert.equal(h.calls.refs.length, 0, `${label}: never asked again`);
  }

  let broken = true;
  const h = mk({ isCto: async () => { if (broken) throw new Error("store down"); return false; }, isInternal: async () => false });
  await h.st.hydrate();
  h.annotate();
  await flushAll(h);
  assert.equal(h.calls.refs.length, 0, "a throwing check: no lookup this pass");
  assert.equal(h.st._state.eligibility.get("R"), true, "eligibility is not decided against the root by a failed check");
  assert.deepEqual(h.nesting(), { 2: null });
  broken = false;
  h.clock.t += 61_000;
  h.annotate();
  await flushAll(h);
  assert.equal(h.calls.refs.length, 1, "a later pass with a working check proceeds");
  assert.deepEqual(h.nesting(), { 2: 1 });
});
