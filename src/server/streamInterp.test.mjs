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

// BET-896: the box stamps the idle->busy edge so the phone can count from the
// real turn start instead of when the phone noticed. `since` is epoch ms or
// null, and is never restarted by a mid-turn re-emit.

test("session.status busy emits a running frame with a non-null since", () => {
  const { interp, events } = make(42_000);
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  const ev = events.find((e) => e.sub === "running");
  assert.ok(ev);
  assert.equal(ev.payload.running, true);
  assert.equal(ev.payload.since, 42_000, "stamped from the injectable now()");
});

test("snapshotState always emits exactly one runningSet frame, even with nothing running (BET-922)", () => {
  const { interp } = make(42_000);
  // Nothing busy yet -> the set must STILL be exactly one frame, because an
  // empty list is the correction a stale client needs (the old shape returned
  // nothing and could never clear a latched `running:true`).
  const empty = interp.snapshotState();
  assert.equal(empty.length, 1);
  assert.equal(empty[0].kind, "runningSet");
  assert.deepEqual(empty[0].payload.sessions, [], "nothing running = an empty, authoritative set");
});

test("snapshotState lists a busy session in the runningSet with its original since (BET-922)", () => {
  const { interp } = make(42_000);
  // Start a turn; the replay carries the frame the busy->idle edge never
  // re-emits, with the ORIGINAL since so the timer survives a fresh process.
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  const snap = interp.snapshotState();
  assert.equal(snap.length, 1, "only the runningSet when nothing else is pending");
  assert.equal(snap[0].kind, "runningSet");
  assert.equal(snap[0].payload.sessions.length, 1);
  assert.equal(snap[0].payload.sessions[0].sessionId, SID);
  assert.equal(snap[0].payload.sessions[0].since, 42_000, "original idle->busy stamp, not reconnect time");
  assert.equal(snap[0].payload.sessions[0].type, "busy", "last status type preserved additively");
  // An idle session drops out of the set entirely — absent == not running.
  interp.interpret({ type: "session.idle", properties: { sessionID: SID } });
  const afterIdle = interp.snapshotState();
  assert.equal(afterIdle.length, 1);
  assert.equal(afterIdle[0].kind, "runningSet");
  assert.deepEqual(afterIdle[0].payload.sessions, [], "a session that went idle drops out of the set");
});

test("snapshotState ignores sessions that were never marked running", () => {
  const { interp } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "m", part: { id: "p", type: "text", text: "hi" } },
  });
  const snap = interp.snapshotState();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].kind, "runningSet");
  assert.deepEqual(snap[0].payload.sessions, []);
});

// BET-916 — sibling of BET-913: pending questions/permissions are edge-only too
// (`question.*` / `permission.*` frames fire only as events arrive), so a fresh
// /events subscription would drop the still-pending interactive card. The
// snapshot replays them regardless of `running` — a pending question/blocks a
// turn without ever setting `running`, so gating on `running` would skip them.

test("snapshotState replays a pending questions frame independent of running (BET-916)", () => {
  const { interp } = make();
  interp.interpret({
    type: "question.asked",
    properties: {
      sessionID: SID,
      id: "que_1",
      tool: { messageID: "m", callID: "call_1" },
      questions: [{ text: "Option one?" }],
    },
  });
  // The live path never set `running` for this session — the snapshot must
  // still replay the question, or a reconnecting client is blocked but
  // unanswerable on the box.
  assert.equal(interp.getState(SID).running, false, "question doesn't set running");
  const snap = interp.snapshotState();
  const q = snap.find((e) => e.sub === "questions");
  assert.ok(q, "a questions frame is replayed");
  assert.equal(q.kind, "stream");
  assert.equal(q.sessionId, SID);
  assert.equal(q.payload.questions.length, 1);
  assert.equal(q.payload.questions[0].id, "call_1", "real request id survives for answering");
});

test("snapshotState replays a pending permissions frame independent of running (BET-916)", () => {
  const { interp } = make();
  interp.interpret({
    type: "permission.asked",
    properties: { sessionID: SID, id: "perm_1", prompt: "Allow reading ~/secrets.json?" },
  });
  assert.equal(interp.getState(SID).running, false, "permission doesn't set running");
  const snap = interp.snapshotState();
  const p = snap.find((e) => e.sub === "permissions");
  assert.ok(p, "a permissions frame is replayed");
  assert.equal(p.kind, "stream");
  assert.equal(p.sessionId, SID);
  assert.equal(p.payload.permissions.length, 1);
  assert.equal(p.payload.permissions[0].id, "perm_1", "real request id survives for answering");
});

test("snapshotState does not replay resolved/empty questions or permissions", () => {
  const { interp } = make();
  interp.interpret({
    type: "question.asked",
    properties: {
      sessionID: SID,
      id: "que_1",
      tool: { messageID: "m", callID: "call_1" },
      questions: [{ text: "?" }],
    },
  });
  interp.interpret({
    type: "question.replied",
    properties: { sessionID: SID, id: "que_1" },
  });
  assert.equal(interp.getState(SID).questions.length, 0);
  const snap = interp.snapshotState();
  assert.equal(snap.length, 1, "only the always-present runningSet remains");
  assert.equal(snap[0].kind, "runningSet");
  assert.equal(snap.filter((e) => e.sub === "questions").length, 0, "no questions frame pending");
  assert.equal(snap.filter((e) => e.sub === "permissions").length, 0, "no permissions frame pending");
});

test("snapshotState replays running + questions + permissions together, each with its own frame", () => {
  const { interp } = make(42_000);
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  interp.interpret({
    type: "question.asked",
    properties: {
      sessionID: SID,
      id: "que_1",
      tool: { messageID: "m", callID: "call_1" },
      questions: [{ text: "?" }],
    },
  });
  interp.interpret({
    type: "permission.asked",
    properties: { sessionID: SID, id: "perm_1", prompt: "p" },
  });
  const snap = interp.snapshotState();
  assert.equal(snap[0].kind, "runningSet", "running is one authoritative frame, not one per session");
  assert.equal(snap[0].payload.sessions.length, 1);
  assert.equal(snap[0].payload.sessions[0].sessionId, SID);
  const subs = snap.slice(1).map((e) => e.sub).sort();
  // One `attention` frame too (question wins over permission), so a reconnecting
  // sidebar shows the badge.
  assert.deepEqual(subs, ["attention", "permissions", "questions"]);
  assert.deepEqual(snap.find((e) => e.sub === "attention").payload, { kind: "question" });
});

test("snapshotState replays attention only for sessions with a pending ask; permission-only → permission", () => {
  const { interp } = make(42_000);
  interp.interpret({ type: "permission.asked", properties: { sessionID: "ses_perm", id: "perm_1", prompt: "p" } });
  interp.interpret({ type: "session.status", properties: { sessionID: "ses_quiet", status: { type: "busy" } } });
  const att = interp.snapshotState().filter((e) => e.sub === "attention");
  assert.deepEqual(att.map((e) => [e.sessionId, e.payload.kind]), [["ses_perm", "permission"]]);
  interp.interpret({ type: "permission.replied", properties: { sessionID: "ses_perm", requestID: "perm_1", id: "perm_1" } });
  assert.equal(interp.snapshotState().filter((e) => e.sub === "attention").length, 0);
});

test("a second busy while already running emits the SAME since (clock not restarted)", () => {
  let clock = 100_000;
  const events = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    now: () => clock,
  });
  const busy = () =>
    interp.interpret({
      type: "session.status",
      properties: { sessionID: SID, status: { type: "busy" } },
    });
  busy();
  clock = 300_000; // the turn "has been running" for 200s by the second status
  busy();
  const frames = events.filter((e) => e.sub === "running");
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.since, 100_000);
  assert.equal(frames[1].payload.since, 100_000, "edge stamp survives a re-emit");
});

test("session.idle emits turnComplete with running:false and since:null", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  interp.interpret({ type: "session.idle", properties: { sessionID: SID } });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.complete, true);
  assert.equal(ev.payload.running, false);
  assert.equal(ev.payload.since, null, "the stamp is cleared when the turn stops");
});

test("session.error (non-abort) emits turnComplete with since:null", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.error",
    properties: {
      sessionID: SID,
      error: { name: "ApiError", message: "boom" },
    },
  });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.running, false);
  assert.equal(ev.payload.since, null);
});

test("a message.updated mid-turn emits turnComplete with running:true and the original since", () => {
  const { interp, events } = make(77_000);
  interp.interpret({
    type: "session.status",
    properties: { sessionID: SID, status: { type: "busy" } },
  });
  // An assistant message with no completion time is mid-turn (complete:false).
  interp.interpret({
    type: "message.updated",
    properties: {
      sessionID: SID,
      info: { id: "msg1", role: "assistant", sessionID: SID, time: { created: 1 } },
    },
  });
  const ev = events.find((e) => e.sub === "turnComplete");
  assert.ok(ev);
  assert.equal(ev.payload.complete, false);
  assert.equal(ev.payload.running, true, "still running mid-turn");
  assert.equal(ev.payload.since, 77_000, "original edge stamp still attached");
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

// BET-1209: a reasoning part's content streams in a field literally named
// `text`, byte-identical to a prose delta. The interpreter must classify it as
// `reasoning` from the part's `type` snapshot so a thin client (iOS) can keep
// it out of the conversation. opencode emits `message.part.updated` (type
// known) BEFORE it starts streaming the deltas.
test("reasoning deltas stream as reasoning, never as text (BET-1209)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "reasoning" } },
  });
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "Let me think step by step.\n\n" },
  });
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 1, "the reasoning delta flushed at the boundary");
  assert.ok(
    flushes.every((f) => f.payload.field !== "text"),
    "no reasoning content leaks to the device as ordinary prose",
  );
  assert.equal(flushes[0].payload.field, "reasoning");
});

test("text deltas still flush as text (BET-1209)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "text" } },
  });
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "Regular prose.\n\n" },
  });
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].payload.field, "text");
});

test("a delta whose part id was never announced is classified text (BET-1209)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "ghost", field: "text", delta: "Unknown part prose.\n\n" },
  });
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].payload.field, "text");
});

test("a reasoning part that finalizes with buffered text emits no flush (BET-1209)", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "reasoning" } },
  });
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "end of thinking, no boundary" },
  });
  assert.equal(events.length, 0, "no boundary yet -> nothing flushed");
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "reasoning", text: "end of thinking, no boundary" } },
  });
  const flushes = events.filter((e) => e.sub === "flush");
  assert.equal(flushes.length, 0, "the reasoning tail is dropped, never flushed as prose");
});

test("partTypes does not retain entries for finalized parts (BET-1209)", () => {
  const { interp } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "reasoning" } },
  });
  interp.interpret({
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: "msg1", partID: "p1", field: "text", delta: "x" },
  });
  interp.interpret({
    type: "message.part.updated",
    properties: { sessionID: SID, part: { id: "p1", type: "reasoning", text: "x" } },
  });
  const st = interp.getState(SID);
  assert.equal(st.partTypes.has("p1"), false, "finalized part released from partTypes");
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

// Context/cache reading from message.updated (BET-887). The
// `session.next.step.ended` event that used to be the only source of these
// frames never fires on the deployed opencode build, so the interpreter reads
// the live token breakdown off assistant `message.updated` events instead.
// All tests inject a stub `contextLimitFor` (never a live box).
const ASSISTANT_MSG = {
  id: "msg_000209d3a001K1l3sjt4jY58Sa",
  role: "assistant",
  sessionID: "ses_fffe287c0ffeShSHRqaJKxqpNn",
  providerID: "anthropic",
  modelID: "claude-opus-5",
  tokens: {
    total: 185763,
    input: 2,
    output: 2054,
    reasoning: 0,
    cache: { write: 1516, read: 182191 },
  },
  cost: 0.1519305,
};

function updatedWith(info) {
  return { type: "message.updated", properties: { sessionID: SID, info } };
}

function makeCtx(contextLimitFor) {
  const events = [];
  const interp = createStreamInterpreter({
    publish: (e) => events.push(e),
    contextLimitFor,
  });
  return { interp, events };
}

test("message.updated with assistant tokens emits a context frame", () => {
  const { interp, events } = makeCtx(() => 1_000_000);
  interp.interpret(updatedWith(ASSISTANT_MSG));
  const ctx = events.filter((e) => e.sub === "context");
  assert.equal(ctx.length, 1);
  // (2 + 182191 + 1516) / 1_000_000 -> 18.37 -> 18
  assert.equal(ctx[0].payload.pct, 18);
});

test("the context denominator comes from the resolver", () => {
  const calls = [];
  const { interp, events } = makeCtx((providerID, modelID) => {
    calls.push([providerID, modelID]);
    return 200_000;
  });
  interp.interpret(updatedWith(ASSISTANT_MSG));
  const ctx = events.filter((e) => e.sub === "context");
  assert.equal(ctx.length, 1);
  // (2 + 182191 + 1516) / 200_000 -> 91.85 -> 92
  assert.equal(ctx[0].payload.pct, 92);
  assert.deepEqual(calls, [["anthropic", "claude-opus-5"]]);
});

test("a resolver miss passes the unknown limit straight through (no fake window)", () => {
  const { interp, events } = makeCtx(() => null);
  interp.interpret(updatedWith(ASSISTANT_MSG));
  const ctx = events.filter((e) => e.sub === "context");
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].payload.hasLimit, false);
  assert.equal(ctx[0].payload.pct, null);
});

test("repeated message.updated events are deduped per session", () => {
  const { interp, events } = makeCtx(() => 1_000_000);
  interp.interpret(updatedWith(ASSISTANT_MSG));
  interp.interpret(updatedWith(ASSISTANT_MSG));
  interp.interpret(updatedWith(ASSISTANT_MSG));
  assert.equal(events.filter((e) => e.sub === "context").length, 1);
  assert.equal(events.filter((e) => e.sub === "cache").length, 1);
  // a changed input total is a different reading -> a second frame
  interp.interpret(updatedWith({ ...ASSISTANT_MSG, tokens: { ...ASSISTANT_MSG.tokens, input: 20 } }));
  assert.equal(events.filter((e) => e.sub === "context").length, 2);
});

test("no context frame for a user message, a token-less message, or an all-zero token set", () => {
  const { interp, events } = makeCtx(() => 1_000_000);
  // user role -> nothing
  interp.interpret(updatedWith({ ...ASSISTANT_MSG, role: "user" }));
  // assistant but no tokens -> nothing
  interp.interpret(updatedWith({ ...ASSISTANT_MSG, tokens: undefined }));
  // assistant but all-zero input buckets -> nothing (fabricated-0% guard)
  interp.interpret(
    updatedWith({ ...ASSISTANT_MSG, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } }),
  );
  assert.equal(events.filter((e) => e.sub === "context").length, 0);
});

test("the same event also emits a cache frame", () => {
  const { interp, events } = makeCtx(() => 1_000_000);
  interp.interpret(updatedWith(ASSISTANT_MSG));
  assert.equal(events.filter((e) => e.sub === "cache").length, 1);
});

test("cache staleness predicts against the configured TTL, falling back to 5m", async () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // opencode configured to send 1h -> the device pill uses 1h (matches the
  // desktop SessionHeader pill) rather than always assuming opencode's 5m
  // default.
  const oneHour = [];
  const interp1h = createStreamInterpreter({
    publish: (e) => oneHour.push(e),
    readCacheTtl: async () => "1h",
  });
  await flush(); // let the background TTL resolution land
  interp1h.interpret(updatedWith(ASSISTANT_MSG));
  const cache1h = oneHour.find((e) => e.sub === "cache");
  assert.ok(cache1h, "a cache frame was emitted");
  assert.equal(cache1h.payload.ttlMs, 3_600_000);

  // no readCacheTtl / nothing readable -> 5m default fallback preserved
  const fiveMin = [];
  const interp5m = createStreamInterpreter({
    publish: (e) => fiveMin.push(e),
    readCacheTtl: async () => null,
  });
  await flush();
  interp5m.interpret(updatedWith(ASSISTANT_MSG));
  const cache5m = fiveMin.find((e) => e.sub === "cache");
  assert.ok(cache5m, "a cache frame was emitted");
  assert.equal(cache5m.payload.ttlMs, 5 * 60_000);
});

test("a completed plan_exit tool part emits one planMode {on:false} frame", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      part: { id: "p1", type: "tool", tool: "plan_exit", callID: "toolu_exit", state: { status: "completed" } },
    },
  });
  const pm = events.filter((e) => e.sub === "planMode");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].payload.on, false);
});

test("a completed plan_enter tool part emits one planMode {on:true} frame", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      part: { id: "p1", type: "tool", tool: "plan_enter", callID: "toolu_enter", state: { status: "completed" } },
    },
  });
  const pm = events.filter((e) => e.sub === "planMode");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].payload.on, true);
});

test("an errored plan_exit tool part emits NOTHING", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      part: { id: "p1", type: "tool", tool: "plan_exit", callID: "toolu_exit", state: { status: "error" } },
    },
  });
  assert.equal(events.filter((e) => e.sub === "planMode").length, 0);
});

test("the same planMode callID arriving twice emits once", () => {
  const { interp, events } = make();
  const upd = {
    type: "message.part.updated",
    properties: {
      sessionID: SID,
      part: { id: "p1", type: "tool", tool: "plan_exit", callID: "toolu_exit", state: { status: "completed" } },
    },
  };
  interp.interpret(upd);
  interp.interpret(upd);
  assert.equal(events.filter((e) => e.sub === "planMode").length, 1);
});

test("session.next.agent.switched to plan emits planMode {on:true}", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.next.agent.switched",
    properties: { sessionID: SID, agent: "plan" },
  });
  const pm = events.filter((e) => e.sub === "planMode");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].payload.on, true);
});

test("session.next.agent.switched away from plan emits planMode {on:false}", () => {
  const { interp, events } = make();
  interp.interpret({
    type: "session.next.agent.switched",
    properties: { sessionID: SID, agent: "build" },
  });
  const pm = events.filter((e) => e.sub === "planMode");
  assert.equal(pm.length, 1);
  assert.equal(pm[0].payload.on, false);
});

// ───────────────────────── Slice A: complete frame vocabulary ─────────────────────────
// (OpenCode V2 migration, phase 1.) Payload shapes are pinned by
// docs/superpowers/specs/2026-10-16-opencode-v2-phase1-frames-phase3-plugins.md.

// Interpreter with a controllable clock + timer queue (the messageChanged
// trailing edge is the only timer the interpreter owns).
function makeTimed() {
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
  });
  const advance = (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      clock = due.at;
      due.fn();
    }
    clock = until;
  };
  return { interp, events, advance, pending: () => timers.filter((t) => !t.dead).length };
}
const subs = (events, sub) => events.filter((e) => e.sub === sub);

test("retry: session.status retry publishes the banner payload; busy/idle clears it with null", () => {
  const { interp, events } = make();
  interp.interpret({
    id: "e1",
    type: "session.status",
    properties: {
      sessionID: SID,
      status: {
        type: "retry",
        attempt: 2,
        message: "Rate limited",
        next: 1234,
        action: { title: "T", message: "M", label: "L", link: "https://example.invalid" },
      },
    },
  });
  assert.deepEqual(subs(events, "retry")[0].payload, {
    attempt: 2,
    message: "Rate limited",
    next: 1234,
    action: { title: "T", message: "M", label: "L", link: "https://example.invalid" },
  });
  // running still treats retry as a live turn, unchanged.
  assert.equal(subs(events, "running")[0].payload.running, true);
  interp.interpret({ id: "e2", type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  assert.equal(subs(events, "retry").length, 2);
  assert.equal(subs(events, "retry")[1].payload, null);
  // A plain busy with no retry outstanding does not spam null.
  interp.interpret({ id: "e3", type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
  assert.equal(subs(events, "retry").length, 2);
});

test("retry: optional fields are omitted when the event lacks them; idle also clears", () => {
  const { interp, events } = make();
  interp.interpret({ id: "e1", type: "session.status", properties: { sessionID: SID, status: { type: "retry", attempt: 1, message: "x" } } });
  assert.deepEqual(subs(events, "retry")[0].payload, { attempt: 1, message: "x" });
  interp.interpret({ id: "e2", type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } });
  assert.equal(subs(events, "retry")[1].payload, null);
});

test("stepEnded: carries messageID, normalised tokens, cost and finish", () => {
  const { interp, events } = make();
  interp.interpret({
    id: "e1",
    type: "session.next.step.ended",
    properties: {
      sessionID: SID,
      messageID: "msg_9",
      usage: { input: 10, output: 20, reasoning: 3, cache: { read: 100, write: 5 } },
      cost: 0.5,
      finish: "tool-calls",
    },
  });
  assert.deepEqual(subs(events, "stepEnded")[0].payload, {
    messageID: "msg_9",
    tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 100, write: 5 } },
    cost: 0.5,
    finish: "tool-calls",
  });
  // No usage -> still a boundary, zeros; no cost/finish keys.
  interp.interpret({ id: "e2", type: "session.next.step.ended", properties: { sessionID: SID, messageID: "msg_9" } });
  assert.deepEqual(subs(events, "stepEnded")[1].payload, {
    messageID: "msg_9",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
});

test("toolBoundary: once per tool part at a terminal status, with callID fallback", () => {
  const { interp, events } = make();
  const part = (status, extra = {}) => ({
    type: "tool",
    id: "prt_1",
    messageID: "msg_1",
    callID: "call_1",
    tool: "bash",
    state: { status },
    ...extra,
  });
  interp.interpret({ id: "e1", type: "message.part.updated", properties: { sessionID: SID, part: part("running") } });
  assert.equal(subs(events, "toolBoundary").length, 0);
  interp.interpret({ id: "e2", type: "message.part.updated", properties: { sessionID: SID, part: part("completed") } });
  interp.interpret({ id: "e3", type: "message.part.updated", properties: { sessionID: SID, part: part("completed") } }); // re-emit, new event id
  assert.deepEqual(subs(events, "toolBoundary").map((e) => e.payload), [
    { messageID: "msg_1", partID: "prt_1", callID: "call_1", tool: "bash", status: "completed" },
  ]);
  interp.interpret({
    id: "e4",
    type: "message.part.updated",
    properties: { sessionID: SID, part: part("error", { id: "prt_2", callID: undefined }) },
  });
  const b2 = subs(events, "toolBoundary")[1].payload;
  assert.equal(b2.status, "error");
  assert.equal(b2.callID, "prt_2"); // falls back to the part id
});

test("compaction: started / delta / ended; legacy raw events carry reason + delta", () => {
  const { interp, events } = make();
  interp.interpret({ id: "e1", type: "session.next.compaction.started", properties: { sessionID: SID, reason: "context", text: "" } });
  interp.interpret({ id: "e2", type: "session.next.compaction.delta", properties: { sessionID: SID, delta: "abc" } });
  interp.interpret({ id: "e3", type: "session.next.compaction.ended", properties: { sessionID: SID } });
  assert.deepEqual(subs(events, "compaction").map((e) => e.payload), [
    { phase: "started", text: "", reason: "context" },
    { phase: "delta", text: "abc" },
    { phase: "ended" },
  ]);
});

test("transcriptStale: session.compacted -> {}", () => {
  const { interp, events } = make();
  interp.interpret({ id: "e1", type: "session.compacted", properties: { sessionID: SID } });
  assert.deepEqual(subs(events, "transcriptStale"), [
    { kind: "stream", sub: "transcriptStale", sessionId: SID, payload: {} },
  ]);
});

test("commandExecuted: messageID, name, arguments as strings", () => {
  const { interp, events } = make();
  interp.interpret({
    id: "e1",
    type: "command.executed",
    properties: { sessionID: SID, name: "review", arguments: "src/", messageID: "msg_c" },
  });
  assert.deepEqual(subs(events, "commandExecuted")[0].payload, { messageID: "msg_c", name: "review", arguments: "src/" });
});

test("childSession: published under the PARENT session id (the child's own id is properties.sessionID)", () => {
  const { interp, events } = make();
  interp.interpret({
    id: "e1",
    type: "session.created",
    properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: SID } },
  });
  const f = subs(events, "childSession");
  assert.equal(f.length, 1);
  assert.equal(f[0].sessionId, SID);
  assert.deepEqual(f[0].payload, { childSessionId: "ses_child", parentSessionId: SID });
  // A top-level session (no parentID) announces nothing.
  interp.interpret({ id: "e2", type: "session.created", properties: { sessionID: "ses_top", info: { id: "ses_top" } } });
  assert.equal(subs(events, "childSession").length, 1);
});

test("attention: question wins over permission; null only when nothing is pending", () => {
  const { interp, events } = make();
  const att = () => subs(events, "attention").map((e) => e.payload.kind);
  interp.interpret({ id: "p1", type: "permission.asked", properties: { sessionID: SID, id: "per_1" } });
  assert.deepEqual(att(), ["permission"]);
  interp.interpret({
    id: "q1",
    type: "question.asked",
    properties: { sessionID: SID, id: "que_1", tool: { callID: "call_q" }, questions: [{ question: "?" }] },
  });
  assert.deepEqual(att(), ["permission", "question"]);
  // Answering the question leaves the permission pending -> back to "permission".
  interp.interpret({ id: "q2", type: "question.replied", properties: { sessionID: SID, requestID: "que_1" } });
  assert.deepEqual(att(), ["permission", "question", "permission"]);
  // V1's permission.replied carries requestID (no id) — must still clear it.
  interp.interpret({ id: "p2", type: "permission.replied", properties: { sessionID: SID, requestID: "per_1", reply: "once" } });
  assert.deepEqual(att(), ["permission", "question", "permission", null]);
  // The existing questions/permissions frames are unchanged and stay last per event.
  assert.equal(events[events.length - 1].sub, "permissions");
  assert.equal(events[events.length - 1].payload.permissions.length, 0);
});

test("messageChanged: resolves messageID from properties.info.id, part.messageID and properties.messageID", () => {
  const { interp, events } = makeTimed();
  interp.interpret({ id: "e1", type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a", role: "user" } } });
  interp.interpret({ id: "e2", type: "message.part.updated", properties: { sessionID: SID, part: { id: "p", type: "text", messageID: "msg_b" } } });
  interp.interpret({ id: "e3", type: "message.part.removed", properties: { sessionID: SID, messageID: "msg_c", partID: "p" } });
  interp.interpret({ id: "e4", type: "message.removed", properties: { sessionID: SID, messageID: "msg_d" } });
  assert.deepEqual(subs(events, "messageChanged").map((e) => e.payload.messageID), ["msg_a", "msg_b", "msg_c", "msg_d"]);
  // An event with no resolvable message id announces nothing.
  interp.interpret({ id: "e5", type: "message.part.updated", properties: { sessionID: SID, part: { id: "p", type: "text" } } });
  assert.equal(subs(events, "messageChanged").length, 4);
});

test("messageChanged: coalesces to one frame per message per 100 ms, trailing edge guaranteed", () => {
  const { interp, events, advance, pending } = makeTimed();
  const touch = (id, mid = "msg_1") =>
    interp.interpret({ id, type: "message.part.updated", properties: { sessionID: SID, part: { id: "p", type: "text", messageID: mid } } });
  touch("a"); // leading edge: immediate
  assert.equal(subs(events, "messageChanged").length, 1);
  advance(30); touch("b");
  advance(30); touch("c");
  advance(30); touch("d");
  assert.equal(subs(events, "messageChanged").length, 1, "inside the window: nothing yet");
  assert.equal(pending(), 1, "exactly one trailing timer");
  advance(15); // t = 105 -> window closed, trailing fires
  assert.equal(subs(events, "messageChanged").length, 2);
  // A different message is independent.
  touch("e", "msg_2");
  assert.equal(subs(events, "messageChanged").length, 3);
  // After the window a new change is a fresh leading edge.
  advance(200); touch("f");
  assert.equal(subs(events, "messageChanged").length, 4);
  assert.equal(pending(), 0);
});

test("messageChanged: flushPending fires an outstanding trailing frame; dispose drops timers", () => {
  const { interp, events, pending } = makeTimed();
  const touch = (id) =>
    interp.interpret({ id, type: "message.updated", properties: { sessionID: SID, info: { id: "msg_1", role: "user" } } });
  touch("a");
  touch("b"); // inside the window
  assert.equal(pending(), 1);
  interp.flushPending();
  assert.equal(subs(events, "messageChanged").length, 2);
  assert.equal(pending(), 0);
  touch("c");
  touch("d");
  interp.dispose();
  assert.equal(pending(), 0);
});

test("new frames go through the event-id de-dup (global + scoped double delivery)", () => {
  const { interp, events } = make();
  const evts = [
    { id: "d1", type: "command.executed", properties: { sessionID: SID, name: "n", arguments: "", messageID: "m" } },
    { id: "d2", type: "session.compacted", properties: { sessionID: SID } },
    { id: "d3", type: "session.next.compaction.ended", properties: { sessionID: SID } },
    { id: "d4", type: "session.created", properties: { sessionID: "ses_c", info: { id: "ses_c", parentID: SID } } },
    { id: "d5", type: "session.status", properties: { sessionID: SID, status: { type: "retry", attempt: 1, message: "m" } } },
  ];
  for (const e of evts) { interp.interpret(e); interp.interpret(e); }
  for (const sub of ["commandExecuted", "transcriptStale", "compaction", "childSession", "retry"]) {
    assert.equal(subs(events, sub).length, 1, sub);
  }
});

test("sessionError carries the raw error name unchanged; MessageAbortedError stays silent", () => {
  const { interp, events } = make();
  interp.interpret({ id: "e1", type: "session.error", properties: { sessionID: SID, error: { name: "ProviderAuthError", data: { message: "bad key" } } } });
  assert.equal(subs(events, "sessionError")[0].payload.name, "ProviderAuthError");
  interp.interpret({ id: "e2", type: "session.error", properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
  assert.equal(subs(events, "sessionError").length, 1);
});

test("message.* events that nest the session id (info/part) are still interpreted", () => {
  const { interp, events } = make();
  interp.interpret({ id: "n1", type: "message.updated", properties: { info: { id: "msg_n", sessionID: SID, role: "user" } } });
  interp.interpret({ id: "n2", type: "message.part.updated", properties: { part: { id: "p", type: "text", messageID: "msg_n2", sessionID: SID } } });
  assert.deepEqual(subs(events, "messageChanged").map((e) => [e.sessionId, e.payload.messageID]), [[SID, "msg_n"], [SID, "msg_n2"]]);
});

// ── stepEnded from step-finish parts (OpenCode V2 slice A2) ──

const stepFinish = (id, messageID, extra = {}) => ({
  id: `evt_${id}`,
  type: "message.part.updated",
  properties: {
    sessionID: SID,
    part: {
      id,
      messageID,
      sessionID: SID,
      type: "step-finish",
      reason: "tool-calls",
      cost: 0.5,
      tokens: { total: 90, input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 } },
      ...extra,
    },
  },
});

test("step-finish part emits stepEnded with tokens/cost/reason (finish = reason)", () => {
  const { interp, events } = make();
  interp.interpret(stepFinish("prt_sf1", "msg_a"));
  const f = subs(events, "stepEnded");
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].payload, {
    messageID: "msg_a",
    tokens: { input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 } },
    cost: 0.5,
    finish: "tool-calls",
  });
});

test("step-finish: a re-emitted part (same id) produces one frame; a second part another", () => {
  const { interp, events } = make();
  interp.interpret(stepFinish("prt_sf1", "msg_a"));
  interp.interpret(stepFinish("prt_sf1", "msg_a")); // no event id → not caught by the id filter, caught by part id
  interp.interpret(stepFinish("prt_sf2", "msg_a", { reason: "stop" }));
  assert.deepEqual(subs(events, "stepEnded").map((e) => e.payload.finish), ["tool-calls", "stop"]);
});

test("step-finish without usage still announces the step (zeros, no cost/finish)", () => {
  const { interp, events } = make();
  interp.interpret(stepFinish("prt_sf1", "msg_a", { tokens: undefined, cost: undefined, reason: undefined }));
  assert.deepEqual(subs(events, "stepEnded")[0].payload, {
    messageID: "msg_a",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
});

test("stepEnded de-dup: a build emitting BOTH step.ended and step-finish yields one frame per step (either order)", () => {
  const ended = (id, messageID) => ({
    id: `evt_${id}`,
    type: "session.next.step.ended",
    properties: { sessionID: SID, messageID, finish: "tool-calls", tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } } },
  });
  // event first, then the part
  const a = make();
  a.interp.interpret(ended("e1", "msg_a"));
  a.interp.interpret(stepFinish("prt_1", "msg_a"));
  assert.equal(subs(a.events, "stepEnded").length, 1);
  // part first, then the event — the event's truncation/context frames still fire
  const b = make();
  b.interp.interpret(stepFinish("prt_1", "msg_a"));
  b.interp.interpret(ended("e1", "msg_a"));
  assert.equal(subs(b.events, "stepEnded").length, 1);
  assert.equal(subs(b.events, "context").length, 1, "the event path still emits context");
  // a SECOND step of the same message is a new step on both sources
  b.interp.interpret(stepFinish("prt_2", "msg_a"));
  b.interp.interpret(ended("e2", "msg_a"));
  assert.equal(subs(b.events, "stepEnded").length, 2);
  // different messages never suppress each other
  b.interp.interpret(ended("e3", "msg_b"));
  assert.equal(subs(b.events, "stepEnded").length, 3);
});

test("a step-finish part does not emit context/cache/truncation (only stepEnded)", () => {
  const { interp, events } = make();
  interp.interpret(stepFinish("prt_sf1", "msg_a", { reason: "length" }));
  for (const sub of ["context", "cache", "truncation"]) assert.equal(subs(events, sub).length, 0, sub);
});
