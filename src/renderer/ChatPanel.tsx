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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OpencodeModel,
  QuestionRequest,
} from "../shared/types";
import { useStore } from "./store";
import {
  allTodosTerminal,
  selectActiveTodos,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  computeStaleCache,
  STALE_CACHE_MIN_TOKENS,
  countRunningSubagents,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  sanitizeGeneratedTitle,
  hydrateQuestion,
  classifyScrollForPin,
  detectCommandFromText,
  formatBytes,
  credentialRefreshBannerText,
  lastUserMessageText,
  type StaleCacheResult,
} from "./chatUtils";
import {
  CLAUDE_ORANGE,
  appendPromptHistory,
  guessMime,
  mimeToInputMode,
  modelInputModes,
  modelSupportsAttachments,
  readSavedModel,
  writeSavedModel,
  type AgentMention,
  type Attachment,
  type ModelSelection,
  type TaskContextValue,
  type TokenUsage,
} from "./chatShared";
import { RunningIndicator } from "./MessageRow";
import { CompactionCard, CredRefreshCard, PermissionCard, RetryCard } from "./Cards";
import { ScheduledTasksCard, SecretsCard, WebhooksCard } from "./PanelCards";
import { useSessionResources } from "./hooks/useSessionResources";
import { useInputHistory } from "./hooks/useInputHistory";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useSseBus } from "./hooks/useSseBus";
import { useVoice } from "./hooks/useVoice";
import { useTypeahead } from "./hooks/useTypeahead";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { getMantaPreload } from "./preloadAccess";

// Attachment / AgentMention / TypeaheadState / TypeaheadRow are shared with
// the extracted composer components and live in ./chatShared.

// manta-local slash commands. These are handled in the renderer (not forwarded
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
const MANTA_BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "clear", description: "Start a fresh chat in this window" },
  { name: "fork", description: "Copy this session's history into a new window" },
  { name: "compact", description: "Summarize to free context" },
  { name: "help", description: "Show available commands" },
];
const MANTA_BUILTIN_NAMES = new Set(MANTA_BUILTIN_COMMANDS.map((c) => c.name));

function buildHelpText(): string {
  const lines = [
    "Slash commands (manta-local):",
    ...MANTA_BUILTIN_COMMANDS.map((c) => `  /${c.name.padEnd(8)} — ${c.description}`),
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
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  // User-configured Anthropic prompt cache TTL — drives the "/clear to
  // save Nk tokens" pill when the session has been idle past this TTL.
  // manta doesn't set the real cache_control.ttl on requests; this is the
  // user's claim about what opencode is sending. See AppConfig comment.
  const cacheTtl = useStore((s) => s.cacheTtl);
  // Server-owned resource cards (⏰ schedules, 🔑 secrets, 🪝 webhooks) —
  // state, refresh callbacks, poll effects, session resets, and the mobile
  // `manta-open-*` window-event bridges. Extracted to a self-contained hook
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
  const setChatSubagents = useStore((s) => s.setChatSubagents);
  // Prompt-history navigation (Up/Down cycles past prompts, terminal-style) is
  // owned by useInputHistory — see the hook call after `updateInput` below.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Per-child debounce timers for refetching child transcripts when their
  // expanded card is receiving SSE traffic. Keyed by childSessionId. 300ms
  // matches the parent's scheduleRefetch debounce so behavior is uniform.
  const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Forward declaration: submitRef is defined later (depends on submit), but
  // useSseBus needs it now for the drain effect.
  const submitRef = useRef<() => void>(() => {});
  // Input state must be declared before useSseBus (which needs setInput).
  const [input, setInput] = useState("");
  // Bumped after each submit so useInputHistory re-reads localStorage and the
  // freshly-persisted prompt becomes immediately cyclable (BET-257). The hook
  // can't watch localStorage on its own — we drive the re-read from here.
  const [historyEpoch, setHistoryEpoch] = useState(0);

  // ===== Claude credential auto-refresh (BET-139) =====
  //
  // Driven by a ProviderAuthError session.error, routed here from useSseBus
  // via the onProviderAuthError callback. `credRefresh` is a per-session
  // live-event state, same convention as retryInfo/compactionState.
  const [credRefresh, setCredRefresh] = useState<null | "refreshing" | "ok" | "error">(null);
  // Indirection mirrors submitRef: the SSE effect inside useSseBus only
  // depends on [sessionId], so a plain closure passed as a prop would be
  // captured once (at mount / session change) and go stale against the
  // freshest `messages`. Routing the call through a ref that's reassigned
  // every render keeps it fresh without re-arming the SSE subscription.
  const onProviderAuthErrorRef = useRef<() => void>(() => {});

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
    expandedTasksRef,
    childMessagesRef,
    isActiveRef,
    refetchOwedWhileInactive,
    prevScrollHeight,
    questionCardRef,
    wantQuestionScroll,
    flushPendingDeltas,
    scheduleFlush,
    scheduleRefetch,
    spliceMessage,
    toggleTaskExpand,
    pendingDeltas,
    oldestPendingAt,
    FLUSH_MAX_AGE_MS,
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
    todosDismissed,
    setTodosDismissed,
    liveTodos,
    branch,
    refreshBranch,
    liveChildStatus,
    commandByMessageId,
    finishByMessageId,
    retryInfo,
    compactionState,
    rejectAllPendingQuestions,
  } = useSseBus({
    sessionId,
    cwd,
    setMessages,
    setRefreshing,
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
    submitRef,
    setInput,
    // Indirection to dodge the circular dep: this callback needs setSendError
    // (returned BY useSseBus) and the freshest `messages` (from
    // useTranscriptState). onProviderAuthErrorRef.current is assigned below,
    // after both are in scope — see the comment there.
    onProviderAuthError: () => onProviderAuthErrorRef.current(),
  });

  // Actual ProviderAuthError handler: refresh credentials server-side, then
  // either auto-resend the failed turn (success) or surface an actionable
  // banner (failure). Kept as a plain function (not useCallback) reassigned
  // to the ref every render — see onProviderAuthErrorRef's declaration for
  // why the indirection is needed.
  onProviderAuthErrorRef.current = () => {
    void (async () => {
      setCredRefresh("refreshing");
      const res = await window.api.opencodeRefreshCredentials();
      if (res.ok) {
        setCredRefresh("ok");
        const lastText = lastUserMessageText(messages);
        if (lastText) {
          setInput(lastText);
          setTimeout(() => {
            submitRef.current?.();
          }, 0);
        }
        setTimeout(() => setCredRefresh(null), 2500);
      } else {
        setCredRefresh("error");
        setSendError(credentialRefreshBannerText(res.reason));
        setCredRefresh(null);
      }
    })();
  };

  // ===== ChatPanel-own state (not extracted to hooks) =====
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
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
  // Agent @-mentions state — populated by useTypeahead, consumed by submit.
  const [agentMentions, setAgentMentions] = useState<AgentMention[]>([]);
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
  const [childFetchState] = useState<
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
  // Compaction clear timer is owned by useSseBus.

  // Initial load + reload whenever sessionId changes.
  // Most state resets are now handled by the extracted hooks (useTranscriptState
  // resets messages/scroll/delta-buffer, useSseBus resets permissions/questions/
  // stepTokens/etc. via its SSE effect cleanup). We only need to reset the
  // ChatPanel-own state here: error, modelOverride, attachments, agentMentions,
  // systemNotice, dragHover, credRefresh. The SSE stream open/close is also
  // handled by useSseBus's effect now.
  useEffect(() => {
    setError(null);
    setModelOverride(readSavedModel(sessionId) ?? configDefaultModel ?? null);
    setAttachments([]);
    setAgentMentions([]);
    setSystemNotice(null);
    setDragHover(false);
    setCredRefresh(null);
    // Branch indicator: poll every 5s while this session is mounted.
    refreshBranch(cwd);
    const branchPoll = setInterval(() => refreshBranch(cwd), 5000);
    return () => {
      clearInterval(branchPoll);
    };
  }, [sessionId, cwd, refreshBranch]);

  // Refresh permissions list. Called on any permission event.
  const refreshPermissions = useCallback(() => {
    window.api
      .opencodePermissions(sessionId)
      .then((all) =>
        setPermissions(all.filter((p) => p.sessionID === sessionId)),
      )
      .catch(() => { /* keep last-known */ });
  }, [sessionId]);

  // Refresh question list. Called on any question event.
  // `hydrateQuestion` normalizes the server's QuestionRequest shape — in
  // particular, it copies the server's `id` (the `que_…`) into our `requestId`
  // field, which is required for the reply handler.
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
    type ScrollWin = Window & { __mantaScrollQuestionSession?: string | null };
    const w = window as ScrollWin;
    if (w.__mantaScrollQuestionSession && w.__mantaScrollQuestionSession === sessionId) {
      wantQuestionScroll.current = true;
      w.__mantaScrollQuestionSession = null;
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
    window.addEventListener("manta-scroll-to-question", onEvt);
    return () => window.removeEventListener("manta-scroll-to-question", onEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // (manta-open-schedules / -secrets / -webhooks mobile bridges moved to
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
  // don't re-render a transcript the user can't see. On reactivation, pull the
  // canonical transcript (if any refetch/delta was dropped while hidden) plus
  // the pending questions/permissions — their .asked events can be missed while
  // the panel is hidden and there is no delta/owed mechanism to replay them.
  useEffect(() => {
    if (!isActive) return;
    if (refetchOwedWhileInactive.current) {
      refetchOwedWhileInactive.current = false;
      scheduleRefetch();
    }
    refreshQuestions();
    refreshPermissions();
  }, [isActive, scheduleRefetch, refreshQuestions, refreshPermissions]);

  const submit = useCallback(async () => {
    // Block submit while any attachment is still uploading.
    if (attachments.some((a) => a.status === "uploading")) {
      setSendError("Wait for attachments to finish uploading.");
      return;
    }
    // Non-media chips ride along as `@<remote-path>` tokens appended to the
    // message text — the AI reads them with its Read tool.
    const pathRefAttachments = attachments.filter(
      (a) => a.status === "ready" && !!a.remotePath && a.asPathRef,
    );
    const pathRefText = pathRefAttachments.map((a) => `@${a.remotePath}`).join(" ");
    const typed = input.trim();
    const text = pathRefText ? (typed ? `${typed} ${pathRefText}` : pathRefText) : typed;
    if (!text) return;
    // Record the prompt into the per-window localStorage list BEFORE the
    // running-queue early-return so queued prompts also persist (a queued
    // prompt still belongs to this tmux window — `/clear` shouldn't lose it).
    // epoch bump drives useInputHistory to re-read storage on its next render.
    appendPromptHistory(tmuxSession, windowIndex, text);
    setHistoryEpoch((e) => e + 1);
    // If the AI is already running, push to the queue instead of aborting.
    if (running) {
      setMessageQueue((q) => [...q, text]);
      setInput("");
      // Drop path-ref chips so they aren't appended a second time on next submit.
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
    // Snap the branch indicator to current truth on every submit.
    refreshBranch(cwd);
    // If the pinned todo list is fully terminal, hide the stale checklist.
    if (activeTodos && allTodosTerminal(activeTodos)) {
      setTodosDismissed(true);
    }

    // Optimistic transcript append — show the user's message NOW. The next
    // message-refetch (triggered by SSE) will overwrite `messages` entirely
    // with the canonical state. Force-pin to bottom BEFORE the commit so the
    // layout effect snaps to the freshly-appended turn.
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

    // Slash-command path: manta-local builtins → opencode commands → normal prompt.
    const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const cmdName = slashMatch ? slashMatch[1] : null;

    if (cmdName && MANTA_BUILTIN_NAMES.has(cmdName)) {
      setRunning(false);
      // manta builtins are renderer-only — no prompt actually sent, so strip
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
      cmdName && commandsRef.current ? commandsRef.current.find((c) => c.name === cmdName) : null;

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
  }, [input, running, sessionId, modelOverride, attachments, agentMentions]);

  // Always-current ref to submit — lets the queued-message effect call the
  // latest version without adding submit to the effect's dependency array
  // (which would re-arm the effect on every keystroke).
  submitRef.current = submit;

  // When the AI goes idle (running flips false) and there are queued
  // messages, dispatch the next one. We restore it into `input` and call
  // NOTE: the queued-message drain effect (submit next queued prompt when
  // running flips false) lives in useSseBus (useSseBus.ts). It used to be
  // ALSO duplicated here — both effects fired on the same running→false
  // transition against the shared messageQueue/submitRef and submitted the
  // same queued item TWICE. The duplicate was removed; the hook's effect is
  // the single owner. Do NOT reintroduce a drain effect here.

  const abort = useCallback(async () => {
    try {
      await window.api.opencodeAbort(sessionId);
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
    // Any question that was blocking this turn is dead now — reject it
    // server-side so it can't re-latch the sidebar's stale "?" glyph on a
    // later replay (BET-116). Best-effort; the helper never throws.
    rejectAllPendingQuestions();
  }, [sessionId, rejectAllPendingQuestions]);

  const replyPermission = useCallback(
    async (requestId: string, reply: "once" | "always" | "reject") => {
      // Optimistically drop this request so the card disappears immediately.
      setPermissions((prev) => prev.filter((p) => p.id !== requestId));
      // Clear the sidebar attention dot immediately — the SSE round-trip can
      // be missed, leaving the red `!` stuck.
      useStore.getState().setChatAttention(sessionId, null);
      try {
        await window.api.opencodePermissionReply(requestId, reply, sessionId);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        refreshPermissions();
      }
    },
    [refreshPermissions, sessionId],
  );

  const replyQuestion = useCallback(
    async (q: QuestionRequest, answers: string[][]) => {
      const que = q.requestId;
      // No reply token → unanswerable ask (stale/orphan/cross-session leak).
      // Auto-dismiss instead of surfacing an error the user can't clear.
      if (!que) {
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        useStore.getState().setChatAttention(q.sessionID, null);
        return;
      }
      setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      // Clear the sidebar attention dot immediately.
      useStore.getState().setChatAttention(q.sessionID, null);
      try {
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

  // ===== Typeahead (extracted to useTypeahead) =====
  // Declared after currentModelName so it's available in the hook params.
  const {
    typeahead,
    setTypeahead: setTypeaheadFromHook,
    typeaheadRows,
    commands,
    onTypeaheadSelect: applyTypeahead,
    onTypeaheadMove: moveTypeaheadSelection,
    updateInput,
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
  // Ref to commands so submit can access it without being in deps (commands
  // is defined after submit in the file, but submit needs the latest value).
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

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
  // Derives a short tmux window name from the conversation every Nth completed
  // user turn. Title is generated by a throwaway opencode session via the
  // opencodeGenerateTitle IPC. Works on desktop and mobile because ChatPanel
  // is shared.
  const prevRunningForRenameRef = useRef(false);
  const lastAutoRenamedTurnRef = useRef(0);
  const autoRenameInFlightRef = useRef(false);
  const pendingRenameRef = useRef(false);

  useEffect(() => {
    // New session → reset the per-session rename bookkeeping.
    lastAutoRenamedTurnRef.current = 0;
    autoRenameInFlightRef.current = false;
    prevRunningForRenameRef.current = false;
    pendingRenameRef.current = false;
  }, [sessionId]);

  // ARM on the running true→false edge. The transcript is STALE here
  // (300ms-debounced refetch), so we only flip the pending flag; evaluation
  // runs below once the settled transcript arrives.
  useEffect(() => {
    const wasRunning = prevRunningForRenameRef.current;
    prevRunningForRenameRef.current = running;
    if (wasRunning && !running) pendingRenameRef.current = true;
    else if (!wasRunning && running) pendingRenameRef.current = false;
  }, [running]);

  // EVALUATE when a rename is armed AND the transcript is settled. Runs on
  // every `messages` change while not running, so it catches the post-edge
  // refetch. The flag is cleared only when we actually fire a rename, or when
  // a new turn starts (the disarm above).
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
    replyPermission: (id: string, reply: string) => replyPermission(id, reply as "once" | "always" | "reject"),
    replyQuestion,
    rejectQuestion,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey: useStore((s) => s.groqApiKey),
  });

  // ===== Drag-drop attachments =====
  //
  // Files dropped anywhere on the panel are shipped to ~/.manta-uploads/<session>/
  // and each gets a chip above the input ("uploading" → "ready"; failures keep
  // the chip with an error tooltip). TWO transports, decided per file:
  //   - OS path available (Electron preload's webUtils via getPathForFile) →
  //     batch scp through the uploadFiles bridge (desktop SSH mode).
  //   - No OS path (desktop HTTP mode / mobile browser: getPathForFile returns
  //     "") → read the File's bytes and POST them through uploadBuffer, the
  //     same byte path paste already uses. Without this fallback a drop in
  //     HTTP mode silently discarded every file.

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
      // `lp === ""` means "no OS path" → the file rides the byte path below.
      type Pending = { file: File; lp: string; mime: string; asPathRef: boolean; id: string };
      const pending: Pending[] = list.map((f) => {
        const mime = f.type || guessMime(f.name);
        return {
          file: f,
          lp: window.api.getPathForFile(f),
          mime,
          asPathRef: mimeToInputMode(mime) === "other",
          id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        };
      });

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

      const settleChip = (id: string, rp: string | null, errorMsg?: string) => {
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? rp
                ? { ...a, status: "ready", remotePath: rp }
                : { ...a, status: "error", errorMsg: errorMsg ?? "Upload returned no path" }
              : a,
          ),
        );
      };

      // Path-based entries upload in one batch (cheaper round-trip).
      const pathPending = pending.filter((p) => p.lp);
      const pathBatch = (async () => {
        if (pathPending.length === 0) return;
        let remotePaths: string[] = [];
        try {
          remotePaths = await window.api.uploadFiles({
            projectName: tmuxSession,
            localPaths: pathPending.map((p) => p.lp),
          });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          for (const p of pathPending) settleChip(p.id, null, msg);
          return;
        }
        pathPending.forEach((p, i) => settleChip(p.id, remotePaths[i] ?? null));
      })();

      // Byte-based entries upload individually (each File's bytes → uploadBuffer).
      const bytePending = pending.filter((p) => !p.lp);
      const byteBatch = Promise.all(
        bytePending.map(async (p) => {
          try {
            const buffer = await p.file.arrayBuffer();
            const rp = await window.api.uploadBuffer({
              projectName: tmuxSession,
              filename: p.file.name,
              buffer,
            });
            settleChip(p.id, rp || null);
          } catch (e) {
            settleChip(p.id, null, String((e as Error)?.message ?? e));
          }
        }),
      );

      await Promise.all([pathBatch, byteBatch]);
    },
    [tmuxSession],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Patch one attachment by id with a Partial<Attachment>. Reused by the
  // paste/screenshot upload paths to flip status from "uploading" -> "ready"
  // (with remotePath) or -> "error" (with errorMsg) without repeating the
  // setAttachments(prev => prev.map(a => a.id === id ? {...a, ...patch} : a))
  // closure at every site (duplication-gate).
  const patchAttachment = useCallback(
    (id: string, patch: Partial<Attachment>) => {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

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
          patchAttachment(id, { status: "ready", remotePath });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          patchAttachment(id, { status: "error", errorMsg: msg });
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
      // Only Electron main can read the Mac clipboard or a Mac file — both
      // must come from the preload OS bridge, never window.api (which is
      // httpApi in HTTP mode and has no OS access; the server IS the box).
      const preload = getMantaPreload();
      if (!preload) throw new Error("Screenshot capture requires the desktop app");

      let buf: ArrayBuffer;
      if (toast.source === "file" && toast.path) {
        // Desktop watcher: read the local Mac file's bytes via main.
        buf = await preload.readLocalFile(toast.path);
      } else {
        // Clipboard: read bytes from main.
        const clip = await preload.clipboardReadImage();
        if (!clip) throw new Error("Clipboard image vanished");
        buf = clip;
      }
      // Upload the bytes through the same proven path as paste/drag-drop —
      // window.api.uploadBuffer POSTs to the server's /api/upload.
      const remotePath = await window.api.uploadBuffer({
        projectName: tmuxSession,
        filename,
        buffer: buf,
      });
      if (!remotePath) throw new Error("Upload failed");
      patchAttachment(id, { status: "ready", remotePath });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      patchAttachment(id, { status: "error", errorMsg: msg });
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

  // Prompt-history navigation (Up/Down) + the typing path that exits history
  // mode. Self-contained hook; see useInputHistory. The hook also returns
  // `promptHistory`, but ChatPanel doesn't consume it.
  const { navigateHistory, updateInputWithHistoryReset } = useInputHistory({
    messages,
    inputRef,
    setInput,
    setTypeahead: setTypeaheadFromHook,
    updateInput,
    tmuxSession,
    windowIndex,
    historyEpoch,
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
      <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-bg text-text-faint text-sm font-mono">
        <div
          className="h-5 w-5 rounded-full border-2 border-text-faint border-t-transparent animate-spin"
          aria-hidden
        />
        <span>Connecting to session…</span>
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
      {/* Header dropped — manta's outer chrome already shows project/window. */}

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

      {/* Transcript-loading card removed (BET-251). The warm-stale-reopen */}
      {/* refetch is now surfaced as an ambient orange sweep on the composer's */}
      {/* top divider — see InputArea + `manta-loading-divider` in index.css. */}
      {/* Cold-load (`messages === null`) is still covered by the full-screen */}
      {/* "Connecting to session…" spinner above. */}
      {/* `refreshing` is still threaded into the composer below. */}

      {/* Live compaction progress. Streams the summary as it's produced and */}
      {/* flips to a brief "Compacted" confirmation after .ended; clears on */}
      {/* a timer (session.compacted refetch has already landed by then). */}
      {compactionState && (
        <div className="shrink-0 px-4 pt-2">
          <CompactionCard state={compactionState} />
        </div>
      )}

      {/* Claude credential auto-refresh (BET-139). Only "refreshing"/"ok" */}
      {/* render here — "error" surfaces via the sendError banner instead */}
      {/* (see onProviderAuthErrorRef above), so it's intentionally excluded. */}
      {(credRefresh === "refreshing" || credRefresh === "ok") && (
        <div className="shrink-0 px-4 pt-2">
          <CredRefreshCard state={credRefresh} />
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
          setTypeaheadFromHook((prev) => (prev ? { ...prev, selectedIdx: idx } : prev))
        }
        input={input}
        setInput={updateInputWithHistoryReset}
        inputRef={inputRef}
        submit={submit}
        abort={abort}
        running={running}
        refreshing={refreshing}
        branch={branch}
        modelLabel={modelLabel}
        chatAutoAllow={chatAutoAllow}
        setChatAutoAllow={setChatAutoAllow}
        voiceEnabled={voiceEnabled}
        voicePhase={voiceRecorder.phase}
        voiceMode={voiceRecorder.mode}
        voiceRecording={voiceRecording}
        voiceProcessing={voiceProcessing}
        startVoice={(mode) => { voiceRecorder.start(mode); return Promise.resolve(); }}
        stopVoice={voiceRecorder.stop}
        cancelVoice={voiceRecorder.cancel}
        tokens={latestTokens}
        staleCache={staleCache}
        models={models}
        modelOverride={modelOverride}
        defaultModel={defaultModel}
        deactivatedMainModels={deactivatedMainModels}
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
        onTypeaheadCancel={() => setTypeaheadFromHook(null)}
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
