import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamInterpreter } from "./streamInterp.mjs";

function make(now = 500_000) {
  const events = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => now,
  });
  return { interp, events };
}

const SID = "ses_main";

// BET-649 changed the expected cut here: the sentence end is now the boundary,
// so the flush stops after "Hello world.\n" instead of withholding the line
// until the paragraph break. The remainder ("\nSecond para") still carries the
// second newline, so the text the client assembles is byte-identical — only
// the timing of the split changed.
test("message.part.delta flushes at the sentence end and keeps the remainder", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: {
      sessionID: SID,
      messageID: "msg1",
      part: { id: "p1", type: "text", text: "Hello world" },
    },
  });
  assert.equal(events.length, 0, "no boundary yet -> no event");
  interp.interpret({
    type: "message.part.delta",
    properties: {
      sessionID: SID,
      messageID: "msg1",
      part: { id: "p1", type: "text", text: ".\n\nSecond para" },
    },
  });
  const fl = events.find((e) => e.sub === "flush");
  assert.ok(fl, "a flush event was emitted");
  assert.equal(fl.sessionId, SID);
  assert.equal(fl.payload.text, "Hello world.\n");
  assert.equal(fl.payload.messageID, "msg1");
});

test("a paragraph break still flushes when there is no sentence end", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: {
      sessionID: SID,
      messageID: "msg1",
      part: { id: "p1", type: "text", text: "# Heading\n\nbody" },
    },
  });
  const fl = events.find((e) => e.sub === "flush");
  assert.ok(fl, "a flush event was emitted");
  assert.equal(fl.payload.text, "# Heading\n\n");
});

test("max-age fallback flushes an unpunctuated run at the last safe word break", () => {
  // No sentence end, no paragraph break — the pre-BET-649 policy withheld this
  // until the part snapshot, which is the "it all arrived at once" case.
  let clock = 500_000;
  const events = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => clock,
  });
  const delta = (text) =>
    interp.interpret({
      type: "message.part.delta",
      properties: { sessionID: SID, messageID: "msg1", part: { id: "p1", type: "text", text } },
    });

  delta("a long unpunctuated ");
  assert.equal(events.length, 0, "still fresh -> nothing flushed");
  clock += 200; // past FLUSH_MAX_AGE_MS
  delta("run of words");

  const fl = events.find((e) => e.sub === "flush");
  assert.ok(fl, "the age fallback flushed");
  // Cut at the LAST word break in the buffer, never mid-word — so the reader
  // gets everything except the word still being typed.
  assert.equal(fl.payload.text, "a long unpunctuated run of ");
});

test("max-age fallback stops BEFORE an unclosed inline code span", () => {
  let clock = 500_000;
  const events = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => clock,
  });
  interp.interpret({
    type: "message.part.delta",
    properties: {
      sessionID: SID,
      messageID: "msg1",
      part: { id: "p1", type: "text", text: "see `some code " },
    },
  });
  clock += 200;
  interp.interpret({
    type: "message.part.delta",
    properties: {
      sessionID: SID,
      messageID: "msg1",
      part: { id: "p1", type: "text", text: "still open" },
    },
  });
  // Every cut after the opening backtick is inside the span, so the fallback
  // walks back past it and releases only the text before it. `some code still
  // open` stays buffered until the span closes — half a code span must never
  // reach the screen.
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].payload.text, "see ");
});

test("session.next.step.ended emits truncation classification", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.next.step.ended",
    properties: {
      sessionID: SID,
      finish: "max_tokens",
      lastPartIsToolUse: true,
      tokens: { input: 100, cache: { read: 10, write: 20 } },
    },
  });
  const tr = events.find((e) => e.sub === "truncation");
  assert.ok(tr);
  assert.equal(tr.payload.kind, "tool-cutoff");
  // No messageID on the raw step → none forwarded (S1b consumes it when
  // present to stamp the per-message truncation badge).
  assert.equal(tr.payload.messageID, undefined);
});

test("session.next.step.ended passes messageID through on stream.truncation", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.next.step.ended",
    properties: {
      sessionID: SID,
      messageID: "msg_trunc",
      finish: "length",
      tokens: { input: 100 },
    },
  });
  const tr = events.find((e) => e.sub === "truncation");
  assert.ok(tr);
  assert.equal(tr.payload.messageID, "msg_trunc");
});

test("session.next.step.ended emits context breakdown and cache staleness", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.next.step.ended",
    properties: {
      sessionID: SID,
      tokens: { input: 100, cache: { read: 10, write: 20 } },
    },
  });
  const ctx = events.find((e) => e.sub === "context");
  assert.ok(ctx);
  assert.equal(ctx.payload.totalInput, 130);
  assert.equal(ctx.payload.freshInput, 100);
  const cache = events.find((e) => e.sub === "cache");
  assert.ok(cache);
  assert.equal(cache.payload.cachedTokens || cache.payload.staleTokens, 30);
});

test("todo.updated derives active + visible todos", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "todo.updated",
    properties: {
      sessionID: SID,
      todos: [
        { id: "a", status: "in_progress" },
        { id: "b", status: "pending" },
        { id: "c", status: "completed" },
      ],
    },
  });
  const t = events.find((e) => e.sub === "todos");
  assert.ok(t);
  assert.equal(t.payload.allTerminal, false);
  assert.equal(t.payload.visible.visible.length, 3);
});

test("session.created registers a child subagent and emits subagent.child", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.created",
    properties: {
      sessionID: SID,
      info: { id: "ses_child", parentID: SID },
    },
  });
  const ev = events.find((e) => e.sub === "subagent.child");
  assert.ok(ev);
  assert.equal(ev.payload.childSessionId, "ses_child");
});

test("message.part.updated for a task tool emits subagent info", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      part: {
        id: "t1",
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          input: { description: "find x", prompt: "p", subagent_type: "explore" },
          metadata: { sessionId: "ses_child" },
        },
      },
    },
  });
  const ev = events.find((e) => e.sub === "subagent");
  assert.ok(ev);
  assert.equal(ev.payload.childSessionId, "ses_child");
  assert.equal(ev.payload.agent, "explore");
  assert.equal(ev.payload.status, "running");
});

test("question.asked hydrates pending questions", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "question.asked",
    properties: {
      sessionID: SID,
      id: "que_1",
      tool: { messageID: "m", callID: "call_1" },
      questions: [{ text: "Option one?" }],
    },
  });
  const ev = events.find((e) => e.sub === "questions");
  assert.ok(ev);
  assert.equal(ev.payload.questions.length, 1);
  assert.equal(ev.payload.questions[0].id, "call_1");
  // replied removes it
  interp.interpret({
    type: "question.replied",
    properties: { sessionID: SID, id: "que_1" },
  });
  const ev2 = events[events.length - 1];
  assert.equal(ev2.sub, "questions");
  assert.equal(ev2.payload.questions.length, 0);
});

test("permission.asked hydrates pending permissions; replied removes it; other-session asked ignored", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "permission.asked",
    properties: {
      sessionID: SID,
      id: "perm_1",
      prompt: "Allow reading ~/secrets.json?",
    },
  });
  const ev = events.find((e) => e.sub === "permissions");
  assert.ok(ev);
  assert.equal(ev.payload.permissions.length, 1);
  assert.equal(ev.payload.permissions[0].id, "perm_1");
  // replied removes it
  interp.interpret({
    type: "permission.replied",
    properties: { sessionID: SID, id: "perm_1" },
  });
  const ev2 = events[events.length - 1];
  assert.equal(ev2.sub, "permissions");
  assert.equal(ev2.payload.permissions.length, 0);
  // an ask for a different session never leaks into this session's state
  interp.interpret({
    type: "permission.asked",
    properties: { sessionID: "ses_other", id: "perm_2", prompt: "p" },
  });
  const frame = events[events.length - 1];
  assert.equal(frame.sub, "permissions");
  assert.equal(frame.sessionId, "ses_other");
  assert.equal(frame.payload.permissions.length, 1); // its own session's frame
  assert.equal(interp.getState(SID).permissions.length, 0); // SID untouched
});

test("session.idle emits turnComplete true", () => {
  const { interp, events } = make();
  interp.interpret({ type: "session.idle", properties: { sessionID: SID } });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.complete, true);
});

test("session.error emits sessionError with name+message AND turnComplete running false", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.error",
    properties: {
      sessionID: SID,
      error: { name: "ProviderAuthError", data: { message: "Bad key" } },
    },
  });
  const err = events.find((e) => e.sub === "sessionError");
  assert.ok(err, "a sessionError frame was emitted");
  assert.equal(err.payload.name, "ProviderAuthError");
  assert.equal(err.payload.message, "Bad key");
  const done = events.find((e) => e.sub === "turnComplete");
  assert.ok(done, "a turnComplete frame was emitted so the spinner stops");
  assert.equal(done.payload.complete, true);
  assert.equal(done.payload.running, false);
});

test("session.error with a MessageAbortedError name emits NOTHING", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.error",
    properties: {
      sessionID: SID,
      error: { name: "MessageAbortedError", message: "aborted" },
    },
  });
  assert.equal(events.length, 0, "an abort is not a failure — no frames emitted");
});

test("session.status retry reports running true and carries type retry (parity with pre-S1b renderer)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, type: "retry" },
  });
  const ev = events.find((e) => e.sub === "running");
  assert.ok(ev);
  assert.equal(ev.payload.running, true);
  // BET-758: the retry-ness must reach the device so iOS can render a retry
  // banner; `running` stays the single source of truth, `type` is additive.
  assert.equal(ev.payload.type, "retry");
});

// ---------------------------------------------------------------------------
// Real-wire regression tests.
//
// The shapes above were written from the spec, not from a live box, and the
// box actually sends something different for the two events that matter most:
// the status is nested and a delta is flat. Every one of these passed while
// the phone showed no running indicator and no streaming text at all, so
// these cases pin the shapes captured off a running box.
// ---------------------------------------------------------------------------

test("session.status reports running from the NESTED status.type the box sends", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  const ev = events.find((e) => e.sub === "running");
  assert.ok(ev);
  assert.equal(ev.payload.running, true);
  // BET-758: the nested busy type is forwarded additively.
  assert.equal(ev.payload.type, "busy");
});

test("message.part.delta flushes from the FLAT delta the box sends", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "Rain falls" },
  });
  assert.equal(events.length, 0, "no boundary yet");
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: ".\n\nThen it stops" },
  });
  const fl = events.find((e) => e.sub === "flush");
  assert.ok(fl);
  // BET-649: the sentence end is the boundary, so the cut lands after
  // "Rain falls.\n" and the remaining newline rides with the next chunk. The
  // assembled text is unchanged — only the split moved earlier.
  assert.equal(fl.payload.text, "Rain falls.\n");
  assert.equal(fl.payload.partID, "p1");
  assert.equal(fl.payload.field, "text");
});

test("message.part.updated flushes the buffered tail of a short answer", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "Hello" },
  });
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "text", text: "Hello", messageID: "msg1" } },
  });
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 1, "the tail is flushed exactly once");
  assert.equal(flushes[0].payload.text, "Hello");
});

test("message.updated records the message from properties.info (no wrapper)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.updated",
    properties: {
      sessionID: SID,
      info: { id: "msg1", role: "assistant", sessionID: SID, time: { created: 1 } },
    },
  });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.complete, false, "an assistant turn with no completion time is not complete");
});

test("the same event delivered twice is interpreted once", () => {
  const { interp, events } = make();
  const ev = {
    id: "evt_1",
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  };
  interp.interpret(ev);
  interp.interpret(ev); // global + per-directory stream deliver the same event
  assert.equal(events.filter((e) => e.sub === "running").length, 1);
});

test("interpret ignores events with no session id", () => {
  const { interp, events } = make();
  interp.interpret({ type: "message.part.delta", properties: { part: { id: "x" } } });
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Live tool-output frames (server half, BET-745).
//
// A tool part flows through `message.part.updated` with `part.type === "tool"`.
// The running tool's stdout is in `state.metadata.output`; the authoritative
// final output reads from `state.output` at completion.
// ---------------------------------------------------------------------------

// Build a tool `message.part.updated` payload in the shape opencode sends.
function toolPartUpdated({ id, tool = "bash", status, title, metaOutput, output, callID, messageID = "msg1" }) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      messageID,
      part: {
        id,
        type: "tool",
        tool,
        ...(callID !== undefined ? { callID } : {}),
        state: {
          status,
          ...(title !== undefined ? { title } : {}),
          ...(metaOutput !== undefined ? { metadata: { output: metaOutput } } : {}),
          ...(output !== undefined ? { output } : {}),
        },
      },
    },
  };
}

test("toolStarted is emitted once when a tool part first appears", () => {
  const { interp, events } = make();
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", title: "Run: npm test", metaOutput: "" }));
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "" }));
  const started = events.filter((e) => e.sub === "toolStarted");
  assert.equal(started.length, 1, "re-emit for the same idx emits toolStarted exactly once");
  assert.equal(started[0].payload.sessionId, SID);
  assert.equal(started[0].payload.idx, "t1");
  // callID falls back to the part id when opencode gave none, so the live row
  // always shares the canonical step row's identity.
  assert.equal(started[0].payload.callID, "t1");
  assert.equal(started[0].payload.toolName, "bash");
  assert.equal(started[0].payload.toolPresentationHint, "Run: npm test");
  assert.equal(started[0].payload.status, "running");
});

test("toolStarted carries the tool's callID when opencode provides one", () => {
  const { interp, events } = make();
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", callID: "toolu_123" }));
  const started = events.filter((e) => e.sub === "toolStarted");
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.idx, "t1");
  assert.equal(started[0].payload.callID, "toolu_123");
});

test("toolOutput carries only the delta since the last chunk, never the full output", () => {
  const { interp, events } = make();
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "line1\n" }));
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "line1\nline2\n" }));
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "line1\nline2\nline3\n" }));
  const chunks = events.filter((e) => e.sub === "toolOutput").map((e) => e.payload.text);
  assert.deepEqual(chunks, ["line1\n", "line2\n", "line3\n"]);
  // every chunk is keyed by the same stable tool idx
  assert.ok(events.filter((e) => e.sub === "toolOutput").every((e) => e.payload.idx === "t1"));
});

test("re-emitting the same output does not double-append", () => {
  const { interp, events } = make();
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "abc" }));
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "abc" }));
  const chunks = events.filter((e) => e.sub === "toolOutput").map((e) => e.payload.text);
  assert.deepEqual(chunks, ["abc"], "no byte is sent twice for the same tool");
  assert.equal(events.filter((e) => e.sub === "toolStarted").length, 1);
});

test("toolEnded inverts ok on failure and flags truncation on cap", () => {
  const { interp, events } = make();
  // success: completed -> ok true
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "ok" }));
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "completed", output: "ok" }));
  const ends1 = events.filter((e) => e.sub === "toolEnded" && e.payload.idx === "t1");
  assert.equal(ends1.length, 1, "toolEnded fires exactly once");
  assert.equal(ends1[0].payload.ok, true);
  assert.equal(ends1[0].payload.truncated, undefined);

  // failure: error -> ok false
  interp.interpret(toolPartUpdated({ id: "t2", tool: "bash", status: "error", output: "boom" }));
  const ends2 = events.filter((e) => e.sub === "toolEnded" && e.payload.idx === "t2");
  assert.equal(ends2.length, 1);
  assert.equal(ends2[0].payload.ok, false);

  // cap: an over-limit bash is truncated once, then no further output
  const { interp: i2, events: ev2 } = make();
  const huge = "x".repeat(50_000);
  i2.interpret(toolPartUpdated({ id: "t3", tool: "bash", status: "running", metaOutput: huge }));
  const outs = ev2.filter((e) => e.sub === "toolOutput");
  assert.equal(outs.length, 1);
  assert.ok(outs[0].payload.text.endsWith("… [output truncated]"), "a truncation marker rides the last chunk");
  i2.interpret(toolPartUpdated({ id: "t3", tool: "bash", status: "running", metaOutput: huge + "extra" }));
  assert.equal(ev2.filter((e) => e.sub === "toolOutput").length, 1, "output is suppressed once capped");
  i2.interpret(toolPartUpdated({ id: "t3", tool: "bash", status: "completed", output: huge + "extra" }));
  const ends3 = ev2.filter((e) => e.sub === "toolEnded");
  assert.equal(ends3.length, 1);
  assert.equal(ends3[0].payload.truncated, true);
});

test("live tool frames are additive — running/truncation/sessionError still fire on their triggers", () => {
  const { interp, events } = make();
  // regression pins: the pre-existing frames are untouched by the new branch
  interp.interpret({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  assert.equal(events.filter((e) => e.sub === "running").length, 1);
  interp.interpret({ type: "session.next.step.ended", properties: { sessionID: SID, finish: "max_tokens", lastPartIsToolUse: true } });
  assert.equal(events.filter((e) => e.sub === "truncation").length, 1);
  interp.interpret({ type: "session.error", properties: { sessionID: SID, error: { name: "ApiError", message: "boom" } } });
  assert.equal(events.filter((e) => e.sub === "sessionError").length, 1);
  assert.equal(events.filter((e) => e.sub === "turnComplete").length, 1);
  // and a tool flow still flows through the same stream
  interp.interpret(toolPartUpdated({ id: "t1", tool: "bash", status: "running", metaOutput: "hi" }));
  assert.equal(events.filter((e) => e.sub === "toolStarted").length, 1);
  assert.equal(events.filter((e) => e.sub === "toolOutput").length, 1);
});
