// src/server/ctoBinding.mjs — the durable singleton CTO conversation binding
// (unified-cto-spec §3.1, phase P3a1).
//
// ONE durable opencode session is bound to the box's CTO role. Its opencode
// directory is a stable server-owned control directory under the state home —
// never a user repository, never an implicit implementation target. The
// binding itself is a small versioned record in the CTO store: generation,
// current session id, previous session ids, and a reserve-before-create
// operation marker that recovers a role session whose remote create landed
// but whose bind was lost to a crash.
//
// Scope (deliberately small): ensure / recover / getBinding. NOT here —
// prompt admission (P3a2), any UI or public route, the delegate extension,
// session deletion (P6). The role session is DURABLE: its title never carries
// the ephemeral reaper's `cto:` prefix and it is never registered with any
// TTL'd registry — only with the never-swept provenance tombstones, so
// pipeline readers classify it as CTO-owned rather than user activity.
//
// Identity rule (spec: "A title match alone is not proof of ownership"): a
// session is adopted ONLY on an exact metadata marker match — `metadata.role
// === "cto_conversation"` AND `metadata.bindingOperation === <the reserved
// operation id>` — verified by direct read-back, never by list title. The
// marker is stamped on the session at create time (P0 live probes:
// docs/cto-implementation-map.md §1/§8 — metadata round-trips verbatim).
// Uncertainty (transient opencode errors, a marker outside the provable
// window of `GET /session`'s newest-100 page) is reported as such and never
// resolved by guessing or by blindly creating a replacement.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { writeJsonAtomic } from "./jsonStore.mjs";
import { bindingStore, internalSessionsStore, patchStore } from "./ctoStores.mjs";
import { createInternalSessions } from "./internalSessions.mjs";

// Role provenance vocabulary (spec §3.1). The full four-way split
// (cto_conversation / cto_worker / cto_internal / user_session) lands with the
// admission phase; P3a1 pins the conversation role on the session marker and
// registers the durable session in the CTO-owned tombstone store.
export const BINDING_ROLE = "cto_conversation";

// The role session's title. MUST NOT start with the ephemeral reaper's
// `cto:` prefix (ctoSessions.CTO_TITLE_PREFIX) — the reaper deletes sessions
// by title prefix, and the durable conversation must never be reaped. Pinned
// by a test against the imported constant.
export const ROLE_SESSION_TITLE = "Manta CTO conversation";

// Marker file inside the control directory. Byte-static (no timestamp) so
// re-writing it is idempotent.
export const CONTROL_MARKER_FILENAME = "cto-control-directory.json";

// opencode caps unscoped `GET /session` at the 100 most-recently-updated
// sessions box-wide (docs/cto-implementation-map.md §1, sessionExists note).
const LIST_PAGE_CAP = 100;

export const PREVIOUS_SESSION_IDS_CAP = 10;
export const RECONCILE_ATTEMPTS = 3;
export const RECONCILE_BACKOFF_MS = 150;
export const RECEIPT_ATTEMPTS = 3;

export class CtoBindingError extends Error {
  constructor(message, code, { cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "CtoBindingError";
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stable server-owned CTO control directory (under the state home). */
export function defaultControlDir() {
  return statePath("cto", "conversation");
}

/** The identity marker stamped onto the created session's metadata. */
export function markerFor(op) {
  return {
    role: BINDING_ROLE,
    bindingOperation: op.operation,
    bindingGeneration: op.generation,
    boundAt: op.startedAt,
  };
}

/** Exact identity match — role AND the exact operation id. Never title. */
export function isMarkerSession(session, operation) {
  const metadata = session?.metadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    metadata.role === BINDING_ROLE &&
    metadata.bindingOperation === operation
  );
}

/** Dedupe + keep the most recent archives, capped. */
export function capPrevious(ids, cap = PREVIOUS_SESSION_IDS_CAP) {
  return [...new Set(ids)].slice(-cap);
}

// ---------------------------------------------------------------------------
// Binding record normalization — fail loudly on any shape violation (spec
// §8.2: corrupt state is visible unhealthy state, never silently "unbound",
// which would create a duplicate role session).
// ---------------------------------------------------------------------------

function invalidState(what, value) {
  return new CtoBindingError(
    `binding store payload has invalid ${what}: ${JSON.stringify(value)}`,
    "invalid-state",
  );
}

function normalizePending(op) {
  if (op === null || op === undefined) return null;
  if (typeof op !== "object" || Array.isArray(op)) throw invalidState("pendingOperation", op);
  for (const key of ["operation", "directory"]) {
    if (typeof op[key] !== "string" || op[key].length === 0) throw invalidState(`pendingOperation.${key}`, op[key]);
  }
  if (!Number.isInteger(op.generation) || op.generation < 1) throw invalidState("pendingOperation.generation", op.generation);
  if (!Number.isInteger(op.startedAt) || op.startedAt < 0) throw invalidState("pendingOperation.startedAt", op.startedAt);
  return { operation: op.operation, generation: op.generation, directory: op.directory, startedAt: op.startedAt };
}

export function normalizeBinding(payload) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const generation = p.generation ?? 0;
  if (!Number.isInteger(generation) || generation < 0) throw invalidState("generation", p.generation);
  const currentSessionId = p.currentSessionId ?? null;
  const currentOperation = p.currentOperation ?? null;
  if (currentSessionId !== null && (typeof currentSessionId !== "string" || currentSessionId.length === 0)) {
    throw invalidState("currentSessionId", p.currentSessionId);
  }
  if (currentSessionId !== null && (typeof currentOperation !== "string" || currentOperation.length === 0)) {
    throw invalidState("currentOperation (bound session without its creation operation)", p.currentOperation);
  }
  if (currentSessionId === null && currentOperation !== null) {
    throw invalidState("currentOperation (present without a bound session)", p.currentOperation);
  }
  const previous = p.previousSessionIds ?? [];
  if (!Array.isArray(previous) || previous.some((id) => typeof id !== "string" || id.length === 0)) {
    throw invalidState("previousSessionIds", p.previousSessionIds);
  }
  return {
    generation,
    currentSessionId,
    currentOperation,
    previousSessionIds: [...previous],
    pendingOperation: normalizePending(p.pendingOperation),
  };
}

/**
 * Build the durable singleton CTO conversation binding service.
 *
 * @param {object} deps
 * @param {{ createSession: Function, listSessions: Function, readSession: Function }} deps.oc
 *        The opencode client (production: the matching exports of
 *        src/server/opencode.mjs). No other oc surface is touched — in
 *        particular ensure()/recover()/getBinding() never send a prompt or
 *        resolve a model.
 * @param {object} [deps.store] Binding store (default: ctoStores.bindingStore,
 *        strict — corrupt payloads throw, never silently read as unbound).
 * @param {object} [deps.provenanceStore] Never-swept ownership tombstones
 *        (default: ctoStores.internalSessionsStore) — the reader seam that
 *        makes provenance classifiers see the durable session as CTO-owned.
 * @param {Function} [deps.createProvenance] internalSessions factory (injected).
 * @param {string} [deps.controlDir] The role session's opencode directory.
 * @param {Function} [deps.now] @param {Function} [deps.newId] @param {Function} [deps.sleep]
 * @param {number} [deps.reconcileAttempts] @param {number} [deps.reconcileBackoffMs]
 * @returns {{ ensure: () => Promise<object>, recover: () => Promise<object>, getBinding: () => Promise<object> }}
 */
export function createCtoBinding({
  oc,
  store = bindingStore,
  provenanceStore = internalSessionsStore,
  createProvenance = createInternalSessions,
  controlDir = defaultControlDir(),
  now = () => Date.now(),
  newId = () => randomUUID(),
  sleep = defaultSleep,
  reconcileAttempts = RECONCILE_ATTEMPTS,
  reconcileBackoffMs = RECONCILE_BACKOFF_MS,
} = {}) {
  if (
    !oc ||
    typeof oc.createSession !== "function" ||
    typeof oc.listSessions !== "function" ||
    typeof oc.readSession !== "function"
  ) {
    throw new Error("createCtoBinding requires an oc client with createSession, listSessions and readSession");
  }
  const provenance = createProvenance({ store: provenanceStore });

  async function loadBinding() {
    try {
      return normalizeBinding(await store.load());
    } catch (err) {
      if (err instanceof CtoBindingError) throw err;
      throw new CtoBindingError(
        `binding store unreadable — refusing to create or recover a role session on top of unhealthy state: ${err?.message ?? err}`,
        "store-unreadable",
        { cause: err },
      );
    }
  }

  /**
   * The control directory: exists, owned (0700 at creation), marked, and
   * never a repository (spec §3.1: the control directory "is never an
   * implicit target for implementation" — a .git there means it stopped
   * being a control directory).
   */
  async function ensureControlDirectory() {
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    if (existsSync(join(controlDir, ".git"))) {
      throw new CtoBindingError(
        `CTO control directory ${controlDir} contains a .git — refusing to bind the role session to a repository`,
        "control-directory-repository",
      );
    }
    await writeJsonAtomic(
      join(controlDir, CONTROL_MARKER_FILENAME),
      JSON.stringify(
        {
          kind: "manta-cto-control-directory",
          role: BINDING_ROLE,
          note: "Server-owned CTO control directory — not a repository; never an implicit implementation target.",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  /**
   * Register the durable session in the never-swept provenance tombstones —
   * the one reader seam (internalSessions) that classifies sessions as
   * CTO-owned. Deliberately NOT the TTL'd ephemeral machinery: the durable
   * conversation is never registered with the reaper or any expiry.
   */
  async function registerProvenance(sessionId, actions) {
    try {
      const finish = provenance.beginInternalSession();
      await finish(sessionId);
    } catch (err) {
      actions?.push({ action: "provenance-failed", sessionId, error: String(err?.message ?? err) });
    }
  }

  /**
   * Marker scan with bounded retries. Returns
   *   { state: "found", sessionId }      — exact marker, verified by direct read-back
   *   { state: "absent", reason }        — healthy scan, definitively never created
   *   { state: "unknown", reason }       — transient / unprovable; reservation stays
   *
   * Absence is DEFINITIVE only while the op's session could not have scrolled
   * off `GET /session`'s newest-100 page: the page must be non-full, or its
   * oldest entry must predate the operation's reservation instant (a session
   * created at ~startedAt ranks above anything older, so it would be on the
   * page). A full page of entries all newer than the op proves nothing —
   * that is uncertainty, not absence, and never a timeout-based replacement.
   */
  async function findSessionByMarker(pending) {
    let lastReason = "attempts-exhausted";
    for (let attempt = 1; attempt <= reconcileAttempts; attempt++) {
      if (attempt > 1) await sleep(reconcileBackoffMs * (attempt - 1));
      let sessions;
      try {
        sessions = await oc.listSessions();
      } catch (err) {
        lastReason = `list-sessions-failed: ${err?.message ?? err}`;
        continue;
      }
      const list = Array.isArray(sessions) ? sessions : [];
      const hit = list.find((s) => isMarkerSession(s, pending.operation));
      if (hit?.id) {
        // The list hit is a hint; the direct read-back is the receipt.
        const read = await oc.readSession(hit.id);
        if (read.state === "found" && isMarkerSession(read.session, pending.operation)) {
          return { state: "found", sessionId: hit.id };
        }
        lastReason = `list-hit-${hit.id}-unverified-${read.state}`;
        continue;
      }
      const pageDates = list
        .map((s) => s?.time?.updated ?? s?.time?.created ?? s?.created ?? null)
        .filter((t) => typeof t === "number");
      const pageProvesWindow = list.length < LIST_PAGE_CAP
        ? true
        : pageDates.length === list.length && Math.min(...pageDates) < pending.startedAt;
      if (pageProvesWindow) {
        return { state: "absent", reason: "marker-absent-in-provable-window" };
      }
      return { state: "unknown", reason: "marker-absent-beyond-list-page-window" };
    }
    return { state: "unknown", reason: lastReason };
  }

  /**
   * Resolve a reserved operation left by this or a previous process: adopt
   * the created session by exact marker, or clear the reservation once
   * absence is definitive. Never creates here — creation happens only from a
   * clean slate in ensure().
   */
  async function reconcilePending(binding, actions) {
    const pending = binding.pendingOperation;
    if (!pending) return binding;
    const scan = await findSessionByMarker(pending);
    if (scan.state === "found") {
      const next = await patchStore(store, (fresh) => {
        const base = normalizeBinding(fresh);
        if (base.pendingOperation?.operation !== pending.operation) return {};
        const previous =
          base.currentSessionId && base.currentSessionId !== scan.sessionId
            ? capPrevious([...base.previousSessionIds, base.currentSessionId])
            : base.previousSessionIds;
        return {
          generation: Math.max(base.generation, pending.generation),
          currentSessionId: scan.sessionId,
          currentOperation: pending.operation,
          previousSessionIds: previous,
          pendingOperation: undefined,
        };
      });
      const base = normalizeBinding(next);
      if (base.currentSessionId === scan.sessionId) {
        actions.push({ action: "adopted", operation: pending.operation, sessionId: scan.sessionId });
        await registerProvenance(scan.sessionId, actions);
      }
      return base;
    }
    if (scan.state === "absent") {
      const next = await patchStore(store, (fresh) => {
        const base = normalizeBinding(fresh);
        if (base.pendingOperation?.operation !== pending.operation) return {};
        return { pendingOperation: undefined };
      });
      actions.push({ action: "reservation-cleared", operation: pending.operation, reason: scan.reason });
      return normalizeBinding(next);
    }
    actions.push({ action: "reconcile-unknown", operation: pending.operation, reason: scan.reason });
    return binding;
  }

  /**
   * Verify the currently bound session. "found" requires the exact marker —
   * a live session whose metadata no longer matches is "mismatch" (surfaced,
   * never adopted blindly, never replaced from).
   */
  async function verifyCurrent(binding) {
    const read = await oc.readSession(binding.currentSessionId);
    if (read.state === "found") {
      return isMarkerSession(read.session, binding.currentOperation) ? { state: "found" } : { state: "mismatch" };
    }
    return read;
  }

  /**
   * Reserve → create → verify receipt → bind. The reservation is a single
   * serialized store read-modify-write (no lock held across the external
   * create); the marker rides on the create itself, so a crash anywhere
   * leaves a recoverable reservation instead of an unidentifiable session.
   */
  async function reserveCreateAndBind(binding, actions) {
    const op = {
      operation: newId(),
      generation: binding.generation + 1,
      directory: controlDir,
      startedAt: now(),
    };
    const reserved = await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation) return {}; // a concurrent reservation wins; caller re-reconciles
      return { pendingOperation: op };
    });
    if (normalizeBinding(reserved).pendingOperation?.operation !== op.operation) {
      throw new CtoBindingError("binding reservation deferred to a concurrent operation", "deferred");
    }

    let session;
    try {
      session = await oc.createSession({
        directory: op.directory,
        title: ROLE_SESSION_TITLE,
        metadata: markerFor(op),
      });
    } catch (err) {
      // Unknown outcome: the create may or may not have landed. The
      // reservation deliberately STAYS — the next ensure/recover reconciles
      // by exact marker before any retry. Never clear-and-blind-retry here.
      throw new CtoBindingError(
        `role-session create failed with unknown outcome (operation ${op.operation} kept for recovery): ${err?.message ?? err}`,
        "create-unknown",
        { cause: err },
      );
    }
    if (typeof session?.id !== "string" || session.id.length === 0) {
      throw new CtoBindingError("opencode createSession returned no session id", "unidentifiable-create");
    }

    // Receipt: a 2xx from the create alone is not proof (P0 map guard rails).
    // Bind only once the marker is verified on the record itself.
    let receipt = null;
    for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(reconcileBackoffMs);
      const read = await oc.readSession(session.id);
      if (read.state === "found") {
        if (!isMarkerSession(read.session, op.operation)) {
          throw new CtoBindingError(
            `opencode did not persist the binding metadata marker on ${session.id} — role-session creation is ` +
              `not identifiable (spec §3.1); refusing to bind. The created session is left unbound for investigation.`,
            "unidentifiable-create",
          );
        }
        receipt = read.session;
        break;
      }
      if (read.state === "missing") {
        throw new CtoBindingError(
          `created role session ${session.id} is immediately missing — refusing to bind (operation ${op.operation} kept for recovery)`,
          "unidentifiable-create",
        );
      }
    }
    if (!receipt) {
      throw new CtoBindingError(
        `could not verify the created role session ${session.id} (lookup stayed unknown) — operation ${op.operation} kept for recovery`,
        "unknown-state",
      );
    }

    const bound = await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation?.operation !== op.operation) return {};
      const previous =
        base.currentSessionId && base.currentSessionId !== session.id
          ? capPrevious([...base.previousSessionIds, base.currentSessionId])
          : base.previousSessionIds;
      return {
        generation: op.generation,
        currentSessionId: session.id,
        currentOperation: op.operation,
        previousSessionIds: previous,
        pendingOperation: undefined,
      };
    });
    const base = normalizeBinding(bound);
    if (base.currentSessionId !== session.id) {
      throw new CtoBindingError(
        `binding for operation ${op.operation} was resolved concurrently — created session ${session.id} left for reconciliation`,
        "deferred",
      );
    }
    actions.push({ action: "created", generation: op.generation, sessionId: session.id });
    await registerProvenance(session.id, actions);
    return base;
  }

  async function ensureOnce() {
    await ensureControlDirectory();
    const actions = [];
    let binding = await loadBinding();
    let lastError = null;
    for (let attempt = 1; attempt <= reconcileAttempts; attempt++) {
      if (attempt > 1) await sleep(reconcileBackoffMs * (attempt - 1));
      // Every attempt reconciles against FRESH store state: a previous
      // attempt's failed create left a reservation this attempt must resolve
      // (adopt or prove absent) before any retry.
      binding = await reconcilePending(await loadBinding(), actions);
      if (binding.pendingOperation) {
        lastError = new CtoBindingError(
          `binding has an unreconciled creation operation (${binding.pendingOperation.operation}) — opencode state is ` +
            `unknown after ${reconcileAttempts} attempts; refusing to create a duplicate. Retry once opencode is reachable, or run recover().`,
          "unknown-state",
        );
        continue;
      }
      if (binding.currentSessionId) {
        const verdict = await verifyCurrent(binding);
        if (verdict.state === "found") {
          return { binding, created: false, actions };
        }
        if (verdict.state === "unknown" || verdict.state === "mismatch") {
          // Transient failure or an identity that no longer matches: a timeout
          // is NEVER absence — returning the binding as-is can't duplicate.
          actions.push({ action: "uncertain", reason: verdict.state, sessionId: binding.currentSessionId });
          return { binding, created: false, uncertain: true, uncertainReason: verdict.state, actions };
        }
        // Definitive absence (404) → replacement generation, history preserved.
      }
      const wasBound = binding.currentSessionId !== null;
      try {
        binding = await reserveCreateAndBind(binding, actions);
        return { binding, created: true, replaced: wasBound, actions };
      } catch (err) {
        lastError = err;
        // Unknown outcome — reservation kept; the next attempt reconciles it
        // by exact marker before retrying anything.
      }
    }
    throw lastError instanceof CtoBindingError
      ? lastError
      : new CtoBindingError(
          `ensure failed after ${reconcileAttempts} bounded attempts: ${lastError?.message ?? lastError}`,
          "retries-exhausted",
          { cause: lastError },
        );
  }

  async function recoverOnce() {
    await ensureControlDirectory();
    const actions = [];
    let binding = await loadBinding();
    binding = await reconcilePending(binding, actions);
    if (binding.pendingOperation) {
      actions.push({ action: "pending-unresolved", operation: binding.pendingOperation.operation });
      return { binding, actions, uncertain: true };
    }
    if (!binding.currentSessionId) {
      // Nothing bound — creation is ensure()'s job, not recovery's.
      return { binding, actions };
    }
    const verdict = await verifyCurrent(binding);
    if (verdict.state === "found") {
      return { binding, actions };
    }
    if (verdict.state === "unknown" || verdict.state === "mismatch") {
      actions.push({ action: "uncertain", reason: verdict.state, sessionId: binding.currentSessionId });
      return { binding, actions, uncertain: true };
    }
    binding = await reserveCreateAndBind(binding, actions);
    actions.push({ action: "replaced", generation: binding.generation, sessionId: binding.currentSessionId });
    return { binding, actions, replaced: true };
  }

  // Singleflight: concurrent ensure() calls join ONE flight, so concurrent
  // opens (desktop + phone) produce exactly one creation. The reservation
  // itself is a store-local mutex scope — never held across the create.
  let flight = null;
  function ensure() {
    if (!flight) {
      flight = ensureOnce().finally(() => {
        flight = null;
      });
    }
    return flight;
  }

  return {
    ensure,
    recover: recoverOnce,
    /** Store read only — zero opencode calls, zero model turns. */
    getBinding: async () => loadBinding(),
  };
}
