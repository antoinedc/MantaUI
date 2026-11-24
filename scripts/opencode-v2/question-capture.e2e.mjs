#!/usr/bin/env node
// Probe for the specialist question path (docs/superpowers/specs/2026-11-24-ask-user-tool.md), on the REAL pinned OpenCode V2
// binary and the REAL delegate engine, no API spend.
//
//   node scripts/opencode-v2/question-capture.e2e.mjs
//
// A scripted stand-in for the model calls OpenCode's standard `question` tool once. The job's child is created through the
// production client with the production rulesets; the production pump rule (a question form in an owned session goes to
// `engine.handleQuestion`) is replayed here. Asserts, on the real binary:
//   - a specialist's task is OFFERED the question tool and its question raises a real form; the engine captures it as the
//     decision (question text, options, multiple), interrupts the turn (the REAL raw outcome is `interrupted`), rejects the
//     form (nothing is left pending) and settles the task as done / "needs a decision" with ONE result carrying the block;
//   - the task stops counting as running at once (the 5-task cap), and is never judged stalled;
//   - a plain delegate job's question call is denied by its ruleset and raises no form: its questions stay denied, as before.
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

// ---- the scripted "model": one `question` call (if the tool is offered), then a closing word ----
const QUESTION = "Create @pricing-copy as its own agent? I recommend adding it to @conversion-cro: the library says narrow agents are rarely routed to.";
const OPTIONS = [
  { label: "Add to @conversion-cro", description: "One agent keeps the pricing rules." },
  { label: "Create @pricing-copy", description: "A separate agent, as asked." },
];
const offers = []; // the tool names each model request was offered
const decideFn = (body) => {
  const names = (body.tools ?? []).map((t) => t.name);
  offers.push(names);
  const answered = (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
  const q = names.find((n) => /^question$/i.test(n));
  if (!q || answered) return { kind: "text", text: "done" };
  return { kind: "tool", name: q, input: { questions: [{ question: QUESTION, header: "Agent", options: OPTIONS }] } };
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
  const { decisionLines, DECISION_HEADER } = await import("../../src/server/taskDecision.mjs");

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

  // ===== a specialist's task asks =====
  console.log("\n[1] a specialist's task calls the question tool");
  const parent = await newParent();
  const res = await engine.startJob(
    {
      prompt: "Decide whether the new agent should exist.",
      name: "probe-asks",
      parentSessionID: parent.id,
      parentDirectory: sb.dirs.repo,
      model: MODEL,
      specialist: true,
      isolation: "none",
      agentName: "Probe",
      agentDir: join(sb.root, "home", ".manta", "agents", "probe"),
      autonomy: { load: async () => ({ ...MODES.balanced }), check: () => null },
    },
  );
  check("the specialist task started", res.ok === true, j(res));
  const id = res.job?.id;
  const child = res.job?.childSessionID;
  const rules = (await oc.readSession(child)).session?.permissions ?? [];
  console.log(`  [info] child permissions: ${j(rules.filter((r) => /question/.test(`${r.action ?? r.permission}`)))}`);
  check("the child's ruleset has no question deny", !rules.some((r) => /question/.test(`${r.action ?? r.permission}`) && (r.effect === "deny" || r.action === "deny")), j(rules.slice(-4)));

  await until("the task settled", async () => (await jobById(id))?.status === "done" || (await jobById(id))?.status === "failed");
  const job = await jobById(id);
  console.log(`  [info] job: ${j({ status: job.status, endedBlocked: job.endedBlocked, error: job.error, decision: job.decision })}`);
  check("the question tool was offered to the specialist's model", offers.some((n) => n.some((x) => /^question$/i.test(x))), j(offers[0]));
  check("a real question form was raised in the child's session", forms.some((f) => f.sessionID === child), j(forms.map((f) => f.sessionID)));
  check("the task ended `done` and `needs a decision` (not failed / interrupted)", job.status === "done" && job.endedBlocked === true && job.error == null, j({ s: job.status, e: job.error, b: job.endedBlocked }));
  check("the decision holds the question text and the options as labels and descriptions", job.decision?.questions?.[0]?.question === QUESTION && j(job.decision.questions[0].options) === j(OPTIONS) && job.decision.questions[0].multiple === false, j(job.decision));
  const sess = (await oc.readSession(child)).session;
  check("the turn really ended `interrupted` on the binary", sess?.outcome === "interrupted", j(sess?.outcome));
  check("nothing is left pending: no open question in the child's session", ((await oc.listQuestions(child)) ?? []).length === 0);
  await until("the result was posted", async () => posted.length >= 1, 30_000);
  const text = posted[0]?.body?.text ?? "";
  check("exactly one result, `needs a decision`, carrying the server-written block", posted.length === 1 && /^\[background job "[^"]+" needs a decision\]/.test(text) && decisionLines(job.decision).every((l) => text.includes(l)) && text.includes(DECISION_HEADER), text.slice(0, 600));
  const stillRunning = (await delegateMod.loadJobs(jobsFile)).filter((x) => x.status === "running");
  check("the task no longer counts toward the 5-task cap, and its liveness picture is gone", stillRunning.length === 0 && liveness.get(id) == null, j(stillRunning.map((x) => x.id)));

  // ===== a plain delegate job cannot ask =====
  console.log("\n[2] a plain delegate job: the question tool stays denied");
    const p2 = await newParent();
  const res2 = await engine.startJob({ prompt: "Do a small thing.", name: "probe-plain", model: MODEL, parentSessionID: p2.id, parentDirectory: sb.dirs.repo });
  check("the plain job started", res2.ok === true, j(res2));
  await until("the plain job settled", async () => ["done", "failed"].includes((await jobById(res2.job.id))?.status));
  const plain = await jobById(res2.job.id);
  const plainParts = (await oc.listMessages(res2.job.childSessionID, { limit: 50 })).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool" && /question/i.test(p.tool));
  console.log(`  [info] plain job's question call → ${j(plainParts.map((p) => ({ status: p.state?.status, error: p.state?.error })))}`);
  check("the plain job raised no question form in its session (a question call, if any, is denied by its ruleset)", forms.every((f) => f.sessionID !== res2.job.childSessionID) && plainParts.every((p) => p.state?.status === "error" && /denied|rule/i.test(String(p.state?.error ?? ""))), j(plainParts.map((p) => p.state)));
  check("the plain job ended as an ordinary job (not `needs a decision`)", plain.status === "done" && plain.endedBlocked === false && plain.decision === undefined, j({ s: plain.status, b: plain.endedBlocked }));
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
