#!/usr/bin/env node
// Live smoke for slice C1: the REAL manta-server opencode client
// (src/server/opencode.mjs) + stream interpreter (src/server/streamInterp.mjs)
// against a REAL pinned OpenCode V2 binary in a throwaway sandbox.
//
//   ANTHROPIC_API_KEY="$(cat /home/dev/.manta-secrets/ANTHROPIC_API_KEY)" \
//     node scripts/opencode-v2/c1-smoke.mjs
//
// Exercises, through the production code paths: create session, prompt (model
// switch via the session), the event stream, a tool with LIVE shell output, a
// question (form) reply, a permission reply, an abort, a subagent, todo_write,
// the lifecycle adapter, and the transcript mapper — and asserts the FRAMES the
// clients would receive. Haiku only, a handful of short turns (cents).
//
// SAFETY: only the sandbox (own port, random password, own HOME/XDG) is used.
// The live opencode (:4096) and manta-server (:8787) are never contacted: the
// client is pointed at the sandbox with _setApiBase and the password comes from
// MANTA_OPENCODE_PASSWORD.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

// C1_SMOKE_MOCK=1: run ONLY the cleanup-spec checks (inbox / steer / interrupt /
// slash-command origin) against the REAL opencode binary with a scripted stand-in
// for the model (mock-anthropic.mjs) — for when the API key's quota is spent.
const MOCK = process.env.C1_SMOKE_MOCK === "1";
if (!process.env.ANTHROPIC_API_KEY && !MOCK) {
  console.log("SKIP c1-smoke — set ANTHROPIC_API_KEY to run the live V2 smoke.");
  process.exit(0);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
}
const j = (v) => JSON.stringify(v)?.slice(0, 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = await startFakeMantaServer({ token: "ab12".repeat(8) });
const mock = MOCK ? await startMockAnthropic({ log: (m) => process.env.C1_SMOKE_VERBOSE && console.log(m) }) : null;
const sb = await startSandbox({
  binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
  plugins: [PLUGIN_DIR], // todo_write
  dirs: ["repo"],
  // a one-line custom command for the slash-command origin checks (§3)
  config: {
    command: { smokecmd: { template: "Reply with exactly these words: command ran $ARGUMENTS", description: "smoke command" } },
    // Stage B: a NATIVE `commands` entry (the key is `commands`, not `command` — F4) whose
    // definition runs in a child session.
    commands: { bgnative: { template: "Reply with exactly these words: native bg ran $ARGUMENTS", description: "native background command", subagent: true } },
    ...(MOCK ? { provider: { anthropic: { options: { baseURL: `${mock.url}/v1`, apiKey: "mock" } } } } : {}),
  },
  env: { ANTHROPIC_API_KEY: MOCK ? "mock" : process.env.ANTHROPIC_API_KEY, MANTA_SERVER_URL: fake.url, MANTA_BOX_TOKEN: "ab12".repeat(8) },
});
console.log(`[sandbox] ${sb.url}`);

// Point the production client at the sandbox BEFORE anything talks to it.
process.env.MANTA_OPENCODE_PASSWORD = sb.password;
const oc = await import("../../src/server/opencode.mjs");
const { createStreamInterpreter } = await import("../../src/server/streamInterp.mjs");
const { createLifecycleAdapter } = await import("../../src/shared/opencodeV2.mjs");
const { createCommandCorrelator, createOriginStore } = await import("../../src/server/commandOrigins.mjs");
oc._setApiBase(sb.url);
const delegateMod = await import("../../src/server/delegate.mjs");

// ---- Stage B: the REAL delegate engine, driven with the real opencode client but a TEMP jobs
// file and fake tmux (the smoke never touches the live store or the live tmux) ----
const jobsFile = join(mkdtempSync(join(tmpdir(), "c1-smoke-jobs-")), "jobs.json");
const loadJobsB = () => delegateMod.loadJobs(jobsFile);
const saveJobsB = (jobs) => delegateMod.saveJobs(jobs, jobsFile);
const fakeWindows = []; // { index, opencodeSessionId }
const killed = [];
let postedByManta = 0;
const engine = delegateMod.createDelegateEngine({
  load: loadJobsB,
  save: saveJobsB,
  publish: () => {},
  listProjects: async () => [{ tmuxSession: "smoke", defaultCwd: sb.dirs.repo, windows: fakeWindows.map((w) => ({ ...w, paneCurrentPath: sb.dirs.repo })) }],
  newWindow: async ({ existingSessionId }) => {
    const index = 10 + fakeWindows.length;
    fakeWindows.push({ index, opencodeSessionId: existingSessionId });
    return { sessionId: existingSessionId, windowIndex: index };
  },
  killWindow: async (w) => {
    killed.push(w);
  },
  stampOwner: async () => {},
  clearProgress: async () => {},
  readProgress: async () => null,
  listMessages: (sid) => oc.listMessages(sid),
  abortSession: (sid) => oc.abortSession(sid),
  readSession: (sid) => oc.readSession(sid),
  listActiveIds: () => oc.listActiveSessionIds(),
  listChildSessions: (sid) => oc.listChildSessions(sid),
  listRawTimeline: (sid, o) => oc.listRawTimeline(sid, o),
  listInbox: (sid) => oc.listInbox(sid),
  createChildSession: (i) => oc.createSession(i),
  runCommandOnChild: (i) => oc.runCommand(i),
  deleteSession: (sid) => oc.deleteSessionRaw(sid),
  postSynthetic: (sid, body) => {
    postedByManta += 1;
    return oc.postSynthetic(sid, body);
  },
  isCtoConversationSession: async () => false,
  openCommandWindows: (sid) => correlatorRef.current.openWindows(sid),
  oc,
});
const correlatorRef = { current: null };

// ---- the production pump, minus the bus: raw → correlator + interpreter + lifecycle adapter ----
const frames = [];
const lifecycle = [];
const rawLog = []; // { t, raw } — for the timing measurements
const adapter = createLifecycleAdapter();
const interp = createStreamInterpreter({
  publish: (f) => frames.push(f),
  fetchShellOutput: (a) => oc.readShellOutput(a),
  contextLimitFor: () => 200_000,
  listInbox: (sid) => oc.listInbox(sid),
});
const correlator = createCommandCorrelator({
  origins: createOriginStore(),
  log: (...a) => console.log("  [correlator]", ...a),
  onTag: (t) => interp.emitCommandExecuted(t.sessionId, t),
  onWindowClosed: (w) => engine.windowClosed(w),
});
correlatorRef.current = correlator;
oc.setCommandCorrelator(correlator);
const connects = [];
const stop = oc.subscribeEvents(
  (raw) => {
    rawLog.push({ t: Date.now(), raw });
    if (raw?.type === "session.inbox.enqueued") correlator.observeEnqueued(raw.data?.sessionID, raw.data?.inboxID, raw.data?.item?.type);
    interp.interpret(raw);
    engine.observeRaw(raw).catch((e) => console.log("  [engine] observeRaw failed:", e?.message ?? e));
    for (const e of adapter.adapt(raw)) {
      lifecycle.push(e);
      if (e.type === "session.idle") correlator.noteIdle(e.properties.sessionID);
      engine.observeEvent(e).catch(() => {});
    }
  },
  { onConnect: (i) => connects.push(i), onDisconnect: () => { correlator.noteDisconnect(); interp.inboxDisconnected(); } },
);

const of = (sid, sub) => frames.filter((f) => f.sub === sub && f.sessionId === sid);
async function until(label, pred, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(150);
  }
  check(`(timeout) ${label}`, false);
  return false;
}
const idleWith = (sid) => () => {
  const tc = of(sid, "turnComplete");
  return tc.length > 0 && tc.at(-1).payload.complete === true && of(sid, "running").at(-1)?.payload.running === false;
};

let cost = 0;
const sessions = [];
async function newSession(opts = {}) {
  const s = await oc.createSession({ directory: sb.dirs.repo, ...opts });
  sessions.push(s.id);
  return s;
}

try {
  await until("event stream connected", () => connects.length > 0, 15_000);
  check("the SSE stream connected once with auth (first connect, reconnect=false)", connects.length >= 1 && connects[0].reconnect === false);

  // a git repo with files for the tools
  writeFileSync(join(sb.dirs.repo, "notes.txt"), "alpha\nbeta\ngamma\n");
  execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm i", { cwd: sb.dirs.repo, stdio: "ignore" });

  if (!MOCK) { // sections 1–8 need a real model (the pre-existing C1 checks)
  // ---------------------------------------------------------------- 1. plain turn
  console.log("\n[1] create → prompt (model switch) → stream → transcript");
  const s1 = await newSession({ title: "smoke-1" });
  check("createSession returns the V1-shaped record (id, directory)", s1.id?.startsWith("ses_") && s1.directory === sb.dirs.repo, j(s1));
  check("the directory cache was primed", oc.cachedSessionDirectory(s1.id) === sb.dirs.repo);
  await oc.sendPrompt({ sessionId: s1.id, text: "Reply with exactly these words: smoke one ok", model: MODEL });
  await until("turn 1 complete", idleWith(s1.id));
  check("running(true) preceded running(false)", of(s1.id, "running").map((f) => f.payload.running).join() === "true,false", j(of(s1.id, "running").map((f) => f.payload)));
  const text = of(s1.id, "flush").filter((f) => f.payload.field === "text").map((f) => f.payload.text).join("");
  check("text streamed as flush frames", /smoke one ok/i.test(text), text);
  check("stepEnded + context + cache frames", of(s1.id, "stepEnded").length >= 1 && of(s1.id, "context").length >= 1 && of(s1.id, "cache").length >= 1);
  check("context reads the resolver's limit", of(s1.id, "context")[0].payload.hasLimit === true && of(s1.id, "context")[0].payload.totalInput > 0);
  check("the session model is the one the prompt named", (await oc.readSession(s1.id)).session.model.id === MODEL.modelID);
  const tx = await oc.listMessages(s1.id);
  check("listMessages → [{info,parts}] user then assistant", tx.map((m) => m.info.role).join() === "user,assistant" && tx[1].parts.some((p) => p.type === "text" && /smoke one ok/i.test(p.text)), j(tx.map((m) => m.info)));
  check("assistant info carries modelID/providerID/tokens for the token selectors", tx[1].info.modelID === MODEL.modelID && tx[1].info.providerID === "anthropic" && tx[1].info.tokens?.input >= 0);
  const limited = await oc.listMessages(s1.id, { limit: 1 });
  check("listMessages {limit:1} returns the tail", limited.length === 1 && limited[0].info.role === "assistant");
  const one = await oc.getMessage(s1.id, tx[0].info.id);
  check("getMessage round-trips the user message id (the delivery receipt)", one?.info.id === tx[0].info.id && one.info.role === "user");
  check("lifecycle adapter produced busy→idle for the session", lifecycle.some((e) => e.type === "session.status" && e.properties.sessionID === s1.id && e.properties.status.type === "busy") && lifecycle.some((e) => e.type === "session.idle" && e.properties.sessionID === s1.id));
  check("the session is no longer active", (await oc.listActiveSessionIds()).includes(s1.id) === false && (await oc.getSessionStatus(s1.id)) === "idle");
  const listed = await oc.listSessions(sb.dirs.repo);
  check("listSessions({directory}) finds it with a V1 `directory`", listed.some((s) => s.id === s1.id && s.directory === sb.dirs.repo));

  // ---------------------------------------------------------------- 2. tool + live shell
  console.log("\n[2] shell tool with LIVE output");
  const s2 = await newSession();
  await oc.sendPrompt({ sessionId: s2.id, text: "Run exactly this shell command and nothing else: for i in 1 2 3 4 5; do echo line$i; sleep 1; done . Then reply with the single word done.", model: MODEL });
  await until("turn 2 complete", idleWith(s2.id));
  const started = of(s2.id, "toolStarted");
  check("toolStarted for `bash` (V1 name for V2's shell)", started.length === 1 && started[0].payload.toolName === "bash", j(started.map((f) => f.payload)));
  const outs = of(s2.id, "toolOutput");
  const ended = of(s2.id, "toolEnded");
  const order = frames.filter((f) => f.sessionId === s2.id && ["toolStarted", "toolOutput", "toolEnded"].includes(f.sub));
  const firstOut = order.findIndex((f) => f.sub === "toolOutput");
  const endedAt = order.findIndex((f) => f.sub === "toolEnded");
  check("output arrived in MORE than one chunk, before toolEnded (live tail, not a final dump)", outs.length >= 2 && firstOut < endedAt, `chunks=${outs.length}`);
  check("the chunks reassemble to the full output", outs.map((f) => f.payload.text).join("") === "line1\nline2\nline3\nline4\nline5\n", j(outs.map((f) => f.payload.text)));
  check("toolEnded ok + one toolBoundary with the V1 tool name", ended.length === 1 && ended[0].payload.ok === true && of(s2.id, "toolBoundary").length === 1 && of(s2.id, "toolBoundary")[0].payload.tool === "bash");
  const tx2 = await oc.listMessages(s2.id);
  const bashPart = tx2.flatMap((m) => m.parts).find((p) => p.type === "tool");
  check("transcript tool part: bash, completed, output + input.command", bashPart?.tool === "bash" && bashPart.state.status === "completed" && bashPart.state.output.includes("line5") && /for i in/.test(bashPart.state.input.command), j(bashPart));

  // ---------------------------------------------------------------- 3. todo_write
  console.log("\n[3] todo_write (manta plugin) → todos frame");
  const s3 = await newSession();
  await oc.sendPrompt({ sessionId: s3.id, text: 'Call the todo_write tool exactly once with two todos: {content:"first", status:"in_progress", priority:"high"} and {content:"second", status:"pending", priority:"low"}. Then reply done.', model: MODEL });
  await until("turn 3 complete", idleWith(s3.id));
  const todos = of(s3.id, "todos");
  check("a todos frame with both items", todos.length >= 1 && todos[0].payload.active?.length === 2 && todos[0].payload.allTerminal === false, j(todos.map((f) => f.payload)));

  // ---------------------------------------------------------------- 4. question (form)
  console.log("\n[4] question tool (a V2 form) → reply");
  const s4 = await newSession();
  await oc.sendPrompt({ sessionId: s4.id, text: "Use the question tool to ask me which colour I prefer (options: Red, Green, Blue), then tell me the colour I picked.", model: MODEL });
  await until("question frame", () => of(s4.id, "questions").some((f) => f.payload.questions.length === 1));
  check("attention = question", of(s4.id, "attention").at(-1)?.payload.kind === "question");
  const qf = of(s4.id, "questions").find((f) => f.payload.questions.length === 1).payload.questions[0];
  check("the card carries the form id as requestId and 3 options", /^frm_/.test(qf.requestId) && qf.questions[0].options.length === 3, j(qf));
  const pending = await oc.listQuestions(s4.id);
  check("oc.listQuestions returns the same pending question", pending.length === 1 && pending[0].id === qf.requestId);
  await oc.replyQuestion({ requestId: qf.requestId, sessionId: s4.id, answers: [["Blue"]] });
  await until("turn 4 complete", idleWith(s4.id));
  check("attention cleared and questions emptied after the reply", of(s4.id, "attention").at(-1)?.payload.kind === null && of(s4.id, "questions").at(-1).payload.questions.length === 0);
  const t4 = (await oc.listMessages(s4.id)).flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text).join(" ");
  check("the model received the answer (mentions Blue)", /blue/i.test(t4), t4.slice(0, 200));

  // ---------------------------------------------------------------- 5. permission
  console.log("\n[5] permission ask → reply (and trust-style `always`)");
  const s5 = await newSession({ permission: [{ permission: "bash", pattern: "*", action: "ask" }] });
  await oc.sendPrompt({ sessionId: s5.id, text: "Run exactly this shell command and nothing else: echo permission-ok . Then reply with the single word done.", model: MODEL });
  await until("permission frame", () => of(s5.id, "permissions").some((f) => f.payload.permissions.length === 1));
  const perm = of(s5.id, "permissions").find((f) => f.payload.permissions.length === 1).payload.permissions[0];
  check("PermissionCard shape: bash + command + always patterns", perm.permission === "bash" && perm.metadata.command === "echo permission-ok" && perm.always.length > 0, j(perm));
  check("attention = permission", of(s5.id, "attention").at(-1)?.payload.kind === "permission");
  check("lifecycle adapter raised permission.asked with the same id", lifecycle.some((e) => e.type === "permission.asked" && e.properties.id === perm.id));
  check("oc.listPermissions sees it", (await oc.listPermissions(s5.id)).some((p) => p.id === perm.id));
  await oc.replyPermission({ requestId: perm.id, reply: "once", sessionId: s5.id });
  await until("turn 5 complete", idleWith(s5.id));
  check("permission cleared after the reply", of(s5.id, "permissions").at(-1).payload.permissions.length === 0 && of(s5.id, "attention").at(-1).payload.kind === null);
  check("the command really ran after approval", (await oc.listMessages(s5.id)).flatMap((m) => m.parts).some((p) => p.type === "tool" && /permission-ok/.test(p.state.output ?? "")));

  // ---------------------------------------------------------------- 6. abort
  console.log("\n[6] abort mid-tool");
  const s6 = await newSession();
  await oc.sendPrompt({ sessionId: s6.id, text: "Run exactly this shell command and nothing else: for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo tick$i; sleep 1; done . Then reply with the single word done.", model: MODEL });
  await until("live output before the abort", () => of(s6.id, "toolOutput").length >= 1);
  check("the session reports busy while the tool runs", (await oc.getSessionStatus(s6.id)) === "busy" && (await oc.listActiveSessionIds()).includes(s6.id));
  await oc.abortSession(s6.id);
  await until("turn 6 stopped", idleWith(s6.id));
  check("an `aborted` frame (empty payload) and NO sessionError", of(s6.id, "aborted").length === 1 && of(s6.id, "sessionError").length === 0);
  check("the tool ended not-ok with a boundary", of(s6.id, "toolEnded").at(-1)?.payload.ok === false && of(s6.id, "toolBoundary").at(-1)?.payload.status === "error");
  check("lifecycle adapter: session.error MessageAbortedError then idle", lifecycle.some((e) => e.type === "session.error" && e.properties.sessionID === s6.id && e.properties.error.name === "MessageAbortedError"));
  const polled = of(s6.id, "toolOutput").length;
  await sleep(1500);
  check("the shell poll stopped with the abort", of(s6.id, "toolOutput").length === polled);

  // ---------------------------------------------------------------- 7. subagent
  console.log("\n[7] subagent");
  const s7 = await newSession();
  await oc.sendPrompt({ sessionId: s7.id, text: "Use the subagent tool (agent: explore) to find which file defines the function `greet` in this repo (it may not exist), then tell me what it found.", model: MODEL });
  await until("turn 7 complete", idleWith(s7.id), 120_000);
  const child = of(s7.id, "childSession");
  check("childSession frame published under the PARENT", child.length === 1 && child[0].payload.parentSessionId === s7.id, j(child.map((f) => f.payload)));
  const sub = of(s7.id, "subagent");
  check("subagent frames: running with the child id, then completed", sub.length >= 2 && sub[0].payload.status === "running" && sub[0].payload.childSessionId === child[0].payload.childSessionId && sub.at(-1).payload.status === "completed", j(sub.map((f) => f.payload.status)));
  sessions.push(child[0]?.payload.childSessionId);
  const parts7 = (await oc.listMessages(s7.id)).flatMap((m) => m.parts).filter((p) => p.type === "tool");
  const task = parts7.find((p) => p.tool === "task");
  check("transcript: a `task` part with the child session id + result", task?.state.metadata.sessionId === child[0].payload.childSessionId && typeof task.state.output === "string", j(task));
  const childTx = await oc.listMessages(child[0].payload.childSessionId);
  check("the child's own transcript is readable", childTx.length >= 2);
  check("lifecycle adapter announced the child (session.created with parentID)", lifecycle.some((e) => e.type === "session.created" && e.properties.info.parentID === s7.id));

  // ---------------------------------------------------------------- 8. misc routes
  console.log("\n[8] fork / compact / commands / models / files");
  const forked = await oc.forkSession({ sessionId: s1.id });
  sessions.push(forked.id);
  check("forkSession returns the NEW session (different id, same directory)", forked.id !== s1.id && forked.directory === sb.dirs.repo, j(forked));
  const cmds = await oc.listCommands();
  check("listCommands / listAgents shapes", Array.isArray(cmds) && cmds.every((c) => typeof c.name === "string") && (await oc.listAgents()).some((a) => a.name === "build" && a.mode === "primary"));
  const files = await oc.findFiles({ query: "notes", directory: sb.dirs.repo });
  check("findFiles → project-relative paths", files.includes("notes.txt"), j(files));
  const models = await oc.listModels();
  check("listModels: connected anthropic models, normalized (limit.context, cost, capabilities)", models.some((m) => m.providerID === "anthropic" && m.id === "claude-haiku-4-5" && m.limit.context > 0 && m.capabilities.toolcall === true), j(models.slice(0, 1)));
  const def = await oc.getProviders();
  check("getProviders: anthropic connected via the env key", def.connected.includes("anthropic"));
  check("pickCheapModel picks a Haiku-class model", /haiku/.test((await oc.pickCheapModel())?.id ?? ""));
  const title = await oc.generateSessionTitle({ instruction: "Reply with a 2-word title for: fixing a login bug. Output only the title." });
  check("generateSessionTitle → one-shot text with no session created", title.trim().length > 0, j(title));
  await oc.compactSession(s1.id);
  await until("compaction frames", () => of(s1.id, "compaction").some((f) => f.payload.phase === "ended"), 60_000);
  await until("transcriptStale after the compaction settles", () => of(s1.id, "transcriptStale").length >= 1, 30_000);
  check("compaction started…ended, then transcriptStale once it settles", of(s1.id, "compaction")[0].payload.phase === "started" && of(s1.id, "transcriptStale").length >= 1);
  check("a plan-mode prompt sets the plan agent, the next plain prompt returns to build", await (async () => {
    const n0 = of(s2.id, "turnComplete").length;
    await oc.sendPrompt({ sessionId: s2.id, text: "Reply with the word one.", agent: "plan", model: MODEL });
    await until("plan turn", () => of(s2.id, "turnComplete").length > n0, 60_000);
    const a1 = await oc.getSessionAgent(s2.id);
    const n1 = of(s2.id, "turnComplete").length;
    await oc.sendPrompt({ sessionId: s2.id, text: "Reply with the word two.", model: MODEL });
    const a2 = await oc.getSessionAgent(s2.id);
    await until("build turn", () => of(s2.id, "turnComplete").length > n1, 60_000);
    return a1 === "plan" && (a2 ?? "build") === "build" && of(s2.id, "planMode").map((f) => f.payload.on).join() === "true,false";
  })());
  check("sessionExists: live → true, unknown → false", (await oc.sessionExists(s1.id)) === true && (await oc.sessionExists("ses_does_not_exist")) === false);

  } // end of the real-model sections (skipped under C1_SMOKE_MOCK=1)

  // C1_SMOKE_B_ONLY=1 skips the cleanup-spec block below (faster iteration on Stage B).
  if (!process.env.C1_SMOKE_B_ONLY) {
  // ================================================================ cleanup spec §8 (S1 a–h + the 20-command check)
  const loopText = (n, tag = "tick") => `Run exactly this shell command and nothing else: for i in ${Array.from({ length: n }, (_, k) => k + 1).join(" ")}; do echo ${tag}$i; sleep 1; done . Then reply with the single word done.`;
  const inboxOf = (sid) => of(sid, "inbox").at(-1)?.payload;
  const itemsOf = (sid) => inboxOf(sid)?.items ?? [];
  const starts = (sid) => of(sid, "running").filter((f) => f.payload.running === true).length;
  const userTexts = async (sid) => (await oc.listMessages(sid)).filter((m) => m.info.role === "user").map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""));
  const asstText = async (sid) => (await oc.listMessages(sid)).filter((m) => m.info.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text).join(" ");
  const cancel = (sid, id) => interp.cancelInbox(sid, id, { deleteItem: () => oc.cancelInboxItem(sid, id), getMessage: () => oc.getMessage(sid, id) });

  // ---------------------------------------------------------------- (a) steer mid-turn
  console.log("\n[9a] steer mid-turn → inbox frame (1 item) → delivered in the SAME execution → inbox empty; (f) active set");
  const sa = await newSession();
  await oc.sendPrompt({ sessionId: sa.id, text: loopText(12), model: MODEL });
  await until("(a) live output", () => of(sa.id, "toolOutput").length >= 1);
  check("(f) listActiveSessionIds contains the session mid-turn", (await oc.listActiveSessionIds()).includes(sa.id));
  const steerText = "After the shell command finishes, also say the word STEERED.";
  await oc.sendPrompt({ sessionId: sa.id, text: steerText, delivery: "steer" });
  await until("(a) inbox frame with the steered item", () => itemsOf(sa.id).length === 1, 15_000);
  check("(a) the inbox frame carries exactly the steered item (K2 shape, epoch/rev)", itemsOf(sa.id)[0]?.text === steerText && itemsOf(sa.id)[0]?.delivery === "steer" && /^msg_/.test(itemsOf(sa.id)[0]?.id) && itemsOf(sa.id)[0]?.attachmentCount === 0 && inboxOf(sa.id).epoch === interp.epoch && inboxOf(sa.id).rev >= 2, j(inboxOf(sa.id)));
  const snapA = await interp.getInbox(sa.id);
  check("(a) opencode:inbox (interpreter snapshot) agrees with the last frame", snapA.rev === inboxOf(sa.id).rev && snapA.items.length === 1);
  const rawA = await oc.listInbox(sa.id);
  check("(a) the raw V2 inbox GET lists it as a user item with the same id", rawA.some((r) => r.id === itemsOf(sa.id)[0]?.id && r.type === "user"), j(rawA));
  await until("(a) turn complete", idleWith(sa.id), 120_000);
  check("(a) delivered within the SAME execution (one execution.started) and the inbox is empty", starts(sa.id) === 1 && itemsOf(sa.id).length === 0, `starts=${starts(sa.id)} items=${j(itemsOf(sa.id))}`);
  check("(a) the model saw the steered message (STEERED in the reply)", /steered/i.test(await asstText(sa.id)));
  if (mock) {
    // WHEN was the steer injected? Which model request first carried it?
    const sawAt = mock.requests.findIndex((r) => JSON.stringify(r.body.messages).includes("also say the word STEERED"));
    console.log(`  [a] model requests this turn: ${mock.requests.length} (decisions: ${mock.requests.map((r) => r.decision.kind).join(",")}); steer first present in request #${sawAt + 1}`);
  }
  check("(f) the session is NOT in the active set after the turn", !(await oc.listActiveSessionIds()).includes(sa.id));
  check("(a) inbox revs strictly increase within the epoch", of(sa.id, "inbox").every((f, i, a) => i === 0 || f.payload.rev > a[i - 1].payload.rev), j(of(sa.id, "inbox").map((f) => f.payload.rev)));

  // ---------------------------------------------------------------- (b) queue + cancel
  console.log("\n[9b] queue item + cancel → cancelled; cancel after delivery → delivered");
  const sq = await newSession();
  await oc.sendPrompt({ sessionId: sq.id, text: loopText(8), model: MODEL });
  await until("(b) live output", () => of(sq.id, "toolOutput").length >= 1);
  await oc.sendPrompt({ sessionId: sq.id, text: "Reply with exactly: queued one", delivery: "queue" });
  await until("(b) queued item in the inbox", () => itemsOf(sq.id).length === 1, 15_000);
  check("(b) the pending item is a `queue` delivery", itemsOf(sq.id)[0]?.delivery === "queue", j(itemsOf(sq.id)));
  const q1 = itemsOf(sq.id)[0];
  const t0 = Date.now();
  const r1 = await cancel(sq.id, q1.id);
  console.log(`  [b] cancel answered in ${Date.now() - t0} ms`);
  check("(b) cancel → outcome `cancelled` with the pre-cancel copy of the item", r1.outcome === "cancelled" && r1.item?.text === "Reply with exactly: queued one", j(r1));
  check("(b) the inbox frame is empty after the cancel, and a session.inbox.cancelled event arrived", itemsOf(sq.id).length === 0 && rawLog.some((e) => e.raw.type === "session.inbox.cancelled" && e.raw.data.inboxID === q1.id));
  await oc.sendPrompt({ sessionId: sq.id, text: "Reply with exactly: queued two", delivery: "queue" });
  await until("(b) second queued item", () => itemsOf(sq.id).length === 1, 15_000);
  const q2 = itemsOf(sq.id)[0];
  await until("(b) the turn finished and the queued item ran", async () => (await userTexts(sq.id)).includes("Reply with exactly: queued two") && itemsOf(sq.id).length === 0 && idleWith(sq.id)(), 120_000);
  console.log(`  [b] executions started for the session: ${starts(sq.id)} (queued item ran in the same execution iff 1)`);
  const r2 = await cancel(sq.id, q2.id);
  check("(b) cancel after delivery → outcome `delivered` (no item)", r2.outcome === "delivered" && r2.item === undefined, j(r2));
  check("(b) the cancelled item never ran; the queued-two item ran as its own turn", !(await userTexts(sq.id)).includes("Reply with exactly: queued one") && (await userTexts(sq.id)).includes("Reply with exactly: queued two"), j(await userTexts(sq.id)));

  // ---------------------------------------------------------------- (c) Esc with pending input
  console.log("\n[9c] interrupt?resume=true: pending steer runs next; queued stays parked; empty inbox → idle");
  const sc = await newSession();
  await oc.sendPrompt({ sessionId: sc.id, text: loopText(20), model: MODEL });
  await until("(c) live output", () => of(sc.id, "toolOutput").length >= 1);
  await oc.sendPrompt({ sessionId: sc.id, text: "Reply with exactly these words: after the stop", delivery: "steer" });
  await oc.sendPrompt({ sessionId: sc.id, text: "Reply with exactly these words: parked queue", delivery: "queue" });
  await until("(c) both pending", () => itemsOf(sc.id).length === 2, 15_000);
  await oc.interruptSession(sc.id, { resume: true });
  await until("(c) the steered item ran as the next turn", () => starts(sc.id) >= 2 && idleWith(sc.id)(), 90_000);
  check("(c) an `aborted` frame, then the steered message ran as the NEXT turn", of(sc.id, "aborted").length === 1 && /after the stop/i.test(await asstText(sc.id)), j(await asstText(sc.id)));
  const pendingC = itemsOf(sc.id);
  console.log(`  [c] after the resumed turn the inbox holds: ${j(pendingC.map((i) => [i.delivery, i.text]))}; executions=${starts(sc.id)}`);
  check("(c) the QUEUED prompt stayed parked (resume runs steering input only)", pendingC.length === 1 && pendingC[0].delivery === "queue" && !(await userTexts(sc.id)).includes("Reply with exactly these words: parked queue"), j(pendingC));
  await cancel(sc.id, pendingC[0]?.id);
  const sc2 = await newSession();
  await oc.sendPrompt({ sessionId: sc2.id, text: loopText(15), model: MODEL });
  await until("(c2) live output", () => of(sc2.id, "toolOutput").length >= 1);
  await oc.interruptSession(sc2.id, { resume: true });
  await until("(c2) stopped", idleWith(sc2.id));
  await sleep(3000);
  check("(c) Esc with an EMPTY inbox leaves the session idle (no new execution)", starts(sc2.id) === 1 && !(await oc.listActiveSessionIds()).includes(sc2.id) && itemsOf(sc2.id).length === 0);

  // ---------------------------------------------------------------- (e) question + composer send
  console.log("\n[9e] pending question + composer send: reject the question, then steer");
  const se = await newSession();
  await oc.sendPrompt({ sessionId: se.id, text: "Use the question tool to ask me which fruit I prefer (options: Apple, Pear), then tell me my choice. If the question is dismissed, follow whatever I say next.", model: MODEL });
  await until("(e) question frame", () => of(se.id, "questions").some((f) => f.payload.questions.length === 1));
  const eq = of(se.id, "questions").find((f) => f.payload.questions.length === 1).payload.questions[0];
  await oc.rejectQuestion({ requestId: eq.requestId, sessionId: se.id });
  await oc.sendPrompt({ sessionId: se.id, text: "Skip the question. Reply with exactly these words: COMPOSER-OK", delivery: "steer" });
  await until("(e) turn complete", idleWith(se.id), 120_000);
  check("(e) the question card cleared and the turn continued", of(se.id, "questions").at(-1).payload.questions.length === 0 && of(se.id, "attention").at(-1)?.payload.kind === null);
  check("(e) the steered message was read (reply mentions COMPOSER-OK)", /composer-ok/i.test(await asstText(se.id)), (await asstText(se.id)).slice(0, 300));
  console.log(`  [e] executions=${starts(se.id)}; inbox after: ${j(itemsOf(se.id))}`);

  // ---------------------------------------------------------------- (g) steer after a plan-agent turn
  console.log("\n[9g] a steered send does not switch the agent");
  const sg = await newSession();
  mock?.setDelay(4000); // keep the (model-less) turn in flight long enough to steer it
  await oc.sendPrompt({ sessionId: sg.id, text: "Read notes.txt with the read tool, then write three sentences about it.", agent: "plan", model: MODEL });
  await until("(g) the turn is busy", async () => (await oc.listActiveSessionIds()).includes(sg.id), 30_000);
  const agentBefore = await oc.getSessionAgent(sg.id);
  const planFramesBefore = of(sg.id, "planMode").length;
  await oc.sendPrompt({ sessionId: sg.id, text: "Also mention the word zebra.", delivery: "steer" });
  const agentAfter = await oc.getSessionAgent(sg.id);
  await until("(g) turn complete", idleWith(sg.id), 120_000);
  mock?.setDelay(0);
  check("(g) the session agent is `plan` before and after the steered send (no agent POST)", agentBefore === "plan" && agentAfter === "plan" && (await oc.getSessionAgent(sg.id)) === "plan", j([agentBefore, agentAfter]));
  check("(g) no planMode frame flipped it off", of(sg.id, "planMode").slice(planFramesBefore).every((f) => f.payload.on === true) && of(sg.id, "planMode").at(-1)?.payload.on === true);

  // ---------------------------------------------------------------- (h) transcript order with minted ids
  console.log("\n[9h] transcript order with minted prompt ids");
  const sh = await newSession();
  await oc.sendPrompt({ sessionId: sh.id, text: loopText(4, "h"), model: MODEL });
  await until("(h) busy", async () => (await oc.listActiveSessionIds()).includes(sh.id), 30_000);
  const words = ["alpha", "bravo", "charlie", "delta"];
  for (const w of words) await oc.sendPrompt({ sessionId: sh.id, text: `Reply with exactly: ${w}`, delivery: "queue" });
  await until("(h) all queued items ran", async () => (await userTexts(sh.id)).length === 5 && idleWith(sh.id)() && itemsOf(sh.id).length === 0, 180_000);
  const hu = await userTexts(sh.id);
  check("(h) user messages appear in send order", hu.slice(1).join("|") === words.map((w) => `Reply with exactly: ${w}`).join("|"), j(hu));
  const hm = await oc.listMessages(sh.id);
  check("(h) the minted ids are msg_-prefixed (random UUIDs) and every user message is followed by an assistant reply before the next user message", hm.filter((m) => m.info.role === "user").every((m) => /^msg_/.test(m.info.id)) && hm.every((m, i) => m.info.role !== "user" || hm[i + 1]?.info.role === "assistant"), j(hm.map((m) => m.info.role)));
  const hid = await Promise.all(words.map((w) => oc.sendPrompt({ sessionId: sh.id, text: `Reply with exactly: ${w}`, messageID: `msg_dup-${w}` }).then(() => "ok")));
  check("(h) a caller-supplied id is honoured", (await Promise.resolve(hid)).length === 4);

  // ---------------------------------------------------------------- (d) slash command origin
  console.log("\n[9d] slash command → inbox enqueue → commandExecuted → info.command; a plain prompt in the window is NOT tagged");
  const cmds2 = await oc.listCommands();
  check("(d) the sandbox command `smokecmd` is registered", cmds2.some((c) => c.name === "smokecmd"), j(cmds2.map((c) => c.name)));
  const sd = await newSession();
  const tCmd0 = Date.now();
  await oc.runCommand({ sessionId: sd.id, command: "smokecmd", arguments: "alpha", model: MODEL });
  const tCmd1 = Date.now();
  await oc.sendPrompt({ sessionId: sd.id, text: "Reply with exactly: plain prompt in the window", delivery: "queue" }); // inside the 3 s window
  await until("(d) both turns done", async () => (await userTexts(sd.id)).length === 2 && idleWith(sd.id)() && itemsOf(sd.id).length === 0, 120_000);
  const enq = rawLog.filter((e) => e.raw.type === "session.inbox.enqueued" && e.raw.data.sessionID === sd.id);
  check("(d) the command's user message passed through session.inbox.enqueued as a `user` item (expanded template)", enq.some((e) => e.raw.data.item?.type === "user" && /command ran alpha/.test(e.raw.data.item.payload?.text ?? "")), j(enq.map((e) => e.raw.data.item)));
  await until("(d) the window closed and tagged", () => of(sd.id, "commandExecuted").length === 1, 10_000);
  const ce = of(sd.id, "commandExecuted")[0]?.payload;
  const dm = await oc.listMessages(sd.id);
  const cmdMsg = dm.find((m) => m.info.role === "user" && m.info.id === ce?.messageID);
  check("(d) a commandExecuted frame {messageID,name,arguments}", ce?.name === "smokecmd" && ce?.arguments === "alpha" && /^msg_/.test(ce?.messageID ?? ""), j(ce));
  check("(d) info.command is stamped on the command's message on refetch (listMessages + getMessage)", cmdMsg?.info.command?.name === "smokecmd" && (await oc.getMessage(sd.id, ce.messageID))?.info.command?.arguments === "alpha", j(cmdMsg?.info));
  const plainMsg = dm.find((m) => m.info.role === "user" && m.parts.some((p) => /plain prompt in the window/.test(p.text ?? "")));
  check("(d) the plain prompt sent during the window is NOT tagged", plainMsg && !plainMsg.info.command);
  console.log(`  [d] runCommand POST ${tCmd1 - tCmd0} ms; enqueues in session: ${enq.length}`);

  // ---------------------------------------------------------------- 20-command empirical check
  console.log("\n[9x] 20 commands (each interrupted as soon as it starts): enqueue cardinality + timing vs the 204");
  const sx = await newSession();
  mock?.setDelay(1500); // so each command's turn is still starting when it is interrupted
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    const before = rawLog.length;
    const tStart = Date.now();
    await oc.runCommand({ sessionId: sx.id, command: "smokecmd", arguments: `n${i}`, model: MODEL });
    const tResp = Date.now();
    // as soon as the turn starts, interrupt it (cheap), then let everything settle
    await until(`(x${i}) turn started`, () => rawLog.slice(before).some((e) => e.raw.type === "session.execution.started" && e.raw.data.sessionID === sx.id), 30_000);
    await oc.interruptSession(sx.id, { resume: false }).catch(() => {});
    await sleep(3500); // the full 3 s window + margin: any late enqueue would show up here
    const mine = rawLog.slice(before).filter((e) => e.raw.type === "session.inbox.enqueued" && e.raw.data.sessionID === sx.id && e.raw.data.item?.type === "user");
    rows.push({ i, enqueues: mine.length, beforeResponse: mine.length > 0 && mine[0].t <= tResp, lagMs: mine.length ? mine[0].t - tResp : null, postMs: tResp - tStart });
    await until(`(x${i}) idle`, () => !(rawLog.slice(before).some((e) => e.raw.type === "session.execution.started")) || of(sx.id, "running").at(-1)?.payload.running === false, 30_000);
  }
  mock?.setDelay(0);
  console.log("  per-command: i enqueues beforeResponse lagMs(enqueue-resp) postMs");
  for (const r of rows) console.log(`   ${String(r.i).padStart(2)}  ${r.enqueues}  ${r.beforeResponse ? "before" : "after "}  ${String(r.lagMs).padStart(6)}  ${r.postMs}`);
  const lags = rows.map((r) => r.lagMs).filter((x) => x != null);
  console.log(`  summary: enqueues/command = ${[...new Set(rows.map((r) => r.enqueues))].join(",")}; before the 204: ${rows.filter((r) => r.beforeResponse).length}/20; lag min/max = ${Math.min(...lags)}/${Math.max(...lags)} ms`);
  check("(x) EVERY command produced exactly ONE user enqueue", rows.every((r) => r.enqueues === 1), j(rows.map((r) => r.enqueues)));
  check("(x) no enqueue later than 3 s after the response", rows.every((r) => r.lagMs == null || r.lagMs <= 3000), j(rows.map((r) => r.lagMs)));
  check("(x) all 20 were tagged by the correlator (sequential, idle between)", of(sx.id, "commandExecuted").length === 20, `tagged=${of(sx.id, "commandExecuted").length}`);
  const xm = await oc.listMessages(sx.id);
  check("(x) 20 command messages carry info.command with the right arguments", xm.filter((m) => m.info.command?.name === "smokecmd").map((m) => m.info.command.arguments).join() === Array.from({ length: 20 }, (_, k) => `n${k + 1}`).join());

  // ---------------------------------------------------------------- (i) N1: change a pending item's delivery
  console.log("\n[9i] N1 setInboxDelivery: queue→steer changed + delivered in the SAME execution; delivered id → delivered; Stop parks the queue item; U4 steer on the idle session starts a turn; round-trip");
  const setDelivery = (sid, id, delivery) => interp.setInboxDelivery(sid, id, delivery, { patchItem: () => oc.setInboxDelivery(sid, id, delivery), getMessage: () => oc.getMessage(sid, id) });
  const rawPatch = (sid, id, delivery) => oc.setInboxDelivery(sid, id, delivery).then(() => "2xx", (e) => `${e.status ?? "net"}: ${String(e.message).slice(0, 160)}`);

  // 1 + 2: a queue item posted mid-turn is switched to steer and runs inside the running execution
  const si = await newSession();
  await oc.sendPrompt({ sessionId: si.id, text: loopText(12), model: MODEL });
  await until("(i) live output", () => of(si.id, "toolOutput").length >= 1);
  const iText = "Reply with exactly these words: N1 SWITCHED";
  await oc.sendPrompt({ sessionId: si.id, text: iText, delivery: "queue" });
  await until("(i) the queue item is pending", () => itemsOf(si.id).length === 1, 15_000);
  const iItem = itemsOf(si.id)[0];
  check("(i) the pending item starts as `queue`", iItem?.delivery === "queue", j(itemsOf(si.id)));
  const i1 = await setDelivery(si.id, iItem.id, "steer");
  check("(i.1) N1 steer on a queue item → outcome `changed`", i1.outcome === "changed", j(i1));
  check("(i.1) the snapshot flipped to `steer` (one item, same id)", itemsOf(si.id).length === 1 && itemsOf(si.id)[0].id === iItem.id && itemsOf(si.id)[0].delivery === "steer", j(itemsOf(si.id)));
  check("(i.1) a delivery.changed event with `steer` for that id arrived", rawLog.some((e) => e.raw.type === "session.inbox.delivery.changed" && e.raw.data.inboxID === iItem.id && e.raw.data.delivery === "steer"));
  await until("(i) turn complete", idleWith(si.id), 120_000);
  check("(i.1) the switched item ran inside the SAME execution (one execution start) and the inbox is empty", starts(si.id) === 1 && itemsOf(si.id).length === 0 && (await userTexts(si.id)).includes(iText), `starts=${starts(si.id)} items=${j(itemsOf(si.id))}`);
  const i2 = await setDelivery(si.id, iItem.id, "steer");
  check("(i.2) N1 on an id that was already delivered → `delivered`", i2.outcome === "delivered", j(i2));
  console.log(`  [i] V2's raw PATCH answers — delivered id: ${await rawPatch(si.id, iItem.id, "queue")}; unknown id: ${await rawPatch(si.id, "msg_does_not_exist", "queue")}`);
  const i2b = await setDelivery(si.id, "msg_does_not_exist", "steer");
  check("(i.2) N1 on an id that never existed → `unknown` (never `changed`)", i2b.outcome === "unknown", j(i2b));

  // 3 + 4: Stop with one steer + one queue item pending, then U4
  const sj = await newSession();
  await oc.sendPrompt({ sessionId: sj.id, text: loopText(20), model: MODEL });
  await until("(i3) live output", () => of(sj.id, "toolOutput").length >= 1);
  await oc.sendPrompt({ sessionId: sj.id, text: "Reply with exactly these words: steer after stop", delivery: "steer" });
  await oc.sendPrompt({ sessionId: sj.id, text: "Reply with exactly these words: U4 PARKED RAN", delivery: "queue" });
  await until("(i3) both pending", () => itemsOf(sj.id).length === 2, 15_000);
  await oc.interruptSession(sj.id, { resume: true }); // what `opencode:abort` does
  await until("(i3) the steer item ran as the next turn and the session is idle", () => starts(sj.id) >= 2 && idleWith(sj.id)(), 90_000);
  const jPending = itemsOf(sj.id);
  check("(i.3) Stop with a steer + a queue item: the steer item ran next, the queue item stays parked (snapshot)", /steer after stop/i.test(await asstText(sj.id)) && jPending.length === 1 && jPending[0].delivery === "queue" && jPending[0].text.includes("U4 PARKED RAN") && !(await userTexts(sj.id)).includes("Reply with exactly these words: U4 PARKED RAN"), j(jPending));
  check("(i.3) the session is idle (not in the active set) before U4", !(await oc.listActiveSessionIds()).includes(sj.id));
  const startsBefore = starts(sj.id);
  const parked = jPending[0];
  const j1 = await setDelivery(sj.id, parked.id, "steer");
  check("(U4) N1 steer on the parked item of the IDLE session → outcome `changed`", j1.outcome === "changed", j(j1));
  console.log(`  [U4] N1 outcome: ${j(j1)}`);
  const u4Started = await until("(U4) a new turn started", () => starts(sj.id) > startsBefore, 30_000);
  check("(U4) a NEW turn started: a running(true) frame + a new execution.started for the session", u4Started && rawLog.filter((e) => e.raw.type === "session.execution.started" && e.raw.data.sessionID === sj.id).length >= 3, `starts ${startsBefore}→${starts(sj.id)}`);
  await until("(U4) the new turn completed", idleWith(sj.id), 90_000);
  check("(U4) the parked message was delivered by that turn: inbox empty, message exists, the model answered it", itemsOf(sj.id).length === 0 && (await oc.getMessage(sj.id, parked.id))?.info.id === parked.id && /u4 parked ran/i.test(await asstText(sj.id)), `items=${j(itemsOf(sj.id))}`);
  check("(U4) lifecycle shows busy then idle again for the session after the N1", lifecycle.filter((e) => e.type === "session.status" && e.properties.sessionID === sj.id && e.properties.status.type === "busy").length >= 3 && !(await oc.listActiveSessionIds()).includes(sj.id));

  // 5: queue → steer → queue keeps one inbox item with the last delivery
  const sk = await newSession();
  await oc.sendPrompt({ sessionId: sk.id, text: loopText(12), model: MODEL });
  await until("(i5) live output", () => of(sk.id, "toolOutput").length >= 1);
  await oc.sendPrompt({ sessionId: sk.id, text: "Reply with exactly: round trip", delivery: "queue" });
  await until("(i5) pending", () => itemsOf(sk.id).length === 1, 15_000);
  const kItem = itemsOf(sk.id)[0];
  const k1 = await setDelivery(sk.id, kItem.id, "steer");
  const k2 = await setDelivery(sk.id, kItem.id, "queue");
  const kRaw = await oc.listInbox(sk.id);
  check("(i.5) queue → steer → queue: both `changed`, ONE inbox item (snapshot + raw GET) with the last delivery", k1.outcome === "changed" && k2.outcome === "changed" && itemsOf(sk.id).length === 1 && itemsOf(sk.id)[0].id === kItem.id && itemsOf(sk.id)[0].delivery === "queue" && kRaw.filter((r) => r.id === kItem.id).length === 1 && kRaw.find((r) => r.id === kItem.id)?.delivery === "queue", j([k1, k2, itemsOf(sk.id), kRaw.map((r) => [r.id, r.delivery])]));
  const k3raw = await rawPatch(sk.id, kItem.id, "queue");
  const k3 = await setDelivery(sk.id, kItem.id, "queue");
  console.log(`  [i] to the delivery the item ALREADY has (queue→queue): raw PATCH ${k3raw}; N1 ${j(k3)}`);
  await cancel(sk.id, kItem.id);

  } // end of the cleanup-spec block (skipped under C1_SMOKE_B_ONLY=1)

  // ================================================================ Stage B (§B-server 8)
  const B = delegateMod;
  const jobsNow = () => loadJobsB();
  const jobBy = async (pred) => (await jobsNow()).find(pred);
  const rawTl = (sid, type) => oc.listRawTimeline(sid, type ? { type } : {});
  const assistantTexts = (tl) =>
    tl.filter((r) => r.type === "assistant").map((r) => (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""));
  const wait = (label, pred, ms = 60_000) => until(label, pred, ms);
  const loop = (n, tag = "b") => `Run exactly this shell command and nothing else: for i in ${Array.from({ length: n }, (_, k) => k + 1).join(" ")}; do echo ${tag}$i; sleep 1; done . Then reply with the single word done.`;
  // a parent conversation with its own permission ruleset and a window the engine can resolve
  async function newParent(opts = {}) {
    // (an explicit model: a session with none would fall back to V2's own default, which is not the mock)
    const s = await newSession({ model: MODEL, permissions: [{ action: "shell", resource: "echo *", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }], ...opts });
    fakeWindows.push({ index: 100 + fakeWindows.length, opencodeSessionId: s.id });
    return s;
  }
  const execStarts = (sid) => rawLog.filter((e) => e.raw.type === "session.execution.started" && e.raw.data.sessionID === sid);
  const rawOf = (type, pred) => rawLog.filter((e) => e.raw.type === type && pred(e.raw.data));

  // ---------------------------------------------------------------- 10. launch checks (wrapped run)
  console.log("\n[10] startCommandJob: cap + nesting refusals create nothing");
  {
    const p = await newParent();
    const saved = await jobsNow();
    const fiveRunning = Array.from({ length: B.MAX_RUNNING_JOBS }, (_, i) => ({ id: `cap0000${i}`, name: "x", parentSessionID: "ses_other", childSessionID: `ses_cap${i}`, status: "running", origin: "delegate" }));
    await saveJobsB([...saved, ...fiveRunning]);
    const before = (await oc.listSessions(sb.dirs.repo)).length;
    const capRes = await engine.startCommandJob({ parentSessionID: p.id, command: "smokecmd", arguments: "cap" });
    check("(10) at the cap → refused with startJob's message, no child created", capRes.ok === false && capRes.error === B.CAP_ERROR && (await oc.listSessions(sb.dirs.repo)).length === before, j(capRes));
    await saveJobsB([...saved, { id: "nest0001", name: "n", parentSessionID: "ses_other", childSessionID: p.id, status: "running", origin: "delegate" }]);
    const nestRes = await engine.startCommandJob({ parentSessionID: p.id, command: "smokecmd", arguments: "nest" });
    check("(10) a run from inside a background job's session → refused (no nesting), nothing created", nestRes.ok === false && /cannot start another background job/.test(nestRes.error) && (await oc.listSessions(sb.dirs.repo)).length === before, j(nestRes));
    await saveJobsB(saved);
  }

  // ---------------------------------------------------------------- 11. wrapped run, IDLE parent
  console.log("\n[11] wrapped run on an IDLE parent: child config, completion, N7 result, one reply (U1 idle)");
  let wrappedJob;
  {
    const p = await newParent();
    const parentPerms = (await oc.readSession(p.id)).session.permissions;
    const res = await engine.startCommandJob({ parentSessionID: p.id, parentDirectory: sb.dirs.repo, command: "smokecmd", arguments: "wrapped", model: MODEL });
    check("(11) startCommandJob resolves a job at `running`", res.ok === true && res.job.launchState === "running" && res.job.origin === "command" && res.job.completionOwner === "manta", j(res));
    wrappedJob = res.job;
    const child = (await oc.readSession(wrappedJob.childSessionID)).session;
    sessions.push(child.id);
    check("(11) the child is a real V2 child of the parent (client-minted id, parentID, title = /cmd args)", child.id === wrappedJob.childSessionID && /^ses_[0-9a-f]{32}$/.test(child.id) && child.parentID === p.id && child.title === "/smokecmd wrapped", j({ id: child.id, parentID: child.parentID, title: child.title }));
    check("(11) the child has exactly the parent's permission ruleset", JSON.stringify(child.permissions) === JSON.stringify(parentPerms) && parentPerms.length === 2, j({ child: child.permissions, parent: parentPerms }));
    check("(11) the job is registered with a window stamped for the child and a persisted result id", fakeWindows.some((w) => w.opencodeSessionId === child.id) && /^msg_/.test(wrappedJob.completionMessageId) && wrappedJob.submittedAt > 0);
    await wait("(11) the job finished", async () => (await jobBy((x) => x.id === wrappedJob.id))?.status === "done");
    const done = await jobBy((x) => x.id === wrappedJob.id);
    check("(11) completion from the raw outcome: done, result = the child's reply, window kept", done.status === "done" && /command ran wrapped/.test(done.result ?? "") && !killed.some((k) => k.windowIndex === done.windowIndex), j({ status: done.status, result: done.result, error: done.error, killed }));
    await wait("(11) the result was posted", async () => (await jobBy((x) => x.id === wrappedJob.id))?.completionDelivery === "delivered", 60_000);
    await until("(11) parent idle after the reply", async () => !(await oc.listActiveSessionIds()).includes(p.id) && execStarts(p.id).length >= 1, 60_000);
    await sleep(1200);
    const tl = await rawTl(p.id);
    const syn = tl.filter((r) => r.type === "synthetic" && r.metadata?.source === "subagent");
    console.log(`  [11] parent timeline: ${tl.map((r) => r.type + (r.type === "synthetic" ? `(${r.metadata?.source ?? "reminder"})` : "")).join(" → ")}`);
    check("(11) exactly ONE result synthetic in the parent, under the job's persisted completionMessageId", syn.length === 1 && syn[0].id === wrappedJob.completionMessageId, j(syn.map((s) => s.id)));
    check("(11) the synthetic carries source=subagent, childID and our jobId (N7)", syn[0]?.metadata?.source === "subagent" && syn[0].metadata.childID === wrappedJob.childSessionID && syn[0].metadata.manta?.jobId === wrappedJob.id && syn[0].metadata.state === "completed", j(syn[0]));
    const after = tl.slice(tl.findIndex((r) => r.id === syn[0]?.id) + 1).filter((r) => r.type === "assistant");
    check("(11) exactly ONE parent reply after the result", after.length === 1, `replies=${after.length}`);
    const enq = rawLog.find((e) => e.raw.type === "session.inbox.enqueued" && e.raw.data.inboxID === wrappedJob.completionMessageId);
    const started = rawLog.find((e) => e.raw.type === "session.execution.started" && e.raw.data.sessionID === p.id && e.t >= (enq?.t ?? Infinity));
    console.log(`  [U1 idle] enqueue → execution.started on the idle parent: ${started && enq ? started.t - enq.t : "?"} ms`);
    check("(U1 idle) a result posted to an IDLE parent starts a turn at once (< 3 s)", !!enq && !!started && started.t - enq.t < 3000, `${started && enq ? started.t - enq.t : "none"} ms`);
    check("(11) Manta posted exactly once", postedByManta === 1, `posted=${postedByManta}`);
    // a second sweep / boot reconcile must not post again
    await engine.reconcileV2();
    await engine.sweep();
    check("(11) re-running the boot reconcile + sweep posts nothing more", postedByManta === 1 && (await rawTl(p.id, "synthetic")).filter((r) => r.metadata?.source === "subagent").length === 1);
    wrappedJob.parent = p.id;
  }

  // ---------------------------------------------------------------- 11b. a plan-agent parent
  console.log("\n[11b] wrapped run on a PLAN-agent parent: the child runs plan too; the parent is never switched");
  {
    const p = await newParent({ agent: "plan" });
    const res = await engine.startCommandJob({ parentSessionID: p.id, parentDirectory: sb.dirs.repo, command: "smokecmd", arguments: "planned", model: MODEL });
    sessions.push(res.job?.childSessionID);
    const child = (await oc.readSession(res.job.childSessionID)).session;
    check("(11b) the child runs the plan agent (the parent's own, explicit on create AND run) and the parent still does", child.agent === "plan" && (await oc.getSessionAgent(p.id)) === "plan", j([child.agent, await oc.getSessionAgent(p.id)]));
    await wait("(11b) the job finished", async () => (await jobBy((x) => x.id === res.job.id))?.status === "done");
    await until("(11b) parent settled", async () => (await jobBy((x) => x.id === res.job.id))?.completionDelivery === "delivered" && !(await oc.listActiveSessionIds()).includes(p.id), 60_000);
    check("(11b) after the whole round trip the parent's agent is still plan", (await oc.getSessionAgent(p.id)) === "plan");
  }

  // ---------------------------------------------------------------- 12. U1 busy parent + U2
  console.log("\n[12] wrapped run while the parent is BUSY: the result waits for the turn (U1 busy); U2 same synthetic id twice → one record");
  {
    const p = await newParent();
    await oc.sendPrompt({ sessionId: p.id, text: loop(8, "pb"), model: MODEL });
    await until("(12) parent busy with live output", () => of(p.id, "toolOutput").length >= 1);
    const res = await engine.startCommandJob({ parentSessionID: p.id, parentDirectory: sb.dirs.repo, command: "smokecmd", arguments: "busy", model: MODEL });
    check("(12) a background run never steers the parent's turn (started while it is busy)", res.ok === true, j(res));
    sessions.push(res.job.childSessionID);
    await wait("(12) the child finished", async () => (await jobBy((x) => x.id === res.job.id))?.status === "done", 40_000);
    const parentBusyWhenChildDone = (await oc.listActiveSessionIds()).includes(p.id);
    await wait("(12) the result was posted", async () => (await jobBy((x) => x.id === res.job.id))?.completionDelivery === "delivered");
    const enq = rawOf("session.inbox.enqueued", (d) => d.sessionID === p.id && d.inboxID === res.job.completionMessageId);
    check("(12) the result was enqueued as `queue` while the parent was still busy", parentBusyWhenChildDone && enq.length === 1 && enq[0].raw.data.item.delivery === "queue", j(enq.map((e) => e.raw.data.item)));
    await until("(12) the parent finished its loop turn and the follow-up", async () => rawOf("session.inbox.delivered", (d) => d.sessionID === p.id && d.inboxID === res.job.completionMessageId).length === 1 && !(await oc.listActiveSessionIds()).includes(p.id), 120_000);
    await sleep(1500);
    const tl = await rawTl(p.id);
    const at = tl.findIndex((r) => r.id === res.job.completionMessageId);
    const before = tl.slice(0, at).filter((r) => r.type === "assistant");
    const after = tl.slice(at + 1).filter((r) => r.type === "assistant");
    const finalBefore = assistantTexts(before).at(-1) ?? "";
    console.log(`  [12] parent timeline: ${tl.map((r) => r.type + (r.type === "synthetic" ? `(${r.metadata?.source ?? "reminder"})` : "")).join(" → ")}; executions started: ${execStarts(p.id).length}`);
    check("(U1 busy) the queued result landed AFTER the busy parent's turn finished (its tool step AND its final answer precede it) — never steered mid-turn", at > 0 && before.some((r) => (r.content ?? []).some((c) => c.type === "tool")) && /done/.test(finalBefore) && (before.at(-1)?.time?.completed ?? Infinity) <= tl[at].time.created, `at=${at} finalBefore=${finalBefore}`);
    check("(U1 busy) …and it started a turn of its own: exactly one parent reply to it", after.length === 1, `replies=${after.length}`);
    const syn = tl.filter((r) => r.type === "synthetic" && r.metadata?.source === "subagent");
    check("(12) exactly one result in the busy parent", syn.length === 1);

    // U2: the same explicit id twice → one record
    const body = { id: "msg_u2_dup_0001", text: "dup result", description: "u2", metadata: { source: "subagent", childID: "ses_none", state: "completed" }, delivery: "queue", resume: true };
    const r1 = await oc.postSynthetic(p.id, body).then(() => "2xx", (e) => `${e.status}`);
    await until("(U2) the first post's turn ran", async () => rawOf("session.inbox.delivered", (d) => d.sessionID === p.id && d.inboxID === body.id).length === 1 && !(await oc.listActiveSessionIds()).includes(p.id), 60_000);
    await sleep(1000);
    const startsMid = execStarts(p.id).length;
    const asstMid = assistantTexts(await rawTl(p.id)).length;
    const r2 = await oc.postSynthetic(p.id, body).then(() => "2xx", (e) => `${e.status}`);
    await sleep(3500);
    await until("(U2) idle", async () => !(await oc.listActiveSessionIds()).includes(p.id), 30_000);
    const dups = (await rawTl(p.id, "synthetic")).filter((r) => r.id === body.id);
    const asstEnd = assistantTexts(await rawTl(p.id)).length;
    console.log(`  [U2] first post ${r1}, second post ${r2}; records with that id: ${dups.length}; executions after the 2nd post: ${execStarts(p.id).length - startsMid}; assistant replies added by it: ${asstEnd - asstMid}`);
    check("(U2) the same synthetic id posted twice is admitted ONCE (one record)", r1 === "2xx" && dups.length === 1, `r2=${r2} records=${dups.length}`);
    check("(U2) …and the duplicate adds no extra reply (a re-run of an idle session has nothing to answer)", asstEnd === asstMid, `executions +${execStarts(p.id).length - startsMid}, replies +${asstEnd - asstMid}`);
  }

  // ---------------------------------------------------------------- 13. NATIVE background commands (subagent:true) — F4/F5 + adoption
  console.log("\n[13] V2-native background command (`commands` key, subagent:true): adopted row, no Manta result, one opencode result, one reply, row stays");
  const nativeRun = async (command, label, directory) => {
    const p = await newParent(directory ? { directory } : {});
    const jobsBefore = (await jobsNow()).length;
    postedByManta = 0;
    await oc.runCommand({ sessionId: p.id, command, arguments: "n1", noSync: true });
    await wait(`(${label}) a row appeared for the command's child`, async () => (await jobsNow()).length > jobsBefore, 30_000);
    const row = await jobBy((x) => x.parentSessionID === p.id);
    if (row) sessions.push(row.childSessionID);
    await wait(`(${label}) the row is recorded finished`, async () => (await jobBy((x) => x.parentSessionID === p.id))?.status === "done", 40_000);
    await until(`(${label}) the parent settled`, async () => !(await oc.listActiveSessionIds()).includes(p.id), 60_000);
    await sleep(1500);
    const done = await jobBy((x) => x.parentSessionID === p.id);
    const tl = await rawTl(p.id);
    const syn = tl.filter((r) => r.type === "synthetic");
    const replies = tl.slice(tl.findIndex((r) => r.id === syn[0]?.id) + 1).filter((r) => r.type === "assistant");
    const users = tl.filter((r) => r.type === "user");
    if (process.env.C1_SMOKE_VERBOSE) {
      console.log(`  [${label}] parent timeline:`, JSON.stringify(tl.map((r) => ({ type: r.type, id: r.id, text: (r.text ?? "").slice(0, 80), md: r.metadata?.source, content: (r.content ?? []).map((c) => c.type + (c.name ? `:${c.name}` : "") + (c.text ? `:${c.text.slice(0, 40)}` : "")) }))));
      console.log(`  [${label}] raw events for the parent:`, rawLog.filter((e) => e.raw.data?.sessionID === p.id && /execution|inbox/.test(e.raw.type)).map((e) => `${e.raw.type}${e.raw.data.item ? `(${e.raw.data.item.type}/${e.raw.data.item.delivery})` : ""}`).join(" "));
    }
    return { p, row, done, syn, replies, users, tl };
  };
  {
    const n = await nativeRun("bgnative", "13");
    check("(13) the parent got no user message and no tool part for the command (F5)", n.users.length === 0 && n.tl.every((r) => r.type !== "assistant" || !(r.content ?? []).some((c) => c.type === "tool")), j(n.tl.map((r) => r.type)));
    check("(13) adopted as a row: origin command, opencode-owned, engine v2, no worktree, named from the command window", n.row?.origin === "command" && n.row.completionOwner === "opencode" && n.row.engine === "v2" && n.row.worktree === null && n.row.name === "/bgnative n1", j(n.row));
    check("(13) the row finished (it was adopted AFTER the child ended — the raw outcome map covered the gap) and stays", n.done?.status === "done" && /native bg ran n1/.test(n.done.result ?? "") && !killed.some((k) => k.windowIndex === n.done.windowIndex), j(n.done));
    check("(13) Manta posted NOTHING for it", postedByManta === 0 && n.done?.completionDelivery === null && n.done?.completionMessageId === null);
    check("(13) exactly ONE opencode-posted result in the parent (source=subagent, not ours) and ONE reply", n.syn.length === 1 && n.syn[0].metadata?.source === "subagent" && n.syn[0].metadata?.childID === n.row?.childSessionID && !n.syn[0].metadata?.manta && n.replies.length === 1, `syn=${n.syn.length} replies=${n.replies.length} md=${j(n.syn[0]?.metadata)}`);
  }

  // ---------------------------------------------------------------- 14. U5: a .md command with `subagent: true`
  console.log("\n[14] U5: a .md command with `subagent: true` frontmatter behaves like the native one");
  {
    // (a project's .opencode/commands is read when opencode first opens that directory: use a fresh one)
    const mdDir = join(sb.root, "dirs", "repo-md");
    mkdirSync(join(mdDir, ".opencode", "commands"), { recursive: true });
    execSync("git init -q", { cwd: mdDir, stdio: "ignore" });
    writeFileSync(join(mdDir, ".opencode", "commands", "bgmd.md"), "---\ndescription: md background command\nsubagent: true\n---\nReply with exactly these words: md bg ran $ARGUMENTS\n");
    const n = await nativeRun("bgmd", "14", mdDir);
    const listed = await oc.listCommands({ directory: mdDir });
    console.log(`  [U5] commands visible for the project once opened: ${j(listed.map((c) => c.name))}`);
    check("(U5) the project's own .md command is listed for its directory", listed.some((c) => c.name === "bgmd"), j(listed.map((c) => c.name)));
    check("(U5) the .md command ran in a CHILD session (row adopted, parent got no user message/tool part)", !!n.row && n.users.length === 0, j(n.row));
    check("(U5) …finished, no Manta result, exactly one opencode result + one reply", n.done?.status === "done" && postedByManta === 0 && n.syn.length === 1 && n.replies.length === 1, `syn=${n.syn.length} replies=${n.replies.length}`);
  }

  // ---------------------------------------------------------------- 15. N4 over the real timeline (if the mapper has landed)
  console.log("\n[15] the parent transcript: the result renders as a background-result message (N4) once the mapper is on this branch");
  {
    const tx = await oc.listMessages(wrappedJob.parent);
    const bg = tx.filter((m) => m.parts?.some((p) => p.type === "background-result"));
    if (bg.length === 0) console.log("  [N4] SKIPPED — the B1a mapper is not on this branch yet (the raw synthetic was verified above)");
    else check("(N4) the wrapped run's result maps to ONE background-result part paired by jobId", bg.length === 1 && bg[0].parts.find((p) => p.type === "background-result").jobId === wrappedJob.id, j(bg.map((m) => m.parts)));
  }

  // ---------------------------------------------------------------- spend
  for (const id of sessions.filter(Boolean)) {
    const s = await oc.readSession(id);
    cost += s.session?.cost ?? 0;
  }
  console.log(`\n[spend] total session cost $${cost.toFixed(4)}`);
  check("total model spend < $1", cost < 1);

  // cleanup through the production delete path
  for (const id of sessions.filter(Boolean).reverse()) await oc.deleteSessionRaw(id).catch(() => {});
  const firstId = sessions.find(Boolean);
  check("deleteSessionRaw removes a session (sessionExists → false)", (await oc.sessionExists(firstId)) === false);
} catch (e) {
  check("smoke ran to completion", false, e?.stack ?? String(e));
} finally {
  stop();
  interp.dispose();
  await sb.stop();
  await fake.close?.();
  await mock?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (process.env.C1_SMOKE_FRAMES) {
  mkdirSync(dirname(process.env.C1_SMOKE_FRAMES), { recursive: true });
  writeFileSync(process.env.C1_SMOKE_FRAMES, JSON.stringify(frames, null, 1));
}
process.exit(failed.length ? 1 : 0);
