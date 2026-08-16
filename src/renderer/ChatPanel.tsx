// Chat panel for opencode chat-mode windows — Claude Code-style transcript.
//
// Layout intent:
//   - Full-width monospace transcript; no chat bubbles
//   - User messages prefixed with `>`; assistant messages with `●` in Claude's
//     accent orange
//   - Markdown for text parts (inline code, bold/italic, fenced code blocks,
//     lists, headers)
//   - Reasoning rendered as a dimmed italic `✻ Thinking…` block
//   - Running state shows a cycling loader + present-tense verb + live
//     elapsed seconds + tokens so far at the tail of the transcript
//   - Input is a single bordered box with a `>` prompt prefix
//
// No Electron-only deps — only `window.api.*` (the mobile HTTP server will
// shim that surface).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, Clock, X } from "lucide-react";
import type {
  AvailableLauncher,
  CheckRollup,
  DelegateApproval,
  DelegateApprovalTool,
  ForgeCheckRun,
  OpencodeModel,
  ProgressRecord,
  PullRequest,
  QuestionRequest,
} from "../shared/types";
import { useStore } from "./store";
import type { PendingScreenshot } from "./store";
import { flashMessageRow } from "./messageFlash";
import {
  allTodosTerminal,
  selectActiveTodos,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  computeStaleCache,
  computeContextBreakdown,
  resolveContextLimit,
  STALE_CACHE_MIN_TOKENS,
  countRunningSubagents,
  computeTurnInfo,
  computeLiveTurn,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  sanitizeGeneratedTitle,
  detectCommandFromText,
  type EntryMotionState,
  type StaleCacheResult,
  type PendingScrollWin,
  isApprovalCoveredByAlways,
  scrollElementToTail,
  MANTA_BUILTIN_COMMANDS,
  MANTA_BUILTIN_NAMES,
  parseModelRef,
  describeMergeFailure,
  progressAttentionKind,
  resolvePlanToggle,
  isPlanExitQuestion,
  extractPlanData,
  selectableModelGroups,
} from "./chatUtils";
import { isPlanAgent, planPageUrl } from "../shared/planMode.mjs";
import { serverBase } from "./api/httpApi";
import {
  appendPromptHistory,
  copySavedModels,
  guessMime,
  mimeToInputMode,
  modelInputModes,
  modelKey,
  modelSupportsAttachments,
  readSavedModel,
  writeSavedModel,
  readPlanSaved,
  writePlanSaved,
  readSavedDelegateModel,
  writeSavedDelegateModel,
  resolveActiveModel,
  type AgentMention,
  type Attachment,
  type ModelMode,
  type ModelSelection,
  type SessionMode,
  type TaskContextValue,
  type TokenUsage,
} from "./chatShared";
import { useModelCatalog } from "./modelCatalog";
import { useAgentCatalog } from "./agentCatalog";
import { MantaLoader } from "./MantaLoader";
import { MeasureColumn } from "./MeasureColumn";
import { BlockedProgressCard, CompactionCard, PermissionCard, PlanCard, RetryCard } from "./Cards";
import { Button } from "./Button";
import { DelegateApprovalCard, ReadOnlyJobBar, ScheduledTasksCard, SecretsCard, WebhooksCard } from "./PanelCards";
import { CardStack, type PinnedCardRender } from "./components/CardStack";
import { useSessionResources } from "./hooks/useSessionResources";
import { useInputHistory } from "./hooks/useInputHistory";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useSseBus } from "./hooks/useSseBus";
import { useVoice } from "./hooks/useVoice";
import { useTypeahead } from "./hooks/useTypeahead";
import { VoicePlaybackProvider } from "./hooks/useVoicePlayback";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { SessionHeader } from "./SessionHeader";
import { Modal } from "./Modal";
import { ConnectGithubPanel } from "./ConnectGithub";
import { buildVoiceNoteMap } from "./chatUtils";
import type { VoiceNoteRecord } from "../shared/types";
import type { PendingVoiceNote } from "./VoiceNote";

// Attachment / AgentMention / TypeaheadState / TypeaheadRow are shared with
// the extracted composer components and live in ./chatShared.
// manta-local slash commands live in chatUtils.ts (MANTA_BUILTIN_COMMANDS /
// MANTA_BUILTIN_NAMES), shared with useTypeahead so execution and completion
// never diverge.

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
  // BET-459: the session header is the single top-of-pane row and now owns
  // the breadcrumb + mode toggle that used to live in the app titlebar.
  // Optional so callers that don't own mode (e.g. the mobile SessionScreen)
  // keep composing the header without one.
  projectName?: string | null;
  winName?: string | null;
  mode?: SessionMode;
  onModeChange?: (m: SessionMode) => void;
  // BET-467: the box's AI-CLI launchers for the session; forwarded to the
  // header's session menu so a launcher mode is reachable from the running UI
  // (the header glyph only toggles Chat ↔ Terminal).
  availableLaunchers?: AvailableLauncher[];
  // BET-659: the Artifacts panel toggle state + handler, owned by App (which
  // mounts the panel as a sibling of <main>). Threaded through to the header.
  // Optional so test harnesses that construct ChatPanel directly omit them.
  artifactsOpen?: boolean;
  onToggleArtifacts?: () => void;
  // A prompt to send through the panel's OWN submit path once, on mount —
  // used by the optimistic "new session" flow so the first prompt + running
  // indicator appear immediately in the real chat view. Optional; present
  // only on the transient panel rendered while the tmux window is created.
  autoSubmit?: { text: string; model?: ModelSelection };
  // App-control (BET-840/841): App owns the single `appControl` bus listener
  // and reaches the open panel for a `switch-model` action through these.
  // `selectModel` is registered so a model-switch applies the override through
  // the SAME path the picker uses (no parallel setter that could drift). Both
  // optional — omitted in test harnesses that mount ChatPanel directly.
  registerModelControl?: (sessionId: string, apply: (m: ModelSelection) => void) => void;
  unregisterModelControl?: (sessionId: string) => void;
  // BET-795: a one-shot composer SEED — the inbox's "Start a session". Like
  // autoSubmit, delivered to the RIGHT session's panel, but it only fills the
  // composer (setInput); it does NOT submit. The user reviews + hits Enter.
  seedPrompt?: { text: string };
};

export function ChatPanel({
  sessionId,
  tmuxSession,
  windowIndex,
  cwd,
  isActive,
  projectName = null,
  winName = null,
  mode = "chat",
  onModeChange,
  availableLaunchers = [],
  artifactsOpen = false,
  onToggleArtifacts = () => {},
  autoSubmit,
  registerModelControl,
  unregisterModelControl,
  seedPrompt,
}: Props) {
  const chatAutoAllow = useStore((s) => s.chatAutoAllow);
  const setChatAutoAllow = useStore((s) => s.setChatAutoAllow);
  const autoRenameSessions = useStore((s) => s.autoRenameSessions);
  const configDefaultModel = useStore((s) => s.defaultModel);
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels);
  const hiddenStatusItems = useStore((s) => s.hiddenStatusItems);
  // BET-789: the "Connect GitHub…" offer's per-box dismissal flag. Once set,
  // the offer never re-appears until the config flag is cleared.
  const forgeConnectOfferDismissed = useStore((s) => s.forgeConnectOfferDismissed);
  // User-configured Anthropic prompt cache TTL — drives the "/clear to
  // save Nk tokens" pill when the session has been idle past this TTL.
  // manta doesn't set the real cache_control.ttl on requests; this is the
  // user's claim about what opencode is sending. See AppConfig comment.
  const cacheTtl = useStore((s) => s.cacheTtl);
  // Server-owned resource cards (⏰ schedules, 🔑 secrets, 🪝 webhooks) —
  // state, refresh callbacks, poll effects, session resets, and the mobile
  // `manta-open-*` window-event bridges. Extracted to a self-contained hook
  // (BET-63) because none of it touches the SSE / pin-to-bottom / message core.
  const resources = useSessionResources(sessionId, isActive);
  const {
    openPanel,
    togglePanel,
    closePanel,
    schedules,
    setSchedules,
    scheduleError,
    setScheduleError,
    refreshSchedules,
    secrets,
    setSecrets,
    secretError,
    setSecretError,
    refreshSecrets,
    webhooks,
    setWebhooks,
    webhookError,
    setWebhookError,
    refreshWebhooks,
  } = resources;
  const setChatSubagents = useStore((s) => s.setChatSubagents);
  const setChatMessages = useStore((s) => s.setChatMessages);

  // BET-418 §A: pre-flight background-job approvals. When trust mode is OFF
  // and the model's `delegate` call declared `tools`, the server holds the
  // call and publishes a pending approval; this panel polls for it and shows
  // ONE card (Start / Edit access / Not now). The 3s poll is fast enough that
  // the card appears within the 2-min approval window. Cleared on session
  // change. Trust mode (chatAutoAllow) skips the card server-side, so none
  // arrive here.
  const [pendingApproval, setPendingApproval] = useState<DelegateApproval | null>(null);
  const chatAutoAllowApproval = useStore((s) => s.chatAutoAllow);

  // BET-794/867: forge ship + merge for this session. The server resolves cwd →
  // repo → token box-side (a forge token never reaches the renderer). The
  // branch chip's popover is the ONE git surface (BET-867): it is the human
  // gate (BET-794 [SH1]) before a PR is pushed/opened — the ship preview is
  // loaded, the title shown, and the explicit non-default Create button names
  // the head, base, file count and title. Create PR ships inline from the
  // popover — never auto-submitted.
  const [shipProposal, setShipProposal] = useState<{ head: string; base: string; fileCount: number; title: string; body: string } | null>(null);
  const [shipBusy, setShipBusy] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // BET-925: a few seconds of "Opened #N" in the branch popover after a ship,
  // so the state swap is affirmed rather than silent. Mirrors the compaction
  // card's 2.5s hold; the timer is cleared on unmount so a late fire can never
  // write into a different session.
  const [shipJustCreated, setShipJustCreated] = useState(false);
  useEffect(() => {
    if (!shipJustCreated) return;
    const t = setTimeout(() => setShipJustCreated(false), 4000);
    return () => clearTimeout(t);
  }, [shipJustCreated]);

  // BET-418 §D: detect whether THIS session is a background job's child. A
  // job session is read-only (no composer, no cards, no model picker/fork/
  // compact/clear); the composer is replaced by ReadOnlyJobBar. Derived from
  // the store's `jobs` slice (keyed by childSessionID, fed by App.tsx's single
  // 30s delegateList poll + real-time `delegate.updated` refetch) — the panel
  // no longer runs its own 10s delegateList poll.
  const jobs = useStore((s) => s.jobs);
  const jobOwnership = useMemo(
    () => jobs[sessionId] ?? null,
    [jobs, sessionId],
  );

  const projects = useStore((s) => s.projects);
  const setActive = useStore((s) => s.setActive);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Per-child debounce timers for refetching child transcripts when their
  // expanded card is receiving SSE traffic. Keyed by childSessionId. 300ms
  // matches the parent's scheduleRefetch debounce so behavior is uniform.
  const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Unmount cleanup — clear every pending child refetch timer so a 300ms timer
  // surviving teardown can't fire fetch + setState after the panel unmounts
  // (same pattern as useTranscriptState's own splice-timer cleanup).
  useEffect(() => () => {
    for (const t of childRefetchTimers.current.values()) clearTimeout(t);
    childRefetchTimers.current.clear();
  }, []);
  // Forward declaration: submitRef is defined later (depends on submit), but
  // useSseBus needs it now for the drain effect.
  const submitRef = useRef<(textOverride?: string) => void>(() => {});
  // Input state must be declared before useSseBus (which needs setInput).
  const [input, setInput] = useState("");
  // Bumped after each submit so useInputHistory re-reads localStorage and the
  // freshly-persisted prompt becomes immediately cyclable (BET-257). The hook
  // can't watch localStorage on its own — we drive the re-read from here.
  const [historyEpoch, setHistoryEpoch] = useState(0);

  // BET-837 voice notes. `voiceNotes` is the session's stored notes (fetched
  // once per session, reset on session change — same lifecycle as the
  // transcript state); `pendingVoiceNote` is the not-yet-real row shown while
  // a take uploads + transcribes. The send flow (useVoice.onComplete) sets
  // both via the setters passed into the hook.
  const [voiceNotes, setVoiceNotes] = useState<VoiceNoteRecord[]>([]);
  const [pendingVoiceNote, setPendingVoiceNote] = useState<PendingVoiceNote | null>(null);

  // ===== Transcript state (extracted to useTranscriptState) =====
  // The entry-motion state is owned HERE and shared with both Transcript
  // (rendering) and useTranscriptState (whose reconcile registers canonical
  // ids against it so an optimistic placeholder's handover never replays the
  // entry "pop"). One ChatPanel instance is bound to one session, so a single
  // ref per panel is the right lifetime.
  const motionStateRef = useRef<EntryMotionState | null>(null);
  const {
    messages,
    setMessages,
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
    wantQuestionScroll,
    applyStreamFlush,
    scheduleRefetch,
    spliceMessage,
    loadEarlierChildTranscript,
    toggleTaskExpand,
    loadedAllRef,
    fetchOpts,
    childLoadedAllRef,
    loadingChildEarlier,
  } = useTranscriptState({ sessionId, isActive, motionStateRef });

  // ===== Virtualized scroll (BET-679) =====
  // react-virtuoso owns the transcript scroller (see Transcript.tsx). This
  // component keeps a handle to it for the imperative scroll needs that the
  // pin machinery used to cover — submit force-pin, re-pin on reactivation,
  // and the deep-link jumps — plus a live at-bottom flag (the replacement for
  // the deleted `pinnedToBottom` ref) fed by Virtuoso's atBottomStateChange.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Whether the transcript is following the tail. The REF is the source of
  // truth (imperative readers — resizeInput, the re-activation effect, the
  // growth handler in Transcript — must not wait for a render); the state is
  // its render mirror, needed only so the jump-to-latest button can appear.
  // The equality guard is load-bearing: a scroll fires this on every event and
  // an unguarded setState would re-render the panel on every scroll frame.
  //
  // This deliberately does NOT track "is the scroller at the bottom". Content
  // growing under the user must not detach them — see the header comment on
  // classifyFollowOnScroll.
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const setFollowing = useCallback((v: boolean) => {
    if (followingRef.current === v) return;
    followingRef.current = v;
    setFollowingState(v);
  }, []);
  // The Virtuoso scroll container, captured by Transcript via Virtuoso's
  // `scrollerRef` prop. Same ownership pattern as loadedAllRef / motionStateRef.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Set by submit(), consumed by the force-tail effect below. Submit cannot
  // scroll inline: the optimistic row it just queued is not committed yet, so
  // `index: "LAST"` would resolve to the PREVIOUS last message.
  const forceTailRef = useRef(false);
  // Canceller for the in-flight message-flash wait (BET-805). Held across
  // `flashMessageRow` calls so a pending wait from a previous jump can be
  // cancelled before starting a new one, and cleared in the session-change
  // cleanup so a wait can't fire against a transcript the user has left.
  const messageFlashCancelRef = useRef<(() => void) | null>(null);
  // The ONE way this panel scrolls the transcript to its tail. Every caller
  // goes through here: submit's force-pin, the question-card reveal, the
  // composer-resize rescue, the re-activation re-pin and the jump-to-latest
  // button. The follow state is set eagerly here rather than waiting for any
  // async signal, so the growth handler and the rescues agree with the scroll
  // we just asked for.
  const scrollToTail = useCallback(() => {
    setFollowing(true);
    scrollElementToTail(scrollerElRef.current);
  }, [setFollowing]);
  // Mirror of `messages` for event listeners (deep-link jumps) that need the
  // current list without re-registering on every message update.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const scrollToMessage = useCallback((messageId: string, behavior: "smooth" | "auto" = "smooth") => {
    const idx = (messagesRef.current ?? []).findIndex((m) => m.info.id === messageId);
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior });
  }, []);

  // ===== Per-session model override =====
  // Declared before useSseBus: the auth-banner providerID below derives from
  // it. Initialized from the per-session localStorage override for the ACTIVE
  // mode (per-mode since BET-950 — plan mode falls back to the build key when
  // no plan key exists), falling back to the persisted global default (the
  // same seed useSseBus's providerID used to recompute from readSavedModel on
  // every render).
  const [modelOverride, setModelOverride] = useState<ModelSelection | null>(() =>
    readSavedModel(sessionId, readPlanSaved(sessionId) ? "plan" : "build") ??
    configDefaultModel ?? null,
  );
  // Active-model providerID for the auth-error banner (BET-316). Per-session
  // override wins over the persisted default; null if neither is set. Memoized
  // on `modelOverride` (the in-memory selection, itself seeded from
  // localStorage) so the localStorage read + parse runs on model change, not
  // on every keystroke re-render.
  const providerID = useMemo(
    () => modelOverride?.providerID ?? configDefaultModel?.providerID ?? null,
    [modelOverride, configDefaultModel],
  );

  // ===== Per-session plan mode (BET-949) =====
  // Local on/off, seeded from the per-session storage key (the `Session.agent`
  // seed falls back to this). The honesty handlers in useSseBus sync this from
  // opencode's own agent-switch events (plan_enter/plan_exit / agent.switched),
  // so the chip never claims plan mode while the next turn would run as build.
  const [planOn, setPlanOn] = useState<boolean>(() => readPlanSaved(sessionId));
  // The `plan` agent availability comes from the shared box-level catalog.
  const { agents } = useAgentCatalog();
  const plan = useMemo(
    () => resolvePlanToggle(agents, planOn),
    [agents, planOn],
  );
  const togglePlan = useCallback(() => {
    const next = !planOn;
    setPlanOn(next);
    writePlanSaved(sessionId, next);
    // Requirement 1 (BET-950): toggling re-reads the model for the mode we are
    // entering so the composer's model chip visibly changes. Zero-config:
    // readSavedModel's plan→build fallback means a first toggle to plan keeps
    // the build model until the user picks one while in plan mode. The plan
    // key is NOT written here — only on an explicit model pick.
    const mode: ModelMode = next ? "plan" : "build";
    setModelOverride(readSavedModel(sessionId, mode) ?? configDefaultModel ?? null);
  }, [planOn, sessionId, configDefaultModel]);
  // Honesty sync from useSseBus: opencode's OWN agent switches (plan_enter /
  // plan_exit / agent.switched) drive this so the chip never lies about the
  // agent the next turn will run as. Also persists so a re-mount seeds right.
  const syncPlan = useCallback((next: boolean) => {
    setPlanOn(next);
    writePlanSaved(sessionId, next);
  }, [sessionId]);

  // ===== SSE bus state (extracted to useSseBus) =====
  const {
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
    refreshPermissions,
    refreshQuestions,
    transcriptLoadError,
    retryTranscriptLoad,
  } = useSseBus({
    sessionId,
    cwd,
    setMessages,
    setRefreshing,
    scheduleRefetch,
    fetchOpts,
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
    applyStreamFlush,
    providerID,
    setPlanOn: syncPlan,
    submit: () => {}, // placeholder — ChatPanel's submit is used below
    submitRef,
  });

  // Manual dismiss of the pinned todo card — the user's escape hatch for a
  // stale list that's non-terminal. Mirrors the auto-dismiss path in submit().
  // Stable identity so it doesn't defeat ActiveTodos' React.memo.
  const dismissTodos = useCallback(() => setTodosDismissed(true), [setTodosDismissed]);

  // BET-418 §A5: ref mirror of permissions so the approval poll can read the
  // latest always[] grants without taking permissions as a dep (which would
  // reset the poll timer on every permission change).
  const permissionsRef = useRef(permissions);
  useEffect(() => {
    permissionsRef.current = permissions;
  }, [permissions]);
  useEffect(() => {
    setPendingApproval(null);
    if (chatAutoAllowApproval) return; // trust mode → server never requests approval
    if (!isActive) return; // hidden panel — stop polling; refire once on reactivation
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await window.api.delegatePendingApprovals(sessionId);
        if (cancelled || list.length === 0) return;
        const approval = list[0];
        // BET-418 §A5: if the parent's existing always[] grants cover every
        // requested tool, auto-approve without rendering the card.
        if (isApprovalCoveredByAlways(approval, permissionsRef.current)) {
          void window.api.delegateApprove(approval.id, approval.tools).catch(() => { /* best-effort */ });
          return;
        }
        setPendingApproval(approval);
      } catch { /* non-fatal */ }
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [sessionId, chatAutoAllowApproval, isActive]);


  // ===== ChatPanel-own state (not extracted to hooks) =====
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  // Available models + server default. The catalog is box-level, not
  // per-session, so it lives in a shared module cache (`useModelCatalog`) — a
  // panel mounted by `/clear` reads the already-known list synchronously and
  // the picker never flashes "Loading…" for a list that didn't change.
  // Selection, by contrast, IS per-session and persists via localStorage.
  const { models, defaultModel } = useModelCatalog();
  // Pending attachments (chips above input) + agent @-mentions waiting to be
  // serialized into FilePart / AgentPart on next submit. Cleared on success.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Agent @-mentions state — populated by useTypeahead, consumed by submit.
  const [agentMentions, setAgentMentions] = useState<AgentMention[]>([]);
  // Ephemeral system notice (e.g. /help output). Lives in the store so the
  // App-level global toast host (BET-723) renders it over every pane type.
  // Cleared on dismiss or on next session change.
  const setSystemNotice = useStore((s) => s.setSystemNotice);
  // Whether the panel is currently being dragged over with files (for the
  // big "drop to attach" overlay).
  const [dragHover, setDragHover] = useState(false);
  // Ref mirror of the child-status map so `toggleTaskExpand` can read
  // current values synchronously without taking them as deps.
  const liveChildStatusRef = useRef<Map<string, "running" | "idle">>(new Map());
  useEffect(() => {
    liveChildStatusRef.current = liveChildStatus;
  }, [liveChildStatus]);
  // Compaction clear timer is owned by useSseBus.

  // Initial load + reload whenever sessionId changes.
  // Most state resets are now handled by the extracted hooks (useTranscriptState
  // resets messages/scroll/delta-buffer, useSseBus resets permissions/questions/
  // stepTokens/etc. via its SSE effect cleanup). We only need to reset the
  // ChatPanel-own state here: error, modelOverride, attachments, agentMentions,
  // systemNotice, dragHover. The SSE stream open/close is also handled by
  // useSseBus's effect now.
  useEffect(() => {
    setError(null);
    const planOnStart = readPlanSaved(sessionId);
    setPlanOn(planOnStart);
    setModelOverride(
      readSavedModel(sessionId, planOnStart ? "plan" : "build") ?? configDefaultModel ?? null,
    );
    // Seed plan mode from the session's own `agent` field when present (BET-949
    // §5): a session pre-set to plan OUTSIDE MantaUI would otherwise show the
    // chip off and send the next prompt as build — the stored key alone can't
    // know. Session.agent takes precedence over the stored key; on failure or
    // absence we keep the stored-key seed. Guarded like modelCatalog: the
    // pre-pairing preload subset lacks the method, and calling it throws.
    const api = window.api as Partial<typeof window.api>;
    if (api.opencodeSessionAgent) {
      api.opencodeSessionAgent(sessionId).then((agent) => {
        if (agent && agent.length > 0) {
          const planNow = isPlanAgent(agent);
          setPlanOn(planNow);
          writePlanSaved(sessionId, planNow);
          setModelOverride(
            readSavedModel(sessionId, planNow ? "plan" : "build") ?? configDefaultModel ?? null,
          );
        }
      }).catch(() => { /* non-fatal — stored-key seed stands */ });
    }
    setAttachments([]);
    setAgentMentions([]);
    setSystemNotice(null);
    setDragHover(false);
    // BET-837: voice notes reset on session change, then fetched once per
    // session (metadata only — audio rides the REST GET on demand).
    setVoiceNotes([]);
    setPendingVoiceNote(null);
    window.api
      .voiceListNotes(sessionId)
      .then((notes) => { if (Array.isArray(notes)) setVoiceNotes(notes); })
      .catch(() => { /* non-fatal — voice notes are ambient */ });
    // NOTE: the BRANCH POLL is intentionally NOT here. Chat panels stay
    // mounted (hidden with display:none) and this reset effect must only run
    // on a genuine session change — if isActive were a dep here, switching
    // away and back would re-run the reset and wipe staged attachments, @agent
    // mentions and the /help notice out of the composer. The poll lives in its
    // own visibility-gated effect below.
    return () => {
      // Cancel a pending message-flash wait on session change/unmount so it
      // can't fire against a transcript the user has since left.
      messageFlashCancelRef.current?.();
      messageFlashCancelRef.current = null;
    };
  }, [sessionId, cwd]);

  // BET-789: forge read path, consumed by SessionHeader. Refreshed on the SAME
  // timer as the branch indicator (the issue forbids a second poll — a second
  // timer for the same question is a duplicate code path). Nothing in this
  // state renders chrome by itself: no PR / no checks → the checks chip is not
  // registered; forge connected or not a forge origin → no connect offer.
  const [forge, setForge] = useState<{
    connected: boolean;
    kind: string | null;
    pr: PullRequest | null;
    checks: ForgeCheckRun[];
    rollup: CheckRollup;
    branch: string | null;
    base: string | null;
    aheadCount: number | null;
  }>({ connected: false, kind: null, pr: null, checks: [], rollup: "none", branch: null, base: null, aheadCount: null });
  const refreshForge = useCallback(async (cwdArg: string) => {
    try {
      const [status, prResult] = await Promise.all([
        window.api.forgeStatus(),
        window.api.forgePullRequest({ cwd: cwdArg }),
      ]);
      setForge({
        // `status` is a union; both variants carry `connected`.
        connected: status.connected,
        // The origin is a recognised forge whenever the read path got far
        // enough to classify it: "not_connected" is recognised-but-unauth'd
        // (exactly the connect-offer trigger), "no_forge" is not a forge at
        // all. github is the only adapter today.
        kind: prResult.error !== "no_forge" ? "github" : null,
        pr: prResult.pr,
        checks: prResult.checks ?? [],
        rollup: prResult.rollup ?? "none",
        branch: prResult.branch ?? null,
        base: prResult.base ?? null,
        aheadCount: prResult.aheadCount ?? null,
      });
    } catch {
      // non-fatal — the forge read path is best-effort; keep last-known.
    }
  }, []);

  // Fetch the ship preview once (the branch popover's no-PR state shows
  // Base / Changes). Click-only surface ⇒ fetched on popover open, never
  // polled, and not re-fetched if already loaded for this cwd. The session's
  // selected model + sessionId ride along (BET-893) so the box can generate
  // the title/body with that model, out of band.
  const ensureShipPreview = useCallback(async () => {
    if (!cwd) return;
    setShipError(null);
    if (shipProposal) return;
    try {
      const prev = await window.api.forgeShipPreview({
        cwd,
        ...(modelOverride ? { model: { providerID: modelOverride.providerID, modelID: modelOverride.modelID }, sessionId } : {}),
      });
      if (prev.ok) {
        // BET-925: fall back to the head branch name when the box is still
        // drafting (or returned an empty) title, so the Create button can never
        // enable on an empty title.
        setShipProposal({ head: prev.head, base: prev.base, fileCount: prev.fileCount, title: prev.title || prev.head, body: prev.body ?? "" });
      } else {
        setShipProposal(null);
        setShipError(prev.error);
      }
    } catch (e) {
      setShipProposal(null);
      setShipError(e instanceof Error ? e.message : "could not prepare the pull request");
    }
  }, [cwd, shipProposal, modelOverride, sessionId]);

  // Confirm → push + create, inline from the branch popover (BET-925). Only
  // reached after the human confirms the popover's Create button. The
  // title/body come from shipProposal (the box's preview, already resolved).
  // On success it writes the PR straight into local forge state so the popover
  // swaps to the PR state in the same tick (no flicker through the ready
  // state), opens the PR in the browser, then refreshes checks/mergeability.
  const confirmShip = useCallback(async () => {
    if (!cwd) return;
    const { title, body } = shipProposal ?? { title: "", body: "" };
    setShipBusy(true);
    setShipError(null);
    try {
      const res = await window.api.forgeShip({ cwd, title, body });
      if (res.ok) {
        // Swap the popover to the PR state in the same tick the write returns —
        // waiting for the next forge poll would flash the ready state back.
        // refreshForge then reconciles checks / mergeability.
        setForge((f) => ({ ...f, pr: res.pr }));
        setShipProposal(null);
        setShipJustCreated(true);
        if (res.url) void window.api.openExternal(res.url);
        void refreshForge(cwd);
      } else {
        setShipError(res.error);
      }
    } catch (e) {
      setShipError(e instanceof Error ? e.message : "ship failed");
    } finally {
      setShipBusy(false);
    }
  }, [cwd, shipProposal, refreshForge]);

  // Merge the shown PR, ALWAYS with the head SHA the user approved.
  const doMerge = useCallback(async () => {
    const pr = forge.pr;
    if (!pr || !cwd) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const res = await window.api.forgeMerge({ cwd, number: pr.number, method: "merge", sha: pr.headSha });
      if (res.ok) {
        void refreshForge(cwd);
      } else {
        setMergeError(describeMergeFailure(res.kind));
      }
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "merge failed");
    } finally {
      setMergeBusy(false);
    }
  }, [cwd, forge.pr, refreshForge]);

  // BET-789: dismiss the "Connect GitHub…" offer permanently, per-box. Mirror
  // of AppConfig.forgeConnectOfferDismissed, written through the generic
  // configUpdate channel (no new RPC). Optimistic store write so the offer
  // disappears immediately; the config write persists it across restarts.
  const dismissForgeConnect = useCallback(async () => {
    useStore.setState({ forgeConnectOfferDismissed: true });
    try {
      await window.api.configUpdate({ forgeConnectOfferDismissed: true });
    } catch {
      // persistent across restarts is best-effort; the optimistic hide stands.
    }
  }, []);

  // BET-943: the ConnectOffer's "Connect" chip opens the device-code modal.
  // The modal stays MOUNTED and gated by this flag (that is how `Modal` plays
  // its exit animation). onConnected closes it and re-reads forgeStatus so the
  // offer disappears and the checks/PR chips appear — no second refresh path.
  const [connectGithubOpen, setConnectGithubOpen] = useState(false);
  const openConnectGithub = useCallback(() => setConnectGithubOpen(true), []);

  // Branch indicator: poll every 5s while this session is visible. Gated on
  // isActive — hidden panels stop polling; the effect re-fires (one
  // refreshBranch on entry) when isActive flips back on.
  useEffect(() => {
    if (!isActive) return;
    refreshBranch(cwd);
    void refreshForge(cwd);
    const branchPoll = setInterval(() => {
      refreshBranch(cwd);
      void refreshForge(cwd);
    }, 5000);
    return () => clearInterval(branchPoll);
  }, [cwd, refreshBranch, isActive, refreshForge]);

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
          // The question cards live in the transcript's footer; scroll the last
          // row into view so the footer (with the cards) is revealed.
          scrollToTail();
          wantQuestionScroll.current = false;
        }
      }
    };
    window.addEventListener("manta-scroll-to-question", onEvt);
    return () => window.removeEventListener("manta-scroll-to-question", onEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Scroll the transcript to a message row and flash it (BET-660 treatment).
  // Returns false when the message isn't in the loaded transcript yet so
  // callers can retry later (e.g. the ⌘F cross-conversation jump, where the
  // window has just been activated and its transcript is still streaming in).
  // scrollToMessage scrolls via Virtuoso's scrollToIndex; the target row may
  // not be in the DOM until Virtuoso renders it, so flashMessageRow polls for
  // it (a frame or two later for the smooth scroll) instead of flashing on a
  // single immediate lookup.
  const scrollFlashMessage = useCallback(
    (messageId: string, query?: string): boolean => {
      scrollToMessage(messageId);
      // Cancel any pending wait from a previous jump so it can't flash against
      // a row the user has already scrolled past or a transcript they've left.
      messageFlashCancelRef.current?.();
      messageFlashCancelRef.current = flashMessageRow(messageId, document, query);
      return (messagesRef.current ?? []).some((m) => m.info.id === messageId);
    },
    [scrollToMessage],
  );

  // Artifacts panel → jump-to-message bridge (BET-660). Scrolls the transcript
  // to the row that owns an artifact's messageId and flashes it for ~1.2s.
  useEffect(() => {
    const onScrollToMessage = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { sessionId?: string; messageId?: string; query?: string }
        | undefined;
      if (detail?.sessionId !== sessionId || !detail?.messageId) return;
      scrollFlashMessage(detail.messageId, detail.query);
    };
    window.addEventListener("manta-scroll-to-message", onScrollToMessage);
    return () => window.removeEventListener("manta-scroll-to-message", onScrollToMessage);
  }, [sessionId, scrollFlashMessage]);

  // ⌘F cross-conversation jump: consume the pending scroll target once this
  // session's transcript has rendered the row. Same pre-mount-bridge pattern
  // as __mantaScrollQuestionSession above — the search palette can't dispatch
  // an event at a panel that hasn't loaded its messages yet. Re-runs on every
  // messages commit until the row exists, then clears the global.
  useEffect(() => {
    const w = window as PendingScrollWin;
    const pending = w.__mantaPendingMessageScroll;
    if (!pending || pending.sessionId !== sessionId || messages == null) return;
    if (scrollFlashMessage(pending.messageId, pending.query)) {
      w.__mantaPendingMessageScroll = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId]);

  // Mobile keyboard-bar → /clear bridge (BET-259). The KeyboardBar's
  // `clear` key already showed the user a confirm; this listener hands the
  // clear to ChatPanel's existing /clear builtin path so optimistic-message
  // cleanup and model-override carry-over to the new session behave exactly
  // like a typed `/clear`. The submit is deferred via setTimeout(…, 0) so the
  // setInput("/clear") re-render commits first — calling submit() in the
  // same tick would read the stale input closure. Don't call
  // opencodeClearSession directly; the builtin path in submit() owns the
  // model-carry-over.
  useEffect(() => {
    const onRunClear = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId !== sessionId) return;
      setInput("/clear");
      setTimeout(() => {
        submitRef.current?.();
      }, 0);
    };
    window.addEventListener("manta-run-clear", onRunClear);
    return () => window.removeEventListener("manta-run-clear", onRunClear);
  }, [sessionId, setInput]);

  // Review pane → composer bridge (BET-792). A draft note's "Send to agent"
  // appends the note text to the composer input WITHOUT sending — it fills the
  // input, it does not submit. The user's next Enter sends it through the
  // normal submit path.
  useEffect(() => {
    const onForgeComment = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { sessionId?: string; text?: string }
        | undefined;
      if (detail?.sessionId !== sessionId || !detail?.text) return;
      setInput((prev) => (prev ? `${prev}\n${detail.text!}` : detail.text!));
      inputRef.current?.focus();
    };
    window.addEventListener("manta-forge-comment", onForgeComment);
    return () => window.removeEventListener("manta-forge-comment", onForgeComment);
  }, [sessionId, setInput]);

  // (manta-open-schedules / -secrets / -webhooks mobile bridges moved to
  // useSessionResources.)

  // Perform the deferred scroll once the question cards actually exist (cold
  // start: questions arrive via the async fetch after this panel mounts).
  useEffect(() => {
    if (wantQuestionScroll.current && questions.length > 0) {
      scrollToTail();
      wantQuestionScroll.current = false;
    }
  }, [questions, scrollToTail]);

  // Textarea auto-resize up to a 6-line cap. After resizing, if the transcript
  // is following the tail we re-scroll so the input growing pushes the chat
  // content up rather than sliding over it. Follows the panel's follow state
  // — the replacement for the deleted pin refs.
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cap = 6 * 20;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    if (followingRef.current) {
      scrollToTail();
    }
  }, [scrollToTail]);
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

  // Re-pin to bottom when this panel becomes active again.
  //
  // GOTCHA (inherited from the pin machinery): while App.tsx hides an inactive
  // panel with `display:none`, the scroller has no layout. New messages keep
  // accumulating while hidden, and on re-activation the user should be back at
  // the tail if they were there when the panel was deactivated. The panel's
  // follow state retains its last value across the hidden window (hidden
  // panels fire no scroll events), so gating on it reproduces the old "was at
  // bottom when deactivated" rule; a single tail scroll on reactivation is
  // all that's needed.
  useEffect(() => {
    if (!isActive) return;
    if (!followingRef.current) return;
    // Re-activation re-pin. The scroller was display:none while inactive, so at
    // this instant it has NOT re-measured: both a synchronous el.scrollTop =
    // el.scrollHeight and Virtuoso's scrollToIndex(LAST,end) land SHORT (the
    // real increaseViewportBy bottom crowds out the tail). Defer the true-bottom
    // write to after the browser has re-laid-out the now-visible scroller
    // (2x rAF — scrollHeight is then the real tail), and pin exactly to it. All
    // OTHER scrollToTail() callers run on a visible, measured scroller and stay
    // as they are. (BET-1003 — supersedes the BET-1001 scrollToIndex approach
    // which still landed ~216px above the tail under "content grew while
    // hidden".)
    setFollowing(true);
    const el = scrollerElRef.current;
    requestAnimationFrame(() => requestAnimationFrame(() => scrollElementToTail(el)));
  }, [isActive, setFollowing]);

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

  const submit = useCallback(async (textOverride?: string) => {
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
    const typed = (textOverride ?? input).trim();
    const text = pathRefText ? (typed ? `${typed} ${pathRefText}` : pathRefText) : typed;
    if (!text) return;
    // Resolve the agent at SUBMIT time (not queue time) — a mode flipped
    // mid-turn must apply to the turn that actually runs (BET-949). Only send
    // it when plan is genuinely available AND on.
    const planAgent = plan.available && plan.on ? plan.agent : undefined;
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
    setRunning(true); // optimistic — session.status will confirm
    setInput("");
    // Snap the branch indicator to current truth on every submit.
    refreshBranch(cwd);
    // Forge state rides the same "ask the box" moment — a submit is the other
    // trigger (with the branch poll) for re-deriving the session's PR/checks.
    void refreshForge(cwd);
    // If the pinned todo list is fully terminal, hide the stale checklist.
    if (activeTodosRef.current && allTodosTerminal(activeTodosRef.current)) {
      setTodosDismissed(true);
    }

    // Optimistic transcript append — show the user's message NOW. The next
    // message-refetch (triggered by SSE) will overwrite `messages` entirely
    // with the canonical state.
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
    // Force-pin to the tail. The scroll is deferred to the force-tail effect
    // because the optimistic row above has not been committed yet — scrolling
    // here would land on the previous last message.
    forceTailRef.current = true;

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
          await clearSessionRef.current();
        } else if (cmdName === "fork") {
          await forkSessionRef.current();
        } else if (cmdName === "compact") {
          await compactSessionRef.current();
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
          agent: planAgent,
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
          planAgent,
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
    // tmuxSession/windowIndex key the per-window prompt-history list (line
    // 720) — if they moved to a different owning window, submit must use the
    // NEW window's history, so they're deps. activeTodos + the session ops
    // (clear/fork/compact) are read via their ref mirror below (declared after
    // submit in this file — the established commandsRef pattern) so submit
    // always sees their current value without them re-rotating this callback.
  }, [input, running, sessionId, modelOverride, attachments, agentMentions, tmuxSession, windowIndex, plan]);

  // Always-current ref to submit — lets the queued-message effect call the
  // latest version without adding submit to the effect's dependency array
  // (which would re-arm the effect on every keystroke).
  submitRef.current = submit;

  // Post-commit half of submit()'s force-pin. Runs once per submit (the ref
  // gate), after React has committed the optimistic user row and after the
  // composer has resized, which is what makes `index: "LAST"` resolve to the
  // message the user just sent. Ordinary streaming stickiness is still
  // Virtuoso's followOutput — this effect does nothing when the ref is unset.
  useEffect(() => {
    if (!forceTailRef.current) return;
    forceTailRef.current = false;
    scrollToTail();
  }, [messages, scrollToTail]);

  // Optimistic "new session" auto-submit: seed the composer with the draft's
  // prompt and fire the panel's OWN submit once, on mount. Going through submit
  // (rather than calling opencodePrompt directly) gives the optimistic user
  // message + running indicator immediately, exactly like a normal send. The
  // defer is load-bearing: setInput runs synchronously, and submit is deferred
  // so the re-render reassigns submitRef.current to a closure holding the new
  // input (same rule as the queued-drain effect). A ref guard keeps it to one
  // submission even if the autoSubmit prop identity churns.
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (!autoSubmit || autoSubmitted.current) return;
    autoSubmitted.current = true;
    const { text, model } = autoSubmit;
    setModelOverride(model ?? null);
    setInput(text);
    // Clear the one-shot INSIDE the fired timeout, never in the effect body.
    // Clearing the store flips autoSubmit → undefined, which re-runs this
    // effect's cleanup (clearTimeout) and would cancel the deferred submit
    // before it fires — the exact "prompt never sent / blank session" bug.
    // The text is passed EXPLICITLY to submit (textOverride) so we don't depend
    // on the setInput re-render having committed before the timer fires.
    const t = setTimeout(() => {
      useStore.getState().setAutoSubmitPrompt(null);
      submitRef.current?.(text);
    }, 0);
    return () => {
      clearTimeout(t);
      // Reset the guard in the cleanup so a React 18 StrictMode double-mount
      // (setup → cleanup → setup, both before any timeout fires) re-arms the
      // timer. Without this, the ref set in the first setup persists into the
      // second, which bails early on autoSubmitted — the composer is seeded
      // but the prompt is never sent: a blank new session with the text stuck
      // in the input. Each setup clears its predecessor's timer in its own
      // cleanup, so there is still exactly one submission per autoSubmit value.
      autoSubmitted.current = false;
    };
  }, [autoSubmit, setModelOverride, setInput]);

  // BET-795: inbox "Start a session" — seed the composer (setInput) but do NOT
  // submit. One-shot via the same ref guard idiom as autoSubmit. Clearing the
  // store flips seedPrompt → undefined; clearing inside the timeout (never the
  // effect body) keeps the effect's own cleanup from racing the clear.
  const seedApplied = useRef(false);
  useEffect(() => {
    if (!seedPrompt || seedApplied.current) return;
    seedApplied.current = true;
    setInput(seedPrompt.text);
    const t = setTimeout(() => {
      useStore.getState().setSeedPrompt(null);
    }, 0);
    return () => {
      clearTimeout(t);
      seedApplied.current = false;
    };
  }, [seedPrompt, setInput]);

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
    async (
      requestId: string,
      reply: "once" | "always" | "reject",
      recordSessionId?: string,
    ) => {
      // Optimistically drop this request so the card disappears immediately.
      setPermissions((prev) => prev.filter((p) => p.id !== requestId));
      // Clear the sidebar attention dot immediately — the SSE round-trip can
      // be missed, leaving the red `!` stuck.
      useStore.getState().setChatAttention(sessionId, null);
      // Route the reply to the request's OWN session, not the panel's. A
      // background job's permission lives on the job's child session; the
      // record carries that sessionID. Fall back to the viewed session for
      // the panel's own requests (BET-380 decision #8).
      const sid = recordSessionId ?? sessionId;
      try {
        await window.api.opencodePermissionReply(requestId, reply, sid);
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

  // Kept for the picker button's onOpen — no-op now that we pre-fetch.
  const ensureModels = useCallback(async () => { /* noop */ }, []);

  // Active model used for the NEXT prompt. modelOverride wins; otherwise the
  // server default. Used to look up capability flags (attachment support) and
  // the context-window limit. Resolution lives in chatShared so ModelPicker
  // and ChatPanel share one path (BET-415 duplication gate).
  const activeModel = useMemo<OpencodeModel | null>(
    () => resolveActiveModel(models, modelOverride, defaultModel),
    [models, modelOverride, defaultModel],
  );
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

  // If a saved model (in EITHER per-mode key) references one that isn't in the
  // current list of connected models (common after switching providers or fixing
  // listModels' source endpoint), clear it. Otherwise the server rejects the
  // prompt with a not-found error and nothing reaches the transcript. Heals both
  // keys (BET-950) so a stale model in the inactive mode's key is dropped too.
  // Reads each mode's RAW key (not readSavedModel, whose plan→build fallback
  // would mask which key actually held the stale value).
  useEffect(() => {
    if (!models) return;
    const isStale = (sel: { providerID: string; modelID: string }) =>
      !models.some((m) => m.providerID === sel.providerID && m.id === sel.modelID);
    const heal = (mode: ModelMode) => {
      let saved: ModelSelection | null = null;
      try {
        const raw = localStorage.getItem(modelKey(sessionId, mode));
        if (raw) {
          const p = JSON.parse(raw);
          if (p && typeof p.providerID === "string" && typeof p.modelID === "string") {
            saved = p as ModelSelection;
          }
        }
      } catch { /* non-JSON / disabled storage — nothing to heal */ }
      if (!saved || !isStale(saved)) return;
      writeSavedModel(sessionId, mode, null);
      // Drop the active override when the cleared key is what's in play: the
      // active mode's own key, or the build fallback a plan session is using.
      const active: ModelMode = planOn ? "plan" : "build";
      if (mode === active) setModelOverride(null);
      else if (modelOverride && modelOverride.providerID === saved.providerID
        && modelOverride.modelID === saved.modelID) setModelOverride(null);
    };
    heal("build");
    heal("plan");
  }, [models, modelOverride, planOn, sessionId]);

  const selectModel = useCallback(
    (m: ModelSelection | null) => {
      const mode: ModelMode = planOn ? "plan" : "build";
      setModelOverride(m);
      writeSavedModel(sessionId, mode, m);
    },
    [sessionId, planOn],
  );

  // App-control (BET-840/841): expose this panel's `selectModel` to App so the
  // box's `switch-model` app-control event drives the override through the same
  // path the picker uses (setModelOverride + writeSavedModel). Re-registers on
  // session change; unregisters on unmount so a closed panel can't be reached.
  useEffect(() => {
    registerModelControl?.(sessionId, selectModel);
    return () => unregisterModelControl?.(sessionId);
  }, [sessionId, selectModel, registerModelControl, unregisterModelControl]);


  // Session ops. All three depend on tmuxSession/windowIndex being non-null
  // (the panel hides the buttons otherwise). The store will pick up the new
  // project list automatically via the next refresh / sync delta call.
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

  // Clear session — extracted from the /clear slash-command path so the
  // SessionHeader menu (and the context popover's "Clear session" button)
  // can call it directly without routing through the composer. Same logic:
  // opencodeClearSession swaps in a new session id; the model override is
  // carried forward so the user doesn't re-pick after every clear.
  const clearSession = useCallback(async () => {
    if (!tmuxSession || windowIndex == null) {
      setSendError("Can't clear — no owning tmux window.");
      return;
    }
    setSendError(null);
    try {
      const cleared = await window.api.opencodeClearSession({
        sessionName: tmuxSession,
        windowIndex,
        cwd: cwd ?? "",
        title: `${tmuxSession} / cleared`,
      });
      // /clear carries BOTH per-mode model keys forward (BET-950) so the user
      // doesn't re-pick after every clear. copySavedModels preserves their
      // independence; plan mode state is carried on top.
      if (cleared?.newSessionId) {
        copySavedModels(sessionId, cleared.newSessionId);
        if (planOn) {
          writePlanSaved(cleared.newSessionId, true);
        }
      }
      await refresh();
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
  }, [tmuxSession, windowIndex, cwd, planOn, refresh]);

  // Current-value ref mirrors for `submit` — declared AFTER submit in this file
  // (the established commandsRef pattern), so submit reads these instead of
  // taking the callbacks as deps (which would hit the TDZ at submit's
  // declaration line). Kept current each render.
  const forkSessionRef = useRef(forkSession);
  forkSessionRef.current = forkSession;
  const compactSessionRef = useRef(compactSession);
  compactSessionRef.current = compactSession;
  const clearSessionRef = useRef(clearSession);
  clearSessionRef.current = clearSession;

  // Delete session — kills the tmux window + opencode session. Reaches the
  // same IPC the mobile ⋯ sheet uses.
  const deleteSession = useCallback(async () => {
    if (!tmuxSession || windowIndex == null) return;
    setSendError(null);
    try {
      await window.api.opencodeDeleteSession({
        sessionId,
        sessionName: tmuxSession,
        windowIndex,
      });
      await refresh();
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
  }, [sessionId, tmuxSession, windowIndex, refresh]);

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
  const voice = useVoice({
    input,
    setInput,
    inputRef,
    submitRef,
    setSendError,
    setSystemNotice,
    groqApiKey: useStore((s) => s.groqApiKey),
    sessionId,
    setPendingVoiceNote,
    setVoiceNotes,
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

  // Patch one attachment by id with a Partial<Attachment>. The single owner of
  // the "uploading" -> "ready" (with remotePath) / -> "error" (with errorMsg)
  // state transition, reused by every upload path (drag-drop, paste,
  // screenshot) so they never repeat a setAttachments closure (duplication-
  // gate).
  const patchAttachment = useCallback(
    (id: string, patch: Partial<Attachment>) => {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

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

      // Settle each chip once its upload finishes: route every completion /
      // failure through the shared patchAttachment owner (this used to be a
      // local settleChip that duplicated it — BET-732).
      const settleReady = (id: string, rp: string | null) =>
        patchAttachment(
          id,
          rp
            ? { status: "ready", remotePath: rp }
            : { status: "error", errorMsg: "Upload returned no path" },
        );

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
          for (const p of pathPending) patchAttachment(p.id, { status: "error", errorMsg: msg });
          return;
        }
        pathPending.forEach((p, i) => settleReady(p.id, remotePaths[i] ?? null));
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
            settleReady(p.id, rp || null);
          } catch (e) {
            patchAttachment(p.id, { status: "error", errorMsg: String((e as Error)?.message ?? e) });
          }
        }),
      );

      await Promise.all([pathBatch, byteBatch]);
    },
    [tmuxSession, patchAttachment],
  );

  // Mobile ⋯ sheet → attach-files bridge (BET-260). The hidden <input
  // type="file"> inside SessionScreen's ⋯ sheet dispatches this with the
  // user's selected File[]; we hand them to addDroppedFiles, which already
  // runs the byte path on mobile (getPathForFile → ""), renders the
  // uploading→ready chip, and converts ready media chips into FileParts at
  // submit. No new upload code lives here. The listener sits next to
  // addDroppedFiles so the function is in scope (the existing mobile
  // bridges — manta-scroll-to-question, manta-run-clear — sit higher up
  // because they only need state primitives declared earlier).
  useEffect(() => {
    const onAttachFiles = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { sessionId?: string; files?: File[] }
        | undefined;
      if (detail?.sessionId !== sessionId) return;
      const files = detail?.files ?? [];
      if (files.length === 0) return;
      void addDroppedFiles(files);
    };
    window.addEventListener("manta-attach-files", onAttachFiles);
    return () => window.removeEventListener("manta-attach-files", onAttachFiles);
  }, [sessionId, addDroppedFiles]);

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
          patchAttachment(id, { status: "ready", remotePath });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err);
          patchAttachment(id, { status: "error", errorMsg: msg });
        }
      }
    },
    [tmuxSession],
  );

   // ===== Pending screenshots =====
   //
   // Also lives in the store (App.tsx reads the bytes + records them). Only
   // the active panel renders + acts on them; acting clears the global
   // records.

   const pendingScreenshots = useStore((s) => s.pendingScreenshots);
   const removePendingScreenshots = useStore((s) => s.removePendingScreenshots);

   // Attach one or more pending screenshots. The bytes were already read at
   // detection (App.tsx), so this is now just "make a chip, upload the bytes" —
   // the same tail every other upload path runs. Accepting one and accepting
   // all are the same call with a different array.
   const acceptScreenshots = useCallback(
     (shots: PendingScreenshot[]) => {
       removePendingScreenshots(shots.map((s) => s.id));
       if (!tmuxSession) return;
       for (const shot of shots) {
         const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
         setAttachments((prev) => [
           ...prev,
           { id, filename: shot.filename, mime: "image/png", status: "uploading", source: "paste" } as Attachment,
         ]);
         void (async () => {
           try {
             const remotePath = await window.api.uploadBuffer({
               projectName: tmuxSession,
               filename: shot.filename,
               buffer: shot.bytes,
             });
             if (!remotePath) throw new Error("Upload failed");
             patchAttachment(id, { status: "ready", remotePath });
           } catch (err) {
             patchAttachment(id, { status: "error", errorMsg: String((err as Error)?.message ?? err) });
           }
         })();
       }
     },
     [tmuxSession, removePendingScreenshots, patchAttachment],
   );

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
  // that empty object, which made `ctxTokens === 0` and hid the context bar
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
      // `tokens` is declared on OpencodeMessageInfo (BET-733/L10) — shape
      // matches AssistantMessage.tokens from the OpenAPI doc.
      const t = info.tokens;
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
    if (!isActive) return; // BET-730: hidden panels don't need staleness ticks
    if (running) return;
    if (lastAssistantCompletion == null) return;
    if (cachedTokens < STALE_CACHE_MIN_TOKENS) return;
    const id = setInterval(() => setStaleTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [running, lastAssistantCompletion, cachedTokens, isActive]);
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

  // Context breakdown for the SessionHeader pill + popover (BET-415). The
  // denominator is the active model's real context window so the pill
  // reflects what the provider will actually accept on the next request.
  const ctxLimit = useMemo(
    () => resolveContextLimit(activeModel),
    [activeModel],
  );
  const ctxBreakdown = useMemo(
    () => computeContextBreakdown(latestTokens, ctxLimit),
    [latestTokens, ctxLimit],
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
  // Current-value ref mirror for `submit` (declared after submit — commandsRef
  // pattern) so submit's todos auto-dismiss reads the latest activeTodos even
  // though activeTodos itself can't appear in submit's dep array.
  const activeTodosRef = useRef(activeTodos);
  activeTodosRef.current = activeTodos;

  // Turn boundary metadata: which assistant messages are the FINAL one of
  // their turn (i.e., immediately followed by a user message or end-of-list),
  // the cumulative duration of that turn (first assistant `created` →
  // last assistant `completed`), and the turn's total output tokens (read off
  // the last assistant message's `info.tokens.output` — the same persisted,
  // transcript-derived source the context bar uses, so it survives refresh).
  // Intermediate assistant messages within a multi-step turn get no footer —
  // only the final one does. While the turn is running, the footer is gated off
  // its still-streaming final assistant message (it would render behind the
  // working indicator); it appears once running flips false.
  const turnInfo = useMemo(
    () => computeTurnInfo(messages, running),
    [messages, running],
  );

  // Live metrics of the in-flight turn (startedAt, tokens, verb seed) for the
  // working row at the transcript tail. Recomputes on every messages change;
  // the row's per-second clock tick advances its elapsed label in place.
  const liveTurn = useMemo(() => computeLiveTurn(messages), [messages]);

  // ===== Session progress (BET-790/791) =====
  // Live "where is this turn right now" state served by `progress:get`,
  // refreshed on the `progress.updated` bus event (no poll). The server clamps
  // step monotonicity — the renderer only displays what it returns and never
  // re-derives a regressing step. Follows the established live-event-preferred
  // pattern (same as liveTodos): separate state from messages, reset on
  // session change, so a canonical transcript refetch cannot overwrite it.
  const [liveProgress, setLiveProgress] = useState<ProgressRecord | null>(null);
  const blockedRef = useRef(false);
  useEffect(() => {
    let active = true;
    setLiveProgress(null);
    blockedRef.current = false;
    const load = () => {
      window.api
        .progressGet(sessionId)
        .then((r) => {
          if (!active) return;
          setLiveProgress((r as ProgressRecord | null) || null);
        })
        .catch(() => { /* non-fatal — progress is ambient */ });
    };
    void load();
    const unsub = window.api.onProgressUpdated?.((p: { sessionID?: string }) => {
      if (p.sessionID && p.sessionID === sessionId) void load();
    });
    return () => {
      active = false;
      unsub?.();
    };
  }, [sessionId]);

  // `blocked` lights the same sidebar attention dot a pending question does,
  // reusing the existing setChatAttention latch (no parallel mechanism). It is
  // cleared only when we ourselves set it, so a concurrent question's latch is
  // never wiped — the model reports a different state (or the turn ends) and
  // the store's setActive clears the dot when the user focuses the window.
  useEffect(() => {
    const kind = progressAttentionKind(liveProgress?.state ?? null);
    // The rail-row tooltip label: only a WORKING turn's model-authored label
    // (blocked yields to its card, done/failed to the turn ending).
    const label =
      liveProgress?.state === "working" && liveProgress.label?.trim()
        ? liveProgress.label
        : null;
    useStore.getState().setChatProgressLabel(sessionId, label);
    if (kind) {
      blockedRef.current = true;
      useStore.getState().setChatAttention(sessionId, "blocked");
    } else if (blockedRef.current) {
      blockedRef.current = false;
      useStore.getState().setChatAttention(sessionId, null);
    }
  }, [liveProgress, sessionId]);

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

  // BET-837: user-message-id → voice-note map. Passed to MessageRow exactly
  // like userCommandInfo — an O(1) Map lookup in messages.map, never an object
  // literal built inside the callback (that would defeat the row memo and
  // reintroduce documented keystroke lag).
  const voiceNoteByMessageId = useMemo(
    () => buildVoiceNoteMap(messages, voiceNotes),
    [messages, voiceNotes],
  );

  // Retry transcription for a note whose transcript came back empty (the 409
  // send path). On success append the (now-transcribed) record and clear the
  // pending row; the transcript flows through as a normal user message exactly
  // as a non-retry send would.
  const retryVoiceNote = useCallback(
    async (noteId: string) => {
      if (!pendingVoiceNote) return;
      const prev = pendingVoiceNote;
      setPendingVoiceNote({ ...prev, error: undefined });
      try {
        const res = await window.api.voiceRetryNote(noteId);
        if (res.ok && res.transcript) {
          const current = pendingVoiceNote;
          setVoiceNotes((existing) => {
            if (existing.some((n) => n.id === noteId)) return existing;
            return [
              ...existing,
              {
                id: noteId,
                sessionId,
                transcript: res.transcript,
                mime: "audio/webm",
                durationMs: current?.durationMs ?? 0,
                peaks: current?.peaks ?? new Uint8Array(0),
                createdAt: Date.now(),
                expiresAt: null,
                audioAvailable: true,
              },
            ];
          });
          setPendingVoiceNote(null);
          const text = res.transcript.trim();
          if (!text) return;
          setInput((prev) => (prev ? `${prev}\n${text}` : text));
          setTimeout(() => submitRef.current?.(), 0);
          return;
        }
        setPendingVoiceNote({ ...prev, noteId, error: res.ok ? "Transcription failed" : res.error });
      } catch (e) {
        setPendingVoiceNote({ ...prev, noteId, error: e instanceof Error ? e.message : String(e) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingVoiceNote, sessionId],
  );

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
      childLoadedAllRef,
      loadEarlierChild: loadEarlierChildTranscript,
      loadingChildEarlier,
      liveStatus: liveChildStatus,
      showThinking,
    }),
    [
      expandedTasks,
      toggleTaskExpand,
      childMessages,
      loadEarlierChildTranscript,
      loadingChildEarlier,
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

  // BET-659: lift this session's live transcript into the store so the
  // Artifacts panel can derive artifacts without a second opencodeMessages
  // fetch. `messages` only changes on an actual transcript commit (never on a
  // keystroke re-render), and setChatMessages no-ops when the reference is
  // unchanged, so this costs nothing during typing.
  useEffect(() => {
    setChatMessages(sessionId, messages ?? []);
  }, [sessionId, messages, setChatMessages]);
  // Clear the store entry on unmount / session change so a stale transcript
  // from the previous session doesn't linger in the artifacts derivation.
  useEffect(() => {
    return () => setChatMessages(sessionId, []);
  }, [sessionId, setChatMessages]);


  // ===== Pinned card stack (BET-783) =====
  // The cards that mount above the composer used to be ten hardcoded CardMount
  // blocks in JSX order, so the transcript was the only flexible child and a
  // permission request could land below three ambient cards. They are now DATA
  // — a list the pure `arrangeCards` arbiter (via <CardStack/>) sorts into a
  // blocking tier (always above ambient, at most one expanded) and an ambient
  // tier (fixed priority, at most two expanded, the rest rolled up).
  const AMBIENT_CARD: Record<string, { order: number; label: string }> = {
    retry: { order: 7, label: "↻ retry" },
    compaction: { order: 6, label: "↧ compaction" },
    "send-error": { order: 5, label: "⚠ error" },
    queued: { order: 4, label: "⏳ queued" },
    schedules: { order: 3, label: "⏰ schedule" },
    secrets: { order: 2, label: "🔑 secret" },
    webhooks: { order: 1, label: "🪝 webhook" },
  };
  // Monotonic first-seen arrival counter for blocking cards (BET-783 reviewer
  // Block). Records each blocking ask's true interleaved arrival across
  // permission requests AND delegate-approval, so "newest" is real arrival
  // order — NOT derived from the live array length. Deriving delegate's order
  // from `permissions.length` always out-ranks every newer permission, which
  // is exactly the "urgent thing demoted" failure this issue prevents. The
  // idempotent `map.size` assignment survives React StrictMode double-render
  // (second pass finds the id already present) and the per-session-instance
  // lifetime (ChatPanel is keyed by session id in App) makes it self-resetting.
  const blockingArrival = useRef<Map<string, number>>(new Map());

  // ===== Plan card (BET-951) =====
  // The plan_exit question is upgraded into a blocking plan card in the pinned
  // card stack. Detection is EXACT — `isPlanExitQuestion` matches the question's
  // `tool.callID` against a `plan_exit` tool part in the transcript, never the
  // question text. These are also EXCLUDED from the inline transcript question
  // rendering below so they never appear twice (once inline as a generic
  // QuestionCard, once in the stack).
  const planQuestions = useMemo(
    () => questions.filter((q) => isPlanExitQuestion(q, messages)),
    [questions, messages],
  );
  const planDataByQuestion = useMemo(
    () => new Map(planQuestions.map((q) => [q.id, extractPlanData(q, messages)])),
    [planQuestions, messages],
  );

  // Delegate split control (BET-951).
  // Level 3 of the model precedence — "same as current" means the BUILD model,
  // not the plan model the composer chip may be showing while plan mode is on.
  // Until per-mode models land there is only one model per session and this is
  // simply the active model, but the lookup keeps working when they arrive.
  const sessionModel = useMemo<ModelSelection | null>(
    () =>
      modelOverride ??
      (defaultModel
        ? { providerID: defaultModel.providerID, modelID: defaultModel.modelID }
        : null),
    [modelOverride, defaultModel],
  );
  const delegateSelectable = useMemo(
    () => selectableModelGroups(models, deactivatedMainModels),
    [models, deactivatedMainModels],
  );
  // Level 2 — the remembered delegation model for this project (written ONLY on
  // an explicit pick; an inherited default is never promoted into it).
  const delegateProjectKey = tmuxSession ?? sessionId;
  const rememberedDelegateModel = useMemo(
    () => readSavedDelegateModel(delegateProjectKey),
    [delegateProjectKey],
  );
  // Hard cap of five concurrent background jobs, box-wide (MAX_RUNNING_JOBS in
  // src/server/delegate.mjs). At the cap the split control is disabled with a
  // title saying so, rather than accepting the click and failing after.
  const runningDelegates = useMemo(
    () => Object.values(jobs).filter((j) => j.status === "running").length,
    [jobs],
  );
  const atDelegateCap = runningDelegates >= 5;

  const rememberDelegateModel = useCallback(
    (m: ModelSelection | null) => writeSavedDelegateModel(delegateProjectKey, m),
    [delegateProjectKey],
  );

  const buildPlanPrompt = useCallback(
    (q: QuestionRequest, feedback: string) => {
      const text = extractPlanData(q, messages).text;
      const trimmed = feedback.trim();
      return trimmed ? `${text}\n\n${trimmed}` : text;
    },
    [messages],
  );

  const buildHere = useCallback(
    async (q: QuestionRequest, feedback: string) => {
      // Answer "Yes" so opencode switches to the build agent...
      await replyQuestion(q, [["Yes"]]);
      // ...then re-send the plan text ourselves WITH the BUILD model. opencode's
      // "Yes" path stamps the injected build turn with the model of the last
      // user message — which, because MantaUI sends the model per prompt, is the
      // PLAN model. That is exactly why this is a resubmit, not a toggle.
      setPlanOn(false);
      writePlanSaved(sessionId, false);
      try {
        await window.api.opencodePrompt(
          sessionId,
          buildPlanPrompt(q, feedback),
          sessionModel ?? undefined,
          [],
          undefined,
          undefined,
        );
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
      }
    },
    [replyQuestion, sessionId, sessionModel, buildPlanPrompt, setPlanOn],
  );

  const keepPlanning = useCallback(
    async (q: QuestionRequest, feedback: string) => {
      // Answer "No" → RejectedError, plan mode STAYS ON.
      await replyQuestion(q, [["No"]]);
      // If the user asked for a change, hand that back to the plan agent so it
      // refines the plan (still in plan mode — no edits).
      const trimmed = feedback.trim();
      if (trimmed) {
        const planAgent = plan.available && plan.on ? plan.agent : undefined;
        try {
          await window.api.opencodePrompt(sessionId, trimmed, undefined, [], undefined, planAgent);
        } catch (e) {
          setSendError(String((e as Error)?.message ?? e));
        }
      }
    },
    [replyQuestion, sessionId, plan],
  );

  const startPlanDelegate = useCallback(
    (q: QuestionRequest, m: ModelSelection | null, feedback: string) => {
      return window.api
        .delegateStart({
          prompt: buildPlanPrompt(q, feedback),
          sessionID: sessionId,
          directory: cwd,
          model: m ? { providerID: m.providerID, modelID: m.modelID } : undefined,
        })
        .catch((e: unknown) => {
          setSendError(String((e as Error)?.message ?? e));
        });
    },
    [buildPlanPrompt, sessionId, cwd],
  );

  // The PlanCard's "Open page" URL. Single-HTML plans are published by the
  // model's plan_render tool under the DETERMINISTIC per-session subdomain
  // (`<base>/pages/plan-<shortSessionId>`); there is no eager-publish state and
  // no `.md` publish path. serverBase may be unavailable (no server
  // configured); then there is simply no URL.
  const planCardUrl = useMemo(() => {
    try {
      return planPageUrl(sessionId, serverBase());
    } catch {
      return "";
    }
  }, [sessionId]);

  // The plan_exit card, built here and mounted in the transcript tail the SAME
  // way the questions are (it used to be pinned in the CardStack). Building the
  // element here keeps the closures over the plan data + the deterministic
  // URL; Transcript just mounts it. The stable `key={q.id}` preserves the
  // card's internal state (feedback / open model menu) across updates.
  //
  // ONE pending-action state drives the loading/disabled of all three actions
  // (Build here / Delegate / Send feedback) while their async call is in
  // flight — SQL no loading state existed before.
  const [pendingAction, setPendingAction] = useState<"build" | "delegate" | "feedback" | null>(null);
  const planCard = useMemo(() => {
    for (const q of planQuestions) {
      const data = planDataByQuestion.get(q.id);
      if (!data) continue;
      return (
        <PlanCard
          key={q.id}
          data={data}
          models={delegateSelectable}
          remembered={rememberedDelegateModel}
          sessionModel={sessionModel}
          buildModelName={activeModel?.name ?? ""}
          atDelegateCap={atDelegateCap}
          busy={pendingAction}
          onBuildHere={(fb) => {
            setPendingAction("build");
            void buildHere(q, fb).finally(() => setPendingAction(null));
          }}
          onSendFeedback={(fb) => {
            setPendingAction("feedback");
            void keepPlanning(q, fb).finally(() => setPendingAction(null));
          }}
          onStartDelegate={(m, fb) => {
            setPendingAction("delegate");
            void startPlanDelegate(q, m, fb).finally(() => setPendingAction(null));
          }}
          onRememberDelegateModel={rememberDelegateModel}
          planUrl={planCardUrl}
          onOpenInBrowser={() => {
            if (planCardUrl) void window.api.openExternal(planCardUrl).catch(() => { /* best-effort */ });
          }}
        />
      );
    }
    return null;
  }, [planQuestions, planDataByQuestion, delegateSelectable, rememberedDelegateModel, sessionModel, activeModel, atDelegateCap, pendingAction, buildHere, keepPlanning, startPlanDelegate, rememberDelegateModel, planCardUrl]);

  const cards = useMemo<PinnedCardRender[]>(() => {
    const list: PinnedCardRender[] = [];
    const block = (id: string, order: number, render: React.ReactNode): PinnedCardRender =>
      ({ id, tier: "blocking", order, render });
    const amb = (id: string, render: React.ReactNode): PinnedCardRender =>
      ({ id, tier: "ambient", order: AMBIENT_CARD[id].order, label: AMBIENT_CARD[id].label, render });
    const blockOrder = (id: string): number => {
      const map = blockingArrival.current;
      let order = map.get(id);
      if (order === undefined) {
        order = map.size;
        map.set(id, order);
      }
      return order;
    };
    // Blocking tier — permission requests + delegate-approval, newest first.
    if (!jobOwnership) {
      permissions.forEach((p) => list.push(block(
        `permission-${p.id}`, blockOrder(`permission-${p.id}`),
        <PermissionCard
          key={p.id}
          perm={p}
          onReply={(reply) => replyPermission(p.id, reply, p.sessionID)}
        />,
      )));
      if (pendingApproval) list.push(block(
        `delegate-${pendingApproval.id}`, blockOrder(`delegate-${pendingApproval.id}`),
        <DelegateApprovalCard
          approval={pendingApproval}
          onApprove={(tools: DelegateApprovalTool[]) => {
            const id = pendingApproval.id;
            setPendingApproval(null);
            void window.api.delegateApprove(id, tools).catch(() => { /* best-effort */ });
          }}
          onDecline={() => {
            const id = pendingApproval.id;
            setPendingApproval(null);
            void window.api.delegateDecline(id).catch(() => { /* best-effort */ });
          }}
          />,
        ));
      // BET-791 [C9]: a model reporting it has STOPPED and needs a human
      // decision earns the one card `blocked` gets — a warn-toned ask in the
      // blocking tier, alongside permission and question, never below an
      // ambient card. It is not dismissible by ×; it clears when the model
      // reports a different state or the turn ends.
      if (liveProgress?.state === "blocked") {
        list.push(block(
          "progress-blocked", blockOrder("progress-blocked"),
          <BlockedProgressCard progress={liveProgress} />,
        ));
      }
      // NOTE: the plan_exit card (PlanCard) is intentionally NOT here any more
      // — it now renders in the transcript tail, mounted the same way as the
      // question cards (see `planCard`, passed to <Transcript>).
    }
    // Ambient tier — fixed priority, independent of arrival order.
    if (retryInfo) list.push(amb("retry",
      <div className="shrink-0 px-4 pt-2"><RetryCard info={retryInfo} /></div>));
    if (compactionState) list.push(amb("compaction",
      <div className="shrink-0 px-4 pt-2"><CompactionCard state={compactionState} /></div>));
    if (sendError) list.push(amb("send-error",
      <div className="shrink-0 mx-4 mb-1 px-2 py-1 text-meta text-danger bg-danger-bg border border-danger/30 rounded-xs break-words flex items-start gap-2">
        <span className="flex-1">⚠ {sendError}</span>
        {authReconnect && (
          <button onClick={openAuthReconnect} className="text-danger hover:text-danger underline leading-none px-1" title={`Reconnect ${authReconnect}`}>
            Reconnect
          </button>
        )}
        <button onClick={() => setSendError(null)} className="text-danger hover:text-danger leading-none px-1 inline-flex items-center" title="Dismiss" aria-label="Dismiss error">
          <X size={14} aria-hidden="true" />
        </button>
      </div>));
    if (running && messageQueue.length > 0) list.push(amb("queued",
      <MeasureColumn>
        <div className="shrink-0 pb-2 flex flex-col text-meta text-text-faint" style={{ gap: "var(--block-gap)" }}>
          {messageQueue.map((msg, i) => (
            <div key={i} className="flex items-baseline gap-1">
              <Clock size={14} aria-hidden="true" className="shrink-0 self-center" />
              <span className="italic flex-1 truncate">{msg}</span>
              <button onClick={() => setMessageQueue((q) => q.filter((_, j) => j !== i))} className="ml-1 text-text-faint hover:text-text leading-none shrink-0 inline-flex items-center" title="Remove from queue" aria-label="Remove from queue">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </MeasureColumn>));
    if (!jobOwnership) {
      if (openPanel === "schedules") list.push(amb("schedules",
        <div className="shrink-0 px-4 pt-2 pb-2">
          <ScheduledTasksCard
            jobs={schedules}
            error={scheduleError}
            onClose={closePanel}
            onDelete={(id) => {
              setSchedules((prev) => prev.filter((j) => j.id !== id));
              window.api.scheduleDelete(id).then(() => refreshSchedules()).catch((e: unknown) => {
                setScheduleError(e instanceof Error ? e.message : "delete failed");
                void refreshSchedules();
              });
            }}
          />
        </div>));
      if (openPanel === "secrets") list.push(amb("secrets",
        <div className="shrink-0 px-4 pt-2 pb-2">
          <SecretsCard
            secrets={secrets}
            error={secretError}
            sessionId={sessionId}
            onClose={closePanel}
            onSave={(input) => window.api.secretsSet(input).then((r) => {
              if (r && r.ok === false) { setSecretError(r.error || "save failed"); return false; }
              void refreshSecrets(); setSecretError(null); return true;
            }).catch((e: unknown) => {
              setSecretError(e instanceof Error ? e.message : "save failed"); return false;
            })}
            onDelete={(id) => {
              setSecrets((prev) => prev.filter((s) => s.id !== id));
              window.api.secretsDelete(id).then(() => refreshSecrets()).catch((e: unknown) => {
                setSecretError(e instanceof Error ? e.message : "delete failed");
                void refreshSecrets();
              });
            }}
          />
        </div>));
      if (openPanel === "webhooks") list.push(amb("webhooks",
        <div className="shrink-0 px-4 pt-2 pb-2">
          <WebhooksCard
            hooks={webhooks}
            error={webhookError}
            onClose={closePanel}
            onDelete={(id) => {
              setWebhooks((prev) => prev.filter((h) => h.id !== id));
              window.api.webhookDelete(id).then(() => refreshWebhooks()).catch((e: unknown) => {
                setWebhookError(e instanceof Error ? e.message : "delete failed");
                void refreshWebhooks();
              });
            }}
          />
        </div>));
    }
    return list;
  }, [jobOwnership, permissions, pendingApproval, retryInfo, compactionState, sendError, authReconnect, running, messageQueue, openPanel, schedules, scheduleError, secretError, secrets, webhooks, webhookError, closePanel, setSchedules, refreshSchedules, setScheduleError, setSendError, setMessageQueue, setPendingApproval, setSecrets, refreshSecrets, setSecretError, setWebhooks, refreshWebhooks, setWebhookError, sessionId, replyPermission, shipProposal, shipBusy, shipError, liveProgress]);


  if (error || transcriptLoadError) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-bg text-text-muted p-6 font-mono">
        <div className="max-w-md text-body text-center">
          <div className="font-semibold text-text mb-2">Couldn't load session</div>
          <pre className="whitespace-pre-wrap break-words text-meta text-text-faint">
            {transcriptLoadError ?? error}
          </pre>
          {transcriptLoadError && (
            <div className="mt-4 flex justify-center">
              <Button type="button" tone="default" onClick={retryTranscriptLoad}>
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!messages) {
    return (
      // The app's one waiting image, the same one iOS shows when a session
      // opens — replacing the generic grey ring that used to sit here.
      <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-bg text-text-faint text-body">
        <MantaLoader size="screen" label="Connecting to session" />
        <span>Connecting to session…</span>
      </div>
    );
  }


  return (
    <div
      className="h-full w-full flex flex-col bg-bg font-sans text-prose relative"
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
          className="absolute inset-2 z-30 pointer-events-none rounded-md border-2 border-dashed flex items-center justify-center"
          style={{
            borderColor: "var(--accent)",
            backgroundColor: "var(--accent-bg)",
          }}
        >
          <span className="text-body text-text" style={{ color: "var(--accent)" }}>
            Drop to attach
          </span>
        </div>
      )}

      {/* Session header (BET-415): owns SESSION STATE — git branch, context
          usage pill + popover, and the session menu (fork / compact / clear /
          delete). The composer below owns only composing. */}
      <SessionHeader
        branch={branch}
        ctxBreakdown={ctxBreakdown}
        ctxLimit={ctxLimit}
        staleCache={staleCache}
        modelName={
          activeModel
            ? activeModel.name
            : null
        }
        hasSession={!!tmuxSession && windowIndex != null}
        readOnly={!!jobOwnership}
        onFork={() => void forkSession()}
        onCompact={() => void compactSession()}
        onClear={() => void clearSession()}
        onDelete={() => void deleteSession()}
        breadcrumb={projectName ? { project: projectName, window: winName } : null}
        mode={mode}
        onModeChange={onModeChange}
        availableLaunchers={availableLaunchers}
        artifactsOpen={artifactsOpen}
        onToggleArtifacts={onToggleArtifacts}
        hiddenStatusItems={hiddenStatusItems}
        pr={forge.pr}
        checks={forge.checks}
        checksRollup={forge.rollup}
        forgeConnected={forge.connected}
        forgeKind={forge.kind}
        forgeConnectOfferDismissed={forgeConnectOfferDismissed}
        onOpenExternal={(url) => void window.api.openExternal(url)}
        onReviewChanges={() =>
          void window.dispatchEvent(new CustomEvent("manta-open-review"))
        }
        onFillComposer={updateInputWithHistoryReset}
        onDismissForgeConnect={dismissForgeConnect}
        onConnectForge={openConnectGithub}
        onMerge={() => void doMerge()}
        mergeBusy={mergeBusy}
        mergeError={mergeError}
        shipBusy={shipBusy}
        shipError={shipError}
        shipBase={shipProposal?.base ?? null}
        shipFileCount={shipProposal?.fileCount ?? null}
        shipTitle={shipProposal ? shipProposal.title : null}
        justShipped={shipJustCreated}
        base={forge.base}
        aheadCount={forge.aheadCount}
        onCreatePr={() => void confirmShip()}
        onEnsureShipPreview={() => void ensureShipPreview()}
      />

      {/* The transcript region owns its own positioning context so the
          jump-to-latest button floats at the BOTTOM OF THE TRANSCRIPT — above
          the card stack and the composer, both of which change height. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <VoicePlaybackProvider active={isActive}>
          <Transcript
            messages={messages}
            virtuosoRef={virtuosoRef}
            sessionId={sessionId}
            setMessages={setMessages}
            loadedAllRef={loadedAllRef}
            taskContextValue={taskContextValue}
            showThinking={showThinking}
            running={running}
            liveTurn={liveTurn}
            progress={liveProgress}
            isActive={isActive}
            activeTodos={activeTodos}
            onDismissTodos={dismissTodos}
            // BET-418 §D: a job session is read-only — never show its (anyway
            // impossible) question cards. Defensive: a job's pre-flight ruleset
            // means it never generates asks.
            questions={jobOwnership ? [] : questions.filter((q) => !isPlanExitQuestion(q, messages))}
            turnInfo={turnInfo}
            finishByMessageId={finishByMessageId}
            userCommandInfo={userCommandInfo}
            voiceNoteByMessageId={voiceNoteByMessageId}
            pendingVoiceNote={pendingVoiceNote}
            onRetryVoiceNote={retryVoiceNote}
            onReplyQuestion={replyQuestion}
            onRejectQuestion={rejectQuestion}
            planCard={planCard}
            scrollerElRef={scrollerElRef}
            followingRef={followingRef}
            onFollowingChange={setFollowing}
            motionStateRef={motionStateRef}
          />
        </VoicePlaybackProvider>
        <button
          type="button"
          className="manta-jump-latest"
          data-shown={!following}
          aria-hidden={following}
          tabIndex={following ? -1 : 0}
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={scrollToTail}
        >
          <ArrowDown size={16} aria-hidden />
        </button>
      </div>

      {/* Pinned card stack above the composer (BET-783): blocking always
          above ambient, at most one blocking expanded, at most two ambient
          expanded (rest rolled up); the whole stack is capped at 30vh with
          internal scroll so the transcript stays the flexible child of the
          panel. Read-only job sessions (jobOwnership) never mount these — the
          ReadOnlyJobBar below replaces the composer instead. */}
      <CardStack cards={cards} sessionId={sessionId} />

      {jobOwnership ? (
        <ReadOnlyJobBar
          job={jobOwnership}
          modelName={
            resolveActiveModel(models, parseModelRef(jobOwnership.model), null)?.name ?? null
          }
          parentName={(() => {
            const pid = jobOwnership.parentSessionID;
            for (const p of projects) {
              const w = (p.windows || []).find((x) => x.opencodeSessionId === pid);
              if (w) return w.name ?? p.tmuxSession;
            }
            return null;
          })()}
          onGoToParent={() => {
            const pid = jobOwnership.parentSessionID;
            for (const p of projects) {
              const w = (p.windows || []).find((x) => x.opencodeSessionId === pid);
              if (w) {
                setActive(p.tmuxSession, w.index);
                return;
              }
            }
          }}
          onStop={() => {
            if (jobOwnership.status !== "running") return;
            void window.api
              .delegateStop(jobOwnership.id)
              .then(() => {
                // Optimistically flip this job to stopped in the store's jobs
                // slice (server `delegate.updated` refetch confirms shortly).
                const st = useStore.getState();
                const job = st.jobs[sessionId];
                if (!job) return;
                st.setJobs(
                  Object.values(st.jobs).map((j) =>
                    j.childSessionID === sessionId ? { ...j, status: "stopped" } : j,
                  ),
                );
              })
              .catch(() => { /* best-effort */ });
          }}
        />
      ) : (
      <Composer
        attachments={attachments}
        onRemoveAttachment={removeAttachment}
        onAttachFiles={(files) => void addDroppedFiles(files)}
        pendingScreenshots={isActive ? pendingScreenshots : []}
        onAcceptScreenshots={acceptScreenshots}
        onDiscardScreenshot={(id) => removePendingScreenshots([id])}
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
        modelLabel={modelLabel}
        chatAutoAllow={chatAutoAllow}
        setChatAutoAllow={setChatAutoAllow}
        voice={voice}
        models={models}
        modelOverride={modelOverride}
        defaultModel={defaultModel}
        plan={plan}
        onTogglePlan={togglePlan}
        activeProviderID={activeModel?.providerID ?? null}
        deactivatedMainModels={deactivatedMainModels}
        onOpenModels={ensureModels}
        onSelectModel={selectModel}
        scheduleCount={schedules.length}
        onSchedules={() => togglePanel("schedules")}
        onSecrets={() => togglePanel("secrets")}
        onWebhooks={() => togglePanel("webhooks")}
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
          // The setMessageQueue updater must stay pure (it's double-invoked
          // under StrictMode). Compute the popped value inside it, then run
          // the setInput + focus side effects AFTER — otherwise setInput and
          // the rAF fire twice per pop.
          let last: string | undefined;
          setMessageQueue((q) => {
            if (q.length === 0) return q;
            last = q[q.length - 1];
            return q.slice(0, -1);
          });
          if (last === undefined) return;
          setInput(last);
          requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(last!.length, last!.length);
          });
        }}
        onPaste={onPaste}
      />
      )}

      {/* BET-943: "Connect GitHub" device-code modal, opened from the session
          header's connect offer. Kept MOUNTED + gated by `open` (how `Modal`
          plays its exit animation). onConnected closes it and re-reads
          forgeStatus so the offer disappears and the checks/PR chips appear. */}
      <Modal
        open={connectGithubOpen}
        onDismiss={() => setConnectGithubOpen(false)}
        size="sm"
        padded={false}
        label="Connect GitHub"
      >
        <ConnectGithubPanel
          onConnected={() => {
            setConnectGithubOpen(false);
            if (cwd) void refreshForge(cwd);
          }}
          onCancel={() => setConnectGithubOpen(false)}
        />
      </Modal>
    </div>
  );
}
