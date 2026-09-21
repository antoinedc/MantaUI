// ctoHealthWatchers.test.mjs — BET-1537 S5: pure predicate tests for the
// endpoint + infrastructure watchers (§W7 items 2+3). Hermetic — no fs, no
// stores, no clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEndpointIncidents,
  evaluateInfraIncidents,
  formatHealthReason,
  INFRA_RATE_THRESHOLD,
  INFRA_RATE_WINDOW_MS,
} from "./ctoHealthWatchers.mjs";

const T0 = 1_789_429_793_440; // 2026-09-14T23:49:53Z
let seq = 0;
let clock = T0;
const excluded = (over = {}) => {
  seq += 1;
  return {
    kind: "cto.endpoint_excluded",
    ts: (clock += 1000),
    subject: "p/m1",
    scope: "endpoint",
    state: "dead",
    reason: { httpStatus: 503, errorName: "APIError" },
    ...over,
  };
};
const recovered = (over = {}) => {
  seq += 1;
  return { kind: "cto.endpoint_recovered", ts: (clock += 1000), subject: "p/m1", scope: "endpoint", ...over };
};
const outcome = (code, over = {}) => {
  seq += 1;
  return { kind: "cto.operation_outcome", ts: (clock += 1000), code, ...over };
};

// ---------------------------------------------------------------------------
// Watcher 2 — the endpoint watcher
// ---------------------------------------------------------------------------

test("endpoint watcher: an exclusion raises once per incident and dedupes while active", () => {
  const alarms = {};
  let out = evaluateEndpointIncidents([excluded({ ts: 1000 })], { nowMs: 2000, alarms });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].watcher, "endpoint");
  assert.equal(out.raised[0].subject, "p/m1");
  assert.equal(out.raised[0].generation, 1);
  assert.equal(out.alarms["endpoint:p/m1"].active, true);

  // Same subject again while the incident is active — deduped, no re-raise.
  out = evaluateEndpointIncidents([excluded({ ts: 3000 })], { nowMs: 4000, alarms: out.alarms });
  assert.equal(out.raised.length, 0);
  assert.equal(out.alarms["endpoint:p/m1"].generation, 1);
});

test("endpoint watcher: recovery closes the incident and a later exclusion re-arms with a new generation", () => {
  const first = evaluateEndpointIncidents([excluded({ ts: 1000 })], { nowMs: 2000 });
  assert.equal(first.raised.length, 1);

  const closed = evaluateEndpointIncidents([recovered({ ts: 5000 })], { nowMs: 6000, alarms: first.alarms });
  assert.equal(closed.raised.length, 0);
  assert.equal(closed.recovered.length, 1);
  assert.equal(closed.recovered[0].subject, "p/m1");
  assert.equal(closed.alarms["endpoint:p/m1"].active, false);

  // Re-arm only AFTER recovery — the new exclusion is a new incident.
  const rearmed = evaluateEndpointIncidents([excluded({ ts: 9000 })], { nowMs: 10000, alarms: closed.alarms });
  assert.equal(rearmed.raised.length, 1);
  assert.equal(rearmed.raised[0].generation, 2);
});

test("endpoint watcher: a recovery row older than the incident does not close it", () => {
  const first = evaluateEndpointIncidents([excluded({ ts: 5000 })], { nowMs: 6000 });
  const out = evaluateEndpointIncidents([recovered({ ts: 1000 })], { nowMs: 7000, alarms: first.alarms });
  assert.equal(out.recovered.length, 0);
  assert.equal(out.alarms["endpoint:p/m1"].active, true);
});

test("endpoint watcher: the sliding window replaying seen rows never re-fires a closed incident", () => {
  // The full history an engine tick would re-read after the incident closed.
  const history = [excluded({ ts: 1000 }), recovered({ ts: 5000 }), excluded({ ts: 9000 })];
  // The latch as persisted after the third row raised incident #2.
  const afterAll = evaluateEndpointIncidents(history, { nowMs: 10000 });
  assert.equal(afterAll.alarms["endpoint:p/m1"].generation, 2);
  assert.equal(afterAll.alarms["endpoint:p/m1"].active, true);
  // Replaying the SAME rows against the persisted latch raises nothing.
  const replay = evaluateEndpointIncidents(history, { nowMs: 11000, alarms: afterAll.alarms });
  assert.equal(replay.raised.length, 0);
});

test("endpoint watcher: an account-scope exclusion fires under its own subject", () => {
  const out = evaluateEndpointIncidents(
    [excluded({ subject: "anthropic", scope: "account", state: "out-of-credit" })],
    { nowMs: 2000 },
  );
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].scope, "account");
  assert.equal(out.alarms["endpoint:anthropic"].state, "out-of-credit");
});

// ---------------------------------------------------------------------------
// Watcher 3 — the infrastructure watcher
// ---------------------------------------------------------------------------

test("infra watcher: a persistence failure, a quarantined file, self-doubt and verdicts each raise", () => {
  const rows = [
    { kind: "cto.endpoint_health_persist_failed", ts: 1000, operation: "register" },
    { kind: "cto.endpoint_attempts_quarantined", ts: 1100, detail: "bad json" },
    { kind: "cto.health_self_doubt", ts: 1200 },
    outcome("no-healthy-endpoint", { ts: 1300 }),
    outcome("no-alternate-endpoint", { ts: 1400 }),
  ];
  const out = evaluateInfraIncidents(rows, { nowMs: 2000 });
  const subjects = out.raised.map((a) => a.subject).sort();
  assert.deepEqual(subjects, [
    "no-alternate-endpoint",
    "no-healthy-endpoint",
    "persist",
    "quarantined",
    "self-doubt",
  ]);
  for (const a of out.raised) {
    assert.equal(a.watcher, "infra");
    assert.equal(a.generation, 1);
  }
});

test("infra watcher: repeated evidence dedupes; a later ok outcome closes verdict incidents", () => {
  let out = evaluateInfraIncidents([outcome("no-healthy-endpoint", { ts: 1000 })], { nowMs: 2000 });
  assert.equal(out.raised.length, 1);

  // Same verdict again while active — deduped.
  out = evaluateInfraIncidents([outcome("no-healthy-endpoint", { ts: 3000 })], { nowMs: 4000, alarms: out.alarms });
  assert.equal(out.raised.length, 0);

  // Dispatch works again — demonstrated recovery.
  out = evaluateInfraIncidents([outcome("ok", { ts: 5000 })], { nowMs: 6000, alarms: out.alarms });
  assert.equal(out.raised.length, 0);
  assert.equal(out.recovered.length, 1);
  assert.equal(out.recovered[0].subject, "no-healthy-endpoint");
  assert.equal(out.alarms["infra:no-healthy-endpoint"].active, false);

  // Re-arm after recovery.
  out = evaluateInfraIncidents([outcome("no-healthy-endpoint", { ts: 9000 })], { nowMs: 10000, alarms: out.alarms });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].generation, 2);
});

test("infra watcher: the sustained-loss rate fires only at threshold and decays below it", () => {
  const rows = [];
  for (let i = 0; i < INFRA_RATE_THRESHOLD; i++) {
    rows.push({ kind: "cto.operation_not_dispatched", ts: 1000 + i, operation: `op-${i}` });
  }
  let out = evaluateInfraIncidents(rows, { nowMs: 1000 + INFRA_RATE_WINDOW_MS / 2 });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].subject, "sustained-loss");

  // The window count IS the decay signal: a below-threshold evaluation (even
  // N-1) closes the active incident — demonstrated by the count, not by
  // absence of rows.
  out = evaluateInfraIncidents(rows.slice(0, INFRA_RATE_THRESHOLD - 1), { nowMs: 1000 + INFRA_RATE_WINDOW_MS / 2, alarms: out.alarms });
  assert.equal(out.raised.length, 0);
  assert.equal(out.alarms["infra:sustained-loss"].active, false);

  // A fresh storm re-arms with a new generation.
  out = evaluateInfraIncidents(rows, { nowMs: 1000 + INFRA_RATE_WINDOW_MS / 2 + 1, alarms: out.alarms });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].generation, 2);

  // After the window empties, the incident also decays (recovery).
  out = evaluateInfraIncidents([], { nowMs: 1000 + INFRA_RATE_WINDOW_MS + 1, alarms: out.alarms });
  assert.equal(out.recovered.length, 1);
  assert.equal(out.recovered[0].subject, "sustained-loss");
});

test("infra watcher: a batched abandoned row counts its weight", () => {
  const rows = [
    { kind: "cto.operations_abandoned", ts: 1000, count: INFRA_RATE_THRESHOLD },
  ];
  const out = evaluateInfraIncidents(rows, { nowMs: 2000 });
  assert.equal(out.raised.length, 1);
  assert.equal(out.raised[0].subject, "sustained-loss");
});

test("infra watcher: point incidents decay to recovered after the quiet window", () => {
  const out = evaluateInfraIncidents(
    [{ kind: "cto.endpoint_health_persist_failed", ts: 1000, operation: "register" }],
    { nowMs: 2000 },
  );
  assert.equal(out.raised.length, 1);

  // Still inside the quiet window — active.
  let next = evaluateInfraIncidents([], { nowMs: 1000 + 60_000, alarms: out.alarms });
  assert.equal(next.recovered.length, 0);
  assert.equal(next.alarms["infra:persist"].active, true);

  // Quiet past the window — recovered.
  next = evaluateInfraIncidents([], { nowMs: 1000 + 31 * 60_000, alarms: next.alarms });
  assert.equal(next.recovered.length, 1);
  assert.equal(next.recovered[0].subject, "persist");
});

// ---------------------------------------------------------------------------
// Reason formatter
// ---------------------------------------------------------------------------

test("formatHealthReason names the subject, the state and the reason", () => {
  const s = formatHealthReason({
    watcher: "endpoint",
    subject: "p/m1",
    scope: "endpoint",
    state: "dead",
    reason: { httpStatus: 503, errorName: "APIError", streak: 5 },
  });
  assert.match(s, /endpoint "p\/m1"/);
  assert.match(s, /dead/);
  assert.match(s, /HTTP 503/);
  assert.match(s, /5 consecutive failures/);

  const a = formatHealthReason({
    watcher: "endpoint",
    subject: "anthropic",
    scope: "account",
    state: "out-of-credit",
    reason: { httpStatus: 402 },
  });
  assert.match(a, /account "anthropic"/);
  assert.match(a, /HTTP 402/);

  const i = formatHealthReason({ watcher: "infra", subject: "quarantined", state: null, reason: null });
  assert.equal(i, "a health state file was corrupt — quarantined and rebuilt empty");

  // Every infra subject gets dedicated wording (never endpoint-shaped "unknown").
  for (const subject of ["persist", "self-doubt", "sustained-loss", "no-healthy-endpoint", "no-alternate-endpoint"]) {
    const s = formatHealthReason({ watcher: "infra", subject, state: null, reason: null });
    assert.ok(!/excluded — unknown/.test(s), `${subject} must not render endpoint-shaped copy`);
    assert.match(s, /./);
  }

  // A subject without dedicated copy still names itself.
  const x = formatHealthReason({ watcher: "infra", subject: "mystery-subject", state: null, reason: null });
  assert.match(x, /"mystery-subject"/);
});
