// ctoWorkTools.mjs — unified-CTO spec §7 `work` control-tool family, RECORD +
// DISPATCH half (§5/§6/§8/§9/§12) and the §11 REVIEW / MERGE / RELEASE /
// VERIFICATION work-stage operations. This family turns a request into tracked
// work, puts a worker on it in an EXPLICIT project, and then establishes the
// remaining §11 observations BY EVIDENCE: independent review of an exact head,
// a SHA-bound merge observed on the forge, a contract-driven release with run
// identity, live verification against the actual target, and verified
// completion — the one operation that legitimately owns state "completed".
//
// CENTRAL INVARIANT (§1.1): "Completing a worker is not completing the work.
// The declared delivery target determines completion." It is enforced
// STRUCTURALLY, not by documentation:
//   • work_create only ever creates "draft" or "ready" envelopes.
//   • work_revise REFUSES patch.state "completed" (and "running"/"archived"/
//     "cancelled", whose owners are dispatch/dispatch/cancel/archive).
//   • workReview / workMerge / workRelease / workRollback / workVerify /
//     workComplete — the §11 evidence paths (independent review of an exact
//     head, SHA-bound merge, contract-driven release, live target
//     verification, verified completion).
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
// PROJECT IDENTITY (§1.1, §4.1, §5.1 ProjectRef) — carried EXPLICITLY with the
// work. work_create resolves the caller-supplied project through the ONE
// identity surface (ctoMantaTools.resolveProjectIdentity via the identity
// adapter) and persists a ProjectRef whose workspaceId is the Manta-minted
// durable projectId — a rename rebinds the record, the key never changes.
// repositoryId is opencode's project id ONLY for a remote-backed repo (never
// the fork-prone root-commit id of a remote-less one); repositoryRoot is the
// validated checkout path at USE TIME, never persisted as identity. Every
// later operation REVALIDATES the stored key against live tmux state and
// fails CLOSED (target_not_found / target_ambiguous) — never inferring a
// target from the conversation cwd or the first project.
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
import { createHash, randomUUID } from "node:crypto";
import {
  controlError,
  toControlError,
  createProjectIdentityAdapter,
  defaultObserveOpencodeProjectId,
  createOperationRunner,
  assertPlainObject,
  argsSnapshot,
  MANTA_CONTROL_LEASE_TTL_MS,
} from "./ctoMantaTools.mjs";
import { canonicalArgsHash, canonicalJson, validateExecutionCharter } from "./ctoWork.mjs";
import {
  createCtoWork as createCtoWorkService,
  validateSpec as validateSpecRef,
  validateDeliveryTarget as validateDeliveryTargetRef,
  validateProjectRef as validateProjectRefRef,
  workError,
  WORK_STATES,
  // Validates `handoff.stage`. It sat next to the already-imported
  // WORK_STATES but was never imported itself, so the stage check threw a
  // ReferenceError instead of rejecting a bad stage — turning input
  // validation into a crash on the one path it was meant to guard.
  WORK_STAGES,
  LIST_MAX_LIMIT,
  LIST_DEFAULT_LIMIT,
} from "./ctoWork.mjs";
import { workStore, mantaControlStore } from "./ctoStores.mjs";
import { MAX_RUNNING_JOBS, CAP_ERROR, loadJobs } from "./delegate.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";
import { readConversationSessionId } from "./ctoBinding.mjs";
import { rollupChecks } from "../shared/forge.mjs";

// Lease TTL for in_flight dispatch receipts: the protected window covers
// worktree + window + prompt delivery (seconds, occasionally a slow box), not
// the worker's run — the dispatch receipt records success the moment the
// worker EXISTS. A 2-minute window matches the other §7 families.
export const WORK_LEASE_TTL_MS = MANTA_CONTROL_LEASE_TTL_MS;
const RECEIPT_OWNER = "cto-work-tools";
const CREATE_RECEIPT_OWNER = "cto-work-create";

// §11's seven observations — a CLOSED claim vocabulary. The dispatch half
// records `implementation_reported` (the worker's own "done" — a claim, never
// a verdict); the §11 operations record the five evidence-backed observations
// (independent review of an exact head, merged commit, published artifact,
// target runs the artifact, acceptance checks on that target) and own the one
// verified-completion transition. `tests_reported` stays a worker-report claim
// (the implementation worker's own test statement — labelled, never verified).
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
export const REVIEW_CLAIM = "independent_review_approved";
export const MERGE_CLAIM = "merged_commit_exists";
export const RELEASE_CLAIM = "artifact_published";
export const TARGET_RUNS_CLAIM = "target_runs_artifact";
export const ACCEPTANCE_CLAIM = "acceptance_checks_passed";
for (const kind of [IMPLEMENTATION_CLAIM, REVIEW_CLAIM, MERGE_CLAIM, RELEASE_CLAIM, TARGET_RUNS_CLAIM, ACCEPTANCE_CLAIM]) {
  if (!CLAIM_KINDS.includes(kind)) throw new Error(`claim kind ${kind} is outside the closed §11 vocabulary`);
}

// Attempt statuses (the work-record view of a stage attempt; the delegate job
// store stays authoritative for low-level job state — §5.1). The §11 stage
// attempts add their own terminal shapes: a review attempt ends `approved` or
// `changes_requested`; a verify attempt that held ends `verified`.
export const ATTEMPT_STATUSES = Object.freeze([
  "dispatching",
  "running",
  "reported_complete",
  "approved",
  "changes_requested",
  "verified",
  "failed",
  "stopped",
  "superseded",
  "missing",
]);

// §11 review verdicts — the ONLY machine-readable outcomes a reviewer report
// may carry (parseReviewVerdict). Anything else is a failed review, never a
// guess.
export const REVIEW_VERDICTS = Object.freeze(["approved", "changes_requested"]);
const VERDICT_RE = /^\s*VERDICT:\s*(approved|changes_requested)\s*$/i;

// §11 release contracts — DATA identifying an existing pipeline. Field set is
// closed (typo protection in a file that can start a pipeline); nothing here
// is executable.
export const RELEASE_CONTRACT_FIELDS = Object.freeze([
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

// §8.2: "A configurable-by-existing-policy attempt limit may govern runtime
// work" — injected, bounded default; never the spec-authoring history's
// unbounded review loop.
export const DEFAULT_MAX_STAGE_ATTEMPTS = 3;

// P6 scheduling (spec §9). The interactive reserve is the capacity-count a
// BACKGROUND dispatch must leave free while an INTERACTIVE work item is
// dispatchable — "speculative backfill and nonurgent ambient analysis yield
// before CEO requests". Interactive dispatch itself never yields.
export const DEFAULT_INTERACTIVE_RESERVE = 1;

// P6 checkpoint handoffs (spec §10). Bounded: at most HANDOFF_KEEP records per
// envelope (oldest trimmed, count reported), string fields clipped with a
// visible marker at NOTE_MAX_CHARS (the file's shared bounded-text rule),
// list fields bounded in count.
export const HANDOFF_KEEP = 20;
const HANDOFF_LIST_MAX = 10;
const HANDOFF_LIST_FIELDS = Object.freeze(["pendingDecisions", "constraints"]);
const HANDOFF_TEXT_FIELDS = Object.freeze(["objective", "target", "diffCommit", "testResults", "nextStep"]);

// Bounded note/result text stored on attempts and claims.
const NOTE_MAX_CHARS = 2000;

function inlineWorkSpec(content, revision) {
  assertNonEmptyString(content, "specText");
  if (!Number.isInteger(revision) || revision < 1) throw controlError("unsupported", "specRevision must be a positive integer");
  if (content.length > 64000) throw controlError("unsupported", "specText exceeds 64000 characters");
  const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const spec = { revision, hash, documentRef: `inline:${hash}`, content };
  validateSpecRef(spec);
  return spec;
}

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

// Lazy §4.1 identity defaults (invoked only at execute time, like the other
// lazy production defaults).
function lazyLocalConfigGet() {
  return async () => (await import("./local.mjs")).configGet();
}
function lazyLocalPersist() {
  return async (plan) => (await import("./local.mjs")).projectIdentityPersist(plan);
}

// defaultGitRemoteUrl — the checkout's origin URL (then the first remote
// listed), mirroring opencode's remote preference for repository-identity
// purposes. Null when the checkout has no usable remote (never throws).
function defaultGitRemoteUrl(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 }, (error, stdout) => {
      if (!error && typeof stdout === "string" && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      execFile("git", ["-C", cwd, "remote"], { timeout: 10_000 }, (listError, listOut) => {
        const names = typeof listOut === "string" ? listOut.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        if (listError || names.length === 0) {
          resolve(null);
          return;
        }
        execFile("git", ["-C", cwd, "remote", "get-url", names[0]], { timeout: 10_000 }, (urlError, urlOut) => {
          resolve(!urlError && typeof urlOut === "string" && urlOut.trim() ? urlOut.trim() : null);
        });
      });
    });
  });
}

// §12 cleanup gitStatus default — the same contract as ctoMantaTools'
// defaultGitStatus: porcelain stdout ("" when clean), rejected with the
// stderr message when git fails (the caller maps that to provider_unavailable).
function defaultWorktreeGitStatus(cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "status", "--porcelain"], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        reject(new Error(error.stderr?.trim() || error.message));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

/**
 * ProjectRef.repositoryId derivation (§4.1, §5.1): opencode's `project.id` is
 * the repository identity for REMOTE-BACKED repos only — deterministic and
 * machine-stable. A remote-less repo's id is the fork-prone root-commit hash
 * (it forks on delete+recreate [PROVEN]) and is NEVER persisted: the ref says
 * `unmapped` instead. A remote-backed checkout whose id is unobservable also
 * degrades to `unmapped` rather than persisting a guess. A caller-supplied
 * repositoryId always wins (explicit data beats derivation).
 */
export function deriveRepositoryId({ repositoryId, remoteUrl, observedOpencodeProjectId }) {
  if (typeof repositoryId === "string" && repositoryId.trim().length > 0) return repositoryId.trim();
  const remote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  const remoteBacked = remote.length > 0 && !remote.startsWith("file://");
  if (!remoteBacked) return "unmapped";
  const observed = typeof observedOpencodeProjectId === "string" ? observedOpencodeProjectId.trim() : "";
  return observed.length > 0 ? observed : "unmapped";
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
// §11 pure helpers (exported for tests; every guarantee below has a
// counterfactual positive control in ctoWorkTools.test.mjs).
// ---------------------------------------------------------------------------

/**
 * §11: the reviewer's verdict is machine-readable ONLY through an explicit
 * marker line — `VERDICT: approved` / `VERDICT: changes_requested` (last one
 * wins). Free-text "looks approved" is NOT a verdict: a report that merely
 * mentions "approved" mid-sentence parses as null, and a null verdict records
 * a failed review rather than a guessed approval.
 */
export function parseReviewVerdict(reportText) {
  const text = String(reportText ?? "");
  let verdict = null;
  for (const line of text.split(/\r?\n/)) {
    const m = VERDICT_RE.exec(line);
    if (m) verdict = m[1].toLowerCase();
  }
  return verdict;
}

// Value shapes that read as credential material (§11: "Secrets live in
// existing service clients and are never written into the work record, tool
// arguments, or logs"). Key-NAME evidence first, then well-known token
// prefixes in any value.
const SECRET_KEY_RE = /(token|secret|password|passphrase|apikey|api_key|authorization|credential|privatekey|private_key)/i;
const SECRET_VALUE_RES = [
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^xox[baprs]-/,
  /^AKIA[0-9A-Z]{16}$/,
  /^sk-[A-Za-z0-9]{20,}/,
  /^eyJ[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+/i,
];

function assertNoSecretLikeValues(value, label, path = "") {
  if (value == null) return;
  if (typeof value === "string") {
    const key = path.split(".").pop() ?? "";
    if (SECRET_KEY_RE.test(key)) {
      throw controlError("unsupported", `${label}: "${path}" reads as credential material — tokens never enter work records (§11)`);
    }
    for (const re of SECRET_VALUE_RES) {
      if (re.test(value)) {
        throw controlError("unsupported", `${label}: value at "${path}" reads as credential material — tokens never enter work records (§11)`);
      }
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretLikeValues(v, label, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoSecretLikeValues(v, label, path ? `${path}.${k}` : k);
  }
}

/**
 * §11: the repository identity a merge/checks operation addresses. Two
 * non-empty segments "owner/repo" — no stray whitespace, no host prefix (the
 * composition's forge adapter owns host resolution).
 */
export function parseRepoKey(repoKey) {
  assertNonEmptyString(repoKey, "repositoryId");
  const parts = repoKey.trim().split("/");
  if (parts.length !== 2 || parts.some((p) => p.trim().length === 0)) {
    throw controlError("unsupported", `repositoryId ${JSON.stringify(repoKey)} must be "owner/repo" — the canonical forge identity, not a workspace name`);
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

/**
 * §11: a release contract is DATA identifying an EXISTING pipeline — closed
 * field set, descriptive fields only, nothing executable.
 */
export function validateReleaseContract(contract) {
  assertPlainObject(contract, "release contract");
  const unknown = Object.keys(contract).filter((k) => !RELEASE_CONTRACT_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw controlError("unsupported", `release contract "${contract?.id ?? "?"}" has unknown field(s): ${unknown.join(", ")} — a release contract is data (id, pipeline, allowedTargets, allowedChannels, sourceRevision, artifactIdentity, verification, mutates), not a DSL`);
  }
  for (const field of ["id", "pipeline", "sourceRevision", "artifactIdentity", "verification"]) {
    assertNonEmptyString(contract[field], `release contract.${field}`);
  }
  for (const field of ["allowedTargets", "allowedChannels"]) {
    if (!Array.isArray(contract[field]) || contract[field].length === 0 || contract[field].some((v) => typeof v !== "string" || v.trim().length === 0)) {
      throw controlError("unsupported", `release contract.${field} must be a non-empty array of non-empty strings`);
    }
  }
  if (contract.mutates !== undefined && typeof contract.mutates !== "boolean") {
    throw controlError("unsupported", "release contract.mutates must be a boolean");
  }
  if (contract.workspaceId !== undefined && contract.workspaceId !== null && typeof contract.workspaceId !== "string") {
    throw controlError("unsupported", "release contract.workspaceId must be a string, null, or omitted (null/omitted = applies to every project)");
  }
  return contract;
}

/**
 * Resolve the release contract for a project+target+channel. An exact
 * workspace-scoped contract wins over a global one; a target/channel the
 * contract does not allow does not match. Multiple candidate global
 * contracts for the same target+channel are ambiguous, not a pick-one.
 */
export function resolveReleaseContract(contracts, workspaceId, releaseTarget, channel) {
  const valid = (contracts ?? []).map((c) => validateReleaseContract(c));
  const matches = valid.filter((c) => {
    if (!c.allowedTargets.includes(releaseTarget) || !c.allowedChannels.includes(channel)) return false;
    return c.workspaceId == null || c.workspaceId === workspaceId;
  });
  const scoped = matches.filter((c) => c.workspaceId != null);
  if (scoped.length > 1) {
    throw controlError("target_ambiguous", `release contracts ${scoped.map((c) => c.id).join(", ")} all match project ${workspaceId} — narrow the contract set`);
  }
  if (scoped.length === 1) return scoped[0];
  if (matches.length > 1) {
    throw controlError("target_ambiguous", `global release contracts ${matches.map((c) => c.id).join(", ")} all match ${releaseTarget}/${channel} — narrow the contract set`);
  }
  if (matches.length === 1) return matches[0];
  return null;
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
// P6 pure helpers (§9 scheduling, §10 handoffs, §12 cleanup classification).
// Exported for tests; every guarantee built on them has a counterfactual
// positive control in ctoWorkTools.test.mjs.
// ---------------------------------------------------------------------------

/**
 * §10: the handoff the NEXT attempt reads. Newest record wins; `stale` marks a
 * handoff recorded against a spec hash that is no longer current — it is
 * still injected (never silently dropped) but labelled superseded, so a
 * prompt-space consumer can never mistake old checkpoint context for current
 * constraints.
 */
export function selectHandoffForAttempt(env) {
  const handoffs = Array.isArray(env?.handoffs) ? env.handoffs : [];
  const newest = [...handoffs].sort((a, b) => (b?.recordedAt ?? 0) - (a?.recordedAt ?? 0))[0] ?? null;
  if (!newest) return null;
  return { handoff: newest, stale: newest.specHash !== env.spec.hash };
}

/**
 * §9 scheduling order — the pure comparator behind work_capacity's
 * schedulingOrder: interactive first, then explicit priority (higher first),
 * then fair aging (older created first), then id (total, deterministic order).
 */
export function compareScheduling(a, b) {
  const classA = a?.schedulingClass === "interactive" ? 0 : 1;
  const classB = b?.schedulingClass === "interactive" ? 0 : 1;
  if (classA !== classB) return classA - classB;
  if ((b?.priority ?? 0) !== (a?.priority ?? 0)) return (b?.priority ?? 0) - (a?.priority ?? 0);
  if ((a?.createdAt ?? 0) !== (b?.createdAt ?? 0)) return (a?.createdAt ?? 0) - (b?.createdAt ?? 0);
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * §9 scheduling decision for ONE dispatch request — a discriminated union:
 *   { action: "dispatch" }
 *   { action: "wait", reason: "capacity", detail: { exhausted: true } }
 *   { action: "wait", reason: "capacity", detail: { yieldedTo: "interactive", ... } }
 * Order per §9: availability, then the interactive reserve (a BACKGROUND item
 * yields when the remaining slots are at or below the reserve AND a real
 * interactive work item is dispatchable — no competitor, no yield). The
 * exhausted branch is reported for observability; the caller lets the delegate
 * engine's own cap refusal surface it (the one shared capacity seam).
 */
export function schedulingDecision({ work, availableSlots, interactiveCompetitors = [], interactiveReserve = DEFAULT_INTERACTIVE_RESERVE }) {
  if (!Number.isInteger(availableSlots) || availableSlots < 0) {
    throw controlError("unsupported", `availableSlots must be a non-negative integer (got ${JSON.stringify(availableSlots)})`);
  }
  if (availableSlots <= 0) {
    return { action: "wait", reason: "capacity", detail: { exhausted: true } };
  }
  if (work?.schedulingClass !== "interactive" && availableSlots <= interactiveReserve && interactiveCompetitors.length > 0) {
    return {
      action: "wait",
      reason: "capacity",
      detail: {
        yieldedTo: "interactive",
        interactiveReserve,
        competitors: interactiveCompetitors.map((c) => c?.id ?? String(c)),
      },
    };
  }
  return { action: "dispatch" };
}

/**
 * §12 cleanup classification for ONE owned job resource, computed BEFORE any
 * destructive call: clean | dirty | still_referenced | active. Dirty and
 * still-referenced are PRESERVED (never destroyed without the explicit
 * override); the classification names WHY, visibly.
 */
export function classifyCleanupResource({ resource, job, dirtyStatus, referencedBy = [] }) {
  if (job && (job.status === "running" || job.status === "paused")) {
    return { cls: "active", reason: `job ${job.id} is still ${job.status}` };
  }
  if (referencedBy.length > 0) {
    return { cls: "still_referenced", reason: `worktree ${resource?.path ?? "?"} is still referenced by: ${referencedBy.join(", ")}` };
  }
  if (dirtyStatus) {
    return { cls: "dirty", reason: `worktree ${resource?.path ?? "?"} has uncommitted changes: ${dirtyStatus}` };
  }
  return { cls: "clean", reason: null };
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
  configGet = lazyLocalConfigGet(),
  // §4.1 identity READ dep — the opencode project id opencode currently
  // resolves for a directory (null when unobservable). Feeds the rebind gate
  // and ProjectRef.repositoryId derivation.
  observeOpencodeProjectId = defaultObserveOpencodeProjectId,
  // ---- WRITE deps (mutations only; reads never reference these) ------------
  delegateOps = null, // { startJob, stopJob, pauseJob, resumeJob, deleteJob } — the bound engine
  resolveCwd = resolveCwdOrThrow,
  getConversationId = readConversationSessionId,
  getAcceptedHumanTurn = async () => null,
  // §4.1 identity WRITE dep — applies `{upserts, removes}` to the
  // `~/.manta/config.json` projects[] records in one read-modify-write.
  persistProjectIdentity = lazyLocalPersist(),
  // The git origin URL for ProjectRef.repositoryId classification (null when
  // the checkout has no usable remote — a remote-less repo's opencode id is
  // fork-prone and is never persisted as identity).
  gitRemoteUrl = defaultGitRemoteUrl,
  // §12 cleanup classification dep — git status --porcelain over a worktree
  // path ("" when clean, a non-empty porcelain listing when dirty, a throw
  // when unreadable). Mirrors ctoMantaTools' gitStatus dep contract.
  gitStatus = defaultWorktreeGitStatus,
  // §9 interactive reserve — how many slots a background dispatch must leave
  // free while an interactive work item is dispatchable.
  interactiveReserve = DEFAULT_INTERACTIVE_RESERVE,
  // ---- §11 stage deps (review/merge/release/verify) -------------------------
  // forge: an existing forge adapter seam (src/server/forge/*) exposing
  //   getPullRequest(repo, number), getChecks(repo, sha), merge(repo, number,
  //   {method, sha}) — repo is {owner, repo}. Tokens stay INSIDE the adapter.
  forge = null,
  // releaseContracts: DATA (validated by validateReleaseContract) describing
  //   each project's existing pipeline. Never executable.
  releaseContracts = [],
  // releaseTrigger / rollbackTrigger / targetProbe: the thin external seams a
  // production composition wires to the existing release scripts and target
  // probes. Unwired operations fail `unsupported` — never a silent no-op.
  releaseTrigger = null, // ({ contract, work, deliveryTarget, recoveryRef }) => { runId, artifact: { identity, digest?, version? } }
  rollbackTrigger = null, // ({ contract, work, recoveryRef }) => { ok, note? }
  targetProbe = null, // ({ work, deliveryTarget, contract? }) => { sha?, digest?, version?, checks?: [{ name, passed, note? }] }
} = {}) {
  const work = createCtoWorkService({ store, now, newId });
  const createReceipts = createOperationRunner({
    store: createReceiptsStore,
    now,
    newId,
    owner: CREATE_RECEIPT_OWNER,
  });

  function hasExplicitExecutionIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    if (/\b(plan|spec|research|brainstorm)\s+only\b|\bjust\s+(plan|spec|research|brainstorm)\b|\b(do not|don't|dont)\s+(execute|implement|make changes|change files)\b|\bwithout\s+(executing|implementing|making changes)\b|\bno code changes\b|\bwhat would it take\b|\bshould (i|we)\b|\bdo you think\b|\bwould it be better\b|\b(why did|why does|why is|what is|what was|how did|how does|how was|what if|is it|are we|did we|do we|can we|could we)\b|\b(?:make|write|draft|create|prepare|give|show|outline)\s+(?:me\s+)?(?:a|the)?\s*(?:plan|proposal|approach|outline)\b|\bjust\s+(?:tell|explain|describe|outline|discuss)\b/i.test(text)) return false;
    return /\b(implement|build|fix|create|add|remove|update|change|refactor|migrate|ship|release|merge|deploy|execute|run|complete|deliver|write|make|open|close|delete|archive|spec|specify|research|investigate|audit|analyze|analyse|review|check|verify|test|inspect)\b/i.test(text);
  }

  function hasExplicitControlIntent(text, verb) {
    if (typeof text !== "string" || !text.trim()) return false;
    if (/\b(do not|don't|dont|never)\s+(pause|hold|stop|cancel|abort|resume|continue|unpause)\b|\b(maybe|perhaps|consider|should i|should we|do you think|would it be better)\b/i.test(text)) return false;
    if (verb === "pause") return /\b(pause|hold|stop for now)\b/i.test(text);
    if (verb === "cancel") return /\b(cancel|abort|stop|abandon)\b/i.test(text);
    if (verb === "resume") return /\b(resume|unpause|continue|pick up again)\b/i.test(text);
    return false;
  }

  async function getAcceptedTurnForSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    const boundId = await getConversationId();
    if (boundId !== sessionId) return null;
    const turn = await getAcceptedHumanTurn(sessionId);
    return turn?.sessionId === sessionId && turn.messageID ? turn : null;
  }

  async function getTrustedExecutionTurn(sessionId) {
    const turn = await getAcceptedTurnForSession(sessionId);
    if (!turn || !hasExplicitExecutionIntent(turn.text)) return null;
    return turn;
  }

  async function authorizeGoalCreation(sessionId) {
    return !!(await getTrustedExecutionTurn(sessionId));
  }

  async function authorizeGoalMutation(toolName, args, sessionId) {
    if (typeof sessionId !== "string" || !sessionId || typeof args?.work !== "string") return false;
    let envelope;
    try {
      envelope = await work.getWork(args.work);
    } catch {
      return false;
    }
    if (!envelope) return false;
    const grant = () => {
      if (args.expectedRevision !== undefined && args.expectedRevision !== envelope.revision) return false;
      return {
        allowed: true,
        workRevision: envelope.revision,
        charterRevision: envelope.executionCharter?.revision,
      };
    };
    const currentTurn = await getAcceptedTurnForSession(sessionId);
    if (["work_pause", "work_cancel"].includes(toolName)) {
      const requestedAction = toolName === "work_pause" ? "pause" : "cancel";
      return currentTurn && hasExplicitControlIntent(currentTurn.text, requestedAction) ? grant() : false;
    }
    const charter = envelope?.executionCharter;
    try {
      validateExecutionCharter(charter);
    } catch {
      return false;
    }
    if (charter.status !== "active" || charter.source.sessionId !== sessionId ||
        charter.scope.workspaceId !== envelope.project.workspaceId ||
        charter.scope.repositoryId !== envelope.project.repositoryId ||
        charter.scope.objectiveHash !== createHash("sha256").update(envelope.objective).digest("hex") ||
        charter.scope.specHash !== envelope.spec.hash ||
        charter.scope.deliveryTargetHash !== createHash("sha256").update(canonicalJson(envelope.deliveryTarget)).digest("hex")) return false;
    if (toolName === "work_resume") {
      return currentTurn && envelope.state === "paused" && hasExplicitControlIntent(currentTurn.text, "resume")
        ? grant()
        : false;
    }

    const permissionByTool = {
      work_dispatch: "dispatch",
      work_retry: "retry",
      work_handoff: "handoff",
      work_review: "review",
      work_verify: "verify",
      work_complete: "complete",
    };
    if (toolName === "work_merge" && envelope.deliveryTarget.kind === "merged") permissionByTool.work_merge = "merge";
    if (toolName === "work_release" && ["published", "deployed"].includes(envelope.deliveryTarget.kind)) permissionByTool.work_release = "release";
    if (toolName === "work_revise") {
      const patch = args?.patch;
      const keys = patch && typeof patch === "object" && !Array.isArray(patch) ? Object.keys(patch) : [];
      const allowed = keys.length > 0 && keys.every((key) => ["state", "stage", "waitingReason"].includes(key)) &&
        (patch.state === undefined || ["ready", "waiting"].includes(patch.state)) &&
        (patch.stage === undefined || WORK_STAGES.includes(patch.stage)) &&
        !["completed", "cancelled", "archived"].includes(envelope.state);
      return allowed ? grant() : false;
    }
    const permission = permissionByTool[toolName];
    const allowed = !!permission && charter.permissions.includes(permission) && !["completed", "cancelled", "archived"].includes(envelope.state);
    return allowed ? grant() : false;
  }

  // THE identity adapter (§4.1) — one composition; work_create and the
  // revalidation paths all resolve through it. Writes persist the reconcile
  // plan; reads (work_get's liveness) resolve identically and write nothing.
  const resolveProject = createProjectIdentityAdapter({
    configGet,
    observeOpencodeProjectId,
    persistProjectIdentity,
    newId,
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

  // §11 stage seams — unwired means the operation visibly refuses; nothing
  // here fakes a stage outcome.
  function requireForge() {
    if (!forge) {
      throw controlError("unsupported", "forge is not wired on this composition — pass an adapter exposing getPullRequest/getChecks/merge", { retrySafe: true });
    }
    return forge;
  }
  function requireReleaseTrigger() {
    if (typeof releaseTrigger !== "function") {
      throw controlError("unsupported", "releaseTrigger is not wired on this composition — a release is requested, never faked", { retrySafe: true });
    }
    return releaseTrigger;
  }
  function requireRollbackTrigger() {
    if (typeof rollbackTrigger !== "function") {
      throw controlError("unsupported", "rollbackTrigger is not wired on this composition — rollback is explicit or not offered", { retrySafe: true });
    }
    return rollbackTrigger;
  }
  function requireTargetProbe() {
    if (typeof targetProbe !== "function") {
      throw controlError("unsupported", "targetProbe is not wired on this composition — verification never trusts a green build alone (§11)", { retrySafe: true });
    }
    return targetProbe;
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

  // Every §7/§11 stage operation reserves its receipt identically — the only
  // thing that varies is the operation name. Extracted so the reservation
  // shape (idempotency key, args snapshot, expected revision, lease) cannot
  // drift between stages: a stage that reserved differently would be a
  // silently weaker idempotency guarantee.
  async function reserveStage(opName, input) {
    return reserveOrThrow(input.work, {
      key: input.key,
      op: opName,
      args: argsSnapshot(input),
      expectedRevision: input.expectedRevision ?? input[GOAL_AUTH_REVISION],
      leaseOwner: RECEIPT_OWNER,
      leaseTtlMs,
    });
  }

  // Append an evidence reference once, keyed by id — re-observing the same
  // external effect must not duplicate the record it is evidence for.
  function pushEvidenceOnce(evidence, evidenceId, kind) {
    if (!evidence.some((r) => r?.id === evidenceId)) {
      evidence.push({ kind, id: evidenceId, observedAt: now() });
    }
  }

  // A stage whose external effect is NOT a delegate job (release, verify,
  // complete, rollback) still records an attempt, so a crash mid-effect leaves
  // a visible "dispatching" attempt rather than a silent gap. Shared so every
  // such stage numbers and stamps its attempt identically.
  async function appendStageAttempt(input, attemptId, receipt, stage) {
    await work.mutateWork(input.work, (env) => {
      const attempt = {
        id: attemptId,
        stage,
        attemptNumber: (env.attempts ?? []).filter((a) => a?.stage === stage).length + 1,
        specHash: env.spec.hash,
        receiptId: receipt.id,
        jobId: null,
        status: "dispatching",
        startedAt: now(),
        updatedAt: now(),
      };
      return { save: { ...env, attempts: [...(env.attempts ?? []), attempt], updatedAt: now() }, value: null };
    });
  }

  // A delegate job that STARTED: the receipt succeeds with the job as its
  // external ref, the attempt is linked to the job and marked running, and the
  // job is registered as an owned resource (so cleanup and the borrowed-
  // resource protections can see it). Shared by dispatch and review — the only
  // difference is the result code, and a stage that linked the job differently
  // would leak an unowned worker.
  async function recordJobStarted(input, receipt, attemptId, job, payload, resultCode) {
    await work.recordOperationOutcome(input.work, {
      receiptId: receipt.id,
      status: "succeeded",
      externalRef: job.id,
      resultCode,
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
  }

  // A delegate job's transcript is the evidence record for whatever it
  // produced. Appended once per job (id-keyed) so re-observing a terminal
  // event never duplicates the reference.
  function withJobEvidence(env, job) {
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
    return evidence;
  }

  // A stage whose external effect threw: record the receipt failure and mark
  // the in-flight attempt failed. Extracted because every stage must fail the
  // SAME way — a stage that skipped the attempt update would leave a
  // permanently "dispatching" attempt blocking its own retry.
  async function failStageAttempt(input, receipt, attemptId, label, error) {
    const err = toWorkToolError(error);
    await recordReceiptFailure(input.work, receipt, err).catch(() => {});
    await work
      .mutateWork(input.work, (env) => ({
        save: {
          ...env,
          attempts: (env.attempts ?? []).map((a) =>
            a?.id === attemptId && a.status === "dispatching"
              ? { ...a, status: "failed", updatedAt: now(), note: clipNote(`${label} failed: ${err.message}`) }
              : a,
          ),
          updatedAt: now(),
        },
        value: null,
      }))
      .catch(() => {});
    throw err;
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

  // §1.1/§6 target revalidation — the stored workspaceId (the §4.1 durable
  // projectId; legacy envelopes carry the tmux name) must still resolve
  // against LIVE tmux state, exactly as it did at create time. The identity
  // adapter applies the settled rename-rebind rule (fail closed); a rebind
  // persists so the stored key keeps resolving across renames.
  async function revalidateTarget(env) {
    let projects;
    try {
      projects = await listProjects();
    } catch (error) {
      throw toControlError(error);
    }
    const outcome = await resolveProject(projects, env.project.workspaceId);
    return outcome.project;
  }

  // §5.1 repositoryRoot is the validated checkout path AT USE TIME — the live
  // session's cwd, never the create-time snapshot used as identity.
  async function resolveTargetCheckout(env, target) {
    const liveRoot = target?.defaultCwd || env.project.repositoryRoot;
    try {
      return resolveCwd(liveRoot);
    } catch {
      throw controlError(
        "target_not_found",
        `work "${env.id}" target checkout ${liveRoot} no longer exists — ` +
          `re-point the work or restore the checkout`,
        { retrySafe: false },
      );
    }
  }

  // §9 dependency readiness — bounded, honest about its source: a dependency
  // is met when the dependency work is completed, or when it carries a
  // non-superseded implementation claim matching its CURRENT spec (a
  // REPORTED outcome — labelled as a claim, never silently a verdict; the
  // §11 PR adds verified completion as the stronger signal). Readiness is
  // always computed FRESH against the dependency's live envelope, so a
  // dependency revision (spec hash move) or a superseded claim invalidates
  // satisfaction by construction — stale evidence is never "met".
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

  // The unmet-dependency list of ONE envelope, computed against the live
  // dependency envelopes. Shared by the dispatch gate (assertDependenciesOrPark)
  // and the P6 waiting re-evaluation pass (§9).
  async function unmetDependencies(env) {
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
    return unmet;
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
    assertStageAttemptBudget(env, env.stage);
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

  // §10: the section the prompt renders for a checkpoint handoff. The handoff
  // is the DURABLE record verbatim — constraints are enumerated so the next
  // attempt cannot silently drop them (a prompt-space summary would). A stale
  // handoff (recorded against a moved spec hash) is still injected but labelled
  // SUPERSEDED — never silently dropped, never silently trusted.
  function buildHandoffPromptSection(env) {
    const selected = selectHandoffForAttempt(env);
    if (!selected) return null;
    const { handoff, stale } = selected;
    const lines = [
      ``,
      `## Handoff from a previous attempt (durable checkpoint record${stale ? " — SUPERSEDED" : ""})`,
    ];
    if (stale) {
      lines.push(`RECORDED AGAINST SPEC ${handoff.specHash}; the work is now on spec ${env.spec.hash}. Treat as background context and verify before trusting.`);
    }
    if (handoff.objective) lines.push(`Objective at checkpoint: ${handoff.objective}`);
    if (handoff.target) lines.push(`Target at checkpoint: ${handoff.target}`);
    if (handoff.diffCommit) lines.push(`Diff/commit at checkpoint: ${handoff.diffCommit}`);
    if (handoff.testResults) lines.push(`Test results at checkpoint: ${handoff.testResults}`);
    if (Array.isArray(handoff.pendingDecisions) && handoff.pendingDecisions.length > 0) {
      lines.push(`Pending decisions: ${handoff.pendingDecisions.join("; ")}`);
    }
    if (handoff.nextStep) lines.push(`Next step at checkpoint: ${handoff.nextStep}`);
    if (Array.isArray(handoff.constraints) && handoff.constraints.length > 0) {
      lines.push(`Constraints (MUST be honored):`);
      for (const c of handoff.constraints) lines.push(`- ${c}`);
    }
    return lines;
  }

  function buildWorkPrompt(env) {
    const lines = [
      `You are the implementation worker for tracked work ${env.id} (work revision ${env.revision}).`,
      ``,
      `Objective: ${env.objective}`,
      `Target project: ${env.project.workspaceId} (checkout ${env.project.repositoryRoot}, repository identity ${env.project.repositoryId}).`,
      `Spec: revision ${env.spec.revision}, hash ${env.spec.hash}, document ${env.spec.documentRef} — this is the pinned revision; do not consume a newer "latest spec".`,
      ...(env.spec.content ? [`Pinned specification:\n${env.spec.content}`] : []),
      `Declared delivery target: ${describeDeliveryTarget(env.deliveryTarget)}.`,
      ``,
      `IMPORTANT: completing your implementation does NOT complete the work. Review, merge, release and`,
      `verification are separate stages operated by the CTO. Do not merge. Do not deploy. Do not publish.`,
      `When you finish, report exactly what you changed and how you verified it — that report is a CLAIM,`,
      `not a completion verdict.`,
    ];
    const handoffLines = buildHandoffPromptSection(env);
    if (handoffLines) lines.push(...handoffLines);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // §11 — review / merge / release / verify helpers
  // ---------------------------------------------------------------------------

  function buildReviewPrompt(env, { headSha }) {
    const lines = [
      `You are the INDEPENDENT reviewer for tracked work ${env.id} (work revision ${env.revision}).`,
      ``,
      `Objective under review: ${env.objective}`,
      `Repository identity: ${env.project.repositoryId}. Review commit ${headSha} (exact head — verify you`,
      `are reviewing precisely this SHA).`,
      `Spec: revision ${env.spec.revision}, hash ${env.spec.hash}, document ${env.spec.documentRef}.`,
      ...(env.spec.content ? [`Pinned specification:\n${env.spec.content}`] : []),
      `Your context is independent of the implementation worker's context. Do not trust its report:`,
      `read the diff of ${headSha} and judge it against the spec and its acceptance criteria.`,
      ``,
      `End your report with EXACTLY one final line and nothing after it:`,
      `VERDICT: approved`,
      `or`,
      `VERDICT: changes_requested`,
    ];
    return lines.join("\n");
  }

  // §5.1 attempt budget for ANY stage — the §11 stage operations (review/
  // merge/release/verify) count attempts per-stage against the same bounded
  // maxStageAttempts the dispatch pipeline uses (§8.2).
  function assertStageAttemptBudget(env, stage) {
    const used = (env.attempts ?? []).filter((a) => a?.stage === stage).length;
    const limit = env.executionCharter?.limits?.maxAttemptsPerStage ?? maxStageAttempts;
    if (used >= limit) {
      throw controlError(
        "policy_blocked",
        `attempt limit reached for work "${env.id}" stage "${stage}" (${used}/${limit}) — ` +
          `escalate rather than looping (§8.2: bounded human-facing behavior)`,
        { retrySafe: false, details: { stage, attemptsUsed: used, limit } },
      );
    }
  }

  // Supersede a set of claims INSIDE a mutator (pure over the envelope's
  // claims array — the caller persists the result). Supersession is additive
  // bookkeeping on the claim record: the claim stays readable as evidence, it
  // just stops reading as current (§8.2/U13 shape, now driven by review
  // verdicts too).
  function supersededClaims(claims, predicate, { by, reason }) {
    return (claims ?? []).map((c) =>
      c && predicate(c) && c.superseded !== true
        ? { ...c, superseded: true, supersededBy: by ?? null, supersededReason: clipNote(reason ?? "") }
        : c,
    );
  }

  // The live (non-superseded, current-spec) claim of a given kind — the ONLY
  // way stage operations read a prior observation. Newest wins when several
  // are live.
  function liveClaimOf(env, kind) {
    return (env.claims ?? [])
      .filter((c) => c?.kind === kind && c.superseded !== true && c.specHash === env.spec.hash)
      .sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0] ?? null;
  }

  // An approval claim is INVALIDATED the moment the head it approved is no
  // longer the head under consideration (§11: "When head SHA changes,
  // invalidate the approval … never preserve old approval silently"). The
  // observation points are a new-head review request and the forge's live PR
  // read at merge time — both call this inside their mutator.
  function invalidateApprovalClaimsForHead(env, newHeadSha, { by, reason }) {
    return supersededClaims(
      env.claims,
      (c) => c.kind === REVIEW_CLAIM && c.headSha !== newHeadSha,
      { by, reason },
    );
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

    const evidence = withJobEvidence(env, job);

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

  // ---------------------------------------------------------------------------
  // §11 review outcome adoption — the reviewer's terminal event becomes the
  // review observation. An APPROVAL records `independent_review_approved`
  // pinned to the EXACT head/spec/model the dispatch fixed; a REJECTION
  // records no approval and SUPERSEDES the implementation claim(s) so
  // downstream work admitted on that claim reads its dependency as unmet
  // (the §11 carry-forward). A reviewer that finished without a
  // machine-readable verdict records a failed review — never a guessed one.
  // ---------------------------------------------------------------------------
  async function adoptReviewOutcomeInEnvelope(env, job) {
    const attempts = [...(env.attempts ?? [])];
    const idx = attempts.findIndex((a) => a?.jobId === job.id && a?.stage === "review");
    if (idx === -1) return { save: null, value: { adopted: false, reason: "no review attempt links this job" } };
    const attempt = attempts[idx];
    const headSha = attempt.headSha ?? null;
    if (!headSha) return { save: null, value: { adopted: false, reason: "review attempt carries no head" } };

    if (job.status === "stopped" || job.status === "failed") {
      const status = job.status === "stopped" ? "stopped" : "failed";
      if (attempt.status === status) {
        return { save: null, value: { adopted: false, replay: true, reason: `review attempt already ${status}` } };
      }
      const failedAttempts = attempts.map((a) =>
        a?.id === attempt.id
          ? {
              ...a,
              status,
              updatedAt: now(),
              note: clipNote(`reviewer ${status} — BLOCKED review, no verdict recorded: ${clipNote(job.error ?? "")}`),
            }
          : a,
      );
      let next = { ...env, attempts: failedAttempts, updatedAt: now() };
      if (next.state === "running" || next.state === "paused") {
        next = withState(next, "waiting", { waitingReason: "external" });
      }
      return { save: next, value: { adopted: true, verdict: null, state: next.state } };
    }
    if (job.status !== "done") {
      return { save: null, value: { adopted: false, reason: `job status ${JSON.stringify(job.status)} is not a terminal outcome` } };
    }

    // §8.2/U13: a late completion for an attempt superseded by a spec
    // revision preserves the verdict as SUPERSEDED evidence and never
    // advances the current work.
    const staleSpec = attempt.specHash !== env.spec.hash || attempt.status === "superseded";
    const verdict = parseReviewVerdict(job.result);
    if (!verdict) {
      if (attempt.status === "failed") {
        return { save: null, value: { adopted: false, replay: true, reason: "review attempt already failed" } };
      }
      const failedAttempts = attempts.map((a) =>
        a?.id === attempt.id
          ? {
              ...a,
              status: "failed",
              updatedAt: now(),
              note: clipNote(
                `reviewer finished WITHOUT a machine-readable verdict (expected a final "VERDICT: " line) — ` +
                  `BLOCKED review, no approval recorded${staleSpec ? "; attempt superseded by a later spec revision" : ""}`,
              ),
            }
          : a,
      );
      let next = { ...env, attempts: failedAttempts, updatedAt: now() };
      if (!staleSpec && (next.state === "running" || next.state === "paused")) {
        next = withState(next, "waiting", { waitingReason: "external" });
      }
      return { save: next, value: { adopted: true, verdict: null, state: next.state } };
    }

    const claims = [...(env.claims ?? [])];
    let claim = null;
    if (verdict === "approved") {
      const claimId = `${attempt.id}:${REVIEW_CLAIM}`;
      if (!claims.some((c) => c?.id === claimId)) {
        claim = {
          id: claimId,
          kind: REVIEW_CLAIM,
          attemptId: attempt.id,
          jobId: job.id,
          specHash: attempt.specHash,
          headSha,
          reviewerModel: attempt.reviewerModel ?? null,
          observedAt: now(),
          superseded: staleSpec,
          note: clipNote(job.result ?? ""),
        };
        claims.push(claim);
      }
    } else {
      // §11 carry-forward: a rejected head invalidates the implementation
      // claim the rejection sits on. Downstream work admitted on that claim
      // must no longer read its dependency as met.
      const supersededImplementation = supersededClaims(
        claims,
        (c) => c.kind === IMPLEMENTATION_CLAIM,
        { by: attempt.id, reason: `review of head ${headSha} requested changes (§11) — the implementation claim is superseded` },
      );
      claims.length = 0;
      claims.push(...supersededImplementation);
    }

    const terminalStatus = verdict === "approved" ? "approved" : "changes_requested";
    const reviewAttempts = attempts.map((a) =>
      a?.id === attempt.id
        ? {
            ...a,
            status: a.status === "superseded" ? "superseded" : terminalStatus,
            ...(staleSpec ? { superseded: true } : {}),
            updatedAt: now(),
            note: clipNote(
              verdict === "approved"
                ? `reviewer approved head ${headSha}${staleSpec ? "; attempt superseded by a later spec revision" : ""}`
                : `reviewer requested changes on head ${headSha} — implementation claim superseded; repair via work_retry`,
            ),
          }
        : a,
    );

    const evidence = withJobEvidence(env, job);

    let next = { ...env, attempts: reviewAttempts, claims, evidence, updatedAt: now() };
    if (!staleSpec && (next.state === "running" || next.state === "paused")) {
      // Both verdicts hand the work back to the waiting-for-next-stages state:
      // approved awaits merge/verify; changes_requested awaits the repair
      // dispatch (work_retry). The claim — or its absence — is the record.
      next = withState(next, "waiting", { waitingReason: "external" });
    }
    return { save: next, value: { adopted: true, verdict, claim: claim?.id ?? null, state: next.state } };
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
    // Route by the correlation op stamped at dispatch: review-correlated
    // jobs adopt through the §11 review path, everything else keeps the
    // implementation-claim path.
    const isReviewJob = corr.op === "work.review";
    return work.mutateWork(corr.workId, (e) =>
      isReviewJob ? adoptReviewOutcomeInEnvelope(e, job) : adoptOutcomeInEnvelope(e, job),
    );
  }

  // ---------------------------------------------------------------------------
  // Reads — dependency graph contains NO dispatch / worker creation anywhere.
  // ---------------------------------------------------------------------------

  function workRow(env) {
    const { content, ...spec } = env.spec;
    return {
      id: env.id,
      revision: env.revision,
      objective: env.objective,
      state: env.state,
      ...(env.waitingReason ? { waitingReason: env.waitingReason } : {}),
      stage: env.stage,
      priority: env.priority,
      priorityReason: env.priorityReason,
      schedulingClass: env.schedulingClass ?? "background",
      project: env.project,
      deliveryTarget: env.deliveryTarget,
      spec: { ...spec, ...(typeof content === "string" ? { contentLength: content.length } : {}) },
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
      // Envelopes key on the §4.1 durable projectId; a legacy envelope still
      // carries the tmux name it was created with. Accept BOTH spellings of
      // the same project: resolve the filter through the identity surface so
      // a caller naming the project (or quoting its key) matches either.
      const projects = await listProjects().catch(() => null);
      const aliases = new Set([project]);
      if (projects) {
        try {
          const outcome = await resolveProject(projects, project, { persist: false });
          if (outcome.projectId) aliases.add(outcome.projectId);
          if (outcome.project?.tmuxSession) aliases.add(outcome.project.tmuxSession);
          const record = outcome.record;
          if (record?.tmuxSession) aliases.add(record.tmuxSession);
        } catch {
          // Unknown target: the filter then matches nothing — never a guess.
        }
      }
      rows = rows.filter((r) => aliases.has(r.project.workspaceId));
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
    // The stored workspaceId is the §4.1 durable key, so liveness resolves
    // through the identity surface (read-only: no reconcile, no persist).
    let targetLive = null;
    try {
      const projects = await listProjects();
      const outcome = await resolveProject(projects, env.project.workspaceId, { persist: false });
      const exact = projects.filter((p) => p?.tmuxSession === outcome.project?.tmuxSession);
      targetLive = exact.length === 1 ? true : exact.length === 0 ? false : "ambiguous";
    } catch {
      targetLive = null; // source unavailable — visible as null, never a guess
    }
    return {
      ok: true,
      data: {
        ...workRow(env),
        spec: env.spec,
        attempts,
        claims: env.claims ?? [],
        // §11: each observation becomes durable, attributable evidence — it
        // must be inspectable, not just the claims it supports.
        evidence: env.evidence ?? [],
        // §10: the checkpoint handoffs — the next attempt reads the newest
        // one; "ask why it acted" after archive reads these plus the claims.
        handoffs: env.handoffs ?? [],
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
    // §9 scheduling order — dependency readiness filters the candidates, then
    // compareScheduling orders them: interactive first, explicit priority,
    // then fair aging. This is the observable "which next and why" for
    // contended capacity.
    const candidates = works.filter((w) => w.state === "ready" || w.state === "waiting");
    const schedulingOrder = [...candidates]
      .sort(compareScheduling)
      .map((w) => ({
        workId: w.id,
        state: w.state,
        waitingReason: w.waitingReason ?? null,
        priority: w.priority,
        priorityReason: w.priorityReason ?? "",
        schedulingClass: w.schedulingClass ?? "background",
        createdAt: w.createdAt,
      }));
    return {
      ok: true,
      data: {
        delegate: {
          runningJobs: running,
          maxRunningJobs: MAX_RUNNING_JOBS,
          availableSlots: Math.max(0, MAX_RUNNING_JOBS - running),
        },
        interactiveReserve,
        schedulingOrder,
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

  async function workCreate(input, invocation = {}) {
    const conversationId = await getConversationId();
    const acceptedTurn = invocation?.sessionID === conversationId
      ? await getTrustedExecutionTurn(invocation.sessionID)
      : null;
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
          // Bootstrap a pinned brief without granting the central CTO shell
          // or filesystem writes. The immutable text travels with the work.
          let spec = input.spec;
          if (input.specText !== undefined) {
            if (spec !== undefined) throw controlError("unsupported", "Pass spec OR specText, not both");
            spec = inlineWorkSpec(input.specText, 1);
          }
          validateSpecRef(spec);
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
          if (input.schedulingClass !== undefined) {
            assertNonEmptyString(input.schedulingClass, "schedulingClass");
          }
          for (const d of input.decisions ?? []) validateDecisionRecord(d, "decisions[]");

          // §1.1: the target is EXPLICIT and resolved against live tmux — never
          // inferred from the conversation cwd or the first project. The §4.1
          // adapter reconciles the durable key (mint on first sight, migrate
          // id-less records in place, rebind renames) and persists it.
          let projects;
          try {
            projects = await listProjects();
          } catch (error) {
            throw toControlError(error);
          }
          const outcome = await resolveProject(projects, input.project);
          const resolved = outcome.project;

          const conversationId = await getConversationId();
          if (typeof conversationId !== "string" || !conversationId) {
            throw controlError(
              "unsupported",
              "work_create attributes origin to the bound CTO conversation, but no conversation is bound — " +
                "bind the role session first (spec §3.1)",
              { retrySafe: true },
            );
          }

          // §5.1 ProjectRef — workspaceId is the Manta-minted durable key; a
          // rename rebinds the record, the key never changes. repositoryId is
          // opencode's project id ONLY for a remote-backed repo (never the
          // fork-prone root-commit id of a remote-less one); repositoryRoot is
          // the validated checkout path, never persisted as identity.
          let remoteUrl = null;
          let observedRepositoryId = null;
          if (typeof resolved.defaultCwd === "string" && resolved.defaultCwd.length > 0) {
            try {
              remoteUrl = await gitRemoteUrl(resolved.defaultCwd);
            } catch {
              remoteUrl = null;
            }
            try {
              observedRepositoryId = await observeOpencodeProjectId(resolved.defaultCwd);
            } catch {
              observedRepositoryId = null;
            }
          }
          const projectRef = {
            workspaceId: outcome.projectId,
            repositoryId: deriveRepositoryId({
              repositoryId: input.repositoryId,
              remoteUrl,
              observedOpencodeProjectId: observedRepositoryId,
            }),
            repositoryRoot: resolved.defaultCwd,
          };
          validateProjectRefRef(projectRef);
          const goalKey = acceptedTurn
            ? canonicalArgsHash("work.goal", {
                sourceSessionId: acceptedTurn.sessionId,
                sourceMessageId: acceptedTurn.messageID,
                workspaceId: projectRef.workspaceId,
                objective: input.objective.trim().replace(/\s+/g, " ").toLowerCase(),
                deliveryTarget: input.deliveryTarget,
              })
            : null;

          // A charter's provenance comes from the server's accepted human
          // admission record, never the model-supplied originMessageId. The
          // central role/session and an explicit execution instruction are
          // both required; plan/spec/research-only turns create ordinary work
          // without execution authority.
          const originMessageId = acceptedTurn?.messageID ?? input.originMessageId ?? "unattributed";
          const executionCharter = acceptedTurn ? {
            version: 1,
            revision: 1,
            status: "active",
            goalKey,
            source: { kind: "ceo_instruction", sessionId: conversationId, messageId: acceptedTurn.messageID },
            acceptedAt: acceptedTurn.acceptedAt,
            scope: {
              workspaceId: projectRef.workspaceId,
              repositoryId: projectRef.repositoryId,
              objectiveHash: createHash("sha256").update(input.objective).digest("hex"),
              specHash: spec.hash,
              deliveryTargetHash: createHash("sha256").update(canonicalJson(input.deliveryTarget)).digest("hex"),
            },
            limits: { maxAttemptsPerStage: maxStageAttempts },
            scopeApprovals: [],
            permissions: [
              "dispatch", "retry", "handoff", "review", "verify", "complete",
              ...(input.deliveryTarget.kind === "merged" ? ["merge"] : []),
              ...(["published", "deployed"].includes(input.deliveryTarget.kind) ? ["release"] : []),
            ],
          } : undefined;

          let env = goalKey ? await work.findExecutionGoal(goalKey) : null;
          const created = !env;
          if (!env) {
            try {
              env = await work.createWork({
                id: input.id,
                origin: { conversationId, messageId: originMessageId },
                project: projectRef,
                spec: { ...spec },
                objective: input.objective,
                deliveryTarget: { ...input.deliveryTarget },
                ...(executionCharter ? { executionCharter } : {}),
                dependencies: input.dependencies ?? [],
                priority: input.priority ?? 0,
                priorityReason: input.priorityReason ?? "",
                schedulingClass: input.schedulingClass ?? "background",
                stage: "specify",
                state: input.state ?? "draft",
                decisions: input.decisions ?? [],
              });
            } catch (error) {
              if (goalKey && error?.code === "duplicate_execution_goal") {
                env = await work.findExecutionGoal(goalKey);
              }
              if (!env) throw toWorkToolError(error);
            }
          }
          return {
            workId: env.id,
            resourceId: `work:${env.id}`,
            revision: env.revision,
            state: env.state,
            reused: !created,
            changed: created,
            project: projectRef,
            summary:
              `${created ? "created" : "reused"} work "${env.id}" (state ${env.state}, stage ${env.stage}) targeting project ` +
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

  async function workRevise(input, invocation = {}) {
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
      let patch = input.patch;
      if (patch.specText !== undefined) {
        if (patch.spec !== undefined) throw controlError("unsupported", "Pass patch.spec OR patch.specText, not both");
        const { specText, specRevision, ...rest } = patch;
        patch = { ...rest, spec: inlineWorkSpec(specText, specRevision) };
      }
      let executionCharter;
      const scopeChanged = envBefore.executionCharter && (
        (patch.objective !== undefined && patch.objective !== envBefore.objective) ||
        (patch.project !== undefined && canonicalJson(patch.project) !== canonicalJson(envBefore.project)) ||
        (patch.spec !== undefined && patch.spec.hash !== envBefore.spec.hash) ||
        (patch.deliveryTarget !== undefined && canonicalJson(patch.deliveryTarget) !== canonicalJson(envBefore.deliveryTarget))
      );
      if (scopeChanged) {
        const approval = invocation?.approvedConfirmation;
        if (!approval || approval.tool !== "work_revise" || typeof approval.id !== "string") {
          throw controlError("policy_blocked", "this edit changes the accepted goal scope; approve this exact revision before it can proceed", { retrySafe: false });
        }
        const project = patch.project ?? envBefore.project;
        const objective = patch.objective ?? envBefore.objective;
        const spec = patch.spec ?? envBefore.spec;
        const deliveryTarget = patch.deliveryTarget ?? envBefore.deliveryTarget;
        const nextRevision = envBefore.executionCharter.revision + 1;
        const objectiveHash = createHash("sha256").update(objective).digest("hex");
        const deliveryTargetHash = createHash("sha256").update(canonicalJson(deliveryTarget)).digest("hex");
        const scope = {
          workspaceId: project.workspaceId,
          repositoryId: project.repositoryId,
          objectiveHash,
          specHash: spec.hash,
          deliveryTargetHash,
        };
        const scopeHash = createHash("sha256").update(canonicalJson(scope)).digest("hex");
        executionCharter = {
          ...envBefore.executionCharter,
          revision: nextRevision,
          scope,
          scopeApprovals: [
            ...(envBefore.executionCharter.scopeApprovals ?? []),
            { revision: nextRevision, confirmationId: approval.id, approvedAt: now(), scopeHash },
          ].slice(-20),
        };
      }
      const env = await work.reviseWork(input.work, patch, {
        expectedRevision: input.expectedRevision ?? input[GOAL_AUTH_REVISION],
        ...(executionCharter ? { executionCharter } : {}),
      });
      // §5.2: a spec revision pauses advancement — a running worker was
      // pinned to the OLD spec; the envelope already marked its receipts
      // superseded, and the attempt is now marked so a late completion event
      // cannot advance the new spec (adoptOutcomeInEnvelope's staleSpec path).
      if (patch.spec !== undefined && patch.spec.hash !== envBefore.spec.hash && env.state === "running") {
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
      // §9: a priority change re-evaluates the waiting set. A waiting/
      // dependency item whose dependencies have since become satisfied is
      // PROMOTED to ready (recording the transition); items whose evidence is
      // stale (the dependency's spec moved on) stay waiting. Running workers
      // are never disturbed.
      const reevaluated = await reevaluateWaitingWorks();
      const payload = successPayload({
        env,
        receipt,
        summary: `work "${env.id}" priority → ${env.priority}${env.priorityReason ? ` (${env.priorityReason})` : ""} — running workers were not disturbed` +
          (reevaluated.length
            ? `; waiting re-evaluation promoted: ${reevaluated.map((r) => r.workId).join(", ")}`
            : ""),
        extra: { reevaluated },
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

  // §9 re-evaluation pass over the waiting set (bounded by the list cap):
  // every waiting/dependency work whose dependencies now read satisfied is
  // promoted to ready with a visible transition record. A work whose
  // dependency evidence is stale (unmet after the fresh readiness read) stays
  // waiting — the park is honest, never optimistic.
  async function reevaluateWaitingWorks() {
    const { works } = await work.listWorks({ limit: LIST_MAX_LIMIT });
    const reevaluated = [];
    for (const w of works) {
      if (w.state !== "waiting" || w.waitingReason !== "dependency") continue;
      const unmet = await unmetDependencies(w);
      if (unmet.length > 0) continue;
      const outcome = await work
        .mutateWork(w.id, (env) => {
          // Guarded: only a still-waiting-on-dependency envelope moves. A
          // concurrent dispatch/cancel wins and this pass no-ops.
          if (env.state !== "waiting" || env.waitingReason !== "dependency") {
            return { save: null, value: null };
          }
          return { save: withState(env, "ready"), value: { promoted: true } };
        })
        .catch(() => null);
      if (outcome?.promoted) {
        reevaluated.push({ workId: w.id, from: "waiting/dependency", to: "ready" });
      }
    }
    return reevaluated;
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

      // Target revalidation (§6) + cwd existence chokepoint — the checkout
      // path is validated AT USE TIME from the live session (§5.1), so a
      // moved checkout is followed, never guessed from the stale snapshot.
      const target = await revalidateTarget(envBefore);
      const repositoryRoot = await resolveTargetCheckout(envBefore, target);

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
        // targetProject is the LIVE tmux session name (the delegate engine's
        // window-placement handle, revalidated just above); the durable §4.1
        // key stays in the envelope's ProjectRef.
        parentDirectory: repositoryRoot,
        targetProject: target.tmuxSession,
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
      return await recordJobStarted(input, receipt, attemptId, job, payload, "dispatched");
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
    const reserved = await reserveStage("work.dispatch", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const envBefore = await getWorkOrThrow(input.work);
    assertDispatchAdmissible(envBefore);
    await assertDependenciesOrPark(input.work, envBefore);
    await assertSchedulingOrPark(input.work, envBefore);
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
    const unmet = await unmetDependencies(env);
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

  // §9 interactive reserve — the P6 scheduling gate. A BACKGROUND dispatch
  // yields (explicitly, with a durable wait reason) when the remaining slots
  // are at or below the interactive reserve AND a real interactive work item
  // is dispatchable; interactive dispatch never yields. Runs BEFORE the
  // pipeline: no attempt is burned on a refusal the schedule already knows,
  // and the park lands here (waiting/capacity — dispatchable again the moment
  // a slot frees or the competitor clears).
  async function assertSchedulingOrPark(workId, env) {
    if (env.schedulingClass === "interactive") return; // CEO work never yields
    const jobs = await readJobsOrThrow(`scheduling work "${workId}"`);
    const availableSlots = Math.max(0, MAX_RUNNING_JOBS - jobs.filter((j) => j?.status === "running").length);
    const { works } = await work.listWorks({ limit: LIST_MAX_LIMIT });
    const competitors = works.filter(
      (w) =>
        w.id !== workId &&
        w.schedulingClass === "interactive" &&
        (w.state === "ready" || (w.state === "waiting" && w.waitingReason === "capacity")),
    );
    const decision = schedulingDecision({
      work: env,
      availableSlots,
      interactiveCompetitors: competitors,
      interactiveReserve,
    });
    if (decision.action !== "wait" || decision.detail?.yieldedTo !== "interactive") return;
    const why = `yielded to the interactive reserve (${decision.detail.interactiveReserve}) — ` +
      `interactive work ${competitors.map((c) => c.id).join(", ")} is dispatchable and keeps the next slot(s)`;
    await work
      .mutateWork(workId, (e) =>
        e.state === "running"
          ? { save: null, value: null }
          : { save: { ...e, state: "waiting", waitingReason: "capacity", updatedAt: now() }, value: null },
      )
      .catch(() => {});
    throw controlError(
      "capacity_wait",
      `dispatch of work "${workId}" waits: ${why}`,
      { retrySafe: true, details: decision.detail },
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
    const reserved = await reserveStage("work.retry", input);
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
    await assertSchedulingOrPark(input.work, envAfter);
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
    const reserved = await reserveStage("work.pause", input);
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
    const reserved = await reserveStage("work.resume", input);
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
    const reserved = await reserveStage("work.cancel", input);
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
    const reserved = await reserveStage("work.answer_decision", input);
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
  // work_handoff (§10) — the durable checkpoint record. Written AT CHECKPOINT
  // (pause boundary, attempt replacement, compaction of a work conversation);
  // read at the NEXT attempt's start via the worker prompt — never a
  // prompt-space summary that silently drops constraints. Bounded: field text
  // clipped with a visible marker, list fields capped, oldest records trimmed
  // past HANDOFF_KEEP (count reported).
  // ---------------------------------------------------------------------------

  function validateHandoffInput(input) {
    for (const field of HANDOFF_TEXT_FIELDS) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== "string") {
          throw controlError("unsupported", `handoff.${field} must be a string`);
        }
      }
    }
    for (const field of HANDOFF_LIST_FIELDS) {
      if (input[field] !== undefined) {
        if (!Array.isArray(input[field]) || input[field].some((v) => typeof v !== "string" || v.trim().length === 0)) {
          throw controlError("unsupported", `handoff.${field} must be an array of non-empty strings`);
        }
        if (input[field].length > HANDOFF_LIST_MAX) {
          throw controlError(
            "unsupported",
            `handoff.${field} accepts at most ${HANDOFF_LIST_MAX} entries (got ${input[field].length})`,
          );
        }
      }
    }
    if (input.stage !== undefined && !WORK_STAGES.includes(input.stage)) {
      throw controlError("unsupported", `handoff.stage must be one of ${WORK_STAGES.join(", ")} (got ${JSON.stringify(input.stage)})`);
    }
  }

  function buildHandoffRecord(env, input) {
    const clip = (v) => (v === undefined ? undefined : clipNote(v));
    const liveAttempt = (env.attempts ?? []).find((a) => a?.status === "running" || a?.status === "dispatching") ?? null;
    return {
      id: `hnd_${newId()}`,
      stage: input.stage ?? env.stage,
      specHash: env.spec.hash,
      workRevision: env.revision,
      recordedAt: now(),
      attemptId: liveAttempt?.id ?? null,
      ...(input.objective !== undefined ? { objective: clip(input.objective) } : {}),
      ...(input.target !== undefined ? { target: clip(input.target) } : {}),
      ...(input.diffCommit !== undefined ? { diffCommit: clip(input.diffCommit) } : {}),
      ...(input.testResults !== undefined ? { testResults: clip(input.testResults) } : {}),
      ...(input.nextStep !== undefined ? { nextStep: clip(input.nextStep) } : {}),
      ...(input.pendingDecisions !== undefined ? { pendingDecisions: input.pendingDecisions.map(clip) } : {}),
      ...(input.constraints !== undefined ? { constraints: input.constraints.map(clip) } : {}),
    };
  }

  async function workHandoff(input) {
    assertPlainObject(input, "handoff input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    if (["completed", "cancelled", "archived"].includes(envBefore.state)) {
      throw controlError(
        "policy_blocked",
        `work "${input.work}" is ${envBefore.state} — a checkpoint handoff records context for a NEXT attempt; there is no next attempt here`,
        { retrySafe: false },
      );
    }
    validateHandoffInput(input);
    const reserved = await reserveStage("work.handoff", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      let trimmed = 0;
      const record = buildHandoffRecord(envBefore, input);
      await work.mutateWork(input.work, (env) => {
        // §10: bounded — the newest records survive, the trim count is visible.
        const kept = [...(env.handoffs ?? []), record];
        if (kept.length > HANDOFF_KEEP) {
          trimmed = kept.length - HANDOFF_KEEP;
          kept.splice(0, trimmed);
        }
        return { save: { ...env, handoffs: kept, updatedAt: now() }, value: null };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `recorded checkpoint handoff ${record.id} on work "${input.work}" (stage ${record.stage}, spec ${record.specHash})` +
          (record.attemptId ? ` for attempt ${record.attemptId}` : "") +
          ` — the next attempt reads it at start` +
          (trimmed ? `; ${trimmed} oldest handoff(s) trimmed (bounded at ${HANDOFF_KEEP})` : ""),
        extra: { changed: true, handoff: record, trimmed },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "handed_off", result: payload });
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
    const reserved = await reserveStage("work.archive", input);
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

  // §12 cleanup classification — computed BEFORE any destructive call so a
  // dirty / still-referenced worktree is PRESERVED (never destroyed), the
  // reason is visible, and the retry path is obvious. Only `overrideDirty`
  // lets cleanup proceed past a dirty worktree, and even then the uncommitted
  // file list is preserved as durable evidence FIRST (§12 order: preserve
  // evidence → remove).
  async function classifyJobResourcesForCleanup({ workId, jobResources, jobs }) {
    const { works } = await work.listWorks({ limit: LIST_MAX_LIMIT });
    const classifications = [];
    for (const r of jobResources) {
      const job = jobs.find((j) => j?.id === r.ref);
      // Still-referenced: ANOTHER live work envelope's (non-removed) resource
      // sits at the same worktree path — removing ours would pull theirs.
      const referencedBy = r.path
        ? works
            .filter((w) => w.id !== workId)
            .filter((w) =>
              (w.resources ?? []).some(
                (x) => x?.kind === "delegate_job" && x.cleanupStatus !== "removed" && x.path === r.path,
              ),
            )
            .map((w) => w.id)
        : [];
      let dirtyStatus = null;
      if (referencedBy.length === 0 && r.path) {
        try {
          const status = await gitStatus(r.path);
          // Keep the raw porcelain (leading column characters are meaningful);
          // only the EMPTINESS check trims.
          dirtyStatus = typeof status === "string" && status.trim().length > 0 ? status : null;
        } catch (error) {
          throw controlError(
            "provider_unavailable",
            `cannot check worktree ${r.path} of work "${workId}" for uncommitted changes: ${error?.message ?? error} — ` +
              `cleanup proceeds only once the worktree state is observable`,
            { retrySafe: true },
          );
        }
      }
      classifications.push({
        resource: r,
        ...classifyCleanupResource({ resource: r, job, dirtyStatus, referencedBy }),
        dirtyStatus,
      });
    }
    return classifications;
  }

  async function workCleanup(input) {
    assertPlainObject(input, "cleanup input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    if (input.overrideDirty !== undefined && typeof input.overrideDirty !== "boolean") {
      throw controlError("unsupported", "overrideDirty must be a boolean when present");
    }
    const envBefore = await getWorkOrThrow(input.work);
    const reserved = await reserveStage("work.cleanup", input);
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
      const classifications = await classifyJobResourcesForCleanup({
        workId: input.work,
        jobResources,
        jobs,
      });
      // Dirty / still-referenced are PRESERVED up front — classified before
      // anything destructive, with the reason on both the error and the
      // resource row (visible + retryable, §12/U20). Destroying a dirty
      // worktree requires the explicit overrideDirty flag.
      for (const c of classifications) {
        if (c.cls === "active") {
          throw controlError(
            "active_resource",
            `resource ${c.resource.ref} of work "${input.work}" is still live — ${c.reason} — stop it before cleanup`,
            { retrySafe: false },
          );
        }
        if (c.cls === "still_referenced") {
          await markResource(input.work, c.resource.id, {
            cleanupStatus: "preserved",
            preservedReason: "still_referenced",
            failureReason: clipNote(c.reason),
          });
          throw controlError(
            "active_resource",
            `cleanup of work "${input.work}" preserved ${c.resource.ref} — ${c.reason} — resolve the reference and retry`,
            { retrySafe: true, details: { preserved: [{ ref: c.resource.ref, reason: "still_referenced" }] } },
          );
        }
        if (c.cls === "dirty" && input.overrideDirty !== true) {
          await markResource(input.work, c.resource.id, {
            cleanupStatus: "preserved",
            preservedReason: "dirty",
            failureReason: clipNote(c.reason),
          });
          throw controlError(
            "dirty_resource",
            `cleanup of work "${input.work}" preserved ${c.resource.ref} — ${c.reason} — ` +
              `commit or discard the changes and retry, or pass overrideDirty to destroy them (the file list is preserved as evidence first)`,
            { retrySafe: true, details: { preserved: [{ ref: c.resource.ref, reason: "dirty" }] } },
          );
        }
      }
      // §12 order: validate and record intent → preserve evidence → remove
      // through the existing NON-FORCED operation (force ONLY where the
      // explicit override accepted a dirty worktree) → record success. Failure
      // retains metadata to retry and stays visible.
      const removed = [];
      const failed = [];
      const preserved = [];
      for (const c of classifications) {
        const r = c.resource;
        await work.mutateWork(input.work, (env) => ({
          save: {
            ...env,
            resources: (env.resources ?? []).map((x) =>
              x?.id === r.id ? { ...x, cleanupStatus: "pending", updatedAt: now() } : x,
            ),
          },
          value: null,
        }));
        // Override path: the dirty worktree IS destroyed, but what was there
        // is preserved as durable evidence BEFORE the removal (§12 order).
        let evidenceId = null;
        if (c.cls === "dirty" && input.overrideDirty === true) {
          const files = (c.dirtyStatus ?? "")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(0, HANDOFF_LIST_MAX);
          evidenceId = `dirty-worktree:${r.ref}`;
          await work.mutateWork(input.work, (env) => {
            const evidence = [...(env.evidence ?? [])];
            if (!evidence.some((e) => e?.id === evidenceId)) {
              evidence.push({ kind: "worktree_preserved", id: evidenceId, path: r.path, files, observedAt: now() });
            }
            return { save: { ...env, evidence, updatedAt: now() }, value: null };
          });
          preserved.push({ ref: r.ref, reason: "dirty (destroyed by explicit overrideDirty — uncommitted file list preserved as evidence)", evidenceId });
        }
        try {
          const res = await deleteJob(r.ref, c.cls === "dirty" && input.overrideDirty === true ? { force: true } : undefined);
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
        (preserved.length
          ? `; destroyed-by-override with evidence preserved: ${preserved.map((p) => p.ref).join(", ")}`
          : "") +
        (failed.length
          ? `; RETAINED (visible + retryable): ${failed.map((f) => `${f.ref} (${f.reason})`).join(", ")}`
          : "") +
        `; the work record and its evidence remain`;
      const payload = successPayload({
        env: fresh,
        receipt,
        summary,
        extra: { changed: removed.length > 0, removed, preserved, failed },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "cleaned", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // §11 — REVIEW / MERGE / RELEASE / ROLLBACK / VERIFY / COMPLETE
  //
  // The five observations the dispatch half cannot establish, each by
  // EVIDENCE, never assertion:
  //   • independent_review_approved — an independent reviewer job (own
  //     worktree, requested model verbatim, exact head + spec hash pinned at
  //     dispatch) whose terminal report carries a machine-readable verdict.
  //   • merged_commit_exists — the forge ACCEPTED a merge bound to the
  //     approved head (matching-head precondition), with required checks
  //     queried from the forge FOR THAT HEAD.
  //   • artifact_published — an injected release trigger's OBSERVED run +
  //     artifact identity, gated on the work's release contract (data).
  //   • target_runs_artifact / acceptance_checks_passed — a probe comparing
  //     the ACTUAL target's sha/digest/version to the claims the work already
  //     holds, plus acceptance checks observed on that target.
  // workComplete owns the single verified "completed" transition, and only
  // when the DECLARED delivery target's evidence chain is present.
  // ---------------------------------------------------------------------------

  // Map a forge merge failure to the closed §7 code set. The forge adapters
  // throw typed errors (kind: sha_mismatch | cannot_merge | permission) or
  // raw status numbers.
  function forgeMergeError(error, { repoKey, prNumber }) {
    const kind = error?.kind ?? (error?.status === 405 ? "cannot_merge" : error?.status === 409 ? "sha_mismatch" : error?.status === 403 ? "permission" : null);
    if (kind === "sha_mismatch") {
      return controlError(
        "target_changed",
        `the forge refused the merge of ${repoKey}#${prNumber}: the head moved between the gate read and the merge ` +
          `(matching-head precondition) — re-read the PR and re-review if the head changed (§11)`,
        { retrySafe: true },
      );
    }
    if (kind === "cannot_merge" || kind === "permission") {
      return controlError(
        "policy_blocked",
        `the forge refused the merge of ${repoKey}#${prNumber}: ${error?.message ?? error} (§11)`,
        { retrySafe: false },
      );
    }
    return toControlError(error);
  }

  // The §11 forge gate — shared by work_merge and work_complete for a
  // "pr"-target work. Required checks are queried FROM THE FORGE and must
  // correspond to THAT head; the approval is invalidated the moment the live
  // head differs (never preserved silently). Returns the observed gate facts.
  async function forgeGate({ env, approval, prNumber, purpose }) {
    const forgeOps = requireForge();
    const repoKey = env.project.repositoryId;
    if (!repoKey || repoKey === "unmapped") {
      throw controlError(
        "unsupported",
        `work "${env.id}" carries no canonical repository identity (project.repositoryId) — ` +
          `forge operations address the repo the work names, never a guessed one (§1.1)`,
        { retrySafe: false },
      );
    }
    const repo = parseRepoKey(repoKey);
    let pr;
    try {
      pr = (await forgeOps.getPullRequest(repo, prNumber))?.data ?? null;
    } catch (error) {
      throw toControlError(error);
    }
    if (!pr?.headSha) {
      throw controlError("target_not_found", `PR #${prNumber} not found (or carries no head) on ${repoKey}`, { retrySafe: false });
    }
    if (pr.headSha !== approval.headSha) {
      // §11: when the head SHA changes, invalidate the approval — at the one
      // point the server can OBSERVE the change (the forge's live PR head).
      await work
        .mutateWork(env.id, (e) => ({
          save: {
            ...e,
            claims: invalidateApprovalClaimsForHead(e, pr.headSha, {
              reason: `forge head ${pr.headSha} moved past approved ${approval.headSha}; approval invalidated (§11) — re-review required`,
            }),
            updatedAt: now(),
          },
          value: null,
        }))
        .catch(() => {});
      throw controlError(
        "target_changed",
        `head moved under the approval: approved ${approval.headSha}, PR head is now ${pr.headSha} — ` +
          `the approval was invalidated; re-review the new head before ${purpose} (§11)`,
        { retrySafe: false, details: { approvedHead: approval.headSha, currentHead: pr.headSha } },
      );
    }
    if (pr.state && pr.state !== "open") {
      throw controlError("policy_blocked", `PR #${prNumber} on ${repoKey} is ${JSON.stringify(pr.state)} — ${purpose} runs on an open PR (§6)`, { retrySafe: false });
    }
    let checks = [];
    try {
      const checksRes = await forgeOps.getChecks(repo, approval.headSha);
      checks = Array.isArray(checksRes?.data) ? checksRes.data : [];
    } catch (error) {
      throw toControlError(error);
    }
    const rollup = rollupChecks(checks);
    if (rollup !== "green") {
      throw controlError(
        "policy_blocked",
        `required checks on the approved head ${approval.headSha} are "${rollup}" (queried from the forge FOR that head) — ` +
          `${purpose} requires green (§11)`,
        { retrySafe: true, details: { headSha: approval.headSha, rollup, checks: checks.length } },
      );
    }
    return { repo, repoKey, pr, checks, rollup };
  }

  // §6 review starts: candidate commit (headSha) and acceptance criteria (the
  // pinned spec) are fixed by the caller; the reviewer gets an INDEPENDENT
  // context (isolationRequired) and the REQUESTED model — verbatim.
  async function workReview(input) {
    assertPlainObject(input, "review input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    assertNonEmptyString(input.headSha, "headSha");
    assertNonEmptyString(input.reviewerModel, "reviewerModel");
    const completionParentSessionId = input.completionParentSessionId ?? (await getConversationId());
    if (typeof completionParentSessionId !== "string" || !completionParentSessionId) {
      throw controlError("unsupported", "work_review requires a bound CTO conversation to receive the reviewer's report — bind the role session first (§3.1)", { retrySafe: true });
    }
    const deps = requireDelegateOps("review");
    const reserved = await reserveStage("work.review", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    let attemptId = null;
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      const envBefore = await getWorkOrThrow(input.work);
      const target = await revalidateTarget(envBefore);
      const repositoryRoot = await resolveTargetCheckout(envBefore, target);
      attemptId = `att_${newId()}`;
      // Admission + approval invalidation + attempt LINKED, atomically. A
      // prior approval pinned to a DIFFERENT head is invalidated HERE (the
      // new-head review request is an observation of the head change).
      await work.mutateWork(input.work, (env) => {
        if (!["ready", "waiting"].includes(env.state)) {
          throw controlError(
            "policy_blocked",
            `work "${input.work}" is ${env.state}${env.waitingReason ? ` (${env.waitingReason})` : ""} — review starts from ready or from a reported-complete work awaiting its next stages (§6)`,
            { retrySafe: false },
          );
        }
        assertStageAttemptBudget(env, "review");
        const claims = invalidateApprovalClaimsForHead(env, input.headSha, {
          reason: `a review of head ${input.headSha} was requested; approval of a different head is invalidated (§11)`,
        });
        const attempt = {
          id: attemptId,
          stage: "review",
          attemptNumber: (env.attempts ?? []).filter((a) => a?.stage === "review").length + 1,
          specHash: env.spec.hash,
          headSha: input.headSha,
          reviewerModel: input.reviewerModel,
          receiptId: receipt.id,
          jobId: null,
          status: "dispatching",
          startedAt: now(),
          updatedAt: now(),
        };
        return { save: withState({ ...env, claims, attempts: [...(env.attempts ?? []), attempt] }, "running"), value: null };
      });
      const started = await deps.startJob({
        prompt: buildReviewPrompt(envBefore, { headSha: input.headSha }),
        parentSessionID: completionParentSessionId,
        parentDirectory: repositoryRoot,
        // The LIVE tmux session name (window-placement handle, revalidated
        // above); the durable §4.1 key stays in the envelope's ProjectRef.
        targetProject: target.tmuxSession,
        isolationRequired: true, // review is independent of implementation context (§11)
        correlation: { kind: "work", workId: input.work, receiptId: receipt.id, op: "work.review" },
        actor: "cto",
        model: input.reviewerModel, // the requested reviewer — never substituted (§11/U15)
        ...(input.subagentType !== undefined ? { subagent_type: input.subagentType } : {}),
      });
      if (!started?.ok || !started.job) {
        const rawError = started?.error ?? "startJob returned no job";
        const code = started?.error === CAP_ERROR || rawError === CAP_ERROR ? "capacity_wait" : "provider_unavailable";
        throw controlError(
          code,
          `review of work "${input.work}" is BLOCKED — the reviewer failed to start: ${rawError} ` +
            `(a blocked review is not a passed review, and the requested model ${input.reviewerModel} was not substituted)`,
          { retrySafe: code === "capacity_wait" },
        );
      }
      const job = started.job;
      const payload = {
        workId: envBefore.id,
        revision: envBefore.revision,
        state: "running",
        jobId: job.id,
        workerSessionId: job.childSessionID ?? null,
        jobStatus: job.status,
        headSha: input.headSha,
        reviewerModel: input.reviewerModel,
        changed: true,
        summary:
          `dispatched INDEPENDENT reviewer (model ${input.reviewerModel}) for work "${input.work}" at head ${input.headSha} ` +
          `(spec ${envBefore.spec.hash}); the verdict becomes a review claim only from the reviewer's terminal report`,
      };
      return await recordJobStarted(input, receipt, attemptId, job, payload, "review_dispatched");
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err).catch(() => {});
      // A reviewer that failed to start leaves a BLOCKED review: the attempt
      // is failed with that note, no approval claim exists, and the work is
      // dispatchable again for the stage it came from.
      await work
        .mutateWork(input.work, (env) => {
          const attempts = (env.attempts ?? []).map((a) =>
            a?.id === attemptId && a.status === "dispatching"
              ? { ...a, status: "failed", updatedAt: now(), note: clipNote(`reviewer failed to start — BLOCKED review (§11): ${err.message}`) }
              : a,
          );
          const prior = attempts.length > 0 && (env.state === "running") ? "waiting" : env.state;
          const next = env.state === "running" ? withState({ ...env, attempts }, prior, prior === "waiting" ? { waitingReason: "external" } : {}) : { ...env, attempts, updatedAt: now() };
          return { save: next, value: null };
        })
        .catch(() => {});
      throw err;
    }
  }

  // §6 review approves -> merge: exact head approved (a live review claim),
  // required checks green ON THAT HEAD (queried from the forge), and the
  // merge itself bound to the approved SHA. The observed merge commit is
  // recorded as the merged_commit_exists claim.
  async function workMerge(input) {
    assertPlainObject(input, "merge input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
      throw controlError("unsupported", "prNumber must be a positive integer");
    }
    if (input.method !== undefined && !["merge", "squash", "rebase"].includes(input.method)) {
      throw controlError("unsupported", `method must be merge|squash|rebase (got ${JSON.stringify(input.method)})`);
    }
    const reserved = await reserveStage("work.merge", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    const forgeOps = requireForge();
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      const env = await getWorkOrThrow(input.work);
      const approval = liveClaimOf(env, REVIEW_CLAIM);
      if (!approval?.headSha) {
        throw controlError(
          "evidence_missing",
          `merge of work "${input.work}" refused: no live independent_review_approved claim for the current spec — ` +
            `an exact-head approval is the merge precondition (§11); run work_review first`,
          { retrySafe: true, details: { missing: ["independent_review_approved"] } },
        );
      }
      const gate = await forgeGate({ env, approval, prNumber: input.prNumber, purpose: "merge" });
      let merged;
      try {
        merged = await forgeOps.merge(gate.repo, input.prNumber, { method: input.method ?? "merge", sha: approval.headSha });
      } catch (error) {
        throw forgeMergeError(error, { repoKey: gate.repoKey, prNumber: input.prNumber });
      }
      const mergeCommitSha = typeof merged?.data?.sha === "string" && merged.data.sha ? merged.data.sha : null;
      const claim = {
        id: `merge:${receipt.id}`,
        kind: MERGE_CLAIM,
        specHash: env.spec.hash,
        headSha: approval.headSha,
        mergeCommitSha,
        prNumber: input.prNumber,
        repoKey: gate.repoKey,
        observedAt: now(),
        superseded: false,
        note: `forge accepted the merge of PR #${input.prNumber} bound to approved head ${approval.headSha}` +
          (mergeCommitSha ? ` — merge commit ${mergeCommitSha}` : " (the forge response carried no merge commit SHA)"),
      };
      assertNoSecretLikeValues(claim, "merge claim");
      await work.mutateWork(input.work, (e) => {
        const claims = [...(e.claims ?? []), claim];
        const evidence = [...(e.evidence ?? [])];
        const evidenceId = `forge:merge:${gate.repoKey}#${input.prNumber}@${approval.headSha}`;
        if (!evidence.some((r) => r?.id === evidenceId)) {
          evidence.push({ kind: "forge", id: evidenceId, observedAt: now() });
        }
        return { save: { ...e, claims, evidence, updatedAt: now() }, value: null };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `merged ${gate.repoKey}#${input.prNumber} at the approved head ${approval.headSha}` +
          (mergeCommitSha ? ` — merge commit ${mergeCommitSha} observed` : "") +
          `; required checks were green on THAT head (queried from the forge)`,
        extra: { changed: true, headSha: approval.headSha, mergeCommitSha, prNumber: input.prNumber, checks: gate.checks.length },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "merged", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // §6 merge -> release: gated on the project's release CONTRACT (data
  // naming the existing pipeline — never an executable DSL and never a
  // guessed universal deploy). The trigger's OBSERVED run + artifact
  // identity is the evidence; a mutating contract must carry a recovery
  // reference BEFORE it runs (§11).
  async function workRelease(input) {
    assertPlainObject(input, "release input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    if (input.recoveryRef !== undefined && input.recoveryRef !== null) assertNonEmptyString(input.recoveryRef, "recoveryRef");
    const envBefore = await getWorkOrThrow(input.work);
    const dt = envBefore.deliveryTarget;
    if (dt.kind !== "published" && dt.kind !== "deployed") {
      throw controlError(
        "policy_blocked",
        `work "${input.work}" delivery target ${dt.kind} names no release — work_release applies to published/deployed targets (§6: stages not needed for the declared target are explicitly skipped)`,
        { retrySafe: false },
      );
    }
    const contract = resolveReleaseContract(releaseContracts, envBefore.project.workspaceId, dt.releaseTarget, dt.channel);
    if (!contract) {
      throw controlError(
        "policy_blocked",
        `no release contract matches project "${envBefore.project.workspaceId}" target ${JSON.stringify(dt.releaseTarget)} ` +
          `channel ${JSON.stringify(dt.channel)} — a release contract is DATA naming the existing pipeline; ` +
          `spec/PR/merge work may finish at its declared target, but the requested deployment is blocked rather than guessed (§11)`,
        { retrySafe: false },
      );
    }
    if (contract.mutates === true && !input.recoveryRef) {
      throw controlError(
        "evidence_missing",
        `release contract "${contract.id}" mutates configuration/infrastructure — a recovery reference must be ` +
          `preserved BEFORE the release runs (§11)`,
        { retrySafe: false },
      );
    }
    const trigger = requireReleaseTrigger();
    const reserved = await reserveStage("work.release", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    let attemptId = null;
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      attemptId = `att_${newId()}`;
      await appendStageAttempt(input, attemptId, receipt, "release");
      const observed = await trigger({ contract, work: envBefore, deliveryTarget: dt, recoveryRef: input.recoveryRef ?? null });
      assertNoSecretLikeValues(observed, "release result");
      if (!observed?.runId || !observed?.artifact?.identity) {
        throw controlError(
          "provider_unavailable",
          `release trigger for "${contract.pipeline}" returned no run/artifact identity — refusing to record a release ` +
            `without observed identity (§11)`,
          { retrySafe: true },
        );
      }
      const claim = {
        id: `release:${receipt.id}`,
        kind: RELEASE_CLAIM,
        specHash: envBefore.spec.hash,
        observedAt: now(),
        superseded: false,
        runId: observed.runId,
        artifact: observed.artifact,
        pipeline: contract.pipeline,
        recoveryRef: input.recoveryRef ?? null,
        note: `pipeline ${contract.pipeline} run ${observed.runId} published ${observed.artifact.identity}` +
          (observed.artifact.digest ? ` (digest ${observed.artifact.digest})` : "") +
          (observed.artifact.version ? ` (version ${observed.artifact.version})` : ""),
      };
      await work.mutateWork(input.work, (env) => {
        const claims = [...(env.claims ?? []), claim];
        const evidence = [...(env.evidence ?? [])];
        const evidenceId = `release:${contract.pipeline}:${observed.runId}`;
        pushEvidenceOnce(evidence, evidenceId, "release");
        const attempts = (env.attempts ?? []).map((a) =>
          a?.id === attemptId ? { ...a, status: "reported_complete", updatedAt: now(), note: clipNote(claim.note) } : a,
        );
        return { save: { ...env, claims, evidence, attempts, updatedAt: now() }, value: null };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `released work "${input.work}" through contract "${contract.id}" (pipeline ${contract.pipeline}) — ` +
          `run ${observed.runId} published ${observed.artifact.identity}; the release REQUEST ran, the target is not yet verified`,
        extra: { changed: true, runId: observed.runId, artifact: observed.artifact, pipeline: contract.pipeline, recoveryRef: input.recoveryRef ?? null },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "released", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      await failStageAttempt(input, receipt, attemptId, "release", error);
    }
  }

  // §11: rollback is an EXPLICIT operation with its own result — never
  // assumed possible for every migration. It runs only with a recovery
  // reference (preserved at release time or supplied here) and records only
  // its own outcome; no completion or verification claim is affected.
  async function workRollback(input) {
    assertPlainObject(input, "rollback input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    if (input.recoveryRef !== undefined && input.recoveryRef !== null) assertNonEmptyString(input.recoveryRef, "recoveryRef");
    const trigger = requireRollbackTrigger();
    const envBefore = await getWorkOrThrow(input.work);
    const dt = envBefore.deliveryTarget;
    if (dt.kind !== "published" && dt.kind !== "deployed") {
      throw controlError("policy_blocked", `work "${input.work}" delivery target ${dt.kind} names no release to roll back`, { retrySafe: false });
    }
    const releaseClaim = liveClaimOf(envBefore, RELEASE_CLAIM);
    if (!releaseClaim) {
      throw controlError("policy_blocked", `work "${input.work}" has no published artifact to roll back (no artifact_published claim)`, { retrySafe: false });
    }
    const recoveryRef = input.recoveryRef ?? releaseClaim.recoveryRef ?? null;
    if (!recoveryRef) {
      throw controlError(
        "evidence_missing",
        `rollback of work "${input.work}" refused: no recovery reference was preserved at release time and none was supplied — ` +
          `rollback is not assumed possible for every migration (§11)`,
        { retrySafe: false },
      );
    }
    const contract = resolveReleaseContract(releaseContracts, envBefore.project.workspaceId, dt.releaseTarget, dt.channel);
    if (!contract) {
      throw controlError("policy_blocked", `no release contract matches project "${envBefore.project.workspaceId}" — the rollback trigger cannot be addressed (§11)`, { retrySafe: false });
    }
    const reserved = await reserveStage("work.rollback", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      const observed = await trigger({ contract, work: envBefore, recoveryRef });
      assertNoSecretLikeValues(observed, "rollback result");
      await work.mutateWork(input.work, (env) => {
        const evidence = [...(env.evidence ?? [])];
        const evidenceId = `rollback:${receipt.id}`;
        pushEvidenceOnce(evidence, evidenceId, "release");
        return { save: { ...env, evidence, updatedAt: now() }, value: null };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `rollback of work "${input.work}" executed via recovery reference ${recoveryRef} — its own result is recorded; ` +
          `no completion or verification claim was created or revoked by this operation`,
        extra: { changed: true, rollback: observed ?? { ok: true }, recoveryRef },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "rolled_back", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      const err = toWorkToolError(error);
      await recordReceiptFailure(input.work, receipt, err);
      throw err;
    }
  }

  // §11: production verification NEVER trusts a green build alone. The probe
  // OBSERVES the actual target; the operation compares what it observed
  // against the identity the work's own claims already hold (expected sha /
  // digest / version). Mismatches fail with the target named; matches record
  // target_runs_artifact, and observed acceptance checks record
  // acceptance_checks_passed.
  async function workVerify(input) {
    assertPlainObject(input, "verify input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const probe = requireTargetProbe();
    const envBefore = await getWorkOrThrow(input.work);
    const dt = envBefore.deliveryTarget;
    if (dt.kind !== "deployed" && dt.kind !== "published") {
      throw controlError(
        "policy_blocked",
        `work "${input.work}" delivery target ${dt.kind} names no target instance to verify — work_verify applies to published/deployed targets`,
        { retrySafe: false },
      );
    }
    // Expected identity comes from the work's OWN observations, never from
    // the caller's input — a verifier that accepts expected values as
    // arguments would be an assertion, not a check.
    const mergeClaim = liveClaimOf(envBefore, MERGE_CLAIM);
    const releaseClaim = liveClaimOf(envBefore, RELEASE_CLAIM);
    const approvalClaim = liveClaimOf(envBefore, REVIEW_CLAIM);
    const expectedSha = mergeClaim?.mergeCommitSha ?? mergeClaim?.headSha ?? approvalClaim?.headSha ?? null;
    const expectedDigest = releaseClaim?.artifact?.digest ?? null;
    const expectedVersion = releaseClaim?.artifact?.version ?? null;
    if (!expectedSha && !expectedDigest && !expectedVersion) {
      throw controlError(
        "evidence_missing",
        `verification of work "${input.work}" refused: the work holds no expected artifact identity ` +
          `(no merge/release claims) — verification compares observations, it does not assert them (§11)`,
        { retrySafe: true, details: { missing: ["merged_commit_exists", "artifact_published"] } },
      );
    }
    const reserved = await reserveStage("work.verify", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    let attemptId = null;
    const targetName = dt.instance ?? `${dt.releaseTarget} (${dt.channel})`;
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      attemptId = `att_${newId()}`;
      await appendStageAttempt(input, attemptId, receipt, "verify");
      const observed = await probe({ work: envBefore, deliveryTarget: dt, targetName });
      assertNoSecretLikeValues(observed, "probe result");
      const observedSha = typeof observed?.sha === "string" && observed.sha ? observed.sha : null;
      const observedDigest = typeof observed?.digest === "string" && observed.digest ? observed.digest : null;
      const observedVersion = typeof observed?.version === "string" && observed.version ? observed.version : null;
      const comparable =
        (expectedSha && observedSha) || (expectedDigest && observedDigest) || (expectedVersion && observedVersion);
      if (!comparable) {
        throw controlError(
          "evidence_missing",
          `the probe of ${targetName} observed nothing comparable (sha/digest/version) — verification never trusts ` +
            `a green build alone, and it also never asserts a match it could not compare (§11)`,
          { retrySafe: true },
        );
      }
      const mismatches = [];
      if (expectedSha && observedSha && observedSha !== expectedSha) mismatches.push(`sha expected ${expectedSha}, observed ${observedSha}`);
      if (expectedDigest && observedDigest && observedDigest !== expectedDigest) mismatches.push(`digest expected ${expectedDigest}, observed ${observedDigest}`);
      if (expectedVersion && observedVersion && observedVersion !== expectedVersion) mismatches.push(`version expected ${expectedVersion}, observed ${observedVersion}`);
      if (mismatches.length > 0) {
        throw controlError(
          "target_changed",
          `verification of ${targetName} FAILED — the target does not run the expected artifact: ${mismatches.join("; ")} (§11)`,
          { retrySafe: false, details: { mismatches } },
        );
      }
      const checks = Array.isArray(observed?.checks) ? observed.checks : [];
      const failedChecks = checks.filter((c) => c?.passed !== true);
      const runsClaim = {
        id: `verify:${receipt.id}:runs`,
        kind: TARGET_RUNS_CLAIM,
        specHash: envBefore.spec.hash,
        observedAt: now(),
        superseded: false,
        target: targetName,
        expectedSha,
        observedSha,
        expectedDigest,
        observedDigest,
        expectedVersion,
        observedVersion,
        note: `${targetName} runs the expected artifact` +
          (observedSha ? ` (sha ${observedSha})` : "") +
          (observedDigest ? ` (digest ${observedDigest})` : "") +
          (observedVersion ? ` (version ${observedVersion})` : ""),
      };
      const acceptanceClaim = checks.length > 0 && failedChecks.length === 0
        ? {
            id: `verify:${receipt.id}:acceptance`,
            kind: ACCEPTANCE_CLAIM,
            specHash: envBefore.spec.hash,
            observedAt: now(),
            superseded: false,
            target: targetName,
            checks: checks.map((c) => ({ name: c?.name ?? "unnamed", passed: true })),
            note: `acceptance checks passed on ${targetName}: ${checks.map((c) => c?.name ?? "unnamed").join(", ")}`,
          }
        : null;
      for (const claim of [runsClaim, acceptanceClaim]) {
        if (claim) assertNoSecretLikeValues(claim, `${claim.kind} claim`);
      }
      await work.mutateWork(input.work, (env) => {
        const claims = [...(env.claims ?? []), runsClaim, ...(acceptanceClaim ? [acceptanceClaim] : [])];
        const evidence = [...(env.evidence ?? [])];
        const evidenceId = `verify:${receipt.id}`;
        pushEvidenceOnce(evidence, evidenceId, "release");
        const attempts = (env.attempts ?? []).map((a) =>
          a?.id === attemptId
            ? {
                ...a,
                status: "verified",
                updatedAt: now(),
                note: clipNote(runsClaim.note + (failedChecks.length > 0 ? `; acceptance checks FAILED: ${failedChecks.map((c) => c?.name ?? "unnamed").join(", ")}` : "")),
              }
            : a,
        );
        return { save: { ...env, claims, evidence, attempts, updatedAt: now() }, value: null };
      });
      if (failedChecks.length > 0) {
        throw controlError(
          "policy_blocked",
          `acceptance checks FAILED on ${targetName}: ${failedChecks.map((c) => c?.name ?? "unnamed").join(", ")} — ` +
            `the target runs the expected artifact but the acceptance criteria do not hold (§11)`,
          { retrySafe: false, details: { failed: failedChecks.map((c) => c?.name ?? "unnamed") } },
        );
      }
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `verified ${targetName} against the work's own claims — it runs the expected artifact` +
          (checks.length > 0 ? `; ${checks.length} acceptance check(s) passed` : "; no acceptance checks were reported by the probe"),
        extra: {
          changed: true,
          observed: { sha: observedSha, digest: observedDigest, version: observedVersion },
          acceptanceChecks: checks.length,
        },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "verified", result: payload });
      return { ok: true, replayed: false, ...payload };
    } catch (error) {
      await failStageAttempt(input, receipt, attemptId, "verification", error);
    }
  }

  // §6 -> completed: the ONE verified-completion transition, owned by the
  // declared delivery target's evidence chain — completion evidence, not
  // merely worker prose. Stages not needed for the target are skipped, not
  // recorded as executions.
  function completionRequirements(env) {
    const missing = [];
    const claims = [];
    const need = (kind, label) => {
      const claim = liveClaimOf(env, kind);
      if (!claim) missing.push(label);
      else claims.push({ claimId: claim.id, kind });
      return claim;
    };
    const dt = env.deliveryTarget;
    switch (dt.kind) {
      case "spec":
        need(IMPLEMENTATION_CLAIM, "implementation_reported (the settled-spec report)");
        break;
      case "pr":
        need(REVIEW_CLAIM, "independent_review_approved for the current spec");
        break;
      case "merged":
        need(MERGE_CLAIM, "merged_commit_exists (a forge-observed merge of the approved head)");
        break;
      case "published":
        need(MERGE_CLAIM, "merged_commit_exists (§6: merge precedes release)");
        need(RELEASE_CLAIM, "artifact_published (an observed pipeline run + artifact identity)");
        break;
      case "deployed":
        need(MERGE_CLAIM, "merged_commit_exists (§6: merge precedes release)");
        need(RELEASE_CLAIM, "artifact_published (an observed pipeline run + artifact identity)");
        need(TARGET_RUNS_CLAIM, "target_runs_artifact (live verification of the actual target)");
        need(ACCEPTANCE_CLAIM, "acceptance_checks_passed on that target");
        break;
      default:
        missing.push(`delivery target kind ${JSON.stringify(dt?.kind)}`);
    }
    return { missing, claims };
  }

  async function workComplete(input) {
    assertPlainObject(input, "complete input");
    assertNonEmptyString(input.key, "idempotency key");
    assertNonEmptyString(input.work, "work");
    const envBefore = await getWorkOrThrow(input.work);
    if (envBefore.state === "completed") {
      throw controlError("policy_blocked", `work "${input.work}" is already completed`, { retrySafe: false });
    }
    if (["draft", "running", "paused", "cancelled", "archived", "needs_decision", "failed"].includes(envBefore.state)) {
      throw controlError(
        "policy_blocked",
        `work "${input.work}" is ${envBefore.state}${envBefore.waitingReason ? ` (${envBefore.waitingReason})` : ""} — ` +
          `completion verifies a delivered target from a settled state`,
        { retrySafe: false },
      );
    }
    const dt = envBefore.deliveryTarget;
    if (dt.kind === "pr" && (input.prNumber === undefined || !Number.isInteger(input.prNumber) || input.prNumber < 1)) {
      // A pr-target work completes on an OPEN PR (§6) — the gate needs the PR
      // to run against; the CTO supplies it at completion time.
      throw controlError("unsupported", "work_complete for a pr delivery target requires prNumber (the open PR the gate runs on, §6)", { retrySafe: false });
    }
    const reserved = await reserveStage("work.complete", input);
    if (reserved.replay) return replayResponse(reserved.receipt, input.work);
    const receipt = reserved.receipt;
    try {
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "in_flight" });
      const env = await getWorkOrThrow(input.work);
      // Fresh evidence collection: claims may have been superseded between
      // the reserve and now (e.g. a concurrent review rejection).
      const { missing, claims } = completionRequirements(env);
      if (missing.length > 0) {
        throw controlError(
          "evidence_missing",
          `work "${input.work}" cannot complete: ${missing.join("; ")} — completion is evidence, not worker prose (§11)`,
          { retrySafe: true, details: { missing } },
        );
      }
      let gate = null;
      if (dt.kind === "pr") {
        const approval = liveClaimOf(env, REVIEW_CLAIM);
        gate = await forgeGate({ env, approval, prNumber: input.prNumber, purpose: "completion" });
      }
      // mutateWork returns the mutator's VALUE, not the saved envelope —
      // re-read the completed work for the result payload (a completed-state
      // marker object has no workId and the receipt recorder would refuse it).
      await work.mutateWork(input.work, (e) => {
        if (e.state === "completed") return { save: null, value: null };
        return { save: withState(e, "completed"), value: { state: "completed" } };
      });
      const fresh = await getWorkOrThrow(input.work);
      const payload = successPayload({
        env: fresh,
        receipt,
        summary: `work "${input.work}" COMPLETED — delivery target ${describeDeliveryTarget(dt)} satisfied by evidence: ` +
          claims.map((c) => c.kind).join(", ") +
          (gate ? `; the gate was re-observed live on ${gate.repoKey}#${input.prNumber} at head ${gate.pr.headSha}` : ""),
        extra: { changed: true, evidence: claims, ...(gate ? { gate: { headSha: gate.pr.headSha, rollup: gate.rollup } } : {}) },
      });
      await work.recordOperationOutcome(input.work, { receiptId: receipt.id, status: "succeeded", resultCode: "completed", result: payload });
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
    authorizeGoalCreation,
    authorizeGoalMutation,
    workRevise,
    workPrioritize,
    workDispatch,
    workPause,
    workResume,
    workCancel,
    workRetry,
    workAnswerDecision,
    workHandoff,
    workArchive,
    workCleanup,
    // §11 stage operations
    workReview,
    workMerge,
    workRelease,
    workRollback,
    workVerify,
    workComplete,
    // engine-facing outcome routing (delegate.onJobTerminal)
    recordWorkerOutcome,
  };
}


// ---------------------------------------------------------------------------
// Tool registration — the production composition boundary. Each operation is
// ONE tool with an ACTION-SPECIFIC params schema (no shared unvalidated args
// bag). Reads are mode "auto"; ordinary mutations are "confirm"; routine
// workflow actions are "goal" and are auto-authorized only by a live charter.
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(["work_list", "work_inspect", "work_evidence", "work_capacity"]);
const GOAL_SCOPED_TOOLS = new Set([
  "work_create", "work_revise", "work_dispatch", "work_pause", "work_resume", "work_cancel", "work_retry", "work_handoff",
  "work_review", "work_merge", "work_release", "work_verify", "work_complete",
]);
const GOAL_AUTH_REVISION = Symbol("server-goal-authorized-work-revision");

export function registerCtoWorkTools(register, workControl) {
  const def = (name, description, params, run) =>
    register({
      name,
      description: GOAL_SCOPED_TOOLS.has(name)
        ? `${description} Runs autonomously only when a server-validated execution charter covers this exact work and target; otherwise requires user confirmation.`
        : description,
      params,
      mode: READ_TOOLS.has(name) ? "auto" : GOAL_SCOPED_TOOLS.has(name) ? "goal" : "confirm",
      run: async (_ctx, args) => {
        try {
          if (_ctx?.goalScopedAuthorization === true) {
            const grant = name === "work_create"
              ? await workControl.authorizeGoalCreation?.(_ctx.sessionID)
              : name.startsWith("work_")
                ? await workControl.authorizeGoalMutation?.(name, args ?? {}, _ctx.sessionID)
                : false;
            const stillAuthorized = grant === true || grant?.allowed === true;
            if (!stillAuthorized) {
              return {
                ok: false,
                code: "policy_blocked",
                retrySafe: false,
                error: "execution charter changed or no longer covers this action; reconcile the work and request only the new authority that is missing",
              };
            }
            if (name !== "work_create" && Number.isInteger(grant?.workRevision)) {
              if (_ctx.goalAuthorizationRevision !== grant.workRevision) {
                return {
                  ok: false,
                  code: "revision_conflict",
                  retrySafe: true,
                  error: "the work changed after its execution charter was checked; inspect the latest revision and re-authorize the action",
                };
              }
              args = { ...(args ?? {}) };
              Object.defineProperty(args, GOAL_AUTH_REVISION, { value: grant.workRevision, enumerable: false });
            }
          }
          return await run(args ?? {}, _ctx ?? {});
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
      "live state, never inferred); either spec (revision + hash + document ref) or specText, plus the delivery target, is " +
      "required. Creates as draft (or ready when the spec is settled). schedulingClass marks CEO-requested work " +
      "'interactive' — background dispatches yield to it when capacity is contended (§9). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key (replays the original result)." },
      project: { type: "string", description: "Target project — the exact tmux session name." },
      objective: { type: "string", description: "What this work delivers." },
      spec: {
        type: "object",
        description: "Pinned spec: {revision, hash, documentRef}. Workers never consume a mutable latest spec.",
      },
      specText: { type: "string", description: "Alternative to spec: complete brief (objective, constraints, acceptance criteria), max 64000 characters. Server stores it in the work envelope, computes its SHA-256 and injects it into the worker. No file write needed." },
      deliveryTarget: {
        type: "object",
        description: "Discriminated: {kind:'spec'} | {kind:'pr'} | {kind:'merged', baseBranch} | {kind:'published', releaseTarget, channel} | {kind:'deployed', releaseTarget, channel, instance}. The delivery target determines completion.",
      },
      state: { type: "string", description: "draft (default) or ready (spec settled)." },
      dependencies: { type: "array", description: "Work ids this depends on (acyclic; existence enforced)." },
      priority: { type: "number", description: "Scheduling priority (higher first)." },
      priorityReason: { type: "string", description: "Why this priority." },
      schedulingClass: { type: "string", description: "interactive (CEO-requested, reserves capacity) | background (default — yields to interactive when contended)." },
      repositoryId: { type: "string", description: "Optional canonical repository identity (defaults to 'unmapped')." },
      decisions: { type: "array", description: "Initial decision records (usually empty)." },
      originMessageId: { type: "string", description: "Optional originating CTO message id." },
    },
    (args, invocation) => workControl.workCreate(args, invocation),
  );

  def(
    "work_revise",
    "Revise a work item: objective, spec (monotonic revision; a hash change pauses advancement and supersedes " +
      "in-flight results), delivery target, dependencies, stage, schedulingClass (interactive|background), or " +
      "state (draft/ready/waiting/paused/needs_decision/failed — NEVER completed/running/archived/cancelled, " +
      "which are owned by their operations). Takes expectedRevision for optimistic concurrency. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
      patch: { type: "object", description: "The fields to change (objective, spec, deliveryTarget, dependencies, stage, state, waitingReason, priority, priorityReason, schedulingClass). To revise an inline brief instead of spec, provide specText plus specRevision (a higher integer); the server computes the hash." },
      reason: { type: "string", description: "Why the revision (recorded in the summary)." },
    },
    (args, invocation) => workControl.workRevise(args, invocation),
  );

  def(
    "work_prioritize",
    "Change a work item's scheduling priority ('do this first'). Only the priority fields move — running " +
      "workers are never disturbed to reorder a queue. The change also re-evaluates the waiting set (§9): " +
      "waiting items whose dependencies became satisfied are promoted to ready, and the response reports each " +
      "transition. Idempotent via key.",
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
    "Put a worker on a READY work item in its EXPLICIT target project: revalidates the target, dependencies " +
      "and schedule (a background item yields — capacity_wait with an explicit reason — when the interactive " +
      "reserve is contended), reserves the operation, links the attempt, then starts an ISOLATED delegate job " +
      "(own worktree + branch; a worktree failure never falls back to the repository directory). The worker " +
      "finishing does NOT complete the work. Idempotent via key.",
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
    "work_handoff",
    "Write the DURABLE checkpoint handoff for a work item (§10) — call it AT CHECKPOINT (pause boundary, " +
      "attempt replacement, context compaction). The next attempt reads this record at start (it is injected " +
      "into the worker prompt verbatim, constraints enumerated — never a prompt-space summary). Stale records " +
      "(recorded against an older spec) are still injected but labelled SUPERSEDED. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      objective: { type: "string", description: "Objective AT CHECKPOINT (may have drifted from the envelope)." },
      target: { type: "string", description: "Target / checkout at checkpoint." },
      diffCommit: { type: "string", description: "Current diff or commit at checkpoint." },
      testResults: { type: "string", description: "Test results observed at checkpoint." },
      pendingDecisions: { type: "string[]", description: "Open questions the next attempt must resolve (bounded)." },
      nextStep: { type: "string", description: "The concrete next step at checkpoint." },
      constraints: { type: "string[]", description: "Constraints the next attempt MUST honor (bounded)." },
      stage: { type: "string", description: "Stage the checkpoint belongs to (defaults to the work's current stage)." },
    },
    (args) => workControl.workHandoff(args),
  );

  def(
    "work_archive",
    "Archive a work item: metadata only — attempts, claims, evidence, handoffs, receipts and resources all remain " +
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
      "existing NON-FORCED removal), preserving the durable work record and evidence. Classifies each worktree " +
      "FIRST (§12/U20): clean | dirty | still-referenced | active — dirty or still-referenced or active " +
      "worktrees are PRESERVED with the reason visible, never destroyed; destroying a dirty worktree requires " +
      "the explicit overrideDirty flag (the uncommitted file list is preserved as evidence before removal). " +
      "Refuses borrowed resources, open decisions and unresolved receipts; failures stay visible and retryable. " +
      "Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      overrideDirty: { type: "boolean", description: "Explicit override: destroy dirty worktrees (file list preserved as evidence first). Default false — dirty worktrees are preserved." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workCleanup(args),
  );

  // ---- §11 work-stage operations (review / merge / release / verify) -------

  def(
    "work_review",
    "Dispatch an INDEPENDENT reviewer for an exact head SHA: its own context (isolated worktree), the " +
      "requested reviewer model passed through verbatim (never substituted), the pinned spec hash in the " +
      "prompt. The reviewer's terminal report — only through its machine-readable VERDICT line — becomes an " +
      "independent_review_approved claim pinned to that head, or a rejection that supersedes the " +
      "implementation claim. A reviewer failing to start is a BLOCKED review. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (ready, or reported-complete awaiting its next stages)." },
      headSha: { type: "string", description: "The exact candidate head SHA to review." },
      reviewerModel: { type: "string", description: "The requested reviewer model — used verbatim, never substituted." },
      subagentType: { type: "string", description: "Optional subagent type / intent for the reviewer." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workReview(args),
  );

  def(
    "work_merge",
    "Merge a PR under the §11 gate: requires a live independent_review_approved claim for the current spec; " +
      "reads the PR's LIVE head from the forge (a moved head invalidates the approval and refuses with " +
      "target_changed), queries required checks FROM THE FORGE for THAT head, then merges bound to the " +
      "approved SHA. Records the merged_commit_exists claim with the observed merge commit. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (its project.repositoryId names the repo as owner/repo)." },
      prNumber: { type: "number", description: "The PR number to merge." },
      method: { type: "string", description: "merge (default) | squash | rebase." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workMerge(args),
  );

  def(
    "work_release",
    "Release through the project's release CONTRACT — data naming the existing pipeline, its allowed " +
      "target/channel and artifact identity; never a guessed deploy. Missing contract → visibly blocked. The " +
      "trigger's observed run + artifact identity is recorded as artifact_published. A contract that mutates " +
      "configuration/infrastructure requires recoveryRef BEFORE it runs. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (published/deployed delivery target)." },
      recoveryRef: { type: "string", description: "Recovery reference preserved before a mutating release runs (required when the contract declares mutates)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workRelease(args),
  );

  def(
    "work_rollback",
    "EXPLICIT rollback of a published release, through the preserved recovery reference (the release record's " +
      "or one supplied here) — rollback is never assumed possible for every migration. Records only its own " +
      "result; touches no completion or verification claim. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (must hold an artifact_published claim)." },
      recoveryRef: { type: "string", description: "Recovery reference (falls back to the one preserved on the release record)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workRollback(args),
  );

  def(
    "work_verify",
    "Verify the ACTUAL target (§11: never trust a green build alone): the probe OBSERVES sha/digest/version " +
      "and the operation compares them to the identity the work's own merge/release claims already hold. " +
      "Mismatch → target_changed, no claim. Match → target_runs_artifact; observed acceptance checks that all " +
      "pass record acceptance_checks_passed. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id (published/deployed delivery target)." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workVerify(args),
  );

  def(
    "work_complete",
    "The ONE verified-completion transition. Checks the DECLARED delivery target's evidence chain on the " +
      "work record: spec → settled-spec report; pr → review approval + live forge gate on the open PR; merged " +
      "→ observed merge; published → merge + artifact; deployed → merge + artifact + live verification + " +
      "acceptance checks. Missing evidence refuses — completion is evidence, not worker prose. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      work: { type: "string", description: "The work id." },
      prNumber: { type: "number", description: "For a pr delivery target: the open PR the gate re-observes." },
      expectedRevision: { type: "number", description: "The work revision you read (omit to skip the CAS)." },
    },
    (args) => workControl.workComplete(args),
  );
}
