import { test } from "node:test";
import assert from "node:assert/strict";
import { COOLDOWN_MS, decideAutoTrigger, entryPlan, handoffBudget, modelClass, normalizeMode } from "./policy.mjs";

// ---- §4.1 entry points × mode ------------------------------------------------

const CARD = { produce: "card", kind: "suggest" };
const TABLE = [
  // [trigger, action, mode, expected]
  ["auto", undefined, "auto", { produce: "start", kind: "auto", how: "clear", disposition: "armed" }],
  ["auto", undefined, "suggest", CARD],
  ["auto", undefined, "off", { produce: "none", kind: "suggest" }],
  ["agent", "handoff", "auto", { produce: "start", kind: "auto", how: "clear", disposition: "send" }],
  ["agent", "handoff", "suggest", CARD],
  ["agent", "handoff", "off", CARD],
  ["agent", "suggest", "auto", CARD],
  ["agent", "suggest", "suggest", CARD],
  ["agent", "suggest", "off", CARD],
  ["user", undefined, "auto", CARD],
  ["user", undefined, "suggest", CARD],
  ["user", undefined, "off", CARD],
  ["button", undefined, "auto", CARD],
  ["button", undefined, "suggest", CARD],
  ["button", undefined, "off", CARD],
];
for (const [trigger, action, mode, want] of TABLE) {
  test(`entry × mode: ${trigger}${action ? `/${action}` : ""} in ${mode}`, () => {
    assert.deepEqual(entryPlan({ mode, trigger, action }), want);
  });
}

test("entryPlan rejects unknown triggers/actions and treats a garbage mode as the default (auto)", () => {
  assert.throws(() => entryPlan({ mode: "auto", trigger: "cron" }), /unknown trigger/);
  assert.throws(() => entryPlan({ mode: "auto", trigger: "agent", action: "nuke" }), /unknown action/);
  assert.equal(normalizeMode("yes"), "auto");
  assert.equal(normalizeMode(undefined), "auto");
  assert.equal(normalizeMode("off"), "off");
  assert.equal(entryPlan({ mode: "bogus", trigger: "auto" }).disposition, "armed");
});

// ---- §4.3 budget -----------------------------------------------------------------

test("budget: min(family ceiling, 60% of the window)", () => {
  assert.equal(handoffBudget({ modelID: "claude-opus-4-8", contextLimit: 1_000_000 }), 200_000);
  assert.equal(handoffBudget({ modelID: "claude-sonnet-5-5", contextLimit: 200_000 }), 120_000, "60% of a 200k window beats the 200k ceiling");
  assert.equal(handoffBudget({ modelID: "gpt-6-sol", contextLimit: 400_000 }), 200_000);
  assert.equal(handoffBudget({ modelID: "claude-haiku-4-5", contextLimit: 200_000 }), 100_000, "smaller/cheaper ≈ 100k");
  assert.equal(handoffBudget({ modelID: "gpt-5-mini", contextLimit: 400_000 }), 100_000, "a small marker wins over a frontier family word");
  assert.equal(handoffBudget({ modelID: "some-new-model", contextLimit: 128_000 }), 76_800, "unknown family → 60% of the window");
});

test("budget: an unknown window uses the family ceiling; neither → null", () => {
  assert.equal(handoffBudget({ modelID: "claude-opus-4-8" }), 200_000);
  assert.equal(handoffBudget({ modelID: "claude-opus-4-8", contextLimit: 0 }), 200_000);
  assert.equal(handoffBudget({ modelID: "mystery" }), null);
  assert.equal(handoffBudget({}), null);
  assert.equal(modelClass("x", ""), "unknown");
});

// ---- §4.2 trigger: turn outcome × budget × cooldown ---------------------------------

const base = { mode: "auto", turnSucceeded: true, contextTokens: 250_000, budget: 200_000, now: 10_000_000 };
test("trigger fires only for a successful turn over budget outside cooldown, in a mode that acts", () => {
  assert.deepEqual(decideAutoTrigger(base), { fire: true, reason: "over-budget" });
  assert.equal(decideAutoTrigger({ ...base, mode: "suggest" }).fire, true, "suggest also decides (the caller makes a card)");
  assert.equal(decideAutoTrigger({ ...base, mode: "off" }).reason, "mode-off");
  assert.equal(decideAutoTrigger({ ...base, turnSucceeded: false }).reason, "turn-not-successful");
  assert.equal(decideAutoTrigger({ ...base, contextTokens: 200_000 }).reason, "under-budget", "exactly at budget is not over");
  assert.equal(decideAutoTrigger({ ...base, budget: null }).reason, "no-budget");
  assert.equal(decideAutoTrigger({ ...base, contextTokens: null }).reason, "no-measurement");
});

test("trigger cooldown: 30 minutes after the session's creation by a handoff", () => {
  const created = base.now - (COOLDOWN_MS - 1);
  assert.equal(decideAutoTrigger({ ...base, successorCreatedAt: created }).reason, "cooldown");
  assert.equal(decideAutoTrigger({ ...base, successorCreatedAt: base.now - COOLDOWN_MS }).fire, true);
  assert.equal(decideAutoTrigger({ ...base, successorCreatedAt: null }).fire, true);
});
