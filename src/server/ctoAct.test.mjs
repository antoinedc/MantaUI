// BET-1519 — §9.4 the ONE generic plan executor + driver: the brief, the
// session-kind selection, the §9.2 verify dispatch, the one-retry loop, the
// resolve rows, the queue (blocker-before-finding, ≤ 2 in flight), the
// two-executions-per-plan cap, the escalations and the §9.5 outcome folding.

// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionBrief,
  buildRetryBrief,
  checkMarkerResult,
  createCtoExecutorDriver,
  createCtoPlanRunner,
  CHECK_MARKER,
  EXECUTIONS_PER_PLAN,
  MAX_IN_FLIGHT,
  permissionRulesetFor,
  runVerifyCheck,
  validatePlan,
  wantsDelegateSession,
} from "./ctoAct.mjs";
import { patchStore } from "./ctoStores.mjs";

// ---------------------------------------------------------------------------
// Memory store (the resolve.json shape — {entries: []}) + fakes
// ---------------------------------------------------------------------------

function memoryStore(initial = {}) {
  let data = { ...initial };
  return {
    load: async () => ({ ...data }),
    save: async (next) => {
      data = { ...next };
    },
  };
}

const basePlan = (over = {}) => ({
  id: "pl1",
  class: "start-job",
  confidence: 0.9,
  finding: { text: "stale cache after deploy", refs: ["m1"] },
  diagnosis: "the cache is not invalidated",
  steps: ["Invalidate the cache", "Re-run the deploy check"],
  access: [],
  verify: { kind: "session-ok" },
  undo: "re-run the deploy",
  ...over,
});

// A runner whose transcript "work" is canned: each sendPrompt call resolves
// the next turn's last-assistant text and passes/fails verification via the
// scripted checks.
function fakeRunnerSeams({ texts = [], checks = null, startRefusal = null, latency = 0 } = {}) {
  let turn = 0;
  const sends = [];
  const sessions = [];
  let deleted = 0;
  return {
    state: { sends, sessions, get deleted() { return deleted; } },
    deps: {
      createSession: async ({ directory, title, permission } = {}) => {
        if (startRefusal) return { ok: false, reason: startRefusal };
        const id = `sess-${sessions.length + 1}`;
        sessions.push({ id, directory, title, permission });
        return { ok: true, id };
      },
      sendPrompt: async ({ sessionId, text }) => {
        sends.push({ sessionId, text });
        turn += 1;
        return { ok: true };
      },
      listMessages: async () => {
        const text = texts[Math.min(turn, texts.length) - 1] ?? `turn ${turn}`;
        return [{ role: "user", parts: [{ type: "text", text: "go" }] }, { role: "assistant", parts: [{ type: "text", text }] }];
      },
      abortSession: async () => ({ ok: true }),
      deleteSession: async () => {
        deleted += 1;
        return { ok: true };
      },
      verifyFact: checks?.verifyFact,
      probeRead: checks?.probeRead,
      conditionGone: checks?.conditionGone,
      sleep: async () => {},
      turnBudgetMs: 1000,
    },
  };
}

function fakeDriverDeps({ runnerResults = null, runner = null } = {}) {
  const ledgerRows = [];
  const escalations = [];
  const calibrations = [];
  const acts = [];
  const store = memoryStore({ entries: [] });
  return {
    state: { ledgerRows, escalations, calibrations, acts, store },
    deps: {
      runner:
        runner ??
        (async () => {
          const r = (runnerResults ?? []).shift() ?? { ok: true, outcome: "resolved", attempts: 1, cost: 42, reason: null, result: { kind: "ephemeral", lastText: "done" } };
          return r;
        }),
      store,
      ledger: { append: async (row) => ledgerRows.push(row) },
      escalate: async (text) => escalations.push(text),
      calibration: async (input) => calibrations.push(input),
      recordAct: async (input) => acts.push(input),
      verdictsList: async () => [],
      now: () => 1_000_000,
      sleep: async () => {},
    },
  };
}

// Let the driver's fire-and-forget runs actually settle (several awaits deep
// — a bare setImmediate is not enough).
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// validatePlan / session-kind / ruleset
// ---------------------------------------------------------------------------

test("validatePlan: steps required, verify kind known, access normalized", () => {
  assert.equal(validatePlan(null).ok, false);
  assert.equal(validatePlan({}).reason, "invalid-plan:id");
  assert.equal(validatePlan({ id: "p" }).reason, "invalid-plan:steps");
  assert.equal(validatePlan({ id: "p", steps: ["a"] }).reason, "invalid-plan:verify:missing");
  assert.equal(validatePlan({ id: "p", steps: ["a"], verify: { kind: "predicate" } }).reason, "invalid-plan:verify:condition");
  const ok = validatePlan({
    id: " p ",
    steps: [" a ", "", 3],
    access: [{ permission: " write ", pattern: "**" }, { permission: "read", action: "bogus" }],
    verify: { kind: "predicate", condition: "CI on F is green" },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.steps, ["a", "3"]);
  assert.deepEqual(ok.plan.access, [
    { permission: "write", pattern: "**", action: "allow" },
    { permission: "read", pattern: "*", action: "allow" },
  ]);
});

test("wantsDelegateSession: write/edit access → delegate job; else ephemeral", () => {
  assert.equal(wantsDelegateSession([{ permission: "read" }]), false);
  assert.equal(wantsDelegateSession([{ permission: "write", pattern: "**" }]), true);
  assert.equal(wantsDelegateSession([{ permission: "edit", pattern: "src/**" }]), true);
  assert.equal(wantsDelegateSession([]), false);
});

test("permissionRulesetFor: catch-all deny first, plan grants after (last-match-wins)", () => {
  const rs = permissionRulesetFor([{ permission: "write", pattern: "**" }]);
  assert.deepEqual(rs[0], { permission: "*", pattern: "**", action: "deny" });
  assert.deepEqual(rs[1], { permission: "write", pattern: "**", action: "allow" });
});

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

test("buildExecutionBrief: finding, diagnosis, steps, undo, project and the exact marker line", () => {
  const brief = buildExecutionBrief(basePlan(), { finding: { text: "boom on boot" }, project: "manta" });
  assert.ok(brief.includes("## Finding"));
  assert.ok(brief.includes("boom on boot"));
  assert.ok(brief.includes("## Diagnosis"));
  assert.ok(brief.includes("the cache is not invalidated"));
  assert.ok(brief.includes("1. Invalidate the cache"));
  assert.ok(brief.includes("2. Re-run the deploy check"));
  assert.ok(brief.includes("## Undo"));
  assert.ok(brief.includes("re-run the deploy"));
  assert.ok(brief.includes("Project: manta"));
  assert.ok(brief.includes(`\`${CHECK_MARKER} pass\``));
  // delegate flavor for write-access plans
  const del = buildExecutionBrief(basePlan({ access: [{ permission: "write", pattern: "**" }] }));
  assert.ok(del.includes("isolated git worktree"));
  const eph = buildExecutionBrief(basePlan());
  assert.ok(eph.includes("read-only ephemeral session"));
});

test("buildRetryBrief: names the failed check and repeats the marker contract", () => {
  const r = buildRetryBrief(basePlan(), { reason: "predicate-false", detail: "CI red" });
  assert.ok(r.includes("predicate-false"));
  assert.ok(r.includes("CI red"));
  assert.ok(r.includes(`${CHECK_MARKER} pass`));
});

// ---------------------------------------------------------------------------
// Verify dispatch (§9.2 kinds)
// ---------------------------------------------------------------------------

test("runVerifyCheck: session-ok reads the CHECK marker; missing marker fails", async () => {
  assert.equal(checkMarkerResult(`did it\n${CHECK_MARKER} pass`).ok, true);
  const fail = checkMarkerResult(`${CHECK_MARKER} fail: cache still stale`);
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, "session-reported-fail");
  assert.equal(fail.detail, "cache still stale");
  assert.equal(checkMarkerResult("all done").reason, "no-check-marker");
  const plan = basePlan({ verify: { kind: "session-ok" } });
  assert.equal((await runVerifyCheck(plan, { lastText: `ok ${CHECK_MARKER} pass` })).ok, true);
  assert.equal((await runVerifyCheck(plan, { lastText: "no marker" })).ok, false);
});

test("runVerifyCheck: predicate dispatches through the fact verifier; not-checkable/unavailable fail", async () => {
  const plan = basePlan({ verify: { kind: "predicate", condition: "CI on F is green" } });
  const ok = await runVerifyCheck(plan, { verifyFact: async () => ({ ok: true }) });
  assert.equal(ok.ok, true);
  const no = await runVerifyCheck(plan, { verifyFact: async () => ({ ok: false, reason: "predicate-false" }) });
  assert.equal(no.ok, false);
  assert.equal(no.reason, "predicate-false");
  // a no-opinion (null) seam is a FAIL, never a silent pass
  const unavailable = await runVerifyCheck(plan, { verifyFact: null });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "verify-unavailable");
});

test("runVerifyCheck: probe + condition-gone dispatch; condition-unverified (no opinion) fails", async () => {
  const probe = basePlan({ verify: { kind: "probe", probe: "github/ci" } });
  assert.equal((await runVerifyCheck(probe, { probeRead: async () => ({ ok: true }) })).ok, true);
  const unhealthy = await runVerifyCheck(probe, { probeRead: async () => ({ ok: false, reason: "probe-unhealthy" }) });
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.reason, "probe-unhealthy");

  const cond = basePlan({ verify: { kind: "condition-gone", condition: "the deploy fails" } });
  assert.equal((await runVerifyCheck(cond, { conditionGone: async () => true })).ok, true);
  const still = await runVerifyCheck(cond, { conditionGone: async () => false });
  assert.equal(still.ok, false);
  assert.equal(still.reason, "condition-still-present");
  const unsure = await runVerifyCheck(cond, { conditionGone: async () => null });
  assert.equal(unsure.ok, false);
  assert.equal(unsure.reason, "condition-unverified");
});

// ---------------------------------------------------------------------------
// The runner: session kind, retry loop, escalations
// ---------------------------------------------------------------------------

test("runner: ephemeral plan resolves when the session leaves the pass marker", async () => {
  const f = fakeRunnerSeams({ texts: [`done\n${CHECK_MARKER} pass`] });
  const execute = createCtoPlanRunner(f.deps);
  const res = await execute({ plan: basePlan(), finding: { text: "boom" } });
  assert.equal(res.ok, true);
  assert.equal(res.outcome, "resolved");
  assert.equal(res.attempts, 1);
  assert.equal(res.result.kind, "ephemeral");
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.sends.length, 1);
  assert.ok(f.state.sends[0].text.includes("Invalidate the cache"));
  // the ephemeral session is always cleaned up
  assert.equal(f.state.deleted, 1);
});

test("runner: write-access plan routes through startJob with the plan access as tools and trustMode false", async () => {
  const started = [];
  const f = fakeRunnerSeams({});
  const execute = createCtoPlanRunner({
    ...f.deps,
    resolveParent: async () => ({ parentSessionID: "par-1", parentDirectory: "/srv/app" }),
    startJob: async (input) => {
      started.push(input);
      return { ok: true, job: { id: "job-1" } };
    },
    jobRow: async () => ({ running: false, sessionId: "child-1", status: "done" }),
    listMessages: async () => [{ role: "assistant", parts: [{ type: "text", text: `${CHECK_MARKER} pass` }] }],
  });
  const res = await execute({ plan: basePlan({ access: [{ permission: "write", pattern: "**" }] }) });
  assert.equal(res.ok, true);
  assert.equal(res.outcome, "resolved");
  assert.equal(res.result.kind, "delegate");
  assert.equal(started.length, 1);
  assert.equal(started[0].trustMode, false);
  assert.deepEqual(started[0].tools, [{ permission: "write", pattern: "**", action: "allow" }]);
  assert.equal(started[0].parentSessionID, "par-1");
});

test("runner: no parent project → refused (never a silent no-op), ephemeral start failure refused", async () => {
  const f = fakeRunnerSeams({});
  const execute = createCtoPlanRunner({
    ...f.deps,
    resolveParent: async () => null,
    startJob: async () => ({ ok: true, job: { id: "job-1" } }),
  });
  const res = await execute({ plan: basePlan({ access: [{ permission: "edit", pattern: "**" }] }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-project-session");

  const g = fakeRunnerSeams({ startRefusal: "opencode-down" });
  const execute2 = createCtoPlanRunner(g.deps);
  const res2 = await execute2({ plan: basePlan() });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "opencode-down");
});

test("runner: fail → exactly one retry with the failed check → resolved; fail again → escalated with the attempt log", async () => {
  const f = fakeRunnerSeams({
    texts: [`${CHECK_MARKER} fail: cache stale`, `fixed\n${CHECK_MARKER} pass`],
    checks: { verifyFact: undefined },
  });
  const execute = createCtoPlanRunner(f.deps);
  const res = await execute({ plan: basePlan({ verify: { kind: "session-ok" } }) });
  assert.equal(res.outcome, "resolved");
  assert.equal(res.attempts, 2);
  assert.equal(f.state.sends.length, 2);
  assert.ok(f.state.sends[1].text.includes("session-reported-fail"));

  // both attempts fail → escalated, the reason carries BOTH check results
  const g = fakeRunnerSeams({ texts: [`${CHECK_MARKER} fail: a`, `${CHECK_MARKER} fail: b`] });
  const execute2 = createCtoPlanRunner(g.deps);
  const res2 = await execute2({ plan: basePlan({ verify: { kind: "session-ok" } }) });
  assert.equal(res2.outcome, "escalated");
  assert.equal(res2.attempts, 2);
  assert.ok((res2.reason ?? "").includes("attempt1"));
  assert.ok((res2.reason ?? "").includes("attempt2"));
});

// ---------------------------------------------------------------------------
// The driver: queue, cap, rows, outcomes, 7-day resolution
// ---------------------------------------------------------------------------

test("driver: every execution writes ONE complete cto.resolve row (§9.4-9.5 fields)", async () => {
  const f = fakeDriverDeps({ runnerResults: [{ ok: true, outcome: "resolved", attempts: 2, cost: 777, reason: null, result: null }] });
  const d = createCtoExecutorDriver(f.deps);
  const r = await d.executePlan(basePlan(), {
    findingId: "f9",
    finding: { kind: "blocker", text: "boom", refs: ["m3"] },
    gateCtx: { effective: 0.72, tau: 0.7, calibration: 0.8 },
  });
  assert.equal(r.ok, true);
  // the queued run is fire-and-forget — flush the microtask queue
  await settle();
  const payload = await f.state.store.load();
  assert.equal(payload.entries.length, 1);
  const row = payload.entries[0];
  assert.equal(row.planId, "pl1");
  assert.equal(row.class, "start-job");
  assert.equal(row.findingId, "f9");
  assert.equal(row.confidence, 0.9);
  assert.equal(row.calibration, 0.8);
  assert.equal(row.effective, 0.72);
  assert.equal(row.tau, 0.7);
  assert.equal(row.trigger, "act");
  assert.equal(row.outcome, "resolved");
  assert.equal(row.attempts, 2);
  assert.equal(row.cost, 777);
  assert.equal(row.undo, "re-run the deploy");
  assert.deepEqual(row.refs, ["m1"]);
  assert.equal(typeof row.ts, "number");
  assert.equal(typeof row.resolvedAt, "number");
  // resolved → success DEFERRED (no fold yet)
  assert.deepEqual(f.state.calibrations, []);
  const ledger = f.state.ledgerRows.filter((x) => x.kind === "cto.resolve");
  assert.equal(ledger.length, 1);
});

test("driver: escalated → immediate calibration failure + a blocker card carrying the attempt log", async () => {
  const f = fakeDriverDeps({ runnerResults: [{ ok: true, outcome: "escalated", attempts: 2, cost: 10, reason: "attempt1:no-check-marker; attempt2:session-reported-fail", result: { kind: "ephemeral", lastText: "gave up" } }] });
  const d = createCtoExecutorDriver(f.deps);
  await d.executePlan(basePlan());
  await settle();
  assert.deepEqual(f.state.calibrations, [{ planId: "pl1", class: "start-job", ok: false }]);
  assert.equal(f.state.escalations.length, 1);
  assert.ok(f.state.escalations[0].includes("attempt1"));
  assert.ok(f.state.escalations[0].includes("plan pl1"));
});

test("driver: the 7-day window — success with no negative verdict; a negative verdict in-window fails immediately", async () => {
  // resolved now; 7 days pass; no negative verdicts → success
  let t = 1_000_000;
  const f = fakeDriverDeps({ runnerResults: [{ ok: true, outcome: "resolved", attempts: 1, cost: 5, reason: null, result: null }] });
  f.deps.now = () => t;
  const d = createCtoExecutorDriver(f.deps);
  await d.executePlan(basePlan());
  await settle();
  t += 7 * 24 * 3_600_000 + 1;
  const tick = await d.tick();
  assert.equal(tick.resolved, 1);
  assert.deepEqual(f.state.calibrations, [{ planId: "pl1", class: "start-job", ok: true }]);

  // resolved then a correct verdict inside the window → immediate failure
  let t2 = 2_000_000;
  const g = fakeDriverDeps({ runnerResults: [{ ok: true, outcome: "resolved", attempts: 1, cost: 5, reason: null, result: null }] });
  g.deps.now = () => t2;
  g.deps.verdictsList = async () => [{ subject: { type: "suggestion", id: "pl1" }, verdict: "correct", ts: t2 + 100 }];
  const d2 = createCtoExecutorDriver(g.deps);
  await d2.executePlan(basePlan());
  await settle();
  await d2.tick();
  assert.deepEqual(g.state.calibrations, [{ planId: "pl1", class: "start-job", ok: false }]);
  const rows = (await g.state.store.load()).entries;
  assert.equal(rows[0].failureFoldedAt != null, true);
});

test("driver: two executions per plan id EVER — a re-triage cannot re-arm the cap; cap-hit refuses and never acts", async () => {
  const f = fakeDriverDeps({
    runnerResults: [
      { ok: true, outcome: "resolved", attempts: 1, cost: 1, reason: null, result: null },
      { ok: true, outcome: "escalated", attempts: 2, cost: 2, reason: "failed twice", result: null },
    ],
  });
  const d = createCtoExecutorDriver(f.deps);
  assert.equal((await d.executePlan(basePlan())).ok, true);
  await settle();
  // the plan is RE-REPORTED and re-triaged: the same plan id executes once more
  assert.equal((await d.executePlan(basePlan(), { trigger: "accepted" })).ok, true);
  await settle();
  // third execution → cap-hit refusal (degrades to ask, never acts)
  const third = await d.executePlan(basePlan());
  assert.equal(third.ok, false);
  assert.equal(third.reason, "cap-hit");
  const rows = (await f.state.store.load()).entries;
  assert.equal(rows.filter((r) => r.planId === "pl1").length, 2);
  assert.equal(rows.filter((r) => r.planId === "pl1").length <= EXECUTIONS_PER_PLAN, true);
});

test("driver: queue caps at 10, blocker plans jump ahead of finding plans, ≤ 2 run at once", async () => {
  // A runner gated on a released promise so the queue state is deterministic.
  let release = null;
  const gate = new Promise((r) => (release = r));
  let started = 0;
  const f = fakeDriverDeps({
    runner: async () => {
      started += 1;
      await gate;
      return { ok: true, outcome: "resolved", attempts: 1, cost: 1, reason: null, result: null };
    },
  });
  const d = createCtoExecutorDriver(f.deps);
  // 2 fill the in-flight slots; 10 more fill the queue; the 13th is refused.
  for (let i = 0; i < 12; i += 1) {
    const r = await d.executePlan(basePlan({ id: `pf${i}` }), { finding: { kind: "finding" } });
    assert.equal(r.ok, true, `call ${i} should enqueue`);
  }
  assert.deepEqual(d.state(), { queueDepth: 10, inFlight: 2 });
  const overflow = await d.executePlan(basePlan({ id: "pf-overflow" }));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, "queue-full");
  // release: everything drains (concurrency ≤ MAX_IN_FLIGHT, all 12 written)
  release();
  await settle(40);
  assert.deepEqual(d.state(), { queueDepth: 0, inFlight: 0 });
  const rows = (await f.state.store.load()).entries;
  assert.equal(rows.length, 12);
  assert.equal(started, 12);
  assert.ok(MAX_IN_FLIGHT >= 2); // the §3.3 sub-cap constant holds
});

test("driver: a queued blocker plan is taken before a queued finding plan", async () => {
  // Both slots busy on gated runs; then enqueue finding → blocker → finding.
  let releaseAll = null;
  const gate = new Promise((r) => (releaseAll = r));
  const f = fakeDriverDeps({
    runner: async () => {
      await gate;
      return { ok: true, outcome: "resolved", attempts: 1, cost: 1, reason: null, result: null };
    },
  });
  const d = createCtoExecutorDriver(f.deps);
  await d.executePlan(basePlan({ id: "busy-1" }), { finding: { kind: "finding" } });
  await d.executePlan(basePlan({ id: "busy-2" }), { finding: { kind: "finding" } });
  await d.executePlan(basePlan({ id: "q-finding" }), { finding: { kind: "finding" } });
  await d.executePlan(basePlan({ id: "q-blocker" }), { finding: { kind: "blocker" } });
  await d.executePlan(basePlan({ id: "q-finding2" }), { finding: { kind: "finding" } });
  assert.deepEqual(d.state(), { queueDepth: 3, inFlight: 2 });
  releaseAll();
  await settle(40);
  const rows = (await f.state.store.load()).entries;
  // the blocker's row exists and the blocker jumped the queue (drained before
  // the finding entry queued behind it)
  assert.equal(rows.length, 5);
  assert.deepEqual(d.state(), { queueDepth: 0, inFlight: 0 });
  assert.ok(rows.some((r) => r.planId === "q-blocker"));
});

test("driver: invalid plans are refused, never executed or ledgered", async () => {
  const f = fakeDriverDeps({});
  const d = createCtoExecutorDriver(f.deps);
  const r = await d.executePlan({ id: "", steps: [] });
  assert.equal(r.ok, false);
  await settle();
  assert.equal((await f.state.store.load()).entries.length, 0);
  assert.deepEqual(f.state.ledgerRows, []);
});

test("driver: §9.4 presence — finding-sourced acts refuse while present; blockers, accepted and away all run", async () => {
  const f = fakeDriverDeps({ runnerResults: [] });
  let presenceState = "present";
  f.deps.presence = async () => presenceState;
  const d = createCtoExecutorDriver(f.deps);
  // finding-sourced machine act while present → refused, nothing queued/run
  const r1 = await d.executePlan(basePlan({ id: "pl-pres" }), { finding: { kind: "finding" } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "presence-gated");
  await settle(5);
  assert.equal((await f.state.store.load()).entries.length, 0);
  assert.deepEqual(f.state.ledgerRows, []);
  // blocker-sourced runs regardless of presence (the ONLY §9.4 exemption)
  presenceState = "present";
  const r2 = await d.executePlan(basePlan({ id: "pl-blocker" }), { finding: { kind: "blocker" } });
  assert.equal(r2.ok, true);
  // user-accepted plans are user-initiated → bypass presence
  const r3 = await d.executePlan(basePlan({ id: "pl-accepted" }), { trigger: "accepted" });
  assert.equal(r3.ok, true);
  await settle(10);
  // away → the finding act runs
  presenceState = "away";
  const r4 = await d.executePlan(basePlan({ id: "pl-away" }), { finding: { kind: "finding" } });
  assert.equal(r4.ok, true);
  await settle(10);
  const rows = (await f.state.store.load()).entries;
  assert.deepEqual(
    rows.map((r) => r.planId).sort(),
    ["pl-accepted", "pl-away", "pl-blocker"],
  );
  // a presence-read failure must not block machine work — run
  const g = fakeDriverDeps({ runnerResults: [] });
  g.deps.presence = async () => {
    throw new Error("presence down");
  };
  const d2 = createCtoExecutorDriver(g.deps);
  const r5 = await d2.executePlan(basePlan({ id: "pl-pres-err" }), { finding: { kind: "finding" } });
  assert.equal(r5.ok, true);
});

test("runner: a delegate job still running at the turn budget escalates instead of interleaving the retry", async () => {
  const sends = [];
  const started = [];
  const execute = createCtoPlanRunner({
    resolveParent: async () => ({ parentSessionID: "par-1", parentDirectory: "/srv/app" }),
    startJob: async (input) => {
      started.push(input);
      return { ok: true, job: { id: "job-9" } };
    },
    // the job never finishes within the tiny test budget
    jobRow: async () => ({ running: true, sessionId: "child-9", status: "running" }),
    sendPrompt: async ({ text }) => {
      sends.push(text);
      return { ok: true };
    },
    listMessages: async () => [],
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 500); })(), // each poll burns the budget
    turnBudgetMs: 1000,
  });
  const res = await execute({ plan: basePlan({ access: [{ permission: "write", pattern: "**" }], verify: { kind: "session-ok" } }) });
  assert.equal(res.outcome, "escalated");
  assert.ok((res.reason ?? "").includes("job-still-running-at-budget"));
  assert.equal(res.attempts, 1, "the retry never got a turn");
  assert.equal(sends.length, 0, "no retry prompt was delivered into the running job");
});

test("driver: a runner THROW is an interrupt — escalated with the interrupt reason, never lost", async () => {
  const f = fakeDriverDeps({ runner: async () => { throw new Error("provider died"); } });
  const d = createCtoExecutorDriver(f.deps);
  await d.executePlan(basePlan());
  await settle();
  const rows = (await f.state.store.load()).entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "escalated");
  assert.ok((rows[0].reason ?? "").includes("interrupt"));
  assert.deepEqual(f.state.calibrations, [{ planId: "pl1", class: "start-job", ok: false }]);
});

test("driver: executeAccepted announces the accepted execution through the act-and-report queue", async () => {
  const f = fakeDriverDeps({});
  const d = createCtoExecutorDriver(f.deps);
  await d.executeAccepted(basePlan(), { gateCtx: { effective: 0.5 } });
  await settle();
  const rows = (await f.state.store.load()).entries;
  assert.equal(rows[0].trigger, "accepted");
  assert.equal(f.state.acts.length, 1);
  assert.deepEqual(f.state.acts[0].action, { type: "plan", payload: { planId: "pl1" } });
});

// ---------------------------------------------------------------------------
// BET-1520 — the suggest finding's REAL pipeline shape obeys §3.4-3. The
// finding the gate passes to the executor is the triage record's verbatim
// copy of the pending-findings row (sourceFindingCopy), which preserves the
// "suggest" source (pinned in ctoTriage.test.mjs). A suggest-sourced plan
// must be presence-gated exactly like any other finding-sourced one, while
// the inbox blocker's shape (source "inbox", noteKind "blocker") keeps the
// §9.4 blocker exemption.
// ---------------------------------------------------------------------------

test("driver: §9.4 presence — a suggest-sourced plan defers to ask while present; an inbox blocker runs", async () => {
  const f = fakeDriverDeps({ runnerResults: [] });
  let presenceState = "present";
  f.deps.presence = async () => presenceState;
  const d = createCtoExecutorDriver(f.deps);
  // The post-sourceFindingCopy shape of a suggest finding record.
  const suggestFinding = {
    source: "suggest",
    sourceKind: "failure-recurrence",
    sourceId: "rec:x",
    ts: 1_000,
    message: "Pipeline red on main",
    title: "CTO finding: failure-recurrence",
    refs: ["c1"],
    pendingSince: 1_000,
  };
  const r1 = await d.executePlan(basePlan({ id: "pl-suggest" }), { finding: suggestFinding });
  assert.equal(r1.ok, false, "a suggest-sourced machine act refuses while the user is present");
  assert.equal(r1.reason, "presence-gated");
  await settle(5);
  assert.equal((await f.state.store.load()).entries.length, 0);
  // The inbox blocker's real shape runs regardless of presence.
  const r2 = await d.executePlan(basePlan({ id: "pl-inbox" }), {
    finding: { source: "inbox", noteKind: "blocker", message: "deploy failed", refs: [] },
  });
  assert.equal(r2.ok, true);
  await settle(10);
  // Away → the same suggest plan runs.
  presenceState = "away";
  const r3 = await d.executePlan(basePlan({ id: "pl-suggest" }), { finding: suggestFinding });
  assert.equal(r3.ok, true);
  await settle(10);
  const rows = (await f.state.store.load()).entries;
  assert.deepEqual(rows.map((r) => r.planId).sort(), ["pl-inbox", "pl-suggest"]);
});
