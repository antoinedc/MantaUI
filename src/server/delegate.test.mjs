import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobPrompt,
  buildCompletionText,
  deriveName,
  resolveOwner,
  startJob,
  observeEvent,
  finishJob,
  sweepDelegateJobs,
  deleteJob,
  MAX_RUNNING_JOBS,
} from "./delegate.mjs";

// ----------------------------------------------------------------------------
// Harness: in-memory load/save on a closure-held array, recorded publish +
// deliver. Mirrors the harness style of capabilities.test.mjs / schedule.test.
// No real tmux, no real opencode, no real git.
// ----------------------------------------------------------------------------

function harness(initialJobs = [], fixedNow = 1_700_000_000_000) {
  let jobs = initialJobs.map((j) => ({ ...j }));
  const published = [];
  const delivered = [];
  let nowMs = fixedNow;
  const deps = {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => {
      jobs = next.map((j) => ({ ...j }));
    },
    publish: (evt) => published.push(evt),
    deliver: async (args) => {
      delivered.push(args);
      return { delivered: true, queued: false };
    },
    listMessages: async () => [],
    gitRun: async () => ({ stdout: "" }),
    now: () => nowMs,
    setNow: (n) => { nowMs = n; },
  };
  return {
    deps,
    published,
    delivered,
    setNow: (n) => { nowMs = n; },
    get jobs() { return jobs; },
  };
}

const CAP_ERROR =
  "too many background jobs running (5). Do not retry — either wait for one to finish, or do this work yourself.";

// ----------------------------------------------------------------------------
// 1. buildJobPrompt — with and without a worktree
// ----------------------------------------------------------------------------

test("buildJobPrompt includes the git paragraph when a worktree is present", () => {
  const out = buildJobPrompt({
    prompt: "Fix the login bug",
    worktree: "/repo/wt-login",
    branch: "fix-login",
  });
  assert.match(out, /^Fix the login bug\n\n---\n/);
  assert.ok(out.includes("You are running as a background job."));
  assert.ok(out.includes("/repo/wt-login"));
  assert.ok(out.includes("branch fix-login"));
  assert.ok(out.includes("Commit your work to that branch before you finish."));
  assert.ok(out.includes("Do not push, do not open a"));
  assert.ok(out.includes("When you are done, end with a short summary"));
});

test("buildJobPrompt omits the git paragraph when there is no worktree", () => {
  const out = buildJobPrompt({ prompt: "Summarize the docs", worktree: null, branch: null });
  assert.match(out, /^Summarize the docs\n\n---\n/);
  assert.ok(out.includes("You are running as a background job."));
  assert.ok(!out.includes("git worktree"));
  assert.ok(!out.includes("Commit your work"));
  assert.ok(out.includes("When you are done, end with a short summary"));
});

// ----------------------------------------------------------------------------
// 2. buildCompletionText — done, failed, stopped, no-worktree
// ----------------------------------------------------------------------------

test("buildCompletionText done with a worktree", () => {
  const text = buildCompletionText({
    name: "fix-login", status: "done", branch: "fix-login",
    worktree: "/repo/wt-login", filesChanged: 3, result: "fixed it",
  });
  assert.equal(text, [
    '[background job "fix-login" done]',
    "Branch: fix-login (3 files changed)",
    "Worktree: /repo/wt-login",
    "",
    "fixed it",
  ].join("\n"));
});

test("buildCompletionText failed replaces result with Error", () => {
  const text = buildCompletionText({
    name: "fix-login", status: "failed", branch: "b", worktree: "/w",
    filesChanged: 0, error: "boom",
  });
  assert.ok(text.startsWith('[background job "fix-login" failed]'));
  assert.ok(text.includes("Error: boom"));
  assert.ok(!text.includes("undefined"));
});

test("buildCompletionText stopped uses Error too", () => {
  const text = buildCompletionText({
    name: "bg", status: "stopped", worktree: null, error: "stopped by user",
  });
  assert.ok(text.startsWith('[background job "bg" stopped]'));
  assert.ok(text.includes("Error: stopped by user"));
  // no worktree → no Branch/Worktree lines
  assert.ok(!text.includes("Branch:"));
  assert.ok(!text.includes("Worktree:"));
});

test("buildCompletionText no-worktree done omits Branch/Worktree lines", () => {
  const text = buildCompletionText({
    name: "sum", status: "done", worktree: null, result: "done summary",
  });
  assert.equal(text, [
    '[background job "sum" done]',
    "",
    "done summary",
  ].join("\n"));
});

test("buildCompletionText timeout status is failed with the timeout error", () => {
  const text = buildCompletionText({
    name: "bg", status: "failed", worktree: "/w", branch: "b", filesChanged: 0,
    error: "timed out after 30 minutes",
  });
  assert.ok(text.startsWith('[background job "bg" failed]'));
  assert.ok(text.includes("Error: timed out after 30 minutes"));
});

// ----------------------------------------------------------------------------
// 8. Name derivation from a long prompt (placed early, pure)
// ----------------------------------------------------------------------------

test("deriveName takes the first four words and slugifies", () => {
  assert.equal(
    deriveName("Fix the login bug by updating auth.ts and the session store"),
    "fix-the-login-bug",
  );
});

test("deriveName falls back to a slug for symbol-heavy prompts", () => {
  assert.equal(deriveName("!!! ??? @@@ something"), "something");
  assert.equal(deriveName("   "), "background");
});

// ----------------------------------------------------------------------------
// resolveOwner helper
// ----------------------------------------------------------------------------

test("resolveOwner finds the tmux session owning a session id", () => {
  const projects = [
    { tmuxSession: "proj-a", windows: [{ index: 0, opencodeSessionId: "ses_x", paneCurrentPath: "/a" }] },
    { tmuxSession: "proj-b", windows: [{ index: 1, opencodeSessionId: "ses_parent", paneCurrentPath: "/b" }] },
  ];
  assert.deepEqual(resolveOwner(projects, "ses_parent"), {
    tmuxSession: "proj-b", windowIndex: 1, cwd: "/b",
  });
  assert.equal(resolveOwner(projects, "ses_missing"), null);
});

// ----------------------------------------------------------------------------
// 3. The cap: a sixth concurrent start is refused with the exact error string
// ----------------------------------------------------------------------------

function runningJob(i) {
  return {
    id: `r${i}`, name: `job${i}`, prompt: "p", model: null,
    parentSessionID: `parent${i}`, parentDirectory: "/repo",
    childSessionID: `child${i}`, tmuxSession: "s", windowIndex: i,
    worktree: null, branch: null, baseSha: null,
    status: "running", activity: null,
    createdAt: 1, startedAt: 1, finishedAt: null,
    result: null, error: null, filesChanged: null,
  };
}

test("startJob refuses a sixth concurrent job with the exact cap error", async () => {
  const h = harness(Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => runningJob(i)));
  const res = await startJob(
    { prompt: "extra work", parentSessionID: "parentX", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, CAP_ERROR);
  // nothing persisted
  assert.equal(h.jobs.length, MAX_RUNNING_JOBS);
  assert.equal(h.delivered.length, 0);
});

test("startJob allows a job when under the cap", async () => {
  const h = harness(Array.from({ length: MAX_RUNNING_JOBS - 1 }, (_, i) => runningJob(i)));
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 0, name: "parent", opencodeSessionId: "parentX", paneCurrentPath: "/repo" };
  const childWin = { index: 9, name: "extra-work", opencodeSessionId: "child-new", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async (input) => [
    { tmuxSession: input.sessionName, windows: [parentWin, childWin] },
  ];
  const res = await startJob(
    { prompt: "extra work", parentSessionID: "parentX", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(res.job.status, "running");
  assert.equal(h.jobs.length, MAX_RUNNING_JOBS);
});

// ----------------------------------------------------------------------------
// 4. Nesting: a start whose parentSessionID is a live job's childSessionID
// ----------------------------------------------------------------------------

test("startJob refuses nesting when parentSessionID is a live job's childSessionID", async () => {
  const live = { ...runningJob(0), childSessionID: "child_live", status: "running" };
  const h = harness([live]);
  const res = await startJob(
    { prompt: "nested work", parentSessionID: "child_live", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "a background job cannot start another background job");
  assert.equal(h.jobs.length, 1);
  assert.equal(h.delivered.length, 0);
});

test("startJob allows nesting when the blocking job is terminal", async () => {
  const done = { ...runningJob(0), childSessionID: "child_done", status: "done", finishedAt: 2 };
  const h = harness([done]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 1, name: "p", opencodeSessionId: "child_done", paneCurrentPath: "/repo" };
  const childWin = { index: 5, name: "nested-work", opencodeSessionId: "c2", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async (input) => [
    { tmuxSession: input.sessionName, windows: [parentWin, childWin] },
  ];
  const res = await startJob(
    { prompt: "nested work", parentSessionID: "child_done", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
});

// ----------------------------------------------------------------------------
// 7. Rollback: a throw at the window-creation step removes the worktree
// ----------------------------------------------------------------------------

test("startJob rolls back the worktree when window creation throws", async () => {
  const h = harness([]);
  let worktreeCreated = null;
  h.deps.gitAddWorktree = async ({ cwd, name }) => {
    worktreeCreated = { path: `/repo/wt-${name}`, branch: name };
    return worktreeCreated;
  };
  h.deps.gitRun = async (args) => ({ stdout: "abc123\n" }); // baseSha
  const parentWin = { index: 0, name: "parent", opencodeSessionId: "parent", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async () => { throw new Error("tmux new-window exploded"); };
  const removed = [];
  h.deps.gitRemoveWorktree = async (input) => { removed.push(input); return { removed: true }; };

  const res = await startJob(
    { prompt: "do work", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /tmux new-window exploded/);
  // worktree was created then removed on rollback
  assert.ok(worktreeCreated, "worktree was created");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].path, worktreeCreated.path);
  assert.equal(removed[0].force, false);
  // no job persisted
  assert.equal(h.jobs.length, 0);
  assert.equal(h.delivered.length, 0);
});

// ----------------------------------------------------------------------------
// 5. observeEvent: idle before any busy does NOT complete; busy then idle DOES
// ----------------------------------------------------------------------------

function runningObserverJob() {
  return {
    id: "j1", name: "bg", prompt: "p", model: null,
    parentSessionID: "parent", parentDirectory: "/repo",
    childSessionID: "child", tmuxSession: "s", windowIndex: 1,
    worktree: null, branch: null, baseSha: null,
    status: "running", activity: null,
    createdAt: 1, startedAt: 1, finishedAt: null,
    result: null, error: null, filesChanged: null,
  };
}

test("observeEvent: idle before any busy does NOT complete the job", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  // stray idle arrives before the opening prompt lands
  await observeEvent({ type: "session.idle", properties: { sessionID: "child" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

test("observeEvent: busy then idle DOES complete the job as done", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  h.deps.listMessages = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
  ];
  h.deps.gitRun = async () => ({ stdout: "" }); // no worktree → filesChanged null
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  await observeEvent({ type: "session.idle", properties: { sessionID: "child" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
  assert.equal(h.jobs[0].result, "all done");
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, "parent");
  assert.match(h.delivered[0].text, /\[background job "bg" done\]/);
});

test("observeEvent: session.status idle (not session.idle) also completes after busy", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
});

// ----------------------------------------------------------------------------
// 6. observeEvent: session.error fails the job, MessageAbortedError ignored
// ----------------------------------------------------------------------------

test("observeEvent: session.error fails the job", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({
    type: "session.error",
    properties: { sessionID: "child", error: { name: "ProviderAuthError", message: "bad key" } },
  }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "failed");
  assert.equal(h.jobs[0].error, "bad key");
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].text, /failed/);
  assert.match(h.delivered[0].text, /Error: bad key/);
});

test("observeEvent: MessageAbortedError is ignored (intentional abort)", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({
    type: "session.error",
    properties: { sessionID: "child", error: { name: "MessageAbortedError", message: "aborted" } },
  }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

test("observeEvent ignores events for untracked sessions", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.idle", properties: { sessionID: "other" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
});

// ----------------------------------------------------------------------------
// 9. Sweeper marks a 31-minute-old running job failed, leaves worktree intact
// ----------------------------------------------------------------------------

test("sweeper marks a 31-minute-old running job failed with the timeout error", async () => {
  const started = 1_700_000_000_000;
  const h = harness([{
    ...runningObserverJob(),
    id: "old", startedAt: started, worktree: "/repo/wt-old", branch: "old",
    baseSha: "abc",
  }], started + 31 * 60_000); // 31 minutes later
  h.deps.gitRun = async () => ({ stdout: "" });
  await sweepDelegateJobs(h.deps);
  assert.equal(h.jobs[0].status, "failed");
  assert.equal(h.jobs[0].error, "timed out after 30 minutes");
  // worktree field left intact (sweeper NEVER removes the worktree)
  assert.equal(h.jobs[0].worktree, "/repo/wt-old");
  assert.equal(h.jobs[0].branch, "old");
  // completion delivered to parent
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].text, /timed out after 30 minutes/);
});

test("sweeper leaves a job younger than 30 minutes running", async () => {
  const started = 1_700_000_000_000;
  const h = harness([{
    ...runningObserverJob(), id: "young", startedAt: started,
  }], started + 10 * 60_000);
  await sweepDelegateJobs(h.deps);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

// ----------------------------------------------------------------------------
// 10. deleteJob on a dirty worktree keeps worktree + record, reports dirty
// ----------------------------------------------------------------------------

test("deleteJob on a dirty worktree keeps the worktree and the record", async () => {
  const job = {
    ...runningObserverJob(), id: "d1", status: "done",
    worktree: "/repo/wt-dirty", branch: "dirty", finishedAt: 2,
    tmuxSession: "s", windowIndex: 3,
  };
  const h = harness([job]);
  const killed = [];
  h.deps.killWindow = async (input) => { killed.push(input); };
  h.deps.gitRemoveWorktree = async () => ({ removed: false, reason: "dirty" });

  const res = await deleteJob("d1", h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "dirty");
  // window was killed (best-effort) ...
  assert.equal(killed.length, 1);
  // ... but the worktree removal refused, so the record MUST be kept
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].id, "d1");
  assert.equal(h.jobs[0].worktree, "/repo/wt-dirty");
});

test("deleteJob removes the record when the worktree removes cleanly", async () => {
  const job = {
    ...runningObserverJob(), id: "d2", status: "done",
    worktree: "/repo/wt-clean", branch: "clean", finishedAt: 2,
    tmuxSession: "s", windowIndex: 4,
  };
  const h = harness([job]);
  h.deps.killWindow = async () => {};
  h.deps.gitRemoveWorktree = async () => ({ removed: true });
  const res = await deleteJob("d2", h.deps);
  assert.equal(res.ok, true);
  assert.equal(h.jobs.length, 0);
  assert.ok(h.published.some((e) => e.payload?.id === "d2" && e.payload?.status === "deleted"));
});

test("deleteJob on a job with no worktree just drops the record", async () => {
  const job = { ...runningObserverJob(), id: "d3", status: "done", worktree: null, finishedAt: 2 };
  const h = harness([job]);
  h.deps.killWindow = async () => {};
  const res = await deleteJob("d3", h.deps);
  assert.equal(res.ok, true);
  assert.equal(h.jobs.length, 0);
});

test("deleteJob returns not-found for an unknown id", async () => {
  const h = harness([]);
  h.deps.killWindow = async () => {};
  const res = await deleteJob("nope", h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "not found");
});

// ----------------------------------------------------------------------------
// startJob happy path (no worktree) persists + delivers the opening prompt
// ----------------------------------------------------------------------------

test("startJob happy path (non-git cwd) persists a running job and delivers the prompt", async () => {
  const h = harness([]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 1, name: "parent-h", opencodeSessionId: "parent-h", paneCurrentPath: "/repo" };
  const childWin = { index: 2, name: "fix-the-login-bug", opencodeSessionId: "child-h", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "proj", windows: [parentWin] }];
  h.deps.newWindow = async (input) => [
    { tmuxSession: input.sessionName, windows: [parentWin, childWin] },
  ];
  const res = await startJob(
    { prompt: "Fix the login bug please", parentSessionID: "parent-h", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(res.job.name, "fix-the-login-bug");
  assert.equal(res.job.worktree, null);
  assert.equal(res.job.branch, null);
  assert.equal(res.job.baseSha, null);
  assert.equal(res.job.childSessionID, "child-h");
  assert.equal(res.job.status, "running");
  assert.equal(h.jobs.length, 1);
  // opening prompt delivered to the child session
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, "child-h");
  assert.match(h.delivered[0].text, /Fix the login bug please/);
  assert.doesNotMatch(h.delivered[0].text, /git worktree/);
});

// ----------------------------------------------------------------------------
// finishJob filesChanged counts committed + uncommitted (with a worktree)
// ----------------------------------------------------------------------------

test("finishJob counts committed + uncommitted files when a worktree exists", async () => {
  const job = {
    ...runningObserverJob(), id: "fc", worktree: "/repo/wt", branch: "b", baseSha: "sha1",
  };
  const h = harness([job]);
  const sawBusy = new Map();
  h.deps.listMessages = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
  ];
  h.deps.gitRun = async (args) => {
    if (args.includes("diff")) return { stdout: "a.ts\nb.ts\n" }; // 2 committed
    if (args.includes("status")) return { stdout: " M c.ts\n?? d.ts\n" }; // 2 uncommitted
    return { stdout: "" };
  };
  await finishJob(job, "done", null, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
  assert.equal(h.jobs[0].result, "done");
  assert.equal(h.jobs[0].filesChanged, 4);
});

test("finishJob is idempotent for an already-terminal job", async () => {
  const job = { ...runningObserverJob(), id: "idem", status: "done", finishedAt: 9 };
  const h = harness([job]);
  const res = await finishJob(job, "done", null, h.deps, new Map());
  assert.equal(res.ok, true);
  assert.equal(res.alreadyTerminal, true);
  assert.equal(h.delivered.length, 0);
});
