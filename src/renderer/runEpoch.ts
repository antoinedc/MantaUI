// Run values per session, and the connection state that decides which of them are current (WS11 D11).
//
// The box tags every run value with its interpreter `epoch` and a `{gen, seq}` revision. A client keeps the values of the
// LATEST connection's epoch only: `runningSet` (the first frame of every /events connection) announces it, a connection
// counter (`connGen`) retires RPC answers that were issued before a reconnect. The rules themselves are the pure reducers in
// toolActivity.ts; this module is the per-session state around them plus the two entry points the transport feeds.

import { useSyncExternalStore } from "react";
import { useStore } from "./store";
import {
  applyRunRebuild,
  emptyRunMap,
  hasStaleMembership,
  mergeRunViews,
  pruneRunMap,
  runIdsOfMessages,
  runViewsOf,
  setRunEpoch,
  type RunMap,
} from "./toolActivity";
import type { OpencodeMessage, StreamToolRunsPayload } from "../shared/types";

const maps = new Map<string, RunMap>();
const listeners = new Set<() => void>();
const EMPTY = emptyRunMap();
/** Run ids of the turn in progress, from the latest `toolRuns` frames: a prune after a full fetch never drops them. */
const liveIds = new Map<string, Set<string>>();

const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const conn = () => useStore.getState().runEpoch;

/** The run map of a session (a stable empty one when it has none). */
export const getRunMap = (sessionId: string): RunMap => maps.get(sessionId) ?? EMPTY;

/**
 * React binding: re-renders only when THIS session's map changes (the identity is stable for an untouched session, so a
 * `toolRuns` frame of another session bails out; the layout memo keys on the map identity).
 */
export function useRunMap(sessionId: string): RunMap {
  return useSyncExternalStore(subscribe, () => getRunMap(sessionId));
}

function put(sessionId: string, next: RunMap): void {
  if (next === getRunMap(sessionId)) return;
  maps.set(sessionId, next);
  notify();
}

/** The latest connection's `runningSet` named its epoch: drop every other epoch's runs, apply queued writes. */
export function onRunEpoch(epoch: string | null | undefined): void {
  useStore.getState().setRunEpoch(epoch ?? null);
  const { connGen } = conn();
  let changed = false;
  for (const [sid, state] of maps) {
    const next = setRunEpoch(state, epoch ?? null, connGen);
    if (next === state) continue;
    maps.set(sid, next);
    changed = true;
  }
  if (liveIds.size > 0) {
    liveIds.clear(); // the new connection's snapshot names the live runs again
    changed = true;
  }
  if (changed) notify();
}

/** The events connection (re)opened: its epoch is unknown until the new `runningSet`. */
export function onRunConnection(): void {
  useStore.getState().beginRunConnection();
}

/**
 * Feed the run views a transcript response carries. `issuedConnGen` is the connection generation the request was issued
 * under. Returns true when the response carries a membership older than the session's `minGen` (the caller refetches).
 */
export function ingestRunMessages(sessionId: string, messages: readonly OpencodeMessage[], issuedConnGen: number): boolean {
  const { epoch, connGen } = conn();
  const views = runViewsOf(messages);
  let state = getRunMap(sessionId);
  if (views.length > 0) {
    state = mergeRunViews(state, views, { currentEpoch: epoch, connGen, issuedConnGen });
    put(sessionId, state);
  }
  return issuedConnGen >= connGen && hasStaleMembership(messages, getRunMap(sessionId).minGen);
}

/**
 * A FULL transcript answer replaced the loaded messages: runs no message references and the turn in progress does not
 * hold are no longer drawn — drop them (spec "Run revisions": pruned on refetch). Never for a splice, a stale-connection
 * answer, or while the connection's epoch is unknown.
 */
function pruneAfterFullFetch(sessionId: string, messages: readonly OpencodeMessage[], issuedConnGen: number): void {
  const { epoch, connGen } = conn();
  if (epoch == null || issuedConnGen < connGen) return;
  const keep = runIdsOfMessages(messages);
  for (const id of liveIds.get(sessionId) ?? []) keep.add(id);
  put(sessionId, pruneRunMap(getRunMap(sessionId), keep));
}

/** A live `toolRuns` frame. Returns true when it was a canonical rebuild (the caller refetches once). */
export function ingestRunFrame(sessionId: string, frame: StreamToolRunsPayload): boolean {
  const { epoch, connGen } = conn();
  if (epoch == null || frame.epoch === epoch) {
    const ids = [...(frame.runs ?? []).map((r) => r.id), ...(frame.layout as { kind?: string; id?: string }[] | undefined ?? []).flatMap((b) => (b.kind === "run" && b.id ? [b.id] : []))];
    const held = frame.full ? new Set<string>() : (liveIds.get(sessionId) ?? new Set<string>());
    for (const id of ids) held.add(id);
    liveIds.set(sessionId, held);
  }
  let state = mergeRunViews(getRunMap(sessionId), frame.runs ?? [], { currentEpoch: epoch, connGen });
  if (frame.rebuilt && frame.epoch === epoch) state = applyRunRebuild(state, frame.retired ?? [], frame.gen);
  put(sessionId, state);
  return frame.rebuilt === true && frame.epoch === epoch;
}

export function forgetRunSession(sessionId: string): void {
  liveIds.delete(sessionId);
  if (maps.delete(sessionId)) notify();
}

/** Test seam. */
export function resetRunEpochState(): void {
  maps.clear();
  liveIds.clear();
  notify();
}

/**
 * `opencodeMessages` with the run views ingested under the connection generation the request was ISSUED under. `onStale`
 * is called when the answer carries a membership older than the session's `minGen` (a rebuild happened meanwhile).
 */
export async function opencodeMessagesTracked(
  sessionId: string,
  opts: { limit?: number; view?: boolean } | undefined,
  onStale?: () => void,
): Promise<OpencodeMessage[]> {
  const issued = conn().connGen;
  const messages = await window.api.opencodeMessages(sessionId, opts);
  const stale = ingestRunMessages(sessionId, messages, issued);
  pruneAfterFullFetch(sessionId, messages, issued);
  if (stale) onStale?.();
  return messages;
}

/** `opencodeMessage` (a splice), tracked the same way. A lone message is always self-contained (full run views). */
export async function opencodeMessageTracked(
  sessionId: string,
  messageId: string,
  opts: { view?: boolean } | undefined,
  onStale?: () => void,
): Promise<OpencodeMessage | null> {
  const issued = conn().connGen;
  const message = await window.api.opencodeMessage(sessionId, messageId, opts);
  if (message && ingestRunMessages(sessionId, [message], issued)) onStale?.();
  return message;
}
