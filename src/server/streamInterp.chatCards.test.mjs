// WS02 server-first (SF-1…SF-3): the chat-card copy the box adds to the stream
// frames — retry headline/caption/body, compaction firstLine, sessionError display.
// These assertions go green once the M-02-srv-2/3/5 mounts are applied to streamInterp.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamInterpreter } from "./streamInterp.mjs";

const SID = "ses_main";
let n = 0;
const ev = (type, data = {}) => ({ id: `evt_cc_${++n}`, type, data: { sessionID: SID, ...data } });

function make() {
  const events = [];
  const interp = createStreamInterpreter({ publish: (e) => events.push(e), now: () => 500_000 });
  return { interp, events };
}
const subs = (events, sub) => events.filter((e) => e.sub === sub);

test("retry frame carries the box's headline / caption / body", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.retry.scheduled", { attempt: 3, at: 99, error: { message: "Overloaded" } }));
  const p = subs(events, "retry")[0].payload;
  assert.equal(p.headline, "Retrying…");
  assert.equal(p.caption, "attempt 3");
  assert.equal(p.body, "Overloaded");
  assert.equal(p.attempt, 3);
  assert.equal(p.next, 99);
});

test("retry frame: attempt 0 has no caption; an empty message has no body", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.retry.scheduled", { error: {} }));
  const p = subs(events, "retry")[0].payload;
  assert.equal(p.attempt, 0);
  assert.equal(p.caption, null);
  assert.equal(p.body, null);
});

test("compaction: started + deltas + ended → ended carries the first non-blank line", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.compaction.started", { reason: "context" }));
  interp.interpret(ev("session.compaction.delta", { text: "\n  " }));
  interp.interpret(ev("session.compaction.delta", { text: "## Objective\nmore" }));
  interp.interpret(ev("session.compaction.ended", {}));
  const frames = subs(events, "compaction").map((e) => e.payload);
  assert.deepEqual(frames.at(-1), { phase: "ended", firstLine: "## Objective" });
  // delta frames stay verbatim (the live card shows the stream as it grows)
  assert.deepEqual(frames[1], { phase: "delta", text: "\n  " });
});

test("compaction: a new started resets what the previous one streamed", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.compaction.started", {}));
  interp.interpret(ev("session.compaction.delta", { text: "first run" }));
  interp.interpret(ev("session.compaction.ended", {}));
  interp.interpret(ev("session.compaction.started", {}));
  interp.interpret(ev("session.compaction.ended", {}));
  const ended = subs(events, "compaction").filter((e) => e.payload.phase === "ended").map((e) => e.payload.firstLine);
  assert.deepEqual(ended, ["first run", null]);
});

test("sessionError.display: a credential failure after a step on anthropic → Claude reconnect target", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.started"));
  interp.interpret(ev("session.step.started", { model: { providerID: "anthropic", id: "claude-sonnet-5-5" } }));
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.auth", message: "Unauthorized" } }));
  const p = subs(events, "sessionError")[0].payload;
  assert.equal(p.name, "ProviderAuthError");
  assert.deepEqual(p.display, {
    text: "Claude needs to be reconnected.",
    reconnect: { providerID: "anthropic", label: "Claude", accountsId: "claude" },
  });
});

test("sessionError.display: no model known → a plain notice with no reconnect", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.auth", message: "Unauthorized" } }));
  const p = subs(events, "sessionError")[0].payload;
  assert.equal(p.display.reconnect, null);
  assert.equal(p.display.text, "Unauthorized");
});

test("sessionError.display: classification uses the RAW provider message when the box humanized it", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.step.started", { model: { providerID: "openai", id: "gpt-6" } }));
  const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Your session is no longer valid" } });
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.internal", message: `Unauthorized: ${body}` } }));
  const p = subs(events, "sessionError")[0].payload;
  assert.equal(p.message, "Your session is no longer valid");
  assert.equal(p.display.reconnect?.accountsId, "codex");
});

test("sessionError.display: a rate-limit ApiError stays a plain 'API error' notice", () => {
  const { interp, events } = make();
  interp.interpret(ev("session.step.started", { model: { providerID: "anthropic", id: "x" } }));
  interp.interpret(ev("session.execution.failed", { error: { type: "provider.no-route", message: "rate limit window expired" } }));
  const p = subs(events, "sessionError")[0].payload;
  assert.equal(p.display.reconnect, null);
  assert.equal(p.display.text, "API error: rate limit window expired");
});
