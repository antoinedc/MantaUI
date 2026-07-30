// Tests for src/server/promptDelivery.mjs — the single defer-while-busy
// prompt-delivery engine shared by all four senders (webhook, schedule,
// peer, capability). The busy/pending mechanics were lifted verbatim from
// the webhook engine; these tests pin that behaviour so a future change to
// the shared engine can't silently regress the three senders that just
// gained deferral (BET-375).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPromptDelivery } from "./promptDelivery.mjs";

// Build an engine with a fake sendPrompt that records every call in order.
// `rejectTexts` is a Set of texts whose sendPrompt call should reject.
function makeEngine({ rejectTexts = new Set() } = {}) {
  const calls = [];
  const sendPrompt = async (args) => {
    calls.push(args);
    if (rejectTexts.has(args?.text)) {
      throw new Error(`synthetic sendPrompt failure for "${args?.text}"`);
    }
  };
  const engine = createPromptDelivery({ sendPrompt });
  return { engine, calls };
}

test("1. idle session → deliver calls sendPrompt once and reports delivered:true", async () => {
  const { engine, calls } = makeEngine();
  const res = await engine.deliver({ sessionId: "s1", text: "hi" });
  assert.equal(res.delivered, true);
  assert.equal(res.queued, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { sessionId: "s1", text: "hi" });
});

test("2. busy session → sendPrompt NOT called; reports queued:true", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  const res = await engine.deliver({ sessionId: "s1", text: "deferred" });
  assert.equal(res.delivered, false);
  assert.equal(res.queued, true);
  assert.equal(calls.length, 0);
});

test("3. busy then two delivers then idle → both sent, in submission order", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "first" });
  await engine.deliver({ sessionId: "s1", text: "second" });
  assert.equal(calls.length, 0, "nothing sent while busy");
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  // drain is async — let it settle.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, "first");
  assert.equal(calls[1].text, "second");
});

test("4. session.status{type:\"retry\"} also marks busy", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "retry" } },
  });
  assert.equal(engine.isBusy("s1"), true);
  const res = await engine.deliver({ sessionId: "s1", text: "x" });
  assert.equal(res.queued, true);
  assert.equal(calls.length, 0);
});

test("5. session.error clears busy and drains", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "queued-on-error" });
  engine.observeEvent({ type: "session.error", properties: { sessionID: "s1" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.isBusy("s1"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "queued-on-error");
});

test("6. session.status{type:\"idle\"} clears busy and drains", async () => {
  const { engine, calls } = makeEngine();
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "queued-on-idle" });
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" } },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.isBusy("s1"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "queued-on-idle");
});

test("7. a sendPrompt rejection does not reject deliver and does not stop the queue draining", async () => {
  const { engine, calls } = makeEngine({ rejectTexts: new Set(["will-fail", "boom"]) });
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  await engine.deliver({ sessionId: "s1", text: "will-fail" });
  await engine.deliver({ sessionId: "s1", text: "after-fail" });
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  await new Promise((r) => setTimeout(r, 5));
  // Both attempted; the first threw but the second still ran.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, "will-fail");
  assert.equal(calls[1].text, "after-fail");
  // A direct deliver to an idle session that rejects must not reject.
  const res = await engine.deliver({ sessionId: "s2", text: "boom" });
  assert.equal(res.delivered, false);
  assert.equal(res.queued, false);
});

test("8. events with no properties.sessionID are ignored without throwing", async () => {
  const { engine } = makeEngine();
  assert.doesNotThrow(() => engine.observeEvent({ type: "session.idle" }));
  assert.doesNotThrow(() => engine.observeEvent({ type: "session.status", properties: {} }));
  assert.doesNotThrow(() => engine.observeEvent(undefined));
  assert.doesNotThrow(() => engine.observeEvent(null));
  assert.doesNotThrow(() =>
    engine.observeEvent({ type: "session.status", properties: { sessionID: 123 } }),
  );
});

test("9. isBusy reflects the tracked state", async () => {
  const { engine } = makeEngine();
  assert.equal(engine.isBusy("s1"), false);
  engine.observeEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  assert.equal(engine.isBusy("s1"), true);
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  assert.equal(engine.isBusy("s1"), false);
});
