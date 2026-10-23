// ===== useSseBus =====
//
// Extracted from ChatPanel.tsx (BET-64). Owns the SSE connection state machine.
// Subscribes to the box-interpreted `stream` frames and routes them to the
// appropriate state setters. Messages sent while a turn runs are delivered by
// opencode itself (V2 steer) and listed from the box's `inbox` frame — there is
// no client-side queue and no abort-to-drain any more (cleanup spec §2).
//
// OpenCode V2 slice A2: this hook no longer reads raw opencode events at all
// (`onOpencodeEvent` has no renderer subscriber). Every behaviour that used to
// hang off a raw event is driven by the frame the box derives from it — see the
// mapping table in docs/superpowers/specs/2026-10-16-opencode-v2-slices-a2-b2.md
// and the `switch (ev.sub)` below.
//
// This hook owns:
//   - The frame subscription (window.api.onStreamEvent)
//   - The frame handler that routes frames to state setters
//   - All event-driven state: running, permissions, questions, stepTokens,
//     compactionState, liveTodos, todosDismissed, retryInfo, finishByMessageId,
//     commandByMessageId, sendError, inboxItems
// Dependencies injected via params:
//   - setMessages (from useTranscriptState)
//   - scheduleRefetch / spliceMessage / etc. (from useTranscriptState)
//   - running, setRunning (owned by this hook)
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
//   - compactSession, forkSession (for voice dispatch, but we'll skip that)
//   - selectModel (for voice dispatch, but we'll skip that)
//   - refreshPermissions, refreshQuestions (for server.connected)
//   - setChatAttention, setChatSubagents (for sidebar updates)

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OpencodeInboxItem,
  OpencodeMessage,
  PermissionRequest,
  QuestionRequest,
  StreamChildSessionPayload,
  StreamCommandExecutedPayload,
  StreamCompactionPayload,
  StreamEnvelope,
  StreamFlushPayload,
  StreamMessageChangedPayload,
  StreamPermissionsPayload,
  StreamPlanModePayload,
  StreamRetryPayload,
  StreamRunningPayload,
  StreamSessionErrorPayload,
  StreamStepEndedPayload,
  StreamTodosPayload,
  StreamTruncationPayload,
  StreamQuestionsPayload,
  StreamSubagentChildPayload,
} from "../../shared/types";
import {
  collectChildSessionIds,
  hydrateQuestion,
  describeSessionError,
  stepTokensFromFrame,
  fetchTranscriptWithRetry,
} from "../chatUtils";
import { createInboxTracker, type InboxTracker } from "../inboxState";
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
  // The session's pending user messages (V2 inbox), oldest first, from the
  // box's `inbox` frame under the K3 acceptance rule. Always [] for a surface
  // that opts out (the CTO conversation: its inbox is admission-owned).
  inboxItems: OpencodeInboxItem[];
  // Re-read the snapshot (opencode:inbox) under the same acceptance rule.
  refreshInbox: () => void;
  permissions: PermissionRequest[];
  setPermissions: React.Dispatch<React.SetStateAction<PermissionRequest[]>>;
  questions: QuestionRequest[];
  setQuestions: React.Dispatch<React.SetStateAction<QuestionRequest[]>>;
  stepTokens: (TokenUsage & { cost: number }) | null;
  setStepTokens: React.Dispatch<React.SetStateAction<(TokenUsage & { cost: number }) | null>>;
  compactionState: { reason: string; text: string; phase: "running" | "done" } | null;
  setCompactionState: React.Dispatch<React.SetStateAction<{ reason: string; text: string; phase: "running" | "done" } | null>>;
  // BET-1347: the box compacted this conversation in the background — a
  // transient transcript one-liner (away + token sizes when known).
  compactionNotice: { beforeTokens: number | null; afterTokens: number | null; away: boolean } | null;
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
  branch: string | null;
  refreshBranch: (cwd: string) => void;
  // Reject THIS session's pending questions (the same filter as the abort
  // cleanup, BET-116) and AWAIT every request. A card is removed only once its
  // rejection succeeded; on any failure the result says so (the busy send then
  // sends nothing). A question that arrives after this pass is left alone.
  // Owned here because this hook owns `questions`.
  rejectPendingQuestions: () => Promise<{ ok: boolean; error?: string }>;
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
  // Whether this surface has a V2 inbox to show. Default true; the CTO
  // conversation passes false (its opencode:inbox is refused by design).
  inbox?: boolean;
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
    inbox: inboxEnabled = true,
    setPlanOn,
  } = params;

  const [running, setRunning] = useState(false);
  const [sendError, setSendErrorState] = useState<string | null>(null);
  // True while the banner on screen came from a MessageAbortedError (a user
  // Stop, or the box aborting a seat-limit retry before it resumes the turn).
  // That banner is stale the moment a new turn starts, so a later
  // `session.status busy|retry` clears it. EVERY other write resets this, so a
  // different error is never swept away by the next busy.
  const abortedBannerRef = useRef(false);
  const setSendError = useCallback<React.Dispatch<React.SetStateAction<string | null>>>((v) => {
    abortedBannerRef.current = false;
    setSendErrorState(v);
  }, []);
  // Provider label when `sendError` is an auth-failure banner (BET-316). When
  // non-null, ChatPanel renders a single [Reconnect] button that dispatches
  // `manta-open-subscriptions`. Tied 1:1 with `sendError`: cleared together
  // by openAuthReconnect and by the dismiss × button in ChatPanel.
  const [authReconnect, setAuthReconnect] = useState<string | null>(null);
  const [inboxItems, setInboxItems] = useState<OpencodeInboxItem[]>([]);
  // The current session's inbox re-seed (set by the frame effect below, a
  // no-op when the surface has no inbox). `refreshInbox` calls through it.
  const inboxFetchRef = useRef<() => void>(() => {});
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
  const [stepTokens, setStepTokens] = useState<(TokenUsage & { cost: number }) | null>(null);
  const [compactionState, setCompactionState] = useState<{
    reason: string;
    text: string;
    phase: "running" | "done";
  } | null>(null);
  const compactionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BET-1347: a background compaction the BOX did while this conversation was
  // open, surfaced as a transient transcript one-liner. Set server-side on
  // compaction; cleared after a short display window so it reads as a pass-by
  // note, not a permanent fixture. `away` is the server's presence verdict at
  // compaction time; before/after are token sizes when known.
  const [compactionNotice, setCompactionNotice] = useState<{
    beforeTokens: number | null;
    afterTokens: number | null;
    away: boolean;
  } | null>(null);
  const compactionNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armCompactionNotice = (n: { beforeTokens: number | null; afterTokens: number | null; away: boolean }) => {
    setCompactionNotice(n);
    if (compactionNoticeTimer.current) clearTimeout(compactionNoticeTimer.current);
    compactionNoticeTimer.current = setTimeout(() => setCompactionNotice(null), 10_000);
  };
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

  // Reject this session's pending questions, awaiting every request. Used by
  // BOTH the user's Stop (a question blocking an aborted turn is dead — opencode's
  // pending list never expires on its own, so it would re-latch the sidebar's red
  // "?" glyph on a later replay, BET-116) and the busy send (a message typed while
  // a question blocks the turn dismisses the question first).
  //
  // Scope rejection to THIS panel's own session only (BET-418 §F): the panel's
  // `questions` state can hold asks from more than one session, and only the
  // viewed session's turn is being acted on. A card is removed only once ITS
  // rejection succeeded, and only the cards this pass rejected — a question that
  // arrives afterwards (or one that failed) stays for the user.
  const rejectPendingQuestions = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const own = questionsRef.current.filter((q) => q.sessionID === sessionId);
    if (own.length === 0) return { ok: true };
    const rejected = new Set<string>();
    let error: string | undefined;
    await Promise.all(
      own.map(async (q) => {
        // Nothing to tell the server without a request id; just clear the card.
        if (!q.requestId) {
          rejected.add(q.id);
          return;
        }
        try {
          await window.api.opencodeQuestionReject(q.requestId, q.sessionID);
          rejected.add(q.id);
        } catch (e) {
          error ??= e instanceof Error ? e.message : String(e);
        }
      }),
    );
    if (rejected.size > 0) {
      setQuestions((prev) => prev.filter((q) => !rejected.has(q.id)));
      if (rejected.size === own.length) useStore.getState().setChatAttention(sessionId, null);
    }
    return error === undefined
      ? { ok: true }
      : { ok: false, error: `Couldn't dismiss the pending question: ${error}` };
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

  // Frame subscription effect
  useEffect(() => {
    // The inbox tracker for THIS session (K3). Disposed in the cleanup, which
    // is what drops an RPC answer that lands after the panel moved to another
    // session. Seeded by `opencode:inbox` now and on every `resync`.
    let tracker: InboxTracker | null = null;
    const fetchInbox = () => {
      const t = tracker;
      if (!t) return;
      const stamp = t.beginRequest();
      window.api
        .opencodeInbox(sessionId)
        .then((snap) => {
          t.offerResponse(stamp, snap);
        })
        .catch((e: unknown) => {
          // Not a user action: the next `inbox` frame or resync re-seeds. Say
          // so in the console rather than swallowing it.
          console.warn("[inbox] couldn't read the pending messages:", e);
        });
    };
    setInboxItems([]);
    if (inboxEnabled) {
      tracker = createInboxTracker(setInboxItems);
      inboxFetchRef.current = fetchInbox;
      fetchInbox();
    } else {
      inboxFetchRef.current = () => {};
    }

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

    // Subagent child-session frames (the child's own transcript card). A child
    // session's frames carry the CHILD's id; the panel only cares while it is in
    // the allowlist (seeded from the transcript's task parts and the parent's
    // `childSession` frame).
    //   - `flush` / `messageChanged` → refetch the child transcript, only while
    //     its card is expanded (a closed card burns no fetch traffic). `flush`
    //     matters because streamed text deltas never produce `messageChanged`.
    //   - `running` → the card's live running/idle badge; going idle also
    //     refetches the PARENT so the task part's own state flips.
    // `turnComplete` is deliberately NOT used for the child badge: the box derives
    // it from the transcript, so it fires mid-turn at every tool-step boundary
    // (see TURN_SETTLE_MS) and would flicker the badge. `running` is the hard
    // signal — the same one the raw child handler used (session.status).
    const handleChildFrame = (ev: StreamEnvelope) => {
      const childId = ev.sessionId;
      switch (ev.sub) {
        case "flush":
        case "messageChanged":
          if (expandedTasksRef.current.has(childId)) scheduleChildRefetch(childId);
          return;
        case "running": {
          const next = (ev.payload as StreamRunningPayload).running ? "running" : "idle";
          setLiveChildStatus((prev) => {
            if (prev.get(childId) === next) return prev;
            const m = new Map(prev);
            m.set(childId, next);
            return m;
          });
          if (next === "idle") scheduleRefetch();
          return;
        }
        default:
          return;
      }
    };

    // Box-interpreted stream frames (BET-551 / §17; OpenCode V2 slice A2). The
    // box derives every live signal from the raw opencode stream and publishes
    // it as `stream.*`; this is the panel's ONLY live input.
    const offStream = window.api.onStreamEvent((ev: StreamEnvelope) => {
      // Client-synthesised by httpApi when the events socket reconnects (frames
      // may have been missed): resync this panel. Carries no session id.
      if (ev.sub === "resync") {
        // Answers still in flight predate the reconnect: stale, drop them, then
        // re-seed the inbox (K3).
        tracker?.markResync();
        fetchInbox();
        scheduleRefetch();
        void refreshPermissions();
        void refreshQuestions();
        return;
      }
      if (ev.sessionId !== sessionId) {
        if (ev.sessionId && childSessionIds.current.has(ev.sessionId)) handleChildFrame(ev);
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
          const { running: nowRunning } = ev.payload as StreamRunningPayload;
          // A new turn began: a stale "Aborted" banner is no longer true.
          if (nowRunning && abortedBannerRef.current) setSendError(null);
          // Authoritative in both directions: cancel any pending settle so a
          // stale timer can't clobber this value, then apply it immediately.
          cancelTurnSettle();
          setRunning(nowRunning);
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
        case "retry": {
          // Provider is being retried (rate limit, overload, seat limit). `null`
          // = cleared by the next busy/idle.
          const r = ev.payload as StreamRetryPayload;
          setRetryInfo(
            r === null || r === undefined
              ? null
              : {
                  attempt: r.attempt ?? 0,
                  message: r.message ?? "",
                  next: r.next ?? 0,
                  action: r.action
                    ? {
                        title: r.action.title ?? "",
                        message: r.action.message ?? "",
                        label: r.action.label ?? "",
                        link: r.action.link,
                      }
                    : undefined,
                },
          );
          return;
        }
        case "aborted": {
          // session.error MessageAbortedError — the box publishes it as its own
          // frame (never as a `sessionError`, so iOS shows no banner).
          // A user Stop (or the box aborting a seat-limit retry): show the
          // "Aborted" banner; the next busy/retry clears it (abortedBannerRef).
          setSendError("Aborted");
          abortedBannerRef.current = true;
          setAuthReconnect(null);
          cancelTurnSettle();
          setRunning(false);
          return;
        }
        case "sessionError": {
          const p = ev.payload as StreamSessionErrorPayload;
          // Auth-error banner (BET-316) or the typed-prefix message. (An abort
          // never arrives here — see the `aborted` frame above.)
          const d = describeSessionError(p, providerIDRef.current);
          setSendError(d.message);
          setAuthReconnect(d.auth ? d.auth.label : null);
          cancelTurnSettle();
          setRunning(false);
          return;
        }
        case "stepEnded": {
          // Step boundary: refresh the live token snapshot so the context pill
          // updates between tool calls.
          const t = stepTokensFromFrame(ev.payload as StreamStepEndedPayload);
          if (t) setStepTokens(t);
          return;
        }
        case "planMode": {
          // Plan-mode honesty (BET-949): opencode switches its agent locally on
          // plan_enter/plan_exit, so mirror it or the chip lies. The box
          // de-dups per callID.
          setPlanOnRef.current((ev.payload as StreamPlanModePayload).on);
          return;
        }
        case "compaction": {
          const c = ev.payload as StreamCompactionPayload;
          if (c.phase === "started") {
            setCompactionState({
              reason: String(c.reason ?? "context"),
              text: String(c.text ?? ""),
              phase: "running",
            });
          } else if (c.phase === "delta") {
            setCompactionState((prev) => (prev ? { ...prev, text: prev.text + String(c.text ?? "") } : null));
          } else if (c.phase === "ended") {
            setCompactionState((prev) => (prev ? { ...prev, phase: "done" } : null));
            if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
            compactionClearTimer.current = setTimeout(() => {
              setCompactionState(null);
            }, 3000);
          }
          return;
        }
        case "transcriptStale": {
          // session.compacted: the canonical transcript changed wholesale.
          setCompactionState(null);
          scheduleRefetch();
          return;
        }
        case "inbox": {
          // The box's FULL pending-message list for this session (K3). The
          // tracker applies the epoch/rev acceptance rule.
          tracker?.offerFrame(ev.payload);
          return;
        }
        case "commandExecuted": {
          const c = ev.payload as StreamCommandExecutedPayload;
          setCommandByMessageId((prev) => {
            const next = new Map(prev);
            next.set(c.messageID, { name: c.name, arguments: c.arguments });
            return next;
          });
          return;
        }
        case "messageChanged": {
          // The canonical copy of one message changed → targeted splice (which
          // keeps its own 300ms debounce + SPLICE_MAX_WAIT_MS guard, so a running
          // tool streaming output every ~30ms still renders at a steady cap).
          // The box already resolves the messageID across the three event paths
          // (AGENTS.md "messageID + debounce-starvation trap") and coalesces to
          // ≤1 frame per message per 100 ms.
          const { messageID } = ev.payload as StreamMessageChangedPayload;
          // First-token-latency instrumentation (BET-553 / §17) — the splice path.
          markFirstToken("raw", sessionId);
          spliceMessage(messageID);
          markRendered("raw", sessionId);
          return;
        }
        case "childSession": {
          // A subagent session was created under THIS session: admit its frames.
          const { childSessionId } = ev.payload as StreamChildSessionPayload;
          if (childSessionId) childSessionIds.current.add(childSessionId);
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
        case "permissions": {
          // The box's list of this session's pending asks, used directly (no
          // refetch). Under trust mode the box never frames an ask it
          // auto-answers, so a pending list here is one the user must act on.
          const { permissions: list } = ev.payload as StreamPermissionsPayload;
          if (Array.isArray(list)) setPermissions(list as PermissionRequest[]);
          return;
        }
        case "subagent.child": {
          const { childSessionId } = ev.payload as StreamSubagentChildPayload;
          if (childSessionId) childSessionIds.current.add(childSessionId);
          return;
        }
        // BET-1347: the box compacted this conversation in the background.
        // Server-side onCompacted publishes `optimizer.compacted` on the
        // stream channel (scoped to the session, guarded by the early-return
        // above); we surface it as the transcript one-liner.
        case "optimizer.compacted": {
          const p = ev.payload as { beforeTokens?: number; afterTokens?: number; away?: boolean };
          armCompactionNotice({
            beforeTokens: typeof p?.beforeTokens === "number" ? p.beforeTokens : null,
            afterTokens: typeof p?.afterTokens === "number" ? p.afterTokens : null,
            away: p?.away === true,
          });
          return;
        }
        default:
          // context / cache / subagent / autoRename / attention / tool* —
          // consumed by other surfaces (the sidebar, the context pill), not this
          // panel's live transcript state. vcs.branch.updated has no frame on
          // purpose: the branch is polled (opencode's event is unreliable —
          // AGENTS.md "/vcs").
          return;
      }
    });

    return () => {
      offStream();
      tracker?.dispose();
      inboxFetchRef.current = () => {};
      cancelTurnSettle();
      if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
      if (compactionNoticeTimer.current) clearTimeout(compactionNoticeTimer.current);
    };
  }, [sessionId, inboxEnabled]);

  // Same acceptance rule as the seed fetch (it IS the seed fetch), so a late
  // answer for another session or from before a resync is dropped.
  const refreshInbox = useCallback(() => inboxFetchRef.current(), []);

  return {
    running,
    setRunning,
    sendError,
    setSendError,
    authReconnect,
    openAuthReconnect,
    inboxItems,
    refreshInbox,
    permissions,
    setPermissions,
    questions,
    setQuestions,
    stepTokens,
    setStepTokens,
    compactionState,
    setCompactionState,
    compactionNotice,
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
    rejectPendingQuestions,
    refreshPermissions,
    refreshQuestions,
    transcriptLoadError,
    retryTranscriptLoad,
  };
}
