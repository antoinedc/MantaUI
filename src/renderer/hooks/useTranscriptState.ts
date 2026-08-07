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

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpencodeMessage } from "../../shared/types";
import {
  mergeBufferedDeltas,
  collectChildSessionIds,
  reconcileOptimisticUser,
} from "../chatUtils";

/** How many of the most recent messages the tail-first mount fetch pulls.
 *  "Load earlier" afterwards replaces the tail with the full history. The
 *  Transcript's LoadEarlier control and every fetchOpts() decision read this. */
export const TRANSCRIPT_TAIL_LIMIT = 100;

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
  spliceMessage: (messageId: string) => void;
  fetchChildTranscript: (childId: string) => void;
  toggleTaskExpand: (childId: string) => void;
  // Whether the full transcript has been loaded (via "Load earlier"). Drives
  // fetchOpts: until true, fetches pull the tail; once true they pull the
  // whole history so no earlier message is dropped.
  loadedAllRef: React.MutableRefObject<boolean>;
  // The options for the next transcript fetch: { limit: TRANSCRIPT_TAIL_LIMIT }
  // until loadedAllRef flips, then {} (full history).
  fetchOpts: () => { limit: number } | {};
};

export function useTranscriptState(params: {
  sessionId: string;
  isActive: boolean;
}): TranscriptState {
  const { sessionId, isActive } = params;

  const [messages, setMessages] = useState<OpencodeMessage[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Tail-first loading: until the user clicks "Load earlier" (or the full
  // history has otherwise been pulled), every transcript fetch passes
  // { limit: TRANSCRIPT_TAIL_LIMIT }. Reset on session change below.
  const loadedAllRef = useRef(false);
  const fetchOpts = useCallback(
    (): { limit: number } | {} =>
      loadedAllRef.current ? {} : { limit: TRANSCRIPT_TAIL_LIMIT },
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
      setRefreshing(true);
      window.api
        .opencodeMessages(sessionId, fetchOpts())
        .then((m) => {
          setMessages(m);
          for (const cid of collectChildSessionIds(m)) {
            childSessionIds.current.add(cid);
          }
        })
        .catch(() => { /* keep last-known state */ })
        .finally(() => setRefreshing(false));
    }, 300);
  }, [sessionId, setRefreshing, fetchOpts]);

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
        window.api
          .opencodeMessage(sessionId, messageId)
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
                next[idx] = msg;
                return next;
              }
              // Reconcile: if the incoming message is the real user message
              // for this send, drop any optimistic placeholder that would
              // otherwise survive as a duplicate. The splice below then
              // appends the canonical message into its time-sorted position.
              const cleaned = reconcileOptimisticUser(prev, msg) ?? prev;
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
    window.api
      .opencodeMessages(childId)
      .then((m) => {
        setChildMessages((prev) => {
          const next = new Map(prev);
          next.set(childId, m);
          return next;
        });
      })
      .catch(() => { /* non-fatal */ });
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
    // Cancel any in-flight per-message splice from the PREVIOUS session so a
    // late timer can't refetch + write a stale message into the new session's
    // list. Also clear the max-wait bookkeeping.
    for (const t of spliceTimers.current.values()) clearTimeout(t);
    spliceTimers.current.clear();
    spliceFirstScheduledAt.current.clear();
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
    spliceMessage,
    fetchChildTranscript,
    toggleTaskExpand,
    loadedAllRef,
    fetchOpts,
  };
}
