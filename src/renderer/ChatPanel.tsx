// Chat panel for opencode chat-mode windows — Claude Code-style transcript.
//
// Layout intent:
//   - Full-width monospace transcript; no chat bubbles
//   - User messages prefixed with `>`; assistant messages with `●` in Claude's
//     accent orange
//   - Markdown for text parts (inline code, bold/italic, fenced code blocks,
//     lists, headers)
//   - Reasoning rendered as a dimmed italic `✻ Thinking…` block
//   - Running state shows a cycling spinner glyph + verb + elapsed seconds
//   - Input is a single bordered box with a `>` prompt prefix
//
// No Electron-only deps — only `window.api.*` (the mobile HTTP server will
// shim that surface).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  OpencodeEvent,
  OpencodeMessage,
  OpencodeModel,
  PermissionRequest,
  QuestionRequest,
} from "../shared/types";
import { useStore } from "./store";
import {
  classifyFinish,
  describeTruncation,
  allTodosTerminal,
  selectActiveTodos,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  computeStaleCache,
  STALE_CACHE_MIN_TOKENS,
  countRunningSubagents,
  classifyScrollForPin,
  wasAtBottomBeforeCommit,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  sanitizeGeneratedTitle,
  type StaleCacheResult,
} from "./chatUtils";
import {
  CLAUDE_ORANGE,
  guessMime,
  mimeToInputMode,
  modelInputModes,
  modelSupportsAttachments,
  readSavedModel,
  writeSavedModel,
  type Attachment,
  type ModelSelection,
  type TaskContextValue,
  type TokenUsage,
} from "./chatShared";
import { RunningIndicator } from "./MessageRow";
import { CompactionCard, PermissionCard, RetryCard } from "./Cards";
import { ScheduledTasksCard, SecretsCard, WebhooksCard } from "./PanelCards";
import { useSessionResources } from "./hooks/useSessionResources";
import { useInputHistory } from "./hooks/useInputHistory";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useSseBus } from "./hooks/useSseBus";
import { useVoice } from "./hooks/useVoice";
import { useTypeahead } from "./hooks/useTypeahead";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";

// Attachment / AgentMention / TypeaheadState / TypeaheadRow are shared with
// the extracted composer components and live in ./chatShared.

// bui-local slash commands. These are handled in the renderer (not forwarded
// to opencode's /command endpoint) because opencode doesn't ship equivalents
// — they're terminal-TUI conventions users expect to "just work". Each one
// dispatches to a function on the ChatPanel.
type BuiltinCommand = {
  name: string;
  description: string;
  // Returns true if the command was handled (caller skips fallthrough).
  // Returns false to fall through to opencode/prompt path (useful for
  // disabled commands).
};
const BUI_BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "clear", description: "Start a fresh chat in this window" },
  { name: "fork", description: "Copy this session's history into a new window" },
  { name: "compact", description: "Summarize to free context" },
  { name: "help", description: "Show available commands" },
];
const BUI_BUILTIN_NAMES = new Set(BUI_BUILTIN_COMMANDS.map((c) => c.name));

function buildHelpText(): string {
  const lines = [
    "Slash commands (bui-local):",
    ...BUI_BUILTIN_COMMANDS.map((c) => `  /${c.name.padEnd(8)} — ${c.description}`),
    "",
    "Shortcuts:",
    "  ⏎               send",
    "  shift+⏎         newline",
    "  esc             interrupt while running",
    "  ctrl+o          toggle reasoning / verbose tool output",
    "  @               file or agent mention typeahead",
    "  drag-drop       attach files",
  ];
  return lines.join("\n");
}

type Props = {
  sessionId: string;
  // Context for session-level operations (fork creates a new tmux window in
  // the same project; delete kills this window). Null when the owning tmux
  // window was killed remotely while we still have the panel mounted — UI
  // hides fork/delete buttons in that case.
  tmuxSession: string | null;
  windowIndex: number | null;
  cwd: string;
  // True when this panel is the currently-visible one. All ChatPanels stay
  // mounted (display:none) so we need a prop to gate "global" UI like the
  // screenshot detection toast — only the active panel should render it.
  isActive: boolean;
};

export function ChatPanel({ sessionId, tmuxSession, windowIndex, cwd, isActive }: Props) {
  const chatAutoAllow = useStore((s) => s.chatAutoAllow);
  const setChatAutoAllow = useStore((s) => s.setChatAutoAllow);
  const autoRenameSessions = useStore((s) => s.autoRenameSessions);
  const configDefaultModel = useStore((s) => s.defaultModel);
  // User-configured Anthropic prompt cache TTL — drives the "/clear to
  // save Nk tokens" pill when the session has been idle past this TTL.
  // bui doesn't set the real cache_control.ttl on requests; this is the
  // user's claim about what opencode is sending. See AppConfig comment.
  const cacheTtl = useStore((s) => s.cacheTtl);
  // Server-owned resource cards (⏰ schedules, 🔑 secrets, 🪝 webhooks) —
  // state, refresh callbacks, poll effects, session resets, and the mobile
  // `bui-open-*` window-event bridges. Extracted to a self-contained hook
  // (BET-63) because none of it touches the SSE / pin-to-bottom / message core.
  const resources = useSessionResources(sessionId);
  const {
    showSchedules,
    setShowSchedules,
    schedules,
    setSchedules,
    scheduleError,
    setScheduleError,
    refreshSchedules,
    showSecrets,
    setShowSecrets,
    secrets,
    setSecrets,
    secretError,
    setSecretError,
    refreshSecrets,
    showWebhooks,
    setShowWebhooks,
    webhooks,
    setWebhooks,
    webhookError,
    setWebhookError,
    refreshWebhooks,
  } = resources;
  // Screenshot detection toast — global, lives in the store. App.tsx owns
  // the single ipcRenderer subscription; this panel reads + clears it.
  // Only the active panel renders it (gated below by `isActive`).
  const screenshotToast = useStore((s) => s.screenshotToast);
  const setScreenshotToast = useStore((s) => s.setScreenshotToast);
  // Agent → laptop file push toast (single global instance, like screenshots).
  const agentFileToast = useStore((s) => s.agentFileToast);
  const setAgentFileToast = useStore((s) => s.setAgentFileToast);
  const [agentFileSaving, setAgentFileSaving] = useState(false);
  const setChatSubagents = useStore((s) => s.setChatSubagents);
  // Prompt-history navigation (Up/Down cycles past prompts, terminal-style) is
  // owned by useInputHistory — see the hook call after `updateInput` below.
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ===== Transcript state (extracted to useTranscriptState) =====
  const {
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
  } = useTranscriptState({ sessionId, isActive });

  // ===== SSE bus state (extracted to useSseBus) =====
  const {
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
  } = useSseBus({
    sessionId,
    cwd,
    setMessages,
    scheduleRefetch,
    spliceMessage,
    scheduleChildRefetch: (childId: string) => {
      // Per-child debounced refetch — called when a known child's
      // message.part.* event arrives while its TaskBody is expanded.
      const existing = childRefetchTimers.current.get(childId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        childRefetchTimers.current.delete(childId);
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
      }, 300);
      childRefetchTimers.current.set(childId, t);
    },
    childSessionIds,
    childMessagesRef,
    expandedTasksRef,
    childRefetchTimers,
    isActiveRef,
    refetchOwedWhileInactive,
    pendingDeltas,
    flushPendingDeltas,
    scheduleFlush,
    oldestPendingAt,
    FLUSH_MAX_AGE_MS,
    submit: () => {}, // placeholder — ChatPanel's submit is used below
    submitRef: submitRef as React.RefObject<() => void>,
    compactSession,
    forkSession,
    selectModel,
    setChatAttention: (v: boolean) => { /* no-op — sidebar attention is cleared in replyPermission/replyQuestion */ },
    setChatSubagents,
  });

  // ===== ChatPanel-own state (not extracted to hooks) =====
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [input, setInput] = useState("");
  // Messages queued while the AI was still running. The moment a queued
  // prompt exists, bui aborts the in-flight turn at the next step boundary
  // and submits the queued prompt as a fresh turn.
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Live mirror of `messageQueue` for the SSE handler closure.
  const messageQueueRef = useRef<string[]>([]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);
  // Available models + server default (pre-fetched on mount, not lazy — so
  // the footer can show a meaningful model name before the first response,
  // and clicking the picker doesn't flash a "Loading…" row). Selection is
  // per-session and persists via localStorage.
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [defaultModel, setDefaultModel] = useState<{
    providerID: string;
    modelID: string;
  } | null>(null);
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(() =>
    readSavedModel(sessionId) ?? configDefaultModel ?? null,
  );
  // Pending attachments (chips above input) + agent @-mentions waiting to be
  // serialized into FilePart / AgentPart on next submit. Cleared on success.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Ephemeral system notice (e.g. /help output) rendered above the input.
  // Cleared on dismiss or on next session change.
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  // Whether the panel is currently being dragged over with files (for the
  // big "drop to attach" overlay).
  const [dragHover, setDragHover] = useState(false);
  // Screenshot detection toast — global, lives in the store. App.tsx owns
  // the single ipcRenderer subscription; this panel reads + clears it.
  // Only the active panel renders it (gated below by `isActive`).
  const screenshotToast = useStore((s) => s.screenshotToast);
  const setScreenshotToast = useStore((s) => s.setScreenshotToast);
  // Agent → laptop file push toast (single global instance, like screenshots).
  const agentFileToast = useStore((s) => s.agentFileToast);
  const setAgentFileToast = useStore((s) => s.setAgentFileToast);
  const [agentFileSaving, setAgentFileSaving] = useState(false);
  // Per-child loading/error state for the lazy fetch on expand.
  const [childFetchState, setChildFetchState] = useState<
    Map<string, "loading" | "error">
  >(() => new Map());
  // Ref mirrors of the child-state maps so `toggleTaskExpand` can read
  // current values synchronously without taking them as deps.
  const childFetchStateRef = useRef<Map<string, "loading" | "error">>(new Map());
  const liveChildStatusRef = useRef<Map<string, "running" | "idle">>(new Map());
  useEffect(() => {
    childFetchStateRef.current = childFetchState;
  }, [childFetchState]);
  useEffect(() => {
    liveChildStatusRef.current = liveChildStatus;
  }, [liveChildStatus]);
  // Per-child debounce timers for refetching child transcripts when their
  // expanded card is receiving SSE traffic. Keyed by childSessionId. 300ms
  // matches the parent's scheduleRefetch debounce so behavior is uniform.
  const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Compaction clear timer.
  const compactionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load + reload whenever sessionId changes.
  // Most state resets are now handled by the extracted hooks (useTranscriptState
  // resets messages/scroll/delta-buffer, useSseBus resets permissions/questions/
  // stepTokens/etc. via its SSE effect cleanup). We only need to reset the
  // ChatPanel-own state here: error, modelOverride, attachments, agentMentions,
  // systemNotice, dragHover. The SSE stream open/close is also handled by
  // useSseBus's effect now.
  useEffect(() => {
    setError(null);
    setModelOverride(readSavedModel(sessionId) ?? configDefaultModel ?? null);
    setAttachments([]);
    setAgentMentions([]);
    setSystemNotice(null);
    setDragHover(false);
    // Branch indicator: poll every 5s while this session is mounted.
    const fetchBranch = () => {
      window.api
        .opencodeVcsBranch(cwd)
        .then((b) => {
          setBranch(b);
        })
        .catch(() => { /* non-fatal — non-git cwd or transport blip */ });
    };
    fetchBranch();
    const branchPoll = setInterval(fetchBranch, 5000);
    return () => {
      clearInterval(branchPoll);
    };
  }, [sessionId, cwd]);

  // (schedule / secrets / webhook poll + reset effects moved to
  // useSessionResources — see the `resources` hook call above.)

  // Refresh permissions list. Called on any permission event.
  // Passes `sessionId` so the main process scopes the request to this
  // session's workspace directory (see opencodePermissions in opencode.ts).
  const refreshPermissions = useCallback(() => {
    window.api
      .opencodePermissions(sessionId)
      .then((all) =>
        setPermissions(all.filter((p) => p.sessionID === sessionId)),
      )
      .catch(() => { /* keep last-known */ });
  }, [sessionId]);

  // Refresh question list. Called on any question event.
  //
  // `hydrateQuestion` (defined above the component) normalizes the server's
  // QuestionRequest shape into the renderer's QuestionLike: in particular,
  // it copies the server's `id` (which is the `que_…`) into our `requestId`
  // field. Without this, a card rendered from the GET-hydrate path looks
  // visually correct but the reply handler errors with "reply token was not
  // captured" because `q.requestId` is undefined — even though the `que_`
  // is sitting right there in `q.id`. (Live SSE events carry both shapes:
  // applyQuestionEvent fills `requestId` from `p.id` explicitly; the GET
  // path was the regression introduced by the workspace-scope fix making
  // GET authoritative.)
  const refreshQuestions = useCallback(() => {
    window.api
      .opencodeQuestions(sessionId)
      .then((all) =>
        setQuestions(
          all
            .filter((q) => q.sessionID === sessionId)
            .map(hydrateQuestion) as QuestionRequest[],
        ),
      )
      .catch(() => { /* keep last-known — v2-only endpoint */ });
  }, [sessionId]);

  // Subscribe to the global opencode event stream; filter by sessionID.
  useEffect(() => {
    // ===== Buffered text-delta flush =====
    //
    // Applies as much of each pending delta as can be safely flushed
    // (i.e. everything up to the deepest section boundary) into
    // `messages` state in ONE setMessages call, then keeps any trailing
    // not-yet-bounded text in the buffer for the next round.
    //
    // `force=true` flushes everything regardless of boundaries — used on
    // step-ended, part-updated, session-idle, and the max-age timeout.
    // Returns the count of partIDs that couldn't be matched against any
    // part in `messages` (race: delta arrived before snapshot); caller
    // schedules a refetch if any unmatched.
    const flushPendingDeltas = (force: boolean): number => {
      const buf = pendingDeltas.current;
      if (buf.size === 0) return 0;
      // Build the to-flush map: for each pending part, slice off either
      // the longest bounded prefix (normal) or the whole buffer (force).
      const toApply = new Map<string, PendingDelta>();
      for (const [partID, d] of buf) {
        if (force) {
          toApply.set(partID, d);
          continue;
        }
        const idx = findFlushBoundary(d.text);
        if (idx <= 0) continue;
        toApply.set(partID, { ...d, text: d.text.slice(0, idx) });
        // Keep the unbounded remainder in the buffer.
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
      // If the buffer is now empty (force, or every entry flushed
      // cleanly), reset the age clock; otherwise leave it ticking so
      // the trailing remainder still has a deadline.
      if (buf.size === 0) oldestPendingAt.current = null;
      return unmatchedCount;
    };

    // Schedule a flush check soon. Uses two timers conceptually:
    //   - A short (16ms) "boundary check" tick after each delta so we
    //     react quickly when a boundary character lands, without doing
    //     a full setMessages on every keystroke-equivalent.
    //   - The age-based force flush handled inline by checking
    //     `oldestPendingAt` against FLUSH_MAX_AGE_MS.
    // Both share a single setTimeout slot.
    const scheduleFlush = () => {
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
        // If anything is still buffered (trailing remainder), keep
        // checking — but only if the buffer is actually still aging.
        if (pendingDeltas.current.size > 0) {
          // Either we just sliced off a prefix and the remainder is
          // waiting for its own boundary, or aged=true cleared
          // everything. Defensive: reschedule only if there's content.
          scheduleFlush();
        }
      }, delay);
    };

    // scheduleRefetchRef is a component-level useRef (declared near
    // refetchTimer). scheduleFlush calls it before scheduleRefetch is
    // defined below; the reactivation catch-up effect also reads it.
    const scheduleRefetch = () => {
      // Inactive panels don't render their transcript (App.tsx hides them
      // with display:none) — skip the expensive full re-pull + re-render and
      // just remember we owe one. The reactivation effect pulls fresh on
      // becoming visible. Live sidebar state (running/attention/todos) is set
      // by the other branches of the handler, which still run. This is the
      // primary fix for the per-event ×K-panels cost that grows over a
      // session as more chat windows are opened.
      if (!isActiveRef.current) {
        refetchOwedWhileInactive.current = true;
        return;
      }
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        window.api
          .opencodeMessages(sessionId)
          .then((m) => {
            setMessages(m);
            // Re-seed the subagent allowlist on every refetch — covers
            // children spawned by a turn that completed entirely in
            // between event subscriptions (rare, but possible after a
            // reconnect window).
            for (const cid of collectChildSessionIds(m)) {
              childSessionIds.current.add(cid);
            }
            // Self-heal a stuck spinner. `running` is normally cleared by
            // the live `session.idle` / `session.status{idle}` event — but
            // if the scoped event stream dropped after the first post-resume
            // frame and before that idle (half-dead dedicated tunnel, the
            // "got a first line then hangs" failure), opencode never
            // re-emits idle for the now-idle session on reconnect. The
            // reconnect DOES trigger this refetch, and the completed turn is
            // in `m` — so recompute "done" from the authoritative transcript
            // (assistant `time.completed`) and clear the orphaned spinner.
            // One-way: only clears, never sets running true (that stays
            // event/optimistic-send driven), so it can't race an in-flight
            // turn — an active turn has no completion stamp on its last
            // message, or a trailing user message, both → not complete.
            if (isAssistantTurnComplete(m)) setRunning(false);
          })
          .catch(() => { /* keep last-known state */ });
      }, 300);
    };
    scheduleRefetchRef.current = scheduleRefetch;

    // Incremental splice: fetch ONE message by id and merge it into `messages`
    // by id (replace if present, insert in time order if new), instead of
    // re-pulling the entire (up-to-3 MB) transcript on every part-finalization
    // event. This is the live-turn analog of the switch-time tail-merge.
    //
    // Per-message fetches are debounced+coalesced per messageID so a chatty
    // part stream (many message.part.updated for the same message) collapses to
    // one fetch. On a fetch miss (null) or an unmatched insert we fall back to
    // the full scheduleRefetch so we can never get permanently out of sync.
    const spliceMessage = (messageId: string) => {
      if (!messageId) {
        scheduleRefetch();
        return;
      }
      // Inactive panels don't render — defer to the reactivation refetch, same
      // policy as scheduleRefetch (avoids per-event ×K-panels fetch cost).
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
                // Miss — fall back to a full pull so we don't drop the update.
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
                // New message: insert in time order (it's usually the newest,
                // so this is an append in the common case).
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
    };

    // Per-child debounced refetch — called when a known child's
    // message.part.* event arrives while its TaskBody is expanded. We
    // re-pull the FULL child transcript instead of merging deltas inline
    // because subagent transcripts are typically short (one task = one
    // turn), and pure-refetch sidesteps the buffered-delta-buffer's
    // parent-keyed state.
    const scheduleChildRefetch = (childId: string) => {
      const existing = childRefetchTimers.current.get(childId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        childRefetchTimers.current.delete(childId);
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
      }, 300);
      childRefetchTimers.current.set(childId, t);
    };

    // Issue a drain-abort if a prompt is queued and we haven't already this
    // turn. Called at every real mid-turn step boundary (a completed tool
    // part) AND the legacy step.ended fallback. Idempotent: drainAbortRef
    // gates re-entrancy so multiple boundaries before the abort POST lands
    // only fire one abort. The abort flips the turn idle (via the swallowed
    // MessageAbortedError / session.idle), and the [running, messageQueue]
    // effect then submits the queued prompt as a fresh turn.
    const maybeDrainQueuedPrompt = () => {
      if (!shouldAbortForQueuedDrain(messageQueueRef.current.length, drainAbortRef.current)) {
        return;
      }
      drainAbortRef.current = true;
      void window.api.opencodeAbort(sessionId).catch(() => {
        // Abort POST failed — re-arm so a later boundary can retry, and fall
        // back to the slower idle-drain in the meantime.
        drainAbortRef.current = false;
      });
    };

    const off = window.api.onOpencodeEvent((ev: OpencodeEvent) => {
      const props = ev.properties ?? {};
      // Per-session guard for transcript/state events (message.*, todo.*,
      // etc.) that only matter for the currently-viewed session.
      //
      // EXEMPTION: question.*/permission.* lifecycle events must bypass this.
      // Their `properties` is the QuestionRequest/PermissionRequest itself,
      // so `props.sessionID` is the QUESTION's session — which differs from
      // the viewed `sessionId` whenever the user isn't already on that exact
      // session. The handlers below (refreshQuestions/refreshPermissions)
      // already self-filter by sessionID after re-fetching, so pre-dropping
      // here just means the refresh trigger never fires and the card never
      // appears. opencode also emits question.asked ONLY on the scoped
      // `?directory=` stream, so the mount-time poll alone can't cover a
      // mid-turn question — the live event MUST get through. (Root cause of
      // "questions never appear".)
      // Per-session guard. Events for OUR session always pass; events for a
      // known CHILD subagent session (in childSessionIds allowlist) are
      // routed to the subagent-handling branch below; everything else with a
      // non-matching sessionID is dropped — UNLESS it's a self-filtering
      // lifecycle event (question.*/permission.*, whose own handlers
      // re-filter after the refresh trigger they cause).
      const evSessionID = typeof props.sessionID === "string" ? props.sessionID : "";

      // Register a NEW subagent child id BEFORE the per-session filter
      // runs — see registerChildSessionFromCreated's docstring for the
      // ordering rationale (the filter would otherwise drop the very
      // event we'd use to enlarge the allowlist).
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

      // ===== Subagent child-session event routing =====
      //
      // For events scoped to a known child, only a narrow set actually
      // matters for the inline TaskBody renderer: message-shape updates
      // (so the expanded card stays live), session lifecycle (so the
      // header badge flips running→idle), and session.created (which we
      // also use to enlarge the allowlist for grandchildren). Everything
      // else (compaction, todo.updated, vcs.branch.updated on child, etc.)
      // is intentionally ignored — TaskBody is read-only, no point routing
      // them into a separate state pipeline.
      if (isChildEvent) {
        if (
          ev.type === "message.part.updated" ||
          ev.type === "message.part.delta" ||
          ev.type === "message.updated" ||
          ev.type === "message.part.removed" ||
          ev.type === "message.removed"
        ) {
          // Only refetch children whose card is expanded — keeps idle
          // panels cheap and avoids re-rendering subagent transcripts the
          // user isn't looking at. The expanded card has the partID's
          // parent message in its state; without that part, deltas would
          // accumulate orphaned in `pendingDeltas`.
          //
          // Coalesce per-child via a small debounce. Without it, a chatty
          // subagent (one streaming delta every ~30ms) would re-fetch its
          // full transcript on every event.
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
          // The parent's task tool part status snapshot is what users
          // actually see in the collapsed card — re-fetch the parent so
          // its state.status flips from "running" to "completed". Otherwise
          // the badge keeps spinning until the next parent SSE event.
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
        // Any other child-scoped event is dropped — handled above or not
        // needed for read-only subagent UI.
        return;
      }

      if (ev.type === "message.part.delta") {
        const partID = String(props.partID ?? "");
        const messageID = String(props.messageID ?? "");
        const field = String(props.field ?? "text");
        const delta = String(props.delta ?? "");
        if (!partID || !delta) return;

        // Inactive panel: don't buffer/flush deltas (flushing re-renders the
        // streaming message, which the user can't see). The catch-up refetch
        // on reactivation pulls the canonical transcript, which already
        // contains this streamed text — so dropping the live delta loses
        // nothing visible. Mark the owed refetch so reactivation repaints.
        if (!isActiveRef.current) {
          refetchOwedWhileInactive.current = true;
          return;
        }

        // Buffer the delta instead of applying it immediately. The flush
        // helper will slice off the longest prefix ending at a section
        // boundary (paragraph break outside a code block, or a closing
        // ``` fence) and apply only that to state — keeping any trailing
        // half-formed content out of React until it's complete. See
        // `findFlushBoundary` (chatUtils.ts) for the boundary rules and
        // FLUSH_MAX_AGE_MS for the long-paragraph fallback.
        //
        // Different (partID, field) pairs need separate buffer entries
        // — a reasoning part and a text part can stream concurrently
        // and they go to different `field` keys on different `partID`s.
        // The key is partID alone because opencode only ever streams
        // one field per part at a time (reasoning parts stream `text`
        // just like text parts do).
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

      // Mirror server-reported running state. session.status carries a nested
      // {type: "idle"|"busy"|"retry"} discriminator; session.idle is sugar.
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
        // Retry is a transient state between busy attempts — surface attempt
        // count + actionable hint so the user knows the AI hasn't stalled.
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

      // Server-side prompt failure (model not found, provider down, etc).
      // Without surfacing this the renderer just sits at "running" forever
      // and the user thinks the AI isn't replying. opencode v2 names the
      // error class on `err.name`; prepend a context-appropriate prefix so
      // the user can tell auth failures from context overflows at a glance.
      if (ev.type === "session.error") {
        const err = (props.error as { data?: { message?: string }; name?: string } | undefined);
        const raw = err?.data?.message ?? err?.name ?? "Unknown server error";
        // Drain-initiated abort: we aborted this turn ourselves to make room
        // for a queued prompt. Swallow the MessageAbortedError silently — no
        // banner — and just flip idle so the [running, messageQueue] effect
        // submits the queued prompt. (session.idle usually also fires, but
        // flipping here is the safety net if it doesn't.) Leave drainAbortRef
        // set; the drain effect clears it when the queued prompt lands.
        if (isDrainAbortError(err?.name, drainAbortRef.current)) {
          setRunning(false);
          return;
        }
        let msg: string;
        switch (err?.name) {
          case "ProviderAuthError":
            msg = `Auth error: ${raw}`;
            break;
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
            // MessageAbortedError, UnknownError, and anything we don't have a
            // specific phrasing for falls through to the raw message.
            msg = raw;
        }
        setSendError(msg);
        setRunning(false);
      }

      // Live token/cost snapshot at every step boundary. The transcript-
      // derived latestTokens lags by one re-fetch cycle (we only refetch on
      // message.part.updated / .updated), so the footer goes stale during a
      // long tool roundtrip. step.ended fires after each reasoning/tool step
      // with the cumulative usage — feed it straight into stepTokens.
      if (ev.type === "session.next.step.ended") {
        // A step ending means the assistant's narration for this step is
        // complete — flush any buffered tail (a final sentence/paragraph
        // that didn't end with a paragraph break) so the user sees it
        // before the next step starts (often a tool call).
        flushPendingDeltas(true);

        // Queued-prompt drain (FALLBACK path). The PRIMARY trigger is a
        // completed tool part in the message.part.updated handler below,
        // because `session.next.step.ended` is NOT emitted by the deployed
        // opencode build (verified live — see isToolStepBoundary's note in
        // chatUtils.ts). This block stays as a no-cost fallback for builds
        // that DO emit step.ended: maybeDrainQueuedPrompt is idempotent
        // (drainAbortRef guards re-entrancy), so having both triggers is safe.
        maybeDrainQueuedPrompt();

        const tokens = props.tokens as TokenUsage | undefined;
        const cost = typeof props.cost === "number" ? props.cost : 0;
        if (tokens) {
          setStepTokens({
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            reasoning: tokens.reasoning ?? 0,
            cache: {
              read: tokens.cache?.read ?? 0,
              write: tokens.cache?.write ?? 0,
            },
            cost,
          });
        }
        // Finish-reason inspection. Opencode normalizes provider-native
        // stop_reason / finish_reason values into `properties.finish`.
        // classifyFinish() returns null for benign finishes (end_turn,
        // tool_use, etc.) so the badge map only grows on real truncations.
        //
        // For "max_tokens" we also peek at the last part of the assistant
        // message to detect the silently-fatal mid-tool-call case: when the
        // model was emitting a tool_use JSON block and got cut off, the
        // call is incomplete and the agent loop would otherwise try to
        // execute invalid JSON. Promoting it to "tool-cutoff" gives the
        // user a distinct badge + clearer remediation.
        const finishRaw =
          typeof props.finish === "string" ? props.finish : null;
        const stepMsgId =
          typeof props.messageID === "string" ? props.messageID : null;
        if (finishRaw && stepMsgId) {
          // Find the message and check whether its last non-trivial part is
          // an incomplete tool_use. We look at the current `messages` array
          // via the setter closure to avoid stale-closure issues.
          let lastPartIsToolUse = false;
          setMessages((prevMsgs) => {
            if (!prevMsgs) return prevMsgs;
            const m = prevMsgs.find((mm) => mm.info.id === stepMsgId);
            if (m) {
              for (let i = m.parts.length - 1; i >= 0; i--) {
                const p = m.parts[i];
                if (p.type === "step-start" || p.type === "step-finish") continue;
                lastPartIsToolUse = p.type === "tool";
                break;
              }
            }
            return prevMsgs;
          });
          const kind = classifyFinish(finishRaw, { lastPartIsToolUse });
          if (kind) {
            setFinishByMessageId((prev) => {
              if (prev.get(stepMsgId) === kind) return prev;
              const next = new Map(prev);
              next.set(stepMsgId, kind);
              return next;
            });
            // Also keep the legacy soft-banner so this change is additive:
            // a per-message badge is more discoverable but the dismissable
            // banner remains the loud signal for the active turn. Banner
            // copy is now finish-aware. Don't clobber a more-specific
            // session.error.
            const desc = describeTruncation(kind);
            setSendError((prev) => prev ?? `Response ${desc.label}`);
          }
        }
      }

      // Live compaction progress. Without surfacing these events the user
      // fires /compact, sees nothing for several seconds, then the
      // transcript abruptly shrinks. .started → "Compacting…", .delta
      // appends fragments of the summary, .ended sets the final text and
      // we hold the "Compacted" confirmation briefly before clearing (the
      // session.compacted re-fetch will already have updated the transcript).
      if (ev.type === "session.next.compaction.started") {
        if (compactionClearTimer.current) {
          clearTimeout(compactionClearTimer.current);
          compactionClearTimer.current = null;
        }
        setCompactionState({
          reason: String(props.reason ?? ""),
          text: "",
          phase: "running",
        });
      }
      if (ev.type === "session.next.compaction.delta") {
        const frag = String(props.text ?? "");
        setCompactionState((prev) =>
          prev ? { ...prev, text: prev.text + frag } : prev,
        );
      }
      if (ev.type === "session.next.compaction.ended") {
        const finalText = String(props.text ?? "");
        setCompactionState((prev) =>
          prev
            ? { ...prev, text: finalText || prev.text, phase: "done" }
            : { reason: "", text: finalText, phase: "done" },
        );
        if (compactionClearTimer.current) clearTimeout(compactionClearTimer.current);
        compactionClearTimer.current = setTimeout(() => {
          setCompactionState(null);
          compactionClearTimer.current = null;
        }, 2500);
      }

      // Branch indicator — vcs.branch.updated has no sessionID so it bypasses
      // the early filter at the top of the handler. opencode emits one event
      // per worker on every branch change; for the chat footer we just want
      // the latest value (`branch?` is unset when the dir leaves a git repo).
      if (ev.type === "vcs.branch.updated") {
        const b = props.branch;
        setBranch(typeof b === "string" ? b : null);
      }

      // Live TodoWrite mirror — opencode fires todo.updated whenever the
      // tool stores a new list. The transcript-scraped activeTodos lags by
      // one re-fetch cycle and only sees the final state; this gives us the
      // intermediate ticks (e.g. one task flipping to in_progress).
      if (ev.type === "todo.updated") {
        const todos = props.todos as
          | Array<{ content?: unknown; status?: unknown; priority?: unknown }>
          | undefined;
        if (Array.isArray(todos)) {
          setLiveTodos(
            todos.map((t) => ({
              content: String(t.content ?? ""),
              status: String(t.status ?? "pending"),
              priority: String(t.priority ?? ""),
            })),
          );
          // New activity from the model — clear any prior user dismissal so
          // the refreshed list (even if itself fully completed) is shown.
          setTodosDismissed(false);
        }
      }

      // Slash-command provenance. opencode emits this when it accepts a
      // /command POST and creates the assistant turn that will hold the
      // response. The event's `messageID` is the NEW ASSISTANT turn id, not
      // the user message that holds the expanded template body — the user
      // message sits immediately before it in the transcript. We key the
      // map by assistant-id and resolve to the user-id at render time (see
      // the messages.map(...) site where `cmdInfo` is computed via idx+1).
      if (ev.type === "command.executed") {
        const p = ev.properties as {
          name?: string;
          messageID?: string;
          arguments?: string;
        };
        if (typeof p.messageID === "string" && typeof p.name === "string") {
          const messageID = p.messageID;
          const name = p.name;
          const argumentsStr = typeof p.arguments === "string" ? p.arguments : "";
          setCommandByMessageId((m) => {
            const next = new Map(m);
            next.set(messageID, { name, arguments: argumentsStr });
            return next;
          });
        }
      }

      // PRIMARY queued-prompt drain trigger. A tool part flipping to a
      // terminal status ("completed"/"error") is the only reliable mid-turn
      // step boundary the deployed opencode emits (session.next.step.ended
      // never fires — see isToolStepBoundary). The model just finished a tool
      // round-trip and is about to think/call again, so aborting here cleanly
      // ends the turn and lets the queued prompt go out as a fresh one rather
      // than waiting for the whole (possibly many-step) turn to complete.
      if (ev.type === "message.part.updated" && isToolStepBoundary(props.part)) {
        maybeDrainQueuedPrompt();
      }

      if (
        ev.type === "message.part.updated" ||
        ev.type === "message.updated"
      ) {
        // Force-flush any buffered text deltas before the merge overwrites the
        // affected message. Without this, a still-buffered trailing paragraph
        // would be discarded when the canonical message arrives (the server
        // snapshot has the same content but the fetch races the buffer's
        // max-age timer).
        flushPendingDeltas(true);
        // Incremental: splice just the touched message instead of re-pulling
        // the whole transcript. messageID lives at props.part.messageID for
        // part events and props.info.id for message.updated. On an empty id we
        // fall back to a full refetch inside spliceMessage.
        const mid =
          ev.type === "message.part.updated"
            ? String(
                (props.part as { messageID?: string } | undefined)?.messageID ??
                  "",
              )
            : String(
                (props.info as { id?: string } | undefined)?.id ?? "",
              );
        spliceMessage(mid);
      } else if (
        ev.type === "session.idle" ||
        ev.type === "session.status" ||
        ev.type === "session.compacted" ||
        ev.type === "session.error"
      ) {
        // Session-lifecycle events carry no single messageID — a full refetch
        // is the right tool (and these are infrequent vs part events). It also
        // runs the isAssistantTurnComplete spinner self-heal.
        flushPendingDeltas(true);
        scheduleRefetch();
      }

      // Transport (re)connect resync. opencode emits `server.connected` as
      // the first frame of EVERY SSE connection — including the fresh one
      // the main-process bus opens after a dropped/stalled scoped stream.
      // It carries no sessionID (transport frame, bypasses the per-session
      // guard like vcs.branch.updated). This is the ONLY event guaranteed
      // to arrive after a reconnect when the turn already finished
      // server-side: the missed `session.idle` is never re-emitted for an
      // already-idle session, and an idle reconnected stream otherwise
      // produces only heartbeats (no refetch trigger). Refetching here
      // re-pulls the canonical transcript; the isAssistantTurnComplete
      // check in scheduleRefetch then clears any spinner orphaned by the
      // drop. Root-cause fix for "UI stuck on spinner after the turn
      // completed server-side" (HANDOFF-sse-ui-completion-gap).
      //
      // ALSO re-pull questions + permissions. Long-running tools (e.g. a
      // bash that takes >45s) produce no substantive frames while running,
      // so the bus watchdog tears the stream down. If a `question.asked`
      // or `permission.asked` fires DURING the reconnect window, the live
      // event is lost — the card never appears and the session looks stuck
      // even after the workspace-scope fix landed. Resyncing both lists on
      // every reconnect closes the gap: any pending entry the server has
      // for this session re-hydrates and the existing renderers handle it.
      if (ev.type === "server.connected") {
        scheduleRefetch();
        refreshQuestions();
        refreshPermissions();
      }

      // Queue drain. The actual submit happens in the [running, messageQueue]
      // effect below the moment `running` flips false. Idle is reached either
      // by a turn finishing naturally OR by the step-boundary drain-abort in
      // the session.next.step.ended handler above: as soon as a prompt is
      // queued, we abort the in-flight turn at the next step boundary instead
      // of waiting for the whole (possibly many-step) turn to end. The
      // resulting MessageAbortedError is tagged via drainAbortRef and
      // swallowed by the session.error handler, so the swap is invisible —
      // the queue just advances and the new prompt starts processing.
      //
      // Posting a prompt mid-turn WITHOUT a preceding abort is what produced
      // the old "MessageAbortedError banner + aborted assistant message"
      // artifact — opencode aborts implicitly to start the new turn. The
      // explicit abort + error suppression here is what makes that clean.

      // Permission lifecycle — refresh the inline approval list so the card
      // appears/disappears in real time as opencode requests/closes them.
      if (ev.type === "permission.asked" || ev.type === "permission.replied") {
        refreshPermissions();
        // permission.replied implies the matching tool just unstuck — pull
        // the canonical message state so the ToolPart re-renders as running.
        if (ev.type === "permission.replied") scheduleRefetch();
      }

      // Question lifecycle. opencode v1.15 delivers the FULL question in the
      // `question.asked` event payload (properties is a QuestionRequest);
      // `GET /question` stays empty for live questions, so the old
      // refreshQuestions() re-poll set the list to [] and the card never
      // appeared (regression since 1a5a336). Drive state from the event
      // payload itself — see applyQuestionEvent (chatUtils, tested).
      if (
        ev.type === "question.asked" ||
        ev.type === "question.replied" ||
        ev.type === "question.rejected"
      ) {
        setQuestions((prev) =>
          applyQuestionEvent(
            prev,
            ev.type,
            ev.properties,
            sessionId,
          ) as QuestionRequest[],
        );
        if (ev.type === "question.replied" || ev.type === "question.rejected") {
          scheduleRefetch();
        }
      }
    });

    return () => {
      off();
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      if (compactionClearTimer.current) {
        clearTimeout(compactionClearTimer.current);
        compactionClearTimer.current = null;
      }
      // Cancel any pending child transcript refetches; the next session's
      // effect will fetch fresh on first expand.
      for (const t of childRefetchTimers.current.values()) clearTimeout(t);
      childRefetchTimers.current.clear();
      // Cancel any pending single-message splices for the same reason.
      for (const t of spliceTimers.current.values()) clearTimeout(t);
      spliceTimers.current.clear();
      // Force-flush whatever's still buffered on unmount/session change
      // so the user doesn't lose the final sentence of a turn when they
      // navigate away. (The new session's effect will clear the buffer
      // again on its own initial-load reset.)
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (pendingDeltas.current.size > 0) {
        flushPendingDeltas(true);
      }
    };
  }, [sessionId]);

  // Pinned-to-bottom detection — derive pin state from the PRE-commit DOM,
  // not from event-cached state.
  //
  // Prior designs and the bug they each hit:
  //
  //   v1 (pre-631b03e): symmetric 80px threshold. A 30px scroll-up left
  //     dist=30 < 80, the next delta saw `pinned === true`, snap. Lost.
  //
  //   v2 (631b03e): tight 8px re-pin + wheel/touch/key "intent" un-pin.
  //     wheel-up explicitly unpinned regardless of distance, fixing v1.
  //     Missed scrollbar-handle drag (no wheel/touch/key) and got snapped
  //     by the `running` false→true edge effect on busy/idle oscillations.
  //
  //   v3 (f1b7341): single 8px symmetric threshold + one `scroll` listener.
  //     Right idea, wrong substrate. `scroll` events are dispatched
  //     asynchronously (rAF-batched in modern browsers), but
  //     setMessages → render → effect is synchronous in the SAME task. So
  //     this sequence eats the user's scroll-up during active streaming:
  //
  //       1. User wheels up 50px. scrollTop drops synchronously.
  //       2. Streaming delta lands in the same tick. setMessages fires.
  //       3. Effect runs with stale `pinned == true` from the LAST scroll
  //          event, calls stickToBottom, scrollTop = scrollHeight.
  //       4. Only NOW does the queued scroll event for the wheel-up
  //          dispatch. It observes dist=0 (post-snap) and reaffirms
  //          `pinned == true`. The user's wheel-up is silently erased.
  //
  //     During heavy streaming (deltas every few ms) this happens on
  //     virtually every wheel attempt, hence "still jumping to bottom."
  //
  // v4 (here): the post-commit stick decision reads the live DOM in a
  // `useLayoutEffect` (synchronous post-commit, pre-paint) and computes
  // pre-commit distance against the PREVIOUS render's scrollHeight:
  //
  //     prevDist = max(0, prevScrollHeight - scrollTop - clientHeight)
  //
  // `scrollTop` is preserved by the browser when content is appended, so
  // this is the user's actual position before the new rows landed. No
  // event timing, no stale ref. The `scroll` listener is kept as a
  // back-channel for callers that need the boolean outside the messages
  // commit (the RunningIndicator `atBottom` prop, the resizeInput
  // re-stick, the isActive re-pin), but it is no longer load-bearing for
  // the streaming case.
  //
  // Force-pin paths stay explicit and limited to user actions: `submit()`
  // sets `pinnedToBottom.current = true` AND resets
  // `prevScrollHeight.current = 0` (so the next layout effect sticks
  // unconditionally via the prevScrollHeight=0 → pin branch in
  // `wasAtBottomBeforeCommit`). Queue drains route through the same
  // submit() path, so they inherit this force-pin for free.
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  // Tracks the scrollHeight as of the last completed commit. The layout
  // effect compares this against the live DOM to derive whether the user
  // WAS pinned before the new content landed. Reset to 0 on session
  // change and on explicit force-pin (submit).
  const prevScrollHeight = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedToBottom.current = classifyScrollForPin({
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Reset prevScrollHeight when the session id changes — the new session's
  // first messages commit must pin unconditionally (the initial render's
  // scrollHeight is 0 anyway, but being explicit guards against effect
  // ordering surprises if anything else resets `messages` to null first).
  useEffect(() => {
    prevScrollHeight.current = 0;
    pinnedToBottom.current = true;
  }, [sessionId]);

  // On every messages / liveTodos commit: if the user WAS at the tail
  // before this commit grew the container, glue to the new tail. Layout
  // effect — runs synchronously post-commit, pre-paint, so the user never
  // sees the brief mid-frame where the viewport is partway down.
  //
  // The decision uses `prevScrollHeight.current` (the height as of the
  // last commit), NOT a cached pin boolean. `scrollTop` in the live DOM is
  // unchanged by appending content, so `prevScrollHeight - scrollTop -
  // clientHeight` is the user's actual pre-commit distance from bottom.
  // This is robust against the v3 streaming-snap-back race because we
  // never consult the async-dispatched scroll event for stick decisions.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasPinned = wasAtBottomBeforeCommit(
      prevScrollHeight.current,
      el.scrollTop,
      el.clientHeight,
    );
    if (wasPinned) {
      el.scrollTop = el.scrollHeight;
      pinnedToBottom.current = true;
    } else {
      pinnedToBottom.current = false;
    }
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, liveTodos, questions]);

  // Ctrl+O toggles reasoning visibility. Matches Claude Code's TUI keybind.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        setShowThinking((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Notification deep-link → scroll to the pending QuestionCard. iOS web push
  // can't render inline action buttons, so a question notification opens the
  // app; this brings the card into view so it's a single tap to answer. The
  // signal comes two ways: a window global latch (set by MobileApp before this
  // panel mounts on a cold start from a notification) and a live CustomEvent
  // (warm — app already open on this session). Either arms wantQuestionScroll;
  // the effect below performs the scroll once the questions have rendered.
  useEffect(() => {
    type ScrollWin = Window & { __buiScrollQuestionSession?: string | null };
    const w = window as ScrollWin;
    if (w.__buiScrollQuestionSession && w.__buiScrollQuestionSession === sessionId) {
      wantQuestionScroll.current = true;
      w.__buiScrollQuestionSession = null;
    }
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) {
        wantQuestionScroll.current = true;
        if (questions.length > 0) {
          questionCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          wantQuestionScroll.current = false;
        }
      }
    };
    window.addEventListener("bui-scroll-to-question", onEvt);
    return () => window.removeEventListener("bui-scroll-to-question", onEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // (bui-open-schedules / -secrets / -webhooks mobile bridges moved to
  // useSessionResources.)

  // Perform the deferred scroll once the question cards actually exist (cold
  // start: questions arrive via the async fetch after this panel mounts).
  useEffect(() => {
    if (wantQuestionScroll.current && questions.length > 0) {
      questionCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      wantQuestionScroll.current = false;
    }
  }, [questions]);

  // Textarea auto-resize up to a 6-line cap. After resizing, if the scroll
  // container is pinned to bottom we re-scroll so the input growing pushes
  // the chat content up rather than sliding over it.
  //
  // Reads the LIVE DOM pin state rather than the event-cached
  // `pinnedToBottom.current`. The cache lags scroll events (rAF-batched
  // dispatch), so if a user scrolled up to read history and then typed a
  // character, the cache could be stale=true and we'd snap them back.
  // The live read uses `classifyScrollForPin` directly against the
  // pre-resize scrollHeight, which is what the user actually sees.
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const scroller = scrollRef.current;
    const wasAtBottom = scroller
      ? classifyScrollForPin({
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
        })
      : false;
    el.style.height = "auto";
    const cap = 6 * 20;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    if (wasAtBottom) {
      stickToBottom();
      // Resync derived state so a subsequent layout effect agrees.
      pinnedToBottom.current = true;
      if (scroller) prevScrollHeight.current = scroller.scrollHeight;
    }
  }, [stickToBottom]);
  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  // Focus the chat input whenever this panel becomes the active one or its
  // owning session id changes. Covers two flows the user expects:
  //   1. Switching between sessions in the sidebar — focus follows the
  //      newly visible ChatPanel (the previous one had `isActive=false`).
  //   2. After `/clear` — the handler swaps in a new session id via
  //      `refresh()`, which mounts a NEW ChatPanel for the new session id
  //      (App.tsx keys panels by `chat:${sid}`). The new panel's first
  //      render returns "Loading session…" — the textarea is NOT in the
  //      DOM yet, so `inputRef.current` is null and `.focus()` no-ops.
  //      Depending on `messages` here re-fires the effect once the initial
  //      message fetch lands and the textarea actually exists.
  // Skip on the mobile shell — auto-focusing a textarea on touch devices
  // pops the soft keyboard before the user has decided to type, which is
  // disruptive on the drill-down session list flow.
  const messagesReady = !!messages;
  useEffect(() => {
    if (!isActive) return;
    if (!messagesReady) return;
    const el = inputRef.current;
    if (!el) return;
    if (el.closest(".mobile-body")) return;
    // RAF defers focus to after the active-panel `display:block` flip in
    // App.tsx has committed; focusing a hidden element is a no-op.
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, sessionId, messagesReady]);

  // Re-pin to bottom when this panel becomes active again. GOTCHA: while
  // App.tsx hides an inactive panel with `display:none`, the scroll
  // container has no layout — `scrollHeight` reads 0, so the post-commit
  // layout effect's `el.scrollTop = el.scrollHeight` becomes a no-op write
  // of 0. New messages keep accumulating in the DOM while hidden, and when
  // the user switches back the viewport is parked at the top of the (now-
  // tall) container even though `pinnedToBottom.current` is still true.
  // RAF after the display flip so layout is live and scrollHeight reflects
  // the full transcript. Also resync `prevScrollHeight.current` to the
  // post-stick scrollHeight so the next [messages] layout effect doesn't
  // see a stale (small) prevScrollHeight and misderive that the user
  // scrolled up by `currentScrollHeight - prevScrollHeight`.
  useEffect(() => {
    if (!isActive) return;
    if (!pinnedToBottom.current) return;
    const raf = requestAnimationFrame(() => {
      stickToBottom();
      const el = scrollRef.current;
      if (el) prevScrollHeight.current = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, stickToBottom]);

  // Catch-up refetch on reactivation. While inactive, scheduleRefetch and the
  // delta buffer are suppressed (see the gating refs near refetchTimer) so we
  // don't re-render a transcript the user can't see. When the panel becomes
  // active again, pull the canonical transcript once if any refetch/delta was
  // dropped while hidden — this repaints with everything that streamed in the
  // background. scheduleRefetchRef is set by the SSE effect (same lifecycle);
  // guard for the first render where it may not be wired yet.
  useEffect(() => {
    if (!isActive) return;
    if (!refetchOwedWhileInactive.current) return;
    refetchOwedWhileInactive.current = false;
    scheduleRefetchRef.current?.();
  }, [isActive]);

  const submit = useCallback(async () => {
    // Block submit while any attachment is still uploading — easy to forget
    // a file is mid-transfer when the input is short.
    if (attachments.some((a) => a.status === "uploading")) {
      setSendError("Wait for attachments to finish uploading.");
      return;
    }
    // Non-media chips (csv/code/text/…) ride along as `@<remote-path>`
    // tokens appended to the message text — the AI reads them with its Read
    // tool. This keeps the composer clean (the chip is the only visible
    // affordance) instead of dumping the raw path into the textarea on drop.
    const pathRefAttachments = attachments.filter(
      (a) => a.status === "ready" && !!a.remotePath && a.asPathRef,
    );
    const pathRefText = pathRefAttachments.map((a) => `@${a.remotePath}`).join(" ");
    const typed = input.trim();
    const text = pathRefText ? (typed ? `${typed} ${pathRefText}` : pathRefText) : typed;
    if (!text) return;
    // If the AI is already running, push to the queue instead of aborting.
    // Items are sent automatically one at a time as running flips to false.
    if (running) {
      setMessageQueue((q) => [...q, text]);
      setInput("");
      // The path refs are now baked into the queued text; drop their chips so
      // they aren't appended a second time on the next submit.
      if (pathRefAttachments.length > 0) {
        const ids = new Set(pathRefAttachments.map((a) => a.id));
        setAttachments((prev) => prev.filter((a) => !ids.has(a.id)));
      }
      return;
    }
    setSendError(null);
    setScreenshotToast(null);
    setRunning(true); // optimistic — session.status will confirm
    setInput("");
    // Snap the branch indicator to current truth on every submit. The 5s
    // poll catches terminal-side checkouts eventually, but the user is
    // most likely to notice a wrong branch right when they hit enter.
    window.api
      .opencodeVcsBranch(cwd)
      .then((b) => setBranch(b))
      .catch(() => { /* non-fatal */ });
    // If the pinned todo list is fully terminal (every item completed or
    // cancelled), the user has acknowledged the previous turn's work by
    // starting a new one — hide the stale checklist until opencode writes a
    // fresh list. todo.updated resets this so a follow-up TodoWrite still
    // surfaces normally.
    if (activeTodos && allTodosTerminal(activeTodos)) {
      setTodosDismissed(true);
    }

    // Optimistic transcript append — show the user's message NOW so they
    // see their input land in the conversation while the server is still
    // routing the call. The next message-refetch (triggered by SSE) will
    // overwrite `messages` entirely with the canonical state, so this
    // entry is naturally replaced (no manual dedupe needed). On error we
    // strip it by id in the catch block.
    //
    // Force-pin to bottom BEFORE the setMessages commit so the
    // [messages, liveTodos] layout effect snaps to the freshly-appended
    // turn even if the user had scrolled up to read history. This is the
    // only legitimate force-pin path — the previous design fired on every
    // `running` false→true edge, which incorrectly yanked the viewport on
    // every busy/idle oscillation during multi-step turns.
    //
    // Reset `prevScrollHeight.current = 0` so the layout effect's
    // `wasAtBottomBeforeCommit` short-circuits to true (its first-commit
    // branch). Without this, a user who had scrolled mid-history before
    // submitting a new turn would still NOT auto-scroll to their own
    // optimistic message, because the pre-commit dist would correctly
    // read "above threshold."
    pinnedToBottom.current = true;
    prevScrollHeight.current = 0;
    const optimisticUserId = `optimistic-user-${Date.now()}`;
    setMessages((prev) => [
      ...(prev ?? []),
      {
        info: {
          id: optimisticUserId,
          sessionID: sessionId,
          role: "user",
          time: { created: Date.now() },
        },
        parts: [
          {
            id: `${optimisticUserId}-text`,
            messageID: optimisticUserId,
            type: "text",
            text,
          },
        ],
      },
    ]);

    // Slash-command path. Order:
    //   1. bui-local builtins (/clear, /fork, /compact, /help) — handled
    //      entirely in the renderer; opencode never sees them.
    //   2. opencode commands (from GET /command) — routed to runCommand.
    //   3. Everything else falls through as a normal prompt.
    const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const cmdName = slashMatch ? slashMatch[1] : null;

    if (cmdName && BUI_BUILTIN_NAMES.has(cmdName)) {
      setRunning(false);
      // bui builtins are renderer-only — no prompt actually sent, so strip
      // the optimistic transcript entry we just added.
      setMessages((prev) =>
        prev ? prev.filter((m) => m.info.id !== optimisticUserId) : prev,
      );
      try {
        if (cmdName === "clear") {
          if (!tmuxSession || windowIndex == null) {
            setSendError("Can't /clear — no owning tmux window.");
            return;
          }
          const cleared = await window.api.opencodeClearSession({
            sessionName: tmuxSession,
            windowIndex,
            // Empty string signals the main handler to resolve from the
            // project's stored defaultCwd. Passing "~" or a stale paneCurrentPath
            // would short-circuit that fallback.
            cwd: cwd ?? "",
            title: `${tmuxSession} / cleared`,
          });
          // Carry the current model selection forward to the new session so
          // the user doesn't have to re-pick it after every /clear.
          if (cleared?.newSessionId && modelOverride) {
            writeSavedModel(cleared.newSessionId, modelOverride);
          }
          await refresh();
        } else if (cmdName === "fork") {
          await forkSession();
        } else if (cmdName === "compact") {
          await compactSession();
        } else if (cmdName === "help") {
          setSystemNotice(buildHelpText());
        }
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
      }
      return;
    }

    const knownCommand =
      cmdName && commands ? commands.find((c) => c.name === cmdName) : null;

    // Only media chips become multimodal FileParts; path-ref chips were
    // already folded into `text` above.
    const readyAttachments = attachments
      .filter((a) => a.status === "ready" && a.remotePath && !a.asPathRef)
      .map((a) => ({
        remotePath: a.remotePath!,
        mime: a.mime,
        filename: a.filename,
      }));

    // Refuse to submit if the user has attachments but the active model
    // can't accept them — opencode would error mid-stream with a vague
    // "media type X functionality not supported" message. Block here with
    // a clearer reason instead.
    if (readyAttachments.length > 0) {
      const modes = modelInputModes(activeModel);
      const unsupported = readyAttachments
        .map((a) => ({ filename: a.filename, mime: a.mime, mode: mimeToInputMode(a.mime) }))
        .filter((a) => a.mode === "other" || !modes.includes(a.mode));
      if (unsupported.length > 0) {
        setRunning(false);
        // Strip the optimistic user message — the send is being refused.
        setMessages((prev) =>
          prev ? prev.filter((m) => m.info.id !== optimisticUserId) : prev,
        );
        const detail = unsupported
          .map((u) => `${u.filename} (${u.mime})`)
          .join(", ");
        setSendError(
          `${currentModelName} doesn't accept ${detail}. Accepted: ${
            modes.filter((m) => m !== "text").join(", ") || "none"
          }.`,
        );
        return;
      }
    }

    try {
      if (knownCommand && slashMatch) {
        await window.api.opencodeRunCommand({
          sessionId,
          command: cmdName!,
          arguments: slashMatch[2] ?? "",
          model: modelOverride ?? undefined,
          attachments: readyAttachments,
        });
      } else {
        // Resolve agent mentions to {value, start, end} offsets by re-scanning
        // the submitted text. Unmatched mentions (user deleted the @token)
        // are silently dropped.
        const resolvedMentions: Array<{
          name: string;
          source: { value: string; start: number; end: number };
        }> = [];
        for (const m of agentMentions) {
          const token = `@${m.name}`;
          let pos = 0;
          while (true) {
            const idx = text.indexOf(token, pos);
            if (idx < 0) break;
            const prev = idx > 0 ? text[idx - 1] : "";
            const next = text[idx + token.length] ?? "";
            const wordChar = /[A-Za-z0-9_]/;
            if (!wordChar.test(prev) && !wordChar.test(next)) {
              resolvedMentions.push({
                name: m.name,
                source: { value: token, start: idx, end: idx + token.length },
              });
              break;
            }
            pos = idx + token.length;
          }
        }
        await window.api.opencodePrompt(
          sessionId,
          text,
          modelOverride ?? undefined,
          readyAttachments,
          resolvedMentions.length > 0 ? resolvedMentions : undefined,
        );
      }
      setAttachments([]);
      setAgentMentions([]);
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
      setRunning(false);
      // Strip the optimistic user entry so the transcript doesn't show a
      // message that never reached the server.
      setMessages((prev) =>
        prev ? prev.filter((m) => m.info.id !== optimisticUserId) : prev,
      );
    }
  }, [input, running, sessionId, modelOverride, attachments, agentMentions, commands]);

  // Always-current ref to submit — lets the queued-message effect call the
  // latest version without adding submit to the effect's dependency array
  // (which would re-arm the effect on every keystroke).
  const submitRef = useRef<() => void>(() => {});
  submitRef.current = submit;

  // When the AI goes idle (running flips false) and there are queued
  // messages, dispatch the next one. We restore it into `input` and call
  // submit() via the ref so slash commands, attachments, and model
  // resolution all go through the same code path as a manual submit.
  //
  // Idle is reached one of two ways now: a turn finishing naturally, OR the
  // step-boundary drain-abort (see the session.next.step.ended handler) that
  // interrupts a still-running turn the moment a prompt is queued. Either
  // way the submit path is identical — this effect just waits for !running.
  // Re-arm drainAbortRef here so the NEXT queued item (if any) can again
  // abort the freshly-submitted turn at its next step boundary.
  useEffect(() => {
    if (running || messageQueue.length === 0) return;
    drainAbortRef.current = false;
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    setInput(next);
    setTimeout(() => submitRef.current(), 0);
  }, [running, messageQueue]);

  const abort = useCallback(async () => {
    try {
      await window.api.opencodeAbort(sessionId);
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
  }, [sessionId]);

  const replyPermission = useCallback(
    async (requestId: string, reply: "once" | "always" | "reject") => {
      // Optimistically drop this request so the card disappears immediately;
      // the SSE permission.replied event will reconcile if anything diverges.
      setPermissions((prev) => prev.filter((p) => p.id !== requestId));
      // Clear the sidebar attention dot immediately. We otherwise rely on the
      // SSE permission.replied round-trip to clear it, but that event is
      // occasionally missed (reconnect window, scoped-stream race) which
      // leaves the red `!` stuck forever. Answering the card IS the user
      // resolving the block, so clear locally and let SSE reconcile.
      useStore.getState().setChatAttention(sessionId, null);
      try {
        // Pass `sessionId` so the reply lands on this session's workspace
        // scope — without it the server silently routes to the default
        // workspace and the permission never clears (verified live).
        await window.api.opencodePermissionReply(requestId, reply, sessionId);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        // Re-pull on failure so the card comes back if reply didn't land.
        refreshPermissions();
      }
    },
    [refreshPermissions, sessionId],
  );

  // opencode's reply/reject API is keyed STRICTLY on the `que_…` requestID
  // (validated server-side: `Expected a string starting with "que"`). Our
  // canonical `q.id` is the tool callID (for event/transcript dedup), so we
  // must send `q.requestId` — the `que_` captured from the question.asked
  // event — to the API, while still filtering UI state by `q.id`. A question
  // with no requestId (e.g. transcript-only recovery) is NOT answerable in
  // opencode v1.15 and isn't surfaced (see the mount path).
  const replyQuestion = useCallback(
    async (q: QuestionRequest, answers: string[][]) => {
      const que = q.requestId;
      if (!que) {
        setSendError(
          "This question can't be answered — its reply token was not " +
            "captured (asked before this session was open).",
        );
        return;
      }
      setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      // Clear the sidebar attention dot immediately (see replyPermission) —
      // don't wait on the question.replied SSE round-trip, which can be
      // missed and leave the red `?` stuck.
      useStore.getState().setChatAttention(q.sessionID, null);
      try {
        // Pass sessionID so the main process scopes the reply with
        // ?directory= — opencode's /question endpoints are directory-scoped
        // (like prompt_async); an unscoped reply 200s but never resumes the
        // blocked tool, hanging the agent in "processing".
        await window.api.opencodeQuestionReply(que, answers, q.sessionID);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        refreshQuestions();
      }
    },
    [refreshQuestions],
  );

  const rejectQuestion = useCallback(
    async (q: QuestionRequest) => {
      const que = q.requestId;
      setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      // Clear the sidebar attention dot immediately (see replyPermission).
      useStore.getState().setChatAttention(q.sessionID, null);
      if (!que) return; // nothing to tell the server; just clear the card
      try {
        await window.api.opencodeQuestionReject(que, q.sessionID);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        refreshQuestions();
      }
    },
    [refreshQuestions],
  );



  // Pre-fetch models + default on session mount so the footer shows the
  // actual model (not just "opencode") before the first response, and the
  // dropdown opens populated. Idempotent: skipped when both are already loaded.
  useEffect(() => {
    let cancelled = false;
    if (models == null) {
      window.api
        .opencodeModels()
        .then((list) => { if (!cancelled) setModels(list); })
        .catch(() => { /* non-fatal */ });
    }
    if (defaultModel == null) {
      window.api
        .opencodeDefaultModel()
        .then((d) => { if (!cancelled) setDefaultModel(d); })
        .catch(() => { /* non-fatal */ });
    }
    return () => { cancelled = true; };
  }, [sessionId, models, defaultModel]);

  // Kept for the picker button's onOpen — no-op now that we pre-fetch.
  const ensureModels = useCallback(async () => { /* noop */ }, []);

  // Active model used for the NEXT prompt. modelOverride wins; otherwise the
  // server default. Used to look up capability flags (attachment support).
  const activeModel = useMemo<OpencodeModel | null>(() => {
    if (!models || models.length === 0) return null;
    const target = modelOverride ??
      (defaultModel
        ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
        : null);
    if (!target) return null;
    return (
      models.find(
        (m) => m.providerID === target.providerID && m.id === target.modelID,
      ) ?? null
    );
  }, [models, modelOverride, defaultModel]);
  const currentModelSupportsAttachments = modelSupportsAttachments(activeModel);
  const currentModelName = activeModel?.name ?? "this model";

  // If a saved modelOverride references a model that isn't in the current
  // list of connected models (common after switching providers or fixing
  // listModels' source endpoint), clear it. Otherwise the server rejects the
  // prompt with a not-found error and nothing reaches the transcript.
  useEffect(() => {
    if (!models || !modelOverride) return;
    const found = models.find(
      (m) =>
        m.providerID === modelOverride.providerID && m.id === modelOverride.modelID,
    );
    if (!found) {
      setModelOverride(null);
      writeSavedModel(sessionId, null);
    }
  }, [models, modelOverride, sessionId]);

  const selectModel = useCallback(
    (m: ModelSelection | null) => {
      setModelOverride(m);
      writeSavedModel(sessionId, m);
    },
    [sessionId],
  );

  // Session ops. All three depend on tmuxSession/windowIndex being non-null
  // (the panel hides the buttons otherwise). The store will pick up the new
  // project list automatically via the next refresh / tmuxList call.
  const refresh = useStore((s) => s.refresh);

  const forkSession = useCallback(async () => {
    if (!tmuxSession) return;
    setSendError(null);
    try {
      const baseName = windowIndex != null ? `fork-${windowIndex}` : "fork";
      const windowName = `${baseName}-${Date.now().toString(36).slice(-4)}`;
      await window.api.opencodeForkSession({
        sessionId,
        sessionName: tmuxSession,
        windowName,
        // Empty string signals the main handler to resolve from the project's
        // stored defaultCwd (see resolveProjectCwd in src/main/index.ts).
        cwd: cwd ?? "",
      });
      await refresh();
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
  }, [sessionId, tmuxSession, windowIndex, cwd, refresh]);

  const compactSession = useCallback(async () => {
    setSendError(null);
    try {
      await window.api.opencodeCompactSession(sessionId);
      // session.compacted SSE will trigger a refetch; no manual reload needed.
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
  }, [sessionId]);

  // Session deletion lives in the sidebar (desktop) and the mobile ⋯ sheet —
  // it was removed from the composer status bar to declutter. The IPC
  // (window.api.opencodeDeleteSession) is still wired for those paths.

  // ===== Auto-rename =====
  //
  // When AppConfig.autoRenameSessions is on, derive a short tmux window name
  // from the conversation every Nth completed user turn (AUTO_RENAME_EVERY_N_
  // TURNS) and ALWAYS overwrite the current name. The title is generated by a
  // throwaway opencode session (the user's own model — no Groq key) via the
  // opencodeGenerateTitle IPC; chatUtils helpers build the prompt input and
  // sanitize the reply. This is the SOLE auto-rename path; it works on desktop
  // and mobile because ChatPanel is shared.
  //
  // Cadence/guards:
  //  - Fires only on the running true→false edge (a turn just completed), so
  //    we read a settled transcript, not a mid-stream one.
  //  - `lastAutoRenamedTurnRef` ensures one rename per qualifying turn count
  //    even though the effect re-runs on every `messages`/`running` change.
  //  - `autoRenameInFlightRef` prevents overlapping ~9s generations.
  //  - Refs reset on session change so a fresh session starts counting over.
  const prevRunningForRenameRef = useRef(false);
  const lastAutoRenamedTurnRef = useRef(0);
  const autoRenameInFlightRef = useRef(false);
  // Armed on the turn-completed edge, consumed once the transcript settles.
  // See the two-effect rationale below.
  const pendingRenameRef = useRef(false);

  useEffect(() => {
    // New session → reset the per-session rename bookkeeping.
    lastAutoRenamedTurnRef.current = 0;
    autoRenameInFlightRef.current = false;
    prevRunningForRenameRef.current = false;
    pendingRenameRef.current = false;
  }, [sessionId]);

  // ARM on the running true→false edge. We must NOT evaluate the transcript
  // here: `messages` is updated by a 300ms-debounced refetch (scheduleRefetch),
  // so at the instant `running` flips the transcript is still STALE — it's
  // missing the turn that just completed (or off-by-one on the count). The old
  // single-effect design read `countUserTurns(messages)` right on the edge,
  // saw the wrong count, returned, and then when the refetch landed the edge
  // was already consumed (wasRunning=false) — so the rename never fired. This
  // effect only flips the pending flag; the evaluation runs below once the
  // settled transcript arrives.
  useEffect(() => {
    const wasRunning = prevRunningForRenameRef.current;
    prevRunningForRenameRef.current = running;
    // Arm on the completed edge. Re-running on a new turn (false→true) DIS-arms
    // any rename still pending from the prior turn — its window has closed and
    // the next completed edge will re-arm with the newer transcript.
    if (wasRunning && !running) pendingRenameRef.current = true;
    else if (!wasRunning && running) pendingRenameRef.current = false;
  }, [running]);

  // EVALUATE when a rename is armed AND the transcript is settled. Runs on
  // every `messages` change while not running, so it catches the post-edge
  // refetch that carries the just-completed turn. We do NOT clear the pending
  // flag on a no-match pass: the first pass after the edge sees a STALE
  // transcript (refetch is 300ms-debounced) whose turn count hasn't advanced,
  // so it legitimately won't match the cadence — leaving the flag armed lets
  // the refetch's `messages` update re-trigger this effect with the settled
  // count. The flag is cleared only when we actually fire a rename, or when a
  // new turn starts (the disarm above). `lastAutoRenamedTurnRef` still bounds
  // us to one rename per qualifying turn count.
  useEffect(() => {
    if (running) return;
    if (!pendingRenameRef.current) return;
    if (!autoRenameSessions) return;
    if (!tmuxSession || windowIndex == null) return;
    if (autoRenameInFlightRef.current) return;

    const turns = countUserTurns(messages);
    if (!shouldAutoRename(turns)) return;
    if (turns <= lastAutoRenamedTurnRef.current) return; // already done this turn

    pendingRenameRef.current = false;

    const input = buildTitlePromptInput(messages);
    if (!input) return;

    autoRenameInFlightRef.current = true;
    lastAutoRenamedTurnRef.current = turns;
    void (async () => {
      try {
        const raw = await window.api.opencodeGenerateTitle({
          directory: cwd ?? "",
          instruction: buildTitleInstruction(input),
        });
        const name = sanitizeGeneratedTitle(raw);
        // Empty → generation failed/timed out; skip silently (never blank the
        // window name, and the rename IPC rejects empty names anyway).
        if (!name) return;
        await window.api.tmuxRenameWindow({
          sessionName: tmuxSession,
          windowIndex,
          newName: name,
        });
        await refresh();
      } catch {
        /* auto-rename is best-effort — never surface an error banner */
      } finally {
        autoRenameInFlightRef.current = false;
      }
    })();
  }, [running, messages, autoRenameSessions, tmuxSession, windowIndex, cwd, refresh]);

  // ===== Voice (extracted to useVoice) =====
  const {
    voiceEnabled,
    voiceRecording,
    voiceProcessing,
    voiceRecorder,
    dispatchVoiceAction,
  } = useVoice({
    input,
    setInput,
    inputRef,
    models,
    permissions,
    questions,
    sessionId,
    chatAutoAllow,
    setChatAutoAllow,
    selectModel,
    compactSession,
    forkSession,
    abort,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey: useStore((s) => s.groqApiKey),
  });

  // ===== Drag-drop attachments =====
  //
  // Files dropped anywhere on the panel are scp'd to ~/.bui-uploads/<session>/
  // via the existing uploadFiles bridge. Each file gets a chip above the
  // input. The chip shows "uploading" until the IPC returns, then "ready".
  // Failures keep the chip with an error tooltip so the user can retry.

  const addDroppedFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!tmuxSession) return;
      const list = Array.from(files);
      if (list.length === 0) return;

      // Every dropped file gets a chip card. Split by mime decides HOW it's
      // sent at submit, not WHETHER it shows a chip:
      //   - Image/PDF/audio/video → multimodal FilePart (bytes the model decodes).
      //   - Everything else (csv/code/text/…) → `asPathRef` chip; its remote
      //     path is appended to the outgoing message as `@<path>` at submit so
      //     the AI reads it with its Read tool. The path no longer pollutes the
      //     composer — the chip is the user-visible affordance.
      type Pending = { file: File; lp: string; mime: string; asPathRef: boolean; id: string };
      const pending: Pending[] = [];
      for (const f of list) {
        const lp = window.api.getPathForFile(f);
        if (!lp) continue;
        const mime = f.type || guessMime(f.name);
        const asPathRef = mimeToInputMode(mime) === "other";
        const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        pending.push({ file: f, lp, mime, asPathRef, id });
      }
      if (pending.length === 0) return;

      // Pre-upload chip placeholders for ALL entries.
      const newChips: Attachment[] = pending.map((p) => ({
        id: p.id,
        filename: p.file.name,
        mime: p.mime,
        status: "uploading",
        source: "drop",
        asPathRef: p.asPathRef,
      }));
      setAttachments((prev) => [...prev, ...newChips]);

      // Upload all pending files in one batch (cheaper round-trip).
      const allLocalPaths = pending.map((p) => p.lp);
      let remotePaths: string[] = [];
      try {
        remotePaths = await window.api.uploadFiles({
          projectName: tmuxSession,
          localPaths: allLocalPaths,
        });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const ids = new Set(pending.map((p) => p.id));
        setAttachments((prev) =>
          prev.map((a) => (ids.has(a.id) ? { ...a, status: "error", errorMsg: msg } : a)),
        );
        return;
      }

      // Wire each upload result back to its chip.
      for (let i = 0; i < pending.length; i++) {
        const rp = remotePaths[i];
        const { id } = pending[i];
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? rp
                ? { ...a, status: "ready", remotePath: rp }
                : { ...a, status: "error", errorMsg: "Upload returned no path" }
              : a,
          ),
        );
      }
    },
    [tmuxSession],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ===== Clipboard paste (screenshots) =====
  //
  // When the user pastes into the textarea, check for image/* items in the
  // clipboard. If found, upload them via uploadBuffer (bytes → temp file →
  // scp) and add chips exactly like drag-drop. Text items are left to the
  // browser default (inserted into the textarea as-is).
  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!tmuxSession) return;
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      // Prevent the browser from pasting anything for this event — image data
      // in a textarea would just be lost anyway, but be explicit.
      e.preventDefault();

      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const mime = item.type; // e.g. "image/png"
        const ext = mime.split("/")[1] ?? "png";
        const filename = `screenshot-${Date.now()}.${ext}`;
        const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        setAttachments((prev) => [
          ...prev,
          { id, filename, mime, status: "uploading", source: "paste" } as Attachment,
        ]);

        try {
          const arrayBuffer = await blob.arrayBuffer();
          const remotePath = await window.api.uploadBuffer({
            projectName: tmuxSession,
            filename,
            buffer: arrayBuffer,
          });
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: "ready", remotePath } : a)),
          );
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: "error", errorMsg: msg } : a)),
          );
        }
      }
    },
    [tmuxSession],
  );

  // ===== Screenshot detection =====
  //
  // Subscription lives in App.tsx — single global listener writes into the
  // store's `screenshotToast`. Only the active panel renders the toast and
  // can accept/dismiss it; acting clears the global state for everyone.

  // Accept: upload the screenshot and create a chip.
  const acceptScreenshot = useCallback(async () => {
    const toast = screenshotToast;
    setScreenshotToast(null);
    if (!tmuxSession || !toast) return;

    const mime = "image/png";
    const filename = toast.path
      ? toast.path.split("/").pop() ?? "screenshot.png"
      : `screenshot-${Date.now()}.png`;
    const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    setAttachments((prev) => [
      ...prev,
      { id, filename, mime, status: "uploading", source: "paste" } as Attachment,
    ]);

    try {
      let remotePath: string;
      if (toast.source === "file" && toast.path) {
        // Desktop watcher: we have a local Mac path — use uploadFiles directly.
        const results = await window.api.uploadFiles({
          projectName: tmuxSession,
          localPaths: [toast.path],
        });
        remotePath = results[0] ?? "";
      } else {
        // Clipboard: read bytes from main then uploadBuffer.
        const buf = await window.api.clipboardReadImage();
        if (!buf) throw new Error("Clipboard image vanished");
        remotePath = await window.api.uploadBuffer({
          projectName: tmuxSession,
          filename,
          buffer: buf,
        });
      }
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "ready", remotePath } : a)),
      );
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "error", errorMsg: msg } : a)),
      );
    }
  }, [screenshotToast, tmuxSession]);

  // Agent → laptop file push. In require-confirm mode the toast's "Save" button
  // calls this: pull the remote outbox file to the downloads dir, then flip the
  // toast to the saved state (so the user can Reveal it). In auto-pull mode the
  // file is already down (main did it in the poller) and this isn't called.
  const saveAgentFile = useCallback(async () => {
    const toast = agentFileToast;
    if (!toast || agentFileSaving) return;
    setAgentFileSaving(true);
    try {
      const localPath = await window.api.agentPullFile(toast.remotePath);
      // Desktop returns a real local path → flip the toast to the saved state
      // so the user can Reveal it in Finder. Mobile returns "" (the download
      // was handed to the browser; there's no OS file manager to reveal into)
      // → just dismiss the toast.
      if (localPath) {
        setAgentFileToast({ ...toast, autoPulled: true, localPath });
      } else {
        setAgentFileToast(null);
      }
    } catch (err) {
      setSendError(`Couldn't save file: ${String((err as Error)?.message ?? err)}`);
      setAgentFileToast(null);
    } finally {
      setAgentFileSaving(false);
    }
  }, [agentFileToast, agentFileSaving, setAgentFileToast]);

  const revealAgentFile = useCallback(() => {
    const local = agentFileToast?.localPath;
    if (local) void window.api.revealInFolder(local);
    setAgentFileToast(null);
  }, [agentFileToast, setAgentFileToast]);

  // Panel-level drag handlers. We listen on the chat container; the body of
  // the panel paints a dotted overlay while dragHover is true. App.tsx
  // already suppresses default drag/drop on the window so the renderer
  // doesn't navigate to file:// — we only handle the panel-local case.
  const onPanelDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    setDragHover(true);
  }, []);
  const onPanelDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onPanelDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the panel itself, not crossing into a child.
    if (e.currentTarget === e.target) setDragHover(false);
  }, []);
  const onPanelDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      setDragHover(false);
      if (e.dataTransfer.files.length > 0) {
        void addDroppedFiles(e.dataTransfer.files);
      }
    },
    [addDroppedFiles],
  );

  // ===== Typeahead (extracted to useTypeahead) =====
  const {
    typeahead,
    setTypeahead: setTypeaheadFromHook,
    typeaheadRows,
    onTypeaheadSelect,
    onTypeaheadHover,
    onTypeaheadConfirm,
    onTypeaheadMove,
    onTypeaheadCancel,
    typeaheadOpen,
    typeaheadExactMatch,
    updateInput,
    onHistoryUp,
    onHistoryDown,
  } = useTypeahead({
    input,
    setInput,
    inputRef,
    cwd,
    currentModelSupportsAttachments,
    currentModelName,
    agentMentions,
    setAgentMentions,
  });

  // Prompt-history navigation (Up/Down) + the typing path that exits history
  // mode. Self-contained hook; see useInputHistory. The hook also returns
  // `promptHistory`, but ChatPanel doesn't consume it.
  const { navigateHistory, updateInputWithHistoryReset } = useInputHistory({
    messages,
    inputRef,
    setInput,
    setTypeahead: setTypeaheadFromHook,
    updateInput,
  });

  // Model line: last assistant message's modelID (provider/model).
  const modelLabel = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info.role === "assistant" && info.modelID) {
        return info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
      }
    }
    return null;
  }, [messages]);

  // Latest assistant message's token usage — drives the running indicator's
  // `↑ N tokens · X% ctx` readout. Updates live as message parts stream in
  // (the refetch on message.part.updated reads fresh tokens from opencode).
  // session.next.step.ended (item 2) feeds stepTokens on every step boundary
  // and we prefer it here so the footer reflects the latest snapshot without
  // waiting for a re-fetch cycle.
  //
  // **GOTCHA — fall through "empty" tokens.** A freshly-streaming assistant
  // message has `tokens` either absent or all-zeros until the first step
  // boundary lands. The naive "first assistant from the tail" loop returned
  // that empty object, which made `ctxTokens === 0` and hid the ContextBar
  // for the entire streaming turn — the bar only re-appeared after the
  // step.ended event arrived (sometimes minutes later, after a long tool
  // call). Skip empty entries and keep walking back to the PRIOR turn's
  // tokens so the bar shows the last known good value during streaming.
  const latestTokens = useMemo<TokenUsage | null>(() => {
    if (stepTokens) {
      return {
        input: stepTokens.input,
        output: stepTokens.output,
        reasoning: stepTokens.reasoning,
        cache: stepTokens.cache,
      };
    }
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info.role !== "assistant") continue;
      // OpencodeMessageInfo type doesn't surface `tokens` directly — read
      // it off the underlying record. Shape matches AssistantMessage.tokens
      // from the OpenAPI doc.
      const t = (info as unknown as { tokens?: TokenUsage }).tokens;
      if (!t) continue;
      const totalInput =
        (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      if (totalInput <= 0) continue;
      return t;
    }
    return null;
  }, [messages, stepTokens]);

  // ===== Stale prompt-cache detection =====
  //
  // Drives the "/clear to save Nk tokens" pill in the footer. When the
  // session has been idle long enough that Anthropic's prompt cache has
  // expired (TTL = 5m default OR 1h opt-in, set in Settings to match
  // opencode's cache_control.ttl), the next user turn will re-bill the
  // entire cached prefix as cache_creation_input_tokens. For deep
  // sessions that's often 100k+ tokens of avoidable spend; suggest /clear
  // when the cached prefix is non-trivial AND the cache has expired.
  //
  // Three inputs to the predicate:
  //   - lastCompleted: timestamp of the last fully-finished assistant
  //     turn (cache TTL clock starts at the request that wrote it, but
  //     time.completed is the closest proxy in the data we have)
  //   - cachedTokens: cache.read + cache.write from the most recent step
  //     (= every token currently in this session's cache entry)
  //   - now: stale cache is time-driven, so we need to re-evaluate over
  //     time without remounting. Tick at 10s — staleness is a 5-min /
  //     1-hr scale so sub-10s precision is irrelevant.
  //
  // The tick ONLY runs while a turn isn't actively in flight; running
  // turns can't go stale by definition.
  const lastAssistantCompletion = useMemo(
    () => selectLastAssistantCompletion(messages),
    [messages],
  );
  // Cached prefix size = read + write from the last step. On a warm
  // session most of the prefix is `cache.read`; on the first turn after
  // /compact (or the first turn ever) it'll be mostly `cache.write`.
  // Either way, this is what flips from "free" to "paid" when the TTL
  // expires.
  const cachedTokens = latestTokens
    ? (latestTokens.cache?.read ?? 0) + (latestTokens.cache?.write ?? 0)
    : 0;
  const ttlMs = selectCacheTtlMs(cacheTtl);
  // Tick state — re-render every 10s when we have a completed turn and
  // we're not running. The interval is deliberately scope-gated to avoid
  // burning a wakeup every 10s on idle apps with no completed turns.
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    if (running) return;
    if (lastAssistantCompletion == null) return;
    if (cachedTokens < STALE_CACHE_MIN_TOKENS) return;
    const id = setInterval(() => setStaleTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [running, lastAssistantCompletion, cachedTokens]);
  const staleCache = useMemo<StaleCacheResult>(
    () =>
      computeStaleCache({
        lastCompleted: lastAssistantCompletion,
        now: Date.now(),
        ttlMs,
        cachedTokens,
        running,
      }),
    // staleTick is intentionally in the deps so the memo recomputes on
    // each tick even when other inputs haven't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastAssistantCompletion, ttlMs, cachedTokens, running, staleTick],
  );

  // Most recent TodoWrite call from anywhere in the session — pinned under
  // either the running indicator (while a turn is live) or the final turn's
  // duration footer (when idle). Walks back through ALL messages, not just
  // the current turn, so the list persists across turns that don't update it.
  // Item 4: liveTodos (from todo.updated SSE) wins when set so the card
  // reflects in-flight ticks without waiting for the message re-fetch.
  // When todosDismissed is set (user submitted with all items terminal),
  // suppress the card until opencode writes a fresh list — see the send
  // handler and the todo.updated branch in onOpencodeEvent.
  const activeTodos = useMemo<Array<Record<string, unknown>> | null>(() => {
    // Transcript fallback: most recent non-empty TodoWrite input. Only used
    // when no live todo.updated has been seen (liveTodos == null). The
    // live-vs-transcript-vs-dismissed precedence — including the critical
    // "empty live list = explicitly cleared, hide the card" rule — lives in
    // the pure, tested selectActiveTodos (chatUtils.ts).
    let transcriptTodos: Array<Record<string, unknown>> | null = null;
    if (messages) {
      outer: for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        for (let j = m.parts.length - 1; j >= 0; j--) {
          const p = m.parts[j];
          if (p.type === "tool" && (p as Record<string, unknown>).tool === "todowrite") {
            const state = (p as Record<string, unknown>).state as
              | { input?: { todos?: Array<Record<string, unknown>> } }
              | undefined;
            const todos = state?.input?.todos;
            if (Array.isArray(todos) && todos.length > 0) {
              transcriptTodos = todos;
              break outer;
            }
          }
        }
      }
    }
    return selectActiveTodos(
      liveTodos as Array<Record<string, unknown>> | null,
      transcriptTodos,
      todosDismissed,
    );
  }, [messages, liveTodos, todosDismissed]);

  // Turn boundary metadata: which assistant messages are the FINAL one of
  // their turn (i.e., immediately followed by a user message or end-of-list),
  // and the cumulative duration of that turn (first assistant `created` →
  // last assistant `completed`). Intermediate assistant messages within a
  // multi-step turn don't get a duration footer — only the final one does.
  const turnInfo = useMemo(() => {
    const out = new Map<string, { turnDurationMs: number | null }>();
    if (!messages) return out;
    let i = 0;
    while (i < messages.length) {
      if (messages[i].info.role === "user") {
        // Walk forward over the run of assistant messages that follow.
        let j = i + 1;
        let firstStart: number | null = null;
        let lastEnd: number | null = null;
        let lastAssistantId: string | null = null;
        while (j < messages.length && messages[j].info.role === "assistant") {
          const t = messages[j].info.time;
          if (firstStart == null && t?.created != null) firstStart = t.created;
          if (t?.completed != null) lastEnd = t.completed;
          lastAssistantId = messages[j].info.id;
          j++;
        }
        if (lastAssistantId) {
          out.set(lastAssistantId, {
            turnDurationMs:
              firstStart != null && lastEnd != null && lastEnd > firstStart
                ? lastEnd - firstStart
                : null,
          });
        }
        i = j;
      } else {
        i++;
      }
    }
    return out;
  }, [messages]);

  // Slash-command provenance per USER message id. Two-source resolution:
  //
  //   (1) Live: opencode emits `command.executed.messageID` pointing at the
  //       ASSISTANT message the command kicked off. The expanded user
  //       message sits at messages[idx], the assistant at messages[idx+1].
  //       So a user message is command-origin when the NEXT message's id
  //       is in `commandByMessageId`.
  //   (2) Historical: live events only fire for commands invoked during
  //       this panel's lifetime. For older transcripts, detect by matching
  //       the user-message text against the static prefix of every known
  //       command template (`detectCommandFromText`). When the live map
  //       doesn't have it, fall back to this.
  //
  // This memo MUST live at panel scope (NOT inside messages.map), because
  // the map runs on every keystroke (the InputArea's `input` state lives
  // in ChatPanel and forces a re-render). The map callback used to
  // recompute `userText` and call `detectCommandFromText` for every user
  // message every render — O(user_messages × commands) per keystroke and
  // a fresh `{name, arguments}` object that defeated React.memo on
  // MessageRow. The memo's key is the user-message id; lookup inside the
  // map is O(1) and the returned object is stable across renders.
  const userCommandInfo = useMemo<
    Map<string, { name: string; arguments: string }>
  >(() => {
    const out = new Map<string, { name: string; arguments: string }>();
    if (!messages) return out;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.info.role !== "user") continue;
      // (1) Live map first — most authoritative, has the run-time
      // `arguments` string the historical-prefix match can't recover.
      const nextMsg = messages[i + 1];
      if (nextMsg && nextMsg.info.role === "assistant") {
        const live = commandByMessageId.get(nextMsg.info.id);
        if (live) {
          out.set(m.info.id, live);
          continue;
        }
      }
      // (2) Historical fallback.
      if (commands && commands.length > 0) {
        const userText = m.parts
          .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => p.text ?? "")
          .join("\n");
        const detected = detectCommandFromText(userText, commands);
        if (detected) out.set(m.info.id, { name: detected, arguments: "" });
      }
    }
    return out;
  }, [messages, commandByMessageId, commands]);

  // Memoized TaskContext value. Identity-stable across keystroke renders
  // (input/typeahead state churn): only changes when one of the underlying
  // subagent maps or showThinking flips. Without the memo, the Provider
  // would re-render every TaskBody on every keystroke and the user would
  // see the expand state visually flash through React's reconciliation.
  const taskContextValue = useMemo<TaskContextValue>(
    () => ({
      expanded: expandedTasks,
      toggle: toggleTaskExpand,
      childMessages,
      childFetchState,
      liveStatus: liveChildStatus,
      showThinking,
    }),
    [
      expandedTasks,
      toggleTaskExpand,
      childMessages,
      childFetchState,
      liveChildStatus,
      showThinking,
    ],
  );

  // Push the running-subagent count into the global store so the sidebar's
  // `·N` indicator (Sidebar.tsx's StatusIndicator) lights up for chat-mode
  // windows. The TUI poller can't see chat-mode subagents (holder pane runs
  // `sleep infinity`), so this is the sole update path for chat-mode `·N`.
  // Pure derivation from the same data TaskBody consumes; the store no-ops
  // when the count is unchanged so this doesn't churn other subscribers.
  const runningSubagents = useMemo(
    () => countRunningSubagents(messages, liveChildStatus),
    [messages, liveChildStatus],
  );
  useEffect(() => {
    setChatSubagents(sessionId, runningSubagents);
  }, [sessionId, runningSubagents, setChatSubagents]);
  // Reset to zero on unmount / session change so a stale count from the
  // previous session doesn't linger on the sidebar dot.
  useEffect(() => {
    return () => setChatSubagents(sessionId, 0);
  }, [sessionId, setChatSubagents]);

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg text-text-muted p-6 font-mono">
        <div className="max-w-md text-sm">
          <div className="font-semibold text-text mb-2">Couldn't load session</div>
          <pre className="whitespace-pre-wrap break-words text-xs text-text-faint">{error}</pre>
        </div>
      </div>
    );
  }

  if (!messages) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg text-text-faint text-sm font-mono">
        Loading session…
      </div>
    );
  }

  return (
    <div
      className="h-full w-full flex flex-col bg-bg font-mono font-medium text-[13px] leading-[1.5] relative"
      onDragEnter={onPanelDragEnter}
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={onPanelDrop}
    >
      {/* Header dropped — bui's outer chrome already shows project/window. */}

      {/* Drop overlay: dotted border + tinted bg only while files are over */}
      {/* the panel. pointer-events-none so the inner DOM still receives the */}
      {/* drop event (overlay shouldn't intercept it). */}
      {dragHover && (
        <div
          className="absolute inset-2 z-30 pointer-events-none rounded-lg border-2 border-dashed flex items-center justify-center"
          style={{
            borderColor: CLAUDE_ORANGE,
            backgroundColor: CLAUDE_ORANGE + "11",
          }}
        >
          <span className="text-sm text-text" style={{ color: CLAUDE_ORANGE }}>
            Drop to attach
          </span>
        </div>
      )}

      <Transcript
        messages={messages}
        scrollRef={scrollRef}
        questionCardRef={questionCardRef}
        taskContextValue={taskContextValue}
        showThinking={showThinking}
        running={running}
        activeTodos={activeTodos}
        questions={questions}
        turnInfo={turnInfo}
        finishByMessageId={finishByMessageId}
        userCommandInfo={userCommandInfo}
        onReplyQuestion={replyQuestion}
        onRejectQuestion={rejectQuestion}
      />

      {/* Pending permission cards. Shown above the running indicator/input */}
      {/* so they're hard to miss — tool execution pauses until reply. */}
      {permissions.length > 0 && (
        <div className="shrink-0 px-4 pt-2 space-y-2">
          {permissions.map((p) => (
            <PermissionCard
              key={p.id}
              perm={p}
              onReply={(reply) => replyPermission(p.id, reply)}
            />
          ))}
        </div>
      )}

      {/* Retry status — surfaces session.status "retry" so the user can */}
      {/* see WHY the spinner is still spinning (rate limit, transient API */}
      {/* failure, etc) instead of assuming the AI is stalled. */}
      {retryInfo && (
        <div className="shrink-0 px-4 pt-2">
          <RetryCard info={retryInfo} />
        </div>
      )}

      {/* Live compaction progress. Streams the summary as it's produced and */}
      {/* flips to a brief "Compacted" confirmation after .ended; clears on */}
      {/* a timer (session.compacted refetch has already landed by then). */}
      {compactionState && (
        <div className="shrink-0 px-4 pt-2">
          <CompactionCard state={compactionState} />
        </div>
      )}

      {/* Scheduled-tasks management card. Toggled by the ⏰ toolbar button */}
      {/* (desktop) or the ⋯ sheet (mobile). Refetch-driven while open. */}
      {/* pb-2 gives the card breathing room above the composer border so it */}
      {/* doesn't sit flush against the chat divider. */}
      {showSchedules && (
        <div className="shrink-0 px-4 pt-2 pb-2">
          <ScheduledTasksCard
            jobs={schedules}
            error={scheduleError}
            onClose={() => setShowSchedules(false)}
            onDelete={(id) => {
              setSchedules((prev) => prev.filter((j) => j.id !== id));
              window.api
                .scheduleDelete(id)
                .then(() => refreshSchedules())
                .catch((e: unknown) => {
                  setScheduleError(
                    e instanceof Error ? e.message : "delete failed",
                  );
                  void refreshSchedules();
                });
            }}
          />
        </div>
      )}

      {/* Secrets management card. Toggled by the 🔑 toolbar button (desktop) or */}
      {/* the ⋯ sheet (mobile). The value never appears here — list is metadata */}
      {/* only; agents read secrets via the secret_* opencode tools. */}
      {showSecrets && (
        <div className="shrink-0 px-4 pt-2 pb-2">
          <SecretsCard
            secrets={secrets}
            error={secretError}
            sessionId={sessionId}
            onClose={() => setShowSecrets(false)}
            onSave={(input) => {
              return window.api
                .secretsSet(input)
                .then((r) => {
                  if (r && r.ok === false) {
                    setSecretError(r.error || "save failed");
                    return false;
                  }
                  void refreshSecrets();
                  setSecretError(null);
                  return true;
                })
                .catch((e: unknown) => {
                  setSecretError(e instanceof Error ? e.message : "save failed");
                  return false;
                });
            }}
            onDelete={(id) => {
              setSecrets((prev) => prev.filter((s) => s.id !== id));
              window.api
                .secretsDelete(id)
                .then(() => refreshSecrets())
                .catch((e: unknown) => {
                  setSecretError(e instanceof Error ? e.message : "delete failed");
                  void refreshSecrets();
                });
            }}
          />
        </div>
      )}

      {/* Inbound-webhook management card. Toggled by the 🪝 toolbar button */}
      {/* (desktop) or the ⋯ sheet (mobile). List is metadata only (no signing */}
      {/* secret); creation is the AI's job via the `webhook` opencode tool. */}
      {showWebhooks && (
        <div className="shrink-0 px-4 pt-2 pb-2">
          <WebhooksCard
            hooks={webhooks}
            error={webhookError}
            onClose={() => setShowWebhooks(false)}
            onDelete={(id) => {
              setWebhooks((prev) => prev.filter((h) => h.id !== id));
              window.api
                .webhookDelete(id)
                .then(() => refreshWebhooks())
                .catch((e: unknown) => {
                  setWebhookError(e instanceof Error ? e.message : "delete failed");
                  void refreshWebhooks();
                });
            }}
          />
        </div>
      )}

      {running && (
        <>
          <RunningIndicator tokens={latestTokens} atBottom={pinnedToBottom.current} />
          {/* activeTodos used to render here, sticky above the input. Moved */}
          {/* into the scroll container above (tail of the transcript) so */}
          {/* long checklists scroll like normal chat content. */}
          {messageQueue.length > 0 && (
            <div className="shrink-0 px-4 pb-2 flex flex-col gap-0.5">
              {messageQueue.map((msg, i) => (
                <div key={i} className="text-[13px] text-text-faint font-mono flex items-baseline gap-1">
                  <span className="select-none shrink-0">⏎ </span>
                  <span className="italic flex-1 truncate">{msg}</span>
                  <button
                    onClick={() => setMessageQueue((q) => q.filter((_, j) => j !== i))}
                    className="ml-1 text-text-faint hover:text-text leading-none shrink-0"
                    title="Remove from queue"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Send error banner — surfaced from both client-side capability */}
      {/* checks and server-side session.error events. Dismissable. */}
      {sendError && (
        <div className="shrink-0 mx-4 mb-1 px-2 py-1 text-[12px] text-red-300 bg-red-900/20 border border-red-500/30 rounded break-words flex items-start gap-2">
          <span className="flex-1">⚠ {sendError}</span>
          <button
            onClick={() => setSendError(null)}
            className="text-red-300 hover:text-red-200 leading-none px-1"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Screenshot detection toast. Appears when main detects a new clipboard */}
      {/* image or a new Screenshot file on the Desktop. Only the active panel */}
      {/* renders it — it lives in global store state, one instance app-wide. */}
      {isActive && screenshotToast && (
        <div className="shrink-0 mx-4 mb-1 rounded border border-border bg-bg-elev px-3 py-2 text-[12px] text-text-muted flex items-center gap-2">
          <span className="flex-1 truncate">
            {screenshotToast.source === "file" && screenshotToast.path
              ? `Screenshot: ${screenshotToast.path.split("/").pop()}`
              : "Screenshot in clipboard"}
          </span>
          <button
            onClick={() => void acceptScreenshot()}
            className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 font-medium"
          >
            Add to chat
          </button>
          <button
            onClick={() => setScreenshotToast(null)}
            className="shrink-0 text-text-faint hover:text-text leading-none"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Agent → laptop file toast. The remote AI dropped a file in its outbox. */}
      {/* In auto-pull (trust) mode it's already saved (autoPulled) → "Reveal"; */}
      {/* otherwise it's a Save/dismiss prompt. Single global instance, active */}
      {/* panel only — mirrors the screenshot toast above. */}
      {isActive && agentFileToast && (
        <div className="shrink-0 mx-4 mb-1 rounded border border-border bg-bg-elev px-3 py-2 text-[12px] text-text-muted flex items-center gap-2">
          <span className="flex-1 truncate">
            <span className="text-text">↓ {agentFileToast.name}</span>
            {formatBytes(agentFileToast.size) && (
              <span className="text-text-faint"> · {formatBytes(agentFileToast.size)}</span>
            )}
            <span className="text-text-faint">
              {agentFileToast.autoPulled ? " · saved to Downloads" : " — AI sent you a file"}
            </span>
          </span>
          {agentFileToast.autoPulled ? (
            agentFileToast.localPath && (
              <button
                onClick={revealAgentFile}
                className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 font-medium"
              >
                Reveal
              </button>
            )
          ) : (
            <button
              onClick={() => void saveAgentFile()}
              disabled={agentFileSaving}
              className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 font-medium disabled:opacity-50"
            >
              {agentFileSaving ? "Saving…" : "Save"}
            </button>
          )}
          <button
            onClick={() => setAgentFileToast(null)}
            className="shrink-0 text-text-faint hover:text-text leading-none"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Ephemeral system notice (e.g. /help output). Dismissed by clicking ×. */}
      {systemNotice && (
        <div className="shrink-0 mx-4 mb-1 rounded border border-border bg-bg-elev px-3 py-2 text-[12px] text-text-muted flex items-start gap-2">
          <pre className="flex-1 whitespace-pre-wrap font-mono">{systemNotice}</pre>
          <button
            onClick={() => setSystemNotice(null)}
            className="text-text-faint hover:text-text leading-none"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <Composer
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        typeahead={typeahead}
        typeaheadRows={typeaheadRows}
        onTypeaheadSelect={applyTypeahead}
        onTypeaheadHover={(idx) =>
          setTypeahead((prev) => (prev ? { ...prev, selectedIdx: idx } : prev))
        }
        input={input}
        setInput={updateInputWithHistoryReset}
        inputRef={inputRef}
        submit={submit}
        abort={abort}
        running={running}
        branch={branch}
        refreshing={refreshing}
        modelLabel={modelLabel}
        chatAutoAllow={chatAutoAllow}
        setChatAutoAllow={setChatAutoAllow}
        voiceEnabled={voiceEnabled}
        voicePhase={voiceRecorder.phase}
        voiceMode={voiceRecorder.mode}
        voiceRecording={voiceRecording}
        voiceProcessing={voiceProcessing}
        startVoice={voiceRecorder.start}
        stopVoice={voiceRecorder.stop}
        cancelVoice={voiceRecorder.cancel}
        tokens={latestTokens}
        staleCache={staleCache}
        models={models}
        modelOverride={modelOverride}
        defaultModel={defaultModel}
        activeModel={activeModel}
        onOpenModels={ensureModels}
        onSelectModel={selectModel}
        scheduleCount={schedules.length}
        onSchedules={() => setShowSchedules((v) => !v)}
        onSecrets={() => setShowSecrets((v) => !v)}
        onWebhooks={() => setShowWebhooks((v) => !v)}
        typeaheadOpen={typeahead != null && typeaheadRows.length > 0}
        typeaheadExactMatch={(() => {
          if (!typeahead || typeaheadRows.length === 0) return false;
          const idx = Math.min(typeahead.selectedIdx, typeaheadRows.length - 1);
          const row = typeaheadRows[idx];
          // Compare against the trimmed input, ignoring trailing spaces the
          // user may have typed while staring at the popup.
          return input.trim() === row.primary;
        })()}
        onTypeaheadConfirm={() => {
          if (typeahead && typeaheadRows.length > 0) {
            const idx = Math.min(typeahead.selectedIdx, typeaheadRows.length - 1);
            applyTypeahead(typeaheadRows[idx]);
          }
        }}
        onTypeaheadMove={moveTypeaheadSelection}
        onTypeaheadCancel={() => setTypeahead(null)}
        onHistoryUp={() => navigateHistory(-1)}
        onHistoryDown={() => navigateHistory(1)}
        onQueuePop={() => {
          setMessageQueue((q) => {
            if (q.length === 0) return q;
            const last = q[q.length - 1];
            setInput(last);
            requestAnimationFrame(() => {
              const el = inputRef.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(last.length, last.length);
            });
            return q.slice(0, -1);
          });
        }}
        onPaste={onPaste}
      />
    </div>
  );
}
