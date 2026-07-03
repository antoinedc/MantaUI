// ===== useTranscriptState =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the transcript rendering
// pipeline: message-list state, pin-to-bottom scroll behavior, delta
// buffering/flushing, and the inactive-panel performance gate.
//
// This is the hook that owns `messages` — the single source of truth for
// the transcript. It exposes setMessages so the SSE bus hook can write to it.
// The scroll/pin logic is self-contained but depends on `scrollRef` and
// `isActive` props.
//
// Key behaviors:
//   - Buffered text-delta flush (250ms max-age, boundary-based)
//   - 300ms-debounced full transcript refetch
//   - Per-message incremental splice (300ms debounce)
//   - Inactive-panel gating (skip refetch + delta flush when hidden)
//   - Post-commit stick-to-bottom (useLayoutEffect reads live DOM)
//   - Session-change reset

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OpencodeMessage } from "../../shared/types";
import {
  findFlushBoundary,
  mergeBufferedDeltas,
  collectChildSessionIds,
  type PendingDelta,
} from "../chatUtils";

export type TranscriptState = {
  messages: OpencodeMessage[] | null;
  setMessages: React.Dispatch<React.SetStateAction<OpencodeMessage[] | null>>;
  scrollRef: React.RefObject<HTMLDivElement>;
  pinnedToBottom: React.MutableRefObject<boolean>;
  stickToBottom: () => void;
  refreshing: boolean;
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  childSessionIds: React.MutableRefObject<Set<string>>;
  childMessages: Map<string, OpencodeMessage[]>;
  setChildMessages: React.Dispatch<React.SetStateAction<Map<string, OpencodeMessage[]>>>;
  expandedTasks: Set<string>;
  setExpandedTasks: React.Dispatch<React.SetStateAction<Set<string>>>;
  expandedTasksRef: React.MutableRefObject<Set<string>>;
  childMessagesRef: React.MutableRefObject<Map<string, OpencodeMessage[]>>;
  scheduleRefetchRef: React.MutableRefObject<(() => void) | null>;
  isActiveRef: React.MutableRefObject<boolean>;
  refetchOwedWhileInactive: React.MutableRefObject<boolean>;
  prevScrollHeight: React.MutableRefObject<number>;
  questionCardRef: React.RefObject<HTMLDivElement>;
  wantQuestionScroll: React.MutableRefObject<boolean>;
  flushPendingDeltas: (force: boolean) => number;
  scheduleFlush: () => void;
  scheduleRefetch: () => void;
  spliceMessage: (messageId: string) => void;
  fetchChildTranscript: (childId: string) => void;
  toggleTaskExpand: (childId: string) => void;
  // Exposed for useSseBus — the delta buffer internals.
  pendingDeltas: React.MutableRefObject<Map<string, PendingDelta>>;
  flushTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  FLUSH_MAX_AGE_MS: number;
  oldestPendingAt: React.MutableRefObject<number | null>;
};

export function useTranscriptState(params: {
  sessionId: string;
  isActive: boolean;
}): TranscriptState {
  const { sessionId, isActive } = params;

  const [messages, setMessages] = useState<OpencodeMessage[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const prevScrollHeight = useRef(0);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const refetchOwedWhileInactive = useRef(false);
  const scheduleRefetchRef = useRef<(() => void) | null>(null);
  const spliceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingDeltas = useRef<Map<string, PendingDelta>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_MAX_AGE_MS = 250;
  const oldestPendingAt = useRef<number | null>(null);
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
  const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const questionCardRef = useRef<HTMLDivElement>(null);
  const wantQuestionScroll = useRef(false);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Buffered text-delta flush
  const flushPendingDeltas = useCallback((force: boolean): number => {
    const buf = pendingDeltas.current;
    if (buf.size === 0) return 0;
    const toApply = new Map<string, PendingDelta>();
    for (const [partID, d] of buf) {
      if (force) {
        toApply.set(partID, d);
        continue;
      }
      const idx = findFlushBoundary(d.text);
      if (idx <= 0) continue;
      toApply.set(partID, { ...d, text: d.text.slice(0, idx) });
      const remainder = d.text.slice(idx);
      if (remainder.length > 0) {
        buf.set(partID, { ...d, text: remainder });
      } else {
        buf.delete(partID);
      }
    }
    if (force) buf.clear();
    if (toApply.size === 0) return 0;
    let unmatchedCount = 0;
    setMessages((prev) => {
      const { messages: next, unmatched } = mergeBufferedDeltas(
        prev,
        toApply,
      );
      unmatchedCount = unmatched.length;
      return next ?? prev;
    });
    if (buf.size === 0) oldestPendingAt.current = null;
    return unmatchedCount;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return;
    const now = Date.now();
    const age =
      oldestPendingAt.current != null ? now - oldestPendingAt.current : 0;
    const delay = Math.max(0, Math.min(16, FLUSH_MAX_AGE_MS - age));
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const now2 = Date.now();
      const aged =
        oldestPendingAt.current != null &&
        now2 - oldestPendingAt.current >= FLUSH_MAX_AGE_MS;
      const unmatched = flushPendingDeltas(aged);
      if (unmatched > 0) scheduleRefetchRef.current?.();
      if (pendingDeltas.current.size > 0) {
        scheduleFlush();
      }
    }, delay);
  }, [flushPendingDeltas]);

  const scheduleRefetch = useCallback(() => {
    if (!isActiveRef.current) {
      refetchOwedWhileInactive.current = true;
      return;
    }
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      window.api
        .opencodeMessages(sessionId)
        .then((m) => {
          setMessages(m);
          for (const cid of collectChildSessionIds(m)) {
            childSessionIds.current.add(cid);
          }
        })
        .catch(() => { /* keep last-known state */ });
    }, 300);
  }, [sessionId]);

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
    if (existing) clearTimeout(existing);
    spliceTimers.current.set(
      messageId,
      setTimeout(() => {
        spliceTimers.current.delete(messageId);
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
              const t = msg.info.time?.created ?? 0;
              const insertAt = prev.findIndex(
                (m) => (m.info.time?.created ?? 0) > t,
              );
              const next = prev.slice();
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

  // Scroll listener
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollHeight, scrollTop, clientHeight } = el;
      pinnedToBottom.current = scrollHeight - scrollTop - clientHeight <= 8;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Session-change reset
  useEffect(() => {
    prevScrollHeight.current = 0;
    pinnedToBottom.current = true;
  }, [sessionId]);

  // Post-commit stick layout effect
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasPinned = prevScrollHeight.current === 0 ||
      (el.scrollHeight - el.scrollTop - el.clientHeight) <= 8;
    if (wasPinned) {
      el.scrollTop = el.scrollHeight;
      pinnedToBottom.current = true;
    } else {
      pinnedToBottom.current = false;
    }
    prevScrollHeight.current = el.scrollHeight;
  }, [messages]);

  return {
    messages,
    setMessages,
    scrollRef,
    pinnedToBottom,
    stickToBottom,
    refreshing,
    setRefreshing,
    childSessionIds,
    childMessages,
    setChildMessages,
    expandedTasks,
    setExpandedTasks,
    expandedTasksRef,
    childMessagesRef,
    scheduleRefetchRef,
    isActiveRef,
    refetchOwedWhileInactive,
    prevScrollHeight,
    questionCardRef,
    wantQuestionScroll,
    flushPendingDeltas,
    scheduleFlush,
    scheduleRefetch,
    spliceMessage,
    fetchChildTranscript,
    toggleTaskExpand,
    pendingDeltas,
    flushTimer,
    FLUSH_MAX_AGE_MS,
    oldestPendingAt,
  };
}
