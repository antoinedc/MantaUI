#!/usr/bin/env node
// Probe for the specialist question path, on the REAL pinned OpenCode V2 binary and the REAL delegate engine + question store,
// no API spend.
//
//   node scripts/opencode-v2/question-capture.e2e.mjs
//
// (docs/superpowers/specs/2026-11-24-ask-user-tool.md = the question tool; docs/superpowers/specs/2026-11-26-agents-screens.md §4 =
// questions that don't block the task.)
//
// A scripted stand-in for the model calls OpenCode's standard `question` tool. The job's child is created through the production
// client with the production rulesets; the production pump rule (a question form in an owned session goes to
// `engine.handleQuestion`) is replayed here. Asserts, on the real binary:
//   [1] a specialist's question is NON-BLOCKING: the form is answered at once with the placeholder (the tool call returns it), the
//       turn is NOT interrupted and goes on (a second tool call happens), nothing is left pending, the question is stored open;
//   [2] the user's answer is STEERED into the running turn: a user message carrying the answer appears in the SAME run (no new
//       execution) and the model's next request sees it;
//   [3] a task that ends with its question open ends `done` (not "needs a decision") with a result that says it is waiting; the
//       answer then CONTINUES the finished task (a new round whose first message carries the answer);
//   [4] the ending gate's matching rule: what a steered message looks like in the child's inbox (printed), that it can be matched
//       to the message id we sent it under, and that cancelling it takes it out — the inbox item shape the gate relies on;
//   [5] a plain delegate job's question call is denied by its ruleset and raises no form: its questions stay denied, as before;
//   [6] the old path still works when the form forbids typing: the task ends `done` / "needs a decision" with ONE result.
//
// SAFETY: sandbox only (sandbox.mjs: own port, random password, own HOME/XDG, a temp jobs file, fake tmux). The live opencode
// (:4096) and manta-server (:8787) are never contacted.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";
import { MODES } from "../../src/shared/autonomyShared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${String(detail).slice(0, 900)}` : ""}`);
};
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, pred, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(150);
  }
  check(`(timeout) ${label}`, false);
  return false;
}

// ---- the scripted "model" ----
const QUESTION = "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro: the library says narrow agents are rarely routed to.";
const OPTIONS = [
  { label: "Add to @conversion-cro", description: "One agent keeps the pricing rules." },
  { label: "Create @pricing-copy", description: "A separate agent, as asked." },
];
// two questions in one form, the first one multiple-choice (every field of the form must get its placeholder)
const MULTI_QUESTIONS = [
  { question: "Which markets first?", header: "Markets", options: [{ label: "US", description: "largest" }, { label: "EU", description: "regulated" }], multiple: true },
  { question: "Name it now?", header: "Name", options: [{ label: "Yes", description: "now" }, { label: "Later", description: "after review" }] },
];
// What each scenario's prompt says (the first user message): STEER keeps working until the answer arrives; END finishes at once.
const textOfMessages = (body) => JSON.stringify(body.messages ?? []);
const offers = []; // the tool names each model request was offered
const asked = []; // [scenario, request index]
const decideFn = (body) => {
  const names = (body.tools ?? []).map((t) => t.name);
  offers.push(names);
  const all = textOfMessages(body);
  const scenario = /SCENARIO-(STEER|MULTI)/.test(all) ? "steer" : /SCENARIO-END/.test(all) ? "end" : /SCENARIO-IDLE/.test(all) ? "idle" : "plain";
  const multi = /SCENARIO-MULTI/.test(all);
  const q = names.find((n) => /^question$/i.test(n));
  const toolResults = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_result") : []));
  const answerSeen = /Answer from the user to your question/.test(all);
  if (scenario === "plain") return { kind: "text", text: "done" };
  if (scenario === "idle") {
    // keeps working with read-only calls (it never asks by itself): a task that is really running when a form is replayed into it
    return toolResults.length < 12 ? { kind: "tool", name: names.find((n) => /^glob$/i.test(n)) ?? names[0], input: { pattern: "*" } } : { kind: "text", text: "done" };
  }
  if (!q) return { kind: "text", text: "done" };
  if (toolResults.length === 0) return { kind: "tool", name: q, input: { questions: multi ? MULTI_QUESTIONS : [{ question: QUESTION, header: "Agent", options: OPTIONS }] } };
  if (scenario === "end") return answerSeen ? { kind: "text", text: "Applied the answer." } : { kind: "text", text: "Finished everything that did not depend on the answer." };
  // steer: keep working (a read-only listing each time) until the answer is in the conversation
  if (answerSeen) return { kind: "text", text: "Applied the answer." };
  asked.push(["steer", toolResults.length]);
  if (toolResults.length > 12) return { kind: "text", text: "No answer arrived." };
  return { kind: "tool", name: names.find((n) => /^glob$/i.test(n)) ?? names[0], input: { pattern: "*" } };
};

// (an explicit model: a job with none would fall back to V2's own default, which is not the mock)
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const mock = await startMockAnthropic({ decideFn });
let sb;
try {
  sb = await startSandbox({
    binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
    plugins: [PLUGIN_DIR],
    dirs: ["repo"],
    config: { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } } },
    env: { ANTHROPIC_API_KEY: "mock", MANTA_SERVER_URL: "http://127.0.0.1:9", MANTA_BOX_TOKEN: "ab12".repeat(8) },
  });
  process.env.MANTA_OPENCODE_PASSWORD = sb.password;
  const oc = await import("../../src/server/opencode.mjs");
  oc._setApiBase(sb.url);
  const delegateMod = await import("../../src/server/delegate.mjs");
  const { createJobLiveness } = await import("../../src/server/jobLiveness.mjs");
  const { createLifecycleAdapter, isQuestionForm } = await import("../../src/shared/opencodeV2.mjs");
  const { decisionLines, DECISION_HEADER, PLACEHOLDER_ANSWER, waitingLine } = await import("../../src/server/taskDecision.mjs");
  const { createTaskQuestions } = await import("../../src/server/taskQuestions.mjs");

  // the REAL engine over the real client, a TEMP jobs file and a fake tmux
  const jobsFile = join(mkdtempSync(join(tmpdir(), "question-capture-jobs-")), "jobs.json");
  const windows = [];
  const posted = [];
  const liveness = createJobLiveness();
  const engine = delegateMod.createDelegateEngine({
    load: () => delegateMod.loadJobs(jobsFile),
    save: (jobs) => delegateMod.saveJobs(jobs, jobsFile),
    publish: () => {},
    liveness,
    autonomyPolicy: async () => ({ ...MODES.balanced }), // (a continuation re-reads the settings the task started under)
    home: join(sb.root, "home"),
    listProjects: async () => [{ tmuxSession: "probe", defaultCwd: sb.dirs.repo, windows: windows.map((w) => ({ ...w, paneCurrentPath: sb.dirs.repo })) }],
    newWindow: async ({ existingSessionId }) => {
      const index = 10 + windows.length;
      windows.push({ index, opencodeSessionId: existingSessionId });
      return { sessionId: existingSessionId, windowIndex: index };
    },
    killWindow: async () => {},
    stampOwner: async () => {},
    clearProgress: async () => {},
    readProgress: async () => null,
    listMessages: (sid) => oc.listMessages(sid),
    abortSession: (sid) => oc.abortSession(sid),
    rejectQuestion: (a) => oc.rejectQuestion(a),
    rejectPermission: (a) => oc.rejectPermission?.(a),
    listQuestions: (sid) => oc.listQuestions(sid),
    listPermissions: (sid) => oc.listPermissions(sid),
    readSession: (sid) => oc.readSession(sid),
    listActiveIds: () => oc.listActiveSessionIds(),
    listChildSessions: (sid) => oc.listChildSessions(sid),
    listRawTimeline: (sid, o) => oc.listRawTimeline(sid, o),
    listInbox: (sid) => oc.listInbox(sid),
    cancelInboxItem: (sid, id) => oc.cancelInboxItem(sid, id),
    createChildSession: (i) => oc.createSession(i),
    moveSession: (sid, dir) => oc.moveSession(sid, dir),
    sendChildPrompt: (i) => oc.sendPrompt(i),
    sessionExists: (sid) => oc.sessionExists(sid),
    deliver: async () => undefined,
    runCommandOnChild: (i) => oc.runCommand(i),
    deleteSession: (sid) => oc.deleteSessionRaw(sid),
    postSynthetic: async (sid, body) => {
      posted.push({ sid, body });
      return oc.postSynthetic(sid, body);
    },
    isCtoConversationSession: async () => false,
    openCommandWindows: () => [],
    oc,
  });
  // the question store, over this engine (what index.mjs wires in production)
  const tq = createTaskQuestions({
    root: join(sb.root, "agents"),
    publish: () => {},
    delegate: engine,
    oc,
  });
  engine.setTaskQuestions(tq);

  // the production pump rules this change touches: a question form in a job's session goes to the engine, never to a client
  const forms = [];
  const adapter = createLifecycleAdapter();
  const stop = oc.subscribeEvents((raw) => {
    if (raw?.type === "form.created" && isQuestionForm(raw.data?.form)) {
      forms.push(raw.data.form);
      if (engine.ownsSession(raw.data.form.sessionID)) {
        void engine.handleQuestion(raw.data.form).catch((e) => console.log("  [engine] handleQuestion failed:", e?.message ?? e));
        return;
      }
    }
    engine.observeRaw(raw).catch((e) => console.log("  [engine] observeRaw failed:", e?.message ?? e));
    for (const e of adapter.adapt(raw)) engine.observeEvent(e).catch(() => {});
  });
  await sleep(500);

  async function newParent() {
    const s = await oc.createSession({ directory: sb.dirs.repo, model: MODEL });
    windows.push({ index: 100 + windows.length, opencodeSessionId: s.id });
    return s;
  }
  const jobById = async (id) => (await delegateMod.loadJobs(jobsFile)).find((x) => x.id === id);
  const startTask = async (marker, name) => {
    const parent = await newParent();
    const res = await engine.startJob({
      prompt: `${marker} Decide whether the new agent should exist.`,
      name,
      parentSessionID: parent.id,
      parentDirectory: sb.dirs.repo,
      model: MODEL,
      specialist: true,
      isolation: "none",
      agentName: "Probe",
      agentDir: join(sb.root, "home", ".manta", "agents", "probe"),
      autonomy: { load: async () => ({ ...MODES.balanced }), check: () => null },
    });
    return { res, parent };
  };
  const toolParts = async (child) => (await oc.listMessages(child, { limit: 100 })).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
  const userTexts = async (child) => (await oc.listRawTimeline(child, { type: "user" })).map((r) => JSON.stringify(r));

  // ===== [1] + [2]: a specialist's task asks, keeps working, and the answer is steered in =====
  console.log("\n[1] a specialist's task calls the question tool — the question does not block it");
  mock.setDelay(900); // each model step takes a moment, so the turn is still running when the answer comes
  const { res } = await startTask("SCENARIO-STEER", "probe-steer");
  check("the specialist task started", res.ok === true, j(res));
  const id = res.job?.id;
  const child = res.job?.childSessionID;
  const rules = (await oc.readSession(child)).session?.permissions ?? [];
  check("the child's ruleset has no question deny", !rules.some((r) => /question/.test(`${r.action ?? r.permission}`) && (r.effect === "deny" || r.action === "deny")), j(rules.slice(-4)));
  const stored = await until("the question was captured", async () => (await tq.listOpen({})).length === 1, 60_000);
  const [open] = await tq.listOpen({});
  console.log(`  [info] stored question: ${j({ id: open?.id, state: open?.state, rootJobId: open?.rootJobId, parent: open?.parentSessionID === res.job?.parentSessionID })}`);
  check("a real question form was raised in the child's session", forms.some((f) => f.sessionID === child), j(forms.map((f) => f.sessionID)));
  check("the question is stored open with its text and options, keyed by the task's root", open?.state === "open" && open.rootJobId === id && open.questions?.[0]?.question === QUESTION && j(open.questions[0].options) === j(OPTIONS), j(open));
  await sleep(400);
  const mid = await jobById(id);
  check("the task is STILL RUNNING (nothing interrupted it, no decision stored, not blocked)", mid.status === "running" && mid.decision === undefined && mid.jobProgress?.modelState !== "blocked", j({ s: mid.status, d: mid.decision, m: mid.jobProgress?.modelState }));
  check("nothing is left pending: the form was answered", ((await oc.listQuestions(child)) ?? []).length === 0);
  const qPart = (await toolParts(child)).find((p) => /^question$/i.test(p.tool));
  console.log(`  [info] the question tool call returned: ${j(qPart?.state?.output ?? qPart?.state)}`.slice(0, 400));
  check("the question tool call RETURNED the placeholder", qPart?.state?.status === "completed" && JSON.stringify(qPart.state).includes(PLACEHOLDER_ANSWER.slice(0, 40)), j(qPart?.state));
  await until("the turn went on: a second tool call happened after the question", async () => (await toolParts(child)).some((p) => /^glob$/i.test(p.tool)), 30_000);
  check("the turn went on (a read-only call after the question)", (await toolParts(child)).some((p) => /^glob$/i.test(p.tool)));
  check("the task's milestone says it asked", (mid.jobProgress?.milestones ?? []).some((m) => /^Asked you: Create @pricing-copy/.test(m.text)), j(mid.jobProgress?.milestones));

  console.log("\n[2] the answer is steered into the RUNNING turn");
  const answered = await tq.answer(open.id, [["Add to @conversion-cro"]]);
  check("the answer was delivered by steering", answered.ok === true && answered.question?.delivery === "steer", j(answered));
  await until("the task settled", async () => ["done", "failed"].includes((await jobById(id))?.status), 90_000);
  const done = await jobById(id);
  console.log(`  [info] job: ${j({ status: done.status, endedBlocked: done.endedBlocked, error: done.error, askedUser: done.askedUser, completionDelivery: done.completionDelivery })}`);
  const users = await userTexts(child);
  check("a user message carrying the answer is in the SAME session", users.some((t) => t.includes("Answer from the user to your question") && t.includes("Add to @conversion-cro")), users.join("\n").slice(0, 600));
  const sawAnswer = mock.requests.some((r) => /SCENARIO-STEER/.test(JSON.stringify(r.body.messages)) && /Answer from the user to your question/.test(JSON.stringify(r.body.messages)));
  check("the model's next request carried the answer (it arrived mid-turn, at a step boundary)", sawAnswer);
  const timeline = await oc.listRawTimeline(child);
  const idles = timeline.filter((r) => r.type === "idle").length;
  console.log(`  [info] idle records in the child's timeline: ${idles}`);
  check("it was ONE run: no continuation was needed", (await delegateMod.loadJobs(jobsFile)).filter((x) => x.continues === id).length === 0 && done.status === "done");
  check("the task ended `done` (not `needs a decision`) and remembers it was answered", done.status === "done" && done.endedBlocked === false && done.error == null && done.askedUser === true, j({ s: done.status, b: done.endedBlocked, a: done.askedUser }));
  check("the question is answered and nothing is open", (await tq.listOpen({})).length === 0 && tq.hasOpen(id) === false);
  mock.setDelay(0);
  await until("the result was posted", async () => posted.length >= 1, 30_000);
  check("exactly one result for the task", posted.length === 1 && posted[0].body.metadata.manta.jobId === id, posted.map((p) => p.body.text.slice(0, 80)).join(" | "));

  // ===== [3] a task that ends with its question open; the answer continues it =====
  console.log("\n[3] a task that ends with its question open — the answer CONTINUES it");
  posted.length = 0;
  const end = await startTask("SCENARIO-END", "probe-end");
  const eid = end.res.job?.id;
  const echild = end.res.job?.childSessionID;
  await until("the second task settled", async () => ["done", "failed"].includes((await jobById(eid))?.status), 90_000);
  const ended = await jobById(eid);
  console.log(`  [info] job: ${j({ status: ended.status, endedBlocked: ended.endedBlocked, waiting: ended.waiting?.length, completionDelivery: ended.completionDelivery })}`);
  check("it ended `done` with its question still open (not `needs a decision`)", ended.status === "done" && ended.endedBlocked === false && tq.hasOpen(eid) === true, j({ s: ended.status, b: ended.endedBlocked }));
  await until("its result was posted", async () => posted.length >= 1, 30_000);
  const text = posted[0]?.body?.text ?? "";
  check("ONE result that says it is waiting for the answer, with no decision block", posted.length === 1 && text.includes(waitingLine([{ question: QUESTION }])) && !text.includes(DECISION_HEADER), text.slice(0, 700));
  const [openEnd] = await tq.listOpen({});
  const cont = await tq.answer(openEnd.id, [["Create @pricing-copy"]]);
  check("the answer continued the finished task", cont.ok === true && cont.question?.delivery === "continue", j(cont));
  await until("the continuation settled", async () => (await delegateMod.loadJobs(jobsFile)).some((x) => x.continues === eid && ["done", "failed"].includes(x.status)), 90_000);
  const next = (await delegateMod.loadJobs(jobsFile)).find((x) => x.continues === eid);
  check("a new round started on the same session, carrying the answer as its first message", next?.childSessionID === echild && next.launch?.text?.startsWith("Answer from the user to your question") && next.rootJobId === eid && next.askedUser === true, j({ c: next?.childSessionID === echild, r: next?.rootJobId, t: next?.launch?.text?.slice(0, 80) }));
  check("the continuation finished and the model saw the answer", next?.status === "done" && mock.requests.some((r) => /SCENARIO-END/.test(JSON.stringify(r.body.messages)) && /Create @pricing-copy/.test(JSON.stringify(r.body.messages.at(-1))) ), j({ s: next?.status }));

  // ===== [3b] one form, two questions (one multiple-choice) =====
  console.log("\n[3b] a form with two questions, one of them multiple-choice: every field gets the placeholder");
  mock.setDelay(600);
  posted.length = 0;
  const multi = await startTask("SCENARIO-MULTI", "probe-multi");
  const mid2 = multi.res.job?.id;
  const mchild = multi.res.job?.childSessionID;
  await until("the two-question form was captured", async () => (await tq.listOpen({})).some((q) => q.rootJobId === mid2), 60_000);
  const mq = (await tq.listOpen({})).find((q) => q.rootJobId === mid2);
  check("both questions are on one card, the first one multiple", mq?.questions?.length === 2 && mq.questions[0].multiple === true && mq.questions[1].multiple === false, j(mq?.questions));
  const mparts = await toolParts(mchild);
  const mOut = String(mparts.find((p) => /^question$/i.test(p.tool))?.state?.output ?? "");
  check("the tool call returned the placeholder for BOTH questions", (mOut.match(/Not answered yet/g) ?? []).length === 2, mOut.slice(0, 1500));
  const manswer = await tq.answer(mq.id, [["US", "EU"], ["Later"]]);
  check("the answer (a list for the first, one label for the second) was steered", manswer.ok === true && manswer.question?.delivery === "steer", j(manswer));
  await until("the multi task settled", async () => ["done", "failed"].includes((await jobById(mid2))?.status), 90_000);
  check("the task saw both answers (one line each) and finished", mock.requests.some((r) => /SCENARIO-MULTI/.test(JSON.stringify(r.body.messages)) && /to your question \\"Which markets first\?\\": US, EU/.test(JSON.stringify(r.body.messages)) && /to your question \\"Name it now\?\\": Later/.test(JSON.stringify(r.body.messages))) && (await jobById(mid2)).status === "done");
  mock.setDelay(0);

  // ===== [4] the ending gate's matching rule =====
  console.log("\n[4] what a steered message looks like in the child's inbox (the ending gate cancels it by id)");
  mock.setDelay(4000); // a long step: the steered message stays in the inbox
  const probe = await startTask("SCENARIO-STEER", "probe-inbox");
  const pchild = probe.res.job?.childSessionID;
  await until("the probe's turn is running", async () => (await oc.listActiveSessionIds()).includes(pchild), 30_000);
  const steerId = `msg_probe_${Date.now()}`;
  await oc.sendPrompt({ sessionId: pchild, text: "Answer from the user: inbox probe", delivery: "steer", messageID: steerId });
  const inbox = await oc.listInbox(pchild);
  const item = inbox.find((i) => i?.id === steerId) ?? inbox.find((i) => JSON.stringify(i).includes("inbox probe"));
  console.log(`  [info] inbox item: ${j(item)}`);
  check("the steered message is in the inbox", !!item, j(inbox));
  check("…and carries the message id we sent it under (the gate matches by id)", item?.id === steerId, j(item));
  if (item) {
    await oc.cancelInboxItem(pchild, item.id);
    const after = await oc.listInbox(pchild);
    check("cancelling it takes it out of the inbox", !after.some((i) => i?.id === item.id), j(after));
  }
  await engine.stopJob(probe.res.job.id);
  mock.setDelay(0);

  // ===== [5] a plain delegate job cannot ask =====
  console.log("\n[5] a plain delegate job: the question tool stays denied");
  const p2 = await newParent();
  const res2 = await engine.startJob({ prompt: "Do a small thing.", name: "probe-plain", model: MODEL, parentSessionID: p2.id, parentDirectory: sb.dirs.repo });
  check("the plain job started", res2.ok === true, j(res2));
  await until("the plain job settled", async () => ["done", "failed"].includes((await jobById(res2.job.id))?.status));
  const plain = await jobById(res2.job.id);
  const plainParts = (await oc.listMessages(res2.job.childSessionID, { limit: 50 })).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool" && /question/i.test(p.tool));
  console.log(`  [info] plain job's question call → ${j(plainParts.map((p) => ({ status: p.state?.status, error: p.state?.error })))}`);
  check("the plain job raised no question form in its session (a question call, if any, is denied by its ruleset)", forms.every((f) => f.sessionID !== res2.job.childSessionID) && plainParts.every((p) => p.state?.status === "error" && /denied|rule/i.test(String(p.state?.error ?? ""))), j(plainParts.map((p) => p.state)));
  check("the plain job ended as an ordinary job (not `needs a decision`)", plain.status === "done" && plain.endedBlocked === false && plain.decision === undefined, j({ s: plain.status, b: plain.endedBlocked }));

  // ===== [6] a form that forbids typing keeps today's path =====
  console.log("\n[6] a form that forbids typing: the task ends `needs a decision` (the old path)");
  // (the model's `question` tool always offers a free-text answer, so a form that forbids typing is replayed through the engine by hand,
  // into the session of a task that is really running)
  const fallbackForm = { id: "frm_probe_notyping", metadata: { kind: "question" }, fields: [{ key: "a", title: "Agent", description: QUESTION, type: "select", custom: false, options: OPTIONS.map((o) => ({ ...o, value: o.label })) }] };
  const running = await startTask("SCENARIO-IDLE", "probe-notyping");
  const rchild = running.res.job.childSessionID;
  mock.setDelay(1500);
  await until("the no-typing probe's turn is running", async () => (await oc.listActiveSessionIds()).includes(rchild), 30_000);
  const handled = await engine.handleQuestion({ ...fallbackForm, sessionID: rchild });
  check("(no stored question: the new path was not taken)", (await tq.listOpen({})).every((q) => q.rootJobId !== running.res.job.id));
  const rjob = await jobById(running.res.job.id);
  check("a form that forbids typing is captured as a DECISION (the old path): stored, blocked, the turn interrupted", handled.captured === true && !!rjob.decision && rjob.jobProgress?.modelState === "blocked", j({ handled, d: !!rjob.decision }));
  mock.setDelay(0);
  await until("the no-typing task settled", async () => ["done", "failed"].includes((await jobById(running.res.job.id))?.status), 60_000);
  const rdone = await jobById(running.res.job.id);
  check("it ended `done` / needs a decision", rdone.status === "done" && rdone.endedBlocked === true && decisionLines(rdone.decision).length > 0, j({ s: rdone.status, b: rdone.endedBlocked }));
  stop();
} catch (e) {
  check("probe ran to completion", false, e?.stack ?? String(e));
} finally {
  await sb?.stop();
  await mock.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
