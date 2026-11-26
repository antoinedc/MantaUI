// A specialist task's question that doesn't block the task (docs/superpowers/specs/2026-11-26-agents-screens.md §4):
// capture (store → placeholder reply → outcome), the claim → deliver → record answer, dismissal, the crash-recovery sweep and
// the round-settled hand-off. Everything outside the store is a fake; the store itself is a real file in a temp dir, and the
// store mutex is wrapped so a test can prove no network call ever runs under it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutex } from "./jsonStore.mjs";
import { PLACEHOLDER_ANSWER } from "./taskDecision.mjs";
import { createTaskQuestions, QUESTIONS_OPEN_MAX, QUESTIONS_FILE } from "./taskQuestions.mjs";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PARENT = "ses_parent";
const CHILD = "ses_child";

const FORM = (over = {}) => ({
  id: "frm_1",
  sessionID: CHILD,
  metadata: { kind: "question" },
  fields: [
    {
      key: "a",
      title: "Agent",
      description: "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro.",
      type: "select",
      options: [{ label: "Add to @conversion-cro", value: "x", description: "One agent keeps the pricing rules." }, { label: "Create @pricing-copy", value: "y", description: "A separate agent." }],
    },
  ],
  ...over,
});

const JOB = (over = {}) => ({
  id: "job1",
  name: "pricing copy",
  agent: "agent-seo",
  agentName: "SEO",
  specialist: true,
  status: "running",
  parentSessionID: PARENT,
  childSessionID: CHILD,
  parentDirectory: "/repo",
  attempt: 1,
  ...over,
});

async function rig({ jobs = [JOB()] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "task-questions-"));
  const state = { now: T0, inMutex: 0, violations: [] };
  const calls = { reply: [], deliver: [], milestone: [], publish: [], readMessage: [] };
  const fail = { reply: null, deliver: null, readMessage: null };
  const mutex = createMutex();
  const guarded = {
    runExclusive: (fn) =>
      mutex.runExclusive(async () => {
        state.inMutex++;
        try {
          return await fn();
        } finally {
          state.inMutex--;
        }
      }),
  };
  const noMutex = (what) => {
    if (state.inMutex > 0) state.violations.push(what);
  };
  const records = jobs.map((j) => ({ ...j }));
  const messages = new Set(); // `${session}/${messageID}` the child holds
  const pendingForms = new Set();
  const out = { deliverResult: { delivery: "steer" } };
  const oc = {
    replyQuestion: async (a) => {
      noMutex("replyQuestion");
      calls.reply.push(a);
      if (fail.reply) throw fail.reply;
    },
    readMessageStrict: async (sid, mid) => {
      noMutex("readMessageStrict");
      calls.readMessage.push([sid, mid]);
      if (fail.readMessage) throw fail.readMessage;
      return { state: messages.has(`${sid}/${mid}`) ? "found" : "missing" };
    },
    listQuestions: async (sid) => [...pendingForms].filter((f) => f.sessionID === sid).map((f) => ({ id: f.id, sessionID: f.sessionID })),
  };
  const delegate = {
    rootJobOf: (j) => j.rootJobId ?? j.architect?.rootJobId ?? j.id,
    loadRecords: async () => {
      noMutex("loadRecords");
      return records.map((r) => structuredClone(r));
    },
    deliverToTask: async (root, text, opts) => {
      noMutex("deliverToTask");
      calls.deliver.push({ root, text, ...opts });
      if (fail.deliver) throw fail.deliver;
      return typeof out.deliverResult === "function" ? out.deliverResult({ root, text, ...opts }) : out.deliverResult;
    },
    addJobMilestone: async (id, text) => {
      calls.milestone.push({ id, text });
    },
  };
  const tq = createTaskQuestions({
    root,
    now: () => state.now,
    publish: (p) => calls.publish.push(p),
    delegate,
    oc,
    mutex: guarded,
    projectOf: () => "manta",
  });
  const file = join(root, QUESTIONS_FILE);
  return {
    tq,
    state,
    calls,
    fail,
    out,
    records,
    messages,
    pendingForms,
    root,
    file,
    stored: async () => JSON.parse(await readFile(file, "utf-8")).questions,
    write: (questions) => writeFile(file, JSON.stringify({ version: 1, questions })),
    async capture(form = FORM(), job = records[0]) {
      return tq.capture(form, job);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// a question as an earlier run left it in the store
const stored = (over = {}) => ({
  id: "tq_0123456789abcdef",
  rootJobId: "job1",
  jobId: "job1",
  parentSessionID: PARENT,
  agentSlug: "seo",
  agentName: "SEO",
  project: "manta",
  taskName: "pricing copy",
  questions: [{ question: "Create it?", options: [{ label: "Add", description: "" }], multiple: false }],
  state: "open",
  askedAt: T0,
  answeredAt: null,
  answer: null,
  delivery: null,
  delivering: null,
  error: null,
  childSessionID: CHILD,
  formID: "frm_1",
  pendingReply: false,
  ...over,
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

test("capture: stores an open question, replies to the form with the placeholder for every field, interrupts nothing, adds the milestone, publishes", async () => {
  const r = await rig();
  const res = await r.capture();
  assert.deepEqual(res, { captured: true, id: res.id });
  assert.match(res.id, /^tq_[0-9a-f]{16}$/);
  assert.deepEqual(r.calls.reply, [{ requestId: "frm_1", sessionId: CHILD, answers: [[PLACEHOLDER_ANSWER]] }]);
  const [q] = await r.stored();
  assert.equal(q.state, "open");
  assert.equal(q.rootJobId, "job1");
  assert.equal(q.jobId, "job1");
  assert.equal(q.parentSessionID, PARENT);
  assert.equal(q.agentSlug, "seo");
  assert.equal(q.agentName, "SEO");
  assert.equal(q.project, "manta");
  assert.equal(q.taskName, "pricing copy");
  assert.equal(q.askedAt, T0);
  assert.deepEqual([q.answeredAt, q.answer, q.delivery, q.delivering, q.error], [null, null, null, null, null]);
  assert.equal(q.questions[0].question, "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro.");
  assert.deepEqual(q.questions[0].options.map((o) => o.label), ["Add to @conversion-cro", "Create @pricing-copy"]);
  assert.equal(q.pendingReply, false, "the outcome was written after the reply");
  assert.deepEqual(r.calls.milestone, [{ id: "job1", text: "Asked you: Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro." }]);
  assert.deepEqual(r.calls.publish.at(-1), { id: res.id, parentSessionID: PARENT, rootJobId: "job1", state: "open" });
  assert.deepEqual(r.state.violations, [], "no network call under the store mutex");
  assert.equal(r.tq.hasOpen("job1"), true);
  assert.equal(r.tq.openCountFor("job1"), 1);
  await r.cleanup();
});

test("capture: a multi-field form gets one placeholder answer per raw field; the milestone is cut at 120 characters", async () => {
  const r = await rig();
  const long = "w".repeat(300);
  const form = FORM({ fields: [{ ...FORM().fields[0], description: long }, { key: "b", title: "T", description: "Second?", type: "multiselect", options: [{ label: "p" }] }] });
  await r.capture(form);
  assert.deepEqual(r.calls.reply[0].answers, [[PLACEHOLDER_ANSWER], [PLACEHOLDER_ANSWER]]);
  const [q] = await r.stored();
  assert.equal(q.questions.length, 2);
  assert.ok(r.calls.milestone[0].text.length <= "Asked you: ".length + 120);
  await r.cleanup();
});

test("capture: a form that forbids typing falls back (nothing stored, nothing replied)", async () => {
  const r = await rig();
  const form = FORM({ fields: [{ ...FORM().fields[0], custom: false }] });
  assert.deepEqual(await r.capture(form), { captured: false, reason: "free-text" });
  assert.deepEqual(r.calls.reply, []);
  await assert.rejects(readFile(r.file), "no store written");
  await r.cleanup();
});

test("capture: a form with no usable question falls back", async () => {
  const r = await rig();
  const empty = FORM({ fields: [{ key: "a", title: "  ", description: "   ", type: "select", options: [] }] });
  assert.deepEqual(await r.capture(empty), { captured: false, reason: "no-question" });
  await r.cleanup();
});

test("capture: a failed reply deletes the stored question (never left open) and falls back", async () => {
  const r = await rig();
  r.fail.reply = new Error("opencode is down");
  assert.deepEqual(await r.capture(), { captured: false, reason: "reply-failed" });
  assert.deepEqual(await r.stored(), []);
  assert.equal(r.tq.hasOpen("job1"), false);
  assert.deepEqual(r.calls.milestone, []);
  assert.deepEqual(r.state.violations, []);
  await r.cleanup();
});

test(`capture: the ${QUESTIONS_OPEN_MAX + 1}th open question of one task falls back; another task is unaffected`, async () => {
  const r = await rig({ jobs: [JOB(), JOB({ id: "job2", childSessionID: "ses_other" })] });
  for (let i = 0; i < QUESTIONS_OPEN_MAX; i++) assert.equal((await r.capture(FORM({ id: `frm_${i}` }))).captured, true);
  assert.deepEqual(await r.capture(FORM({ id: "frm_x" })), { captured: false, reason: "limit" });
  assert.equal(r.calls.reply.length, QUESTIONS_OPEN_MAX, "the extra one was never replied to");
  assert.equal((await r.capture(FORM({ id: "frm_y", sessionID: "ses_other" }), r.records[1])).captured, true);
  await r.cleanup();
});

test("capture: an unreadable store falls back and is never saved over", async () => {
  const r = await rig();
  await writeFile(r.file, "{ not json");
  assert.deepEqual(await r.capture(), { captured: false, reason: "store" });
  assert.equal(await readFile(r.file, "utf-8"), "{ not json");
  assert.deepEqual(r.calls.reply, []);
  await r.cleanup();
});

test("capture: continuations share one task — a round of the same root counts toward the same limit", async () => {
  const r = await rig({ jobs: [JOB({ rootJobId: "job1" }), JOB({ id: "job2", rootJobId: "job1", attempt: 2 })] });
  await r.capture(FORM({ id: "f1" }), r.records[0]);
  const second = await r.capture(FORM({ id: "f2" }), r.records[1]);
  assert.equal(second.captured, true);
  const qs = await r.stored();
  assert.deepEqual(qs.map((q) => [q.rootJobId, q.jobId]), [["job1", "job1"], ["job1", "job2"]]);
  assert.equal(r.tq.openCountFor("job1"), 2);
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// answer: claim → deliver → record
// ---------------------------------------------------------------------------

test("answer: claim, then deliver (nothing held), then record — delivering is persisted BEFORE the send and cleared after; success marks it answered with the delivery", async () => {
  const r = await rig();
  const { id } = await r.capture();
  let seenWhileDelivering = null;
  r.out.deliverResult = async () => {
    seenWhileDelivering = (await r.stored())[0];
    return { delivery: "steer" };
  };
  r.state.now = T0 + 5000;
  const res = await r.tq.answer(id, [["Add to @conversion-cro"]]);
  assert.equal(res.ok, true);
  assert.equal(seenWhileDelivering.state, "open");
  assert.match(seenWhileDelivering.delivering.messageID, /^msg_/);
  assert.equal(seenWhileDelivering.delivering.at, T0 + 5000);
  assert.deepEqual(seenWhileDelivering.answer, [["Add to @conversion-cro"]]);
  const [q] = await r.stored();
  assert.equal(q.state, "answered");
  assert.equal(q.answeredAt, T0 + 5000);
  assert.equal(q.delivery, "steer");
  assert.equal(q.delivering, null);
  assert.equal(q.error, null);
  assert.deepEqual(res.question.state, "answered");
  assert.equal(r.calls.deliver.length, 1);
  assert.equal(r.calls.deliver[0].root, "job1");
  assert.equal(r.calls.deliver[0].messageID, seenWhileDelivering.delivering.messageID);
  assert.equal(r.calls.deliver[0].text, 'Answer from the user to your question "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro.": Add to @conversion-cro');
  assert.deepEqual(r.calls.milestone.at(-1), { id: "job1", text: "You answered: Add to @conversion-cro" });
  assert.deepEqual(r.calls.publish.at(-1), { id, parentSessionID: PARENT, rootJobId: "job1", state: "answered" });
  assert.deepEqual(r.state.violations, [], "no network call under the store mutex");
  assert.equal(r.tq.hasOpen("job1"), false, "answered and delivered: nothing open any more");
  await r.cleanup();
});

test("answer: a refusal keeps the question open with the sentence as its error, delivering cleared — nothing is marked answered before delivery succeeded", async () => {
  const r = await rig();
  const { id } = await r.capture();
  r.out.deliverResult = { error: "This task is paused; resume it first, then answer." };
  const res = await r.tq.answer(id, [["x"]]);
  assert.equal(res.ok, false);
  assert.equal(res.error, "This task is paused; resume it first, then answer.");
  const [q] = await r.stored();
  assert.equal(q.state, "open");
  assert.equal(q.error, "This task is paused; resume it first, then answer.");
  assert.equal(q.delivering, null);
  assert.equal(q.answeredAt, null);
  assert.equal(r.tq.hasOpen("job1"), true);
  assert.ok(!r.calls.milestone.some((m) => /You answered/.test(m.text)));
  // pressing again works and clears the error
  r.out.deliverResult = { delivery: "continue" };
  const again = await r.tq.answer(id, [["x"]]);
  assert.equal(again.ok, true);
  assert.equal((await r.stored())[0].error, null);
  await r.cleanup();
});

test("answer: a delivery that throws is a refusal sentence too, and the question stays open", async () => {
  const r = await rig();
  const { id } = await r.capture();
  r.fail.deliver = new Error("fetch failed");
  const res = await r.tq.answer(id, [["x"]]);
  assert.equal(res.ok, false);
  assert.match(res.error, /Couldn't send your answer/);
  assert.equal((await r.stored())[0].state, "open");
  assert.equal((await r.stored())[0].delivering, null);
  await r.cleanup();
});

test("answer: records every delivery — steer, continue, continue-pending", async () => {
  for (const delivery of ["steer", "continue", "continue-pending"]) {
    const r = await rig();
    const { id } = await r.capture();
    r.out.deliverResult = { delivery };
    const res = await r.tq.answer(id, [["x"]]);
    assert.equal(res.ok, true);
    const [q] = await r.stored();
    assert.equal(q.delivery, delivery);
    assert.equal(q.state, "answered");
    assert.equal(r.tq.hasOpen("job1"), delivery === "continue-pending", "a continue-pending answer still holds the task's proposals");
    await r.cleanup();
  }
});

test("answer: a second press while the first is being delivered is refused ('Already sending your answer'); after it was answered the record comes back unchanged and nothing is sent", async () => {
  const r = await rig();
  const { id } = await r.capture();
  let release;
  const gate = new Promise((res) => (release = res));
  r.out.deliverResult = async () => {
    await gate;
    return { delivery: "steer" };
  };
  const first = r.tq.answer(id, [["a"]]);
  await new Promise((res) => setTimeout(res, 20));
  const second = await r.tq.answer(id, [["b"]]);
  assert.equal(second.ok, false);
  assert.equal(second.error, "Already sending your answer");
  release();
  assert.equal((await first).ok, true);
  const third = await r.tq.answer(id, [["c"]]);
  assert.equal(third.ok, true);
  assert.equal(third.question.state, "answered");
  assert.equal(r.calls.deliver.length, 1, "exactly one delivery");
  assert.deepEqual((await r.stored())[0].answer, [["a"]]);
  await r.cleanup();
});

test("answer: every question needs an answer; an unknown id is a sentence; a dismissed question can't be answered", async () => {
  const r = await rig();
  const { id } = await r.capture();
  assert.deepEqual((await r.tq.answer(id, [[]])).error, "Answer every question first.");
  assert.deepEqual((await r.tq.answer(id, [])).error, "Answer every question first.");
  assert.deepEqual((await r.tq.answer(id, "nope")).error, "Answer every question first.");
  assert.deepEqual((await r.tq.answer(id, [["  "]])).error, "Answer every question first.");
  assert.equal((await r.tq.answer("tq_ffffffffffffffff", [["x"]])).error, "That question no longer exists.");
  await r.tq.dismiss(id);
  assert.equal((await r.tq.answer(id, [["x"]])).error, "That question was dismissed.");
  assert.ok(r.calls.deliver.every((d) => d.steerOnly), "no answer was delivered (the dismissal's own steer is the only send)");
  await r.cleanup();
});

test("answer: a multi-question form is delivered as one line per question", async () => {
  const r = await rig();
  const form = FORM({ fields: [FORM().fields[0], { key: "b", title: "T", description: "Second?", type: "select", options: [{ label: "p" }] }] });
  const { id } = await r.capture(form);
  await r.tq.answer(id, [["one"], ["two", "typed"]]);
  const lines = r.calls.deliver[0].text.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('"Second?": two, typed'));
  await r.cleanup();
});

test("answer: a task that no longer exists says so, and the question stays open", async () => {
  const r = await rig();
  const { id } = await r.capture();
  r.out.deliverResult = { error: "That task no longer exists; ask in a chat instead." };
  const res = await r.tq.answer(id, [["x"]]);
  assert.equal(res.error, "That task no longer exists; ask in a chat instead.");
  assert.equal((await r.stored())[0].state, "open");
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// dismiss
// ---------------------------------------------------------------------------

test("dismiss: marks it dismissed and tells a running task (a steer only — a finished task is left as is)", async () => {
  const r = await rig();
  const { id } = await r.capture();
  r.out.deliverResult = { delivery: "steer" };
  const res = await r.tq.dismiss(id);
  assert.equal(res.ok, true);
  assert.equal(res.question.state, "dismissed");
  assert.equal(r.calls.deliver.length, 1);
  assert.equal(r.calls.deliver[0].steerOnly, true, "never starts another round");
  assert.equal(r.calls.deliver[0].text, 'The user dismissed your question "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro.". Decide yourself, or say what is left undecided.');
  assert.equal(r.tq.hasOpen("job1"), false);
  assert.deepEqual(r.calls.publish.at(-1).state, "dismissed");
  assert.deepEqual(r.state.violations, []);
  // idempotent
  const again = await r.tq.dismiss(id);
  assert.equal(again.ok, true);
  assert.equal(r.calls.deliver.length, 1);
  await r.cleanup();
});

test("dismiss: a finished task (nothing to steer) is fine; a failed steer is reported as a warning, the dismissal stands", async () => {
  const r = await rig();
  const a = await r.capture(FORM({ id: "f1" }));
  r.out.deliverResult = { delivery: "none" };
  const quiet = await r.tq.dismiss(a.id);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.warning, undefined);
  const b = await r.capture(FORM({ id: "f2" }));
  r.out.deliverResult = { error: "boom" };
  const loud = await r.tq.dismiss(b.id);
  assert.equal(loud.ok, true);
  assert.equal(loud.question.state, "dismissed");
  assert.equal(loud.warning, "boom");
  await r.cleanup();
});

test("dismiss: an answer in flight can't be dismissed; an unknown id says so; an answered question comes back unchanged", async () => {
  const r = await rig();
  const { id } = await r.capture();
  let release;
  r.out.deliverResult = async () => {
    await new Promise((res) => (release = res));
    return { delivery: "steer" };
  };
  const pending = r.tq.answer(id, [["a"]]);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal((await r.tq.dismiss(id)).error, "Already sending your answer");
  release();
  await pending;
  assert.equal((await r.tq.dismiss(id)).question.state, "answered");
  assert.equal((await r.tq.dismiss("tq_ffffffffffffffff")).ok, false);
  await r.cleanup();
});

test("dismiss: a task that is gone can still be dismissed", async () => {
  const r = await rig();
  const { id } = await r.capture();
  r.out.deliverResult = { error: "That task no longer exists; ask in a chat instead." };
  const res = await r.tq.dismiss(id);
  assert.equal(res.ok, true);
  assert.equal(res.question.state, "dismissed");
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

test("listOpen: open questions, newest first, for one chat or all; the wire copy carries no server bookkeeping", async () => {
  const r = await rig();
  await r.write([
    stored({ id: "tq_aaaaaaaaaaaaaaaa", askedAt: T0 }),
    stored({ id: "tq_bbbbbbbbbbbbbbbb", askedAt: T0 + 10, parentSessionID: "ses_other", rootJobId: "job9" }),
    stored({ id: "tq_cccccccccccccccc", askedAt: T0 + 20, state: "answered", answeredAt: T0 + 30, delivery: "steer" }),
    stored({ id: "tq_dddddddddddddddd", askedAt: T0 + 40, state: "dismissed" }),
  ]);
  const all = await r.tq.listOpen({});
  assert.deepEqual(all.map((q) => q.id), ["tq_bbbbbbbbbbbbbbbb", "tq_aaaaaaaaaaaaaaaa"]);
  const mine = await r.tq.listOpen({ sessionID: PARENT });
  assert.deepEqual(mine.map((q) => q.id), ["tq_aaaaaaaaaaaaaaaa"]);
  for (const k of ["childSessionID", "formID", "pendingReply", "sent"]) assert.ok(!(k in mine[0]), k);
  assert.equal(mine[0].state, "open");
  await r.cleanup();
});

test("listOpen: follows the task's chat when the chat was replaced (a handoff re-points the job, not the question)", async () => {
  const r = await rig();
  await r.write([stored()]);
  r.records[0].parentSessionID = "ses_successor";
  assert.deepEqual((await r.tq.listOpen({ sessionID: PARENT })).map((q) => q.id), []);
  const moved = await r.tq.listOpen({ sessionID: "ses_successor" });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].parentSessionID, "ses_successor");
  await r.cleanup();
});

test("hasOpen / openCountFor: open, delivering and continue-pending count; answered, dismissed and failed don't; keyed by the task's root", async () => {
  const r = await rig();
  await r.write([
    stored({ id: "tq_1111111111111111" }),
    stored({ id: "tq_2222222222222222", rootJobId: "r2", delivering: { messageID: "msg_1", at: T0 } }),
    stored({ id: "tq_3333333333333333", rootJobId: "r3", state: "answered", delivery: "continue-pending" }),
    stored({ id: "tq_4444444444444444", rootJobId: "r4", state: "answered", delivery: "steer" }),
    stored({ id: "tq_5555555555555555", rootJobId: "r5", state: "dismissed" }),
    stored({ id: "tq_6666666666666666", rootJobId: "r6", state: "failed" }),
  ]);
  const fresh = createTaskQuestions({ root: r.root, now: () => T0, publish() {}, delegate: {}, oc: {} });
  assert.deepEqual(["job1", "r2", "r3", "r4", "r5", "r6", "nope"].map((x) => fresh.hasOpen(x)), [true, true, true, false, false, false, false], "a fresh process reads the store at once");
  assert.equal(fresh.openCountFor("job1"), 1);
  assert.equal(fresh.openCountFor("r2"), 1, "an answer in flight still counts");
  assert.equal(fresh.openCountFor("r3"), 0, "openCountFor is the number of questions waiting for the user's answer");
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// the ending gate's side of the store
// ---------------------------------------------------------------------------

test("pendingSteer / markContinuePending / hasContinuePending: the steered answers of a task, and turning them into continue-pending", async () => {
  const r = await rig();
  await r.write([
    stored({ id: "tq_1111111111111111", state: "answered", delivery: "steer", sent: { messageID: "msg_a", text: "A" } }),
    stored({ id: "tq_2222222222222222", state: "open", delivering: { messageID: "msg_b", at: T0 }, sent: { messageID: "msg_b", text: "B" } }),
    stored({ id: "tq_3333333333333333", state: "answered", delivery: "continue", sent: { messageID: "msg_c", text: "C" } }),
    stored({ id: "tq_4444444444444444", rootJobId: "other", state: "answered", delivery: "steer", sent: { messageID: "msg_d", text: "D" } }),
  ]);
  const steer = await r.tq.pendingSteer("job1");
  assert.deepEqual(steer.map((s) => [s.id, s.messageID, s.text]), [["tq_1111111111111111", "msg_a", "A"], ["tq_2222222222222222", "msg_b", "B"]]);
  assert.equal(await r.tq.hasContinuePending("job1"), false);
  await r.tq.markContinuePending("job1", ["tq_1111111111111111", "tq_2222222222222222"]);
  const qs = await r.stored();
  assert.deepEqual(qs.slice(0, 2).map((q) => [q.state, q.delivery, q.delivering]), [["answered", "continue-pending", null], ["answered", "continue-pending", null]]);
  assert.equal(await r.tq.hasContinuePending("job1"), true);
  assert.equal(await r.tq.hasContinuePending("other"), false);
  assert.equal(r.tq.hasOpen("job1"), true);
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// onRoundSettled
// ---------------------------------------------------------------------------

test("onRoundSettled: every continue-pending answer of the root goes out in ONE continuation; success records each as continued", async () => {
  const r = await rig();
  await r.write([
    stored({ id: "tq_1111111111111111", state: "answered", answeredAt: T0, answer: [["Add"]], delivery: "continue-pending" }),
    stored({ id: "tq_2222222222222222", state: "answered", answeredAt: T0, answer: [["Other"]], delivery: "continue-pending", questions: [{ question: "Second?", options: [], multiple: false }] }),
    stored({ id: "tq_3333333333333333", state: "open" }),
  ]);
  let seen = null;
  r.out.deliverResult = async (a) => {
    seen = (await r.stored()).map((q) => q.delivering?.messageID ?? null);
    return { delivery: "continue" };
  };
  const res = await r.tq.onRoundSettled({ id: "job1", status: "done", completionDelivery: "deferred" });
  assert.deepEqual(res, { continued: true });
  assert.equal(r.calls.deliver.length, 1, "one continuation");
  assert.equal(r.calls.deliver[0].root, "job1");
  assert.equal(r.calls.deliver[0].text, 'Answer from the user to your question "Create it?": Add\n\nAnswer from the user to your question "Second?": Other');
  assert.match(seen[0], /^msg_/);
  assert.equal(seen[0], seen[1], "claimed under one message id before the send");
  assert.equal(seen[2], null, "an open question isn't part of it");
  const qs = await r.stored();
  assert.deepEqual(qs.slice(0, 2).map((q) => [q.delivery, q.delivering]), [["continue", null], ["continue", null]]);
  assert.equal(qs[2].state, "open");
  assert.deepEqual(r.state.violations, []);
  await r.cleanup();
});

test("onRoundSettled: a refused or failed continuation puts the answers back to open with the sentence as their error", async () => {
  for (const how of ["refuse", "throw"]) {
    const r = await rig();
    await r.write([stored({ state: "answered", answeredAt: T0, answer: [["Add"]], delivery: "continue-pending" })]);
    if (how === "refuse") r.out.deliverResult = { error: "that job's session is busy" };
    else r.fail.deliver = new Error("fetch failed");
    const res = await r.tq.onRoundSettled({ id: "job1" });
    assert.equal(res.continued, false);
    assert.ok(res.error);
    const [q] = await r.stored();
    assert.equal(q.state, "open");
    assert.equal(q.delivery, null);
    assert.equal(q.delivering, null);
    assert.ok(q.error);
    assert.equal(q.answeredAt, null);
    await r.cleanup();
  }
});

test("onRoundSettled: nothing continue-pending → nothing to do (continued:false, no error)", async () => {
  const r = await rig();
  assert.deepEqual(await r.tq.onRoundSettled({ id: "job1" }), { continued: false });
  assert.equal(r.calls.deliver.length, 0);
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// sweep (boot pass and the 60 s sweep)
// ---------------------------------------------------------------------------

test("sweep: a stale claim whose message the child holds is answered (steer); one a newer round was created with is answered (continue); one with no trace is cleared and stays open", async () => {
  const r = await rig({ jobs: [JOB(), JOB({ id: "job2", rootJobId: "job1", attempt: 2, launch: { messageId: "msg_cont", continuation: true } })] });
  await r.write([
    stored({ id: "tq_1111111111111111", delivering: { messageID: "msg_steer", at: T0 }, answer: [["a"]] }),
    stored({ id: "tq_2222222222222222", delivering: { messageID: "msg_cont", at: T0 }, answer: [["b"]] }),
    stored({ id: "tq_3333333333333333", delivering: { messageID: "msg_none", at: T0 }, answer: [["c"]] }),
  ]);
  r.messages.add(`${CHILD}/msg_steer`);
  r.state.now = T0 + 5 * MIN;
  await r.tq.sweep();
  const [a, b, c] = await r.stored();
  assert.deepEqual([a.state, a.delivery, a.delivering], ["answered", "steer", null]);
  assert.deepEqual([b.state, b.delivery, b.delivering], ["answered", "continue", null]);
  assert.deepEqual([c.state, c.delivery, c.delivering], ["open", null, null], "the user can press again");
  assert.deepEqual(r.state.violations, []);
  await r.cleanup();
});

test("sweep: a claim younger than the grace is left alone (it may be in flight); an unreadable check leaves it too", async () => {
  const r = await rig();
  await r.write([stored({ delivering: { messageID: "msg_x", at: T0 }, answer: [["a"]] })]);
  r.state.now = T0 + 5_000;
  await r.tq.sweep();
  assert.ok((await r.stored())[0].delivering, "too young");
  assert.deepEqual(r.calls.readMessage, []);
  r.state.now = T0 + 5 * MIN;
  r.fail.readMessage = new Error("down");
  await r.tq.sweep();
  assert.ok((await r.stored())[0].delivering, "unknown proves nothing");
  await r.cleanup();
});

test("sweep: an answer in flight that finishes after the sweep cleared its claim is still recorded — the send itself decides", async () => {
  const r = await rig();
  const { id } = await r.capture();
  let release;
  r.out.deliverResult = async () => {
    await new Promise((res) => (release = res));
    return { delivery: "steer" };
  };
  const pending = r.tq.answer(id, [["a"]]);
  await new Promise((res) => setTimeout(res, 20));
  r.state.now = T0 + 5 * MIN;
  await r.tq.sweep(); // no trace of the message → cleared
  assert.equal((await r.stored())[0].delivering, null);
  release();
  const res = await pending;
  assert.equal(res.ok, true, "the message was sent: that is what the user is told");
  const [q] = await r.stored();
  assert.deepEqual([q.state, q.delivery, q.delivering], ["answered", "steer", null]);
  await r.cleanup();
});

test("sweep: a capture whose reply never happened (the box restarted) is marked failed once the form is no longer ours to reply to; a reply that did happen is kept", async () => {
  const r = await rig();
  await r.write([
    stored({ id: "tq_1111111111111111", pendingReply: true, formID: "frm_still", askedAt: T0 }),
    stored({ id: "tq_2222222222222222", pendingReply: true, formID: "frm_gone", askedAt: T0 }),
    stored({ id: "tq_3333333333333333", pendingReply: true, formID: "frm_young", askedAt: T0 + 5 * MIN }),
  ]);
  r.pendingForms.add({ id: "frm_still", sessionID: CHILD });
  r.pendingForms.add({ id: "frm_young", sessionID: CHILD });
  r.state.now = T0 + 5 * MIN + 5_000;
  await r.tq.sweep();
  const [a, b, c] = await r.stored();
  assert.deepEqual([a.state, a.error], ["failed", "The task's question was lost in a restart"], "still pending: it was never replied to");
  assert.deepEqual([b.state, b.pendingReply], ["open", false], "no longer pending: the reply went through, only the record was lost");
  assert.deepEqual([c.state, c.pendingReply], ["open", true], "too young to judge");
  assert.equal(r.tq.hasOpen("job1"), true);
  await r.cleanup();
});

test("sweep: a continue-pending answer whose task is finished (and not being deferred) is sent now; one whose task is still running is left", async () => {
  const r = await rig({ jobs: [JOB({ status: "done", completionDelivery: "delivered" }), JOB({ id: "r2", childSessionID: "ses_2", status: "running" })] });
  await r.write([
    stored({ id: "tq_1111111111111111", state: "answered", answeredAt: T0, answer: [["a"]], delivery: "continue-pending" }),
    stored({ id: "tq_2222222222222222", rootJobId: "r2", jobId: "r2", state: "answered", answeredAt: T0, answer: [["b"]], delivery: "continue-pending" }),
  ]);
  r.out.deliverResult = { delivery: "continue" };
  await r.tq.sweep();
  assert.equal(r.calls.deliver.length, 1);
  assert.equal(r.calls.deliver[0].root, "job1");
  const [a, b] = await r.stored();
  assert.equal(a.delivery, "continue");
  assert.equal(b.delivery, "continue-pending");
  await r.cleanup();
});

test("sweep: a continue-pending answer on a deferred round is the engine's to send (onRoundSettled), not the sweep's", async () => {
  const r = await rig({ jobs: [JOB({ status: "done", completionDelivery: "deferred" })] });
  await r.write([stored({ state: "answered", answeredAt: T0, answer: [["a"]], delivery: "continue-pending" })]);
  await r.tq.sweep();
  assert.equal(r.calls.deliver.length, 0);
  await r.cleanup();
});

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

test("store: open questions are never evicted; the others go after 7 days; the cap keeps the newest", async () => {
  const r = await rig();
  const old = T0 - 8 * DAY;
  await r.write([
    stored({ id: "tq_1111111111111111", askedAt: old }), // open, old: kept
    stored({ id: "tq_2222222222222222", state: "answered", delivery: "steer", askedAt: old, answeredAt: old }), // old: goes
    stored({ id: "tq_3333333333333333", state: "dismissed", askedAt: T0 - DAY }), // recent: kept
  ]);
  await r.capture(FORM({ id: "frm_n" })); // any write prunes
  const ids = (await r.stored()).map((q) => q.id);
  assert.ok(ids.includes("tq_1111111111111111"));
  assert.ok(!ids.includes("tq_2222222222222222"));
  assert.ok(ids.includes("tq_3333333333333333"));

  const many = Array.from({ length: 320 }, (_, i) => stored({ id: `tq_${String(i).padStart(16, "0")}`, rootJobId: `r${i}`, state: "dismissed", askedAt: T0 - 1000 + i }));
  many.push(stored({ id: "tq_aaaaaaaaaaaaaaaa", rootJobId: "keep" })); // open
  await r.write(many);
  await r.capture(FORM({ id: "frm_m" }));
  const after = await r.stored();
  assert.ok(after.length <= 300 + 2, `capped (${after.length})`);
  assert.ok(after.some((q) => q.id === "tq_aaaaaaaaaaaaaaaa"), "an open question survives the cap");
  assert.ok(!after.some((q) => q.id === "tq_0000000000000000"), "the oldest finished one went first");
  await r.cleanup();
});

test("store: every mutation reads strictly — an unreadable store is a sentence, never overwritten", async () => {
  const r = await rig();
  const { id } = await r.capture();
  await writeFile(r.file, "{ broken");
  const a = await r.tq.answer(id, [["x"]]);
  assert.equal(a.ok, false);
  assert.match(a.error, /Couldn't read the saved questions/);
  const d = await r.tq.dismiss(id);
  assert.equal(d.ok, false);
  assert.equal(await readFile(r.file, "utf-8"), "{ broken");
  assert.equal(r.calls.deliver.length, 0, "nothing was sent");
  // display reads degrade to empty
  assert.deepEqual(await r.tq.listOpen({}), []);
  await r.cleanup();
});
