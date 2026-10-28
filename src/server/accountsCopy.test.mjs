import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountsErrorMessage, withErrorMessage, formatRetryMinutes, formatAgeAt, formatEndpointStateLine,
  worstEndpoint, providerLinesFor, formatNoHealthyEndpointCopy, moveNoticeText, moveLine, resentText, moveCopy, moveReasonText,
} from "./accountsCopy.mjs";

test("K7: every code has a sentence; unknown codes degrade; a result gains `message`", () => {
  for (const code of ["unknown-seat", "invalid-label", "live-seat", "last-seat", "no-replacement", "unknown-provider", "login-failed", "duplicate-login", "different-org", "different-account", "unknown-flow"]) {
    const m = accountsErrorMessage(code);
    assert.ok(m.endsWith("."), code);
    assert.doesNotMatch(m, new RegExp(code), "the raw code never reaches a screen");
  }
  assert.equal(accountsErrorMessage("who-knows"), "That didn't work. Try again.");
  assert.equal(accountsErrorMessage(undefined), "That didn't work. Try again.");
  assert.deepEqual(withErrorMessage({ error: "live-seat" }), { error: "live-seat", message: accountsErrorMessage("live-seat") });
  assert.deepEqual(withErrorMessage({ ok: true }), { ok: true });
  assert.deepEqual(withErrorMessage({ error: "x", message: "kept" }), { error: "x", message: "kept" });
  assert.equal(withErrorMessage(null), null);
});

test("K3: state line parts, in order, with the age worded at response time", () => {
  const now = 10 * 60_000 * 6;
  assert.equal(formatEndpointStateLine(null, now), "");
  assert.equal(formatEndpointStateLine({ state: "dead" }, now), "Dead");
  const line = formatEndpointStateLine({
    state: "rate-limited", retryInMs: 61_000, reason: { httpStatus: 429 }, lastSuccessAt: now - 5 * 60_000, attempts: 4, successes: 3,
  }, now);
  assert.equal(line, "Rate limited · retry in 2m · HTTP 429 · last success 5m ago · 4 attempts · 75% success in window");
  assert.equal(formatEndpointStateLine({ state: "degraded", reason: { errorName: "Timeout" }, attempts: 1, successes: 0 }, now), "Degraded · Timeout · 1 attempt · 0% success in window");
  assert.equal(formatEndpointStateLine({ state: "weird" }, now), "weird");
  assert.equal(formatRetryMinutes(1), 1);
  assert.equal(formatRetryMinutes(0), null);
  assert.equal(formatAgeAt(0, 5), null);
  assert.equal(formatAgeAt(1, 1 + 3 * 3_600_000), "3h ago");
  assert.equal(formatAgeAt(1, 1 + 6 * 86_400_000), "6d ago");
});

test("K3: worst endpoint by badness (tie keeps the first) and providerLines", () => {
  const endpoints = {
    "p/a": { state: "degraded" },
    "p/b": { state: "dead" },
    "p/c": { state: "forbidden" },
    "q/x": { state: "not-found" },
    "q/y": { state: "forbidden" },
    "pp/z": { state: "dead" },
  };
  assert.equal(worstEndpoint(endpoints, "p").key, "p/b");
  assert.equal(worstEndpoint(endpoints, "q").key, "q/x");
  assert.equal(worstEndpoint({}, "p"), null);
  const lines = providerLinesFor(endpoints, { p: 3, r: 2, s: 0 }, 0);
  assert.deepEqual(lines.p, { key: "p/b", stateLine: "Dead" });
  assert.deepEqual(lines.r, { key: null, stateLine: "Unproven" });
  assert.equal(lines.s, undefined);
});

test("K3: no-healthy copy with and without excludedWhy", () => {
  assert.match(formatNoHealthyEndpointCopy({ excluded: [] }), /^Auto couldn't pick a healthy model\. The turn was not sent/);
  assert.match(formatNoHealthyEndpointCopy(undefined), /^Auto couldn't pick/);
  assert.equal(
    formatNoHealthyEndpointCopy({ excluded: ["a/m", "b/n"], excludedWhy: { "a/m": { endpoint: "dead", provider: "out-of-credit" } } }),
    "Auto couldn't pick a healthy model — a/m (Dead, Out of credit), b/n excluded. The turn was not sent; switch off Auto, reset health below, or pick a model to send.",
  );
});

test("K5: notice sentence per reason / trigger / cross-org", () => {
  const base = { fromLabel: "Seat 1", toLabel: "Work · Seat 2" };
  assert.equal(moveNoticeText({ ...base, reason: "load", trigger: { kind: "session", pct: 91.2 } }), "Moved to Work · Seat 2 (Seat 1 at 91% of 5h).");
  assert.equal(moveNoticeText({ ...base, reason: "load", trigger: { kind: "weekly", pct: 70 } }), "Moved to Work · Seat 2 (Seat 1 at 70% of the weekly limit).");
  assert.equal(moveNoticeText({ ...base, reason: "load" }), "Moved to Work · Seat 2 (Seat 1 was near its limit).");
  assert.equal(moveNoticeText({ ...base, reason: "exhausted" }), "Moved to Work · Seat 2 (Seat 1 was at its limit).");
  assert.equal(moveNoticeText({ ...base, reason: "unusable" }), "Moved to Work · Seat 2 (Seat 1 needed sign-in).");
  assert.equal(moveNoticeText({ ...base, reason: "manual" }), "Switched to Work · Seat 2.");
  assert.equal(moveNoticeText({ ...base, reason: "mystery" }), "Moved to Work · Seat 2.");
  assert.equal(moveNoticeText({ toLabel: " ", fromLabel: "", reason: "load" }), "Moved to another seat.");
  assert.equal(moveNoticeText({ ...base, reason: "exhausted", crossOrg: true }), "Moved to Work · Seat 2 (Seat 1 was at its limit). History re-sent.");
});

test("K5: dial line, reason words and the re-sent figure", () => {
  assert.equal(moveLine({ from: "s1", fromLabel: "Seat 1", reason: "exhausted" }), "Moved from Seat 1 · seat was at its limit");
  assert.equal(moveLine({ from: "s1", reason: "load" }), "Moved from s1 · to balance load");
  assert.equal(moveLine({}), "Moved from another seat");
  assert.equal(moveReasonText("seat-gone_now"), "seat gone now");
  assert.equal(moveReasonText("  "), null);
  assert.equal(resentText({ crossOrg: true, resentTokens: 12_400 }), "history re-sent: 12.4k");
  assert.equal(resentText({ crossOrg: true }), null);
  assert.equal(resentText({ crossOrg: false, resentTokens: 5 }), null);
  assert.deepEqual(Object.keys(moveCopy({ fromLabel: "a", toLabel: "b" })).sort(), ["line", "resentText", "text"]);
});
