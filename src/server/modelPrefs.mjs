// modelPrefs.mjs — the durable box-side record of per-conversation model
// selection (provider+model, reasoning effort, fast flavour) and the small
// list of recent model choices (BET-1279).
//
// WHY THIS STORE EXISTS. The per-conversation model choice is stored ONLY on
// the device that made it — localStorage on desktop, UserDefaults on iOS —
// and is never told to the box. opencode itself has no per-session model
// field (model + variant are attached to each request and then forgotten), so
// no server-side record exists anywhere. Opening the same conversation on a
// second device therefore has no model selection at all and falls back to a
// default. This store fixes that by persisting the selection box-side, and
// publishes `model-prefs.updated` so connected clients refetch without polling.
//
// On-disk shape (statePath("model-prefs.json") → ~/.manta/model-prefs.json):
//   sessions: { "<sessionId>": { providerID, modelID, variant?, updatedAt } }
//   recents:  [ { providerID, modelID, variant?, fast } ]  — capped at 5
//
// Rules (these are decisions, not suggestions):
//   - `variant` is OMITTED when absent. Never null.
//   - A session record has NO `fast` field. Fast is encoded in `modelID` by
//     the `-fast` suffix, exactly as both clients already do.
//   - `recents[]` DOES carry `fast: boolean` and a base `modelID` — the
//     existing iOS `ModelChoice` shape, kept byte-identical (no translation
//     layer). The CLIENT owns ordering + dedupe (`ModelRecents.record` already
//     does it); the server stores what it is given, truncated to 5.
//   - `sessions` is capped at 500; when over, drop the lowest `updatedAt` first.
//     This is the only pruning — the store learns nothing about which sessions
//     are live (no tmux import, no opencode call).
//
// Validation: a session record is valid only with non-empty string
// `providerID` + `modelID`; `variant`, if present, must be a non-empty string.
// An invalid record is skipped on write and DROPPED on load — a malformed
// record must never be able to break a client's composer.
//
// Follows the existing store pattern (stoppedStore.mjs / secrets.mjs): pure
// logic + injected I/O, resolved through statePath() (never a hand-built home
// path — that breaks the test sandbox), written atomically via jsonStore.

import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

const STORE_PATH = statePath("model-prefs.json");
// Exported so the state-sandbox canary can assert it resolves inside the test
// sandbox (never the live box) — see stateSandbox.test.mjs.
export { STORE_PATH };

const SESSIONS_CAP = 500;
const RECENTS_CAP = 5;

/**
 * @typedef {object} ModelSelection
 * A single model choice, shared by both the session record and a recent.
 * `variant`, when present, is a non-empty string (reasoning effort / fast
 * flavour); `fast` is a recent-only boolean flag (never on a session record).
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} [variant]
 * @property {boolean} [fast]
 */

// A session record is valid only with non-empty string providerID + modelID;
// a present variant must be a non-empty string. Anything else is silently
// rejected on write and dropped on load.
function isValidSelection(sel) {
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) return false;
  if (typeof sel.providerID !== "string" || sel.providerID === "") return false;
  if (typeof sel.modelID !== "string" || sel.modelID === "") return false;
  if (sel.variant !== undefined && (typeof sel.variant !== "string" || sel.variant === "")) return false;
  return true;
}

// Build the on-disk session record for a validated selection. `variant` is
// OMITTED when absent (never null); there is deliberately no `fast` field on a
// session record (fast lives in the `-fast` modelID suffix).
function buildSessionRecord(sel, now) {
  const record = { providerID: sel.providerID, modelID: sel.modelID };
  if (sel.variant !== undefined) record.variant = sel.variant;
  record.updatedAt = now();
  return record;
}

/**
 * Read and normalize the store. Returns `{ sessions: {}, recents: [] }` on a
 * missing/unreadable/garbage file. Invalid session records are DROPPED on load.
 * @param {string} [path]
 * @returns {{ sessions: Record<string, object>, recents: ModelSelection[] }}
 */
export function loadModelPrefs(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  const sessions = {};
  const rawSessions = parsed?.sessions;
  if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
    for (const [key, value] of Object.entries(rawSessions)) {
      if (!isValidSelection(value)) continue; // drop malformed records on load
      sessions[key] = {
        providerID: value.providerID,
        modelID: value.modelID,
        ...(value.variant !== undefined ? { variant: value.variant } : {}),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
      };
    }
  }
  // A healthy defensive guard only — an on-disk file over cap collapses to
  // cap on load (keep the in-memory shape consistent for the next writer).
  pruneSessions(sessions);
  const recents = Array.isArray(parsed?.recents) ? parsed.recents.filter(isValidSelection).slice(0, RECENTS_CAP) : [];
  return { sessions, recents };
}

/**
 * Persist `state` atomically. NOT a secret — no `mode` option.
 * @param {{ sessions: Record<string, object>, recents: ModelSelection[] }} state
 * @param {string} [path]
 */
export async function saveModelPrefs(state, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(state, null, 2));
}

/**
 * Prune `sessions` to the cap, dropping the lowest `updatedAt` first. This is
 * the ONLY pruning the store performs. Mutates in place. Returns how many were
 * dropped (mostly a debug aid).
 * @param {Record<string, object>} sessions
 * @returns {number}
 */
function pruneSessions(sessions) {
  const keys = Object.keys(sessions);
  if (keys.length <= SESSIONS_CAP) return 0;
  const byOldestFirst = keys.sort((a, b) => (sessions[a]?.updatedAt ?? 0) - (sessions[b]?.updatedAt ?? 0));
  let dropped = 0;
  while (keys.length - dropped > SESSIONS_CAP) {
    delete sessions[byOldestFirst[dropped++]];
  }
  return dropped;
}

function sameRecents(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read the current { sessions, recents } for clients.
 * @param {object} [deps]
 * @param {typeof loadModelPrefs} [deps.load]
 */
export async function getModelPrefs({ load = loadModelPrefs } = {}) {
  const state = load();
  return { sessions: state.sessions, recents: state.recents };
}

/**
 * ONE mutator for the whole store (not one per field).
 *
 * A call may carry any of:
 *   - `sessionId` + a `selection` object   → upsert that session (updatedAt: now())
 *   - `sessionId` + `selection: null`       → delete that session's entry
 *   - `recents` array                       → replace the stored list (truncated to 5)
 * Either half may be omitted. A call with neither is a no-op and publishes nothing.
 *
 * An invalid `selection` is skipped silently, never thrown. The published
 * envelope is `{ kind: "model-prefs.updated", payload: { sessionId } }`, with
 * `sessionId` omitted when only `recents` changed — the payload is a HINT, not
 * the record; clients refetch.
 *
 * @param {object} input
 * @param {string} [input.sessionId]
 * @param {ModelSelection|null} [input.selection]
 * @param {ModelSelection[]} [input.recents]
 * @param {object} [deps]
 * @param {typeof loadModelPrefs} [deps.load]
 * @param {typeof saveModelPrefs} [deps.save]
 * @param {(evt: object) => void} [deps.publish]
 * @param {() => number} [deps.now]
 */
export async function setModelPrefs(
  { sessionId, selection, recents } = {},
  { load = loadModelPrefs, save = saveModelPrefs, publish, now = () => Date.now() } = {},
) {
  if (selection === undefined && recents === undefined) return;
  const state = load();
  let sessionChanged = false;
  let recentsChanged = false;

  if (sessionId !== undefined) {
    if (selection === null) {
      if (Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) {
        delete state.sessions[sessionId];
        sessionChanged = true;
      }
    } else if (isValidSelection(selection)) {
      state.sessions[sessionId] = buildSessionRecord(selection, now);
      sessionChanged = true;
    }
    // invalid selection → skip silently
  }

  if (recents !== undefined) {
    const truncated = Array.isArray(recents) ? recents.filter(isValidSelection).slice(0, RECENTS_CAP) : [];
    if (!sameRecents(state.recents, truncated)) {
      state.recents = truncated;
      recentsChanged = true;
    }
  }

  if (!sessionChanged && !recentsChanged) return;

  pruneSessions(state.sessions);
  await save(state);
  const payload = sessionChanged && sessionId !== undefined ? { sessionId } : {};
  publish?.({ kind: "model-prefs.updated", payload });
}

/**
 * Non-destructive merge, used once by each client's one-shot migration.
 * Writes a session key only when it does not already exist; writes `recents`
 * only when the stored list is empty. Publishes once with an EMPTY payload,
 * and only if something actually changed.
 * @param {object} input
 * @param {Record<string, ModelSelection>} [input.sessions]
 * @param {ModelSelection[]} [input.recents]
 * @param {object} [deps]
 * @param {typeof loadModelPrefs} [deps.load]
 * @param {typeof saveModelPrefs} [deps.save]
 * @param {(evt: object) => void} [deps.publish]
 * @param {() => number} [deps.now]
 */
export async function seedModelPrefs(
  { sessions, recents } = {},
  { load = loadModelPrefs, save = saveModelPrefs, publish, now = () => Date.now() } = {},
) {
  const state = load();
  let changed = false;

  if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
    for (const [key, value] of Object.entries(sessions)) {
      if (Object.prototype.hasOwnProperty.call(state.sessions, key)) continue; // never overwrite
      if (isValidSelection(value)) {
        state.sessions[key] = buildSessionRecord(value, now);
        changed = true;
      }
    }
  }

  if (Array.isArray(recents) && recents.length > 0 && state.recents.length === 0) {
    const truncated = recents.filter(isValidSelection).slice(0, RECENTS_CAP);
    if (truncated.length > 0) {
      state.recents = truncated;
      changed = true;
    }
  }

  if (!changed) return;

  pruneSessions(state.sessions);
  await save(state);
  publish?.({ kind: "model-prefs.updated", payload: {} });
}
