// Stage C1: `delegate` background jobs on the V2 engine (every job except the CTO's):
// create → move → window → send, undo on a definite refusal and NEVER on an unknown
// outcome, raw-outcome completion (interrupted → paused / stopped / failed), pause at
// a tool boundary, resume as a fresh child, the one N7 result per job through every
// route to a terminal state, and the races between them. Every opencode / tmux / git
// call is a fake over one in-memory world; nothing live.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startJob,
  resumeJob,
  pauseJob,
  stopJob,
  finishV2Job,
  settleV2Job,
  observeEvent,
  reconcileV2Jobs,
  reconcileJobsOnBoot,
  retryPendingDeliveries,
  sweepDelegateJobs,
  buildCompletionText,
  createDelegateEngine,
  MAX_RUNNING_JOBS,
  CAP_ERROR,
} from "./delegate.mjs";

const T0 = 1_700_000_000_000;
const PARENT = "ses_parent";
const REPO = "/repo";
const WT = "/wt/fix-the-bug";

const httpErr = (status, message = `opencode ${status}`) => Object.assign(new Error(message), { status });
const netErr = () => new Error("fetch failed");

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
function world({ jobs: seed = [], git = true } = {}) {
  const jobs = seed.map((j) => ({ ...j }));
  const calls = { create: [], move: [], send: [], window: [], kill: [], del: [], synth: [], deliver: [], abort: [], rmWorktree: [], addWorktree: [], stamp: [] };
  const log = []; // the order the network / tmux calls happened in
  const sessions = new Map([[PARENT, { id: PARENT, directory: REPO, agent: "build" }]]);
  const active = new Set();
  const inboxes = new Map();
  const timelines = new Map();
  const messages = new Map();
  const windows = [{ index: 0, opencodeSessionId: PARENT, paneCurrentPath: REPO }];
  const records = new Map(); // parent synthetic records, deduped by id like V2 does (U2)
  const fail = { create: null, move: null, send: null, window: null, synth: [], dirty: false, addWorktree: null };
  const state = { now: T0, nextWindow: 5, cto: false, ctoResult: undefined, git, moveLag: 0, pendingMove: null, readPolls: 0 };
  const storeAt = (label) => log.push({ label, store: jobs.map((j) => ({ ...j })) });

  // V2 applies a move as an inbox item run by an execution of its own, so the child's
  // directory changes (and its first outcome appears) a little AFTER the 204.
  const applyMove = (sid, { poll = false } = {}) => {
    const pm = state.pendingMove;
    if (!pm || pm.sid !== sid) return;
    if (poll && pm.lag-- > 0) return;
    state.pendingMove = null;
    const s = sessions.get(sid);
    if (!s) return;
    s.directory = pm.directory;
    s.outcome = "succeeded";
    s.time = { ...(s.time ?? {}), idle: state.now };
    active.delete(sid);
    inboxes.set(sid, (inboxes.get(sid) ?? []).filter((i) => i.type !== "move"));
  };

  const deps = {
    sleep: async () => {},
    load: async () => jobs.map((j) => structuredClone(j)),
    save: async (next) => {
      jobs.splice(0, jobs.length, ...next.map((j) => structuredClone(j)));
    },
    publish: () => {},
    now: () => state.now,
    listProjects: async () => [{ tmuxSession: "proj", defaultCwd: REPO, windows: windows.map((x) => ({ ...x })) }],
    newWindow: async (i) => {
      calls.window.push(i);
      storeAt("window");
      if (fail.window) throw fail.window;
      const idx = state.nextWindow++;
      windows.push({ index: idx, opencodeSessionId: i.existingSessionId, paneCurrentPath: i.cwd });
      return { sessionId: i.existingSessionId ?? "ses_legacy_made", windowIndex: idx };
    },
    stampOwner: async (...a) => calls.stamp.push(a),
    killWindow: async (i) => {
      calls.kill.push(i);
      const at = windows.findIndex((x) => x.index === i.windowIndex);
      if (at !== -1) windows.splice(at, 1);
    },
    gitAddWorktree: async ({ cwd, name }) => {
      calls.addWorktree.push({ cwd, name });
      if (!state.git || fail.addWorktree) throw fail.addWorktree ?? new Error("not a git repository");
      return { path: `/wt/${name}`, branch: `job/${name}` };
    },
    gitRemoveWorktree: async (i) => {
      calls.rmWorktree.push(i);
      return fail.dirty ? { removed: false, reason: "dirty" } : { removed: true };
    },
    gitRun: async (args) => {
      if (args.includes("rev-parse")) return { stdout: "abc123\n" };
      if (args.includes("diff")) return { stdout: "a.txt\nb.txt\n" };
      return { stdout: "" };
    },
    readSession: async (sid) => {
      state.readPolls++;
      applyMove(sid, { poll: true });
      const s = sessions.get(sid);
      return s ? { state: "found", session: structuredClone(s) } : { state: "missing" };
    },
    listActiveIds: async () => [...active],
    listChildSessions: async (sid) => [...sessions.values()].filter((s) => s.parentID === sid).map((s) => structuredClone(s)),
    listRawTimeline: async (sid, { type } = {}) => (timelines.get(sid) ?? []).filter((r) => !type || r.type === type),
    listInbox: async (sid) => inboxes.get(sid) ?? [],
    createChildSession: async (input) => {
      calls.create.push(input);
      storeAt("create");
      if (fail.create) throw fail.create;
      sessions.set(input.id, { id: input.id, parentID: input.parentID, directory: REPO, agent: input.agent, permissions: input.permission });
      return { id: input.id };
    },
    moveSession: async (sid, directory) => {
      calls.move.push({ sid, directory });
      storeAt("move");
      if (fail.move) throw fail.move;
      inboxes.set(sid, [...(inboxes.get(sid) ?? []), { id: `msg_move_${calls.move.length}`, type: "move", payload: { location: { directory } } }]);
      state.pendingMove = { sid, directory, lag: state.moveLag };
      if (state.moveLag === 0) applyMove(sid);
    },
    sendChildPrompt: async (input) => {
      calls.send.push(input);
      storeAt("send");
      if (fail.send) throw fail.send;
      state.sentAfterMoveApplied = state.pendingMove === null;
      timelines.set(input.sessionId, [...(timelines.get(input.sessionId) ?? []), { type: "user", id: input.messageID }]);
      active.add(input.sessionId);
      const s = sessions.get(input.sessionId);
      if (s) delete s.outcome; // a new execution is running
    },
    deleteSession: async (sid) => {
      calls.del.push(sid);
      sessions.delete(sid);
    },
    postSynthetic: async (sid, body) => {
      calls.synth.push({ sid, body });
      const mode = fail.synth.shift();
      if (mode === "refuse") throw httpErr(500);
      if (mode === "gone") throw httpErr(404);
      if (!records.has(body.id)) records.set(body.id, { sid, body }); // idempotent by id
      if (mode === "lost") throw netErr(); // admitted, response lost
    },
    deliver: async (a) => {
      calls.deliver.push(a);
      return state.ctoResult;
    },
    isCtoConversationSession: async () => state.cto,
    listMessages: async (sid) => messages.get(sid) ?? [],
    clearProgress: async () => {},
    openCommandWindows: () => [],
    abortSession: async (sid) => {
      calls.abort.push(sid);
    },
    sessionExists: async (sid) => sessions.has(sid),
    oc: {},
  };
  return {
    deps,
    calls,
    log,
    sessions,
    active,
    inboxes,
    timelines,
    windows,
    records,
    fail,
    state,
    get jobs() {
      return jobs;
    },
    job: (id) => jobs.find((j) => j.id === id),
    say(sid, text) {
      messages.set(sid, [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]);
    },
    // a child that ended with `outcome`
    finish(sid, outcome, idleAt = state.now) {
      const s = sessions.get(sid);
      s.outcome = outcome;
      s.time = { ...(s.time ?? {}), idle: idleAt };
      active.delete(sid);
    },
  };
}

const input = (extra = {}) => ({ prompt: "Fix the bug in the parser", name: "fix the bug", parentSessionID: PARENT, parentDirectory: REPO, ...extra });
const start = async (w, extra) => {
  const res = await startJob(input(extra), w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.job.id;
};
// how many results the parent was told about this job: parent records + legacy deliveries
const results = (w) => ({ records: w.records.size, deliveries: w.calls.deliver.length });
const raw = (type, sid, extra = {}) => ({ type, data: { sessionID: sid, ...extra } });

// ---------------------------------------------------------------------------
// the launch (steps 1–5)
// ---------------------------------------------------------------------------

test("C1 startJob: registers FIRST, then create → move → window → send in order, on the child", async () => {
  const w = world();
  const id = await start(w, { permission: [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }] });
  const job = w.job(id);

  assert.deepEqual(w.log.map((l) => l.label), ["create", "move", "window", "send"], "network + tmux steps happen in the specified order");
  const atCreate = w.log[0].store;
  assert.equal(atCreate.length, 1, "the record exists BEFORE the child is created");
  assert.equal(atCreate[0].launchState, "creating");
  assert.match(atCreate[0].childSessionID, /^ses_[0-9a-f]{32}$/, "a client-minted child id");
  assert.match(atCreate[0].completionMessageId, /^msg_/, "the result id is minted up front");

  const c = w.calls.create[0];
  assert.equal(c.id, job.childSessionID);
  assert.equal(c.parentID, PARENT);
  assert.equal(c.title, job.name);
  assert.equal(c.directory, REPO, "created at the parent's location");
  assert.equal(c.agent, "build");
  assert.deepEqual(c.permission, job.permission, "today's preflight ruleset, catch-all deny first");
  assert.equal(c.permission[0].action, "deny");

  assert.deepEqual(w.calls.move, [{ sid: job.childSessionID, directory: WT }], "moved into the worktree");
  assert.equal(w.calls.window[0].existingSessionId, job.childSessionID, "the window is stamped with the child");
  assert.equal(w.calls.window[0].cwd, WT);
  assert.equal(w.calls.window[0].worktreePath, WT);
  assert.equal(w.calls.window[0].chatMode, true);
  assert.deepEqual(w.calls.stamp[0], ["proj", job.windowIndex, "job"]);

  assert.equal(w.calls.send.length, 1, "exactly one opening prompt");
  const s = w.calls.send[0];
  assert.equal(s.sessionId, job.childSessionID, "sent TO THE CHILD");
  assert.match(s.text, /Fix the bug in the parser/);
  assert.match(s.text, new RegExp(`isolated git worktree at ${WT}`));
  assert.equal(s.agent, "build");
  assert.match(s.messageID, /^msg_/, "a persisted message id: a retry after an unknown outcome admits once");
  const atSend = w.log[3].store[0];
  assert.equal(atSend.submittedAt, T0, "submittedAt is persisted BEFORE the send");
  assert.equal(atSend.launchState, "submitting");

  assert.equal(job.status, "running");
  assert.equal(job.launchState, "running");
  assert.equal(job.engine, "v2");
  assert.equal(job.completionOwner, "manta");
  assert.equal(job.attempt, 1);
  assert.equal(job.origin, "delegate");
  assert.equal(job.actor, "user");
  assert.equal(job.worktree, WT);
  assert.equal(job.branch, "job/fix-the-bug");
  assert.equal(job.baseSha, "abc123");
  assert.equal(job.executionDirectory, WT);
  assert.equal(job.tmuxSession, "proj");
  assert.deepEqual(w.calls.deliver, [], "no legacy promptDelivery on the way in either");
});

test("C1 startJob: the named model reaches the child's create AND the opening prompt", async () => {
  const w = world();
  const id = await start(w, { model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
  assert.deepEqual(w.calls.create[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  assert.deepEqual(w.calls.send[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  assert.equal(w.job(id).requestedModel, "anthropic/claude-sonnet-5-5");
});

test("C1 startJob: a non-repository job (no worktree) is NOT moved", async () => {
  const w = world({ git: false });
  const id = await start(w);
  const job = w.job(id);
  assert.equal(job.worktree, null);
  assert.equal(job.executionDirectory, REPO);
  assert.deepEqual(w.calls.move, [], "created at the parent's directory already");
  assert.equal(w.calls.window[0].cwd, REPO);
  assert.equal(w.calls.window[0].worktreePath, undefined);
  assert.equal(w.calls.send.length, 1);
  assert.doesNotMatch(w.calls.send[0].text, /isolated git worktree/);
});

test("C1 startJob: isolationRequired + a worktree failure refuses BEFORE anything is created", async () => {
  const w = world({ git: false });
  const res = await startJob(input({ isolationRequired: true }), w.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, "worktree_failed");
  assert.deepEqual([w.calls.create, w.calls.move, w.calls.window, w.calls.send].map((c) => c.length), [0, 0, 0, 0]);
  assert.equal(w.jobs.length, 0);
});

test("C1 startJob: a forge/inbox style call without an actor is V2 too", async () => {
  const w = world();
  const res = await startJob(input({ link: { issue: { repoKey: "github.com/a/b", number: 4 } } }), w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.job.engine, "v2");
  assert.deepEqual(res.job.link, { issue: { repoKey: "github.com/a/b", number: 4 } });
});

test("C1 startJob: the cap and the no-nesting rule refuse before anything is created (no worktree either)", async () => {
  const running = Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => ({ id: `cap${i}`, name: "x", parentSessionID: "ses_other", childSessionID: `ses_cap${i}`, status: "running", origin: "delegate" }));
  const w = world({ jobs: running });
  const capRes = await startJob(input(), w.deps);
  assert.equal(capRes.error, CAP_ERROR);
  const w2 = world({ jobs: [{ id: "n1", name: "n", parentSessionID: "ses_o", childSessionID: PARENT, status: "running", origin: "delegate" }] });
  const nest = await startJob(input(), w2.deps);
  assert.match(nest.error, /cannot start another background job/);
  for (const x of [w, w2]) {
    assert.equal(x.calls.addWorktree.length, 0);
    assert.equal(x.calls.create.length, 0);
  }
});

test("C1 startJob: concurrent starts never exceed the cap and never leak a worktree", async () => {
  const w = world();
  const N = MAX_RUNNING_JOBS + 3;
  const out = await Promise.all(Array.from({ length: N }, (_, i) => startJob(input({ prompt: `job ${i}`, name: `job ${i}` }), w.deps)));
  assert.equal(out.filter((r) => r.ok).length, MAX_RUNNING_JOBS);
  assert.equal(out.filter((r) => !r.ok && r.error === CAP_ERROR).length, N - MAX_RUNNING_JOBS);
  assert.equal(w.calls.addWorktree.length, MAX_RUNNING_JOBS, "refused starts made no worktree");
});

test("C1 startJob: a missing V2 dependency fails loudly instead of silently doing nothing", async () => {
  const w = world();
  delete w.deps.moveSession;
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /moveSession is missing/);
  assert.equal(w.calls.window.length, 0);
});

// ---------------------------------------------------------------------------
// undo on a DEFINITE refusal, at each failure point
// ---------------------------------------------------------------------------

const nothingLeft = (w) => {
  assert.equal(w.jobs.length, 0, "the record is deleted");
  assert.deepEqual(w.calls.rmWorktree.map((r) => r.path), [WT], "the worktree is removed (never forced)");
  assert.equal(w.calls.rmWorktree[0].force, false);
};

test("C1 undo: a definite refusal of the create → worktree + record removed; there is no child to delete", async () => {
  const w = world();
  w.fail.create = httpErr(400, "bad request");
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /bad request/);
  nothingLeft(w);
  assert.deepEqual(w.calls.del, [], "the child never existed");
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.send.length, 0);
});

test("C1 undo: a definite refusal of the move → child deleted, worktree + record removed, no window, nothing sent", async () => {
  const w = world();
  w.fail.move = httpErr(400, "outside the project");
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /could not move the session into its worktree/);
  nothingLeft(w);
  assert.equal(w.calls.del.length, 1);
  assert.equal(w.calls.del[0], w.calls.create[0].id);
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.send.length, 0);
});

test("C1 undo: the window failing → child deleted, worktree + record removed, nothing sent", async () => {
  const w = world();
  w.fail.window = new Error("tmux said no");
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /tmux said no/);
  nothingLeft(w);
  assert.deepEqual(w.calls.del, [w.calls.create[0].id]);
  assert.equal(w.calls.send.length, 0);
});

test("C1 undo: a definite refusal of the opening prompt → child deleted, window closed, worktree + record removed", async () => {
  const w = world();
  w.fail.send = httpErr(422, "model not found");
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /model not found/);
  nothingLeft(w);
  assert.deepEqual(w.calls.del, [w.calls.create[0].id]);
  assert.equal(w.calls.kill.length, 1, "the window was closed");
  assert.equal(w.windows.some((x) => x.opencodeSessionId === w.calls.create[0].id), false);
});

test("C1 undo: a refusal in a repo-less job removes no worktree (there is none)", async () => {
  const w = world({ git: false });
  w.fail.send = httpErr(400);
  await startJob(input(), w.deps);
  assert.equal(w.calls.rmWorktree.length, 0);
  assert.equal(w.jobs.length, 0);
});

// ---------------------------------------------------------------------------
// an UNKNOWN outcome is never rolled back
// ---------------------------------------------------------------------------

const keptEverything = (w, { child = true } = {}) => {
  assert.equal(w.jobs.length, 1, "the record is kept");
  assert.equal(w.jobs[0].launchState, "uncertain");
  assert.equal(w.jobs[0].status, "running");
  assert.deepEqual(w.calls.rmWorktree, [], "the worktree is kept");
  assert.deepEqual(w.calls.del, [], "no child is deleted");
  assert.deepEqual(w.calls.kill, [], "no window is closed");
  if (child) assert.ok(w.sessions.has(w.jobs[0].childSessionID));
};

for (const [label, mk] of [["a network error", netErr], ["a 5xx", () => httpErr(503)]]) {
  test(`C1 uncertain create (${label}): everything is kept, marked uncertain, nothing else is done`, async () => {
    const w = world();
    w.fail.create = mk();
    const res = await startJob(input(), w.deps);
    assert.equal(res.ok, true);
    assert.equal(res.uncertain, true);
    keptEverything(w, { child: false });
    assert.equal(w.calls.window.length + w.calls.send.length + w.calls.move.length, 0);
  });
}

test("C1 uncertain move: everything is kept; the launch does not go on without the move", async () => {
  const w = world();
  w.fail.move = netErr();
  const res = await startJob(input(), w.deps);
  assert.equal(res.uncertain, true);
  keptEverything(w);
  assert.equal(w.calls.window.length + w.calls.send.length, 0);
});

test("C1 uncertain opening prompt: record, child, worktree and window are all kept; submittedAt is never rewritten", async () => {
  const w = world();
  w.fail.send = netErr();
  const res = await startJob(input(), w.deps);
  assert.equal(res.uncertain, true);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].launchState, "uncertain");
  assert.equal(w.jobs[0].submittedAt, T0);
  assert.deepEqual(w.calls.rmWorktree.concat(w.calls.del, w.calls.kill), []);
  assert.equal(w.calls.send.length, 1);
  // …and the sweeps never re-send it, however many run
  await reconcileV2Jobs(w.deps);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.send.length, 1, "a prompt that may have been admitted is never sent twice");
  assert.equal(w.jobs[0].submittedAt, T0);
});

test("C1 uncertain opening prompt: admission evidence (the child ran) makes it running, and it completes normally", async () => {
  const w = world();
  w.fail.send = netErr();
  await startJob(input(), w.deps);
  const job = w.jobs[0];
  assert.equal(job.launchState, "uncertain");
  // admitted after all: the child holds the user message and is running
  w.timelines.set(job.childSessionID, [{ type: "user", id: "msg_late" }]);
  w.active.add(job.childSessionID);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).launchState, "running");
  w.say(job.childSessionID, "all done");
  w.finish(job.childSessionID, "succeeded", T0 + 5);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).status, "done");
  assert.equal(w.records.size, 1);
});

test("C1 uncertain create: when the child later provably exists, the reconcile finishes the launch — move, window, ONE send", async () => {
  const w = world();
  w.fail.create = netErr();
  await startJob(input(), w.deps);
  const job = w.jobs[0];
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.send.length, 0, "no child yet: nothing is sent, nothing rolled back");
  assert.equal(w.jobs.length, 1);
  // the create landed after all
  w.sessions.set(job.childSessionID, { id: job.childSessionID, parentID: PARENT, directory: REPO });
  await reconcileV2Jobs(w.deps);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.move.length, 1, "moved into the worktree");
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.send.length, 1, "exactly ONE opening prompt, however many reconciles");
  assert.equal(w.calls.send[0].sessionId, job.childSessionID);
  assert.equal(w.job(job.id).launchState, "running");
});

test("C1 reconcile: a move already queued in the child's inbox is not re-issued, and a pending move is not admission evidence", async () => {
  const w = world();
  // a launch that was cut off right after the move request: the state, by hand
  const jobId = "j1";
  w.jobs.push({
    id: jobId, name: "n", prompt: "p", parentSessionID: PARENT, parentDirectory: REPO, childSessionID: "ses_c1", tmuxSession: "proj", windowIndex: null,
    worktree: WT, branch: "b", baseSha: "x", origin: "delegate", actor: "user", status: "running", createdAt: T0, startedAt: T0, finishedAt: null,
    engine: "v2", completionOwner: "manta", attempt: 1, launchState: "uncertain", submittedAt: null, completionMessageId: "msg_c1", completionDelivery: null,
    agent: "build", executionDirectory: WT, launch: { text: "go", model: null, messageId: "msg_l1" },
  });
  w.sessions.set("ses_c1", { id: "ses_c1", parentID: PARENT, directory: REPO });
  w.inboxes.set("ses_c1", [{ id: "msg_m", type: "move", payload: { location: { directory: WT } } }]);
  w.state.pendingMove = { sid: "ses_c1", directory: WT, lag: 2 }; // lands after two polls
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.move.length, 0, "the move is already queued");
  assert.equal(w.calls.send.length, 1);
  assert.equal(w.state.sentAfterMoveApplied, true, "…and the prompt waited for it to land");
  // a launch whose prompt outcome is unknown, with only the move item pending, has no admission evidence
  const w2 = world();
  w2.jobs.push({ ...w.jobs[0], launchState: "uncertain", submittedAt: T0, windowIndex: 5 });
  w2.sessions.set("ses_c1", { id: "ses_c1", parentID: PARENT, directory: REPO });
  w2.inboxes.set("ses_c1", [{ id: "msg_m", type: "move", payload: { location: { directory: WT } } }]);
  await reconcileV2Jobs(w2.deps);
  assert.equal(w2.job("j1").launchState, "uncertain", "a pending move proves nothing about the prompt");
});

test("C1 reconcile: a definite refusal found while finishing a reported-as-started launch ends the job failed, with its one result", async () => {
  const w = world();
  w.fail.create = netErr();
  await startJob(input(), w.deps);
  const job = w.jobs[0];
  w.sessions.set(job.childSessionID, { id: job.childSessionID, parentID: PARENT, directory: REPO });
  w.fail.send = httpErr(422, "no such model");
  await reconcileV2Jobs(w.deps);
  const done = w.job(job.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /could not start: .*no such model/);
  assert.equal(w.records.size, 1, "the caller was told it started, so it gets one result");
  assert.equal(done.completionDelivery, "delivered");
});

test("C1 stop mid-launch: a job ended while its window was being made never gets a prompt, and its child is taken back", async () => {
  const w = world();
  const newWindow = w.deps.newWindow;
  let stopped;
  w.deps.newWindow = async (i) => {
    const out = await newWindow(i);
    stopped = await stopJob(w.jobs[0].id, w.deps);
    return out;
  };
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, false);
  assert.equal(stopped.ok, true);
  assert.equal(w.calls.send.length, 0, "no prompt for a stopped job");
  assert.deepEqual(w.calls.del, [w.calls.create[0].id]);
  assert.equal(w.jobs[0].status, "stopped", "the record keeps the terminal state");
  assert.equal(w.records.size, 1);
});

// ---------------------------------------------------------------------------
// the move runs an execution of its own
// ---------------------------------------------------------------------------

test("C1 move: the opening prompt waits until the move has LANDED and its execution is over", async () => {
  const w = world();
  w.state.moveLag = 3; // the child's directory changes only after three polls
  const id = await start(w);
  assert.equal(w.state.sentAfterMoveApplied, true, "no prompt while the move was still pending");
  assert.ok(w.state.readPolls >= 3);
  assert.equal(w.job(id).launchState, "running");
  assert.deepEqual(w.log.map((l) => l.label), ["create", "move", "window", "send"]);
  assert.equal(w.sessions.get(w.job(id).childSessionID).directory, WT);
});

test("C1 move: a move that never lands in time is an UNKNOWN launch — kept, nothing sent, nothing rolled back", async () => {
  const w = world();
  w.state.moveLag = 10_000;
  w.deps.moveWait = { attempts: 4, intervalMs: 0 };
  const res = await startJob(input(), w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.uncertain, true);
  keptEverything(w);
  assert.equal(w.calls.window.length + w.calls.send.length, 0, "no window and no prompt before the move landed");
});

test("C1 move: the move's own execution outcome is never read as the job finishing", async () => {
  // a job whose opening input has not been submitted yet, over a child whose move-applying
  // execution already `succeeded`: that outcome is not the job's
  for (const launchState of ["creating", "submitting", "uncertain"]) {
    const w = world();
    const id = await start(w);
    w.job(id).launchState = launchState;
    w.job(id).submittedAt = null;
    w.job(id).status = "running";
    const child = w.job(id).childSessionID;
    w.finish(child, "succeeded", T0 + 5); // the move's execution
    const res = await settleV2Job(w.job(id), w.deps);
    assert.equal(res.settled, false, launchState);
    assert.equal(res.reason, "unsent");
    assert.equal(w.job(id).status, "running");
    assert.equal(w.records.size, 0);
    await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", child));
    assert.equal(w.job(id).status, "running", "nor does the pump's raw event finish it");
  }
  // once submitted, the child's own outcome finishes it
  const w = world();
  const id = await start(w);
  w.say(w.job(id).childSessionID, "real work");
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 50);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  assert.equal(w.job(id).status, "done");
  assert.equal(w.job(id).result, "real work");
});

test("C1 completion: a fresh outcome on a child that never received the prompt (a late move execution) does not finish the job", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.timelines.set(child, []); // no user message on the child
  w.finish(child, "succeeded", T0 + 5);
  const res = await settleV2Job(w.job(id), w.deps);
  assert.equal(res.settled, false);
  assert.equal(res.reason, "no-input");
  assert.equal(w.job(id).status, "running");
  w.timelines.set(child, [{ type: "user", id: "msg_x" }]);
  assert.equal((await settleV2Job(w.job(id), w.deps)).settled, true);
  assert.equal(w.job(id).status, "done");
});

// ---------------------------------------------------------------------------
// completion from RAW outcomes; the single N7 result
// ---------------------------------------------------------------------------

test("C1 N7: a finished job posts exactly the spec'd body, queue + resume, under its persisted result id", async () => {
  const w = world();
  const id = await start(w);
  const job = w.job(id);
  w.say(job.childSessionID, "I fixed the parser.");
  w.finish(job.childSessionID, "succeeded", T0 + 10);
  const engine = createDelegateEngine(w.deps);
  await engine.observeRaw(raw("session.execution.succeeded", job.childSessionID));
  const done = w.job(id);
  assert.equal(done.status, "done");
  assert.equal(done.result, "I fixed the parser.");
  assert.equal(done.filesChanged, 2);
  assert.equal(done.completionDelivery, "delivered");

  assert.equal(w.calls.synth.length, 1);
  const { sid, body } = w.calls.synth[0];
  assert.equal(sid, PARENT);
  assert.deepEqual(body, {
    id: job.completionMessageId,
    text: buildCompletionText(done),
    description: job.name,
    metadata: { source: "subagent", childID: job.childSessionID, agent: "build", state: "completed", manta: { jobId: id, name: job.name } },
    delivery: "queue",
    resume: true,
  });
  assert.match(body.text, /Branch: job\/fix-the-bug \(2 files changed\)/);
  assert.deepEqual(results(w), { records: 1, deliveries: 0 });
  // a worktree job is cleaned up like a legacy one: worktree and window removed
  assert.deepEqual(w.calls.rmWorktree.map((r) => r.path), [WT]);
  assert.equal(w.calls.kill.length, 1);
  assert.equal(w.job(id).cleanedUp, true);
});

test("C1 N7: a dirty worktree is kept (with its window and record), exactly like a legacy job", async () => {
  const w = world();
  const id = await start(w);
  w.fail.dirty = true;
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  assert.equal(w.job(id).status, "done");
  assert.equal(w.job(id).cleanedUp, false);
  assert.equal(w.calls.kill.length, 0, "the window stays with the dirty worktree");
});

test("C1 N7: a repo-less job closes its window but keeps its record, and the text has no branch lines", async () => {
  const w = world({ git: false });
  const id = await start(w);
  w.say(w.job(id).childSessionID, "ok");
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  assert.equal(w.calls.kill.length, 1, "the finished job's window is closed");
  assert.equal(w.job(id).status, "done", "the record stays");
  assert.doesNotMatch(w.calls.synth[0].body.text, /Branch:/);
});

test("C1 completion: failed → failed with the error; interrupted → failed 'interrupted'", async () => {
  const w = world();
  const a = await start(w, { name: "alpha" });
  const b = await start(w, { name: "beta" });
  const engine = createDelegateEngine(w.deps);
  w.finish(w.job(a).childSessionID, "failed");
  await engine.observeRaw(raw("session.execution.failed", w.job(a).childSessionID, { error: { message: "provider exploded" } }));
  assert.equal(w.job(a).status, "failed");
  assert.equal(w.job(a).error, "provider exploded");
  w.finish(w.job(b).childSessionID, "interrupted");
  await engine.observeRaw(raw("session.execution.interrupted", w.job(b).childSessionID));
  assert.equal(w.job(b).status, "failed");
  assert.equal(w.job(b).error, "interrupted");
  assert.deepEqual(results(w), { records: 2, deliveries: 0 });
  assert.equal(w.calls.synth.find((s) => s.body.metadata.childID === w.job(a).childSessionID).body.metadata.state, "failed");
});

test("C1 completion: interrupted with a stop requested → stopped (with its result), decided against the LIVE record", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  // a stop that is requested but whose terminal write has not landed: the flag is on the record
  w.job(id).stopRequested = true;
  w.finish(child, "interrupted");
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "stopped");
  assert.equal(w.calls.synth[0].body.metadata.state, "cancelled");
  assert.equal(w.records.size, 1);
});

test("C1 completion: a duplicate / repeated raw outcome never reports twice", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.say(child, "done");
  w.finish(child, "succeeded", T0 + 1);
  const engine = createDelegateEngine(w.deps);
  await Promise.all([
    engine.observeRaw(raw("session.execution.succeeded", child)),
    engine.observeRaw(raw("session.execution.succeeded", child)),
    reconcileV2Jobs(w.deps),
    sweepDelegateJobs(w.deps),
  ]);
  await engine.sweep();
  assert.equal(w.records.size, 1);
  assert.equal(w.calls.synth.length, 1, "posted once, not retried while delivered");
  assert.equal(w.calls.deliver.length, 0);
});

test("C1 completion: the activity-poller / legacy adapter path cannot finish a V2 job (an idle that reads as success)", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  await observeEvent({ type: "session.status", properties: { sessionID: child, status: { type: "busy" } } }, w.deps);
  await observeEvent({ type: "session.idle", properties: { sessionID: child } }, w.deps);
  assert.equal(w.job(id).status, "running", "completion comes only from raw outcomes");
  assert.equal(w.records.size, 0);
});

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

const toolDone = (sid) => ({ type: "message.part.updated", properties: { sessionID: sid, part: { type: "tool", state: { status: "completed" } } } });
const toolRunning = (sid) => ({ type: "message.part.updated", properties: { sessionID: sid, part: { type: "tool", state: { status: "running" } } } });

test("C1 pause: interrupts at the next COMPLETED tool boundary (once), and the raw `interrupted` outcome parks the job — nothing is emitted", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  assert.equal((await pauseJob(id, w.deps)).ok, true);
  assert.equal(w.job(id).pauseRequested, true);
  assert.equal(w.job(id).status, "running");

  await observeEvent(toolRunning(child), w.deps);
  await observeEvent({ type: "message.part.updated", properties: { sessionID: child, part: { type: "text", text: "x" } } }, w.deps);
  assert.equal(w.calls.abort.length, 0, "not a completed tool part");
  await observeEvent(toolDone(child), w.deps);
  await observeEvent(toolDone(child), w.deps);
  assert.deepEqual(w.calls.abort, [child], "one interrupt, however many boundaries arrive before it lands");
  assert.equal(w.job(id).status, "running", "the interrupt alone does not park it");

  // the raw outcome of that interrupt
  w.finish(child, "interrupted", T0 + 3);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  const paused = w.job(id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.pauseRequested, false);
  assert.equal(paused.pausedAt, T0);
  assert.equal(paused.completionDelivery, null, "a paused attempt owes nothing");
  assert.deepEqual(results(w), { records: 0, deliveries: 0 });
  assert.equal(w.calls.rmWorktree.length, 0, "the worktree and window are KEPT");
  assert.equal(w.calls.kill.length, 0);
});

test("C1 pause: a boundary without a pause request does nothing; a failed interrupt is retried at the next boundary", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  await observeEvent(toolDone(child), w.deps);
  assert.equal(w.calls.abort.length, 0);
  await pauseJob(id, w.deps);
  let n = 0;
  w.deps.abortSession = async (sid) => {
    w.calls.abort.push(sid);
    if (++n === 1) throw netErr();
  };
  await observeEvent(toolDone(child), w.deps);
  await observeEvent(toolDone(child), w.deps);
  assert.equal(w.calls.abort.length, 2, "the first failed, so the next boundary tried again");
});

test("C1 pause: a paused job is never re-settled from its interrupted child, nor timed out as running", async () => {
  const w = world();
  const id = await start(w, { sweepAllowanceMs: 1000 });
  const child = w.job(id).childSessionID;
  await pauseJob(id, w.deps);
  w.finish(child, "interrupted", T0 + 1);
  const engine = createDelegateEngine(w.deps);
  await engine.observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "paused");
  w.state.now = T0 + 60 * 60_000; // an hour later: far past the allowance
  await engine.sweep();
  await engine.reconcileV2();
  await engine.observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "paused", "not failed 'interrupted', not 'timed out'");
  assert.deepEqual(results(w), { records: 0, deliveries: 0 });
});

test("C1 pause: refused for command runs and opencode-owned rows, as before", async () => {
  const w = world({
    jobs: [
      { id: "cmd1", status: "running", engine: "v2", origin: "command", completionOwner: "manta", childSessionID: "ses_a", parentSessionID: PARENT },
      { id: "own1", status: "running", engine: "v2", origin: "subagent", completionOwner: "opencode", childSessionID: "ses_b", parentSessionID: PARENT },
    ],
  });
  assert.equal((await pauseJob("cmd1", w.deps)).ok, false);
  assert.equal((await pauseJob("own1", w.deps)).ok, false);
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

async function pausedJob(w, extra) {
  const id = await start(w, extra);
  const child = w.job(id).childSessionID;
  await pauseJob(id, w.deps);
  w.finish(child, "interrupted", T0 + 3);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "paused");
  return id;
}

test("C1 resume: a FRESH child the same way (create → move → window → send); attempt+1, jobId and result id unchanged, old window closed after", async () => {
  const w = world();
  const id = await pausedJob(w);
  const before = structuredClone(w.job(id));
  const oldWindow = before.windowIndex;
  w.calls.create.length = w.calls.move.length = w.calls.send.length = w.calls.window.length = 0;
  w.log.length = 0;

  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const job = w.job(id);
  assert.equal(job.id, id);
  assert.equal(job.attempt, 2);
  assert.notEqual(job.childSessionID, before.childSessionID, "childSessionID replaced");
  assert.equal(job.completionMessageId, before.completionMessageId, "the result id is minted once per JOB");
  assert.equal(job.worktree, WT, "the SAME worktree — never a new one");
  assert.equal(job.status, "running");
  assert.equal(job.launchState, "running");
  assert.equal(job.startedAt, T0, "a fresh timeout clock");
  assert.deepEqual(w.log.map((l) => l.label), ["create", "move", "window", "send"]);
  assert.equal(w.calls.create[0].id, job.childSessionID);
  assert.equal(w.calls.create[0].parentID, PARENT);
  assert.deepEqual(w.calls.move, [{ sid: job.childSessionID, directory: WT }]);
  assert.match(w.calls.send[0].text, /Recent commit history|Working tree status|Fix the bug/);
  assert.equal(w.calls.addWorktree.length, 1, "no second worktree");
  assert.equal(w.calls.kill.length, 1, "the old window goes once the new attempt runs");
  assert.equal(w.calls.kill[0].windowIndex, oldWindow);
  assert.equal(job.launch.restore, undefined, "the swap is complete");
  assert.deepEqual(w.calls.del, [], "the paused attempt's child is left alone");
});

test("C1 resume: the cap refuses a resume (retriable) and the job stays paused", async () => {
  const w = world();
  const id = await pausedJob(w);
  for (let i = 0; i < MAX_RUNNING_JOBS; i++) w.jobs.push({ id: `r${i}`, status: "running", childSessionID: `ses_r${i}`, parentSessionID: "ses_o" });
  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, CAP_ERROR);
  assert.equal(res.retriable, true);
  assert.equal(w.job(id).status, "paused");
});

test("C1 resume: a definite refusal puts the job back as it was — paused, old child, old window, attempt unchanged", async () => {
  const w = world();
  const id = await pausedJob(w);
  const before = structuredClone(w.job(id));
  w.fail.create = httpErr(400, "nope");
  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, false);
  const after = w.job(id);
  assert.equal(after.status, "paused");
  assert.equal(after.childSessionID, before.childSessionID);
  assert.equal(after.attempt, 1);
  assert.equal(after.windowIndex, before.windowIndex);
  assert.equal(after.pausedAt, before.pausedAt);
  assert.equal(w.calls.kill.length, 0, "the paused attempt's window was never touched");
  assert.equal(w.records.size, 0, "a refused resume is not a result");
  // …and it can be resumed again
  w.fail.create = null;
  assert.equal((await resumeJob(id, w.deps)).ok, true);
  assert.equal(w.job(id).attempt, 2);
});

test("C1 resume: a send refused after the window exists closes THAT window and keeps the old one", async () => {
  const w = world();
  const id = await pausedJob(w);
  const before = structuredClone(w.job(id));
  w.fail.send = httpErr(422);
  await resumeJob(id, w.deps);
  assert.equal(w.job(id).status, "paused");
  assert.equal(w.calls.kill.length, 1);
  assert.notEqual(w.calls.kill[0].windowIndex, before.windowIndex, "the NEW window was closed, not the old one");
  assert.equal(w.calls.del.length, 1);
  assert.notEqual(w.calls.del[0], before.childSessionID);
});

test("C1 resume: an unknown outcome keeps the new attempt (running, uncertain) and never rolls back", async () => {
  const w = world();
  const id = await pausedJob(w);
  w.fail.send = netErr();
  const res = await resumeJob(id, w.deps);
  assert.equal(res.uncertain, true);
  assert.equal(w.job(id).status, "running");
  assert.equal(w.job(id).launchState, "uncertain");
  assert.equal(w.job(id).attempt, 2);
  assert.equal(w.calls.del.length, 0);
  assert.equal(w.calls.kill.length, 0, "the old window stays until the new attempt is known to run");
});

test("C1 resume: refused for jobs that aren't paused or whose lifecycle opencode owns", async () => {
  const w = world({ jobs: [{ id: "o1", status: "paused", engine: "v2", origin: "subagent", completionOwner: "opencode", childSessionID: "ses_o", parentSessionID: PARENT }] });
  const id = await start(w);
  assert.equal((await resumeJob(id, w.deps)).error, "job not paused");
  assert.equal((await resumeJob("o1", w.deps)).ok, false);
});

// ---------------------------------------------------------------------------
// exactly ONE result per job, through every route to a terminal state
// ---------------------------------------------------------------------------

const oneResult = (w, id, state) => {
  assert.deepEqual(results(w), { records: 1, deliveries: 0 }, "one parent record, no legacy notice");
  const rec = [...w.records.values()][0];
  assert.equal(rec.body.id, w.job(id).completionMessageId);
  assert.equal(rec.body.metadata.state, state);
  assert.equal(rec.body.metadata.manta.jobId, id);
};

test("C1 exactly one result — done", async () => {
  const w = world();
  const id = await start(w);
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  oneResult(w, id, "completed");
});

test("C1 exactly one result — failed", async () => {
  const w = world();
  const id = await start(w);
  w.finish(w.job(id).childSessionID, "failed", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.failed", w.job(id).childSessionID, { error: { message: "boom" } }));
  oneResult(w, id, "failed");
});

test("C1 exactly one result — stopped (and a second stop is refused)", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  assert.equal((await stopJob(id, w.deps)).ok, true);
  assert.deepEqual(w.calls.abort, [child], "the running child is interrupted");
  // the interrupt's own raw outcome finds nothing left to do
  w.finish(child, "interrupted", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  oneResult(w, id, "cancelled");
  assert.equal(w.job(id).status, "stopped");
  assert.equal(w.job(id).error, "stopped by user");
  assert.equal((await stopJob(id, w.deps)).ok, false);
  assert.equal(w.calls.deliver.length, 0);
});

test("C1 exactly one result — timed out (the child is interrupted, a late outcome adds nothing)", async () => {
  const w = world();
  const id = await start(w, { sweepAllowanceMs: 60_000 });
  const child = w.job(id).childSessionID;
  w.state.now = T0 + 2 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "failed");
  assert.equal(w.job(id).error, "timed out after 1 minutes");
  assert.deepEqual(w.calls.abort, [child], "the timeout interrupts the child");
  oneResult(w, id, "failed");
  // the child's own late outcome, and further sweeps
  w.finish(child, "interrupted", T0 + 2 * 60_000);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  await sweepDelegateJobs(w.deps);
  oneResult(w, id, "failed");
});

test("C1 exactly one result — the default allowance is 30 minutes", async () => {
  const w = world();
  const id = await start(w);
  w.state.now = T0 + 29 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running");
  w.state.now = T0 + 31 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).error, "timed out after 30 minutes");
  oneResult(w, id, "failed");
});

test("C1 exactly one result — paused → resumed → done: the pause emits nothing, the end emits the job's single result", async () => {
  const w = world();
  const id = await pausedJob(w);
  assert.deepEqual(results(w), { records: 0, deliveries: 0 });
  await resumeJob(id, w.deps);
  assert.deepEqual(results(w), { records: 0, deliveries: 0 }, "a resume emits nothing either");
  const child2 = w.job(id).childSessionID;
  w.say(child2, "finished on attempt two");
  w.finish(child2, "succeeded", T0 + 9);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", child2));
  oneResult(w, id, "completed");
  assert.equal(w.job(id).attempt, 2);
  assert.equal(w.calls.synth[0].body.id, w.job(id).completionMessageId);
  assert.equal(w.calls.synth[0].body.metadata.childID, child2, "the result names the child that finished");
});

test("C1 exactly one result — paused → stopped emits a `stopped` result (nothing to interrupt)", async () => {
  const w = world();
  const id = await pausedJob(w);
  const aborts = w.calls.abort.length;
  assert.equal((await stopJob(id, w.deps)).ok, true);
  assert.equal(w.calls.abort.length, aborts, "a paused job has no turn to interrupt");
  oneResult(w, id, "cancelled");
  assert.equal(w.job(id).status, "stopped");
  assert.deepEqual(w.calls.rmWorktree.map((r) => r.path), [WT], "the parked worktree is cleaned up");
});

test("C1 exactly one result — a pause that outlives its 7 days is stopped WITH its result (a V2 job still owes one)", async () => {
  const w = world();
  const id = await pausedJob(w);
  w.state.now = T0 + 8 * 24 * 60 * 60_000;
  await sweepDelegateJobs(w.deps);
  oneResult(w, id, "cancelled");
  assert.equal(w.job(id).error, "paused for over 7 days, stopped");
});

// ---------------------------------------------------------------------------
// first terminal transition wins
// ---------------------------------------------------------------------------

test("C1 race: pause requested, then a stop → stopped; the interrupt's later outcome is a no-op", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  await pauseJob(id, w.deps);
  await observeEvent(toolDone(child), w.deps);
  await stopJob(id, w.deps);
  w.finish(child, "interrupted", T0 + 2);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "stopped", "never parked after a stop");
  oneResult(w, id, "cancelled");
});

test("C1 race: completion beats a timeout, and a timeout beats a late completion — one terminal state, one result", async () => {
  const w = world();
  const id = await start(w, { sweepAllowanceMs: 60_000 });
  const child = w.job(id).childSessionID;
  w.say(child, "made it");
  w.finish(child, "succeeded", T0 + 1);
  w.state.now = T0 + 2 * 60_000;
  // the sweep reads its candidate list, THEN the completion lands, THEN the sweep acts
  const stale = structuredClone(w.job(id));
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).status, "done");
  const res = await finishV2Job(stale, "failed", "timed out after 2 minutes", w.deps);
  assert.equal(res.alreadyTerminal, true);
  assert.equal(w.job(id).status, "done");
  oneResult(w, id, "completed");

  const w2 = world();
  const id2 = await start(w2, { sweepAllowanceMs: 60_000 });
  w2.state.now = T0 + 2 * 60_000;
  await sweepDelegateJobs(w2.deps);
  w2.finish(w2.job(id2).childSessionID, "succeeded", T0 + 2 * 60_000);
  await settleV2Job(w2.job(id2), w2.deps);
  assert.equal(w2.job(id2).status, "failed");
  oneResult(w2, id2, "failed");
});

test("C1 race: a timeout sweep holding a stale `running` snapshot cannot time out a job that was paused meanwhile", async () => {
  const w = world();
  const id = await start(w, { sweepAllowanceMs: 1000 });
  const child = w.job(id).childSessionID;
  const stale = structuredClone(w.job(id));
  await pauseJob(id, w.deps);
  w.finish(child, "interrupted", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).status, "paused");
  const res = await finishV2Job(stale, "failed", "timed out after 0 minutes", w.deps);
  assert.equal(res.alreadyTerminal, true);
  assert.equal(w.job(id).status, "paused");
  assert.deepEqual(results(w), { records: 0, deliveries: 0 });
});

test("C1 race: a stop and a completion at once → exactly one result", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.say(child, "done");
  w.finish(child, "succeeded", T0 + 1);
  await Promise.all([stopJob(id, w.deps), settleV2Job(w.job(id), w.deps)]);
  assert.equal(w.records.size, 1);
  assert.deepEqual(results(w).deliveries, 0);
  assert.match(w.job(id).status, /^(done|stopped)$/);
});

// ---------------------------------------------------------------------------
// N7 delivery: retry after a failed POST, after a boot mid-delivery; the CTO conversation
// ---------------------------------------------------------------------------

test("C1 N7 retry: a refused POST leaves the result pending; the retry posts the SAME id and there is one parent record", async () => {
  const w = world();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.fail.synth.push("refuse");
  w.finish(child, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).status, "done");
  assert.equal(w.job(id).completionDelivery, "pending", "terminal AND pending in the same write");
  assert.equal(w.records.size, 0);
  assert.equal(await retryPendingDeliveries(w.deps), 1);
  assert.equal(w.job(id).completionDelivery, "delivered");
  assert.equal(w.calls.synth.length, 2);
  assert.equal(w.calls.synth[0].body.id, w.calls.synth[1].body.id);
  assert.deepEqual(w.calls.synth[0].body, w.calls.synth[1].body, "a retry posts the same body");
  assert.equal(w.records.size, 1);
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 2, "nothing more once delivered");
});

test("C1 N7 retry: a lost response (admitted, then the connection died) is retried and still ONE record", async () => {
  const w = world();
  const id = await start(w);
  w.fail.synth.push("lost");
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.records.size, 1, "it WAS admitted");
  assert.equal(w.job(id).completionDelivery, "pending");
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).completionDelivery, "delivered");
  assert.equal(w.records.size, 1, "the explicit id made the retry harmless");
});

test("C1 N7 retry: after a boot mid-delivery (a terminal, pending record and a fresh process) → one parent record", async () => {
  const w = world();
  const id = await start(w);
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  w.fail.synth.push("lost");
  await settleV2Job(w.job(id), w.deps);
  // "reboot": a brand-new engine over the persisted store
  const engine = createDelegateEngine(w.deps);
  await engine.reconcileV2();
  await engine.reconcileV2();
  assert.equal(w.records.size, 1);
  assert.equal(w.job(id).completionDelivery, "delivered");
});

test("C1 N7: a parent that no longer exists (404) abandons the delivery once, never retried", async () => {
  const w = world();
  const id = await start(w);
  w.fail.synth.push("gone");
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).completionDelivery, "abandoned");
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 1);
});

test("C1 N7 CTO conversation parent: goes through promptDelivery with a stable ctoKey, never N7; a refusal retries under the SAME key", async () => {
  const w = world();
  w.state.cto = true;
  const id = await start(w);
  w.state.ctoResult = { delivered: false, queued: false, rejected: true, error: "admission busy" };
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.calls.synth.length, 0, "never an N7 post for the CTO conversation");
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.deliver[0].ctoKey, w.job(id).completionMessageId, "the job's result id is the admission dedupe identity");
  assert.equal(w.calls.deliver[0].sessionId, PARENT);
  assert.equal(w.job(id).completionDelivery, "pending", "an explicit refusal is not delivered");
  w.state.ctoResult = { delivered: false, queued: true, ctoId: "x" };
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.deliver.length, 2);
  assert.equal(w.calls.deliver[1].ctoKey, w.calls.deliver[0].ctoKey);
  assert.equal(w.calls.deliver[1].text, w.calls.deliver[0].text, "admission refuses the same id with different text, so the text is a pure function of the record");
  assert.equal(w.job(id).completionDelivery, "delivered");
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.deliver.length, 2);
});

test("C1 N7 CTO conversation parent: a deduped (already settled) admission result counts as delivered", async () => {
  const w = world();
  w.state.cto = true;
  const id = await start(w);
  // admission replaying a settled record for this id: nothing is queued, and nothing is lost
  w.state.ctoResult = { delivered: false, queued: false, deduped: true, ctoStatus: "completed" };
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).completionDelivery, "delivered");
});

test("C1: the activity poller leaves a launch that has no child yet alone", async () => {
  const w = world();
  w.fail.create = netErr();
  await startJob(input(), w.deps);
  let listed = 0;
  w.deps.listMessages = async () => {
    listed++;
    return [];
  };
  const { tickActivity } = await import("./delegate.mjs");
  await tickActivity(w.deps);
  assert.equal(listed, 0);
});

// ---------------------------------------------------------------------------
// Stage C2: the CTO's own workers run on the V2 engine (actor "cto"), and the
// pre-C2 records a box can still hold are settled once, at boot.
// ---------------------------------------------------------------------------

const CTO = "ses_cto";
const CTO_HOME = "/home/cto";

// A world where the parent is the headless CTO conversation: a session that exists
// in opencode but has NO tmux window (so the workspace can only come from targetProject),
// and which sits in the CTO's own directory, not in the repository a worker is sent to.
function ctoWorld(opts) {
  const w = world(opts);
  w.sessions.set(CTO, { id: CTO, directory: CTO_HOME, agent: "build" });
  w.state.cto = true;
  w.projectReads = 0;
  const listProjects = w.deps.listProjects;
  w.deps.listProjects = async () => {
    w.projectReads++;
    return listProjects();
  };
  w.terminal = [];
  w.deps.onJobTerminal = async (job) => w.terminal.push({ id: job.id, status: job.status });
  // like the real create: the child sits at its parent's location
  w.deps.createChildSession = async (i) => {
    w.calls.create.push(i);
    w.log.push({ label: "create", store: w.jobs.map((j) => ({ ...j })) });
    w.sessions.set(i.id, { id: i.id, parentID: i.parentID, directory: w.sessions.get(i.parentID)?.directory ?? REPO, agent: i.agent });
    return { id: i.id, directory: w.sessions.get(i.id).directory };
  };
  return w;
}

// What ctoWorkTools hands startJob for a tracked-work dispatch (and a review).
const ctoInput = (extra = {}) => ({
  prompt: "Implement the parser change",
  name: "fix the bug",
  parentSessionID: CTO,
  parentDirectory: REPO,
  targetProject: "proj",
  isolationRequired: true,
  correlation: { kind: "work", workId: "w1", receiptId: "r1", op: "work.dispatch" },
  actor: "cto",
  sweepAllowanceMs: 3_600_000,
  permission: [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }],
  ...extra,
});
const ctoStart = async (w, extra) => {
  const res = await startJob(ctoInput(extra), w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.job.id;
};
// the CTO conversation hears of a job exactly once, through admission (never a synthetic)
const ctoOneResult = (w, id, status) => {
  assert.equal(w.calls.deliver.length, 1, "exactly one delivery to admission");
  assert.equal(w.calls.synth.length, 0, "never an N7 post into the CTO conversation");
  const d = w.calls.deliver[0];
  assert.equal(d.sessionId, CTO);
  assert.equal(d.ctoKey, w.job(id).completionMessageId, "the job's result id is the admission dedupe identity");
  assert.match(d.text, new RegExp(`^\\[background job "[^"]*" ${status}\\]`));
  assert.equal(w.job(id).completionDelivery, "delivered");
};

test("C2 startJob: a CTO job is a V2 child, with everything the CTO relies on persisted", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w);
  const job = w.job(id);
  assert.equal(job.engine, "v2");
  assert.equal(job.completionOwner, "manta");
  assert.equal(job.actor, "cto");
  assert.equal(job.origin, "delegate");
  assert.deepEqual(job.correlation, { kind: "work", workId: "w1", receiptId: "r1", op: "work.dispatch" });
  assert.equal(job.sweepAllowanceMs, 3_600_000);
  assert.equal(job.tmuxSession, "proj", "the window goes where targetProject says");
  assert.equal(w.projectReads, 0, "a windowless CTO conversation is never looked up in tmux");
  assert.equal(job.parentSessionID, CTO);
  assert.equal(job.worktree, WT);
  assert.equal(job.branch, "job/fix-the-bug");
  assert.equal(job.baseSha, "abc123");
  assert.deepEqual(job.permission, ctoInput().permission, "the preflight ruleset is kept for a resume");
  assert.equal(job.status, "running");
  assert.equal(job.launchState, "running");

  assert.equal(w.calls.create[0].parentID, CTO);
  assert.deepEqual(w.calls.create[0].permission, job.permission);
  assert.deepEqual(w.calls.move, [{ sid: job.childSessionID, directory: WT }], "moved from the CTO's directory into the worktree");
  assert.equal(w.calls.window[0].sessionName, "proj");
  assert.equal(w.calls.window[0].existingSessionId, job.childSessionID);
  assert.equal(w.calls.send[0].sessionId, job.childSessionID);
  assert.deepEqual(w.calls.deliver, [], "the opening prompt never goes through promptDelivery");
});

test("C2 startJob: isolationRequired never falls back to the repository — the refusal creates nothing and leaves no record", async () => {
  const w = ctoWorld({ git: false });
  const res = await startJob(ctoInput(), w.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, "worktree_failed");
  assert.match(res.error, /refusing to fall back to the original repository directory/);
  assert.deepEqual([w.calls.create, w.calls.move, w.calls.window, w.calls.send].map((c) => c.length), [0, 0, 0, 0]);
  assert.equal(w.jobs.length, 0, "no correlated job for the reconciler to adopt");
});

test("C2 startJob: the cap refuses with the exact CAP_ERROR the CTO maps to capacity_wait", async () => {
  const running = Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => ({ id: `cap${i}`, name: "x", parentSessionID: "ses_other", childSessionID: `ses_cap${i}`, status: "running", origin: "delegate" }));
  const w = ctoWorld({ jobs: running });
  const res = await startJob(ctoInput(), w.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, CAP_ERROR);
  assert.equal(w.calls.addWorktree.length, 0);
});

test("C2 startJob: a child created away from the job's directory is moved there even with no worktree", async () => {
  const w = ctoWorld({ git: false });
  const res = await startJob(ctoInput({ isolationRequired: false }), w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.job.worktree, null);
  assert.equal(res.job.executionDirectory, REPO);
  assert.deepEqual(w.calls.move, [{ sid: res.job.childSessionID, directory: REPO }], "the CTO conversation sits in the CTO's directory");
});

test("C2 startJob: a child created AT the job's directory is not moved (a trailing slash is the same place)", async () => {
  const w = ctoWorld({ git: false });
  w.sessions.get(CTO).directory = `${REPO}/`;
  const res = await startJob(ctoInput({ isolationRequired: false }), w.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(w.calls.move, []);
});

test("C2 exactly one result — done (through admission; the work coordinator hears the outcome once)", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w);
  const child = w.job(id).childSessionID;
  w.say(child, "implemented");
  w.finish(child, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", child));
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", child));
  ctoOneResult(w, id, "done");
  assert.match(w.calls.deliver[0].text, /implemented/);
  assert.deepEqual(w.terminal, [{ id, status: "done" }]);
  assert.deepEqual(w.calls.rmWorktree.map((r) => r.path), [WT], "a finished worker's clean worktree is cleaned up");
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.deliver.length, 1);
});

test("C2 exactly one result — failed", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w);
  const child = w.job(id).childSessionID;
  w.finish(child, "failed", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.failed", child, { error: { message: "boom" } }));
  ctoOneResult(w, id, "failed");
  assert.match(w.calls.deliver[0].text, /Error: boom/);
  assert.deepEqual(w.terminal, [{ id, status: "failed" }]);
});

test("C2 exactly one result — stopped (the cancel path: abort, one `stopped` result, a late outcome adds nothing)", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w);
  const child = w.job(id).childSessionID;
  assert.equal((await stopJob(id, w.deps)).ok, true);
  assert.deepEqual(w.calls.abort, [child]);
  w.finish(child, "interrupted", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  ctoOneResult(w, id, "stopped");
  assert.equal(w.job(id).status, "stopped");
  assert.equal((await stopJob(id, w.deps)).ok, false);
  assert.equal(w.calls.deliver.length, 1);
});

test("C2 exactly one result — timed out on the job's OWN allowance (the overnight window), the child interrupted", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w, { sweepAllowanceMs: 90 * 60_000 });
  const child = w.job(id).childSessionID;
  w.state.now = T0 + 89 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running", "the 30-minute default does not apply");
  w.state.now = T0 + 91 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "failed");
  assert.equal(w.job(id).error, "timed out after 90 minutes");
  assert.deepEqual(w.calls.abort, [child]);
  w.finish(child, "interrupted", T0 + 92 * 60_000);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  await sweepDelegateJobs(w.deps);
  ctoOneResult(w, id, "failed");
  assert.deepEqual(w.terminal, [{ id, status: "failed" }]);
});

test("C2 exactly one result — paused → resumed → done: the pause and the resume emit nothing", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w);
  const child = w.job(id).childSessionID;
  assert.equal((await pauseJob(id, w.deps)).ok, true);
  await observeEvent(toolDone(child), w.deps);
  w.finish(child, "interrupted", T0 + 3);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "paused");
  assert.equal(w.calls.deliver.length, 0, "a pause is not an outcome");
  assert.deepEqual(w.terminal, [], "the work coordinator is told nothing yet");

  const resumed = await resumeJob(id, w.deps);
  assert.equal(resumed.ok, true);
  assert.equal(w.job(id).attempt, 2);
  assert.equal(w.job(id).tmuxSession, "proj", "the persisted workspace is reused: the CTO conversation owns no window to look up");
  assert.equal(w.calls.deliver.length, 0);
  const child2 = w.job(id).childSessionID;
  assert.notEqual(child2, child);
  assert.equal(w.calls.create[1].parentID, CTO);
  assert.deepEqual(w.calls.create[1].permission, ctoInput().permission, "the resumed child is scoped exactly like the first");
  w.say(child2, "finished on attempt two");
  w.finish(child2, "succeeded", T0 + 9);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", child2));
  ctoOneResult(w, id, "done");
  assert.deepEqual(w.terminal, [{ id, status: "done" }]);
});

test("C2 admission is never bypassed: a tracked-work job goes through admission even when classifying the parent fails open", async () => {
  const w = ctoWorld();
  w.state.cto = false; // the conversation store was unreadable: the classifier says "ordinary session"
  const id = await ctoStart(w);
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.calls.synth.length, 0, "no straight post into the CTO conversation");
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.deliver[0].ctoKey, w.job(id).completionMessageId);
});

test("C2 admission is never bypassed: a classifier that cannot answer leaves the result pending, then it is delivered once", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w, { correlation: null });
  w.deps.isCtoConversationSession = async () => {
    throw new Error("binding store down");
  };
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.job(id).status, "done");
  assert.equal(w.job(id).completionDelivery, "pending");
  assert.equal(w.calls.synth.length, 0, "never a guess at N7");
  assert.equal(w.calls.deliver.length, 0);
  w.deps.isCtoConversationSession = async () => true;
  await retryPendingDeliveries(w.deps);
  ctoOneResult(w, id, "done");
});

test("C2 a CTO job whose parent is NOT the CTO conversation (a plan / overnight job in a project session) gets N7 like any other", async () => {
  const w = ctoWorld();
  w.state.cto = false;
  const id = await ctoStart(w, { parentSessionID: PARENT, correlation: null, targetProject: undefined, isolationRequired: false });
  assert.equal(w.job(id).actor, "cto");
  assert.equal(w.job(id).tmuxSession, "proj", "its workspace comes from the parent's own window");
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  oneResult(w, id, "completed");
  assert.deepEqual(w.terminal, [{ id, status: "done" }]);
});

test("C2 an overnight preempt (pauseJob with the engine's own default store access) parks a CTO job at its next tool boundary", async () => {
  const w = ctoWorld();
  const id = await ctoStart(w, { correlation: null, actor: "cto", parentSessionID: PARENT });
  const child = w.job(id).childSessionID;
  const { pauseJob: bare } = await import("./delegate.mjs");
  // the preempt flags the job through the module's own pauseJob (no engine deps) …
  assert.equal((await bare(id, { load: w.deps.load, save: w.deps.save })).ok, true);
  // … and the pump's tool boundary does the interrupt
  await createDelegateEngine(w.deps).observeEvent(toolDone(child));
  w.finish(child, "interrupted", T0 + 2);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  assert.equal(w.job(id).status, "paused");
  assert.deepEqual(results(w), { records: 0, deliveries: 0 });
});

// ---- pre-C2 records, settled once at boot -----------------------------------

const legacyRecord = (extra = {}) => ({
  id: "leg00001", name: "old job", prompt: "do the old thing", model: "anthropic/claude-sonnet-5-5", requestedModel: null,
  parentSessionID: PARENT, parentDirectory: REPO, childSessionID: "ses_leg", tmuxSession: "proj", windowIndex: 3,
  worktree: WT, branch: "job/old", baseSha: "abc123", origin: "delegate", link: null, actor: "user", correlation: null, sweepAllowanceMs: null, permission: null,
  status: "running", activity: null, createdAt: T0, startedAt: T0, finishedAt: null, result: null, error: null, filesChanged: null,
  ...extra,
});
const legacyWorld = (jobs) => {
  const w = world({ jobs });
  for (const j of jobs) {
    w.sessions.set(j.childSessionID, { id: j.childSessionID, directory: j.worktree ?? REPO });
    w.windows.push({ index: j.windowIndex, opencodeSessionId: j.childSessionID, paneCurrentPath: j.worktree ?? REPO });
  }
  return w;
};

test("C2 boot: a legacy running job is failed \"interrupted by upgrade\", its child interrupted, and it reports its ONE result", async () => {
  const w = legacyWorld([legacyRecord()]);
  const terminal = [];
  w.deps.onJobTerminal = async (j) => terminal.push(j.status);
  const res = await reconcileJobsOnBoot(w.deps);
  assert.deepEqual(res, { ok: true, reconciled: 1 });
  const job = w.job("leg00001");
  assert.equal(job.status, "failed");
  assert.equal(job.error, "interrupted by upgrade");
  assert.equal(job.engine, "v2");
  assert.equal(job.completionOwner, "manta");
  assert.deepEqual(w.calls.abort, ["ses_leg"]);
  assert.equal(w.records.size, 1, "one N7 result");
  const rec = [...w.records.values()][0];
  assert.equal(rec.sid, PARENT);
  assert.equal(rec.body.id, job.completionMessageId);
  assert.equal(rec.body.metadata.state, "failed");
  assert.match(rec.body.text, /interrupted by upgrade/);
  assert.equal(job.completionDelivery, "delivered");
  assert.deepEqual(terminal, ["failed"]);
  assert.deepEqual(w.calls.rmWorktree.map((r) => r.path), [WT], "its worktree is cleaned up like any finished job's");
  // a second boot, and the sweeper's own pass, add nothing
  assert.deepEqual(await reconcileJobsOnBoot(w.deps), { ok: true, reconciled: 0 });
  await sweepDelegateJobs(w.deps);
  assert.equal(w.records.size, 1);
  assert.deepEqual(terminal, ["failed"]);
});

test("C2 boot: a legacy running job of the CTO conversation reports through admission, once", async () => {
  const w = legacyWorld([legacyRecord({ actor: "cto", parentSessionID: CTO, correlation: { kind: "work", workId: "w1", receiptId: "r1", op: "work.dispatch" } })]);
  w.state.cto = true;
  await reconcileJobsOnBoot(w.deps);
  assert.equal(w.job("leg00001").status, "failed");
  assert.equal(w.calls.synth.length, 0);
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.deliver[0].sessionId, CTO);
  assert.equal(w.calls.deliver[0].ctoKey, w.job("leg00001").completionMessageId);
  assert.match(w.calls.deliver[0].text, /interrupted by upgrade/);
});

test("C2 boot: the boot call and the sweeper's first tick overlapping settle a legacy job once", async () => {
  const w = legacyWorld([legacyRecord()]);
  await Promise.all([reconcileJobsOnBoot(w.deps), sweepDelegateJobs(w.deps), reconcileV2Jobs(w.deps)]);
  assert.equal(w.job("leg00001").status, "failed");
  assert.equal(w.job("leg00001").error, "interrupted by upgrade");
  assert.equal(w.records.size, 1);
});

test("C2 boot: a result that cannot be posted yet (opencode still starting) stays pending and is retried", async () => {
  const w = legacyWorld([legacyRecord()]);
  w.fail.synth.push("refuse");
  await reconcileJobsOnBoot(w.deps);
  assert.equal(w.job("leg00001").completionDelivery, "pending");
  assert.equal(w.records.size, 0);
  await retryPendingDeliveries(w.deps);
  assert.equal(w.job("leg00001").completionDelivery, "delivered");
  assert.equal(w.records.size, 1);
});

test("C2 boot: a legacy adopted subagent that was running fails with no result (opencode reports its own)", async () => {
  const w = legacyWorld([legacyRecord({ id: "sub00001", origin: "subagent", worktree: null, branch: null, baseSha: null, childSessionID: "ses_sub", windowIndex: 4 })]);
  await reconcileJobsOnBoot(w.deps);
  assert.equal(w.job("sub00001").status, "failed");
  assert.equal(w.job("sub00001").completionOwner, "opencode");
  assert.equal(w.records.size, 0);
  assert.equal(w.calls.deliver.length, 0);
});

test("C2 boot: a legacy PAUSED job is upgraded in place, still paused, and can be resumed on the V2 path", async () => {
  const w = legacyWorld([legacyRecord({ status: "paused", pausedAt: T0 + 5, pauseRequested: false })]);
  const res = await reconcileJobsOnBoot(w.deps);
  assert.deepEqual(res, { ok: true, reconciled: 1 });
  const job = w.job("leg00001");
  assert.equal(job.status, "paused");
  assert.equal(job.engine, "v2");
  assert.equal(job.completionOwner, "manta");
  assert.equal(job.attempt, 1);
  assert.match(job.completionMessageId, /^msg_/);
  assert.equal(job.executionDirectory, WT);
  assert.deepEqual(job.launch.model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  assert.equal(job.childSessionID, "ses_leg", "history is untouched");
  assert.equal(job.worktree, WT);
  assert.deepEqual(results(w), { records: 0, deliveries: 0 }, "an upgrade emits nothing");
  assert.deepEqual(w.calls.abort, []);

  const resumed = await resumeJob("leg00001", w.deps);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const after = w.job("leg00001");
  assert.equal(after.attempt, 2);
  assert.equal(after.status, "running");
  assert.notEqual(after.childSessionID, "ses_leg");
  assert.deepEqual(w.calls.create[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  assert.deepEqual(w.calls.move, [{ sid: after.childSessionID, directory: WT }], "a fresh child in the SAME worktree");
  assert.equal(w.calls.addWorktree.length, 0, "never a new worktree");
  assert.deepEqual(w.calls.kill.map((k) => k.windowIndex), [3], "the old window goes once the new attempt runs");
  w.say(after.childSessionID, "done after the upgrade");
  w.finish(after.childSessionID, "succeeded", T0 + 9);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", after.childSessionID));
  assert.equal(w.records.size, 1, "the resumed job's one result");
  assert.equal([...w.records.values()][0].body.id, after.completionMessageId);
});

test("C2 boot: a legacy paused job without a worktree resumes in its parent's directory", async () => {
  const w = legacyWorld([legacyRecord({ status: "paused", pausedAt: T0 + 5, worktree: null, branch: null, baseSha: null, model: null, requestedModel: null })]);
  await reconcileJobsOnBoot(w.deps);
  assert.equal(w.job("leg00001").executionDirectory, REPO);
  assert.equal(w.job("leg00001").launch.model, null);
  assert.equal((await resumeJob("leg00001", w.deps)).ok, true);
  assert.deepEqual(w.calls.move, []);
});

test("C2 boot: finished legacy records and V2 records are left exactly as they are", async () => {
  const done = legacyRecord({ id: "old00001", status: "done", finishedAt: T0 + 1, childSessionID: "ses_o1", windowIndex: 6 });
  const v2 = { ...legacyRecord({ id: "new00001", childSessionID: "ses_n1", windowIndex: 7 }), engine: "v2", completionOwner: "manta", attempt: 1, launchState: "running", submittedAt: T0, completionMessageId: "msg_x", completionDelivery: null };
  const w = legacyWorld([done, v2]);
  const before = structuredClone(w.jobs);
  assert.deepEqual(await reconcileJobsOnBoot(w.deps), { ok: true, reconciled: 0 });
  assert.deepEqual(w.jobs, before);
  assert.deepEqual(w.calls.abort, []);
});
