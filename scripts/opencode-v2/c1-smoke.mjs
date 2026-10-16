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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBinary } from "./fetch-binary.mjs";
import { startSandbox } from "./sandbox.mjs";
import { startFakeMantaServer } from "./fake-manta-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta");
const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

if (!process.env.ANTHROPIC_API_KEY) {
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
const sb = await startSandbox({
  binary: await ensureBinary({ log: (m) => console.log(`[binary] ${m}`) }),
  plugins: [PLUGIN_DIR], // todo_write
  dirs: ["repo"],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, MANTA_SERVER_URL: fake.url, MANTA_BOX_TOKEN: "ab12".repeat(8) },
});
console.log(`[sandbox] ${sb.url}`);

// Point the production client at the sandbox BEFORE anything talks to it.
process.env.MANTA_OPENCODE_PASSWORD = sb.password;
const oc = await import("../../src/server/opencode.mjs");
const { createStreamInterpreter } = await import("../../src/server/streamInterp.mjs");
const { createLifecycleAdapter } = await import("../../src/shared/opencodeV2.mjs");
oc._setApiBase(sb.url);

// ---- the production pump, minus the bus: raw → interpreter + lifecycle adapter ----
const frames = [];
const lifecycle = [];
const adapter = createLifecycleAdapter();
const interp = createStreamInterpreter({
  publish: (f) => frames.push(f),
  fetchShellOutput: (a) => oc.readShellOutput(a),
  contextLimitFor: () => 200_000,
});
const connects = [];
const stop = oc.subscribeEvents(
  (raw) => {
    interp.interpret(raw);
    for (const e of adapter.adapt(raw)) lifecycle.push(e);
  },
  { onConnect: (i) => connects.push(i) },
);

const of = (sid, sub) => frames.filter((f) => f.sub === sub && f.sessionId === sid);
async function until(label, pred, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
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

  // ---------------------------------------------------------------- spend
  for (const id of sessions.filter(Boolean)) {
    const s = await oc.readSession(id);
    cost += s.session?.cost ?? 0;
  }
  console.log(`\n[spend] total session cost $${cost.toFixed(4)}`);
  check("total model spend < $1", cost < 1);

  // cleanup through the production delete path
  for (const id of sessions.filter(Boolean).reverse()) await oc.deleteSessionRaw(id).catch(() => {});
  check("deleteSessionRaw removes a session (sessionExists → false)", (await oc.sessionExists(s1.id)) === false);
} catch (e) {
  check("smoke ran to completion", false, e?.stack ?? String(e));
} finally {
  stop();
  interp.dispose();
  await sb.stop();
  await fake.close?.();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (process.env.C1_SMOKE_FRAMES) {
  mkdirSync(dirname(process.env.C1_SMOKE_FRAMES), { recursive: true });
  writeFileSync(process.env.C1_SMOKE_FRAMES, JSON.stringify(frames, null, 1));
}
process.exit(failed.length ? 1 : 0);
