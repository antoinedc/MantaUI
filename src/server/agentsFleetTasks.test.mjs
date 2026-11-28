// The Fleet page's read model (docs/superpowers/specs/2026-11-28-fleet-redesign.md §2.2): what is in progress or paused by the
// user, and what ended today with one plain sentence each. Pure shaping over task records; no stores, no git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedByOf, endedOutcome, localMidnight, shapeFleetTasks, FLEET_ENDED_MAX } from "./agentsFleetTasks.mjs";

const NOW = new Date(2026, 10, 28, 15, 30).getTime(); // a Saturday afternoon, box-local
const MIN = 60_000;
const HOUR = 60 * MIN;

let n = 0;
const job = (over = {}) => {
  const id = over.id ?? `job_${++n}`;
  return {
    id,
    rootJobId: id,
    name: "fix the build",
    agent: "agent-dev",
    specialist: true,
    parentSessionID: "ses_chat",
    parentDirectory: "/repo/site",
    status: "done",
    isolation: "worktree",
    branch: null,
    filesChanged: null,
    createdAt: NOW - 3 * HOUR,
    startedAt: NOW - 3 * HOUR,
    finishedAt: NOW - HOUR,
    result: "Done.",
    error: null,
    ...over,
  };
};

const slugOf = (j) => (typeof j.agent === "string" ? j.agent.replace(/^agent-/, "") : null);
const shape = (jobs, over = {}) =>
  shapeFleetTasks({
    rounds: jobs,
    now: NOW,
    slugOfJob: slugOf,
    projectOf: () => ({ slug: "site-aaaaaaaaaa", name: "Site" }),
    verdictOf: () => null,
    proposalWaiting: () => false,
    stillNeedsYou: () => false,
    boxRunning: 0,
    cap: 10,
    ...over,
  });

test("localMidnight: the start of the box's calendar day", () => {
  assert.equal(localMidnight(NOW), new Date(2026, 10, 28).getTime());
});

test("askedByOf: a refresh / check-up task is a routine, a handoff is Manta (with its chat), the rest is the user", () => {
  assert.deepEqual(askedByOf(job({ deliverResult: false })), { by: "routine" });
  assert.deepEqual(askedByOf(job({ requestedBy: "manta" })), { by: "manta", sessionId: "ses_chat" });
  assert.deepEqual(askedByOf(job({ requestedBy: "manta", parentSessionID: "" })), { by: "manta", sessionId: null });
  assert.deepEqual(askedByOf(job()), { by: "you" });
});

test("shapeFleetTasks: running and paused tasks only; paused is 'paused by you'; newest first within a status", () => {
  const out = shape([
    job({ id: "r1", status: "running", finishedAt: null, startedAt: NOW - 10 * MIN, branch: "agent/dev/a" }),
    job({ id: "p1", status: "paused", finishedAt: null, pausedAt: NOW - 2 * HOUR }),
    job({ id: "r2", status: "running", finishedAt: null, startedAt: NOW - 5 * MIN }),
    job({ id: "d1" }),
    job({ id: "x", status: "running", specialist: false, finishedAt: null }),
  ]);
  assert.deepEqual(out.running.map((t) => [t.jobId, t.status]), [["r2", "in-progress"], ["r1", "in-progress"], ["p1", "paused-by-you"]]);
  const p = out.running.find((t) => t.jobId === "p1");
  assert.equal(p.pausedAt, NOW - 2 * HOUR);
  const r1 = out.running.find((t) => t.jobId === "r1");
  assert.deepEqual(
    { title: r1.title, agentSlug: r1.agentSlug, project: r1.project, projectName: r1.projectName, branch: r1.branch, startedAt: r1.startedAt },
    { title: "fix the build", agentSlug: "dev", project: "site-aaaaaaaaaa", projectName: "Site", branch: "agent/dev/a", startedAt: NOW - 10 * MIN },
  );
  assert.deepEqual(out.running.map((t) => t.jobId).includes("x"), false, "not a specialist task");
});

test("shapeFleetTasks: a row's title is plain words — the stored title, a handoff's own title, or the first sentence of the prompt — never the slug", () => {
  const out = shape([
    job({ id: "t1", status: "running", finishedAt: null, name: "build-the-fleet-needs-you-redesign", request: "Build the Fleet / Needs you redesign", requestedBy: "manta" }),
    job({ id: "t2", status: "running", finishedAt: null, name: "you-are-implementing-pr", title: "Implement the Fleet redesign", request: undefined }),
    job({ id: "t3", status: "running", finishedAt: null, name: "mantaui-repo-github-com-antoined", prompt: "MantaUI repo (github.com/antoinedc/MantaUI). The Fleet redesign is merged." }),
  ]);
  const title = (id) => out.running.find((t) => t.jobId === id).title;
  assert.equal(title("t1"), "Build the Fleet / Needs you redesign");
  assert.equal(title("t2"), "Implement the Fleet redesign");
  assert.equal(title("t3"), "MantaUI repo (github.com/antoinedc/MantaUI)");
  const endedOne = shape([job({ id: "e1", name: "audit-the-head-tags-on", request: "Audit the head tags on the pricing page. Then the blog." })]);
  assert.equal(endedOne.ended[0].title, "Audit the head tags on the pricing page");
});

test("shapeFleetTasks: a task with no registry project is listed with a null project", () => {
  const out = shape([job({ status: "running", finishedAt: null })], { projectOf: () => null });
  assert.equal(out.running[0].project, null);
  assert.equal(out.running[0].projectName, null);
});

test("shapeFleetTasks: Ended today = finished since local midnight, newest first; yesterday and running ones are not in it", () => {
  const out = shape([
    job({ id: "old", finishedAt: new Date(2026, 10, 27, 23, 59).getTime() }),
    job({ id: "early", finishedAt: new Date(2026, 10, 28, 0, 1).getTime() }),
    job({ id: "late", finishedAt: NOW - 5 * MIN }),
    job({ id: "run", status: "running", finishedAt: null }),
  ]);
  assert.deepEqual(out.ended.map((e) => e.jobId), ["late", "early"]);
  assert.equal(out.ended[0].endedAt, NOW - 5 * MIN);
});

test("shapeFleetTasks: Ended today holds at most the cap, and the box-full flag follows the box-wide running count", () => {
  const many = Array.from({ length: FLEET_ENDED_MAX + 5 }, (_, i) => job({ id: `e${i}`, finishedAt: NOW - (i + 1) * MIN }));
  assert.equal(shape(many).ended.length, FLEET_ENDED_MAX);
  assert.deepEqual([shape([], { boxRunning: 9 }).full, shape([], { boxRunning: 10 }).full], [false, true]);
  assert.equal(shape([], { cap: 7 }).cap, 7);
});

test("endedOutcome: what the box recorded decides the badge and the sentence", () => {
  const ctx = { verdict: null, proposalWaiting: false, stillNeedsYou: false };
  const o = (j, c = {}) => {
    const r = endedOutcome(j, { ...ctx, ...c });
    return [r.outcome, r.sentence];
  };
  assert.deepEqual(o(job({ status: "stopped", error: "stopped by user" })), ["stopped", "You stopped it. What it had done so far is kept."]);
  assert.deepEqual(o(job({ status: "stopped", error: "paused for over 7 days, stopped" })), ["interrupted", "It was paused for over 7 days, so Manta stopped it."]);
  assert.deepEqual(o(job({ status: "failed", endReason: "time-limit", error: "x" })), ["didnt-finish", "It ran out of time."]);
  assert.deepEqual(o(job({ status: "failed", endReason: "stalled", error: "x" })), ["didnt-finish", "It stopped making progress."]);
  assert.deepEqual(o(job({ status: "failed", error: "interrupted by upgrade" })), ["interrupted", "It was cut off when the box restarted."]);
  assert.deepEqual(o(job({ status: "failed", error: "the run was cut off — opencode stopped before it finished" })), ["interrupted", "It was cut off when the box restarted."]);
  assert.deepEqual(o(job({ status: "failed", error: "boom" })), ["didnt-finish", "It hit a problem and stopped."]);
  assert.deepEqual(o(job({ endedBlocked: true })), ["didnt-finish", "It stopped to ask for a decision."]);
  assert.deepEqual(o(job({ endedBlocked: true }), { stillNeedsYou: true }), ["didnt-finish", "It stopped to ask for your decision. It's in Needs you."]);
  assert.deepEqual(o(job(), { proposalWaiting: true }), ["done", "It suggests a change that needs your approval."]);
  assert.deepEqual(o(job({ branch: "b", filesChanged: 3 }), { verdict: "landed" }), ["done", "Its changes are in the project."]);
  assert.deepEqual(o(job({ branch: "b", filesChanged: 3 }), { verdict: "unmerged" }), ["done", "Its changes are on a branch, not in the project yet."]);
  assert.deepEqual(o(job({ branch: "b", filesChanged: 3 }), { verdict: "unknown" }), ["done", "It finished and changed 3 files."]);
  assert.deepEqual(o(job({ branch: "b", filesChanged: 1 }), { verdict: "unknown" }), ["done", "It finished and changed 1 file."]);
  assert.deepEqual(o(job({ deliverResult: false })), ["done", "It finished its scheduled work."]);
  assert.deepEqual(o(job()), ["done", "Its report is in the chat that asked."]);
  // a branch with no changed files is no branch work
  assert.deepEqual(o(job({ branch: "b", filesChanged: 0 }), { verdict: "unmerged" }), ["done", "Its report is in the chat that asked."]);
});

test("endedOutcome: the technical record keeps the facts the sentence leaves out", () => {
  const ctx = { verdict: "landed", proposalWaiting: false, stillNeedsYou: false };
  assert.equal(endedOutcome(job({ status: "failed", endReason: "time-limit", error: "x", filesChanged: 1, branch: "agent/dev/x" }), ctx).facts, "Hit its time limit · 1 file changed · branch agent/dev/x (in the project)");
  assert.equal(endedOutcome(job({ status: "failed", error: "boom\nsecond line" }), ctx).facts, "Failed: boom");
  assert.equal(endedOutcome(job({ status: "stopped", error: "stopped by user" }), ctx).facts, "Stopped by you");
  assert.equal(endedOutcome(job(), ctx).facts, "No files changed");
});

test("shapeFleetTasks: an ended row carries who asked, the project and the branch", () => {
  const [e] = shape([job({ id: "e1", requestedBy: "manta", branch: "agent/dev/x", filesChanged: 2 })], { verdictOf: () => "landed" }).ended;
  assert.deepEqual(
    { askedBy: e.askedBy, project: e.project, projectName: e.projectName, branch: e.branch, outcome: e.outcome, sentence: e.sentence, title: e.title, agentSlug: e.agentSlug },
    { askedBy: { by: "manta", sessionId: "ses_chat" }, project: "site-aaaaaaaaaa", projectName: "Site", branch: "agent/dev/x", outcome: "done", sentence: "Its changes are in the project.", title: "fix the build", agentSlug: "dev" },
  );
});
