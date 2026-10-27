// ===== Auto-handoff — client cache + bus subscription =====
//
// One cache of handoff records and per-session handoff info, shared by every
// surface that draws a card (the inline `handoff` tool part, the pinned card,
// the continuation notice, Previous sessions). Kept apart from store.ts: it is
// a feature-local read model over the six `handoff:*` rpc channels, and it must
// be resettable on its own in tests.
//
// The `handoff` bus kind carries no text ("on every change"), so an event only
// tells us WHICH record/sessions moved; the cache refetches what it holds. The
// subscription is refcounted: the first surface to mount attaches the single
// `window.api.onHandoff` listener (+ the stream `resync` that follows a
// reconnect), the last one to unmount detaches it. Panels mount/unmount per
// session, so no one panel may own the listener.

import { useEffect } from "react";
import { create } from "zustand";
import type { HandoffEventPayload, HandoffRecord, HandoffSessionInfo } from "../shared/api";
import { eventOfRecord } from "./handoff";

export type RecordStatus = "loading" | "ready" | "expired" | "error";
export interface RecordEntry {
  status: RecordStatus;
  record?: HandoffRecord;
  error?: string;
}

export type SessionStatus = "loading" | "ready" | "error";
export interface SessionEntry {
  status: SessionStatus;
  info?: HandoffSessionInfo;
  error?: string;
}

interface HandoffCache {
  records: Record<string, RecordEntry>;
  sessions: Record<string, SessionEntry>;
}

export const useHandoffStore = create<HandoffCache>(() => ({ records: {}, sessions: {} }));

export function resetHandoffStore(): void {
  useHandoffStore.setState({ records: {}, sessions: {} });
  switched.clear();
}

// Record ids whose REPLACEMENT this client already acted on: a commit is
// announced by the bus AND by the initiating client's own start response, and a
// pane must only switch (and carry its composer) once.
const switched = new Set<string>();
/** True the first time `id` is claimed, false after. */
export function claimSwitch(id: string): boolean {
  if (switched.has(id)) return false;
  switched.add(id);
  return true;
}
/** Give the claim back (the switch failed and may be retried). */
export function releaseSwitch(id: string): void {
  switched.delete(id);
}

const isExpiredError = (e: unknown) => /expired|not.?found|\b404\b/i.test(String((e as Error)?.message ?? e));
const errText = (e: unknown) => String((e as Error)?.message ?? e);

// A fetch that lands after a newer one must not roll a card back (a `ready`
// response arriving after `starting` would re-enable the buttons).
function newer(a: HandoffRecord | undefined, b: HandoffRecord): HandoffRecord {
  return a && a.updatedAt > b.updatedAt ? a : b;
}

export function applyRecord(record: HandoffRecord): void {
  useHandoffStore.setState((s) => ({
    records: {
      ...s.records,
      [record.id]: { status: "ready", record: newer(s.records[record.id]?.record, record) },
    },
  }));
}

// De-dupe concurrent loads of one key (many cards, one record).
const inflightRecords = new Map<string, Promise<void>>();
const inflightSessions = new Map<string, Promise<HandoffSessionInfo | null>>();

export function loadRecord(id: string): Promise<void> {
  const pending = inflightRecords.get(id);
  if (pending) return pending;
  const prev = useHandoffStore.getState().records[id];
  if (!prev) {
    useHandoffStore.setState((s) => ({ records: { ...s.records, [id]: { status: "loading" } } }));
  }
  const run = (async () => {
    try {
      const res = await window.api.handoffGet({ id });
      if (res?.handoff) applyRecord(res.handoff);
      else throw new Error("expired");
    } catch (e) {
      const keep = useHandoffStore.getState().records[id]?.record;
      useHandoffStore.setState((s) => ({
        records: {
          ...s.records,
          [id]: isExpiredError(e)
            ? { status: "expired" }
            : { status: "error", error: errText(e), ...(keep ? { record: keep } : {}) },
        },
      }));
    } finally {
      inflightRecords.delete(id);
    }
  })();
  inflightRecords.set(id, run);
  return run;
}

export function loadSession(sessionId: string): Promise<HandoffSessionInfo | null> {
  const pending = inflightSessions.get(sessionId);
  if (pending) return pending;
  const prev = useHandoffStore.getState().sessions[sessionId];
  if (!prev) {
    useHandoffStore.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: { status: "loading" } } }));
  }
  const run = (async (): Promise<HandoffSessionInfo | null> => {
    try {
      const res = await window.api.handoffList({ sessionId });
      // A box without the feature (or the demo transport) answers null.
      const info: HandoffSessionInfo = {
        records: Array.isArray(res?.records) ? res.records : [],
        links: res?.links ?? null,
        continuation: res?.continuation ?? null,
        ...(typeof res?.dismissed === "boolean" ? { dismissed: res.dismissed } : {}),
        ...(res?.mode ? { mode: res.mode } : {}),
        ...(typeof res?.modeIsDefault === "boolean" ? { modeIsDefault: res.modeIsDefault } : {}),
      };
      for (const r of info.records) applyRecord(r);
      useHandoffStore.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: { status: "ready", info } } }));
      return info;
    } catch (e) {
      const keep = useHandoffStore.getState().sessions[sessionId]?.info;
      useHandoffStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: { status: "error", error: errText(e), ...(keep ? { info: keep } : {}) },
        },
      }));
      return null;
    } finally {
      inflightSessions.delete(sessionId);
    }
  })();
  inflightSessions.set(sessionId, run);
  return run;
}

/** Overlay fields onto a session's cached info (an optimistic edit, or a write the box just confirmed). */
export function patchSessionInfo(sessionId: string, patch: Partial<HandoffSessionInfo>): void {
  useHandoffStore.setState((s) => {
    const cur = s.sessions[sessionId];
    const info: HandoffSessionInfo = { records: [], links: null, continuation: null, ...cur?.info, ...patch };
    return { sessions: { ...s.sessions, [sessionId]: { status: "ready", info } } };
  });
}

/** Refetch everything this client already holds that the event could have changed. */
function refreshForEvent(ev: HandoffEventPayload): void {
  const { records, sessions } = useHandoffStore.getState();
  if (records[ev.id]) void loadRecord(ev.id);
  for (const sid of [ev.fromSessionId, ev.successorId]) {
    if (sid && sessions[sid]) void loadSession(sid);
  }
}

function refreshAll(): void {
  const { records, sessions } = useHandoffStore.getState();
  for (const id of Object.keys(records)) void loadRecord(id);
  for (const sid of Object.keys(sessions)) void loadSession(sid);
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

type EventListener = (ev: HandoffEventPayload) => void;
const listeners = new Set<EventListener>();
let refs = 0;
let detach: (() => void) | null = null;

function attach(): () => void {
  const api = window.api as Partial<typeof window.api>;
  const offs: Array<() => void> = [];
  const keep = (off: unknown) => {
    if (typeof off === "function") offs.push(off as () => void);
  };
  // Pre-pairing preload subset / demo transport: nothing to subscribe to.
  if (api.onHandoff) {
    keep(
      api.onHandoff((ev) => {
        refreshForEvent(ev);
        for (const fn of Array.from(listeners)) {
          try {
            fn(ev);
          } catch (e) {
            console.error("[handoff] listener threw", e);
          }
        }
      }),
    );
  }
  // After a reconnect the socket may have dropped events: reload what we hold.
  if (api.onStreamEvent) {
    keep(
      api.onStreamEvent((ev) => {
        if (ev.sub === "resync") refreshAll();
      }),
    );
  }
  return () => offs.forEach((off) => off());
}

/**
 * Hold the bus open. `onEvent` (optional) hears every handoff event after the
 * cache has started refetching. Returns the release function; the listener is
 * detached when the last holder releases.
 */
export function subscribeHandoff(onEvent?: EventListener): () => void {
  if (onEvent) listeners.add(onEvent);
  if (refs++ === 0) detach = attach();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (onEvent) listeners.delete(onEvent);
    if (--refs === 0) {
      detach?.();
      detach = null;
    }
  };
}

/**
 * The initiating client learned of a commit from its own start response; give
 * the listeners the same event the bus would have (the bus may be late or have
 * dropped it). Each listener de-dupes by record id.
 */
export function announceRecord(record: HandoffRecord): void {
  applyRecord(record);
  const ev = eventOfRecord(record);
  refreshForEvent(ev);
  for (const fn of Array.from(listeners)) {
    try {
      fn(ev);
    } catch (e) {
      console.error("[handoff] listener threw", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const MISSING: RecordEntry = { status: "loading" };

/** One record's live entry; fetched on first use, refetched on every `handoff` event that names it. */
export function useHandoffRecord(id: string | null): RecordEntry | null {
  const entry = useHandoffStore((s) => (id ? s.records[id] : undefined));
  useEffect(() => {
    if (!id) return;
    const release = subscribeHandoff();
    if (!useHandoffStore.getState().records[id]) void loadRecord(id);
    return release;
  }, [id]);
  if (!id) return null;
  return entry ?? MISSING;
}

/** One session's handoff info (records, links, continuation); refetched when the box announces a change to it. */
export function useHandoffSession(sessionId: string | null): SessionEntry | null {
  const entry = useHandoffStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  useEffect(() => {
    if (!sessionId) return;
    const release = subscribeHandoff();
    void loadSession(sessionId);
    return release;
  }, [sessionId]);
  return entry ?? null;
}
