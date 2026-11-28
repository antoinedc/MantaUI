// Fleet rows are working SESSIONS, not jobs (docs/superpowers/specs/2026-11-28-fleet-redesign.md §5b): a chat that is running, or a
// top-level background task. A subagent / helper job started from a session is never a row; it is listed in that row's Details.
// Pure shaping over the session tree + job records; no stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeFleetTasks } from "./agentsFleetTasks.mjs";

const NOW = new Date(2026, 10, 28, 15, 30).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

const job = (over = {}) => {
  const id = over.id ?? "job_x";
  return {
    id,
    rootJobId: id,
    name: "you-are-implementing-pr",
    title: "Build the Fleet fixes",
    agent: "agent-dev",
    specialist: true,
    parentSessionID: "ses_chat",
    childSessionID: `ses_${id}`,
    parentDirectory: "/repo/site",
    status: "running",
    createdAt: NOW - HOUR,
    startedAt: NOW - HOUR,
    finishedAt: null,
    ...over,
  };
};

const node = (sessionId, over = {}) => ({ key: sessionId, sessionId, kind: "window", windowIndex: 1, title: "Fleet fix", job: null, outside: false, children: [], ...over });
const project = (tree, over = {}) => ({ tmuxSession: "manta", defaultCwd: "/repo/site", windows: [{ index: 1, name: "Fleet fix", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_chat" }], tree, ...over });

const slugOf = (j) => (typeof j.agent === "string" ? j.agent.replace(/^agent-/, "") : null);
const STATUS = {
  ses_chat: { running: true, busy: true },
  ses_idle: { running: false, busy: false },
};

const shape = ({ rounds = [], projects = [], status = STATUS, agentOfSession = () => null, lineOf = () => "", ...over } = {}) =>
  shapeFleetTasks({
    rounds,
    now: NOW,
    slugOfJob: slugOf,
    projectOf: () => ({ slug: "site-aaaaaaaaaa", name: "Site" }),
    verdictOf: () => null,
    proposalWaiting: () => false,
    stillNeedsYou: () => false,
    boxRunning: 0,
    cap: 10,
    sessions: { projects, statusOf: (sid) => status[sid] ?? { running: false, busy: false }, agentOfSession, projectOfDir: () => ({ slug: "site-aaaaaaaaaa", name: "Site" }), lineOf },
    ...over,
  });

test("a subagent's job is not a row: the chat that started it is, and the job is listed in that row's subs", () => {
  const j = job({ id: "j1", title: "Build the Fleet fixes" });
  const projects = [project([node("ses_chat", { children: [node("ses_j1", { kind: "virtual", windowIndex: null, title: "Session", job: { id: "j1", status: "running", origin: "delegate" } })] })])];
  const out = shape({ rounds: [j], projects });
  assert.equal(out.running.length, 1);
  const [row] = out.running;
  assert.equal(row.kind, "chat");
  assert.equal(row.key, "ses_chat");
  assert.equal(row.sessionId, "ses_chat");
  assert.equal(row.jobId, "", "a chat row has no job of its own");
  assert.equal(row.title, "Fleet fix", "the session's own title, as the sidebar shows it");
  assert.equal(row.status, "in-progress");
  assert.deepEqual(row.window, { tmuxSession: "manta", index: 1 });
  assert.deepEqual(row.subs, [{ key: "j1", title: "Build the Fleet fixes", status: "in-progress", jobId: "j1", agentSlug: "dev" }]);
});

test("a chat that is running is a row, with the agent that runs it ('manta' for a plain chat) and the project's name", () => {
  const projects = [project([node("ses_chat")])];
  assert.equal(shape({ projects, sessions: undefined }).running.length, 0, "without a session read, only jobs are rows");
  const [row] = shape({ projects, agentOfSession: () => null }).running;
  assert.equal(row.agentSlug, "manta");
  assert.equal(row.project, "site-aaaaaaaaaa");
  assert.equal(row.projectName, "Site");
  assert.deepEqual(row.subs, []);
});

test("a chat in a workspace the registry doesn't know falls back to the workspace's own name", () => {
  const projects = [project([node("ses_chat")])];
  const out = shape({ projects, sessions: { projects, statusOf: (s) => STATUS[s], agentOfSession: () => null, projectOfDir: () => null, lineOf: () => "" } });
  assert.deepEqual([out.running[0].project, out.running[0].projectName], [null, "manta"]);
});

test("an agent's own conversation is a row of that agent", () => {
  const projects = [project([node("ses_chat")])];
  const [row] = shape({ projects, agentOfSession: (sid) => (sid === "ses_chat" ? "seo" : null) }).running;
  assert.equal(row.agentSlug, "seo");
});

test("an idle chat with nothing running or paused beneath it is not a row", () => {
  const projects = [project([node("ses_idle", { windowIndex: 2, title: "Old chat" })], { windows: [{ index: 2, name: "Old chat", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_idle" }] })];
  assert.deepEqual(shape({ projects }).running, []);
});

test("a terminal window (no session) is never a row", () => {
  const projects = [project([node(null, { sessionId: null, key: "window:manta:3", windowIndex: 3 })])];
  assert.deepEqual(shape({ projects, status: { null: { running: true, busy: true } } }).running, []);
});

test("an idle chat whose only helper job was paused by the user is a 'paused by you' row; the job carries the Resume", () => {
  const j = job({ id: "jp", status: "paused", pausedAt: NOW - 2 * HOUR, finishedAt: null });
  const projects = [project([node("ses_idle", { windowIndex: 2, title: "Old chat", children: [node("ses_jp", { kind: "virtual", windowIndex: null, job: { id: "jp", status: "paused", origin: "delegate" } })] })])];
  const out = shape({ rounds: [j], projects });
  assert.equal(out.running.length, 1);
  const [row] = out.running;
  assert.equal(row.status, "paused-by-you");
  assert.equal(row.kind, "chat");
  assert.equal(row.jobId, "");
  assert.deepEqual(row.subs, [{ key: "jp", title: "Build the Fleet fixes", status: "paused-by-you", jobId: "jp", agentSlug: "dev" }]);
});

test("a job that is itself a top-level session is a task row: its job title, its specialist, Stop and Resume apply to it", () => {
  const j = job({ id: "jt", parentSessionID: "", requestedBy: "manta", branch: "agent/dev/x" });
  const projects = [project([node("ses_jt", { windowIndex: 4, title: "you-are-implementing-pr", job: { id: "jt", status: "running", origin: "delegate" } })], { windows: [{ index: 4, name: "you-are-implementing-pr", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_jt" }] })];
  const out = shape({ rounds: [j], projects, status: { ses_jt: { running: true, busy: true } } });
  assert.equal(out.running.length, 1);
  const [row] = out.running;
  assert.equal(row.kind, "task");
  assert.equal(row.jobId, "jt");
  assert.equal(row.title, "Build the Fleet fixes", "a job row never shows the slug of its window");
  assert.equal(row.agentSlug, "dev");
  assert.equal(row.branch, "agent/dev/x");
  assert.deepEqual(row.window, { tmuxSession: "manta", index: 4 });
});

test("title fallbacks: a job's own title rules, the session title, then 'Untitled session'; never a slug", () => {
  const untitled = project([node("ses_chat", { title: "   " })]);
  assert.equal(shape({ projects: [untitled] }).running[0].title, "Untitled session");
  const j = job({ id: "j2", title: undefined, name: "build-the-fleet-needs-you-redesign", request: "Build the Fleet / Needs you redesign" });
  const projects = [project([node("ses_chat", { children: [node("ses_j2", { kind: "virtual", windowIndex: null, title: "Session", job: { id: "j2", status: "running", origin: "delegate" } })] })])];
  assert.equal(shape({ rounds: [j], projects }).running[0].subs[0].title, "Build the Fleet / Needs you redesign");
  // a subagent session that is not a job record: its own session title
  const sub = project([node("ses_chat", { children: [node("ses_sub", { kind: "virtual", windowIndex: null, title: "Find the pump code", job: null })] })]);
  const status = { ses_chat: { running: true, busy: true }, ses_sub: { running: true, busy: true } };
  assert.deepEqual(shape({ projects: [sub], status }).running[0].subs, [{ key: "ses_sub", title: "Find the pump code", status: "in-progress", jobId: null, agentSlug: null }]);
});

test("a running specialist job whose session isn't in any tree (a routine run) is a task row; with its parent chat in the tree it folds into that chat", () => {
  const orphan = job({ id: "ro", parentSessionID: "ses_gone", deliverResult: false, name: "refresh-seo", title: "Refresh @seo" });
  const out = shape({ rounds: [orphan], projects: [project([node("ses_idle", { windowIndex: 2 })], { windows: [{ index: 2, name: "x", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_idle" }] })] });
  assert.equal(out.running.length, 1);
  assert.deepEqual([out.running[0].kind, out.running[0].jobId, out.running[0].title, out.running[0].window, out.running[0].sessionId], ["task", "ro", "Refresh @seo", null, "ses_ro"]);
  const folded = job({ id: "rf", parentSessionID: "ses_chat" });
  const projects = [project([node("ses_chat")])];
  const out2 = shape({ rounds: [folded], projects });
  assert.equal(out2.running.length, 1);
  assert.equal(out2.running[0].kind, "chat");
  assert.deepEqual(out2.running[0].subs.map((s) => s.jobId), ["rf"]);
});

test("the one-liner comes from the reader, per session, for chats and job rows alike; none means an empty string", () => {
  const j = job({ id: "jt", parentSessionID: "" });
  const projects = [project([node("ses_chat"), node("ses_jt", { windowIndex: 4, title: "x", job: { id: "jt", status: "running", origin: "delegate" } })], { windows: [{ index: 1, name: "Fleet fix", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_chat" }, { index: 4, name: "x", paneCurrentPath: "/repo/site", opencodeSessionId: "ses_jt" }] })];
  const seen = [];
  const out = shape({
    rounds: [j],
    projects,
    status: { ses_chat: { running: true, busy: true }, ses_jt: { running: true, busy: true } },
    lineOf: (target) => {
      seen.push(target.sessionId);
      return target.sessionId === "ses_chat" ? "Building the Fleet fixes" : "";
    },
  });
  assert.deepEqual(out.running.map((r) => [r.key, r.oneLiner]).sort(), [["jt", ""], ["ses_chat", "Building the Fleet fixes"]]);
  assert.deepEqual(seen.sort(), ["ses_chat", "ses_jt"]);
});

test("Ended today: one row per top-level session — its ended jobs are in the row's subs, the title is the session's", () => {
  const a = job({ id: "ea", status: "done", finishedAt: NOW - 30 * MIN, title: "Audit the pricing page", filesChanged: 0 });
  const b = job({ id: "eb", status: "failed", endReason: "time-limit", finishedAt: NOW - 10 * MIN, title: "Fix the footer", error: "x" });
  const c = job({ id: "ec", status: "done", finishedAt: NOW - 5 * MIN, title: "Refresh @seo", parentSessionID: "ses_closed", deliverResult: false });
  const projects = [project([node("ses_chat")])];
  const out = shape({ rounds: [a, b, c], projects, status: {} });
  assert.equal(out.ended.length, 2);
  const [first, second] = out.ended;
  assert.deepEqual([first.kind, first.jobId, first.title], ["task", "ec", "Refresh @seo"], "a job whose session isn't in the tree stays its own row, newest first");
  assert.deepEqual([second.kind, second.key, second.sessionId, second.title, second.outcome], ["chat", "ses_chat", "ses_chat", "Fleet fix", "didnt-finish"], "the newest ended job decides the badge");
  assert.equal(second.sentence, "It ran out of time.");
  assert.deepEqual(second.subs.map((s) => [s.jobId, s.title, s.status, s.agentSlug]), [["eb", "Fix the footer", "didnt-finish", "dev"], ["ea", "Audit the pricing page", "finished", "dev"]]);
  assert.equal(second.endedAt, NOW - 10 * MIN);
  assert.equal(second.agentSlug, "manta");
});

test("Ended today without a session read is one row per job, as before", () => {
  const a = job({ id: "ea", status: "done", finishedAt: NOW - 30 * MIN });
  const out = shapeFleetTasks({ rounds: [a], now: NOW, slugOfJob: slugOf, projectOf: () => null, verdictOf: () => null, proposalWaiting: () => false, stillNeedsYou: () => false, boxRunning: 0, cap: 10 });
  assert.deepEqual(out.ended.map((e) => [e.jobId, e.kind ?? "task"]), [["ea", "task"]]);
});

test("a descendant that finished is listed 'finished' in the row's subs; only the row's own state decides its status", () => {
  const done = job({ id: "dn", status: "done", finishedAt: NOW - 20 * MIN });
  const projects = [project([node("ses_chat", { children: [node("ses_dn", { kind: "virtual", windowIndex: null, job: { id: "dn", status: "done", origin: "delegate" } })] })])];
  const [row] = shape({ rounds: [done], projects }).running;
  assert.deepEqual(row.subs.map((s) => [s.jobId, s.status]), [["dn", "finished"]]);
  assert.equal(row.status, "in-progress");
});
