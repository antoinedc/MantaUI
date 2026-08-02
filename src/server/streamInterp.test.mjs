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

test("message.part.delta emits a flush at a paragraph boundary and keeps the remainder", () => {
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
  assert.equal(fl.payload.text, "Hello world.\n\n");
  assert.equal(fl.payload.messageID, "msg1");
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

test("session.idle emits turnComplete true", () => {
  const { interp, events } = make();
  interp.interpret({ type: "session.idle", properties: { sessionID: SID } });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.complete, true);
});

test("interpret ignores events with no session id", () => {
  const { interp, events } = make();
  interp.interpret({ type: "message.part.delta", properties: { part: { id: "x" } } });
  assert.equal(events.length, 0);
});
