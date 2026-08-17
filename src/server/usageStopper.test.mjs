// usageStopper.test.mjs — classifier + pure enrolment decision (BET-1047 §1, §4).
// Pure logic only — no live provider, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STOP_STRINGS,
  classifyUsageStopped,
  isUsageAtLimit,
  isStoppedProvider,
  decideUsageEnrolment,
} from "./usageStopper.mjs";

// Build a classifier call with a plausible error shape.
function classify(provider, errorName, errorMessage) {
  return classifyUsageStopped({ provider, errorName, errorMessage });
}

// ---------------------------------------------------------------------------
// Positive strings: every one enrols and yields the right window
// ---------------------------------------------------------------------------

test("claude positive strings enrol with the right window", () => {
  const cases = [
    { msg: "you've hit your session limit", window: "session" },
    { msg: "you've hit your weekly limit", window: "weekly" },
    { msg: "you've hit your Opus limit", window: "weekly" },
  ];
  for (const { msg, window } of cases) {
    const r = classify("claude", "Error", msg);
    assert.equal(r.enrolled, true, `"${msg}" should enrol`);
    assert.equal(r.window, window, `"${msg}" window`);
  }
  // The generic "usage limit reached" (title) enrols with no window.
  const generic = classify("claude", "Error", "usage limit reached");
  assert.equal(generic.enrolled, true);
  assert.equal(generic.window, null);
});

test("claude positive strings also match when in the error NAME", () => {
  const r = classify("claude", "usage limit reached", "something else entirely");
  assert.equal(r.enrolled, true);
});

test("claude matching is case-insensitive substring", () => {
  const r = classify("claude", "Error", "You've Hit Your Weekly Limit now");
  assert.equal(r.enrolled, true);
  assert.equal(r.window, "weekly");
});

test("codex structural markers enrol (error name / stream code)", () => {
  assert.equal(classify("codex", "usage_limit_reached", "The user is out of tokens").enrolled, true);
  assert.equal(classify("codex", "Error", "insufficient_quota").enrolled, true);
  assert.equal(classify("codex", "Error", "insufficient_quota").window, null);
});

test("kimi positive strings enrol with the right window", () => {
  const cases = [
    { msg: "reached your usage limit for this billing cycle", window: "weekly" },
    { msg: "reached your usage limit for this period", window: "session" },
    { msg: "reached kimi monthly usage limit", window: "monthly" },
  ];
  for (const { msg, window } of cases) {
    const r = classify("kimi", "Error", msg);
    assert.equal(r.enrolled, true, `"${msg}" should enrol`);
    assert.equal(r.window, window, `"${msg}" window`);
  }
});

// ---------------------------------------------------------------------------
// Negative strings: never enrol — throttles, overload, tier, credit
// ---------------------------------------------------------------------------

test("claude negative strings never enrol", () => {
  for (const msg of STOP_STRINGS.claude.negative) {
    assert.equal(classify("claude", "Error", msg).enrolled, false, `"${msg}" must not enrol`);
  }
  // A negative present alongside a positive must still not enrol.
  const mixed = classify("claude", "Error", "you've hit your session limit, usag usage credits are required");
  assert.equal(mixed.enrolled, false);
});

test("codex negative strings never enrol", () => {
  for (const msg of STOP_STRINGS.codex.negative) {
    assert.equal(classify("codex", msg, "the provider declined").enrolled, false, `"${msg}" must not enrol`);
  }
});

test("kimi negative strings never enrol, including tier-entitlement", () => {
  for (const msg of STOP_STRINGS.kimi.negative) {
    assert.equal(classify("kimi", "Error", msg).enrolled, false, `"${msg}" must not enrol`);
  }
});

test("auth/credential failures never enrol (reuses the auth-error predicate)", () => {
  // Claude's credential-expired shape must not enrol even though "limit"
  // appears nowhere — it's an auth failure, not a plan limit.
  const auth = classifyUsageStopped({
    provider: "claude",
    errorName: "UnknownError",
    errorMessage: "Your Claude credential has expired",
    error: { name: "UnknownError", data: { message: "Your Claude credential has expired" } },
  });
  assert.equal(auth.enrolled, false, "claude credential failure must not enrol");
});

test("a user abort never enrols, even with a matching-looking name field", () => {
  assert.equal(classifyUsageStopped({ provider: "claude", errorName: "MessageAbortedError", errorMessage: "stopped" }).enrolled, false);
});

test("a context overflow never enrols", () => {
  assert.equal(classifyUsageStopped({ provider: "claude", errorName: "ContextOverflowError", errorMessage: "context window exceeded" }).enrolled, false);
});

test("unlisted / unknown provider is out of scope and never enrols", () => {
  assert.equal(isStoppedProvider("deepseek"), false);
  assert.equal(isStoppedProvider("openai"), false); // opencode providerID, not the adapter id
  assert.equal(classify("openai", "ApiError", "you've hit your weekly limit").enrolled, false);
  assert.equal(classify(undefined, "Error", "usage limit reached").enrolled, false);
  assert.equal(isStoppedProvider("claude"), true);
});

// ---------------------------------------------------------------------------
// isUsageAtLimit + decideUsageEnrolment (the meter-correlation signal)
// ---------------------------------------------------------------------------

test("isUsageAtLimit flags an exhausted window", () => {
  assert.equal(isUsageAtLimit([{ pct: 100 }]), true);
  assert.equal(isUsageAtLimit([{ pct: 142 }]), true);
  assert.equal(isUsageAtLimit([{ pct: 99 }, { used: 12, limit: 10 }]), true);
  assert.equal(isUsageAtLimit([{ pct: 40 }]), false);
  assert.equal(isUsageAtLimit([{ used: 8, limit: 10 }]), false);
  assert.equal(isUsageAtLimit([]), false);
  assert.equal(isUsageAtLimit(undefined), false);
});

test("correlation: unmatched wording + provider AT limit → enrolled (no window)", () => {
  const match = { enrolled: false, window: null };
  const decision = decideUsageEnrolment({ match, atLimit: true });
  assert.equal(decision.enrol, true);
  assert.equal(decision.window, null);
});

test("correlation: unmatched wording + provider UNDER limit → not enrolled", () => {
  const decision = decideUsageEnrolment({ match: { enrolled: false, window: null }, atLimit: false });
  assert.equal(decision.enrol, false);
});

test("match wins even when the meter reads under limit, and keeps its window", () => {
  const decision = decideUsageEnrolment({ match: { enrolled: true, window: "weekly" }, atLimit: false });
  assert.equal(decision.enrol, true);
  assert.equal(decision.window, "weekly");
});
