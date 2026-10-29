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
  runViewsOf,
  setRunEpoch,
  type RunMap,
} from "./toolActivity";
import type { OpencodeMessage, StreamToolRunsPayload } from "../shared/types";

const maps = new Map<string, RunMap>();
const listeners = new Set<() => void>();
const EMPTY = emptyRunMap();
let version = 0;

const notify = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const conn = () => useStore.getState().runEpoch;

/** The run map of a session (a stable empty one when it has none). */
export const getRunMap = (sessionId: string): RunMap => maps.get(sessionId) ?? EMPTY;

/** React binding: re-renders when ANY session's runs change (cheap: the layout memo keys on the map identity). */
export function useRunMap(sessionId: string): RunMap {
  useSyncExternalStore(subscribe, () => version);
  return getRunMap(sessionId);
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
  for (const [sid, state] of maps) maps.set(sid, setRunEpoch(state, epoch ?? null, connGen));
  notify();
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

/** A live `toolRuns` frame. Returns true when it was a canonical rebuild (the caller refetches once). */
export function ingestRunFrame(sessionId: string, frame: StreamToolRunsPayload): boolean {
  const { epoch, connGen } = conn();
  let state = mergeRunViews(getRunMap(sessionId), frame.runs ?? [], { currentEpoch: epoch, connGen });
  if (frame.rebuilt && frame.epoch === epoch) state = applyRunRebuild(state, frame.retired ?? [], frame.gen);
  put(sessionId, state);
  return frame.rebuilt === true && frame.epoch === epoch;
}

export function forgetRunSession(sessionId: string): void {
  if (maps.delete(sessionId)) notify();
}

/** Test seam. */
export function resetRunEpochState(): void {
  maps.clear();
  version = 0;
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
  if (ingestRunMessages(sessionId, messages, issued)) onStale?.();
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
