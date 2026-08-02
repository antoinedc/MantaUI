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
  StreamEnvelope,
  StreamFlushPayload,
  StreamRunningPayload,
  StreamTodosPayload,
  StreamTruncationPayload,
  StreamQuestionsPayload,
  StreamSubagentChildPayload,
} from "../../shared/types";
import {
  shouldDropEventForSessionFilter,
  isDrainAbortError,
  shouldAbortForQueuedDrain,
  isToolStepBoundary,
  collectChildSessionIds,
  hydrateQuestion,
  authErrorAdvice,
} from "../chatUtils";
import type { TokenUsage } from "../chatShared";
import { useStore } from "../store";

export type SseBus = {
  running: boolean;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  sendError: string | null;
  setSendError: React.Dispatch<React.SetStateAction<string | null>>;
  // Provider label when the current sendError is an auth-failure banner
  // (BET-316). When non-null, ChatPanel renders a single [Reconnect] button
  // alongside the dismiss ×; clicking it dispatches `manta-open-subscriptions`
  // and clears BOTH sendError and authReconnect. Always null for any
  // non-auth error (context overflow, network blip, etc.) so the banner
  // is unchanged.
  authReconnect: string | null;
  // Dispatch the `manta-open-subscriptions` window CustomEvent and clear
  // the banner. Mirrors the `manta-open-schedules` / `-secrets` / `-webhooks`
  // bridge precedent from useSessionResources.ts (BET-63) — the listener
  // that reacts to the event lives on whichever component owns the
  // Subscriptions card (BET-314). Until that ships the dispatch is a no-op
  // visible to the user.
  openAuthReconnect: () => void;
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
  refreshBranch: (cwd: string) => void;
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
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  scheduleRefetch: () => void;
  spliceMessage: (messageId: string) => void;
  scheduleChildRefetch: (childId: string) => void;
  childSessionIds: React.MutableRefObject<Set<string>>;
  childMessagesRef: React.MutableRefObject<Map<string, OpencodeMessage[]>>;
  expandedTasksRef: React.MutableRefObject<Set<string>>;
  childRefetchTimers: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  isActiveRef: React.MutableRefObject<boolean>;
  refetchOwedWhileInactive: React.MutableRefObject<boolean>;
  applyStreamFlush: (d: {
    partID: string;
    messageID: string;
    field: string;
    text: string;
  }) => number;
  // The session's active model's providerID (e.g. "anthropic", "openai",
  // "kimi-for-coding"). Drives the auth-error banner copy (BET-316) — when
  // a session.error is recognisably a credential failure on one of the
  // three subscription providers, the banner shows "<Label> needs to be
  // reconnected." with a single [Reconnect] button. Null when no model is
  // active (initial load, no default chosen, etc.) — the banner then falls
  // through to the raw-message path.
  providerID: string | null;
  submit: () => void;
  submitRef: React.RefObject<() => void>;
  setInput: (v: string) => void;
}): SseBus {
  const {
    sessionId,
    setMessages,
    setRefreshing,
    scheduleRefetch,
    spliceMessage,
    scheduleChildRefetch,
    childSessionIds,
    expandedTasksRef,
    isActiveRef,
    refetchOwedWhileInactive,
    applyStreamFlush,
    providerID,
    submit,
    submitRef,
    setInput,
  } = params;

  const [running, setRunning] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Provider label when `sendError` is an auth-failure banner (BET-316). When
  // non-null, ChatPanel renders a single [Reconnect] button that dispatches
  // `manta-open-subscriptions`. Tied 1:1 with `sendError`: cleared together
  // by openAuthReconnect and by the dismiss × button in ChatPanel.
  const [authReconnect, setAuthReconnect] = useState<string | null>(null);
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

  // Preserve last-known branch on a transient null. getVcsBranch resolves
  // null (never rejects) for a git-index-lock / spawn blip as well as a
  // genuine non-git cwd, so blanking on every null made the indicator
  // flicker on the 5s poll. cwd changes re-init the consumer effect
  // (branch resets to null here on remount), so a real dir change still
  // clears it.
  const refreshBranch = useCallback((cwd: string) => {
    window.api
      .opencodeVcsBranch(cwd)
      .then((b) => setBranch((prev) => b ?? prev))
      .catch(() => { /* non-fatal — non-git cwd or transport blip */ });
  }, []);

  // Any question that was blocking an aborted turn is dead — opencode's
  // pending list never expires on its own (see BET-116), so it would
  // re-latch the sidebar's red "?" glyph on a later replay unless we reject
  // it here. Best-effort, fire-and-forget: cleanup must never surface an
  // error. Called from BOTH abort paths below (user-facing abort and the
  // queued-drain abort) via a single shared helper — do not duplicate the
  // loop.
  // Scope rejection to THIS panel's own session only (BET-418 §F). The panel's
  // `questions` state can hold asks from more than one session (a background
  // job's child, or any record the server's filter widened in), and rejecting
  // every pending question on abort silently dismissed an UNRELATED session's
  // ask. Only the viewed session's turn is being aborted, so only its asks are
  // dead; leave the rest intact for their owning panel.
  const rejectAllPendingQuestions = useCallback(() => {
    const pending = questionsRef.current;
    if (pending.length === 0) return;
    const own = pending.filter((q) => q.sessionID === sessionId);
    if (own.length === 0) return;
    for (const q of own) {
      if (!q.requestId) continue;
      void window.api.opencodeQuestionReject
        ?.(q.requestId, q.sessionID)
        .catch(() => { /* best-effort cleanup */ });
    }
    setQuestions((prev) => prev.filter((q) => q.sessionID !== sessionId));
    useStore.getState().setChatAttention(sessionId, null);
  }, [sessionId]);

  const abort = useCallback(() => {
    void window.api.opencodeAbort(sessionId)
      .catch(() => { /* non-fatal */ })
      .then(() => rejectAllPendingQuestions());
  }, [sessionId, rejectAllPendingQuestions]);

  // Open the Settings → AI → Subscriptions card from outside ChatPanel's
  // component tree (BET-316). Follows the `manta-open-schedules` /
  // `-secrets` / `-webhooks` precedent from useSessionResources.ts: the
  // listener lives on whichever component owns the Subscriptions card
  // (BET-314). Until that ships the dispatch is a benign no-op. Clearing
  // the banner pair here keeps state consistent with the dismiss × button.
  const openAuthReconnect = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("manta-open-subscriptions", { detail: { sessionId } }),
    );
    setSendError(null);
    setAuthReconnect(null);
  }, [sessionId]);

  const refreshPermissions = useCallback(async () => {
    try {
      const perms = await window.api.opencodePermissions?.(sessionId);
      if (Array.isArray(perms)) {
        // Background-job children no longer surface here (BET-418 §A): a job
        // is created with a pre-flight permission ruleset and never asks once
        // running, so the server returns only the viewed session's own asks.
        setPermissions(perms);
      }
    } catch { /* non-fatal */ }
  }, [sessionId]);

  const refreshQuestions = useCallback(async () => {
    try {
      const qs = await window.api.opencodeQuestions?.(sessionId);
      if (Array.isArray(qs)) {
        // hydrateQuestion copies the server's `que_…` id into `requestId`
        // (required for reply). The server now returns only the viewed
        // session's own questions (BET-418 §A).
        setQuestions(qs.map(hydrateQuestion) as QuestionRequest[]);
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

      // NOTE: the viewed session's delta flush, running, todos, truncation and
      // question interpretation all moved to the box (BET-551 / §17) and are
      // consumed via the onStreamEvent subscription below — no longer here.

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
        // Auth-error banner (BET-316). For one of the three subscription
        // providers, replace the raw message (which often ends with "Run
        // `claude` to refresh them." for Claude, or arrives with no context
        // for Codex/Kimi) with a single reconnect nudge. Server-side recovery
        // (maybeRecoverCredentials + the 10-min pre-expiry poller) keeps
        // running in parallel for Claude specifically — this banner is
        // additive, not a replacement. For everything else the existing
        // switch/default branch handles the message and we fall through.
        const auth = authErrorAdvice(err?.name, raw, providerID);
        if (auth) {
          setSendError(`${auth.label} needs to be reconnected.`);
          setAuthReconnect(auth.label);
          setRunning(false);
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
        setAuthReconnect(null);
        setRunning(false);
      }

      if (ev.type === "session.next.step.ended") {
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
        // Truncation classification moved to the box → stream.truncation
        // (consumed below); finishByMessageId is stamped there, not here.
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
        // Preserve last-known branch when the event carries no branch, rather
        // than blanking (or worse, `String(null)` → the truthy string "null").
        const b = props.branch ? String(props.branch) : null;
        setBranch((prev) => b ?? prev);
      }

      // Todo interpretation moved to the box → stream.todos (consumed below).

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

      // Question interpretation moved to the box → stream.questions (consumed
      // below). BET-418 semantics follow: a viewed session's own ask applies
      // live from the payload (no refetch), a foreign/child ask never applies.
    });

    // Initial fetch. Arm `refreshing` here (not just in scheduleRefetch) so the
    // ambient loading divider shows during the REAL transcript load when a
    // session first opens — previously only background refetches drove the bar,
    // so the initial load flashed nothing and the indicator "disappeared".
    setRefreshing(true);
    void window.api.opencodeMessages(sessionId).then((m) => {
      setMessages(m);
      for (const cid of collectChildSessionIds(m)) {
        childSessionIds.current.add(cid);
      }
      // Self-heal: one debounced refetch after the stream is (now) live, in
      // case an event slipped through during stream warm-up. Idempotent,
      // gated on active panel by scheduleRefetch itself.
      scheduleRefetch();
    }).catch(() => { /* non-fatal */ }).finally(() => setRefreshing(false));

    // Box-side interpreted stream events (BET-551 / §17). The box derives
    // running, delta-flush, todos, truncation, questions and subagent/child
    // state from the raw opencode stream and publishes them as `stream.*` —
    // the renderer consumes those here instead of re-interpreting.
    const offStream = window.api.onStreamEvent((ev: StreamEnvelope) => {
      // A stream event scoped to a subagent child session (not this panel's
      // own session) still needs the child's live-transcript routing — the
      // same scheduleChildRefetch the raw-event child block above does.
      if (ev.sessionId !== sessionId) {
        if (
          ev.sessionId &&
          childSessionIds.current.has(ev.sessionId) &&
          expandedTasksRef.current.has(ev.sessionId)
        ) {
          scheduleChildRefetch(ev.sessionId);
        }
        return;
      }

      switch (ev.sub) {
        case "flush": {
          const { messageID, partID, field, text } = ev.payload as StreamFlushPayload;
          if (!partID || !messageID) return;
          if (!isActiveRef.current) {
            refetchOwedWhileInactive.current = true;
            return;
          }
          // The box already flushed at a safe boundary; apply the chunk
          // directly. Unmatched → the part snapshot isn't loaded yet.
          const unmatched = applyStreamFlush({ messageID, partID, field, text });
          if (unmatched > 0) scheduleRefetch();
          return;
        }
        case "running":
        case "turnComplete": {
          setRunning((ev.payload as StreamRunningPayload).running);
          return;
        }
        case "todos": {
          const { active } = ev.payload as StreamTodosPayload;
          if (active) {
            setLiveTodos(active as Array<{ content: string; status: string; priority: string }>);
            setTodosDismissed(false);
          }
          return;
        }
        case "truncation": {
          const p = ev.payload as StreamTruncationPayload;
          if (p.messageID && p.kind) {
            setFinishByMessageId((prev) => {
              const next = new Map(prev);
              next.set(p.messageID as string, p.kind as import("../chatUtils").TruncationKind);
              return next;
            });
          }
          return;
        }
        case "questions": {
          const { questions } = ev.payload as StreamQuestionsPayload;
          if (Array.isArray(questions)) {
            setQuestions(questions as QuestionRequest[]);
          }
          return;
        }
        case "subagent.child": {
          const { childSessionId } = ev.payload as StreamSubagentChildPayload;
          if (childSessionId) childSessionIds.current.add(childSessionId);
          return;
        }
        default:
          // context / cache / subagent / autoRename — consumed by other
          // surfaces, not this panel's live transcript state.
          return;
      }
    });

    return () => {
      off();
      offStream();
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
    authReconnect,
    openAuthReconnect,
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
    refreshBranch,
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
