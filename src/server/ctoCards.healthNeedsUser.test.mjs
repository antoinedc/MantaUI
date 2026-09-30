import { test } from "node:test";
import assert from "node:assert/strict";
import { healthNeedsUser, healthGroupKey, healthCardCopy, healthAlarmActive } from "./ctoCards.mjs";
import { BLOCKER_ACTION_TYPES } from "../shared/ctoCard.mjs";

const pinned = { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5" };

test("healthNeedsUser: background-task and persistence failures are never user cards", () => {
  assert.equal(healthNeedsUser({ source: "op-class:segment-summary" }, { defaultModel: pinned }), false);
  assert.equal(healthNeedsUser({ source: "infra:persist" }, { defaultModel: pinned }), false);
});

test("healthNeedsUser: a provider outage is a card only for the pinned provider", () => {
  assert.equal(healthNeedsUser({ source: "endpoint:chutes" }, { defaultModel: pinned }), false);
  assert.equal(healthNeedsUser({ source: "endpoint:chutes/Qwen/Qwen3.6-27B-TEE" }, { defaultModel: pinned }), false);
  assert.equal(healthNeedsUser({ source: "endpoint:openrouter" }, { defaultModel: pinned }), true);
  assert.equal(healthNeedsUser({ source: "endpoint:OpenRouter/x/y" }, { defaultModel: pinned }), true);
  assert.equal(healthNeedsUser({ source: "endpoint:openrouter" }, { defaultModel: null }), false);
});

test("healthNeedsUser: hard pauses still need a human", () => {
  for (const source of ["watchdog", "rate_limit", "cto-executor", "overnight_queue"]) {
    assert.equal(healthNeedsUser({ source }), true, source);
  }
});

test("healthGroupKey: a model-level endpoint folds into its account", () => {
  assert.equal(healthGroupKey({ source: "endpoint:chutes/Qwen/Qwen3.6-27B-TEE" }), "endpoint:chutes");
  assert.equal(healthGroupKey({ source: "endpoint:chutes" }), "endpoint:chutes");
  assert.equal(healthGroupKey({ source: "watchdog" }), "watchdog");
});

test("healthCardCopy: plain titles and only handled actions", () => {
  for (const [src, reason] of [
    ["watchdog", "burn $12.00/hr > 4x expected $1.00/hr"],
    ["rate_limit", "sessionCreationsPerHour"],
    ["overnight_queue", "Tonight task x was removed"],
    ["cto-executor", "plan failed"],
    ["endpoint:openrouter", 'account "openrouter" excluded — out-of-credit (HTTP 402)'],
    ["something-else", ""],
  ]) {
    const c = healthCardCopy(src, reason);
    assert.ok(c.title && c.title !== "Health check", src);
    assert.ok(!/op-class|HTTP 402|APIError/.test(c.title), src);
    assert.ok(c.options.length > 0, src);
    for (const o of c.options) assert.ok(BLOCKER_ACTION_TYPES.includes(o.action.type), `${src}:${o.action.type}`);
  }
  assert.match(healthCardCopy("endpoint:openrouter", "out-of-credit").title, /OpenRouter.*out of credits/);
  assert.deepEqual(healthCardCopy("watchdog", "").options.map((o) => o.action.type), ["resume-cto", "dismiss-card"]);
});

test("healthAlarmActive: reads the latches, account-grouped for endpoints", () => {
  const meta = {
    opClassAlarms: { "segment-summary": { active: false }, "tool-scan": { active: true } },
    healthAlarms: { "infra:persist": { active: false }, "endpoint:chutes/Qwen/X": { active: true } },
  };
  assert.equal(healthAlarmActive("op-class:segment-summary", meta), false);
  assert.equal(healthAlarmActive("op-class:tool-scan", meta), true);
  assert.equal(healthAlarmActive("infra:persist", meta), false);
  assert.equal(healthAlarmActive("endpoint:chutes", meta), true);
  assert.equal(healthAlarmActive("endpoint:openrouter", meta), false);
  assert.equal(healthAlarmActive("watchdog", meta), true);
});
