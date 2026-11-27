// Architect v2 PR D (spec §5.1): the runner that watches finished tasks, gathers the user's corrections (five kinds of signal), asks one
// cheap model call per task 30 minutes after its last signal, checks the facts and writes the rules. Every dependency is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentLearning, LEARN_DELAY_MS } from "./agentLearning.mjs";

const T0 = Date.parse("2026-11-27T10:00:00Z");
const MIN = 60_000;

/** A world: jobs, the messages of sessions, which are the user's, the answers, the commits; and the learner over them. */
function world(over = {}) {
  const w = {
    clock: T0,
    jobs: [{ id: "job1", rootJobId: "job1", agent: "agent-dev", specialist: true, status: "done", createdAt: T0 - 20 * MIN, finishedAt: T0, parentSessionID: "ses_chat", parentDirectory: "/proj/site", childSessionID: "ses_child1", result: "I fixed the build." }],
    messages: {
      ses_child1: [
        { info: { id: "m_dispatch", role: "user", time: { created: T0 - 20 * MIN } }, parts: [{ type: "text", text: "Fix the build." }] },
        { info: { id: "m_user1", role: "user", time: { created: T0 - 5 * MIN } }, parts: [{ type: "text", text: "No, always use imperative commit messages please." }] },
        { info: { id: "m_asst", role: "assistant", time: { created: T0 - 4 * MIN } }, parts: [{ type: "text", text: "Sorry." }] },
      ],
      ses_chat: [],
    },
    userAuthored: new Set(["m_user1"]),
    questions: [],
    changes: [],
    commits: null,
    projects: { "/proj/site": "site" },
    rules: [],
    tombstones: new Set(),
    learners: new Set(["dev", "architect"]),
    answers: [], // the model's answers, in order
    asked: [],
    writes: [],
    writeResult: (i) => ({ ok: true, change: { id: `ach_${i.rule.rule}`, state: "applied" } }),
    askResult: null, // a failure to answer with
    redactAll: false,
    redactDown: false,
    ...over,
  };
  const saved = { doc: null };
  const learning = createAgentLearning({
    agents: {
      learnedWrite: async (i) => {
        w.writes.push(i);
        return w.writeResult(i);
      },
      learnedRules: async () => w.rules,
      learnedTombstones: async () => w.tombstones,
    },
    canLearn: async (slug) => w.learners.has(slug),
    agentName: async (slug) => (slug === "dev" ? "Dev" : slug),
    listJobs: async () => {
      if (w.jobsThrow) throw new Error("unreadable");
      return w.jobs;
    },
    listMessages: async (sid) => w.messages[sid] ?? [],
    isUserAuthored: async (id) => w.userAuthored.has(id),
    questionsOf: async () => w.questions,
    changesOf: async () => w.changes,
    userCommits: async () => w.commits,
    projectOf: async (dir) => w.projects[dir] ?? null,
    ask: async (prompt) => {
      w.asked.push(prompt);
      if (w.askResult) return w.askResult;
      return { ok: true, text: w.answers.shift() ?? '{"candidates":[]}' };
    },
    redact: async (text) => (w.redactDown ? null : w.redactAll ? String(text).replace(/sk-[a-z0-9]+/g, "[redacted]") : text),
    store: { load: async () => (saved.doc ? JSON.parse(JSON.stringify(saved.doc)) : null), save: async (d) => void (saved.doc = JSON.parse(JSON.stringify(d))) },
    now: () => w.clock,
    log: () => {},
  });
  return { w, learning, saved };
}

const CAND = (over = {}) => JSON.stringify({ candidates: [{ rule: "Write commit messages in the imperative mood.", why: "They corrected it.", whyIsInferred: false, quote: "always use imperative commit messages", scope: "project", ...over }] });

test("a finished task is looked at 30 minutes later, not before; the rule is written in the task's project with the task as its source", async () => {
  const { w, learning } = world();
  w.answers.push(CAND());
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS - 1;
  assert.deepEqual(await learning.runDue(), { ran: 0 });
  assert.equal(w.asked.length, 0);
  w.clock = T0 + LEARN_DELAY_MS;
  assert.deepEqual(await learning.runDue(), { ran: 1 });
  assert.equal(w.asked.length, 1);
  assert.equal(w.writes.length, 1);
  assert.deepEqual(w.writes[0], { slug: "dev", scope: "site", rule: { rule: "Write commit messages in the imperative mood.", why: "They corrected it.", whyIsInferred: false, quote: "always use imperative commit messages", sourceJobId: "job1" }, replacesId: null });
  assert.deepEqual(await learning.runDue(), { ran: 0 }, "once");
});

test("the prompt frames what the user wrote as data and names the agent and project; the dispatch prompt is not a signal", async () => {
  const { w, learning } = world();
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  const p = w.asked[0];
  assert.match(p, /AGENT: Dev/);
  assert.match(p, /PROJECT: site/);
  assert.match(p, /always use imperative commit messages/);
  assert.ok(!p.includes("Fix the build."), "a message the user didn't write is no signal");
  assert.ok(!p.includes("Sorry."), "nor is the agent's own");
});

test("a quote the user never wrote is dropped (nothing written); a task with no user words costs no model call at all", async () => {
  const { w, learning } = world();
  w.answers.push(CAND({ quote: "the user said something they never said" }));
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.writes.length, 0);
  const quiet = world();
  quiet.w.userAuthored.clear();
  await quiet.learning.noteEnded(quiet.w.jobs[0]);
  quiet.w.clock = T0 + LEARN_DELAY_MS;
  assert.deepEqual(await quiet.learning.runDue(), { ran: 1 });
  assert.equal(quiet.w.asked.length, 0);
});

test("signal 2: the user's next message in the chat after a result counts when the work was then continued or handed over again; with nothing after it, it doesn't", async () => {
  const { w, learning } = world({ userAuthored: new Set() });
  w.messages.ses_chat = [
    { info: { id: "c_before", role: "user", time: { created: T0 - 30 * MIN } }, parts: [{ type: "text", text: "please fix the build" }] },
    { info: { id: "c_next", role: "user", time: { created: T0 + 2 * MIN } }, parts: [{ type: "text", text: "That's wrong: never touch the lockfile by hand." }] },
    { info: { id: "c_later", role: "user", time: { created: T0 + 9 * MIN } }, parts: [{ type: "text", text: "and thanks" }] },
  ];
  w.userAuthored = new Set(["c_before", "c_next", "c_later"]);
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.asked.length, 0, "no later round: the message was a new request as far as anyone can tell");
  // the lead continues the task (same root) after that message
  w.jobs.push({ id: "job2", rootJobId: "job1", continues: "job1", agent: "agent-dev", specialist: true, status: "done", createdAt: T0 + 3 * MIN, finishedAt: T0 + 6 * MIN, parentSessionID: "ses_chat", parentDirectory: "/proj/site", childSessionID: "ses_child2", requestedBy: "manta", result: "Reverted the lockfile." });
  w.messages.ses_child2 = [];
  w.answers.push(CAND({ rule: "Never edit the lockfile by hand.", quote: "never touch the lockfile by hand" }));
  await learning.noteEnded(w.jobs[1]);
  w.clock = T0 + 6 * MIN + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.asked.length, 1);
  assert.match(w.asked[0], /never touch the lockfile by hand/);
  assert.ok(!w.asked[0].includes("and thanks"), "only the NEXT message");
  assert.ok(!w.asked[0].includes("please fix the build"), "nothing from before the result");
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].rule.quote, "never touch the lockfile by hand");
});

test("signal 2 also attributes a message to the EARLIER task when the same work is handed to the same agent again", async () => {
  const { w, learning } = world({ userAuthored: new Set(["c_next"]) });
  w.messages.ses_chat = [{ info: { id: "c_next", role: "user", time: { created: T0 + 2 * MIN } }, parts: [{ type: "text", text: "Not like that: keep every PR under 200 lines." }] }];
  w.jobs.push({ id: "job7", rootJobId: "job7", agent: "agent-dev", specialist: true, status: "done", createdAt: T0 + 3 * MIN, finishedAt: T0 + 8 * MIN, parentSessionID: "ses_chat", parentDirectory: "/proj/site", childSessionID: "ses_child7", requestedBy: "manta", result: "Redone." });
  w.messages.ses_child7 = [];
  w.userAuthored = new Set(["c_next"]);
  w.answers.push(CAND({ rule: "Keep every PR under 200 lines.", quote: "keep every PR under 200 lines" }));
  await learning.noteEnded(w.jobs[1]); // the new task ended: the old one is looked at again too
  w.clock = T0 + 8 * MIN + LEARN_DELAY_MS;
  await learning.runDue();
  const learnedFrom = w.writes.map((x) => x.rule.sourceJobId);
  assert.deepEqual(learnedFrom, ["job1"], "the rule belongs to the task whose result the user corrected");
});

test("signal 3: an answer that typed the user's own text, or picked an option other than the recommended one, counts; the recommended pick doesn't", async () => {
  const q = (answer) => ({ id: "tq_1", state: "answered", answer, questions: [{ question: "Which style?", options: [{ label: "Tabs (Recommended)" }, { label: "Spaces" }], multiple: false }] });
  for (const [answer, quoted, expected] of [
    [[["Spaces"]], "Spaces", true],
    [[["we use two-space indentation everywhere"]], "two-space indentation everywhere", true],
    [[["Tabs (Recommended)"]], "Tabs (Recommended)", false],
  ]) {
    const { w, learning } = world({ userAuthored: new Set() });
    w.questions = [q(answer)];
    w.answers.push(CAND({ rule: "Indent with spaces.", quote: quoted }));
    await learning.noteEnded(w.jobs[0]);
    w.clock = T0 + LEARN_DELAY_MS;
    await learning.runDue();
    assert.equal(w.writes.length, expected ? 1 : 0, JSON.stringify(answer));
    assert.equal(w.asked.length, expected ? 1 : 0);
  }
});

test("signal 4: a change the user undid is context for the model but has no words to quote", async () => {
  const { w, learning } = world();
  w.changes = [{ id: "ach_1", state: "undone", summary: "Tightened the routing line", origin: { kind: "job", rootJobId: "job1" } }, { id: "ach_2", state: "applied", summary: "Not this one" }];
  w.answers.push(CAND({ rule: "Leave routing lines alone.", quote: "Undid: Tightened the routing line" }));
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.match(w.asked[0], /Undid: Tightened the routing line/);
  assert.ok(!w.asked[0].includes("Not this one"));
  assert.equal(w.writes.length, 0, "quoting an event, not the user's words, is dropped");
});

test("signal 5: a commit the user made on the task's branch after it ended is quotable by its hunk", async () => {
  const { w, learning } = world({ userAuthored: new Set() });
  w.jobs[0] = { ...w.jobs[0], isolation: "worktree", branch: "agent/dev/x", endHead: "abc123", baseSha: "base1" };
  w.commits = "@@ -1 +1 @@\n-Added the thing\n+Add the thing";
  w.answers.push(CAND({ rule: "Write commit messages in the imperative mood.", quote: "+Add the thing" }));
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.writes.length, 1);
  assert.match(w.asked[0], /\+Add the thing/);
});

test("nothing new, nothing asked: a signal already read isn't read again; a new one is", async () => {
  const { w, learning } = world();
  w.answers.push(CAND());
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.asked.length, 1);
  await learning.noteEnded(w.jobs[0]);
  w.clock += LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.asked.length, 1, "the same words aren't a new signal");
  w.messages.ses_child1.push({ info: { id: "m_user2", role: "user", time: { created: w.clock } }, parts: [{ type: "text", text: "Also keep subject lines under 60 characters." }] });
  w.userAuthored.add("m_user2");
  await learning.noteEnded(w.jobs[0]);
  w.clock += LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.asked.length, 2);
  assert.ok(!w.asked[1].includes("always use imperative"), "only what is new");
});

test("a model that can't answer now (budget, no model) is asked again later, at most 3 times; a scanner that can't run means no call; nothing ever asks the user", async () => {
  const { w, learning } = world();
  w.askResult = { ok: false, code: "budget" };
  await learning.noteEnded(w.jobs[0]);
  for (let i = 0; i < 6; i++) {
    w.clock += LEARN_DELAY_MS;
    await learning.runDue();
  }
  assert.equal(w.asked.length, 3);
  assert.equal(w.writes.length, 0);
  const down = world();
  down.w.redactDown = true;
  await down.learning.noteEnded(down.w.jobs[0]);
  down.w.clock += LEARN_DELAY_MS;
  await down.learning.runDue();
  assert.equal(down.w.asked.length, 0);
  // an unreadable jobs store is retried, not lost
  const bad = world();
  await bad.learning.noteEnded(bad.w.jobs[0]);
  bad.w.jobsThrow = true;
  bad.w.clock += LEARN_DELAY_MS;
  await bad.learning.runDue();
  bad.w.jobsThrow = false;
  bad.w.answers.push(CAND());
  bad.w.clock += LEARN_DELAY_MS;
  await bad.learning.runDue();
  assert.equal(bad.w.writes.length, 1);
});

test("what the model sees and what is stored is redacted", async () => {
  const { w, learning } = world({ redactAll: true });
  w.messages.ses_child1[1].parts[0].text = "No, always use imperative commit messages, and my key is sk-abc123 ok";
  w.answers.push(CAND({ quote: "always use imperative commit messages", why: "They said so (sk-zzz999)." }));
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.ok(!w.asked[0].includes("sk-abc123"));
  assert.match(w.asked[0], /\[redacted\]/);
  assert.ok(!w.writes[0].rule.why.includes("sk-zzz999"));
});

test("the lead and anything that can't learn is ignored; the Architect learns in every project; a project rule in a folder of no project is dropped", async () => {
  const lead = world({ jobs: [{ id: "jobL", rootJobId: "jobL", agent: "agent-manta", specialist: true, status: "done", createdAt: T0, finishedAt: T0, parentSessionID: "ses_chat", parentDirectory: "/proj/site", childSessionID: "ses_child1" }] });
  await lead.learning.noteEnded(lead.w.jobs[0]);
  lead.w.clock += LEARN_DELAY_MS;
  assert.deepEqual(await lead.learning.runDue(), { ran: 0 });
  const notSpecialist = world();
  await notSpecialist.learning.noteEnded({ ...notSpecialist.w.jobs[0], specialist: false });
  notSpecialist.w.clock += LEARN_DELAY_MS;
  assert.deepEqual(await notSpecialist.learning.runDue(), { ran: 0 });
  const arch = world();
  arch.w.jobs[0] = { ...arch.w.jobs[0], agent: "agent-architect" };
  arch.w.answers.push(CAND());
  await arch.learning.noteEnded(arch.w.jobs[0]);
  arch.w.clock += LEARN_DELAY_MS;
  await arch.learning.runDue();
  assert.equal(arch.w.writes[0].scope, "_all");
  const none = world({ projects: {} });
  none.w.answers.push(CAND());
  await none.learning.noteEnded(none.w.jobs[0]);
  none.w.clock += LEARN_DELAY_MS;
  await none.learning.runDue();
  assert.equal(none.w.writes.length, 0);
  const anywhere = world({ projects: {} });
  anywhere.w.answers.push(CAND({ scope: "all" }));
  await anywhere.learning.noteEnded(anywhere.w.jobs[0]);
  anywhere.w.clock += LEARN_DELAY_MS;
  await anywhere.learning.runDue();
  assert.equal(anywhere.w.writes[0].scope, "_all");
});

test("a rule the user undid before (tombstone) isn't learned again; a rule that replaces one names it; a write that is refused or skipped never throws", async () => {
  const { w, learning } = world();
  const { quoteHash } = await import("./agentLearning.mjs");
  w.tombstones = new Set([quoteHash("always use imperative commit messages")]);
  w.answers.push(CAND());
  await learning.noteEnded(w.jobs[0]);
  w.clock = T0 + LEARN_DELAY_MS;
  await learning.runDue();
  assert.equal(w.writes.length, 0);
  const r = world();
  r.w.rules = [{ id: "lr_00000001", scope: "site", rule: "Use tabs.", archived: false }];
  r.w.answers.push(CAND({ rule: "Use spaces.", replacesId: "lr_00000001" }));
  r.w.writeResult = () => ({ ok: false, skipped: "never" });
  await r.learning.noteEnded(r.w.jobs[0]);
  r.w.clock = T0 + LEARN_DELAY_MS;
  await r.learning.runDue();
  assert.equal(r.w.writes[0].replacesId, "lr_00000001");
  const t = world();
  t.w.answers.push(CAND());
  t.w.writeResult = () => {
    throw new Error("disk full");
  };
  await t.learning.noteEnded(t.w.jobs[0]);
  t.w.clock = T0 + LEARN_DELAY_MS;
  await assert.doesNotReject(t.learning.runDue());
});

test("the state survives a restart: a due task is picked up by a new learner over the same store", async () => {
  const a = world();
  await a.learning.noteEnded(a.w.jobs[0]);
  const { createAgentLearning } = await import("./agentLearning.mjs");
  a.w.answers.push(CAND());
  const again = createAgentLearning({
    agents: { learnedWrite: async (i) => (a.w.writes.push(i), { ok: true, change: { id: "x" } }), learnedRules: async () => [], learnedTombstones: async () => new Set() },
    canLearn: async () => true,
    agentName: async () => "Dev",
    listJobs: async () => a.w.jobs,
    listMessages: async (sid) => a.w.messages[sid] ?? [],
    isUserAuthored: async (id) => a.w.userAuthored.has(id),
    questionsOf: async () => [],
    changesOf: async () => [],
    userCommits: async () => null,
    projectOf: async () => "site",
    ask: async () => ({ ok: true, text: a.w.answers.shift() }),
    redact: async (t) => t,
    store: { load: async () => JSON.parse(JSON.stringify(a.saved.doc)), save: async () => {} },
    now: () => T0 + LEARN_DELAY_MS,
    log: () => {},
  });
  assert.deepEqual(await again.runDue(), { ran: 1 });
  assert.equal(a.w.writes.length, 1);
});
