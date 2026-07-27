import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  agentRole,
  sortRunsNewestFirst,
  runSettledAt,
  screenIssue,
  decideUnstick,
  ACTIVE_RUN_STATUSES,
  LIVE_PR_STATES,
  LIVE_STATUSES,
} from "./multica-unstick.mjs";

const DEV = "dev-id";
const REVIEWER = "reviewer-id";
const PM = "pm-id";
const OPS = "ops-id";

const ROLES = new Map([
  [DEV, { name: "manta-dev", role: "implementer" }],
  [REVIEWER, { name: "manta-reviewer", role: "reviewer" }],
  [PM, { name: "manta-pm", role: "pm" }],
  [OPS, { name: "manta-ops", role: "ops" }],
]);

const NOW = Date.parse("2026-07-27T08:00:00Z");
const GRACE = 30 * 60_000;
const BACKOFF = 120 * 60_000;

const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();

const issue = (over = {}) => ({
  id: "uuid-1",
  identifier: "BET-297",
  status: "in_review",
  assignee_type: "agent",
  assignee_id: DEV,
  updated_at: minsAgo(400),
  metadata: {},
  ...over,
});

const decide = (over = {}) =>
  decideUnstick({
    issue: issue(),
    runs: [{ status: "completed", completed_at: minsAgo(90) }],
    pullRequests: [],
    roleById: ROLES,
    now: NOW,
    graceMs: GRACE,
    backoffMs: BACKOFF,
    ...over,
  });

describe("agentRole", () => {
  test("classifies the live MANTA mesh", () => {
    assert.equal(agentRole("manta-dev"), "implementer");
    assert.equal(agentRole("manta-reviewer"), "reviewer");
    assert.equal(agentRole("manta-pm"), "pm");
    assert.equal(agentRole("manta-ops"), "ops");
  });

  test("works for a differently-prefixed workspace", () => {
    assert.equal(agentRole("tenanture-reviewer"), "reviewer");
    assert.equal(agentRole("tenanture-pm"), "pm");
    assert.equal(agentRole("tenanture-backend"), "implementer");
  });

  test("is case-insensitive", () => {
    assert.equal(agentRole("MANTA-PM"), "pm");
  });

  test("does not read 'pm' out of the middle of a word", () => {
    // A name like "manta-pmail" or "compiler" must not become the PM.
    assert.equal(agentRole("manta-pmail"), "implementer");
    assert.equal(agentRole("manta-opsec-tool"), "implementer");
  });

  test("returns unknown for empty input", () => {
    assert.equal(agentRole(""), "unknown");
    assert.equal(agentRole(null), "unknown");
    assert.equal(agentRole(undefined), "unknown");
  });
});

describe("sortRunsNewestFirst", () => {
  test("puts the most recently settled run first regardless of input order", () => {
    const runs = [
      { id: "old", completed_at: minsAgo(300) },
      { id: "new", completed_at: minsAgo(10) },
      { id: "mid", completed_at: minsAgo(100) },
    ];
    assert.deepEqual(
      sortRunsNewestFirst(runs).map((r) => r.id),
      ["new", "mid", "old"],
    );
  });

  test("falls back through started_at and created_at", () => {
    const runs = [
      { id: "created-only", created_at: minsAgo(200) },
      { id: "started-only", started_at: minsAgo(5) },
    ];
    assert.equal(sortRunsNewestFirst(runs)[0].id, "started-only");
  });

  test("does not mutate its input", () => {
    const runs = [{ id: "a", completed_at: minsAgo(1) }, { id: "b", completed_at: minsAgo(9) }];
    sortRunsNewestFirst(runs);
    assert.equal(runs[0].id, "a");
  });

  test("tolerates non-arrays", () => {
    assert.deepEqual(sortRunsNewestFirst(null), []);
    assert.deepEqual(sortRunsNewestFirst(undefined), []);
  });
});

describe("runSettledAt", () => {
  test("prefers completed_at", () => {
    const t = runSettledAt({ completed_at: minsAgo(10), started_at: minsAgo(60) });
    assert.equal(t, NOW - 10 * 60_000);
  });

  test("returns null when no timestamp parses", () => {
    assert.equal(runSettledAt({}), null);
    assert.equal(runSettledAt({ completed_at: "not-a-date" }), null);
  });
});

describe("screenIssue", () => {
  const screen = (over = {}) =>
    screenIssue({ issue: issue(over), roleById: ROLES, now: NOW, backoffMs: BACKOFF });

  test("accepts an agent-assigned in_review issue", () => {
    assert.deepEqual(screen(), { candidate: true, role: "implementer" });
  });

  test("accepts in_progress too", () => {
    assert.equal(screen({ status: "in_progress" }).candidate, true);
  });

  test("REGRESSION: never touches a human-assigned issue", () => {
    // BET-159 and BET-273 are owned by a person. Paging an agent about them
    // would be noise at best and duplicated work at worst.
    const r = screen({ assignee_type: "member", assignee_id: "human-id" });
    assert.equal(r.candidate, false);
    assert.match(r.reason, /not agent-assigned/);
  });

  test("ignores unassigned issues", () => {
    assert.equal(screen({ assignee_type: null, assignee_id: null }).candidate, false);
  });

  test("accepts todo — the state multica-unblock leaves behind", () => {
    assert.equal(screen({ status: "todo" }).candidate, true);
  });

  test("REGRESSION: leaves `blocked` to multica-unblock", () => {
    // The two sweeps must not both act on one issue: unblock owns `blocked`,
    // unstick owns the live statuses. Overlap would double-fire.
    const r = screen({ status: "blocked" });
    assert.equal(r.candidate, false);
    assert.match(r.reason, /not in scope/);
  });

  test("ignores the terminal statuses", () => {
    assert.equal(screen({ status: "done" }).candidate, false);
    assert.equal(screen({ status: "cancelled" }).candidate, false);
  });

  test("skips issues assigned to ops", () => {
    assert.equal(screen({ assignee_id: OPS }).candidate, false);
  });

  test("skips an assignee that is not a known agent", () => {
    assert.equal(screen({ assignee_id: "stranger" }).candidate, false);
  });

  test("honours the backoff window", () => {
    const r = screen({ metadata: { unstick_last: minsAgo(30) } });
    assert.equal(r.candidate, false);
    assert.match(r.reason, /backoff/);
  });

  test("acts again once the backoff window has passed", () => {
    assert.equal(screen({ metadata: { unstick_last: minsAgo(200) } }).candidate, true);
  });

  test("ignores an unparseable backoff stamp rather than blocking forever", () => {
    assert.equal(screen({ metadata: { unstick_last: "whenever" } }).candidate, true);
  });
});

describe("decideUnstick — the stall it was built for", () => {
  test("REGRESSION (BET-297): implementer left itself on in_review after a done run", () => {
    // Verbatim shape of the live stall: manta-dev completed at 00:30, opened a
    // green PR, set in_review, and never reassigned. Seven hours dead, five
    // downstream issues blocked behind it.
    const r = decide({
      issue: issue({ assignee_id: DEV, status: "in_review" }),
      runs: [
        { status: "completed", completed_at: minsAgo(450), started_at: minsAgo(494) },
        { status: "completed", completed_at: minsAgo(500) },
      ],
      pullRequests: [{ state: "draft" }],
    });
    assert.equal(r.act, true);
    assert.equal(r.action, "assign");
    assert.equal(r.role, "reviewer");
  });

  test("implementer on in_progress with an open PR also goes to the reviewer", () => {
    const r = decide({
      issue: issue({ status: "in_progress" }),
      pullRequests: [{ state: "open" }],
    });
    assert.equal(r.role, "reviewer");
  });

  test("implementer on in_progress with no PR is a no-op run — goes to the PM", () => {
    const r = decide({ issue: issue({ status: "in_progress" }), pullRequests: [] });
    assert.equal(r.act, true);
    assert.equal(r.role, "pm");
    assert.match(r.reason, /no-op/);
  });

  test("a closed PR does not count as a work product", () => {
    const r = decide({
      issue: issue({ status: "in_progress" }),
      pullRequests: [{ state: "closed" }],
    });
    assert.equal(r.role, "pm");
  });

  test("reviewer whose verdict was never routed goes to the PM", () => {
    const r = decide({ issue: issue({ assignee_id: REVIEWER }) });
    assert.equal(r.act, true);
    assert.equal(r.action, "assign");
    assert.equal(r.role, "pm");
  });

  test("a stalled PM is re-run, not reassigned — nothing is downstream of it", () => {
    const r = decide({ issue: issue({ assignee_id: PM }) });
    assert.equal(r.act, true);
    assert.equal(r.action, "rerun");
    assert.equal(r.role, "pm");
  });
});

describe("decideUnstick — the hand-off between the two sweeps", () => {
  test("REGRESSION: a todo left behind by multica-unblock is re-dispatched", () => {
    // multica-unblock flips blocked -> todo, but a STATUS change dispatches
    // nothing (only an assignment or a comment does). Without this rule the
    // unblocked issue sits in todo forever and the two sweeps drop the work
    // between them — exactly the stall they exist to prevent.
    const r = decide({
      issue: issue({ status: "todo", assignee_id: PM }),
      runs: [{ status: "completed", completed_at: minsAgo(90) }],
    });
    assert.equal(r.act, true);
    assert.equal(r.action, "rerun");
    assert.equal(r.role, "pm");
    assert.match(r.reason, /nothing will start it/);
  });

  test("a todo re-dispatch targets the current assignee, whatever its role", () => {
    for (const [assignee, role] of [
      [DEV, "implementer"],
      [REVIEWER, "reviewer"],
      [PM, "pm"],
    ]) {
      const r = decide({ issue: issue({ status: "todo", assignee_id: assignee }) });
      assert.equal(r.action, "rerun");
      assert.equal(r.role, role);
    }
  });

  test("a fresh todo inside the grace window is left alone", () => {
    const r = decide({
      issue: issue({ status: "todo" }),
      runs: [{ status: "completed", completed_at: minsAgo(3) }],
    });
    assert.equal(r.act, false);
  });
});

describe("decideUnstick — assigned but never dispatched", () => {
  test("an agent-assigned issue with no runs at all is re-dispatched", () => {
    const r = decide({ issue: issue({ updated_at: minsAgo(120) }), runs: [] });
    assert.equal(r.act, true);
    assert.equal(r.action, "rerun");
    assert.match(r.reason, /never dispatched/);
  });

  test("REGRESSION: a just-assigned issue is not re-dispatched", () => {
    // The dispatch is asynchronous. Acting inside the grace window would
    // duplicate a run that is about to start on its own.
    const r = decide({ issue: issue({ updated_at: minsAgo(2) }), runs: [] });
    assert.equal(r.act, false);
    assert.match(r.reason, /only 2m old/);
  });

  test("no runs and no usable updated_at does nothing", () => {
    const r = decide({ issue: issue({ updated_at: undefined }), runs: [] });
    assert.equal(r.act, false);
    assert.match(r.reason, /updated_at/);
  });

  test("a queued run still suppresses the no-runs path", () => {
    const r = decide({
      issue: issue({ updated_at: minsAgo(500) }),
      runs: [{ status: "queued" }],
    });
    assert.equal(r.act, false);
  });
});

describe("decideUnstick — cases that must NOT act", () => {
  test("REGRESSION: a run in flight is never a stall, however old", () => {
    // A long multi-hour turn is normal. Re-paging mid-run would abort real work.
    const r = decide({
      runs: [
        { status: "running", started_at: minsAgo(600) },
        { status: "completed", completed_at: minsAgo(700) },
      ],
    });
    assert.equal(r.act, false);
    assert.match(r.reason, /running/);
  });

  test("every active run status suppresses action", () => {
    for (const status of ACTIVE_RUN_STATUSES) {
      const r = decide({ runs: [{ status, created_at: minsAgo(600) }] });
      assert.equal(r.act, false, `${status} must suppress`);
    }
  });

  test("a run that finished inside the grace window is left alone", () => {
    const r = decide({ runs: [{ status: "completed", completed_at: minsAgo(5) }] });
    assert.equal(r.act, false);
    assert.match(r.reason, /cold/);
  });

  test("REGRESSION: an unreadable run timestamp must never read as cold", () => {
    // Defaulting a missing timestamp to 0 would make every such run look
    // infinitely stale and page an agent about work that may have just started.
    const r = decide({ runs: [{ status: "completed" }] });
    assert.equal(r.act, false);
    assert.match(r.reason, /timestamp/);
  });

  test("a failed run still counts as terminal and gets unstuck", () => {
    // A failed run is exactly the case nobody re-fires.
    const r = decide({
      runs: [{ status: "failed", completed_at: minsAgo(90), error: "boom" }],
    });
    assert.equal(r.act, true);
  });

  test("issue-level rejections short-circuit before any run reasoning", () => {
    const r = decide({
      issue: issue({ assignee_type: "member" }),
      runs: [{ status: "completed", completed_at: minsAgo(900) }],
    });
    assert.equal(r.act, false);
    assert.match(r.reason, /not agent-assigned/);
  });

  test("tolerates malformed input", () => {
    assert.equal(decide({ issue: null }).act, false);
    // A null runs payload reads as "no runs", which is the never-dispatched
    // path — safe, because it still has to clear the grace window first.
    assert.equal(decide({ runs: null }).action, "rerun");
    assert.equal(decide({ runs: null, issue: issue({ updated_at: minsAgo(1) }) }).act, false);
    assert.equal(decide({ pullRequests: null, issue: issue({ status: "in_progress" }) }).act, true);
  });
});

describe("constants", () => {
  test("live statuses exclude blocked and the terminal states", () => {
    assert.deepEqual(LIVE_STATUSES, ["todo", "in_progress", "in_review"]);
    for (const s of ["blocked", "done", "cancelled"]) {
      assert.ok(!LIVE_STATUSES.includes(s), `${s} must be out of scope`);
    }
  });

  test("terminal run states are not in the active set", () => {
    for (const s of ["completed", "failed", "cancelled"]) {
      assert.ok(!ACTIVE_RUN_STATUSES.has(s), `${s} must not count as active`);
    }
  });

  test("a merged PR still counts as a work product", () => {
    assert.ok(LIVE_PR_STATES.has("merged"));
    assert.ok(!LIVE_PR_STATES.has("closed"));
  });
});
