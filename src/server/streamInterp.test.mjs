// Unit tests for the V2 stream interpreter (OpenCode V2 cutover, slice C1).
// Each test feeds hand-built raw V2 events (`{id, type, data}`); the recorded
// end-to-end streams live in streamInterp.golden.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamInterpreter, SHELL_POLL_MS } from "./streamInterp.mjs";

const SID = "ses_main";
const MID = "msg_a1";
let n = 0;
const ev = (type, data = {}, id) => ({ id: id ?? `evt_${++n}`, type, data: { sessionID: SID, ...data } });

function make(opts = {}) {
  const events = [];
  const interp = createStreamInterpreter({ publish: (e) => events.push(e), now: () => 500_000, ...opts });
  return { interp, events };
}
const subs = (events, sub) => events.filter((e) => e.sub === sub);

function makeTimed(opts = {}) {
  let clock = 1_000_000;
  const events = [];
  const timers = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => { t.dead = true; },
    ...opts,
  });
  const advance = async (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock = due.at;
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    clock = until;
  };
  return { interp, events, advance, pending: () => timers.filter((t) => !t.dead).length };
}

// ---- turn lifecycle ----

test("execution.started -> running frame with a non-null since; the idle edge clears it", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.started"));
  const [run] = subs(events, "running");
  assert.deepEqual(run.payload, { running: true, type: "busy", since: 500_000 });
  interp.interpret(ev("session.execution.succeeded"));
  assert.deepEqual(subs(events, "running").at(-1).payload, { running: false, type: "idle", since: null });
  assert.deepEqual(subs(events, "turnComplete").at(-1).payload, { complete: true, running: false, since: null });
});

test("a second started while already running keeps the SAME since (clock not restarted)", () => {
  let t = 1000;
  const events = [];
  const interp = createStreamInterpreter({ publish: (e) => events.push(e), now: () => t });
  interp.interpret(ev("session.execution.started"));
  t = 9000;
  interp.interpret(ev("session.execution.started"));
  assert.deepEqual(subs(events, "running").map((e) => e.payload.since), [1000, 1000]);
});

test("execution.failed -> sessionError (V1 error names) + running false + turnComplete", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.started"));
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.no-route", message: "Model unavailable: anthropic/x" } }));
  const [err] = subs(events, "sessionError");
  assert.deepEqual(err.payload, { name: "ApiError", message: "Model unavailable: anthropic/x" });
  assert.equal(subs(events, "running").at(-1).payload.running, false);
  assert.equal(subs(events, "turnComplete").at(-1).payload.complete, true);
});

test("execution.failed maps the typed error classes to the V1 names the banners switch on", () => {
  for (const [type, name] of [["provider.auth", "ProviderAuthError"], ["context.length", "ContextOverflowError"], ["output.length", "MessageOutputLengthError"]]) {
    const { interp, events } = make();
    interp.interpret(ev("session.execution.failed", { error: { type, message: "m" } }));
    assert.equal(subs(events, "sessionError")[0].payload.name, name);
  }
});

test("sessionError carries rawMessage only when humanizing changed the text", () => {
  const { interp, events } = make();
  const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "OAuth token has expired" } });
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.auth", message: `Unauthorized: ${body}` } }));
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.internal", message: "plain failure" } }));
  const [wrapped, plain] = subs(events, "sessionError").map((e) => e.payload);
  assert.equal(wrapped.message, "OAuth token has expired");
  assert.equal(wrapped.rawMessage, `Unauthorized: ${body}`);
  assert.equal(plain.message, "plain failure");
  assert.equal("rawMessage" in plain, false);
});

test("execution.interrupted -> `aborted` {} and NO sessionError; running false + turnComplete follow", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.started"));
  interp.interpret(ev("session.execution.interrupted", { reason: "user" }));
  assert.equal(subs(events, "sessionError").length, 0);
  assert.deepEqual(subs(events, "aborted").map((e) => e.payload), [{}]);
  assert.equal(subs(events, "running").at(-1).payload.running, false);
  assert.equal(subs(events, "turnComplete").at(-1).payload.complete, true);
});

test("the same event delivered twice (a reconnect) is interpreted once; a new one emits again", () => {
  const { interp, events } = make();
  const e = ev("session.execution.interrupted", {}, "evt_dup");
  interp.interpret(e);
  interp.interpret(e);
  assert.equal(subs(events, "aborted").length, 1);
  interp.interpret(ev("session.execution.interrupted"));
  assert.equal(subs(events, "aborted").length, 2);
});

test("interpret ignores events with no session id and malformed input", () => {
  const { interp, events } = make();
  interp.interpret({ id: "x", type: "project.updated", data: {} });
  interp.interpret({ type: "session.execution.started" });
  interp.interpret(null);
  interp.interpret({ type: 5 });
  assert.equal(events.length, 0);
});

test("retry: session.retry.scheduled publishes the banner payload; the next step clears it with null", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.retry.scheduled", { attempt: 2, at: 1792167156112, error: { type: "provider.internal", message: "Overloaded", status: 529 } }));
  assert.deepEqual(subs(events, "retry")[0].payload, { attempt: 2, message: "Overloaded", next: 1792167156112 });
  interp.interpret(ev("session.step.started", { assistantMessageID: MID, model: { providerID: "p", id: "m" } }));
  assert.equal(subs(events, "retry").at(-1).payload, null);
  assert.equal(subs(events, "retry").length, 2);
});

test("a retry is cleared once by the turn edge too, and never twice", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.retry.scheduled", { attempt: 2, at: 1, error: { message: "x" } }));
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.internal", message: "x" } }));
  interp.interpret(ev("session.execution.succeeded"));
  assert.equal(subs(events, "retry").filter((e) => e.payload === null).length, 1);
});

// ---- text ----

test("text and reasoning deltas are forwarded as they arrive (phrase-level), keyed by message + ordinal", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.text.delta", { assistantMessageID: MID, ordinal: 0, delta: "Hello! I'm ready" }));
  interp.interpret(ev("session.reasoning.delta", { assistantMessageID: MID, ordinal: 0, delta: "thinking…" }));
  interp.interpret(ev("session.text.delta", { assistantMessageID: MID, ordinal: 1, delta: " more" }));
  assert.deepEqual(subs(events, "flush").map((e) => e.payload), [
    { messageID: MID, partID: `${MID}:text:0`, field: "text", text: "Hello! I'm ready" },
    { messageID: MID, partID: `${MID}:reasoning:0`, field: "reasoning", text: "thinking…" },
    { messageID: MID, partID: `${MID}:text:1`, field: "text", text: " more" },
  ]);
});

test("a delta with no message id or no text emits nothing", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.text.delta", { delta: "x" }));
  interp.interpret(ev("session.text.delta", { assistantMessageID: MID, delta: "" }));
  assert.equal(subs(events, "flush").length, 0);
});

// ---- steps: stepEnded / truncation / context / cache ----

const STEP = { assistantMessageID: MID, finish: "stop", rawFinish: "end_turn", cost: 0.01, tokens: { input: 3, output: 7, reasoning: 0, cache: { read: 1000, write: 200 } } };

test("step.ended -> stepEnded with normalised tokens, cost and the provider's finish", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.step.ended", STEP));
  assert.deepEqual(subs(events, "stepEnded")[0].payload, {
    messageID: MID,
    tokens: { input: 3, output: 7, reasoning: 0, cache: { read: 1000, write: 200 } },
    cost: 0.01,
    finish: "end_turn",
  });
});

test("step.ended without usage still announces the step (zeros, no cost/finish)", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.step.ended", { assistantMessageID: MID }));
  assert.deepEqual(subs(events, "stepEnded")[0].payload, { messageID: MID, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  assert.equal(subs(events, "context").length, 0);
});

test("truncation: max_tokens -> output-cap with the messageID; a tool-calls stop promotes to tool-cutoff", () => {
  const a = make();
  a.interp.interpret(ev("session.step.ended", { assistantMessageID: MID, finish: "length", rawFinish: "max_tokens" }));
  assert.deepEqual(subs(a.events, "truncation")[0].payload.kind, "output-cap");
  assert.equal(subs(a.events, "truncation")[0].payload.messageID, MID);
  const b = make();
  b.interp.interpret(ev("session.step.ended", { assistantMessageID: MID, finish: "tool-calls", rawFinish: "max_tokens" }));
  assert.equal(subs(b.events, "truncation")[0].payload.kind, "tool-cutoff");
  const c = make();
  c.interp.interpret(ev("session.step.ended", STEP));
  assert.equal(subs(c.events, "truncation").length, 0);
});

test("context: disjoint buckets are summed against the model's limit (resolver); repeated identical steps are deduped", () => {
  const seen = [];
  const { interp, events } = make({ contextLimitFor: (p, m) => (seen.push([p, m]), 1_000_000) });
  interp.interpret(ev("session.step.started", { assistantMessageID: MID, model: { providerID: "anthropic", id: "claude-x" } }));
  interp.interpret(ev("session.step.ended", STEP));
  interp.interpret(ev("session.step.ended", STEP));
  const ctx = subs(events, "context");
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].payload.totalInput, 1203);
  assert.equal(ctx[0].payload.hasLimit, true);
  assert.equal(ctx[0].payload.pct, 0);
  assert.deepEqual(seen[0], ["anthropic", "claude-x"]);
  assert.equal(subs(events, "cache").length, 2); // staleness is re-evaluated every step
});

test("a resolver miss passes the unknown limit straight through (no fake window)", () => {
  const { interp, events } = make({ contextLimitFor: () => null });
  interp.interpret(ev("session.step.ended", STEP));
  assert.equal(subs(events, "context")[0].payload.hasLimit, false);
  assert.equal(subs(events, "context")[0].payload.pct, null);
});

test("cache staleness predicts against the configured TTL, falling back to 5m", async () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const oneHour = [];
  const i1 = createStreamInterpreter({ publish: (e) => oneHour.push(e), readCacheTtl: async () => "1h" });
  await flush();
  i1.interpret(ev("session.step.ended", STEP));
  assert.equal(subs(oneHour, "cache")[0].payload.ttlMs, 3_600_000);
  const five = [];
  const i2 = createStreamInterpreter({ publish: (e) => five.push(e), readCacheTtl: async () => null });
  await flush();
  i2.interpret(ev("session.step.ended", STEP));
  assert.equal(subs(five, "cache")[0].payload.ttlMs, 5 * 60_000);
});

// ---- tools ----

const called = (id, name, input, extra = {}) => [
  ev("session.tool.input.started", { assistantMessageID: MID, id, name }),
  ev("session.tool.called", { assistantMessageID: MID, id, input, ...extra }),
];
const success = (id, text, metadata = {}) => ev("session.tool.success", { assistantMessageID: MID, id, content: [{ type: "text", text }], metadata });

test("toolStarted fires once per tool with the V1 tool name; toolEnded + toolBoundary on success", () => {
  const { interp, events } = make();
  for (const e of called("toolu_1", "shell", { command: "ls" })) interp.interpret(e);
  interp.interpret(success("toolu_1", "a\nb\n"));
  interp.interpret(success("toolu_1", "a\nb\n", {}));
  assert.deepEqual(subs(events, "toolStarted").map((e) => e.payload), [
    { sessionId: SID, idx: "toolu_1", callID: "toolu_1", toolName: "bash", toolPresentationHint: null, status: "pending" },
  ]);
  assert.deepEqual(subs(events, "toolOutput").map((e) => e.payload.text), ["a\nb\n"]);
  assert.equal(subs(events, "toolEnded")[0].payload.ok, true);
  assert.deepEqual(subs(events, "toolBoundary")[0].payload, { messageID: MID, partID: "toolu_1", callID: "toolu_1", tool: "bash", status: "completed" });
});

test("tool.failed -> toolEnded ok:false and a boundary with status error", () => {
  const { interp, events } = make();
  for (const e of called("toolu_1", "shell", { command: "x" })) interp.interpret(e);
  interp.interpret(ev("session.tool.failed", { assistantMessageID: MID, id: "toolu_1", error: { type: "aborted", message: "Tool execution interrupted" } }));
  assert.equal(subs(events, "toolEnded")[0].payload.ok, false);
  assert.equal(subs(events, "toolBoundary")[0].payload.status, "error");
});

test("an unnamed tool event (e.g. after a reconnect) does not start a nameless tool", () => {
  const { interp, events } = make();
  interp.interpret(success("toolu_9", "x"));
  assert.equal(subs(events, "toolStarted").length, 0);
  assert.equal(subs(events, "toolEnded").length, 1);
});

test("live shell output: polled by cursor every 250 ms until the tool ends, only deltas are sent", async () => {
  let produced = "";
  const reads = [];
  const { interp, events, advance, pending } = makeTimed({
    fetchShellOutput: async ({ shellID, cursor, directory }) => {
      reads.push([shellID, cursor, directory]);
      return { output: produced.slice(cursor), cursor: produced.length };
    },
  });
  for (const e of called("toolu_1", "shell", { command: "loop" })) interp.interpret(e);
  interp.interpret({ ...ev("session.tool.progress", { assistantMessageID: MID, id: "toolu_1", metadata: { shellID: "sh_1" } }), location: { directory: "/w" } });
  assert.equal(pending() >= 1, true);
  produced = "tick1\n";
  await advance(SHELL_POLL_MS);
  produced = "tick1\ntick2\n";
  await advance(SHELL_POLL_MS);
  await advance(SHELL_POLL_MS); // nothing new -> nothing sent
  assert.deepEqual(subs(events, "toolOutput").map((e) => e.payload.text), ["tick1\n", "tick2\n"]);
  assert.deepEqual(reads.map((r) => r[1]), [0, 6, 12]);
  assert.ok(reads.every((r) => r[0] === "sh_1" && r[2] === "/w"), "the shell is read in the event's location");
  // the final result carries a tail the poll had not yet seen -> only the remainder is added
  interp.interpret(success("toolu_1", "tick1\ntick2\ntick3\n"));
  assert.deepEqual(subs(events, "toolOutput").map((e) => e.payload.text), ["tick1\n", "tick2\n", "tick3\n"]);
  await advance(1000);
  assert.equal(reads.length, 3, "polling stopped with the tool");
});

test("the live tail is capped at 20k chars per tool, with one truncation marker and toolEnded.truncated", async () => {
  const big = "x".repeat(30_000);
  const { interp, events, advance } = makeTimed({
    fetchShellOutput: async ({ cursor }) => ({ output: big.slice(cursor), cursor: big.length }),
  });
  for (const e of called("toolu_1", "shell", {})) interp.interpret(e);
  interp.interpret(ev("session.tool.progress", { assistantMessageID: MID, id: "toolu_1", metadata: { shellID: "sh_1" } }));
  await advance(SHELL_POLL_MS);
  interp.interpret(success("toolu_1", big));
  const out = subs(events, "toolOutput").map((e) => e.payload.text);
  assert.equal(out.length, 1);
  assert.ok(out[0].endsWith("… [output truncated]"));
  assert.equal(out[0].length, 20_000 + "… [output truncated]".length);
  assert.equal(subs(events, "toolEnded")[0].payload.truncated, true);
});

test("an interrupt stops the shell poll", async () => {
  const reads = [];
  const { interp, advance } = makeTimed({ fetchShellOutput: async ({ cursor }) => (reads.push(cursor), { output: "", cursor }) });
  for (const e of called("toolu_1", "shell", {})) interp.interpret(e);
  interp.interpret(ev("session.tool.progress", { assistantMessageID: MID, id: "toolu_1", metadata: { shellID: "sh_1" } }));
  await advance(SHELL_POLL_MS);
  interp.interpret(ev("session.execution.interrupted", { reason: "user" }));
  const before = reads.length;
  await advance(2000);
  assert.equal(reads.length, before);
});

test("todo_write input drives the todos frame (active, visible, terminal flags)", () => {
  const { interp, events } = make();
  for (const e of called("toolu_t", "todo_write", { todos: [
    { content: "a", status: "in_progress", priority: "high" },
    { content: "b", status: "pending", priority: "low" },
  ] })) interp.interpret(e);
  const first = subs(events, "todos")[0].payload;
  assert.equal(first.active.length, 2);
  assert.equal(first.allTerminal, false);
  for (const e of called("toolu_u", "todo_write", { todos: [{ content: "a", status: "completed", priority: "high" }, { content: "b", status: "cancelled", priority: "low" }] })) interp.interpret(e);
  const last = subs(events, "todos").at(-1).payload;
  assert.equal(last.allTerminal, true);
  assert.equal(last.anyTerminal, true);
});

// ---- subagents ----

test("session.created with a parentID -> childSession published under the PARENT", () => {
  const { interp, events } = make();
  interp.interpret({ id: "e1", type: "session.created", data: { sessionID: "ses_child", parentID: SID, agent: "explore" } });
  assert.deepEqual(events.filter((e) => e.sub === "childSession").map((e) => [e.sessionId, e.payload]), [
    [SID, { childSessionId: "ses_child", parentSessionId: SID }],
  ]);
  interp.interpret({ id: "e2", type: "session.created", data: { sessionID: "ses_top" } });
  assert.equal(subs(events, "childSession").length, 1, "a top-level session announces no child");
});

test("subagent frames follow the tool: running with the child id, then completed with the unwrapped result", () => {
  const { interp, events } = make();
  for (const e of called("toolu_s", "subagent", { agent: "explore", description: "Find greet", prompt: "go" })) interp.interpret(e);
  interp.interpret(ev("session.tool.progress", { assistantMessageID: MID, id: "toolu_s", metadata: { sessionID: "ses_child", status: "running" } }));
  interp.interpret(success("toolu_s", '<subagent sessionID="ses_child" state="completed">\nfound it\n</subagent>', { sessionID: "ses_child", status: "completed" }));
  const sub = subs(events, "subagent").map((e) => e.payload);
  assert.equal(sub[0].status, "running");
  assert.equal(sub[0].childSessionId, "ses_child");
  assert.equal(sub[0].agent, "explore");
  assert.equal(sub[0].description, "Find greet");
  assert.equal(sub[0].runningCount, 1);
  assert.equal(sub.at(-1).status, "completed");
  assert.equal(sub.at(-1).output, "found it");
  assert.equal(sub.at(-1).runningCount, 0);
  assert.equal(subs(events, "toolStarted")[0].payload.toolName, "task");
});

// ---- asks: questions + permissions ----

const FORM = {
  id: "frm_1",
  sessionID: SID,
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: MID, id: "toolu_q" } },
  fields: [{ key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true }],
};

test("form.created (question) -> attention + questions in the QuestionRequest shape; replied clears both", () => {
  const { interp, events } = make();
  interp.interpret({ id: "f1", type: "form.created", data: { form: FORM } });
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), ["question"]);
  const q = subs(events, "questions").at(-1).payload.questions[0];
  assert.equal(q.requestId, "frm_1");
  assert.deepEqual(q.tool, { messageID: MID, callID: "toolu_q" });
  assert.equal(q.questions[0].question, "Which colour?");
  assert.equal(q.questions[0].header, "Colour");
  assert.deepEqual(q.questions[0].options, [{ label: "Red", description: "warm" }, { label: "Blue" }]);
  assert.equal(events.at(-1).sub, "questions", "questions is the LAST frame of the event");
  interp.interpret({ id: "f2", type: "form.replied", data: { id: "frm_1", sessionID: SID, answer: { q0: "Red" } } });
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), ["question", null]);
  assert.deepEqual(subs(events, "questions").at(-1).payload.questions, []);
});

test("form.cancelled clears the question; a non-question form (OAuth etc.) is ignored", () => {
  const { interp, events } = make();
  interp.interpret({ id: "f1", type: "form.created", data: { form: { ...FORM, metadata: { kind: "oauth" } } } });
  assert.equal(events.length, 0);
  interp.interpret({ id: "f2", type: "form.created", data: { form: FORM } });
  interp.interpret({ id: "f3", type: "form.cancelled", data: { id: "frm_1", sessionID: SID } });
  assert.deepEqual(subs(events, "questions").at(-1).payload.questions, []);
});

const PERM = { id: "per_1", sessionID: SID, action: "shell", resources: ["echo hi"], save: ["echo *"], source: { type: "tool", messageID: MID, id: "toolu_p" } };

test("permission.asked -> permissions in the PermissionCard shape + attention; replied removes it", () => {
  const { interp, events } = make();
  interp.interpret({ id: "p1", type: "permission.asked", data: PERM });
  const perm = subs(events, "permissions")[0].payload.permissions[0];
  assert.equal(perm.id, "per_1");
  assert.equal(perm.permission, "bash");
  assert.deepEqual(perm.patterns, ["echo hi"]);
  assert.deepEqual(perm.always, ["echo *"]);
  assert.equal(perm.metadata.command, "echo hi");
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), ["permission"]);
  interp.interpret({ id: "p2", type: "permission.replied", data: { sessionID: SID, requestID: "per_1", reply: "once" } });
  assert.deepEqual(subs(events, "permissions").at(-1).payload.permissions, []);
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), ["permission", null]);
});

test("attention: question wins over permission; null only when nothing is pending", () => {
  const { interp, events } = make();
  interp.interpret({ id: "p1", type: "permission.asked", data: PERM });
  interp.interpret({ id: "f1", type: "form.created", data: { form: FORM } });
  interp.interpret({ id: "f2", type: "form.replied", data: { id: "frm_1", sessionID: SID } });
  interp.interpret({ id: "p2", type: "permission.replied", data: { sessionID: SID, requestID: "per_1" } });
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), ["permission", "question", "permission", null]);
});

test("permission.asked for another session is not folded into this one's pending list", () => {
  const { interp, events } = make();
  interp.interpret({ id: "p1", type: "permission.asked", data: { ...PERM, sessionID: "ses_other" } });
  assert.deepEqual(events.filter((e) => e.sub === "permissions").map((e) => [e.sessionId, e.payload.permissions.length]), [["ses_other", 1]]);
});

// ---- plan mode, compaction, snapshot ----

test("session.agent.selected: plan -> planMode on; build -> off", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.agent.selected", { agent: "plan" }));
  interp.interpret(ev("session.agent.selected", { agent: "build" }));
  assert.deepEqual(subs(events, "planMode").map((e) => e.payload.on), [true, false]);
});

test("compaction: started / delta / ended map to frames; the transcript goes stale once the compaction's execution settles (not in the same render as `ended`)", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.compaction.started", { reason: "manual" }));
  interp.interpret(ev("session.compaction.delta", { text: "## Objective" }));
  interp.interpret(ev("session.compaction.ended", { reason: "manual", text: "full" }));
  assert.deepEqual(subs(events, "compaction").map((e) => e.payload), [
    { phase: "started", text: "", reason: "manual" },
    { phase: "delta", text: "## Objective" },
    { phase: "ended" },
  ]);
  assert.equal(subs(events, "transcriptStale").length, 0);
  interp.interpret(ev("session.execution.succeeded"));
  interp.interpret(ev("session.execution.succeeded"));
  assert.deepEqual(subs(events, "transcriptStale").map((e) => e.payload), [{}], "exactly once");
  interp.interpret(ev("session.compacted"));
  assert.equal(subs(events, "transcriptStale").length, 2);
});

test("messageChanged: step/tool/text events name their message; coalesced to one frame per 100 ms, trailing edge guaranteed", async () => {
  const { interp, events, advance } = makeTimed();
  for (let i = 0; i < 5; i++) interp.interpret(ev("session.tool.progress", { assistantMessageID: MID, id: "t", metadata: {} }));
  assert.equal(subs(events, "messageChanged").length, 1, "leading edge only inside the window");
  await advance(100);
  assert.equal(subs(events, "messageChanged").length, 2, "one trailing frame for everything after the first");
  await advance(500);
  assert.equal(subs(events, "messageChanged").length, 2);
  interp.interpret(ev("session.inbox.delivered", { inboxID: "msg_user" }));
  assert.equal(subs(events, "messageChanged").at(-1).payload.messageID, "msg_user");
});

test("messageChanged: flushPending fires an outstanding trailing frame; dispose drops timers", () => {
  const { interp, events, pending } = makeTimed();
  interp.interpret(ev("session.step.started", { assistantMessageID: MID }));
  interp.interpret(ev("session.step.ended", { assistantMessageID: MID }));
  const before = subs(events, "messageChanged").length;
  assert.equal(pending() > 0, true);
  interp.flushPending();
  assert.equal(subs(events, "messageChanged").length, before + 1);
  interp.interpret(ev("session.step.started", { assistantMessageID: "msg_b" }));
  interp.interpret(ev("session.step.ended", { assistantMessageID: "msg_b" }));
  interp.dispose();
  assert.equal(pending(), 0);
});

test("snapshotState always emits exactly one runningSet frame (index 0), even with nothing running", () => {
  const { interp } = make();
  const snap = interp.snapshotState();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0], { kind: "runningSet", payload: { sessions: [] } });
});

test("snapshotState lists a running session with its original since, replays pending asks, drops finished ones", () => {
  let t = 1000;
  const interp = createStreamInterpreter({ publish: () => {}, now: () => t });
  interp.interpret(ev("session.execution.started"));
  t = 2000;
  interp.interpret({ id: "f1", type: "form.created", data: { form: FORM } });
  interp.interpret({ id: "p1", type: "permission.asked", data: PERM });
  const snap = interp.snapshotState();
  assert.deepEqual(snap[0].payload.sessions, [{ sessionId: SID, since: 1000, type: "busy" }]);
  assert.deepEqual(snap.filter((f) => f.sub === "attention").map((f) => f.payload.kind), ["question"]);
  assert.equal(snap.filter((f) => f.sub === "questions").length, 1);
  assert.equal(snap.filter((f) => f.sub === "permissions").length, 1);
  interp.interpret({ id: "f2", type: "form.replied", data: { id: "frm_1", sessionID: SID } });
  interp.interpret({ id: "p2", type: "permission.replied", data: { sessionID: SID, requestID: "per_1" } });
  interp.interpret(ev("session.execution.succeeded"));
  const after = interp.snapshotState();
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].payload.sessions, []);
});

test("a question pending without a running turn is still replayed (not gated on running)", () => {
  const { interp } = make();
  interp.interpret({ id: "f1", type: "form.created", data: { form: FORM } });
  const snap = interp.snapshotState();
  assert.equal(snap[0].payload.sessions.length, 0);
  assert.equal(snap.filter((f) => f.sub === "questions").length, 1);
});

// ---- reconnect resync ----

test("resync after a reconnect: a turn that ended while disconnected is closed; asks are replaced by the server's list; clients refetch", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.started"));
  interp.interpret({ id: "p1", type: "permission.asked", data: PERM });
  events.length = 0;
  interp.resync(SID, { running: false, permissions: [], questions: [] });
  assert.equal(subs(events, "running")[0].payload.running, false);
  assert.equal(subs(events, "turnComplete")[0].payload.complete, true);
  assert.deepEqual(subs(events, "permissions")[0].payload.permissions, []);
  assert.deepEqual(subs(events, "attention").map((e) => e.payload.kind), [null]);
  assert.equal(subs(events, "transcriptStale").length, 1);
});

test("resync on a session the interpreter never saw does nothing", () => {
  const { interp, events } = make();
  interp.resync("ses_unknown", { running: false });
  assert.equal(events.length, 0);
});
