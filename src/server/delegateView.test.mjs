import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDelegateView,
  ReadOnlyJobError,
  READ_ONLY_JOB_MESSAGE,
  APPROVAL_RULES_MESSAGE,
  isReadOnlyJob,
  jobStatusLabel,
  jobSummary,
  jobHeadline,
  jobStatusLine,
  parseModelRef,
  validateApprovalTools,
} from "./delegateView.mjs";

const job = (over = {}) => ({
  id: "job1",
  name: "fix-login",
  childSessionID: "ses_child",
  parentSessionID: "ses_parent",
  status: "running",
  model: "anthropic/claude-sonnet-5-5",
  activity: "editing auth.ts",
  correlation: null,
  worktree: null,
  branch: null,
  filesChanged: null,
  error: null,
  attempt: 1,
  createdAt: 1,
  ...over,
});

const projects = [
  {
    tmuxSession: "proj",
    windows: [
      { index: 0, name: "main", opencodeSessionId: "ses_parent" },
      { index: 1, name: null, opencodeSessionId: "ses_other" },
    ],
  },
];
const models = [{ providerID: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }];

function view(jobs, over = {}) {
  const calls = { models: 0, jobs: 0 };
  const v = createDelegateView({
    listJobs: async () => {
      calls.jobs++;
      return jobs;
    },
    listProjects: async () => projects,
    listModels: async () => {
      calls.models++;
      return models;
    },
    now: () => 1_000,
    ...over,
  });
  return { v, calls };
}

// ---- pure rules -----------------------------------------------------------

test("isReadOnlyJob: delegate and subagent records are read-only, a CTO work worker is not", () => {
  assert.equal(isReadOnlyJob(job()), true);
  assert.equal(isReadOnlyJob(job({ correlation: { kind: "delegate" } })), true);
  assert.equal(isReadOnlyJob(job({ correlation: { kind: "work" } })), false);
  assert.equal(isReadOnlyJob(null), false);
});

test("parseModelRef splits on the first slash only", () => {
  assert.deepEqual(parseModelRef("openai/gpt-4o/mini"), { providerID: "openai", modelID: "gpt-4o/mini" });
  for (const bad of [null, undefined, "", "nomodel", "/x", "x/", 5]) assert.equal(parseModelRef(bad), null);
});

test("jobStatusLabel falls back to 'unknown'", () => {
  assert.equal(jobStatusLabel({ status: "done" }), "done");
  assert.equal(jobStatusLabel({ status: "" }), "unknown");
  assert.equal(jobStatusLabel({}), "unknown");
});

test("jobSummary: files with and without a worktree branch", () => {
  assert.equal(jobSummary({ branch: "fix", filesChanged: 3, worktree: "/wt" }), "fix · 3 files changed");
  assert.equal(jobSummary({ branch: "fix", filesChanged: 1, worktree: "/wt" }), "fix · 1 file changed");
  assert.equal(jobSummary({ branch: null, filesChanged: 5, worktree: null }), "5 files changed");
  assert.equal(jobSummary({ branch: null, filesChanged: 2, worktree: "/wt" }), "2 files changed");
  assert.equal(jobSummary({ branch: "fix", filesChanged: null, worktree: "/wt" }), "fix · 0 files changed");
  assert.equal(jobSummary({ filesChanged: 0 }), "0 files changed");
});

test("jobHeadline with and without a catalog name", () => {
  assert.equal(jobHeadline("Claude Sonnet 5.5"), "Read-only — this is a background job running Claude Sonnet 5.5.");
  assert.equal(jobHeadline(null), "Read-only — this is a background job.");
});

test("jobStatusLine: running shows activity, with a fallback", () => {
  assert.equal(jobStatusLine(job()), "editing auth.ts");
  assert.equal(jobStatusLine(job({ activity: "  " })), "running…");
  assert.equal(jobStatusLine(job({ activity: null })), "running…");
  assert.equal(jobStatusLine(job({ status: "paused", activity: "waiting" })), "waiting");
});

test("jobStatusLine: terminal states", () => {
  assert.equal(jobStatusLine(job({ status: "done", filesChanged: 2, branch: "b", worktree: "/w" })), "b · 2 files changed");
  assert.equal(jobStatusLine(job({ status: "failed", filesChanged: 0, error: "boom" })), "0 files changed · boom");
  assert.equal(jobStatusLine(job({ status: "failed", filesChanged: 0, error: null })), "0 files changed · failed");
  assert.equal(jobStatusLine(job({ status: "stopped", filesChanged: 1, error: "stopped by user" })), "1 file changed · stopped by user");
});

test("validateApprovalTools: undefined ok, empty / blank rejected, filled ok", () => {
  assert.equal(validateApprovalTools(undefined), null);
  assert.equal(validateApprovalTools([]), APPROVAL_RULES_MESSAGE);
  assert.equal(validateApprovalTools(null), APPROVAL_RULES_MESSAGE);
  assert.equal(validateApprovalTools([{ permission: "bash", pattern: "" }]), APPROVAL_RULES_MESSAGE);
  assert.equal(validateApprovalTools([{ permission: " ", pattern: "*" }]), APPROVAL_RULES_MESSAGE);
  assert.equal(validateApprovalTools([{ permission: "bash", pattern: "npm *" }, { permission: "edit" }]), APPROVAL_RULES_MESSAGE);
  assert.equal(validateApprovalTools([{ permission: "bash", pattern: "npm *" }]), null);
});

// ---- jobForSession --------------------------------------------------------

test("jobForSession: a non-job session is writable", async () => {
  const { v } = view([job()]);
  assert.deepEqual(await v.jobForSession("ses_unrelated"), { readOnly: false });
  assert.deepEqual(await v.jobForSession(""), { readOnly: false });
  assert.deepEqual(await v.jobForSession(undefined), { readOnly: false });
});

test("jobForSession: a CTO work worker opens writable", async () => {
  const { v } = view([job({ correlation: { kind: "work" } })]);
  assert.deepEqual(await v.jobForSession("ses_child"), { readOnly: false });
});

test("jobForSession: a delegate job gets the full view with the catalog model name and parent window", async () => {
  const { v } = view([job()]);
  const r = await v.jobForSession("ses_child");
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.job, {
    id: "job1",
    status: "running",
    statusLabel: "running",
    headline: "Read-only — this is a background job running Claude Sonnet 5.5.",
    statusLine: "editing auth.ts",
    parentLine: "It reports to main.",
    stoppable: true,
    parent: { sessionId: "ses_parent", name: "main", project: "proj", windowIndex: 0 },
  });
});

test("jobForSession: model not in the catalogue → no name in the headline", async () => {
  const { v } = view([job({ model: "other/unknown" })]);
  assert.equal((await v.jobForSession("ses_child")).job.headline, "Read-only — this is a background job.");
});

test("jobForSession: a model-less job and a failing catalogue still answer", async () => {
  const a = view([job({ model: null })]);
  assert.equal((await a.v.jobForSession("ses_child")).job.headline, "Read-only — this is a background job.");
  const b = view([job()], { listModels: async () => { throw new Error("down"); } });
  assert.equal((await b.v.jobForSession("ses_child")).job.headline, "Read-only — this is a background job.");
});

test("jobForSession: parent window closed → 'a session that's closed', parent null", async () => {
  const { v } = view([job({ parentSessionID: "ses_gone" })]);
  const r = await v.jobForSession("ses_child");
  assert.equal(r.job.parentLine, "It reports to a session that's closed.");
  assert.equal(r.job.parent, null);
});

test("jobForSession: an unnamed parent window falls back to the tmux session name", async () => {
  const { v } = view([job({ parentSessionID: "ses_other" })]);
  const r = await v.jobForSession("ses_child");
  assert.equal(r.job.parentLine, "It reports to proj.");
  assert.equal(r.job.parent.name, "proj");
});

test("jobForSession: a failing project list loses only the parent", async () => {
  const { v } = view([job()], { listProjects: async () => { throw new Error("tmux down"); } });
  const r = await v.jobForSession("ses_child");
  assert.equal(r.readOnly, true);
  assert.equal(r.job.parent, null);
});

test("jobForSession: a superseded record is ignored in favour of the newest", async () => {
  const { v } = view([
    job({ id: "old", status: "failed", error: "x", supersededBy: "new", correlation: { kind: "work" } }),
    job({ id: "new", status: "running", attempt: 2, createdAt: 5 }),
  ]);
  const r = await v.jobForSession("ses_child");
  assert.equal(r.readOnly, true);
  assert.equal(r.job.id, "new");
});

test("jobForSession: stoppable for running / paused, not for terminal", async () => {
  for (const [status, expected] of [["running", true], ["paused", true], ["done", false], ["failed", false], ["stopped", false]]) {
    const { v } = view([job({ status })]);
    assert.equal((await v.jobForSession("ses_child")).job.stoppable, expected, status);
  }
});

test("jobForSession: terminal views carry the status line and an 'unknown' label for an empty status", async () => {
  const done = view([job({ status: "failed", filesChanged: 0, error: "boom" })]);
  assert.equal((await done.v.jobForSession("ses_child")).job.statusLine, "0 files changed · boom");
  const empty = view([job({ status: "" })]);
  assert.equal((await empty.v.jobForSession("ses_child")).job.statusLabel, "unknown");
});

test("jobForSession accepts the {jobs: []} list shape", async () => {
  const v = createDelegateView({
    listJobs: async () => ({ jobs: [job()] }),
    listProjects: async () => projects,
    listModels: async () => models,
  });
  assert.equal((await v.jobForSession("ses_child")).readOnly, true);
});

test("models are fetched once within the memo window and again after it", async () => {
  let t = 1_000;
  const { v, calls } = view([job()], { now: () => t });
  await v.jobForSession("ses_child");
  await v.jobForSession("ses_child");
  assert.equal(calls.models, 1);
  t += 6 * 60 * 1000;
  await v.jobForSession("ses_child");
  assert.equal(calls.models, 2);
});

// ---- assertWritable -------------------------------------------------------

test("assertWritable throws the 409 error for a read-only job session", async () => {
  const { v } = view([job()]);
  await assert.rejects(
    () => v.assertWritable("ses_child"),
    (e) =>
      e instanceof ReadOnlyJobError &&
      e.rpcStatus === 409 &&
      e.code === "read_only_job" &&
      e.message === READ_ONLY_JOB_MESSAGE,
  );
});

test("assertWritable lets a work job, an ordinary session and a missing id through", async () => {
  const { v } = view([job({ correlation: { kind: "work" } })]);
  await v.assertWritable("ses_child");
  await v.assertWritable("ses_ordinary");
  await v.assertWritable(undefined);
});

test("assertWritable still refuses a TERMINAL job session", async () => {
  const { v } = view([job({ status: "done" })]);
  await assert.rejects(() => v.assertWritable("ses_child"), ReadOnlyJobError);
});

// ---- decorateList ---------------------------------------------------------

test("decorateList adds statusLabel and summary to every row and keeps the rest", () => {
  const { v } = view([]);
  const out = v.decorateList([
    job({ status: "done", filesChanged: 2, branch: "b", worktree: "/w" }),
    job({ id: "j2", status: "" }),
  ]);
  assert.equal(out[0].statusLabel, "done");
  assert.equal(out[0].summary, "b · 2 files changed");
  assert.equal(out[0].id, "job1");
  assert.equal(out[1].statusLabel, "unknown");
  assert.equal(out[1].summary, "0 files changed");
});

test("decorateList passes a non-array through untouched", () => {
  const { v } = view([]);
  assert.deepEqual(v.decorateList({ jobs: [] }), { jobs: [] });
});
