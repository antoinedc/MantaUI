// ===== useSseBus =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the SSE connection/drain/queue
// state machine. Subscribes to opencode events, routes them to the appropriate
// state setters, and manages the drain-abort logic for queued prompts.
//
// This hook owns:
//   - The SSE subscription (window.api.onOpencodeEvent)
//   - The event handler that routes events to state setters
//   - All event-driven state: running, permissions, questions, stepTokens,
//     compactionState, liveTodos, todosDismissed, retryInfo, finishByMessageId,
//     commandByMessageId, sendError, messageQueue, drainAbortRef
//   - The drain effect ([running, messageQueue] → submit queued prompt)
//   - The abort callback
//   - The replyPermission / replyQuestion / rejectQuestion callbacks
//
// Dependencies injected via params:
//   - setMessages (from useTranscriptState)
//   - scheduleRefetch / spliceMessage / etc. (from useTranscriptState)
//   - input, setInput (for submit)
//   - inputRef (for submit)
//   - running, setRunning (owned by this hook)
//   - messageQueue, setMessageQueue (owned by this hook)
//   - drainAbortRef (owned by this hook)
//   - setSendError (owned by this hook)
//   - permissions, setPermissions (owned by this hook)
//   - questions, setQuestions (owned by this hook)
//   - stepTokens, setStepTokens (owned by this hook)
//   - compactionState, setCompactionState (owned by this hook)
//   - liveTodos, setLiveTodos (owned by this hook)
//   - todosDismissed, setTodosDismissed (owned by this hook)
//   - retryInfo, setRetryInfo (owned by this hook)
//   - finishByMessageId, setFinishByMessageId (owned by this hook)
//   - commandByMessageId, setCommandByMessageId (owned by this hook)
//   - childSessionIds (from useTranscriptState)
//   - childMessagesRef (from useTranscriptState)
//   - expandedTasksRef (from useTranscriptState)
//   - liveChildStatus, setLiveChildStatus (owned by this hook)
//   - childRefetchTimers (from useTranscriptState)
//   - scheduleChildRefetch (from useTranscriptState)
//   - isActiveRef (from useTranscriptState)
//   - refetchOwedWhileInactive (from useTranscriptState)
//   - pendingDeltas, flushPendingDeltas, scheduleFlush (from useTranscriptState)
//   - submit (for drain effect)
//   - submitRef (for drain effect)
//   - compactSession, forkSession (for voice dispatch, but we'll skip that)
//   - selectModel (for voice dispatch, but we'll skip that)
//   - refreshPermissions, refreshQuestions (for server.connected)
//   - setChatAttention, setChatSubagents (for sidebar updates)

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpencodeEvent,
  OpencodeMessage,
  PermissionRequest,
  QuestionRequest,
} from "../../shared/types";
import {
  shouldDropEventForSessionFilter,
  registerChildSessionFromCreated,
  isDrainAbortError,
  shouldAbortForQueuedDrain,
  isToolStepBoundary,
  collectChildSessionIds,
  applyQuestionEvent,
  hydrateQuestion,
  type PendingDelta,
} from "../chatUtils";
import type { TokenUsage } from "../chatShared";
import { useStore } from "../store";

export type SseBus = {
  running: boolean;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  sendError: string | null;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  messageQueue: string[];
  setMessageQueue: React.Dispatch<React.SetStateAction<string[]>>;
  permissions: PermissionRequest[];
  setPermissions: React.Dispatch<React.SetStateAction<PermissionRequest[]>>;
  questions: QuestionRequest[];
  setQuestions: React.Dispatch<React.SetStateAction<QuestionRequest[]>>;
  stepTokens: (TokenUsage & { cost: number }) | null;
  setStepTokens: React.Dispatch<React.SetStateAction<(TokenUsage & { cost: number }) | null>>;
  compactionState: { reason: string; text: string; phase: "running" | "done" } | null;
  setCompactionState: React.Dispatch<React.SetStateAction<{ reason: string; text: string; phase: "running" | "done" } | null>>;
  liveTodos: Array<{ content: string; status: string; priority: string }> | null;
  setLiveTodos: React.Dispatch<React.SetStateAction<Array<{ content: string; status: string; priority: string }> | null>>;
  todosDismissed: boolean;
  setTodosDismissed: React.Dispatch<React.SetStateAction<boolean>>;
  retryInfo: { attempt: number; message: string; next: number; action?: { title: string; message: string; label: string; link?: string } } | null;
  setRetryInfo: React.Dispatch<React.SetStateAction<{ attempt: number; message: string; next: number; action?: { title: string; message: string; label: string; link?: string } } | null>>;
  finishByMessageId: Map<string, import("../chatUtils").TruncationKind>;
  setFinishByMessageId: React.Dispatch<React.SetStateAction<Map<string, import("../chatUtils").TruncationKind>>>;
  commandByMessageId: Map<string, { name: string; arguments: string }>;
  setCommandByMessageId: React.Dispatch<React.SetStateAction<Map<string, { name: string; arguments: string }>>>;
  liveChildStatus: Map<string, "running" | "idle">;
  setLiveChildStatus: React.Dispatch<React.SetStateAction<Map<string, "running" | "idle">>>;
  drainAbortRef: React.MutableRefObject<boolean>;
  branch: string | null;
  setBranch: React.Dispatch<React.SetStateAction<string | null>>;
  submit: () => void;
  submitRef: React.RefObject<() => void>;
  abort: () => void;
  replyPermission: (id: string, reply: "once" | "always" | "reject") => void;
  replyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  rejectQuestion: (q: QuestionRequest) => void;
  // Best-effort cleanup for any question(s) blocking an aborted turn — see
  // BET-116. Owned here (not ChatPanel) because this hook owns `questions`
  // state; exposed so ChatPanel's own user-facing abort path can call the
  // SAME loop instead of duplicating it.
  rejectAllPendingQuestions: () => void;
  refreshPermissions: () => Promise<void>;
  refreshQuestions: () => Promise<void>;
};

export function useSseBus(params: {
  sessionId: string;
  cwd: string;
  setMessages: React.Dispatch<React.SetStateAction<OpencodeMessage[] | null>>;
  scheduleRefetch: () => void;
  spliceMessage: (messageId: string) => void;
  scheduleChildRefetch: (childId: string) => void;
  childSessionIds: React.MutableRefObject<Set<string>>;
  childMessagesRef: React.MutableRefObject<Map<string, OpencodeMessage[]>>;
  expandedTasksRef: React.MutableRefObject<Set<string>>;
  childRefetchTimers: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  isActiveRef: React.MutableRefObject<boolean>;
  refetchOwedWhileInactive: React.MutableRefObject<boolean>;
  pendingDeltas: React.MutableRefObject<Map<string, PendingDelta>>;
  flushPendingDeltas: (force: boolean) => number;
  scheduleFlush: () => void;
  oldestPendingAt: React.MutableRefObject<number | null>;
  FLUSH_MAX_AGE_MS: number;
  submit: () => void;
  submitRef: React.RefObject<() => void>;
  setInput: (v: string) => void;
  // Called (fire-and-forget) on a ProviderAuthError session.error. The async
  // refresh-then-resend logic lives in ChatPanel (with the rest of the panel
  // logic) — this hook only routes the event to the callback.
  onProviderAuthError: () => void;
}): SseBus {
  const {
    sessionId,
    setMessages,
    scheduleRefetch,
    spliceMessage,
    scheduleChildRefetch,
    childSessionIds,
    expandedTasksRef,
    isActiveRef,
    refetchOwedWhileInactive,
    pendingDeltas,
    flushPendingDeltas,
    scheduleFlush,
    oldestPendingAt,
    submit,
    submitRef,
    setInput,
    onProviderAuthError,
  } = params;

  const [running, setRunning] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);
  const drainAbortRef = useRef(false);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const questionsRef = useRef<QuestionRequest[]>([]);
  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);
  const [stepTokens, setStepTokens] = useState<(TokenUsage & { cost: number }) | null>(null);
  const [compactionState, setCompactionState] = useState<{
    reason: string;
    text: string;
    phase: "running" | "done";
  } | null>(null);
  const compactionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liveTodos, setLiveTodos] = useState<
    Array<{ content: string; status: string; priority: string }> | null
  >(null);
  const [todosDismissed, setTodosDismissed] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number;
    message: string;
    next: number;
    action?: { title: string; message: string; label: string; link?: string };
  } | null>(null);
  const [finishByMessageId, setFinishByMessageId] = useState<
    Map<string, import("../chatUtils").TruncationKind>
  >(() => new Map());
  const [commandByMessageId, setCommandByMessageId] = useState<
    Map<string, { name: string; arguments: string }>
  >(() => new Map());
  const [liveChildStatus, setLiveChildStatus] = useState<
    Map<string, "running" | "idle">
  >(() => new Map());
  const [branch, setBranch] = useState<string | null>(null);

  // Any question that was blocking an aborted turn is dead — opencode's
  // pending list never expires on its own (see BET-116), so it would
  // re-latch the sidebar's red "?" glyph on a later replay unless we reject
  // it here. Best-effort, fire-and-forget: cleanup must never surface an
  // error. Called from BOTH abort paths below (user-facing abort and the
  // queued-drain abort) via a single shared helper — do not duplicate the
  // loop.
  const rejectAllPendingQuestions = useCallback(() => {
    const pending = questionsRef.current;
    if (pending.length === 0) return;
    for (const q of pending) {
      if (!q.requestId) continue;
      void window.api.opencodeQuestionReject
        ?.(q.requestId, q.sessionID)
        .catch(() => { /* best-effort cleanup */ });
    }
    setQuestions([]);
    useStore.getState().setChatAttention(sessionId, null);
  }, [sessionId]);

  const abort = useCallback(() => {
    void window.api.opencodeAbort(sessionId)
      .catch(() => { /* non-fatal */ })
      .then(() => rejectAllPendingQuestions());
  }, [sessionId, rejectAllPendingQuestions]);

  const refreshPermissions = useCallback(async () => {
    try {
      const perms = await window.api.opencodePermissions?.(sessionId);
      if (Array.isArray(perms)) {
        setPermissions(perms);
      }
    } catch { /* non-fatal */ }
  }, [sessionId]);

  const refreshQuestions = useCallback(async () => {
    try {
      const qs = await window.api.opencodeQuestions?.(sessionId);
      if (Array.isArray(qs)) {
        // Mirror ChatPanel's original hydrate + sessionID-filter: hydrateQuestion
        // copies the server's `que_…` id into `requestId` (required for reply),
        // and the filter keeps only the viewed session's questions so a
        // cumulative workspace-wide GET doesn't stack unrelated backlog.
        setQuestions(
          qs
            .filter((q) => q.sessionID === sessionId)
            .map(hydrateQuestion) as QuestionRequest[],
        );
      }
    } catch { /* non-fatal */ }
  }, [sessionId]);

  const replyPermission = useCallback(
    (id: string, reply: "once" | "always" | "reject") => {
      void window.api.opencodePermissionReply?.(id, reply, sessionId);
    },
    [sessionId],
  );

  const replyQuestion = useCallback(
    (q: QuestionRequest, answers: string[][]) => {
      if (!q.requestId) return;
      void window.api.opencodeQuestionReply?.(q.requestId, answers, q.sessionID);
    },
    [sessionId],
  );

  const rejectQuestion = useCallback(
    (q: QuestionRequest) => {
      // Signature is opencodeQuestionReject(requestId, sessionId?) and the
      // reply/reject API accepts ONLY the `que_…` requestId, not the callID.
      if (!q.requestId) return;
      void window.api.opencodeQuestionReject?.(q.requestId, q.sessionID);
    },
    [],
  );

  // SSE effect
  useEffect(() => {
    // Drain-abort helper
    const maybeDrainQueuedPrompt = () => {
      if (!shouldAbortForQueuedDrain(messageQueueRef.current.length, drainAbortRef.current)) {
        return;
      }
      drainAbortRef.current = true;
      void window.api.opencodeAbort(sessionId)
        .catch(() => {
          drainAbortRef.current = false;
        })
        .then(() => rejectAllPendingQuestions());
    };

    const off = window.api.onOpencodeEvent((ev: OpencodeEvent) => {
      const props = ev.properties ?? {};
      const evSessionID = typeof props.sessionID === "string" ? props.sessionID : "";

      registerChildSessionFromCreated(
        ev as { type: string; properties?: { info?: { id?: string; parentID?: string } } },
        sessionId,
        childSessionIds.current,
      );

      if (shouldDropEventForSessionFilter(
        ev as { type: string; properties?: { sessionID?: string } },
        sessionId,
        childSessionIds.current,
      )) {
        return;
      }
      const isChildEvent =
        evSessionID.length > 0 &&
        evSessionID !== sessionId &&
        childSessionIds.current.has(evSessionID);

      // Subagent child-session event routing
      if (isChildEvent) {
        if (
          ev.type === "message.part.updated" ||
          ev.type === "message.part.delta" ||
          ev.type === "message.updated" ||
          ev.type === "message.part.removed" ||
          ev.type === "message.removed"
        ) {
          if (expandedTasksRef.current.has(evSessionID)) {
            scheduleChildRefetch(evSessionID);
          }
          return;
        }
        if (ev.type === "session.idle") {
          setLiveChildStatus((prev) => {
            if (prev.get(evSessionID) === "idle") return prev;
            const next = new Map(prev);
            next.set(evSessionID, "idle");
            return next;
          });
          scheduleRefetch();
          return;
        }
        if (ev.type === "session.status") {
          const t = (props.status as { type?: string } | undefined)?.type;
          if (t === "busy" || t === "retry") {
            setLiveChildStatus((prev) => {
              if (prev.get(evSessionID) === "running") return prev;
              const next = new Map(prev);
              next.set(evSessionID, "running");
              return next;
            });
          } else if (t === "idle") {
            setLiveChildStatus((prev) => {
              if (prev.get(evSessionID) === "idle") return prev;
              const next = new Map(prev);
              next.set(evSessionID, "idle");
              return next;
            });
            scheduleRefetch();
          }
          return;
        }
        return;
      }

      if (ev.type === "message.part.delta") {
        const partID = String(props.partID ?? "");
        const messageID = String(props.messageID ?? "");
        const field = String(props.field ?? "text");
        const delta = String(props.delta ?? "");
        if (!partID || !delta) return;

        if (!isActiveRef.current) {
          refetchOwedWhileInactive.current = true;
          return;
        }

        const existing = pendingDeltas.current.get(partID);
        if (existing && existing.field === field) {
          existing.text += delta;
        } else {
          pendingDeltas.current.set(partID, { messageID, field, text: delta });
        }
        if (oldestPendingAt.current == null) {
          oldestPendingAt.current = Date.now();
        }
        scheduleFlush();
        return;
      }

      if (ev.type === "session.idle") {
        setRunning(false);
      }
      if (ev.type === "session.status") {
        const status = props.status as
          | {
              type?: string;
              attempt?: number;
              message?: string;
              next?: number;
              action?: {
                reason?: string;
                provider?: string;
                title?: string;
                message?: string;
                label?: string;
                link?: string;
              };
            }
          | undefined;
        const type = status?.type;
        if (type === "busy" || type === "retry") setRunning(true);
        else if (type === "idle") setRunning(false);
        if (type === "retry") {
          setRetryInfo({
            attempt: status?.attempt ?? 0,
            message: status?.message ?? "",
            next: status?.next ?? 0,
            action:
              status?.action
                ? {
                    title: status.action.title ?? "",
                    message: status.action.message ?? "",
                    label: status.action.label ?? "",
                    link: status.action.link,
                  }
                : undefined,
          });
        } else if (type === "busy" || type === "idle") {
          setRetryInfo(null);
        }
      }

      if (ev.type === "session.error") {
        const err = (props.error as { data?: { message?: string }; name?: string } | undefined);
        const raw = err?.data?.message ?? err?.name ?? "Unknown server error";
        if (isDrainAbortError(err?.name, drainAbortRef.current)) {
          setRunning(false);
          return;
        }
        // ProviderAuthError is not surfaced as a plain banner — it triggers
        // the credential auto-refresh flow (owned by ChatPanel) instead.
        // Skip the generic switch entirely so its `setSendError` call below
        // doesn't race the refresh's own (better, actionable) messaging.
        if (err?.name === "ProviderAuthError") {
          setRunning(false);
          onProviderAuthError();
          return;
        }
        let msg: string;
        switch (err?.name) {
          case "ContextOverflowError":
            msg = `Context full — try /compact: ${raw}`;
            break;
          case "MessageOutputLengthError":
            msg = "Response truncated (hit output limit)";
            break;
          case "StructuredOutputError":
            msg = `Structured output failed: ${raw}`;
            break;
          case "ApiError":
            msg = `API error: ${raw}`;
            break;
          default:
            msg = raw;
        }
        setSendError(msg);
        setRunning(false);
      }

      if (ev.type === "session.next.step.ended") {
        flushPendingDeltas(true);
        maybeDrainQueuedPrompt();
        // Update stepTokens
        const usage = props.usage as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
        const cost = (props.cost as number | undefined) ?? 0;
        if (usage) {
          setStepTokens({
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            reasoning: usage.reasoning ?? 0,
            cache: {
              read: usage.cache?.read ?? 0,
              write: usage.cache?.write ?? 0,
            },
            cost,
          });
        }
        // Update finishByMessageId
        const finish = props.finish as string | undefined;
        if (finish) {
          const messageID = String(props.messageID ?? "");
          setFinishByMessageId((prev) => {
            const next = new Map(prev);
            next.set(messageID, finish as import("../chatUtils").TruncationKind);
            return next;
          });
        }
      }

      if (ev.type.startsWith("session.next.compaction.")) {
        const phase = ev.type.split(".").pop();
        if (phase === "started") {
          setCompactionState({
            reason: String(props.reason ?? "context"),
            text: String(props.text ?? ""),
            phase: "running",
          });
        } else if (phase === "delta") {
          setCompactionState((prev) => prev ? { ...prev, text: prev.text + String(props.delta ?? "") } : null);
        } else if (phase === "ended") {
          setCompactionState((prev) => prev ? { ...prev, phase: "done" } : null);
          if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
          compactionClearTimer.current = setTimeout(() => {
            setCompactionState(null);
          }, 3000);
        }
      }

      if (ev.type === "vcs.branch.updated") {
        setBranch(String(props.branch ?? null));
      }

      if (ev.type === "todo.updated") {
        const todos = props.todos as Array<{ content: string; status: string; priority: string }> | undefined;
        if (todos) {
          setLiveTodos(todos);
          setTodosDismissed(false);
        }
      }

      if (ev.type === "command.executed") {
        const messageID = String(props.messageID ?? "");
        const name = String(props.name ?? "");
        const arguments_ = String(props.arguments ?? "");
        setCommandByMessageId((prev) => {
          const next = new Map(prev);
          next.set(messageID, { name, arguments: arguments_ });
          return next;
        });
      }

      if (ev.type === "message.part.updated" || ev.type === "message.updated") {
        // messageID lives at DIFFERENT paths per event type on the deployed
        // opencode build (verified live against /events):
        //   - message.part.updated → properties.part.messageID (top-level
        //     properties.messageID is UNDEFINED)
        //   - message.updated       → properties.messageID (properties.info.id
        //     as a fallback)
        // Reading only props.messageID meant message.part.updated resolved to
        // "" and fell through to a FULL scheduleRefetch — whose single 300ms
        // timer is reset on every event. A running bash emits part.updated
        // every ~20-40ms, so that timer never fired until the turn went idle:
        // live tool output (metadata.output) never streamed, it dumped all at
        // once on completion. Resolving the real id routes to the targeted
        // per-message splice (which has its own max-wait guard).
        const part = props.part as { messageID?: unknown } | undefined;
        const info = props.info as { id?: unknown } | undefined;
        const messageID = String(
          props.messageID ?? part?.messageID ?? info?.id ?? "",
        );
        spliceMessage(messageID);
        flushPendingDeltas(false);
      }

      // Primary drain trigger — the real step boundary the deployed opencode
      // build actually emits (see module doc + BET-131). Only fires for the
      // main session: `isChildEvent` above already returned early for
      // subagent child events, so a completed tool part reaching here always
      // belongs to the session this hook owns.
      if (ev.type === "message.part.updated" && isToolStepBoundary(props.part)) {
        maybeDrainQueuedPrompt();
      }

      if (ev.type === "session.compacted") {
        setCompactionState(null);
        scheduleRefetch();
      }

      if (ev.type === "server.connected") {
        scheduleRefetch();
        void refreshPermissions();
        void refreshQuestions();
      }

      if (ev.type === "permission.asked" || ev.type === "permission.replied") {
        void refreshPermissions();
      }

      if (ev.type === "question.asked" || ev.type === "question.replied" || ev.type === "question.rejected") {
        // Payload-driven live update (restored from BET-64 refactor regression).
        // Applying the event payload directly (a) hydrates `requestId` from the
        // asked payload so submit can send the reply, (b) upserts by callID so
        // re-asks don't stack, and (c) filters to the viewed session — instead
        // of re-polling GET /question which returns ALL cumulatively-pending
        // questions for the workspace and dropped the requestId + filter.
        setQuestions((prev) =>
          applyQuestionEvent(prev, ev.type, props, sessionId) as QuestionRequest[],
        );
        if (ev.type === "question.replied" || ev.type === "question.rejected") {
          scheduleRefetch();
        }
      }
    });

    // Initial fetch
    void window.api.opencodeMessages(sessionId).then((m) => {
      setMessages(m);
      for (const cid of collectChildSessionIds(m)) {
        childSessionIds.current.add(cid);
      }
      // Self-heal: one debounced refetch after the stream is (now) live, in
      // case an event slipped through during stream warm-up. Idempotent,
      // gated on active panel by scheduleRefetch itself.
      scheduleRefetch();
    }).catch(() => { /* non-fatal */ });

    return () => {
      off();
      if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
    };
  }, [sessionId]);

  // Drain effect: when running flips false and there's a queued prompt, submit
  // it. This is the SOLE drain effect (a duplicate in ChatPanel was removed —
  // both fired on the same running→false edge and double-submitted).
  //
  // Ordering matters: setInput(queued) runs NOW (synchronously in this effect),
  // and the actual submit is deferred to a setTimeout(0). The gap lets React
  // re-render so submitRef.current is reassigned to a fresh submit() closure
  // that captures the new `input` — submit() reads `input` from its render
  // closure (not a ref), so calling it before the input-set re-render would
  // read the stale empty value and no-op. Do NOT collapse setInput into the
  // timeout alongside submitRef.current() — that reintroduces the stale-closure
  // bug where the queued prompt is silently dropped.
  useEffect(() => {
    if (!running && messageQueue.length > 0) {
      const queued = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      drainAbortRef.current = false;
      setInput(queued);
      setTimeout(() => {
        submitRef.current?.();
      }, 0);
    }
  }, [running, messageQueue]);

  return {
    running,
    setRunning,
    sendError,
    setSendError,
    messageQueue,
    setMessageQueue,
    permissions,
    setPermissions,
    questions,
    setQuestions,
    stepTokens,
    setStepTokens,
    compactionState,
    setCompactionState,
    liveTodos,
    setLiveTodos,
    todosDismissed,
    setTodosDismissed,
    retryInfo,
    setRetryInfo,
    finishByMessageId,
    setFinishByMessageId,
    commandByMessageId,
    setCommandByMessageId,
    liveChildStatus,
    setLiveChildStatus,
    branch,
    setBranch,
    drainAbortRef,
    submit,
    submitRef,
    abort,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    rejectAllPendingQuestions,
    refreshPermissions,
    refreshQuestions,
  };
}
