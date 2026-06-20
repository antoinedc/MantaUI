import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCron,
  cronMatches,
  minuteKey,
  createScheduler,
} from "./schedule.mjs";

// ----------------------------------------------------------------------------
// validateCron
// ----------------------------------------------------------------------------

test("validateCron accepts standard 5-field expressions", () => {
  for (const ok of [
    "*/5 * * * *",
    "0 * * * *",
    "7 * * * *",
    "0 9 * * *",
    "0 9 * * 1-5",
    "30 14 15 3 *",
    "0,15,30,45 * * * *",
    "0 0 * * 7", // sunday as 7
  ]) {
    assert.equal(validateCron(ok).valid, true, `${ok} should be valid`);
  }
});

test("validateCron rejects malformed expressions", () => {
  for (const bad of [
    "* * * *", // 4 fields
    "* * * * * *", // 6 fields
    "60 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "* * 0 * *", // dom < 1
    "* * * 13 *", // month > 12
    "* * * * 8", // dow > 7
    "*/0 * * * *", // zero step
    "5-2 * * * *", // inverted range
    "abc * * * *", // non-numeric
  ]) {
    assert.equal(validateCron(bad).valid, false, `${bad} should be invalid`);
  }
});

test("validateCron rejects non-strings", () => {
  assert.equal(validateCron(null).valid, false);
  assert.equal(validateCron(42).valid, false);
});

// ----------------------------------------------------------------------------
// cronMatches — uses LOCAL time
// ----------------------------------------------------------------------------

// Build a local-time Date. (new Date(y, mIdx, d, h, min) is local.)
function localDate(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

test("cronMatches wildcard matches everything", () => {
  assert.equal(cronMatches("* * * * *", localDate(2026, 6, 20, 15, 5)), true);
});

test("cronMatches step on minutes", () => {
  const expr = "*/5 * * * *";
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 15, 0)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 15, 5)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 15, 3)), false);
});

test("cronMatches single minute+hour", () => {
  const expr = "30 9 * * *";
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 9, 30)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 9, 31)), false);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 10, 30)), false);
});

test("cronMatches comma list", () => {
  const expr = "0,15,30,45 * * * *";
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 1, 15)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 1, 45)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 1, 20)), false);
});

test("cronMatches weekday range (Mon-Fri at 9am)", () => {
  const expr = "0 9 * * 1-5";
  // 2026-06-22 is a Monday
  assert.equal(cronMatches(expr, localDate(2026, 6, 22, 9, 0)), true);
  // 2026-06-20 is a Saturday
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 9, 0)), false);
});

test("cronMatches Sunday as 0 or 7", () => {
  // 2026-06-21 is a Sunday
  assert.equal(cronMatches("0 0 * * 0", localDate(2026, 6, 21, 0, 0)), true);
  assert.equal(cronMatches("0 0 * * 7", localDate(2026, 6, 21, 0, 0)), true);
});

test("cronMatches vixie DOM/DOW either-match semantics", () => {
  // Both DOM and DOW restricted → match if EITHER matches.
  // "0 0 13 * 5" = midnight on the 13th OR any Friday.
  const expr = "0 0 13 * 5";
  // 2026-06-13 is a Saturday → matches via DOM (13).
  assert.equal(cronMatches(expr, localDate(2026, 6, 13, 0, 0)), true);
  // 2026-06-19 is a Friday → matches via DOW (5).
  assert.equal(cronMatches(expr, localDate(2026, 6, 19, 0, 0)), true);
  // 2026-06-20 is a Saturday, not the 13th → no match.
  assert.equal(cronMatches(expr, localDate(2026, 6, 20, 0, 0)), false);
});

test("cronMatches DOM-only restriction ignores weekday", () => {
  const expr = "0 0 15 * *";
  assert.equal(cronMatches(expr, localDate(2026, 6, 15, 0, 0)), true);
  assert.equal(cronMatches(expr, localDate(2026, 6, 16, 0, 0)), false);
});

test("cronMatches returns false for malformed expr (no throw)", () => {
  assert.equal(cronMatches("garbage", localDate(2026, 6, 20, 0, 0)), false);
  assert.equal(cronMatches("* * * *", localDate(2026, 6, 20, 0, 0)), false);
});

// ----------------------------------------------------------------------------
// minuteKey
// ----------------------------------------------------------------------------

test("minuteKey is stable per-minute local key", () => {
  assert.equal(minuteKey(localDate(2026, 6, 20, 15, 5)), "2026-06-20T15:05");
  assert.equal(minuteKey(localDate(2026, 1, 2, 3, 4)), "2026-01-02T03:04");
});

// ----------------------------------------------------------------------------
// createScheduler.tick — fire / dedup / one-shot / recurring / persist
// ----------------------------------------------------------------------------

// In-memory store + sendPrompt spy harness.
function harness(initialJobs, fixedNow) {
  let jobs = initialJobs.map((j) => ({ ...j }));
  const sent = [];
  const published = [];
  const deps = {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => {
      jobs = next.map((j) => ({ ...j }));
    },
    sendPrompt: async (args) => {
      sent.push(args);
    },
    now: () => fixedNow,
    publish: (evt) => published.push(evt),
  };
  return {
    deps,
    sent,
    published,
    get jobs() {
      return jobs;
    },
  };
}

const baseJob = {
  id: "job1",
  cron: "*/5 * * * *",
  prompt: "check the deploy",
  recurring: true,
  label: "",
  sessionID: "ses_abc",
  directory: "/home/dev/x",
  createdAt: 0,
  lastFiredMinute: null,
};

test("tick fires a due recurring job and stamps lastFiredMinute", async () => {
  const now = localDate(2026, 6, 20, 15, 5); // matches */5
  const h = harness([baseJob], now);
  const { tick } = createScheduler(h.deps);
  await tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { sessionId: "ses_abc", text: "check the deploy" });
  assert.equal(h.jobs.length, 1, "recurring job survives");
  assert.equal(h.jobs[0].lastFiredMinute, "2026-06-20T15:05");
});

test("tick does NOT fire a job that isn't due this minute", async () => {
  const now = localDate(2026, 6, 20, 15, 3); // not a */5 minute
  const h = harness([baseJob], now);
  const { tick } = createScheduler(h.deps);
  await tick();
  assert.equal(h.sent.length, 0);
});

test("tick does NOT double-fire within the same minute", async () => {
  const now = localDate(2026, 6, 20, 15, 5);
  const h = harness([baseJob], now);
  const { tick } = createScheduler(h.deps);
  await tick(); // fires, stamps lastFiredMinute=...15:05
  await tick(); // same minute → guard prevents re-fire
  assert.equal(h.sent.length, 1);
});

test("tick deletes a one-shot job after firing", async () => {
  const now = localDate(2026, 6, 20, 15, 0);
  const oneShot = { ...baseJob, id: "once1", cron: "0 15 * * *", recurring: false };
  const h = harness([oneShot], now);
  const { tick } = createScheduler(h.deps);
  await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.jobs.length, 0, "one-shot removed after firing");
});

test("tick publishes schedule.updated for fired sessions", async () => {
  const now = localDate(2026, 6, 20, 15, 5);
  const h = harness([baseJob], now);
  const { tick } = createScheduler(h.deps);
  await tick();
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].kind, "schedule.updated");
  assert.equal(h.published[0].payload.sessionID, "ses_abc");
});

test("tick swallows sendPrompt errors but still stamps to avoid hammering", async () => {
  const now = localDate(2026, 6, 20, 15, 5);
  const h = harness([baseJob], now);
  h.deps.sendPrompt = async () => {
    throw new Error("opencode down");
  };
  const { tick } = createScheduler(h.deps);
  await tick(); // must not throw
  assert.equal(h.jobs[0].lastFiredMinute, "2026-06-20T15:05");
});

test("tick leaves non-due jobs untouched and persists nothing", async () => {
  const now = localDate(2026, 6, 20, 15, 3);
  const h = harness([baseJob], now);
  const { tick } = createScheduler(h.deps);
  await tick();
  assert.equal(h.published.length, 0);
  assert.equal(h.jobs[0].lastFiredMinute, null);
});
