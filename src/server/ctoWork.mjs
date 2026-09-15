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
//     `externalRef` stays caller-supplied.
//   - No §6 transition-precondition enforcement (that is the P4 work
//     coordinator), no attempt subtypes beyond opaque ref objects, no future
//     control methods (dispatch/pause/cancel/answer_decision/…), no sweeper
//     wiring, no HTTP/UI.

import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrateStore, lockForStore, workStore } from "./ctoStores.mjs";

// ---------------------------------------------------------------------------
// Closed vocabularies (spec §5.1) — enum membership is enforced on every write.
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
// Terminal receipts may be pruned for retention; pending/in_flight/unknown are
// UNRESOLVED and are never evicted arbitrarily (a pending/in_flight receipt is
// someone's live reservation; an unknown receipt is the only record that an
// external effect MAY have happened — losing it invites blind re-dispatch).
export const UNRESOLVED_OPERATION_STATUSES = Object.freeze(["pending", "in_flight", "unknown"]);

// Bounded operation history per envelope: terminal receipts beyond this cap
// are pruned oldest-first at write time. Non-terminal receipts never count
// against the cap.
export const OPERATIONS_KEEP = 20;
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
// service-layer codes beyond that list are spelled out and documented.
// ---------------------------------------------------------------------------

export function workError(code, message, { receipt } = {}) {
  const error = new Error(message);
  error.code = code;
  if (receipt) error.receipt = receipt;
  return error;
}

// ---------------------------------------------------------------------------
// Canonical args hashing (receipt idempotency — spec §7/§8.1). Key order must
// not matter: the same logical request under a different key order is the SAME
// operation.
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function canonicalArgsHash(args) {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex");
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

// ---------------------------------------------------------------------------
// Store plumbing — strict envelope load (missing → null, corrupt → visible
// throw, never the store's default-payload fall-through) + per-envelope
// mutation under the shared per-path lock map from ctoStores.
// ---------------------------------------------------------------------------

async function loadEnvelopeStrict(store, id) {
  let raw;
  try {
    raw = await readFile(store.pathFor(id), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw workError("store_corrupt", `work envelope "${id}" is corrupt (invalid JSON) — refusing to load`);
  }
  const migrated = migrateStore(store.name, parsed);
  if (!migrated || typeof migrated !== "object" || migrated.id !== id) {
    throw workError("store_corrupt", `work envelope "${id}" is corrupt (missing or mismatched id)`);
  }
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

async function loadAllEnvelopes(store) {
  let entries;
  try {
    entries = await readdir(store.dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name.slice(0, -".json".length));
  const envs = [];
  for (const id of ids) {
    const env = await loadEnvelopeStrict(store, id); // corrupt → visible failure, never skipped
    if (env) envs.push(env);
  }
  return envs;
}

// ---------------------------------------------------------------------------
// Retention + dependency-graph helpers (pure except the store reads they need)
// ---------------------------------------------------------------------------

// Pure: trim TERMINAL receipts beyond `keep`, oldest first (by resultAt, then
// updatedAt, then original order for stability). pending/in_flight/unknown
// receipts are never dropped, whatever their age — dropping an unresolved
// receipt would erase the only record of a possibly-executed external effect.
export function pruneOperationHistory(operations, { keep = OPERATIONS_KEEP } = {}) {
  const list = Array.isArray(operations) ? operations : [];
  const terminal = list.filter((r) => !UNRESOLVED_OPERATION_STATUSES.includes(r?.status));
  if (terminal.length <= keep) return list;
  const ranked = terminal
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        (a.r.resultAt ?? a.r.updatedAt ?? 0) - (b.r.resultAt ?? b.r.updatedAt ?? 0) || a.i - b.i,
    );
  const droppedIds = new Set(ranked.slice(0, terminal.length - keep).map((x) => x.r.id));
  return list.filter((r) => !droppedIds.has(r?.id));
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
      await assertDependenciesValid(store, envelope.dependencies, { selfId: id });
    }
    const existing = await loadEnvelopeStrict(store, id);
    if (existing) throw workError("target_exists", `work "${id}" already exists`);
    await store.save(id, envelope);
    return envelope;
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
    return mutateEnvelope(store, id, async (env) => {
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
      if (patch.dependencies !== undefined) {
        // Dependency existence + acyclicity are checked against the POST-patch
        // graph. Nothing has been written yet, so a rejection leaves the
        // envelope untouched (invalid updates never write).
        await assertDependenciesValid(store, next.dependencies, { selfId: id });
      }
      return { save: next, value: next };
    });
  }

  // §8.1 step 2: reserve the operation under the store lock — same key + same
  // canonical args replays the prior receipt; same key + different args is an
  // error; a second concurrent reserve observes the first (the lock
  // serializes) and replays instead of double-reserving. No external effect
  // happens inside this function: the lock is held only across the file
  // read-modify-write and released before return.
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
    const argsHash = canonicalArgsHash(args);
    const ts = now();
    const ttl = leaseTtlMs ?? LEASE_DEFAULT_TTL_MS;
    const owner = leaseOwner ?? DEFAULT_LEASE_OWNER;

    return mutateEnvelope(store, workId, (env) => {
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
            `idempotency key "${key}" was already used with different arguments on work "${workId}"`,
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
        const leaseLive = existing.lease != null && existing.lease.expiresAt > ts;
        if (leaseLive) {
          // A live reservation — pending or in_flight — is OWNED: a second
          // caller replays the receipt and must not act on it (this is what
          // keeps concurrent same-key requests to ONE reservation).
          return { save: null, value: { receipt: existing, replay: true } };
        }
        // Unresolved with an expired/absent lease → crash recovery: the
        // reservation is resumable; hand it back re-armed.
        existing.status = "pending";
        existing.lease = { owner, expiresAt: ts + ttl };
        existing.takeoverCount = (existing.takeoverCount ?? 0) + 1;
        existing.updatedAt = ts;
        env.updatedAt = ts;
        return { save: env, value: { receipt: existing, replay: false, recovered: true } };
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
      env.operations = pruneOperationHistory([...env.operations, receipt]);
      // Receipt bookkeeping does NOT bump the work-state revision: a same-key
      // retry (or a concurrent reserve) carries expectedRevision and must
      // replay, not conflict. `revision` moves only when the work's semantic
      // state changes (create/revise) — which is exactly what
      // `receipt.workRevision` snapshots for later staleness checks.
      env.updatedAt = ts;
      return { save: env, value: { receipt, replay: false } };
    });
  }

  // §8.1 step 5: persist the OBSERVED result on the receipt. Records only —
  // stage advancement/orchestration is the later coordinator's job. A result
  // whose spec hash no longer matches the envelope's current spec is recorded
  // but marked superseded and never treated as current-work progress (U13).
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
      if (receipt.status === status) {
        return { save: null, value: { receipt, replay: true, superseded: receipt.superseded === true } };
      }
      if (!UNRESOLVED_OPERATION_STATUSES.includes(receipt.status)) {
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
      const superseded = receipt.specHash !== env.spec.hash;
      if (superseded) receipt.superseded = true;
      env.operations = pruneOperationHistory([...env.operations]);
      env.updatedAt = ts;
      return { save: env, value: { receipt, replay: false, superseded } };
    });
  }

  return { createWork, getWork, listWorks, reviseWork, reserveOperation, recordOperationOutcome };
}
