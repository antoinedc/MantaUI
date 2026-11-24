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
  extendJob,
  continueJob,
  loadJobsStrict,
  ADMIT_STORE_ERROR,
  WORKTREE_AGENT_GRANTS,
  buildWorktreeAgentRuleset,
  normalizeJobRuleset,
  buildJobPrompt,
  buildReadOnlyAgentRuleset,
  buildArchitectRuleset,
  withResearchToolAllows,
  listJobs,
  MAX_RUNNING_JOBS,
  CAP_ERROR,
} from "./delegate.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createJobLiveness } from "./jobLiveness.mjs";
import { MODES } from "../shared/autonomyShared.mjs";
import { jobRules, policyKey, normalizePolicy, effectivePolicy, taskPromptSection, taskFooter, CODE_OFF, POLICY_CHANGED, LEGACY_TASK, MANTA_FOLDER, SETTINGS_UNREADABLE } from "./autonomy.mjs";
import { buildResultSynthetic } from "./delegate.mjs";
import { MAX_ENTRIES_ERROR, projectPatterns, validateEntry } from "./projectActions.mjs";
import { createJobViews } from "./jobViews.mjs";
import { askUserLines, ASK_USER_HEADER } from "./askUser.mjs";

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
    getWindowOption: async () => "job", // seeded and launched holders model job ownership
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
    setMessages(sid, list) {
      messages.set(sid, list);
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
  assert.deepEqual(c.permission, [...job.permission, { permission: "question", pattern: "*", action: "deny" }], "the preflight ruleset, catch-all deny first, a question deny last (a job cannot wait on a person)");
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

// ---- agent jobs (agents phase 1): `agent`, `isolation`, `agentName`, `request` ----

const READ_ONLY_KEYS = ["read", "glob", "grep", "list", "webfetch", "websearch", "todowrite", "progress_report", "external_directory", "research_fetch", "research_read", "research_search", "research_library_find", "research_library_save", "ask_user"];

test("agent job, isolation none: no worktree, no move, the agent reaches create AND send, a read-only ruleset, no commit advice", async () => {
  const w = world();
  const id = await start(w, {
    agent: "agent-scout",
    isolation: "none",
    agentDir: "/home/x/.manta/agents/scout",
    agentName: "Scout",
    request: "@scout what does the parser do?",
  });
  const job = w.job(id);
  assert.deepEqual(w.calls.addWorktree, [], "no worktree is even attempted");
  assert.deepEqual(w.calls.move, [], "created at the parent's folder, never moved");
  assert.equal(job.worktree, null);
  assert.equal(job.executionDirectory, REPO);
  assert.equal(w.calls.window[0].cwd, REPO);
  assert.equal(w.calls.window[0].worktreePath, undefined);
  assert.equal(w.calls.create[0].agent, "agent-scout");
  assert.equal(w.calls.send[0].agent, "agent-scout");
  assert.equal(job.agent, "agent-scout");
  assert.equal(job.agentName, "Scout");
  assert.equal(job.request, "@scout what does the parser do?");

  const rules = w.calls.create[0].permission;
  assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" }, "deny by default, FIRST (last match wins)");
  assert.deepEqual(rules.at(-1), { permission: "question", pattern: "*", action: "deny" });
  const allowed = rules.filter((r) => r.action === "allow").map((r) => r.permission);
  assert.deepEqual([...new Set(allowed)].sort(), [...READ_ONLY_KEYS].sort());
  assert.ok(!allowed.includes("bash") && !allowed.includes("edit"), "no bash, no edit");
  assert.ok(rules.some((r) => r.permission === "external_directory" && r.pattern === "/home/x/.manta/agents/scout/**" && r.action === "allow"));

  const text = w.calls.send[0].text;
  assert.doesNotMatch(text, /Commit your work/);
  assert.doesNotMatch(text, /isolated git worktree/);
  assert.match(text, /cannot edit files or run commands/);
  assert.match(text, /progress_report/);
});

test("agent job, isolation worktree: fails closed with no repository (nothing created), otherwise a worktree, the agent and an editing ruleset", async () => {
  const none = world({ git: false });
  const res = await startJob(input({ agent: "agent-dev", isolation: "worktree" }), none.deps);
  assert.equal(res.ok, false);
  assert.equal(res.code, "worktree_failed");
  assert.deepEqual([none.calls.create, none.calls.move, none.calls.window, none.calls.send].map((c) => c.length), [0, 0, 0, 0]);
  assert.equal(none.jobs.length, 0);

  const w = world();
  const id = await start(w, { agent: "agent-dev", isolation: "worktree", agentName: "Dev", request: "fix it" });
  const job = w.job(id);
  assert.equal(job.worktree, WT);
  assert.equal(w.calls.create[0].agent, "agent-dev");
  assert.deepEqual(w.calls.move, [{ sid: job.childSessionID, directory: WT }]);
  const rules = w.calls.create[0].permission;
  assert.equal(rules[0].action, "deny");
  assert.ok(rules.some((r) => r.permission === "bash" && r.action === "allow"));
  assert.ok(rules.some((r) => r.permission === "edit" && r.action === "allow"));
  assert.ok(rules.some((r) => r.permission === "progress_report" && r.action === "allow"));
  assert.match(w.calls.send[0].text, /Commit your work as you go/);
  assert.match(w.calls.send[0].text, new RegExp(`isolated git worktree at ${WT}`));
});

test("agent job: a caller-supplied permission ruleset wins; plain jobs are unchanged (build agent, no agentName / request)", async () => {
  const w = world();
  const custom = [{ permission: "*", pattern: "**", action: "deny" }, { permission: "read", pattern: "**", action: "allow" }];
  await start(w, { agent: "agent-x", isolation: "none", permission: custom });
  assert.deepEqual(w.calls.create[0].permission, [...custom, { permission: "question", pattern: "*", action: "deny" }]);

  const plain = world();
  const id = await start(plain);
  const job = plain.job(id);
  assert.equal(job.agent, "build");
  assert.ok(!("agentName" in job) && !("request" in job));
  assert.match(plain.calls.send[0].text, /Commit your work as you go/);
});

test("agent job: agentName and request reach the client through listJobs", async () => {
  const w = world();
  await start(w, { agent: "agent-scout", isolation: "none", agentName: "Scout", request: "look into X" });
  const [row] = await listJobs({ sessionID: PARENT }, { load: w.deps.load, readProgress: async () => null });
  assert.equal(row.agentName, "Scout");
  assert.equal(row.request, "look into X");
  assert.equal(row.agent, "agent-scout");
});

test("buildReadOnlyAgentRuleset: no agent folder grant without agentDir; the folder grant is a glob under it", () => {
  const bare = buildReadOnlyAgentRuleset({ home: "/h" });
  assert.ok(!bare.some((r) => r.permission === "external_directory" && r.pattern.includes(".manta")));
  assert.ok(bare.some((r) => r.permission === "external_directory" && r.pattern === "/h/.local/share/opencode/tool-output/*"));
  const withDir = buildReadOnlyAgentRuleset({ home: "/h", agentDir: "/h/.manta/agents/a/" });
  assert.deepEqual(withDir.at(-1), { permission: "external_directory", pattern: "/h/.manta/agents/a/**", action: "allow" });
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
  assert.equal(w.job(id).error, "reached its time limit of 1 minute");
  assert.equal(w.job(id).endReason, "time-limit");
  assert.deepEqual(w.calls.abort, [child], "the timeout interrupts the child");
  oneResult(w, id, "failed");
  // the child's own late outcome, and further sweeps
  w.finish(child, "interrupted", T0 + 2 * 60_000);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.interrupted", child));
  await sweepDelegateJobs(w.deps);
  oneResult(w, id, "failed");
});

test("C1 exactly one result — the default ceiling is 4 hours", async () => {
  const w = world();
  const id = await start(w);
  w.state.now = T0 + 31 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running", "the old 30-minute timeout is gone");
  w.state.now = T0 + 4 * 60 * 60_000 + 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).error, "reached its time limit of 4 hours");
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
  assert.deepEqual(w.calls.create[0].permission, [...job.permission, { permission: "question", pattern: "*", action: "deny" }]);
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
  assert.equal(w.job(id).status, "running", "the default ceiling does not apply");
  w.state.now = T0 + 91 * 60_000;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "failed");
  assert.equal(w.job(id).error, "reached its time limit of 1 hour 30 minutes");
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
  assert.deepEqual(w.calls.create[1].permission, [...ctoInput().permission, { permission: "question", pattern: "*", action: "deny" }], "the resumed child is scoped exactly like the first");
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

// ---------------------------------------------------------------------------
// Liveness, ceiling, progress (spec 2026-11-14)
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A world whose engine state (liveness + views) the module-level sweep reads. `engine.observeActivity` feeds it. */
function liveWorld(opts) {
  const w = world(opts);
  w.published = [];
  w.deps.publish = (e) => w.published.push(e);
  w.deps.liveness = createJobLiveness({ now: () => w.state.now });
  w.deps.jobViews = createJobViews({ now: () => w.state.now, epoch: 5, liveness: w.deps.liveness, publish: (e) => w.published.push(e), load: w.deps.load });
  w.deps.listTailMessages = async () => [];
  // (created on first use, so a test's own dep overrides are in the engine's copy of the deps)
  let engine = null;
  Object.defineProperty(w, "engine", { get: () => (engine ??= createDelegateEngine(w.deps)) });
  w.tap = (type, minutesAfterStart, extra = {}) => {
    const job = w.jobs.find((j) => j.status === "running");
    w.engine.observeActivity({ type, sessionId: job.childSessionID, at: T0 + minutesAfterStart * MIN, ...extra });
  };
  w.rebuilt = (id) => w.deps.liveness.applyReconstruction(id, w.deps.liveness.get(id).generation, {});
  return w;
}

test("liveness: a launched job is born with the ceiling, extension and progress fields; its child can never ask a question", async () => {
  const w = liveWorld();
  const id = await start(w);
  const j = w.job(id);
  assert.equal(j.ceilingMs, 4 * HOUR);
  assert.equal(j.baseCeilingMs, 4 * HOUR);
  assert.deepEqual(j.extensions, []);
  assert.equal(j.endReason, null);
  assert.equal(j.endedBlocked, false);
  assert.equal(j.jobProgress.planRevision, 0);
  assert.deepEqual(j.jobProgress.usage, { tokens: 0, costUsd: null, costPartial: false });
  assert.deepEqual(w.calls.create[0].permission.at(-1), { permission: "question", pattern: "*", action: "deny" });
  assert.match(j.launch.text, /Time: this job is stopped after 4 hours of work \(and earlier if it makes no\nprogress for 15 minutes\)\. Commit your work as you go so nothing is lost if it\nis stopped\./);
  assert.ok(j.launch.text.includes('call progress_report with state "blocked" and a label saying what you need, then\nend your turn with the question.'));
  assert.ok(w.deps.liveness.ownsSession(j.childSessionID), "the backstop knows the job's session from the start");
});

test("liveness: maxDurationMinutes sets the ceiling (and the prompt's wording); an invalid one refuses the job; the CTO's allowance is a ceiling too", async () => {
  const w = liveWorld();
  const id = await start(w, { maxDurationMinutes: 150 });
  assert.equal(w.job(id).ceilingMs, 150 * MIN);
  assert.match(w.job(id).launch.text, /stopped after 2 hours 30 minutes of work/);
  for (const bad of [9, 721, 30.5]) {
    const res = await startJob(input({ maxDurationMinutes: bad }), w.deps);
    assert.deepEqual(res, { ok: false, error: "maxDurationMinutes must be an integer between 10 and 720" });
  }
  assert.equal(w.jobs.length, 1, "nothing was started for the invalid ones");
  const w2 = liveWorld();
  const id2 = await start(w2, { sweepAllowanceMs: 90 * MIN });
  assert.equal(w2.job(id2).ceilingMs, 90 * MIN);
});

test("stall: 16 minutes of silence ends a launched job — failed / stalled with the last headline, ONE result, the child interrupted", async () => {
  const w = liveWorld();
  const id = await start(w, { name: "fix the bug" });
  const child = w.job(id).childSessionID;
  w.rebuilt(id);
  w.tap("content", 1);
  w.state.now = T0 + 16 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running", "15 minutes after the last record is not yet stalled");
  w.state.now = T0 + 17 * MIN;
  await sweepDelegateJobs(w.deps);
  const j = w.job(id);
  assert.equal(j.status, "failed");
  assert.equal(j.endReason, "stalled");
  assert.equal(j.error, "stalled — no progress for 15 minutes");
  assert.deepEqual(w.calls.abort, [child]);
  oneResult(w, id, "failed");
  assert.match(w.calls.synth[0].body.text, /^Reason: stalled — no progress for 15 minutes$/m);
  assert.equal(w.deps.liveness.get(id), null, "the live picture is gone with the run");
});

test("stall: a job that keeps producing records stays alive; a model label becomes the stall's `last:` text", async () => {
  const w = liveWorld();
  const id = await start(w);
  w.rebuilt(id);
  for (let m = 5; m <= 60; m += 5) w.tap("content", m);
  w.state.now = T0 + 70 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running");
  await w.engine.reportJobProgress({ sessionID: w.job(id).childSessionID, input: { label: "running the parser tests" }, record: { state: "working" } });
  w.state.now = T0 + 90 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).error, "stalled — no progress for 15 minutes (last: running the parser tests)");
});

test("stall: after a restart (live state not rebuilt) a job is never judged; the sweep rebuilds it from reads, then the rules apply", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.deps.liveness.resetAll(w.jobs); // a boot / reconnect
  w.state.now = T0 + 40 * MIN;
  let reads = 0;
  w.deps.listTailMessages = async (sid) => {
    reads++;
    return [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "toolu_1", state: { status: "running", input: { command: "make all\nmore", timeout: 3_600_000 }, time: { start: T0 + 30 * MIN } } }] }];
  };
  w.state.now = T0 + 41 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.ok(reads >= 1);
  const live = w.deps.liveness.get(id);
  assert.ok(live.reconstructedAt != null);
  assert.equal(live.tools.get("toolu_1").target, "make all");
  assert.equal(live.tools.get("toolu_1").startedAt, T0 + 30 * MIN, "the transcript's start time");
  assert.equal(w.job(id).status, "running", "its shell is within its own timeout");
  w.state.now = T0 + 30 * MIN + 66 * MIN; // past start + timeout + 5 min
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "failed");
  assert.equal(w.job(id).error, 'stalled — "make all" ran past its own timeout');
  assert.deepEqual(w.calls.abort, [child]);
});

test("stall: a failed reconstruction read is retried next sweep and never ends the job meanwhile", async () => {
  const w = liveWorld();
  const id = await start(w);
  w.state.now = T0 + 100 * MIN;
  w.deps.liveness.resetAll(w.jobs); // a reconnect: the stall clock starts from here
  w.deps.listTailMessages = async () => {
    throw netErr();
  };
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running");
  assert.equal(w.deps.liveness.get(id).reconstructedAt, null);
  w.deps.listTailMessages = async () => [];
  w.state.now = T0 + 101 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.ok(w.deps.liveness.get(id).reconstructedAt != null);
  assert.equal(w.job(id).status, "running");
});

test("stall: a job with a handoff pending is not judged under it; once the handoff is gone it is", async () => {
  const w = liveWorld();
  const id = await start(w);
  w.rebuilt(id);
  w.state.now = T0 + 40 * MIN;
  w.deps.deferSettlement = () => true;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running", "handoff pending");
  w.deps.deferSettlement = () => false;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "failed");
});

test("ceiling: a job that keeps working runs for hours and is ended at its 4 hour ceiling with time-limit", async () => {
  const w = liveWorld();
  const id = await start(w);
  w.rebuilt(id);
  for (let m = 2; m <= 180; m += 2) w.tap("content", m);
  w.state.now = T0 + 3 * HOUR;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running");
  w.tap("content", 241);
  w.state.now = T0 + 4 * HOUR + MIN;
  await sweepDelegateJobs(w.deps);
  const j = w.job(id);
  assert.equal(j.status, "failed");
  assert.equal(j.endReason, "time-limit");
  assert.equal(j.error, "reached its time limit of 4 hours");
  oneResult(w, id, "failed");
});

test("ceiling: the guard re-checks the LIVE record under the lock — a snapshot taken before an extension can't end the job", async () => {
  const w = liveWorld();
  const id = await start(w);
  const snapshot = structuredClone(w.job(id));
  const ceiling = snapshot.ceilingMs;
  w.state.now = T0 + 4 * HOUR + MIN;
  w.tap("content", 4 * 60); // (still working: only the ceiling is in question)
  const ext = await extendJob(id, { minutes: 30, reason: "almost there", sessionID: PARENT }, w.deps);
  assert.equal(ext.ok, true);
  const res = await finishV2Job(snapshot, "failed", "reached its time limit of 4 hours", w.deps, {
    endReason: "time-limit",
    onlyIf: (live) => live.status === "running" && live.ceilingMs === ceiling && w.state.now - live.startedAt > live.ceilingMs,
  });
  assert.deepEqual(res, { ok: true, skipped: "guard" });
  assert.equal(w.job(id).status, "running");
  assert.equal(results(w).records, 0);
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running", "the extended ceiling now covers it");
});

test("extend: the A7 checks, in order, and the success shape (30 minutes is +1 800 000 ms)", async () => {
  const w = liveWorld();
  const id = await start(w);
  w.deps.replacementChain = (sid) => (sid === PARENT ? [PARENT, "ses_successor"] : [sid]);
  const ask = (over = {}) => extendJob(id, { minutes: 30, reason: "needs more", sessionID: PARENT, ...over }, w.deps);
  assert.equal((await extendJob("nope0000", { minutes: 30, reason: "x", sessionID: PARENT }, w.deps)).status, 404);
  assert.deepEqual(await ask({ sessionID: "ses_stranger" }), { ok: false, status: 403, error: "that job belongs to another session" });
  assert.equal((await ask({ minutes: 14 })).status, 400);
  assert.equal((await ask({ minutes: 481 })).status, 400);
  assert.equal((await ask({ minutes: 20.5 })).status, 400);
  assert.equal((await ask({ reason: "   " })).status, 400);
  assert.equal((await ask({ reason: "x".repeat(201) })).status, 400);
  const ok = await ask();
  assert.deepEqual(ok, { ok: true, job: { id, name: w.job(id).name, ceilingMs: 4 * HOUR + 1_800_000, startedAt: T0 } });
  assert.equal(w.job(id).extensions.length, 1);
  assert.equal(w.job(id).extensions[0].reason, "needs more");
  assert.equal(w.published.at(-1).payload.view.ceilingAt, T0 + 4 * HOUR + 1_800_000, "published with the new ceiling");
  assert.equal((await ask({ sessionID: "ses_successor" })).ok, true, "a session of the handoff chain may extend");
  for (let i = 0; i < 3; i++) await ask({ minutes: 480 }).then((r) => assert.ok(r.ok === true || r.status === 409));
  assert.equal((await ask({ minutes: 480 })).status, 409, "12 hours at most");
  assert.ok(w.job(id).ceilingMs <= 12 * HOUR);
  w.finish(w.job(id).childSessionID, "succeeded", T0 + 1);
  await createDelegateEngine(w.deps).observeRaw(raw("session.execution.succeeded", w.job(id).childSessionID));
  assert.equal((await ask()).status, 409, "a finished job can't be extended");
  const oc = liveWorld({ jobs: [{ id: "aaaa1111", status: "running", childSessionID: "ses_oc", parentSessionID: PARENT, origin: "subagent", completionOwner: "opencode", startedAt: T0 }] });
  assert.equal((await extendJob("aaaa1111", { minutes: 30, reason: "x", sessionID: PARENT }, oc.deps)).status, 409, "opencode-owned jobs have no limit to extend");
});

test("extend: the engine's own tool route returns the same refusals", async () => {
  const w = liveWorld();
  const id = await start(w);
  assert.equal((await w.engine.extendJob(id, { minutes: 30, reason: "r", sessionID: "ses_other" })).status, 403);
  assert.equal((await w.engine.extendJob(id, { minutes: 30, reason: "r", sessionID: PARENT })).ok, true);
});

test("resume: a new segment gets the launch ceiling back, extensions dropped, progress kept; a refused resume restores every field", async () => {
  const w = liveWorld();
  const id = await pausedJob(w);
  w.jobs.find((j) => j.id === id).jobProgress.milestones.push({ at: T0, text: "kept" });
  await extendJob(id, { minutes: 15, reason: "x", sessionID: PARENT }, { ...w.deps, load: w.deps.load }).catch(() => {});
  const paused = w.job(id);
  assert.equal(paused.status, "paused");
  // refused resume: the pre-resume fields come back
  const before = { ceilingMs: paused.ceilingMs, extensions: structuredClone(paused.extensions), endReason: paused.endReason };
  w.fail.create = httpErr(400);
  const refused = await resumeJob(id, w.deps);
  assert.equal(refused.ok, false);
  assert.equal(w.job(id).status, "paused");
  assert.deepEqual({ ceilingMs: w.job(id).ceilingMs, extensions: w.job(id).extensions, endReason: w.job(id).endReason }, before);
  w.fail.create = null;
  // simulate an extension having happened in the previous segment
  const rec = w.jobs.find((j) => j.id === id);
  rec.ceilingMs = rec.baseCeilingMs + 45 * MIN;
  rec.extensions = [{ at: T0, minutes: 45, reason: "earlier" }];
  const resumed = await resumeJob(id, w.deps);
  assert.equal(resumed.ok, true);
  assert.equal(w.job(id).ceilingMs, w.job(id).baseCeilingMs, "extensions of the previous segment are dropped");
  assert.deepEqual(w.job(id).extensions, []);
  assert.equal(w.job(id).startedAt, w.state.now, "the segment clock restarts");
  assert.equal(w.job(id).jobProgress.milestones[0].text, "kept", "progress survives a resume");
});

test("resume: a job that reported 'blocked' resumes with no model state (progress otherwise kept); a refused resume restores the original progress exactly", async () => {
  const w = liveWorld();
  const id = await pausedJob(w);
  const rec = w.jobs.find((j) => j.id === id);
  rec.jobProgress.label = "waiting on a decision";
  rec.jobProgress.modelState = "blocked";
  rec.jobProgress.milestones.push({ at: T0, text: "kept" });
  rec.jobProgress.usage = { tokens: 42, costUsd: 0.5, costPartial: false };
  const original = structuredClone(rec.jobProgress);
  w.fail.create = httpErr(400);
  assert.equal((await resumeJob(id, w.deps)).ok, false);
  assert.deepEqual(w.job(id).jobProgress, original, "a refused resume restores jobProgress exactly");
  w.fail.create = null;
  assert.equal((await resumeJob(id, w.deps)).ok, true);
  const jp = w.job(id).jobProgress;
  assert.equal(jp.modelState, null);
  assert.equal(jp.label, original.label);
  assert.deepEqual(jp.checklist, original.checklist);
  assert.deepEqual(jp.milestones, original.milestones);
  assert.deepEqual(jp.usage, original.usage);
});

test("continuation: a new round resets every liveness / progress field of the record it spreads", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  const rec = w.jobs.find((j) => j.id === id);
  rec.extensions = [{ at: T0, minutes: 30, reason: "x" }];
  rec.ceilingMs = rec.baseCeilingMs + 30 * MIN;
  rec.jobProgress.milestones.push({ at: T0, text: "old" });
  rec.jobProgress.usage = { tokens: 99, costUsd: 1, costPartial: false };
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(w.job(id).completionDelivery, "delivered");
  const res = await continueJob(id, { prompt: "next round", sessionID: PARENT }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const next = res.job;
  assert.notEqual(next.id, id);
  assert.equal(next.ceilingMs, next.baseCeilingMs);
  assert.deepEqual(next.extensions, []);
  assert.equal(next.endReason, null);
  assert.equal(next.endedBlocked, false);
  assert.equal(next.lastProgressAt, null);
  assert.deepEqual(next.jobProgress.milestones, []);
  assert.deepEqual(next.jobProgress.usage, { tokens: 0, costUsd: null, costPartial: false });
});

test("a legacy running record (none of the new fields) is given them at first touch and keeps the CTO allowance as its ceiling", async () => {
  const w = liveWorld({ jobs: [{
    id: "aaaa1111", name: "old", status: "running", engine: "v2", completionOwner: "manta", childSessionID: "ses_child", parentSessionID: PARENT,
    startedAt: T0, launchState: "running", submittedAt: T0, sweepAllowanceMs: 90 * MIN, origin: "delegate", launch: { text: "x" },
  }] });
  w.sessions.set("ses_child", { id: "ses_child", parentID: PARENT, time: {} });
  w.active.add("ses_child");
  w.state.now = T0 + 10 * MIN;
  await sweepDelegateJobs(w.deps);
  const j = w.job("aaaa1111");
  assert.equal(j.ceilingMs, 90 * MIN);
  assert.equal(j.baseCeilingMs, 90 * MIN);
  assert.deepEqual(j.extensions, []);
  assert.ok(j.jobProgress);
  assert.equal(j.status, "running");
});

test("progress: the tap's todo list becomes the job's checklist; a model report adds label, milestones and a decision state; every report is stored", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  const todos = [{ content: "read", status: "completed" }, { content: "write", status: "in_progress" }, { content: "test", status: "pending" }];
  w.engine.observeActivity({ type: "todos", sessionId: child, items: todos, at: T0 + MIN });
  await new Promise((r) => setTimeout(r, 5));
  let j = w.job(id);
  assert.equal(j.jobProgress.checklist.length, 3);
  assert.equal(j.jobProgress.planRevision, 1);
  assert.equal(j.jobProgress.bar, 1 / 3);
  // a subagent's todo list is not the job's plan
  w.engine.observeActivity({ type: "child", sessionId: child, childSessionId: "ses_kid", parentSessionId: child, at: T0 });
  w.engine.observeActivity({ type: "todos", sessionId: "ses_kid", items: [{ content: "x", status: "pending" }, { content: "y", status: "pending" }], at: T0 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.job(id).jobProgress.checklist.length, 3);

  await w.engine.reportJobProgress({ sessionID: child, input: { label: "writing the fix", milestone: "found the cause" }, record: { state: "working", step: 2, total: 3 } });
  await w.engine.reportJobProgress({ sessionID: child, input: { milestone: "found the cause" }, record: { state: "blocked", step: 2, total: 3 } });
  j = w.job(id);
  assert.equal(j.jobProgress.label, "writing the fix");
  assert.equal(j.jobProgress.modelState, "blocked");
  assert.equal(j.jobProgress.milestones.length, 1, "an exact duplicate of the newest is dropped");
  const listed = await w.engine.listJobs({ sessionID: PARENT });
  assert.equal(listed[0].view.state, "needs-decision");
  assert.equal(listed[0].view.headline, "writing the fix");
  assert.equal(listed[0].view.steps.source, "checklist", "the checklist wins the steps");
  // a report from a session that is not a running job's root is not applied
  assert.deepEqual(await w.engine.reportJobProgress({ sessionID: "ses_kid", input: { label: "x" }, record: { state: "working" } }), { applied: false });
});

test("progress: ending while blocked is `needs a decision` (not done), carries endedBlocked into the result, keeps the bar below 1, and milestones survive clearProgress", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.engine.observeActivity({ type: "todos", sessionId: child, items: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }], at: T0 });
  await new Promise((r) => setTimeout(r, 5));
  await w.engine.reportJobProgress({ sessionID: child, input: { label: "need a call on the schema", milestone: "schema drafted" }, record: { state: "blocked" } });
  w.say(child, "Which schema do you want: A or B?");
  w.finish(child, "succeeded", T0 + 9);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const j = w.job(id);
  assert.equal(j.status, "done");
  assert.equal(j.endedBlocked, true);
  assert.ok(j.jobProgress.bar < 1);
  const body = w.calls.synth[0].body;
  assert.equal(body.metadata.manta.endedBlocked, true);
  assert.equal(body.metadata.state, "completed", "the execution state stays completed");
  assert.match(body.text, /^\[background job "[^"]+" needs a decision\]/);
  assert.match(body.text, /Milestones:\n- schema drafted/);
  assert.match(body.text, /Which schema do you want/);
});

test("progress: a plain done job's bar is 1 and its result says done; usage is folded in at the end and flushed by the sweep", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.engine.observeActivity({ type: "todos", sessionId: child, items: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }], at: T0 });
  await new Promise((r) => setTimeout(r, 5));
  w.engine.observeActivity({ type: "step", sessionId: child, eventId: "e1", tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 0 }, cost: 0.5, at: T0 + 1 });
  w.state.now = T0 + 2 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.deepEqual(w.job(id).jobProgress.usage, { tokens: 115, costUsd: 0.5, costPartial: false }, "flushed by the sweep");
  w.engine.observeActivity({ type: "step", sessionId: child, eventId: "e2", tokens: { input: 1, output: 1 }, cost: null, at: T0 + 3 * MIN });
  w.say(child, "all done");
  w.finish(child, "succeeded", T0 + 4 * MIN);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const j = w.job(id);
  assert.equal(j.jobProgress.bar, 1);
  assert.deepEqual(j.jobProgress.usage, { tokens: 117, costUsd: 0.5, costPartial: true }, "folded in at the terminal transition");
  assert.match(w.calls.synth[0].body.text, /^\[background job "[^"]+" done\]/);
  assert.ok(w.published.some((e) => e.payload.view?.state === "done" && e.payload.status === "done"), "the terminal publish carries the view");
});

test("evidence log: one line per Manta-owned terminal segment with what the engine knew at the decision", async () => {
  const w = liveWorld();
  const lines = [];
  w.deps.livenessLog = { appendSegment: async (e) => lines.push(e), recordDeployed: async () => true };
  const id = await start(w);
  w.rebuilt(id);
  w.tap("toolStarted", 1, { callID: "c1", name: "bash", target: "sleep 99", timeoutMs: 20 * MIN });
  w.state.now = T0 + 17 * MIN; // the tool is still within its allowance (until minute 26): alive
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).status, "running");
  w.state.now = T0 + 20 * MIN;
  w.tap("toolEnded", 2, { callID: "c1", name: "bash", input: {} });
  w.state.now = T0 + 40 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.equal(w.job(id).endReason, "stalled");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].jobId, id);
  assert.equal(lines[0].status, "failed");
  assert.equal(lines[0].endReason, "stalled");
  assert.equal(lines[0].segmentMs, 40 * MIN);
  assert.equal(lines[0].ceilingMs, 4 * HOUR);
  assert.equal(typeof lines[0].contentRecordsLast15m, "number");
  assert.deepEqual(lines[0].toolsAtEnd, []);
});

test("the final file count is the number of UNIQUE changed paths (base diff + untracked), and a git failure leaves it unknown", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.deps.gitRun = async (args) => {
    if (args.includes("diff")) return { stdout: "a.ts\nb.ts\n" };
    if (args.includes("status")) return { stdout: " M a.ts\n?? c.ts\n?? a.ts\n" };
    return { stdout: "abc123\n" };
  };
  w.say(child, "ok");
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(w.job(id).filesChanged, 3, "a.ts counted once");
  assert.deepEqual(w.job(id).jobProgress.files.changed, 3);
  const w2 = liveWorld();
  const id2 = await start(w2);
  w2.deps.gitRun = async () => {
    throw new Error("git is gone");
  };
  w2.state.now = T0 + 2 * MIN;
  await sweepDelegateJobs(w2.deps);
  assert.equal(w2.job(id2).jobProgress.files.changed, null, "unknown, never 0 by mistake");
});

test("the A5 backstop queue: a rejection that failed is retried by the next sweep (after reconstruction) and dropped on success, not-found or lost ownership", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.rebuilt(id);
  const tries = [];
  let failing = true;
  w.deps.rejectQuestion = async (a) => {
    tries.push(a);
    if (failing) throw netErr();
  };
  w.deps.rejectPermission = async (a) => {
    tries.push(a);
    throw httpErr(404, "gone");
  };
  assert.equal(await w.engine.rejectAsk({ kind: "question", requestId: "frm_1", sessionId: child }), false);
  assert.equal(await w.engine.rejectAsk({ kind: "permission", requestId: "per_1", sessionId: child }), true, "a 404 means the request is gone");
  assert.deepEqual(w.deps.liveness.pendingRejections().map((r) => r.requestId), ["frm_1"]);
  w.state.now = T0 + MIN;
  await sweepDelegateJobs(w.deps);
  assert.equal(tries.filter((t) => t.requestId === "frm_1").length, 2, "retried by the sweep");
  failing = false;
  w.state.now = T0 + 2 * MIN;
  await sweepDelegateJobs(w.deps);
  assert.deepEqual(w.deps.liveness.pendingRejections(), []);
  w.deps.liveness.queueRejection({ kind: "question", requestId: "frm_2", sessionId: "ses_not_owned" });
  await sweepDelegateJobs(w.deps);
  assert.deepEqual(w.deps.liveness.pendingRejections(), [], "no longer owned: dropped without a call");
  assert.equal(tries.some((t) => t.requestId === "frm_2"), false);
});

test("reconstruction rejects the asks it finds pending in the job's sessions (permission and question)", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.deps.liveness.resetAll(w.jobs);
  w.deps.listPermissions = async () => [{ id: "per_9" }];
  w.deps.listQuestions = async () => [{ id: "frm_9" }];
  const rejected = [];
  w.deps.rejectPermission = async (a) => rejected.push(["permission", a.requestId, a.sessionId]);
  w.deps.rejectQuestion = async (a) => rejected.push(["question", a.requestId, a.sessionId]);
  w.state.now = T0 + MIN;
  await sweepDelegateJobs(w.deps);
  assert.deepEqual(rejected, [["permission", "per_9", child], ["question", "frm_9", child]]);
});

test("reconstruction leaves a background slash-command job's pending asks alone (it shares its parent's permissions), unlike a delegate job's", async () => {
  const w = liveWorld({
    jobs: [{ id: "cmd00001", status: "running", engine: "v2", origin: "command", completionOwner: "manta", childSessionID: "ses_cmd", parentSessionID: PARENT, launchState: "running", startedAt: T0 }],
  });
  const id = await start(w);
  const child = w.job(id).childSessionID;
  w.deps.liveness.resetAll(w.jobs);
  w.deps.listPermissions = async (sid) => [{ id: `per_${sid}` }];
  w.deps.listQuestions = async () => [];
  const rejected = [];
  w.deps.rejectPermission = async (a) => rejected.push(a.sessionId);
  w.deps.rejectQuestion = async () => {};
  w.state.now = T0 + MIN;
  await sweepDelegateJobs(w.deps);
  assert.ok(w.deps.liveness.get("cmd00001").reconstructedAt != null, "the command job was reconstructed");
  assert.deepEqual(rejected, [child], "only the delegate job's ask is rejected");
});

test("normalizeJobRuleset: a trailing question deny, idempotent, grants untouched; buildJobPrompt carries the budget text for a worktree-less job too", () => {
  const grants = [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }];
  const once = normalizeJobRuleset(grants);
  assert.deepEqual(once, [...grants, { permission: "question", pattern: "*", action: "deny" }]);
  assert.deepEqual(normalizeJobRuleset(once), once);
  assert.deepEqual(normalizeJobRuleset(null), [{ permission: "question", pattern: "*", action: "deny" }]);
  const bare = buildJobPrompt({ prompt: "do it", worktree: null, branch: null, ceilingMs: 90 * MIN });
  assert.ok(bare.includes("Time: this job is stopped after 1 hour 30 minutes of work"));
  assert.ok(bare.includes("Progress: keep your todo list current"));
});

test("completion text: Reason (+ last status) for an ended job, milestones, and no change for an ordinary one", () => {
  const base = { name: "n", status: "failed", worktree: null, error: "stalled — no progress for 15 minutes", endReason: "stalled", jobProgress: { label: "building", milestones: [{ at: 1, text: "m1" }, { at: 2, text: "m2" }] } };
  const t = buildCompletionText(base);
  assert.equal(t, '[background job "n" failed]\nReason: stalled — no progress for 15 minutes\nLast status: building\nMilestones:\n- m1\n- m2\n\nError: stalled — no progress for 15 minutes');
  assert.equal(buildCompletionText({ name: "n", status: "done", result: "ok" }), '[background job "n" done]\n\nok');
  assert.ok(!buildCompletionText({ ...base, error: "stalled — no progress for 15 minutes (last: building)" }).includes("Last status:"), "already in the reason");
});

// ---------------------------------------------------------------------------
// Agents Phase 2: strict store, admission, lead markers, no-PR prompts
// ---------------------------------------------------------------------------

test("loadJobsStrict: a missing file is an empty list; a corrupt or shapeless file THROWS; a good file loads", async () => {
  const dir = await mkdtemp(joinPath(tmpdir(), "jobs-strict-"));
  try {
    assert.deepEqual(await loadJobsStrict(joinPath(dir, "none.json")), []);
    await writeFile(joinPath(dir, "bad.json"), "{ not json");
    await assert.rejects(loadJobsStrict(joinPath(dir, "bad.json")), SyntaxError);
    await writeFile(joinPath(dir, "shape.json"), JSON.stringify({ jobs: "nope" }));
    await assert.rejects(loadJobsStrict(joinPath(dir, "shape.json")), /no jobs list/);
    await writeFile(joinPath(dir, "ok.json"), JSON.stringify({ jobs: [{ id: "a" }] }));
    assert.deepEqual(await loadJobsStrict(joinPath(dir, "ok.json")), [{ id: "a" }]);
    // a directory where the file should be is a read failure, not "missing"
    await assert.rejects(loadJobsStrict(dir), /EISDIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WORKTREE_AGENT_GRANTS: the one grant list the worktree ruleset is built from", () => {
  assert.ok(Object.isFrozen(WORKTREE_AGENT_GRANTS));
  assert.deepEqual(buildWorktreeAgentRuleset({ home: "/h" }), buildWorktreeAgentRuleset({ home: "/h" }));
  const rules = buildWorktreeAgentRuleset({ home: "/h" });
  for (const g of WORKTREE_AGENT_GRANTS) assert.ok(rules.some((r) => r.action === "allow" && r.pattern === g.pattern), g.permission);
});

test("admit on startJob: runs under the lock, sees the stored jobs, and a refusal leaves NO record, worktree, session or window", async () => {
  const w = world({ jobs: [{ id: "run00001", name: "other", status: "running", engine: "v2", completionOwner: "manta", parentSessionID: PARENT, isolation: "worktree", childSessionID: "ses_other", origin: "delegate" }] });
  let seen = null;
  const res = await startJob(input({ agent: "agent-dev", isolation: "worktree", admit: (jobs) => ((seen = jobs.map((j) => j.id)), "Dev is already changing code for this chat (other); wait for its result") }), w.deps);
  assert.deepEqual(res, { ok: false, error: "Dev is already changing code for this chat (other); wait for its result" });
  assert.deepEqual(seen, ["run00001"]);
  assert.deepEqual(w.calls.addWorktree, [], "refused before a worktree was allocated");
  assert.deepEqual([w.calls.create, w.calls.move, w.calls.window, w.calls.send, w.calls.rmWorktree].map((c) => c.length), [0, 0, 0, 0, 0]);
  assert.equal(w.jobs.length, 1, "no record was written");
});

test("admit on startJob: a throwing check refuses; an unreadable store refuses and is never saved over", async () => {
  const w = world();
  const threw = await startJob(input({ admit: () => { throw new Error("boom"); } }), w.deps);
  assert.equal(threw.ok, false);
  assert.match(threw.error, /boom/);
  assert.equal(w.jobs.length, 0);

  const saves = [];
  const bad = world();
  bad.deps.loadStrict = async () => { throw new Error("jobs store unreadable"); };
  bad.deps.save = async (j) => saves.push(j);
  const res = await startJob(input({ admit: () => null }), bad.deps);
  assert.deepEqual(res, { ok: false, error: ADMIT_STORE_ERROR });
  assert.deepEqual(saves, [], "nothing saved");
  assert.deepEqual(bad.calls.addWorktree, []);
});

test("admit on startJob: two concurrent writers through the real lock → exactly one starts", async () => {
  const w = world();
  const admit = (jobs) => (jobs.some((j) => j.parentSessionID === PARENT && j.isolation === "worktree" && j.status === "running") ? "a writer is already running" : null);
  const [a, b] = await Promise.all([
    startJob(input({ name: "first", agent: "agent-dev", isolation: "worktree", admit }), w.deps),
    startJob(input({ name: "second", agent: "agent-dev", isolation: "worktree", admit }), w.deps),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(w.jobs.length, 1);
  assert.equal(w.calls.addWorktree.length, 1, "the loser never allocated a worktree");
});

test("the lead's markers: isolation, requestedBy, turnKey and allowPr are persisted; absent for a plain job", async () => {
  const w = world();
  const id = await start(w, { agent: "agent-dev", isolation: "worktree", requestedBy: "manta", turnKey: "msg_user1", allowPr: false, agentName: "Dev", request: "Fix login" });
  const job = w.job(id);
  assert.equal(job.isolation, "worktree");
  assert.equal(job.requestedBy, "manta");
  assert.equal(job.turnKey, "msg_user1");
  assert.equal(job.allowPr, false);
  const [row] = await listJobs({ sessionID: PARENT }, { load: w.deps.load, readProgress: async () => null });
  assert.equal(row.requestedBy, "manta", "reaches the client like agentName");
  assert.equal(row.request, "Fix login");

  const plain = world();
  const pid = await start(plain);
  for (const k of ["isolation", "requestedBy", "turnKey", "allowPr"]) assert.equal(k in plain.job(pid), false, k);
  const ro = world();
  const rid = await start(ro, { agent: "agent-seo", isolation: "none" });
  assert.equal(ro.job(rid).isolation, "none");
  assert.equal("allowPr" in ro.job(rid), false, "absent = allowed");
});

test("buildJobPrompt: allowPr:false replaces the pull-request sentence (a worktree job); the default is unchanged", () => {
  const base = { prompt: "do it", worktree: "/wt", branch: "job/x" };
  const yes = buildJobPrompt(base);
  assert.match(yes, /You may open a draft pull\nrequest for it/);
  const no = buildJobPrompt({ ...base, allowPr: false });
  assert.doesNotMatch(no, /draft pull/);
  assert.match(no, /Do not open pull requests; the lead and the user decide what ships\./);
  assert.match(no, /never merge, never force-push|Never merge, never force-push/);
  assert.equal(buildJobPrompt({ ...base, allowPr: true }), yes);
});

test("allowPr:false on start: the opening prompt the child gets has no pull-request permission", async () => {
  const w = world();
  await start(w, { agent: "agent-dev", isolation: "worktree", allowPr: false });
  assert.doesNotMatch(w.calls.send[0].text, /draft pull/);
  assert.match(w.calls.send[0].text, /Do not open pull requests/);
  const open = world();
  await start(open, { agent: "agent-dev", isolation: "worktree" });
  assert.match(open.calls.send[0].text, /draft pull/);
});

test("allowPr:false on resume: the resumed job's prompt still has no pull-request permission", async () => {
  const w = world();
  const id = await pausedJob(w, { agent: "agent-dev", isolation: "worktree", allowPr: false });
  w.calls.send.length = 0;
  assert.equal((await resumeJob(id, w.deps)).ok, true);
  assert.doesNotMatch(w.calls.send[0].text, /draft pull/);
  assert.match(w.calls.send[0].text, /Do not open pull requests/);
  const open = world();
  const oid = await pausedJob(open, { agent: "agent-dev", isolation: "worktree" });
  open.calls.send.length = 0;
  await resumeJob(oid, open.deps);
  assert.match(open.calls.send[0].text, /draft pull/);
});

async function finishedLeadJob(extra = {}) {
  const w = liveWorld();
  w.deps.autonomyPolicy = async () => MODES.balanced;
  const id = await start(w, { agent: "agent-dev", isolation: "worktree", requestedBy: "manta", turnKey: "msg_u1", allowPr: false, agentName: "Dev", request: "Fix login", specialist: true, autonomy: { load: async () => MODES.balanced, check: () => null }, ...extra });
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(w.job(id).completionDelivery, "delivered");
  return { w, id };
}

test("continueJob with admit: the check sees the live store and the STORED job; a refusal leaves the old record untouched", async () => {
  const { w, id } = await finishedLeadJob();
  let seen = null;
  const refused = await continueJob(id, { prompt: "round two", sessionID: PARENT, admit: (jobs, old) => ((seen = { ids: jobs.map((j) => j.id), old: old.id, isolation: old.isolation }), "too many") }, w.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "too many");
  assert.deepEqual(seen, { ids: [id], old: id, isolation: "worktree" });
  assert.equal(w.jobs.length, 1, "no successor record");
  assert.equal(w.job(id).supersededBy, undefined, "the old record is still the live one");
});

test("continueJob with admit: an unreadable store refuses and saves nothing", async () => {
  const { w, id } = await finishedLeadJob();
  const saves = [];
  w.deps.loadStrict = async () => { throw new Error("unreadable"); };
  const realSave = w.deps.save;
  w.deps.save = async (j) => (saves.push(j), realSave(j));
  const res = await continueJob(id, { prompt: "round two", sessionID: PARENT, admit: () => null }, w.deps);
  assert.deepEqual(res, { ok: false, status: 500, error: ADMIT_STORE_ERROR });
  assert.deepEqual(saves, []);
});

test("continueJob: the lead's fields land on the successor (title, request, requestedBy, turnKey, allowPr); without them it inherits", async () => {
  const { w, id } = await finishedLeadJob();
  const res = await continueJob(id, { prompt: "round two", sessionID: PARENT, admit: () => null, name: "Fix signup page", request: "Fix signup page", requestedBy: "manta", turnKey: "msg_u2", allowPr: false }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const next = res.job;
  assert.equal(next.name, "fix-signup-page");
  assert.equal(next.request, "Fix signup page");
  assert.equal(next.requestedBy, "manta");
  assert.equal(next.turnKey, "msg_u2");
  assert.equal(next.allowPr, false);
  assert.equal(next.isolation, "worktree", "the stored isolation carries over");
  assert.equal(next.agentName, "Dev");
  assert.equal(next.continues, id);
  assert.equal(next.prompt, "round two");

  // a continuation that names nothing inherits the old record's values
  const { w: w2, id: id2 } = await finishedLeadJob();
  const plain = await continueJob(id2, { prompt: "again", sessionID: PARENT }, w2.deps);
  assert.equal(plain.ok, true);
  assert.equal(plain.job.requestedBy, "manta");
  assert.equal(plain.job.turnKey, "msg_u1");
  assert.equal(plain.job.request, "Fix login");
  assert.equal(plain.job.allowPr, false);
});


// ---------------------------------------------------------------------------
// Agents Phase 3: a specialist's task follows the user's autonomy settings
// ---------------------------------------------------------------------------

const HOME = "/home/test";
const BAL = { ...MODES.balanced };
const AUT = { ...MODES.autonomous };
const NEVER_CODE = { ...MODES.balanced, edit_code: "never" };
const specialistWorld = (policy = BAL) => {
  const w = liveWorld();
  w.deps.home = HOME;
  w.state.policy = policy;
  w.deps.autonomyPolicy = async () => w.state.policy;
  return w;
};
const autonomyInput = (w, extra = {}) => ({
  agent: "agent-dev",
  isolation: "worktree",
  agentName: "Dev",
  agentDir: `${HOME}/.manta/agents/dev`,
  specialist: true,
  autonomy: { load: async () => w.state.policy, check: () => null },
  ...extra,
});
const q = { permission: "question", pattern: "*", action: "deny" };

test("autonomy: a specialist's denies are appended ONCE after the base, then the question deny; the base, key and policy are persisted", async () => {
  const w = specialistWorld();
  const id = await start(w, autonomyInput(w));
  const job = w.job(id);
  const base = buildWorktreeAgentRuleset();
  const rules = jobRules(BAL, { home: HOME, agentDir: `${HOME}/.manta/agents/dev`, sessionID: job.childSessionID });
  assert.deepEqual(job.basePermission, base);
  // the rules name THIS child's secrets folder (and nobody else's): the child id was minted before its ruleset
  assert.ok(rules.some((r) => r.action === "allow" && r.pattern.includes(`/.manta-secrets/sessions/${job.childSessionID}/`)));
  assert.equal(w.calls.create[0].id, job.childSessionID);
  assert.deepEqual(job.permission, [...base, ...rules, q]);
  assert.deepEqual(w.calls.create[0].permission, job.permission, "the child is created with the final ruleset");
  assert.equal(job.permission.filter((r) => r.permission === "question").length, 1);
  assert.equal(job.specialist, true);
  assert.equal(job.autonomyKey, policyKey(BAL));
  assert.deepEqual(job.autonomyPolicy, normalizePolicy(BAL));
  assert.equal(job.agentDir, `${HOME}/.manta/agents/dev`);
  assert.match(job.launch.text, /Needs the user's go-ahead \(don't do it and don't try another way\): deploy or release anything/);
  assert.match(job.launch.text, /Merging is never part of a task/);
  assert.equal(job.launch.text.includes(taskPromptSection(BAL)), true, "the section is the pure one, with no project entries");
  // …and the prompt's autonomy section sits after the worktree paragraph, before the time budget
  assert.ok(job.launch.text.indexOf("## Your limits") > job.launch.text.indexOf("never touch any other checkout") || job.launch.text.indexOf("## Your limits") > job.launch.text.indexOf("Do not open pull requests"));
  assert.ok(job.launch.text.indexOf("## Your limits") < job.launch.text.indexOf("Time: this job is stopped"));
  // a specialist's endings send the question and the summary to its final message, before the report section
  assert.match(job.launch.text, /put the question in your final message, before the "Actions from your list" section\./);
  assert.match(job.launch.text, /When you are done, write a short summary of what you changed and why\./);
  assert.deepEqual(job.projectPatterns, [], "no page entries: an empty snapshot");
});

test("autonomy: a caller-supplied (approval-resolved) base is kept and the denies come after it; a plain job is untouched", async () => {
  const w = specialistWorld();
  const caller = [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }];
  const id = await start(w, autonomyInput(w, { permission: caller }));
  // research and the library ride along, right under the leading deny (they are not a file or shell permission)
  const withResearch = withResearchToolAllows(caller);
  assert.deepEqual(withResearch.slice(0, 1), caller.slice(0, 1));
  assert.deepEqual(withResearch.slice(-1), caller.slice(-1));
  assert.equal(withResearch.length, caller.length + 6);
  assert.deepEqual(w.job(id).basePermission, withResearch);
  assert.deepEqual(w.job(id).permission, [...withResearch, ...jobRules(BAL, { home: HOME, agentDir: `${HOME}/.manta/agents/dev`, sessionID: w.job(id).childSessionID }), q]);
  const plain = world();
  const pid = await start(plain, { agent: "agent-dev", isolation: "worktree", agentName: "Dev" });
  for (const k of ["specialist", "basePermission", "autonomyKey", "autonomyPolicy"]) assert.equal(k in plain.job(pid), false, k);
  assert.deepEqual(plain.job(pid).permission, buildWorktreeAgentRuleset());
});

test("autonomy: the settings are read at the last moment; a read failure or a failing check refuses before anything is created", async () => {
  const w = specialistWorld();
  const unreadable = await startJob(input(autonomyInput(w, { autonomy: { load: async () => { throw new Error("bad json"); }, check: () => null } })), w.deps);
  assert.deepEqual(unreadable, { ok: false, error: SETTINGS_UNREADABLE });
  const refused = await startJob(input(autonomyInput(w, { autonomy: { load: async () => NEVER_CODE, check: (p) => (p.edit_code === "never" ? CODE_OFF : null) } })), w.deps);
  assert.deepEqual(refused, { ok: false, error: CODE_OFF });
  const missing = await startJob(input({ ...autonomyInput(w), autonomy: undefined }), w.deps);
  assert.equal(missing.ok, false, "a specialist job with no autonomy hook fails closed");
  assert.equal(w.jobs.length, 0);
  assert.deepEqual(w.calls.addWorktree, []);
  assert.deepEqual(w.calls.create, []);
});

test("autonomy: startJobWithApproval reads the settings AFTER the approval wait, and the denies follow the edited grants", async () => {
  const w = specialistWorld(BAL);
  let loads = 0;
  const engine = createDelegateEngine(w.deps);
  const started = engine.startJobWithApproval(
    input({
      ...autonomyInput(w, { autonomy: { load: async () => (loads++, w.state.policy), check: () => null } }),
      trustMode: false,
      tools: [{ permission: "bash", pattern: "**" }],
    }),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loads, 0, "nothing read while the user is still deciding");
  const [pending] = engine.listPendingApprovals(PARENT);
  assert.ok(pending, "the approval card is up");
  w.state.policy = AUT; // the user changed the settings while the card was open
  const edited = [{ permission: "read", pattern: "**" }];
  engine.approve(pending.id, edited);
  const res = await started;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(loads, 1);
  const job = w.job(res.job.id);
  assert.equal(job.autonomyKey, policyKey(AUT), "the settings in force AFTER the wait");
  assert.deepEqual(job.permission.slice(-1), [q]);
  assert.ok(job.permission.some((r) => r.permission === "read" && r.action === "allow"), "the edited grants are the base");
  assert.ok(!job.permission.some((r) => r.permission === "bash" && r.pattern === "**" && r.action === "allow"), "the grants the user removed are gone");
  const baseLen = job.basePermission.length;
  assert.deepEqual(job.permission.slice(0, baseLen), job.basePermission);
});

test("autonomy: a task can't run inside Manta's own folders (parent folder, or a worktree made there)", async () => {
  const w = specialistWorld();
  const inManta = await startJob(input(autonomyInput(w, { parentDirectory: `${HOME}/.manta/agents/manta/home` })), w.deps);
  assert.deepEqual(inManta, { ok: false, error: MANTA_FOLDER });
  assert.deepEqual(w.calls.addWorktree, []);
  const onConfig = await startJob(input(autonomyInput(w, { parentDirectory: `${HOME}/.config/opencode/x` })), w.deps);
  assert.equal(onConfig.error, MANTA_FOLDER);

  const wt = specialistWorld();
  wt.deps.gitAddWorktree = async ({ name }) => ({ path: `${HOME}/.manta/wt/${name}`, branch: `job/${name}` });
  const made = await startJob(input(autonomyInput(wt)), wt.deps);
  assert.deepEqual(made, { ok: false, error: MANTA_FOLDER });
  assert.deepEqual(wt.calls.rmWorktree.map((r) => r.path), [`${HOME}/.manta/wt/fix-the-bug`], "the worktree it made is taken back");
  assert.equal(wt.jobs.length, 0);
  // a generic job is not subject to it
  const plain = specialistWorld();
  assert.equal((await startJob(input({ parentDirectory: `${HOME}/.manta/x` }), plain.deps)).ok, true);
});

async function finishedSpecialist(w, extra = {}) {
  const id = await start(w, autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1", allowPr: false, request: "Fix login", ...extra }));
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  return id;
}

test("autonomy continue: refused when the settings changed since the task started, or for a writer under 'Code changes: Never'; allowed under the same settings", async () => {
  const w = specialistWorld();
  const id = await finishedSpecialist(w);
  w.state.policy = AUT;
  const changed = await continueJob(id, { prompt: "again", sessionID: PARENT }, w.deps);
  assert.deepEqual(changed, { ok: false, status: 409, error: POLICY_CHANGED });
  assert.equal(w.job(id).supersededBy, undefined);

  w.state.policy = BAL;
  w.jobs.find((j) => j.id === id).autonomyKey = policyKey(NEVER_CODE); // a task that started under "never"…
  w.state.policy = NEVER_CODE; // …and still is
  const writer = await continueJob(id, { prompt: "again", sessionID: PARENT }, w.deps);
  assert.deepEqual(writer, { ok: false, status: 409, error: CODE_OFF });

  const ok = specialistWorld();
  const oid = await finishedSpecialist(ok);
  const res = await continueJob(oid, { prompt: "again", sessionID: PARENT }, ok.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.job.autonomyKey, policyKey(BAL), "the successor carries the snapshot of the session's permissions");
  assert.deepEqual(res.job.permission, ok.job(oid).permission);

  const unreadable = specialistWorld();
  const uid = await finishedSpecialist(unreadable);
  unreadable.deps.autonomyPolicy = async () => { throw new Error("unreadable"); };
  const r = await continueJob(uid, { prompt: "again", sessionID: PARENT }, unreadable.deps);
  assert.deepEqual(r, { ok: false, status: 500, error: SETTINGS_UNREADABLE });
});

test("autonomy continue/resume: a Phase 1/2 specialist job (no snapshot) is refused; a generic job is not", async () => {
  const w = specialistWorld();
  const id = await start(w, { agent: "agent-dev", isolation: "worktree", agentName: "Dev", requestedBy: "manta" });
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const legacy = await continueJob(id, { prompt: "again", sessionID: PARENT }, w.deps);
  assert.deepEqual(legacy, { ok: false, status: 409, error: LEGACY_TASK });

  const paused = specialistWorld();
  const pid = await pausedJob(paused, { agent: "agent-dev", isolation: "worktree", agentName: "Dev" });
  assert.deepEqual(await resumeJob(pid, paused.deps), { ok: false, error: LEGACY_TASK });
  assert.equal(paused.job(pid).status, "paused", "it stays paused");

  const generic = specialistWorld();
  const gid = await finishedLeadJobLike(generic);
  assert.equal((await continueJob(gid, { prompt: "again", sessionID: PARENT }, generic.deps)).ok, true);
});

async function finishedLeadJobLike(w) {
  const id = await start(w, { agent: "build" });
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  return id;
}

test("autonomy resume: a fresh child under the CURRENT settings — the ruleset is recomputed from the base; a writer under 'Never' is refused", async () => {
  const w = specialistWorld(BAL);
  const id = await pausedJob(w, autonomyInput(w));
  const before = structuredClone(w.job(id));
  w.state.policy = AUT;
  w.calls.create.length = w.calls.send.length = 0;
  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const job = w.job(id);
  assert.deepEqual(job.permission, normalizeJobRuleset([...before.basePermission, ...jobRules(AUT, { home: HOME, agentDir: `${HOME}/.manta/agents/dev`, sessionID: job.childSessionID })]));
  assert.notDeepEqual(job.permission, before.permission);
  // the resumed attempt is a NEW child: its rules open its own secrets folder, not the previous attempt's
  assert.notEqual(job.childSessionID, before.childSessionID);
  assert.ok(job.permission.some((r) => r.action === "allow" && r.pattern.includes(`/sessions/${job.childSessionID}/`)));
  assert.ok(!job.permission.some((r) => r.pattern.includes(before.childSessionID)));
  assert.equal(job.autonomyKey, policyKey(AUT));
  assert.deepEqual(job.autonomyPolicy, normalizePolicy(AUT));
  assert.deepEqual(w.calls.create[0].permission, job.permission, "the new child gets the recomputed ruleset");
  assert.deepEqual(job.basePermission, before.basePermission);
  assert.doesNotMatch(w.calls.send[0].text, /Needs the user's go-ahead \(don't do it and don't try another way\): deploy or release anything/, "deploy is Tell now, so it is no longer an 'ask' in the prompt");
  assert.match(w.calls.send[0].text, /Allowed \(do them when the task needs them\), but list them in your report: deploy or release anything/);
  assert.match(w.calls.send[0].text, /Merging is never part of a task/);

  const refused = specialistWorld(BAL);
  const rid = await pausedJob(refused, autonomyInput(refused));
  refused.state.policy = NEVER_CODE;
  assert.deepEqual(await resumeJob(rid, refused.deps), { ok: false, error: CODE_OFF });
  assert.equal(refused.job(rid).status, "paused");
});

const toolPart = (tool, input, status = "completed", error) => ({ type: "tool", tool, state: { status, input, ...(error ? { error } : {}), output: "" } });
const msgs = (launchId, ...parts) => [
  { info: { id: launchId, role: "user" }, parts: [{ type: "text", text: "go" }] },
  { info: { id: "msg_a1", role: "assistant" }, parts: [...parts, { type: "text", text: "All done." }] },
];

test("autonomy result: 'Tell me' and blocked actions are read from THIS attempt's transcript, kept on the record, and reach the result's text and metadata", async () => {
  const w = specialistWorld(AUT); // deploy / publish are "Tell me" here
  const id = await start(w, autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1" }));
  const job = w.job(id);
  w.setMessages(job.childSessionID, msgs(
    job.launch.messageId,
    toolPart("bash", { command: "cd app && fly deploy --app secret-name" }),
    toolPart("bash", { command: "gh pr merge 12" }, "error", "Permission denied: shell"),
    toolPart("bash", { command: "ls nope" }, "error", "ls: cannot access"), // an ordinary failure is never "blocked"
  ));
  w.finish(job.childSessionID, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", job.childSessionID));
  const done = w.job(id);
  assert.deepEqual(done.toldActions, [{ kind: "deploy", summary: "fly deploy" }]);
  assert.deepEqual(done.blockedActions, [{ kind: "merge", level: "never", summary: "gh pr merge" }]);
  const syn = [...w.records.values()][0].body;
  assert.deepEqual(syn.metadata.manta.toldActions, done.toldActions);
  assert.deepEqual(syn.metadata.manta.blockedActions, done.blockedActions);
  assert.match(syn.text, /Done without asking \(the user asked to be told\): deploy — fly deploy\n/);
  assert.match(syn.text, /Blocked by the user's autonomy settings: merge — gh pr merge \(never\) \(ask = needs the user's go-ahead, never = not allowed\)/);
  assert.ok(!JSON.stringify(syn).includes("secret-name"), "user arguments never appear");
});

test("autonomy result: using a secret file the task was handed is not reported; another session's folder and Manta's own files still are", async () => {
  const w = specialistWorld(BAL);
  const id = await start(w, autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1" }));
  const job = w.job(id);
  const own = `${HOME}/.manta-secrets/sessions/${job.childSessionID}/KEY`;
  const other = `${HOME}/.manta-secrets/sessions/ses_someoneelse/KEY`;
  w.setMessages(job.childSessionID, msgs(
    job.launch.messageId,
    toolPart("bash", { command: `git push https://x-access-token:$(cat ${HOME}/.manta-secrets/GH_TOKEN)@github.com/o/r HEAD` }),
    toolPart("bash", { command: `curl -u "u:$(cat ${own})" https://x.test` }),
    toolPart("bash", { command: `cat ${other}` }, "error", "Permission denied: shell"),
  ));
  w.finish(job.childSessionID, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", job.childSessionID));
  const done = w.job(id);
  assert.deepEqual(done.blockedActions, [{ kind: "protected", level: "never", summary: "Manta settings or credentials" }], "only the other session's folder");
  assert.deepEqual(done.exceededActions ?? [], []);
});

test("autonomy result: a continuation reads only its own round; nothing to report omits the fields", async () => {
  const w = specialistWorld(AUT);
  const id = await finishedSpecialist(w);
  const first = w.job(id);
  const child = first.childSessionID;
  const res = await continueJob(id, { prompt: "round two", sessionID: PARENT }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const next = w.job(res.job.id);
  assert.equal(next.toldActions, undefined, "not inherited");
  w.setMessages(child, [
    { info: { id: first.launch.messageId, role: "user" }, parts: [] },
    { info: { id: "msg_old", role: "assistant" }, parts: [toolPart("bash", { command: "fly deploy" })] }, // round one
    { info: { id: next.launch.messageId, role: "user" }, parts: [] },
    { info: { id: "msg_new", role: "assistant" }, parts: [toolPart("bash", { command: "npm publish" })] }, // round two
  ]);
  w.finish(child, "succeeded", T0 + 2);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.deepEqual(w.job(next.id).toldActions, [{ kind: "deploy", summary: "npm publish" }]);

  const quiet = specialistWorld(BAL);
  const qid = await finishedSpecialist(quiet);
  const body = buildResultSynthetic(quiet.job(qid));
  assert.equal("toldActions" in body.metadata.manta, false);
  assert.equal("blockedActions" in body.metadata.manta, false);
  assert.doesNotMatch(body.text, /Done without asking|Blocked by the user's autonomy/);
});


// ---------------------------------------------------------------------------
// Agents Phase 3c: the project's own commands, the report section, what got through
// ---------------------------------------------------------------------------

const pageEntry = (kind, command, file = null) => validateEntry({ kind, command, what: "x", file });
const PAGE_A = [pageEntry("deploy", "scripts/deploy-web.sh", "scripts/deploy-web.sh"), pageEntry("publish", "make ship")];
const PAGE_B = [pageEntry("deploy", "make release", "Makefile")];
// the project's commands for every task started in the world, and the directories it was asked about
const withPage = (w, entries = PAGE_A, promptEntries = entries) => {
  w.state.asked = [];
  w.deps.projectActions = {
    forTask: async ({ directory }) => {
      w.state.asked.push(directory);
      return { entries: w.state.pageEntries ?? entries, promptEntries: w.state.pagePrompt ?? w.state.pageEntries ?? promptEntries };
    },
  };
  return w;
};
const DIR = `${HOME}/.manta/agents/dev`;
const bashDenies = (rules) => rules.filter((r) => r.permission === "bash" && r.action === "deny").map((r) => r.pattern);

test("project actions: a specialist's START takes its denies and its prompt section from the page (read once, for the parent's folder); the snapshot is stored", async () => {
  const w = withPage(specialistWorld(BAL));
  const id = await start(w, autonomyInput(w));
  const job = w.job(id);
  const pp = projectPatterns(PAGE_A);
  assert.deepEqual(w.state.asked, [REPO]);
  assert.deepEqual(job.projectPatterns, pp);
  assert.deepEqual(job.permission, [...job.basePermission, ...jobRules(BAL, { home: HOME, agentDir: DIR, projectPatterns: pp, sessionID: job.childSessionID }), q]);
  assert.deepEqual(w.calls.create[0].permission, job.permission);
  const denies = bashDenies(w.calls.create[0].permission);
  for (const p of ["scripts/deploy-web.sh", "./scripts/deploy-web.sh", "bash scripts/deploy-web.sh", "make ship", "make ship *"]) assert.ok(denies.includes(p), p);
  assert.ok(job.permission.every((r) => r.action === "deny" || !String(r.pattern).includes("deploy-web")), "a page never produces an allow");
  assert.equal(job.launch.text.includes(taskPromptSection(BAL, PAGE_A)), true);
  assert.match(job.launch.text, /- deploy or release anything: `scripts\/deploy-web\.sh` \(scripts\/deploy-web\.sh\)\n- publish anything others can see: `make ship`\n\nYour final message:/);

  // Tell: nothing is blocked, but the section still tells the task
  const t = withPage(specialistWorld(AUT));
  const tid = await start(t, autonomyInput(t));
  assert.ok(!bashDenies(t.job(tid).permission).includes("make ship"));
  assert.ok(!bashDenies(t.job(tid).permission).includes("scripts/deploy-web.sh"));
  assert.deepEqual(t.job(tid).projectPatterns, pp, "every entry is kept (Tell commands are still attributed)");
  assert.match(t.job(tid).launch.text, /`scripts\/deploy-web\.sh`/);

  // the rules and the prompt come from the entries the page gave: prompt entries may be fewer (unscreened ones are rules only)
  const rulesOnly = withPage(specialistWorld(BAL), PAGE_A, []);
  const rid = await start(rulesOnly, autonomyInput(rulesOnly));
  assert.ok(bashDenies(rulesOnly.job(rid).permission).includes("make ship"));
  assert.doesNotMatch(rulesOnly.job(rid).launch.text, /In this project, these commands also count/);

  // a generic job never asks the page
  const plain = withPage(world());
  await start(plain, { agent: "build" });
  assert.deepEqual(plain.state.asked, []);
});

test("project actions: a reader that rejects, throws or answers nonsense is no project rules — the task still starts", async () => {
  for (const forTask of [async () => { throw new Error("boom"); }, () => { throw new Error("sync boom"); }, async () => null, async () => ({ entries: "x", promptEntries: 5 })]) {
    const w = specialistWorld(BAL);
    w.deps.projectActions = { forTask };
    const id = await start(w, autonomyInput(w));
    assert.deepEqual(w.job(id).projectPatterns, []);
    assert.deepEqual(w.job(id).permission, [...w.job(id).basePermission, ...jobRules(BAL, { home: HOME, agentDir: DIR, sessionID: w.job(id).childSessionID }), q]);
    assert.doesNotMatch(w.job(id).launch.text, /In this project, these commands also count/);
  }
  const noReader = specialistWorld(BAL);
  assert.equal((await startJob(input(autonomyInput(noReader)), noReader.deps)).ok, true, "no reader wired at all");
});

test("project actions: more than 100 commands refuses the start and the resume with the page's sentence, creating nothing", async () => {
  const many = Array.from({ length: 101 }, (_, i) => pageEntry("deploy", `scripts/deploy-${i}.sh`));
  const w = withPage(specialistWorld(BAL), many);
  const res = await startJob(input(autonomyInput(w)), w.deps);
  assert.deepEqual(res, { ok: false, error: MAX_ENTRIES_ERROR });
  assert.equal(w.jobs.length, 0);
  assert.deepEqual(w.calls.addWorktree, []);
  assert.deepEqual(w.calls.create, []);

  const r = withPage(specialistWorld(BAL));
  const id = await pausedJob(r, autonomyInput(r));
  r.state.pageEntries = many;
  r.calls.create.length = 0;
  assert.deepEqual(await resumeJob(id, r.deps), { ok: false, error: MAX_ENTRIES_ERROR });
  assert.equal(r.job(id).status, "paused");
  assert.deepEqual(r.calls.create, []);
});

test("project actions: a RESUME (fresh child) reads the page again — new denies, new section, new snapshot; a refused resume restores the old snapshot", async () => {
  const w = withPage(specialistWorld(BAL));
  const id = await pausedJob(w, autonomyInput(w));
  const before = structuredClone(w.job(id));
  assert.deepEqual(before.projectPatterns, projectPatterns(PAGE_A));
  w.state.pageEntries = PAGE_B;
  w.state.asked.length = 0;
  w.calls.create.length = w.calls.send.length = 0;

  w.fail.create = httpErr(400);
  assert.equal((await resumeJob(id, w.deps)).ok, false);
  assert.deepEqual(w.job(id).projectPatterns, before.projectPatterns, "a refused resume puts the paused job back as it was");
  assert.deepEqual(w.job(id).permission, before.permission);
  w.fail.create = null;

  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const job = w.job(id);
  assert.deepEqual(w.state.asked, [REPO, REPO], "asked for each resume attempt, for the parent's folder");
  assert.deepEqual(job.projectPatterns, projectPatterns(PAGE_B));
  assert.deepEqual(job.permission, normalizeJobRuleset([...before.basePermission, ...jobRules(BAL, { home: HOME, agentDir: DIR, projectPatterns: projectPatterns(PAGE_B), sessionID: job.childSessionID })]));
  assert.deepEqual(w.calls.create.at(-1).permission, job.permission);
  assert.ok(bashDenies(job.permission).includes("make release") && !bashDenies(job.permission).includes("make ship"));
  assert.match(w.calls.send.at(-1).text, /`make release` \(Makefile\)/);
  assert.match(w.calls.send.at(-1).text, /put the question in your final message, before the "Actions from your list" section\./);
  assert.match(w.calls.send.at(-1).text, /When you are done, write a short summary/);
  assert.equal("projectPatterns" in res.job || "selfReport" in res.job || "basePermission" in res.job, false, "never on the wire");
});

test("project actions: a CONTINUATION keeps the record's snapshot (no new lookup) and reminds the child of the report section", async () => {
  const w = withPage(specialistWorld(BAL));
  const id = await finishedSpecialist(w);
  const first = w.job(id);
  assert.deepEqual(first.projectPatterns, projectPatterns(PAGE_A));
  w.state.pageEntries = Array.from({ length: 150 }, (_, i) => pageEntry("deploy", `scripts/x-${i}.sh`)); // a page that would refuse a start
  w.state.asked.length = 0;
  w.calls.send.length = 0;
  const res = await continueJob(id, { prompt: "round two: tidy up", sessionID: PARENT }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(w.state.asked, [], "no new lookup");
  const next = w.job(res.job.id);
  assert.deepEqual(next.projectPatterns, first.projectPatterns, "the snapshot is carried over");
  assert.deepEqual(next.permission, first.permission);
  assert.equal(next.prompt, "round two: tidy up", "the record keeps the user's text");
  const sent = w.calls.send.at(-1).text;
  assert.equal(sent, `round two: tidy up\n\n${taskFooter(first.autonomyPolicy)}`);
  assert.match(sent, /## Actions from your list\n- Did: <action>/);
  assert.match(sent, /<action> is one of: deploy, publish, send, delete, spend, settings, agent change, merge\.$/);
  // a generic job's follow-up is the text, untouched
  const g = specialistWorld(BAL);
  const gid = await finishedLeadJobLike(g);
  g.calls.send.length = 0;
  await continueJob(gid, { prompt: "again", sessionID: PARENT }, g.deps);
  assert.equal(g.calls.send.at(-1).text, "again");
});

const reportText = (...lines) => `All done.\n\n## Actions from your list\n${lines.join("\n")}`;
const finishWith = async (w, id, messages) => {
  const child = w.job(id).childSessionID;
  w.setMessages(child, messages);
  w.finish(child, "succeeded", T0 + 5);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  return w.job(id);
};
const turn = (launchId, parts, text) => [
  { info: { id: launchId, role: "user" }, parts: [{ type: "text", text: "go" }] },
  { info: { id: `msg_${launchId}`, role: "assistant" }, parts: [...parts, ...(text === undefined ? [] : [{ type: "text", text }])] },
];

test("project actions: what got through (a command at Ask / Never, or the agent's own 'Did') is kept on the record, put first in the result and on its metadata; a report beats no report", async () => {
  const w = withPage(specialistWorld(BAL));
  const id = await start(w, autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1" }));
  const job0 = w.job(id);
  const done = await finishWith(
    w,
    id,
    turn(job0.launch.messageId, [toolPart("bash", { command: "./scripts/deploy-web.sh --prod" }), toolPart("bash", { command: "fly deploy --app z" })], reportText("- Did: deploy — pushed the site by hand", "- Did: spend — started a VM", "- Blocked: send — needed to email the client")),
  );
  assert.equal(done.selfReport, "present");
  assert.deepEqual(done.exceededActions, [
    { kind: "deploy", level: "ask", summary: "scripts/deploy-web.sh" },
    { kind: "deploy", level: "ask", summary: "fly deploy" },
    { kind: "spend", level: "ask", summary: "started a VM", source: "agent" },
  ]);
  assert.deepEqual(done.blockedActions, [{ kind: "send_external", level: "ask", summary: "needed to email the client", source: "agent" }]);
  const syn = [...w.records.values()][0].body;
  assert.deepEqual(syn.metadata.manta.exceededActions, done.exceededActions);
  assert.equal("selfReport" in syn.metadata.manta, false, "the report state only drives a line of text");
  const lines = syn.text.split("\n");
  const exceededAt = lines.findIndex((l) => l.startsWith("Despite the user's autonomy settings: "));
  const blockedAt = lines.findIndex((l) => l.startsWith("Blocked by the user's autonomy settings"));
  assert.ok(exceededAt >= 0 && blockedAt > exceededAt, "exceeded comes first");
  assert.match(lines[exceededAt], /deploy — scripts\/deploy-web\.sh \(ask\) \(matched in a completed command; outcome not checked\); deploy — fly deploy \(ask\) \(matched in a completed command; outcome not checked\); spend — started a VM \(ask\) \(agent's report: did it\)/);
  assert.match(lines[blockedAt], /send external — needed to email the client \(ask\) \(agent's report\)/);
  assert.doesNotMatch(syn.text, /did not include/);
  assert.ok(!syn.text.includes("--prod"), "a command's arguments never appear");
  assert.equal(JSON.stringify(syn.metadata).includes("--prod"), false);
});

test("project actions: a specialist's result without the section says so (done only); a failed task is not called out; a generic job never is", async () => {
  const w = specialistWorld(BAL);
  const id = await start(w, autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1" }));
  const done = await finishWith(w, id, turn(w.job(id).launch.messageId, [], "Fixed it."));
  assert.equal(done.selfReport, "missing");
  assert.match(buildCompletionText(done), /\nThe task did not include its "Actions from your list" section\.\n/);

  const none = specialistWorld(BAL);
  const nid = await start(none, autonomyInput(none, { requestedBy: "manta", turnKey: "msg_u1" }));
  const quiet = await finishWith(none, nid, turn(none.job(nid).launch.messageId, [], reportText("- None")));
  assert.equal(quiet.selfReport, "none");
  assert.deepEqual(quiet.exceededActions, []);
  assert.doesNotMatch(buildCompletionText(quiet), /did not include|Despite/);
  assert.equal("exceededActions" in buildResultSynthetic(quiet).metadata.manta, false, "nothing to report omits the field");

  const failed = specialistWorld(BAL);
  const fid = await start(failed, autonomyInput(failed));
  failed.setMessages(failed.job(fid).childSessionID, turn(failed.job(fid).launch.messageId, [toolPart("bash", { command: "fly deploy" })], "Hit an error."));
  await finishV2Job(failed.job(fid), "failed", "boom", failed.deps);
  assert.equal(failed.job(fid).selfReport, "missing", "a failed attempt has no final text to read");
  assert.deepEqual(failed.job(fid).exceededActions, [{ kind: "deploy", level: "ask", summary: "fly deploy" }], "…but a command that ran is still seen");
  assert.doesNotMatch(buildCompletionText(failed.job(fid)), /did not include/);
  assert.match(buildCompletionText(failed.job(fid)), /Despite the user's autonomy settings: deploy — fly deploy/);

  const generic = specialistWorld(BAL);
  const gid = await finishedLeadJobLike(generic);
  assert.equal("selfReport" in generic.job(gid), false);
  assert.doesNotMatch(buildCompletionText(generic.job(gid)), /did not include/);
});

test("project actions: the result text is THIS attempt's — a continuation that wrote no new final text has none (never round one's report)", async () => {
  const w = specialistWorld(BAL);
  const id = await finishedSpecialist(w);
  const first = w.job(id);
  const child = first.childSessionID;
  const res = await continueJob(id, { prompt: "round two", sessionID: PARENT }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const next = w.job(res.job.id);
  assert.equal(next.exceededActions, undefined, "not inherited");
  assert.equal(next.selfReport, undefined, "not inherited");
  const roundOne = turn(first.launch.messageId, [], reportText("- Did: spend — round one VM"));
  const roundTwo = [{ info: { id: next.launch.messageId, role: "user" }, parts: [] }, { info: { id: "msg_two", role: "assistant" }, parts: [toolPart("bash", { command: "npm test" })] }];
  const after = await finishWith(w, next.id, [...roundOne, ...roundTwo]);
  assert.equal(after.selfReport, "missing");
  assert.deepEqual(after.exceededActions, []);
  assert.equal(after.result, "All done.\n\n## Actions from your list\n- Did: spend — round one VM", "(the result text itself is unchanged behaviour)");
  assert.match(buildCompletionText(after), /did not include its "Actions from your list" section/);

  // …and a round that does report is read from its own text only
  const w2 = specialistWorld(BAL);
  const id2 = await finishedSpecialist(w2);
  const first2 = w2.job(id2);
  const res2 = await continueJob(id2, { prompt: "round two", sessionID: PARENT }, w2.deps);
  const next2 = w2.job(res2.job.id);
  const done2 = await finishWith(w2, next2.id, [
    ...turn(first2.launch.messageId, [], reportText("- Did: spend — round one VM")),
    { info: { id: next2.launch.messageId, role: "user" }, parts: [] },
    { info: { id: "msg_two", role: "assistant" }, parts: [{ type: "text", text: reportText("- Did: publish — round two gist", "- Blocked: delete — a table") }] },
  ]);
  assert.equal(done2.selfReport, "present");
  assert.deepEqual(done2.exceededActions.map((a) => a.summary), ["round two gist"]);
  assert.deepEqual(done2.blockedActions.map((a) => a.summary), ["a table"]);
  void child;
});

test("project actions: projectPatterns, selfReport and the base ruleset stay on the box — never in a start, continue, resume or list response", async () => {
  const w = withPage(specialistWorld(BAL));
  const res = await startJob(input(autonomyInput(w, { requestedBy: "manta", turnKey: "msg_u1" })), w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const secrets = ["projectPatterns", "selfReport", "basePermission"];
  const clean = (v, label) => {
    const text = JSON.stringify(v);
    for (const k of secrets) assert.equal(text.includes(`"${k}"`), false, `${label}: ${k}`);
  };
  clean(res, "start");
  const id = res.job.id;
  assert.ok(w.job(id).projectPatterns.length > 0 && w.job(id).basePermission, "…while the record keeps them");
  const done = await finishWith(w, id, turn(w.job(id).launch.messageId, [], "ok"));
  assert.equal(done.selfReport, "missing");
  clean(await listJobs({ sessionID: PARENT }, { load: w.deps.load }), "list");
  const cont = await continueJob(id, { prompt: "again", sessionID: PARENT }, w.deps);
  assert.equal(cont.ok, true, JSON.stringify(cont));
  clean(cont, "continue");
  const eng = createDelegateEngine(w.deps);
  clean(await eng.listJobs({ sessionID: PARENT }), "engine list");

  const p = withPage(specialistWorld(BAL));
  const pid = await pausedJob(p, autonomyInput(p));
  clean(await resumeJob(pid, p.deps), "resume");
});

// ---------------------------------------------------------------------------
// Agents Phase 5A: the Architect's task — capability stamp and ruleset
// ---------------------------------------------------------------------------

const ARCH_DIR = `${HOME}/.manta/agents/architect`;
const archInput = (w, extra = {}) =>
  autonomyInput(w, { agent: "agent-architect", isolation: "none", agentName: "Architect", agentDir: ARCH_DIR, architect: { mode: "build" }, requestedBy: "manta", turnKey: "msg_u1", allowPr: false, request: "Make an agent", ...extra });
const ruleAt = (rules, permission, pattern, action) => rules.findIndex((r) => r.permission === permission && r.pattern === pattern && r.action === action);

test("Architect launch: stamped {rootJobId = its own id, attempt 1, mode}; the ruleset is deny-first, allows, jobRules(noSecrets), explicit denies, question deny", async () => {
  const w = specialistWorld();
  const id = await start(w, archInput(w));
  const job = w.job(id);
  assert.deepEqual(job.architect, { rootJobId: id, attempt: 1, mode: "build" });
  const rules = job.permission;
  assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
  assert.deepEqual(rules.at(-1), q);
  for (const t of ["research_fetch", "research_read", "research_search", "agent_propose", "todowrite", "progress_report"]) assert.ok(ruleAt(rules, t, "*", "allow") > 0, t);
  for (const t of ["read", "glob", "grep", "list", "websearch"]) assert.ok(ruleAt(rules, t, "**", "allow") > 0, t);
  assert.ok(ruleAt(rules, "external_directory", `${ARCH_DIR}/**`, "allow") > 0);
  assert.ok(ruleAt(rules, "external_directory", `${HOME}/.local/share/opencode/tool-output/*`, "allow") > 0);
  // the explicit denies come LAST (after every allow, jobRules included), so no earlier allow can win
  const lastAllow = rules.map((r) => r.action).lastIndexOf("allow");
  for (const t of ["bash", "edit", "write", "patch", "webfetch"]) {
    for (const p of ["*", "**"]) assert.ok(ruleAt(rules, t, p, "deny") > lastAllow, `${t} ${p}`);
  }
  assert.deepEqual(rules, normalizeJobRuleset(buildArchitectRulesetFor(job, BAL)));
  assert.deepEqual(w.calls.create[0].permission, rules, "the child is created with exactly this ruleset");
  // an unstamped specialist is untouched; a non-specialist can't carry the stamp
  const dev = specialistWorld();
  const did = await start(dev, autonomyInput(dev));
  assert.equal("architect" in dev.job(did), false);
  const plain = world();
  const pid = await start(plain, { agent: "agent-architect", isolation: "none", architect: { mode: "build" } });
  assert.equal("architect" in plain.job(pid), false, "the stamp needs a specialist launch");
});
const buildArchitectRulesetFor = (job, policy) => buildArchitectRuleset({ policy, agentDir: ARCH_DIR, home: HOME, projectPatterns: [], sessionID: job.childSessionID });

test("Architect ruleset: no bash allow survives (secret patterns included), nothing under ~/.manta-secrets is allowed to ANY tool, edit / write / webfetch are denied", () => {
  const rules = buildArchitectRuleset({ policy: BAL, agentDir: ARCH_DIR, home: HOME, sessionID: "ses_child1" });
  assert.equal(rules.some((r) => r.permission === "bash" && r.action === "allow"), false);
  const secretsAllows = rules.filter((r) => r.action === "allow" && r.pattern.includes(".manta-secrets"));
  assert.deepEqual(secretsAllows, [], "no handed-secret exception of any kind");
  for (const p of ["read", "glob", "grep", "list", "edit", "write"]) {
    assert.ok(ruleAt(rules, p, `${HOME}/.manta-secrets`, "deny") > 0, p);
    assert.ok(ruleAt(rules, p, `${HOME}/.manta-secrets/**`, "deny") > 0, p);
  }
  assert.ok(ruleAt(rules, "external_directory", `${HOME}/.manta-secrets/**`, "deny") > 0);
  for (const t of ["edit", "write", "patch", "webfetch", "bash"]) assert.ok(ruleAt(rules, t, "*", "deny") >= 0, t);
  // a normal specialist still gets its handed-secret exceptions: the option is the only difference
  assert.ok(jobRules(BAL, { home: HOME, agentDir: ARCH_DIR, sessionID: "ses_child1" }).some((r) => r.action === "allow" && r.pattern.includes(".manta-secrets")));
  const noSecrets = jobRules(BAL, { home: HOME, agentDir: ARCH_DIR, sessionID: "ses_child1", noSecrets: true });
  assert.deepEqual(noSecrets.filter((r) => r.action === "allow" && r.pattern.includes(".manta-secrets")), []);
  assert.deepEqual(noSecrets.filter((r) => r.permission === "bash" && r.action === "allow"), []);
  assert.ok(noSecrets.some((r) => r.permission === "bash" && r.pattern === "*.manta-secrets*" && r.action === "deny"));
});

test("Architect resume: a fresh child, the ruleset from the SAME builder under the current settings, the stamp keeps its root and the round's mode is unknown", async () => {
  const w = specialistWorld(BAL);
  const id = await pausedJob(w, archInput(w));
  const before = structuredClone(w.job(id));
  assert.equal(before.architect.mode, "build");
  w.state.policy = AUT;
  const res = await resumeJob(id, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  const job = w.job(id);
  assert.deepEqual(job.architect, { rootJobId: id, attempt: 2, mode: "unknown" });
  assert.equal(job.attempt, 2);
  assert.deepEqual(job.permission, normalizeJobRuleset(buildArchitectRuleset({ policy: AUT, agentDir: ARCH_DIR, home: HOME, projectPatterns: [], sessionID: job.childSessionID })));
  assert.ok(job.permission.every((r) => !(r.permission === "bash" && r.action === "allow")));
  assert.ok(!job.permission.some((r) => r.pattern.includes(before.childSessionID)));
});

test("Architect continuation: the root is copied from the predecessor (it survives pruning), attempt follows, the mode comes from the verified call — else unknown", async () => {
  const w = specialistWorld();
  const id = await finishedSpecialist(w, archInput(w));
  const first = await continueJob(id, { prompt: "again", sessionID: PARENT, architect: { mode: "plan" } }, w.deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.job.architect, { rootJobId: id, attempt: 2, mode: "plan" });
  const child = first.job.childSessionID;
  w.finish(child, "succeeded", T0 + 5);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const second = await continueJob(first.job.id, { prompt: "and again", sessionID: PARENT }, w.deps); // no verified call
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.job.architect, { rootJobId: id, attempt: 3, mode: "unknown" });
  assert.equal(second.job.continues, first.job.id);
  // a continuation of an ordinary specialist task never gains a stamp
  const dev = specialistWorld();
  const did = await finishedSpecialist(dev);
  const cont = await continueJob(did, { prompt: "again", sessionID: PARENT, architect: { mode: "build" } }, dev.deps);
  assert.equal("architect" in cont.job, false);
});

test("Architect jobs tell the agents engine when they end — finished, failed or stopped — and no other job does", async () => {
  const w = specialistWorld();
  const ended = [];
  w.deps.onJobEnded = async (job) => ended.push({ id: job.id, status: job.status });
  const done = await start(w, archInput(w));
  const child = w.job(done).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const stopped = await start(w, archInput(w, { requestedBy: undefined, turnKey: undefined }));
  await stopJob(stopped, w.deps);
  const failed = await start(w, archInput(w));
  w.finish(w.job(failed).childSessionID, "failed", T0 + 2);
  await w.engine.observeRaw(raw("session.execution.failed", w.job(failed).childSessionID));
  assert.deepEqual(ended.map((e) => e.status).sort(), ["done", "failed", "stopped"]);
  const dev = await start(w, autonomyInput(w));
  await stopJob(dev, w.deps);
  assert.equal(ended.length, 3, "an ordinary specialist job doesn't notify");
});

test("Architect outcome: what the agents engine returns when the job ends is in the result posted to the parent", async () => {
  const w = specialistWorld();
  let hookFails = false; // the engine keeps the deps it first saw, so the hook itself switches behaviour
  w.deps.onJobEnded = async () => {
    if (hookFails) throw new Error("boom");
    return { outcome: ["Outcome: @cro was created and is live (your setting: Tell me). Undo is on the card."] };
  };
  const id = await start(w, archInput(w));
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(w.calls.synth.length, 1);
  assert.ok(w.calls.synth[0].body.text.includes("Outcome: @cro was created and is live (your setting: Tell me). Undo is on the card."));
  assert.deepEqual(w.job(id).architectOutcome, ["Outcome: @cro was created and is live (your setting: Tell me). Undo is on the card."]);
  // a stop too
  const stopped = await start(w, archInput(w, { requestedBy: undefined, turnKey: undefined }));
  await stopJob(stopped, w.deps);
  assert.ok(w.calls.synth.at(-1).body.text.includes("Outcome: @cro"));
  // an ending hook that fails or returns nothing adds no line and still delivers
  hookFails = true;
  const third = await start(w, archInput(w, { requestedBy: undefined, turnKey: undefined }));
  w.finish(w.job(third).childSessionID, "succeeded", T0 + 3);
  await w.engine.observeRaw(raw("session.execution.succeeded", w.job(third).childSessionID));
  assert.equal(w.calls.synth.length, 3);
  assert.ok(!w.calls.synth.at(-1).body.text.includes("Outcome:"));
});

// ---------------------------------------------------------------------------
// the research library (docs/superpowers/specs/2026-11-24-research-library.md): every specialist may research
// ---------------------------------------------------------------------------
const RESEARCH_TOOLS = ["research_fetch", "research_read", "research_search", "research_library_find", "research_library_save"];
const hasResearch = (rules) => RESEARCH_TOOLS.every((t) => rules.some((r) => r.permission === t && r.pattern === "*" && r.action === "allow"));

test("research tools: the read-only and worktree rulesets allow research and the library, after the catch-all deny", () => {
  for (const rules of [buildReadOnlyAgentRuleset({ home: "/h" }), buildWorktreeAgentRuleset({ home: "/h" })]) {
    assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
    assert.ok(hasResearch(rules));
    for (const t of RESEARCH_TOOLS) assert.ok(ruleAt(rules, t, "*", "allow") > 0, `${t} sits under the deny`);
    assert.equal(rules.some((r) => r.permission === "agent_propose"), false, "agent_propose stays the Architect's");
  }
});

test("research tools: a launched specialist job — read-only, worktree, or with an approval-edited grant list — carries them; the base is persisted with them", async () => {
  const ro = specialistWorld();
  const roId = await start(ro, autonomyInput(ro, { isolation: "none" }));
  assert.ok(hasResearch(ro.job(roId).permission));
  assert.ok(hasResearch(ro.job(roId).basePermission));
  const wt = specialistWorld();
  const wtId = await start(wt, autonomyInput(wt));
  assert.ok(hasResearch(wt.job(wtId).permission));
  // the approval card's edited grants arrive as `permission` (startJobWithApproval): research still rides along, under the deny
  const edited = specialistWorld();
  const edId = await start(edited, autonomyInput(edited, { permission: [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }] }));
  const rules = edited.job(edId).permission;
  assert.ok(hasResearch(rules));
  assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
  assert.ok(ruleAt(rules, "bash", "**", "allow") > 0);
  assert.deepEqual(rules.at(-1), q);
});

test("research tools: the Architect's ruleset also allows the library tools, and still denies bash, edit and webfetch last", () => {
  const rules = buildArchitectRuleset({ policy: BAL, agentDir: ARCH_DIR, home: HOME, sessionID: "ses_child1" });
  assert.ok(hasResearch(rules));
  assert.ok(ruleAt(rules, "agent_propose", "*", "allow") > 0);
  const lastAllow = rules.map((r) => r.action).lastIndexOf("allow");
  for (const t of ["bash", "edit", "write", "patch", "webfetch"]) assert.ok(ruleAt(rules, t, "*", "deny") > lastAllow, t);
});

// ---------------------------------------------------------------------------
// ask_user (docs/superpowers/specs/2026-11-24-ask-user-tool.md): a task that asks ends as "needs a decision" with the question stored
// ---------------------------------------------------------------------------
const ASK = {
  question: "Create @pricing-copy as its own agent?",
  options: [
    { label: "Add it to @conversion-cro", description: "One agent keeps the pricing rules." },
    { label: "Create @pricing-copy", description: "A separate agent, as asked." },
  ],
  recommended: 0,
  why: "Library entry 'agent design', 2 days old.",
  concern: true,
  at: T0,
};

test("ask_user tool: every specialist ruleset allows it under the catch-all deny; the Architect's too; so does an edited grant list", () => {
  for (const rules of [buildReadOnlyAgentRuleset({ home: "/h" }), buildWorktreeAgentRuleset({ home: "/h" }), buildArchitectRuleset({ policy: BAL, agentDir: ARCH_DIR, home: HOME, sessionID: "ses_child1" })]) {
    assert.deepEqual(rules[0], { permission: "*", pattern: "**", action: "deny" });
    assert.ok(ruleAt(rules, "ask_user", "*", "allow") > 0, "allowed under the deny");
  }
  const edited = withResearchToolAllows([{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }]);
  assert.ok(ruleAt(edited, "ask_user", "*", "allow") > 0);
});

test("ask_user tool: a launched specialist task (read-only, worktree, approval-edited grants) carries the permission, and the base is persisted with it", async () => {
  const ro = specialistWorld();
  const roId = await start(ro, autonomyInput(ro, { isolation: "none" }));
  assert.ok(ruleAt(ro.job(roId).permission, "ask_user", "*", "allow") > 0);
  assert.ok(ruleAt(ro.job(roId).basePermission, "ask_user", "*", "allow") > 0);
  const wt = specialistWorld();
  const wtId = await start(wt, autonomyInput(wt));
  assert.ok(ruleAt(wt.job(wtId).permission, "ask_user", "*", "allow") > 0);
  const edited = specialistWorld();
  const edId = await start(edited, autonomyInput(edited, { permission: [{ permission: "*", pattern: "**", action: "deny" }, { permission: "bash", pattern: "**", action: "allow" }] }));
  assert.ok(ruleAt(edited.job(edId).permission, "ask_user", "*", "allow") > 0);
});

test("ask_user: recording the question marks the running task blocked and stores it; a task that is not running stores nothing", async () => {
  const w = liveWorld();
  const id = await start(w);
  assert.ok(await w.engine.recordAskUser(id, ASK));
  assert.deepEqual(w.job(id).askUser, ASK);
  assert.equal(w.job(id).jobProgress.modelState, "blocked");
  assert.equal(await w.engine.recordAskUser("nope", ASK), null);
  const child = w.job(id).childSessionID;
  w.finish(child, "succeeded", T0 + 9);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(await w.engine.recordAskUser(id, { ...ASK, question: "later?" }), null, "an ended task keeps the question it ended with");
  assert.equal(w.job(id).askUser.question, ASK.question);
});

test("ask_user: a task that asked ends `needs a decision` even if it carried on working; the result has the server-written block and the metadata carries the question", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  await w.engine.recordAskUser(id, ASK);
  // the model reports "working" again after asking: the stored question still decides
  await w.engine.reportJobProgress({ sessionID: child, input: { label: "carrying on" }, record: { state: "working" } });
  w.say(child, "I asked; waiting.");
  w.finish(child, "succeeded", T0 + 9);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  const j = w.job(id);
  assert.equal(j.status, "done");
  assert.equal(j.endedBlocked, true);
  const body = w.calls.synth[0].body;
  assert.match(body.text, /^\[background job "[^"]+" needs a decision\]/);
  for (const line of askUserLines(ASK)) assert.ok(body.text.includes(line), line);
  assert.ok(body.text.indexOf("I asked; waiting.") < body.text.indexOf(ASK_USER_HEADER), "the block follows the agent's own text");
  assert.deepEqual(body.metadata.manta.askUser, { question: ASK.question, options: ASK.options, recommended: 0, why: ASK.why, concern: true });
});

test("ask_user: a task that failed or was stopped carries no question block; a plain done task has none", async () => {
  const done = liveWorld();
  const doneId = await start(done);
  const dc = done.job(doneId).childSessionID;
  done.say(dc, "all good");
  done.finish(dc, "succeeded", T0 + 9);
  await done.engine.observeRaw(raw("session.execution.succeeded", dc));
  assert.ok(!done.calls.synth[0].body.text.includes(ASK_USER_HEADER));
  assert.equal("askUser" in done.calls.synth[0].body.metadata.manta, false);
  assert.ok(!buildCompletionText({ name: "n", status: "failed", error: "boom", askUser: ASK, endedBlocked: false }).includes(ASK_USER_HEADER));
  assert.ok(buildCompletionText({ name: "n", status: "done", result: "r", askUser: ASK, endedBlocked: true }).includes(ASK_USER_HEADER));
});

test("ask_user: the next round (continueJob) starts with no question and no blocked state", async () => {
  const w = liveWorld();
  const id = await start(w);
  const child = w.job(id).childSessionID;
  await w.engine.recordAskUser(id, ASK);
  w.finish(child, "succeeded", T0 + 1);
  await w.engine.observeRaw(raw("session.execution.succeeded", child));
  assert.equal(w.job(id).completionDelivery, "delivered");
  const res = await continueJob(id, { prompt: "the user chose option 1", sessionID: PARENT }, w.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.job.askUser, undefined);
  assert.equal(res.job.endedBlocked, false);
  assert.equal(res.job.jobProgress.modelState ?? null, null);
});
