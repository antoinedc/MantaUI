// stoppedStore.mjs — the durable box-side record of conversations stopped by a
// plan-usage limit (BET-1047 stage 1). This is the SINGLE source for the
// sidebar indicator, the row markers and the resume modal; because it is a
// durable on-disk store, all three survive an app restart (spec §5).
//
// Record fields are exactly spec §5's table — nothing extra:
//   workspace   grouping (the project/workspace the conversation lives in)
//   conversation  the row identity + grouping (the opencode session id)
//   provider     usage-engine adapter id ("claude" | "codex" | "kimi") — the
//                meter that gates the resume
//   model        the model that was in flight (pinned on the continuation)
//   window       "session" | "weekly" | "monthly", when the refusal named one
//   stoppedAt    epoch ms — ordering + the "new since you last looked" badge
//   cachedTokens the cached-token count at that moment (cold-cache cost estimate)
//   armed        whether the user chose to resume it
//   attempts     so a permanently-refused conversation stops looping
//
// Plus one list-level `lastLooked` timestamp (stamped when the modal closes).
//
// Lifecycle (spec §5.1):
//   - a repeat refusal for a conversation already listed UPDATES that entry (no duplicate);
//   - removed on a successful run of that conversation (markStoppedRan);
//   - removed on explicit unchecking in the modal (disarm — an explicit "no");
//   - a repeat refusal increments attempts (permanent refusal stops looping).
//
// Follows the existing store pattern (schedule.mjs / secrets.mjs): pure logic +
// injected I/O, resolved through statePath() (never a hand-built home path —
// that breaks the test sandbox), written atomically via jsonStore. Publish
// `usage-stopped.updated` so clients refresh without polling.

import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";

const STORE_PATH = statePath("usage-stopped.json");
// Exported so the state-sandbox canary can assert it resolves inside the test
// sandbox (never the live box) — see stateSandbox.test.mjs.
export { STORE_PATH };

/** @typedef {import("./usageStopper.mjs").UsageWindowKind} UsageWindowKind */

/**
 * @typedef {object} StoppedRecord
 * @property {string} workspace
 * @property {string} conversation
 * @property {"claude"|"codex"|"kimi"} provider
 * @property {string} [model]
 * @property {UsageWindowKind|null} window
 * @property {number} stoppedAt
 * @property {number} [cachedTokens]
 * @property {boolean} [armed]
 * @property {number} [attempts]
 */

export function loadStoppedState(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return {
    lastLooked: typeof parsed?.lastLooked === "number" ? parsed.lastLooked : null,
    records: Array.isArray(parsed?.records) ? parsed.records : [],
  };
}

export async function saveStoppedState(state, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify(state, null, 2));
}

/**
 * Build a fresh record for a conversation. Pure — the caller owns the store.
 * @param {object} input
 * @param {string} input.workspace
 * @param {string} input.conversation
 * @param {"claude"|"codex"|"kimi"} input.provider
 * @param {string} [input.model]
 * @param {UsageWindowKind|null} input.window
 * @param {number} input.stoppedAt
 * @param {number} [input.cachedTokens]
 * @returns {StoppedRecord}
 */
export function buildStoppedRecord({ workspace, conversation, provider, model, window, stoppedAt, cachedTokens }) {
  return {
    workspace: asString(workspace),
    conversation: asString(conversation),
    provider,
    ...(model ? { model: asString(model) } : {}),
    window: window ?? null,
    stoppedAt,
    ...(Number.isFinite(cachedTokens) ? { cachedTokens } : {}),
    armed: false,
    attempts: 1,
  };
}

function asString(v) {
  return typeof v === "string" ? v : "";
}

function indexOfRecord(state, conversation) {
  if (!conversation) return -1;
  return state.records.findIndex((r) => r?.conversation === conversation);
}

/**
 * Enrol (or update) a stopped conversation. A repeat refusal for a
 * conversation already listed UPDATES its entry — never a duplicate (spec
 * §5.1). Publish `usage-stopped.updated` on any write.
 *
 * @param {object} input
 * @param {string} input.conversation
 * @param {string} [input.workspace]
 * @param {"claude"|"codex"|"kimi"} input.provider
 * @param {string} [input.model]
 * @param {UsageWindowKind|null} input.window
 * @param {number} input.stoppedAt
 * @param {number} [input.cachedTokens]
 * @param {object} [deps]
 * @param {() => {records: StoppedRecord[], lastLooked: number|null}} [deps.load]
 * @param {(s: object) => Promise<void>} [deps.save]
 * @param {(evt: object) => void} [deps.publish]
 */
export async function upsertStopped(input, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  if (!input?.conversation) return;
  const state = load();
  const idx = indexOfRecord(state, input.conversation);
  const record = buildStoppedRecord(input);
  if (idx === -1) {
    state.records.push(record);
  } else {
    // Update in place; attempts increments so a permanently-refused
    // conversation stops looping. armed is preserved across repeats.
    state.records[idx] = {
      ...state.records[idx],
      workspace: record.workspace,
      provider: record.provider,
      ...(record.model ? { model: record.model } : {}),
      window: record.window,
      stoppedAt: record.stoppedAt,
      ...(record.cachedTokens !== undefined ? { cachedTokens: record.cachedTokens } : {}),
      attempts: (state.records[idx].attempts ?? 0) + 1,
    };
  }
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: { conversation: input.conversation } });
}

/**
 * Arm an entry for resume: mark it `armed: true`. The row stays listed.
 * @param {object} input
 * @param {string} input.conversation
 * @param {object} [deps]
 */
export async function armStopped({ conversation }, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  if (!conversation) return;
  const state = load();
  const idx = indexOfRecord(state, conversation);
  if (idx === -1) return;
  state.records[idx] = { ...state.records[idx], armed: true };
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: { conversation } });
}

/**
 * Disarm an entry — the modal uncheck, an explicit "no" — which REMOVES it
 * (spec §5.1). The row disappears from the list and the sidebar pill.
 * @param {object} input
 * @param {string} input.conversation
 * @param {object} [deps]
 */
export async function disarmStopped({ conversation }, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  if (!conversation) return;
  const state = load();
  const idx = indexOfRecord(state, conversation);
  if (idx === -1) return;
  state.records.splice(idx, 1);
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: { conversation } });
}

/**
 * Clear an entry because that conversation ran successfully (whether resumed
 * by us or by hand) or resumed. Removes the row (spec §5.1).
 * @param {object} input
 * @param {string} input.conversation
 * @param {object} [deps]
 */
export async function markStoppedRan({ conversation }, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  if (!conversation) return;
  const state = load();
  const idx = indexOfRecord(state, conversation);
  if (idx === -1) return;
  state.records.splice(idx, 1);
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: { conversation } });
}

/**
 * Record that a resumed conversation came back refused, incrementing its
 * `attempts` in place so a permanently-refused conversation stops looping
 * (spec §8 + §5: "A conversation that ... still refused stays in the list and
 * waits for the next check. After a small number of attempts it stops retrying
 * and is flagged"). Unlike upsertStopped this does NOT refresh stoppedAt or
 * provide — a repeat refusal must not reset the "new since last looked" badge
 * or clobber the model/window that enrolled it.
 * @param {object} input
 * @param {string} input.conversation
 * @param {object} [deps]
 */
export async function bumpStoppedAttempts({ conversation }, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  if (!conversation) return;
  const state = load();
  const idx = indexOfRecord(state, conversation);
  if (idx === -1) return;
  state.records[idx] = { ...state.records[idx], attempts: (state.records[idx].attempts ?? 0) + 1 };
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: { conversation } });
}

/**
 * Stamp the list-level "last looked" timestamp (set when the modal closes).
 * @param {object} [input]
 * @param {number} [input.now]
 * @param {object} [deps]
 */
export async function stampStoppedLastLooked({ now = Date.now() } = {}, { load = loadStoppedState, save = saveStoppedState, publish } = {}) {
  const state = load();
  state.lastLooked = now();
  await save(state);
  publish?.({ kind: "usage-stopped.updated", payload: {} });
}

/**
 * Read the current record for clients. Returns { records, lastLooked }.
 * @param {object} [deps]
 */
export async function listStopped({ load = loadStoppedState } = {}) {
  const state = load();
  return { records: state.records, lastLooked: state.lastLooked };
}
