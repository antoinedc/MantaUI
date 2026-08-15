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
// Dependencies injected via params:
//   - setMessages (from useTranscriptState)
//   - scheduleRefetch / spliceMessage / etc. (from useTranscriptState)
//   - input (for submit)
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
  fetchTranscriptWithRetry,
} from "../chatUtils";
import { planModeFromToolPart } from "../../shared/planMode.mjs";
import type { TokenUsage } from "../chatShared";
import { useStore } from "../store";
import { markFirstToken, markRendered } from "../firstTokenLatency";

// Initial mount transcript fetch: a 15s ceiling (open-code is remote and a
// hung box/network must not leave the panel spinning forever) with ONE retry
// after a 2s cooldown. On final failure the panel shows the "Couldn't load
// session" state with a Retry button. Mirror of the rpcWithTimeout pattern.
const INITIAL_FETCH_TIMEOUT_MS = 15_000;
const INITIAL_FETCH_RETRY_DELAY_MS = 2_000;

// A `turnComplete` with running:false is NOT proof the turn ended: the box
// derives it from the transcript, and at every tool-step boundary the just-
// finished step's message is momentarily the transcript tail, so it fires
// mid-turn and is re-armed by the next `session.status busy` 0-134ms later
// (measured on the live stream, 2026-08-07). Waiting this long before
// believing it collapses that flicker, while still self-healing if the hard
// `session.status {"type":"idle"}` signal is ever dropped.
const TURN_SETTLE_MS = 400;
export { TURN_SETTLE_MS };


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
  submitRef: React.RefObject<(textOverride?: string) => void>;
  // Best-effort cleanup for any question(s) blocking an aborted turn — see
  // BET-116. Owned here (not ChatPanel) because this hook owns `questions`
  // state; exposed so ChatPanel's own user-facing abort path can call the
  // SAME loop instead of duplicating it.
  rejectAllPendingQuestions: () => void;
  refreshPermissions: () => Promise<void>;
  refreshQuestions: () => Promise<void>;
  // Whether the initial mount transcript fetch failed (timeout + retry both
  // exhausted). ChatPanel renders the "Couldn't load session" panel + a Retry
  // button that calls retryTranscriptLoad.
  transcriptLoadError: string | null;
  // Re-run the initial mount fetch (timeout + retry). Clears transcriptLoadError
  // on success. Kept callable from the panel's Retry button across renders.
  retryTranscriptLoad: () => void;
};

export function useSseBus(params: {
  sessionId: string;
  cwd: string;
  setMessages: React.Dispatch<React.SetStateAction<OpencodeMessage[] | null>>;
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  scheduleRefetch: () => void;
  // Options for every transcript fetch (tail limit until "Load earlier").
  fetchOpts: () => { limit: number } | {};
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
  submitRef: React.RefObject<(textOverride?: string) => void>;
  // Plan-mode honesty sync (BET-949). Called when opencode reports its own
  // agent switching (plan_enter/plan_exit tool parts, session.next.agent.
  // switched) so the composer chip never claims a mode the next turn won't run.
  setPlanOn: (on: boolean) => void;
}): SseBus {
  const {
    sessionId,
    setMessages,
    setRefreshing,
    scheduleRefetch,
    fetchOpts,
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
    setPlanOn,
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
  const drainingRef = useRef(false);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const questionsRef = useRef<QuestionRequest[]>([]);
  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);
  // Ref mirror of `providerID` so the SSE handler (whose subscription effect
  // deps are `[sessionId]`) classifies the auth-reconnect banner against the
  // CURRENT provider, not the one captured at mount. Without this, switching
  // provider/model mid-session leaves the banner keyed to the old provider.
  const providerIDRef = useRef(providerID);
  providerIDRef.current = providerID;
  // Ref mirror of setPlanOn so the SSE handler (deps [sessionId]) always syncs
  // against the CURRENT session's setter, not the one captured at mount.
  const setPlanOnRef = useRef(setPlanOn);
  setPlanOnRef.current = setPlanOn;
  // Re-entrancy guard for the plan_enter/plan_exit tool parts: the same tool
  // part arrives repeatedly as it streams (like the drain abort), so act once
  // per callID. Mirrors drainAbortRef's guard pattern.
  const handledPlanCallIdsRef = useRef<Set<string>>(new Set());
  const [stepTokens, setStepTokens] = useState<(TokenUsage & { cost: number }) | null>(null);
  const [compactionState, setCompactionState] = useState<{
    reason: string;
    text: string;
    phase: "running" | "done";
  } | null>(null);
  const compactionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timer arming the delayed running→false flip on a `turnComplete` whose
  // running flag is not yet authoritative (see TURN_SETTLE_MS). Any other
  // writer of `running` cancels it first, so a stale settle never lands on a
  // turn it does not belong to.
  const turnSettleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTurnSettle = () => {
    if (turnSettleRef.current) {
      clearTimeout(turnSettleRef.current);
      turnSettleRef.current = null;
    }
  };
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
  // Initial mount transcript fetch failure (see transcriptLoadError in the
  // SseBus type). Held here because this hook owns the fetch; ChatPanel reads
  // it to render the "Couldn't load session" panel + Retry button.
  const [transcriptLoadError, setTranscriptLoadError] = useState<string | null>(null);
  // The latest initial-fetch closure, kept in a ref so the panel's Retry button
  // (rendered outside the SSE effect) can re-run the same fetch.
  const initialFetchRef = useRef<() => void>(() => {});
  const retryTranscriptLoad = useCallback(() => {
    initialFetchRef.current();
  }, []);

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

  // SSE effect
  useEffect(() => {
    // Drain-abort helper
    const maybeDrainQueuedPrompt = () => {
      if (!shouldAbortForQueuedDrain(messageQueueRef.current.length, drainAbortRef.current)) {
        return;
      }
      cancelTurnSettle();
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
          // Running on a retry comes from the box's stream.running (the box
          // treats retry as running — see streamInterp session.status). This
          // raw handler only surfaces the retry banner/message; it must not
          // set running itself, or it would race the box value.
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
          cancelTurnSettle();
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
        const auth = authErrorAdvice(err?.name, raw, providerIDRef.current);
        if (auth) {
          setSendError(`${auth.label} needs to be reconnected.`);
          setAuthReconnect(auth.label);
          cancelTurnSettle();
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
        cancelTurnSettle();
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

      // Plan-mode honesty (BET-949). opencode's OWN client does the mode switch
      // locally (`plan_exit` → build, `plan_enter` → plan); there is no
      // server-side state doing it, so MantaUI must mirror it or the chip
      // claims plan mode while the next turn runs as build.
      if (ev.type === "session.next.agent.switched") {
        setPlanOnRef.current(String(props.agent ?? "") === "plan");
      }
      if (ev.type === "message.part.updated") {
        const part = props.part as { callID?: unknown } | undefined;
        const next = planModeFromToolPart(props.part);
        if (next !== null) {
          const callID = String(part?.callID ?? "");
          if (callID && !handledPlanCallIdsRef.current.has(callID)) {
            handledPlanCallIdsRef.current.add(callID);
            setPlanOnRef.current(next);
          }
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
        // First-token-latency instrumentation (BET-553 / §17) — the raw path.
        // The raw `opencode` stream is the OTHER text source besides the box's
        // interpreted `stream.flush`; both are timed so the numbers are
        // comparable (see the interpreted flush case). `markRendered` marks the
        // splice-invoked commit; true paint timing is captured by the probe.
        markFirstToken("raw", sessionId);
        spliceMessage(messageID);
        markRendered("raw", sessionId);
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
    //
    // Wrapped in a 15s timeout (the box is remote; a hung network must not
    // spin the panel forever) with ONE retry after a 2s cooldown. On final
    // failure transcriptLoadError is set and ChatPanel renders the
    // "Couldn't load session" panel + Retry (which re-runs this same function
    // via initialFetchRef). Fetches the TAIL (fetchOpts), not the full history.
    const doInitialFetch = () => {
      setTranscriptLoadError(null);
      setRefreshing(true);
      fetchTranscriptWithRetry(
        () => window.api.opencodeMessages(sessionId, fetchOpts()),
        { timeoutMs: INITIAL_FETCH_TIMEOUT_MS, retryDelayMs: INITIAL_FETCH_RETRY_DELAY_MS },
      )
        .then((m) => {
          // Only seed messages if nothing has been written yet. On a fresh
          // session with a queued auto-submit, submit() appends its OPTIMISTIC
          // user message before this fetch resolves; this snapshot predates the
          // prompt POST, so overwriting would clobber the just-sent prompt out
          // of the transcript (loader shows, prompt missing). The post-prompt
          // canonical refetch (the SSE-driven scheduleRefetch below) lands the
          // real message instead. No unconditional self-heal is needed — a
          // successful initial fetch IS the fresh snapshot, and the stream was
          // opened (ensureStreamForDirectory) before it, so nothing slipped.
          setMessages((prev) => (prev === null ? m : prev));
          for (const cid of collectChildSessionIds(m)) {
            childSessionIds.current.add(cid);
          }
        })
        .catch(() => {
          setTranscriptLoadError(
            "Couldn't load the transcript. Check your connection and try again.",
          );
        })
        .finally(() => setRefreshing(false));
    };
    initialFetchRef.current = doInitialFetch;
    doInitialFetch();

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
          // First-token-latency instrumentation (BET-553 / §17): the flush is
          // the box's interpreted text chunk — the start of "first token".
          markFirstToken("interpreted", sessionId);
          if (!isActiveRef.current) {
            refetchOwedWhileInactive.current = true;
            return;
          }
          // The box already flushed at a safe boundary; apply the chunk
          // directly. Unmatched → the part snapshot isn't loaded yet.
          const unmatched = applyStreamFlush({ messageID, partID, field, text });
          markRendered("interpreted", sessionId);
          if (unmatched > 0) scheduleRefetch();
          return;
        }
        case "running": {
          // Authoritative in both directions: cancel any pending settle so a
          // stale timer can't clobber this value, then apply it immediately.
          cancelTurnSettle();
          setRunning((ev.payload as StreamRunningPayload).running);
          return;
        }
        case "turnComplete": {
          const { running: turnRunning } = ev.payload as StreamRunningPayload;
          if (turnRunning === true) {
            cancelTurnSettle();
            setRunning(true);
            return;
          }
          // running:false is not proof the turn ended — the box derives it from
          // the transcript, so it fires at every tool-step boundary and is
          // re-armed by the next `session.status busy`. Start (or restart) a
          // settle timer; only the hard `running` signal or a genuine end clears
          // it early.
          cancelTurnSettle();
          turnSettleRef.current = setTimeout(() => {
            setRunning(false);
          }, TURN_SETTLE_MS);
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
      cancelTurnSettle();
      if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
    };
  }, [sessionId]);

  // Drain effect: when running flips false and there's a queued prompt, submit
  // it — EXACTLY ONE item per idle edge. The queued text is passed explicitly
  // via submit's textOverride (same pattern as ChatPanel's autoSubmit), so the
  // old setInput + setTimeout(0) re-render dance is gone and a second queued
  // item can no longer overwrite the first before its deferred submit fires.
  // drainingRef gates re-entrancy: setMessageQueue re-triggers this effect
  // synchronously (before running flips true), and without the gate the second
  // item would submit mid-turn. It re-arms when running goes true (submit sets
  // it synchronously on the non-error path). This is the SOLE drain effect (a
  // duplicate in ChatPanel was removed — see the "no double send" test).
  useEffect(() => {
    if (running) {
      drainingRef.current = false;
      return;
    }
    if (drainingRef.current || messageQueue.length === 0) return;
    drainingRef.current = true;
    const queued = messageQueue[0];
    setMessageQueue((prev) => prev.slice(1));
    drainAbortRef.current = false;
    submitRef.current?.(queued);
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
    rejectAllPendingQuestions,
    refreshPermissions,
    refreshQuestions,
    transcriptLoadError,
    retryTranscriptLoad,
  };
}
