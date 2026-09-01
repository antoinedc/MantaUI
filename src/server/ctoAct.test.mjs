// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCtoActExecutor,
  normalizeQueueTonightPayload,
  normalizeRecordDecisionPayload,
  normalizeStartJobPayload,
} from "./ctoAct.mjs";
import { ACTOR } from "./ctoEngine.mjs";

// ---------------------------------------------------------------------------
// Payload normalization (§9.1 schema → typed executor input)
// ---------------------------------------------------------------------------

test("normalizeRecordDecisionPayload: statement/project/refs required; refs fall back to the finding", () => {
  assert.deepEqual(
    normalizeRecordDecisionPayload({ statement: " Adopt pact ", project: " manta ", refs: ["msg:1", 5, "msg:2"] }),
    { statement: "Adopt pact", project: "manta", refs: ["msg:1", "msg:2"] },
  );
  assert.deepEqual(
    normalizeRecordDecisionPayload({ statement: "s", project: "p" }, { findingRefs: ["ref:9"] }),
    { statement: "s", project: "p", refs: ["ref:9"] },
  );
  assert.equal(normalizeRecordDecisionPayload({ statement: "s", project: "p" }), null);
  assert.equal(normalizeRecordDecisionPayload({ statement: "s", refs: ["r"] }), null);
  assert.equal(normalizeRecordDecisionPayload({ project: "p", refs: ["r"] }), null);
  assert.equal(normalizeRecordDecisionPayload(null), null);
});

test("normalizeStartJobPayload: prompt+cwd required; model passes through in either valid shape", () => {
  assert.deepEqual(normalizeStartJobPayload({ prompt: "Run the sweep", cwd: "/srv/app" }), {
    prompt: "Run the sweep",
    cwd: "/srv/app",
  });
  // the renderer's ask-path spells the directory `directory` — accepted as an alias
  assert.deepEqual(normalizeStartJobPayload({ prompt: "p", directory: "/srv/app" }), { prompt: "p", cwd: "/srv/app" });
  assert.deepEqual(normalizeStartJobPayload({ prompt: "p", cwd: "/srv/app", model: " opus " }), {
    prompt: "p",
    cwd: "/srv/app",
    model: "opus",
  });
  assert.deepEqual(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: { providerID: "anthropic", modelID: "claude", variant: "v" } }), {
    prompt: "p",
    cwd: "c",
    model: { providerID: "anthropic", modelID: "claude", variant: "v" },
  });
  assert.deepEqual(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: { providerID: "a", modelID: "m" } }), {
    prompt: "p",
    cwd: "c",
    model: { providerID: "a", modelID: "m" },
  });
  // a present-but-invalid model refuses the whole act (never silently dropped)
  assert.equal(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: 7 }), null);
  assert.equal(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: ["opus"] }), null);
  assert.equal(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: "" }), null);
  assert.equal(normalizeStartJobPayload({ prompt: "p", cwd: "c", model: { providerID: "a" } }), null);
  assert.equal(normalizeStartJobPayload({ prompt: "", cwd: "c" }), null);
  assert.equal(normalizeStartJobPayload({ prompt: "p" }), null);
  assert.equal(normalizeStartJobPayload(null), null);
});

test("normalizeQueueTonightPayload: name falls back to the finding text; cost is the predictedCost alias", () => {
  assert.deepEqual(
    normalizeQueueTonightPayload(
      { name: "Nightly sweep", prompt: "Sweep it", project: "/srv/app", value: 2, confidence: 0.9, cost: 3, refs: ["a", 1] },
      { findingText: "ignored when a name exists" },
    ),
    { name: "Nightly sweep", prompt: "Sweep it", project: "/srv/app", value: 2, confidence: 0.9, predictedCost: 3, refs: ["a"] },
  );
  assert.deepEqual(
    normalizeQueueTonightPayload({ predictedCost: 1.5 }, { findingText: "Build failures recurred" }),
    { name: "Build failures recurred", predictedCost: 1.5 },
  );
  // non-finite numbers and junk project shapes are dropped, not refused
  assert.deepEqual(
    normalizeQueueTonightPayload({ name: "n", value: "high", confidence: NaN, project: 42 }, {}),
    { name: "n" },
  );
  assert.equal(normalizeQueueTonightPayload({}, { findingText: "" }), null);
  assert.equal(normalizeQueueTonightPayload(null, {}), null);
});

// ---------------------------------------------------------------------------
// The executor — refusal contract + wired paths
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const calls = { proposeFact: [], tonightAdd: [], beginDelegateJob: 0, startDelegateJob: [], gateReleased: 0 };
  const deps = {
    proposeFact: async (input) => {
      calls.proposeFact.push(input);
      return { ok: true };
    },
    tonightAdd: async (task) => {
      calls.tonightAdd.push(task);
      return { ok: true, task: { id: "tq:1" } };
    },
    beginDelegateJob: async () => {
      calls.beginDelegateJob += 1;
      return { ok: true, release: () => (calls.gateReleased += 1) };
    },
    listProjects: async () => [
      { tmuxSession: "app", defaultCwd: "/srv/app", windows: [{ opencodeSessionId: "ses-1", paneCurrentPath: "/srv/app" }] },
    ],
    startDelegateJob: async (input) => {
      calls.startDelegateJob.push(input);
      return { ok: true, job: { id: "job-9" } };
    },
    listDelegateJobs: async () => [],
    ...overrides,
  };
  return { deps, calls };
}

test("executor: record-decision proposes the gatekeeper-checked fact (behavior carried over from BET-1403)", async () => {
  const { deps, calls } = makeDeps();
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "record-decision",
    action: { type: "record-decision", payload: { statement: "Adopt pact", project: "manta" } },
    candidate: { id: "cand-1", finding: { text: "f", refs: ["ref:1"] } },
  });
  assert.deepEqual(out, { ok: true, detail: "decision fact proposed" });
  assert.deepEqual(calls.proposeFact, [{ project: "manta", kind: "decision", statement: "Adopt pact", refs: ["ref:1"], sender: "cto" }]);
});

test("executor: record-decision refusal surfaces the fact route's error", async () => {
  const { deps } = makeDeps({ proposeFact: async () => ({ ok: false, error: "gatekeeper refused" }) });
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "record-decision",
    action: { type: "record-decision", payload: { statement: "s", project: "p", refs: ["r"] } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.deepEqual(out, { ok: false, reason: "gatekeeper refused" });
});

test("executor: queue-tonight adds the normalized task bound to the suggestion (cls + originId)", async () => {
  const { deps, calls } = makeDeps();
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "queue-tonight",
    action: { type: "queue-tonight", payload: { name: "Nightly sweep", prompt: "Sweep it", project: "/srv/app", cost: 2 } },
    candidate: { id: "cand-2", finding: { text: "f", refs: ["ref:2"] } },
  });
  assert.deepEqual(out, { ok: true, detail: "queued for tonight", taskId: "tq:1" });
  assert.deepEqual(calls.tonightAdd, [
    { name: "Nightly sweep", prompt: "Sweep it", project: "/srv/app", predictedCost: 2, refs: ["ref:2"], cls: "queue-tonight", originId: "cand-2" },
  ]);
});

test("executor: queue-tonight refusal carries tonightAdd's own gate error (overnight off, queue full)", async () => {
  for (const error of ["overnight is not enabled (High tier + Overnight switch)", "tonight's queue is full (12) — cancel or edit first"]) {
    const { deps } = makeDeps({ tonightAdd: async () => ({ ok: false, error }) });
    const exec = createCtoActExecutor(deps);
    const out = await exec({
      cls: "queue-tonight",
      action: { type: "queue-tonight", payload: { name: "n" } },
      candidate: { finding: { text: "f", refs: [] } },
    });
    assert.deepEqual(out, { ok: false, reason: error });
  }
});

test("executor: start-job starts a worktree-isolated delegate job as actor cto under the §3.3 gate", async () => {
  const { deps, calls } = makeDeps();
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "start-job",
    action: { type: "start-job", payload: { prompt: "Investigate flaky tests", cwd: "/srv/app", model: "opus" } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.deepEqual(out, { ok: true, detail: "delegate job started", jobId: "job-9" });
  assert.equal(calls.beginDelegateJob, 1);
  assert.equal(calls.gateReleased, 1);
  assert.deepEqual(calls.startDelegateJob, [
    { prompt: "Investigate flaky tests", model: "opus", parentSessionID: "ses-1", parentDirectory: "/srv/app", actor: ACTOR },
  ]);
});

test("executor: start-job refuses at the §3.3 concurrent cto-delegate cap without arming the gate", async () => {
  const { deps, calls } = makeDeps({
    listDelegateJobs: async () => [
      { id: "a", actor: ACTOR, status: "running" },
      { id: "b", actor: ACTOR, status: "running" },
      { id: "c", actor: "user", status: "running" },
    ],
  });
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "start-job",
    action: { type: "start-job", payload: { prompt: "p", cwd: "/srv/app" } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "rate_limit:concurrentDelegate");
  assert.equal(calls.beginDelegateJob, 0);
  assert.equal(calls.startDelegateJob.length, 0);
});

test("executor: start-job refuses when no tracked project session hosts the cwd (gate never armed)", async () => {
  const { deps, calls } = makeDeps({ listProjects: async () => [] });
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "start-job",
    action: { type: "start-job", payload: { prompt: "p", cwd: "/elsewhere" } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.deepEqual(out, { ok: false, reason: "no-project-session" });
  assert.equal(calls.beginDelegateJob, 0);
});

test("executor: start-job refusal from the delegate engine degrades with its error and releases the gate", async () => {
  const { deps, calls } = makeDeps({
    startDelegateJob: async () => ({ ok: false, error: "at MAX_RUNNING_JOBS" }),
  });
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "start-job",
    action: { type: "start-job", payload: { prompt: "p", cwd: "/srv/app" } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.deepEqual(out, { ok: false, reason: "at MAX_RUNNING_JOBS" });
  assert.equal(calls.beginDelegateJob, 1);
  assert.equal(calls.gateReleased, 1);
});

test("executor: a §3.3 gate refusal (kill switch / pause) refuses the act before any start", async () => {
  const { deps, calls } = makeDeps({ beginDelegateJob: async () => ({ ok: false, error: "cto_paused" }) });
  const exec = createCtoActExecutor(deps);
  const out = await exec({
    cls: "start-job",
    action: { type: "start-job", payload: { prompt: "p", cwd: "/srv/app" } },
    candidate: { finding: { text: "f", refs: [] } },
  });
  assert.deepEqual(out, { ok: false, reason: "cto_paused" });
  assert.equal(calls.startDelegateJob.length, 0);
  assert.equal(calls.gateReleased, 0);
});

// ---------------------------------------------------------------------------
// Refusal contract: class/action coherence, unknown classes, unwired deps
// ---------------------------------------------------------------------------

test("executor: class and action.type must agree (act bookkeeping is per-class)", async () => {
  const { deps, calls } = makeDeps();
  const exec = createCtoActExecutor(deps);
  assert.deepEqual(
    await exec({ cls: "start-job", action: { type: "record-decision", payload: { statement: "s", project: "p", refs: ["r"] } } }),
    { ok: false, reason: "class-mismatch" },
  );
  assert.deepEqual(await exec({ cls: undefined, action: { type: "start-job", payload: {} } }), { ok: false, reason: "class-mismatch" });
  assert.deepEqual(await exec({ cls: "start-job", action: null }), { ok: false, reason: "class-mismatch" });
  assert.equal(calls.startDelegateJob.length, 0);
});

test("executor: §9.3-ineligible and data-unreachable classes refuse as unwired (veto-window fallback)", async () => {
  const exec = createCtoActExecutor(makeDeps().deps);
  assert.deepEqual(await exec({ cls: "config-change", action: { type: "config-change", payload: { patch: {} } } }), {
    ok: false,
    reason: "no-executor",
  });
  assert.deepEqual(await exec({ cls: "tool-write", action: { type: "tool-write", payload: { tool: "t" } } }), {
    ok: false,
    reason: "no-executor",
  });
  assert.deepEqual(await exec({ cls: "unknown", action: { type: "unknown", payload: {} } }), { ok: false, reason: "no-executor" });
});

test("executor: an unwired dep refuses its class as no-executor; malformed payloads refuse as incomplete", async () => {
  const { deps } = makeDeps();
  const noTonight = createCtoActExecutor({ ...deps, tonightAdd: null });
  assert.deepEqual(
    await noTonight({ cls: "queue-tonight", action: { type: "queue-tonight", payload: { name: "n" } } }),
    { ok: false, reason: "no-executor" },
  );
  const noDelegate = createCtoActExecutor({ ...deps, startDelegateJob: null, beginDelegateJob: null });
  assert.deepEqual(
    await noDelegate({ cls: "start-job", action: { type: "start-job", payload: { prompt: "p", cwd: "/srv/app" } } }),
    { ok: false, reason: "no-executor" },
  );
  const exec = createCtoActExecutor(deps);
  assert.deepEqual(await exec({ cls: "start-job", action: { type: "start-job", payload: {} } }), { ok: false, reason: "incomplete-payload" });
  assert.deepEqual(await exec({ cls: "queue-tonight", action: { type: "queue-tonight", payload: {} }, candidate: { finding: { text: "", refs: [] } } }), {
    ok: false,
    reason: "incomplete-payload",
  });
  assert.deepEqual(await exec({ cls: "record-decision", action: { type: "record-decision", payload: {} } }), {
    ok: false,
    reason: "incomplete-payload",
  });
});
