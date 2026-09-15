// src/server/ctoBinding.mjs — the durable singleton CTO conversation binding
// (unified-cto-spec §3.1, phase P3a1).
//
// ONE durable opencode session is bound to the box's CTO role. Its opencode
// directory is a stable server-owned control directory under the state home —
// never a user repository, never an implicit implementation target. The
// binding itself is a small versioned record in the CTO store: generation,
// current session id, the full previous-session-id archive (never capped,
// never dropped — replacements are rare and queries paginate), and a
// reserve-before-create operation marker that recovers a role session whose
// remote create landed but whose bind was lost to a crash.
//
// Scope (deliberately small): ensure / recover / getBinding. NOT here —
// prompt admission (P3a2), any UI or public route, the delegate extension,
// session deletion (P6). The role session is DURABLE: its title never carries
// the ephemeral reaper's `cto:` prefix and it is registered with NO TTL'd
// machinery whatsoever — its provenance IS the binding record (see
// readConversationRole), kept deliberately separate from the generic
// internal-session tombstones so readers can tell the human CEO channel
// (cto_conversation) apart from the CTO's own ephemeral inference sessions
// (cto_internal, owned by internalSessions.mjs).
//
// Identity rule (spec: "A title match alone is not proof of ownership"): a
// session is adopted ONLY on an exact metadata marker match — `metadata.role
// === "cto_conversation"` AND `metadata.bindingOperation === <the reserved
// operation id>` — verified by direct read-back, never by list title. The
// marker is stamped on the session at create time (P0 live probes:
// docs/cto-implementation-map.md §1/§8 — metadata round-trips verbatim).
//
// Unknown-outcome discipline (P3a1 review blockers 1-3):
//  - The reservation is persisted BEFORE the create and carries the expected
//    pre-create state (expectedCurrentSessionId / expectedGeneration); both
//    the reservation and the bind are compare-and-swap against the store, so
//    a stale "missing" lookup can never create a replacement on top of a
//    replacement another instance already bound.
//  - A create whose outcome is unknown (network error, deadline, 5xx) keeps
//    the reservation and fails explicitly — it is NEVER blind-retried, and a
//    marker scan that finds nothing NEVER clears the reservation (the create
//    may still be in flight and land after the scan). A reservation settles
//    only when the marker session becomes identifiable (found + verified) or
//    — for a DEFINITIVE opencode rejection (4xx) — when the create is known
//    to have landed nothing, which clears its own reservation.
//  - A create whose response body lacks the identity marker persists the
//    created sid + an unsupported-identity failure (terminal, explicit) —
//    never a create-loop.
//  - Every oc call (list/read/create) is bounded by an AbortSignal deadline
//    raced against the call, so hung headers or a hung body cannot stall
//    ensure() forever; a timed-out create is unknown, not a retry.
//
// SINGLE-WRITER-PROCESS REQUIREMENT: the serialization (per-store task
// queue) and the reservation/bind CAS are correct for ONE writer process —
// one manta-server per box. Composing two LIVE writer processes over the
// same store is unsupported; the CAS narrows but does not guarantee
// cross-process exclusion, and no fake cross-process safety is claimed.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { stateHome, statePath } from "../shared/paths.mjs";
import { writeJsonAtomic } from "./jsonStore.mjs";
import { bindingStore, patchStore } from "./ctoStores.mjs";

// Role provenance vocabulary (spec §3.1). The durable CEO conversation is
// `cto_conversation`; the CTO's own ephemeral inference sessions stay
// `cto_internal` (classified in internalSessions.mjs). The full four-way
// split lands with the admission phase.
export const CONVERSATION_ROLE = "cto_conversation";

// The role session's title. MUST NOT start with the ephemeral reaper's
// `cto:` prefix (ctoSessions.CTO_TITLE_PREFIX) — the reaper deletes sessions
// by title prefix, and the durable conversation must never be reaped. Pinned
// by a test against the imported constant.
export const ROLE_SESSION_TITLE = "Manta CTO conversation";

// Marker file inside the control directory. Byte-static (no timestamp) so
// re-writing it is idempotent.
export const CONTROL_MARKER_FILENAME = "cto-control-directory.json";

export const RECONCILE_ATTEMPTS = 3;
export const RECONCILE_BACKOFF_MS = 150;
export const RECEIPT_ATTEMPTS = 3;

// Every oc call (list/read/create) is bounded: hung response HEADERS or a
// hung response BODY must not stall ensure() forever (review blocker 3).
export const DEFAULT_REQUEST_DEADLINE_MS = 15_000;

// Provenance lookup cache TTL — the reader path (resolvePipelineSession) is
// per-event; binding.json is tiny but re-reading it per event is waste. The
// staleness window matches the tombstone/tmux caches (5s).
const CONVERSATION_ROLE_CACHE_MS = 5_000;

export class CtoBindingError extends Error {
  constructor(message, code, { cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "CtoBindingError";
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describeErr = (err) => String(err?.message ?? err);

/** The stable server-owned CTO control directory (under the state home). */
export function defaultControlDir() {
  return statePath("cto", "conversation");
}

/** The identity marker stamped onto the created session's metadata. */
export function markerFor(op) {
  return {
    role: CONVERSATION_ROLE,
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
    metadata.role === CONVERSATION_ROLE &&
    metadata.bindingOperation === operation
  );
}

/** Dedupe (keep order). The archive is NEVER capped or dropped (blocker 6). */
export function capPrevious(ids) {
  return [...new Set(ids)];
}

/**
 * Is this session the CURRENT durable CTO conversation? Pure store read —
 * zero opencode calls, zero model turns. This is the distinct role-provenance
 * seam (review blocker 4): the provenance reader path consults it so the CEO
 * conversation is recognized as its OWN role — not folded into the generic
 * `cto` internal-session tombstones — letting consumers treat a human CEO
 * message as CEO input while the CTO's own assistant output never re-enters
 * ambient analysis. A 5s single-entry cache mirrors the other provenance
 * caches; a corrupt binding store fails closed (throws) rather than guessing.
 */
let conversationRoleCache = { sid: null, value: false, until: 0 };
export async function readConversationRole(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const t = Date.now();
  if (conversationRoleCache.sid === sessionId && t < conversationRoleCache.until) {
    return conversationRoleCache.value;
  }
  let binding;
  try {
    binding = normalizeBinding(await bindingStore.load());
  } catch (err) {
    throw err instanceof CtoBindingError
      ? err
      : new CtoBindingError(
          `binding store unreadable while resolving conversation provenance: ${describeErr(err)}`,
          "store-unreadable",
          { cause: err },
        );
  }
  const value = binding.currentSessionId === sessionId;
  conversationRoleCache = { sid: sessionId, value, until: t + CONVERSATION_ROLE_CACHE_MS };
  return value;
}

/** Test-only: drop the provenance lookup cache. */
export function _resetConversationRoleCache() {
  conversationRoleCache = { sid: null, value: false, until: 0 };
}

/**
 * The CURRENT durable conversation session id, or null — one uncached store
 * read (no 5s window). This is the distinct-provenance seam the DB reader
 * uses: rows from this session are role-classified (assistant CTO content
 * excluded from ordinary indexing; CEO user instructions stay consumable
 * under their own role), NOT folded into the generic internal tombstones.
 */
export async function readConversationSessionId() {
  try {
    return normalizeBinding(await bindingStore.load()).currentSessionId;
  } catch (err) {
    throw err instanceof CtoBindingError
      ? err
      : new CtoBindingError(
          `binding store unreadable while resolving conversation provenance: ${describeErr(err)}`,
          "store-unreadable",
          { cause: err },
        );
  }
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
  const out = { operation: op.operation, generation: op.generation, directory: op.directory, startedAt: op.startedAt };
  // Expected-state CAS pair (review blocker 1): optional on read (tolerant of
  // partially-written legacy payloads), always written by the service.
  if (op.expectedCurrentSessionId !== undefined) {
    const v = op.expectedCurrentSessionId;
    if (v !== null && (typeof v !== "string" || v.length === 0)) throw invalidState("pendingOperation.expectedCurrentSessionId", v);
    out.expectedCurrentSessionId = v ?? null;
  }
  if (op.expectedGeneration !== undefined) {
    if (!Number.isInteger(op.expectedGeneration) || op.expectedGeneration < 0) {
      throw invalidState("pendingOperation.expectedGeneration", op.expectedGeneration);
    }
    out.expectedGeneration = op.expectedGeneration;
  }
  if (op.reason !== undefined) {
    if (typeof op.reason !== "string") throw invalidState("pendingOperation.reason", op.reason);
    out.reason = op.reason;
  }
  if (op.createdSessionId !== undefined) {
    if (typeof op.createdSessionId !== "string" || op.createdSessionId.length === 0) {
      throw invalidState("pendingOperation.createdSessionId", op.createdSessionId);
    }
    out.createdSessionId = op.createdSessionId;
  }
  if (op.unsupportedIdentity !== undefined) {
    if (typeof op.unsupportedIdentity !== "boolean") throw invalidState("pendingOperation.unsupportedIdentity", op.unsupportedIdentity);
    out.unsupportedIdentity = op.unsupportedIdentity;
  }
  return out;
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

// ---------------------------------------------------------------------------
// Per-store serialization (review round 2, blocker 1): tasks over the SAME
// store run ONE AT A TIME across all engine instances in this process, and
// every caller completes ITS OWN postcondition — an ensure() enqueued behind
// a recover() still performs get-or-create when the store is still unbound
// (a joined no-create recover result is never mistaken for ensure success).
// At-most-one creation comes from the fresh store load + reservation CAS
// inside ensureOnce, not from promise joining. CROSS-PROCESS: this is a
// single-writer-process design (one manta-server per box) — the CAS narrows
// but does not guarantee races between independent writer processes; the
// service must not be composed as two live writers over one store.
// ---------------------------------------------------------------------------

const storeQueues = new Map();

function enqueueStoreTask(store, run) {
  const key = typeof store?.path === "string" && store.path ? store.path : `binding:${store?.name ?? "anon"}`;
  const prev = storeQueues.get(key) ?? Promise.resolve();
  const task = prev.then(run, run);
  const tail = task.then(() => {}, () => {});
  storeQueues.set(key, tail);
  return task.finally(() => {
    if (storeQueues.get(key) === tail) storeQueues.delete(key);
  });
}

/**
 * Build the durable singleton CTO conversation binding service.
 *
 * @param {object} deps
 * @param {{ createSession: Function, listSessions: Function, readSession: Function }} deps.oc
 *        The opencode client (production: the matching exports of
 *        src/server/opencode.mjs). No other oc surface is touched — in
 *        particular ensure()/recover()/getBinding() never send a prompt or
 *        resolve a model. Every call is issued with an AbortSignal deadline.
 * @param {object} [deps.store] Binding store (default: ctoStores.bindingStore,
 *        strict — corrupt payloads throw, never silently read as unbound).
 * @param {string} [deps.controlDir] The role session's opencode directory.
 * @param {Function} [deps.now] @param {Function} [deps.newId] @param {Function} [deps.sleep]
 * @param {number} [deps.reconcileAttempts] @param {number} [deps.reconcileBackoffMs]
 *        Bounds the marker SCAN retries and the receipt read-back retries —
 *        never a create retry.
 * @param {number} [deps.requestDeadlineMs] Per-call deadline for every oc
 *        request (headers + body), enforced via the actual transport signal.
 * @returns {{ ensure: () => Promise<object>, recover: () => Promise<object>, getBinding: (opts?) => Promise<object> }}
 */
export function createCtoBinding({
  oc,
  store = bindingStore,
  controlDir = defaultControlDir(),
  now = () => Date.now(),
  newId = () => randomUUID(),
  sleep = defaultSleep,
  reconcileAttempts = RECONCILE_ATTEMPTS,
  reconcileBackoffMs = RECONCILE_BACKOFF_MS,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
} = {}) {
  if (
    !oc ||
    typeof oc.createSession !== "function" ||
    typeof oc.listSessions !== "function" ||
    typeof oc.readSession !== "function"
  ) {
    throw new Error("createCtoBinding requires an oc client with createSession, listSessions and readSession");
  }

  async function loadBinding() {
    try {
      return normalizeBinding(await store.load());
    } catch (err) {
      if (err instanceof CtoBindingError) throw err;
      throw new CtoBindingError(
        `binding store unreadable — refusing to create or recover a role session on top of unhealthy state: ${describeErr(err)}`,
        "store-unreadable",
        { cause: err },
      );
    }
  }

  /** Bounded oc read; any failure (deadline, network, 5xx) is "unknown". */
  async function readSessionBounded(sessionId) {
    try {
      return await withDeadline(
        (signal) => oc.readSession(sessionId, { signal }),
        requestDeadlineMs,
        `readSession(${sessionId})`,
      );
    } catch {
      return { state: "unknown" };
    }
  }

  /**
   * The control directory: exists, owned (0700, enforced), marked, never a
   * repository (no `.git` in it or in ANY ancestor up to and including the
   * state home) and never a symlink redirect — the REAL path must stay inside
   * the REAL state home, so the role session's cwd can never be pulled into a
   * user project. VALIDATION PRECEDES EVERY MUTATION (review round 2,
   * blocker 3): the realpath/containment/repository checks run against the
   * deepest EXISTING ancestor BEFORE mkdir/chmod touch anything, so a
   * rejected path (e.g. a symlink target) is never modified as a side effect
   * of refusing it.
   */
  async function ensureControlDirectory() {
    // --- validation (read-only) ---
    // (1) Textual containment of the INTENDED path: catches `..` escapes and
    // equality with the state home even when the directory does not exist yet.
    const resolvedControl = resolve(controlDir);
    const resolvedHome = resolve(stateHome());
    if (!resolvedControl.startsWith(resolvedHome + sep)) {
      throw new CtoBindingError(
        `CTO control directory ${controlDir} is outside the state home ${resolvedHome} — refusing to bind`,
        "control-directory-outside-state-home",
      );
    }
    // (2) Real containment of the deepest EXISTING ancestor: resolves any
    // symlinks in the existing chain; a redirect outside the state home is
    // refused before anything is created or mode-changed.
    let anchor = controlDir;
    for (let guard = 0; guard < 256 && !existsSync(anchor); guard++) anchor = dirname(anchor);
    let realAnchor;
    let realHome;
    try {
      realAnchor = await realpath(anchor);
      realHome = await realpath(stateHome());
    } catch (err) {
      throw new CtoBindingError(
        `CTO control directory ${controlDir} cannot be resolved: ${describeErr(err)}`,
        "control-directory-unresolvable",
        { cause: err },
      );
    }
    if (!realAnchor.startsWith(realHome + sep) && realAnchor !== realHome) {
      throw new CtoBindingError(
        `CTO control directory ${controlDir} resolves to ${realAnchor}, outside the state home ${realHome} — ` +
          `refusing to bind (a symlink must not redirect the role session's cwd)`,
        "control-directory-outside-state-home",
      );
    }
    // (3) No repository: the existing chain up to AND INCLUDING the state home.
    for (let dir = realAnchor; ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        throw new CtoBindingError(
          `CTO control directory ${controlDir} sits inside the repository at ${dir} — refusing to bind`,
          "control-directory-repository",
        );
      }
      if (dir === realHome) break;
    }

    // --- mutation (only after validation passed) ---
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    await chmod(controlDir, 0o700);
    await writeJsonAtomic(
      join(controlDir, CONTROL_MARKER_FILENAME),
      JSON.stringify(
        {
          kind: "manta-cto-control-directory",
          role: CONVERSATION_ROLE,
          note: "Server-owned CTO control directory — not a repository; never an implicit implementation target.",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  /**
   * Marker scan with bounded retries. Returns
   *   { state: "found", sessionId }  — exact marker, verified by direct read-back
   *   { state: "unknown", reason }   — absent, malformed response, or transient
   *
   * There is deliberately NO "absent" settlement: an in-flight create can
   * finish AFTER the list snapshot was taken (another engine instance, or a
   * request that outlived its process), so a missing marker never proves the
   * create never landed and never authorizes a second create (review
   * blocker 1). Only a malformed response is distinguished for diagnostics.
   */
  async function scanForMarker(operation) {
    let lastReason = "attempts-exhausted";
    for (let attempt = 1; attempt <= reconcileAttempts; attempt++) {
      if (attempt > 1) await sleep(reconcileBackoffMs * (attempt - 1));
      let sessions;
      try {
        sessions = await withDeadline((signal) => oc.listSessions(undefined, { signal }), requestDeadlineMs, "listSessions");
      } catch (err) {
        lastReason = `list-sessions-failed: ${describeErr(err)}`;
        continue;
      }
      if (!Array.isArray(sessions)) {
        // A malformed list response is NEVER read as [] / absence.
        lastReason = `malformed-list-response:${sessions === null ? "null" : typeof sessions}`;
        continue;
      }
      const hit = sessions.find((s) => isMarkerSession(s, operation));
      if (hit?.id) {
        // The list hit is a hint; the direct read-back is the receipt.
        const read = await readSessionBounded(hit.id);
        if (read.state === "found" && isMarkerSession(read.session, operation)) {
          return { state: "found", sessionId: hit.id };
        }
        lastReason = `list-hit-${hit.id}-unverified-${read.state}`;
        continue;
      }
      return { state: "unknown", reason: "marker-absent" };
    }
    return { state: "unknown", reason: lastReason };
  }

  /**
   * Adopt a marker-verified created session as the current binding (CAS: the
   * operation must still be the pending one).
   */
  async function adoptOperation(pending, sessionId, actions) {
    const next = await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation?.operation !== pending.operation) return {};
      const previous =
        base.currentSessionId && base.currentSessionId !== sessionId
          ? capPrevious([...base.previousSessionIds, base.currentSessionId])
          : base.previousSessionIds;
      return {
        generation: Math.max(base.generation, pending.generation),
        currentSessionId: sessionId,
        currentOperation: pending.operation,
        previousSessionIds: previous,
        pendingOperation: undefined,
      };
    });
    const base = normalizeBinding(next);
    if (base.currentSessionId === sessionId) {
      actions.push({ action: "adopted", operation: pending.operation, sessionId });
    }
    return base;
  }

  /** The created session dropped its marker: persist the terminal failure. */
  async function markUnsupportedIdentity(pending, sessionId) {
    await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation?.operation !== pending.operation) return {};
      return {
        pendingOperation: { ...base.pendingOperation, createdSessionId: sessionId, unsupportedIdentity: true },
      };
    });
  }

  /**
   * Resolve a reserved operation left by this or a previous process. With a
   * persisted created sid, settlement goes DIRECTLY to that sid (a list page
   * can hide the session; the direct read cannot be out-ordered by it) — the
   * marker scan runs only when NO sid is persisted. Never creates here.
   */
  async function reconcilePending(actions) {
    const binding = await loadBinding();
    const pending = binding.pendingOperation;
    if (!pending) return binding;
    if (pending.unsupportedIdentity) {
      // Terminal, persisted state (review blocker 2): the created session —
      // whose sid IS persisted on the operation — can never be identified.
      // Explicit failure every time; never a scan-adopt, never a re-create.
      throw new CtoBindingError(
        `binding operation ${pending.operation} hit an unsupported identity failure (created session ` +
          `${pending.createdSessionId ?? "<sid lost>"} lacks the binding metadata marker) — creation is stopped ` +
          `to prevent duplicates. Manual resolution required.`,
        "unsupported-identity",
      );
    }
    if (pending.createdSessionId) {
      // Direct GET on the persisted sid — the receipt is honored, never
      // discarded; the list page plays no part in this settlement.
      const read = await readSessionBounded(pending.createdSessionId);
      if (read.state === "found") {
        if (isMarkerSession(read.session, pending.operation)) {
          return adoptOperation(pending, pending.createdSessionId, actions);
        }
        await markUnsupportedIdentity(pending, pending.createdSessionId);
        throw new CtoBindingError(
          `created session ${pending.createdSessionId} (operation ${pending.operation}) exists but lacks the ` +
            `binding metadata marker — role-session identity is unsupported; creation is stopped to prevent ` +
            `duplicates. Manual resolution required.`,
          "unsupported-identity",
        );
      }
      actions.push({
        action: "reconcile-unknown",
        operation: pending.operation,
        reason: `created-session-${pending.createdSessionId}-${read.state}`,
      });
      return binding;
    }
    const scan = await scanForMarker(pending.operation);
    if (scan.state === "found") {
      return adoptOperation(pending, scan.sessionId, actions);
    }
    // Unknown outcome (marker absent, malformed list, transient failures):
    // the reservation is RETAINED — never cleared, never re-created on top of.
    actions.push({ action: "reconcile-unknown", operation: pending.operation, reason: scan.reason });
    return binding;
  }

  /**
   * Verify the currently bound session. "found" requires the exact marker —
   * a live session whose metadata no longer matches is "mismatch" (surfaced,
   * never adopted blindly, never replaced from).
   */
  async function verifyCurrent(binding) {
    const read = await readSessionBounded(binding.currentSessionId);
    if (read.state === "found") {
      return isMarkerSession(read.session, binding.currentOperation) ? { state: "found" } : { state: "mismatch" };
    }
    return read;
  }

  // A definitive opencode REJECTION (4xx — nothing landed) vs an unknown
  // outcome (network error, deadline, 5xx — the create may still have landed).
  const isDefinitiveRejection = (err) =>
    err && typeof err.status === "number" && Number.isInteger(err.status) && err.status >= 400 && err.status < 500;

  /**
   * ONE create attempt (never retried inside the service): CAS-reserve the
   * operation against the expected pre-create state → create with the marker
   * → verify the receipt → CAS-bind. Any unknown outcome retains the
   * reservation for marker settlement; a definitive 4xx clears its own
   * reservation. The CAS pair (expectedCurrentSessionId / expectedGeneration)
   * is what stops a stale "missing" lookup from replacing a session another
   * instance already replaced (review blocker 1).
   */
  async function attemptCreate({ expected, reason, actions }) {
    const op = {
      operation: newId(),
      generation: expected.generation + 1,
      directory: controlDir,
      startedAt: now(),
      reason,
      expectedCurrentSessionId: expected.currentSessionId,
      expectedGeneration: expected.generation,
    };
    const reserved = await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation) return {}; // a concurrent reservation wins; caller re-reconciles
      if (base.currentSessionId !== expected.currentSessionId || base.generation !== expected.generation) {
        return {}; // CAS: the store moved (a prior bind landed) — do not create
      }
      return { pendingOperation: op };
    });
    if (normalizeBinding(reserved).pendingOperation?.operation !== op.operation) {
      throw new CtoBindingError(
        `binding moved before reservation (expected generation ${expected.generation}` +
          `${expected.currentSessionId ? ` with session ${expected.currentSessionId}` : " while unbound"}) — ` +
          `deferring to the concurrent resolution`,
        "deferred",
      );
    }

    let session;
    try {
      session = await withDeadline(
        (signal) => oc.createSession({ directory: op.directory, title: ROLE_SESSION_TITLE, metadata: markerFor(op), signal }),
        requestDeadlineMs,
        "createSession",
      );
    } catch (err) {
      if (isDefinitiveRejection(err)) {
        await patchStore(store, (fresh) => {
          const base = normalizeBinding(fresh);
          if (base.pendingOperation?.operation !== op.operation) return {};
          return { pendingOperation: undefined };
        });
        throw new CtoBindingError(
          `role-session create definitively rejected by opencode (operation ${op.operation} cleared): ${describeErr(err)}`,
          "create-rejected",
          { cause: err },
        );
      }
      throw new CtoBindingError(
        `role-session create failed with unknown outcome (operation ${op.operation} retained for recovery): ${describeErr(err)}`,
        "create-unknown",
        { cause: err },
      );
    }
    if (typeof session?.id !== "string" || session.id.length === 0) {
      throw new CtoBindingError(
        `opencode createSession returned no session id (operation ${op.operation} retained for recovery)`,
        "create-unknown",
      );
    }

    // Persist the returned sid IMMEDIATELY, before any receipt verification
    // (review round 2, blocker 2): a receipt timeout must never leave the
    // created session unidentifiable just because the newest-100 list page
    // later hides it — recovery settles by a DIRECT read of this sid first.
    await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation?.operation !== op.operation) return {};
      return { pendingOperation: { ...base.pendingOperation, createdSessionId: session.id } };
    });

    // Receipt: a 2xx from the create alone is not proof (P0 map guard rails).
    // Bind only once the marker is verified on the record itself.
    let receipt = null;
    for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(reconcileBackoffMs);
      const read = await readSessionBounded(session.id);
      if (read.state === "found") {
        if (!isMarkerSession(read.session, op.operation)) {
          // opencode dropped the marker: the session exists but can never be
          // re-identified. Persist the sid + the terminal failure BEFORE
          // erroring — never loop-create over an unidentifiable session.
          await markUnsupportedIdentity(op, session.id);
          throw new CtoBindingError(
            `opencode did not persist the binding metadata marker on ${session.id} — role-session identity is ` +
              `unsupported (operation ${op.operation}); creation is stopped to prevent duplicates. ` +
              `Manual resolution required.`,
            "unsupported-identity",
          );
        }
        receipt = read.session;
        break;
      }
      if (read.state === "missing") {
        throw new CtoBindingError(
          `created role session ${session.id} reads back missing — refusing to bind (operation ${op.operation} retained for recovery)`,
          "create-unknown",
        );
      }
    }
    if (!receipt) {
      throw new CtoBindingError(
        `could not verify the created role session ${session.id} (lookup stayed unknown) — operation ${op.operation} retained for recovery`,
        "create-unknown",
      );
    }

    const bound = await patchStore(store, (fresh) => {
      const base = normalizeBinding(fresh);
      if (base.pendingOperation?.operation !== op.operation) return {};
      if (base.currentSessionId !== op.expectedCurrentSessionId || base.generation !== op.expectedGeneration) {
        return {}; // CAS: a prior bind landed while we were creating — never overwrite it
      }
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
        `binding moved while creating (operation ${op.operation}) — created session ${session.id} left as a ` +
          `marker-stamped orphan for reconciliation`,
        "deferred",
      );
    }
    actions.push({ action: "created", generation: op.generation, sessionId: session.id, reason });
    return base;
  }

  async function ensureOnce() {
    await ensureControlDirectory();
    const actions = [];
    const binding = await reconcilePending(actions);
    if (binding.pendingOperation) {
      // TRUTHFUL residual-unknown copy (review round 2): the create may never
      // have landed — retrying ensure() will NOT fix that (it keeps reporting
      // the same uncertainty and never creates over an unsettled operation),
      // and no automatic retry is safe. Resolution requires the created
      // session to become identifiable (direct lookup of the persisted sid,
      // when one is recorded) or an explicit manual settle.
      const op = binding.pendingOperation;
      throw new CtoBindingError(
        `binding operation ${op.operation} is retained with an unresolved outcome` +
          `${op.createdSessionId ? ` (created session sid ${op.createdSessionId} persisted)` : ""}: the create ` +
          `may still be in flight, or it may never have landed — this is unknown. ensure()/recover() keep ` +
          `reporting this uncertainty and will NOT create a replacement; retrying does not resolve it. ` +
          `The operation settles only when its session becomes identifiable` +
          `${op.createdSessionId ? " (direct lookup of the persisted sid)" : " (exact metadata marker in a session scan)"} ` +
          `or an explicit manual settle is performed.`,
        "unknown-state",
      );
    }
    if (binding.currentSessionId) {
      const verdict = await verifyCurrent(binding);
      if (verdict.state === "found") {
        return { binding, created: false, actions };
      }
      if (verdict.state === "unknown" || verdict.state === "mismatch") {
        // A timeout/5xx is NEVER absence — returning the binding as-is can't
        // duplicate; a replacement happens only on a definitive 404 below.
        actions.push({ action: "uncertain", reason: verdict.state, sessionId: binding.currentSessionId });
        return { binding, created: false, uncertain: true, uncertainReason: verdict.state, actions };
      }
    }
    const wasBound = binding.currentSessionId !== null;
    const expected = { currentSessionId: binding.currentSessionId, generation: binding.generation };
    const next = await attemptCreate({ expected, reason: wasBound ? "bound-session-missing" : "ensure", actions });
    return { binding: next, created: true, replaced: wasBound, actions };
  }

  async function recoverOnce() {
    await ensureControlDirectory();
    const actions = [];
    const binding = await reconcilePending(actions);
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
    const expected = { currentSessionId: binding.currentSessionId, generation: binding.generation };
    const next = await attemptCreate({ expected, reason: "recover: bound session definitively absent", actions });
    actions.push({ action: "replaced", generation: next.generation, sessionId: next.currentSessionId });
    return { binding: next, actions, replaced: true };
  }

  // Serialization shared by ensure() AND recover(), keyed by the store path
  // (not the instance): concurrent calls run ONE AT A TIME and each caller
  // gets ITS OWN result — an ensure() queued behind a recover() still
  // completes get-or-create (review round 2, blocker 1). Cross-process, the
  // reservation + bind CAS narrows races; single-writer-process is required.
  function ensure() {
    return enqueueStoreTask(store, ensureOnce);
  }

  function recover() {
    return enqueueStoreTask(store, recoverOnce);
  }

  return {
    ensure,
    recover,
    /**
     * Store read only — zero opencode calls, zero model turns. By default
     * returns the FULL previous-session archive (never dropped); pass
     * `{ previousLimit, previousOffset }` (offset 0 = most recent) to
     * paginate without dropping anything from the store.
     */
    getBinding: async ({ previousLimit, previousOffset = 0 } = {}) => {
      const binding = await loadBinding();
      const total = binding.previousSessionIds.length;
      if (previousLimit === undefined) {
        return { ...binding, previousSessionIdsTotal: total };
      }
      if (!Number.isInteger(previousLimit) || previousLimit < 1) {
        throw new CtoBindingError("getBinding previousLimit must be a positive integer", "invalid-argument");
      }
      if (!Number.isInteger(previousOffset) || previousOffset < 0) {
        throw new CtoBindingError("getBinding previousOffset must be a non-negative integer", "invalid-argument");
      }
      const end = Math.max(0, total - previousOffset);
      return {
        ...binding,
        previousSessionIds: binding.previousSessionIds.slice(Math.max(0, end - previousLimit), end),
        previousSessionIdsTotal: total,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Deadline plumbing (review blocker 3): every oc call races against an
// AbortSignal.timeout so hung HEADERS or a hung BODY through the real pooled
// transport (http.request with `signal`) — or any transport — cannot stall
// ensure()/recover() past the deadline. A deadline hit is classified by the
// caller: a timed-out CREATE is an unknown outcome (reservation retained,
// never blind-retried), never a duplicate.
// ---------------------------------------------------------------------------

function withDeadline(run, deadlineMs, label) {
  const signal = AbortSignal.timeout(deadlineMs);
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new CtoBindingError(`${label} exceeded its ${deadlineMs}ms deadline (request+body bound)`, "deadline-exceeded"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => run(signal))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
