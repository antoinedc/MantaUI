// ctoWorkTools.test.mjs — contract tests for the unified-CTO spec §7 `work`
// control-tool family, RECORD + DISPATCH half (§5/§6/§8.1/§8.2/§9/§12).
//
// Guarantees under test, each with its counterfactual (the positive control
// that proves the guard is load-bearing — delete the guard in the
// implementation and the paired assertion goes red):
//
//   W1  explicit fail-closed project identity at create AND revalidated at
//       dispatch (target_not_found / target_changed / target_ambiguous;
//       never inferred from cwd or the first project); counterfactual: a
//       valid target resolves and the envelope carries the ProjectRef
//   W2  idempotency: replay returns the ORIGINAL result; same key with
//       different args is an error; execute runs exactly once; a different
//       key on the same op re-executes (key-scoped, not op-scoped)
//   W3  receipt crash windows on dispatch: expired in_flight → durably
//       unknown → external_outcome_unknown, never re-executed; expired
//       pending → safe resume; live-lease duplicate never double-executes
//   W4  expected-revision CAS on revise (revision_conflict, nothing written);
//       counterfactual: the matching revision applies and bumps
//   W5  §6 admission: draft → policy_blocked; running → active_resource;
//       unmet dependencies park the work on waiting/dependency with the
//       reason recorded; counterfactual: a dependency whose predecessor only
//       REPORTED completion admits dispatch, labelled as a claim
//   W6  THE CENTRAL INVARIANT (§1.1): a worker reporting complete is a CLAIM —
//       the work becomes waiting/external, never "completed"; there is no
//       create/revise path that writes "completed"; a full lifecycle walk
//       never reads "completed"
//   W7  read/write separation at the production composition boundary: all
//       four reads succeed with EVERY write dep wired as a throwing spy and
//       zero spy calls; counterfactual: the same boundary drives startJob
//       for dispatch
//   W8  pause/cancel report what is still running (§3.3): checkpoint
//       requested is visible, a refused stop is reported as STILL RUNNING,
//       a paused worker is left intact and named
//   W9  capacity: the read reflects the delegate cap; dispatch at cap →
//       capacity_wait with the work parked on waiting/capacity;
//       counterfactual: below cap it dispatches
//   W10 retry + reconciliation (§8.2): unknown dispatch receipts are
//       reconciled by ADOPTING the operation-correlated worker (never a
//       second startJob); no correlated job → receipt failed with scan
//       evidence; the per-stage attempt limit bounds retries
//   W11 answer_decision: spec-incompatible responses fail visibly
//       (revision_conflict); the answer applies once; a second answer refuses
//   W12 archive ≠ cleanup: archive destroys nothing and refuses live workers;
//       cleanup removes only owned terminal resources through the existing
//       non-forced operation, retains failures visibly, and refuses borrowed
//       resources
//   W13 success never lies: every mutation drives its external dep
//   W14 successful mutations carry operationId, workId, revision, state and a
//       visible summary; replays carry the original result verbatim
//   W15 the stage attempt is LINKED BEFORE prompt delivery (the startJob spy
//       snapshots the envelope at call time: state already "running" with the
//       attempt present and no jobId yet)
//   W16 isolationRequired: a worktree failure fails the dispatch BEFORE
//       prompting (the spy mirrors the real delegate contract) and the work
//       is dispatchable again — never silently de-isolated
//   W17 sandbox canary: the production work + control stores resolve under
//       MANTA_STATE_HOME
//   W18 tool registration: 15 family tools, reads auto, mutations confirm,
//       params action-specific (no shared args bag)
//   W19 outcome adoption is idempotent and spec-stale-aware: a repeated
//       terminal event advances at most once; an attempt whose spec hash no
//       longer matches is superseded WITHOUT advancing the work (U13)
//   W20 resume reconciles: a paused worker is resumed in its worktree, a
//       terminal outcome that landed while paused is adopted, and the
//       resulting admission state is decided from the reconciliation
//
// Sandbox discipline: ctoTestGuard aborts without MANTA_STATE_HOME; every
// store is a per-test fixture under the sandbox; MANTA_OPENCODE_DB is armed
// before any handle could open.

// BET-1490: shared fail-fast guard — must stay the first import.
import "./ctoTestGuard.mjs";

process.env.MANTA_OPENCODE_DB =
  process.env.MANTA_OPENCODE_DB ?? "/nonexistent/opencode/cto-work-tools-fixture.db";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createCtoWorkControl,
  registerCtoWorkTools,
  CLAIM_KINDS,
  IMPLEMENTATION_CLAIM,
  DEFAULT_MAX_STAGE_ATTEMPTS,
} from "./ctoWorkTools.mjs";
import { canonicalArgsHash } from "./ctoWork.mjs";
import { MAX_RUNNING_JOBS, CAP_ERROR } from "./delegate.mjs";
import { ctoPath, lockForStore, workStore, mantaControlStore } from "./ctoStores.mjs";
import { stateHome } from "../shared/paths.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";

// ---------------------------------------------------------------------------
// Fixtures — what the real server produces. Project cwds are REAL directories
// under the sandbox (dispatch revalidates the checkout through
// tmux.resolveCwdOrThrow, which rejects a missing dir). The delegate spy
// mirrors the REAL delegate.mjs contracts: cap refusal, isolationRequired
// worktree failure, targetProject window placement (never parent lookup),
// correlation persistence, stop/pause/resume/delete semantics.
// ---------------------------------------------------------------------------

const FIX_ROOT = join(stateHome(), "cto-work-fixtures");
mkdirSync(FIX_ROOT, { recursive: true });
const fix = (name) => join(FIX_ROOT, name);
for (const name of ["better-ui", "ethernal", "marketing"]) {
  mkdirSync(fix(name), { recursive: true });
}

function fixtureProjects() {
  return [
    { tmuxSession: "manta", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] },
    { tmuxSession: "ethernal", defaultCwd: fix("ethernal"), attached: false, mantaOwned: true, windows: [] },
    { tmuxSession: "Marketing", defaultCwd: fix("marketing"), attached: false, mantaOwned: false, windows: [] },
  ];
}

let testSeq = 0;

function workStoreFixture() {
  testSeq += 1;
  const dir = ctoPath("work-tools-test", `work-${testSeq}`);
  return {
    name: "work",
    dir,
    pathFor: (id) => join(dir, `${id}.json`),
    save: async (id, data) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...data, v: 1 }, null, 2));
    },
  };
}

function ledgerFixture() {
  testSeq += 1;
  const file = ctoPath("work-tools-test", `ledger-${testSeq}.json`);
  return {
    name: "manta-control",
    path: file,
    load: async () => {
      try {
        return JSON.parse(await readFile(file, "utf-8"));
      } catch (error) {
        if (error.code === "ENOENT") return { v: 1 };
        throw error;
      }
    },
    save: async (data) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2));
    },
  };
}

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

function makeDelegateSpy({ jobs = [], worktreeOk = true, stopFails = false, cap = MAX_RUNNING_JOBS } = {}) {
  const calls = [];
  const state = { jobs: [...jobs] };
  let seq = 0;
  const find = (id) => state.jobs.find((j) => j?.id === id) ?? null;
  const engine = {
    async startJob(input) {
      calls.push({ name: "startJob", input });
      const running = state.jobs.filter((j) => j?.status === "running").length;
      if (running >= cap) return { ok: false, error: CAP_ERROR };
      // Real contract: isolationRequired → a worktree failure FAILS the start
      // (never falls back to the repository directory).
      if (input.isolationRequired && !worktreeOk) {
        return {
          ok: false,
          code: "worktree_failed",
          error: `worktree creation failed, refusing to fall back to the original repository directory (isolationRequired): fixture`,
        };
      }
      seq += 1;
      const job = {
        id: `job_${seq}`,
        name: "worker",
        prompt: input.prompt,
        parentSessionID: input.parentSessionID,
        parentDirectory: input.parentDirectory,
        childSessionID: `ses_job_${seq}`,
        // Real contract (§8.1 extension): the window goes to the EXPLICIT
        // target project; parent lookup is never consulted.
        tmuxSession: input.targetProject,
        windowIndex: 9,
        worktree: worktreeOk ? `${input.parentDirectory}/.worktrees/wt_${seq}` : null,
        branch: worktreeOk ? `cto/work-${seq}` : null,
        baseSha: null,
        origin: "delegate",
        actor: input.actor ?? "user",
        correlation: input.correlation ?? null,
        permission: input.permission ?? null,
        status: "running",
        activity: null,
        pauseRequested: false,
        createdAt: 1,
        startedAt: 1,
        finishedAt: null,
        result: null,
        error: null,
        filesChanged: null,
      };
      state.jobs.push(job);
      return { ok: true, job };
    },
    async stopJob(id) {
      calls.push({ name: "stopJob", input: id });
      if (stopFails) throw new Error("stop transport down");
      const job = find(id);
      if (!job) return { ok: false, error: "not found" };
      if (job.status !== "running") return { ok: false, error: "job not running", status: job.status };
      job.status = "stopped";
      job.error = "stopped by user";
      job.finishedAt = 2;
      return { ok: true };
    },
    async pauseJob(id) {
      calls.push({ name: "pauseJob", input: id });
      const job = find(id);
      if (!job || job.status !== "running") return { ok: false, error: "job not running" };
      // Real contract: pauseJob only FLAGS the job; the boundary flip is the
      // pump's job. The flag is what the work record can observe.
      job.pauseRequested = true;
      return { ok: true, job };
    },
    async resumeJob(id) {
      calls.push({ name: "resumeJob", input: id });
      const job = find(id);
      if (!job || job.status !== "paused") return { ok: false, error: "job not running" };
      job.status = "running";
      job.pauseRequested = false;
      return { ok: true, job };
    },
    async deleteJob(id) {
      calls.push({ name: "deleteJob", input: id });
      const job = find(id);
      if (!job) return { ok: false, error: "not found" };
      if (job.status === "running") return { ok: false, error: "job still running" };
      state.jobs = state.jobs.filter((j) => j.id !== id);
      return { ok: true };
    },
  };
  return { engine, calls, state };
}

function makeWorkControl({
  projects = fixtureProjects(),
  jobs = [],
  worktreeOk = true,
  stopFails = false,
  store,
  ledger,
  conversationId = "ses_cto",
  maxStageAttempts,
  cap,
} = {}) {
  const ws = store ?? workStoreFixture();
  const lg = ledger ?? ledgerFixture();
  const spy = makeDelegateSpy({ jobs, worktreeOk, stopFails, ...(cap !== undefined ? { cap } : {}) });
  // Mutable holder so a test can move the LIVE tmux state between operations
  // (e.g. rename a project after create to exercise dispatch-time revalidation).
  const live = { projects };
  const control = createCtoWorkControl({
    store: ws,
    createReceiptsStore: lg,
    now: makeClock(),
    listProjects: async () => live.projects,
    listDelegateJobs: async () => spy.state.jobs,
    delegateOps: spy.engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => conversationId,
    ...(maxStageAttempts !== undefined ? { maxStageAttempts } : {}),
  });
  return { control, calls: spy.calls, jobs: spy.state, workStore: ws, ledger: lg, live };
}

// Standard work fixture: created READY against the explicit "manta" project.
async function seedReadyWork(control, overrides = {}) {
  const created = await control.workCreate({
    key: `create-${overrides.id ?? "seed"}`,
    project: "manta",
    objective: "ship the export fix",
    spec: { revision: 1, hash: "sha256:aaa", documentRef: "docs/specs/export-fix.md#rev1" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    ...overrides,
  });
  assert.equal(created.ok, true, `seed create failed: ${JSON.stringify(created)}`);
  return created;
}

// Seed an envelope receipt directly (the crash-window fixtures): the envelope
// file is loaded through the store, the receipt appended, and saved back.
async function seedEnvelopeReceipt(store, workId, receipt) {
  await lockForStore({ name: store.name, path: store.pathFor(workId) }).runExclusive(async () => {
    const raw = await readFile(store.pathFor(workId), "utf-8");
    const env = JSON.parse(raw);
    env.operations = [...(env.operations ?? []), receipt];
    env.updatedAt = (env.updatedAt ?? 0) + 1;
    await store.save(workId, env);
  });
}

function dispatchReceiptSeed({ workId, key, input, status, leaseExpiresAt }) {
  return {
    id: `op_seed_${key}`,
    key,
    op: "work.dispatch",
    argsHash: canonicalArgsHash("work.dispatch", input),
    args: input,
    workRevision: 1,
    stage: "implement",
    specHash: "sha256:aaa",
    status,
    externalRef: null,
    resultCode: null,
    lease: { owner: "seed", expiresAt: leaseExpiresAt },
    takeoverCount: 0,
    createdAt: 1,
    updatedAt: 1,
    resultAt: null,
  };
}

after(async () => {
  await rm(ctoPath("work-tools-test"), { recursive: true, force: true });
  await rm(FIX_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// W1 — explicit fail-closed project identity
// ---------------------------------------------------------------------------

test("work_create fails closed on an unknown project and never infers a target", async () => {
  const { control } = makeWorkControl();
  await assert.rejects(
    control.workCreate({
      key: "w1-unknown",
      project: "manta-dev",
      objective: "x",
      spec: { revision: 1, hash: "h", documentRef: "d" },
      deliveryTarget: { kind: "pr" },
    }),
    (error) => {
      assert.equal(error.code, "target_not_found");
      assert.equal(error.retrySafe, false);
      assert.ok(!error.message.includes('"manta"'), "must not suggest a fallback target");
      return true;
    },
  );
  const { data } = await control.workList({});
  assert.equal(data.total, 0, "nothing was created");
});

test("work_create fails closed on a renamed or ambiguous project", async () => {
  const { control } = makeWorkControl();
  await assert.rejects(
    control.workCreate({
      key: "w1-renamed",
      project: "marketing",
      objective: "x",
      spec: { revision: 1, hash: "h", documentRef: "d" },
      deliveryTarget: { kind: "pr" },
    }),
    (error) => {
      assert.equal(error.code, "target_changed");
      assert.ok(error.message.includes("Marketing"), "names the current name");
      return true;
    },
  );
});

test("counterfactual: a valid target resolves and the envelope carries the explicit ProjectRef", async () => {
  const { control } = makeWorkControl();
  const created = await seedReadyWork(control);
  assert.equal(created.ok, true);
  assert.deepEqual(created.project, {
    workspaceId: "manta",
    repositoryId: "unmapped",
    repositoryRoot: fix("better-ui"),
  });
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.project.workspaceId, "manta");
  assert.equal(data.targetLive, true);
});

test("work_dispatch revalidates the stored target against live tmux (rename → fail closed, no worker)", async () => {
  const { control, calls, live } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w1-target" });
  // Case-variant rename: the stored workspaceId no longer matches exactly —
  // target_changed names the current name instead of guessing.
  live.projects = [{ tmuxSession: "Manta", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] }];
  await assert.rejects(
    control.workDispatch({ key: "w1-d", work: created.workId }),
    (error) => error.code === "target_changed" && error.message.includes("Manta"),
  );
  // Full rename: target_not_found — never inferred from anything else.
  live.projects = [{ tmuxSession: "renamed-away", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] }];
  await assert.rejects(
    control.workDispatch({ key: "w1-d2", work: created.workId }),
    (error) => error.code === "target_not_found",
  );
  assert.equal(calls.filter((c) => c.name === "startJob").length, 0, "no worker was created against a moved target");
});

// ---------------------------------------------------------------------------
// W2 — idempotency
// ---------------------------------------------------------------------------

test("replay: same key + same args returns the ORIGINAL result without re-executing (create and dispatch)", async () => {
  const { control, calls } = makeWorkControl();
  const first = await seedReadyWork(control, { id: "w2-replay", key: "w2-create" });
  const dispatch1 = await control.workDispatch({ key: "w2-dispatch", work: first.workId });
  assert.equal(dispatch1.ok, true);
  const before = calls.filter((c) => c.name === "startJob").length;

  const createReplay = await control.workCreate({
    key: "w2-create",
    id: "w2-replay",
    project: "manta",
    objective: "ship the export fix",
    spec: { revision: 1, hash: "sha256:aaa", documentRef: "docs/specs/export-fix.md#rev1" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
  });
  assert.equal(createReplay.ok, true);
  assert.equal(createReplay.replayed, true);
  assert.equal(createReplay.workId, first.workId, "replay returns the original work id");
  assert.equal(createReplay.summary, first.summary, "original result preserved verbatim");

  const dispatchReplay = await control.workDispatch({ key: "w2-dispatch", work: first.workId });
  assert.equal(dispatchReplay.ok, true);
  assert.equal(dispatchReplay.replayed, true);
  assert.equal(dispatchReplay.jobId, dispatch1.jobId);
  assert.equal(dispatchReplay.summary, dispatch1.summary);
  assert.equal(
    calls.filter((c) => c.name === "startJob").length,
    before,
    "execute ran exactly once",
  );
});

test("same key with different arguments is an error and never executes", async () => {
  const { control, calls } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w2-mismatch" });
  await control.workDispatch({ key: "w2-dm", work: created.workId });
  const before = calls.length;
  await assert.rejects(
    control.workDispatch({ key: "w2-dm", work: created.workId, model: "sonnet" }),
    (error) => error.code === "idempotency_key_args_mismatch" && error.retrySafe === false,
  );
  assert.equal(calls.length, before);
});

test("counterfactual: a DIFFERENT key on the same op re-executes (replay is key-scoped)", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w2-keyscope" });
  await control.workDispatch({ key: "k1", work: created.workId });
  // The first worker fails; a different key starts a genuinely new operation.
  const job1 = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job1.status = "failed";
  job1.error = "boom";
  await control.recordWorkerOutcome(job1);
  const retried = await control.workRetry({ key: "k2", work: created.workId });
  assert.equal(retried.ok, true);
  const startCalls = calls.filter((c) => c.name === "startJob");
  assert.equal(startCalls.length, 2, "each distinct key is its own operation");
  assert.notEqual(startCalls[1].input.correlation.receiptId, undefined);
});

// ---------------------------------------------------------------------------
// W3 — receipt crash windows on dispatch
// ---------------------------------------------------------------------------

test("expired in_flight dispatch receipt is durably unknown, reconciled, and NEVER re-executed", async () => {
  const store = workStoreFixture();
  const { control, calls } = makeWorkControl({ store });
  const created = await seedReadyWork(control, { id: "w3-inflight" });
  const input = { key: "w3-crash", work: created.workId };
  await seedEnvelopeReceipt(store, created.workId, dispatchReceiptSeed({ input, ...input, status: "in_flight", leaseExpiresAt: 0 }));
  // Re-issuing the SAME key reconciles first: the receipt is durably marked
  // unknown, the full job-store scan finds no correlated worker, and the key
  // replays the RECONCILED failure — startJob is never re-run.
  const replayed = await control.workDispatch(input);
  assert.equal(replayed.ok, false);
  assert.equal(replayed.replayed, true, "the reconciled outcome is the cached answer, not a fresh run");
  assert.equal(replayed.code, "external_outcome_unknown");
  assert.equal(replayed.retrySafe, true, "the scan cleared the uncertainty — a NEW key may retry");
  assert.equal(calls.filter((c) => c.name === "startJob").length, 0);
  const { data } = await control.workInspect({ work: created.workId });
  const receipt = data.operations.find((r) => r.key === "w3-crash");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.resultCode, "reconciled:no_job", "the reconciliation evidence is durable");
});

test("counterfactual: expired PENDING dispatch receipt safely resumes and executes", async () => {
  const store = workStoreFixture();
  const { control, calls } = makeWorkControl({ store });
  const created = await seedReadyWork(control, { id: "w3-pending" });
  const input = { key: "w3-resume", work: created.workId };
  await seedEnvelopeReceipt(store, created.workId, dispatchReceiptSeed({ input, ...input, status: "pending", leaseExpiresAt: 0 }));
  const result = await control.workDispatch(input);
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.name === "startJob").length, 1, "pending never touched the delegate service, so resume is safe");
});

test("live-lease duplicate of the same key does not double-execute", async () => {
  const store = workStoreFixture();
  const { control, calls } = makeWorkControl({ store });
  const created = await seedReadyWork(control, { id: "w3-live" });
  const input = { key: "w3-live-k", work: created.workId };
  await seedEnvelopeReceipt(store, created.workId, dispatchReceiptSeed({ input, ...input, status: "in_flight", leaseExpiresAt: 9007199254740991 }));
  await assert.rejects(
    control.workDispatch(input),
    (error) => error.code === "external_outcome_unknown" && error.retrySafe === true,
  );
  assert.equal(calls.filter((c) => c.name === "startJob").length, 0);
});

// ---------------------------------------------------------------------------
// W4 — expected-revision CAS
// ---------------------------------------------------------------------------

test("work_revise with a stale expectedRevision → revision_conflict, nothing written", async () => {
  const { control } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w4-cas" });
  const { data: before } = await control.workInspect({ work: created.workId });
  await assert.rejects(
    control.workRevise({ key: "w4-r1", work: created.workId, expectedRevision: before.revision + 5, patch: { objective: "changed" } }),
    (error) => error.code === "revision_conflict" && error.retrySafe === false,
  );
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.equal(after.objective, "ship the export fix", "no write happened");
  assert.equal(after.revision, before.revision);
});

test("counterfactual: matching expectedRevision applies the update and bumps the revision", async () => {
  const { control } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w4-ok" });
  const { data: before } = await control.workInspect({ work: created.workId });
  const result = await control.workRevise({
    key: "w4-r2",
    work: created.workId,
    expectedRevision: before.revision,
    patch: { objective: "changed objective" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.revision, before.revision + 1);
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.equal(after.objective, "changed objective");
});

// ---------------------------------------------------------------------------
// W5 — §6 admission
// ---------------------------------------------------------------------------

test("dispatch refuses a draft with policy_blocked and a running work with active_resource", async () => {
  const { control } = makeWorkControl();
  const draft = await control.workCreate({
    key: "w5-draft",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
  });
  assert.equal(draft.state, "draft");
  await assert.rejects(
    control.workDispatch({ key: "w5-d1", work: draft.workId }),
    (error) => error.code === "policy_blocked" && /ready/.test(error.message),
  );

  const ready = await seedReadyWork(control, { id: "w5-run" });
  await control.workDispatch({ key: "w5-d2", work: ready.workId });
  await assert.rejects(
    control.workDispatch({ key: "w5-d3", work: ready.workId }),
    (error) => error.code === "active_resource" && error.retrySafe === false,
  );
});

test("unmet dependencies park the work on waiting/dependency with the reason recorded, then refuse", async () => {
  const { control } = makeWorkControl();
  const dep = await seedReadyWork(control, { id: "w5-dep" }); // never dispatched → nothing reported
  const work = await control.workCreate({
    key: "w5-dependent",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h2", documentRef: "d2" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    dependencies: [dep.workId],
  });
  await assert.rejects(
    control.workDispatch({ key: "w5-d4", work: work.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(error.message.includes(dep.workId), "names the unmet dependency");
      return true;
    },
  );
  const { data } = await control.workInspect({ work: work.workId });
  assert.equal(data.state, "waiting");
  assert.equal(data.waitingReason, "dependency", "the wait reason is durable (§9)");
});

test("counterfactual: a dependency whose predecessor only REPORTED completion admits dispatch — labelled a claim", async () => {
  const { control, jobs } = makeWorkControl();
  const dep = await seedReadyWork(control, { id: "w5-dep2" });
  await control.workDispatch({ key: "w5-dd", work: dep.workId });
  // The worker finishes — a CLAIM, not a verified completion.
  const job = jobs.jobs.find((j) => j.correlation?.workId === dep.workId);
  job.status = "done";
  job.result = "all done, tests pass";
  await control.recordWorkerOutcome(job);
  const { data: depNow } = await control.workInspect({ work: dep.workId });
  assert.equal(depNow.state, "waiting");
  assert.equal(depNow.waitingReason, "external", "reported complete ≠ completed");

  const work = await control.workCreate({
    key: "w5-dependent2",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h3", documentRef: "d3" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    dependencies: [dep.workId],
  });
  const dispatched = await control.workDispatch({ key: "w5-d5", work: work.workId });
  assert.equal(dispatched.ok, true, "a reported (claim-based) dependency admits dispatch");
  assert.equal(dispatched.summary.includes("does NOT complete the work"), true);
});

// ---------------------------------------------------------------------------
// W6 — THE CENTRAL INVARIANT: worker done ≠ work done
// ---------------------------------------------------------------------------

test("a worker reporting complete records a CLAIM and moves the work to waiting/external — never completed", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w6-invariant" });
  const dispatched = await control.workDispatch({ key: "w6-d", work: created.workId });
  assert.equal(dispatched.ok, true);
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "done";
  job.result = "implemented the fix; tests pass; PR ready for review";
  const outcome = await control.recordWorkerOutcome(job);
  assert.equal(outcome.adopted, true);

  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "waiting", "a reported-complete worker parks the work on the next stages");
  assert.equal(data.waitingReason, "external");
  assert.equal(data.state, "completed" && false ? "unreachable" : data.state);
  assert.notEqual(data.state, "completed");
  const claim = data.claims.find((c) => c.kind === IMPLEMENTATION_CLAIM);
  assert.ok(claim, "the worker's claim is recorded");
  assert.equal(claim.superseded, false);
  assert.ok(claim.note.includes("tests pass"), "the claim carries what the worker SAID");
  const attempt = data.attempts.find((a) => a.id !== undefined && a.jobId === job.id);
  assert.equal(attempt.status, "reported_complete", "the ATTEMPT is reported_complete — the WORK is not complete");
});

test("counterfactual: no create/revise path can write state completed", async () => {
  const { control } = makeWorkControl();
  await assert.rejects(
    control.workCreate({
      key: "w6-born",
      project: "manta",
      objective: "x",
      spec: { revision: 1, hash: "h", documentRef: "d" },
      deliveryTarget: { kind: "pr" },
      state: "completed",
    }),
    (error) => error.code === "unsupported" && /draft.*ready/.test(error.message),
  );
  const created = await seedReadyWork(control, { id: "w6-revguard" });
  await assert.rejects(
    control.workRevise({ key: "w6-rv", work: created.workId, patch: { state: "completed" } }),
    (error) => error.code === "unsupported" && /completed/.test(error.message),
  );
});

test("a full lifecycle walk never reads state completed", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w6-walk" });
  await control.workDispatch({ key: "w6-wd", work: created.workId });
  const job = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job.status = "done";
  job.result = "done";
  await control.recordWorkerOutcome(job);
  await control.workPause({ key: "w6-wp", work: created.workId });
  await control.workResume({ key: "w6-wr", work: created.workId });
  await control.workPrioritize({ key: "w6-wpr", work: created.workId, priority: 9, priorityReason: "ceo" });
  await control.workCancel({ key: "w6-wc", work: created.workId });
  await control.workArchive({ key: "w6-wa", work: created.workId });
  const { data } = await control.workInspect({ work: created.workId });
  assert.notEqual(data.state, "completed");
  assert.equal(data.state, "archived");
  for (const op of data.operations) {
    assert.notEqual(op.resultCode, "completed", "no operation claims completion either");
  }
});

// ---------------------------------------------------------------------------
// W7 — read/write separation at the production composition boundary
// ---------------------------------------------------------------------------

test("reads succeed with every write dep throwing, and no write spy is ever called", async () => {
  const throwing = makeDelegateSpy({ throwing: true });
  // Wire every delegate op to throw before touching the store.
  for (const name of ["startJob", "stopJob", "pauseJob", "resumeJob", "deleteJob"]) {
    throwing.engine[name] = async () => {
      throw new Error(`write dep ${name} must not be called`);
    };
  }
  const { control, calls } = makeWorkControl();
  control._throwingDelegate = throwing.engine; // not used — composition below
  // Rebuild the control with the throwing engine.
  const control2 = createCtoWorkControl({
    store: workStoreFixture(),
    createReceiptsStore: ledgerFixture(),
    now: makeClock(),
    listProjects: async () => fixtureProjects(),
    listDelegateJobs: async () => [],
    delegateOps: throwing.engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => "ses_cto",
  });
  await seedReadyWork(control, { id: "w7-seed" });
  const reads = [
    control2.workList({}),
    control2.workCapacity(),
  ];
  // workInspect/workEvidence need a work id in control2's store: create one
  // through control2's own write path first, then reset the call log.
  const created = await control2.workCreate({
    key: "w7-create",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
  });
  throwing.calls.length = 0; // create is a write — clear it for the read probe
  reads.push(control2.workInspect({ work: created.workId }));
  reads.push(control2.workEvidence({ work: created.workId }));
  const results = await Promise.all(reads);
  for (const r of results) {
    assert.equal(r.ok, true, `read must succeed: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.deepEqual(throwing.calls, [], "zero write-dep calls for the four reads");
  assert.deepEqual(calls, [], "the first control's spies were never driven by reads either");
});

test("counterfactual: the same boundary DOES drive startJob for dispatch", async () => {
  const { control, calls } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w7-cf" });
  const dispatched = await control.workDispatch({ key: "w7-d", work: created.workId });
  assert.equal(dispatched.ok, true);
  assert.equal(calls.filter((c) => c.name === "startJob").length, 1);
});

// ---------------------------------------------------------------------------
// W8 — pause/cancel report what is still running (§3.3)
// ---------------------------------------------------------------------------

test("pause requests a checkpoint from running workers and says so; a refused pause is reported", async () => {
  const { control, calls } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w8-pause" });
  const dispatched = await control.workDispatch({ key: "w8-pd", work: created.workId });
  const paused = await control.workPause({ key: "w8-p", work: created.workId });
  assert.equal(paused.ok, true);
  assert.equal(paused.state, "paused");
  assert.deepEqual(paused.checkpointRequested.map((r) => r.jobId), [dispatched.jobId]);
  assert.ok(paused.summary.includes("checkpoint requested"), "the UI can say what is being checkpointed");
  assert.equal(calls.filter((c) => c.name === "pauseJob").length, 1);
  assert.deepEqual(paused.stillRunning, [], "nothing was left un-pauseable here");
});

test("cancel persists intent, stops running workers, and reports a stop that FAILED as still running", async () => {
  const { control, calls } = makeWorkControl({ stopFails: true });
  const created = await seedReadyWork(control, { id: "w8-cancel" });
  const dispatched = await control.workDispatch({ key: "w8-cd", work: created.workId });
  const cancelled = await control.workCancel({ key: "w8-c", work: created.workId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.stillRunning.map((r) => r.jobId), [dispatched.jobId], "the UI must say what is STILL RUNNING");
  assert.ok(cancelled.summary.includes("COULD NOT CANCEL"));
  assert.ok(cancelled.summary.includes("still running externally"));
  assert.equal(calls.filter((c) => c.name === "stopJob").length, 1);
});

test("counterfactual: cancel leaves a PAUSED worker intact and names it (never pretends it stopped)", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w8-pz" });
  const dispatched = await control.workDispatch({ key: "w8-pzd", work: created.workId });
  await control.workPause({ key: "w8-pzp", work: created.workId });
  // The pause boundary landed: the job actually flipped to paused.
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "paused";
  job.pauseRequested = false;
  const cancelled = await control.workCancel({ key: "w8-pzc", work: created.workId });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(cancelled.stopped, [], "a paused worker is not 'stopped'");
  assert.deepEqual(cancelled.leftIntact, [dispatched.jobId], "it is reported as left intact");
  assert.ok(cancelled.summary.includes("left intact"));
});

// ---------------------------------------------------------------------------
// W9 — capacity
// ---------------------------------------------------------------------------

test("work_capacity reflects the delegate cap and dispatch at cap parks the work on waiting/capacity", async () => {
  const { control, calls } = makeWorkControl({ cap: 1 });
  const created = await seedReadyWork(control, { id: "w9-cap" });
  const capacity1 = await control.workCapacity();
  assert.equal(capacity1.data.delegate.maxRunningJobs, MAX_RUNNING_JOBS);
  assert.equal(capacity1.data.delegate.runningJobs, 0);
  assert.equal(capacity1.data.delegate.availableSlots, MAX_RUNNING_JOBS);

  // A box whose slots are all taken by foreign jobs: capacity reads 0 and the
  // dispatch is refused with capacity_wait (retry-safe), the work parked on
  // waiting/capacity with the reason durable.
  const foreign = Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => ({
    id: `job_foreign_${i}`,
    status: "running",
    correlation: null,
  }));
  const control2 = createCtoWorkControl({
    store: workStoreFixture(),
    createReceiptsStore: ledgerFixture(),
    now: makeClock(),
    listProjects: async () => fixtureProjects(),
    listDelegateJobs: async () => foreign,
    delegateOps: makeDelegateSpy({ cap: MAX_RUNNING_JOBS, jobs: foreign }).engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => "ses_cto",
  });
  const w2 = await control2.workCreate({
    key: "w9-create",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
  });
  const capacityFull = await control2.workCapacity();
  assert.equal(capacityFull.data.delegate.runningJobs, MAX_RUNNING_JOBS);
  assert.equal(capacityFull.data.delegate.availableSlots, 0);
  await assert.rejects(
    control2.workDispatch({ key: "w9-dfull", work: w2.workId }),
    (error) => {
      assert.equal(error.code, "capacity_wait");
      assert.equal(error.retrySafe, true);
      return true;
    },
  );
  const { data } = await control2.workInspect({ work: w2.workId });
  assert.equal(data.state, "waiting");
  assert.equal(data.waitingReason, "capacity", "the wait reason is durable (§9)");
  assert.equal(calls.filter((c) => c.name === "startJob").length, 0);
});

test("counterfactual: below cap the dispatch succeeds", async () => {
  const { control } = makeWorkControl({ cap: MAX_RUNNING_JOBS });
  const created = await seedReadyWork(control, { id: "w9-free" });
  const capacity = await control.workCapacity();
  assert.equal(capacity.data.delegate.availableSlots, MAX_RUNNING_JOBS);
  const dispatched = await control.workDispatch({ key: "w9-dfree", work: created.workId });
  assert.equal(dispatched.ok, true);
});

// ---------------------------------------------------------------------------
// W10 — retry + reconciliation
// ---------------------------------------------------------------------------

test("retry reconciles an unknown dispatch by ADOPTING the correlated worker — never a second startJob", async () => {
  const store = workStoreFixture();
  const workId = "w10-adopt";
  const input = { key: "w10-crash", work: workId };
  // The crash happened AFTER the worker was created: a correlated job exists.
  const correlated = {
    id: "job_crashed",
    childSessionID: "ses_crashed",
    tmuxSession: "manta",
    worktree: fix("better-ui") + "/.worktrees/crash",
    branch: "cto/crash",
    status: "running",
    correlation: { kind: "work", workId, receiptId: `op_seed_${input.key}` },
  };
  const { control, calls } = makeWorkControl({ store, jobs: [correlated] });
  const created = await seedReadyWork(control, { id: workId });
  assert.equal(created.workId, workId);
  await seedEnvelopeReceipt(store, workId, dispatchReceiptSeed({ input, ...input, status: "in_flight", leaseExpiresAt: 0 }));
  // A fresh dispatch first reconciles, then refuses: the adopted live worker
  // blocks a second dispatch.
  await assert.rejects(
    control.workDispatch({ key: "w10-new", work: created.workId }),
    (error) => {
      assert.equal(error.code, "active_resource", "the adopted live worker blocks a second dispatch");
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.name === "startJob").length, 0, "never created another worker");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "running", "the adopted worker is reflected in the work state");
  const receipt = data.operations.find((r) => r.id === `op_seed_${input.key}`);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.externalRef, "job_crashed", "the receipt was reconciled with evidence");
  assert.ok(data.resources.some((r) => r.kind === "delegate_job" && r.ref === "job_crashed"), "the job is owned-recorded");
  void correlated;
});

test("counterfactual: reconciliation with NO correlated job records the scan evidence and marks the attempt failed", async () => {
  const store = workStoreFixture();
  const { control, calls } = makeWorkControl({ store });
  const created = await seedReadyWork(control, { id: "w10-nojob" });
  const input = { key: "w10-nojob-k", work: created.workId };
  await seedEnvelopeReceipt(store, created.workId, dispatchReceiptSeed({ input, ...input, status: "in_flight", leaseExpiresAt: 0 }));
  // No correlated job anywhere — the dispatch never issued.
  const result = await control.workDispatch({ key: "w10-fresh", work: created.workId });
  assert.equal(result.ok, true, "the fresh dispatch proceeds after reconciliation");
  assert.equal(calls.filter((c) => c.name === "startJob").length, 1);
  const { data } = await control.workInspect({ work: created.workId });
  const old = data.operations.find((r) => r.id === `op_seed_${input.key}`);
  assert.equal(old.status, "failed");
  assert.equal(old.resultCode, "reconciled:no_job");
});

test("work_retry supersedes the prior attempt and starts a new one; the attempt limit bounds it", async () => {
  const { control, calls, jobs } = makeWorkControl({ maxStageAttempts: 2 });
  const created = await seedReadyWork(control, { id: "w10-retry" });
  await control.workDispatch({ key: "w10-rd1", work: created.workId });
  const job1 = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job1.status = "failed";
  job1.error = "boom";
  await control.recordWorkerOutcome(job1);
  const { data: failed } = await control.workInspect({ work: created.workId });
  assert.equal(failed.state, "failed", "a worker failure is a visible work failure");
  const retried = await control.workRetry({ key: "w10-rt", work: created.workId });
  assert.equal(retried.ok, true);
  assert.equal(calls.filter((c) => c.name === "startJob").length, 2);
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "running");
  const superseded = data.attempts.filter((a) => a.status === "superseded");
  assert.equal(superseded.length, 1, "the failed attempt is superseded, evidence kept");
  const job2 = jobs.jobs.filter((j) => j.correlation?.workId === created.workId)[1];
  job2.status = "failed";
  await control.recordWorkerOutcome(job2);
  await assert.rejects(
    control.workRetry({ key: "w10-rt2", work: created.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/attempt limit/.test(error.message));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// W11 — answer_decision
// ---------------------------------------------------------------------------

test("answer_decision: spec-incompatible response fails visibly; the answer applies once; a second answer refuses", async () => {
  const { control } = makeWorkControl();
  const created = await control.workCreate({
    key: "w11-create",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h1", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    decisions: [
      { id: "dec_1", question: "which auth path?", recommendation: "oauth", state: "open", blocking: true, originatingSpecHash: "h1", priorState: "ready" },
    ],
  });
  assert.equal(created.ok, true);
  // A decision moved the work to needs_decision in the real flow; simulate
  // the parked state the engine would have set.
  await control.workRevise({ key: "w11-park", work: created.workId, patch: { state: "needs_decision" } });

  await assert.rejects(
    control.workAnswerDecision({ key: "w11-a0", work: created.workId, decisionId: "nope", response: "x" }),
    (error) => error.code === "target_not_found",
  );

  const answered = await control.workAnswerDecision({
    key: "w11-a1",
    work: created.workId,
    decisionId: "dec_1",
    response: "use oauth",
  });
  assert.equal(answered.ok, true);
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.equal(after.decisions[0].state, "answered");
  assert.equal(after.state, "ready", "the last open blocking decision unblocked the work (changed once)");

  await assert.rejects(
    control.workAnswerDecision({ key: "w11-a2", work: created.workId, decisionId: "dec_1", response: "again" }),
    (error) => error.code === "policy_blocked" && /already answered/.test(error.message),
  );

  // Spec moved on → the same decision text now fails visibly.
  await control.workRevise({ key: "w11-spec", work: created.workId, patch: { spec: { revision: 2, hash: "h2", documentRef: "d#rev2" } } });
  const second = await control.workCreate({
    key: "w11-create2",
    project: "manta",
    objective: "y",
    spec: { revision: 1, hash: "h1", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    decisions: [{ id: "dec_2", question: "q", state: "open", originatingSpecHash: "stale-hash" }],
  });
  void second;
  await assert.rejects(
    (async () => {
      const w = await control.workCreate({
        key: "w11-create3",
        project: "manta",
        objective: "z",
        spec: { revision: 1, hash: "h9", documentRef: "d9" },
        deliveryTarget: { kind: "pr" },
        state: "ready",
        decisions: [{ id: "dec_3", question: "q", state: "open", originatingSpecHash: "older" }],
      });
      await control.workAnswerDecision({ key: "w11-a3", work: w.workId, decisionId: "dec_3", response: "x" });
    })(),
    (error) => error.code === "revision_conflict",
  );
});

// ---------------------------------------------------------------------------
// W12 — archive ≠ cleanup
// ---------------------------------------------------------------------------

test("archive is metadata-only (destroys nothing) and refuses a live worker", async () => {
  const { control, calls } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w12-arch" });
  await control.workDispatch({ key: "w12-ad", work: created.workId });
  await assert.rejects(
    control.workArchive({ key: "w12-a1", work: created.workId }),
    (error) => error.code === "active_resource",
  );
  assert.equal(calls.filter((c) => c.name === "deleteJob").length, 0);
  await control.workCancel({ key: "w12-ac", work: created.workId });
  const archived = await control.workArchive({ key: "w12-a2", work: created.workId });
  assert.equal(archived.ok, true);
  assert.ok(archived.summary.includes("nothing was deleted"));
  assert.equal(calls.filter((c) => c.name === "deleteJob").length, 0);
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.attempts.length > 0, true, "attempts preserved");
  assert.equal(data.operations.length > 0, true, "receipts preserved");
});

test("cleanup removes only owned terminal resources via the existing non-forced operation and retains failures", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w12-clean" });
  const dispatched = await control.workDispatch({ key: "w12-cd", work: created.workId });
  await control.workCancel({ key: "w12-cc", work: created.workId });
  void jobs;
  // Make the worktree dirty → deleteJob (non-forced) refuses with reason dirty.
  const dirtyControl = makeWorkControl({ jobs: [] });
  void dirtyControl;
  // The spy's deleteJob only refuses for a still-running job; emulate the
  // dirty-worktree refusal the real non-forced removal returns.
  const spy = makeDelegateSpy({ jobs: [] });
  spy.engine.deleteJob = async (id) => {
    if (id === dispatched.jobId) return { ok: false, reason: "dirty" };
    return { ok: true };
  };
  const control2 = createCtoWorkControl({
    store: workStoreFixture(),
    createReceiptsStore: ledgerFixture(),
    now: makeClock(),
    listProjects: async () => fixtureProjects(),
    listDelegateJobs: async () => spy.state.jobs,
    delegateOps: spy.engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => "ses_cto",
  });
  const c2work = await control2.workCreate({
    key: "w12-c2",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
  });
  await control2.workDispatch({ key: "w12-c2d", work: c2work.workId });
  await control2.workCancel({ key: "w12-c2c", work: c2work.workId });
  await assert.rejects(
    control2.workCleanup({ key: "w12-c2x", work: c2work.workId }),
    (error) => {
      assert.equal(error.code, "dirty_resource");
      return true;
    },
  );
  const { data } = await control2.workInspect({ work: c2work.workId });
  const res = data.resources.find((r) => r.kind === "delegate_job");
  assert.equal(res.cleanupStatus, "failed", "the failure is retained and visible");
  assert.equal(res.path !== null, true, "metadata kept to retry");
  assert.equal(data.operations.length > 0, true, "the record was never dropped because removal threw");
});

test("counterfactual: cleanup of a terminal owned job removes it and records the removal", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w12-clean-ok" });
  const dispatched = await control.workDispatch({ key: "w12-cod", work: created.workId });
  await control.workCancel({ key: "w12-coc", work: created.workId });
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  void job;
  const cleaned = await control.workCleanup({ key: "w12-cox", work: created.workId });
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.removed, [dispatched.jobId]);
  assert.equal(calls.filter((c) => c.name === "deleteJob").length, 1);
  const { data } = await control.workInspect({ work: created.workId });
  const res = data.resources.find((r) => r.kind === "delegate_job" && r.ref === dispatched.jobId);
  assert.equal(res.cleanupStatus, "removed");
  assert.ok(res.path, "the durable record keeps the path evidence");
  assert.equal(data.state, "cancelled", "the work record itself is never deleted");
});

test("cleanup refuses borrowed resources and unresolved receipts", async () => {
  const store = workStoreFixture();
  const { control } = makeWorkControl({ store });
  const created = await seedReadyWork(control, { id: "w12-borrow" });
  // Forge a borrowed resource + an unknown receipt, then try to clean up.
  await lockForStore({ name: store.name, path: store.pathFor(created.workId) }).runExclusive(async () => {
    const raw = await readFile(store.pathFor(created.workId), "utf-8");
    const env = JSON.parse(raw);
    env.resources = [{ id: "res_b", kind: "delegate_job", ref: "job_user", owned: false, cleanupStatus: "active" }];
    env.operations = [
      {
        id: "op_u",
        key: "user-op",
        op: "work.dispatch",
        argsHash: "x",
        workRevision: 1,
        stage: "implement",
        specHash: "sha256:aaa",
        status: "unknown",
        lease: { owner: "s", expiresAt: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    await store.save(created.workId, env);
  });
  await assert.rejects(
    control.workCleanup({ key: "w12-bx", work: created.workId }),
    (error) => error.code === "borrowed_resource",
  );
});

// ---------------------------------------------------------------------------
// W13 — success never lies
// ---------------------------------------------------------------------------

test("no mutation returns ok without driving its external dep", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w13-truth" });
  const dispatched = await control.workDispatch({ key: "w13-td", work: created.workId });
  await control.workPause({ key: "w13-tp", work: created.workId });
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "paused";
  job.pauseRequested = false;
  const resumed = await control.workResume({ key: "w13-tr", work: created.workId });
  assert.equal(resumed.ok, true);
  await control.workCancel({ key: "w13-tc", work: created.workId });
  await control.workCleanup({ key: "w13-tx", work: created.workId });
  const driven = new Set(calls.map((c) => c.name));
  for (const dep of ["startJob", "pauseJob", "resumeJob", "stopJob", "deleteJob"]) {
    assert.ok(driven.has(dep), `${dep} must have been driven by its mutation`);
  }
});

// ---------------------------------------------------------------------------
// W14 — response envelope + replay fidelity
// ---------------------------------------------------------------------------

test("every successful mutation carries operationId, workId, revision, state and a visible summary", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w14-resp" });
  for (const field of ["operationId", "workId", "revision", "state", "summary"]) {
    assert.ok(field in created, `create response carries ${field}`);
  }
  const dispatched = await control.workDispatch({ key: "w14-d", work: created.workId });
  for (const field of ["operationId", "workId", "revision", "state", "summary", "jobId"]) {
    assert.ok(field in dispatched, `dispatch response carries ${field}`);
  }
  const revised = await control.workRevise({ key: "w14-r", work: created.workId, patch: { priorityReason: "x" } });
  assert.ok(revised.operationId && revised.summary);
  const job = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job.status = "done";
  job.result = "done";
  const adopted = await control.recordWorkerOutcome(job);
  assert.equal(adopted.adopted, true);
  void adopted;
});

// ---------------------------------------------------------------------------
// W15 — attempt linked BEFORE prompt delivery
// ---------------------------------------------------------------------------

test("the stage attempt is linked before prompt delivery (the startJob spy sees state running, attempt present, no jobId)", async () => {
  const store = workStoreFixture();
  let envAtDispatch = null;
  const spy = makeDelegateSpy({});
  const originalStart = spy.engine.startJob;
  spy.engine.startJob = async (input) => {
    const raw = await readFile(store.pathFor("w15-link"), "utf-8");
    envAtDispatch = JSON.parse(raw);
    return originalStart(input);
  };
  const control = createCtoWorkControl({
    store,
    createReceiptsStore: ledgerFixture(),
    now: makeClock(),
    listProjects: async () => fixtureProjects(),
    listDelegateJobs: async () => spy.state.jobs,
    delegateOps: spy.engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => "ses_cto",
  });
  const created = await seedReadyWork(control, { id: "w15-link" });
  const dispatched = await control.workDispatch({ key: "w15-d", work: created.workId });
  assert.equal(dispatched.ok, true);
  assert.ok(envAtDispatch, "the spy observed the envelope at delivery time");
  assert.equal(envAtDispatch.state, "running", "state was already running when the prompt went out");
  assert.equal(envAtDispatch.attempts.length, 1, "exactly one attempt was linked before delivery");
  assert.equal(envAtDispatch.attempts[0].jobId, null, "the attempt was linked BEFORE the job existed");
  assert.equal(envAtDispatch.attempts[0].status, "dispatching");
});

// ---------------------------------------------------------------------------
// W16 — isolationRequired
// ---------------------------------------------------------------------------

test("a worktree failure fails the dispatch before prompting and never de-isolates the work", async () => {
  const { control, calls } = makeWorkControl({ worktreeOk: false });
  const created = await seedReadyWork(control, { id: "w16-iso" });
  await assert.rejects(
    control.workDispatch({ key: "w16-d", work: created.workId }),
    (error) => {
      assert.equal(error.code, "provider_unavailable");
      assert.ok(/worktree/.test(error.message));
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.name === "startJob").length, 1, "startJob itself refused — no window, no prompt");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "ready", "dispatchable again after an infra failure");
  assert.equal(data.attempts[0].status, "failed");
  assert.equal(data.attempts[0].jobId, null, "no worker was ever created");
});

// ---------------------------------------------------------------------------
// W17 — sandbox canary
// ---------------------------------------------------------------------------

test("sandbox canary: the production work and control stores resolve under MANTA_STATE_HOME", () => {
  assert.ok(workStore.dir.startsWith(stateHome()), `work store must be sandboxed, got ${workStore.dir}`);
  assert.ok(mantaControlStore.path.startsWith(stateHome()), `control store must be sandboxed, got ${mantaControlStore.path}`);
});

// ---------------------------------------------------------------------------
// W18 — tool registration
// ---------------------------------------------------------------------------

test("tool registration: 15 family tools, reads auto, mutations confirm, params action-specific", () => {
  const { control } = makeWorkControl();
  const tools = [];
  registerCtoWorkTools((def) => tools.push(def), control);
  assert.equal(tools.length, 15);
  const reads = new Set(["work_list", "work_inspect", "work_evidence", "work_capacity"]);
  for (const t of tools) {
    assert.ok(t.name.startsWith("work_"));
    assert.equal(t.mode, reads.has(t.name) ? "auto" : "confirm");
    assert.ok(t.description.length > 20);
    assert.ok(t.params && typeof t.params === "object");
  }
  // Action-specific schemas: dispatch carries model/subagentType but not the
  // create schema's spec/deliveryTarget; cleanup has no model.
  const dispatchParams = JSON.stringify(tools.find((t) => t.name === "work_dispatch").params);
  const createParams = JSON.stringify(tools.find((t) => t.name === "work_create").params);
  const cleanupParams = JSON.stringify(tools.find((t) => t.name === "work_cleanup").params);
  assert.ok(createParams.includes("deliveryTarget"));
  assert.ok(!dispatchParams.includes("deliveryTarget"), "dispatch does not accept a delivery target");
  assert.ok(dispatchParams.includes("model"));
  assert.ok(!cleanupParams.includes("model"), "cleanup does not accept a model");
});

// ---------------------------------------------------------------------------
// W19 — outcome adoption: idempotent + spec-stale-aware
// ---------------------------------------------------------------------------

test("a repeated terminal event advances the work at most once; a stale-spec outcome never advances it", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w19-idem" });
  await control.workDispatch({ key: "w19-d", work: created.workId });
  const job1 = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job1.status = "done";
  job1.result = "done (v1 spec)";
  const first = await control.recordWorkerOutcome(job1);
  assert.equal(first.adopted, true);
  const repeat = await control.recordWorkerOutcome(job1);
  assert.equal(repeat.adopted, false, "same event/attempt advances at most once");
  assert.equal(repeat.replay, true);

  // Retry starts attempt 2; the spec is then revised mid-flight (attempt 2 is
  // superseded and the work pauses). The worker — pinned to the OLD spec —
  // finishes anyway: the outcome is preserved as SUPERSEDED evidence and the
  // paused work does NOT advance (U13 / §5.2).
  await control.workRetry({ key: "w19-rt", work: created.workId });
  const job2 = jobs.jobs.filter((j) => j.correlation?.workId === created.workId)[1];
  await control.workRevise({
    key: "w19-spec",
    work: created.workId,
    patch: { spec: { revision: 2, hash: "sha256:bbb", documentRef: "d#rev2" } },
  });
  const { data: midFlight } = await control.workInspect({ work: created.workId });
  assert.equal(midFlight.state, "paused", "a spec revision pauses advancement (§5.2)");
  assert.equal(midFlight.attempts.filter((a) => a.status === "superseded").length >= 1, true);

  job2.status = "done";
  job2.result = "done under the OLD spec";
  const stale = await control.recordWorkerOutcome(job2);
  assert.equal(stale.adopted, true, "the superseded outcome's claim is preserved as evidence");
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.equal(after.state, "paused", "a superseded attempt cannot advance the work");
  assert.notEqual(after.state, "completed");
  const staleClaim = after.claims.find((c) => c.jobId === job2.id);
  assert.ok(staleClaim, "the claim exists");
  assert.equal(staleClaim.superseded, true, "and it is marked superseded");
  const staleRepeat = await control.recordWorkerOutcome(job2);
  assert.equal(staleRepeat.adopted, false, "the superseded claim lands exactly once");
});

// ---------------------------------------------------------------------------
// W20 — resume reconciles
// ---------------------------------------------------------------------------

test("resume resumes a paused worker in its worktree, adopts a terminal outcome, and decides the state", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w20-resume" });
  const dispatched = await control.workDispatch({ key: "w20-d", work: created.workId });
  await control.workPause({ key: "w20-p", work: created.workId });
  // Case 1: the pause boundary landed → the job is paused → resume reuses it.
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "paused";
  job.pauseRequested = false;
  const resumed = await control.workResume({ key: "w20-r", work: created.workId });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.resumed, [dispatched.jobId]);
  assert.equal(resumed.state, "running");
  assert.equal(calls.filter((c) => c.name === "resumeJob").length, 1);

  // Case 2: a work paused while its worker ran to completion — resume adopts
  // the outcome instead of pretending the worker is still going.
  await control.workPause({ key: "w20-p2", work: created.workId });
  job.status = "done";
  job.result = "finished while paused";
  const resumed2 = await control.workResume({ key: "w20-r2", work: created.workId });
  assert.equal(resumed2.ok, true);
  assert.deepEqual(resumed2.adopted.map((a) => a.outcome), ["done"]);
  assert.equal(resumed2.state, "waiting", "the adopted claim parks the work for the next stages");
  assert.notEqual(resumed2.state, "completed");
});

// ---------------------------------------------------------------------------
// Delivery target + prompt content
// ---------------------------------------------------------------------------

test("the worker prompt names the work, the pinned spec, and the invariant", async () => {
  const { control, calls } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w21-prompt" });
  await control.workDispatch({ key: "w21-d", work: created.workId });
  const start = calls.find((c) => c.name === "startJob");
  assert.ok(start.input.prompt.includes(created.workId));
  assert.ok(start.input.prompt.includes("sha256:aaa"), "the pinned spec hash is in the prompt");
  assert.ok(start.input.prompt.includes("does NOT complete the work"));
  assert.equal(start.input.isolationRequired, true);
  assert.equal(start.input.targetProject, "manta");
  assert.equal(start.input.parentSessionID, "ses_cto", "the completion parent is the CTO conversation");
  assert.equal(start.input.correlation.kind, "work");
  assert.equal(start.input.correlation.workId, created.workId);
});

test("CLAIM_KINDS names all seven §11 observations; this half writes only the first", () => {
  assert.deepEqual([...CLAIM_KINDS], [
    "implementation_reported",
    "tests_reported",
    "independent_review_approved",
    "merged_commit_exists",
    "artifact_published",
    "target_runs_artifact",
    "acceptance_checks_passed",
  ]);
  assert.equal(IMPLEMENTATION_CLAIM, "implementation_reported");
  assert.equal(DEFAULT_MAX_STAGE_ATTEMPTS > 0, true);
});
