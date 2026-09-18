// ctoWorkTools.mjs — unified-CTO spec §7 `work` control-tool family, RECORD +
// DISPATCH half. Review/merge/release/verify (§11) are deliberately NOT here —
// next PR. This family turns a request into tracked work and puts a worker on
// it in an EXPLICIT project.
//
// CENTRAL INVARIANT (§1.1): "Completing a worker is not completing the work.
// The declared delivery target determines completion." It is enforced
// STRUCTURALLY, not by documentation:
//   • work_create only ever creates "draft" or "ready" envelopes.
//   • work_revise REFUSES patch.state "completed" (and "running"/"archived"/
//     "cancelled", whose owners are dispatch/dispatch/cancel/archive).
//   • recordWorkerOutcome / adoptJobOutcome — the paths that observe a
//     worker's terminal event — have NO parameter and NO code path that
//     writes state "completed". A reported-complete worker moves the work to
//     `waiting`/`external` and records a CLAIM (spec §11 distinguishes seven
//     observations; this half can legitimately establish only the first two —
//     the claim kinds below name all seven so the remaining five have
//     somewhere to land in the §11 PR).
//   • No other operation in this module writes "completed" either. The test
//     suite walks the whole lifecycle and asserts the state never reads
//     "completed" from any path (the §11 PR adds the verified-completion
//     operation that legitimately owns that transition).
//
// PROJECT IDENTITY (§1.1, §5.1 ProjectRef) — carried EXPLICITLY with the work.
// work_create resolves the caller-supplied project name through
// ctoMantaTools.resolveProjectIdentity (THE one identity surface — the
// Manta-minted durable projectId from PR #1516 is a SEPARATE follow-up
// adoption; nothing here pre-empts it) and persists a ProjectRef. Every later
// operation REVALIDATES the stored workspaceId against live tmux state and
// fails CLOSED (target_not_found / target_changed / target_ambiguous) — never
// inferring a target from the conversation cwd or the first project. KNOWN
// LIMITATION (documented, deliberate): identity resolves against live tmux
// state; a rename surfaces as target_changed (current name in the error) or
// target_not_found after a full rename.
//
// OPERATION PROTOCOL (§8.1) for envelope mutations (dispatch/retry):
//   1. validate (shape + admission preconditions)  — store-only
//   2. reserve the receipt (ctoWork.reserveOperation — pending)  — lock
//   3. record in_flight (crash marker)             — lock
//   4. mutate the envelope: state → running, attempt LINKED (§6: "one stage
//      attempt linked before prompt dispatch")     — lock
//   5. startJob (external — lock RELEASED; the delegate engine's jobsLock is
//      the ONE shared capacity seam; the 5-job cap is reused, never bypassed)
//   6. record the outcome (+ attempt stamp + owned-resource record) — lock
// Never re-executed: an expired in_flight becomes durably `unknown`
// (external_outcome_unknown). Reconciliation (retry/dispatch entry) scans the
// delegate store for the operation-correlated worker (job.correlation =
// {kind:"work", workId, receiptId}) and ADOPTS it — never creates another
// blindly (§8.2). An expired pending resumes safely.
//
// CREATE receipts live in the shared §7 control ledger (mantaControlStore,
// via the extracted createOperationRunner) because they must predate the
// envelope they create; every envelope operation's receipts live IN the
// envelope (ctoWork.reserveOperation / recordOperationOutcome).
//
// ERROR CODES — the §7 closed set with retry-safety on every failure, mapped
// through ctoMantaTools.toControlError; ctoWork's service codes pass through
// with their retry-safety table below. Errors carry `.code` and `.retrySafe`.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  controlError,
  toControlError,
  resolveProjectIdentity,
  createOperationRunner,
  assertPlainObject,
  argsSnapshot,
  MANTA_CONTROL_LEASE_TTL_MS,
} from "./ctoMantaTools.mjs";
import { canonicalArgsHash } from "./ctoWork.mjs";
import {
  createCtoWork as createCtoWorkService,
  validateSpec as validateSpecRef,
  validateDeliveryTarget as validateDeliveryTargetRef,
  validateProjectRef as validateProjectRefRef,
  workError,
  WORK_STATES,
  LIST_MAX_LIMIT,
  LIST_DEFAULT_LIMIT,
} from "./ctoWork.mjs";
import { workStore, mantaControlStore } from "./ctoStores.mjs";
import { MAX_RUNNING_JOBS, CAP_ERROR, loadJobs } from "./delegate.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";
import { readConversationSessionId } from "./ctoBinding.mjs";

// Lease TTL for in_flight dispatch receipts: the protected window covers
// worktree + window + prompt delivery (seconds, occasionally a slow box), not
// the worker's run — the dispatch receipt records success the moment the
// worker EXISTS. A 2-minute window matches the other §7 families.
export const WORK_LEASE_TTL_MS = MANTA_CONTROL_LEASE_TTL_MS;
const RECEIPT_OWNER = "cto-work-tools";
const CREATE_RECEIPT_OWNER = "cto-work-create";

// §11's seven observations. This half records ONLY `implementation_reported`
// (the worker's own "done" — a claim, never a verdict). The other six are
// named so the §11 PR's verified observations have a closed vocabulary to
// land in; nothing here writes them.
export const CLAIM_KINDS = Object.freeze([
  "implementation_reported",
  "tests_reported",
  "independent_review_approved",
  "merged_commit_exists",
  "artifact_published",
  "target_runs_artifact",
  "acceptance_checks_passed",
]);
export const IMPLEMENTATION_CLAIM = "implementation_reported";

// Attempt statuses (the work-record view of a stage attempt; the delegate job
// store stays authoritative for low-level job state — §5.1).
export const ATTEMPT_STATUSES = Object.freeze([
  "dispatching",
  "running",
  "reported_complete",
  "failed",
  "stopped",
  "superseded",
  "missing",
]);

// §8.2: "A configurable-by-existing-policy attempt limit may govern runtime
// work" — injected, bounded default; never the spec-authoring history's
// unbounded review loop.
export const DEFAULT_MAX_STAGE_ATTEMPTS = 3;

// Bounded note/result text stored on attempts and claims.
const NOTE_MAX_CHARS = 2000;

// retry-safety for the ctoWork service codes this family surfaces (§7: every
// error states whether retry is safe).
const WORK_CODE_RETRY_SAFE = Object.freeze({
  revision_conflict: false,
  idempotency_key_args_mismatch: false,
  target_not_found: false,
  target_exists: false,
  dependency_cycle: false,
  receipt_state_conflict: false,
  external_outcome_unknown: false,
  store_corrupt: false,
  history_capacity: true,
  store_unavailable: true,
  unsupported: false,
});

const DISPATCH_OPS = Object.freeze(["work.dispatch", "work.retry"]);

// The states dispatch may enter FROM (the §6 admission surface).
const DISPATCHABLE_WAITING_REASONS = Object.freeze(["capacity", "provider"]);

// ---------------------------------------------------------------------------
// Errors — one mapping for this family: controlError-shaped errors pass
// through; ctoWork service errors keep their code and gain the retry-safety
// table; everything else maps through the shared toControlError.
// ---------------------------------------------------------------------------

function toWorkToolError(error) {
  if (error && error.code && typeof error.retrySafe === "boolean") return error;
  if (error && typeof error.code === "string" && error instanceof Error) {
    // ctoWork.mjs workError — code present, retry-safety from the table.
    return controlError(error.code, error.message, {
      retrySafe: WORK_CODE_RETRY_SAFE[error.code] ?? false,
      ...(error.receipt ? { details: { receiptId: error.receipt.id } } : {}),
    });
  }
  return toControlError(error);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw controlError("unsupported", `${label} must be a non-empty string`);
  }
}

function clipNote(text) {
  const s = String(text ?? "");
  return s.length > NOTE_MAX_CHARS ? `${s.slice(0, NOTE_MAX_CHARS)}… (truncated)` : s;
}

// A safe envelope id for the store path (ctoStores.assertSafeName forbids
// path separators); work ids are service-minted `w_<uuid>` by default.
function assertSafeWorkId(id) {
  assertNonEmptyString(id, "work");
  if (/[/\\]/.test(id) || id === "." || id === "..") {
    throw controlError("unsupported", `work id ${JSON.stringify(id)} is not a valid store key`);
  }
}

// ---------------------------------------------------------------------------
// §5.1 sub-record validation (the shapes this family writes into envelopes).
// ---------------------------------------------------------------------------

function validateDecisionRecord(decision, label) {
  assertPlainObject(decision, label);
  assertNonEmptyString(decision.id, `${label}.id`);
  assertNonEmptyString(decision.question, `${label}.question`);
  if (!["open", "answered", "superseded"].includes(decision.state)) {
    throw controlError("unsupported", `${label}.state must be open|answered|superseded`);
  }
}

function isBlockingOpenDecision(decision) {
  return decision?.state === "open" && decision?.blocking === true;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function createCtoWorkControl({
  // ---- durable bookkeeping -------------------------------------------------
  store = workStore,
  createReceiptsStore = mantaControlStore,
  now = () => Date.now(),
  newId = () => randomUUID(),
  leaseTtlMs = WORK_LEASE_TTL_MS,
  maxStageAttempts = DEFAULT_MAX_STAGE_ATTEMPTS,
  // ---- READ deps (the ONLY deps the read operations may touch) -------------
  listProjects,
  listDelegateJobs = loadJobs,
  // ---- WRITE deps (mutations only; reads never reference these) ------------
  delegateOps = null, // { startJob, stopJob, pauseJob, resumeJob, deleteJob } — the bound engine
  resolveCwd = resolveCwdOrThrow,
  getConversationId = readConversationSessionId,
} = {}) {
  const work = createCtoWorkService({ store, now, newId });
  const createReceipts = createOperationRunner({
    store: createReceiptsStore,
    now,
    newId,
    owner: CREATE_RECEIPT_OWNER,
  });

  function requireDelegateOps(action) {
    if (!delegateOps || typeof delegateOps.startJob !== "function") {
      throw controlError(
        "unsupported",
        `work_${action} is not wired to the delegate engine on this composition — ` +
          `pass delegateOps (the bound createDelegateEngine) to createCtoWorkControl`,
        { retrySafe: true },
      );
    }
    return delegateOps;
  }

  function requireDelegateAction(name) {
    if (!delegateOps || typeof delegateOps[name] !== "function") {
      throw controlError(
        "unsupported",
        `delegateOps.${name} is not wired on this composition — pass the bound delegate engine`,
        { retrySafe: true },
      );
    }
    return delegateOps[name];
  }

  // Move an envelope to a new state, honoring the strict loader's invariant
  // ("waitingReason requires state waiting" — a state move off waiting must
  // drop the stale reason or the envelope write is rejected as corrupt).
  function withState(env, state, extra = {}) {
    const next = { ...env, state, ...extra, updatedAt: now() };
    if (state !== "waiting") delete next.waitingReason;
    return next;
  }

  async function getWorkOrThrow(id) {
    assertSafeWorkId(id);
    const env = await work.getWork(id);
    if (!env) {
      throw controlError("target_not_found", `work "${id}" does not exist`, { retrySafe: false });
    }
    return env;
  }

  // Every error leaving this module carries {code, retrySafe} — including the
  // reserve-phase service errors (revision_conflict, idempotency mismatch,
  // unknown receipts), which otherwise surface raw.
  async function reserveOrThrow(workId, input) {
    try {
      return await work.reserveOperation(workId, input);
    } catch (error) {
      throw toWorkToolError(error);
    }
  }

  async function readJobsOrThrow(reason) {
    try {
      const jobs = await listDelegateJobs();
      return Array.isArray(jobs) ? jobs : [];
    } catch (error) {
      throw controlError(
        "provider_unavailable",
        `cannot read the delegate job store (${reason}): ${error?.message ?? error} — ` +
          `failing closed rather than guessing worker state`,
        { retrySafe: true },
      );
    }
  }

  // §1.1/§6 target revalidation — the stored workspaceId must still resolve
  // against LIVE tmux state, exactly as it did at create time. Fail closed.
  async function revalidateTarget(env) {
    let projects;
    try {
      projects = await listProjects();
    } catch (error) {
      throw toControlError(error);
    }
    const { project } = resolveProjectIdentity(projects, env.project.workspaceId);
    return project;
  }

  // §9 dependency readiness — bounded, honest about its source: a dependency
  // is met when the dependency work is completed, or when it carries a
  // non-superseded implementation claim matching its CURRENT spec (a
  // REPORTED outcome — labelled as a claim, never silently a verdict; the
  // §11 PR adds verified completion as the stronger signal).
  function dependencyReadiness(dep) {
    if (dep.state === "completed") {
      return { met: true, source: "completed" };
    }
    const claimed = (dep.claims ?? []).some(
      (c) => c?.kind === IMPLEMENTATION_CLAIM && c.superseded !== true && c.specHash === dep.spec.hash,
    );
    if (claimed) {
      return { met: true, source: "reported (claim — unverified)" };
    }
    return { met: false, source: dep.state };
  }

  // ---------------------------------------------------------------------------
  // §6 admission state machine for dispatch (pure over the envelope).
  // ---------------------------------------------------------------------------

  function assertDispatchAdmissible(env) {
    switch (env.state) {
      case "ready":
        return;
      case "waiting":
        if (DISPATCHABLE_WAITING_REASONS.includes(env.waitingReason)) return;
        if (env.waitingReason === "dependency") {
          throw controlError(
            "policy_blocked",
            `work "${env.id}" is waiting on dependencies — resolve them first (see work_inspect)`,
            { retrySafe: true },
          );
        }
        if (env.waitingReason === "reconcile") {
          throw controlError(
            "external_outcome_unknown",
            `work "${env.id}" is waiting for reconciliation — run work_retry to reconcile before dispatching`,
            { retrySafe: false },
          );
        }
        throw controlError(
          "policy_blocked",
          `work "${env.id}" already reported a completed worker — use work_retry for a new attempt`,
          { retrySafe: false },
        );
      case "draft":
        throw controlError(
          "policy_blocked",
          `work "${env.id}" is a draft — settle the spec and move it to ready first (work_revise state:"ready")`,
          { retrySafe: false },
        );
      case "running":
        throw controlError(
          "active_resource",
          `work "${env.id}" already has a dispatched worker — pause (work_pause) or cancel (work_cancel) first`,
          { retrySafe: false },
        );
      case "paused":
        throw controlError(
          "policy_blocked",
          `work "${env.id}" is paused — resume it first (work_resume)`,
          { retrySafe: false },
        );
      case "needs_decision":
        throw controlError(
          "policy_blocked",
          `work "${env.id}" is blocked on an open decision — answer it first (work_answer_decision)`,
          { retrySafe: false },
        );
      case "failed":
        throw controlError(
          "policy_blocked",
          `work "${env.id}" failed — start a new attempt with work_retry`,
          { retrySafe: false },
        );
      default:
        throw controlError(
          "policy_blocked",
          `work "${env.id}" is ${env.state} — nothing to dispatch`,
          { retrySafe: false },
        );
    }
  }

  function assertAttemptBudget(env) {
    const used = (env.attempts ?? []).filter((a) => a?.stage === env.stage).length;
    if (used >= maxStageAttempts) {
      throw controlError(
        "policy_blocked",
        `attempt limit reached for work "${env.id}" stage "${env.stage}" (${used}/${maxStageAttempts}) — ` +
          `escalate rather than looping (§8.2: bounded human-facing behavior)`,
        { retrySafe: false, details: { stage: env.stage, attemptsUsed: used, limit: maxStageAttempts } },
      );
    }
  }

  function isLiveJob(job) {
    return job?.status === "running" || job?.status === "paused";
  }

  // Attempts of this work that still own a live (running/paused) worker per
  // the authoritative delegate store.
  async function liveAttempts(env, jobs) {
    const out = [];
    for (const attempt of env.attempts ?? []) {
      if (!attempt?.jobId) continue;
      const job = jobs.find((j) => j?.id === attempt.jobId);
      if (job && isLiveJob(job)) out.push({ attempt, job });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Response building (§7: success carries operation ID, work ID, resulting
  // revision/state and a visible summary).
  // ---------------------------------------------------------------------------

  function successPayload({ env, receipt, state, revision, summary, extra = {} }) {
    return {
      workId: env.id,
      revision: revision ?? env.revision,
      state: state ?? env.state,
      summary,
      ...extra,
      operationId: receipt.id,
      key: receipt.key,
    };
  }

  function replayResponse(receipt, workId) {
    if (receipt.status === "succeeded") {
      return { ok: true, replayed: true, ...(receipt.result ?? {}), operationId: receipt.id, key: receipt.key };
    }
    if (receipt.status === "failed") {
      const cached = receipt.result ?? {};
      return {
        ok: false,
        replayed: true,
        operationId: receipt.id,
        key: receipt.key,
        code: cached.code ?? receipt.resultCode ?? "external_outcome_unknown",
        retrySafe: cached.retrySafe === true,
        error: cached.message ?? "operation previously failed",
      };
    }
    // pending/in_flight under a live lease — owned by another caller.
    throw controlError(
      "external_outcome_unknown",
      `operation "${receipt.id}" on work "${workId}" is in flight under key "${receipt.key}" — ` +
        `retry to obtain its result`,
      { retrySafe: true },
    );
  }

  async function recordReceiptFailure(workId, receipt, error) {
    await work.recordOperationOutcome(workId, {
      receiptId: receipt.id,
      status: "failed",
      resultCode: error.code,
      result: { code: error.code, message: error.message, retrySafe: error.retrySafe === true },
    });
  }

  // ---------------------------------------------------------------------------
  // Worker prompt — bounded, and explicit about the central invariant.
  // ---------------------------------------------------------------------------

  function describeDeliveryTarget(target) {
    switch (target?.kind) {
      case "spec":
        return "spec (a settled spec document)";
      case "pr":
        return "pull request (independent review + required checks on an open PR; merge not required)";
      case "merged":
        return `merged into ${target.baseBranch}`;
      case "published":
        return `published to ${target.releaseTarget} (channel ${target.channel})`;
      case "deployed":
        return `deployed to ${target.instance} (${target.releaseTarget}, channel ${target.channel})`;
      default:
        return JSON.stringify(target);
    }
  }

  function buildWorkPrompt(env) {
    const lines = [
      `You are the implementation worker for tracked work ${env.id} (work revision ${env.revision}).`,
      ``,
      `Objective: ${env.objective}`,
      `Target project: ${env.project.workspaceId} (checkout ${env.project.repositoryRoot}, repository identity ${env.project.repositoryId}).`,
      `Spec: revision ${env.spec.revision}, hash ${env.spec.hash}, document ${env.spec.documentRef} — this is the pinned revision; do not consume a newer "latest spec".`,
      `Declared delivery target: ${describeDeliveryTarget(env.deliveryTarget)}.`,
      ``,
      `IMPORTANT: completing your implementation does NOT complete the work. Review, merge, release and`,
      `verification are separate stages operated by the CTO. Do not merge. Do not deploy. Do not publish.`,
      `When you finish, report exactly what you changed and how you verified it — that report is a CLAIM,`,
      `not a completion verdict.`,
    ];
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // §8.2 reconciliation — adopt the operation-correlated worker, never create
  // another blindly. The correlation identity is derivable from the receipt
  // itself ({kind:"work", workId, receiptId}) — no extra storage.
  // ---------------------------------------------------------------------------

  function correlatedJobsOf(jobs, workId, receiptId) {
    return (jobs ?? []).filter(
      (j) =>
        j?.correlation?.kind === "work" &&
        j.correlation.workId === workId &&
        j.correlation.receiptId === receiptId,
    );
  }

  async function reconcileUnknownReceipts(workId) {
    const env = await getWorkOrThrow(workId);
    // §8.1: an expired in_flight IS durably unknown — it is reconcilable on
    // the same terms (the takeover flip below makes it explicit). A live
    // in_flight/pending under an unexpired lease belongs to another caller.
    const reconcilable = (env.operations ?? []).filter(
      (r) =>
        DISPATCH_OPS.includes(r.op) &&
        (r.status === "unknown" ||
          (r.status === "in_flight" && (r.lease?.expiresAt ?? 0) <= now())),
    );
    if (reconcilable.length === 0) return { reconciled: 0 };
    const jobs = await readJobsOrThrow(`reconciling work "${workId}"`);
    let reconciled = 0;
    for (const receipt of reconcilable) {
      if (receipt.status !== "unknown") {
        // The takeover marker: durably unknown, never silently re-executed.
        await work.recordOperationOutcome(workId, { receiptId: receipt.id, status: "unknown" });
      }
      const correlated = correlatedJobsOf(jobs, workId, receipt.id);
      if (correlated.length > 1) {
        throw controlError(
          "dirty_resource",
          `reconciliation of operation "${receipt.id}" on work "${workId}" found ${correlated.length} ` +
            `correlated worker jobs (${correlated.map((j) => j.id).join(", ")}) — resolve the duplicates ` +
            `through the delegate lifecycle before retrying`,
          { retrySafe: false },
        );
      }
      if (correlated.length === 1) {
        const job = correlated[0];
        // The worker WAS created — the dispatch effect happened. Adopt it.
        const payload = dispatchResultFromJob(env, job, { reconciled: true });
        await work.recordOperationOutcome(workId, {
          receiptId: receipt.id,
          status: "succeeded",
          externalRef: job.id,
          resultCode: `reconciled:job:${job.id}:${job.status}`,
          result: payload,
        });
        await adoptJobIntoEnvelope(workId, job, { viaReceiptId: receipt.id });
        if (isLiveJob(job)) {
          // The adopted worker is LIVE — the work must read as running, or the
          // next dispatch would put a SECOND worker on it (§8.2: never create
          // another blindly).
          await work.mutateWork(workId, (e) => {
            if (["running", "paused", "cancelled", "archived"].includes(e.state)) {
              return { save: null, value: null };
            }
            return { save: withState(e, "running"), value: null };
          });
        } else {
          // Terminal worker whose outcome never landed — adopt it fully
          // (claim, attempt status, waiting/external state).
          await recordWorkerOutcome(job);
        }
        reconciled += 1;
      } else {
        // Exhaustive scan found no correlated job: the dispatch never reached
        // the delegate service. Evidence is the scan itself.
        await work.recordOperationOutcome(workId, {
          receiptId: receipt.id,
          status: "failed",
          resultCode: "reconciled:no_job",
          result: {
            code: "external_outcome_unknown",
            retrySafe: true,
            message:
              `reconciled: a full delegate-store scan found no worker job with correlation ` +
              `${workId}/${receipt.id} — the dispatch never issued; safe to retry under a NEW key`,
          },
        });
        await work.mutateWork(workId, (e) => {
          const attempts = (e.attempts ?? []).map((a) =>
            a?.receiptId === receipt.id && (a.status === "dispatching" || a.status === "running")
              ? { ...a, status: "failed", updatedAt: now(), note: "dispatch never issued (reconciled: no correlated job)" }
              : a,
          );
          const next = withState({ ...e, attempts }, e.state === "running" ? "ready" : e.state);
          return { save: next, value: { reconciled: true } };
        });
        reconciled += 1;
      }
    }
    return { reconciled };
  }

  function dispatchResultFromJob(env, job, { reconciled = false } = {}) {
    return {
      workId: env.id,
      revision: env.revision,
      state: env.state,
      jobId: job.id,
      workerSessionId: job.childSessionID ?? null,
      jobStatus: job.status,
      changed: true,
      ...(reconciled ? { reconciled: true } : {}),
      summary:
        `dispatched work "${env.id}" to worker job ${job.id}` +
        (job.worktree ? ` in worktree ${job.worktree} (branch ${job.branch ?? "?"})` : "") +
        (reconciled ? " (adopted after reconciliation — the original outcome was never recorded)" : "") +
        `; the worker finishing does NOT complete the work`,
    };
  }

  // The §5.1 OwnedResource record for a dispatch-created delegate job — ONE
  // builder so both adoption paths (fresh dispatch, crash reconciliation)
  // produce byte-identical ownership records (§12 cleanup eligibility keys
  // off this).
  function jobResourceEntry(env, job, attemptId) {
    return {
      id: `res_${newId()}`,
      kind: "delegate_job",
      ref: job.id,
      path: job.worktree ?? null,
      branch: job.branch ?? null,
      owned: true,
      creator: { workId: env.id, attemptId },
      cleanupStatus: "active",
      createdAt: now(),
    };
  }

  // Stamp the attempt + owned-resource record for a correlated job (idempotent).
  async function adoptJobIntoEnvelope(workId, job, { viaReceiptId } = {}) {
    return work.mutateWork(workId, (env) => {
      const attempts = [...(env.attempts ?? [])];
      let idx = attempts.findIndex((a) => a?.jobId === job.id);
      if (idx === -1 && viaReceiptId) {
        idx = attempts.findIndex((a) => a?.receiptId === viaReceiptId && !a.jobId);
      }
      let linkedAttemptId = null;
      if (idx !== -1) {
        linkedAttemptId = attempts[idx].id;
        attempts[idx] = {
          ...attempts[idx],
          jobId: attempts[idx].jobId ?? job.id,
          status: attempts[idx].status === "dispatching" ? (isLiveJob(job) ? "running" : attempts[idx].status) : attempts[idx].status,
          updatedAt: now(),
        };
      }
      const resources = [...(env.resources ?? [])];
      if (job.id && !resources.some((r) => r?.kind === "delegate_job" && r.ref === job.id)) {
        resources.push(jobResourceEntry(env, job, linkedAttemptId));
      }
      return { save: { ...env, attempts, resources, updatedAt: now() }, value: { adopted: true } };
    });
  }

  // ---------------------------------------------------------------------------
  // Worker outcome adoption — the ENGINE calls this when a work-linked job
  // reaches a terminal status (delegate.onJobTerminal). THE CENTRAL INVARIANT
  // LIVES HERE: a reported-complete worker is a CLAIM; the work becomes
  // waiting/external — never "completed".
  // ---------------------------------------------------------------------------

  async function adoptOutcomeInEnvelope(env, job) {
    const attempts = [...(env.attempts ?? [])];
    const idx = attempts.findIndex((a) => a?.jobId === job.id);
    if (idx === -1) return { save: null, value: { adopted: false, reason: "no attempt links this job" } };
    const attempt = attempts[idx];
    const status =
      job.status === "done" ? "reported_complete" : job.status === "failed" ? "failed" : job.status === "stopped" ? "stopped" : null;
    if (!status) {
      return { save: null, value: { adopted: false, reason: `job status ${JSON.stringify(job.status)} is not a terminal outcome` } };
    }
    // §8.2/U13: a late completion for an attempt superseded by a spec
    // revision (or a retry) preserves its claim as SUPERSEDED evidence and
    // never advances the work. A non-superseded attempt that already reached
    // its terminal status is a pure replay — same event advances at most once.
    const staleSpec = attempt.specHash !== env.spec.hash || attempt.status === "superseded";
    if (attempt.status === status && !staleSpec) {
      return { save: null, value: { adopted: false, replay: true, reason: `attempt already ${attempt.status}` } };
    }
    if (attempt.status === "superseded") {
      // A superseded attempt only leaves a CLAIM behind when its worker said
      // "done"; a late failure just confirms the supersession. The claim
      // lands exactly once.
      const alreadyClaimed = status === "reported_complete" && (env.claims ?? []).some((c) => c?.id === `${attempt.id}:${IMPLEMENTATION_CLAIM}`);
      if (status !== "reported_complete" || alreadyClaimed) {
        return { save: null, value: { adopted: false, replay: true, reason: "attempt already superseded" } };
      }
    }

    const claims = [...(env.claims ?? [])];
    let claim = null;
    if (status === "reported_complete") {
      const claimId = `${attempt.id}:${IMPLEMENTATION_CLAIM}`;
      if (!claims.some((c) => c?.id === claimId)) {
        claim = {
          id: claimId,
          kind: IMPLEMENTATION_CLAIM,
          attemptId: attempt.id,
          jobId: job.id,
          specHash: attempt.specHash,
          observedAt: now(),
          superseded: staleSpec,
          note: clipNote(job.result ?? ""),
        };
        claims.push(claim);
      }
    }

    attempts[idx] = {
      ...attempt,
      // A superseded attempt STAYS superseded (its late outcome is evidence,
      // not a status change); a live attempt takes its terminal status.
      status: attempt.status === "superseded" ? "superseded" : status,
      ...(staleSpec ? { superseded: true } : {}),
      updatedAt: now(),
      note: clipNote(
        status === "reported_complete"
          ? `worker reported complete (CLAIM — not a completion verdict)${staleSpec ? "; attempt superseded by a later spec revision" : ""}`
          : `worker ${status}: ${clipNote(job.error ?? "")}`,
      ),
    };

    const evidence = [...(env.evidence ?? [])];
    const evidenceId = `delegate-job:${job.id}`;
    if (!evidence.some((r) => r?.id === evidenceId)) {
      evidence.push({
        kind: "message",
        id: evidenceId,
        sessionId: job.childSessionID ?? null,
        observedAt: now(),
      });
    }

    let next = { ...env, attempts, claims, evidence, updatedAt: now() };
    // State moves ONLY from "running" or "paused" (a worker outcome supersedes
    // a pause: the work is no longer paused-with-a-live-worker), and NEVER to
    // "completed". A stale-spec attempt preserves evidence without advancing
    // the current work (§8.2 / U13).
    if (!staleSpec && (next.state === "running" || next.state === "paused")) {
      if (status === "reported_complete") {
        next = withState(next, "waiting", { waitingReason: "external" });
      } else if (status === "failed") {
        next = withState(next, "failed");
      } else {
        next = withState(next, "ready");
      }
    }
    return { save: next, value: { adopted: true, claim: claim?.id ?? null, state: next.state } };
  }

  // Resolve an unresolved dispatch receipt for a terminal job (the crash case:
  // the worker EXISTS, so the dispatch effect happened). Runs OUTSIDE the
  // envelope lock — never call this from inside a mutateWork mutator (the
  // receipt recorder takes the same lock).
  async function resolveReceiptForJob(workId, job) {
    const env = await work.getWork(workId);
    if (!env) return false;
    const attempt = (env.attempts ?? []).find((a) => a?.jobId === job.id);
    if (!attempt?.receiptId) return false;
    const receipt = (env.operations ?? []).find((r) => r.id === attempt.receiptId);
    if (!receipt || !["pending", "in_flight", "unknown"].includes(receipt.status)) return false;
    await work.recordOperationOutcome(workId, {
      receiptId: receipt.id,
      status: "succeeded",
      externalRef: job.id,
      resultCode: `observed:job:${job.id}:${job.status}`,
      result: dispatchResultFromJob(env, job, { reconciled: true }),
    });
    return true;
  }

  async function recordWorkerOutcome(job) {
    if (!job || typeof job !== "object") return { adopted: false };
    const corr = job.correlation;
    if (!corr || corr.kind !== "work" || typeof corr.workId !== "string") {
      return { adopted: false, reason: "job carries no work correlation" };
    }
    const env = await work.getWork(corr.workId);
    if (!env) return { adopted: false, reason: "work envelope no longer exists" };
    await resolveReceiptForJob(corr.workId, job).catch(() => {});
    return work.mutateWork(corr.workId, (e) => adoptOutcomeInEnvelope(e, job));
  }

  // ---------------------------------------------------------------------------
  // Reads — dependency graph contains NO dispatch / worker creation anywhere.
  // ---------------------------------------------------------------------------

  function workRow(env) {
    return {
      id: env.id,
      revision: env.revision,
      objective: env.objective,
      state: env.state,
      ...(env.waitingReason ? { waitingReason: env.waitingReason } : {}),
      stage: env.stage,
      priority: env.priority,
      priorityReason: env.priorityReason,
      project: env.project,
      deliveryTarget: env.deliveryTarget,
      spec: env.spec,
      dependencies: env.dependencies,
      origin: env.origin,
      attempts: (env.attempts ?? []).length,
      claims: (env.claims ?? []).length,
      decisions: (env.decisions ?? []).length,
      updatedAt: env.updatedAt,
      createdAt: env.createdAt,
    };
  }

  async function workList({ state, project, stage, limit = LIST_DEFAULT_LIMIT } = {}) {
    const { works, total } = await work.listWorks({ limit: LIST_MAX_LIMIT });
    let rows = works.map(workRow);
    if (state !== undefined) {
      if (!WORK_STATES.includes(state)) {
        throw controlError("unsupported", `state filter "${state}" is not a valid work state`);
      }
      rows = rows.filter((r) => r.state === state);
    }
    if (stage !== undefined) {
      assertNonEmptyString(stage, "stage");
      rows = rows.filter((r) => r.stage === stage);
    }
    if (project !== undefined) {
      assertNonEmptyString(project, "project");
      rows = rows.filter((r) => r.project.workspaceId === project);
    }
    const bounded = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(Number(limit) || LIST_DEFAULT_LIMIT)));
    return {
      ok: true,
      data: {
        works: rows.slice(0, bounded),
        total: rows.length,
        portfolioTotal: total,
        truncated: rows.length > bounded,
        observedAt: new Date(now()).toISOString(),
      },
    };
  }

  async function workInspect({ work: workId } = {}) {
    const env = await getWorkOrThrow(workId);
    const jobs = await readJobsOrThrow(`inspecting work "${workId}"`);
    const attempts = [];
    for (const attempt of env.attempts ?? []) {
      const job = attempt?.jobId ? jobs.find((j) => j?.id === attempt.jobId) ?? null : null;
      attempts.push({
        ...attempt,
        live: job
          ? {
              jobStatus: job.status,
              activity: job.activity ?? null,
              filesChanged: job.filesChanged ?? null,
              error: job.error ?? null,
              worktree: job.worktree ?? null,
              branch: job.branch ?? null,
              pauseRequested: job.pauseRequested === true,
            }
          : null,
      });
    }
    // §3.3: the UI must be able to say what is still running — including any
    // correlated job whose attempt linkage was lost to a crash.
    const stillRunning = jobs
      .filter((j) => j?.correlation?.kind === "work" && j.correlation.workId === env.id && isLiveJob(j))
      .map((j) => ({ jobId: j.id, status: j.status, attemptLinked: (env.attempts ?? []).some((a) => a?.jobId === j.id) }));
    const unresolvedReceipts = (env.operations ?? [])
      .filter((r) => ["pending", "in_flight", "unknown"].includes(r.status))
      .map((r) => ({ id: r.id, key: r.key, op: r.op, status: r.status, leaseExpiresAt: r.lease?.expiresAt ?? null }));
    // Target liveness — a READ of live tmux; identity resolution stays a
    // write-path concern (fail closed at mutation time, not inspection time).
    let targetLive = null;
    try {
      const projects = await listProjects();
      const exact = projects.filter((p) => p?.tmuxSession === env.project.workspaceId);
      targetLive = exact.length === 1 ? true : exact.length === 0 ? false : "ambiguous";
    } catch {
      targetLive = null; // source unavailable — visible as null, never a guess
    }
    return {
      ok: true,
      data: {
        ...workRow(env),
        attempts,
        claims: env.claims ?? [],
        decisions: env.decisions ?? [],
        resources: env.resources ?? [],
        operations: (env.operations ?? []).map((r) => ({
          id: r.id,
          key: r.key,
          op: r.op,
          status: r.status,
          specHash: r.specHash,
          workRevision: r.workRevision,
          stage: r.stage,
          superseded: r.superseded === true,
          externalRef: r.externalRef ?? null,
          resultCode: r.resultCode ?? null,
          resultAt: r.resultAt ?? null,
        })),
        unresolvedReceipts,
        stillRunning,
        targetLive,
        observedAt: new Date(now()).toISOString(),
      },
    };
  }

  async function workEvidence({ work: workId } = {}) {
    const env = await getWorkOrThrow(workId);
    return {
      ok: true,
      data: {
        workId: env.id,
        spec: env.spec,
        claims: env.claims ?? [],
        evidence: env.evidence ?? [],
        operations: (env.operations ?? []).map((r) => ({
          id: r.id,
          key: r.key,
          op: r.op,
          status: r.status,
          specHash: r.specHash,
          superseded: r.superseded === true,
          externalRef: r.externalRef ?? null,
          resultCode: r.resultCode ?? null,
          resultAt: r.resultAt ?? null,
        })),
        observedAt: new Date(now()).toISOString(),
      },
    };
  }

  async function workCapacity() {
    const jobs = await readJobsOrThrow("capacity");
    const running = jobs.filter((j) => j?.status === "running").length;
    const { works } = await work.listWorks({ limit: LIST_MAX_LIMIT });
    const byState = {};
    for (const env of works) byState[env.state] = (byState[env.state] ?? 0) + 1;
    return {
      ok: true,
      data: {
        delegate: {
          runningJobs: running,
          maxRunningJobs: MAX_RUNNING_JOBS,
          availableSlots: Math.max(0, MAX_RUNNING_JOBS - running),
        },
        worksByState: byState,
        dispatchable: (byState.ready ?? 0) + (byState.waiting ?? 0),
        observedAt: new Date(now()).toISOString(),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // work_create — §7 create. The receipt predates the envelope, so it lives in
  // the shared §7 control ledger (createOperationRunner over mantaControlStore).
  // ---------------------------------------------------------------------------

  async function workCreate(input) {
    return createReceipts.runOperation({
      key: input?.key,
      op: "work.create",
      args: input ?? {},
      execute: async () => {
        try {
          assertPlainObject(input, "create input");
          assertNonEmptyString(input.objective, "objective");
          assertNonEmptyString(input.project, "project");
          if (input.id !== undefined && input.id !== null) assertSafeWorkId(input.id);
          validateSpecRef(input.spec);
          validateDeliveryTargetRef(input.deliveryTarget);
          if (input.state !== undefined && !["draft", "ready"].includes(input.state)) {
            // The create hole in the central invariant: a work item can never be
            // BORN completed/running/failed/... — only dispatch, outcomes and
            // the §11 PR's verified-completion path move state after create.
            throw controlError(
              "unsupported",
              `work_create state must be "draft" or "ready" (got ${JSON.stringify(input.state)}) — ` +
                `lifecycle states are reached through operations, never at birth`,
              { retrySafe: false },
            );
          }
          if (input.repositoryId !== undefined) assertNonEmptyString(input.repositoryId, "repositoryId");
          if (input.priority !== undefined && (typeof input.priority !== "number" || !Number.isFinite(input.priority))) {
            throw controlError("unsupported", "priority must be a finite number");
          }
          if (input.priorityReason !== undefined && typeof input.priorityReason !== "string") {
            throw controlError("unsupported", "priorityReason must be a string");
          }
          for (const d of input.decisions ?? []) validateDecisionRecord(d, "decisions[]");

          // §1.1: the target is EXPLICIT and resolved against live tmux — never
          // inferred from the conversation cwd or the first project.
          let projects;
          try {
            projects = await listProjects();
          } catch (error) {
            throw toControlError(error);
          }
          const { project: resolved } = resolveProjectIdentity(projects, input.project);

          const conversationId = await getConversationId();
          if (typeof conversationId !== "string" || !conversationId) {
            throw controlError(
              "unsupported",
              "work_create attributes origin to the bound CTO conversation, but no conversation is bound — " +
                "bind the role session first (spec §3.1)",
              { retrySafe: true },
            );
          }

          const projectRef = {
            // workspaceId is the PROVEN Manta-side identity (the tmux session
            // name). The Manta-minted durable projectId (PR #1516) is a separate
            // adoption — this record keeps ONE identity surface so it can land
            // without touching call sites.
            workspaceId: resolved.tmuxSession,
            repositoryId: input.repositoryId ?? "unmapped",
            repositoryRoot: resolved.defaultCwd,
          };
          validateProjectRefRef(projectRef);

          let env;
          try {
            env = await work.createWork({
              id: input.id,
              origin: { conversationId, messageId: input.originMessageId ?? "unattributed" },
              project: projectRef,
              spec: { ...input.spec },
              objective: input.objective,
              deliveryTarget: { ...input.deliveryTarget },
              dependencies: input.dependencies ?? [],
              priority: input.priority ?? 0,
              priorityReason: input.priorityReason ?? "",
              stage: "specify",
              state: input.state ?? "draft",
              decisions: input.decisions ?? [],
            });
          } catch (error) {
            throw toWorkToolError(error);
          }
          return {
            workId: env.id,
            resourceId: `work:${env.id}`,
            revision: env.revision,
            state: env.state,
            changed: true,
            project: projectRef,
            summary:
              `created work "${env.id}" (state ${env.state}, stage ${env.stage}) targeting project ` +
              `"${resolved.tmuxSession}" at ${resolved.defaultCwd}; delivery target ${describeDeliveryTarget(env.deliveryTarget)}`,
          };
        } catch (error) {
          // Map BEFORE the shared runner's catch so the receipt replays the
          // SPECIFIC stable code, not a generic provider mapping.
          throw toWorkToolError(error);
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // work_revise / work_prioritize
  // ---------------------------------------------------------------------------

  const REVISE_FORBIDDEN_STATES = Object.freeze(["completed", "running", "archived", "cancelled"]);

  async function workRevise(input) {
    assertPlainObject(input, "revise input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    assertPlainObject(input.patch, "patch");
    const snapshot = argsSnapshot(input);
    const hash = canonicalArgsHash("work.revise", snapshot);

    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.revise",
      args: snapshot,
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;

    try {
      if (input.patch.state !== undefined && REVISE_FORBIDDEN_STATES.includes(input.patch.state)) {
        throw controlError(
          "unsupported",
          `work_revise cannot set state "${input.patch.state}" — completion is owned by the declared delivery ` +
            `target (§11), running by dispatch, archived by work_archive, cancelled by work_cancel`,
          { retrySafe: false },
        );
      }
      const envBefore = await getWorkOrThrow(input.work);
      if (
        input.patch.state === "ready" &&
        (envBefore.decisions ?? []).some((d) => isBlockingOpenDecision(d))
      ) {
        // §6 draft→ready precondition: no unresolved blocking decisions.
        throw controlError(
          "policy_blocked",
          `work "${input.work}" has unresolved blocking decisions — answer them (work_answer_decision) before becoming ready`,
          { retrySafe: false },
        );
      }
      const env = await work.reviseWork(input.work, input.patch, { expectedRevision: input.expectedRevision });
      // §5.2: a spec revision pauses advancement — a running worker was
      // pinned to the OLD spec; the envelope already marked its receipts
      // superseded, and the attempt is now marked so a late completion event
      // cannot advance the new spec (adoptOutcomeInEnvelope's staleSpec path).
      if (input.patch.spec !== undefined && input.patch.spec.hash !== envBefore.spec.hash && env.state === "running") {
        await work.mutateWork(input.work, (e) => {
          const attempts = (e.attempts ?? []).map((a) =>
            a?.status === "running" || a?.status === "dispatching"
              ? { ...a, status: "superseded", updatedAt: now(), note: "superseded by a spec revision (§5.2)" }
              : a,
          );
          return { save: withState({ ...e, attempts }, "paused"), value: null };
        });
      }
      await work.recordOperationOutcome(input.work, {
        receiptId: receipt.id,
        status: "succeeded",
        resultCode: "revised",
        result: successPayload({
          env,
          receipt,
          state: env.state,
          revision: env.revision,
          summary: `revised work "${input.work}" → revision ${env.revision} (${Object.keys(input.patch).join(", ")})` +
            (input.reason ? ` — ${clipNote(input.reason)}` : ""),
        }),
      });
      return {
        ok: true,
        replayed: false,
        workId: env.id,
        revision: env.revision,
        state: env.state,
        summary: `revised work "${input.work}" → revision ${env.revision} (${Object.keys(input.patch).join(", ")})` +
          (input.reason ? ` — ${clipNote(input.reason)}` : "") +
          (env.state === "paused" && envBefore.state === "running" && input.patch.spec !== undefined
            ? "; a spec revision pauses advancement — the in-flight worker was pinned to the OLD spec and any result it reports is superseded evidence (§5.2)"
            : ""),
        operationId: receipt.id,
        key: receipt.key,
      };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  async function workPrioritize(input) {
    assertPlainObject(input, "prioritize input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    if (typeof input.priority !== "number" || !Number.isFinite(input.priority)) {
      throw controlError("unsupported", "priority must be a finite number");
    }
    if (input.priorityReason !== undefined && typeof input.priorityReason !== "string") {
      throw controlError("unsupported", "priorityReason must be a string");
    }
    const snapshot = argsSnapshot(input);
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.prioritize",
      args: snapshot,
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      // §6: reprioritization never touches running workers — the patch is
      // exactly the two priority fields, nothing else.
      const env = await work.reviseWork(
        input.work,
        { priority: input.priority, priorityReason: input.priorityReason ?? "" },
        { expectedRevision: input.expectedRevision },
      );
      const payload = successPayload({
        env,
        receipt,
        summary: `work "${env.id}" priority → ${env.priority}${env.priorityReason ? ` (${env.priorityReason})` : ""} — running workers were not disturbed`,
      });
      await work.recordOperationOutcome(input.work, {
        receiptId: receipt.id,
        status: "succeeded",
        resultCode: "prioritized",
        result: payload,
      });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // work_dispatch / work_retry — the dispatch pipeline (§6 ready→running,
  // §8.1 protocol, §8.2 crash windows, §9 capacity/dependencies).
  // ---------------------------------------------------------------------------

  async function runDispatchPipeline({ input, op, envBefore, completionParentSessionId, receipt }) {
    const deps = requireDelegateOps(op === "work.retry" ? "retry" : "dispatch");
    let attemptId = null;
    try {
      // in_flight BEFORE the first external effect (§8.1 crash-window marker).
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });

      // Target revalidation (§6) + cwd existence chokepoint.
      const target = await revalidateTarget(envBefore);
      let repositoryRoot;
      try {
        repositoryRoot = resolveCwd(envBefore.project.repositoryRoot);
      } catch {
        throw controlError(
          "target_not_found",
          `work "${input.work}" target checkout ${envBefore.project.repositoryRoot} no longer exists — ` +
            `re-point the work or restore the checkout`,
          { retrySafe: false },
        );
      }

      // §8.1 step 4 + §6: state → running with the attempt LINKED, atomically
      // under the envelope lock, BEFORE the prompt is dispatched. Receipt
      // protocol state moves do not bump the work revision (the reserve's
      // expectedRevision CAS stays meaningful across this transition).
      const attemptNumber = (envBefore.attempts ?? []).filter((a) => a?.stage === envBefore.stage).length + 1;
      attemptId = `att_${newId()}`;
      const attempt = {
        id: attemptId,
        stage: envBefore.stage,
        attemptNumber,
        specHash: envBefore.spec.hash,
        receiptId: receipt.id,
        jobId: null,
        status: "dispatching",
        startedAt: now(),
        updatedAt: now(),
      };
      await work.mutateWork(input.work, (env) => {
        assertDispatchAdmissible(env);
        assertAttemptBudget(env);
        return {
          save: withState({ ...env, attempts: [...(env.attempts ?? []), attempt] }, "running"),
          value: null,
        };
      });

      const started = await deps.startJob({
        prompt: buildWorkPrompt(envBefore),
        // completionParentSessionId (§8.1) — the headless CTO conversation,
        // resolved at admission and passed in.
        parentSessionID: completionParentSessionId,
        // The validated execution target (§8.1) — explicit, never parent lookup.
        parentDirectory: repositoryRoot,
        targetProject: envBefore.project.workspaceId,
        isolationRequired: true,
        correlation: { kind: "work", workId: input.work, receiptId: receipt.id, op },
        actor: "cto",
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.subagentType !== undefined ? { subagent_type: input.subagentType } : {}),
      });
      if (!started?.ok || !started.job) {
        const rawError = started?.error ?? "startJob returned no job";
        const code = started?.error === CAP_ERROR || rawError === CAP_ERROR ? "capacity_wait" : started?.code === "worktree_failed" ? "provider_unavailable" : "provider_unavailable";
        const retrySafe = code === "capacity_wait";
        throw controlError(code, `dispatch of work "${input.work}" failed: ${rawError}`, {
          retrySafe,
          details: started?.code ? { reason: started.code } : undefined,
        });
      }
      const job = started.job;

      const payload = dispatchResultFromJob(envBefore, job);
      await work.recordOperationOutcome(input.work, {
        receiptId: receipt.id,
        status: "succeeded",
        externalRef: job.id,
        resultCode: "dispatched",
        result: payload,
      });
      await work.mutateWork(input.work, (env) => {
        const attempts = (env.attempts ?? []).map((a) =>
          a?.id === attemptId ? { ...a, jobId: job.id, status: "running", updatedAt: now() } : a,
        );
        const resources = [...(env.resources ?? [])];
        if (!resources.some((r) => r?.kind === "delegate_job" && r.ref === job.id)) {
          resources.push(jobResourceEntry(env, job, attemptId));
        }
        return { save: { ...env, attempts, resources, updatedAt: now() }, value: null };
      });
      return { ok: true, replayed: false, ...payload, operationId: receipt.id, key: receipt.key };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err).catch(() => {});
      // Revert the admission state honestly: a capacity refusal parks the work
      // on waiting/capacity (§9 "record why something waits"); any other
      // dispatch failure returns the work to ready (dispatchable again — the
      // attempt history + receipt carry what happened).
      await work
        .mutateWork(input.work, (env) => {
          if (env.state !== "running") return { save: null, value: null };
          const attempts = (env.attempts ?? []).map((a) =>
            a?.id === attemptId && a.status === "dispatching"
              ? { ...a, status: "failed", updatedAt: now(), note: clipNote(err.message) }
              : a,
          );
          const next =
            err.code === "capacity_wait"
              ? withState({ ...env, attempts }, "waiting", { waitingReason: "capacity" })
              : withState({ ...env, attempts }, "ready");
          return { save: next, value: null };
        })
        .catch(() => {});
      throw err;
    }
  }

  async function workDispatch(input) {
    assertPlainObject(input, "dispatch input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    // The completion parent (§8.1) — resolved at admission so an unbound
    // conversation fails BEFORE any reservation or external effect.
    const completionParentSessionId = input.completionParentSessionId ?? (await getConversationId());
    if (typeof completionParentSessionId !== "string" || !completionParentSessionId) {
      throw controlError(
        "unsupported",
        "dispatch requires a bound CTO conversation to receive the worker's completion — " +
          "bind the role session first (spec §3.1)",
        { retrySafe: true },
      );
    }
    // Reconcile any unknown dispatch receipts FIRST (§8.2 adoption) — the
    // admission checks below then run against the fresh envelope.
    await reconcileUnknownReceipts(input.work);
    // Reserve BEFORE admission so a terminal receipt REPLAYS the original
    // result regardless of the work's current state (replaying a succeeded
    // dispatch must not be blocked by the state the dispatch itself caused).
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.dispatch",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const envBefore = await getWorkOrThrow(input.work);
    assertDispatchAdmissible(envBefore);
    await assertDependenciesOrPark(input.work, envBefore);
    assertAttemptBudget(envBefore);
    return runDispatchPipeline({
      input,
      op: "work.dispatch",
      envBefore,
      completionParentSessionId,
      receipt: reserved.receipt,
    });
  }

  async function assertDependenciesOrPark(workId, env) {
    const unmet = [];
    for (const depId of env.dependencies ?? []) {
      let dep;
      try {
        dep = await work.getWork(depId);
      } catch {
        dep = null;
      }
      if (!dep) {
        unmet.push({ id: depId, readiness: "missing" });
        continue;
      }
      const r = dependencyReadiness(dep);
      if (!r.met) unmet.push({ id: depId, readiness: r.source });
    }
    if (unmet.length === 0) return;
    // Durable wait reason (§9), then refuse.
    await work
      .mutateWork(workId, (e) =>
        e.state === "running"
          ? { save: null, value: null }
          : { save: { ...e, state: "waiting", waitingReason: "dependency", updatedAt: now() }, value: null },
      )
      .catch(() => {});
    throw controlError(
      "policy_blocked",
      `work "${workId}" cannot dispatch — dependencies unmet: ` +
        unmet.map((u) => `${u.id} (${u.readiness})`).join(", "),
      { retrySafe: true, details: { unmet } },
    );
  }

  async function workRetry(input) {
    assertPlainObject(input, "retry input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const completionParentSessionId = input.completionParentSessionId ?? (await getConversationId());
    if (typeof completionParentSessionId !== "string" || !completionParentSessionId) {
      throw controlError(
        "unsupported",
        "retry requires a bound CTO conversation to receive the worker's completion — " +
          "bind the role session first (spec §3.1)",
        { retrySafe: true },
      );
    }
    await reconcileUnknownReceipts(input.work);
    // Reserve BEFORE admission — replay first (see work_dispatch).
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.retry",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const envBefore = await getWorkOrThrow(input.work);
    // Retry = a NEW attempt for the current stage (§8.2): from a failed work,
    // or from a work whose worker reported complete but the operator wants a
    // fresh run (the old attempt is superseded, its claim kept as evidence).
    const retryable =
      envBefore.state === "failed" ||
      (envBefore.state === "waiting" && envBefore.waitingReason === "external");
    if (!retryable) {
      throw controlError(
        envBefore.state === "running" ? "active_resource" : "policy_blocked",
        envBefore.state === "running"
          ? `work "${input.work}" has a live worker — pause or cancel before retrying`
          : `work "${input.work}" is ${envBefore.state}${envBefore.waitingReason ? ` (${envBefore.waitingReason})` : ""} — retry applies to failed work or reported-complete work awaiting the next stages`,
        { retrySafe: false },
      );
    }
    // Supersede the prior attempt (evidence preserved), then run the pipeline.
    await work.mutateWork(input.work, (env) => {
      if (env.state !== envBefore.state) return { save: null, value: null };
      const attempts = (env.attempts ?? []).map((a) =>
        a?.stage === env.stage && (a.status === "reported_complete" || a.status === "failed")
          ? { ...a, status: "superseded", updatedAt: now(), note: "superseded by work_retry (evidence preserved)" }
          : a,
      );
      return { save: withState({ ...env, attempts }, "ready"), value: null };
    });
    const envAfter = await getWorkOrThrow(input.work);
    assertDispatchAdmissible(envAfter);
    await assertDependenciesOrPark(input.work, envAfter);
    assertAttemptBudget(envAfter);
    return runDispatchPipeline({
      input,
      op: "work.retry",
      envBefore: envAfter,
      completionParentSessionId,
      receipt: reserved.receipt,
    });
  }

  // ---------------------------------------------------------------------------
  // work_pause / work_resume / work_cancel (§6; §3.3 reporting)
  // ---------------------------------------------------------------------------

  async function workPause(input) {
    assertPlainObject(input, "pause input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.pause",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    const pauseJob = requireDelegateAction("pauseJob");
    try {
      const jobs = await readJobsOrThrow(`pausing work "${input.work}"`);
      const live = await liveAttempts(envBefore, jobs);
      const requested = [];
      const couldNotPause = [];
      for (const { attempt, job } of live) {
        if (job.status !== "running") continue; // already paused at its boundary
        try {
          const res = await pauseJob(job.id);
          if (res?.ok) requested.push({ jobId: job.id, attemptId: attempt.id, checkpoint: "requested — pauses at the next completed-tool-part boundary" });
          else couldNotPause.push({ jobId: job.id, reason: res?.error ?? "pauseJob refused" });
        } catch (error) {
          couldNotPause.push({ jobId: job.id, reason: String(error?.message ?? error) });
        }
      }
      await work.mutateWork(input.work, (env) => {
        if (env.state === "paused" || env.state === "archived" || env.state === "cancelled") {
          return { save: null, value: null };
        }
        return { save: withState(env, "paused"), value: null };
      });
      const summary =
        `paused work "${input.work}" (no new stage admission)` +
        (requested.length
          ? `; checkpoint requested for ${requested.length} worker(s): ${requested.map((r) => r.jobId).join(", ")}`
          : "") +
        (couldNotPause.length
          ? `; COULD NOT PAUSE: ${couldNotPause.map((r) => `${r.jobId} (${r.reason})`).join(", ")} — still running`
          : requested.length
            ? ""
            : "; no live workers to checkpoint");
      const payload = successPayload({
        env: envBefore,
        receipt,
        state: "paused",
        summary,
        extra: { changed: true, checkpointRequested: requested, stillRunning: couldNotPause },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "paused", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  async function workResume(input) {
    assertPlainObject(input, "resume input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    if (envBefore.state !== "paused") {
      throw controlError("policy_blocked", `work "${input.work}" is not paused (state ${envBefore.state})`, { retrySafe: false });
    }
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.resume",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    const resumeJob = requireDelegateAction("resumeJob");
    try {
      const jobs = await readJobsOrThrow(`resuming work "${input.work}"`);
      // §6: resume reconciles existing resources before deciding whether to
      // reuse or replace an attempt.
      const resumed = [];
      const adopted = [];
      const replaced = [];
      let anyLive = false;
      for (const attempt of envBefore.attempts ?? []) {
        if (!attempt?.jobId) continue;
        const job = jobs.find((j) => j?.id === attempt.jobId);
        if (!job) {
          // §8.2 "worker disappears": preserve the reference, report missing.
          await work.mutateWork(input.work, (env) => ({
            save: {
              ...env,
              attempts: (env.attempts ?? []).map((a) =>
                a?.id === attempt.id && a.status === "running"
                  ? { ...a, status: "missing", updatedAt: now(), note: "job record no longer exists (worker disappeared)" }
                  : a,
              ),
            },
            value: null,
          }));
          continue;
        }
        if (job.status === "running") {
          anyLive = true; // never actually paused at its boundary — still going
          continue;
        }
        if (job.status === "paused") {
          const res = await resumeJob(job.id);
          if (res?.ok) {
            resumed.push(job.id);
            anyLive = true;
          } else if (res?.retriable) {
            throw controlError(
              "capacity_wait",
              `resume of work "${input.work}" could not re-acquire a slot: ${res.error}`,
              { retrySafe: true },
            );
          } else {
            throw controlError("provider_unavailable", `resume of job ${job.id} failed: ${res?.error ?? "unknown"}`, { retrySafe: true });
          }
          continue;
        }
        // Terminal job whose outcome never landed on the work — adopt it now.
        const outcome = await work.mutateWork(input.work, (env) => adoptOutcomeInEnvelope(env, job));
        if (outcome?.adopted) {
          adopted.push({ jobId: job.id, outcome: job.status });
          if (job.status === "stopped") replaced.push(job.id);
        }
      }
      const fresh = await getWorkOrThrow(input.work);
      // Decide the resulting admission state: running when a worker is live,
      // ready when dispatchable, otherwise the adopted outcome's state.
      let nextState = fresh.state;
      if (fresh.state === "paused") nextState = anyLive ? "running" : "ready";
      await work.mutateWork(input.work, (env) => {
        if (env.state === nextState) return { save: null, value: null };
        return { save: withState(env, nextState), value: null };
      });
      const summary =
        `resumed work "${input.work}"` +
        (resumed.length ? `; resumed worker(s): ${resumed.join(", ")}` : "") +
        (adopted.length ? `; adopted terminal outcome(s): ${adopted.map((a) => `${a.jobId} → ${a.outcome}`).join(", ")}` : "") +
        (replaced.length ? `; attempt(s) stopped and replaceable: ${replaced.join(", ")}` : "") +
        ` → state ${nextState}`;
      const payload = successPayload({
        env: fresh,
        receipt,
        state: nextState,
        summary,
        extra: { changed: true, resumed, adopted, replaced },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "resumed", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  async function workCancel(input) {
    assertPlainObject(input, "cancel input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    if (["cancelled", "archived", "completed"].includes(envBefore.state)) {
      throw controlError("policy_blocked", `work "${input.work}" is already ${envBefore.state}`, { retrySafe: false });
    }
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.cancel",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    const stopJob = requireDelegateAction("stopJob");
    try {
      const jobs = await readJobsOrThrow(`cancelling work "${input.work}"`);
      const live = await liveAttempts(envBefore, jobs);
      const stopped = [];
      const leftIntact = [];
      const couldNotStop = [];
      // §6: "cancellation intent persisted; running effects reconciled …
      // unfinished effects explicitly reported". Persist the intent FIRST.
      await work.mutateWork(input.work, (env) => {
        if (env.state === "cancelled") return { save: null, value: null };
        return { save: withState(env, "cancelled"), value: null };
      });
      for (const { attempt, job } of live) {
        if (job.status === "paused") {
          // Parked, not in flight — left intact (its worktree is preserved);
          // reported rather than silently dropped.
          leftIntact.push(job.id);
          continue;
        }
        try {
          const res = await stopJob(job.id);
          if (res?.ok) stopped.push(job.id);
          else couldNotStop.push({ jobId: job.id, reason: res?.error ?? "stopJob refused" });
        } catch (error) {
          couldNotStop.push({ jobId: job.id, reason: String(error?.message ?? error) });
        }
      }
      const summary =
        `cancelled work "${input.work}" — no further dispatch` +
        (stopped.length ? `; stopped worker(s): ${stopped.join(", ")}` : "") +
        (couldNotStop.length
          ? `; COULD NOT CANCEL: ${couldNotStop.map((r) => `${r.jobId} (${r.reason})`).join(", ")} — still running externally`
          : "") +
        (leftIntact.length
          ? `; paused worker(s) left intact with their worktrees: ${leftIntact.join(", ")}`
          : "") +
        (!stopped.length && !leftIntact.length && !couldNotStop.length ? "; no live workers" : "");
      const payload = successPayload({
        env: envBefore,
        receipt,
        state: "cancelled",
        summary,
        extra: { changed: true, stopped, stillRunning: couldNotStop, leftIntact },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "cancelled", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // work_answer_decision (§5.1 Decision)
  // ---------------------------------------------------------------------------

  async function workAnswerDecision(input) {
    assertPlainObject(input, "answer_decision input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    assertNonEmptyString(input.decisionId, "decisionId");
    assertNonEmptyString(input.response, "response");
    const envBefore = await getWorkOrThrow(input.work);
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.answer_decision",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      const decision = (envBefore.decisions ?? []).find((d) => d?.id === input.decisionId);
      if (!decision) {
        throw controlError("target_not_found", `work "${input.work}" has no decision "${input.decisionId}"`, { retrySafe: false });
      }
      validateDecisionRecord(decision, "decision");
      if (decision.state === "answered") {
        throw controlError(
          "policy_blocked",
          `decision "${decision.id}" on work "${input.work}" was already answered — ` +
            `the work has moved on; re-raise a new decision instead`,
          { retrySafe: false },
        );
      }
      // §5.1: "Old/spec-incompatible responses fail visibly rather than
      // starting a second attempt."
      if (decision.originatingSpecHash && decision.originatingSpecHash !== envBefore.spec.hash) {
        throw controlError(
          "revision_conflict",
          `decision "${decision.id}" belongs to spec ${decision.originatingSpecHash} but work "${input.work}" ` +
            `is now on spec ${envBefore.spec.hash} — the response would change stale work; re-raise it on the current spec`,
          { retrySafe: false },
        );
      }
      await work.mutateWork(input.work, (env) => {
        const decisions = (env.decisions ?? []).map((d) =>
          d?.id === input.decisionId
            ? {
                ...d,
                state: "answered",
                response: { text: clipNote(input.response), answeredAt: now() },
              }
            : d,
        );
        let next = { ...env, decisions, updatedAt: now() };
        // "Accepted responses change the work once": unblock only when this
        // was the last open blocking decision.
        if (
          next.state === "needs_decision" &&
          isBlockingOpenDecision(decision) &&
          !next.decisions.some((d) => isBlockingOpenDecision(d))
        ) {
          next = { ...next, state: decision.priorState && WORK_STATES.includes(decision.priorState) ? decision.priorState : "ready" };
        }
        return { save: next, value: null };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `decision "${input.decisionId}" answered on work "${input.work}" — the work changed once`,
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "answered", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // work_archive / work_cleanup (§12)
  // ---------------------------------------------------------------------------

  async function workArchive(input) {
    assertPlainObject(input, "archive input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.archive",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      const jobs = await readJobsOrThrow(`archiving work "${input.work}"`);
      const live = await liveAttempts(envBefore, jobs);
      if (live.length > 0) {
        throw controlError(
          "active_resource",
          `work "${input.work}" still has live worker(s) (${live.map((l) => l.job.id).join(", ")}) — ` +
            `pause or cancel before archiving`,
          { retrySafe: false },
        );
      }
      let changed = false;
      await work.mutateWork(input.work, (env) => {
        if (env.state === "archived") return { save: null, value: { changed: false } };
        changed = true;
        return { save: withState(env, "archived"), value: { changed: true } };
      });
      const fresh = await getWorkOrThrow(input.work);
      // §12: archive is metadata-only — attempts, claims, evidence, receipts
      // and resources all remain readable. Nothing is deleted.
      const payload = successPayload({
        env: fresh,
        receipt,
        state: "archived",
        summary:
          `archived work "${input.work}" (metadata only — evidence, attempts and receipts preserved; ` +
          `nothing was deleted)`,
        extra: { changed },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "archived", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // ONE resource-status mutator for the cleanup order (§12: "Failure at any
  // step retains enough metadata to retry and remains visible") — every
  // transition records the status change on the resource row itself.
  function markResource(workId, resourceId, patch) {
    return work.mutateWork(workId, (env) => ({
      save: {
        ...env,
        resources: (env.resources ?? []).map((x) =>
          x?.id === resourceId ? { ...x, ...patch, updatedAt: now() } : x,
        ),
      },
      value: null,
    }));
  }

  async function workCleanup(input) {
    assertPlainObject(input, "cleanup input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    const reserved = await reserveOrThrow(input.work, {
      key: input.key,
      op: "work.cleanup",
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision,
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    const deleteJob = requireDelegateAction("deleteJob");
    try {
      const resources = envBefore.resources ?? [];
      const borrowed = resources.filter((r) => r?.owned !== true);
      if (borrowed.length > 0) {
        throw controlError(
          "borrowed_resource",
          `work "${input.work}" references ${borrowed.length} borrowed resource(s) (${borrowed.map((r) => r.ref).join(", ")}) — ` +
            `cleanup only removes CTO-created resources (§12)`,
          { retrySafe: false },
        );
      }
      if ((envBefore.decisions ?? []).some((d) => isBlockingOpenDecision(d))) {
        throw controlError(
          "policy_blocked",
          `work "${input.work}" still has an open blocking decision — answer it before cleanup`,
          { retrySafe: false },
        );
      }
      const unresolved = (envBefore.operations ?? []).filter((r) =>
        ["pending", "in_flight", "unknown"].includes(r.status),
      );
      if (unresolved.length > 0) {
        throw controlError(
          "external_outcome_unknown",
          `work "${input.work}" has ${unresolved.length} unresolved operation(s) (${unresolved.map((r) => r.id).join(", ")}) — ` +
            `reconcile before cleanup (§12: no pending reconciliation)`,
          { retrySafe: false },
        );
      }
      if (envBefore.state === "running") {
        throw controlError("active_resource", `work "${input.work}" is still running`, { retrySafe: false });
      }
      if (envBefore.state === "waiting" && envBefore.waitingReason === "external") {
        throw controlError(
          "policy_blocked",
          `work "${input.work}" reported a completed worker but the review/merge stages have not run — ` +
            `§12 keeps the checkout until review no longer needs it (archive instead)`,
          { retrySafe: false },
        );
      }
      const jobs = await readJobsOrThrow(`cleaning up work "${input.work}"`);
      const jobResources = resources.filter((r) => r?.kind === "delegate_job" && r.cleanupStatus !== "removed");
      for (const r of jobResources) {
        const job = jobs.find((j) => j?.id === r.ref);
        if (job && isLiveJob(job)) {
          throw controlError(
            "active_resource",
            `resource ${r.ref} of work "${input.work}" is still ${job.status} — stop it before cleanup`,
            { retrySafe: false },
          );
        }
      }
      // §12 order: validate and record intent → preserve evidence → remove
      // through the existing NON-FORCED operation → record success. Failure
      // retains metadata to retry and stays visible.
      const removed = [];
      const failed = [];
      for (const r of jobResources) {
        await work.mutateWork(input.work, (env) => ({
          save: {
            ...env,
            resources: (env.resources ?? []).map((x) =>
              x?.id === r.id ? { ...x, cleanupStatus: "pending", updatedAt: now() } : x,
            ),
          },
          value: null,
        }));
        try {
          const res = await deleteJob(r.ref);
          if (res?.ok) {
            removed.push(r.ref);
            await markResource(input.work, r.id, { cleanupStatus: "removed", removedAt: now() });
          } else {
            const reason = String(res?.reason ?? res?.error ?? "removal refused");
            failed.push({ ref: r.ref, reason });
            await markResource(input.work, r.id, { cleanupStatus: "failed", failureReason: clipNote(reason) });
          }
        } catch (error) {
          const reason = String(error?.message ?? error);
          failed.push({ ref: r.ref, reason });
          await markResource(input.work, r.id, { cleanupStatus: "failed", failureReason: clipNote(reason) });
        }
      }
      const fresh = await getWorkOrThrow(input.work);
      if (failed.length > 0 && removed.length === 0 && jobResources.length > 0) {
        // NOTHING was removed — the cleanup did not do its job. Fail with the
        // first refusal's stable code; the resource records above already
        // retain the metadata to retry and stay visible.
        const first = failed[0];
        throw controlError(
          first.reason === "dirty" ? "dirty_resource" : "provider_unavailable",
          `cleanup of work "${input.work}" removed nothing: ${failed.map((f) => `${f.ref} (${f.reason})`).join(", ")} — ` +
            `the resource records retain their metadata to retry`,
          { retrySafe: true, details: { failed } },
        );
      }
      const summary =
        `cleaned up work "${input.work}"` +
        (removed.length ? `; removed: ${removed.join(", ")}` : "") +
        (failed.length
          ? `; RETAINED (visible + retryable): ${failed.map((f) => `${f.ref} (${f.reason})`).join(", ")}`
          : "") +
        `; the work record and its evidence remain`;
      const payload = successPayload({
        env: fresh,
        receipt,
        summary,
        extra: { changed: removed.length > 0, removed, failed },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "cleaned", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  return {
    // reads
    workList,
    workInspect,
    workEvidence,
    workCapacity,
    // mutations
    workCreate,
    workRevise,
    workPrioritize,
    workDispatch,
    workPause,
    workResume,
    workCancel,
    workRetry,
    workAnswerDecision,
    workArchive,
    workCleanup,
    // engine-facing outcome routing (delegate.onJobTerminal)
    recordWorkerOutcome,
  };
}


// ---------------------------------------------------------------------------
// Tool registration — the production composition boundary. Each operation is
// ONE tool with an ACTION-SPECIFIC params schema (no shared unvalidated args
// bag). Reads are mode "auto"; every mutation is mode "confirm".
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(["work_list", "work_inspect", "work_evidence", "work_capacity"]);

export function registerCtoWorkTools(register, workControl) {
  const def = (name, description, params, run) =>
    register({
      name,
      description,
      params,
      mode: READ_TOOLS.has(name) ? "auto" : "confirm",
      run: async (_ctx, args) => {
        try {
          return await run(args ?? {});
        } catch (error) {
          const err = toWorkToolError(error);
          return { ok: false, code: err.code, retrySafe: err.retrySafe === true, error: err.message };
        }
      },
    });

  def(
    "work_list",
    "List tracked work items with state, stage, priority, project, spec revision and delivery target. Optional " +
      "filters (state/project/stage). Bounded; truncation is visible. Read-only.",
    {
      state: { type: "string", description: "Filter by work state (draft|ready|running|waiting|paused|needs_decision|failed|completed|cancelled|archived)." },
      project: { type: "string", description: "Filter by the work's target project (workspaceId)." },
      stage: { type: "string", description: "Filter by stage (specify|implement|review|merge|release|verify)." },
      limit: { type: "number", description: "Max rows (default 100)." },
    },
    (args) => workControl.workList(args),
  );

  def(
    "work_inspect",
    "Inspect ONE work item: envelope (objective, spec, project, delivery target), attempts with LIVE worker " +
      "status from the authoritative delegate store, claims (what workers SAID), decisions, owned resources, " +
      "unresolved operation receipts, what is still running, and whether the target still resolves. Read-only.",
    { work: { type: "string", description: "The work id." } },
    (args) => workControl.workInspect(args),
  );

  def(
    "work_evidence",
    "The observation trail of ONE work item: recorded claims (explicitly labelled as worker claims, not " +
      "verdicts), source evidence references and the operation receipts with their outcomes. Read-only.",
    { work: { type: "string", description: "The work id." } },
    (args) => workControl.workEvidence(args),
  );

  def(
    "work_capacity",
    "Dispatch capacity: running delegate jobs vs the box cap, available slots, and work counts by state. " +
      "Read-only — dispatches nothing.",
    {},
    (args) => workControl.workCapacity(args),
  );

  def(
    "work_create",
    "Create a tracked work item. The target project is EXPLICIT (exact tmux session name — resolved against " +
      "live state, never inferred); the spec (revision + hash + document ref) and the delivery target are " +
      "required. Creates as draft (or ready when the spec is settled). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key (replays the original result)." },
      project: { type: "string", description: "Target project — the exact tmux session name." },
      objective: { type: "string", description: "What this work delivers." },
      spec: {
        type: "object",
        description: "Pinned spec: {revision, hash, documentRef}. Workers never consume a mutable latest spec.",
      },
      deliveryTarget: {
        type: "object",
        description: "Discriminated: {kind:'spec'} | {kind:'pr'} | {kind:'merged', baseBranch} | {kind:'published', releaseTarget, channel} | {kind:'deployed', releaseTarget, channel, instance}. The delivery target determines completion.",
      },
      state: { type: "string", description: "draft (default) or ready (spec settled)." },
      dependencies: { type: "array", description: "Work ids this depends on (acyclic; existence enforced)." },
      priority: { type: "number", description: "Scheduling priority (higher first)." },
      priorityReason: { type: "string", description: "Why this priority." },
      repositoryId: { type: "string", description: "Optional canonical repository identity (defaults to 'unmapped')." },
      decisions: { type: "array", description: "Initial decision records (usually empty)." },
      originMessageId: { type: "string", description: "Optional originating CTO message id." },
    },
    (args) => workControl.workCreate(args),
  );

  def(
    "work_revise",
    "Revise a work item: objective, spec (monotonic revision; a hash change pauses advancement and supersedes " +
      "in-flight results), delivery target, dependencies, stage, or state (draft/ready/waiting/paused/" +
      "needs_decision/failed — NEVER completed/running/archived/cancelled, which are owned by their operations). " +
      "Takes expectedRevision for optimistic concurrency. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
      patch: { type: "object", description: "The fields to change (objective, spec, deliveryTarget, dependencies, stage, state, waitingReason, priority, priorityReason)." },
      reason: { type: "string", description: "Why the revision (recorded in the summary)." },
    },
    (args) => workControl.workRevise(args),
  );

  def(
    "work_prioritize",
    "Change a work item's scheduling priority ('do this first'). Only the priority fields move — running " +
      "workers are never disturbed to reorder a queue. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      priority: { type: "number", description: "New priority." },
      priorityReason: { type: "string", description: "Why (recorded)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workPrioritize(args),
  );

  def(
    "work_dispatch",
    "Put a worker on a READY work item in its EXPLICIT target project: revalidates the target and dependencies, " +
      "reserves the operation, links the attempt, then starts an ISOLATED delegate job (own worktree + branch; " +
      "a worktree failure never falls back to the repository directory). At the box's delegate cap → " +
      "capacity_wait. The worker finishing does NOT complete the work. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (must be ready)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
      model: { type: "string", description: "Optional model for the worker (validated against the box's routable set)." },
      subagentType: { type: "string", description: "Optional subagent type / intent for the worker." },
    },
    (args) => workControl.workDispatch(args),
  );

  def(
    "work_pause",
    "Pause a work item: stops new stage admission and requests a safe checkpoint from running workers (they " +
      "pause at their next completed-tool-part boundary). Reports exactly what was checkpointed and what could " +
      "NOT be paused — never claims an already-running external effect stopped. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workPause(args),
  );

  def(
    "work_resume",
    "Resume a paused work item: reconciles existing attempts first (resumes paused workers in their worktree, " +
      "adopts terminal outcomes that landed while paused, reports disappeared workers), then re-admits. " +
      "Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workResume(args),
  );

  def(
    "work_cancel",
    "Cancel a work item: persists the cancellation intent, stops running workers through the existing job " +
      "controls (partial work preserved), and reports EXPLICITLY any effects that could not be cancelled. " +
      "No further dispatch. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workCancel(args),
  );

  def(
    "work_retry",
    "Start a NEW attempt for the current stage: reconciles any unknown-outcome dispatch first (adopts the " +
      "operation-correlated worker — never creates a second blindly), supersedes the prior attempt (evidence " +
      "kept) and dispatches again. Bounded by the per-stage attempt limit. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (failed, or reported-complete awaiting next stages)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
      model: { type: "string", description: "Optional model for the new worker." },
      subagentType: { type: "string", description: "Optional subagent type / intent." },
    },
    (args) => workControl.workRetry(args),
  );

  def(
    "work_answer_decision",
    "Answer an open decision on a work item. Accepted responses change the work once; a spec-incompatible " +
      "response fails visibly (revision_conflict) instead of starting a second attempt. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      decisionId: { type: "string", description: "The decision to answer." },
      response: { type: "string", description: "The chosen answer / instruction." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workAnswerDecision(args),
  );

  def(
    "work_archive",
    "Archive a work item: metadata only — attempts, claims, evidence, receipts and resources all remain " +
      "readable; NOTHING is deleted. Refuses while a worker is still live. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workArchive(args),
  );

  def(
    "work_cleanup",
    "Remove the disposable compute resources a work item owns (delegate jobs: window + worktree through the " +
      "existing NON-FORCED removal), preserving the durable work record and evidence. Refuses borrowed " +
      "resources, live workers, open decisions and unresolved receipts; failures stay visible and retryable. " +
      "Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workCleanup(args),
  );
}
