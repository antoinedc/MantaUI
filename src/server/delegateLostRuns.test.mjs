// Lost runs: a background job whose child opencode stopped mid-turn (restart / crash) leaves the active
// set and never records an outcome. settleV2Job judges it lost only after a grace of repeated, unchanged
// observations. Every opencode / tmux / git call is a fake; nothing live.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createWorld as createHandoffWorld, readyRecord as handoffReadyRecord, settle as handoffSettle } from "./handoff/testWorld.mjs";
import { settleV2Job, reconcileV2Jobs, LOST_RUN_GRACE_MS, LOST_RUN_MESSAGE, BORN_SLACK_MS, _resetLostRuns } from "./delegate.mjs";

const T0 = 1_700_000_000_000;
const PARENT = "ses_parent";
const CHILD = "ses_child0000000000000000000000000000";
const GRACE = LOST_RUN_GRACE_MS;

beforeEach(() => _resetLostRuns());

function world(jobOver = {}) {
  const base = {
    id: "aaaa1111",
    name: "fix-the-bug",
    prompt: "Fix the bug",
    parentSessionID: PARENT,
    parentDirectory: "/repo",
    childSessionID: CHILD,
    tmuxSession: "proj",
    windowIndex: null,
    worktree: null,
    branch: null,
    origin: "delegate",
    actor: "user",
    correlation: null,
    status: "running",
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    result: null,
    error: null,
    engine: "v2",
    completionOwner: "manta",
    attempt: 1,
    launchState: "running",
    submittedAt: T0,
    completionMessageId: null,
    completionDelivery: null,
    launch: { text: "Fix the bug", model: null, messageId: "msg_open" },
    cleanedUp: null,
    ...jobOver,
  };
  const jobs = [base];
  const sessions = new Map([[CHILD, { id: CHILD, parentID: PARENT, directory: "/repo", time: { created: T0, updated: T0 + 10 } }]]);
  const active = new Set();
  const calls = { synth: [], clear: [] };
  const fail = { listActive: null, readSession: null, listChildren: null, perms: null };
  const pending = { permissions: [], questions: [] };
  const state = { now: T0 + 1000 };
  const deps = {
    load: async () => jobs.map((j) => structuredClone(j)),
    save: async (next) => {
      jobs.splice(0, jobs.length, ...next.map((j) => structuredClone(j)));
    },
    publish: () => {},
    now: () => state.now,
    readSession: async (sid) => {
      if (fail.readSession) throw fail.readSession;
      const s = sessions.get(sid);
      return s ? { state: "found", session: structuredClone(s) } : { state: "missing" };
    },
    listActiveIds: async () => {
      if (fail.listActive) throw fail.listActive;
      return [...active];
    },
    listChildSessions: async (sid) => {
      if (fail.listChildren) throw fail.listChildren;
      return [...sessions.values()].filter((s) => s.parentID === sid).map((s) => structuredClone(s));
    },
    listPermissions: async () => {
      if (fail.perms) throw fail.perms;
      return pending.permissions;
    },
    listQuestions: async () => pending.questions,
    listRawTimeline: async (sid, { type } = {}) => (sid === CHILD && (!type || type === "user") ? [{ type: "user", id: "msg_open" }] : []),
    listInbox: async () => [],
    listMessages: async () => [],
    clearProgress: async (sid) => calls.clear.push(sid),
    postSynthetic: async (sid, body) => {
      calls.synth.push({ sid, body });
    },
    deliver: async () => ({ delivered: true }),
    isCtoConversationSession: async () => false,
    openCommandWindows: () => [],
    listProjects: async () => [],
    killWindow: async () => {},
    replacementChain: (sid) => [sid],
    sessionExists: async () => true,
    oc: {},
  };
  return { deps, jobs, sessions, active, calls, fail, pending, state, job: () => jobs[0], child: () => sessions.get(CHILD) };
}

const settle = (w) => settleV2Job(w.job(), w.deps);
const lostSettle = async (w) => {
  const first = await settle(w);
  w.state.now += GRACE;
  return [first, await settle(w)];
};

test("a: opencode-owned, absent, no outcome — first check leaves it running; a check past the grace fails it with the message", async () => {
  const w = world({ completionOwner: "opencode", origin: "observed", parentSessionID: null, runStartedAt: T0, submittedAt: null, launch: undefined });
  const first = await settle(w);
  assert.deepEqual(first, { settled: false, reason: "lost-pending" });
  w.state.now += GRACE - 1;
  assert.equal((await settle(w)).settled, false, "not before the grace");
  assert.equal(w.job().status, "running");
  w.state.now += 1;
  const res = await settle(w);
  assert.equal(res.settled, true);
  assert.equal(res.status, "failed");
  assert.equal(res.lost, true);
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
  assert.equal(w.job().error, "the run was cut off — opencode stopped before it finished");
  assert.equal(w.calls.synth.length, 0, "opencode owns the result");
});

test("b: a stale previous outcome (idle < runStartedAt) is still a lost run, not a finish", async () => {
  const w = world({ completionOwner: "opencode", origin: "observed", parentSessionID: null, runStartedAt: T0 + 500, submittedAt: null, launch: undefined });
  Object.assign(w.child(), { outcome: "succeeded", time: { idle: T0 + 100, updated: T0 + 600 } });
  const [first, second] = await lostSettle(w);
  assert.equal(first.reason, "lost-pending");
  assert.equal(second.settled, true);
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
});

test("c: the child seen active between checks resets the grace", async () => {
  const w = world();
  await settle(w);
  w.state.now += GRACE - 10_000;
  w.active.add(CHILD);
  assert.equal((await settle(w)).reason, "active");
  w.active.delete(CHILD);
  w.state.now += 20_000; // would be past the original grace
  assert.equal((await settle(w)).reason, "lost-pending", "the record restarted");
  assert.equal(w.job().status, "running");
  w.state.now += GRACE;
  assert.equal((await settle(w)).settled, true);
});

test("d: time.updated advancing resets the grace", async () => {
  const w = world();
  await settle(w);
  w.state.now += GRACE - 10_000;
  w.child().time.updated += 5;
  assert.equal((await settle(w)).reason, "lost-pending");
  w.state.now += 20_000;
  assert.equal((await settle(w)).settled, false, "grace counted from the advance");
  w.state.now += GRACE;
  assert.equal((await settle(w)).settled, true);
});

test("e: a Manta-owned submitted job lost → failed, and exactly one result reaches the parent", async () => {
  const w = world();
  const [first, second] = await lostSettle(w);
  assert.equal(first.settled, false);
  assert.equal(second.settled, true);
  assert.equal(second.status, "failed");
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
  assert.equal(w.job().completionDelivery, "delivered");
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.calls.synth[0].sid, PARENT);
  // later sweeps do nothing more
  w.state.now += GRACE;
  assert.equal((await settle(w)).settled, false);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.synth.length, 1);
});

test("f: stopRequested → stopped; Manta-owned pauseRequested → paused", async () => {
  const stopped = world({ stopRequested: true });
  const [, s] = await lostSettle(stopped);
  assert.equal(s.settled, true);
  assert.equal(s.status, "stopped");
  assert.equal(stopped.job().status, "stopped");

  const paused = world({ pauseRequested: true });
  const [, p] = await lostSettle(paused);
  assert.equal(p.settled, true);
  assert.equal(p.status, "paused");
  assert.equal(paused.job().status, "paused");
  assert.equal(paused.calls.synth.length, 0, "a pause reports nothing");

  // an opencode-owned job can't be parked: it fails
  const owned = world({ completionOwner: "opencode", origin: "observed", pauseRequested: true, runStartedAt: T0, submittedAt: null, launch: undefined });
  const [, o] = await lostSettle(owned);
  assert.equal(o.status, "failed");
});

test("g: an unconfirmed launch is never settled by this rule", async () => {
  for (const over of [
    { launchState: "creating", submittedAt: null },
    { launchState: "submitting", submittedAt: T0 },
    { launchState: "uncertain", submittedAt: T0 },
    { launchState: "running", submittedAt: null },
  ]) {
    const w = world(over);
    const [a, b] = await lostSettle(w);
    assert.equal(a.settled, false, JSON.stringify(over));
    assert.equal(b.settled, false, JSON.stringify(over));
    assert.equal(w.job().status, "running", JSON.stringify(over));
  }
  // an uncertain launch proven admitted by its user message is confirmed on THAT check only
  const w = world({ launchState: "uncertain", submittedAt: T0 });
  const [a, b] = await lostSettle(w);
  assert.equal(a.settled, false);
  assert.equal(b.settled, false, "the confirming check does not count");
  assert.equal(w.job().launchState, "running");
});

test("h: a handoff pending on the child defers", async () => {
  const w = world();
  w.deps.deferSettlement = () => true;
  const [a, b] = await lostSettle(w);
  assert.equal(a.reason, "handoff-pending");
  assert.equal(b.reason, "handoff-pending");
  assert.equal(w.job().status, "running");
});

test("i: a pending permission / question, or an active descendant, keeps it running", async () => {
  const perm = world();
  perm.pending.permissions = [{ id: "per_1" }];
  const [pa, pb] = await lostSettle(perm);
  assert.equal(pa.settled || pb.settled, false);

  const q = world();
  q.pending.questions = [{ id: "frm_1" }];
  const [qa, qb] = await lostSettle(q);
  assert.equal(qa.settled || qb.settled, false);
  q.pending.questions = [];
  assert.equal((await settle(q)).reason, "lost-pending", "answered → the grace starts only now");
  q.state.now += GRACE;
  assert.equal((await settle(q)).settled, true);

  const kids = world();
  kids.sessions.set("ses_kid", { id: "ses_kid", parentID: CHILD, time: { updated: T0 } });
  kids.sessions.set("ses_grand", { id: "ses_grand", parentID: "ses_kid", time: { updated: T0 } });
  kids.active.add("ses_grand");
  const [ka, kb] = await lostSettle(kids);
  assert.equal(ka.settled || kb.settled, false);
  assert.equal(kids.job().status, "running");
  // the tree going quiet restarts the grace rather than finishing at once
  kids.active.clear();
  assert.equal((await settle(kids)).reason, "lost-pending");
  kids.state.now += GRACE;
  assert.equal((await settle(kids)).settled, true);
});

test("j: a read that throws leaves the record unchanged", async () => {
  const w = world();
  await settle(w); // record at checks=1, firstSeenAt = now
  w.state.now += GRACE;
  w.fail.perms = new Error("opencode 500");
  assert.equal((await settle(w)).settled, false);
  w.fail.perms = null;
  w.fail.listChildren = new Error("fetch failed");
  assert.equal((await settle(w)).settled, false);
  w.fail.listChildren = null;
  w.fail.listActive = new Error("fetch failed");
  assert.equal((await settle(w)).reason, "unknown");
  w.fail.listActive = null;
  w.fail.readSession = new Error("fetch failed");
  assert.equal((await settle(w)).reason, "unknown");
  w.fail.readSession = null;
  assert.equal(w.job().status, "running");
  // the failed reads neither advanced nor cleared the record: the next good check settles
  assert.equal((await settle(w)).settled, true);
});

test("a fresh outcome still wins, and a session with no time.updated is never judged lost", async () => {
  const done = world();
  Object.assign(done.child(), { outcome: "succeeded", time: { idle: T0 + 50, updated: T0 + 50 } });
  const res = await settle(done);
  assert.equal(res.settled, true);
  assert.equal(res.status, "done");
  assert.equal(done.job().status, "done");

  const blind = world();
  delete blind.child().time;
  const [a, b] = await lostSettle(blind);
  assert.equal(a.reason, "no-outcome");
  assert.equal(b.reason, "no-outcome");
  assert.equal(blind.job().status, "running");
});

test("the sweep's reconcile drives it: two passes a grace apart end the job", async () => {
  const w = world({ completionOwner: "opencode", origin: "observed", parentSessionID: null, runStartedAt: T0, submittedAt: null, launch: undefined });
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job().status, "running");
  w.state.now += GRACE + 60_000;
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
});

// ---- opencode-owned runs: born-for-this-run freshness, real error text, relay backstop ----
const CREATED = 1_794_154_339_553; // the live-box case: a child that failed within a second of its creation
const IDLE = 1_794_154_339_764;
const SEEN = 1_794_154_340_261; // when Manta first saw the run
const DAY = 24 * 60 * 60_000;
const envelope = (state, body) => `<subagent sessionID="${CHILD}" state="${state}" description="the task">\n${body}\n</subagent>`;
const synthetic = (state, body, created = SEEN - 200) => ({
  type: "synthetic",
  id: `msg_${state}`,
  text: envelope(state, body),
  description: "the task",
  metadata: { source: "subagent", childID: CHILD, state },
  time: { created },
});

function ownedWorld({ created = CREATED, idle = IDLE, outcome = "failed", synthetics = [], childTimeline } = {}) {
  const w = world({
    completionOwner: "opencode",
    origin: "subagent",
    parentSessionID: PARENT,
    sessionParentID: PARENT,
    startedAt: SEEN,
    createdAt: SEEN,
    runStartedAt: SEEN,
    submittedAt: null,
    launch: undefined,
  });
  w.state.now = SEEN + 1000;
  w.sessions.set(CHILD, { id: CHILD, parentID: PARENT, directory: "/repo", outcome, time: { created, idle, updated: idle } });
  // The child's own raw timeline: by default ONE execution — its input, then it ended.
  const timeline = childTimeline ?? [
    { type: "user", id: "msg_in", time: { created: created + 10 } },
    { type: "idle", id: "msg_idle", time: { created: idle }, outcome },
  ];
  const base = w.deps.listRawTimeline;
  w.deps.listRawTimeline = async (sid, opts = {}) => {
    if (sid === PARENT && opts.type === "synthetic") return synthetics;
    if (sid === CHILD) return opts.type ? timeline.filter((r) => r.type === opts.type) : timeline;
    return base(sid, opts);
  };
  return w;
}

test("born for this run: a child that failed before Manta saw it ends failed with the parent's error text, not 'cut off'", async () => {
  const w = ownedWorld({ synthetics: [synthetic("failed", "Model unavailable: openrouter/openai/gpt-6.1-sol")] });
  const res = await settle(w);
  assert.equal(res.settled, true);
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, "Model unavailable: openrouter/openai/gpt-6.1-sol");
  assert.equal(w.calls.synth.length, 0, "opencode owns the result");
});

test("born for this run: with nothing readable in the parent the error stays the generic text", async () => {
  const w = ownedWorld();
  assert.equal((await settle(w)).settled, true);
  assert.equal(w.job().error, "The run failed.");
  const unreadable = ownedWorld();
  unreadable.deps.listRawTimeline = async (sid, opts = {}) => {
    if (opts.type === "synthetic") throw new Error("timeline unavailable");
    return [];
  };
  assert.equal((await settle(unreadable)).settled, true);
  assert.equal(unreadable.job().error, "The run failed.");
});

test("a synthetic from before the run began, or about another child, is not this run's text", async () => {
  const w = ownedWorld({
    synthetics: [
      synthetic("failed", "an old failure", CREATED - 5000),
      { ...synthetic("failed", "someone else's failure"), metadata: { source: "subagent", childID: "ses_other", state: "failed" } },
    ],
  });
  await settle(w);
  assert.equal(w.job().error, "The run failed.");
});

test("the newest matching synthetic wins, and the error is capped at 500 characters", async () => {
  const w = ownedWorld({ synthetics: [synthetic("failed", "first", SEEN - 300), synthetic("failed", "x".repeat(900), SEEN - 100)] });
  await settle(w);
  assert.equal(w.job().error, "x".repeat(500));
});

test("a raw error from the event is never replaced by the parent's text", async () => {
  const w = ownedWorld({ synthetics: [synthetic("failed", "from the parent")] });
  const res = await settleV2Job(w.job(), w.deps, { hint: { outcome: "failed", error: "Provider said no", at: IDLE } });
  assert.equal(res.settled, true);
  assert.equal(w.job().error, "Provider said no");
});

test("a done run with no assistant text takes the parent's result body (capped at 2000)", async () => {
  const w = ownedWorld({ outcome: "succeeded", synthetics: [synthetic("completed", "y".repeat(3000))] });
  const res = await settle(w);
  assert.equal(res.status, "done");
  assert.equal(w.job().result, "y".repeat(2000));
  const withText = ownedWorld({ outcome: "succeeded", synthetics: [synthetic("completed", "from the parent")] });
  withText.deps.listMessages = async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "the child's own last text" }] }];
  await settle(withText);
  assert.equal(withText.job().result, "the child's own last text", "the child's own text still comes first");
});

test("an older resumed session keeps the strict rule: its previous outcome cannot finish the new record", async () => {
  const w = ownedWorld({ created: SEEN - 3 * DAY, idle: SEEN - 3 * DAY + 5000, synthetics: [synthetic("failed", "from the earlier run")] });
  const [first, second] = await lostSettle(w);
  assert.equal(first.reason, "lost-pending");
  assert.equal(second.lost, true, "judged lost, not finished by the old outcome");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
});

test("born within the slack: created up to 60 s before the sighting counts; 61 s does not", async () => {
  const inside = ownedWorld({ created: SEEN - BORN_SLACK_MS, idle: SEEN - BORN_SLACK_MS + 50 });
  assert.equal((await settle(inside)).settled, true);
  const outside = ownedWorld({ created: SEEN - BORN_SLACK_MS - 1, idle: SEEN - BORN_SLACK_MS + 10 });
  assert.equal((await settle(outside)).settled, false);
});

test("a Manta-owned job is unaffected by the born rule and never reads the parent's text", async () => {
  const w = world();
  Object.assign(w.child(), { outcome: "failed", time: { created: T0, idle: T0 + 50, updated: T0 + 50 } });
  let read = false;
  const base = w.deps.listRawTimeline;
  w.deps.listRawTimeline = async (sid, opts = {}) => {
    if (opts.type === "synthetic") read = true;
    return base(sid, opts);
  };
  await settle(w);
  assert.equal(w.job().error, "The run failed.");
  assert.equal(read, false);
});

test("relay backstop: an opencode-owned run whose parent was handed off asks for the result to be relayed, once", async () => {
  const w = ownedWorld({ synthetics: [synthetic("failed", "boom")] });
  const relays = [];
  w.deps.successorOf = (sid) => (sid === PARENT ? "ses_successor" : null);
  w.deps.relayBackgroundResult = async (a) => { relays.push(a); return { relayed: true }; };
  await settle(w);
  await settle(w); // already terminal: nothing more
  assert.deepEqual(relays, [{ sessionId: PARENT, childSessionId: CHILD }]);

  const live = ownedWorld({ synthetics: [synthetic("failed", "boom")] });
  const liveRelays = [];
  live.deps.relayBackgroundResult = async (a) => { liveRelays.push(a); return { relayed: false, reason: "live" }; };
  await settle(live);
  assert.deepEqual(liveRelays, [{ sessionId: PARENT, childSessionId: CHILD }], "the engine is asked and decides (live / fenced / replaced) — the caller keeps no guard of its own");

  const owned = world();
  Object.assign(owned.child(), { outcome: "succeeded", time: { created: T0, idle: T0 + 50, updated: T0 + 50 } });
  const ownedRelays = [];
  owned.deps.successorOf = () => "ses_successor";
  owned.deps.relayBackgroundResult = async (a) => { ownedRelays.push(a); };
  await settle(owned);
  assert.deepEqual(ownedRelays, [], "Manta posts its own results; nothing to relay");
});

test("relay backstop, end to end through settlement: the enqueue event was missed, the child settles DURING the parent's handoff fence, and after the commit the successor receives the result once", async () => {
  // a REAL handoff engine over its fake world, parked inside the fence (after the successor exists, before the commit)
  const hw = createHandoffWorld({ mode: "off" });
  hw.addSession(PARENT);
  hw.addWindow("proj", 3, "work", PARENT);
  let open;
  const parked = new Promise((r) => (open = r));
  let reachedFence;
  const reached = new Promise((r) => (reachedFence = r));
  hw.engine = hw.build({ hooks: { step: async (n) => { if (n === "create") { reachedFence(); await parked; } } } });
  const card = await handoffReadyRecord(hw, { sessionId: PARENT });
  const started = hw.engine.start(card.id, { how: "clear", disposition: "send" });
  await reached;
  assert.ok(hw.engine._state.fences[PARENT], "the parent is fenced");
  // opencode already posted the result to the parent (no enqueue event reached the engine)
  const posted = { ...synthetic("failed", "boom"), id: "msg_missed_result" };
  hw.timelines.set(PARENT, [{ id: "msg_idle0", type: "idle", time: { created: 1 } }, posted]);

  // the delegate engine settles the opencode-owned child, wired as in index.mjs
  const w = ownedWorld({ synthetics: [posted] });
  w.deps.successorOf = (sid) => hw.engine.successorOf(sid); // null while fenced: the guard the caller used to keep
  w.deps.relayBackgroundResult = (a) => hw.engine.relayBackgroundResult(a);
  assert.equal((await settle(w)).settled, true);
  await handoffSettle(10);
  assert.equal(hw.engine._state.arrivals[PARENT]?.length, 1, "the settlement reached the engine, which recorded it for the commit");

  open();
  const out = await started;
  await handoffSettle(10);
  assert.equal(out.state, "committed");
  const copies = hw.posts.filter((p) => p.kind === "synthetic" && p.target === out.successorId);
  assert.equal(copies.length, 1, "the successor received the result exactly once");
  assert.equal(copies[0].args.metadata.relayedMessageId, "msg_missed_result");
  assert.equal(hw.posts.filter((p) => p.kind === "synthetic" && p.target === PARENT).length, 0);
});

test("relay backstop: a failing relay is logged, never thrown, and the record still settles", async () => {
  const w = ownedWorld({ synthetics: [synthetic("failed", "boom")] });
  w.deps.successorOf = () => "ses_successor";
  w.deps.relayBackgroundResult = async () => { throw new Error("relay broke"); };
  const warn = console.warn;
  const logged = [];
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    assert.equal((await settle(w)).settled, true);
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = warn;
  }
  assert.equal(w.job().status, "failed");
  assert.ok(logged.some((l) => /relay broke/.test(l)));
});

// ---- review round: born-for-run only for a provable first run; the parent is read lazily ----
const firstRunRecord = (over = {}) => ({
  id: "first000",
  name: "fix-the-bug",
  parentSessionID: PARENT,
  sessionParentID: PARENT,
  childSessionID: CHILD,
  origin: "subagent",
  engine: "v2",
  completionOwner: "opencode",
  status: "done",
  attempt: 1,
  continues: null,
  runStartedAt: CREATED + 100,
  finishedAt: CREATED + 5000,
  supersededBy: "rec2",
  ...over,
});

test("a resumed record never takes the born allowance: the first run's outcome cannot finish the second, which is lost", async () => {
  // t=0 child created · t=5 s first run ends · t=20 s the session is resumed and recorded · the second run is cut off
  const w = ownedWorld({ outcome: "succeeded", idle: CREATED + 5000, synthetics: [synthetic("completed", "the first run's result")] });
  Object.assign(w.job(), { id: "rec2", attempt: 2, continues: "first000", runStartedAt: CREATED + 20_000, startedAt: CREATED + 20_000 });
  w.jobs.push(firstRunRecord());
  w.state.now = CREATED + 21_000;
  const [first, second] = await lostSettle(w);
  assert.equal(first.reason, "lost-pending");
  assert.equal(second.lost, true, "judged lost, not finished by the first run's outcome");
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
});

test("born allowance needs attempt 1, no continuation and no other record of the child in the store", async () => {
  const strict = async (patch, others = []) => {
    const w = ownedWorld({ outcome: "succeeded", idle: CREATED + 5000 });
    Object.assign(w.job(), { runStartedAt: CREATED + 20_000 }, patch);
    for (const o of others) w.jobs.push(o);
    w.state.now = CREATED + 21_000;
    return (await settle(w)).settled;
  };
  assert.equal(await strict({}), true, "a lone first record: the allowance applies");
  assert.equal(await strict({ attempt: 2 }), false, "attempt 2");
  assert.equal(await strict({ continues: "x" }), false, "continues another record");
  assert.equal(await strict({}, [firstRunRecord({ id: "other", supersededBy: null, status: "stopped" })]), false, "another record of the same child, whatever its status");
  assert.equal(await strict({}, [firstRunRecord({ id: "elsewhere", childSessionID: "ses_unrelated" })]), true, "another child's record is irrelevant");
});

test("an unreadable job store keeps the strict rule", async () => {
  const w = ownedWorld({ outcome: "succeeded", idle: CREATED + 5000 });
  w.job().runStartedAt = CREATED + 20_000;
  const load = w.deps.load;
  let calls = 0;
  w.deps.load = async () => {
    // the first read (effectiveRunStart) fails; later ones (finishV2Job) must still work
    if (++calls === 1) throw new Error("store unreadable");
    return load();
  };
  assert.equal((await settle(w)).settled, false);
});

function countParentReads(w) {
  const reads = [];
  const base = w.deps.listRawTimeline;
  w.deps.listRawTimeline = async (sid, opts = {}) => {
    if (sid === PARENT && opts.type === "synthetic") reads.push(sid);
    return base(sid, opts);
  };
  return reads;
}
const childSaid = (text) => async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];

test("lazy parent read: a done run whose child has text never reads the parent's timeline", async () => {
  const w = ownedWorld({ outcome: "succeeded", synthetics: [synthetic("completed", "from the parent")] });
  w.deps.listMessages = childSaid("the child's own text");
  const reads = countParentReads(w);
  assert.equal((await settle(w)).status, "done");
  assert.equal(w.job().result, "the child's own text");
  assert.deepEqual(reads, [], "zero parent-timeline reads");
});

test("lazy parent read: a done run with no child text reads the parent exactly once", async () => {
  const w = ownedWorld({ outcome: "succeeded", synthetics: [synthetic("completed", "from the parent")] });
  const reads = countParentReads(w);
  await settle(w);
  assert.equal(w.job().result, "from the parent");
  assert.equal(reads.length, 1);
});

test("lazy parent read: a failed run with a raw error never reads the parent; one without reads it once", async () => {
  const withError = ownedWorld({ synthetics: [synthetic("failed", "from the parent")] });
  const none = countParentReads(withError);
  await settleV2Job(withError.job(), withError.deps, { hint: { outcome: "failed", error: "Provider said no", at: IDLE } });
  assert.deepEqual(none, []);
  assert.equal(withError.job().error, "Provider said no");

  const bare = ownedWorld({ synthetics: [synthetic("failed", "from the parent")] });
  const once = countParentReads(bare);
  await settle(bare);
  assert.equal(once.length, 1);
  assert.equal(bare.job().error, "from the parent");
});

test("lazy parent read: an unreadable parent timeline leaves a done run's result empty and still settles it", async () => {
  const w = ownedWorld({ outcome: "succeeded" });
  w.deps.listRawTimeline = async (sid, opts = {}) => {
    if (opts.type === "synthetic") throw new Error("timeline unavailable");
    return [];
  };
  const res = await settle(w);
  assert.equal(res.status, "done");
  assert.equal(w.job().result, null);
});

// ---- review round 2: "first run" is proven by opencode's own timeline of the child ----
test("a child that ran INLINE and was resumed in the background within 60 s is not a first run: its lost second run is not finished by the inline outcome", async () => {
  // No job record exists for the inline run — only opencode's timeline of the child knows it ran before.
  const w = ownedWorld({
    outcome: "succeeded",
    idle: CREATED + 5000,
    synthetics: [synthetic("completed", "the inline run's result")],
    childTimeline: [
      { type: "user", id: "msg_1", time: { created: CREATED + 10 } },
      { type: "idle", id: "idle_1", time: { created: CREATED + 5000 }, outcome: "succeeded" },
      { type: "user", id: "msg_2", time: { created: CREATED + 20_000 } }, // the background resume — then opencode died
    ],
  });
  Object.assign(w.job(), { runStartedAt: CREATED + 20_000, startedAt: CREATED + 20_000 });
  w.state.now = CREATED + 21_000;
  assert.equal(w.jobs.length, 1, "no record of the inline run");
  const [first, second] = await lostSettle(w);
  assert.equal(first.reason, "lost-pending");
  assert.equal(second.lost, true, "judged lost, not finished (done) by the inline run's outcome");
  assert.equal(w.job().status, "failed");
  assert.equal(w.job().error, LOST_RUN_MESSAGE);
});

test("the born allowance needs ONE execution in the child's own timeline; unreadable or unprovable keeps the strict rule", async () => {
  const run = async (childTimeline, tweak) => {
    const w = ownedWorld({ outcome: "failed", synthetics: [synthetic("failed", "Model unavailable: x")], childTimeline });
    tweak?.(w);
    return { w, res: await settle(w) };
  };
  const one = await run(undefined);
  assert.equal(one.res.settled, true, "the original single-execution case still settles");
  assert.equal(one.w.job().status, "failed");
  assert.equal(one.w.job().error, "Model unavailable: x");

  const runningFirst = await run([{ type: "user", id: "u", time: { created: CREATED + 10 } }, { type: "idle", id: "i", time: { created: IDLE }, outcome: "failed" }]);
  assert.equal(runningFirst.res.settled, true);

  const twoIdles = await run([
    { type: "user", id: "u1", time: { created: CREATED + 10 } },
    { type: "idle", id: "i1", time: { created: CREATED + 100 }, outcome: "succeeded" },
    { type: "idle", id: "i2", time: { created: IDLE }, outcome: "failed" },
  ]);
  assert.equal(twoIdles.res.settled, false, "two executions");

  const inputAfter = await run([
    { type: "user", id: "u1", time: { created: CREATED + 10 } },
    { type: "idle", id: "i1", time: { created: IDLE }, outcome: "failed" },
    { type: "user", id: "u2", time: { created: IDLE + 1 } },
  ]);
  assert.equal(inputAfter.res.settled, false, "input after the first execution's end");

  const unreadable = await run(undefined, (w) => {
    const base = w.deps.listRawTimeline;
    w.deps.listRawTimeline = async (sid, opts = {}) => {
      if (sid === CHILD) throw new Error("timeline unavailable");
      return base(sid, opts);
    };
  });
  assert.equal(unreadable.res.settled, false, "unreadable");

  const noReader = await run(undefined, (w) => { delete w.deps.listRawTimeline; });
  assert.equal(noReader.res.settled, false, "no reader");

  const undated = await run([{ type: "user", id: "u1" }, { type: "idle", id: "i1", time: {}, outcome: "failed" }]);
  assert.equal(undated.res.settled, false, "an idle with no time cannot prove anything");
});
