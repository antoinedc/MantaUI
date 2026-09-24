// ctoWork.mjs — P2a durable work envelopes + operation receipts
// (unified-cto-spec §5.1, §6, §8.1; contract tests U10/U13/U19, contract-only).
//
// One work envelope per work item, one JSON file per envelope under
// `~/.manta/cto/work/<id>.json` (the ATOMIC-WRITE BOUNDARY is the single
// envelope — spec §8.1 — so a revise/reserve/record never tears across files).
// All state lives in the store: the service is stateless, so a fresh service
// instance over the same store replays prior operation receipts (crash
// recovery, U10).
//
// REVISION SEMANTICS. `work.revision` is the WORK-STATE revision: it moves on
// create and on revise (spec/objective/state/priority/dependencies/...), and
// is the counter every caller-supplied `expectedRevision` guards. Receipt
// bookkeeping (reserveOperation / recordOperationOutcome) appends to the
// envelope's operation history WITHOUT bumping it — otherwise a same-key retry
// carrying expectedRevision would conflict with its own prior reservation.
// What an operation DID see is snapshotted per receipt (`workRevision`,
// `stage`, `specHash`), which is how a stale result is detected after a
// scope change (U13).
//
// RECEIPT LIFECYCLE (small explicit state machine — six statuses, one frozen
// transition matrix, no workflow engine):
//   pending   → in_flight | succeeded | failed | unknown
//   in_flight → succeeded | failed | unknown
//   unknown   → succeeded | failed     (reconciliation only, evidence required)
//   succeeded/failed → immutable (same-status replays; anything else conflicts)
// `pending` means the operation was reserved but NEVER externally issued —
// that distinction is load-bearing for lease recovery: an expired-lease
// `pending` is safely resumable, an expired-lease `in_flight` is durably
// `unknown` (the external effect MAY have happened; reconcile, never
// re-execute). There is NO downgrade path back to pending from any status.
//
// HISTORY RETENTION = SIMPLE HARD CAP, NO EVICTION. Every receipt ever
// reserved is durable forever; nothing is compacted or tombstoned (spec
// binding and outcome survive indefinitely). The bound is `HISTORY_CAPACITY`
// receipts per work envelope: once full, a NEW unique key is REFUSED with
// `history_capacity`, while identical retries of existing keys and all reads
// keep working forever.
//
// LOCK ORDER (no deadlock). Two lock layers, always acquired in this order:
//   1. `workGraphLock` — ONE module-level mutex serializing every
//      dependency-graph mutation (create/revise that touch `dependencies`)
//      together with its validate+commit, so concurrent A→B / B→A revisions
//      can never both validate clean against pre-commit state (the cycle
//      race). It is local-storage-only work: no external call ever happens
//      under it.
//   2. the per-envelope file lock (`lockForStore`, keyed by the envelope's
//      real path).
// No code path acquires the graph lock while holding a file lock, and
// operations that do not touch the graph (get/list/reserve/record/plain
// revise) never take the graph lock at all.
//
// CONTRACT-ONLY BOUNDARIES (P2a — deliberately NOT implemented here):
//   - The work target (`project`) is a CALLER-SUPPLIED, structurally validated
//     ref. Per docs/cto-implementation-map.md §4 the `ProjectRef` mapping is
//     UNRESOLVED: this module does NOT settle any opencode `project.id` into
//     `ProjectRef.workspaceId`, does NOT conflate checkout/repository/workspace
//     identities, and does NOT resolve or verify existence (no tmux lookup, no
//     fs.stat, no network). Target existence verification is external (P4
//     dispatch revalidates).
//   - No worker/dispatcher side effects: nothing here creates worktrees,
//     windows, sessions or prompts. `reserveOperation`/`recordOperationOutcome`
//     are the receipt protocol later phases execute through; the receipt's
//     `externalRef` stays caller-supplied. P4 protocol rule: a caller MUST
//     record `in_flight` BEFORE its first external effect — that is what makes
//     an expired-lease `pending` safely resumable while an expired-lease
//     `in_flight` is durably `unknown` (reconcile required, never re-executed).
//   - No §6 transition-precondition enforcement (that is the P4 work
//     coordinator), no attempt subtypes beyond opaque ref objects, no future
//     control methods (dispatch/pause/cancel/answer_decision/…), no sweeper
//     wiring, no HTTP/UI.

import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrateStore, lockForStore, workStore } from "./ctoStores.mjs";
import { createMutex } from "./jsonStore.mjs";

// ---------------------------------------------------------------------------
// Closed vocabularies (spec §5.1) — enum membership is enforced on every write
// and re-validated on every load.
// ---------------------------------------------------------------------------

export const WORK_STATES = Object.freeze([
  "draft",
  "ready",
  "running",
  "waiting",
  "paused",
  "needs_decision",
  "failed",
  "completed",
  "cancelled",
  "archived",
]);
export const WORK_STAGES = Object.freeze(["specify", "implement", "review", "merge", "release", "verify"]);
export const WAITING_REASONS = Object.freeze(["dependency", "capacity", "provider", "external", "reconcile"]);
export const DELIVERY_TARGET_KINDS = Object.freeze(["spec", "pr", "merged", "published", "deployed"]);
export const OPERATION_STATUSES = Object.freeze(["pending", "in_flight", "succeeded", "failed", "unknown"]);
// §9 scheduling classes — a CLOSED vocabulary (P6). "interactive" marks
// CEO-requested / explicit user work that background dispatches yield to;
// "background" is speculative backfill and nonurgent ambient analysis.
export const SCHEDULING_CLASSES = Object.freeze(["interactive", "background"]);
// Unresolved statuses can never be evicted or skipped by retention; terminal
// statuses are immutable once reached.
export const UNRESOLVED_OPERATION_STATUSES = Object.freeze(["pending", "in_flight", "unknown"]);
export const TERMINAL_OPERATION_STATUSES = Object.freeze(["succeeded", "failed"]);

// The one receipt transition matrix (blocker: no implicit in_flight→pending
// downgrade anywhere — reserve recovery included). Same-status records are
// idempotent replays, not transitions. unknown→terminal is reconciliation and
// requires explicit evidence (a non-empty resultCode).
export const RECEIPT_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["in_flight", "succeeded", "failed", "unknown"]),
  in_flight: Object.freeze(["succeeded", "failed", "unknown"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  unknown: Object.freeze(["succeeded", "failed"]),
});

// Hard cap on durable receipts per work envelope (blocker: the old layered
// compaction moved replay breakage instead of bounding anything). Nothing is
// ever evicted — when the cap is full, a NEW unique key is refused
// (`history_capacity`) while identical retries and reads keep working forever.
export const HISTORY_CAPACITY = 256;
// List bound: listWorks never returns unbounded arrays; the caller learns the
// true total so truncation is visible, never silent.
export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 1000;

const LEASE_DEFAULT_TTL_MS = 15 * 60_000;
// Documented upper bound for caller-supplied lease TTLs: bounds crash-recovery
// latency (a stuck in_flight receipt surfaces as unknown at most this long
// after the holder died). Not related to any sweeper interval.
export const MAX_LEASE_TTL_MS = 24 * 3_600_000;
const DEFAULT_LEASE_OWNER = "cto-work";
const MUTABLE_FIELDS = Object.freeze([
  "objective",
  "project",
  "deliveryTarget",
  "spec",
  "dependencies",
  "priority",
  "priorityReason",
  "schedulingClass",
  "stage",
  "state",
  "waitingReason",
  "attempts",
  "decisions",
  "resources",
  "evidence",
]);

// ---------------------------------------------------------------------------
// Errors — stable codes on `.code`. Spec §7 codes are used where §7 names one
// (target_not_found, revision_conflict, external_outcome_unknown); the few
// service-layer codes beyond that list are spelled out and documented:
//   target_exists, idempotency_key_args_mismatch, dependency_cycle,
//   receipt_state_conflict, history_capacity, store_corrupt, store_unavailable.
// ---------------------------------------------------------------------------

export function workError(code, message, { receipt } = {}) {
  const error = new Error(message);
  error.code = code;
  if (receipt) error.receipt = receipt;
  return error;
}

// ---------------------------------------------------------------------------
// Canonical request hashing (receipt idempotency — spec §7/§8.1). The hash
// binds BOTH the operation name and the arguments: the same key with the same
// args under a different `op` is a DIFFERENT request and must not replay.
// Key order never matters.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function canonicalArgsHash(op, args) {
  // Hashes EXACTLY the value passed — no null→{} coalescing here. Callers pass
  // the frozen args snapshot (reserveOperation normalizes `undefined` to `{}`);
  // hashing anything other than the stored snapshot would desync dedupe.
  return createHash("sha256").update(canonicalJson({ op, args })).digest("hex");
}

// Deterministic JSON-safety gate for operation args: only plain objects,
// arrays, strings, finite numbers, booleans and null. Anything whose
// JSON round-trip is lossy or nondeterministic (functions, class instances,
// Dates, bigints, symbols, NaN/±Infinity, undefined values, cycles) is
// rejected BY NAME before any write, so the hash and the stored snapshot can
// never disagree.
function assertJsonSafe(value, path, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw workError("unsupported", `${path} must be a finite number (got ${String(value)})`);
    }
    return;
  }
  if (type === "object") {
    if (seen.has(value)) {
      throw workError("unsupported", `${path} contains a circular reference`);
    }
    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!isArray && proto !== Object.prototype && proto !== null) {
      throw workError("unsupported", `${path} must be a plain object (class instances/Dates are not JSON-safe)`);
    }
    seen.add(value);
    const entries = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    for (const [key, entry] of entries) {
      if (entry === undefined) {
        throw workError("unsupported", `${path}.${key} is undefined — JSON round-trip would drop it`);
      }
      assertJsonSafe(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw workError("unsupported", `${path} must be JSON-serializable (got ${type})`);
}

// ---------------------------------------------------------------------------
// Structural validation — shape only, zero external resolution.
// ---------------------------------------------------------------------------

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw workError("unsupported", `${label} must be a non-empty string`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw workError("unsupported", `${label} must be a plain object`);
  }
}

function objectiveHash(objective) {
  return createHash("sha256").update(objective).digest("hex");
}

// Spec §5.1 ProjectRef — STRUCTURAL validation only. `workspaceId`/`repositoryId`
// are caller-supplied stable identifiers (what they identify is the unresolved
// §4 mapping; nothing here interprets them), `repositoryRoot` must be an
// absolute path string. No fs/tmux/network access, by contract.
export function validateProjectRef(project) {
  assertPlainObject(project, "project");
  assertNonEmptyString(project.workspaceId, "project.workspaceId");
  assertNonEmptyString(project.repositoryId, "project.repositoryId");
  assertNonEmptyString(project.repositoryRoot, "project.repositoryRoot");
  if (!project.repositoryRoot.startsWith("/")) {
    throw workError("unsupported", `project.repositoryRoot "${project.repositoryRoot}" must be an absolute path`);
  }
}

export function validateSpec(spec) {
  assertPlainObject(spec, "spec");
  if (!Number.isInteger(spec.revision) || spec.revision < 1) {
    throw workError("unsupported", `spec.revision must be a positive integer (got ${JSON.stringify(spec.revision)})`);
  }
  assertNonEmptyString(spec.hash, "spec.hash");
  assertNonEmptyString(spec.documentRef, "spec.documentRef");
  if (spec.content !== undefined) {
    assertNonEmptyString(spec.content, "spec.content");
    if (spec.content.length > 64000 || spec.hash !== `sha256:${createHash("sha256").update(spec.content).digest("hex")}`) {
      throw workError("unsupported", "Inline spec content must fit 64000 characters and match spec.hash");
    }
  }
}

// Discriminated delivery target (spec §5.1): the required fields follow the kind.
export function validateDeliveryTarget(target) {
  assertPlainObject(target, "deliveryTarget");
  if (!DELIVERY_TARGET_KINDS.includes(target.kind)) {
    throw workError(
      "unsupported",
      `deliveryTarget.kind must be one of ${DELIVERY_TARGET_KINDS.join(", ")} (got ${JSON.stringify(target.kind)})`,
    );
  }
  if (target.kind === "merged") assertNonEmptyString(target.baseBranch, "deliveryTarget.baseBranch");
  if (target.kind === "published" || target.kind === "deployed") {
    assertNonEmptyString(target.releaseTarget, "deliveryTarget.releaseTarget");
    assertNonEmptyString(target.channel, "deliveryTarget.channel");
  }
  if (target.kind === "deployed") assertNonEmptyString(target.instance, "deliveryTarget.instance");
}

function validateStateFields({ state, stage, waitingReason }) {
  if (state !== undefined && !WORK_STATES.includes(state)) {
    throw workError("unsupported", `state "${state}" is not a valid work state`);
  }
  if (stage !== undefined && !WORK_STAGES.includes(stage)) {
    throw workError("unsupported", `stage "${stage}" is not a valid work stage`);
  }
  if (waitingReason !== undefined && !WAITING_REASONS.includes(waitingReason)) {
    throw workError("unsupported", `waitingReason "${waitingReason}" is not a valid waiting reason`);
  }
}

// §9 scheduling class is a CLOSED vocabulary; when absent the envelope defaults
// to "background" (applied at create — see createWork).
function validateSchedulingClass(value) {
  if (!SCHEDULING_CLASSES.includes(value)) {
    throw workError("unsupported", `schedulingClass must be one of ${SCHEDULING_CLASSES.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function validateRefArray(value, label) {
  if (!Array.isArray(value)) throw workError("unsupported", `${label} must be an array`);
  for (const entry of value) assertPlainObject(entry, `${label}[]`);
}

// A stored receipt carries its FULL safety identity: the dedupe key material
// (key/op/argsHash), the staleness material (specHash/stage/workRevision) and
// the recovery material (status/lease). A receipt missing any of these refuses
// to load — retention and recovery logic never guess.
function assertValidReceipt(receipt, workId) {
  const label = "operations[]";
  assertPlainObject(receipt, `${label} (work "${workId}")`);
  assertNonEmptyString(receipt.id, `${label}.id`);
  assertNonEmptyString(receipt.key, `${label}.key`);
  assertNonEmptyString(receipt.op, `${label}.op`);
  assertNonEmptyString(receipt.argsHash, `${label}.argsHash`);
  if (!OPERATION_STATUSES.includes(receipt.status)) {
    throw workError("unsupported", `${label}.status ${JSON.stringify(receipt.status)} is not a valid operation status`);
  }
  assertNonEmptyString(receipt.specHash, `${label}.specHash`);
  if (!WORK_STAGES.includes(receipt.stage)) {
    throw workError("unsupported", `${label}.stage ${JSON.stringify(receipt.stage)} is not a valid work stage`);
  }
  if (!Number.isInteger(receipt.workRevision) || receipt.workRevision < 1) {
    throw workError("unsupported", `${label}.workRevision must be a positive integer`);
  }
  if (typeof receipt.createdAt !== "number" || typeof receipt.updatedAt !== "number") {
    throw workError("unsupported", `${label} timestamps must be numbers`);
  }
  assertPlainObject(receipt.lease, `${label}.lease`);
  assertNonEmptyString(receipt.lease.owner, `${label}.lease.owner`);
  if (typeof receipt.lease.expiresAt !== "number" || !Number.isFinite(receipt.lease.expiresAt)) {
    throw workError("unsupported", `${label}.lease.expiresAt must be a finite number`);
  }
  // Safety-adjacent optional fields are validated when present.
  if (receipt.resultAt != null && typeof receipt.resultAt !== "number") {
    throw workError("unsupported", `${label}.resultAt must be a number or null`);
  }
  for (const field of ["externalRef", "resultCode"]) {
    if (receipt[field] != null && typeof receipt[field] !== "string") {
      throw workError("unsupported", `${label}.${field} must be a string or null`);
    }
  }
  if (receipt.takeoverCount != null && (!Number.isInteger(receipt.takeoverCount) || receipt.takeoverCount < 0)) {
    throw workError("unsupported", `${label}.takeoverCount must be a non-negative integer`);
  }
  if (receipt.superseded != null && typeof receipt.superseded !== "boolean") {
    throw workError("unsupported", `${label}.superseded must be a boolean`);
  }
  if (receipt.args !== undefined) {
    assertJsonSafe(receipt.args, `${label}.args`, new Set());
  }
  // Persisted operation result (the replay contract: "replaying a terminal
  // receipt returns its ORIGINAL result"). Validated JSON-safe when present —
  // never a bare string; failures carry {code,message,retrySafe,...}.
  if (receipt.result !== undefined && receipt.result !== null) {
    assertPlainObject(receipt.result, `${label}.result`);
    assertJsonSafe(receipt.result, `${label}.result`, new Set());
  }
}

// Load-time shape gate: every read, mutate and retention decision downstream
// sees a structurally valid envelope or nothing at all — corruption is
// visible, never silently reinterpreted.
function assertValidEnvelope(env, id) {
  const fail = (message) => workError("store_corrupt", `work envelope "${id}" is corrupt: ${message}`);
  try {
    assertPlainObject(env, "envelope");
    if (env.id !== id) {
      throw workError("unsupported", `envelope id mismatch — expected "${id}", found ${JSON.stringify(env.id)}`);
    }
    if (!Number.isInteger(env.revision) || env.revision < 1) {
      throw workError("unsupported", `revision must be a positive integer`);
    }
    if (typeof env.createdAt !== "number" || typeof env.updatedAt !== "number") {
      throw workError("unsupported", "createdAt/updatedAt must be numbers");
    }
    assertPlainObject(env.origin, "origin");
    assertNonEmptyString(env.origin.conversationId, "origin.conversationId");
    assertNonEmptyString(env.origin.messageId, "origin.messageId");
    validateProjectRef(env.project);
    validateSpec(env.spec);
    validateDeliveryTarget(env.deliveryTarget);
    assertNonEmptyString(env.objective, "objective");
    if (typeof env.priority !== "number" || !Number.isFinite(env.priority)) {
      throw workError("unsupported", "priority must be a finite number");
    }
    if (typeof env.priorityReason !== "string") {
      throw workError("unsupported", "priorityReason must be a string");
    }
    if (env.schedulingClass !== undefined) {
      validateSchedulingClass(env.schedulingClass);
    }
    if (!WORK_STATES.includes(env.state)) {
      throw workError("unsupported", `state "${env.state}" is not a valid work state`);
    }
    if (!WORK_STAGES.includes(env.stage)) {
      throw workError("unsupported", `stage "${env.stage}" is not a valid work stage`);
    }
    if (env.waitingReason !== undefined && !WAITING_REASONS.includes(env.waitingReason)) {
      throw workError("unsupported", `waitingReason "${env.waitingReason}" is not a valid waiting reason`);
    }
    if (env.state === "waiting" && !env.waitingReason) {
      throw workError("unsupported", "state \"waiting\" requires a waitingReason");
    }
    if (env.state !== "waiting" && env.waitingReason !== undefined) {
      throw workError("unsupported", "waitingReason requires state \"waiting\"");
    }
    if (!Array.isArray(env.dependencies) || env.dependencies.some((d) => typeof d !== "string" || d.length === 0)) {
      throw workError("unsupported", "dependencies must be an array of non-empty strings");
    }
    // §10 checkpoint handoffs — OPTIONAL (envelopes pre-P6 carry none);
    // validated structurally whenever present. The tool layer enforces the
    // typed field grammar; the store enforces "array of records".
    if (env.handoffs !== undefined) {
      if (!Array.isArray(env.handoffs)) {
        throw workError("unsupported", "handoffs must be an array when present");
      }
      for (const entry of env.handoffs) assertPlainObject(entry, "handoffs[]");
    }
    for (const field of ["attempts", "decisions", "resources", "evidence"]) {
      if (!Array.isArray(env[field])) {
        throw workError("unsupported", `${field} must be an array`);
      }
      for (const entry of env[field]) assertPlainObject(entry, `${field}[]`);
    }
    if (env.executionCharter !== undefined) {
      validateExecutionCharter(env.executionCharter);
      if (env.executionCharter.source.sessionId !== env.origin.conversationId ||
          env.executionCharter.source.messageId !== env.origin.messageId ||
          env.executionCharter.scope.workspaceId !== env.project.workspaceId ||
          env.executionCharter.scope.repositoryId !== env.project.repositoryId ||
          env.executionCharter.scope.objectiveHash !== objectiveHash(env.objective) ||
          env.executionCharter.scope.specHash !== env.spec.hash ||
          env.executionCharter.scope.deliveryTargetHash !== createHash("sha256").update(canonicalJson(env.deliveryTarget)).digest("hex")) {
        throw workError("unsupported", "executionCharter scope/source does not match the work envelope");
      }
    }
    // Worker-outcome claims (written by the P4 work family, ctoWorkTools.mjs).
    // OPTIONAL for envelopes created before that family existed; validated
    // whenever present so the strict-shape invariant holds for every write.
    if (env.claims !== undefined) {
      if (!Array.isArray(env.claims)) {
        throw workError("unsupported", "claims must be an array when present");
      }
      for (const entry of env.claims) assertPlainObject(entry, "claims[]");
    }
    if (!Array.isArray(env.operations)) {
      throw workError("unsupported", "operations must be an array");
    }
    if (env.operations.length > HISTORY_CAPACITY) {
      throw workError("unsupported", `operations exceeds the durable history capacity ${HISTORY_CAPACITY}`);
    }
    for (const receipt of env.operations) assertValidReceipt(receipt, id);
  } catch (error) {
    throw fail(error.message);
  }
}

// ---------------------------------------------------------------------------
// Store plumbing — strict envelope load (missing → null, unavailable → visible
// throw, corrupt → visible throw, never the store's default-payload
// fall-through) + per-envelope mutation under the shared per-path lock map
// from ctoStores.
// ---------------------------------------------------------------------------

async function loadEnvelopeStrict(store, id) {
  let raw;
  try {
    raw = await readFile(store.pathFor(id), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw workError(
      "store_unavailable",
      `work envelope "${id}" could not be read (${error.code ?? error.message}) — store unavailable`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw workError("store_corrupt", `work envelope "${id}" is corrupt (invalid JSON) — refusing to load`);
  }
  const migrated = migrateStore(store.name, parsed);
  assertValidEnvelope(migrated, id);
  return migrated;
}

function envelopeAdapter(store, id) {
  return {
    name: store.name,
    path: store.pathFor(id),
    load: () => loadEnvelopeStrict(store, id),
    save: (data) => store.save(id, data),
  };
}

// One read-modify-write section per envelope file. `mutator(envOrNull)` either
// throws (nothing is written — invalid updates never write) or returns
// `{ save, value }`; `save: null` skips the write entirely (pure reads and
// replays never touch the file).
async function mutateEnvelope(store, id, mutator) {
  const adapter = envelopeAdapter(store, id);
  return lockForStore(adapter).runExclusive(async () => {
    const env = await adapter.load();
    const { save, value } = await mutator(env);
    if (save !== null) await adapter.save(save);
    return value;
  });
}

// Create's absence-check + first write run under the SAME per-file lock, so
// two concurrent creates with one supplied id can never both see "missing"
// and have the second overwrite (and erase) the first.
async function commitNewWork(store, id, envelope) {
  const adapter = envelopeAdapter(store, id);
  return lockForStore(adapter).runExclusive(async () => {
    const existing = await adapter.load();
    if (existing) throw workError("target_exists", `work "${id}" already exists`);
    await adapter.save(envelope);
    return envelope;
  });
}

async function loadAllEnvelopes(store) {
  let entries;
  try {
    entries = await readdir(store.dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return []; // no store yet — a legitimately empty portfolio
    throw workError(
      "store_unavailable",
      `work store directory "${store.dir}" is unavailable (${error.code ?? error.message})`,
    );
  }
  const ids = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -".json".length));
  const envs = [];
  for (const id of ids) {
    const env = await loadEnvelopeStrict(store, id); // corrupt/unavailable → visible failure, never skipped
    if (env) envs.push(env);
  }
  return envs;
}

// Pure: true when the dependency edges (workId → dependencies) contain a cycle.
function dependencyGraphHasCycle(edges) {
  const state = new Map();
  const visit = (id) => {
    const mark = state.get(id);
    if (mark === 2) return false;
    if (mark === 1) return true;
    state.set(id, 1);
    for (const dep of edges.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of edges.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

// Reads every envelope and checks the POST-patch graph. Callers that mutate
// the graph hold `workGraphLock` around validate + commit (see below), so the
// snapshot here can never interleave with another graph mutation.
async function assertDependenciesValid(store, deps, { selfId } = {}) {
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string" || d.trim().length === 0)) {
    throw workError("unsupported", "dependencies must be an array of non-empty work IDs");
  }
  if (selfId != null && deps.includes(selfId)) {
    throw workError("unsupported", `work "${selfId}" cannot depend on itself`);
  }
  const all = await loadAllEnvelopes(store);
  const known = new Set(all.map((w) => w.id));
  for (const dep of deps) {
    if (!known.has(dep)) throw workError("target_not_found", `dependency work "${dep}" does not exist`);
  }
  const edges = new Map();
  for (const env of all) {
    edges.set(env.id, env.id === selfId ? deps : (env.dependencies ?? []));
  }
  if (selfId != null && !edges.has(selfId)) edges.set(selfId, deps);
  if (dependencyGraphHasCycle(edges)) {
    throw workError("dependency_cycle", "dependencies must form an acyclic graph");
  }
}

// ---------------------------------------------------------------------------
// Full-envelope validation (create path)
// ---------------------------------------------------------------------------

function validateWorkInput(input) {
  assertPlainObject(input, "work input");
  assertNonEmptyString(input.objective, "objective");
  assertPlainObject(input.origin, "origin");
  assertNonEmptyString(input.origin.conversationId, "origin.conversationId");
  assertNonEmptyString(input.origin.messageId, "origin.messageId");
  validateProjectRef(input.project);
  validateSpec(input.spec);
  validateDeliveryTarget(input.deliveryTarget);
  if (input.executionCharter !== undefined) {
    validateExecutionCharter(input.executionCharter);
    if (input.executionCharter.source.sessionId !== input.origin.conversationId ||
        input.executionCharter.source.messageId !== input.origin.messageId ||
        input.executionCharter.scope.workspaceId !== input.project.workspaceId ||
        input.executionCharter.scope.repositoryId !== input.project.repositoryId ||
        input.executionCharter.scope.objectiveHash !== objectiveHash(input.objective) ||
        input.executionCharter.scope.specHash !== input.spec.hash ||
        input.executionCharter.scope.deliveryTargetHash !== createHash("sha256").update(canonicalJson(input.deliveryTarget)).digest("hex")) {
      throw workError("unsupported", "executionCharter scope/source does not match the work envelope");
    }
  }
  validateStateFields({ state: input.state, stage: input.stage, waitingReason: input.waitingReason });
  if (input.priority !== undefined && (typeof input.priority !== "number" || !Number.isFinite(input.priority))) {
    throw workError("unsupported", "priority must be a finite number");
  }
  if (input.priorityReason !== undefined && typeof input.priorityReason !== "string") {
    throw workError("unsupported", "priorityReason must be a string");
  }
  if (input.schedulingClass !== undefined) {
    validateSchedulingClass(input.schedulingClass);
  }
  for (const field of ["attempts", "decisions", "resources", "evidence"]) {
    if (input[field] !== undefined) validateRefArray(input[field], field);
  }
  if (input.waitingReason !== undefined && input.state !== "waiting") {
    throw workError("unsupported", "waitingReason requires state \"waiting\"");
  }
  if (input.state === "waiting" && input.waitingReason === undefined) {
    throw workError("unsupported", "state \"waiting\" requires a waitingReason");
  }
}

const CHARTER_PERMISSIONS = Object.freeze([
  "dispatch", "retry", "handoff", "review", "verify", "complete", "merge", "release",
]);

export function validateExecutionCharter(charter) {
  assertPlainObject(charter, "executionCharter");
  const assertKeys = (value, keys, label) => {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw workError("unsupported", `unknown ${label} field "${key}"`);
    }
  };
  const allowed = new Set(["version", "revision", "status", "goalKey", "source", "acceptedAt", "scope", "limits", "permissions", "scopeApprovals"]);
  for (const key of Object.keys(charter)) {
    if (!allowed.has(key)) throw workError("unsupported", `unknown executionCharter field "${key}"`);
  }
  if (charter.version !== 1) throw workError("unsupported", "executionCharter.version must be 1");
  if (!Number.isInteger(charter.revision) || charter.revision < 1) throw workError("unsupported", "executionCharter.revision must be a positive integer");
  if (charter.status !== "active") throw workError("unsupported", "executionCharter.status must be active");
  if (typeof charter.acceptedAt !== "number" || !Number.isFinite(charter.acceptedAt)) {
    throw workError("unsupported", "executionCharter.acceptedAt must be a finite timestamp");
  }
  if (typeof charter.goalKey !== "string" || !/^[a-f0-9]{64}$/.test(charter.goalKey)) {
    throw workError("unsupported", "executionCharter.goalKey must be a SHA-256 hex digest");
  }
  assertPlainObject(charter.source, "executionCharter.source");
  assertKeys(charter.source, ["kind", "sessionId", "messageId"], "executionCharter.source");
  if (charter.source.kind !== "ceo_instruction") throw workError("unsupported", "executionCharter.source.kind must be ceo_instruction");
  assertNonEmptyString(charter.source.sessionId, "executionCharter.source.sessionId");
  assertNonEmptyString(charter.source.messageId, "executionCharter.source.messageId");
  assertPlainObject(charter.scope, "executionCharter.scope");
  assertKeys(charter.scope, ["workspaceId", "repositoryId", "objectiveHash", "specHash", "deliveryTargetHash"], "executionCharter.scope");
  assertNonEmptyString(charter.scope.workspaceId, "executionCharter.scope.workspaceId");
  assertNonEmptyString(charter.scope.repositoryId, "executionCharter.scope.repositoryId");
  if (typeof charter.scope.objectiveHash !== "string" || !/^[a-f0-9]{64}$/.test(charter.scope.objectiveHash)) {
    throw workError("unsupported", "executionCharter.scope.objectiveHash must be a SHA-256 hex digest");
  }
  assertNonEmptyString(charter.scope.specHash, "executionCharter.scope.specHash");
  assertNonEmptyString(charter.scope.deliveryTargetHash, "executionCharter.scope.deliveryTargetHash");
  if (!Array.isArray(charter.permissions) || charter.permissions.length === 0 ||
      charter.permissions.some((p) => !CHARTER_PERMISSIONS.includes(p)) ||
      new Set(charter.permissions).size !== charter.permissions.length) {
    throw workError("unsupported", "executionCharter.permissions must be unique supported semantic capabilities");
  }
  assertPlainObject(charter.limits, "executionCharter.limits");
  assertKeys(charter.limits, ["maxAttemptsPerStage"], "executionCharter.limits");
  if (!Number.isInteger(charter.limits.maxAttemptsPerStage) || charter.limits.maxAttemptsPerStage < 1) {
    throw workError("unsupported", "executionCharter.limits.maxAttemptsPerStage must be a positive integer");
  }
  if (charter.scopeApprovals !== undefined) {
    if (!Array.isArray(charter.scopeApprovals) || charter.scopeApprovals.length > 20) {
      throw workError("unsupported", "executionCharter.scopeApprovals must be an array with at most 20 entries");
    }
    for (const approval of charter.scopeApprovals) {
      assertPlainObject(approval, "executionCharter.scopeApprovals[]");
      assertKeys(approval, ["revision", "confirmationId", "approvedAt", "scopeHash"], "executionCharter.scopeApprovals[]");
      if (!Number.isInteger(approval.revision) || approval.revision < 2) throw workError("unsupported", "scope approval revision must be >= 2");
      assertNonEmptyString(approval.confirmationId, "scope approval confirmationId");
      if (typeof approval.approvedAt !== "number" || !Number.isFinite(approval.approvedAt)) throw workError("unsupported", "scope approval approvedAt must be finite");
      if (typeof approval.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(approval.scopeHash)) throw workError("unsupported", "scope approval scopeHash must be a SHA-256 hex digest");
    }
  }
  return charter;
}

function executionScopeHash({ project, objective, spec, deliveryTarget }) {
  return createHash("sha256").update(canonicalJson({
    workspaceId: project.workspaceId,
    repositoryId: project.repositoryId,
    objectiveHash: objectiveHash(objective),
    specHash: spec.hash,
    deliveryTargetHash: createHash("sha256").update(canonicalJson(deliveryTarget)).digest("hex"),
  })).digest("hex");
}

// ONE module-level mutex for dependency-graph mutations (validate + commit as
// a single section). Local-storage-only work happens under it — no external
// call, so holding it is cheap and there is no whole-system mutex for slow
// external services.
const workGraphLock = createMutex();

// ---------------------------------------------------------------------------
// Service factory — stateless over the injected store (default: the real,
// sandboxed workStore). A fresh instance over the same store replays receipts.
// ---------------------------------------------------------------------------

export function createCtoWork({ store = workStore, now = () => Date.now(), newId = () => randomUUID() } = {}) {
  async function createWork(input) {
    validateWorkInput(input);
    const id = input.id === undefined || input.id === null ? `w_${newId()}` : input.id;
    const ts = now();
    const envelope = {
      id,
      revision: 1,
      origin: { conversationId: input.origin.conversationId, messageId: input.origin.messageId },
      project: { ...input.project },
      spec: { ...input.spec },
      objective: input.objective,
      deliveryTarget: { ...input.deliveryTarget },
      ...(input.executionCharter !== undefined ? { executionCharter: structuredClone(input.executionCharter) } : {}),
      dependencies: [...(input.dependencies ?? [])],
      priority: input.priority ?? 0,
      priorityReason: input.priorityReason ?? "",
      schedulingClass: input.schedulingClass ?? "background",
      stage: input.stage ?? "specify",
      state: input.state ?? "draft",
      ...(input.waitingReason !== undefined ? { waitingReason: input.waitingReason } : {}),
      attempts: [...(input.attempts ?? [])],
      operations: [],
      handoffs: [],
      decisions: [...(input.decisions ?? [])],
      resources: [...(input.resources ?? [])],
      evidence: [...(input.evidence ?? [])],
      createdAt: ts,
      updatedAt: ts,
    };
    if (envelope.dependencies.length > 0 || envelope.executionCharter) {
      // Graph mutation: validate + commit under the shared graph lock, then
      // the per-file lock inside commitNewWork (lock order: graph → file).
      // The same lock makes source-goal uniqueness atomic across concurrent
      // work_create calls with different model-generated operation keys.
      return workGraphLock.runExclusive(async () => {
        if (envelope.executionCharter) {
          const duplicate = await findExecutionGoal(envelope.executionCharter.goalKey);
          if (duplicate) throw workError("duplicate_execution_goal", `execution goal already exists as work "${duplicate.id}"`, { workId: duplicate.id });
        }
        if (envelope.dependencies.length > 0) {
          await assertDependenciesValid(store, envelope.dependencies, { selfId: id });
        }
        return commitNewWork(store, id, envelope);
      });
    }
    return commitNewWork(store, id, envelope);
  }

  async function getWork(id) {
    return loadEnvelopeStrict(store, id);
  }

  async function findExecutionGoal(goalKey) {
    if (typeof goalKey !== "string" || !/^[a-f0-9]{64}$/.test(goalKey)) return null;
    const envs = await loadAllEnvelopes(store);
    return envs.find((env) => env.executionCharter?.goalKey === goalKey) ?? null;
  }

  async function listWorks({ limit = LIST_DEFAULT_LIMIT } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw workError("unsupported", `limit must be a positive integer (got ${JSON.stringify(limit)})`);
    }
    const bounded = Math.min(limit, LIST_MAX_LIMIT);
    const envs = await loadAllEnvelopes(store);
    envs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
    return { works: envs.slice(0, bounded), total: envs.length, limit: bounded };
  }

  async function reviseWork(id, patch, { expectedRevision, executionCharter } = {}) {
    assertPlainObject(patch, "revise patch");
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_FIELDS.includes(key)) {
        throw workError("unsupported", `unknown revise field "${key}"`);
      }
    }
    if (Object.keys(patch).length === 0) {
      const current = await getWork(id);
      if (!current) throw workError("target_not_found", `work "${id}" does not exist`);
      return current; // pure no-op: no write, no revision bump
    }
    const mutator = async (env) => {
      if (!env) throw workError("target_not_found", `work "${id}" does not exist`);
      if (expectedRevision !== undefined && expectedRevision !== env.revision) {
        throw workError(
          "revision_conflict",
          `work "${id}" revision conflict: expected ${expectedRevision}, current ${env.revision} — nothing written`,
        );
      }
      validateStateFields({
        state: patch.state,
        stage: patch.stage,
        waitingReason: patch.waitingReason,
      });
      if (patch.objective !== undefined) assertNonEmptyString(patch.objective, "objective");
      if (patch.priority !== undefined && (typeof patch.priority !== "number" || !Number.isFinite(patch.priority))) {
        throw workError("unsupported", "priority must be a finite number");
      }
      if (patch.priorityReason !== undefined && typeof patch.priorityReason !== "string") {
        throw workError("unsupported", "priorityReason must be a string");
      }
      if (patch.schedulingClass !== undefined) {
        validateSchedulingClass(patch.schedulingClass);
      }
      if (patch.project !== undefined) validateProjectRef(patch.project);
      if (patch.deliveryTarget !== undefined) validateDeliveryTarget(patch.deliveryTarget);
      for (const field of ["attempts", "decisions", "resources", "evidence"]) {
        if (patch[field] !== undefined) validateRefArray(patch[field], field);
      }
      if (patch.spec !== undefined) {
        validateSpec(patch.spec);
        if (patch.spec.revision < env.spec.revision) {
          throw workError(
            "unsupported",
            `spec revision ${patch.spec.revision} is behind the current ${env.spec.revision} (monotonic)`,
          );
        }
        if (patch.spec.revision === env.spec.revision && patch.spec.hash !== env.spec.hash) {
          throw workError(
            "unsupported",
            `spec hash changed without a revision bump (revision ${env.spec.revision})`,
          );
        }
      }
      const next = { ...env, ...patch, updatedAt: now() };
      if (executionCharter !== undefined) {
        validateExecutionCharter(executionCharter);
        const prior = env.executionCharter;
        const approval = executionCharter.scopeApprovals?.at(-1);
        const stableAuthority = prior && executionCharter.version === prior.version &&
          executionCharter.revision === prior.revision + 1 &&
          executionCharter.status === prior.status && executionCharter.goalKey === prior.goalKey &&
          executionCharter.acceptedAt === prior.acceptedAt &&
          canonicalJson(executionCharter.source) === canonicalJson(prior.source) &&
          canonicalJson(executionCharter.permissions) === canonicalJson(prior.permissions) &&
          canonicalJson(executionCharter.limits) === canonicalJson(prior.limits);
        if (!stableAuthority || !approval || approval.revision !== executionCharter.revision ||
            approval.scopeHash !== executionScopeHash(next)) {
          throw workError("policy_blocked", "execution charter revision must preserve the accepted authority and carry a matching server-approved scope change");
        }
        next.executionCharter = structuredClone(executionCharter);
      }
      if (next.state === "waiting" && !next.waitingReason) {
        throw workError("unsupported", "state \"waiting\" requires a waitingReason");
      }
      if (next.state !== "waiting") {
        if (patch.waitingReason !== undefined) {
          throw workError("unsupported", "waitingReason requires state \"waiting\"");
        }
        if (patch.state !== undefined) {
          // State moved off "waiting": the stale reason is dropped so the
          // envelope invariant (waitingReason only while waiting) always holds.
          delete next.waitingReason;
        }
      }
      next.revision = env.revision + 1;
      // §5.2 "spec revisions invalidate incompatible results": a spec hash
      // change durably marks every receipt reserved under the old spec, so a
      // later redelivery of its result can never report superseded:false.
      // Receipts (and their specHash) are never compacted away, so the
      // staleness material survives as long as the envelope does.
      if (patch.spec !== undefined && next.spec.hash !== env.spec.hash) {
        for (const receipt of next.operations) {
          if (receipt.specHash !== next.spec.hash) {
            receipt.superseded = true;
          }
        }
      }
      if (patch.dependencies !== undefined) {
        // Dependency existence + acyclicity are checked against the POST-patch
        // graph. Nothing has been written yet, so a rejection leaves the
        // envelope untouched (invalid updates never write). Runs under the
        // shared graph lock (the caller wraps this mutator), so concurrent
        // graph mutations cannot interleave with this snapshot.
        await assertDependenciesValid(store, next.dependencies, { selfId: id });
      }
      return { save: next, value: next };
    };
    if (patch.dependencies !== undefined) {
      // Graph mutation: the whole validate+commit section is serialized by
      // the shared graph lock (lock order: graph → file inside mutateEnvelope).
      return workGraphLock.runExclusive(() => mutateEnvelope(store, id, mutator));
    }
    return mutateEnvelope(store, id, mutator);
  }

  // §8.1 step 2: reserve the operation under the store lock — same key + same
  // operation+args replays the prior receipt; same key with a different
  // operation name or different args is an error; a second concurrent reserve
  // observes the first (the lock serializes) and replays instead of
  // double-reserving. No external effect happens inside this function: the
  // lock is held only across the local file read-modify-write and released
  // before return.
  async function reserveOperation(
    workId,
    { key, op, args, expectedRevision, leaseOwner, leaseTtlMs } = {},
  ) {
    assertNonEmptyString(key, "idempotency key");
    assertNonEmptyString(op, "operation name");
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      throw workError(
        "unsupported",
        `expectedRevision must be a positive integer (got ${JSON.stringify(expectedRevision)})`,
      );
    }
    // Lease inputs are validated BEFORE any write: a malformed lease must
    // never reach the store and silently poison crash recovery.
    if (leaseOwner !== undefined) assertNonEmptyString(leaseOwner, "leaseOwner");
    if (leaseTtlMs !== undefined) {
      if (typeof leaseTtlMs !== "number" || !Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
        throw workError(
          "unsupported",
          `leaseTtlMs must be a positive finite integer (got ${JSON.stringify(leaseTtlMs)})`,
        );
      }
      if (leaseTtlMs > MAX_LEASE_TTL_MS) {
        throw workError(
          "unsupported",
          `leaseTtlMs ${leaseTtlMs} exceeds the documented maximum ${MAX_LEASE_TTL_MS}ms`,
        );
      }
    }
    // Args contract (simple, consistent JSON): omitted ≡ `{}` — the same
    // operation under the same key; an EXPLICIT `null` is rejected because it
    // would hash as `{}` while persisting as `null` (hash/storage desync).
    // Nested nulls inside the object are ordinary JSON and stay allowed.
    if (args === null) {
      throw workError("unsupported", "args must be omitted or an object — explicit null is reserved (it would collide with {})");
    }
    // The args snapshot is validated and deep-cloned SYNCHRONOUSLY, before
    // the first await: the hash AND the stored receipt derive from the same
    // frozen snapshot, so a caller mutating its args object while the reserve
    // is in flight can never make stored data disagree with the hashed data.
    assertJsonSafe(args ?? {}, "args", new Set());
    const argsSnapshot = args === undefined ? {} : JSON.parse(JSON.stringify(args));
    const argsHash = canonicalArgsHash(op, argsSnapshot);
    const ts = now();
    const ttl = leaseTtlMs ?? LEASE_DEFAULT_TTL_MS;
    const owner = leaseOwner ?? DEFAULT_LEASE_OWNER;

    const result = await mutateEnvelope(store, workId, (env) => {
      if (!env) throw workError("target_not_found", `work "${workId}" does not exist`);
      if (expectedRevision !== undefined && expectedRevision !== env.revision) {
        throw workError(
          "revision_conflict",
          `work "${workId}" revision conflict: expected ${expectedRevision}, current ${env.revision} — nothing reserved`,
        );
      }
      const existing = env.operations.find((r) => r.key === key);
      if (existing) {
        if (existing.argsHash !== argsHash) {
          throw workError(
            "idempotency_key_args_mismatch",
            `idempotency key "${key}" was already used on work "${workId}" with operation ` +
              `${JSON.stringify(existing.op)} and different arguments`,
          );
        }
        if (existing.status === "unknown") {
          // §8.2: unknown is not safe to retry without reconciliation — forbid
          // the blind re-dispatch by refusing a fresh reservation.
          throw workError(
            "external_outcome_unknown",
            `operation "${existing.id}" on work "${workId}" has an UNKNOWN external outcome — reconcile it ` +
              `(recordOperationOutcome) before re-reserving key "${key}"`,
            { receipt: existing },
          );
        }
        if (TERMINAL_OPERATION_STATUSES.includes(existing.status)) {
          // Terminal ALWAYS replays, lease expired or not — a succeeded/failed
          // operation is never reset and never re-executed.
          return { save: null, value: { receipt: existing, replay: true } };
        }
        const leaseLive = existing.lease != null && existing.lease.expiresAt > ts;
        if (leaseLive) {
          // A live reservation — pending or in_flight — is OWNED: a second
          // caller replays the receipt and must not act on it (this is what
          // keeps concurrent same-key requests to ONE reservation).
          return { save: null, value: { receipt: existing, replay: true } };
        }
        if (existing.status === "pending") {
          // Expired lease on a never-externally-issued reservation → safe
          // resume: re-arm the SAME receipt (pending→pending is a lease
          // re-arm, not a status transition), never create a second one.
          existing.lease = { owner, expiresAt: ts + ttl };
          existing.takeoverCount = (existing.takeoverCount ?? 0) + 1;
          existing.updatedAt = ts;
          env.updatedAt = ts;
          return { save: env, value: { receipt: existing, replay: false, recovered: true } };
        }
        // in_flight + expired lease → the external effect MAY have run and its
        // outcome was never observed. The transition matrix allows
        // in_flight→unknown (never a downgrade to pending): durably mark it
        // and demand reconciliation.
        existing.status = "unknown";
        existing.reconcileReason = "lease_expired";
        existing.resultAt = existing.resultAt ?? ts;
        existing.updatedAt = ts;
        env.updatedAt = ts;
        return { save: env, value: { receipt: existing, replay: false, uncertain: true } };
      }
      // New unique key at capacity → refuse; existing keys keep replaying.
      if (env.operations.length >= HISTORY_CAPACITY) {
        throw workError(
          "history_capacity",
          `work "${workId}" operation history is at the durable capacity ${HISTORY_CAPACITY}; ` +
            `resolve/archive existing operations before reserving new ones (identical retries still replay)`,
        );
      }
      const receipt = {
        id: `op_${newId()}`,
        key,
        op,
        argsHash,
        args: argsSnapshot,
        workRevision: env.revision,
        stage: env.stage,
        specHash: env.spec.hash,
        status: "pending",
        externalRef: null,
        resultCode: null,
        lease: { owner, expiresAt: ts + ttl },
        takeoverCount: 0,
        createdAt: ts,
        updatedAt: ts,
        resultAt: null,
      };
      env.operations = [...env.operations, receipt];
      // Receipt bookkeeping does NOT bump the work-state revision: a same-key
      // retry (or a concurrent reserve) carrying expectedRevision must replay,
      // not conflict. `revision` moves only when the work's semantic state
      // changes (create/revise) — which is exactly what `receipt.workRevision`
      // snapshots for later staleness checks.
      env.updatedAt = ts;
      return { save: env, value: { receipt, replay: false } };
    });
    if (result.uncertain) {
      throw workError(
        "external_outcome_unknown",
        `operation "${result.receipt.id}" on work "${workId}" was in_flight when its lease expired — the external ` +
          `outcome is unknown; reconcile it (recordOperationOutcome) before re-reserving key "${key}"`,
        { receipt: result.receipt },
      );
    }
    return result;
  }

  // §8.1 step 5: persist the OBSERVED result on the receipt, through the one
  // explicit transition matrix (RECEIPT_TRANSITIONS). Records only — stage
  // advancement/orchestration is the later coordinator's job. A result whose
  // spec hash no longer matches the envelope's current spec is recorded but
  // marked superseded and never treated as current-work progress (U13) —
  // including on REPLAY: a redelivered outcome for a receipt that succeeded
  // under an older spec reports superseded:true, never false.
  async function recordOperationOutcome(
    workId,
    { receiptId, key, status, resultCode, externalRef, result } = {},
  ) {
    if (!OPERATION_STATUSES.includes(status)) {
      throw workError("unsupported", `status "${status}" is not a valid operation status`);
    }
    // Outcome fields are validated BEFORE any write, on every path (including
    // unknown reconciliation): a typed-wrong resultCode/externalRef must never
    // reach the store — the strict loader would then refuse to reload the
    // envelope the write just claimed success on.
    if (resultCode !== undefined && resultCode !== null && typeof resultCode !== "string") {
      throw workError("unsupported", `resultCode must be a string or null (got ${typeof resultCode})`);
    }
    if (externalRef !== undefined && externalRef !== null && typeof externalRef !== "string") {
      throw workError("unsupported", `externalRef must be a string or null (got ${typeof externalRef})`);
    }
    if (result !== undefined && result !== null) {
      assertPlainObject(result, "result");
      assertJsonSafe(result, "result", new Set());
    }
    const ts = now();
    return mutateEnvelope(store, workId, (env) => {
      if (!env) throw workError("target_not_found", `work "${workId}" does not exist`);
      const receipt = receiptId !== undefined
        ? env.operations.find((r) => r.id === receiptId)
        : env.operations.find((r) => r.key === key);
      if (!receipt) {
        throw workError(
          "target_not_found",
          `operation ${receiptId ?? `key "${key}"`} not found on work "${workId}"`,
        );
      }
      const staleSpec = receipt.specHash !== env.spec.hash;
      if (receipt.status === status) {
        // Idempotent replay of a known outcome — staleness is evaluated HERE
        // too, before returning, so a redelivery after a spec change can
        // never report superseded:false.
        return { save: null, value: { receipt, replay: true, superseded: receipt.superseded === true || staleSpec } };
      }
      const allowed = RECEIPT_TRANSITIONS[receipt.status] ?? [];
      if (!allowed.includes(status)) {
        throw workError(
          "receipt_state_conflict",
          `operation "${receipt.id}": transition ${receipt.status} → ${status} is not allowed ` +
            `(allowed: ${allowed.length ? allowed.join(", ") : "none — terminal, replay only"})`,
        );
      }
      if (receipt.status === "unknown") {
        // Reconciliation must carry explicit evidence of HOW the outcome was
        // verified (e.g. the PR head / run id that was inspected).
        if (typeof resultCode !== "string" || resultCode.trim().length === 0) {
          throw workError(
            "unsupported",
            `resolving unknown operation "${receipt.id}" requires explicit reconciliation evidence in resultCode`,
          );
        }
      }
      receipt.status = status;
      receipt.resultCode = resultCode ?? receipt.resultCode ?? null;
      receipt.externalRef = externalRef ?? receipt.externalRef ?? null;
      if (result !== undefined) receipt.result = result;
      receipt.resultAt = ts;
      receipt.updatedAt = ts;
      const superseded = staleSpec;
      if (superseded) receipt.superseded = true;
      env.updatedAt = ts;
      return { save: env, value: { receipt, replay: false, superseded } };
    });
  }

  // Validated general envelope mutator for the work-family semantics
  // (ctoWorkTools.mjs): ONE read-modify-write section under the per-envelope
  // lock (the same lock every other mutator uses), strict load, and the saved
  // envelope re-validated before the write — so every write path keeps the
  // strict-shape invariant. NOT for dependency patches (those must go through
  // reviseWork, which holds the graph lock). `mutator(envOrNull)` returns
  // `{ save, value }` with `save: null` meaning a pure read.
  async function mutateWork(id, mutator) {
    return mutateEnvelope(store, id, async (env) => {
      if (!env) throw workError("target_not_found", `work "${id}" does not exist`);
      const { save, value } = await mutator(env);
      if (save !== null) assertValidEnvelope(save, id);
      return { save, value };
    });
  }

  return {
    createWork,
    getWork,
    findExecutionGoal,
    listWorks,
    reviseWork,
    reserveOperation,
    recordOperationOutcome,
    mutateWork,
  };
}
