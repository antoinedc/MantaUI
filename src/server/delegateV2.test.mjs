// Stage B: V2 background jobs — Manta-wrapped command runs (startCommandJob),
// raw-outcome completion, the N7 result post, V2-native command adoption,
// no-worktree retention, open-session. Every opencode / tmux read is an injected
// fake over one in-memory "world"; no live anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startCommandJob,
  settleV2Job,
  finishV2Job,
  reconcileV2Jobs,
  deliverJobResult,
  retryPendingDeliveries,
  buildResultSynthetic,
  openJobSession,
  adoptSubagentJob,
  observeEvent,
  stopJob,
  deleteJob,
  pauseJob,
  sweepDelegateJobs,
  reconcileJobsOnBoot,
  createDelegateEngine,
  createLifecycleMap,
  completionOwnerOf,
  outcomeToTerminal,
  commandDisplayName,
  mintSessionId,
  MAX_RUNNING_JOBS,
} from "./delegate.mjs";

const T0 = 1_700_000_000_000;
const PARENT = "ses_parent";
const CAP_ERROR =
  "too many background jobs running (5). Do not retry — either wait for one to finish, or do this work yourself.";

const httpErr = (status, message = `opencode ${status}`) => Object.assign(new Error(message), { status });
const netErr = () => new Error("fetch failed");

// ---------------------------------------------------------------------------
// The world: an in-memory store + fake opencode/tmux. `w.deps` is what the
// engine functions receive.
// ---------------------------------------------------------------------------
function world({ parent = {}, jobs: seed = [] } = {}) {
  const jobs = seed.map((j) => ({ ...j }));
  const saves = [];
  const published = [];
  const calls = { create: [], run: [], window: [], kill: [], del: [], synth: [], deliver: [], stamp: [] };
  const sessions = new Map();
  const active = new Set();
  const inboxes = new Map();
  const timelines = new Map(); // sid -> raw records (chronological)
  const messages = new Map(); // sid -> [{info, parts}] (for the result text)
  const windows = [{ index: 0, opencodeSessionId: PARENT, paneCurrentPath: "/repo" }];
  const fail = { create: null, run: null, synth: null, readSession: null };
  const state = { now: T0, nextWindow: 5, cto: false, openWindows: [] };

  sessions.set(PARENT, {
    id: PARENT,
    directory: "/repo",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "shell", resource: "git *", effect: "allow" }],
    ...parent,
  });

  const deps = {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => {
      saves.push(structuredClone(next));
      jobs.splice(0, jobs.length, ...next.map((j) => ({ ...j })));
    },
    publish: (e) => published.push(e),
    now: () => state.now,
    listProjects: async () => [{ tmuxSession: "proj", defaultCwd: "/repo", windows: windows.map((x) => ({ ...x })) }],
    newWindow: async (i) => {
      calls.window.push(i);
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
    readSession: async (sid) => {
      if (fail.readSession) throw fail.readSession;
      const s = sessions.get(sid);
      return s ? { state: "found", session: structuredClone(s) } : { state: "missing" };
    },
    listActiveIds: async () => [...active],
    listChildSessions: async (sid) => [...sessions.values()].filter((s) => s.parentID === sid).map((s) => structuredClone(s)),
    listRawTimeline: async (sid, { type } = {}) => (timelines.get(sid) ?? []).filter((r) => !type || r.type === type),
    listInbox: async (sid) => inboxes.get(sid) ?? [],
    createChildSession: async (input) => {
      calls.create.push(input);
      if (fail.create) throw fail.create;
      sessions.set(input.id, { id: input.id, parentID: input.parentID, directory: input.directory, agent: input.agent, model: input.model && { providerID: input.model.providerID, id: input.model.modelID }, permissions: input.permissions });
      return { id: input.id };
    },
    runCommandOnChild: async (input) => {
      // what the store holds at the instant the command is SENT
      calls.run.push({ ...input, storeAtSend: jobs.find((j) => j.childSessionID === input.sessionId) && { ...jobs.find((j) => j.childSessionID === input.sessionId) } });
      if (fail.run) throw fail.run;
    },
    deleteSession: async (sid) => {
      calls.del.push(sid);
      sessions.delete(sid);
    },
    postSynthetic: async (sid, body) => {
      calls.synth.push({ sid, body });
      if (fail.synth) throw fail.synth;
    },
    deliver: async (a) => calls.deliver.push(a),
    isCtoConversationSession: async () => state.cto,
    listMessages: async (sid) => messages.get(sid) ?? [],
    clearProgress: async () => {},
    openCommandWindows: () => state.openWindows,
    abortSession: async () => {},
    oc: {},
  };
  return {
    deps,
    calls,
    published,
    saves,
    sessions,
    active,
    inboxes,
    timelines,
    messages,
    windows,
    fail,
    state,
    get jobs() {
      return jobs;
    },
    job: (id) => jobs.find((j) => j.id === id),
    setNow: (n) => { state.now = n; },
    say(sid, text) {
      messages.set(sid, [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]);
    },
    // a child session that ended with `outcome` at `idleAt`
    finish(sid, outcome, idleAt = state.now) {
      const s = sessions.get(sid);
      s.outcome = outcome;
      s.time = { ...(s.time ?? {}), idle: idleAt };
      active.delete(sid);
    },
  };
}

const startInput = (extra = {}) => ({ parentSessionID: PARENT, command: "review", arguments: "HEAD~1", ...extra });

function v2Job(over = {}) {
  return {
    id: "aaaa1111",
    name: "/review HEAD~1",
    prompt: "/review HEAD~1",
    model: null,
    requestedModel: null,
    parentSessionID: PARENT,
    parentDirectory: "/repo",
    childSessionID: "ses_child",
    tmuxSession: "proj",
    windowIndex: 5,
    worktree: null,
    branch: null,
    baseSha: null,
    origin: "command",
    actor: "user",
    status: "running",
    activity: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
    engine: "v2",
    completionOwner: "manta",
    attempt: 1,
    launchState: "running",
    submittedAt: T0,
    completionMessageId: "msg_fixed",
    completionDelivery: null,
    agent: "build",
    commandRun: { command: "review", arguments: "HEAD~1", agent: "build" },
    ...over,
  };
}

// a wrapped job whose child exists in the world
function seedWrapped(w, over = {}) {
  const job = v2Job(over);
  w.jobs.push(job);
  w.sessions.set(job.childSessionID, { id: job.childSessionID, parentID: PARENT, directory: "/repo", time: {} });
  return job;
}

// ---------------------------------------------------------------------------
// startCommandJob — launch checks, ordering, controls, permissions
// ---------------------------------------------------------------------------

test("startCommandJob registers FIRST, creates the child with the parent's permissions + explicit controls, then sends once", async () => {
  const w = world();
  // what the store holds when each network call happens
  const seen = {};
  const create = w.deps.createChildSession;
  w.deps.createChildSession = async (i) => {
    seen.atCreate = w.jobs.map((j) => ({ ...j }));
    return create(i);
  };
  const res = await startCommandJob(startInput({ attachments: [{ remotePath: "/x/a.txt", mime: "text/plain" }] }), w.deps);
  assert.equal(res.ok, true);
  const job = w.job(res.job.id);

  assert.equal(seen.atCreate.length, 1, "the record exists BEFORE the child is created");
  assert.equal(seen.atCreate[0].launchState, "creating");
  assert.match(seen.atCreate[0].childSessionID, /^ses_[0-9a-f]{32}$/, "a client-minted child id");
  assert.match(seen.atCreate[0].completionMessageId, /^msg_/, "the result id is minted up front");

  assert.equal(w.calls.create.length, 1);
  const c = w.calls.create[0];
  assert.equal(c.id, job.childSessionID);
  assert.equal(c.parentID, PARENT);
  assert.equal(c.title, "/review HEAD~1");
  assert.deepEqual(c.permissions, w.sessions.get(PARENT).permissions, "the parent's OWN ruleset, verbatim — never wider");
  assert.equal(c.agent, "build");
  assert.deepEqual(c.model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, "the parent's current model when the composer sent none");

  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.window[0].existingSessionId, job.childSessionID, "the window is stamped with the child id");
  assert.equal(w.calls.window[0].chatMode, true);

  assert.equal(w.calls.run.length, 1, "exactly one send");
  assert.equal(w.calls.run[0].sessionId, job.childSessionID, "the command runs IN THE CHILD");
  assert.equal(w.calls.run[0].command, "review");
  assert.equal(w.calls.run[0].arguments, "HEAD~1");
  assert.equal(w.calls.run[0].agent, "build", "agent passed explicitly to the run too");
  assert.deepEqual(w.calls.run[0].model, { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
  assert.equal(w.calls.run[0].attachments.length, 1);
  assert.equal(w.calls.run[0].storeAtSend.submittedAt, T0, "submittedAt is persisted BEFORE the send");
  assert.equal(w.calls.run[0].storeAtSend.launchState, "submitting");

  assert.equal(job.launchState, "running");
  assert.equal(job.submittedAt, T0, "never rewritten");
  assert.equal(job.origin, "command");
  assert.equal(job.engine, "v2");
  assert.equal(job.completionOwner, "manta");
  assert.equal(job.worktree, null);
  assert.equal(job.parentDirectory, "/repo");
  assert.equal(job.name, "/review HEAD~1");
  assert.equal(job.status, "running");
  assert.ok(w.published.some((e) => e.payload.launchState === "running"), "a launchState change goes through the usual publish (P7)");
});

test("startCommandJob: a plan-agent parent stays plan (explicit agent on create and run); the composer's agent/model win when sent", async () => {
  const w = world({ parent: { agent: "plan" } });
  await startCommandJob(startInput(), w.deps);
  assert.equal(w.calls.create[0].agent, "plan");
  assert.equal(w.calls.run[0].agent, "plan", "syncSessionControls' omitted-agent rule can never flip it");

  const w2 = world({ parent: { agent: "plan" } });
  await startCommandJob(startInput({ agent: "build", model: { providerID: "openai", modelID: "gpt-6-sol", variant: "high" } }), w2.deps);
  assert.equal(w2.calls.create[0].agent, "build");
  assert.deepEqual(w2.calls.create[0].model, { providerID: "openai", modelID: "gpt-6-sol", variant: "high" });
  assert.deepEqual(w2.calls.run[0].model, { providerID: "openai", modelID: "gpt-6-sol", variant: "high" });
});

test("startCommandJob refuses at the cap — same message as startJob — before creating anything", async () => {
  const running = Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => v2Job({ id: `cap0000${i}`, childSessionID: `ses_c${i}` }));
  const w = world({ jobs: running });
  const res = await startCommandJob(startInput(), w.deps);
  assert.deepEqual(res, { ok: false, error: CAP_ERROR });
  assert.equal(w.calls.create.length, 0);
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.run.length, 0);
  assert.equal(w.jobs.length, MAX_RUNNING_JOBS, "no record was added");
});

test("startCommandJob refuses a run from inside a background job's own session (no nesting)", async () => {
  const w = world({ jobs: [v2Job({ childSessionID: PARENT, origin: "delegate" })] });
  const res = await startCommandJob(startInput(), w.deps);
  assert.deepEqual(res, { ok: false, error: "a background job cannot start another background job" });
  assert.equal(w.calls.create.length, 0);
});

test("startCommandJob fails clearly (nothing created) when the parent can't be read or is gone", async () => {
  const w = world();
  w.fail.readSession = netErr();
  const r1 = await startCommandJob(startInput(), w.deps);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Couldn't read this conversation's settings/);
  const w2 = world();
  w2.sessions.delete(PARENT);
  assert.equal((await startCommandJob(startInput(), w2.deps)).ok, false);
  assert.equal(w.calls.create.length + w2.calls.create.length, 0);
});

test("startCommandJob: a definite 4xx on create deletes the record and reports", async () => {
  const w = world();
  w.fail.create = httpErr(400, "opencode createSession 400: bad id");
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /bad id/);
  assert.equal(w.jobs.length, 0);
  assert.equal(w.calls.window.length, 0);
  assert.equal(w.calls.run.length, 0);
});

test("startCommandJob: a definite 4xx on the command deletes the child + window + record and reports", async () => {
  const w = world();
  w.fail.run = httpErr(404, "opencode runCommand 404: no such command");
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /no such command/);
  assert.equal(w.jobs.length, 0, "record deleted");
  assert.equal(w.calls.del.length, 1, "child deleted");
  assert.equal(w.calls.kill.length, 1, "window closed");
});

test("startCommandJob: a window that can't be created rolls back the child and record (nothing was sent)", async () => {
  const w = world();
  w.deps.newWindow = async () => {
    throw new Error("tmux said no");
  };
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, false);
  assert.match(res.error, /tmux said no/);
  assert.equal(w.jobs.length, 0);
  assert.equal(w.calls.del.length, 1);
  assert.equal(w.calls.run.length, 0);
});

// ---------------------------------------------------------------------------
// Uncertain launches are never rolled back
// ---------------------------------------------------------------------------

test("uncertain: a LOST CREATE response keeps the record, marks it uncertain, rolls nothing back, sends nothing", async () => {
  const w = world();
  w.fail.create = netErr();
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, true, "still resolves a job — the card shows the uncertain text");
  assert.equal(res.uncertain, true);
  const job = w.job(res.job.id);
  assert.equal(job.launchState, "uncertain");
  assert.equal(job.status, "running");
  assert.equal(w.calls.del.length, 0, "the child is not deleted");
  assert.equal(w.calls.run.length, 0, "nothing was sent");
  assert.equal(job.submittedAt, null, "never sent");

  // a sweep with the child still unknown to opencode: stays exactly as it is, however often
  for (let i = 0; i < 3; i++) await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).launchState, "uncertain");
  assert.equal(w.job(job.id).status, "running");
  assert.equal(w.calls.create.length, 1, "never a second create");

  // …the create HAD landed: the next sweep sees the child and finishes the launch (one window, one send)
  w.sessions.set(job.childSessionID, { id: job.childSessionID, parentID: PARENT, directory: "/repo", time: {} });
  await reconcileV2Jobs(w.deps);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.run.length, 1, "exactly one send");
  assert.equal(w.job(job.id).launchState, "running");
  assert.ok(w.job(job.id).submittedAt != null);
});

test("uncertain: a LOST COMMAND response keeps record+child+window; reconcile with nothing found changes nothing; admission AFTER that read → running → completes normally", async () => {
  const w = world();
  w.fail.run = httpErr(503, "upstream hiccup");
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.uncertain, true);
  const job = w.job(res.job.id);
  assert.equal(job.launchState, "uncertain");
  assert.equal(w.calls.del.length, 0, "no child deletion");
  assert.equal(w.calls.kill.length, 0, "no window closed");
  assert.equal(w.jobs.length, 1, "record kept");
  const submittedAt = job.submittedAt;
  assert.ok(submittedAt != null);

  // the read finds nothing: still uncertain (and a reconcile after a long time doesn't time it out either)
  w.setNow(T0 + 3 * 60 * 60_000);
  await reconcileV2Jobs(w.deps);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(job.id).launchState, "uncertain");
  assert.equal(w.job(job.id).status, "running", "an uncertain launch is never failed on a clock");

  // …then the request is admitted AFTER that read: the child runs
  w.active.add(job.childSessionID);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).launchState, "running", "evidence of admission");
  assert.equal(w.job(job.id).submittedAt, submittedAt, "submittedAt never rewritten");

  w.say(job.childSessionID, "review done");
  w.finish(job.childSessionID, "succeeded", w.state.now + 5);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).status, "done");
  assert.equal(w.job(job.id).result, "review done");
  assert.equal(w.calls.synth.length, 1, "and it still reports");
});

test("uncertain: the command is still queued in the child's inbox → that is admission evidence → running", async () => {
  const w = world();
  w.fail.run = netErr();
  const res = await startCommandJob(startInput(), w.deps);
  const job = w.job(res.job.id);
  w.inboxes.set(job.childSessionID, [{ id: "msg_x", type: "user" }]);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).launchState, "running");
  assert.equal(w.job(job.id).status, "running");
});

test("uncertain: a grandchild is running under the child → evidence → running, and NOT finished while it runs", async () => {
  const w = world();
  w.fail.run = httpErr(500);
  const res = await startCommandJob(startInput(), w.deps);
  const job = w.job(res.job.id);
  w.sessions.set("ses_gc", { id: "ses_gc", parentID: job.childSessionID, time: {} });
  w.active.add("ses_gc");
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(job.id).launchState, "running");
  assert.equal(w.job(job.id).status, "running");
});

test("uncertain with no evidence stays uncertain on every sweep and is not the cap's problem to clear", async () => {
  const w = world();
  w.fail.run = netErr();
  const res = await startCommandJob(startInput(), w.deps);
  for (let i = 0; i < 5; i++) await reconcileV2Jobs(w.deps);
  assert.equal(w.job(res.job.id).launchState, "uncertain");
});

// ---------------------------------------------------------------------------
// Completion from raw outcomes + the N7 result: exactly once
// ---------------------------------------------------------------------------

test("a finished wrapped run: ONE terminal write holds status + completionMessageId + pending; then exactly one N7 post", async () => {
  const w = world();
  const job = seedWrapped(w);
  w.say(job.childSessionID, "all good");
  w.finish(job.childSessionID, "succeeded", T0 + 10);
  const res = await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "succeeded", at: T0 + 10 } });
  assert.equal(res.settled, true);

  const terminalWrites = w.saves.filter((s) => s.find((j) => j.id === job.id)?.status === "done");
  assert.ok(terminalWrites.length >= 1);
  const first = terminalWrites[0].find((j) => j.id === job.id);
  assert.equal(first.completionMessageId, "msg_fixed", "the persisted id");
  assert.equal(first.completionDelivery, "pending", "pending in the SAME write that made it terminal");
  assert.equal(first.result, "all good");

  assert.equal(w.calls.synth.length, 1);
  const { sid, body } = w.calls.synth[0];
  assert.equal(sid, PARENT);
  assert.equal(body.id, "msg_fixed");
  assert.equal(body.delivery, "queue");
  assert.equal(body.resume, true);
  assert.equal(body.description, "/review HEAD~1");
  assert.deepEqual(body.metadata, {
    source: "subagent",
    childID: "ses_child",
    agent: "build",
    state: "completed",
    manta: { jobId: job.id, name: "/review HEAD~1" },
  });
  assert.match(body.text, /all good/);
  assert.equal(w.job(job.id).completionDelivery, "delivered");

  // re-evaluating a terminal job never posts again
  await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "succeeded", at: T0 + 10 } });
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 1);
});

test("N7 retry after a FAILED post: stays pending, the retry posts the SAME id, then delivered — one record", async () => {
  const w = world();
  const job = seedWrapped(w);
  w.fail.synth = httpErr(503, "busy");
  await finishV2Job(w.job(job.id), "done", null, w.deps);
  assert.equal(w.job(job.id).completionDelivery, "pending");
  assert.equal(w.calls.synth.length, 1);

  w.fail.synth = null;
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 2);
  assert.equal(w.calls.synth[1].body.id, w.calls.synth[0].body.id, "same id → V2 admits it once (U2)");
  assert.equal(w.job(job.id).completionDelivery, "delivered");
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 2, "no third post");
});

test("N7 after a network failure on the post (uncertain) retries with the same id too", async () => {
  const w = world();
  const job = seedWrapped(w);
  w.fail.synth = netErr();
  await finishV2Job(w.job(job.id), "done", null, w.deps);
  w.fail.synth = null;
  // the sweeper tick retries it (the V2 reconcile pass is a no-op for a terminal job)
  await sweepDelegateJobs(w.deps);
  assert.equal(w.calls.synth.length, 2);
  assert.equal(w.calls.synth[0].body.id, w.calls.synth[1].body.id);
  assert.equal(w.job(job.id).completionDelivery, "delivered");
});

test("boot mid-delivery: a terminal record still `pending` on disk is delivered once by the boot reconcile", async () => {
  const w = world({ jobs: [v2Job({ status: "done", finishedAt: T0 + 5, result: "r", completionDelivery: "pending" })] });
  const engine = createDelegateEngine(w.deps);
  await engine.reconcileV2();
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.calls.synth[0].body.id, "msg_fixed");
  assert.equal(w.job("aaaa1111").completionDelivery, "delivered");
  await engine.reconcileV2();
  assert.equal(w.calls.synth.length, 1);
});

test("a 404 from the parent marks the result abandoned (no retry, prunable)", async () => {
  const w = world();
  const job = seedWrapped(w);
  w.fail.synth = httpErr(404, "session not found");
  await finishV2Job(w.job(job.id), "done", null, w.deps);
  assert.equal(w.job(job.id).completionDelivery, "abandoned");
  await retryPendingDeliveries(w.deps);
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 1, "stopped retrying");
});

test("the CTO conversation as parent never gets N7: it keeps promptDelivery", async () => {
  const w = world();
  w.state.cto = true;
  const job = seedWrapped(w);
  await finishV2Job(w.job(job.id), "failed", "boom", w.deps);
  assert.equal(w.calls.synth.length, 0);
  assert.equal(w.calls.deliver.length, 1);
  assert.equal(w.calls.deliver[0].sessionId, PARENT);
  assert.match(w.calls.deliver[0].text, /Error: boom/);
  assert.equal(w.job(job.id).completionDelivery, "delivered");
});

test("completionOwner opencode: Manta NEVER posts a result and never marks anything pending", async () => {
  const w = world();
  const job = seedWrapped(w, { completionOwner: "opencode", origin: "command", submittedAt: null, completionMessageId: null });
  w.say(job.childSessionID, "native done");
  await finishV2Job(w.job(job.id), "done", null, w.deps);
  assert.equal(w.job(job.id).status, "done");
  assert.equal(w.job(job.id).completionDelivery, null);
  assert.equal(w.job(job.id).completionMessageId, null);
  assert.equal(w.calls.synth.length, 0);
  assert.equal(w.calls.deliver.length, 0);
  await retryPendingDeliveries(w.deps);
  assert.equal(w.calls.synth.length, 0);
});

test("stopping an opencode-owned job posts nothing either (opencode reports its own end)", async () => {
  const w = world();
  const job = seedWrapped(w, { completionOwner: "opencode", origin: "subagent", submittedAt: null, completionMessageId: null });
  const res = await stopJob(job.id, w.deps);
  assert.equal(res.ok, true);
  assert.equal(w.job(job.id).status, "stopped");
  assert.equal(w.calls.synth.length + w.calls.deliver.length, 0);
});

test("first terminal transition wins: stop, then a late raw outcome → one stopped result, no second", async () => {
  const w = world();
  const job = seedWrapped(w);
  const stopped = await stopJob(job.id, w.deps);
  assert.equal(stopped.ok, true);
  assert.equal(w.job(job.id).status, "stopped");
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.calls.synth[0].body.metadata.state, "cancelled");
  assert.equal(w.calls.synth[0].body.id, "msg_fixed");
  // the interrupted event that follows the stop
  w.finish(job.childSessionID, "interrupted", T0 + 2);
  const late = await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "interrupted", at: T0 + 2 } });
  assert.notEqual(late.status, "failed");
  assert.equal(w.job(job.id).status, "stopped");
  assert.equal(w.calls.synth.length, 1, "exactly one result");
  assert.ok(w.calls.kill.length === 0, "a no-worktree row keeps its window");
});

test("completion then stop: the stop is a no-op (job not running) and no second result", async () => {
  const w = world();
  const job = seedWrapped(w);
  await finishV2Job(w.job(job.id), "done", null, w.deps);
  const res = await stopJob(job.id, w.deps);
  assert.equal(res.ok, false);
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.job(job.id).status, "done");
});

test("outcomes: succeeded → done, failed → failed with the error, interrupted → failed 'interrupted'", async () => {
  assert.deepEqual(outcomeToTerminal("succeeded"), { status: "done", error: null });
  assert.deepEqual(outcomeToTerminal("failed", { error: "model refused" }), { status: "failed", error: "model refused" });
  assert.deepEqual(outcomeToTerminal("interrupted"), { status: "failed", error: "interrupted" });
  assert.equal(outcomeToTerminal("weird"), null);

  const w = world();
  const job = seedWrapped(w);
  w.finish(job.childSessionID, "failed", T0 + 3);
  await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "failed", error: "rate limited", at: T0 + 3 } });
  assert.equal(w.job(job.id).status, "failed");
  assert.equal(w.job(job.id).error, "rate limited");
  assert.equal(w.calls.synth[0].body.metadata.state, "failed");
});

test("the sweeper's 30-minute timeout runs through the V2 path: failed + ONE pending result", async () => {
  const w = world({ jobs: [v2Job({ startedAt: T0 })] });
  w.sessions.set("ses_child", { id: "ses_child", parentID: PARENT, time: {} });
  w.active.add("ses_child");
  w.setNow(T0 + 31 * 60_000);
  w.deps.sessionExists = async () => true;
  await sweepDelegateJobs(w.deps);
  const j = w.job("aaaa1111");
  assert.equal(j.status, "failed");
  assert.match(j.error, /timed out after 30 minutes/);
  assert.equal(w.calls.synth.length, 1);
  assert.equal(w.calls.synth[0].body.metadata.state, "failed");
});

// ---------------------------------------------------------------------------
// The settle evaluator: reads only, never guesses
// ---------------------------------------------------------------------------

test("settle: an active child is still running; a stale outcome from before submittedAt is not completion", async () => {
  const w = world();
  const job = seedWrapped(w, { submittedAt: T0 + 100 });
  w.active.add(job.childSessionID);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).settled, false);
  w.active.clear();
  w.finish(job.childSessionID, "succeeded", T0 + 50); // before the send
  const r = await settleV2Job(w.job(job.id), w.deps);
  assert.equal(r.settled, false);
  assert.equal(w.job(job.id).status, "running");
});

test("settle: unreadable state (active set or session read fails) leaves the record untouched", async () => {
  const w = world();
  const job = seedWrapped(w);
  w.finish(job.childSessionID, "succeeded", T0 + 5);
  w.deps.listActiveIds = async () => {
    throw netErr();
  };
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "unknown");
  w.deps.listActiveIds = async () => [];
  w.fail.readSession = netErr();
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "unknown");
  assert.equal(w.job(job.id).status, "running");
});

test("settle: a running job whose child session was deleted fails ('no longer exists'); an unsent one does not", async () => {
  const w = world();
  const job = v2Job();
  w.jobs.push(job); // no session in the world → 404
  await settleV2Job(w.job(job.id), w.deps);
  assert.equal(w.job(job.id).status, "failed");
  assert.match(w.job(job.id).error, /no longer exists/);

  const w2 = world({ jobs: [v2Job({ launchState: "uncertain", submittedAt: null })] });
  await settleV2Job(w2.job("aaaa1111"), w2.deps);
  assert.equal(w2.job("aaaa1111").status, "running", "never sent: the child may yet appear");
});

// ---- the nested-children completion predicate -----------------------------

function nested(w, job) {
  // wrapper child W backgrounded itself: a background grandchild G under it
  const W = job.childSessionID;
  w.sessions.set("ses_gc", { id: "ses_gc", parentID: W, time: {} });
  return { W, G: "ses_gc" };
}

test("predicate: a running descendant blocks completion even when the wrapper itself is idle", async () => {
  const w = world();
  const job = seedWrapped(w);
  const { W, G } = nested(w, job);
  w.finish(W, "succeeded", T0 + 10);
  w.active.add(G);
  const r = await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "succeeded", at: T0 + 10 } });
  assert.equal(r.reason, "descendants");
  assert.equal(w.job(job.id).status, "running");
});

test("predicate: the gap between a background grandchild finishing and the wrapper's reply is not completion; the reply is", async () => {
  const w = world();
  const job = seedWrapped(w);
  const { W, G } = nested(w, job);
  // the wrapper's first turn ended (it backgrounded G)
  w.finish(W, "succeeded", T0 + 10);
  w.finish(G, "succeeded", T0 + 20);

  // 1. G finished but its result synthetic is not in W's timeline yet (still in W's inbox)
  w.inboxes.set(W, [{ id: "msg_syn", type: "synthetic" }]);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "descendants");

  // 2. delivered into W's timeline, inbox empty — but W has not replied yet (its outcome predates the synthetic)
  w.inboxes.set(W, []);
  w.timelines.set(W, [{ id: "msg_syn", type: "synthetic", metadata: { source: "subagent", childID: G }, time: { created: T0 + 30 } }]);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "reply-pending");
  assert.equal(w.job(job.id).status, "running");

  // 3. W is running its reply turn
  w.active.add(W);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "active");

  // 4. the reply turn ends AFTER the synthetic → done, result = the wrapper's last assistant text
  w.active.delete(W);
  w.say(W, "wrapper reply");
  w.finish(W, "succeeded", T0 + 40);
  const r = await settleV2Job(w.job(job.id), w.deps, { hint: { outcome: "succeeded", at: T0 + 40 } });
  assert.equal(r.settled, true);
  assert.equal(w.job(job.id).result, "wrapper reply");
  assert.equal(w.calls.synth.length, 1);
});

test("predicate: a background grandchild that itself ran a FOREGROUND subagent needs that tool block completed in the grandchild's timeline", async () => {
  const w = world();
  const job = seedWrapped(w);
  const { W, G } = nested(w, job);
  w.sessions.set("ses_ggc", { id: "ses_ggc", parentID: G, time: {} });
  w.finish(W, "succeeded", T0 + 100);
  w.finish(G, "succeeded", T0 + 50);
  w.finish("ses_ggc", "succeeded", T0 + 40);
  w.timelines.set(W, [{ id: "msg_syn", type: "synthetic", metadata: { childID: G }, time: { created: T0 + 60 } }]);
  const block = (status) => ({ id: "a1", type: "assistant", content: [{ type: "tool", id: "tc", name: "subagent", state: { status, input: {}, metadata: { sessionID: "ses_ggc" } } }] });

  w.timelines.set(G, [block("running")]);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "descendants", "the foreground tool part is still running");

  w.timelines.set(G, [block("completed")]);
  const r = await settleV2Job(w.job(job.id), w.deps);
  assert.equal(r.settled, true, "its result traveled as the tool result");
});

test("predicate: a background descendant without any evidence blocks; an unreadable descendant list is 'unknown', never 'finished'", async () => {
  const w = world();
  const job = seedWrapped(w);
  const { W } = nested(w, job);
  w.finish(W, "succeeded", T0 + 10);
  w.finish("ses_gc", "succeeded", T0 + 5);
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "descendants");
  w.deps.listChildSessions = async () => {
    throw netErr();
  };
  assert.equal((await settleV2Job(w.job(job.id), w.deps)).reason, "unknown");
  assert.equal(w.job(job.id).status, "running");
});

// ---------------------------------------------------------------------------
// The engine: the raw feed
// ---------------------------------------------------------------------------

const rawExec = (type, sessionID, extra = {}) => ({ type, data: { sessionID, ...extra } });

test("engine.observeRaw: a raw execution.succeeded on a wrapped job's child completes it (one result)", async () => {
  const w = world();
  const job = seedWrapped(w);
  const engine = createDelegateEngine(w.deps);
  w.say(job.childSessionID, "ok");
  w.finish(job.childSessionID, "succeeded", T0 + 7);
  await engine.observeRaw(rawExec("session.execution.succeeded", job.childSessionID));
  assert.equal(w.job(job.id).status, "done");
  assert.equal(w.calls.synth.length, 1);
  // the same event twice, overlapping
  await Promise.all([engine.observeRaw(rawExec("session.execution.succeeded", job.childSessionID)), engine.observeRaw(rawExec("session.execution.succeeded", job.childSessionID))]);
  assert.equal(w.calls.synth.length, 1);
});

test("engine.observeRaw: an interrupt is NOT success (the lifecycle adapter would read it as one)", async () => {
  const w = world();
  const job = seedWrapped(w);
  const engine = createDelegateEngine(w.deps);
  w.finish(job.childSessionID, "interrupted", T0 + 7);
  await engine.observeRaw(rawExec("session.execution.interrupted", job.childSessionID));
  assert.equal(w.job(job.id).status, "failed");
  assert.equal(w.job(job.id).error, "interrupted");
});

test("engine: a V2 job is invisible to the legacy lifecycle completion (idle after busy does not finish it)", async () => {
  const w = world();
  const job = seedWrapped(w);
  const engine = createDelegateEngine(w.deps);
  await engine.observeEvent({ type: "session.status", properties: { sessionID: job.childSessionID, status: { type: "busy" } } });
  await engine.observeEvent({ type: "session.idle", properties: { sessionID: job.childSessionID } });
  assert.equal(w.job(job.id).status, "running");
  assert.equal(w.calls.synth.length, 0);
});

test("engine.observeRaw: a nested wrapped run completes only through the tree predicate (descendants indexed from session.created)", async () => {
  const w = world();
  const job = seedWrapped(w);
  const engine = createDelegateEngine(w.deps);
  // the wrapper child announces a grandchild
  w.sessions.set("ses_gc", { id: "ses_gc", parentID: job.childSessionID, time: {} });
  await engine.observeRaw({ type: "session.created", data: { sessionID: "ses_gc", parentID: job.childSessionID } });
  assert.equal(engine._state.treeIndex.get("ses_gc"), job.id);
  assert.equal(engine._state.candidates.size, 0, "a tree member is never a candidate row");
  w.finish(job.childSessionID, "succeeded", T0 + 10);
  w.active.add("ses_gc");
  await engine.observeRaw(rawExec("session.execution.succeeded", job.childSessionID));
  assert.equal(w.job(job.id).status, "running");
  // grandchild ends; its result is delivered; wrapper replies
  w.finish("ses_gc", "succeeded", T0 + 20);
  w.timelines.set(job.childSessionID, [{ id: "msg_s", type: "synthetic", metadata: { childID: "ses_gc" }, time: { created: T0 + 25 } }]);
  w.finish(job.childSessionID, "succeeded", T0 + 30);
  await engine.observeRaw(rawExec("session.execution.succeeded", "ses_gc"));
  assert.equal(w.job(job.id).status, "done");
});

test("engine.observeRaw: an execution start on an uncertain job is evidence → running", async () => {
  const w = world();
  const job = seedWrapped(w, { launchState: "uncertain" });
  const engine = createDelegateEngine(w.deps);
  w.active.add(job.childSessionID);
  await engine.observeRaw(rawExec("session.execution.started", job.childSessionID));
  assert.equal(w.job(job.id).launchState, "running");
});

test("lifecycle map: remembers the latest raw outcome, expires after 10 minutes, caps its size", () => {
  let now = 1000;
  const m = createLifecycleMap({ now: () => now, ttlMs: 600_000, max: 3 });
  m.record("a", { outcome: "succeeded" });
  assert.equal(m.get("a").outcome, "succeeded");
  now += 599_000;
  assert.ok(m.get("a"));
  now += 2_000;
  assert.equal(m.get("a"), null, "expired");
  for (const s of ["b", "c", "d", "e"]) m.record(s, { outcome: "failed", error: "x" });
  assert.equal(m.size(), 3);
  assert.equal(m.get("b"), null, "oldest evicted");
  assert.equal(m.get("e").error, "x");
});

// ---------------------------------------------------------------------------
// V2-native background commands: provisional adoption
// ---------------------------------------------------------------------------

function engineWithTimers(w) {
  const timers = [];
  w.deps.setTimer = (fn, ms) => {
    const h = { fn, ms, cleared: false };
    timers.push(h);
    return h;
  };
  w.deps.clearTimer = (h) => {
    h.cleared = true;
  };
  const engine = createDelegateEngine(w.deps);
  const fire = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) await t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { engine, timers, fire };
}

const created = (child, parent = PARENT) => ({ type: "session.created", data: { sessionID: child, parentID: parent } });

test("provisional adoption: an unclaimed child born in a command window is adopted 2 s after the window closes (origin command, opencode-owned, window's name)", async () => {
  const w = world();
  w.state.openWindows = [{ name: "review", arguments: "HEAD~1" }];
  const { engine, timers, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_nat"));
  assert.equal(engine._state.candidates.size, 1);
  assert.equal(w.jobs.length, 0, "held: no row yet");

  // the window closes → grace timer of exactly 2 s
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  await fire();

  assert.equal(w.jobs.length, 1);
  const j = w.jobs[0];
  assert.equal(j.origin, "command");
  assert.equal(j.completionOwner, "opencode");
  assert.equal(j.engine, "v2");
  assert.equal(j.name, "/review HEAD~1");
  assert.equal(j.childSessionID, "ses_nat");
  assert.equal(j.worktree, null);
  assert.equal(w.calls.window[0].existingSessionId, "ses_nat");
  assert.equal(w.calls.synth.length, 0, "Manta posts nothing for it");
});

test("provisional adoption: overlapping command windows → the row is named 'Background command'", async () => {
  const w = world();
  w.state.openWindows = [{ name: "a", arguments: "" }, { name: "b", arguments: "x" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_nat"));
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  assert.equal(w.jobs[0].name, "Background command");
});

test("provisional adoption: a FOREGROUND task claim drops the candidate (inline only, never a row)", async () => {
  const w = world();
  w.state.openWindows = [{ name: "review", arguments: "" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_fg"));
  await engine.observeEvent({
    type: "message.part.updated",
    properties: { sessionID: PARENT, part: { id: "p", type: "tool", tool: "task", state: { status: "running", input: { description: "d", prompt: "p" }, metadata: { sessionId: "ses_fg", background: false } } } },
  });
  assert.equal(engine._state.candidates.size, 0);
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  assert.equal(w.jobs.length, 0, "no row for a foreground subagent");
});

test("provisional adoption: a BACKGROUND task claim leaves adoption to the existing subagent path (origin subagent, one row)", async () => {
  const w = world();
  w.state.openWindows = [{ name: "review", arguments: "" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_bg"));
  await engine.observeEvent({
    type: "message.part.updated",
    properties: { sessionID: PARENT, part: { id: "p", type: "tool", tool: "task", state: { status: "running", input: { description: "explore", prompt: "p", background: true }, metadata: { sessionId: "ses_bg", background: true } } } },
  });
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].origin, "subagent");
  assert.equal(w.jobs[0].completionOwner, "opencode");
});

test("provisional adoption: a claim that arrives BEFORE the child's creation event is remembered", async () => {
  const w = world();
  w.state.openWindows = [{ name: "review", arguments: "" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeEvent({
    type: "message.part.updated",
    properties: { sessionID: PARENT, part: { id: "p", type: "tool", tool: "task", state: { status: "running", input: { description: "d", prompt: "p" }, metadata: { sessionId: "ses_early", background: false } } } },
  });
  await engine.observeRaw(created("ses_early"));
  assert.equal(engine._state.candidates.size, 0);
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  assert.equal(w.jobs.length, 0);
});

test("provisional adoption: no open command window → not a candidate; a Manta job's own child is never one", async () => {
  const w = world();
  const { engine } = engineWithTimers(w);
  await engine.observeRaw(created("ses_plain"));
  assert.equal(engine._state.candidates.size, 0);

  w.state.openWindows = [{ name: "review", arguments: "" }];
  const job = seedWrapped(w); // Manta created ses_child; its created event arrives while a window is open on the parent
  await engine.observeRaw(created(job.childSessionID));
  assert.equal(engine._state.candidates.size, 0);
  // a child born inside a job's own session
  await engine.observeRaw(created("ses_inside", job.childSessionID));
  assert.equal(engine._state.candidates.size, 0);
});

test("no lost lifecycle: a child that finished BEFORE it was adopted is recorded finished at once (no result posted)", async () => {
  const w = world();
  w.state.openWindows = [{ name: "quick", arguments: "" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_fast"));
  // it finishes in well under a second — before any adoption
  await engine.observeRaw(rawExec("session.execution.succeeded", "ses_fast"));
  w.say("ses_fast", "fast result");
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  const j = w.jobs.find((x) => x.childSessionID === "ses_fast");
  assert.ok(j);
  assert.equal(j.status, "done", "recorded finished immediately");
  assert.equal(j.result, "fast result");
  assert.equal(j.completionDelivery, null);
  assert.equal(w.calls.synth.length, 0);
});

test("no lost lifecycle: the existing task-subagent adoption reads the map too", async () => {
  const w = world();
  const lifecycleGet = (sid) => (sid === "ses_sub" ? { outcome: "failed", error: "oops", at: T0 } : null);
  const res = await adoptSubagentJob({ parentSessionID: PARENT, parentDirectory: "/repo", childSessionID: "ses_sub", name: "explore", prompt: "p" }, { ...w.deps, lifecycleGet });
  assert.equal(res.ok, true);
  const j = w.jobs.find((x) => x.childSessionID === "ses_sub");
  assert.equal(j.status, "failed");
  assert.equal(j.error, "oops");
  assert.equal(j.origin, "subagent");
  assert.equal(j.completionOwner, "opencode");
});

test("an adopted native-command row completes from the raw outcome (still no Manta result) and the row stays", async () => {
  const w = world();
  w.state.openWindows = [{ name: "bg", arguments: "" }];
  const { engine, fire } = engineWithTimers(w);
  await engine.observeRaw(created("ses_nat"));
  w.state.openWindows = [];
  engine.windowClosed({ sessionId: PARENT });
  await fire();
  w.sessions.set("ses_nat", { id: "ses_nat", parentID: PARENT, time: {} });
  w.say("ses_nat", "native done");
  w.finish("ses_nat", "succeeded", T0 + 9);
  await engine.observeRaw(rawExec("session.execution.succeeded", "ses_nat"));
  const j = w.jobs.find((x) => x.childSessionID === "ses_nat");
  assert.equal(j.status, "done");
  assert.equal(w.calls.synth.length + w.calls.deliver.length, 0);
  assert.equal(w.calls.kill.length, 0, "the window stays after finishing");
  assert.ok(j.windowIndex != null);
});

// ---------------------------------------------------------------------------
// Finished rows stay; retention; closing; pause
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60_000;

function finishedRow(i, over = {}) {
  return v2Job({
    id: `f${String(i).padStart(7, "0")}`,
    childSessionID: `ses_f${i}`,
    windowIndex: 10 + i,
    status: "done",
    finishedAt: T0 + i,
    completionDelivery: "delivered",
    ...over,
  });
}

test("retention: a finished no-worktree row stays until 7 days; the prune closes its window FIRST, then deletes the record", async () => {
  const w = world({ jobs: [finishedRow(1)] });
  w.windows.push({ index: 11, opencodeSessionId: "ses_f1" });
  w.setNow(T0 + 6 * DAY);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 1, "still there at 6 days");
  assert.equal(w.calls.kill.length, 0);

  w.setNow(T0 + 8 * DAY);
  const order = [];
  const kill = w.deps.killWindow;
  w.deps.killWindow = async (i) => {
    order.push(["kill", w.jobs.length]);
    return kill(i);
  };
  await sweepDelegateJobs(w.deps);
  assert.deepEqual(order, [["kill", 1]], "the window was closed while the record still existed");
  assert.equal(w.jobs.length, 0);
  assert.equal(w.calls.kill[0].windowIndex, 11);
});

test("retention: a record whose window index now belongs to a DIFFERENT window never closes that window", async () => {
  const w = world({ jobs: [finishedRow(1)] });
  w.windows.push({ index: 11, opencodeSessionId: "ses_someone_else" });
  w.setNow(T0 + 8 * DAY);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 0, "the record is still pruned");
  assert.equal(w.calls.kill.length, 0, "but a reused index is left alone");
});

test("retention: never prunes a record whose result is still pending, by age or by count", async () => {
  // (the parent is unreachable, so the sweep's own retry cannot deliver it)
  const w = world({ jobs: [finishedRow(1, { completionDelivery: "pending" })] });
  w.fail.synth = httpErr(503);
  w.setNow(T0 + 30 * DAY);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 1);
  // …and past 50 records the pending one is skipped, the oldest deliverable goes
  const many = Array.from({ length: 52 }, (_, i) => finishedRow(i + 2, { finishedAt: T0 + 30 * DAY - 1000 + i }));
  const w2 = world({ jobs: [finishedRow(1, { completionDelivery: "pending", finishedAt: T0 }), ...many] });
  w2.fail.synth = httpErr(503);
  w2.setNow(T0 + 30 * DAY);
  await sweepDelegateJobs(w2.deps);
  assert.ok(w2.jobs.some((j) => j.id === "f0000001"), "pending survives");
  assert.equal(w2.jobs.filter((j) => j.status === "done").length, 50);
  assert.equal(w2.jobs.filter((j) => j.id !== "f0000001").length, 49, "the oldest deliverable rows went");
});

test("retention (count): beyond 50 finished rows the oldest are pruned with their windows closed", async () => {
  const rows = Array.from({ length: 53 }, (_, i) => finishedRow(i + 1, { finishedAt: T0 + 1 + i }));
  const w = world({ jobs: rows });
  for (const r of rows) w.windows.push({ index: r.windowIndex, opencodeSessionId: r.childSessionID });
  w.setNow(T0 + 1000);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 50);
  assert.deepEqual(w.calls.kill.map((k) => k.windowIndex).sort((a, b) => a - b), [11, 12, 13]);
});

test("retention: a worktree job keeps today's behaviour — its record is pruned without the V2 window rule", async () => {
  const job = v2Job({ id: "wt000001", engine: undefined, completionOwner: undefined, worktree: "/repo/wt", branch: "b", status: "done", finishedAt: T0, cleanedUp: true, windowIndex: 12 });
  const w = world({ jobs: [job] });
  w.setNow(T0 + 8 * DAY);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.jobs.length, 0);
  assert.equal(w.calls.kill.length, 0, "cleanup already removed it when the job ended");
});

test("closing a row: finished + delivered → window and record go; running / uncertain / pending → window only, record stays", async () => {
  const w = world({
    jobs: [
      finishedRow(1),
      v2Job({ id: "run00001", childSessionID: "ses_r", windowIndex: 31 }),
      finishedRow(2, { completionDelivery: "pending" }),
      v2Job({ id: "unc00001", childSessionID: "ses_u", windowIndex: 32, launchState: "uncertain" }),
    ],
  });
  for (const j of [...w.jobs]) w.windows.push({ index: j.windowIndex, opencodeSessionId: j.childSessionID });

  assert.deepEqual(await deleteJob("f0000001", w.deps), { ok: true });
  assert.equal(w.job("f0000001"), undefined);

  for (const id of ["run00001", "f0000002", "unc00001"]) {
    const r = await deleteJob(id, w.deps);
    assert.equal(r.retained, true, id);
    assert.ok(w.job(id), `${id} record stays`);
    assert.equal(w.job(id).windowIndex, null);
  }
  assert.equal(w.calls.kill.length, 4);
});

test("pause is not offered for a command or opencode-owned row", async () => {
  const w = world({ jobs: [v2Job(), v2Job({ id: "sub00001", origin: "subagent", completionOwner: "opencode", childSessionID: "ses_s" })] });
  assert.equal((await pauseJob("aaaa1111", w.deps)).ok, false);
  assert.equal((await pauseJob("sub00001", w.deps)).ok, false);
  assert.equal(w.job("aaaa1111").pauseRequested, undefined);
});

test("legacy boot reconcile never parks a V2 job as paused", async () => {
  const w = world({ jobs: [v2Job()] });
  w.deps.sessionExists = async () => false;
  const r = await reconcileJobsOnBoot(w.deps);
  assert.equal(r.reconciled, 0);
  assert.equal(w.job("aaaa1111").status, "running");
});

// ---------------------------------------------------------------------------
// open-session
// ---------------------------------------------------------------------------

test("openJobSession: returns the existing window; re-creates a closed one stamped with the child id; reports a vanished session", async () => {
  const w = world({ jobs: [v2Job({ windowIndex: 31 })] });
  w.sessions.set("ses_child", { id: "ses_child", parentID: PARENT, time: {} });
  w.windows.push({ index: 40, opencodeSessionId: "ses_child" }); // it moved
  const r1 = await openJobSession("aaaa1111", w.deps);
  assert.deepEqual(r1, { ok: true, tmuxSession: "proj", windowIndex: 40 });
  assert.equal(w.job("aaaa1111").windowIndex, 40, "the record follows the window");
  assert.equal(w.calls.window.length, 0);

  w.windows.splice(w.windows.findIndex((x) => x.index === 40), 1); // closed
  const r2 = await openJobSession("aaaa1111", w.deps);
  assert.equal(r2.ok, true);
  assert.equal(w.calls.window.length, 1);
  assert.equal(w.calls.window[0].existingSessionId, "ses_child");
  assert.equal(w.calls.window[0].chatMode, true);
  assert.equal(w.job("aaaa1111").windowIndex, r2.windowIndex);

  w.sessions.delete("ses_child");
  const r3 = await openJobSession("aaaa1111", w.deps);
  assert.deepEqual(r3, { ok: false, error: "The session no longer exists" });

  assert.equal((await openJobSession("nope", w.deps)).ok, false);
  w.sessions.set("ses_child", { id: "ses_child" });
  w.fail.readSession = netErr();
  const r4 = await openJobSession("aaaa1111", w.deps);
  assert.equal(r4.ok, false);
  assert.match(r4.error, /Couldn't reach opencode/);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("helpers: display name, owner defaults, minted ids, the N7 body is a pure function of the record", () => {
  assert.equal(commandDisplayName("review", " HEAD~1 "), "/review HEAD~1");
  assert.equal(commandDisplayName("compact", ""), "/compact");
  assert.equal(completionOwnerOf({ origin: "subagent" }), "opencode");
  assert.equal(completionOwnerOf({ origin: "delegate" }), "manta");
  assert.equal(completionOwnerOf({ origin: "subagent", completionOwner: "manta" }), "manta");
  assert.match(mintSessionId(), /^ses_[0-9a-f]{32}$/);
  const job = v2Job({ status: "failed", error: "x", agent: null });
  assert.deepEqual(buildResultSynthetic(job), buildResultSynthetic({ ...job }));
  assert.equal(buildResultSynthetic(job).metadata.state, "failed");
  assert.equal(buildResultSynthetic({ ...job, status: "stopped" }).metadata.state, "cancelled");
  assert.equal(buildResultSynthetic(job).metadata.agent, null);
});

test("deliverJobResult: concurrent callers post once (in-flight guard) and a non-pending record posts nothing", async () => {
  const w = world();
  const job = seedWrapped(w, { status: "done", finishedAt: T0, completionDelivery: "pending" });
  let release;
  const gate = new Promise((r) => (release = r));
  const post = w.deps.postSynthetic;
  w.deps.postSynthetic = async (...a) => {
    await gate;
    return post(...a);
  };
  const p1 = deliverJobResult(job.id, w.deps);
  const p2 = deliverJobResult(job.id, w.deps);
  release();
  await Promise.all([p1, p2]);
  assert.equal(w.calls.synth.length, 1);
  assert.equal((await deliverJobResult(job.id, w.deps)).skipped, "not-pending");
});

test("observeEvent still adopts a background task subagent into the new V2 shape (existing behaviour, new fields)", async () => {
  const w = world();
  await observeEvent(
    { type: "message.part.updated", properties: { sessionID: PARENT, part: { id: "p", type: "tool", tool: "task", state: { status: "running", input: { description: "go", prompt: "go", background: true }, metadata: { sessionId: "ses_sub", background: true } } } } },
    w.deps,
    new Map(),
  );
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].origin, "subagent");
  assert.equal(w.jobs[0].engine, "v2");
  assert.equal(w.jobs[0].completionOwner, "opencode");
  assert.equal(w.jobs[0].worktree, null);
});

// ---------------------------------------------------------------------------
// A launch cut off by a restart is uncertain; one this process is running is left alone
// ---------------------------------------------------------------------------

test("a record left mid-launch by a restart becomes `uncertain` on reconcile — and is then never timed out", async () => {
  const w = world();
  const sent = seedWrapped(w, { id: "cut00001", launchState: "submitting", submittedAt: T0 });
  const unsent = v2Job({ id: "cut00002", childSessionID: "ses_c2", launchState: "creating", submittedAt: null, windowIndex: null });
  w.jobs.push(unsent);
  await reconcileV2Jobs(w.deps);
  assert.equal(w.job(sent.id).launchState, "uncertain");
  assert.equal(w.job(unsent.id).launchState, "uncertain");
  w.setNow(T0 + 40 * 60_000);
  w.deps.sessionExists = async () => true;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(sent.id).status, "running", "no guessed failure on a clock");
  assert.equal(w.job(unsent.id).status, "running");
  assert.equal(w.calls.synth.length, 0);
});

test("a launch THIS process is running is not touched by a concurrent reconcile", async () => {
  const w = world();
  let release;
  const gate = new Promise((r) => (release = r));
  const create = w.deps.createChildSession;
  w.deps.createChildSession = async (i) => {
    await gate;
    return create(i);
  };
  const started = startCommandJob(startInput(), w.deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].launchState, "creating");
  await reconcileV2Jobs(w.deps);
  assert.equal(w.jobs[0].launchState, "creating", "still its launch's to settle");
  release();
  const res = await started;
  assert.equal(res.ok, true);
  assert.equal(w.job(res.job.id).launchState, "running");
});

test("a run that finishes before its send's response is recorded still ends with launchState `running`", async () => {
  const w = world();
  const engine = createDelegateEngine(w.deps);
  const run = w.deps.runCommandOnChild;
  w.deps.runCommandOnChild = async (i) => {
    await run(i);
    // the child finishes and its raw outcome is handled while the POST is still "in flight"
    w.say(i.sessionId, "fast");
    w.finish(i.sessionId, "succeeded", w.state.now + 1);
    await engine.observeRaw(rawExec("session.execution.succeeded", i.sessionId));
  };
  const res = await startCommandJob(startInput(), w.deps);
  assert.equal(res.ok, true);
  const j = w.job(res.job.id);
  assert.equal(j.status, "done");
  assert.equal(j.launchState, "running");
  assert.equal(w.calls.synth.length, 1);
});
