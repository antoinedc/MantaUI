// ===== useTranscriptState =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the transcript rendering
// pipeline: message-list state, delta buffering/flushing, and the inactive-
// panel performance gate.
//
// This is the hook that owns `messages` — the single source of truth for
// the transcript. It exposes setMessages so the SSE bus hook can write to it.
//
// Scrolling, pin-to-bottom and follow-output are owned by react-virtuoso
// (BET-679) — the hook no longer carries any scroll math or scroll refs.
//
// Key behaviors:
//   - Buffered text-delta flush (250ms max-age, boundary-based)
//   - 300ms-debounced full transcript refetch
//   - Per-message incremental splice (300ms debounce)
//   - Inactive-panel gating (skip refetch + delta flush when hidden)
//   - Session-change reset
//   - Catch-up on reactivation (immediate fetch + generation guard; inert
//     unless a host calls catchUp())

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpencodeMessage } from "../../shared/types";
import { forgetRunSession, opencodeMessageTracked, opencodeMessagesTracked } from "../runEpoch";
import {
  mergeBufferedDeltas,
  collectChildSessionIds,
  reconcileOptimisticUser,
  markReconciledFromOptimistic,
  createEntryMotionState,
  type EntryMotionState,
} from "../chatUtils";

/** How many of the most recent messages the tail-first mount fetch pulls.
 *  "Load earlier" afterwards replaces the tail with the full history. The
 *  Transcript's LoadEarlier control and every fetchOpts() decision read this. */
export const TRANSCRIPT_TAIL_LIMIT = 100;

export type CatchUpStatus = "idle" | "catching" | "failed";
export type CatchUpResult =
  | { ok: true; before: OpencodeMessage[] | null; after: OpencodeMessage[] }
  | { ok: false; stale?: true };

export type TranscriptState = {
  messages: OpencodeMessage[] | null;
  setMessages: React.Dispatch<React.SetStateAction<OpencodeMessage[] | null>>;
  refreshing: boolean;
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  childSessionIds: React.MutableRefObject<Set<string>>;
  childMessages: Map<string, OpencodeMessage[]>;
  setChildMessages: React.Dispatch<React.SetStateAction<Map<string, OpencodeMessage[]>>>;
  expandedTasks: Set<string>;
  setExpandedTasks: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedTasksRef: React.MutableRefObject<Set<string>>;
  childMessagesRef: React.MutableRefObject<Map<string, OpencodeMessage[]>>;
  loadedAllRef: React.MutableRefObject<boolean>;
  // The options for the next transcript fetch: { limit: TRANSCRIPT_TAIL_LIMIT }
  // until loadedAllRef flips, then {} (full history).
  fetchOpts: () => { limit?: number; view: true };
  // Tail-first loading for CHILD transcripts (BET-683). `childLoadedAllRef`
  // maps each childSessionId to whether its FULL history has been pulled (via
  // "Load earlier"); until true, child fetches pass { limit:
  // TRANSCRIPT_TAIL_LIMIT }. `loadingChildEarlier` tracks in-flight full-pulls
  // so the TaskCard's "Load earlier" button can disable + show feedback.
  childLoadedAllRef: React.MutableRefObject<Map<string, boolean>>;
  loadingChildEarlier: Set<string>;
  isActiveRef: React.MutableRefObject<boolean>;
  refetchOwedWhileInactive: React.MutableRefObject<boolean>;
  wantQuestionScroll: React.MutableRefObject<boolean>;
  // Apply one box-flushed delta (stream.flush) into the transcript
  // (BET-551 / §17 — the box detects flush boundaries now). Returns the
  // number of parts that didn't yet match a message, so useSseBus can refetch
  // when a delta arrived ahead of its part snapshot.
  applyStreamFlush: (d: {
    partID: string;
    messageID: string;
    field: string;
    text: string;
  }) => number;
  scheduleRefetch: () => void;
  // Catch-up on reactivation (spec 2026-10-30-session-catch-up B5). Inert
  // unless a host calls catchUp(): status stays "idle" and nothing else reads it.
  catchUpStatus: CatchUpStatus;
  catchUp: () => Promise<CatchUpResult>;
  resetCatchUp: () => void;
  spliceMessage: (messageId: string) => void;
  fetchChildTranscript: (childId: string) => void;
  // Pull the FULL child transcript once the user clicks "Load earlier" on an
  // expanded TaskCard. Flips childLoadedAllRef for that child and replaces
  // the tail with the whole history.
  loadEarlierChildTranscript: (childId: string) => void;
  toggleTaskExpand: (childId: string) => void;
};

export function useTranscriptState(params: {
  sessionId: string;
  isActive: boolean;
  // The entry-motion state, owned by the parent (ChatPanel) and shared with
  // Transcript. The reconcile path registers a canonical id here so the swap
  // from its optimistic placeholder is treated as already-entered (no second
  // "pop"). Optional: when absent, the reconcile just skips the registration.
  motionStateRef?: React.MutableRefObject<EntryMotionState | null>;
}): TranscriptState {
  const { sessionId, isActive, motionStateRef } = params;
  if (motionStateRef) motionStateRef.current ??= createEntryMotionState();

  const [messages, setMessages] = useState<OpencodeMessage[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The transcript as committed, for a catch-up's "before" snapshot (read at the
  // moment its fetch starts, never from a stale closure).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Catch-up state. `catchUpGenRef` is the generation token (B1): deactivation,
  // session change and a newer catch-up all bump it, and a result is applied
  // only while its token is still current. `catchUpDoneRef` is false while a
  // catch-up is in flight or did not succeed (nothing to remember otherwise).
  const [catchUpStatus, setCatchUpStatus] = useState<CatchUpStatus>("idle");
  const catchUpGenRef = useRef(0);
  const catchUpDoneRef = useRef(true);
  // Tail-first loading: until the user clicks "Load earlier" (or the full
  // history has otherwise been pulled), every transcript fetch passes
  // { limit: TRANSCRIPT_TAIL_LIMIT }. Reset on session change below.
  const loadedAllRef = useRef(false);
  const fetchOpts = useCallback(
    (): { limit?: number; view: true } =>
      loadedAllRef.current ? { view: true } : { limit: TRANSCRIPT_TAIL_LIMIT, view: true },
    [],
  );
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const refetchOwedWhileInactive = useRef(false);
  const spliceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-message max-wait guard: records when the CURRENT (un-fired) splice
  // debounce for a message first started. A running tool emits
  // message.part.updated every ~20-40ms — far faster than the 300ms debounce —
  // so resetting the timer on every event would starve it and nothing would
  // render until the turn idles. If the debounce has been pending longer than
  // SPLICE_MAX_WAIT_MS we let the in-flight timer fire instead of resetting it,
  // so live output updates at a steady ~4Hz cap.
  const spliceFirstScheduledAt = useRef<Map<string, number>>(new Map());
  const SPLICE_MAX_WAIT_MS = 250;
  const childSessionIds = useRef<Set<string>>(new Set());
  const [childMessages, setChildMessages] = useState<
    Map<string, OpencodeMessage[]>
  >(() => new Map());
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  const expandedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    expandedTasksRef.current = expandedTasks;
  }, [expandedTasks]);
  const childMessagesRef = useRef<Map<string, OpencodeMessage[]>>(new Map());
  useEffect(() => {
    childMessagesRef.current = childMessages;
  }, [childMessages]);
  // Tail-first loading for child transcripts (BET-683). Mirrors loadedAllRef
  // but per-child: until an expanded TaskCard's "Load earlier" is clicked, a
  // child fetch passes { limit: TRANSCRIPT_TAIL_LIMIT }; once clicked it pulls
  // the full history and sets this child's flag so later refetches stay full.
  const childLoadedAllRef = useRef<Map<string, boolean>>(new Map());
  const [loadingChildEarlier, setLoadingChildEarlier] = useState<Set<string>>(
    () => new Set(),
  );
  // childRefetchTimers are managed by the ChatPanel caller (see scheduleChildRefetch param).
  const wantQuestionScroll = useRef(false);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply one box-flushed delta (stream.flush) into the transcript
  // (BET-551 / §17). The box detects flush boundaries and emits the flushed
  // chunk ready-to-merge, so there is no renderer-side buffering or boundary
  // detection here — this just appends the chunk to the named part field and
  // reports how many parts didn't match a known message (caller refetches).
  const applyStreamFlush = useCallback((d: {
    partID: string;
    messageID: string;
    field: string;
    text: string;
  }): number => {
    let unmatchedCount = 0;
    setMessages((prev) => {
      const { messages: next, unmatched } = mergeBufferedDeltas(
        prev,
        new Map([[d.partID, { messageID: d.messageID, field: d.field, text: d.text }]]),
      );
      unmatchedCount = unmatched.length;
      return next ?? prev;
    });
    return unmatchedCount;
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (!isActiveRef.current) {
      refetchOwedWhileInactive.current = true;
      return;
    }
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      // The panel was hidden during the debounce: a hidden panel does not fetch.
      if (!isActiveRef.current) {
        refetchOwedWhileInactive.current = true;
        return;
      }
      setRefreshing(true);
      // Tracked: the run views it carries are merged under the connection generation it was ISSUED under (runEpoch.ts); an
      // answer carrying a membership a rebuild has retired schedules one more fetch.
      opencodeMessagesTracked(sessionId, fetchOpts(), scheduleRefetch)
        .then((m) => {
          setMessages(m);
          // A later full refetch succeeding clears a catch-up failure (B2).
          setCatchUpStatus((s) => (s === "failed" ? "idle" : s));
          for (const cid of collectChildSessionIds(m)) {
            childSessionIds.current.add(cid);
          }
        })
        .catch(() => { /* keep last-known state */ })
        .finally(() => setRefreshing(false));
    }, 300);
  }, [sessionId, setRefreshing, fetchOpts]);

  // Pull the canonical transcript NOW because the panel just became active
  // with a refetch owed (B1/B5). Supersedes any pending ordinary-refetch timer.
  const catchUp = useCallback(async (): Promise<CatchUpResult> => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
    refetchOwedWhileInactive.current = false;
    const gen = ++catchUpGenRef.current;
    const sid = sessionId;
    const before = messagesRef.current;
    catchUpDoneRef.current = false;
    setCatchUpStatus("catching");
    setRefreshing(true);
    const isCurrent = () =>
      gen === catchUpGenRef.current && isActiveRef.current && sessionIdRef.current === sid;
    // A result discarded because a NEWER catch-up for this same live panel took
    // over leaves the owing to that one; any other discard leaves it owed.
    const discard = (): CatchUpResult => {
      const sameSession = sessionIdRef.current === sid;
      const superseded = isActiveRef.current && sameSession && !catchUpDoneRef.current;
      if (sameSession && !superseded) refetchOwedWhileInactive.current = true;
      setRefreshing(false);
      return { ok: false, stale: true };
    };
    try {
      const after = await opencodeMessagesTracked(sid, fetchOpts(), scheduleRefetch);
      if (!isCurrent()) return discard();
      setMessages(after);
      for (const cid of collectChildSessionIds(after)) {
        childSessionIds.current.add(cid);
      }
      catchUpDoneRef.current = true;
      setCatchUpStatus("idle");
      setRefreshing(false);
      return { ok: true, before, after };
    } catch {
      if (!isCurrent()) return discard();
      refetchOwedWhileInactive.current = true;
      setRefreshing(false);
      setCatchUpStatus("failed");
      return { ok: false };
    }
  }, [sessionId, setRefreshing, fetchOpts, scheduleRefetch]);

  // Deactivation / session change: any in-flight catch-up result is now stale.
  // The refetch stays owed unless the last catch-up succeeded.
  const resetCatchUp = useCallback(() => {
    catchUpGenRef.current++;
    setCatchUpStatus("idle");
    if (!catchUpDoneRef.current) refetchOwedWhileInactive.current = true;
  }, []);

  const spliceMessage = useCallback((messageId: string) => {
    if (!messageId) {
      scheduleRefetch();
      return;
    }
    if (!isActiveRef.current) {
      refetchOwedWhileInactive.current = true;
      return;
    }
    const existing = spliceTimers.current.get(messageId);
    if (existing) {
      // Max-wait guard: if this message's splice has already been pending
      // longer than SPLICE_MAX_WAIT_MS, DON'T reset the in-flight timer —
      // let it fire so a continuously-updating message (a running tool
      // streaming output every ~30ms) still renders at a steady cap instead
      // of being starved until the turn idles.
      const firstAt = spliceFirstScheduledAt.current.get(messageId);
      if (firstAt != null && Date.now() - firstAt >= SPLICE_MAX_WAIT_MS) {
        return;
      }
      clearTimeout(existing);
    }
    if (!spliceFirstScheduledAt.current.has(messageId)) {
      spliceFirstScheduledAt.current.set(messageId, Date.now());
    }
    spliceTimers.current.set(
      messageId,
      setTimeout(() => {
        spliceTimers.current.delete(messageId);
        spliceFirstScheduledAt.current.delete(messageId);
        opencodeMessageTracked(sessionId, messageId, { view: true }, scheduleRefetch)
          .then((msg) => {
            if (!msg) {
              scheduleRefetch();
              return;
            }
            setMessages((prev) => {
              if (prev === null) return prev;
              const idx = prev.findIndex((m) => m.info.id === msg.info.id);
              if (idx >= 0) {
                const next = prev.slice();
                // A lone message never carries `view.turn` (a turn needs its neighbours): keep the one the last full
                // fetch gave it, so a splice cannot drop a finished turn's footer.
                const kept = prev[idx].view?.turn;
                next[idx] = kept && !msg.view?.turn ? { ...msg, view: { ...msg.view, turn: kept } } : msg;
                return next;
              }
              // Reconcile: if the incoming message is the real user message
              // for this send, drop any optimistic placeholder that would
              // otherwise survive as a duplicate. The splice below then
              // appends the canonical message into its time-sorted position.
              const cleaned = reconcileOptimisticUser(prev, msg) ?? prev;
              // The canonical id that replaced an optimistic placeholder must
              // not replay the entry pop — its bubble already animated. (The
              // handover heuristic alone can miss this when sends overlap.)
              if (cleaned !== prev && motionStateRef?.current) {
                markReconciledFromOptimistic(motionStateRef.current, msg.info.id);
              }
              const t = msg.info.time?.created ?? 0;
              const insertAt = cleaned.findIndex(
                (m) => (m.info.time?.created ?? 0) > t,
              );
              const next = cleaned.slice();
              if (insertAt < 0) next.push(msg);
              else next.splice(insertAt, 0, msg);
              return next;
            });
            for (const cid of collectChildSessionIds([msg])) {
              childSessionIds.current.add(cid);
            }
          })
          .catch(() => scheduleRefetch());
      }, 300),
    );
  }, [sessionId, scheduleRefetch]);

  const fetchChildTranscript = useCallback((childId: string) => {
    // Tail-first, matching the main session: the first fetch pulls only the
    // tail unless "Load earlier" has already pulled the full history.
    opencodeMessagesTracked(
      childId,
      childLoadedAllRef.current.get(childId) ? { view: true } : { limit: TRANSCRIPT_TAIL_LIMIT, view: true },
    )
      .then((m) => {
        setChildMessages((prev) => {
          const next = new Map(prev);
          next.set(childId, m);
          return next;
        });
      })
      .catch(() => { /* non-fatal */ });
  }, []);

  const loadEarlierChildTranscript = useCallback((childId: string) => {
    setLoadingChildEarlier((prev) => new Set(prev).add(childId));
    opencodeMessagesTracked(childId, { view: true })
      .then((m) => {
        childLoadedAllRef.current.set(childId, true);
        setChildMessages((prev) => new Map(prev).set(childId, m));
      })
      .catch(() => { /* non-fatal — keep the tail; the button can be retried */ })
      .finally(() => {
        setLoadingChildEarlier((prev) => {
          const next = new Set(prev);
          next.delete(childId);
          return next;
        });
      });
  }, []);

  const toggleTaskExpand = useCallback((childId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) {
        next.delete(childId);
      } else {
        next.add(childId);
        fetchChildTranscript(childId);
      }
      return next;
    });
  }, [fetchChildTranscript]);

  // Session-change reset
  useEffect(() => {
    loadedAllRef.current = false;
    // A new session starts clean: nothing from the old one is owed or in flight.
    catchUpGenRef.current++;
    catchUpDoneRef.current = true;
    refetchOwedWhileInactive.current = false;
    setCatchUpStatus("idle");
    childLoadedAllRef.current.clear();
    setLoadingChildEarlier(new Set());
    // Cancel any in-flight per-message splice from the PREVIOUS session so a
    // late timer can't refetch + write a stale message into the new session's
    // list. Also clear the max-wait bookkeeping.
    for (const t of spliceTimers.current.values()) clearTimeout(t);
    spliceTimers.current.clear();
    spliceFirstScheduledAt.current.clear();
  }, [sessionId]);

  // The run values of a session (and its subagent children) this hook stops showing are dropped with it — the map is
  // per-session app-lifetime state and would otherwise hold every run ever seen.
  useEffect(() => {
    const children = childSessionIds.current;
    return () => {
      forgetRunSession(sessionId);
      for (const cid of children) forgetRunSession(cid);
    };
  }, [sessionId]);

  // Unmount cleanup — clear EVERY pending debounce timer. A timer surviving
  // unmount fires against a torn-down environment (CI flake: "window is not
  // defined" after jsdom teardown in vitest) and would also setState on an
  // unmounted component. The session-change effect above only covers splice
  // timers on sessionId CHANGE, not the final unmount.
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      for (const t of spliceTimers.current.values()) clearTimeout(t);
      spliceTimers.current.clear();
    };
  }, []);

  return {
    messages,
    setMessages,
    refreshing,
    setRefreshing,
    childSessionIds,
    childMessages,
    setChildMessages,
    expandedTasks,
    setExpandedTasks,
    expandedTasksRef,
    childMessagesRef,
    isActiveRef,
    refetchOwedWhileInactive,
    wantQuestionScroll,
    applyStreamFlush,
    scheduleRefetch,
    catchUpStatus,
    catchUp,
    resetCatchUp,
    spliceMessage,
    fetchChildTranscript,
    loadEarlierChildTranscript,
    toggleTaskExpand,
    loadedAllRef,
    fetchOpts,
    childLoadedAllRef,
    loadingChildEarlier,
  };
}
