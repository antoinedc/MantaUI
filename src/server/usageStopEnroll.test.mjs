// usageStopEnroll.test.mjs — the enrolment path (BET-1047 §3): turns a stream
// of step/error events into stopped-conversation records, combining the
// refusal-match and the meter-correlation signals. Injected I/O only — no live
// provider, no filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageStopEngine, cachedTokensFromStep } from "./usageStopEnroll.mjs";

function harness({ atLimit = false } = {}) {
  const upserts = [];
  const engine = createUsageStopEngine({
    upsert: async (input) => upserts.push(input),
    recheckAtLimit: async () => atLimit,
    resolveWorkspace: async (sid) => `ws-${sid}`,
    now: () => 1234,
  });
  return { engine, upserts };
}

function stepEvent(sid, providerID = "anthropic", modelID = "claude-opus-4-7", cacheTokens = { read: 4000, write: 1000 }) {
  return {
    type: "session.next.step.ended",
    properties: { sessionID: sid, providerID, modelID, tokens: { cache: cacheTokens } },
  };
}

function errorEvent(sid, name = "Error", message = "you've hit your weekly limit") {
  return {
    type: "session.error",
    properties: { sessionID: sid, error: { name, data: { message } } },
  };
}

test("cachedTokensFromStep sums the cached prefix", () => {
  assert.equal(cachedTokensFromStep({ tokens: { cache: { read: 4000, write: 1000 } } }), 5000);
  assert.equal(cachedTokensFromStep({ tokens: {} }), 0);
  assert.equal(cachedTokensFromStep({}), 0);
});

test("a refused turn enrols with the provider, model, window and cached tokens", async () => {
  const { engine, upserts } = harness({ atLimit: false });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1"));
  assert.equal(upserts.length, 1);
  const u = upserts[0];
  assert.equal(u.conversation, "s1");
  assert.equal(u.provider, "claude"); // anthropic -> adapter id "claude"
  assert.equal(u.model, "claude-opus-4-7");
  assert.equal(u.window, "weekly");
  assert.equal(u.cachedTokens, 5000);
  assert.equal(u.workspace, "ws-s1");
  assert.equal(u.stoppedAt, 1234);
});

test("meter correlation: unmatched wording + provider at limit → still enrols", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1", "openai", "gpt-5"));
  await engine.observeEvent(errorEvent("s1", "Error", "some completely unrelated failure"));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, "codex");
  assert.equal(upserts[0].window, null);
});

test("no signal: unmatched wording + provider under limit → no enrolment", async () => {
  const { engine, upserts } = harness({ atLimit: false });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1", "Error", "some completely unrelated failure"));
  assert.equal(upserts.length, 0);
});

// Regression for reviewer Question (cycle 2): a never-enrol negative must
// suppress the meter-correlation signal on the ENROLMENT path too — a throttle
// that fires while a provider sits at its limit must not land a stopped record.
test("a throttle refused at limit still never enrols (neverEnrol beats correlation)", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1", "Error", "...temporarily limiting requests..."));
  assert.equal(upserts.length, 0, "a throttle at-limit must not land a stopped record");
});

test("a credit/overage refusal at limit never enrols", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1", "Error", "usage credits are required"));
  assert.equal(upserts.length, 0);
});

test("auth/credential failures never enrol even when at limit", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(
    errorEvent("s1", "UnknownError", "Your Claude credential has expired"),
  );
  assert.equal(upserts.length, 0, "an auth failure must never land a stopped record");
});

test("a user abort never enrols even when at limit", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1", "MessageAbortedError", "Aborted by user"));
  assert.equal(upserts.length, 0, "a user abort must never land a stopped record");
});

test("a context overflow never enrols even when at limit", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent(stepEvent("s1"));
  await engine.observeEvent(errorEvent("s1", "ContextOverflowError", "Context full — try /compact"));
  assert.equal(upserts.length, 0, "a context overflow must never land a stopped record");
});

test("a session with no observed step (unknown provider) never enrols", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  await engine.observeEvent(errorEvent("s1"));
  assert.equal(upserts.length, 0);
});

test("a kimi refusal maps to the kimi adapter and its window", async () => {
  const { engine, upserts } = harness({ atLimit: false });
  engine.observeEvent(stepEvent("s1", "kimi-for-coding", "kimi-k2"));
  await engine.observeEvent(errorEvent("s1", "Error", "reached your usage limit for this billing cycle"));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, "kimi");
  assert.equal(upserts[0].window, "weekly");
});

test("codex structural marker enrols via the error name", async () => {
  const { engine, upserts } = harness({ atLimit: false });
  engine.observeEvent(stepEvent("s1", "openai", "gpt-5"));
  await engine.observeEvent(errorEvent("s1", "usage_limit_reached", "Out of quota"));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, "codex");
});

test("non-error and non-step events are ignored", async () => {
  const { engine, upserts } = harness({ atLimit: true });
  engine.observeEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  engine.observeEvent({ type: "message.part.updated", properties: {} });
  assert.equal(upserts.length, 0);
});

test("getSessionModel exposes the cached provider record (BET-1230)", () => {
  const { engine } = harness();
  // Before any step event: no record.
  assert.equal(engine.getSessionModel("s1"), null);
  // A step event seeds the per-session provider cache.
  engine.observeEvent(stepEvent("s1", "openai", "gpt-5", { read: 2, write: 3 }));
  const m = engine.getSessionModel("s1");
  assert.equal(m.adapterId, "codex"); // openai -> adapter id "codex"
  assert.equal(m.model, "gpt-5");
  assert.equal(m.cachedTokens, 5);
  // An unknown session stays null.
  assert.equal(engine.getSessionModel("nobody"), null);
});
