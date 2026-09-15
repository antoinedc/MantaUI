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
// RETENTION = DEDUPE PRESERVED. Terminal receipt history is bounded
// (OPERATIONS_KEEP full receipts); receipts evicted from the full set are
// compacted into TOMBSTONES that keep the idempotency identity (key +
// argsHash + op) and the original outcome (status/resultCode/externalRef), so
// a retry of an old key still REPLAYS instead of re-executing (the 21st
// operation must not resurrect the 1st as a blind duplicate). Tombstones are
// capped at TOMBSTONE_KEEP. pending/in_flight/unknown receipts — and anything
// not classifiable as terminal — are never evicted or tombstoned.
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
// Unresolved receipts are never pruned or tombstoned (a pending/in_flight
// receipt is someone's reservation; an unknown receipt is the only record
// that an external effect MAY have happened — losing it invites blind
// re-dispatch). Terminal receipts are the only ones eligible for compaction.
export const UNRESOLVED_OPERATION_STATUSES = Object.freeze(["pending", "in_flight", "unknown"]);
export const TERMINAL_OPERATION_STATUSES = Object.freeze(["succeeded", "failed"]);

// Bounded operation history per envelope: at most OPERATIONS_KEEP FULL
// terminal receipts; older terminals are compacted to tombstones; at most
// TOMBSTONE_KEEP tombstones. Non-terminal receipts never count against
// either cap.
export const OPERATIONS_KEEP = 20;
export const TOMBSTONE_KEEP = 4 * OPERATIONS_KEEP;
// List bound: listWorks never returns unbounded arrays; the caller learns the
// true total so truncation is visible, never silent.
export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 1000;

const LEASE_DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_LEASE_OWNER = "cto-work";
const MUTABLE_FIELDS = Object.freeze([
  "objective",
  "project",
  "deliveryTarget",
  "spec",
  "dependencies",
  "priority",
  "priorityReason",
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
//   receipt_state_conflict, store_corrupt, store_unavailable.
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
  return createHash("sha256").update(canonicalJson({ op, args: args ?? {} })).digest("hex");
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

function validateRefArray(value, label) {
  if (!Array.isArray(value)) throw workError("unsupported", `${label} must be an array`);
  for (const entry of value) assertPlainObject(entry, `${label}[]`);
}

// A stored receipt must carry its full dedupe identity and a status from the
// closed set — an unclassifiable status can never be mistaken for terminal by
// the retention logic, because an envelope carrying one refuses to load.
function assertValidReceipt(receipt, workId) {
  const label = `operations[]`;
  assertPlainObject(receipt, `${label} (work "${workId}")`);
  assertNonEmptyString(receipt.id, `${label}.id`);
  assertNonEmptyString(receipt.key, `${label}.key`);
  assertNonEmptyString(receipt.argsHash, `${label}.argsHash`);
  if (!OPERATION_STATUSES.includes(receipt.status)) {
    throw workError("unsupported", `${label}.status ${JSON.stringify(receipt.status)} is not a valid operation status`);
  }
  if (receipt.tombstone === true) {
    if (typeof receipt.prunedAt !== "number") {
      throw workError("unsupported", `${label}.prunedAt must be a number on a tombstone`);
    }
    return;
  }
  assertNonEmptyString(receipt.op, `${label}.op`);
  if (!Number.isInteger(receipt.workRevision) || receipt.workRevision < 1) {
    throw workError("unsupported", `${label}.workRevision must be a positive integer`);
  }
  if (typeof receipt.createdAt !== "number" || typeof receipt.updatedAt !== "number") {
    throw workError("unsupported", `${label} timestamps must be numbers`);
  }
  if (receipt.lease != null) {
    assertPlainObject(receipt.lease, `${label}.lease`);
    assertNonEmptyString(receipt.lease.owner, `${label}.lease.owner`);
    if (typeof receipt.lease.expiresAt !== "number") {
      throw workError("unsupported", `${label}.lease.expiresAt must be a number`);
    }
  }
}

// Load-time shape gate (blocker: the loader used to accept anything with a
// v/id). Every read, mutate and prune downstream sees a structurally valid
// envelope or nothing at all — corruption is visible, never silently pruned
// or classified.
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
    if (env.state !== undefined && !WORK_STATES.includes(env.state)) {
      throw workError("unsupported", `state "${env.state}" is not a valid work state`);
    }
    if (env.stage !== undefined && !WORK_STAGES.includes(env.stage)) {
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
    for (const field of ["attempts", "decisions", "resources", "evidence"]) {
      if (!Array.isArray(env[field])) {
        throw workError("unsupported", `${field} must be an array`);
      }
      for (const entry of env[field]) assertPlainObject(entry, `${field}[]`);
    }
    if (!Array.isArray(env.operations)) {
      throw workError("unsupported", "operations must be an array");
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

// ---------------------------------------------------------------------------
// Retention + dependency-graph helpers
// ---------------------------------------------------------------------------

// Pure: bound the operation history WITHOUT losing the dedupe function.
//   - pending/in_flight/unknown receipts (and anything not classifiable as
//     terminal) are always kept verbatim;
//   - full terminal receipts beyond `keep` (oldest first) are compacted into
//     tombstones preserving key + argsHash + op + original outcome;
//   - tombstones beyond `tombstoneKeep` (oldest first) are dropped.
export function pruneOperationHistory(
  operations,
  { keep = OPERATIONS_KEEP, tombstoneKeep = TOMBSTONE_KEEP, nowMs = Date.now() } = {},
) {
  const list = Array.isArray(operations) ? operations : [];
  const kept = [];
  const fullTerminals = [];
  const tombstones = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (r.tombstone === true) tombstones.push(r);
    else if (TERMINAL_OPERATION_STATUSES.includes(r.status)) fullTerminals.push(r);
    else kept.push(r); // unresolved — never evicted, whatever the caps
  }
  const byResult = (a, b) =>
    (a.resultAt ?? a.updatedAt ?? 0) - (b.resultAt ?? b.updatedAt ?? 0);
  fullTerminals.sort(byResult);
  const toTombstone = [];
  if (fullTerminals.length > keep) {
    toTombstone.push(...fullTerminals.slice(0, fullTerminals.length - keep));
  }
  const keptTerminals = fullTerminals.slice(Math.max(0, fullTerminals.length - keep));
  const allTombstones = [
    ...toTombstone.map((r) => ({
      id: r.id,
      key: r.key,
      op: r.op,
      argsHash: r.argsHash,
      status: r.status,
      resultCode: r.resultCode ?? null,
      externalRef: r.externalRef ?? null,
      resultAt: r.resultAt ?? r.updatedAt ?? null,
      tombstone: true,
      prunedAt: nowMs,
    })),
    ...tombstones,
  ];
  allTombstones.sort(byResult);
  const droppedTombstones = allTombstones.length > tombstoneKeep
    ? allTombstones.slice(0, allTombstones.length - tombstoneKeep)
    : [];
  const droppedIds = new Set(droppedTombstones.map((t) => t.id));
  return [
    ...kept,
    ...keptTerminals,
    ...allTombstones.filter((t) => !droppedIds.has(t.id)),
  ];
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
  validateStateFields({ state: input.state, stage: input.stage, waitingReason: input.waitingReason });
  if (input.priority !== undefined && (typeof input.priority !== "number" || !Number.isFinite(input.priority))) {
    throw workError("unsupported", "priority must be a finite number");
  }
  if (input.priorityReason !== undefined && typeof input.priorityReason !== "string") {
    throw workError("unsupported", "priorityReason must be a string");
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
      dependencies: [...(input.dependencies ?? [])],
      priority: input.priority ?? 0,
      priorityReason: input.priorityReason ?? "",
      stage: input.stage ?? "specify",
      state: input.state ?? "draft",
      ...(input.waitingReason !== undefined ? { waitingReason: input.waitingReason } : {}),
      attempts: [...(input.attempts ?? [])],
      operations: [],
      decisions: [...(input.decisions ?? [])],
      resources: [...(input.resources ?? [])],
      evidence: [...(input.evidence ?? [])],
      createdAt: ts,
      updatedAt: ts,
    };
    if (envelope.dependencies.length > 0) {
      // Graph mutation: validate + commit under the shared graph lock, then
      // the per-file lock inside commitNewWork (lock order: graph → file).
      return workGraphLock.runExclusive(async () => {
        await assertDependenciesValid(store, envelope.dependencies, { selfId: id });
        return commitNewWork(store, id, envelope);
      });
    }
    return commitNewWork(store, id, envelope);
  }

  async function getWork(id) {
    return loadEnvelopeStrict(store, id);
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

  async function reviseWork(id, patch, { expectedRevision } = {}) {
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
      if (patch.spec !== undefined && next.spec.hash !== env.spec.hash) {
        for (const receipt of next.operations) {
          if (receipt && receipt.tombstone !== true && receipt.specHash != null && receipt.specHash !== next.spec.hash) {
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
    const argsHash = canonicalArgsHash(op, args);
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
              `${JSON.stringify(existing.op ?? "unknown")} and different arguments`,
          );
        }
        if (existing.tombstone === true) {
          // Retention compacted the full receipt; the dedupe identity and the
          // original outcome survive, so this retry REPLAYS — it must never
          // re-execute the action as a new reservation.
          return { save: null, value: { receipt: existing, replay: true } };
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
          // operation is never reset to pending and never re-executed.
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
          // Expired lease on a never-dispatched reservation (the P4 protocol
          // records in_flight BEFORE the first external effect) → safe resume:
          // re-arm the same receipt, never create a second one.
          existing.lease = { owner, expiresAt: ts + ttl };
          existing.takeoverCount = (existing.takeoverCount ?? 0) + 1;
          existing.updatedAt = ts;
          env.updatedAt = ts;
          return { save: env, value: { receipt: existing, replay: false, recovered: true } };
        }
        // in_flight + expired lease → the external effect MAY have run and its
        // outcome was never observed. Never re-execute: durably mark the
        // receipt unknown and demand reconciliation.
        existing.status = "unknown";
        existing.reconcileReason = "lease_expired";
        existing.resultAt = existing.resultAt ?? ts;
        existing.updatedAt = ts;
        env.updatedAt = ts;
        return { save: env, value: { receipt: existing, replay: false, uncertain: true } };
      }
      const receipt = {
        id: `op_${newId()}`,
        key,
        op,
        argsHash,
        args: args ?? {},
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
      env.operations = pruneOperationHistory([...env.operations, receipt], { nowMs: ts });
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

  // §8.1 step 5: persist the OBSERVED result on the receipt. Records only —
  // stage advancement/orchestration is the later coordinator's job. A result
  // whose spec hash no longer matches the envelope's current spec is recorded
  // but marked superseded and never treated as current-work progress (U13) —
  // including on REPLAY: a redelivered outcome for a receipt that succeeded
  // under an older spec reports superseded:true, never false.
  async function recordOperationOutcome(
    workId,
    { receiptId, key, status, resultCode, externalRef } = {},
  ) {
    if (!OPERATION_STATUSES.includes(status)) {
      throw workError("unsupported", `status "${status}" is not a valid operation status`);
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
      const staleSpec = receipt.specHash != null && receipt.specHash !== env.spec.hash;
      if (receipt.status === status) {
        // Idempotent replay of a known outcome — staleness is evaluated HERE
        // too, before returning, so a redelivery after a spec change can
        // never report superseded:false.
        return { save: null, value: { receipt, replay: true, superseded: receipt.superseded === true || staleSpec } };
      }
      if (TERMINAL_OPERATION_STATUSES.includes(receipt.status)) {
        throw workError(
          "receipt_state_conflict",
          `operation "${receipt.id}" is already terminal (${receipt.status}); refusing to record ${status}`,
        );
      }
      if (receipt.status === "unknown" && status !== "succeeded" && status !== "failed") {
        throw workError(
          "receipt_state_conflict",
          `operation "${receipt.id}" is unknown; only a definitive outcome (succeeded/failed) resolves it`,
        );
      }
      receipt.status = status;
      receipt.resultCode = resultCode ?? null;
      receipt.externalRef = externalRef ?? receipt.externalRef ?? null;
      receipt.resultAt = ts;
      receipt.updatedAt = ts;
      const superseded = staleSpec;
      if (superseded) receipt.superseded = true;
      env.operations = pruneOperationHistory([...env.operations], { nowMs: ts });
      env.updatedAt = ts;
      return { save: env, value: { receipt, replay: false, superseded } };
    });
  }

  return { createWork, getWork, listWorks, reviseWork, reserveOperation, recordOperationOutcome };
}
