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
//   W18 tool registration: 22 family tools (16 dispatch-half + P6 handoff + 6 §11 stage
//       operations), reads auto, mutations confirm, params action-specific
//       (no shared args bag)
//   W19 outcome adoption is idempotent and spec-stale-aware: a repeated
//       terminal event advances at most once; an attempt whose spec hash no
//       longer matches is superseded WITHOUT advancing the work (U13)
//   W20 resume reconciles: a paused worker is resumed in its worktree, a
//       terminal outcome that landed while paused is adopted, and the
//       resulting admission state is decided from the reconciliation
//
// §11 — review / merge / release / verify (each observation by EVIDENCE, with
// its counterfactual positive control):
//   V1  independent review: the reviewer dispatch pins the exact head + spec
//       hash, passes the REQUESTED model through verbatim, runs in an
//       independent context; an approval records independent_review_approved
//       from the reviewer's terminal report; counterfactual: a report without
//       a machine-readable verdict records a failed review, never a guess
//   V2  a reviewer failing to start is a BLOCKED review — no approval claim,
//       the requested model never silently substituted; counterfactual: with
//       the engine healthy the reviewer dispatches
//   V3  the review-rejection cascade (the carry-forward): A claims complete →
//       B admitted on A's claim → A's review rejects → A's implementation
//       claim is SUPERSEDED → B's dependency reads unmet; counterfactual: an
//       approving review leaves the claim live and downstream dispatchable
//   V4  head-change invalidation: a new-head review request or the forge's
//       live PR head invalidates an approval of a different head — never
//       preserved silently; counterfactual: matching head → merge proceeds
//   V5  the merge gate: required checks queried FROM THE FORGE for THAT head;
//       the merge is bound to the approved SHA (matching-head precondition);
//       merge records merged_commit_exists with the observed merge commit;
//       counterfactual: no approval → evidence_missing; not-green → no merge
//   V6  release contract: DATA (closed field set, non-executable) resolved per
//       project/target/channel; missing contract → visibly blocked; the
//       trigger's observed run + artifact identity is the claim; a mutating
//       contract requires the recovery reference BEFORE it runs; counterfactual:
//       contract + trigger → artifact_published recorded
//   V7  rollback is explicit: needs a preserved recovery reference and a wired
//       trigger, records only its own result; counterfactual: wired + ref →
//       the trigger ran
//   V8  verification never trusts a green build alone: the probe's
//       observations are compared to the work's OWN claims (sha/digest/
//       version); mismatch → target_changed, no claim; acceptance failures
//       record the identity but not acceptance_checks_passed; counterfactual:
//       matching probe → both claims recorded
//   V9  verified completion is the one "completed" writer, gated per delivery
//       target on the evidence chain; counterfactual: missing evidence →
//       evidence_missing
//   V10 secret hygiene: token-shaped material anywhere a record is written is
//       refused — tokens stay in the service clients; counterfactual: clean
//       records pass
//   V11 pure helpers: parseReviewVerdict (marker contract, not keyword
//       search), resolveReleaseContract (scoped over global, ambiguous →
//       error), parseRepoKey
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
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createCtoWorkControl,
  registerCtoWorkTools,
  CLAIM_KINDS,
  IMPLEMENTATION_CLAIM,
  REVIEW_CLAIM,
  MERGE_CLAIM,
  RELEASE_CLAIM,
  TARGET_RUNS_CLAIM,
  ACCEPTANCE_CLAIM,
  RELEASE_CONTRACT_FIELDS,
  DEFAULT_MAX_STAGE_ATTEMPTS,
  parseReviewVerdict,
  parseRepoKey,
  validateReleaseContract,
  resolveReleaseContract,
} from "./ctoWorkTools.mjs";
import { canonicalArgsHash } from "./ctoWork.mjs";
import { MAX_RUNNING_JOBS, CAP_ERROR } from "./delegate.mjs";
import { ctoPath, lockForStore, workStore, mantaControlStore } from "./ctoStores.mjs";
import { stateHome } from "../shared/paths.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";
import { makeJsonStoreFixture, makeWorkStoreFixture } from "./ctoTestJsonStore.mjs";

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
  return makeWorkStoreFixture("work-tools-test", `work-${testSeq}`);
}

function ledgerFixture() {
  // Shared fixture body (ctoTestStores.mjs) — the duplication gate scans
  // every changed file pairwise.
  return makeJsonStoreFixture("work-tools-test", "ledger");
}

function makeClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

function makeDelegateSpy({ jobs = [], worktreeOk = true, stopFails = false, cap = MAX_RUNNING_JOBS } = {}) {
  const calls = [];
  // worktreeOk/cap are LIVE engine properties — a worktree can start failing
  // and capacity can evaporate between calls, so §11 tests flip them on
  // `state` mid-test (the §11 fixtures exercise a reviewer that fails to
  // start AFTER the implementation dispatched successfully).
  const state = { jobs: [...jobs], worktreeOk, cap, dirtyWorktrees: new Set() };
  let seq = 0;
  const find = (id) => state.jobs.find((j) => j?.id === id) ?? null;
  const engine = {
    async startJob(input) {
      calls.push({ name: "startJob", input });
      const running = state.jobs.filter((j) => j?.status === "running").length;
      if (running >= state.cap) return { ok: false, error: CAP_ERROR };
      // Real contract: isolationRequired → a worktree failure FAILS the start
      // (never falls back to the repository directory).
      if (input.isolationRequired && !state.worktreeOk) {
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
        worktree: state.worktreeOk ? `${input.parentDirectory}/.worktrees/wt_${seq}` : null,
        branch: state.worktreeOk ? `cto/work-${seq}` : null,
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
    async deleteJob(id, opts) {
      calls.push({ name: "deleteJob", input: id, opts });
      const job = find(id);
      if (!job) return { ok: false, error: "not found" };
      if (job.status === "running") return { ok: false, error: "job still running" };
      // Real gitRemoveWorktree contract: a DIRTY worktree is refused by the
      // non-forced removal ({ok:false, reason:"dirty"}); only an explicit
      // force destroys it.
      if (state.dirtyWorktrees.has(id) && opts?.force !== true) {
        return { ok: false, reason: "dirty" };
      }
      state.jobs = state.jobs.filter((j) => j.id !== id);
      return { ok: true };
    },
  };
  return { engine, calls, state };
}

// The §4.1 durable key the harness seeds for the shared "manta" fixture
// project — server-realistic: a Manta project record carries its minted key
// from creation, and work envelopes then key on it.
const MANTA_PROJECT_ID = "proj_manta_1";

function mantaIdentityRecord() {
  return { tmuxSession: "manta", defaultCwd: fix("better-ui"), projectId: MANTA_PROJECT_ID };
}

function makeWorkControl({
  projects = fixtureProjects(),
  jobs = [],
  worktreeOk = true,
  stopFails = false,
  store,
  ledger,
  conversationId = "ses_cto",
  acceptedTurn = null,
  maxStageAttempts,
  cap,
  // §12 cleanup classification: path → porcelain status ("" = clean). A
  // server-realistic double over a stateful map, so a test can flip a
  // worktree dirty→clean and watch the retry succeed.
  worktreeStatus = {},
  // ---- §4.1 identity deps --------------------------------------------------
  identityRecords = [mantaIdentityRecord()],
  observedOpencodeIds = {},
  remoteUrl = null,
  // ---- §11 stage deps ------------------------------------------------------
  forge = null,
  releaseContracts = [],
  releaseTrigger = null,
  rollbackTrigger = null,
  targetProbe = null,
} = {}) {
  const ws = store ?? workStoreFixture();
  const lg = ledger ?? ledgerFixture();
  const spy = makeDelegateSpy({ jobs, worktreeOk, stopFails, ...(cap !== undefined ? { cap } : {}) });
  // Mutable holder so a test can move the LIVE tmux state between operations
  // (e.g. rename a project after create to exercise dispatch-time revalidation).
  const live = { projects };
  // A stateful, server-realistic config-store double: persisted identity
  // plans land here and configGet returns them, exactly like
  // local.mjs configGet/projectIdentityPersist do around ~/.manta/config.json.
  const configState = { projects: identityRecords.map((r) => ({ ...r })) };
  const identityWrites = [];
  const statusState = { byPath: { ...worktreeStatus } };
  const control = createCtoWorkControl({
    store: ws,
    createReceiptsStore: lg,
    now: makeClock(),
    listProjects: async () => live.projects,
    listDelegateJobs: async () => spy.state.jobs,
    delegateOps: spy.engine,
    resolveCwd: resolveCwdOrThrow,
    getConversationId: async () => conversationId,
    getAcceptedHumanTurn: async (sessionId) => acceptedTurn?.sessionId === sessionId ? acceptedTurn : null,
    configGet: async () => ({ projects: configState.projects.map((r) => ({ ...r })) }),
    persistProjectIdentity: async (plan) => {
      identityWrites.push(plan);
      let next = configState.projects.filter((p) => !plan.removes.includes(p?.tmuxSession));
      for (const u of plan.upserts) {
        next = next.filter((p) => p?.tmuxSession !== u.tmuxSession);
        next.push({ ...u });
      }
      configState.projects = next;
      return { projects: next };
    },
    observeOpencodeProjectId: async (dir) => observedOpencodeIds[dir] ?? null,
    gitRemoteUrl: async () => remoteUrl,
    gitStatus: async (cwd) => statusState.byPath[cwd] ?? "",
    ...(maxStageAttempts !== undefined ? { maxStageAttempts } : {}),
    ...(forge !== null ? { forge } : {}),
    ...(releaseContracts !== undefined ? { releaseContracts } : {}),
    ...(releaseTrigger !== null ? { releaseTrigger } : {}),
    ...(rollbackTrigger !== null ? { rollbackTrigger } : {}),
    ...(targetProbe !== null ? { targetProbe } : {}),
  });
  return { control, calls: spy.calls, jobs: spy.state, workStore: ws, ledger: lg, live, configState, identityWrites, statusState };
}

// A forge spy mirroring the REAL adapter contract (src/server/forge/github.mjs):
// getPullRequest → {data: {headSha, headRef, state, ...}}, getChecks(repo, sha)
// → {data: [{name, status, conclusion}]}, merge(repo, number, {method, sha}) →
// {data: {sha, merged}} or a typed throw ({status, kind}). No live forge call
// ever happens in a test.
function makeForgeSpy({ prs = {}, checksBySha = {}, mergeError = null, mergeSha = "mergecommit40hex0123456789abcd" } = {}) {
  const calls = [];
  return {
    calls,
    async getPullRequest(repo, number) {
      calls.push({ name: "getPullRequest", repo: `${repo.owner}/${repo.repo}`, number });
      const pr = prs[number];
      if (!pr) return { data: null, stale: false };
      return { data: { number, headSha: pr.headSha, headRef: pr.headRef ?? "feature/x", state: pr.state ?? "open", title: "the PR" }, stale: false };
    },
    async getChecks(repo, sha) {
      calls.push({ name: "getChecks", repo: `${repo.owner}/${repo.repo}`, sha });
      return { data: checksBySha[sha] ?? [], stale: false };
    },
    async merge(repo, number, { method, sha }) {
      calls.push({ name: "merge", repo: `${repo.owner}/${repo.repo}`, number, method, sha });
      if (mergeError) throw mergeError;
      return { data: { sha: mergeSha, merged: true, method }, stale: false };
    },
  };
}

// Standard work fixture: created READY against the explicit "manta" project.
// A direct createCtoWorkControl composition for tests that need a SEPARATE
// control instance next to the makeWorkControl one (custom spy engine or a
// wrapped startJob over a distinct store).
function directWorkControl({ store, spy, worktreeStatus = {} }) {
  const statusState = { byPath: { ...worktreeStatus } };
  return {
    control: createCtoWorkControl({
      store,
      createReceiptsStore: ledgerFixture(),
      now: makeClock(),
      listProjects: async () => fixtureProjects(),
      listDelegateJobs: async () => spy.state.jobs,
      delegateOps: spy.engine,
      resolveCwd: resolveCwdOrThrow,
      getConversationId: async () => "ses_cto",
      observeOpencodeProjectId: async () => null,
      gitRemoteUrl: async () => null,
      gitStatus: async (cwd) => statusState.byPath[cwd] ?? "",
    }),
    statusState,
  };
}

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

test("an explicit accepted CEO instruction creates a charter from server admission, not model-supplied provenance", async () => {
  const acceptedTurn = {
    id: "adm_1", sessionId: "ses_cto", messageID: "msg_ceo_1", acceptedAt: 1234,
    text: "Implement the export fix and get its pull request verified.",
  };
  const { control, workStore } = makeWorkControl({ acceptedTurn });
  const result = await control.workCreate({
    key: "charter-create-1",
    id: "chartered-export",
    project: "manta",
    objective: "Implement export fix",
    specText: "# Outcome\nFix export behavior and verify the pull request.",
    deliveryTarget: { kind: "pr" },
    originMessageId: "msg_forged_by_model",
    state: "draft",
  }, { sessionID: "ses_cto" });
  assert.equal(result.ok, true);
  const saved = await workStore.load("chartered-export");
  assert.equal(saved.origin.messageId, "msg_ceo_1");
  assert.deepEqual(saved.executionCharter.source, {
    kind: "ceo_instruction", sessionId: "ses_cto", messageId: "msg_ceo_1",
  });
  assert.equal(saved.executionCharter.revision, 1);
  assert.equal(saved.executionCharter.scope.workspaceId, MANTA_PROJECT_ID);
  assert.equal(saved.executionCharter.scope.repositoryId, "unmapped");
  assert.equal(saved.executionCharter.scope.objectiveHash, createHash("sha256").update("Implement export fix").digest("hex"));
  assert.equal(saved.executionCharter.scope.specHash, saved.spec.hash);
  assert.deepEqual(saved.executionCharter.permissions, ["dispatch", "retry", "handoff", "review", "verify", "complete"]);
  assert.deepEqual(saved.executionCharter.limits, { maxAttemptsPerStage: DEFAULT_MAX_STAGE_ATTEMPTS });
  assert.equal((await control.authorizeGoalMutation("work_dispatch", { work: result.workId, expectedRevision: saved.revision }, "ses_cto")).workRevision, saved.revision);
  assert.equal(await control.authorizeGoalMutation("work_dispatch", { work: result.workId, expectedRevision: saved.revision - 1 }, "ses_cto"), false);
  assert.equal((await control.authorizeGoalMutation("work_dispatch", { work: result.workId }, "ses_cto")).allowed, true);
  assert.equal(await control.authorizeGoalMutation("work_cancel", { work: result.workId }, "ses_cto"), false,
    "an implementation request does not imply a request to cancel");
  assert.equal(await control.authorizeGoalMutation("work_retry", { work: result.workId }, "ses_other"), false);
  assert.equal(await control.authorizeGoalMutation("work_merge", { work: result.workId }, "ses_cto"), false,
    "a PR-delivery charter must not silently authorize merging");
  assert.equal((await control.authorizeGoalMutation("work_revise", { work: result.workId, patch: { state: "ready" } }, "ses_cto")).allowed, true);
  assert.equal(await control.authorizeGoalMutation("work_revise", { work: result.workId, patch: { objective: "widen scope" } }, "ses_cto"), false);
  const replay = await control.workCreate({
    key: "model-generated-different-key",
    id: "duplicate-export-goal",
    project: "manta",
    objective: "Implement export fix",
    specText: "# Regenerated brief\nDifferent model phrasing must not create a second goal.",
    deliveryTarget: { kind: "pr" },
    state: "draft",
  }, { sessionID: "ses_cto" });
  assert.equal(replay.workId, result.workId, "source-goal uniqueness survives a changed idempotency key and model-generated spec wording");
  assert.equal(replay.reused, true);
  assert.equal(await workStore.load("duplicate-export-goal"), null);
  acceptedTurn.text = "Pause this work while I check the release plan.";
  assert.equal((await control.authorizeGoalMutation("work_pause", { work: result.workId }, "ses_cto")).allowed, true);
  acceptedTurn.text = "Should I stop this work?";
  assert.equal(await control.authorizeGoalMutation("work_pause", { work: result.workId }, "ses_cto"), false);
  acceptedTurn.text = "Cancel this work; stop the attempt.";
  assert.equal((await control.authorizeGoalMutation("work_cancel", { work: result.workId }, "ses_cto")).allowed, true);
});

test("plan-only, ambiguous, and off-session work creation do not mint execution charters", async () => {
  for (const [text, invocation, shouldCreate, shouldAuthorize] of [
    ["Plan only: show how we might fix this.", { sessionID: "ses_cto" }, false, false],
    ["Make a plan to fix this; do not implement yet.", { sessionID: "ses_cto" }, false, false],
    ["What would it take to fix this?", { sessionID: "ses_cto" }, false, false],
    ["Should we implement this now?", { sessionID: "ses_cto" }, false, false],
    ["Why did we build this?", { sessionID: "ses_cto" }, false, false],
    ["Implement this change.", { sessionID: "ses_other" }, false, true],
  ]) {
    const acceptedTurn = { id: `adm-${text}`, sessionId: "ses_cto", messageID: "msg_real", acceptedAt: 9, text };
    const { control, workStore } = makeWorkControl({ acceptedTurn });
    const id = `no-charter-${Buffer.from(text).toString("hex").slice(0, 12)}`;
    const result = await control.workCreate({
      key: `${id}-receipt`, id, project: "manta", objective: "Explore the outcome",
      specText: "# Outcome\nDescribe the requested work.", deliveryTarget: { kind: "pr" }, state: "draft",
    }, invocation);
    assert.equal(result.ok, true);
    assert.equal(!!(await workStore.load(id)).executionCharter, shouldCreate, text);
    assert.equal(await control.authorizeGoalCreation("ses_cto"), shouldAuthorize, text);
  }
});

test("an explicit specification request can autonomously create a charter bounded to the specification target", async () => {
  const { control, workStore } = makeWorkControl({
    acceptedTurn: {
      id: "adm-spec", sessionId: "ses_cto", messageID: "msg_spec", acceptedAt: 55,
      text: "Spec this change and stop at the settled specification.",
    },
  });
  const result = await control.workCreate({
    key: "spec-charter", id: "spec-only", project: "manta", objective: "Write the specification",
    specText: "# Outcome\nCreate and verify a settled specification.", deliveryTarget: { kind: "spec" }, state: "draft",
  }, { sessionID: "ses_cto" });
  assert.equal(result.ok, true);
  const saved = await workStore.load("spec-only");
  assert.ok(saved.executionCharter);
  assert.deepEqual(saved.executionCharter.permissions, ["dispatch", "retry", "handoff", "review", "verify", "complete"]);
  assert.equal(await control.authorizeGoalMutation("work_merge", { work: "spec-only" }, "ses_cto"), false);
  assert.equal(await control.authorizeGoalMutation("work_release", { work: "spec-only" }, "ses_cto"), false);
});

test("scope edits require a one-shot confirmation and mint a new audited charter revision", async () => {
  const { control, workStore } = makeWorkControl({
    acceptedTurn: {
      id: "adm-scope", sessionId: "ses_cto", messageID: "msg_scope", acceptedAt: 99,
      text: "Implement the export fix.",
    },
  });
  const created = await control.workCreate({
    key: "scope-base", id: "scope-goal", project: "manta", objective: "Implement export fix",
    specText: "# Outcome\nFix the export behavior.", deliveryTarget: { kind: "pr" }, state: "draft",
  }, { sessionID: "ses_cto" });
  await assert.rejects(control.workRevise({
    key: "scope-denied", work: created.workId,
    patch: { objective: "Also redesign all exports" },
  }), /changes the accepted goal scope/);
  const revised = await control.workRevise({
    key: "scope-approved", work: created.workId,
    patch: { objective: "Also redesign all exports" },
    reason: "CEO approved scope expansion",
  }, { approvedConfirmation: { id: "confirm-scope-123", tool: "work_revise" } });
  assert.equal(revised.ok, true);
  const saved = await workStore.load(created.workId);
  assert.equal(saved.executionCharter.revision, 2);
  assert.equal(saved.executionCharter.scope.objectiveHash, createHash("sha256").update(saved.objective).digest("hex"));
  assert.deepEqual(saved.executionCharter.scopeApprovals, [{
    revision: 2,
    confirmationId: "confirm-scope-123",
    approvedAt: saved.executionCharter.scopeApprovals[0].approvedAt,
    scopeHash: saved.executionCharter.scopeApprovals[0].scopeHash,
  }]);
  assert.equal((await control.authorizeGoalMutation("work_dispatch", { work: created.workId }, "ses_cto")).allowed, true);
});

test("counterfactual: a valid target resolves and the envelope carries the explicit ProjectRef", async () => {
  const { control, configState } = makeWorkControl();
  const created = await seedReadyWork(control);
  assert.equal(created.ok, true);
  // §4.1: workspaceId is the Manta-minted durable key (the seeded record's),
  // not the tmux session name; repositoryId stays unmapped for a remote-less
  // checkout; the checkout path is carried, never used as identity.
  assert.deepEqual(created.project, {
    workspaceId: MANTA_PROJECT_ID,
    repositoryId: "unmapped",
    repositoryRoot: fix("better-ui"),
  });
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.project.workspaceId, MANTA_PROJECT_ID);
  assert.equal(data.targetLive, true);
  // The reconcile persisted nothing new: the record already carried its key.
  assert.equal(configState.projects.length, 1);
  assert.equal(configState.projects[0].projectId, MANTA_PROJECT_ID);
});

test("work_dispatch revalidates the stored key against live tmux (rebind on rename; fail closed with no record)", async () => {
  const { control, calls, live, identityWrites } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w1-target" });
  // Case-variant rename: the stored durable key still resolves — through the
  // record — and the record REBINDS to the live session (same checkout, no
  // repository-identity contradiction), keeping its key. The worker is placed
  // by the LIVE tmux name.
  live.projects = [{ tmuxSession: "Manta", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] }];
  const dispatched = await control.workDispatch({ key: "w1-d", work: created.workId });
  assert.equal(dispatched.ok, true);
  assert.equal(calls.filter((c) => c.name === "startJob").length, 1, "the rebound record dispatches");
  const started = calls.find((c) => c.name === "startJob");
  assert.equal(started.input.targetProject, "Manta", "window placement uses the LIVE tmux name");
  const rebound = identityWrites.find((p) => p.removes.includes("manta"));
  assert.ok(rebound, "the rename rebind was persisted");
  assert.deepEqual(rebound.removes, ["manta"]);
  const upserted = rebound.upserts.find((u) => u.projectId === MANTA_PROJECT_ID);
  assert.equal(upserted.tmuxSession, "Manta", "same record, new name, same durable key");

  // Full rename over the SAME checkout with the rebound record: still rebinds
  // (a fresh work item, addressed by the CURRENT live name, then the session
  // renamed again before dispatch).
  const second = await seedReadyWork(control, { id: "w1-target2", state: "ready", project: "Manta" });
  live.projects = [{ tmuxSession: "renamed-away", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] }];
  const secondDispatch = await control.workDispatch({ key: "w1-d2b", work: second.workId });
  assert.equal(secondDispatch.ok, true, "the rebound key follows the session across another rename");

  // A key whose record is GONE (identity store lost the record): fail closed —
  // the name is gone and there is nothing to rebind, so nothing is inferred.
  const orphan = makeWorkControl();
  const legacy = await seedReadyWork(orphan.control, { id: "w1-legacy" });
  orphan.configState.projects = []; // the record vanished (lost store)
  orphan.live.projects = [
    { tmuxSession: "renamed-away", defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] },
  ];
  await assert.rejects(
    orphan.control.workDispatch({ key: "w1-d3", work: legacy.workId }),
    (error) => error.code === "target_not_found",
  );
  assert.equal(orphan.calls.filter((c) => c.name === "startJob").length, 0, "no worker against an unresolved target");
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

test("a CTO brief is pinned server-side and delivered verbatim to a project worker without file writes", async () => {
  const { control, calls } = makeWorkControl();
  const specText = "Repair the export. Preserve existing data. Acceptance: export/re-import round trip passes.";
  const created = await seedReadyWork(control, { id: "inline-brief", spec: undefined, specText });
  const listed = await control.workList();
  const row = listed.data.works.find((w) => w.id === created.workId);
  assert.equal(row.spec.content, undefined);
  assert.equal(row.spec.contentLength, specText.length);
  assert.equal((await control.workInspect({ work: created.workId })).data.spec.content, specText);
  await control.workDispatch({ key: "inline-dispatch", work: created.workId });
  const start = calls.find((c) => c.name === "startJob");
  assert.ok(start.input.prompt.includes(specText));
  assert.match(start.input.prompt, /hash sha256:[a-f0-9]{64}/);
  assert.ok(start.input.prompt.includes("inline:sha256:"));
  const replay = await seedReadyWork(control, { id: "inline-brief", spec: undefined, specText });
  assert.equal(replay.workId, created.workId);
  assert.equal(replay.replayed, true);
  const revised = await control.workRevise({ key: "inline-revise", work: created.workId,
    patch: { specText: `${specText}\nAlso cover empty exports.`, specRevision: 2 } });
  assert.equal(revised.ok, true);
  const revisedReplay = await control.workRevise({ key: "inline-revise", work: created.workId,
    patch: { specText: `${specText}\nAlso cover empty exports.`, specRevision: 2 } });
  assert.equal(revisedReplay.replayed, true);
  await assert.rejects(control.workCreate({ key: "inline-ambiguous", project: "manta", objective: "x",
    spec: { revision: 1, hash: "x", documentRef: "x" }, specText, deliveryTarget: { kind: "pr" } }), /Pass spec OR specText/);
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

test("a full lifecycle walk never reads state completed (work_complete is the ONLY completed-writer and the walk never calls it)", async () => {
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
  // §11 reconciliation: "completed" IS now reachable — but ONLY through
  // work_complete with the delivery target's evidence chain (V9 below). The
  // walk above drives no stage evidence, so completion must refuse visibly
  // rather than pass silently:
  await assert.rejects(
    control.workComplete({ key: "w6-walk-c", work: created.workId }),
    (error) => error.code === "policy_blocked" && /archived/.test(error.message),
  );
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
    observeOpencodeProjectId: async () => null,
    gitRemoteUrl: async () => null,
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
    observeOpencodeProjectId: async () => null,
    gitRemoteUrl: async () => null,
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

test("cleanup classifies a dirty worktree BEFORE removal: preserved with the reason visible, and retry succeeds once clean (U20)", async () => {
  // A stateful gitStatus double keyed by worktree path — the exact
  // server-realistic shape (path → porcelain listing; "" = clean).
  const { control, statusState } = directWorkControl({ store: workStoreFixture(), spy: makeDelegateSpy({ jobs: [] }) });
  const mk = async (id, key) =>
    control.workCreate({
      key,
      project: "manta",
      objective: "x",
      spec: { revision: 1, hash: "h", documentRef: "d" },
      deliveryTarget: { kind: "pr" },
      state: "ready",
      id,
    });
  const pathOf = async (workId, jobId) =>
    (await control.workInspect({ work: workId })).data.resources.find(
      (r) => r.kind === "delegate_job" && r.ref === jobId,
    ).path;
  // Counterfactual positive control: a CLEAN worktree's cleanup succeeds —
  // so the preserve gate below is the only thing standing between a dirty
  // worktree and its removal.
  const a = await mk("w12-clean-cf", "w12-cfa");
  const aJob = (await control.workDispatch({ key: "w12-cfa-d", work: a.workId })).jobId;
  await control.workCancel({ key: "w12-cfa-c", work: a.workId });
  const cleanedClean = await control.workCleanup({ key: "w12-cfa-x", work: a.workId });
  assert.equal(cleanedClean.ok, true);
  assert.deepEqual(cleanedClean.removed, [aJob]);
  // Dirty worktree + no override: classification happens BEFORE any
  // destructive call — the worktree is PRESERVED (not removed, not "failed")
  // and the refusal names the reason.
  const b = await mk("w12-dirty", "w12-c2");
  const bJob = (await control.workDispatch({ key: "w12-c2d", work: b.workId })).jobId;
  await control.workCancel({ key: "w12-c2c", work: b.workId });
  statusState.byPath[await pathOf(b.workId, bJob)] = " M src/worker.js\n?? scratch.txt";
  await assert.rejects(
    control.workCleanup({ key: "w12-c2x", work: b.workId }),
    (error) => {
      assert.equal(error.code, "dirty_resource");
      assert.match(error.message, /preserved/);
      assert.match(error.message, /src\/worker\.js/);
      assert.deepEqual(error.details?.preserved, [{ ref: bJob, reason: "dirty" }]);
      return true;
    },
  );
  const { data } = await control.workInspect({ work: b.workId });
  const res = data.resources.find((r) => r.kind === "delegate_job" && r.ref === bJob);
  assert.equal(res.cleanupStatus, "preserved", "the worktree is preserved, visibly");
  assert.equal(res.preservedReason, "dirty", "the reason is visible on the resource row");
  assert.match(res.failureReason, /src\/worker\.js/);
  assert.equal(data.operations.length > 0, true, "the record was never dropped because removal threw");
  // Retryability: the SAME dirty worktree, once the status clears (a commit
  // landed), is removed by the retry — a preserved cleanup is not a dead end.
  statusState.byPath[await pathOf(b.workId, bJob)] = "";
  const retried = await control.workCleanup({ key: "w12-c2x-retry", work: b.workId });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.removed, [bJob]);
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
  const control = directWorkControl({ store, spy }).control;
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

test("tool registration: reads auto, charter-scoped workflow actions goal-mode, other mutations confirm", () => {
  const { control } = makeWorkControl();
  const tools = [];
  registerCtoWorkTools((def) => tools.push(def), control);
  // 16 record+dispatch (PR #1518 + P6 work_handoff) + 6 §11 completion stages:
  // review, merge, release, verify, complete, rollback. Every §11 stage is a
  // MUTATION — none widens the read set, so an unverified observation can
  // never be established by a read-mode tool.
  assert.equal(tools.length, 22);
  for (const stage of ["work_review", "work_merge", "work_release", "work_verify", "work_complete", "work_rollback", "work_handoff"]) {
    assert.ok(
      tools.some((t) => t.name === stage),
      `${stage} is registered`,
    );
  }
  const reads = new Set(["work_list", "work_inspect", "work_evidence", "work_capacity"]);
  const goalScoped = new Set([
    "work_create", "work_revise", "work_dispatch", "work_pause", "work_resume", "work_cancel", "work_retry", "work_handoff",
    "work_review", "work_merge", "work_release", "work_verify", "work_complete",
  ]);
  for (const t of tools) {
    assert.ok(t.name.startsWith("work_"));
    assert.equal(t.mode, reads.has(t.name) ? "auto" : goalScoped.has(t.name) ? "goal" : "confirm");
    if (goalScoped.has(t.name)) assert.match(t.description, /server-validated execution charter/);
    assert.ok(t.description.length > 20);
    assert.ok(t.params && typeof t.params === "object");
  }
  // Action-specific schemas: dispatch carries model/subagentType but not the
  // create schema's spec/deliveryTarget; cleanup has no model but carries the
  // §12 overrideDirty flag; the handoff has neither.
  const dispatchParams = JSON.stringify(tools.find((t) => t.name === "work_dispatch").params);
  const createParams = JSON.stringify(tools.find((t) => t.name === "work_create").params);
  const cleanupParams = JSON.stringify(tools.find((t) => t.name === "work_cleanup").params);
  const handoffParams = JSON.stringify(tools.find((t) => t.name === "work_handoff").params);
  assert.ok(createParams.includes("deliveryTarget"));
  assert.ok(createParams.includes("schedulingClass"));
  assert.ok(!dispatchParams.includes("deliveryTarget"), "dispatch does not accept a delivery target");
  assert.ok(dispatchParams.includes("model"));
  assert.ok(!cleanupParams.includes("model"), "cleanup does not accept a model");
  assert.ok(cleanupParams.includes("overrideDirty"), "cleanup carries the §12 override flag");
  assert.ok(handoffParams.includes("constraints"), "the handoff carries the §10 constraint list");
});

test("goal-mode tool rechecks the charter at execution immediately before invoking its mutation", async () => {
  const registered = new Map();
  const calls = [];
  let authorized = false;
  let currentRevision = 2;
  registerCtoWorkTools((definition) => { registered.set(definition.name, definition); return definition; }, {
    authorizeGoalMutation: async (name, args, sessionID) => {
      calls.push(["authorize", name, args.work, sessionID]);
      return authorized ? { allowed: true, workRevision: currentRevision } : false;
    },
    workDispatch: async (args) => {
      const revision = Object.getOwnPropertySymbols(args).map((symbol) => args[symbol]).find(Number.isInteger);
      calls.push(["dispatch", args.work, revision]);
      return { ok: true };
    },
  });
  const run = registered.get("work_dispatch").run;
  const denied = await run({ sessionID: "ses_cto", goalScopedAuthorization: true }, { work: "w1" });
  assert.equal(denied.code, "policy_blocked");
  assert.equal(calls.some((call) => call[0] === "dispatch"), false);
  authorized = true;
  const stale = await run({ sessionID: "ses_cto", goalScopedAuthorization: true, goalAuthorizationRevision: 1 }, { work: "w1" });
  assert.equal(stale.code, "revision_conflict");
  assert.equal(calls.some((call) => call[0] === "dispatch"), false, "a grant for an older revision cannot act on a newer scope");
  const allowed = await run({ sessionID: "ses_cto", goalScopedAuthorization: true, goalAuthorizationRevision: 2 }, { work: "w1" });
  assert.equal(allowed.ok, true);
  assert.deepEqual(calls, [
    ["authorize", "work_dispatch", "w1", "ses_cto"],
    ["authorize", "work_dispatch", "w1", "ses_cto"],
    ["authorize", "work_dispatch", "w1", "ses_cto"],
    ["dispatch", "w1", 2],
  ]);
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

test("resume recovers a card stuck at running whose worker was paused outside work_pause", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "w20-stranded" });
  const dispatched = await control.workDispatch({ key: "w20s-d", work: created.workId });
  // The delegate engine paused the worker directly (e.g. §11.6 preemption):
  // the job is paused, the work envelope still says running.
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "paused";
  const resumed = await control.workResume({ key: "w20s-r", work: created.workId });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.resumed, [dispatched.jobId]);
  assert.equal(resumed.state, "running");

  // A genuinely running worker is not "stranded" — resume still refuses.
  await assert.rejects(control.workResume({ key: "w20s-r2", work: created.workId }), /not paused/);
});

test("CEO imperatives without an implementation verb still mint a charter; resume is charter-authorized", async () => {
  for (const text of [
    "wtf i'm telling you to fucking do it so do it and use gpt 5.6 sol",
    "just fucking use another model if chutes doesn't work",
    "Go ahead and get it done.",
  ]) {
    const acceptedTurn = { id: `adm-${text}`, sessionId: "ses_cto", messageID: "msg_ceo", acceptedAt: 9, text };
    const { control, workStore, jobs } = makeWorkControl({ acceptedTurn });
    const id = `imp-${Buffer.from(text).toString("hex").slice(0, 12)}`;
    await control.workCreate({
      key: `${id}-c`, id, project: "manta", objective: "Recover the worker",
      specText: "# Outcome\nRecover it.", deliveryTarget: { kind: "pr" }, state: "ready",
    }, { sessionID: "ses_cto" });
    assert.ok((await workStore.load(id)).executionCharter, text);

    const dispatched = await control.workDispatch({ key: `${id}-d`, work: id });
    // Stranded: job paused, card still running — resume needs no second ask.
    jobs.jobs.find((j) => j.id === dispatched.jobId).status = "paused";
    acceptedTurn.text = "You are the on-call CTO driving work to completion.";
    assert.equal((await control.authorizeGoalMutation("work_resume", { work: id }, "ses_cto")).allowed, true, text);
    // A live worker is not resumable.
    jobs.jobs.find((j) => j.id === dispatched.jobId).status = "running";
    assert.equal(await control.authorizeGoalMutation("work_resume", { work: id }, "ses_cto"), false, text);
  }
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


// ---------------------------------------------------------------------------
// V-block — §11 work-stage tools: work_review / work_merge / work_release /
// work_rollback / work_verify / work_complete. The comment block at the top
// of this file promised these tests; the implementation shipped without a
// single one. Every test quotes the §11 sentence it pins, and every guarantee
// was VERIFIED to fail when broken in the source (each test's counterfactual
// note says exactly what was flipped).
// ---------------------------------------------------------------------------

const HEAD1 = "head1234head1234head1234head1234head12";
const HEAD2 = "head5678head5678head5678head5678head56";
const MERGE_COMMIT = "merge40hex0123456789abcdef0123456789";

const GREEN_CHECKS = [
  { name: "ci", status: "completed", conclusion: "success" },
  { name: "lint", status: "completed", conclusion: "success" },
];

// Drive a work to the implementation-report-complete CLAIM via the standard
// dispatch → terminal-worker walk. By §1.1 that is a CLAIM — never a verified
// completion — and the distinction is load-bearing for every §11 stage below.
async function reportImplementationComplete(control, jobs, { id, ...createOverrides }) {
  const created = await seedReadyWork(control, { id, ...createOverrides });
  const dispatched = await control.workDispatch({ key: `${id}-d`, work: created.workId });
  const job = jobs.jobs.find((j) => j.id === dispatched.jobId);
  job.status = "done";
  job.result = "implemented against the pinned spec; tests executed and passed";
  const adopted = await control.recordWorkerOutcome(job);
  assert.equal(adopted.adopted, true);
  return created;
}

// Request the independent review (work_review) and adopt the reviewer's
// terminal report through the normal outcome pump. `verdict` selects the
// report body: "approved" | "changes_requested" | "no-verdict" (prose that
// mentions approval WITHOUT the machine-readable marker line).
async function runReview(control, jobs, { id, workId, headSha, reviewerModel, verdict }) {
  const review = await control.workReview({ key: `${id}-rv`, work: workId, headSha, reviewerModel });
  const reviewJob = jobs.jobs.find((j) => j.id === review.jobId);
  assert.equal(reviewJob.correlation.op, "work.review", "the reviewer runs as a work.review job");
  reviewJob.status = "done";
  reviewJob.result =
    verdict === "changes_requested"
      ? `findings: the export path breaks on empty input at ${headSha}\nVERDICT: changes_requested`
      : verdict === "no-verdict"
        ? "looks approved to me overall — LGTM"
        : `findings: none blocking at ${headSha}\nVERDICT: approved`;
  const adopted = await control.recordWorkerOutcome(reviewJob);
  return { review, adopted };
}

// Stage a work through implementation-claim + APPROVED review — the exact
// precondition the merge gate requires (a live independent_review_approved
// claim pinned to a head).
async function stageApprovedWork(control, jobs, { id, headSha, reviewerModel = "reviewer-x", ...createOverrides }) {
  const created = await reportImplementationComplete(control, jobs, { id, ...createOverrides });
  const { adopted } = await runReview(control, jobs, { id, workId: created.workId, headSha, reviewerModel, verdict: "approved" });
  assert.equal(adopted.verdict, "approved");
  return created;
}

// A release contract is DATA identifying an existing pipeline (§11): the
// closed field set, descriptive fields only.
function seedContract(overrides = {}) {
  return {
    id: "rc-manta-web",
    // The contract scopes by the ENVELOPE's workspaceId — the §4.1 durable
    // key the harness's "manta" project carries.
    workspaceId: MANTA_PROJECT_ID,
    pipeline: "manta-web-deploy",
    allowedTargets: ["web"],
    allowedChannels: ["prod"],
    sourceRevision: "main@<gitsha>",
    artifactIdentity: "docker:image@sha256:<digest>",
    verification: "probe /healthz on the target",
    mutates: true,
    ...overrides,
  };
}

function deployedTarget(instance = "app.mantaui.com") {
  return { kind: "deployed", releaseTarget: "web", channel: "prod", instance };
}

// -- V1 · independent review ------------------------------------------------

// §11: "Review is independent of implementation context. Record reviewer
// model ID, reviewed head SHA, spec hash, findings and verdict."
test("V1: the review dispatch pins the exact head + spec hash, passes the REQUESTED model verbatim, and runs in an independent context", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v1a" });
  const review = await control.workReview({ key: "w-v1a-rv", work: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x" });
  assert.equal(review.ok, true);
  const start = calls.find((c) => c.name === "startJob" && c.input.correlation?.op === "work.review");
  assert.ok(start, "the reviewer was dispatched through the delegate engine");
  assert.ok(start.input.prompt.includes(HEAD1), "the prompt pins the exact reviewed head");
  assert.ok(start.input.prompt.includes("sha256:aaa"), "the prompt pins the spec hash under review");
  assert.equal(start.input.model, "reviewer-x", "the REQUESTED reviewer model passes through verbatim — never substituted");
  assert.equal(start.input.isolationRequired, true, "review is independent of the implementation context");
  assert.equal(start.input.targetProject, "manta", "an explicit target, never parent lookup");
  assert.equal(start.input.parentSessionID, "ses_cto", "the reviewer reports into the CTO conversation");
  assert.equal(start.input.correlation.workId, created.workId);
  const { data } = await control.workInspect({ work: created.workId });
  const attempt = data.attempts.find((a) => a.stage === "review");
  assert.ok(attempt, "the review attempt is recorded");
  assert.equal(attempt.headSha, HEAD1, "§11: the reviewed head SHA is recorded");
  assert.equal(attempt.specHash, "sha256:aaa", "§11: the spec hash is recorded");
  assert.equal(attempt.reviewerModel, "reviewer-x", "§11: the reviewer model ID is recorded");
  assert.equal(attempt.jobId, review.jobId, "the attempt is linked to the reviewer job");
});

// Counterfactual for the record-the-verdict half of V1: the approval exists
// only AFTER the reviewer's terminal report, carrying the report's findings,
// and the claim lands exactly once.
test("V1: an approval is recorded from the reviewer's terminal report — head, spec, model, findings — exactly once", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v1b" });
  const { adopted } = await runReview(control, jobs, { id: "w-v1b", workId: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x", verdict: "approved" });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.verdict, "approved");
  const { data } = await control.workInspect({ work: created.workId });
  const approvals = data.claims.filter((c) => c.kind === REVIEW_CLAIM);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].headSha, HEAD1);
  assert.equal(approvals[0].specHash, "sha256:aaa");
  assert.equal(approvals[0].reviewerModel, "reviewer-x");
  assert.ok(approvals[0].note.includes("findings"), "the report's findings travel on the claim (§11: findings recorded)");
  // The outcome pump replays the same terminal event without duplicating.
  const reviewJob = jobs.jobs.find((j) => j.correlation?.op === "work.review");
  reviewJob.status = "done";
  const again = await control.recordWorkerOutcome(reviewJob);
  assert.equal(again.claim ?? null, null, "the repeat created no second claim");
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.equal(after.claims.filter((c) => c.kind === REVIEW_CLAIM).length, 1, "the approval landed exactly once");
});

// Counterfactual (V1): a report without the machine-readable marker records a
// FAILED review — never a guessed approval. (Seen red by making
// parseReviewVerdict keyword-search "approved": this test then fails because
// a claim appears and the attempt stops reading failed.)
test("V1 counterfactual: prose that merely mentions approval is NOT a verdict — a failed review, no approval claim", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v1c" });
  const { adopted } = await runReview(control, jobs, { id: "w-v1c", workId: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x", verdict: "no-verdict" });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.verdict, null, "no verdict may be invented from prose");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === REVIEW_CLAIM), false, "no approval claim exists");
  const attempt = data.attempts.find((a) => a.stage === "review");
  assert.equal(attempt.status, "failed", "the review attempt reads failed");
  assert.ok(attempt.note.includes("machine-readable verdict"), "the note says WHY: no machine-readable verdict");
  assert.equal(data.state, "waiting", "the work is back to awaiting its next stages");
  assert.equal(data.waitingReason, "external");
});

// -- V2 · a reviewer failing to start is a BLOCKED review --------------------

// §11: "A reviewer failing to start is a blocked review, not a passed review
// or permission to switch to another requested model." Counterfactual
// positive control: with the engine healthy the same dispatch succeeds (V1).
// (Seen red by deleting workReview's failure revert: the state/recoverability
// assertions fail with the work stranded in "running".)
test("V2: a reviewer failing to start is a BLOCKED review — no approval, no model substitution, and the work is reviewable again", async () => {
  const { control, jobs, calls } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v2a" });
  // The engine's worktree health is live — flip it, then request the review.
  jobs.worktreeOk = false;
  await assert.rejects(
    control.workReview({ key: "w-v2a-rv", work: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x" }),
    (error) => {
      assert.equal(error.code, "provider_unavailable");
      assert.ok(/BLOCKED/.test(error.message), "the error says the review is BLOCKED, not passed");
      assert.ok(error.message.includes("reviewer-x"), "names the requested model — it was NOT substituted");
      return true;
    },
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === REVIEW_CLAIM), false, "a blocked review records NO approval claim");
  const attempt = data.attempts.find((a) => a.stage === "review");
  assert.equal(attempt.status, "failed", "the blocked attempt is failed, visibly");
  assert.ok(attempt.note.includes("BLOCKED review"), "the note carries the blocked reason");
  assert.equal(data.state, "waiting", "the work returned to its pre-review admission state (not stranded in running)");
  assert.equal(data.waitingReason, "external");
  // Recoverability: with the engine healthy again, the review dispatches.
  jobs.worktreeOk = true;
  const retried = await control.workReview({ key: "w-v2a-rv2", work: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x" });
  assert.equal(retried.ok, true);
  const starts = calls.filter((c) => c.name === "startJob" && c.input.correlation?.op === "work.review");
  assert.equal(starts.length, 2);
  for (const s of starts) assert.equal(s.input.model, "reviewer-x", "every attempt keeps the requested model");
});

test("V2: a reviewer refused by the CAP is also a blocked review (capacity_wait), never a silent pass", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v2b" });
  jobs.cap = 0; // capacity evaporates between calls — the reviewer cannot start
  await assert.rejects(
    control.workReview({ key: "w-v2b-rv", work: created.workId, headSha: HEAD1, reviewerModel: "reviewer-x" }),
    (error) => error.code === "capacity_wait" && /BLOCKED/.test(error.message),
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === REVIEW_CLAIM), false);
  assert.equal(data.state, "waiting");
});

// -- V3 · the review-rejection cascade (the carry-forward) --------------------

// The §11 carry-forward: a rejection supersedes the implementation claim the
// rejected head sits on, so downstream work admitted on that claim must read
// its dependency as UNMET. (Seen red by making the rejection adoption a no-op
// for IMPLEMENTATION_CLAIM — the re-dispatch then still succeeded.)
test("V3: the review-rejection cascade — A claims complete, B is admitted on A's claim, A's review rejects, and B's dependency reads unmet", async () => {
  const { control, jobs } = makeWorkControl();
  const a = await reportImplementationComplete(control, jobs, { id: "w-v3-a" });
  // B is admitted on A's UNVERIFIED claim — the positive control that the
  // dependency reads met while the claim is live.
  const b = await control.workCreate({
    key: "w-v3-b",
    project: "manta",
    objective: "downstream consumer of the export fix",
    spec: { revision: 1, hash: "sha256:bbb", documentRef: "docs/specs/consumer.md#rev1" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    dependencies: [a.workId],
  });
  const bDispatch = await control.workDispatch({ key: "w-v3-bd", work: b.workId });
  assert.equal(bDispatch.ok, true, "B is admitted on A's reported (unverified) claim");
  // A's independent review REJECTS the head.
  const { adopted } = await runReview(control, jobs, { id: "w-v3-a", workId: a.workId, headSha: HEAD1, reviewerModel: "reviewer-x", verdict: "changes_requested" });
  assert.equal(adopted.verdict, "changes_requested");
  const { data: aNow } = await control.workInspect({ work: a.workId });
  const implClaim = aNow.claims.find((c) => c.kind === IMPLEMENTATION_CLAIM);
  assert.equal(implClaim.superseded, true, "§11 carry-forward: the rejected head supersedes the implementation claim it sits on");
  assert.ok(implClaim.supersededReason.includes("requested changes"), "the supersession names the review");
  assert.equal(aNow.claims.some((c) => c.kind === REVIEW_CLAIM && c.superseded !== true), false, "a rejection records no approval");
  // B's dependency must read UNMET: stop B's stranded worker (its foundation
  // was rejected), which returns B to ready; the next dispatch is refused
  // and B parks durably on the dependency.
  const bJob = jobs.jobs.find((j) => j.id === bDispatch.jobId);
  bJob.status = "stopped";
  bJob.error = "worker stranded by the rejected dependency";
  await control.recordWorkerOutcome(bJob);
  const { data: bReady } = await control.workInspect({ work: b.workId });
  assert.equal(bReady.state, "ready", "B is dispatchable again in shape — the gate now decides");
  await assert.rejects(
    control.workDispatch({ key: "w-v3-bd2", work: b.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(error.message.includes(a.workId), "names the now-unmet dependency");
      return true;
    },
  );
  const { data: bParked } = await control.workInspect({ work: b.workId });
  assert.equal(bParked.state, "waiting");
  assert.equal(bParked.waitingReason, "dependency", "§9: the wait reason is durable and visible");
});

// Counterfactual (V3): an approving review leaves the claim live and
// downstream dispatchable. (Seen red by making the approval supersede the
// implementation claim too — the downstream dispatch then refused.)
test("V3 counterfactual: an APPROVING review leaves the implementation claim live and downstream dispatchable", async () => {
  const { control, jobs } = makeWorkControl();
  const a = await reportImplementationComplete(control, jobs, { id: "w-v3c-a" });
  await runReview(control, jobs, { id: "w-v3c-a", workId: a.workId, headSha: HEAD1, reviewerModel: "reviewer-x", verdict: "approved" });
  const { data: aNow } = await control.workInspect({ work: a.workId });
  const implClaim = aNow.claims.find((c) => c.kind === IMPLEMENTATION_CLAIM);
  assert.equal(implClaim.superseded, false, "an approving review does NOT supersede the claim it approved");
  assert.equal(aNow.claims.some((c) => c.kind === REVIEW_CLAIM && c.superseded !== true), true);
  // Downstream stays dispatchable on the still-live claim.
  const b = await control.workCreate({
    key: "w-v3c-b",
    project: "manta",
    objective: "downstream consumer",
    spec: { revision: 1, hash: "sha256:bbb", documentRef: "docs/specs/consumer.md#rev1" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    dependencies: [a.workId],
  });
  const bDispatch = await control.workDispatch({ key: "w-v3c-bd", work: b.workId });
  assert.equal(bDispatch.ok, true, "the claim is still live → downstream admits");
});

// -- V4 · head-change invalidation --------------------------------------------

// §11: "When head SHA changes, invalidate approval. If only nonbehavioral
// material changed, an independent reviewer can explicitly confirm the new
// head; do not preserve old approval silently." (Seen red by making
// invalidateApprovalClaimsForHead return the claims unchanged: the old
// approval stayed live through both observation points.)
test("V4: a review request for a NEW head invalidates the approval of the old head at the observation point", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await stageApprovedWork(control, jobs, { id: "w-v4a", headSha: HEAD1 });
  const { data: before } = await control.workInspect({ work: created.workId });
  assert.equal(before.claims.filter((c) => c.kind === REVIEW_CLAIM && c.superseded !== true).length, 1);
  // A new head appears; the CTO requests an independent re-review of it.
  // The old approval is invalidated HERE — the new-head request is the
  // observation of the head change.
  const review2 = await control.workReview({ key: "w-v4a-rv2", work: created.workId, headSha: HEAD2, reviewerModel: "reviewer-x" });
  assert.equal(review2.ok, true);
  const { data } = await control.workInspect({ work: created.workId });
  const oldApproval = data.claims.find((c) => c.kind === REVIEW_CLAIM && c.headSha === HEAD1);
  assert.equal(oldApproval.superseded, true, "the old approval is invalidated — never preserved silently");
  assert.ok(oldApproval.supersededReason.includes(HEAD2), "the reason names the new head");
  assert.equal(data.claims.some((c) => c.kind === REVIEW_CLAIM && c.superseded !== true), false, "no live approval until the new head's review lands");
});

test("V4: the forge's live PR head invalidates a stale approval at merge time and the merge never runs", async () => {
  // §11: "Merge uses a matching-head precondition." (Seen red by skipping the
  // head comparison in forgeGate: the merge proceeded on a moved head.)
  const forge = makeForgeSpy({ prs: { 7: { headSha: HEAD2, state: "open" } } });
  const { control, jobs } = makeWorkControl({ forge });
  const created = await stageApprovedWork(control, jobs, { id: "w-v4b", headSha: HEAD1, repositoryId: "octo/repo" });
  await assert.rejects(
    control.workMerge({ key: "w-v4b-m", work: created.workId, prNumber: 7 }),
    (error) => {
      assert.equal(error.code, "target_changed");
      assert.ok(error.message.includes(HEAD1) && error.message.includes(HEAD2), "the mismatch names both identities");
      return true;
    },
  );
  assert.equal(forge.calls.some((c) => c.name === "merge"), false, "the merge is never attempted on a moved head");
  const { data } = await control.workInspect({ work: created.workId });
  const approval = data.claims.find((c) => c.kind === REVIEW_CLAIM && c.headSha === HEAD1);
  assert.equal(approval.superseded, true, "the approval was invalidated at the observation point");
  assert.ok(approval.supersededReason.includes("moved past approved"), "the reason says the forge observed the move");
});

// -- V5 · the merge gate -------------------------------------------------------

// §11: "Required checks are queried from the forge and must correspond to
// that head. Merge uses a matching-head precondition." (Seen red by removing
// the approval precondition: merge then proceeded with zero forge calls.)
test("V5: merge refuses without a live exact-head approval — evidence_missing, and the forge is never consulted", async () => {
  const forge = makeForgeSpy({ prs: { 9: { headSha: HEAD1, state: "open" }, checksBySha: { [HEAD1]: GREEN_CHECKS } } });
  const { control } = makeWorkControl({ forge });
  const created = await seedReadyWork(control, { id: "w-v5a", repositoryId: "octo/repo" });
  await assert.rejects(
    control.workMerge({ key: "w-v5a-m", work: created.workId, prNumber: 9 }),
    (error) => {
      assert.equal(error.code, "evidence_missing");
      assert.ok(/independent_review_approved/.test(error.message), "names the missing observation");
      return true;
    },
  );
  assert.equal(forge.calls.length, 0, "no approval → the forge is never consulted");
});

test("V5: required checks are queried FROM THE FORGE for the approved head — not green → no merge", async () => {
  const forge = makeForgeSpy({
    prs: { 9: { headSha: HEAD1, state: "open" } },
    checksBySha: { [HEAD1]: [{ name: "ci", status: "completed", conclusion: "failure" }] },
  });
  const { control, jobs } = makeWorkControl({ forge });
  const created = await stageApprovedWork(control, jobs, { id: "w-v5b", headSha: HEAD1, repositoryId: "octo/repo" });
  await assert.rejects(
    control.workMerge({ key: "w-v5b-m", work: created.workId, prNumber: 9 }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/green/.test(error.message));
      return true;
    },
  );
  const gateRead = forge.calls.find((c) => c.name === "getChecks");
  assert.ok(gateRead, "the gate consulted the forge for checks");
  assert.equal(gateRead.sha, HEAD1, "checks were queried for the APPROVED head (§11: 'must correspond to that head')");
  assert.equal(forge.calls.some((c) => c.name === "merge"), false, "not green → the merge never ran");
});

// Counterfactual (V5): matching head + green forge checks → the merge runs,
// bound to the approved SHA, and records the OBSERVED merge commit.
// (Seen red by passing a different SHA to the forge merge and by recording
// a hardcoded claim — the assertions on the spy call and the claim failed.)
test("V5 counterfactual: green checks on the matching head → the forge merge bound to the approved SHA records merged_commit_exists", async () => {
  const forge = makeForgeSpy({ prs: { 9: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT });
  const { control, jobs } = makeWorkControl({ forge });
  const created = await stageApprovedWork(control, jobs, { id: "w-v5c", headSha: HEAD1, repositoryId: "octo/repo" });
  const merged = await control.workMerge({ key: "w-v5c-m", work: created.workId, prNumber: 9 });
  assert.equal(merged.ok, true);
  const mergeCall = forge.calls.find((c) => c.name === "merge");
  assert.equal(mergeCall.sha, HEAD1, "the merge is BOUND to the approved SHA (matching-head precondition)");
  const { data } = await control.workInspect({ work: created.workId });
  const claim = data.claims.find((c) => c.kind === MERGE_CLAIM);
  assert.ok(claim, "merged_commit_exists is recorded");
  assert.equal(claim.mergeCommitSha, MERGE_COMMIT, "the claim carries the forge's OBSERVED merge commit");
  assert.equal(claim.headSha, HEAD1);
  assert.equal(claim.prNumber, 9);
  assert.ok(data.evidence.some((r) => r.kind === "forge" && r.id === `forge:merge:octo/repo#9@${HEAD1}`), "a forge evidence row records the observation");
  assert.ok(merged.summary.includes("green on THAT head"));
});

test("V5: the merge is idempotent via key — a replay returns the original result and the forge merged exactly once", async () => {
  const forge = makeForgeSpy({ prs: { 9: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT });
  const { control, jobs } = makeWorkControl({ forge });
  const created = await stageApprovedWork(control, jobs, { id: "w-v5d", headSha: HEAD1, repositoryId: "octo/repo" });
  const first = await control.workMerge({ key: "w-v5d-m", work: created.workId, prNumber: 9 });
  assert.equal(first.ok, true);
  const replay = await control.workMerge({ key: "w-v5d-m", work: created.workId, prNumber: 9 });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true, "the replay is marked as such");
  assert.equal(replay.mergeCommitSha, first.mergeCommitSha, "the original result is returned verbatim");
  assert.equal(forge.calls.filter((c) => c.name === "merge").length, 1, "the forge merged exactly once");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.filter((c) => c.kind === MERGE_CLAIM).length, 1, "one claim, not two");
});

// -- V6 · the release contract -------------------------------------------------

// §11: "Each project release contract identifies its existing pipeline,
// allowed target/channel, source revision mechanism, artifact identity and
// verification procedure. It is data referencing existing workflows, not an
// arbitrary executable DSL. Missing contract → … requested deployment is
// visibly blocked rather than guessed." (Seen red by returning a default
// contract when none matches — the trigger then ran without a contract.)
test("V6: a missing release contract visibly BLOCKS the deployment — the trigger never runs on a guess", async () => {
  const releaseTriggerCalls = [];
  const { control } = makeWorkControl({
    releaseContracts: [],
    releaseTrigger: async (input) => {
      releaseTriggerCalls.push(input);
      return { runId: "run-x", artifact: { identity: "docker:x" } };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v6a", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await assert.rejects(
    control.workRelease({ key: "w-v6a-r", work: created.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/release contract/.test(error.message), "the block NAMES the missing contract");
      return true;
    },
  );
  assert.equal(releaseTriggerCalls.length, 0, "the trigger never ran without a contract");
  // §6: stages not needed for the declared target are explicitly skipped —
  // a pr-target work RELEASES nothing.
  const prWork = await seedReadyWork(control, { id: "w-v6a-pr" });
  await assert.rejects(
    control.workRelease({ key: "w-v6a-pr-r", work: prWork.workId }),
    (error) => error.code === "policy_blocked" && /delivery target pr/.test(error.message),
  );
  assert.equal(releaseTriggerCalls.length, 0);
});

// §11: "Before an authorized configuration/infrastructure mutation, preserve
// a recovery reference." (Seen red by dropping the mutates guard: the
// trigger then ran with no recovery reference.)
test("V6: a MUTATING contract refuses to run without a preserved recovery reference; a non-mutating one does not need it", async () => {
  const releaseTriggerCalls = [];
  const { control } = makeWorkControl({
    releaseContracts: [seedContract()],
    releaseTrigger: async (input) => {
      releaseTriggerCalls.push(input);
      return { runId: "run-y", artifact: { identity: "docker:y" } };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v6b", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await assert.rejects(
    control.workRelease({ key: "w-v6b-r", work: created.workId }),
    (error) => {
      assert.equal(error.code, "evidence_missing");
      assert.ok(/recovery/.test(error.message), "names the missing recovery reference");
      return true;
    },
  );
  assert.equal(releaseTriggerCalls.length, 0, "the mutation never ran unreferenced");
  // Counterfactual: a NON-mutating contract releases without one.
  const { control: noMutate } = makeWorkControl({
    releaseContracts: [seedContract({ id: "rc-nm", mutates: false })],
    releaseTrigger: async () => ({ runId: "run-nm", artifact: { identity: "docker:nm" } }),
  });
  const nmWork = await seedReadyWork(noMutate, { id: "w-v6b-nm", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  const released = await noMutate.workRelease({ key: "w-v6b-nm-r", work: nmWork.workId });
  assert.equal(released.ok, true, "non-mutating → no recovery reference required");
});

// Counterfactual (V6): contract + trigger → the OBSERVED run + artifact
// identity is the claim. (Seen red by recording a hardcoded claim instead of
// the observed one, and by dropping recoveryRef from the claim.)
test("V6 counterfactual: contract + trigger → artifact_published records the OBSERVED run + artifact identity", async () => {
  const releaseTriggerCalls = [];
  const { control } = makeWorkControl({
    releaseContracts: [seedContract()],
    releaseTrigger: async (input) => {
      releaseTriggerCalls.push(input);
      return { runId: "run-4242", artifact: { identity: "docker:manta@sha256:abc123", digest: "sha256:def456", version: "1.2.3" } };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v6c", deliveryTarget: deployedTarget() });
  const released = await control.workRelease({ key: "w-v6c-r", work: created.workId, recoveryRef: "rollback:manta/1.2.2" });
  assert.equal(released.ok, true);
  assert.equal(releaseTriggerCalls.length, 1);
  assert.equal(releaseTriggerCalls[0].contract.id, "rc-manta-web", "the trigger ran with the resolved CONTRACT (data), not a guessed pipeline");
  assert.equal(releaseTriggerCalls[0].recoveryRef, "rollback:manta/1.2.2");
  const { data } = await control.workInspect({ work: created.workId });
  const claim = data.claims.find((c) => c.kind === RELEASE_CLAIM);
  assert.ok(claim);
  assert.equal(claim.runId, "run-4242", "§11: the observed run identity");
  assert.equal(claim.artifact.identity, "docker:manta@sha256:abc123", "§11: the observed artifact identity");
  assert.equal(claim.pipeline, "manta-web-deploy");
  assert.equal(claim.recoveryRef, "rollback:manta/1.2.2", "the recovery reference is preserved ON the release record (§11)");
  assert.ok(data.evidence.some((r) => r.id === "release:manta-web-deploy:run-4242"));
  assert.ok(released.summary.includes("not yet verified"), "the release REQUEST ran — verification is a separate observation (§11)");
});

test("V6: a trigger that returns no observed run/artifact identity records NOTHING", async () => {
  const { control } = makeWorkControl({
    releaseContracts: [seedContract({ mutates: false })],
    releaseTrigger: async () => ({ runId: "run-7", artifact: {} }),
  });
  const created = await seedReadyWork(control, { id: "w-v6d", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await assert.rejects(
    control.workRelease({ key: "w-v6d-r", work: created.workId }),
    (error) => {
      assert.equal(error.code, "provider_unavailable");
      assert.ok(/identity/.test(error.message));
      return true;
    },
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === RELEASE_CLAIM), false, "no release without observed identity (§11: evidence, never assertion)");
});

// -- V7 · rollback is explicit --------------------------------------------------

// §11: "Rollback is an explicit operation with its own result, not assumed
// possible for every migration." (Seen red by defaulting the recovery ref to
// a placeholder and by letting the trigger run unreferenced.)
test("V7: rollback with nothing published is policy_blocked; published-without-reference is evidence_missing — never assumed possible", async () => {
  const rollbackTriggerCalls = [];
  const { control } = makeWorkControl({
    releaseContracts: [seedContract({ mutates: false })],
    releaseTrigger: async () => ({ runId: "run-nr", artifact: { identity: "docker:manta@sha256:zzz" } }),
    rollbackTrigger: async (input) => {
      rollbackTriggerCalls.push(input);
      return { ok: true };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v7a", deliveryTarget: deployedTarget() });
  await assert.rejects(
    control.workRollback({ key: "w-v7a-rb1", work: created.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/artifact_published/.test(error.message), "names the missing release observation");
      return true;
    },
  );
  // Release WITHOUT a preserved recovery reference (non-mutating contract).
  await control.workRelease({ key: "w-v7a-r", work: created.workId });
  await assert.rejects(
    control.workRollback({ key: "w-v7a-rb2", work: created.workId }),
    (error) => {
      assert.equal(error.code, "evidence_missing");
      assert.ok(/recovery/.test(error.message), "names the missing recovery reference");
      return true;
    },
  );
  assert.equal(rollbackTriggerCalls.length, 0, "the trigger never ran for an impossible rollback");
});

// Counterfactual (V7): a wired trigger + preserved reference executes the
// rollback, records its OWN result, and touches no claim. (Seen red by
// revoking the release claim in the rollback path.)
test("V7 counterfactual: wired trigger + preserved reference → the rollback runs, records its own result, and touches no claim", async () => {
  const rollbackTriggerCalls = [];
  const { control } = makeWorkControl({
    releaseContracts: [seedContract()],
    releaseTrigger: async () => ({ runId: "run-rb", artifact: { identity: "docker:manta@sha256:yyy", version: "2.0.0" } }),
    rollbackTrigger: async (input) => {
      rollbackTriggerCalls.push(input);
      return { ok: true, revertedTo: "1.9.9" };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v7b", deliveryTarget: deployedTarget() });
  await control.workRelease({ key: "w-v7b-r", work: created.workId, recoveryRef: "rollback:manta/1.9.9" });
  const { data: before } = await control.workInspect({ work: created.workId });
  const claimsBefore = before.claims;
  assert.ok(claimsBefore.some((c) => c.kind === RELEASE_CLAIM));
  const rolled = await control.workRollback({ key: "w-v7b-rb", work: created.workId });
  assert.equal(rolled.ok, true);
  assert.equal(rollbackTriggerCalls.length, 1);
  assert.equal(rollbackTriggerCalls[0].recoveryRef, "rollback:manta/1.9.9", "the trigger ran with the PRESERVED recovery reference");
  assert.equal(rollbackTriggerCalls[0].contract.id, "rc-manta-web", "the trigger ran with the resolved contract");
  const { data: after } = await control.workInspect({ work: created.workId });
  assert.deepEqual(after.claims.map((c) => c.id), claimsBefore.map((c) => c.id), "no claim was created");
  assert.deepEqual(
    after.claims.map((c) => c.superseded ?? false),
    claimsBefore.map((c) => c.superseded ?? false),
    "…and none was revoked — rollback records only its own result",
  );
  assert.ok(after.evidence.some((r) => r.id.startsWith("rollback:")), "the rollback's own observation is recorded");
  assert.ok(rolled.summary.includes("no completion or verification claim"));
});

test("V7: an UNWIRED rollback trigger fails unsupported — rollback is explicit or not offered, never faked", async () => {
  const { control } = makeWorkControl({
    releaseContracts: [seedContract({ mutates: false })],
    releaseTrigger: async () => ({ runId: "run-u", artifact: { identity: "docker:u" } }),
    // rollbackTrigger deliberately unwired.
  });
  const created = await seedReadyWork(control, { id: "w-v7c", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await control.workRelease({ key: "w-v7c-r", work: created.workId, recoveryRef: "snap-1" });
  await assert.rejects(
    control.workRollback({ key: "w-v7c-rb", work: created.workId }),
    (error) => error.code === "unsupported" && /rollbackTrigger/.test(error.message),
  );
});

// -- V8 · verification never trusts a green build alone -------------------------

// §11: "Production verification never trusts a green build alone. Check
// expected SHA/artifact digest/version against the actual target as
// supported." (Seen red by accepting the probe's sha as the expected value:
// the mismatch test then recorded both claims.)
test("V8: verification with NO expected identity refuses — it compares observations, never asserts them", async () => {
  const probeCalls = [];
  const { control } = makeWorkControl({
    targetProbe: async (input) => {
      probeCalls.push(input);
      return { sha: HEAD1, checks: [] };
    },
  });
  const created = await seedReadyWork(control, { id: "w-v8a", deliveryTarget: deployedTarget() });
  await assert.rejects(
    control.workVerify({ key: "w-v8a-v", work: created.workId }),
    (error) => {
      assert.equal(error.code, "evidence_missing");
      assert.ok(/expected artifact identity/.test(error.message));
      return true;
    },
  );
  assert.equal(probeCalls.length, 0, "the probe never ran against a work with nothing to compare");
});

// The §1.1 red line: a GREEN build with a MISMATCHED target must yield
// neither target_runs_artifact nor acceptance_checks_passed. (Seen red by
// skipping the mismatch comparison — both claims then appeared.)
test("V8: a green build on a MISMATCHED target yields NO claim — both §11 observations are withheld", async () => {
  const { control, jobs } = makeWorkControl({
    forge: makeForgeSpy({ prs: { 5: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT }),
    targetProbe: async () => ({ sha: HEAD2, digest: "sha256:digest9", checks: [{ name: "smoke", passed: true }] }),
  });
  const created = await stageApprovedWork(control, jobs, { id: "w-v8b", headSha: HEAD1, repositoryId: "octo/repo", deliveryTarget: deployedTarget() });
  await control.workMerge({ key: "w-v8b-m", work: created.workId, prNumber: 5 });
  await assert.rejects(
    control.workVerify({ key: "w-v8b-v", work: created.workId }),
    (error) => {
      assert.equal(error.code, "target_changed");
      assert.ok(error.message.includes(MERGE_COMMIT) && error.message.includes(HEAD2), "the mismatch names BOTH identities");
      return true;
    },
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === TARGET_RUNS_CLAIM), false, "target_runs_artifact is NOT recorded");
  assert.equal(data.claims.some((c) => c.kind === ACCEPTANCE_CLAIM), false, "acceptance_checks_passed is NOT recorded despite passing checks");
});

// Counterfactual (V8): a matching probe records BOTH claims with the observed
// identity. (Seen red by breaking the claim recording entirely.)
test("V8 counterfactual: a matching probe records target_runs_artifact AND acceptance_checks_passed with the observed identity", async () => {
  const { control, jobs } = makeWorkControl({
    forge: makeForgeSpy({ prs: { 5: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT }),
    releaseContracts: [seedContract({ mutates: false })],
    releaseTrigger: async () => ({ runId: "run-9", artifact: { identity: "docker:manta@sha256:kkk", digest: "sha256:digest9", version: "3.4.5" } }),
    targetProbe: async () => ({ sha: MERGE_COMMIT, digest: "sha256:digest9", version: "3.4.5", checks: [{ name: "smoke", passed: true }, { name: "export-fix", passed: true }] }),
  });
  const created = await stageApprovedWork(control, jobs, { id: "w-v8c", headSha: HEAD1, repositoryId: "octo/repo", deliveryTarget: deployedTarget() });
  await control.workMerge({ key: "w-v8c-m", work: created.workId, prNumber: 5 });
  await control.workRelease({ key: "w-v8c-r", work: created.workId, recoveryRef: "snap-9" });
  const verified = await control.workVerify({ key: "w-v8c-v", work: created.workId });
  assert.equal(verified.ok, true);
  const { data } = await control.workInspect({ work: created.workId });
  const runs = data.claims.find((c) => c.kind === TARGET_RUNS_CLAIM);
  const acceptance = data.claims.find((c) => c.kind === ACCEPTANCE_CLAIM);
  assert.ok(runs, "target_runs_artifact recorded");
  assert.equal(runs.observedSha, MERGE_COMMIT);
  assert.equal(runs.observedDigest, "sha256:digest9");
  assert.equal(runs.expectedSha, MERGE_COMMIT, "the claim names what was EXPECTED and what was OBSERVED");
  assert.equal(runs.target, "app.mantaui.com");
  assert.ok(acceptance, "acceptance_checks_passed recorded");
  assert.deepEqual(acceptance.checks.map((c) => c.name), ["smoke", "export-fix"]);
});

test("V8: a probe that observes nothing comparable refuses — verification never asserts a match it could not compare", async () => {
  const { control, jobs } = makeWorkControl({
    forge: makeForgeSpy({ prs: { 5: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS } }),
    targetProbe: async () => ({ digest: "sha256:zzz" }), // no release claim → no digest to compare against
  });
  const created = await stageApprovedWork(control, jobs, { id: "w-v8d", headSha: HEAD1, repositoryId: "octo/repo", deliveryTarget: deployedTarget() });
  await control.workMerge({ key: "w-v8d-m", work: created.workId, prNumber: 5 });
  await assert.rejects(
    control.workVerify({ key: "w-v8d-v", work: created.workId }),
    (error) => error.code === "evidence_missing" && /nothing comparable/.test(error.message),
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === TARGET_RUNS_CLAIM), false);
});

test("V8: the target running the expected artifact with FAILING acceptance checks records the identity but NOT acceptance_checks_passed", async () => {
  const { control, jobs } = makeWorkControl({
    forge: makeForgeSpy({ prs: { 5: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT }),
    targetProbe: async () => ({ sha: MERGE_COMMIT, checks: [{ name: "export-fix", passed: false }] }),
  });
  const created = await stageApprovedWork(control, jobs, { id: "w-v8e", headSha: HEAD1, repositoryId: "octo/repo", deliveryTarget: deployedTarget() });
  await control.workMerge({ key: "w-v8e-m", work: created.workId, prNumber: 5 });
  await assert.rejects(
    control.workVerify({ key: "w-v8e-v", work: created.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/export-fix/.test(error.message), "the failure names the failed acceptance check");
      return true;
    },
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.ok(data.claims.some((c) => c.kind === TARGET_RUNS_CLAIM), "the identity observation stands");
  assert.equal(data.claims.some((c) => c.kind === ACCEPTANCE_CLAIM), false, "acceptance_checks_passed is withheld");
  const verifyAttempt = data.attempts.filter((a) => a.stage === "verify").pop();
  assert.equal(verifyAttempt.status, "verified", "the attempt held its identity verification");
  assert.ok(verifyAttempt.note.includes("acceptance checks FAILED"), "the failed checks stay visible on the attempt");
});

// -- V9 · verified completion is the one "completed" writer ---------------------

// §11: "Distinguish these observations: …" + §6 "-> completed | declared
// delivery target and acceptance criteria satisfied | completion evidence,
// not merely worker prose". (Seen red by dropping the missing-evidence guard:
// every refusal below then completed the work.)
test("V9: completion refuses without the declared target's evidence chain — for every kind", async () => {
  const { control } = makeWorkControl();
  const specWork = await seedReadyWork(control, { id: "w-v9a-spec", deliveryTarget: { kind: "spec" } });
  await assert.rejects(
    control.workComplete({ key: "w-v9a-c1", work: specWork.workId }),
    (error) => error.code === "evidence_missing" && /implementation_reported/.test(error.message),
  );
  const prWork = await seedReadyWork(control, { id: "w-v9a-pr", deliveryTarget: { kind: "pr" } });
  await assert.rejects(
    control.workComplete({ key: "w-v9a-c2", work: prWork.workId, prNumber: 1 }),
    (error) => error.code === "evidence_missing" && /independent_review_approved/.test(error.message),
  );
  const mergedWork = await seedReadyWork(control, { id: "w-v9a-merged", deliveryTarget: { kind: "merged", baseBranch: "main" } });
  await assert.rejects(
    control.workComplete({ key: "w-v9a-c3", work: mergedWork.workId }),
    (error) => error.code === "evidence_missing" && /merged_commit_exists/.test(error.message),
  );
  const publishedWork = await seedReadyWork(control, { id: "w-v9a-pub", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await assert.rejects(
    control.workComplete({ key: "w-v9a-c4", work: publishedWork.workId }),
    (error) => error.code === "evidence_missing" && /merged_commit_exists/.test(error.message) && /artifact_published/.test(error.message),
  );
  const deployedWork = await seedReadyWork(control, { id: "w-v9a-dep", deliveryTarget: deployedTarget() });
  await assert.rejects(
    control.workComplete({ key: "w-v9a-c5", work: deployedWork.workId }),
    (error) => {
      assert.equal(error.code, "evidence_missing");
      for (const kind of ["merged_commit_exists", "artifact_published", "target_runs_artifact", "acceptance_checks_passed"]) {
        assert.ok(error.message.includes(kind), `the deployed chain names ${kind}`);
      }
      return true;
    },
  );
  for (const id of ["w-v9a-spec", "w-v9a-pr", "w-v9a-merged", "w-v9a-pub", "w-v9a-dep"]) {
    const { data } = await control.workInspect({ work: id });
    assert.notEqual(data.state, "completed", `${id} was never completed by prose`);
  }
});

// Counterfactual (V9): with the evidence present, work_complete is the one
// verified transition — and the ONLY writer of "completed". (Seen red by
// gating completion on worker prose instead of the claim.)
test("V9 counterfactual: with the evidence chain present the work completes — once", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await reportImplementationComplete(control, jobs, { id: "w-v9b", deliveryTarget: { kind: "spec" } });
  const completed = await control.workComplete({ key: "w-v9b-c", work: created.workId });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, "completed");
  assert.ok(completed.summary.includes("satisfied by evidence"), "the summary names the evidence, not prose");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "completed");
  await assert.rejects(
    control.workComplete({ key: "w-v9b-c2", work: created.workId }),
    (error) => error.code === "policy_blocked" && /already completed/.test(error.message),
  );
});

// The §11 walk: merge → release → verify → complete for a deployed target,
// every observation by evidence. (Seen red at every stage gate.)
test("V9: the full deployed chain — merge, release, verify, complete — completes by evidence", async () => {
  const { control, jobs } = makeWorkControl({
    forge: makeForgeSpy({ prs: { 5: { headSha: HEAD1, state: "open" } }, checksBySha: { [HEAD1]: GREEN_CHECKS }, mergeSha: MERGE_COMMIT }),
    releaseContracts: [seedContract()],
    releaseTrigger: async () => ({ runId: "run-full", artifact: { identity: "docker:manta@sha256:full", digest: "sha256:dfull", version: "5.0.0" } }),
    targetProbe: async () => ({ sha: MERGE_COMMIT, digest: "sha256:dfull", version: "5.0.0", checks: [{ name: "smoke", passed: true }] }),
  });
  const created = await stageApprovedWork(control, jobs, { id: "w-v9c", headSha: HEAD1, repositoryId: "octo/repo", deliveryTarget: deployedTarget() });
  await control.workMerge({ key: "w-v9c-m", work: created.workId, prNumber: 5 });
  await control.workRelease({ key: "w-v9c-r", work: created.workId, recoveryRef: "rollback:manta/4.9.9" });
  await control.workVerify({ key: "w-v9c-v", work: created.workId });
  const completed = await control.workComplete({ key: "w-v9c-c", work: created.workId });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, "completed");
  assert.ok(completed.summary.includes("target_runs_artifact"), "the deployed chain names the live verification");
  assert.ok(completed.summary.includes("acceptance_checks_passed"), "…and the acceptance observation");
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "completed");
});

// §6: "for pr, … independent review and required checks must pass on an open
// PR, but merge is not required". (Seen red by removing the prNumber
// requirement and by letting the gate accept a closed PR.)
test("V9: a pr-target work completes on an OPEN PR with the gate re-observed live — never without prNumber, never on a closed PR", async () => {
  const forge = makeForgeSpy({
    prs: { 12: { headSha: HEAD1, state: "open" }, 13: { headSha: HEAD1, state: "merged" } },
    checksBySha: { [HEAD1]: GREEN_CHECKS },
  });
  const { control, jobs } = makeWorkControl({ forge });
  const open = await stageApprovedWork(control, jobs, { id: "w-v9d-open", headSha: HEAD1, repositoryId: "octo/repo" });
  const completed = await control.workComplete({ key: "w-v9d-c", work: open.workId, prNumber: 12 });
  assert.equal(completed.ok, true);
  assert.equal(forge.calls.some((c) => c.name === "merge"), false, "a pr-target completes WITHOUT merging (§6)");
  assert.ok(completed.summary.includes("re-observed live"), "the completion summary says the gate was re-observed");
  const noPr = await stageApprovedWork(control, jobs, { id: "w-v9d-nopr", headSha: HEAD1, repositoryId: "octo/repo" });
  await assert.rejects(
    control.workComplete({ key: "w-v9d-c2", work: noPr.workId }),
    (error) => error.code === "unsupported" && /prNumber/.test(error.message),
  );
  const closed = await stageApprovedWork(control, jobs, { id: "w-v9d-closed", headSha: HEAD1, repositoryId: "octo/repo" });
  await assert.rejects(
    control.workComplete({ key: "w-v9d-c3", work: closed.workId, prNumber: 13 }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.ok(/open PR/.test(error.message));
      return true;
    },
  );
  for (const id of ["w-v9d-nopr", "w-v9d-closed"]) {
    const { data } = await control.workInspect({ work: id });
    assert.notEqual(data.state, "completed");
  }
});

// -- V10 · secret hygiene --------------------------------------------------------

// §11: "Secrets stay in existing service clients; do not put tokens into
// work records or logs." (Seen red by removing assertNoSecretLikeValues from
// the release path — the token-shaped digest then landed on the claim.)
test("V10: token-shaped material anywhere a record is written is refused — tokens stay in the service clients", async () => {
  const { control } = makeWorkControl({
    releaseContracts: [seedContract({ mutates: false })],
    releaseTrigger: async () => ({ runId: "run-leak", artifact: { identity: "docker:manta@sha256:aaa", digest: "ghp_0123456789abcdefghij0123456789abcd" } }),
  });
  const created = await seedReadyWork(control, { id: "w-v10", deliveryTarget: { kind: "published", releaseTarget: "web", channel: "prod" } });
  await assert.rejects(
    control.workRelease({ key: "w-v10-r", work: created.workId }),
    (error) => {
      assert.equal(error.code, "unsupported");
      assert.ok(/credential material/.test(error.message), "the refusal names credential material");
      return true;
    },
  );
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.claims.some((c) => c.kind === RELEASE_CLAIM), false, "nothing was recorded");
  const releaseAttempt = data.attempts.filter((a) => a.stage === "release").pop();
  assert.equal(releaseAttempt.status, "failed", "the release attempt failed visibly");
});

// -- V11 · the pure helpers ------------------------------------------------------

test("V11: parseReviewVerdict honors the marker contract, not keyword search", () => {
  assert.equal(parseReviewVerdict("findings: none\nVERDICT: approved"), "approved");
  assert.equal(parseReviewVerdict("VERDICT: changes_requested"), "changes_requested");
  assert.equal(parseReviewVerdict("  verdict:   Approved  "), "approved", "case and surrounding whitespace are tolerated on the marker line");
  assert.equal(parseReviewVerdict("VERDICT: changes_requested\nVERDICT: approved"), "approved", "the LAST marker line wins");
  assert.equal(parseReviewVerdict("the diff looks approved to me overall"), null, "prose mention is NOT a verdict");
  assert.equal(parseReviewVerdict("VERDICT: approved but see comments"), null, "a marker line with trailing prose is not the marker");
  assert.equal(parseReviewVerdict("approved VERDICT: approved"), null, "a marker embedded mid-line is not the marker");
  assert.equal(parseReviewVerdict(""), null);
  assert.equal(parseReviewVerdict(null), null);
});

test("V11: a release contract is DATA with a closed field set — nothing executable slips through", () => {
  // §11: "It is data referencing existing workflows, not an arbitrary
  // executable DSL."
  assert.deepEqual([...RELEASE_CONTRACT_FIELDS], [
    "id",
    "workspaceId",
    "pipeline",
    "allowedTargets",
    "allowedChannels",
    "sourceRevision",
    "artifactIdentity",
    "verification",
    "mutates",
  ]);
  assert.deepEqual(validateReleaseContract(seedContract()), seedContract(), "a well-formed contract validates unchanged");
  assert.throws(() => validateReleaseContract({ ...seedContract(), command: "rm -rf /" }), /unknown field/, "an unknown (executable-shaped) field is refused");
  assert.throws(() => validateReleaseContract({ ...seedContract(), pipeline: undefined }), /non-empty string/, "a required field cannot be empty");
  assert.throws(() => validateReleaseContract({ ...seedContract(), allowedChannels: [] }), /non-empty array/, "an empty channel list is refused");
  assert.throws(() => validateReleaseContract({ ...seedContract(), mutates: "yes" }), /boolean/, "mutates is a boolean, not a string");
  assert.throws(() => validateReleaseContract({ ...seedContract(), workspaceId: 7 }), /string, null, or omitted/, "workspaceId is a string, null, or omitted");
});

test("V11: resolveReleaseContract resolves per project/target/channel — scoped wins, ambiguity is an error, no match is null", () => {
  const scoped = seedContract();
  const global = seedContract({ id: "rc-global", workspaceId: null });
  assert.equal(resolveReleaseContract([global, scoped], MANTA_PROJECT_ID, "web", "prod").id, scoped.id, "an exact workspace-scoped contract wins over a global one");
  assert.equal(resolveReleaseContract([global], "other", "web", "prod").id, global.id, "a global contract applies to every project");
  assert.equal(resolveReleaseContract([scoped], MANTA_PROJECT_ID, "web", "staging"), null, "a channel the contract does not allow does not match");
  assert.equal(resolveReleaseContract([scoped], MANTA_PROJECT_ID, "windows", "prod"), null, "a target the contract does not allow does not match");
  assert.equal(resolveReleaseContract([scoped], "other", "web", "prod"), null, "a scoped contract does not match another project");
  assert.throws(
    () => resolveReleaseContract([seedContract({ id: "rc-a" }), seedContract({ id: "rc-b" })], MANTA_PROJECT_ID, "web", "prod"),
    (error) => error.code === "target_ambiguous" && /narrow the contract set/.test(error.message),
    "two scoped candidates for one project are ambiguous, not a pick-one",
  );
  assert.throws(
    () => resolveReleaseContract([global, seedContract({ id: "rc-g2", workspaceId: null })], MANTA_PROJECT_ID, "web", "prod"),
    (error) => error.code === "target_ambiguous",
    "two global candidates are ambiguous too",
  );
});

test("V11: parseRepoKey is the canonical owner/repo identity — no host prefix, no empty segments", () => {
  assert.deepEqual(parseRepoKey("octo/manta"), { owner: "octo", repo: "manta" });
  assert.deepEqual(parseRepoKey("  octo/manta  "), { owner: "octo", repo: "manta" }, "stray whitespace is tolerated and trimmed");
  assert.throws(() => parseRepoKey("https://github.com/octo/manta"), /owner\/repo/, "a host prefix is refused — the adapter owns host resolution");
  assert.throws(() => parseRepoKey("octo/"), /owner\/repo/, "an empty segment is refused");
  assert.throws(() => parseRepoKey("/manta"), /owner\/repo/);
  assert.throws(() => parseRepoKey("justone"), /owner\/repo/);
  assert.throws(() => parseRepoKey(""), /non-empty string/);
});

// ---------------------------------------------------------------------------
// P6 — §9 priorities/dependencies, §10 checkpoint handoffs, §12 cleanup
// classification. Every guarantee below has a counterfactual positive
// control in the same test: the setup that WOULD dispatch/wait/destroy is
// observed both ways.
// ---------------------------------------------------------------------------

function foreignRunningJob(id, at = 1) {
  return {
    id,
    name: "other",
    prompt: "other work",
    parentSessionID: `ses_${id}`,
    parentDirectory: fix("better-ui"),
    childSessionID: `ses_child_${id}`,
    tmuxSession: "manta",
    windowIndex: 3,
    worktree: `${fix("better-ui")}/.worktrees/foreign-${id}`,
    branch: "other",
    baseSha: null,
    origin: "delegate",
    actor: "user",
    correlation: null,
    permission: null,
    status: "running",
    activity: null,
    pauseRequested: false,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
  };
}

test("P6 schedulingClass: persists on create/revise; anything else is refused (closed vocabulary)", async () => {
  const { control } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "p6-class", schedulingClass: "interactive" });
  assert.equal(created.ok, true);
  let { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.schedulingClass, "interactive");
  await control.workRevise({ key: "p6-class-rev", work: created.workId, patch: { schedulingClass: "background" } });
  ({ data } = await control.workInspect({ work: created.workId }));
  assert.equal(data.schedulingClass, "background", "a class change is a normal revise");
  await assert.rejects(
    control.workRevise({ key: "p6-class-bad", work: created.workId, patch: { schedulingClass: "urgent" } }),
    (error) => error.code === "unsupported" && /schedulingClass/.test(error.message),
  );
  await assert.rejects(
    control.workCreate({
      key: "p6-class-bad2",
      project: "manta",
      objective: "x",
      spec: { revision: 1, hash: "h", documentRef: "d" },
      deliveryTarget: { kind: "pr" },
      state: "ready",
      schedulingClass: "asap",
    }),
    (error) => error.code === "unsupported",
  );
});

test("U19: a background dispatch YIELDS to the interactive reserve with an explicit durable reason; interactive dispatch never yields; no competitor, no yield", async () => {
  // Four foreign running jobs → 1 available slot (MAX_RUNNING_JOBS 5). The
  // reserve is 1, so the free slot is INSIDE the reserve band.
  const base = { jobs: [1, 2, 3, 4].map((n) => foreignRunningJob(`foreign-${n}`)) };
  // (a) background work + a dispatchable interactive competitor → yield.
  const yielded = makeWorkControl({ ...base });
  const bg = await seedReadyWork(yielded.control, { id: "p6-bg-yield" });
  await seedReadyWork(yielded.control, { id: "p6-interactive-competitor", schedulingClass: "interactive" });
  await assert.rejects(
    yielded.control.workDispatch({ key: "p6-bg-yield-d", work: bg.workId }),
    (error) => {
      assert.equal(error.code, "capacity_wait");
      assert.equal(error.retrySafe, true);
      assert.match(error.message, /yielded to the interactive reserve/);
      assert.match(error.message, /p6-interactive-competitor/);
      assert.deepEqual(error.details?.competitors, ["p6-interactive-competitor"]);
      return true;
    },
    "background yields when the free slot is the interactive reserve and a real interactive work waits",
  );
  let { data } = await yielded.control.workInspect({ work: bg.workId });
  assert.equal(data.state, "waiting");
  assert.equal(data.waitingReason, "capacity", "the wait reason is durable and dispatchable-again later");
  // (b) counterfactual: the SAME contention, INTERACTIVE work → dispatches.
  const interactive = makeWorkControl({ ...base });
  const iw = await seedReadyWork(interactive.control, { id: "p6-interactive-goes", schedulingClass: "interactive" });
  const dispatchedInteractive = await interactive.control.workDispatch({ key: "p6-i-d", work: iw.workId });
  assert.equal(dispatchedInteractive.ok, true, "interactive dispatch never yields");
  // (c) counterfactual: the SAME background work, NO interactive competitor
  // → dispatches into the free slot (the reserve binds only against a real
  // CEO-requested competitor, never speculatively).
  const noCompetitor = makeWorkControl({ ...base });
  const nc = await seedReadyWork(noCompetitor.control, { id: "p6-bg-nocomp" });
  const dispatchedNoComp = await noCompetitor.control.workDispatch({ key: "p6-nc-d", work: nc.workId });
  assert.equal(dispatchedNoComp.ok, true, "background dispatches freely when nothing interactive waits");
});

test("§9 scheduling order (work_capacity): interactive first, then priority, then fair aging — the observable 'which next'", async () => {
  const { control } = makeWorkControl();
  const older = await seedReadyWork(control, { id: "p6-order-bg-low", priority: 1 });
  await control.workRevise({ key: "p6-order-interactive", work: older.workId, patch: { schedulingClass: "interactive" } });
  const waiting = await seedReadyWork(control, { id: "p6-order-bg-high", priority: 9 });
  await control.workRevise({ key: "p6-order-wait", work: waiting.workId, patch: { state: "waiting", waitingReason: "capacity" } });
  const { data } = await control.workCapacity();
  const ids = data.schedulingOrder.map((r) => r.workId);
  assert.equal(ids[0], "p6-order-bg-low", "interactive outranks priority (CEO requests first)");
  assert.equal(ids[1], "p6-order-bg-high", "higher priority next");
  assert.equal(data.interactiveReserve, 1);
});

test("U19: a priority change re-evaluates the waiting set — a dependency-satisfied waiter is PROMOTED, stale evidence stays waiting", async () => {
  const { control, jobs } = makeWorkControl();
  const dep = await seedReadyWork(control, { id: "p6-reeval-dep" });
  const waiter = await seedReadyWork(control, { id: "p6-reeval-waiter", dependencies: [dep.workId], state: "ready" });
  await control.workDispatch({ key: "p6-reeval-dep-d", work: dep.workId });
  const job = jobs.jobs.find((j) => j.correlation?.workId === dep.workId);
  job.status = "done";
  job.result = "implemented per spec rev1";
  await control.recordWorkerOutcome(job);
  const depDone = await control.workInspect({ work: dep.workId });
  assert.equal(depDone.data.state, "waiting", "the dependency reports a claim and waits for §11 stages");
  // The waiter was parked on its (then-unmet) dependency before the claim.
  await control.workRevise({ key: "p6-reeval-park", work: waiter.workId, patch: { state: "waiting", waitingReason: "dependency" } });
  // A priority change is the re-evaluation trigger.
  const result = await control.workPrioritize({ key: "p6-reeval-prio", work: waiter.workId, priority: 5 });
  assert.equal(result.ok, true);
  assert.ok(
    result.reevaluated.some((r) => r.workId === waiter.workId && r.to === "ready"),
    "the waiter is promoted because its dependency now carries a matching implementation claim",
  );
  const after = await control.workInspect({ work: waiter.workId });
  assert.equal(after.data.state, "ready");
  assert.equal(after.data.waitingReason, undefined);
  // Counterfactual (stale evidence ≠ met): the dependency's spec moves — the
  // claim no longer matches the CURRENT spec hash, so a waiting dependent is
  // NOT promoted.
  const dep2 = await seedReadyWork(control, { id: "p6-reeval-dep2" });
  const waiter2 = await seedReadyWork(control, { id: "p6-reeval-waiter2", dependencies: [dep2.workId], state: "ready" });
  await control.workDispatch({ key: "p6-reeval-dep2-d", work: dep2.workId });
  const job2 = jobs.jobs.find((j) => j.correlation?.workId === dep2.workId);
  job2.status = "done";
  job2.result = "implemented per spec rev1";
  await control.recordWorkerOutcome(job2);
  await control.workRevise({ key: "p6-reeval-park2", work: waiter2.workId, patch: { state: "waiting", waitingReason: "dependency" } });
  await control.workRevise({
    key: "p6-reeval-spec2",
    work: dep2.workId,
    patch: { spec: { revision: 2, hash: "sha256:rev2", documentRef: "d#rev2" } },
  });
  const result2 = await control.workPrioritize({ key: "p6-reeval-prio2", work: waiter2.workId, priority: 7 });
  assert.equal(result2.reevaluated.some((r) => r.workId === waiter2.workId), false, "stale evidence never promotes");
  const after2 = await control.workInspect({ work: waiter2.workId });
  assert.equal(after2.data.state, "waiting", "still honestly waiting");
  assert.equal(after2.data.waitingReason, "dependency");
});

test("U19: a dependency revision invalidates claim-sourced satisfaction at the NEXT dispatch (stale evidence ≠ met)", async () => {
  const { control, jobs } = makeWorkControl();
  const dep = await seedReadyWork(control, { id: "p6-stale-dep" });
  const consumer = await seedReadyWork(control, { id: "p6-stale-consumer", dependencies: [dep.workId] });
  // Positive control first: with the dep's claim matching the CURRENT spec,
  // the consumer dispatches (claim-sourced readiness).
  await control.workDispatch({ key: "p6-stale-dep-d", work: dep.workId });
  const job = jobs.jobs.find((j) => j.correlation?.workId === dep.workId);
  job.status = "done";
  job.result = "implemented per spec rev1";
  await control.recordWorkerOutcome(job);
  const dispatched = await control.workDispatch({ key: "p6-stale-cd", work: consumer.workId });
  assert.equal(dispatched.ok, true, "a matching claim admits the dependent");
  // Now the dependency's spec is revised: the claim no longer matches.
  const consumer2 = await seedReadyWork(control, { id: "p6-stale-consumer2", dependencies: [dep.workId] });
  await control.workRevise({
    key: "p6-stale-spec",
    work: dep.workId,
    patch: { spec: { revision: 2, hash: "sha256:new", documentRef: "d#rev2" } },
  });
  await assert.rejects(
    control.workDispatch({ key: "p6-stale-c2d", work: consumer2.workId }),
    (error) => {
      assert.equal(error.code, "policy_blocked");
      assert.match(error.message, /sha256:new|stale|unmet|dependencies unmet/i);
      return true;
    },
    "the revised dependency invalidates the old claim — stale evidence is not met",
  );
  const { data } = await control.workInspect({ work: consumer2.workId });
  assert.equal(data.state, "waiting");
  assert.equal(data.waitingReason, "dependency");
});

test("U19: capacity waits are bounded by the stage attempt budget (repeated capacity refusals end in policy_blocked)", async () => {
  const { control } = makeWorkControl({ cap: 0, maxStageAttempts: 2 });
  const created = await seedReadyWork(control, { id: "p6-bounded" });
  // Dispatch 1 → the engine's cap refuses → capacity_wait (attempt 1 failed).
  await assert.rejects(
    control.workDispatch({ key: "p6-bounded-1", work: created.workId }),
    (error) => error.code === "capacity_wait",
  );
  let { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "waiting");
  assert.equal(data.waitingReason, "capacity");
  // Dispatch 2 (waiting/capacity is dispatchable) → attempt 2 failed.
  await assert.rejects(
    control.workDispatch({ key: "p6-bounded-2", work: created.workId }),
    (error) => error.code === "capacity_wait",
  );
  // Dispatch 3 → the budget refuses: retries are BOUNDED, never infinite.
  await assert.rejects(
    control.workDispatch({ key: "p6-bounded-3", work: created.workId }),
    (error) => error.code === "policy_blocked",
  );
});

test("§10 work_handoff writes a typed durable record; replay is idempotent; fields validate; the bound trims visibly", async () => {
  const { control } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "p6-handoff" });
  const first = await control.workHandoff({
    key: "p6-h1",
    work: created.workId,
    objective: "ship the export fix",
    target: "wt_main",
    diffCommit: "abc1234",
    testResults: "npm test: 12 pass",
    pendingDecisions: ["keep or drop the legacy flag?"],
    nextStep: "rebase onto main, then re-run the suite",
    constraints: ["never touch the secrets module", "no new dependencies"],
  });
  assert.equal(first.ok, true);
  const rec = first.handoff;
  assert.equal(rec.stage, "specify", "the handoff pins the work's stage at write time");
  assert.equal(rec.specHash, "sha256:aaa", "the handoff pins the spec hash at write time");
  assert.equal(rec.attemptId, null, "no live attempt — the record is attemptless");
  assert.deepEqual(rec.constraints, ["never touch the secrets module", "no new dependencies"]);
  let { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.handoffs.length, 1);
  assert.deepEqual(data.handoffs[0], rec, "the record is durable on the envelope");
  // Idempotent replay returns the ORIGINAL result; the same key with
  // DIFFERENT args is a visible conflict, never a silent second write.
  const replay = await control.workHandoff({
    key: "p6-h1",
    work: created.workId,
    objective: "ship the export fix",
    target: "wt_main",
    diffCommit: "abc1234",
    testResults: "npm test: 12 pass",
    pendingDecisions: ["keep or drop the legacy flag?"],
    nextStep: "rebase onto main, then re-run the suite",
    constraints: ["never touch the secrets module", "no new dependencies"],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.handoff.id, rec.id);
  await assert.rejects(
    control.workHandoff({ key: "p6-h1", work: created.workId, objective: "different args, same key" }),
    (error) => error.code === "idempotency_key_args_mismatch",
  );
  await assert.rejects(
    control.workHandoff({ key: "p6-h2", work: created.workId, constraints: "not-a-list" }),
    (error) => error.code === "unsupported" && /constraints/.test(error.message),
  );
  await assert.rejects(
    control.workHandoff({ key: "p6-h3", work: created.workId, constraints: ["a", ""] }),
    (error) => error.code === "unsupported",
  );
  await assert.rejects(
    control.workHandoff({
      key: "p6-h4",
      work: created.workId,
      constraints: Array.from({ length: 11 }, (_, i) => `c${i}`),
    }),
    (error) => error.code === "unsupported" && /at most 10/.test(error.message),
  );
  // Bounded: the record cap trims the OLDEST and reports the trim.
  for (let i = 0; i < 21; i += 1) {
    await control.workHandoff({ key: `p6-h-loop-${i}`, work: created.workId, nextStep: `step ${i}` });
  }
  ({ data } = await control.workInspect({ work: created.workId }));
  assert.equal(data.handoffs.length, 20, "the handoff list is bounded");
  assert.equal(data.handoffs.some((h) => h.id === rec.id), false, "the oldest record was trimmed");
  assert.equal(data.handoffs.at(-1).nextStep, "step 20");
  // Over-long text is clipped with a visible marker, never silently kept.
  const long = await control.workHandoff({ key: "p6-h-long", work: created.workId, objective: "x".repeat(3000) });
  assert.ok(long.handoff.objective.endsWith("(truncated)"), "clipping is visible");
  // Terminal states refuse — there is no next attempt to read the record.
  await control.workCancel({ key: "p6-h-cancel", work: created.workId });
  await assert.rejects(
    control.workHandoff({ key: "p6-h-terminal", work: created.workId, nextStep: "nope" }),
    (error) => error.code === "policy_blocked" && /no next attempt/.test(error.message),
  );
});

test("§10: the NEXT attempt READS the handoff — constraints appear verbatim in the worker prompt; a stale handoff is labelled, never silently dropped", async () => {
  const { control, calls, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "p6-read" });
  // Counterfactual control first: no handoff → no handoff section at all.
  await control.workDispatch({ key: "p6-read-bare", work: created.workId });
  const barePrompt = calls.find((c) => c.name === "startJob" && c.input.correlation?.workId === created.workId).input.prompt;
  assert.ok(!barePrompt.includes("Handoff from a previous attempt"));
  // Attempt 1 reports; the work is reported-complete awaiting the next stage.
  const job1 = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job1.status = "done";
  job1.result = "implemented per spec rev1";
  await control.recordWorkerOutcome(job1);
  // The handoff is written AT THE CHECKPOINT between attempts, then the
  // retry (attempt 2) must read it.
  await control.workHandoff({
    key: "p6-read-h",
    work: created.workId,
    objective: "mid-attempt checkpoint",
    diffCommit: "def5678",
    nextStep: "finish the export path",
    constraints: ["never touch the secrets module"],
  });
  const retried = await control.workRetry({ key: "p6-read-retry", work: created.workId });
  assert.equal(retried.ok, true);
  const prompts = calls.filter((c) => c.name === "startJob" && c.input.correlation?.workId === created.workId);
  const handoffPrompt = prompts.at(-1).input.prompt;
  assert.ok(handoffPrompt.includes("Handoff from a previous attempt"), "the handoff section is present");
  assert.ok(handoffPrompt.includes("never touch the secrets module"), "constraints are enumerated verbatim — never dropped");
  assert.ok(handoffPrompt.includes("mid-attempt checkpoint"));
  assert.ok(handoffPrompt.includes("def5678"));
  assert.ok(handoffPrompt.includes("finish the export path"));
  // Stale: the spec moves AFTER the handoff — the record is still injected
  // but labelled SUPERSEDED (never silently dropped, never silently trusted).
  const { control: control2, calls: calls2, jobs: jobs2 } = makeWorkControl();
  const created2 = await seedReadyWork(control2, { id: "p6-read2" });
  await control2.workDispatch({ key: "p6-read2-d", work: created2.workId });
  const job2a = jobs2.jobs.find((j) => j.correlation?.workId === created2.workId);
  job2a.status = "done";
  job2a.result = "implemented per spec rev1";
  await control2.recordWorkerOutcome(job2a);
  await control2.workHandoff({ key: "p6-read2-h", work: created2.workId, nextStep: "old-plan" });
  await control2.workRevise({
    key: "p6-read2-spec",
    work: created2.workId,
    patch: { spec: { revision: 2, hash: "sha256:new-spec", documentRef: "d#rev2" } },
  });
  await control2.workRetry({ key: "p6-read2-retry", work: created2.workId });
  const stalePrompt = calls2
    .filter((c) => c.name === "startJob" && c.input.correlation?.workId === created2.workId)
    .at(-1).input.prompt;
  assert.ok(stalePrompt.includes("SUPERSEDED"), "the stale handoff is labelled");
  assert.ok(stalePrompt.includes("old-plan"), "and its content still travels — not dropped");
});

test("U21: archive preserves the WHY — claims (rationale), handoffs and operations stay readable after archive", async () => {
  const { control, jobs } = makeWorkControl();
  const created = await seedReadyWork(control, { id: "p6-u21" });
  await control.workDispatch({ key: "p6-u21-d", work: created.workId });
  const job = jobs.jobs.find((j) => j.correlation?.workId === created.workId);
  job.status = "done";
  job.result = "changed src/export.ts: handled the empty-input case; verified with npm test (7 pass)";
  const adopted = await control.recordWorkerOutcome(job);
  assert.equal(adopted.adopted, true);
  await control.workHandoff({
    key: "p6-u21-h",
    work: created.workId,
    nextStep: "request independent review of the head",
    constraints: ["do not widen the public API"],
  });
  const archived = await control.workArchive({ key: "p6-u21-a", work: created.workId });
  assert.equal(archived.ok, true);
  const { data } = await control.workInspect({ work: created.workId });
  assert.equal(data.state, "archived");
  const claim = data.claims.find((c) => c.kind === "implementation_reported");
  assert.ok(claim, "the claim survives archive");
  assert.match(claim.note, /handled the empty-input case/, "'why it acted' — the worker's own report — is still readable");
  assert.equal(data.handoffs.length, 1, "the checkpoint handoff survives archive");
  assert.deepEqual(data.handoffs[0].constraints, ["do not widen the public API"]);
  assert.equal(data.operations.length > 0, true, "the receipt history survives archive");
  const evidence = await control.workEvidence({ work: created.workId });
  assert.equal(evidence.ok, true);
  assert.ok(
    JSON.stringify(evidence.data).includes("handled the empty-input case"),
    "the evidence read path still reaches the claim after archive",
  );
});

test("§12 overrideDirty: an explicit override destroys a dirty worktree AFTER its file list is preserved as evidence; without it the force path never runs", async () => {
  const ovrSpy = makeDelegateSpy({ jobs: [] });
  const ctl = directWorkControl({ store: workStoreFixture(), spy: ovrSpy });
  const created = await ctl.control.workCreate({
    key: "p6-ovr-c",
    project: "manta",
    objective: "x",
    spec: { revision: 1, hash: "h", documentRef: "d" },
    deliveryTarget: { kind: "pr" },
    state: "ready",
    id: "p6-ovr",
  });
  const dispatched = await ctl.control.workDispatch({ key: "p6-ovr-d", work: created.workId });
  await ctl.control.workCancel({ key: "p6-ovr-x", work: created.workId });
  const path = (await ctl.control.workInspect({ work: created.workId })).data.resources.find(
    (r) => r.kind === "delegate_job" && r.ref === dispatched.jobId,
  ).path;
  ctl.statusState.byPath[path] = " M src/worker.js\n M src/other.js";
  ovrSpy.state.dirtyWorktrees.add(dispatched.jobId); // the spy's gitRemoveWorktree will refuse non-forced
  // Counterfactual FIRST: WITHOUT the override flag the forced removal is
  // never taken — the spy refuses (reason "dirty") and the worktree is
  // preserved with the reason visible.
  await assert.rejects(
    ctl.control.workCleanup({ key: "p6-ovr-no", work: created.workId }),
    (error) => error.code === "dirty_resource" && /preserved/.test(error.message),
  );
  const nonForced = ovrSpy.calls.filter((c) => c.name === "deleteJob" && c.input === dispatched.jobId);
  assert.equal(nonForced.length, 0, "pre-classified dirty: no destructive call at all before the override");
  // With the flag: evidence FIRST, then the forced removal, and the response
  // reports what was preserved.
  const cleaned = await ctl.control.workCleanup({ key: "p6-ovr-x2", work: created.workId, overrideDirty: true });
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.removed, [dispatched.jobId], "the override DID destroy the worktree");
  const forcedCall = ovrSpy.calls.filter((c) => c.name === "deleteJob" && c.input === dispatched.jobId).at(-1);
  assert.equal(forcedCall.opts?.force, true, "the removal ran FORCED — the explicit override reached git");
  assert.equal(cleaned.preserved.length, 1);
  assert.equal(cleaned.preserved[0].ref, dispatched.jobId);
  assert.match(cleaned.preserved[0].reason, /overrideDirty/);
  const { data } = await ctl.control.workInspect({ work: created.workId });
  const evidence = data.evidence.find((e) => e.kind === "worktree_preserved");
  assert.ok(evidence, "the uncommitted file list is durable evidence");
  assert.deepEqual(evidence.files, [" M src/worker.js", " M src/other.js"], "raw porcelain lines (leading column characters kept), bounded");
  assert.equal(evidence.path, path);
  const res = data.resources.find((r) => r.kind === "delegate_job" && r.ref === dispatched.jobId);
  assert.equal(res.cleanupStatus, "removed", "the resource record closes normally after the override");
});

test("§12 still-referenced: a worktree another live work still references is PRESERVED with the referencing work named", async () => {
  const store = workStoreFixture();
  const { control } = makeWorkControl({ store });
  const holder = await seedReadyWork(control, { id: "p6-ref-holder" });
  const holderDispatch = await control.workDispatch({ key: "p6-ref-hd", work: holder.workId });
  await control.workCancel({ key: "p6-ref-hc", work: holder.workId });
  const holderPath = (await control.workInspect({ work: holder.workId })).data.resources.find(
    (r) => r.kind === "delegate_job" && r.ref === holderDispatch.jobId,
  ).path;
  // A second work envelope whose resource points at the SAME worktree path
  // (the shared-checkout case): the holder's cleanup must preserve.
  const borrower = await seedReadyWork(control, { id: "p6-ref-borrower" });
  await lockForStore({ name: store.name, path: store.pathFor(borrower.workId) }).runExclusive(async () => {
    const raw = await readFile(store.pathFor(borrower.workId), "utf-8");
    const env = JSON.parse(raw);
    env.resources = [
      ...(env.resources ?? []),
      { id: "res_shared", kind: "delegate_job", ref: "job_foreign", path: holderPath, owned: true, createdAt: 1, updatedAt: 1 },
    ];
    await store.save(borrower.workId, env);
  });
  await assert.rejects(
    control.workCleanup({ key: "p6-ref-hx", work: holder.workId }),
    (error) => {
      assert.equal(error.code, "active_resource");
      assert.match(error.message, /p6-ref-borrower/, "the referencing work is named");
      assert.deepEqual(error.details?.preserved, [{ ref: holderDispatch.jobId, reason: "still_referenced" }]);
      return true;
    },
  );
  const { data } = await control.workInspect({ work: holder.workId });
  const res = data.resources.find((r) => r.kind === "delegate_job" && r.ref === holderDispatch.jobId);
  assert.equal(res.cleanupStatus, "preserved");
  assert.equal(res.preservedReason, "still_referenced");
  // Counterfactual: once the other work's resource is REMOVED (its own
  // cleanup ran), the same holder cleanup succeeds.
  await lockForStore({ name: store.name, path: store.pathFor(borrower.workId) }).runExclusive(async () => {
    const raw = await readFile(store.pathFor(borrower.workId), "utf-8");
    const env = JSON.parse(raw);
    env.resources = env.resources.map((x) => (x?.id === "res_shared" ? { ...x, cleanupStatus: "removed" } : x));
    await store.save(borrower.workId, env);
  });
  const cleaned = await control.workCleanup({ key: "p6-ref-hx2", work: holder.workId });
  assert.equal(cleaned.ok, true, "a cleared reference unblocks the cleanup");
  assert.deepEqual(cleaned.removed, [holderDispatch.jobId]);
});
