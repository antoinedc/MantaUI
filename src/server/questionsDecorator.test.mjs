import { test } from "node:test";
import assert from "node:assert/strict";
import { createQuestionsDecorator, planForQuestion, planMetrics, firstHeading, isPlanExitQuestion } from "./questionsDecorator.mjs";

const PLAN = "# Ship the thing\n\n## Step 1: models\n- `src/a.ts`\n- prose bullet\n## Step 2: ui\n- `web/b.tsx`\n";
const planPart = (callID, input, extra = {}) => ({ type: "tool", id: `t-${callID}`, callID, tool: "plan_exit", state: { status: "completed", input }, ...extra });
const msg = (id, parts) => ({ info: { id, role: "assistant" }, parts });
const q = (id, callID, header = "Build Agent") => ({ id, sessionID: "ses_1", questions: [{ header, question: "Plan at x?", options: [] }], ...(callID ? { tool: { messageID: "m", callID } } : {}) });
const BASE = "https://abc.boxes.mantaui.com";

test("exact callID match → a plan with title, text, counts, path and page url", () => {
  const messages = [msg("m1", [planPart("c1", { plan: PLAN }), { type: "text", id: "x", text: "see .opencode/plans/2026-10-29-x.md" }])];
  const plan = planForQuestion({ question: q("q1", "c1"), messages, sessionId: "ses_1", baseUrl: BASE });
  assert.equal(plan.title, "Ship the thing");
  assert.equal(plan.text, PLAN);
  assert.deepEqual([plan.steps, plan.files], [2, 2]);
  assert.equal(plan.path, ".opencode/plans/2026-10-29-x.md");
  assert.equal(plan.pageUrl, `${BASE}/pages/plan-ses1`);
});

test("no matching plan_exit part (a different callID, a non-plan tool, no callID) → no plan; the text is never consulted", () => {
  const messages = [msg("m1", [planPart("c1", { plan: PLAN }), { type: "tool", id: "r", callID: "c2", tool: "read", state: { input: { plan: PLAN } } }])];
  assert.equal(planForQuestion({ question: q("q", "other"), messages, sessionId: "s", baseUrl: BASE }), null);
  assert.equal(planForQuestion({ question: q("q", "c2"), messages, sessionId: "s", baseUrl: BASE }), null, "a read tool is not plan_exit");
  assert.equal(planForQuestion({ question: q("q", null), messages, sessionId: "s", baseUrl: BASE }), null);
  const lookalike = { ...q("q", null), questions: [{ header: "Build Agent", question: "Plan at .opencode/plans/x.md" }] };
  assert.equal(planForQuestion({ question: lookalike, messages, sessionId: "s", baseUrl: BASE }), null);
});

test("plan text keys: plan / content / text; the tool name may be nested under state.input.tool", () => {
  for (const key of ["plan", "content", "text"]) {
    const m = [msg("m", [planPart("c", { [key]: "# T\nbody" })])];
    assert.equal(planForQuestion({ question: q("q", "c"), messages: m, sessionId: "s", baseUrl: null }).text, "# T\nbody", key);
  }
  const nested = [msg("m", [{ type: "tool", id: "t", callID: "c", state: { input: { tool: "plan_exit", plan: "# N" } } }])];
  assert.equal(planForQuestion({ question: q("q", "c"), messages: nested, sessionId: "s", baseUrl: null }).title, "N");
});

test("title fallbacks: first heading → first non-blank line → the question's header → 'Plan complete'", () => {
  const t = (plan, header = "Build Agent") => planForQuestion({ question: q("q", "c", header), messages: [msg("m", [planPart("c", plan === null ? {} : { plan })])], sessionId: "s", baseUrl: null }).title;
  assert.equal(t("intro\n\n### Real heading\nbody"), "Real heading");
  assert.equal(t("\n\n  just a line  \nmore"), "just a line");
  assert.equal(t(null), "Build Agent");
  assert.equal(t(null, ""), "Plan complete");
  assert.equal(firstHeading("  # indented"), null, "a heading must start the line (the desktop rule)");
});

test("path: the part's own plan ref wins; else the first authoring-tool/text ref in the transcript; a read tool is ignored; none → null", () => {
  const own = [msg("m", [planPart("c", { plan: "p", planPath: ".opencode/plans/own.md" }), { type: "text", id: "x", text: ".opencode/plans/other.md" }])];
  assert.equal(planForQuestion({ question: q("q", "c"), messages: own, sessionId: "s", baseUrl: null }).path, ".opencode/plans/own.md");
  const fromTranscript = [msg("m0", [{ type: "tool", id: "w", callID: "w", tool: "write", state: { input: { filePath: "/r/.opencode/plans/w.md" } } }]), msg("m1", [planPart("c", { plan: "p" })])];
  assert.equal(planForQuestion({ question: q("q", "c"), messages: fromTranscript, sessionId: "s", baseUrl: null }).path, ".opencode/plans/w.md");
  const readOnly = [msg("m0", [{ type: "tool", id: "r", callID: "r", tool: "read", state: { input: { filePath: ".opencode/plans/r.md" } } }]), msg("m1", [planPart("c", { plan: "p" })])];
  assert.equal(planForQuestion({ question: q("q", "c"), messages: readOnly, sessionId: "s", baseUrl: null }).path, null);
});

test("pageUrl is null when the box has no public base url", () => {
  const m = [msg("m", [planPart("c", { plan: "# T" })])];
  assert.equal(planForQuestion({ question: q("q", "c"), messages: m, sessionId: "ses_1", baseUrl: null }).pageUrl, null);
});

test("metrics: steps are 'Step…' headings, files are bullets naming a path-like code span", () => {
  assert.deepEqual(planMetrics(""), { steps: 0, files: 0 });
  assert.deepEqual(planMetrics("## Step 1\n- `a.ts`\n* `b/c.go`\n- plain\n### step two\n## Overview\n- `noext`"), { steps: 2, files: 2 });
});

test("isPlanExitQuestion: decorated, or opencode's own literal; nothing else", () => {
  assert.equal(isPlanExitQuestion({ plan: { title: "x" } }), true);
  assert.equal(isPlanExitQuestion({ question: "Plan at /x.md ready" }), true);
  assert.equal(isPlanExitQuestion({ header: "Build Agent" }), true);
  assert.equal(isPlanExitQuestion({ question: "Which db?", header: "DB" }), false);
  assert.equal(isPlanExitQuestion(null), false);
});

// ---- the stateful decorator ----
function rig(messagesBySession = {}, { baseUrl = BASE, now } = {}) {
  const published = [];
  const reads = [];
  const release = [];
  const timers = [];
  const d = createQuestionsDecorator({
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    publish: (e) => published.push(e),
    listMessages: (sid) => { reads.push(sid); const m = messagesBySession[sid]; return typeof m === "function" ? m() : Promise.resolve(m ?? []); },
    baseUrl: () => baseUrl,
    ...(now ? { now } : {}),
    warn: () => {},
  });
  return { d, published, reads, release, timers };
}
const frame = (sid, questions) => ({ kind: "stream", sub: "questions", sessionId: sid, payload: { questions } });
const tick = () => new Promise((r) => setImmediate(r));

test("a questions frame with a plan_exit callID is decorated (one transcript read, cached per (session, callID))", async () => {
  const { d, published, reads } = rig({ ses_1: [msg("m", [planPart("c1", { plan: PLAN })])] });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.questions[0].plan.title, "Ship the thing");
  d.publish(frame("ses_1", [q("q1", "c1")]));
  assert.equal(published.length, 2, "the second is served from the cache synchronously");
  assert.equal(reads.length, 1);
  assert.equal(published[1].payload.questions[0].plan.steps, 2);
});

test("questions with no callID, and other frame kinds, pass straight through synchronously", () => {
  const { d, published, reads } = rig();
  d.publish(frame("ses_1", [q("q1", null)]));
  d.publish({ kind: "stream", sub: "running", sessionId: "ses_1", payload: { running: true } });
  assert.equal(published.length, 2);
  assert.equal(reads.length, 0);
});

test("an overtaken decorated publish is dropped: a newer questions frame wins", async () => {
  let resolveFirst;
  const { d, published } = rig({ ses_1: () => new Promise((res) => { resolveFirst = () => res([msg("m", [planPart("c1", { plan: PLAN })])]); }) });
  d.publish(frame("ses_1", [q("q1", "c1")])); // pending lookup
  d.publish(frame("ses_1", []));              // newer: the question was answered — published at once
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].payload.questions, []);
  resolveFirst();
  await tick();
  assert.equal(published.length, 1, "the stale decorated list never goes out after the empty one");
});

test("the connect snapshot replays decorated questions; a session never decorated stays plain", async () => {
  const { d } = rig({ ses_1: [msg("m", [planPart("c1", { plan: PLAN })])] });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  const snap = d.decorateSnapshot([
    { kind: "runningSet", payload: { sessions: [] } },
    frame("ses_1", [q("q1", "c1")]),
    frame("ses_2", [q("q9", "zz")]),
  ]);
  assert.equal(snap[0].kind, "runningSet");
  assert.equal(snap[1].payload.questions[0].plan.title, "Ship the thing");
  assert.equal(snap[2].payload.questions[0].plan, undefined);
});

test("opencode:questions (decorate) adds the plan the same way", async () => {
  const { d } = rig({ ses_1: [msg("m", [planPart("c1", { plan: "# Hi\n## Step 1" })])] });
  const out = await d.decorate("ses_1", [q("q1", "c1"), q("q2", "c-other")]);
  assert.equal(out[0].plan.title, "Hi");
  assert.equal(out[1].plan, undefined);
});

test("a failed transcript read leaves the question undecorated (still answerable) and publishes it", async () => {
  const { d, published } = rig({ ses_1: () => Promise.reject(new Error("down")) });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.questions[0].plan, undefined);
});

test("a plan_exit part that is not readable yet is picked up by one re-check, and the decorated list is republished", async () => {
  const state = { m: [] };
  const { d, published, reads, timers } = rig({ ses_1: () => Promise.resolve(state.m) });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.questions[0].plan, undefined, "first read: no part yet, published plain");
  assert.equal(timers.length, 1, "one re-check armed");
  state.m = [msg("m", [planPart("c1", { plan: PLAN })])];
  timers[0].fn();
  await tick();
  assert.equal(published.length, 2);
  assert.equal(published[1].payload.questions[0].plan.title, "Ship the thing");
  assert.equal(reads.length, 2);
  assert.equal(timers.length, 1, "the re-check is one-shot");
  const snap = d.decorateSnapshot([frame("ses_1", [q("q1", "c1")])]);
  assert.equal(snap[0].payload.questions[0].plan.title, "Ship the thing", "the snapshot replays the late decoration");
});

test("a re-check that still finds no part publishes nothing; one overtaken by a newer frame does nothing", async () => {
  const { d, published, timers } = rig({ ses_1: [] });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  timers[0].fn();
  await tick();
  assert.equal(published.length, 1, "no part, no republish");

  const rig2 = rig({ ses_1: [msg("m", [planPart("c1", { plan: PLAN })])] });
  rig2.d.publish(frame("ses_1", [q("q1", "c-none")]));
  await tick();
  assert.equal(rig2.timers.length, 1);
  rig2.d.publish(frame("ses_1", []));
  assert.equal(rig2.timers[0].cleared, true, "a newer frame cancels the pending re-check");
  rig2.timers[0].fn();
  await tick();
  assert.equal(rig2.published.length, 2, "only the two frames themselves");
});

test("an ORDINARY question (no plan-exit literal) arms no late-part re-check — it costs no second transcript read", async () => {
  const { d, published, timers, reads } = rig({ ses_1: [] });
  const plain = { id: "q1", sessionID: "ses_1", questions: [{ header: "DB", question: "Which database?", options: [] }], tool: { messageID: "m", callID: "c-ordinary" } };
  d.publish(frame("ses_1", [plain]));
  await tick();
  assert.equal(published.length, 1);
  assert.equal(timers.length, 0, "no timer for a question that does not look like plan_exit");
  assert.equal(reads.length, 1);
});

test("the snapshot never replays a plain card the cache already knows is a plan (per question, the decorated one wins)", async () => {
  let clock = 1_000;
  const state = { m: [] };
  const { d, timers } = rig({ ses_1: () => Promise.resolve(state.m) }, { now: () => clock });
  d.publish(frame("ses_1", [q("q1", "c1")]));
  await tick();
  timers[0].fn(); // the re-check misses: still no part
  await tick();
  assert.equal(d._state.latest.get("ses_1")[0].plan, undefined, "published plain");
  clock += 60_000; // past the negative cache
  state.m = [msg("m", [planPart("c1", { plan: PLAN })])];
  const out = await d.decorate("ses_1", [q("q1", "c1")]); // the part is there now (opencode:questions)
  assert.equal(out[0].plan.title, "Ship the thing");
  const snap = d.decorateSnapshot([frame("ses_1", [q("q1", "c1")])]);
  assert.equal(snap[0].payload.questions[0].plan.title, "Ship the thing");
});
