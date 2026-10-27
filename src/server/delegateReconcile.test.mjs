// Background-job reconciliation: one run = one record (`delegate_send`, supersession, the per-session
// resource lock), observed (track-only) records, adoption through windowless parents, run freshness,
// and the active-session reconciler. Every opencode / tmux / git call is a fake over one in-memory world.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDelegateEngine,
  continueJob,
  finishV2Job,
  settleV2Job,
  reconcileV2Jobs,
  runningJobCount,
  sweepDelegateJobs,
  deleteJob,
  cleanupTerminalJob,
  adoptExistingSession,
  resolveSessionOwner,
  newestRecordFor,
  countsTowardCap,
  startJob,
  observeEvent,
  mintMessageId,
  MAX_RUNNING_JOBS,
  CAP_ERROR,
} from "./delegate.mjs";
import { withInternalMarker, isMarkedInternal } from "./internalSessionMarker.mjs";

const T0 = 1_700_000_000_000;
const PARENT = "ses_parent";
const CHILD = "ses_child0000000000000000000000000000";
const REPO = "/repo";
const WT = "/wt/fix";

const httpErr = (status, message = `opencode ${status}`) => Object.assign(new Error(message), { status });
const netErr = () => new Error("fetch failed");

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
function world({ jobs: seed = [], paths = [] } = {}) {
  const jobs = seed.map((j) => ({ ...j }));
  const calls = { send: [], window: [], kill: [], rm: [], git: [], del: [], synth: [], stamp: [], abort: [] };
  const sessions = new Map([[PARENT, { id: PARENT, directory: REPO, agent: "build" }]]);
  const active = new Set();
  const timelines = new Map();
  const inboxes = new Map();
  const messages = new Map();
  const windows = [{ index: 0, opencodeSessionId: PARENT, paneCurrentPath: REPO }];
  const existing = new Set(paths);
  const fail = { send: null, window: null, add: null, readSession: null, listActive: null, listTimeline: null, lose: false };
  const state = { now: T0, nextWindow: 5, gate: null };
  const warnings = [];

  const deps = {
    load: async () => jobs.map((j) => structuredClone(j)),
    save: async (next) => {
      jobs.splice(0, jobs.length, ...next.map((j) => structuredClone(j)));
    },
    publish: () => {},
    now: () => state.now,
    listProjects: async () => [{ tmuxSession: "proj", defaultCwd: REPO, windows: windows.map((x) => ({ ...x })) }],
    newWindow: async (i) => {
      calls.window.push(i);
      if (fail.window) throw fail.window;
      const idx = state.nextWindow++;
      windows.push({ index: idx, opencodeSessionId: i.existingSessionId, paneCurrentPath: i.cwd });
      return { sessionId: i.existingSessionId, windowIndex: idx };
    },
    stampOwner: async (...a) => calls.stamp.push(a),
    killWindow: async (i) => {
      calls.kill.push(i);
      const at = windows.findIndex((x) => x.index === i.windowIndex);
      if (at !== -1) windows.splice(at, 1);
    },
    gitRun: async (args) => {
      calls.git.push(args);
      if (args.includes("add")) {
        if (fail.add) throw fail.add;
        existing.add(args[args.indexOf("add") + 1]);
      }
      return { stdout: "" };
    },
    gitRemoveWorktree: async (i) => {
      if (state.gate) await state.gate;
      calls.rm.push(i);
      existing.delete(i.path);
      return { removed: true };
    },
    pathExists: (p) => existing.has(p),
    readSession: async (sid) => {
      if (fail.readSession) throw fail.readSession;
      const s = sessions.get(sid);
      return s ? { state: "found", session: structuredClone(s) } : { state: "missing" };
    },
    listActiveIds: async () => {
      if (fail.listActive) throw fail.listActive;
      return [...active];
    },
    listChildSessions: async (sid) => [...sessions.values()].filter((s) => s.parentID === sid).map((s) => structuredClone(s)),
    listRawTimeline: async (sid, { type } = {}) => {
      if (fail.listTimeline) throw fail.listTimeline;
      return (timelines.get(sid) ?? []).filter((r) => !type || r.type === type);
    },
    listInbox: async (sid) => inboxes.get(sid) ?? [],
    sendChildPrompt: async (input) => {
      calls.send.push(input);
      if (fail.send) throw fail.send;
      if (!fail.lose) timelines.set(input.sessionId, [...(timelines.get(input.sessionId) ?? []), { type: "user", id: input.messageID }]);
      active.add(input.sessionId);
      const s = sessions.get(input.sessionId);
      if (s) delete s.outcome;
      if (fail.lose) throw netErr();
    },
    deleteSession: async (sid) => {
      calls.del.push(sid);
      sessions.delete(sid);
    },
    postSynthetic: async (sid, body) => {
      calls.synth.push({ sid, body });
    },
    deliver: async () => ({ delivered: true }),
    isCtoConversationSession: async () => false,
    listMessages: async (sid) => messages.get(sid) ?? [],
    clearProgress: async () => {},
    openCommandWindows: () => [],
    abortSession: async (sid) => calls.abort.push(sid),
    sessionExists: async (sid) => sessions.has(sid),
    replacementChain: (sid) => [sid],
    oc: {},
  };
  return {
    deps,
    calls,
    sessions,
    active,
    timelines,
    inboxes,
    windows,
    existing,
    fail,
    state,
    warnings,
    get jobs() {
      return jobs;
    },
    job: (id) => jobs.find((j) => j.id === id),
    say(sid, text) {
      messages.set(sid, [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]);
    },
    finish(sid, outcome, idleAt = state.now) {
      const s = sessions.get(sid);
      s.outcome = outcome;
      s.time = { ...(s.time ?? {}), idle: idleAt };
      active.delete(sid);
    },
  };
}

// A finished, delivered delegate job whose worktree was cleaned up (the normal end state).
function finishedJob(over = {}) {
  return {
    id: "aaaa1111",
    name: "fix-the-bug",
    prompt: "Fix the bug",
    model: null,
    requestedModel: null,
    parentSessionID: PARENT,
    parentDirectory: REPO,
    childSessionID: CHILD,
    tmuxSession: "proj",
    windowIndex: null,
    worktree: WT,
    branch: "job/fix",
    baseSha: "abc",
    origin: "delegate",
    link: null,
    actor: "user",
    correlation: null,
    sweepAllowanceMs: null,
    permission: null,
    status: "done",
    activity: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: T0 + 10,
    result: "all done",
    error: null,
    filesChanged: 2,
    engine: "v2",
    completionOwner: "manta",
    attempt: 1,
    launchState: "running",
    submittedAt: T0,
    completionMessageId: "msg_old",
    completionDelivery: "delivered",
    agent: "build",
    executionDirectory: WT,
    launch: { text: "Fix the bug", model: null, messageId: "msg_open" },
    cleanedUp: true,
    ...over,
  };
}

// a world holding one finished job whose session still exists
function finishedWorld(over = {}, worldOpts = {}) {
  const w = world({ jobs: [finishedJob(over)], ...worldOpts });
  w.sessions.set(CHILD, { id: CHILD, parentID: PARENT, directory: WT, agent: "build", outcome: "succeeded", time: { idle: T0 + 10 } });
  w.state.now = T0 + 100;
  return w;
}

const send = (w, id = "aaaa1111", extra = {}) => continueJob(id, { prompt: "Now fix the review comments", sessionID: PARENT, ...extra }, w.deps);

// ---------------------------------------------------------------------------
// delegate_send — success
// ---------------------------------------------------------------------------

test("send: a NEW record on the same session, the old one superseded; worktree re-added; prompt sent with the persisted message id", async () => {
  const w = finishedWorld();
  const res = await send(w);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(w.jobs.length, 2);
  const old = w.job("aaaa1111");
  const next = w.job(res.job.id);
  assert.notEqual(next.id, old.id);
  assert.equal(old.supersededBy, next.id);
  assert.equal(old.status, "done", "the old record stays what it was");

  // the new-record field table
  assert.equal(next.childSessionID, CHILD);
  assert.equal(next.attempt, 2);
  assert.equal(next.continues, old.id);
  assert.equal(next.prompt, "Now fix the review comments");
  assert.equal(next.status, "running");
  assert.equal(next.finishedAt, null);
  assert.equal(next.result, null);
  assert.equal(next.error, null);
  assert.equal(next.completionOwner, "manta");
  assert.equal(next.completionDelivery, null);
  assert.equal(next.cleanedUp, null);
  assert.equal(next.launchState, "running");
  assert.equal(next.submittedAt, T0 + 100);
  assert.equal(next.parentSessionID, PARENT);
  assert.equal(next.worktree, WT);
  assert.equal(next.branch, "job/fix");
  assert.equal(next.origin, "delegate");
  assert.match(next.launch.messageId, /^msg_/);
  assert.equal(next.launch.continuation, true);
  assert.equal(next.launch.text, "Now fix the review comments");
  assert.equal(next.launch.model, null);

  // re-added from the branch (from the repo of parentDirectory), then a window by stamp, then the send
  assert.deepEqual(w.calls.git.at(-1), ["-C", REPO, "worktree", "add", WT, "job/fix"]);
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.window[0].existingSessionId, CHILD);
  assert.equal(w.calls.window[0].cwd, WT);
  assert.equal(w.calls.send.length, 1);
  assert.equal(w.calls.send[0].sessionId, CHILD);
  assert.equal(w.calls.send[0].text, "Now fix the review comments");
  assert.equal(w.calls.send[0].messageID, next.launch.messageId);
  assert.deepEqual(w.calls.del, [], "the session is never deleted");
  assert.equal(typeof next.windowIndex, "number");
});

test("send: an existing window stamped with the session is reused (no new window), a present worktree is not re-added", async () => {
  const w = finishedWorld({}, { paths: [WT] });
  w.windows.push({ index: 9, opencodeSessionId: CHILD, paneCurrentPath: WT });
  const res = await send(w);
  assert.equal(res.ok, true);
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.git.filter((a) => a.includes("add")).length, 0);
  assert.equal(w.job(res.job.id).windowIndex, 9);
});

test("send: an unreadable-after-send (lost response) keeps everything, marked uncertain; recovery re-sends with the SAME message id and it settles once", async () => {
  const w = finishedWorld();
  w.fail.lose = true;
  const res = await send(w);
  assert.equal(res.ok, true);
  assert.equal(res.uncertain, true);
  const next = w.job(res.job.id);
  assert.equal(next.launchState, "uncertain");
  assert.equal(next.submittedAt, T0 + 100);
  // the message actually was NOT admitted and nothing is running: the sweep re-sends it, same id
  w.fail.lose = false;
  w.active.clear();
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.send.length, 2);
  assert.equal(w.calls.send[1].messageID, next.launch.messageId, "the same message id — opencode admits it once");
  assert.equal(w.job(next.id).launchState, "running");
  assert.equal(w.job(next.id).submittedAt, T0 + 100, "submittedAt is never rewritten");
});

test("send: admission evidence for the launch's OWN message id proves a lost response was admitted (no re-send); an older user message proves nothing", async () => {
  const w = finishedWorld();
  w.timelines.set(CHILD, [{ type: "user", id: "msg_some_older_one" }]);
  w.fail.lose = true;
  const res = await send(w);
  const id = res.job.id;
  const messageId = w.job(id).launch.messageId;
  w.active.clear();
  w.fail.lose = false;
  // the timeline holds other user messages, but not this launch's
  w.timelines.set(CHILD, [{ type: "user", id: "msg_some_older_one" }]);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.send.length, 2, "an unrelated user message is not evidence: it was re-sent");
  // now the launch's own message is there
  const w2 = finishedWorld();
  w2.fail.lose = true;
  const r2 = await send(w2);
  w2.active.clear();
  w2.timelines.set(CHILD, [{ type: "user", id: w2.job(r2.job.id).launch.messageId }]);
  await reconcileV2Jobs(w2.deps);
  assert.equal(w2.calls.send.length, 1, "evidence by id: not re-sent");
  assert.equal(w2.job(r2.job.id).launchState, "running");
  void messageId;
});

test("send: restart right after the claim (persisted `submitting`) is normalised to uncertain and recovered — never abandoned, never deleting the session", async () => {
  const w = finishedWorld();
  // what a crash between the claim and the send leaves behind
  w.fail.send = netErr();
  await send(w);
  const next = w.jobs.find((j) => j.continues);
  w.fail.send = null;
  w.jobs.splice(0, w.jobs.length, ...w.jobs.map((j) => (j.id === next.id ? { ...j, launchState: "submitting" } : j)));
  w.active.clear();
  w.timelines.set(CHILD, []);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(next.id).launchState, "running");
  assert.equal(w.calls.send.at(-1).messageID, next.launch.messageId);
  assert.deepEqual(w.calls.del, []);
});

test("send: recovery before the worktree restore / window creation / send (never sent) completes the whole launch", async () => {
  const w = finishedWorld();
  const next = {
    ...finishedJob(),
    id: "bbbb2222",
    attempt: 2,
    continues: "aaaa1111",
    status: "running",
    finishedAt: null,
    result: null,
    completionMessageId: null,
    completionDelivery: null,
    cleanedUp: null,
    launchState: "creating",
    submittedAt: null,
    windowIndex: null,
    launch: { text: "again", model: null, messageId: "msg_again", continuation: true },
  };
  w.jobs[0] = { ...w.jobs[0], supersededBy: "bbbb2222" };
  w.jobs.push(next);
  await reconcileV2Jobs(w.deps);
  assert.deepEqual(w.calls.git.at(-1), ["-C", REPO, "worktree", "add", WT, "job/fix"], "worktree restored first");
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.send.length, 1);
  assert.equal(w.calls.send[0].messageID, "msg_again");
  assert.equal(w.job("bbbb2222").launchState, "running");
  assert.equal(w.job("bbbb2222").submittedAt, T0 + 100);
});

test("send: recovery failure ends the record `failed` (one result) without deadlocking — a missing session, a gone branch", async () => {
  const mk = () => {
    const w = finishedWorld();
    w.jobs[0] = { ...w.jobs[0], supersededBy: "bbbb2222" };
    w.jobs.push({ ...finishedJob(), id: "bbbb2222", attempt: 2, continues: "aaaa1111", status: "running", finishedAt: null, result: null, completionMessageId: null, completionDelivery: null, cleanedUp: null, launchState: "uncertain", submittedAt: null, launch: { text: "again", model: null, messageId: "msg_again", continuation: true } });
    return w;
  };
  const gone = mk();
  gone.sessions.delete(CHILD);
  await reconcileV2Jobs(gone.deps);
  assert.equal(gone.job("bbbb2222").status, "failed");
  assert.equal(gone.job("bbbb2222").error, "the session no longer exists");
  assert.equal(gone.calls.synth.length, 1, "the caller gets its one result");

  const noBranch = mk();
  noBranch.fail.add = new Error("fatal: invalid reference: job/fix");
  await reconcileV2Jobs(noBranch.deps);
  assert.equal(noBranch.job("bbbb2222").status, "failed");
  assert.match(noBranch.job("bbbb2222").error, /branch job\/fix no longer exists/);
  assert.equal(noBranch.calls.send.length, 0);
  assert.deepEqual(noBranch.calls.del, []);
});

// ---------------------------------------------------------------------------
// delegate_send — refusals, in order
// ---------------------------------------------------------------------------

test("send refusals: 404 / 400 / 403 / 403 CTO", async () => {
  const w = finishedWorld();
  const r404 = await continueJob("deadbeef", { prompt: "x", sessionID: PARENT }, w.deps);
  assert.deepEqual([r404.status, r404.error], [404, "that background job no longer exists"]);
  const r400 = await send(w, "aaaa1111", { prompt: "   " });
  assert.deepEqual([r400.status, r400.error], [400, "prompt is required"]);
  const r403 = await send(w, "aaaa1111", { sessionID: "ses_somebody_else" });
  assert.deepEqual([r403.status, r403.error], [403, "that job belongs to another session"]);
  const cto = finishedWorld({ correlation: { kind: "work", id: "w1" } });
  const rCto = await send(cto);
  assert.deepEqual([rCto.status, rCto.error], [403, "that job is managed by the CTO"]);
  assert.equal(w.jobs.length, 1);
});

test("send: a session in the parent's replacement chain is the owner too", async () => {
  const w = finishedWorld();
  w.deps.replacementChain = () => [PARENT, "ses_successor"];
  const res = await continueJob("aaaa1111", { prompt: "go", sessionID: "ses_successor" }, w.deps);
  assert.equal(res.ok, true);
});

test("send refusals: superseded → newer run / continued outside delegate; observed; opencode-owned", async () => {
  const w = finishedWorld();
  const first = await send(w);
  assert.equal(first.ok, true);
  // finish the new run so only supersession can refuse
  w.jobs.splice(0, w.jobs.length, ...w.jobs.map((j) => (j.id === first.job.id ? { ...j, status: "done", finishedAt: T0 + 500, completionDelivery: "delivered" } : j)));
  const again = await send(w, "aaaa1111");
  assert.equal(again.status, 409);
  assert.equal(again.error, `that job has a newer run — use ${first.job.id}`);

  // the newest run on that session is an observed one
  const w2 = finishedWorld();
  w2.jobs[0] = { ...w2.jobs[0], supersededBy: "cccc3333" };
  w2.jobs.push({ ...finishedJob(), id: "cccc3333", origin: "observed", completionOwner: "opencode", attempt: 2, continues: "aaaa1111", status: "done", parentSessionID: null });
  const outside = await send(w2, "aaaa1111");
  assert.equal(outside.status, 409);
  assert.equal(outside.error, "that job's session was continued outside delegate — start a new job instead");

  const obs = finishedWorld({ origin: "observed", completionOwner: "opencode" });
  assert.equal((await send(obs)).error, "only jobs started with delegate can be continued — start a new job instead");
  const sub = finishedWorld({ origin: "subagent", completionOwner: "opencode" });
  assert.equal((await send(sub)).error, "only jobs started with delegate can be continued — start a new job instead");
});

test("send refusals: running / paused / result still being delivered / session busy / no session / cap", async () => {
  assert.equal((await send(finishedWorld({ status: "running", finishedAt: null }))).error, "that job is still working — its result will arrive on its own");
  assert.equal((await send(finishedWorld({ status: "paused", finishedAt: null }))).error, "that job is paused — resume it first");
  assert.equal((await send(finishedWorld({ completionDelivery: "pending" }))).error, "its result is still being delivered — try again shortly");

  const busy = finishedWorld();
  busy.active.add(CHILD);
  assert.equal((await send(busy)).error, "that job's session is busy");

  const gone = finishedWorld();
  gone.sessions.delete(CHILD);
  assert.equal((await send(gone)).error, "that job has no session to continue");
  assert.equal((await send(finishedWorld({ childSessionID: null }))).error, "that job has no session to continue");

  const cap = finishedWorld();
  for (let i = 0; i < MAX_RUNNING_JOBS; i++) cap.jobs.push({ id: `r${i}`.padEnd(8, "0"), status: "running", childSessionID: `ses_r${i}`, parentSessionID: "ses_o", origin: "delegate" });
  const capped = await send(cap);
  assert.deepEqual([capped.status, capped.error], [409, CAP_ERROR]);
  // sessions Manta merely observes do not use a slot
  const obsCap = finishedWorld();
  for (let i = 0; i < MAX_RUNNING_JOBS; i++) obsCap.jobs.push({ id: `o${i}`.padEnd(8, "0"), status: "running", childSessionID: `ses_o${i}`, parentSessionID: null, origin: "observed", completionOwner: "opencode" });
  assert.equal((await send(obsCap)).ok, true);
});

// ---------------------------------------------------------------------------
// delegate_send — undo
// ---------------------------------------------------------------------------

test("send: a definite refusal undoes the new record, the supersession, the window it made and the worktree it re-added — and never deletes the session", async () => {
  const w = finishedWorld();
  w.fail.send = httpErr(400, "bad request");
  const res = await send(w);
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.match(res.error, /^couldn't send to the job: /);
  assert.equal(w.jobs.length, 1, "the new record is gone");
  assert.equal(w.job("aaaa1111").supersededBy, undefined, "the old record is its own again");
  assert.equal(w.calls.kill.length, 1, "the window this attempt made is closed");
  assert.deepEqual(w.calls.rm.map((r) => r.path), [WT], "the worktree this attempt re-added is removed");
  assert.deepEqual(w.calls.del, [], "the continued session is NEVER deleted");
  assert.equal(w.windows.some((x) => x.opencodeSessionId === CHILD), false);
});

test("send: refusal with a pre-existing window and worktree takes back nothing it did not make", async () => {
  const w = finishedWorld({}, { paths: [WT] });
  w.windows.push({ index: 9, opencodeSessionId: CHILD, paneCurrentPath: WT });
  w.fail.send = httpErr(400, "bad request");
  const res = await send(w);
  assert.equal(res.ok, false);
  assert.equal(w.calls.kill.length, 0);
  assert.equal(w.calls.rm.length, 0);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.job("aaaa1111").supersededBy, undefined);
});

test("send: a worktree that is gone and whose branch can't be re-added → 409, full rollback", async () => {
  const w = finishedWorld();
  w.fail.add = new Error("fatal: invalid reference");
  const res = await send(w);
  assert.deepEqual([res.status, res.error], [409, "that job's branch job/fix no longer exists"]);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.job("aaaa1111").supersededBy, undefined);
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.send.length, 0);
});

test("send: a window that can't be created → 500 and the re-added worktree is taken back", async () => {
  const w = finishedWorld();
  w.fail.window = new Error("tmux said no");
  const res = await send(w);
  assert.equal(res.status, 500);
  assert.match(res.error, /tmux said no/);
  assert.equal(w.jobs.length, 1);
  assert.deepEqual(w.calls.rm.map((r) => r.path), [WT]);
});

// ---------------------------------------------------------------------------
// delegate_send — completion
// ---------------------------------------------------------------------------

test("send: an old idle/outcome before submittedAt never settles; the new round's outcome settles ONCE and posts ONE result to the caller", async () => {
  const w = finishedWorld();
  const res = await send(w);
  const id = res.job.id;
  w.active.clear(); // opencode shows nothing running, but the session still carries the OLD outcome
  const stale = await settleV2Job(w.job(id), w.deps);
  assert.equal(stale.settled, false);
  assert.equal(stale.reason, "no-outcome");
  assert.equal(w.job(id).status, "running");
  assert.equal(w.calls.synth.length, 0);

  // the new round runs and ends
  w.say(CHILD, "round two done");
  w.finish(CHILD, "succeeded", T0 + 300);
  const done = await settleV2Job(w.job(id), w.deps);
  assert.equal(done.settled, true);
  assert.equal(w.job(id).status, "done");
  assert.equal(w.job(id).result, "round two done");
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.calls.synth[0].sid, PARENT);
  assert.equal(w.calls.synth[0].body.id, w.job(id).completionMessageId);
  assert.equal(w.job("aaaa1111").status, "done");
  assert.equal(w.job("aaaa1111").result, "all done", "the old record keeps its delivered result");
  // a second settle adds nothing
  await settleV2Job(w.job(id), w.deps);
  assert.equal(w.calls.synth.length, 1);
});

test("send: the new run's outcome must come from a message of THIS launch — a user message that is not the launch's is no input", async () => {
  const w = finishedWorld();
  const res = await send(w);
  const id = res.job.id;
  w.timelines.set(CHILD, [{ type: "user", id: "msg_not_ours" }]);
  w.say(CHILD, "x");
  w.finish(CHILD, "succeeded", T0 + 300);
  const out = await settleV2Job(w.job(id), w.deps);
  assert.equal(out.reason, "no-input");
  assert.equal(w.job(id).status, "running");
});

// ---------------------------------------------------------------------------
// one run = one record: a late action on the OLD record never touches the new one
// ---------------------------------------------------------------------------

test("a late cleanup / finish / delete of the superseded record leaves the successor's window and worktree alone", async () => {
  const w = finishedWorld({ cleanedUp: null, windowIndex: 3 });
  const res = await send(w);
  assert.equal(res.ok, true);
  const next = w.job(res.job.id);
  const killsBefore = w.calls.kill.length;
  const rmBefore = w.calls.rm.length;

  // a cleanup of the old record that was paused right before its removal, released now
  const old = w.job("aaaa1111");
  const out = await cleanupTerminalJob(old, w.deps);
  assert.equal(out.superseded, true);
  assert.equal(w.calls.kill.length, killsBefore);
  assert.equal(w.calls.rm.length, rmBefore);
  assert.equal(w.windows.some((x) => x.index === next.windowIndex && x.opencodeSessionId === CHILD), true, "the successor's window survives");
  assert.equal(w.existing.has(WT), true, "the successor's worktree survives");

  // the sweep's close-once loop and an explicit delete of the old record
  w.jobs[0] = { ...w.jobs[0], cleanedUp: null };
  await sweepDelegateJobs(w.deps);
  assert.equal(w.calls.kill.length, killsBefore);
  const del = await deleteJob("aaaa1111", w.deps);
  assert.equal(del.ok, true);
  assert.equal(w.calls.kill.length, killsBefore);
  assert.equal(w.calls.rm.length, rmBefore);
  assert.equal(w.job("aaaa1111"), undefined, "only the record went");
  assert.equal(w.windows.some((x) => x.opencodeSessionId === CHILD), true);
  assert.equal(w.existing.has(WT), true);

  // and the old record's late finish is a no-op
  const late = await finishV2Job({ ...old, status: "running" }, "failed", "late", w.deps);
  assert.equal(late.alreadyTerminal, true);
});

test("the resource lock serialises a cleanup and a successor's setup: the successor re-adds the worktree only AFTER the old cleanup removed it", async () => {
  const w = world({ jobs: [finishedJob({ status: "running", finishedAt: null, result: null, completionMessageId: null, completionDelivery: null, cleanedUp: null, windowIndex: 3, submittedAt: T0 })], paths: [WT] });
  w.sessions.set(CHILD, { id: CHILD, parentID: PARENT, directory: WT, agent: "build", time: {} });
  w.windows.push({ index: 3, opencodeSessionId: CHILD, paneCurrentPath: WT });
  w.state.now = T0 + 100;
  const order = [];
  let release;
  w.state.gate = new Promise((r) => { release = r; });
  const origRm = w.deps.gitRemoveWorktree;
  w.deps.gitRemoveWorktree = async (i) => { const out = await origRm(i); order.push("rm"); return out; };
  const origGit = w.deps.gitRun;
  w.deps.gitRun = async (args) => { if (args.includes("add")) order.push("add"); return origGit(args); };

  w.say(CHILD, "r1");
  w.finish(CHILD, "succeeded", T0 + 50);
  const finishing = finishV2Job(w.job("aaaa1111"), "done", null, w.deps); // blocks inside gitRemoveWorktree
  // let it write its terminal state and reach the cleanup
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.job("aaaa1111").status, "done");
  const sending = send(w);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.jobs.length, 1, "the successor waits for the session's resource lock");
  release();
  await finishing;
  const res = await sending;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(order, ["rm", "add"]);
});

// ---------------------------------------------------------------------------
// observed records are track-only
// ---------------------------------------------------------------------------

const observedJob = (over = {}) => ({
  ...finishedJob(),
  id: "dddd4444",
  childSessionID: "ses_obs",
  origin: "observed",
  completionOwner: "opencode",
  parentSessionID: null,
  status: "running",
  finishedAt: null,
  result: null,
  completionMessageId: null,
  completionDelivery: null,
  worktree: null,
  branch: null,
  baseSha: null,
  executionDirectory: null,
  launch: undefined,
  runStartedAt: T0,
  submittedAt: null,
  cleanedUp: null,
  windowIndex: 7,
  ...over,
});

test("countsTowardCap: running and not observed", () => {
  assert.equal(countsTowardCap({ status: "running", origin: "delegate" }), true);
  assert.equal(countsTowardCap({ status: "running" }), true);
  assert.equal(countsTowardCap({ status: "running", origin: "observed" }), false);
  assert.equal(countsTowardCap({ status: "paused", origin: "delegate" }), false);
  assert.equal(countsTowardCap({ status: "done", origin: "delegate" }), false);
});

test("runningJobCount counts only what uses a slot", async () => {
  const w = world({ jobs: [observedJob(), observedJob({ id: "d2".padEnd(8, "0"), childSessionID: "ses_o2" }), finishedJob({ status: "running", finishedAt: null })] });
  assert.equal(await runningJobCount(w.deps), 1);
});

test("observed: never counts toward the cap or the nesting rule", async () => {
  const noWorktree = async () => { throw new Error("not a git repository"); };
  const w = world({ jobs: Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => observedJob({ id: `o${i}`.padEnd(8, "0"), childSessionID: `ses_o${i}` })) });
  w.deps.createChildSession = async (i) => { w.sessions.set(i.id, { id: i.id, directory: REPO }); return { id: i.id, directory: REPO }; };
  w.deps.moveSession = async () => {};
  w.deps.gitAddWorktree = noWorktree;
  const ok = await startJob({ prompt: "do the thing", name: "thing", parentSessionID: PARENT, parentDirectory: REPO, actor: "cto" }, w.deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // a caller that IS an observed session may start a job (it is not a background job)
  const w2 = world({ jobs: [observedJob({ childSessionID: PARENT })] });
  w2.deps.createChildSession = async (i) => ({ id: i.id, directory: REPO });
  w2.deps.moveSession = async () => {};
  w2.deps.gitAddWorktree = noWorktree;
  const nested = await startJob({ prompt: "x", name: "x", parentSessionID: PARENT, parentDirectory: REPO, actor: "cto" }, w2.deps);
  assert.equal(nested.ok, true, JSON.stringify(nested));
});

test("observed: excluded from the running timeout and from the parent-gone stop", async () => {
  const w = world({ jobs: [observedJob({ startedAt: T0 - 5 * 60 * 60_000, parentSessionID: "ses_gone_parent" })] });
  w.sessions.set("ses_obs", { id: "ses_obs", directory: REPO, time: {} });
  w.active.add("ses_obs");
  w.state.now = T0 + 5 * 60 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job("dddd4444").status, "running");
  assert.equal(w.calls.abort.length, 0);
});

test("observed: settles through settleV2Job with NO result post; the window closes; no worktree to lose", async () => {
  const w = world({ jobs: [observedJob()] });
  w.sessions.set("ses_obs", { id: "ses_obs", directory: REPO, outcome: "succeeded", time: { idle: T0 + 50 } });
  w.windows.push({ index: 7, opencodeSessionId: "ses_obs", paneCurrentPath: REPO });
  w.say("ses_obs", "done by a script");
  const res = await settleV2Job(w.job("dddd4444"), w.deps);
  assert.equal(res.settled, true);
  const j = w.job("dddd4444");
  assert.equal(j.status, "done");
  assert.equal(j.completionDelivery, null);
  assert.equal(w.calls.synth.length, 0);
  assert.equal(w.calls.kill.length, 1);
  assert.equal(j.cleanedUp, true);
});

test("observed: a worktree it inherited is NEVER removed — the window closes and the record keeps it", async () => {
  const w = world({ jobs: [observedJob({ worktree: WT, branch: "job/fix", baseSha: "abc" })], paths: [WT] });
  w.sessions.set("ses_obs", { id: "ses_obs", directory: WT, outcome: "succeeded", time: { idle: T0 + 50 } });
  w.windows.push({ index: 7, opencodeSessionId: "ses_obs", paneCurrentPath: WT });
  await settleV2Job(w.job("dddd4444"), w.deps);
  assert.equal(w.job("dddd4444").status, "done");
  assert.equal(w.calls.rm.length, 0);
  assert.equal(w.calls.kill.length, 1);
  assert.equal(w.job("dddd4444").cleanedUp, false);
  assert.equal(w.job("dddd4444").cleanupReason, "kept");
  // retention keeps it while it holds a worktree
  w.state.now = T0 + 30 * 24 * 60 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 1);
});

test("retention does not keep a SUPERSEDED record just because it was left cleanedUp:false", async () => {
  const w = world({ jobs: [finishedJob({ cleanedUp: false, supersededBy: "eeee5555", finishedAt: T0 }), finishedJob({ id: "eeee5555", attempt: 2, continues: "aaaa1111", finishedAt: T0 + 5 })] });
  w.state.now = T0 + 30 * 24 * 60 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job("aaaa1111"), undefined);
  assert.equal(w.calls.kill.length, 0, "its window belongs to the successor");
});

// ---------------------------------------------------------------------------
// run freshness for sessions opencode runs
// ---------------------------------------------------------------------------

test("freshness: a resumed session's PREVIOUS outcome cannot finish its new record; the new run's outcome does", async () => {
  const w = world({ jobs: [observedJob({ origin: "subagent", runStartedAt: T0 + 100 })] });
  w.sessions.set("ses_obs", { id: "ses_obs", directory: REPO, outcome: "succeeded", time: { idle: T0 + 50 } });
  const stale = await settleV2Job(w.job("dddd4444"), w.deps);
  assert.equal(stale.settled, false);
  assert.equal(stale.reason, "no-outcome");
  w.sessions.get("ses_obs").time.idle = T0 + 150;
  const fresh = await settleV2Job(w.job("dddd4444"), w.deps);
  assert.equal(fresh.settled, true);
});

// ---------------------------------------------------------------------------
// adoptExistingSession + resolveSessionOwner + the task event path
// ---------------------------------------------------------------------------

const adoptInput = (over = {}) => ({
  childSessionID: "ses_adopted",
  owner: { tmuxSession: "proj" },
  displayParentID: PARENT,
  sessionParentID: PARENT,
  cwd: REPO,
  name: "explore",
  prompt: "go",
  model: null,
  origin: "observed",
  runStartedAt: T0,
  ...over,
});

test("adoptExistingSession: a session with a terminal record gets a NEW record linked to it; a live one is already adopted; the window is reused by stamp", async () => {
  const w = world({ jobs: [finishedJob({ childSessionID: "ses_adopted", windowIndex: 2, cleanedUp: false, worktree: WT })], paths: [WT] });
  w.windows.push({ index: 4, opencodeSessionId: "ses_adopted", paneCurrentPath: WT }); // moved: recorded index 2 proves nothing
  const out = await adoptExistingSession(adoptInput({ runStartedAt: T0 + 500 }), w.deps);
  assert.equal(out.ok, true);
  assert.equal(out.job.attempt, 2);
  assert.equal(out.job.continues, "aaaa1111");
  assert.equal(out.job.windowIndex, 4, "reused the window stamped with the session");
  assert.equal(w.calls.window.length, 0);
  assert.equal(out.job.worktree, WT, "the worktree travels while it still exists");
  assert.equal(out.job.completionOwner, "opencode");
  assert.equal(out.job.launchState, "running");
  assert.equal(out.job.submittedAt, null);
  assert.equal(out.job.runStartedAt, T0 + 500);
  assert.equal(w.job("aaaa1111").supersededBy, out.job.id);
  const again = await adoptExistingSession(adoptInput(), w.deps);
  assert.equal(again.alreadyAdopted, true);
  assert.equal(w.jobs.length, 2);
  assert.equal(newestRecordFor(w.jobs, "ses_adopted").id, out.job.id);
});

test("adoptExistingSession: a worktree that is gone is not inherited; a stale signal about an ended run is not a new run", async () => {
  const w = world({ jobs: [finishedJob({ childSessionID: "ses_adopted", finishedAt: T0 + 400 })] });
  const stale = await adoptExistingSession(adoptInput({ runStartedAt: T0 + 100 }), w.deps);
  assert.equal(stale.alreadyAdopted, true);
  assert.equal(stale.stale, true);
  assert.equal(w.jobs.length, 1);
  const fresh = await adoptExistingSession(adoptInput({ runStartedAt: T0 + 900 }), w.deps);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.job.worktree, null);
});

test("resolveSessionOwner: nearest windowed ancestor, else the directory's project, else none; unreadable → unknown", async () => {
  const w = world();
  w.sessions.set("ses_p", { id: "ses_p", parentID: "ses_gp", directory: "/elsewhere" });
  w.sessions.set("ses_gp", { id: "ses_gp", parentID: PARENT, directory: "/elsewhere" });
  w.sessions.set("ses_x", { id: "ses_x", parentID: "ses_p", directory: "/elsewhere" });
  const viaAncestor = await resolveSessionOwner("ses_x", w.deps);
  assert.equal(viaAncestor.status, "ok");
  assert.equal(viaAncestor.displayParentID, PARENT);
  assert.equal(viaAncestor.owner.tmuxSession, "proj");

  w.sessions.set("ses_y", { id: "ses_y", directory: "/repo/sub/dir" });
  const viaDir = await resolveSessionOwner("ses_y", w.deps);
  assert.equal(viaDir.status, "ok");
  assert.equal(viaDir.displayParentID, null);
  assert.equal(viaDir.owner.tmuxSession, "proj");

  w.sessions.set("ses_z", { id: "ses_z", directory: "/nowhere" });
  assert.equal((await resolveSessionOwner("ses_z", w.deps)).status, "none");

  w.fail.readSession = netErr();
  assert.equal((await resolveSessionOwner("ses_x", w.deps)).status, "unknown");
  w.fail.readSession = null;

  // a cycle never loops
  w.sessions.set("ses_c1", { id: "ses_c1", parentID: "ses_c2", directory: "/nowhere" });
  w.sessions.set("ses_c2", { id: "ses_c2", parentID: "ses_c1", directory: "/nowhere" });
  assert.equal((await resolveSessionOwner("ses_c1", w.deps)).status, "none");
});

const bgPart = (child, over = {}) => ({
  type: "tool",
  tool: "task",
  state: { status: "running", input: { subagent_type: "explore", description: "explore it", prompt: "go" }, metadata: { sessionId: child, background: true }, time: { start: T0 + 5 }, ...over },
});

test("observeEvent: a background task whose parent has NO window is adopted under its nearest windowed ancestor", async () => {
  const w = world();
  w.sessions.set("ses_windowless", { id: "ses_windowless", parentID: PARENT, directory: REPO });
  w.sessions.set("ses_bgchild", { id: "ses_bgchild", parentID: "ses_windowless", directory: REPO, time: {} });
  w.active.add("ses_bgchild");
  await observeEvent({ type: "message.part.updated", properties: { sessionID: "ses_windowless", part: bgPart("ses_bgchild") } }, w.deps);
  assert.equal(w.jobs.length, 1);
  const j = w.jobs[0];
  assert.equal(j.childSessionID, "ses_bgchild");
  assert.equal(j.parentSessionID, PARENT);
  assert.equal(j.origin, "subagent");
  assert.equal(j.completionOwner, "opencode");
  assert.equal(j.runStartedAt, T0 + 5, "the task part's own start");
  assert.equal(w.calls.window.length, 1);
});

test("observeEvent: a windowless parent with no windowed ancestor lands in the directory's workspace; an owner-less one warns ONCE", async () => {
  const w = world();
  w.sessions.set("ses_windowless", { id: "ses_windowless", directory: "/repo/sub" });
  w.sessions.set("ses_bg2", { id: "ses_bg2", parentID: "ses_windowless", directory: "/repo/sub", time: {} });
  await observeEvent({ type: "message.part.updated", properties: { sessionID: "ses_windowless", part: bgPart("ses_bg2") } }, w.deps);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].parentSessionID, "ses_windowless", "a windowless display parent: the row renders top-level");

  const orphan = world();
  orphan.sessions.set("ses_nowhere", { id: "ses_nowhere", directory: "/nowhere/at/all" });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    for (let i = 0; i < 3; i++) await observeEvent({ type: "message.part.updated", properties: { sessionID: "ses_nowhere", part: bgPart("ses_bg3") } }, orphan.deps);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(orphan.jobs.length, 0);
  assert.equal(warns.filter((m) => m.includes("could not resolve the owning workspace")).length, 1);
});

test("a resumed task (same child) after its record finished is a NEW record; an old running replay is not", async () => {
  const w = world();
  w.sessions.set("ses_bgchild", { id: "ses_bgchild", parentID: PARENT, directory: REPO, time: {} });
  const ev = (start) => ({ type: "message.part.updated", properties: { sessionID: PARENT, part: bgPart("ses_bgchild", { time: { start } }) } });
  await observeEvent(ev(T0 + 5), w.deps);
  assert.equal(w.jobs.length, 1);
  w.sessions.get("ses_bgchild").outcome = "succeeded";
  w.sessions.get("ses_bgchild").time = { idle: T0 + 50 };
  w.state.now = T0 + 60;
  await settleV2Job(w.job(w.jobs[0].id), w.deps);
  assert.equal(w.jobs[0].status, "done");
  await observeEvent(ev(T0 + 5), w.deps); // a replayed event about the OLD run
  assert.equal(w.jobs.length, 1);
  w.state.now = T0 + 200;
  await observeEvent(ev(T0 + 150), w.deps); // the task was resumed
  assert.equal(w.jobs.length, 2);
  assert.equal(w.jobs[1].attempt, 2);
  assert.equal(w.jobs[0].supersededBy, w.jobs[1].id);
});

// ---------------------------------------------------------------------------
// the active-session reconciler
// ---------------------------------------------------------------------------

function recWorld(opts) {
  const w = world(opts);
  const engine = createDelegateEngine(w.deps);
  const tick = async (n = 1) => {
    let out;
    for (let i = 0; i < n; i++) {
      w.state.now += 15_000;
      out = await engine.reconcileActiveSessions();
    }
    return out;
  };
  return { w, engine, tick };
}
const busy = (w, sid, rec) => {
  w.sessions.set(sid, { id: sid, directory: REPO, title: "Some script run", time: {}, ...rec });
  w.active.add(sid);
};
const quietly = async (fn) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warns;
};

test("reconciler: a windowless busy untracked session is adopted on the 2nd tick (observed, track-only), not the 1st", async () => {
  const { w, tick } = recWorld();
  busy(w, "ses_script", { directory: "/repo/sub" });
  await tick();
  assert.equal(w.jobs.length, 0);
  const firstSeen = w.state.now;
  await tick();
  assert.equal(w.jobs.length, 1);
  const j = w.jobs[0];
  assert.equal(j.origin, "observed");
  assert.equal(j.completionOwner, "opencode");
  assert.equal(j.status, "running");
  assert.equal(j.attempt, 1);
  assert.equal(j.continues, null);
  assert.equal(j.runStartedAt, firstSeen, "the first tick the session was seen busy");
  assert.equal(j.name, "Some script run");
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.window[0].existingSessionId, "ses_script");
  assert.equal(w.calls.window[0].cwd, "/repo/sub");
  assert.equal(countsTowardCap(j), false);
  // idempotent
  await tick(3);
  assert.equal(w.jobs.length, 1);
});

test("reconciler: a child with no `task` block in its parent's timeline needs a 3rd tick; a background block needs 2; a foreground block never", async () => {
  const mk = () => {
    const r = recWorld();
    r.w.sessions.set("ses_p", { id: "ses_p", directory: REPO });
    busy(r.w, "ses_kid", { parentID: "ses_p" });
    return r;
  };
  const none = mk();
  await none.tick(2);
  assert.equal(none.w.jobs.length, 0);
  await none.tick();
  assert.equal(none.w.jobs.length, 1);

  const block = (background) => [{ type: "assistant", content: [{ type: "tool", state: { input: { background }, metadata: { sessionID: "ses_kid" } } }] }];
  const bg = mk();
  bg.w.timelines.set("ses_p", block(true));
  await bg.tick(2);
  assert.equal(bg.w.jobs.length, 1);

  const fg = mk();
  fg.w.timelines.set("ses_p", block(false));
  await fg.tick(6);
  assert.equal(fg.w.jobs.length, 0);
});

test("reconciler: the debounce is dropped when the session leaves `active`", async () => {
  const { w, tick, engine } = recWorld();
  busy(w, "ses_blip", {});
  await tick();
  w.active.delete("ses_blip");
  await tick();
  w.active.add("ses_blip");
  await tick();
  assert.equal(w.jobs.length, 0, "the count restarted");
  await tick();
  assert.equal(w.jobs.length, 1);
  void engine;
});

test("reconciler: skips a session with a live record, anything below a live job, Manta's own helpers, a user window and a pending handoff", async () => {
  const { w, tick } = recWorld({ jobs: [observedJob({ id: "live0000", childSessionID: "ses_live", status: "running" }), observedJob({ id: "paus0000", childSessionID: "ses_paused", status: "paused" }), finishedJob({ id: "jobjob00", childSessionID: "ses_jobroot", status: "running", finishedAt: null, completionDelivery: null })] });
  busy(w, "ses_live", {});
  busy(w, "ses_paused", {});
  busy(w, "ses_jobroot", {});
  busy(w, "ses_below", { parentID: "ses_jobroot" });
  w.sessions.set("ses_mid", { id: "ses_mid", parentID: "ses_jobroot", directory: REPO });
  busy(w, "ses_deep", { parentID: "ses_mid" });
  busy(w, "ses_marked", { metadata: withInternalMarker({ role: "x" }) });
  busy(w, "ses_title", { agent: "title" });
  busy(w, "ses_comp", { agent: "compaction" });
  busy(w, "ses_cto_eph", {});
  busy(w, "ses_cto_conv", {});
  busy(w, "ses_userwin", {});
  w.windows.push({ index: 2, opencodeSessionId: "ses_userwin", paneCurrentPath: REPO });
  busy(w, "ses_handoff", {});
  w.deps.isInternalSession = async (sid) => sid === "ses_cto_eph";
  w.deps.isCtoConversationSession = async (sid) => sid === "ses_cto_conv";
  w.deps.deferSettlement = (sid) => sid === "ses_handoff";
  const { engine } = { engine: createDelegateEngine(w.deps) };
  for (let i = 0; i < 4; i++) await engine.reconcileActiveSessions();
  assert.equal(w.jobs.length, 3, "nothing new was adopted");
  assert.equal(w.calls.window.length, 0);
  void tick;
});

test("reconciler: a windowless parent → its nearest windowed ancestor; no ancestor → the directory's project; no owner → skipped with ONE warning", async () => {
  const { w, tick } = recWorld();
  w.sessions.set("ses_mid", { id: "ses_mid", parentID: PARENT, directory: "/elsewhere" });
  busy(w, "ses_viaancestor", { parentID: "ses_mid", directory: "/elsewhere" });
  w.timelines.set("ses_mid", [{ type: "assistant", content: [{ type: "tool", state: { input: { background: true }, metadata: { sessionID: "ses_viaancestor" } } }] }]);
  busy(w, "ses_viadir", { directory: "/repo/x" });
  busy(w, "ses_noowner", { directory: "/nowhere" });
  const warns = await quietly(() => tick(6));
  const byChild = (c) => w.jobs.find((j) => j.childSessionID === c);
  assert.equal(byChild("ses_viaancestor").parentSessionID, PARENT);
  assert.equal(byChild("ses_viadir").parentSessionID, null);
  assert.equal(byChild("ses_noowner"), undefined);
  assert.equal(warns.filter((m) => m.includes("ses_noowner")).length, 1);
});

test("reconciler: unreadable reads skip the session without a warning; a failing listActiveIds is a no-op tick", async () => {
  const { w, tick } = recWorld();
  busy(w, "ses_a", {});
  w.fail.readSession = netErr();
  const warns = await quietly(() => tick(4));
  assert.equal(w.jobs.length, 0);
  assert.deepEqual(warns, []);
  w.fail.readSession = null;

  const t = recWorld();
  busy(t.w, "ses_b", { parentID: "ses_p2" });
  t.w.sessions.set("ses_p2", { id: "ses_p2", directory: REPO });
  t.w.fail.listTimeline = netErr();
  const warns2 = await quietly(() => t.tick(4));
  assert.equal(t.w.jobs.length, 0);
  assert.deepEqual(warns2, []);
  t.w.fail.listTimeline = null;

  const n = recWorld();
  busy(n.w, "ses_c", {});
  n.w.fail.listActive = netErr();
  const out = await n.tick(3);
  assert.deepEqual(out, { skipped: "unknown" });
  assert.equal(n.w.jobs.length, 0);
  void tick;
});

test("reconciler: a windowed session is never adopted, even when its only records are terminal (a reopened finished job the user chats in)", async () => {
  const { w, tick } = recWorld({ jobs: [finishedJob({ childSessionID: "ses_again", windowIndex: 3, worktree: null, branch: null, cleanedUp: false, finishedAt: T0 + 5 })] });
  w.windows.push({ index: 3, opencodeSessionId: "ses_again", paneCurrentPath: REPO });
  busy(w, "ses_again", { parentID: PARENT });
  w.timelines.set(PARENT, []);
  await tick(6);
  assert.equal(w.jobs.length, 1, "no record written");
  assert.equal(w.job("aaaa1111").supersededBy ?? null, null);
  assert.equal(w.calls.window.length, 0);
});

test("reconciler: a session the handoff engine flags as an uncommitted successor is skipped", async () => {
  const { w } = recWorld();
  busy(w, "ses_succ", {});
  let flagged = true;
  w.deps.isHandoffSuccessor = (sid) => flagged && sid === "ses_succ";
  const engine = createDelegateEngine(w.deps);
  const tickOwn = async (n) => {
    for (let i = 0; i < n; i++) {
      w.state.now += 15_000;
      await engine.reconcileActiveSessions();
    }
  };
  await tickOwn(6);
  assert.equal(w.jobs.length, 0);
  assert.equal(w.calls.window.length, 0);
  flagged = false;
  await tickOwn(2);
  assert.equal(w.jobs.length, 1, "adopted once the predicate no longer flags it");
});

test("reconciler: an observed record picked up here later settles on its own and posts nothing", async () => {
  const { w, tick, engine } = recWorld();
  busy(w, "ses_script", {});
  await tick(2);
  assert.equal(w.jobs.length, 1);
  w.say("ses_script", "script finished");
  w.finish("ses_script", "succeeded", w.state.now + 5);
  w.state.now += 10;
  await engine.sweep();
  assert.equal(w.jobs[0].status, "done");
  assert.equal(w.calls.synth.length, 0);
  assert.equal(w.calls.kill.length, 1);
});

// ---------------------------------------------------------------------------
// the internal-session marker
// ---------------------------------------------------------------------------

test("withInternalMarker merges into existing metadata and never mutates it; isMarkedInternal reads the marker and the housekeeping agents", () => {
  const identity = { role: "cto_conversation", bindingOperation: "op-1", manta: { other: 1 } };
  const marked = withInternalMarker(identity);
  assert.deepEqual(marked, { role: "cto_conversation", bindingOperation: "op-1", manta: { other: 1, internal: true } });
  assert.deepEqual(identity, { role: "cto_conversation", bindingOperation: "op-1", manta: { other: 1 } });
  assert.deepEqual(withInternalMarker(), { manta: { internal: true } });
  assert.equal(isMarkedInternal({ metadata: marked }), true);
  assert.equal(isMarkedInternal({ agent: "title" }), true);
  assert.equal(isMarkedInternal({ agent: "summary" }), true);
  assert.equal(isMarkedInternal({ agent: "build", metadata: { role: "x" } }), false);
  assert.equal(isMarkedInternal(null), false);
});

void mintMessageId;
