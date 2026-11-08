import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("nesting: a nested parent is lifted to the top-level ancestor, a cycle stays top-level", () => {
  const p = mkProject("p", [{ index: 0, opencodeSessionId: "root" }, { index: 1, opencodeSessionId: "mid" }, { index: 2, opencodeSessionId: "leaf" }]);
  const lifted = computeJobNesting(p, {
    a: { status: "running", parentSessionID: "root", childSessionID: "mid" },
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

test("nesting: a job row nests by parentSessionID; a retired displayParentID is ignored; superseded records are invisible", () => {
  const projects = mkProject("p", [{ index: 1, opencodeSessionId: "driver" }, { index: 2, opencodeSessionId: "child1" }, { index: 3, opencodeSessionId: "other" }]);
  const base = { status: "running", parentSessionID: "old", childSessionID: "child1" };
  const a = computeJobNesting(projects, { j: { ...base, parentSessionID: "driver" } });
  assert.deepEqual(a.children.get(1), [2]);
  assert.deepEqual([...a.hidden], [2]);
  const b = computeJobNesting(projects, { j: { ...base, parentSessionID: "other", displayParentID: "driver" } });
  assert.deepEqual(b.children.get(3), [2], "displayParentID is not read");
  assert.equal(b.children.has(1), false);
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

test("active work: a running job rolls up through the graph's edges; a retired displayParentID is not read; superseded running records are ignored", () => {
  const base = { status: "running", parentSessionID: "old", childSessionID: "child1" };
  assert.deepEqual([...sessionsWithActiveWork([], { child1: "old" }, { j: { ...base, displayParentID: "driver" } })].sort(), ["child1", "old"]);
  assert.deepEqual([...sessionsWithActiveWork([], {}, { j: { ...base, displayParentID: "driver" } })].sort(), ["child1", "old"], "no edge held: the record's parent");
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
  assert.equal(last(h, "g").subagents, 1, "subagents counts running descendants at ANY depth (mid is idle, leaf is running)");
});

test("busy through a running delegate job", () => {
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
  const retries = () => h.timers.filter((t) => t.ms < 30_000); // (a session that stopped running also arms a linger timer)
  assert.deepEqual(retries().map((t) => t.ms), [1000]);
  await retries()[0].fn();
  await h.st.hydrate();
  assert.equal(retries().at(-1).ms, 2000, "the next failure backs off");
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

function graphHarness({ projects, parents = {}, jobRecords = [], chains = {}, succ = {}, active = [], isCto, isInternal, links = {} } = {}) {
  const calls = { parent: [], changed: 0 };
  const clock = { t: 1_000_000 };
  const state = { projects, jobs: jobRecords, fail: false, links };
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
    linkOf: (sid) => state.links[sid],
    linkEndpoints: () => Object.entries(state.links).flatMap(([c, l]) => [c, l.parent].filter(Boolean)),
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

test("graph: before the first hydration the projection is the record's parentSessionID; hydrated, the graph decides (an adopted record is no edge source)", async () => {
  const projects = proj1("p", [win(1, "driver"), win(2, "child")]);
  const rec = adoptedRec("j", "child", "driver", { displayParentID: "other" });
  const h = graphHarness({ projects, jobRecords: [rec] });
  await h.st.refreshJobs();
  assert.deepEqual(h.nesting(), { 2: 1 }, "cold: parentSessionID nesting; displayParentID is not read");
  assert.equal(h.st._state.hydratedOnce, false);
  await h.st.hydrate();
  assert.deepEqual(h.nesting(), { 2: null }, "hydrated: the graph says the adopted row's opencode parent is a root");
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

// ---- no inferred edge: a root nobody linked stays a root ----
function cantina({ withSubagentWindows = true, links } = {}) {
  const base = [win(16, "D"), win(10, "J1", "job"), win(12, "J2", "job")];
  const subs = [win(1, "S1", "job"), win(2, "S2", "job")];
  const h = graphHarness({
    projects: proj1("cantina", withSubagentWindows ? [...base, ...subs] : base),
    jobRecords: [adoptedRec("s1", "S1", "R"), adoptedRec("s2", "S2", "R"), delegateRec("j1", "J1", "S1"), delegateRec("j2", "J2", "S2")],
    parents: { S1: "R", S2: "R", J1: "S1", J2: "S2" },
    links,
  });
  h.setSubagentWindows = (on) => { h.state.projects = proj1("cantina", on ? [...base, ...subs] : base); };
  return h;
}

for (const withSubagentWindows of [true, false]) {
  test(`graph: the cantina scenario with a session_link (subagent windows ${withSubagentWindows ? "present" : "absent"} at first) — jobs stay under the driver across 12 alternations of the subagent windows`, async () => {
    const h = cantina({ withSubagentWindows, links: { R: { parent: "D", at: 1 } } });
    await h.st.hydrate();
    h.annotate();
    await flushAll(h);
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
  });
}

test("graph: a windowless API-driven root with no link is a root — nothing is inferred from a transcript naming it; a session_link nests it; an unlink suppression makes it a root again", async () => {
  const mk = (links) =>
    graphHarness({
      projects: proj1("p", [win(1, "D"), win(2, "J", "job")]),
      jobRecords: [delegateRec("j", "J", "R")],
      parents: { J: "R" },
      links,
    });
  const plain = mk({});
  await plain.st.hydrate();
  plain.annotate();
  await flushAll(plain);
  assert.deepEqual(plain.nesting(), { 2: null }, "driven from outside, no link: a root");

  const linked = mk({ R: { parent: "D", at: 5 } });
  await linked.st.hydrate();
  linked.annotate();
  await flushAll(linked);
  assert.deepEqual(linked.nesting(), { 2: 1 }, "the explicit link nests it");

  const suppressed = mk({ R: { parent: null, at: 5 } });
  await suppressed.st.hydrate();
  suppressed.annotate();
  await flushAll(suppressed);
  assert.deepEqual(suppressed.nesting(), { 2: null }, "a suppression makes it a root");
});

// ---- the session tree (stage (b)) ----
import { LINGER_MS, taskBlocksOf, ownerByDirectory } from "./sessionStatus.mjs";

const bgBlock = (child) => ({ content: [{ type: "tool", state: { metadata: { sessionID: child }, input: { background: true } } }] });
const fgBlock = (child) => ({ content: [{ type: "tool", state: { metadata: { sessionID: child }, input: {} } }] });

/**
 * A harness over createSessionStatus with the readers the tree needs. `sessions`: sid → { parentID, title, directory, metadata }
 * (a session absent from it does not exist); `timelines`: parent sid → assistant records; `links`: sid → { parent }.
 */
function treeHarness({ projects, sessions = {}, timelines = {}, jobRecords = [], chains = {}, succ = {}, active = [], asks = [], links = {}, isSuccessor, special, closeViewWindow, armViewWindow } = {}) {
  const calls = { read: [], timeline: [], changed: 0 };
  const clock = { t: 1_000_000 };
  const state = { projects, jobs: jobRecords, active, asks, links, readFails: false };
  const published = [];
  const timers = [];
  const h = { calls, clock, state, published, timers, sessions, timelines };
  h.st = createSessionStatus({
    closeViewWindow,
    armViewWindow,
    publish: (e) => published.push(e),
    windowedSessionIds: () => state.projects.flatMap((p) => p.windows.map((w) => w.opencodeSessionId).filter(Boolean)),
    loadJobs: async () => state.jobs,
    listActiveSessionIds: async () => state.active,
    getSessionParent: async (id) => ({ status: "ok", parentID: h.sessions[id]?.parentID ?? null }),
    readSession: async (id) => {
      calls.read.push(id);
      if (state.readFails) return { state: "unknown" };
      const s = h.sessions[id];
      return s ? { state: "found", session: { id, title: "", directory: "", ...s } } : { state: "missing" };
    },
    listRawTimeline: async (parent) => {
      calls.timeline.push(parent);
      return h.timelines[parent] ?? [];
    },
    isHandoffSuccessor: isSuccessor,
    linkOf: (sid) => state.links[sid],
    linkEndpoints: () => Object.entries(state.links).flatMap(([c, l]) => [c, l.parent].filter(Boolean)),
    pendingAskSessionIds: () => state.asks,
    isCtoConversationSession: special?.cto,
    isInternalSession: special?.internal,
    chainOf: (sid) => chains[sid] ?? [sid],
    successorOf: (sid) => succ[sid] ?? null,
    schedule: () => {},
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    now: () => clock.t,
    onJobsChanged: () => { calls.changed++; h.st.annotateProjects(state.projects); },
  });
  h.annotate = () => h.st.annotateProjects(state.projects);
  h.tree = (name) => h.annotate().find((p) => (name ? p.tmuxSession === name : true)).tree;
  /** Let every background read and the recompute it triggers run to the end. */
  h.settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
      await h.st.settleBackground();
      await new Promise((r) => setImmediate(r));
    }
  };
  /** Boot: hydrate, first pass, background reads, final pass. */
  h.boot = async () => {
    await h.st.hydrate();
    h.annotate();
    await h.settle();
    return h;
  };
  return h;
}
const fmt = (n) => `${n.kind === "window" ? `w${n.windowIndex}` : `v:${n.key}`}${n.children.length ? `[${n.children.map(fmt).join(",")}]` : ""}`;
const show = (tree) => tree.map(fmt).join(" ");
const flatNodes = (tree) => tree.flatMap((n) => [n, ...flatNodes(n.children)]);
const pj = (name, windows, defaultCwd) => ({ tmuxSession: name, defaultCwd: defaultCwd ?? `/work/${name}`, windows });
const w = (index, sid, extra = {}) => ({ index, name: `w${index}`, opencodeSessionId: sid, owner: "user", paneCurrentPath: "/work/p", ...extra });

test("tree: pure helpers — task blocks classify the first block naming a child; ownerByDirectory picks the most specific project", () => {
  const blocks = taskBlocksOf([fgBlock("a"), bgBlock("b"), bgBlock("a"), { content: [{ type: "text" }] }]);
  assert.equal(blocks.get("a"), "fg", "the first block wins");
  assert.equal(blocks.get("b"), "bg");
  assert.equal(taskBlocksOf([{ content: [{ type: "tool", state: { metadata: { sessionId: "c", background: true } } }] }]).get("c"), "bg");
  const ps = [pj("p", [], "/work/p"), pj("q", [], "/work/p/sub")];
  assert.equal(ownerByDirectory(ps, "/work/p/sub/x"), "q");
  assert.equal(ownerByDirectory(ps, "/work/p"), "p");
  assert.equal(ownerByDirectory(ps, "/elsewhere"), null);
  assert.equal(ownerByDirectory(ps, "/"), null);
});

test("tree: before the first hydration it is today's rows — every window a node, job windows nested by parentWindowIndex", async () => {
  const projects = [pj("p", [w(0, "parent"), w(1, "child1", { owner: "job" }), w(2, "child2", { owner: "job" }), w(3, null), w(4, "x")])];
  const h = treeHarness({ projects, jobRecords: [delegateRec("j1", "child1", "parent"), delegateRec("j2", "child2", "parent")] });
  await h.st.refreshJobs();
  assert.equal(h.st._state.hydratedOnce, false);
  const tree = h.tree();
  assert.equal(show(tree), "w0[w1,w2] w3 w4");
  assert.deepEqual(tree.map((n) => [n.key, n.sessionId]), [["parent", "parent"], ["window:p:3", null], ["x", "x"]]);
  assert.deepEqual(tree[0].children.map((n) => n.job), [{ id: "j1", status: "running", origin: "delegate" }, { id: "j2", status: "running", origin: "delegate" }]);
  assert.equal(tree[0].outside, false);
});

test("tree: every window is exactly one row — duplicate windows, terminal windows and a session windowed in two projects", async () => {
  const projects = [pj("p", [w(0, "a"), w(1, "a"), w(2, null), w(3, "b")]), pj("q", [w(0, "b"), w(5, "c")])];
  const h = treeHarness({ projects, sessions: { a: {}, b: {}, c: {} } });
  const windowRows = () => projects.flatMap((p) => flatNodes(h.tree(p.tmuxSession)).filter((n) => n.kind === "window").map((n) => `${p.tmuxSession}:${n.windowIndex}`)).sort();
  const keysUnique = () => projects.every((p) => { const k = flatNodes(h.tree(p.tmuxSession)).map((n) => n.key); return new Set(k).size === k.length; });
  assert.deepEqual(windowRows(), ["p:0", "p:1", "p:2", "p:3", "q:0", "q:5"], "cold: each window once");
  assert.ok(keysUnique());
  assert.deepEqual(h.tree("p").map((n) => n.key), ["a", "window:p:1", "window:p:2", "window:p:3"], "cold: the node of a session is its lowest-index window; every other window is a row of its own");
  await h.boot();
  assert.deepEqual(windowRows(), ["p:0", "p:1", "p:2", "p:3", "q:0", "q:5"], "hydrated: each window once");
  assert.ok(keysUnique());
  // 'b' is windowed in p (seen first) and q: its node sits in p, the q window is a childless row of its own.
  assert.deepEqual(h.tree("p").map((n) => n.key), ["a", "window:p:1", "window:p:2", "b"]);
  assert.deepEqual(h.tree("q").map((n) => [n.key, n.sessionId]), [["window:q:0", "b"], ["c", "c"]]);
});

test("tree: a running windowless subagent below an idle windowed driver is a virtual row; an inline foreground child never is — not even before it is classified", async () => {
  const projects = [pj("p", [w(1, "D")])];
  const h = treeHarness({
    projects,
    active: ["S", "F"],
    sessions: { D: {}, S: { parentID: "D", title: "sub work", directory: "/work/p" }, F: { parentID: "D", title: "inline", directory: "/work/p" } },
    timelines: { D: [bgBlock("S"), fgBlock("F")] },
  });
  await h.st.hydrate();
  assert.equal(show(h.tree()), "w1", "right after hydration neither is shown: unclassified windowless sessions are not rows");
  h.annotate();
  await h.settle();
  assert.equal(show(h.tree()), "w1[v:S]", "S is a background subagent; F is an inline child of D's turn");
  assert.equal(h.tree()[0].children[0].title, "sub work");
  assert.equal(h.tree()[0].children[0].sessionId, "S");
  // Many ticks later F is still not a row, and its running dot rolls up to D.
  for (let i = 0; i < 3; i++) { h.clock.t += 5000; h.annotate(); await h.settle(); }
  assert.ok(!flatNodes(h.tree()).some((n) => n.key === "F"));
});

test("tree: a child with no task block is held back for a few reads, then shown (not an inline child)", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    active: ["S"],
    sessions: { D: {}, S: { parentID: "D", directory: "/work/p" } },
    timelines: { D: [] },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1", "the block can lag the child: not yet");
  for (let i = 0; i < 4; i++) { h.clock.t += 2500; h.annotate(); await h.settle(); }
  assert.equal(show(h.tree()), "w1[v:S]");
  assert.ok(h.calls.timeline.length >= 3);
});

test("tree: a job child under a windowless subagent is rooted at the windowed ancestor — the subagent is a row only when it is not an inline child", async () => {
  const mk = (block) => treeHarness({
    projects: [pj("p", [w(1, "D")])],
    active: ["J"],
    jobRecords: [delegateRec("j", "J", "S", { tmuxSession: "p" })],
    sessions: { D: {}, S: { parentID: "D", directory: "/work/p" }, J: { parentID: "S", directory: "/work/p" } },
    timelines: { D: [block] },
  });
  const bg = mk(bgBlock("S"));
  await bg.boot();
  assert.equal(show(bg.tree()), "w1[v:S[v:J]]", "an idle background subagent holds its shown job: structural retention");
  const fg = mk(fgBlock("S"));
  await fg.boot();
  assert.equal(show(fg.tree()), "w1[v:J]", "edges pass through an inline child");
  // The same with a window for the job.
  const win = treeHarness({
    projects: [pj("p", [w(1, "D"), w(2, "J", { owner: "job" })])],
    jobRecords: [delegateRec("j", "J", "S")],
    sessions: { D: {}, S: { parentID: "D" }, J: { parentID: "S" } },
    timelines: { D: [fgBlock("S")] },
  });
  await win.boot();
  assert.equal(show(win.tree()), "w1[w2]");
});

test("tree: a handoff chain is one node — the key is the oldest member, the canonical session follows the window, and a commit moves nothing", async () => {
  const chain = ["pred", "succ"];
  const base = { chains: { pred: chain, succ: chain }, succ: { pred: "succ" }, sessions: { pred: {}, succ: {}, J: { parentID: "pred" } }, jobRecords: [delegateRec("j", "J", "pred")] };
  const before = treeHarness({ ...base, projects: [pj("p", [w(1, "pred"), w(2, "J", { owner: "job" })])] });
  await before.boot();
  const a = before.tree()[0];
  assert.deepEqual([a.key, a.sessionId, show(before.tree())], ["pred", "pred", "w1[w2]"]);
  const after = treeHarness({ ...base, projects: [pj("p", [w(1, "succ"), w(2, "J", { owner: "job" })])] });
  await after.boot();
  const b = after.tree()[0];
  assert.deepEqual([b.key, b.sessionId, show(after.tree())], ["pred", "succ", "w1[w2]"], "same key and place; the canonical member is the one the window carries");
  // Windowless: the chain's live end is the node.
  const windowless = treeHarness({ ...base, projects: [pj("p", [w(2, "J", { owner: "job" })])], active: ["succ"], sessions: { pred: { directory: "/work/p" }, succ: { directory: "/work/p" }, J: { parentID: "pred" } } });
  await windowless.boot();
  const v = flatNodes(windowless.tree()).find((n) => n.kind === "virtual");
  assert.deepEqual([v.key, v.sessionId], ["pred", "succ"]);
  // An UNCOMMITTED successor is never a row.
  const uncommitted = treeHarness({ projects: [pj("p", [w(1, "D")])], active: ["next"], sessions: { D: {}, next: { directory: "/work/p" } }, isSuccessor: (sid) => sid === "next" });
  await uncommitted.boot();
  assert.equal(show(uncommitted.tree()), "w1");
});

test("tree: structural retention and linger — an idle windowless root holds its running child; both leave 30 s after the child ends", async () => {
  const h = treeHarness({
    projects: [pj("p", [])],
    active: ["R", "C"],
    sessions: { R: { directory: "/work/p", title: "driver" }, C: { parentID: "R", directory: "/work/p", title: "child" } },
    timelines: { R: [bgBlock("C")] },
  });
  await h.boot();
  assert.equal(show(h.tree()), "v:R[v:C]");
  assert.equal(h.tree()[0].outside, true, "a root with no window and no parent is driven from outside");
  assert.equal(h.tree()[0].title, "driver");
  // R is idle for a long time; only C runs.
  h.st.observe(stream("turnComplete", "R", { running: false }));
  h.clock.t += 5 * 60_000;
  assert.equal(show(h.tree()), "v:R[v:C]", "the idle root stays while its descendant runs");
  h.st.observe(stream("turnComplete", "C", { running: false }));
  const lingerTimer = h.timers.find((t) => t.ms === LINGER_MS + 5);
  assert.ok(lingerTimer, "one linger timer per lingering session");
  h.clock.t += LINGER_MS - 1000;
  assert.equal(show(h.tree()), "v:R[v:C]", "C ended < 30 s ago");
  h.clock.t += 2000;
  assert.equal(show(h.tree()), "", "gone after the linger");
  assert.equal(h.timers.filter((t) => t.ms === LINGER_MS + 5).length, 2, "one for each ended session");
});

test("tree: a finished job's windowless child keeps its row through the linger, and a later turn of it shows again", async () => {
  const rec = delegateRec("j", "C", "D", { tmuxSession: "p" });
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    active: ["C"],
    jobRecords: [rec],
    sessions: { D: {}, C: { parentID: "D", directory: "/work/p" } },
    timelines: { D: [bgBlock("C")] },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1[v:C]");
  // The job ends and its result is delivered; the child's turn ends with it.
  h.state.jobs = [{ ...rec, status: "done", completionDelivery: "delivered" }];
  h.state.active = [];
  await h.st.refreshJobs();
  h.st.observe(stream("turnComplete", "C", { running: false }));
  await h.settle();
  assert.equal(show(h.tree()), "w1[v:C]", "the linger holds the row of a finished job's child");
  h.clock.t += LINGER_MS - 1000;
  assert.equal(show(h.tree()), "w1[v:C]");
  h.clock.t += 2000;
  assert.equal(show(h.tree()), "w1", "gone after the linger");
  // A new turn on the same session is a row again.
  h.state.active = ["C"];
  h.st.observe(stream("running", "C", { running: true, since: 9 }));
  await h.settle();
  assert.equal(show(h.tree()), "w1[v:C]");
});

test("tree: a delivered job child stays as structural retention while a descendant runs", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    active: ["G"],
    jobRecords: [
      delegateRec("js", "S", "D", { tmuxSession: "p", status: "done", completionDelivery: "delivered" }),
      delegateRec("jg", "G", "S", { tmuxSession: "p" }),
    ],
    sessions: { D: {}, S: { parentID: "D", directory: "/work/p" }, G: { parentID: "S", directory: "/work/p" } },
    timelines: { D: [bgBlock("S")], S: [bgBlock("G")] },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1[v:S[v:G]]");
});

test("tree: a stopped job whose launch is uncertain is still a (virtual) row", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    jobRecords: [adoptedRec("j", "C", "D", { tmuxSession: "p", status: "stopped", launchState: "uncertain" })],
    sessions: { D: {}, C: { parentID: "D", directory: "/work/p" } },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1[v:C]");
});

test("tree: the linger timer fires a recompute that refreshes the list once the linger is over", async () => {
  const h = treeHarness({ projects: [pj("p", [])], active: ["C"], sessions: { C: { directory: "/work/p" } } });
  await h.boot();
  assert.equal(show(h.tree()), "v:C");
  h.st.observe(stream("turnComplete", "C", { running: false }));
  await h.settle();
  const timer = h.timers.find((t) => t.ms === LINGER_MS + 5);
  const changedBefore = h.calls.changed;
  h.clock.t += LINGER_MS + 10;
  timer.fn();
  await h.settle();
  assert.equal(h.calls.changed, changedBefore + 1, "the expired row triggered one list refresh");
  assert.equal(show(h.tree()), "");
});

test("tree: root placement — window project, then the job's tmuxSession, then the directory's owner; retained when a second window appears elsewhere", async () => {
  const projects = [pj("p", [w(1, "X")], "/work/p"), pj("q", [], "/work/q")];
  const h = treeHarness({
    projects,
    active: ["Y", "Z"],
    jobRecords: [delegateRec("jy", "Y", "gone", { tmuxSession: "q" })],
    sessions: { X: {}, Y: { directory: "/work/p/x" }, Z: { directory: "/work/q/deep" } },
  });
  await h.boot();
  assert.equal(show(h.tree("p")), "w1");
  assert.equal(show(h.tree("q")), "v:Y v:Z", "Y by its job's tmuxSession (not its directory), Z by its directory");
  // X gets a second window in q: the root stays where it was decided.
  h.state.projects = [pj("p", [w(1, "X")], "/work/p"), pj("q", [w(4, "X")], "/work/q")];
  assert.equal(show(h.tree("p")), "w1");
  assert.deepEqual(h.tree("q").map((n) => n.key), ["window:q:4", "Y", "Z"], "the extra window is a childless row of its own");
  // The window it was decided by goes away: the reason lapses and the root moves.
  h.state.projects = [pj("p", [], "/work/p"), pj("q", [w(4, "X")], "/work/q")];
  assert.equal(show(h.tree("p")), "");
  assert.ok(h.tree("q").some((n) => n.key === "X" && n.kind === "window"));
});

test("tree: a parent whose root lies in another project makes the child a root of its own project; a session nobody can place is not shown", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "P")]), pj("q", [w(1, "J", { owner: "job" })])],
    active: ["V", "L"],
    jobRecords: [delegateRec("j", "J", "P"), delegateRec("v", "V", "P", { tmuxSession: "q" })],
    sessions: { P: {}, J: { parentID: "P" }, V: { parentID: "P" }, L: { directory: "/nowhere" } },
  });
  await h.boot();
  assert.equal(show(h.tree("p")), "w1");
  assert.equal(show(h.tree("q")), "w1 v:V", "J and V sit in q (their own project), not under P");
  assert.ok(!flatNodes(h.tree("p")).concat(flatNodes(h.tree("q"))).some((n) => n.key === "L"), "no project owns L's directory");
});

test("tree: exclusions — internal marker, the CTO conversation, a provenance-internal session never show; edges pass through them", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    active: ["M", "C", "I", "K"],
    sessions: {
      D: {},
      M: { directory: "/work/p", metadata: { manta: { internal: true } } },
      C: { directory: "/work/p" },
      I: { directory: "/work/p" },
      K: { directory: "/work/p", parentID: "C" },
    },
    special: { cto: async (sid) => sid === "C", internal: async (sid) => sid === "I" },
    jobRecords: [delegateRec("k", "K", "C", { tmuxSession: "p" })],
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1 v:K", "K (a job of the CTO conversation) is a root; C is not a row");
  const failing = treeHarness({ projects: [pj("p", [w(1, "D")])], active: ["X"], sessions: { D: {}, X: { directory: "/work/p" } }, special: { cto: async () => { throw new Error("store down"); } } });
  await failing.boot();
  assert.equal(show(failing.tree()), "w1", "a provenance store that cannot answer fails closed");
});

test("tree: unknown is not root — a windowless session whose ancestry is unread is not shown; a failed read keeps the last-known nesting", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D"), w(2, "J", { owner: "job" })])],
    jobRecords: [delegateRec("j", "J", "S")],
    sessions: { D: {}, S: { parentID: "D", directory: "/work/p" }, J: { parentID: "S" } },
    timelines: { D: [bgBlock("S")] },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w1[v:S[w2]]");
  // The edge S → D is lost (as an eviction would) and the box cannot be read.
  h.st._state.parentOf.delete("S");
  h.st._state.rootIds.delete("S");
  h.state.readFails = true;
  assert.equal(show(h.tree()), "w1[v:S[w2]]", "last-known nesting stands; nothing becomes a root");
  h.state.readFails = false;
  await h.settle();
  assert.equal(show(h.tree()), "w1[v:S[w2]]");
});

test("tree: explicit links add an edge, a suppression is not an edge, rule 1/2 beat a link, a link cycle breaks into roots", async () => {
  const projects = [pj("p", [w(1, "P"), w(2, "C", { owner: "user" }), w(3, "Q")])];
  const h = treeHarness({ projects, sessions: { P: {}, C: {}, Q: {} } });
  await h.boot();
  assert.equal(show(h.tree()), "w1 w2 w3");
  h.state.links = { C: { parent: "P" } };
  h.st.linksChanged();
  assert.equal(show(h.tree()), "w1[w2] w3", "rule 3: the link nests C under P");
  // rule 2 (opencode's own parent) wins over a link
  h.sessions.C = { parentID: "Q" };
  h.st._state.parentOf.set("C", "Q");
  assert.equal(show(h.tree()), "w1 w3[w2]", "opencode's parentID beats the link");
  h.st._state.parentOf.delete("C");
  h.st._state.rootIds.add("C");
  // a cycle made of links is two roots, not a loop
  h.state.links = { P: { parent: "Q" }, Q: { parent: "P" } };
  assert.equal(show(h.tree()), "w1 w2 w3");
  // a suppression is not an edge
  h.state.links = { C: { parent: null } };
  assert.equal(show(h.tree()), "w1 w2 w3");
});

test("tree: nothing is inferred — a root with no link stays a root; an explicit link nests it; a suppression makes it a root, durably", async () => {
  const projects = [pj("p", [w(1, "D"), w(2, "J", { owner: "job" })])];
  const mk = (links) => treeHarness({ projects, jobRecords: [delegateRec("j", "J", "R")], sessions: { D: {}, R: {}, J: { parentID: "R" } }, links, timelines: { D: [] } });
  const plain = mk({});
  await plain.boot();
  assert.equal(show(plain.tree()), "w1 w2", "no link: J is a root (R has no place of its own)");
  const suppressed = mk({ R: { parent: null } });
  await suppressed.boot();
  assert.equal(show(suppressed.tree()), "w1 w2", "a suppression: J is a root");
  const linked = mk({ R: { parent: "D" } });
  await linked.boot();
  assert.equal(show(linked.tree()), "w1[v:R[w2]]", "the link nests R (an idle windowless root holding a shown job) under D");
  linked.state.links = { R: { parent: null } };
  linked.st.linksChanged();
  assert.equal(show(linked.tree()), "w1 w2", "a later suppression replaces the link");
});

test("tree: a row keeps its slot when it gets a window — siblings are ordered by first appearance, not by window index", async () => {
  const projects = [pj("p", [w(5, "D"), w(7, "A", { owner: "job" }), w(9, "B", { owner: "job" })])];
  const h = treeHarness({
    projects,
    active: ["V"],
    jobRecords: [delegateRec("a", "A", "D"), delegateRec("b", "B", "D"), delegateRec("v", "V", "D", { tmuxSession: "p" })],
    sessions: { D: {}, A: { parentID: "D" }, B: { parentID: "D" }, V: { parentID: "D", directory: "/work/p" } },
  });
  await h.boot();
  assert.equal(show(h.tree()), "w5[w7,w9,v:V]");
  // The user opens V: it gets window 2 (a LOWER index than its siblings) and stays last.
  h.state.projects = [pj("p", [w(2, "V", { owner: "user" }), w(5, "D"), w(7, "A", { owner: "job" }), w(9, "B", { owner: "job" })])];
  assert.equal(show(h.tree()), "w5[w7,w9,w2]");
  assert.equal(h.tree()[0].children[2].key, "V", "the key is the same");
});

test("tree: counts and busy come from the graph — running descendants at any depth, collapsed or shown, plus pending asks", async () => {
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])],
    sessions: { D: {}, S: { parentID: "D" }, T: { parentID: "S" }, U: { parentID: "S" } },
    timelines: { D: [fgBlock("S")] },
  });
  await h.boot();
  h.st.observe(stream("childSession", "D", { childSessionId: "S", parentSessionId: "D" }));
  h.st.observe(stream("childSession", "S", { childSessionId: "T", parentSessionId: "S" }));
  h.st.observe(stream("childSession", "S", { childSessionId: "U", parentSessionId: "S" }));
  h.st.observe(stream("running", "T", { running: true, since: 5 }));
  h.st.observe(stream("running", "U", { running: true, since: 6 }));
  h.st.observe(stream("attention", "S", { kind: "question" }));
  h.st.flush();
  const d = h.published.filter((e) => e.sessionId === "D").at(-1).payload;
  assert.equal(d.subagents, 3, "T and U running + S waiting on a question, all below D");
  assert.equal(d.busy, true);
  assert.equal(d.running, false);
  h.st.observe(stream("attention", "S", { kind: null }));
  h.st.observe(stream("turnComplete", "T", { running: false }));
  h.st.observe(stream("turnComplete", "U", { running: false }));
  h.st.flush();
  assert.deepEqual(h.published.filter((e) => e.sessionId === "D").at(-1).payload, { running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false });
});

test("tree: busy for a running root with no children, and a pending ask the interpreter holds counts even when no frame was seen", async () => {
  const h = treeHarness({ projects: [pj("p", [w(1, "D"), w(2, "E")])], sessions: { D: {}, E: {}, Q: { parentID: "E" } }, asks: ["Q"], timelines: { E: [fgBlock("Q")] } });
  await h.boot();
  h.st.observe(stream("running", "D", { running: true, since: 3 }));
  h.st.flush();
  const frame = (sid) => h.published.filter((e) => e.sessionId === sid).at(-1).payload;
  assert.deepEqual(frame("D"), { running: true, busy: true, startedAt: 3, attention: null, subagents: 0, stopped: false });
  assert.equal(frame("E").subagents, 1, "Q waits on an ask; E sees it");
});

test("tree: windowStatus frames cover virtual rows, and a window stamped with any member of a chain", async () => {
  const chain = ["pred", "succ"];
  const h = treeHarness({
    projects: [pj("p", [w(1, "D"), w(3, "pred")])],
    active: ["S"],
    chains: { pred: chain, succ: chain },
    succ: { pred: "succ" },
    sessions: { D: {}, pred: {}, succ: {}, S: { parentID: "D", directory: "/work/p" } },
    timelines: { D: [bgBlock("S")] },
  });
  await h.boot();
  h.st.flush();
  const sids = new Set(h.published.filter((e) => e.sub === "windowStatus").map((e) => e.sessionId));
  assert.ok(sids.has("S"), "a virtual node has a status frame");
  assert.ok(sids.has("D") && sids.has("pred"));
  assert.equal(h.published.filter((e) => e.sessionId === "S").at(-1).payload.running, true);
  assert.ok(Object.keys(h.st.windowStatusMap()).includes("S"));
  assert.equal(h.published.filter((e) => e.sessionId === "D").at(-1).payload.subagents, 1);
});

test("tree: hydration reads pending-ask sessions and link endpoints too; a directory move re-places a root; a retitle refreshes the row", async () => {
  const h = treeHarness({
    projects: [pj("p", [], "/work/p"), pj("q", [], "/work/q")],
    asks: ["A"],
    links: { L: { parent: "M" } },
    sessions: { A: { directory: "/work/p", title: "asking" }, L: {}, M: {} },
  });
  await h.boot();
  for (const sid of ["A", "L", "M"]) assert.ok(h.calls.read.includes(sid), `${sid} was read`);
  assert.equal(show(h.tree("p")), "v:A", "a session with a pending ask is shown");
  // opencode moves A's directory into q's tree.
  h.sessions.A = { directory: "/work/q/sub", title: "asking" };
  h.st.observe({ kind: "opencode", payload: { type: "session.updated", data: { sessionID: "A", location: { directory: "/work/q/sub" } } } });
  await h.settle();
  assert.equal(show(h.tree("p")), "");
  assert.equal(show(h.tree("q")), "v:A");
  // a retitle without a directory re-reads the session (throttled)
  h.sessions.A = { directory: "/work/q/sub", title: "renamed" };
  h.st.observe({ kind: "opencode", payload: { type: "session.updated", data: { sessionID: "A" } } });
  await h.settle();
  assert.equal(h.tree("q")[0].title, "renamed");
});

test("tree: placementOf answers the project, the canonical session and a starting directory for any member of a shown row", async () => {
  const chain = ["pred", "succ"];
  const h = treeHarness({
    projects: [pj("p", [w(1, "D", { paneCurrentPath: "/work/p/d" })], "/work/p")],
    active: ["S", "pred"],
    chains: { pred: chain, succ: chain },
    succ: { pred: "succ" },
    sessions: { D: {}, S: { parentID: "D", directory: "/work/p/s" }, pred: { directory: "/work/p/pred" }, succ: { directory: "/work/p/succ" } },
    timelines: { D: [bgBlock("S")] },
  });
  await h.boot();
  assert.deepEqual(h.st.placementOf("S"), { project: "p", canonicalSessionId: "S", cwd: "/work/p/s", rootPath: "/work/p/d", defaultCwd: "/work/p" });
  assert.deepEqual(h.st.placementOf("pred"), { project: "p", canonicalSessionId: "succ", cwd: "/work/p/succ", rootPath: null, defaultCwd: "/work/p" }, "either member of the chain finds the node");
  assert.deepEqual(h.st.placementOf("succ"), { project: "p", canonicalSessionId: "succ", cwd: "/work/p/succ", rootPath: null, defaultCwd: "/work/p" });
  assert.equal(h.st.placementOf("nobody"), null);
  // No directory known: the root window's pane path, else the project's default.
  const noDir = treeHarness({ projects: [pj("p", [w(1, "D", { paneCurrentPath: "/work/p/d" })])], active: ["S"], sessions: { D: {}, S: { parentID: "D" } }, timelines: { D: [bgBlock("S")] } });
  await noDir.boot();
  assert.deepEqual(noDir.st.placementOf("S"), { project: "p", canonicalSessionId: "S", cwd: "/work/p/d", rootPath: "/work/p/d", defaultCwd: "/work/p" });
  const root = treeHarness({ projects: [pj("p", [], "/work/p")], active: ["R"], sessions: { R: { directory: "/work/p/r" } } });
  await root.boot();
  assert.equal(root.st.placementOf("R").cwd, "/work/p/r");
});

test("tree: the cantina scenario (linked) — rows keep their root across 10 subagent turns (windows appearing and vanishing for the subagents)", async () => {
  const base = [w(16, "D"), w(10, "J1", { owner: "job" }), w(12, "J2", { owner: "job" })];
  const subs = [w(1, "S1", { owner: "job" }), w(2, "S2", { owner: "job" })];
  const h = treeHarness({
    projects: [pj("cantina", base)],
    jobRecords: [adoptedRec("s1", "S1", "R"), adoptedRec("s2", "S2", "R"), delegateRec("j1", "J1", "S1"), delegateRec("j2", "J2", "S2")],
    sessions: { D: {}, R: { directory: "/work/cantina" }, S1: { parentID: "R" }, S2: { parentID: "R" }, J1: { parentID: "S1" }, J2: { parentID: "S2" } },
    links: { R: { parent: "D" } },
    timelines: { R: [bgBlock("S1"), bgBlock("S2")] },
  });
  await h.boot();
  const rootOf = () => {
    const out = {};
    for (const root of h.tree("cantina")) for (const n of flatNodes([root])) out[n.key] = root.key;
    return out;
  };
  const settled = rootOf();
  assert.ok(["J1", "J2", "S1", "S2"].every((k) => settled[k] === "D"), JSON.stringify(settled));
  let on = false;
  for (let i = 0; i < 10; i++) {
    on = !on;
    h.state.projects = [pj("cantina", on ? [...base, ...subs] : base)];
    assert.deepEqual(rootOf(), settled, `round ${i}: no row changed root`);
    await h.settle();
    assert.deepEqual(rootOf(), settled, `round ${i} after reads`);
  }
  assert.equal(Object.values(flatNodes(h.tree("cantina")).reduce((a, n) => ({ ...a, [n.key]: 1 }), {})).length, flatNodes(h.tree("cantina")).length, "no row twice");
});

test("tree: a tree change refreshes the list and announces sessions.nesting once; an unchanged tree does neither", async () => {
  const h = treeHarness({ projects: [pj("p", [])], active: [], sessions: { C: { directory: "/work/p" } } });
  await h.boot();
  const nesting = () => h.published.filter((e) => e.kind === "sessions.nesting").length;
  assert.equal(nesting(), 0);
  h.st.observe(stream("running", "C", { running: true, since: 1 }));
  await h.settle();
  assert.equal(show(h.tree()), "v:C", "running → a virtual row");
  const changed = h.calls.changed;
  assert.ok(changed >= 1);
  h.st.observe({ kind: "sync", payload: { changed: { projects: [] } } });
  assert.equal(nesting(), 1);
  // a running frame that changes nothing in the tree does not refresh
  h.st.observe(stream("running", "C", { running: true, since: 2, type: "retry" }));
  await h.settle();
  assert.equal(h.calls.changed, changed);
});

test("tree: production wiring supplies session reads, exclusions, pending asks and push's annotated tree", () => {
  const index = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const block = index.slice(index.indexOf("const sessionStatus = createSessionStatus({"), index.indexOf("sessionStatusRef.current = sessionStatus;"));
  for (const text of [
    "readSession: (sid) => oc.readSession(sid)",
    "listRawTimeline: (sid, opts) => oc.listRawTimeline(sid, opts)",
    "isHandoffSuccessor: (sid) => handoffEngine.isSuccessor(sid)",
    "isCtoConversationSession: (sid) => ctoConversation.isConversationSession(sid)",
    "isInternalSession: (sid) => isInternalSession(sid)",
    "pendingAskSessionIds: () => streamInterp.knownSessionIds()",
    "state?.questions?.length > 0 || state?.permissions?.length > 0",
  ]) assert.ok(block.includes(text), text);
  assert.match(index, /push\.setSessionProjectsReader\(\(\) => syncState\.snapshot\(\)\.projects \?\? \[\]\)/);
  assert.ok(block.includes("linkOf: (sid) => sessionLinks.linkOf(sid)"), "explicit links feed the graph");
  assert.ok(block.includes("pruneLinks:"), "hydration prunes confirmed-deleted link endpoints");
});

test("tree: attention and childSession invalidate placement; committed handoff alone recomputes the canonical row", async () => {
  const successors = {};
  const h = treeHarness({
    projects: [pj("p", [w(1, "D")])], active: ["C"], succ: successors,
    chains: { C: ["C", "next"], next: ["C", "next"] },
    sessions: { D: {}, C: { directory: "/work/p", title: "Child" }, next: { directory: "/work/p", title: "Successor" } },
    timelines: { D: [bgBlock("C")] },
  });
  await h.boot();
  h.st.observe(stream("childSession", "D", { childSessionId: "C", parentSessionId: "D" }));
  await h.settle();
  assert.equal(h.tree()[0].children[0].key, "C");
  successors.C = "next";
  const before = h.calls.changed;
  h.st.observe({ kind: "handoff", payload: { state: "ready" } });
  await h.settle();
  assert.equal(h.calls.changed, before);
  h.st.observe({ kind: "handoff", payload: { state: "committed" } });
  await h.settle();
  assert.ok(h.calls.changed > before);
  assert.equal(h.tree()[0].children[0].sessionId, "next");

  const ask = treeHarness({ projects: [pj("p", [])], sessions: { A: { directory: "/work/p" } } });
  await ask.boot();
  ask.st.observe(stream("attention", "A", { kind: "permission" }));
  await ask.settle();
  assert.equal(show(ask.tree()), "v:A");
  ask.st.observe(stream("attention", "A", { kind: null }));
  await ask.settle();
  assert.equal(show(ask.tree()), "");
});

test("tree: job signature changes refresh only a changed tree and include parent-edge changes", async () => {
  const h = treeHarness({ projects: [pj("p", [w(1, "A"), w(2, "B"), w(3, "J", { owner: "job" })])],
    sessions: { A: {}, B: {}, J: {} }, jobRecords: [delegateRec("j", "J", "A")] });
  await h.boot();
  assert.equal(show(h.tree()), "w1[w3] w2");
  const before = h.calls.changed;
  h.state.jobs = [...h.state.jobs, { id: "no-child", status: "running", parentSessionID: "A" }];
  h.st.observe({ kind: "delegate.updated", payload: {} });
  await h.st.settled();
  await h.settle();
  assert.equal(h.calls.changed, before, "a record with no rendered row changes status, not the tree");
  h.state.jobs = h.state.jobs.map((j) => j.id === "j" ? { ...j, parentSessionID: "B" } : j);
  h.st.observe({ kind: "delegate.updated", payload: {} });
  await h.st.settled();
  await h.settle();
  assert.equal(show(h.tree()), "w1 w2[w3]");
  assert.equal(h.calls.changed, before + 1);
});

test("tree: live-job records cannot bypass internal or uncommitted-successor exclusions", async () => {
  const h = treeHarness({ projects: [pj("p", [w(1, "D")])],
    sessions: { D: {}, I: { metadata: { manta: { internal: true } } }, S: {} },
    isSuccessor: (sid) => sid === "S",
    jobRecords: [delegateRec("i", "I", "D"), delegateRec("s", "S", "D")] });
  await h.boot();
  assert.equal(show(h.tree()), "w1");
});

test("tree: a transient unreadable task timeline keeps retrying past the increasing backoff", async () => {
  const h = treeHarness({ projects: [pj("p", [w(1, "D")])], active: ["C"],
    sessions: { D: {}, C: { parentID: "D" } } });
  let available = false;
  h.timelines = new Proxy({}, { get: () => { if (!available) throw new Error("temporarily unavailable"); return [bgBlock("C")]; } });
  await h.boot();
  assert.equal(show(h.tree()), "w1");
  for (let i = 0; i < 6; i++) {
    const timer = h.timers.shift();
    assert.ok(timer, `retry ${i} remains scheduled`);
    h.clock.t += timer.ms;
    timer.fn();
    await h.settle();
  }
  available = true;
  for (let i = 0; i < 4 && !h.tree()[0].children.length; i++) {
    const timer = h.timers.shift();
    assert.ok(timer);
    h.clock.t += timer.ms;
    timer.fn();
    await h.settle();
  }
  assert.equal(show(h.tree()), "w1[v:C]");
});

test("tree: the default linger timer is unref'd", async (t) => {
  const handles = [];
  t.mock.method(globalThis, "setTimeout", (_fn, ms) => {
    const handle = { ms, unreferenced: false, unref() { this.unreferenced = true; return this; } };
    handles.push(handle);
    return handle;
  });
  const st = createSessionStatus({ publish: () => {}, windowedSessionIds: () => [], loadJobs: async () => [],
    listActiveSessionIds: async () => [], getSessionParent: async () => ({ status: "ok", parentID: null }), schedule: () => {} });
  st.observe(stream("running", "C", { running: true }));
  st.observe(stream("turnComplete", "C", { running: false }));
  const timer = handles.find((h) => h.ms === LINGER_MS + 5);
  assert.ok(timer?.unreferenced);
});

test("tree: a newly listed non-job window hydrates its parent instead of staying a false root", async () => {
  const h = treeHarness({ projects: [pj("p", [w(1, "D")])], sessions: { D: {}, C: { parentID: "D" } } });
  await h.boot();
  h.state.projects = [pj("p", [w(1, "D"), w(2, "C")])];
  h.annotate(); // the sync list reader sees the new window before it publishes its delta
  h.st.observe({ kind: "sync", payload: { changed: { projects: h.state.projects } } });
  await h.settle();
  assert.ok(h.calls.read.includes("C"));
  assert.equal(show(h.tree()), "w1[w2]");
});

test("tree: a windowless externally driven root is a root until a session_link nests it", async () => {
  const mk = (links) => treeHarness({ projects: [pj("p", [w(1, "D")])], active: ["R"], links,
    sessions: { D: {}, R: { directory: "/work/p", title: "Outside" } } });
  const plain = mk({});
  await plain.boot();
  assert.equal(show(plain.tree()), "w1 v:R", "driven from outside, no link: a root");
  const linked = mk({ R: { parent: "D" } });
  await linked.boot();
  assert.equal(show(linked.tree()), "w1[v:R]");
});

// ---- viewer windows (`@manta-owner=view`) ----
// A viewer window is armed only by OBSERVED work in its session (stamped on the window, so it survives a restart); only
// an armed window is ever closed, and only after its node has been finished for one linger.
function viewHarness({ armed = false, ...over } = {}) {
  const closed = [];
  const arms = [];
  const result = { closed: true };
  const h = treeHarness({
    projects: [pj("p", [w(1, "V", { owner: "view", ...(armed ? { viewArmed: true } : {}) })])],
    sessions: { V: { directory: "/work/p" } },
    closeViewWindow: async (a) => { closed.push(a); return result; },
    armViewWindow: async (a) => { arms.push(a); if (h.armFails) throw new Error("tmux down"); },
    ...over,
  });
  h.closed = closed;
  h.arms = arms;
  h.result = result;
  h.armFails = false;
  h.tick = async (ms = 0) => { h.clock.t += ms; h.annotate(); await h.settle(); };
  return h;
}

test("view windows: one opened on a session that is not running is never armed and never closed — not even after a restart", async () => {
  const h = viewHarness();
  await h.boot();
  await h.tick(10 * LINGER_MS);
  assert.deepEqual(h.arms, [], "nothing to observe, nothing to arm");
  assert.deepEqual(h.closed, [], "an unarmed window stays");
  assert.equal(h.timers.filter((t) => t.ms === LINGER_MS + 5).length, 0, "no countdown timer either");
  // A later "restart": a fresh status engine over the same unarmed window behaves the same.
  const restarted = viewHarness();
  await restarted.boot();
  await restarted.tick(10 * LINGER_MS);
  assert.deepEqual(restarted.closed, []);
});

test("view windows: seeing the session work arms the window; it closes one linger after the work ends", async () => {
  const h = viewHarness({ active: ["V"] });
  await h.boot();
  assert.deepEqual(h.arms, [{ project: "p", windowIndex: 1, sessionId: "V" }], "armed while it was seen running");
  await h.tick(10 * 60_000);
  assert.equal(h.arms.length, 1, "armed once");
  assert.deepEqual(h.closed, [], "running");
  h.state.active = [];
  h.st.observe(stream("turnComplete", "V", { running: false }));
  await h.settle();
  await h.tick(LINGER_MS - 1000);
  assert.deepEqual(h.closed, [], "ended < one linger ago");
  await h.tick(2000);
  assert.deepEqual(h.closed, [{ project: "p", windowIndex: 1, sessionId: "V" }]);
});

test("view windows: an armed window whose session is no longer running at boot closes after one linger", async () => {
  const h = viewHarness({ armed: true });
  await h.boot();
  assert.deepEqual(h.closed, [], "not at once");
  const timer = h.timers.find((t) => t.ms === LINGER_MS + 5);
  assert.ok(timer, "a timer re-evaluates when the linger is due");
  await h.tick(LINGER_MS - 1000);
  assert.deepEqual(h.closed, []);
  h.clock.t += 2000;
  timer.fn();
  await h.settle();
  assert.deepEqual(h.closed, [{ project: "p", windowIndex: 1, sessionId: "V" }]);
  assert.deepEqual(h.arms, [], "already armed: nothing re-stamped");
});

test("view windows: a pending question, a live job child, or work beneath it each arm the window, and hold it", async () => {
  const asking = viewHarness({ asks: ["V"] });
  await asking.boot();
  await asking.tick(5 * LINGER_MS);
  assert.equal(asking.arms.length, 1, "a pending ask is work");
  assert.deepEqual(asking.closed, [], "pending ask");
  asking.state.asks = [];
  await asking.tick(0);
  await asking.tick(LINGER_MS + 1);
  assert.equal(asking.closed.length, 1, "answered → closes after a linger");

  const job = viewHarness({ jobRecords: [delegateRec("j", "V", "P", { tmuxSession: "p" })] });
  await job.boot();
  await job.tick(5 * LINGER_MS);
  assert.equal(job.arms.length, 1);
  assert.deepEqual(job.closed, [], "the child of a live job record");

  const parent = viewHarness({ active: ["S"], sessions: { V: { directory: "/work/p" }, S: { parentID: "V", directory: "/work/p" } }, timelines: { V: [bgBlock("S")] } });
  await parent.boot();
  await parent.tick(5 * LINGER_MS);
  assert.equal(parent.arms.length, 1, "a subagent beneath it is work at its node");
  assert.deepEqual(parent.closed, [], "a subagent runs beneath it");
  parent.state.active = [];
  parent.st.observe(stream("turnComplete", "S", { running: false }));
  await parent.settle();
  await parent.tick(0);
  await parent.tick(2 * LINGER_MS);
  assert.equal(parent.closed.length, 1, "once the work beneath is done too");
});

test("view windows: a failed arm is retried while the work lasts; work that ended before any arm stuck never closes the window", async () => {
  const h = viewHarness({ active: ["V"] });
  h.armFails = true;
  await h.boot();
  await h.tick(1000);
  assert.ok(h.arms.length >= 2, "retried on the next pass");
  h.state.active = [];
  h.st.observe(stream("turnComplete", "V", { running: false }));
  await h.settle();
  await h.tick(10 * LINGER_MS);
  assert.deepEqual(h.closed, [], "never armed → stays");
  const ok = viewHarness({ active: ["V"] });
  ok.armFails = false;
  await ok.boot();
  assert.equal(ok.arms.length, 1);
});

test("view windows: a window the user owns (user / job / unstamped) is never armed or closed by this rule", async () => {
  for (const owner of ["user", "job", undefined]) {
    const h = viewHarness({ active: ["V"], projects: [pj("p", [w(1, "V", { owner, viewArmed: true })])] });
    await h.boot();
    h.state.active = [];
    h.st.observe(stream("turnComplete", "V", { running: false }));
    await h.settle();
    await h.tick(10 * LINGER_MS);
    assert.deepEqual(h.closed, [], `owner ${owner}`);
    assert.deepEqual(h.arms, [], `owner ${owner}`);
  }
});

test("view windows: promotion to user between evaluations cancels the close", async () => {
  const h = viewHarness({ armed: true });
  await h.boot();
  await h.tick(LINGER_MS - 1000);
  h.state.projects = [pj("p", [w(1, "V", { owner: "user", viewArmed: true })])];
  await h.tick(5 * LINGER_MS);
  assert.deepEqual(h.closed, []);
});

test("view windows: a refused close (still stamped / running) is retried after another linger, not in a loop", async () => {
  const h = viewHarness({ armed: true });
  h.result.closed = false;
  await h.boot();
  await h.tick(LINGER_MS + 1);
  assert.equal(h.closed.length, 1);
  for (let i = 0; i < 5; i++) await h.tick(1000);
  assert.equal(h.closed.length, 1, "no retry inside the next linger");
  await h.tick(LINGER_MS);
  assert.equal(h.closed.length, 2);
});

test("view windows: nothing is armed or closed before the first hydration", async () => {
  const cold = viewHarness({ active: ["V"], armed: true });
  cold.annotate();
  await cold.tick(10 * LINGER_MS);
  assert.deepEqual(cold.closed, [], "before hydration the running set is unknown");
  assert.deepEqual(cold.arms, []);
});

test("view windows: an arm the box refuses (the window is no longer that viewer) arms nothing, so nothing closes", async () => {
  const h = viewHarness({ active: ["V"], armViewWindow: async (a) => { h.arms.push(a); return { armed: false, reason: "changed" }; } });
  await h.boot();
  h.state.active = [];
  h.st.observe(stream("turnComplete", "V", { running: false }));
  await h.settle();
  await h.tick(10 * LINGER_MS);
  assert.ok(h.arms.length >= 1);
  assert.deepEqual(h.closed, [], "never armed → stays");
});
