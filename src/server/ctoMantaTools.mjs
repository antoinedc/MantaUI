// ctoMantaTools.mjs — unified-CTO spec §7 `projects` + `sessions` control-tool
// families (P4 slice). The `work` family (dispatch/review/merge lifecycle) is
// deliberately NOT here — separate PR.
//
// PROJECT IDENTITY — THE DURABLE KEY (docs/cto-implementation-map.md §4/§4.1,
// adopted per PR #1516's probe). A project IS a tmux session (name + resolved
// cwd, per tmux.mjs `listProjects`); its DURABLE key is a Manta-minted
// `projectId`, persisted ONCE on the `~/.manta/config.json` `projects[]`
// record — `{tmuxSession, defaultCwd, projectId, opencodeProjectId?}`. No
// opencode identifier may BE the key (opencode's `project.id` is
// repository-grained while a Manta project is checkout-grained; remote-less
// repos fork their id on delete+recreate). `opencodeProjectId` is a CACHE,
// never authoritative: on a mismatch with a live observation, ADOPT the new
// value — opencode has already migrated its sessions; Manta follows.
// Consequences, all deliberate:
//   • NO second project registry: live tmux state stays the source of truth;
//     the config record only adds the minted key + the two cache fields.
//   • The identity surface is ONE function — `resolveProjectIdentity` — the
//     rules live there; `createProjectIdentityAdapter` is its single I/O
//     wrapper (config records in, persist plan out).
//   • tmux session names are user-renameable. A rename REBINDS the existing
//     record (keeps its minted key) under the settled §4.1 rule; what the
//     rule cannot recover fails closed — see the §4.1 doc, "what it cannot
//     recover".
//
// RECEIPT LIFECYCLE — mirrors ctoWork.mjs (same canonicalArgsHash, same
// transition family, adapted to box-management effects whose latency is
// seconds, so the lease TTL is short):
//   pending ──(issue imminent)──▶ in_flight ──▶ succeeded | failed
//   expired pending  → safe resume (nothing was issued; re-execute)
//   expired in_flight → durably `unknown` → external_outcome_unknown
//   (reconcile required — the external effect MAY have happened; NEVER
//   re-execute). Replaying a terminal receipt returns its ORIGINAL result;
//   the same key with different arguments is
//   `idempotency_key_args_mismatch`. Reserve → in_flight → execute are
//   separate store sections with the lock RELEASED across the external call
//   (§8.1: never hold a store lock while awaiting an external effect).
//
// ERROR CODES (spec §7 closed set, with retry-safety on every error):
//   target_not_found, target_ambiguous, target_changed, revision_conflict,
//   provider_unavailable, unsupported, dirty_resource, borrowed_resource,
//   active_resource, external_outcome_unknown, capacity_wait — plus the two
//   service-layer codes ctoWork already established beyond the set:
//   target_exists, idempotency_key_args_mismatch. `capacity_wait` is used
//   here only for the receipt-ledger cap; the §7 dispatch-capacity use lives
//   in the work family. `policy_blocked` and `evidence_missing` are unused in
//   these two families (their triggers — admission policy and evidence
//   reconciliation — belong to work/admission).
//
// READ/WRITE SEPARATION (spec §7 + U04): the read operations' dependency
// graph contains NO prompt dispatch, worker creation, window creation or
// session mutation. The factory takes reads and writes as separate injected
// deps; the test wires EVERY write dep as a throwing spy at the production
// composition boundary and asserts the reads still succeed and no spy fires.
//
// Every mutation drives its external dep (tmux.mjs / opencode.mjs — the SAME
// operations the UI uses); nothing here is a no-op stub. Cwd resolution goes
// through `projectCwd.resolveProjectCwd` (the SOLE resolver) and
// `tmux.resolveCwdOrThrow` (the ~-expansion + missing-dir chokepoint) — never
// around them. Archive is metadata-only (nothing destroyed, transcripts
// preserved); remove is the destructive request and refuses dirty /
// borrowed / active resources rather than losing work (no new authorization
// ladder — just refuse with the stable code).

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lockForStore, mantaControlStore } from "./ctoStores.mjs";
import { canonicalArgsHash } from "./ctoWork.mjs";
import { resolveProjectCwd as defaultResolveProjectCwd } from "./projectCwd.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";
import { resolveNamedModel } from "./delegate.mjs";
import {
  createSession as ocCreateSessionDefault,
  forkSession as ocForkSessionDefault,
  compactSession as ocCompactSessionDefault,
  deleteSessionRaw as ocDeleteSessionRawDefault,
  listSessions as ocListSessionsDefault,
  listModels as ocListModelsDefault,
} from "./opencode.mjs";
import { loadJobs as loadDelegateJobsDefault } from "./delegate.mjs";

// Lease TTL for in_flight receipts: these effects are tmux/opencode HTTP
// calls (seconds), so a 2-minute protection window is generous. An in_flight
// receipt past its lease means its owner died mid-effect → unknown.
export const MANTA_CONTROL_LEASE_TTL_MS = 120_000;
export const MANTA_CONTROL_RECEIPTS_CAP = 500;
const RECEIPT_OWNER = "cto-manta-tools";

// Sessions-list bound: the global opencode session enumeration is bounded
// server-side, truncation always visible.
export const SESSIONS_LIST_DEFAULT_LIMIT = 50;
export const SESSIONS_LIST_MAX_LIMIT = 200;

// tmux-safe session/window names: no whitespace, no "." or ":" (target
// syntax). tmux would accept more, but these are the names every later
// `tmux:<sess>:<idx>` target is built from — keep them unambiguous.
const SAFE_NAME_RE = /^[^\s.:][^\s.:]*$/;

// ---------------------------------------------------------------------------
// Errors — stable code + retry-safety on every failure (spec §7).
// ---------------------------------------------------------------------------

export function controlError(code, message, { retrySafe = false, details } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retrySafe = retrySafe;
  if (details !== undefined) error.details = details;
  return error;
}

// Map a raw external (tmux/opencode) error to the stable code set. opencode
// errors carry `.status` when the HTTP call completed: a definitive 4xx is
// not retryable, everything else (5xx, network, unknown) is. Anything not
// carrying a recognizable caller-error shape becomes provider_unavailable.
// Exported so the §7 `work` family (ctoWorkTools.mjs) maps its raw errors
// through the SAME one mapper — never a second error-shaping implementation.
export function toControlError(error) {
  if (error && error.code && typeof error.retrySafe === "boolean") return error;
  const message = String(error?.message ?? error);
  const status = typeof error?.status === "number" ? error.status : null;
  const retrySafe = status === null || status >= 500 || status === 429;
  return controlError("provider_unavailable", message, { retrySafe });
}

// resolveCwdOrThrow's rejection ("working directory does not exist: …") is a
// caller-target problem, not a provider outage.
function mapCwdError(error) {
  if (/does not exist/.test(String(error?.message ?? error))) {
    return controlError("target_not_found", String(error.message), { retrySafe: false });
  }
  return toControlError(error);
}

// resolveNamedModel (delegate.mjs) throws plain Errors; its caller-error
// wordings are re-mapped to `unsupported` so the model gets an actionable,
// non-retryable verdict. Anything else is a catalog/provider failure.
function mapModelResolutionError(error) {
  const message = String(error?.message ?? error);
  if (/^No model matched|^model must be|^Model ".*" is not routable/.test(message)) {
    return controlError("unsupported", message, { retrySafe: false });
  }
  return controlError(`provider_unavailable`, `model catalog unavailable: ${message}`, { retrySafe: true });
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw controlError("unsupported", `${label} must be a non-empty string`);
  }
}

function assertSafeName(value, label) {
  assertNonEmptyString(value, label);
  if (!SAFE_NAME_RE.test(value.trim())) {
    throw controlError(
      "unsupported",
      `${label} ${JSON.stringify(value)} contains whitespace or tmux target syntax (".", ":")`,
    );
  }
}

// Tool args arrive as JSON by construction; a snapshot round-trip both
// deep-clones (so the stored receipt cannot alias caller state) and rejects
// anything JSON-unsafe before the receipt write. Exported because the §7
// `work` family (ctoWorkTools.mjs) snapshots its args through the SAME
// helper — one snapshotting implementation, one mismatch vocabulary.
export function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw controlError("unsupported", `${label} must be a plain object`);
  }
}

export function argsSnapshot(args) {
  if (args === undefined) return {};
  assertPlainObject(args, "args");
  try {
    return JSON.parse(JSON.stringify(args));
  } catch (error) {
    throw controlError("unsupported", `args are not JSON-safe: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Identity resolution — THE one place (see header). Pure.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared operation-receipt runner — the §8.1 reserve → in_flight → execute →
// record lifecycle, extracted from createCtoMantaControl so the §7 `work`
// family (ctoWorkTools.mjs) reuses the EXACT same protocol for family-level
// receipts (work_create — its receipt must predate the envelope it creates)
// instead of growing a second implementation.
// ---------------------------------------------------------------------------
export function createOperationRunner({
  store,
  now = () => Date.now(),
  newId = () => randomUUID(),
  receiptsCap = MANTA_CONTROL_RECEIPTS_CAP,
  leaseTtlMs = MANTA_CONTROL_LEASE_TTL_MS,
  owner = RECEIPT_OWNER,
}) {
  async function runOperation({ key, op, args, execute }) {
      assertNonEmptyString(key, "idempotency key");
      assertNonEmptyString(op, "operation name");
      const snapshot = argsSnapshot(args);
      const argsHash = canonicalArgsHash(op, snapshot);
  
      const reserved = await withControl(store, (data) => {
        const ts = now();
        data.receipts = data.receipts ?? {};
        const existing = data.receipts[key];
        if (existing) {
          if (existing.argsHash !== argsHash) {
            throw controlError(
              "idempotency_key_args_mismatch",
              `idempotency key "${key}" was already used for ${JSON.stringify(existing.op)} with different arguments`,
              { retrySafe: false },
            );
          }
          if (existing.status === "succeeded") return { save: null, value: { action: "replay-success", receipt: existing } };
          if (existing.status === "failed") return { save: null, value: { action: "replay-failure", receipt: existing } };
          if (existing.status === "unknown") {
            throw controlError(
              "external_outcome_unknown",
              `operation "${existing.operationId}" has an UNKNOWN external outcome — reconcile it before re-issuing key "${key}"`,
              { retrySafe: false },
            );
          }
          const leaseLive = existing.lease != null && existing.lease.expiresAt > ts;
          if (existing.status === "in_flight") {
            if (leaseLive) {
              throw controlError(
                "external_outcome_unknown",
                `operation "${existing.operationId}" is currently in flight under key "${key}" — ` +
                  `retry to obtain its result`,
                { retrySafe: true },
              );
            }
            existing.status = "unknown";
            existing.updatedAt = ts;
            return { save: data, value: { action: "throw-unknown", receipt: existing } };
          }
          // pending + live lease: a concurrent duplicate — never double-execute.
          if (leaseLive) {
            throw controlError(
              "external_outcome_unknown",
              `operation "${existing.operationId}" is being issued under key "${key}" — retry to obtain its result`,
              { retrySafe: true },
            );
          }
          // pending + expired lease: the reservation was made but nothing was
          // ever issued — safe resume (take over the SAME receipt).
          existing.lease = { owner, expiresAt: ts + leaseTtlMs };
          existing.takeoverCount = (existing.takeoverCount ?? 0) + 1;
          existing.updatedAt = ts;
          return { save: data, value: { action: "resume", receipt: existing } };
        }
        if (Object.keys(data.receipts).length >= receiptsCap) {
          throw controlError(
            "capacity_wait",
            `the operation-receipt ledger is at its cap (${receiptsCap}) — prune ` +
              `${store.path} (terminal receipts only) before issuing new operations`,
            { retrySafe: true },
          );
        }
        const receipt = {
          key,
          op,
          argsHash,
          args: snapshot,
          status: "pending",
          operationId: `op_${newId()}`,
          resourceId: null,
          result: null,
          error: null,
          lease: { owner, expiresAt: ts + leaseTtlMs },
          takeoverCount: 0,
          createdAt: ts,
          updatedAt: ts,
        };
        data.receipts[key] = receipt;
        return { save: data, value: { action: "start", receipt } };
      });
  
      const { action, receipt } = reserved;
      if (action === "replay-success") {
        return { ok: true, replayed: true, ...receipt.result };
      }
      if (action === "replay-failure") {
        // The cached answer for a known-failed operation: same code, same
        // retry-safety, never a fresh execution.
        return {
          ok: false,
          replayed: true,
          operationId: receipt.operationId,
          key,
          code: receipt.error?.code ?? "external_outcome_unknown",
          retrySafe: receipt.error?.retrySafe === true,
          error: receipt.error?.message ?? "operation previously failed",
        };
      }
      if (action === "throw-unknown") {
        throw controlError(
          "external_outcome_unknown",
          `operation "${receipt.operationId}" was in flight when its lease expired — the external outcome is ` +
            `unknown; reconcile before re-issuing key "${key}"`,
          { retrySafe: false },
        );
      }
  
      // pending → in_flight: persisted IMMEDIATELY BEFORE the external effect,
      // in its own store section (the crash-window marker — an expired
      // in_flight is durably unknown).
      await withControl(store, (data) => {
        const r = data.receipts?.[key];
        if (!r || r.operationId !== receipt.operationId) {
          throw controlError("external_outcome_unknown", `reservation for key "${key}" changed mid-flight`, { retrySafe: true });
        }
        if (r.status !== "pending") {
          throw controlError(
            "external_outcome_unknown",
            `reservation for key "${key}" moved to ${r.status} mid-flight — reconcile before re-issuing`,
            { retrySafe: true },
          );
        }
        r.status = "in_flight";
        r.lease = { owner, expiresAt: now() + leaseTtlMs };
        r.updatedAt = now();
        return { save: data, value: null };
      });
  
      // EXECUTE — the store lock is RELEASED (§8.1: never hold it across an
      // external call). A fresh failure is RECORDED (the receipt replays it
      // forever) and then RETHROWN — the tool wrapper turns it into the
      // {ok:false, code, retrySafe} response; a REPLAY of a failed receipt
      // returns the cached failure as a value instead (it is the answer, not a
      // new event).
      let payload;
      try {
        payload = await execute();
      } catch (error) {
        const err = toControlError(error);
        await withControl(store, (data) => {
          const r = data.receipts?.[key];
          if (!r) return { save: null, value: null };
          r.status = "failed";
          r.error = { code: err.code, message: err.message, retrySafe: err.retrySafe };
          r.resourceId = err.resourceId ?? r.resourceId;
          r.updatedAt = now();
          return { save: data, value: null };
        });
        throw err;
      }
  
    await withControl(store, (data) => {
      const r = data.receipts?.[key];
      if (!r) return { save: null, value: null };
      r.status = "succeeded";
      // Persist the FULL payload — the replay contract ("replaying a terminal
      // receipt returns its ORIGINAL result") means every field the first
      // caller saw is what the replay returns, never a subset.
      r.result = { ...payload, operationId: receipt.operationId, key };
      r.resourceId = payload.resourceId ?? r.resourceId;
      r.updatedAt = now();
      return { save: data, value: null };
    });
    return { ok: true, replayed: false, ...payload, operationId: receipt.operationId, key };
  }
  return { runOperation };
}

// ---------------------------------------------------------------------------
// §4.1 project identity — the durable key, its reconcile plan, and the ONE
// identity surface. All pure (I/O injected); `createProjectIdentityAdapter`
// below is the single production I/O wrapper.
// ---------------------------------------------------------------------------

// A persisted identity record's checkout anchor is usable for rebind matching
// only when it names a SPECIFIC path — never "~" (a window-less session's
// listProjects fallback) or empty.
const UNBINDABLE_DIRS = new Set(["", "~"]);

function rebindAnchor(record) {
  const dir = record?.defaultCwd;
  return typeof dir === "string" && !UNBINDABLE_DIRS.has(dir) ? dir : null;
}

// Orphaned = its name matches no live session (a rename moved the session
// away from the name this record was keyed by).
function recordIsOrphaned(record, projects) {
  const name = record?.tmuxSession;
  return typeof name === "string" && name.length > 0 && !projects.some((p) => p?.tmuxSession === name);
}

// Repository-identity contradiction (§4.1 failure mode 4): the record's cached
// opencode project id and a LIVE observation for the same directory both exist
// and differ → the path now hosts a different repository (remote-less
// recreation forks the id [PROVEN]; a remote attach migrates it [PROVEN]).
// A rename plus an identity change observed together is unresolvable from
// Manta's signals — the rebind is REFUSED, not guessed.
function rebindContradicted(record, observedId) {
  return (
    typeof record?.opencodeProjectId === "string" &&
    record.opencodeProjectId.length > 0 &&
    typeof observedId === "string" &&
    observedId.length > 0 &&
    observedId !== record.opencodeProjectId
  );
}

// Directories the rebind gate could need an opencode project-id observation
// for: every orphaned record's anchor, plus every live session that matches no
// record (a first-sight mint may rebind from an orphan anchored there, or may
// stamp a fresh cache). Bounded; empty in steady state.
export function directoriesNeedingObservation(projects, records) {
  const list = Array.isArray(projects) ? projects : [];
  const recs = Array.isArray(records) ? records : [];
  const dirs = new Set();
  for (const r of recs) {
    const anchor = rebindAnchor(r);
    if (anchor && recordIsOrphaned(r, list)) dirs.add(anchor);
  }
  const named = new Set(recs.map((r) => r?.tmuxSession).filter((n) => typeof n === "string" && n.length > 0));
  for (const p of list) {
    const dir = typeof p?.defaultCwd === "string" ? p.defaultCwd : null;
    if (dir && !UNBINDABLE_DIRS.has(dir) && !named.has(p.tmuxSession)) dirs.add(dir);
  }
  return [...dirs];
}

// First-sight reconcile for a live project that matches NO record: rebind the
// unique orphaned record anchored at the same checkout (rename recognition,
// §4.1), else mint a new project. Appends to the persist plan.
function planAdoptOrMint(project, records, projects, identity, plan) {
  const dir = typeof project?.defaultCwd === "string" ? project.defaultCwd : null;
  const observed = dir != null ? identity.observed?.get(dir) ?? null : null;
  const orphans =
    dir == null
      ? []
      : records.filter((r) => rebindAnchor(r) === dir && recordIsOrphaned(r, projects));
  if (orphans.length === 1 && !rebindContradicted(orphans[0], observed)) {
    const orphan = orphans[0];
    const rebound = {
      ...orphan,
      tmuxSession: project.tmuxSession,
      defaultCwd: dir,
      ...(observed ? { opencodeProjectId: observed } : {}),
    };
    plan.upserts.push(rebound);
    plan.removes.push(orphan.tmuxSession);
    return { projectId: orphan.projectId, record: rebound };
  }
  const record = {
    tmuxSession: project.tmuxSession,
    defaultCwd: dir ?? "",
    projectId: identity.newId(),
    ...(observed ? { opencodeProjectId: observed } : {}),
  };
  plan.upserts.push(record);
  return { projectId: record.projectId, record };
}

// Refresh reconcile for a live project that DOES match a record by name:
// refresh the cwd cache, mint the id IN PLACE when the record predates the
// durable key (migration — never a new project), and ADOPT a mismatched
// opencode id cache (§4.1: "on mismatch, adopt the new value — Manta follows
// rather than fights").
function planRefresh(record, project, identity, plan) {
  const dir = typeof project?.defaultCwd === "string" ? project.defaultCwd : null;
  const changes = {};
  let changed = false;
  if (dir != null && dir !== record.defaultCwd) {
    changes.defaultCwd = dir;
    changed = true;
  }
  let projectId = record.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    projectId = identity.newId();
    changes.projectId = projectId;
    changed = true;
  }
  const observed = dir != null ? identity.observed?.get(dir) ?? null : null;
  if (observed && observed !== record.opencodeProjectId) {
    changes.opencodeProjectId = observed;
    changed = true;
  }
  if (!changed) return { projectId, record };
  const refreshed = { ...record, ...changes };
  plan.upserts.push(refreshed);
  return { projectId, record: refreshed };
}

/**
 * THE identity surface (§4.1). Resolves a target that is either a live tmux
 * session name or a Manta-minted durable `projectId`, and — when an identity
 * context is supplied — reconciles the config records against live state:
 * minting on first sight, migrating id-less records in place, rebinding
 * renamed records, and adopting moved caches. Pure: all I/O arrives via the
 * injected context.
 *
 *   identity = { records, observed?: Map<dir, opencodeProjectId|null>, newId }
 *
 * Returns `{ project }` unchanged for a bare call; with a context it returns
 * `{ project, projectId, record, changed, persistPlan }` where persistPlan is
 * `{ upserts: [record…], removes: [tmuxSession…] }`.
 *
 * Resolution order: exact live name → durable key / stale record name → the
 * historical case-insensitive guards → target_not_found. The rebind matcher
 * keys on the CHECKOUT DIRECTORY (the only signal a rename leaves behind) and
 * refuses on repository-identity contradiction — fail closed, never guessed.
 */
export function resolveProjectIdentity(projects, name, identity = null) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw controlError("unsupported", "project must be a non-empty string");
  }
  const target = name.trim();
  const list = Array.isArray(projects) ? projects : [];
  const exact = list.filter((p) => p?.tmuxSession === target);
  if (exact.length === 1) {
    const project = exact[0];
    if (!identity) return { project };
    const plan = { upserts: [], removes: [] };
    const records = Array.isArray(identity.records) ? identity.records : [];
    const existing = records.find((r) => r?.tmuxSession === project.tmuxSession) ?? null;
    const reconciled = existing
      ? planRefresh(existing, project, identity, plan)
      : planAdoptOrMint(project, records, list, identity, plan);
    return {
      project,
      projectId: reconciled.projectId,
      record: reconciled.record,
      changed: plan.upserts.length > 0 || plan.removes.length > 0,
      persistPlan: plan,
    };
  }
  if (exact.length > 1) {
    throw controlError("target_ambiguous", `project "${target}" matches ${exact.length} live sessions`);
  }

  if (identity) {
    const plan = { upserts: [], removes: [] };
    const records = Array.isArray(identity.records) ? identity.records : [];
    // The durable key is authoritative: a projectId match wins over a stale
    // record-name match (legacy envelopes that still carry a tmux name).
    const byId = records.filter((r) => typeof r?.projectId === "string" && r.projectId === target);
    const candidates = byId.length > 0 ? byId : records.filter((r) => r?.tmuxSession === target);
    if (candidates.length === 1) {
      const record = candidates[0];
      // The record may still be live-claimed under its own name — the durable
      // key resolves straight to it (the common case; nothing to rebind).
      // planRefresh keeps this path's reconcile identical to a name match.
      const own = list.filter((p) => p?.tmuxSession === record.tmuxSession);
      if (own.length === 1) {
        const reconciled = planRefresh(record, own[0], identity, plan);
        return {
          project: own[0],
          projectId: reconciled.projectId,
          record: reconciled.record,
          changed: plan.upserts.length > 0 || plan.removes.length > 0,
          persistPlan: plan,
        };
      }
      // Orphaned: the rebind matcher. Unclaimed live sessions at the record's
      // checkout — a session that already carries its OWN record belongs to
      // that identity, never to this one.
      const anchor = rebindAnchor(record);
      // A CONTESTED anchor — more than one orphaned record anchored at the
      // same checkout — cannot tell which of them the renamed session was.
      // Whoever resolved first would silently win the checkout; that is a
      // guess, so fail closed instead (§4.1: the rename rule never guesses).
      const contested = records.filter((r) => r !== record && rebindAnchor(r) === anchor && recordIsOrphaned(r, list));
      if (contested.length > 0) {
        throw controlError(
          "target_ambiguous",
          `project "${target}" is keyed to checkout ${anchor}, where ${contested.length + 1} orphaned identity records ` +
            `anchor the same path (${[record.tmuxSession, ...contested.map((r) => r.tmuxSession)].map((n) => `"${n}"`).join(", ")}) — ` +
            `which of them renamed is not decidable; re-issue against the live session name`,
          { retrySafe: false, details: { storedCheckout: anchor } },
        );
      }
      const unclaimed = anchor
        ? list.filter(
            (p) =>
              p?.defaultCwd === anchor &&
              !records.some((r) => r?.tmuxSession === p.tmuxSession),
          )
        : [];
      if (unclaimed.length === 1) {
        const observed = identity.observed?.get(anchor) ?? null;
        if (rebindContradicted(record, observed)) {
          throw controlError(
            "target_not_found",
            `project "${target}" is keyed to checkout ${anchor}, but that path now hosts a different ` +
              `repository (cached ${record.opencodeProjectId}, observed ${observed}) — a rename observed ` +
              `together with a repository-identity change is not recoverable; re-issue against the live session`,
            { retrySafe: false, details: { storedCheckout: anchor, cachedRepositoryId: record.opencodeProjectId, observedRepositoryId: observed } },
          );
        }
        const rebound = {
          ...record,
          tmuxSession: unclaimed[0].tmuxSession,
          defaultCwd: anchor,
          ...(observed ? { opencodeProjectId: observed } : {}),
        };
        plan.upserts.push(rebound);
        plan.removes.push(record.tmuxSession);
        return {
          project: unclaimed[0],
          projectId: record.projectId,
          record: rebound,
          changed: true,
          persistPlan: plan,
        };
      }
      if (unclaimed.length === 0) {
        throw controlError(
          "target_not_found",
          `project "${target}" is keyed to checkout ${anchor ?? record?.defaultCwd ?? "?"}, which matches no ` +
            `live session (the checkout may have moved together with the rename, or the session is gone)`,
          { retrySafe: false, details: { storedCheckout: anchor } },
        );
      }
      throw controlError(
        "target_ambiguous",
        `project "${target}" is keyed to checkout ${anchor}, where ${unclaimed.length} live sessions now sit: ` +
          unclaimed.map((p) => `"${p.tmuxSession}"`).join(", ") + " — refusing to guess which one holds the key",
        { retrySafe: false, details: { storedCheckout: anchor } },
      );
    }
    if (candidates.length > 1) {
      throw controlError("target_ambiguous", `project key "${target}" matches ${candidates.length} identity records`);
    }
  }

  const ci = list.filter(
    (p) => typeof p?.tmuxSession === "string" && p.tmuxSession.toLowerCase() === target.toLowerCase(),
  );
  if (ci.length === 1) {
    throw controlError(
      "target_changed",
      `project "${target}" was renamed — its current name is "${ci[0].tmuxSession}" ` +
        `(fail closed; re-issue with the current name)`,
      { retrySafe: false, details: { currentName: ci[0].tmuxSession } },
    );
  }
  if (ci.length > 1) {
    throw controlError(
      "target_ambiguous",
      `project "${target}" case-insensitively matches ${ci.length} sessions: ` +
        ci.map((p) => `"${p.tmuxSession}"`).join(", "),
      { retrySafe: false },
    );
  }
  throw controlError(
    "target_not_found",
    `no project named "${target}" exists on this box (targets are never inferred ` +
      `from the current directory or the first project)`,
    { retrySafe: false },
  );
}

// Cache-adoption plan (§4.1): a live observation that differs from the
// record's cached opencode id is ADOPTED — opencode has already migrated its
// sessions; Manta follows rather than fights. Pure.
export function planCacheAdoption(record, observedOpencodeProjectId) {
  if (!record || typeof record.tmuxSession !== "string" || record.tmuxSession.length === 0) return null;
  if (typeof observedOpencodeProjectId !== "string" || observedOpencodeProjectId.length === 0) return null;
  if (observedOpencodeProjectId === record.opencodeProjectId) return null;
  return { upserts: [{ ...record, opencodeProjectId: observedOpencodeProjectId }], removes: [] };
}

// The single I/O wrapper around the identity surface. Loads the config
// records, observes what the rebind gate could need (bounded — usually zero
// directories), resolves, and persists the plan. `persist: false` (reads)
// resolves identically but writes nothing.
export function createProjectIdentityAdapter({ configGet, observeOpencodeProjectId, persistProjectIdentity, newId }) {
  return async function resolveProject(projects, target, { persist = true } = {}) {
    const cfg = await configGet();
    const records = Array.isArray(cfg?.projects) ? cfg.projects : [];
    const observed = new Map();
    for (const dir of directoriesNeedingObservation(projects, records)) {
      let value = null;
      try {
        value = await observeOpencodeProjectId(dir);
      } catch {
        value = null;
      }
      observed.set(dir, value);
    }
    const outcome = resolveProjectIdentity(projects, target, { records, observed, newId });
    if (persist && outcome.changed && outcome.persistPlan) {
      await persistProjectIdentity(outcome.persistPlan);
    }
    // Cache adoption for the RESOLVED project: the rebind gate observes only
    // orphan candidates, so a name-matched record's stale cache refreshes
    // here — one bounded read, persisted only on mismatch.
    if (persist && outcome.project && outcome.record) {
      const dir = outcome.project.defaultCwd;
      if (typeof dir === "string" && dir.length > 0) {
        let live = null;
        try {
          live = await observeOpencodeProjectId(dir);
        } catch {
          live = null;
        }
        const adoption = planCacheAdoption(outcome.record, live);
        if (adoption) await persistProjectIdentity(adoption);
      }
    }
    return outcome;
  };
}

// Production default observer: the read-only opencode DB lookup by directory.
// Null on any failure — an unobservable id never blocks or guesses. Exported
// so the work family composes the SAME default (one observer, one semantics).
export async function defaultObserveOpencodeProjectId(directory) {
  try {
    return await (await import("./opencodeDb.mjs")).lookupProjectIdByDirectory(directory);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Control-record + receipt store plumbing — same shape as ctoWork's envelope
// adapter: load-strict under the shared per-path lock (one mutex per real
// file path), save only when the mutator says so. Corruption fails loudly.
// ---------------------------------------------------------------------------

function assertValidPayload(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw controlError("unsupported", "manta-control store payload is corrupt (top-level non-object)");
  }
  if (data.receipts !== undefined && (data.receipts === null || typeof data.receipts !== "object" || Array.isArray(data.receipts))) {
    throw controlError("unsupported", "manta-control store receipts are corrupt");
  }
  for (const field of ["projects", "sessions"]) {
    if (data[field] !== undefined && (data[field] === null || typeof data[field] !== "object" || Array.isArray(data[field]))) {
      throw controlError("unsupported", `manta-control store ${field} are corrupt`);
    }
  }
}

function controlAdapter(store) {
  return {
    name: store.name,
    path: store.path,
    load: async () => {
      const data = await store.load();
      assertValidPayload(data);
      return data;
    },
    save: (data) => store.save(data),
  };
}

// One read-modify-write section per control store. `mutator(data)` either
// throws (nothing is written) or returns `{ save, value }` (`save: null` = a
// pure read/replay — no write).
async function withControl(store, mutator) {
  const adapter = controlAdapter(store);
  return lockForStore(adapter).runExclusive(async () => {
    const data = await adapter.load();
    const { save, value } = await mutator(data);
    if (save !== null) await adapter.save(save);
    return value;
  });
}

function projectRecordOf(data, name) {
  return data.projects?.[name] ?? null;
}

// Ensure a control record exists for a resource, returning { record, created }.
function ensureProjectRecord(data, name, ts) {
  data.projects = data.projects ?? {};
  const existing = projectRecordOf(data, name);
  if (existing) return { record: existing, created: false };
  const record = { name, revision: 1, archived: false, createdAt: ts, updatedAt: ts };
  data.projects[name] = record;
  return { record, created: true };
}

function ensureSessionRecord(data, sessionId, ts) {
  data.sessions = data.sessions ?? {};
  const existing = data.sessions[sessionId] ?? null;
  if (existing) return { record: existing, created: false };
  const record = {
    sessionId,
    revision: 1,
    archived: false,
    model: null,
    window: null,
    createdAt: ts,
    updatedAt: ts,
  };
  data.sessions[sessionId] = record;
  return { record, created: true };
}

// The CAS rule for `expectedRevision`: an update may only land on the exact
// revision the caller read. A resource with NO control record has no durable
// revision to CAS against — first-touch updates must omit expectedRevision.
function assertExpectedRevision(record, expectedRevision, label) {
  if (expectedRevision === undefined) return;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw controlError("unsupported", `expectedRevision must be a positive integer (got ${JSON.stringify(expectedRevision)})`);
  }
  if (!record || !Number.isInteger(record.revision)) {
    throw controlError(
      "revision_conflict",
      `${label} has no control record (no durable revision yet) — omit expectedRevision for first-touch, ` +
        `or read the resource first`,
      { retrySafe: false },
    );
  }
  if (record.revision !== expectedRevision) {
    throw controlError(
      "revision_conflict",
      `${label} revision conflict: expected ${expectedRevision}, current ${record.revision} — nothing written; ` +
        `re-read the resource and re-issue`,
      { retrySafe: false },
    );
  }
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function createCtoMantaControl({
  // ---- durable bookkeeping -------------------------------------------------
  store = mantaControlStore,
  now = () => Date.now(),
  newId = () => randomUUID(),
  receiptsCap = MANTA_CONTROL_RECEIPTS_CAP,
  leaseTtlMs = MANTA_CONTROL_LEASE_TTL_MS,
  // ---- READ deps (the ONLY deps the read operations may touch) -------------
  listProjects = lazyTmux().listProjects,
  listSessions = ocListSessionsDefault,
  listModels = ocListModelsDefault,
  configGet = lazyLocal().configGet,
  gitStatus = defaultGitStatus,
  // ---- §4.1 identity deps --------------------------------------------------
  // observeOpencodeProjectId: a READ dep — the opencode project id opencode
  //   currently resolves for a directory (null when unobservable; never a
  //   guess). Feeds the rebind gate and the cache-adoption semantics.
  // persistProjectIdentity: a WRITE dep — applies `{upserts, removes}` to the
  //   `~/.manta/config.json` projects[] records in ONE read-modify-write.
  observeOpencodeProjectId = defaultObserveOpencodeProjectId,
  persistProjectIdentity = lazyLocal().projectIdentityPersist,
  // ---- WRITE deps (mutations only; reads never reference these) ------------
  resolveProjectCwd = defaultResolveProjectCwd,
  resolveCwd = resolveCwdOrThrow,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxRenameSession,
  tmuxRenameWindow,
  ocCreateSession = ocCreateSessionDefault,
  ocForkSession = ocForkSessionDefault,
  ocCompactSession = ocCompactSessionDefault,
  ocDeleteSessionRaw = ocDeleteSessionRawDefault,
  listDelegateJobs = loadDelegateJobsDefault,
  getWindowOption = lazyTmux().getWindowOption,
} = {}) {
  // Production composition needs NO wiring: every omitted dep is the REAL
  // server operation (lazy imports; invoked only at execute time). The engine
  // composes this factory from ITS deps so tests inherit the engine's fakes
  // for reads; injected spies override individual deps everywhere else.
  const tmuxWrites = lazyTmuxWrites();
  const writes = {
    tmuxNewSession: tmuxNewSession ?? tmuxWrites.newSession,
    tmuxNewWindow: tmuxNewWindow ?? tmuxWrites.newWindow,
    tmuxKillSession: tmuxKillSession ?? tmuxWrites.killSession,
    tmuxKillWindow: tmuxKillWindow ?? tmuxWrites.killWindow,
    tmuxRenameSession: tmuxRenameSession ?? tmuxWrites.renameSession,
    tmuxRenameWindow: tmuxRenameWindow ?? tmuxWrites.renameWindow,
  };
  // Receipt protocol — reserve → in_flight → execute → record (lock released
  // across execute; §8.1). The lifecycle lives in the SHARED
  // createOperationRunner above so the §7 `work` family (ctoWorkTools.mjs)
  // reuses the exact same protocol for its own family-level receipts (e.g.
  // work_create, whose receipt must predate the envelope it creates).
  const { runOperation } = createOperationRunner({ store, now, newId, receiptsCap, leaseTtlMs });

  // THE identity adapter — composed once; every resolution in this factory
  // (and ctoWorkTools', via the exported factory) flows through it. Writes
  // persist the reconcile plan; reads resolve identically and write nothing.
  const resolveProject = createProjectIdentityAdapter({
    configGet,
    observeOpencodeProjectId,
    persistProjectIdentity,
    newId,
  });


  // -------------------------------------------------------------------------
  // Shared read primitives (reads ONLY — no dispatch anywhere downstream)
  // -------------------------------------------------------------------------

  async function liveProjects() {
    return listProjects();
  }

  function projectRow(project, data) {
    const record = data ? projectRecordOf(data, project.tmuxSession) : null;
    return {
      name: project.tmuxSession,
      cwd: project.defaultCwd,
      attached: !!project.attached,
      mantaOwned: !!project.mantaOwned,
      windows: (project.windows ?? []).map((w) => ({
        index: w.index,
        name: w.name,
        chat: typeof w.opencodeSessionId === "string" && !!w.opencodeSessionId,
        sessionID: w.opencodeSessionId ?? null,
        owner: w.owner ?? "user",
        worktreePath: w.worktreePath ?? null,
      })),
      archived: record ? record.archived === true : false,
      control: record ? { revision: record.revision, archived: record.archived === true, archivedAt: record.archivedAt ?? null } : null,
    };
  }

  function isDirty(porcelain) {
    return String(porcelain ?? "")
      .split("\n")
      .some((line) => line.trim().length > 0);
  }

  // Live window holding an opencode session, or null.
  function liveWindowFor(projects, sessionId) {
    for (const p of projects) {
      for (const w of p?.windows ?? []) {
        if (w?.opencodeSessionId === sessionId) return { project: p, window: w };
      }
    }
    return null;
  }

  // The global session enumeration (one bounded opencode call). Returns
  // `{ ok, items }`; ok:false means the source is unavailable — callers that
  // NEED existence proof throw provider_unavailable (fail closed).
  async function sessionItems() {
    try {
      const items = await listSessions();
      return { ok: true, items: Array.isArray(items) ? items : [] };
    } catch (error) {
      return { ok: false, error: toControlError(error) };
    }
  }

  function sessionSummary(item) {
    if (!item) return null;
    return {
      title: typeof item?.title === "string" ? item.title : null,
      cost: typeof item?.cost === "number" ? item.cost : null,
      tokens: item?.tokens ?? null,
      updated: item?.time?.updated ?? null,
      directory: typeof item?.directory === "string" ? item.directory : null,
      model: item?.info?.providerID && item?.info?.modelID ? `${item.info.providerID}/${item.info.modelID}` : null,
    };
  }

  // Resolve a session across all three sources (live window, opencode item,
  // control record). Exists in NONE → target_not_found. When the opencode
  // enumeration is unavailable and the session is not provably known
  // otherwise, fail closed with provider_unavailable.
  async function resolveSession(sessionId) {
    assertNonEmptyString(sessionId, "session");
    const projects = await liveProjects();
    const live = liveWindowFor(projects, sessionId);
    const data = await withControl(store, (d) => ({ save: null, value: d }));
    const record = data.sessions?.[sessionId] ?? null;
    if (live || record) {
      const { ok, items, error } = await sessionItems();
      const item = ok ? items.find((s) => s?.id === sessionId) ?? null : null;
      if (!ok && !live) {
        // A control-record-only session with no opencode proof: the record
        // may predate a deletion. Surface the source failure, not a guess.
        throw controlError("provider_unavailable", `cannot verify session "${sessionId}": ${error.message}`, { retrySafe: true });
      }
      return { sessionId, live, record, item, projects };
    }
    const { ok, items, error } = await sessionItems();
    if (!ok) {
      throw controlError("provider_unavailable", `cannot verify session "${sessionId}": ${error.message}`, { retrySafe: true });
    }
    const item = items.find((s) => s?.id === sessionId) ?? null;
    if (!item) {
      throw controlError(
        "target_not_found",
        `no session "${sessionId}" is live, recorded, or present in opencode history`,
        { retrySafe: false },
      );
    }
    return { sessionId, live: null, record: null, item, projects };
  }

  // Model/effort validation → the durable override shape. A caller-named
  // model is matched against the box's model catalog (the same shared fuzzy
  // matcher delegate uses); `effort` is opencode's model `variant`.
  async function resolveModelOverride(model, effort) {
    if (model === undefined && effort === undefined) return null;
    if (effort !== undefined && (typeof effort !== "string" || !effort.trim())) {
      throw controlError("unsupported", "effort must be a non-empty string when provided");
    }
    if (model === undefined) return { effortOnly: true, effort: effort.trim() };
    let catalog = [];
    try {
      catalog = await listModels();
      if (!Array.isArray(catalog)) catalog = [];
    } catch (error) {
      throw mapModelResolutionError(error);
    }
    let resolved;
    try {
      resolved = resolveNamedModel(model, catalog);
    } catch (error) {
      throw mapModelResolutionError(error);
    }
    const override = { providerID: resolved.providerID, modelID: resolved.modelID };
    if (typeof resolved.variant === "string" && resolved.variant) override.variant = resolved.variant;
    else if (effort !== undefined) override.variant = effort.trim();
    return { override };
  }

  // -------------------------------------------------------------------------
  // projects family
  // -------------------------------------------------------------------------

  async function projectsList({ query, includeArchived = true } = {}) {
    const projects = await liveProjects();
    const data = await withControl(store, (d) => ({ save: null, value: d }));
    let rows = projects.map((p) => projectRow(p, data));
    if (typeof query === "string" && query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.cwd ?? "").toLowerCase().includes(q));
    }
    if (!includeArchived) rows = rows.filter((r) => !r.archived);
    return {
      ok: true,
      data: {
        projects: rows,
        total: rows.length,
        observedAt: new Date(now()).toISOString(),
        identity: "tmux-session", // the PROVEN Manta-side identity (see header)
      },
    };
  }

  async function projectsInspect({ project } = {}) {
    const projects = await liveProjects();
    const { project: resolved } = await resolveProject(projects, project, { persist: false });
    const data = await withControl(store, (d) => ({ save: null, value: d }));
    let dirty = null;
    try {
      dirty = isDirty(await gitStatus(resolved.defaultCwd));
    } catch {
      dirty = null; // non-git dir or git missing — visible as null, never a guess
    }
    return { ok: true, data: { ...projectRow(resolved, data), git: { dirty } } };
  }

  async function projectsCreate(input) {
    return runOperation({
      key: input?.key,
      op: "projects.create",
      args: input ?? {},
      execute: async () => {
        assertSafeName(input?.name, "name");
        assertNonEmptyString(input?.cwd, "cwd");
        if (input?.windowName !== undefined) assertSafeName(input.windowName, "windowName");
        const projects = await liveProjects();
        if (projects.some((p) => p.tmuxSession === input.name)) {
          throw controlError("target_exists", `project "${input.name}" already exists`, { retrySafe: false });
        }
        let resolvedCwd;
        try {
          resolvedCwd = resolveCwd(input.cwd); // THE ~-expansion + missing-dir chokepoint
        } catch (error) {
          throw mapCwdError(error);
        }
        const created = await writes.tmuxNewSession({
          name: input.name,
          cwd: resolvedCwd,
          windowName: input.windowName,
          createDir: input.createDir === true,
          chatMode: false,
        });
        // §4.1 — the mint-at-creation trigger: the created project's durable
        // key persists NOW, on the refreshed live row, through the ONE
        // identity surface (an orphan anchored at this checkout rebinds
        // instead — recreate-over-old-key keeps the old key). The tmux write
        // returns the refreshed live list (tmux.newSession's contract).
        try {
          const live = Array.isArray(created?.projects) ? created.projects : [];
          await resolveProject(live.length > 0 ? live : await liveProjects(), input.name);
        } catch {
          // Best-effort mint: the tmux session EXISTS, and the next identity
          // resolution re-mints on first sight. A persist failure here must
          // never turn an accepted create into a failed receipt.
        }
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureProjectRecord(data, input.name, ts);
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        return {
          resourceId: `project:${input.name}`,
          revision: record.revision,
          state: "created",
          changed: true,
          summary: `created project "${input.name}" at ${resolvedCwd}`,
        };
      },
    });
  }

  async function projectsUpdate(input) {
    return runOperation({
      key: input?.key,
      op: "projects.update",
      args: input ?? {},
      execute: async () => {
        assertPlainObject(input, "update input");
        const hasRename = input.rename !== undefined;
        const hasUnarchive = input.unarchive === true;
        if (!hasRename && !hasUnarchive) {
          throw controlError("unsupported", "projects_update requires rename or unarchive: true (empty update)");
        }
        if (hasRename) assertSafeName(input.rename, "rename");
        const projects = await liveProjects();
        const { project: resolved } = await resolveProject(projects, input.project);
        if (hasRename && projects.some((p) => p.tmuxSession === input.rename)) {
          throw controlError("target_exists", `project "${input.rename}" already exists`, { retrySafe: false });
        }
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureProjectRecord(data, resolved.tmuxSession, ts);
          assertExpectedRevision(record, input.expectedRevision, `project "${resolved.tmuxSession}"`);
          if (hasRename) {
            delete data.projects[resolved.tmuxSession];
            record.name = input.rename;
            data.projects[input.rename] = record;
          }
          if (hasUnarchive) record.archived = false;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        if (hasRename) {
          try {
            await writes.tmuxRenameSession({ oldName: resolved.tmuxSession, newName: input.rename });
          } catch (error) {
            // The store rename already happened — mirror the live rename as
            // the record's truth. If tmux failed the old name is still live;
            // move the record back so bookkeeping matches reality.
            await withControl(store, (data) => {
              const moved = data.projects?.[input.rename];
              if (moved) {
                delete data.projects[input.rename];
                moved.name = resolved.tmuxSession;
                moved.revision += 1;
                data.projects[resolved.tmuxSession] = moved;
              }
              return { save: data, value: null };
            });
            throw error;
          }
        }
        return {
          resourceId: `project:${record.name}`,
          revision: record.revision,
          state: "updated",
          changed: true,
          summary:
            `updated project "${record.name}"` +
            (hasRename ? ` (renamed from "${resolved.tmuxSession}")` : "") +
            (hasUnarchive ? " (unarchived)" : ""),
        };
      },
    });
  }

  async function projectsArchive(input) {
    return runOperation({
      key: input?.key,
      op: "projects.archive",
      args: input ?? {},
      execute: async () => {
        const projects = await liveProjects();
        const { project: resolved } = await resolveProject(projects, input.project);
        const ts = now();
        const outcome = await withControl(store, (data) => {
          const { record } = ensureProjectRecord(data, resolved.tmuxSession, ts);
          if (record.archived === true) {
            return { save: data, value: { changed: false, record } };
          }
          record.archived = true;
          record.archivedAt = ts;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: { changed: true, record } };
        });
        return {
          resourceId: `project:${resolved.tmuxSession}`,
          revision: outcome.record.revision,
          state: "archived",
          changed: outcome.changed,
          // Archive destroys NOTHING: the tmux session stays live, every
          // transcript and window is preserved (spec §12).
          summary:
            `archived project "${resolved.tmuxSession}" (metadata only — nothing was destroyed; ` +
            `the session and its history remain intact)`,
        };
      },
    });
  }

  async function projectsRemove(input) {
    return runOperation({
      key: input?.key,
      op: "projects.remove",
      args: input ?? {},
      execute: async () => {
        const projects = await liveProjects();
        const { project: resolved } = await resolveProject(projects, input.project);
        const windows = resolved.windows ?? [];
        const jobWindows = windows.filter((w) => w?.owner === "job");
        if (jobWindows.length > 0) {
          throw controlError(
            "borrowed_resource",
            `project "${resolved.tmuxSession}" has ${jobWindows.length} delegate-job-owned window(s) ` +
              `(indices ${jobWindows.map((w) => w.index).join(", ")}) — resolve them through the delegate ` +
              `job lifecycle before removing the project`,
            { retrySafe: false },
          );
        }
        let dirty = false;
        try {
          dirty = isDirty(await gitStatus(resolved.defaultCwd));
        } catch (error) {
          throw controlError(
            "provider_unavailable",
            `cannot check "${resolved.defaultCwd}" for uncommitted work: ${error?.message ?? error}`,
            { retrySafe: true },
          );
        }
        if (dirty) {
          throw controlError(
            "dirty_resource",
            `project "${resolved.tmuxSession}" has uncommitted changes in ${resolved.defaultCwd} — ` +
              `commit or discard them first (removal would lose work)`,
            { retrySafe: false },
          );
        }
        if (resolved.attached) {
          throw controlError(
            "active_resource",
            `project "${resolved.tmuxSession}" is attached to a client — detach and retry`,
            { retrySafe: true },
          );
        }
        await writes.tmuxKillSession(resolved.tmuxSession);
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureProjectRecord(data, resolved.tmuxSession, ts);
          record.removedAt = ts;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        return {
          resourceId: `project:${resolved.tmuxSession}`,
          revision: record.revision,
          state: "removed",
          changed: true,
          summary:
            `removed project "${resolved.tmuxSession}" (tmux session killed; opencode transcripts ` +
            `preserved in history)`,
        };
      },
    });
  }

  // -------------------------------------------------------------------------
  // sessions family
  // -------------------------------------------------------------------------

  async function sessionsList({ project, includeArchived = true, limit = SESSIONS_LIST_DEFAULT_LIMIT } = {}) {
    const bounded = Math.max(1, Math.min(SESSIONS_LIST_MAX_LIMIT, Math.floor(Number(limit) || SESSIONS_LIST_DEFAULT_LIMIT)));
    const projects = await liveProjects();
    const data = await withControl(store, (d) => ({ save: null, value: d }));
    const { ok, items } = await sessionItems();
    const itemsById = new Map(ok ? items.filter((s) => s?.id).map((s) => [s.id, s]) : []);
    let rows = [];
    const seen = new Set();
    for (const p of projects) {
      for (const w of p?.windows ?? []) {
        if (typeof w?.opencodeSessionId !== "string" || !w.opencodeSessionId) continue;
        seen.add(w.opencodeSessionId);
        rows.push({ sessionId: w.opencodeSessionId, project: p.tmuxSession, windowIndex: w.index, windowName: w.name, live: true });
      }
    }
    for (const [sessionId, record] of Object.entries(data.sessions ?? {})) {
      if (seen.has(sessionId)) {
        const row = rows.find((r) => r.sessionId === sessionId);
        row.archived = record.archived === true;
        continue;
      }
      rows.push({ sessionId, project: record.window?.project ?? null, windowIndex: record.window?.windowIndex ?? null, windowName: null, live: false, archived: record.archived === true });
    }
    for (const item of itemsById.values()) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ sessionId: item.id, project: null, windowIndex: null, windowName: null, live: false, archived: false });
    }
    rows = rows.map((r) => {
      const record = data.sessions?.[r.sessionId] ?? null;
      const summary = sessionSummary(itemsById.get(r.sessionId));
      return {
        sessionID: r.sessionId,
        project: r.project ?? null,
        windowIndex: r.windowIndex ?? null,
        windowName: r.windowName ?? null,
        live: !!r.live,
        archived: r.archived === true || (record ? record.archived === true : false),
        model: record?.model ?? null,
        revision: record?.revision ?? null,
        title: summary?.title ?? null,
      };
    });
    if (project !== undefined) {
      const { project: resolved } = await resolveProject(projects, project, { persist: false });
      rows = rows.filter((r) => r.project === resolved.tmuxSession);
    }
    if (!includeArchived) rows = rows.filter((r) => !r.archived);
    rows.sort((a, b) => (a.live === b.live ? a.sessionID.localeCompare(b.sessionID) : a.live ? -1 : 1));
    return {
      ok: true,
      data: {
        sessions: rows.slice(0, bounded),
        total: rows.length,
        truncated: rows.length > bounded,
        observedAt: new Date(now()).toISOString(),
        identity: "tmux-session",
      },
    };
  }

  async function sessionsInspect({ session } = {}) {
    const resolved = await resolveSession(session);
    const data = await withControl(store, (d) => ({ save: null, value: d }));
    const record = data.sessions?.[resolved.sessionId] ?? null;
    const summary = sessionSummary(resolved.item);
    return {
      ok: true,
      data: {
        sessionID: resolved.sessionId,
        project: resolved.live?.project.tmuxSession ?? record?.window?.project ?? null,
        windowIndex: resolved.live?.window.index ?? record?.window?.windowIndex ?? null,
        windowName: resolved.live?.window.name ?? null,
        owner: resolved.live?.window.owner ?? null,
        worktreePath: resolved.live?.window.worktreePath ?? null,
        live: !!resolved.live,
        archived: record ? record.archived === true : false,
        revision: record?.revision ?? null,
        model: record?.model ?? null,
        title: summary?.title ?? null,
        directory: summary?.directory ?? null,
        cost: summary?.cost ?? null,
        tokens: summary?.tokens ?? null,
        updated: summary?.updated ?? null,
      },
    };
  }

  async function sessionsUsage({ session } = {}) {
    const resolved = await resolveSession(session);
    const summary = sessionSummary(resolved.item);
    return {
      ok: true,
      data: {
        sessionID: resolved.sessionId,
        cost: summary?.cost ?? null,
        tokens: summary?.tokens ?? null,
        updated: summary?.updated ?? null,
      },
    };
  }

  async function sessionsCreate(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.create",
      args: input ?? {},
      execute: async () => {
        assertPlainObject(input, "create input");
        const attach = input.attach !== false;
        const hasProject = input.project !== undefined;
        const hasCwd = input.cwd !== undefined;
        if (!hasProject && !hasCwd) {
          throw controlError(
            "unsupported",
            "sessions_create requires an explicit target: project (a tmux session name) or cwd — " +
              "targets are never inferred from the current directory or the first project",
            { retrySafe: false },
          );
        }
        if (attach && !hasProject) {
          throw controlError("unsupported", "attach requires an explicit project — pass project, or attach:false with an explicit cwd", { retrySafe: false });
        }
        if (hasProject) assertNonEmptyString(input.project, "project");
        if (hasCwd) assertNonEmptyString(input.cwd, "cwd");
        if (input.name !== undefined) assertSafeName(input.name, "name");
        const modelResolved = await resolveModelOverride(input.model, input.effort);
        const override = modelResolved?.override ?? null;
        if (modelResolved?.effortOnly) {
          throw controlError("unsupported", "effort requires a model (pass model, or configure it on a session that already has one)", { retrySafe: false });
        }

        let projectName = null;
        let resolvedCwd;
        if (hasProject) {
          const projects = await liveProjects();
          const { project: resolved } = await resolveProject(projects, input.project);
          projectName = resolved.tmuxSession;
          resolvedCwd = await resolveProjectCwd(projectName, input.cwd, { configGet, listProjects });
        } else {
          try {
            resolvedCwd = resolveCwd(input.cwd);
          } catch (error) {
            throw mapCwdError(error);
          }
        }
        try {
          resolvedCwd = resolveCwd(resolvedCwd); // the chokepoint for BOTH paths
        } catch (error) {
          throw mapCwdError(error);
        }

        let sessionId;
        let windowIndex = null;
        if (attach) {
          const res = await writes.tmuxNewWindow({
            sessionName: projectName,
            windowName: input.name,
            cwd: resolvedCwd,
            chatMode: true,
            oc: { createSession: ocCreateSession },
          });
          sessionId = res.sessionId;
          windowIndex = res.windowIndex;
        } else {
          const sess = await ocCreateSession({ directory: resolvedCwd, title: typeof input.title === "string" ? input.title : "" });
          sessionId = sess.id;
        }
        if (typeof sessionId !== "string" || !sessionId) {
          throw controlError("provider_unavailable", "session creation returned no session id", { retrySafe: true });
        }
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureSessionRecord(data, sessionId, ts);
          record.model = override;
          record.window = attach ? { project: projectName, windowIndex } : record.window;
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        return {
          resourceId: `session:${sessionId}`,
          sessionID: sessionId,
          revision: record.revision,
          state: attach ? "created+attached" : "created",
          changed: true,
          model: override,
          summary:
            `created session ${sessionId}${attach ? ` in project "${projectName}" (window ${windowIndex})` : ` at ${resolvedCwd}`}` +
            (override ? ` on ${override.providerID}/${override.modelID}${override.variant ? ` (effort: ${override.variant})` : ""}` : ""),
        };
      },
    });
  }

  async function sessionsConfigure(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.configure",
      args: input ?? {},
      execute: async () => {
        assertPlainObject(input, "configure input");
        const resolved = await resolveSession(input.session);
        const hasModel = input.model !== undefined;
        const hasEffort = input.effort !== undefined;
        const hasRename = input.renameWindow !== undefined;
        const hasUnarchive = input.unarchive === true;
        if (!hasModel && !hasEffort && !hasRename && !hasUnarchive) {
          throw controlError("unsupported", "sessions_configure requires model, effort, renameWindow, or unarchive: true (empty configure)");
        }
        const modelResolved = await resolveModelOverride(input.model, input.effort);
        let override;
        if (modelResolved?.override) override = modelResolved.override;
        else if (modelResolved?.effortOnly) {
          const existing = await withControl(store, (d) => ({ save: null, value: d.sessions?.[resolved.sessionId] ?? null }));
          if (!existing?.model) {
            throw controlError("unsupported", "effort requires a model — this session has no model override yet", { retrySafe: false });
          }
          override = { ...existing.model, variant: modelResolved.effort };
        }
        if (hasRename) assertSafeName(input.renameWindow, "renameWindow");
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureSessionRecord(data, resolved.sessionId, ts);
          assertExpectedRevision(record, input.expectedRevision, `session "${resolved.sessionId}"`);
          if (override) record.model = override;
          if (hasUnarchive) record.archived = false;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        if (hasRename && resolved.live) {
          try {
            await writes.tmuxRenameWindow({ sessionName: resolved.live.project.tmuxSession, windowIndex: resolved.live.window.index, newName: input.renameWindow });
          } catch (error) {
            throw error; // recorded as failed; the record's semantic fields never moved
          }
        }
        return {
          resourceId: `session:${resolved.sessionId}`,
          sessionID: resolved.sessionId,
          revision: record.revision,
          state: "configured",
          changed: true,
          model: record.model,
          summary:
            `configured session ${resolved.sessionId}` +
            (override ? ` → ${override.providerID}/${override.modelID}${override.variant ? ` (effort: ${override.variant})` : ""}` : "") +
            (hasRename ? ` (window renamed to "${input.renameWindow}")` : "") +
            (hasUnarchive ? " (unarchived)" : ""),
        };
      },
    });
  }

  async function sessionsFork(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.fork",
      args: input ?? {},
      execute: async () => {
        assertPlainObject(input, "fork input");
        const resolved = await resolveSession(input.session);
        const attach = input.attach !== false;
        const modelResolved = await resolveModelOverride(input.model, input.effort);
        const override = modelResolved?.override ?? null;
        if (modelResolved?.effortOnly) {
          throw controlError("unsupported", "effort requires a model (pass model with the fork)", { retrySafe: false });
        }
        if (input.name !== undefined) assertSafeName(input.name, "name");
        let projectName = null;
        if (input.project !== undefined) {
          const { project: resolvedProject } = await resolveProject(resolved.projects, input.project);
          projectName = resolvedProject.tmuxSession;
        } else if (resolved.live) {
          projectName = resolved.live.project.tmuxSession;
        } else if (attach) {
          throw controlError(
            "unsupported",
            `session ${resolved.sessionId} is not attached to any project window — pass project or attach:false`,
            { retrySafe: false },
          );
        }
        let forked;
        try {
          forked = await ocForkSession({ sessionId: resolved.sessionId, messageID: input.messageID });
        } catch (error) {
          throw toControlError(error);
        }
        let windowIndex = null;
        if (attach) {
          if (!projectName) {
            throw controlError("unsupported", "attach requires a project (none resolved)", { retrySafe: false });
          }
          const projectCwd = await resolveProjectCwd(projectName, undefined, { configGet, listProjects });
          let dir;
          try {
            dir = resolveCwd(projectCwd);
          } catch (error) {
            throw mapCwdError(error);
          }
          const res = await writes.tmuxNewWindow({
            sessionName: projectName,
            windowName: input.name,
            cwd: dir,
            chatMode: true,
            existingSessionId: forked.id,
            oc: { createSession: ocCreateSession },
          });
          windowIndex = res.windowIndex;
        }
        const data = await withControl(store, (d) => ({ save: null, value: d }));
        const parentRecord = data.sessions?.[resolved.sessionId] ?? null;
        const ts = now();
        const record = await withControl(store, (fresh) => {
          const { record } = ensureSessionRecord(fresh, forked.id, ts);
          record.model = override ?? parentRecord?.model ?? null;
          record.window = attach ? { project: projectName, windowIndex } : record.window;
          record.updatedAt = ts;
          return { save: fresh, value: record };
        });
        return {
          resourceId: `session:${forked.id}`,
          sessionID: forked.id,
          revision: record.revision,
          state: attach ? "forked+attached" : "forked",
          changed: true,
          model: record.model,
          summary: `forked ${resolved.sessionId} → ${forked.id}` + (attach ? ` in project "${projectName}" (window ${windowIndex})` : ""),
        };
      },
    });
  }

  async function sessionsCompact(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.compact",
      args: input ?? {},
      execute: async () => {
        const resolved = await resolveSession(input?.session);
        try {
          await ocCompactSession(resolved.sessionId);
        } catch (error) {
          throw toControlError(error);
        }
        return {
          resourceId: `session:${resolved.sessionId}`,
          sessionID: resolved.sessionId,
          revision: null, // compaction carries no control-record revision
          state: "compacted",
          changed: true,
          summary: `compaction issued for session ${resolved.sessionId} (opencode summarizes in place)`,
        };
      },
    });
  }

  async function sessionsArchive(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.archive",
      args: input ?? {},
      execute: async () => {
        const resolved = await resolveSession(input?.session);
        const ts = now();
        const outcome = await withControl(store, (data) => {
          const { record } = ensureSessionRecord(data, resolved.sessionId, ts);
          if (record.archived === true) return { save: data, value: { changed: false, record } };
          record.archived = true;
          record.archivedAt = ts;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: { changed: true, record } };
        });
        return {
          resourceId: `session:${resolved.sessionId}`,
          sessionID: resolved.sessionId,
          revision: outcome.record.revision,
          state: "archived",
          changed: outcome.changed,
          summary:
            `archived session ${resolved.sessionId} (metadata only — the opencode session was NOT deleted; ` +
            `history is preserved)`,
        };
      },
    });
  }

  async function sessionsRemove(input) {
    return runOperation({
      key: input?.key,
      op: "sessions.remove",
      args: input ?? {},
      execute: async () => {
        const resolved = await resolveSession(input?.session);
        // Borrow/active protections: the delegate job store is authoritative
        // for job-owned sessions. A RUNNING job's session is active; any job
        // record's session is borrowed (the job's evidence).
        let jobs;
        try {
          jobs = await listDelegateJobs();
          if (!Array.isArray(jobs)) jobs = [];
        } catch (error) {
          throw controlError(
            "provider_unavailable",
            `cannot read the delegate job store to check ownership of session "${resolved.sessionId}": ` +
              `${error?.message ?? error} (fail closed — removal proceeds only once ownership is checkable)`,
            { retrySafe: true },
          );
        }
        const owned = jobs.filter((j) => j?.childSessionID === resolved.sessionId || j?.parentSessionID === resolved.sessionId);
        if (owned.some((j) => j.status === "running")) {
          throw controlError(
            "active_resource",
            `session "${resolved.sessionId}" is running inside ${owned.filter((j) => j.status === "running").length} ` +
              `active delegate job(s) — stop them through the job lifecycle first`,
            { retrySafe: true },
          );
        }
        if (owned.length > 0) {
          throw controlError(
            "borrowed_resource",
            `session "${resolved.sessionId}" is referenced by ${owned.length} delegate job record(s) ` +
              `(${owned.map((j) => j.id ?? "unknown").join(", ")}) — resolve them through the delegate ` +
              `lifecycle before removing the session`,
            { retrySafe: false },
          );
        }
        let alreadyGone = false;
        try {
          await ocDeleteSessionRaw(resolved.sessionId);
        } catch (error) {
          const status = typeof error?.status === "number" ? error.status : null;
          if (status === 404) {
            alreadyGone = true; // definitive proof the goal state is already reached
          } else {
            throw toControlError(error);
          }
        }
        const projects = await liveProjects();
        for (const p of projects) {
          for (const w of p?.windows ?? []) {
            if (w?.opencodeSessionId !== resolved.sessionId) continue;
            // Re-verify the stamp right before the kill: the listing may be
            // moments old, and a window restamped to a DIFFERENT session is
            // no longer ours to kill.
            const stamped = await getWindowOption(p.tmuxSession, w.index, "@manta-session-id");
            if (stamped === resolved.sessionId) {
              await writes.tmuxKillWindow({ sessionName: p.tmuxSession, windowIndex: w.index });
            }
          }
        }
        const ts = now();
        const record = await withControl(store, (data) => {
          const { record } = ensureSessionRecord(data, resolved.sessionId, ts);
          record.removedAt = ts;
          record.revision += 1;
          record.updatedAt = ts;
          return { save: data, value: record };
        });
        return {
          resourceId: `session:${resolved.sessionId}`,
          sessionID: resolved.sessionId,
          revision: record.revision,
          state: "removed",
          changed: !alreadyGone,
          summary: alreadyGone
            ? `session ${resolved.sessionId} was already deleted (nothing to do)`
            : `removed session ${resolved.sessionId} (deleted from opencode; any holding window killed)`,
        };
      },
    });
  }

  return {
    projectsList,
    projectsInspect,
    projectsCreate,
    projectsUpdate,
    projectsArchive,
    projectsRemove,
    sessionsList,
    sessionsInspect,
    sessionsUsage,
    sessionsCreate,
    sessionsConfigure,
    sessionsFork,
    sessionsCompact,
    sessionsArchive,
    sessionsRemove,
  };
}

// Lazy real-tmux write defaults so the factory composes production operations
// without index.mjs wiring (injected spies override them per dep).
function lazyTmuxWrites() {
  return {
    newSession: async (input) => (await import("./tmux.mjs")).newSession(input),
    newWindow: async (input) => (await import("./tmux.mjs")).newWindow(input),
    killSession: async (name) => (await import("./tmux.mjs")).killSession(name),
    killWindow: async (input) => (await import("./tmux.mjs")).killWindow(input),
    renameSession: async (input) => (await import("./tmux.mjs")).renameSession(input),
    renameWindow: async (input) => (await import("./tmux.mjs")).renameWindow(input),
  };
}

// Lazy real tmux/local readers for the same reason (defaults, invoked lazily).
function lazyTmux() {
  return new Proxy({}, { get: (_t, prop) => async (...args) => (await import("./tmux.mjs"))[prop](...args) });
}
function lazyLocal() {
  return new Proxy({}, { get: (_t, prop) => async (...args) => (await import("./local.mjs"))[prop](...args) });
}

// Default git porcelain reader — matches the engine's gitStatus dep contract
// (porcelain stdout string; a non-git dir or missing git yields "").
function defaultGitStatus(cwd) {
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

// ---------------------------------------------------------------------------
// Tool registration — the production composition boundary. Each operation is
// ONE tool with an ACTION-SPECIFIC params schema (discriminated by the family
// prefix; no shared unvalidated args bag). Reads are mode "auto"; every
// mutation is mode "confirm" (a side effect needs the user's go-ahead, the
// same rule the `watch` tool already established).
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(["projects_list", "projects_inspect", "sessions_list", "sessions_inspect", "sessions_usage"]);

export function registerCtoMantaControlTools(register, control) {
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
          const err = toControlError(error);
          return { ok: false, code: err.code, retrySafe: err.retrySafe, error: err.message };
        }
      },
    });

  def(
    "projects_list",
    "List the box's projects (a project IS a tmux session: name + resolved cwd — the proven Manta-side identity). " +
      "Per project: cwd, windows (chat flag, opencode session id, owner user/job), archived flag, mantaOwned. " +
      "Optional substring query; includeArchived:false hides archived. Read-only.",
    {
      query: { type: "string", description: "Optional substring filter on name/cwd." },
      includeArchived: { type: "boolean", description: "Include archived projects (default true)." },
    },
    (args) => control.projectsList(args),
  );

  def(
    "projects_inspect",
    "Inspect ONE project by its exact tmux session name: windows with stamps, control record (revision, archived), " +
      "git dirty state. Fails CLOSED on unknown/renamed/ambiguous names — never infers a target. Read-only.",
    { project: { type: "string", description: "The exact tmux session name." } },
    (args) => control.projectsInspect(args),
  );

  def(
    "projects_create",
    "Create a project (tmux session) with an EXPLICIT cwd. Validates the name (no whitespace/./:), refuses an " +
      "existing name, resolves ~ and rejects a missing directory before anything is created. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key (replays the original result)." },
      name: { type: "string", description: "New tmux session name (no whitespace, '.', ':')." },
      cwd: { type: "string", description: "Working directory (absolute or ~-prefixed; must exist unless createDir)." },
      windowName: { type: "string", description: "Optional initial window name." },
      createDir: { type: "boolean", description: "mkdir -p the cwd first (default false)." },
    },
    (args) => control.projectsCreate(args),
  );

  def(
    "projects_update",
    "Update a project: rename (the identity is the tmux session name — renames surface to every later call) or " +
      "unarchive. Takes expectedRevision (optimistic concurrency); conflicting revision → revision_conflict.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      project: { type: "string", description: "The exact current tmux session name." },
      expectedRevision: { type: "number", description: "The control-record revision you read (omit for first-touch)." },
      rename: { type: "string", description: "New tmux session name." },
      unarchive: { type: "boolean", description: "Clear the archived flag." },
    },
    (args) => control.projectsUpdate(args),
  );

  def(
    "projects_archive",
    "Archive a project: metadata only — NOTHING is destroyed, the tmux session stays live, transcripts preserved. " +
      "Destructive removal is a DIFFERENT request (projects_remove). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      project: { type: "string", description: "The exact tmux session name." },
    },
    (args) => control.projectsArchive(args),
  );

  def(
    "projects_remove",
    "Remove a project: kills the tmux session (opencode transcripts are PRESERVED — history is never deleted). " +
      "Refuses: delegate-owned windows (borrowed_resource), uncommitted changes (dirty_resource), an attached " +
      "client (active_resource). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      project: { type: "string", description: "The exact tmux session name." },
    },
    (args) => control.projectsRemove(args),
  );

  def(
    "sessions_list",
    "List sessions: live chat windows (by project), control-record sessions (created bare / archived), and the " +
      "opencode enumeration — with the durable model override, archived flag and title. Optional project filter. Read-only.",
    {
      project: { type: "string", description: "Optional exact project (tmux session) filter." },
      includeArchived: { type: "boolean", description: "Include archived sessions (default true)." },
      limit: { type: "number", description: "Max rows (default 50, max 200); truncated flag when cut." },
    },
    (args) => control.sessionsList(args),
  );

  def(
    "sessions_inspect",
    "Inspect ONE session: project/window placement, durable model override, archive/revision state, title, cost and " +
      "token totals. Read-only.",
    { session: { type: "string", description: "The opencode session id." } },
    (args) => control.sessionsInspect(args),
  );

  def(
    "sessions_usage",
    "Per-session cost and token totals (input/output) as opencode reports them. Read-only.",
    { session: { type: "string", description: "The opencode session id." } },
    (args) => control.sessionsUsage(args),
  );

  def(
    "sessions_create",
    "Create a session in an EXPLICIT project (chat-mode window via the UI's own creation path) or at an explicit " +
      "cwd (bare opencode session). Server-owned model/effort: validated against the box catalog and persisted " +
      "durably on the control record — never a renderer model-switch event. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      project: { type: "string", description: "Target project (exact tmux session name) — required for attach." },
      cwd: { type: "string", description: "Optional cwd override / the target when project is omitted." },
      name: { type: "string", description: "Window name (attach)." },
      attach: { type: "boolean", description: "Create a chat window in the project (default true) vs a bare session." },
      model: { type: "string", description: "Model for this session (free text or provider/model)." },
      effort: { type: "string", description: "Model effort/variant (requires model)." },
      title: { type: "string", description: "Session title (bare sessions)." },
    },
    (args) => control.sessionsCreate(args),
  );

  def(
    "sessions_configure",
    "Configure a session: server-owned model/effort (durable, validated), window rename (when attached), or " +
      "unarchive. Takes expectedRevision for optimistic concurrency. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      session: { type: "string", description: "The opencode session id." },
      expectedRevision: { type: "number", description: "The control-record revision you read (omit for first-touch)." },
      model: { type: "string", description: "Model for this session (free text or provider/model)." },
      effort: { type: "string", description: "Model effort/variant (requires a model on this or a prior request)." },
      renameWindow: { type: "string", description: "New tmux window name (attached sessions)." },
      unarchive: { type: "boolean", description: "Clear the archived flag." },
    },
    (args) => control.sessionsConfigure(args),
  );

  def(
    "sessions_fork",
    "Fork a session (copies history up to messageID into a new session) and, by default, attach the fork as a " +
      "chat window in the parent's project (or an explicit project). Inherits the parent's model override unless " +
      "model is given. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      session: { type: "string", description: "The parent opencode session id." },
      messageID: { type: "string", description: "Fork point (omit to copy everything)." },
      project: { type: "string", description: "Explicit project for the fork's window (defaults to the parent's)." },
      name: { type: "string", description: "Window name (attach)." },
      attach: { type: "boolean", description: "Attach a chat window (default true)." },
      model: { type: "string", description: "Model override for the fork." },
      effort: { type: "string", description: "Model effort/variant (requires model)." },
    },
    (args) => control.sessionsFork(args),
  );

  def(
    "sessions_compact",
    "Compact a session: opencode summarizes it in place to free context (the existing compaction facility, not a " +
      "second summarizer). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      session: { type: "string", description: "The opencode session id." },
    },
    (args) => control.sessionsCompact(args),
  );

  def(
    "sessions_archive",
    "Archive a session: metadata only — the opencode session is NOT deleted, history stays readable (spec §12: " +
      "never implement archive via a delete API). Deletion is a DIFFERENT request (sessions_remove). Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      session: { type: "string", description: "The opencode session id." },
    },
    (args) => control.sessionsArchive(args),
  );

  def(
    "sessions_remove",
    "Remove a session: deletes it from opencode AND kills any window still stamped with it. Refuses sessions owned " +
      "by delegate jobs (active while running, borrowed once recorded) rather than losing job evidence. Idempotent via key.",
    {
      key: { type: "string", description: "Stable idempotency key." },
      session: { type: "string", description: "The opencode session id." },
    },
    (args) => control.sessionsRemove(args),
  );
}
