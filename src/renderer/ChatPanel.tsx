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

import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components as MarkdownComponents } from "react-markdown";
import type {
  OpencodeAgent,
  OpencodeCommand,
  OpencodeEvent,
  OpencodeMessage,
  OpencodeModel,
  OpencodePart,
  PermissionRequest,
  QuestionRequest,
  ScheduledJob,
  SecretMeta,
  SecretScope,
} from "../shared/types";
import { useStore } from "./store";
import {
  useVoiceRecorder,
  fuzzyMatchModel,
  resolveQuestionAnswer,
  type VoiceMode,
  type VoicePhase,
} from "./voice";
import type { VoiceAction } from "../shared/types";
import {
  ASSUMED_CONTEXT_TOKENS,
  formatTokens,
  formatBytes,
  formatDuration,
  formatClockTime,
  ctxStageColor,
  filterCommands,
  dedupeAgainstBuiltins,
  resolveContextLimit,
  classifyFinish,
  describeTruncation,
  allTodosTerminal,
  selectActiveTodos,
  selectVisibleTodos,
  formatHiddenTodosSummary,
  registerChildSessionFromCreated,
  shouldDropEventForSessionFilter,
  applyQuestionEvent,
  hydrateQuestion,
  buildQuestionAnswers,
  canSubmitQuestion,
  detectCommandFromText,
  isAssistantTurnComplete,
  isAssistantTurnInProgress,
  computeContextBreakdown,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  computeStaleCache,
  STALE_CACHE_MIN_TOKENS,
  findFlushBoundary,
  mergeBufferedDeltas,
  extractSubagentInfo,
  collectChildSessionIds,
  countRunningSubagents,
  summarizeChildSession,
  classifyScrollForPin,
  wasAtBottomBeforeCommit,
  shouldAbortForQueuedDrain,
  isToolStepBoundary,
  isDrainAbortError,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  buildTitleInstruction,
  sanitizeGeneratedTitle,
  describeCron,
  describeNextRun,
  type TruncationKind,
  type ContextBreakdown,
  type StaleCacheResult,
  type PendingDelta,
} from "./chatUtils";

// In-flight attachments tracked alongside the textarea content. Each chip
// rendered above the input maps to one entry; `status` drives the chip
// appearance (uploading spinner vs. ready vs. error).
type Attachment = {
  id: string;                       // local id for keyed rendering / removal
  filename: string;
  remotePath?: string;              // set when upload finished or @-mention resolved
  mime: string;
  status: "uploading" | "ready" | "error";
  errorMsg?: string;
  source: "drop" | "paste" | "mention"; // "drop"/"paste" = scp'd to ~/.bui-uploads, "mention" = path from /find/file
  // When true this chip is NOT sent as a multimodal FilePart (the model
  // can't decode it — csv/code/text/etc). Instead its remote path is
  // appended to the outgoing message as `@<path>` so the AI reads it with
  // its Read tool. Keeps the composer clean instead of dumping the raw path.
  asPathRef?: boolean;
};

// Agent mention emitted by @-mention typeahead. We track the inserted slice
// of the textarea so we can compute {value, start, end} for the wire format
// at submit time, after the user may have edited around it.
type AgentMention = {
  id: string;
  name: string;
};

// Active typeahead popup state. The renderer tracks what we're matching and
// the [start, end) slice of the input string that the popup overlays — on
// selection we replace that slice with the canonical insertion text.
type TypeaheadState = {
  mode: "file" | "agent" | "command";
  query: string;
  anchorStart: number;
  anchorEnd: number;
  selectedIdx: number;
};

// A single row rendered in the typeahead popup. `kind` matches the trigger
// mode; `key` is the canonical identifier (path / name) we'll insert.
type TypeaheadRow = {
  kind: "file" | "agent" | "command";
  key: string;
  primary: string;            // user-visible label, e.g. "@src/foo" or "/init"
  secondary?: string;         // dim caption: command description / agent description
};

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

// Detect whether a model can accept file attachments. Two shapes in the wild:
//   /provider source:  capabilities = {attachment: bool, input: {image, pdf, ...}}
//   /api/model source: capabilities = {tools, input: ["text", "image", ...]}
// Treat "supports attachments" as: any non-"text" input modality.
function modelSupportsAttachments(m: OpencodeModel | null): boolean {
  const modes = modelInputModes(m);
  return modes.some((v) => v !== "text");
}

// Return the set of input modalities the model accepts (text, image, pdf,
// video, audio, ...). Empty array if unknown.
function modelInputModes(m: OpencodeModel | null): string[] {
  if (!m) return [];
  const caps = m.capabilities as unknown as
    | { input?: unknown }
    | undefined;
  if (!caps) return [];
  const input = caps.input;
  if (Array.isArray(input)) {
    return input.filter((v): v is string => typeof v === "string");
  }
  if (input && typeof input === "object") {
    return Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
  return [];
}

// Group a mime type into one of opencode's input modality buckets so we can
// match against the model's capabilities. Important nuance for the
// Anthropic family (and many others): a model declaring `input.text=true`
// only means it accepts text content in `text` blocks — NOT that it accepts
// `text/*` or `application/json` files as FilePart content blocks. Those
// silently get the cryptic "media type X functionality not supported" from
// the upstream API. So we treat text-ish files as "other" — caller refuses
// them upfront. Image/PDF are the only mime classes that map to FilePart-
// safe modes for the providers we've seen.
function mimeToInputMode(mime: string): "image" | "video" | "audio" | "pdf" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

// Best-effort MIME inference for drag-drop chips and @-mention file refs.
// Drag-drop has File.type for many cases; @-mention only has the path. The
// FilePartInput's mime field is required by the API but opencode is tolerant
// of generic types like `application/octet-stream`.
// Array.findLast polyfill — ES2023, not in our ES2022 target. Returns the
// last element matching `pred`, or undefined. Used by the voice action
// dispatcher to pick the NEWEST pending permission/question (matches the
// visual stack: topmost card is the most recent ask).
function findLast<T>(arr: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    yml: "text/yaml",
    yaml: "text/yaml",
    js: "text/javascript",
    jsx: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
    sh: "text/x-shellscript",
    html: "text/html",
    css: "text/css",
  };
  return map[ext] ?? "application/octet-stream";
}

// Per-session model override. Stored in localStorage keyed by sessionId so the
// picker remembers the user's choice across panel mounts. `null` (or missing)
// means "let opencode pick its default" — matches the prompt_async fallback.
type ModelSelection = { providerID: string; modelID: string; variant?: string };
function modelKey(sessionId: string): string {
  return `bui:chat:${sessionId}:model`;
}
function readSavedModel(sessionId: string): ModelSelection | null {
  try {
    const raw = localStorage.getItem(modelKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return parsed as ModelSelection;
    }
    return null;
  } catch {
    return null;
  }
}
function writeSavedModel(sessionId: string, m: ModelSelection | null): void {
  try {
    if (m) localStorage.setItem(modelKey(sessionId), JSON.stringify(m));
    else localStorage.removeItem(modelKey(sessionId));
  } catch { /* quota / disabled storage */ }
}

// Claude's bullet/spinner accent. Inlined (not in tailwind config) so we only
// brand the chat panel without touching the rest of bui's blue accent.
const CLAUDE_ORANGE = "#d97757";

// Subagent (Task tool) context. Carries the per-panel state needed to render
// expanded child transcripts inside TaskBody. Provided once by ChatPanel near
// its scroll container; consumed by TaskBody via useContext so the chain of
// memoized components (MessageRow → AssistantPart → ToolCall → ToolBody) stays
// untouched and their default shallow-comparator memos keep working. Without
// the context, TaskBody falls back to its collapsed-header-only rendering
// (the chevron is hidden because there's nothing to expand into).
type TaskContextValue = {
  expanded: Set<string>;
  toggle: (childSessionId: string) => void;
  // Lazy-loaded child transcripts. Map.get(childSessionId) may be undefined
  // (never fetched) — TaskBody shows a spinner or "expand to load" depending
  // on fetchState.
  childMessages: Map<string, OpencodeMessage[]>;
  // "loading" while the initial fetch is in flight; "error" if it failed
  // (TaskBody renders a small retry hint). Absent = idle.
  childFetchState: Map<string, "loading" | "error">;
  // Live child running/idle from session.status / session.idle events.
  // Overrides the parent's stale `state.status` for the running pulse.
  liveStatus: Map<string, "running" | "idle">;
  // Inherited from ChatPanel's Ctrl+O toggle so reasoning visibility
  // matches between parent and child transcripts.
  showThinking: boolean;
};
const TaskContext = createContext<TaskContextValue | null>(null);

// ASSUMED_CONTEXT_TOKENS, formatTokens, formatDuration, ctxStageColor,
// filterCommands, dedupeAgainstBuiltins, resolveContextLimit,
// classifyFinish, describeTruncation are imported from ./chatUtils.

type TokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

// Present-tense verb pool for the running indicator. Picked once per turn
// so the verb doesn't shuffle between renders. Past-tense pair (same index)
// is used in the post-turn footer (`✻ Brewed for 1m 44s`).
const SPINNER_VERBS = [
  "Cogitating",
  "Ruminating",
  "Pondering",
  "Reflecting",
  "Considering",
  "Deliberating",
  "Musing",
  "Contemplating",
  "Generating",
  "Forging",
  "Brewing",
  "Crafting",
];
const SPINNER_VERBS_PAST = [
  "Cogitated",
  "Ruminated",
  "Pondered",
  "Reflected",
  "Considered",
  "Deliberated",
  "Mused",
  "Contemplated",
  "Generated",
  "Forged",
  "Brewed",
  "Crafted",
];

// Deterministic past-tense verb for a message — same id always picks the same
// verb so the footer doesn't shuffle when the transcript refetches.
function pastVerbFor(messageId: string): string {
  let h = 0;
  for (let i = 0; i < messageId.length; i++) h = (h * 31 + messageId.charCodeAt(i)) | 0;
  return SPINNER_VERBS_PAST[Math.abs(h) % SPINNER_VERBS_PAST.length];
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
  const [messages, setMessages] = useState<OpencodeMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True from session-switch until the fresh transcript fetch resolves. Lets
  // the footer hint at "refreshing…" while we render the cached transcript.
  // opencode's GET /session/{id}/message is 20–35s on large sessions, so
  // this window is real and worth surfacing.
  const [refreshing, setRefreshing] = useState(false);
  // Pending permission requests for THIS session. Polled on mount and refreshed
  // on permission.asked / permission.replied events.
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  // Pending question requests for THIS session. Polled on mount and refreshed
  // on question.asked / question.replied / question.rejected events.
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  // Reasoning ("Thinking…") visibility — hidden by default to keep the
  // transcript focused on results. Ctrl+O toggles like Claude Code's TUI.
  const [showThinking, setShowThinking] = useState(false);
  // Scheduled-prompt management (the ⏰ ScheduledTasksCard). Jobs are
  // server-owned (bui-server fires them); here we only list + delete via the
  // schedule:* window.api channels. Refetch-driven (open + open-poll + post-
  // delete) — NOT a bus event, because desktop's renderer isn't wired to the
  // server bus. See docs/bui-tools-scheduler.md.
  const [showSchedules, setShowSchedules] = useState(false);
  const [schedules, setSchedules] = useState<ScheduledJob[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const refreshSchedules = useCallback(() => {
    return window.api
      .scheduleList(sessionId)
      .then((jobs: ScheduledJob[]) => {
        setSchedules(Array.isArray(jobs) ? jobs : []);
        setScheduleError(null);
      })
      .catch((e: unknown) => {
        setScheduleError(e instanceof Error ? e.message : "schedule server unreachable");
      });
  }, [sessionId]);
  // Secrets management (the 🔑 SecretsCard). Secrets are server-owned (the
  // value never leaves the box; the AI reads them via the secret_* opencode
  // tools). Here the user adds/edits/deletes via secrets:* window.api channels.
  // list returns METADATA ONLY (no values). Refetch-driven like schedules.
  // The card shows shared secrets + this session's scoped ones (sessionId is
  // passed so the agent-visible view matches what tools will resolve).
  const [showSecrets, setShowSecrets] = useState(false);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [secretError, setSecretError] = useState<string | null>(null);
  const refreshSecrets = useCallback(() => {
    return window.api
      .secretsList(sessionId)
      .then((list: SecretMeta[]) => {
        setSecrets(Array.isArray(list) ? list : []);
        setSecretError(null);
      })
      .catch((e: unknown) => {
        setSecretError(e instanceof Error ? e.message : "secrets server unreachable");
      });
  }, [sessionId]);
  // Running mirrors opencode session status (busy/idle/retry). We feed it from
  // session.status events for accuracy, but also set it optimistically on send
  // so the UI flips to "Stop" instantly rather than waiting for the next event.
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // Messages queued while the AI was still running. The moment a queued
  // prompt exists, bui aborts the in-flight turn at the next step boundary
  // and submits the queued prompt as a fresh turn (see the step.ended drain
  // trigger + the [running, messageQueue] drain effect). Shown below the
  // RunningIndicator while waiting; each moves into the transcript once
  // dispatched.
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Live mirror of `messageQueue` for the SSE handler closure (registered
  // once per session, so it can't read the latest state value directly).
  const messageQueueRef = useRef<string[]>([]);
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);
  // True between issuing a drain-abort (at a step boundary) and the queued
  // prompt actually being submitted. Guards against firing a second abort on
  // the next step.ended, and lets the session.error handler swallow the
  // resulting MessageAbortedError so the swap is invisible to the user.
  const drainAbortRef = useRef(false);
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
  const setChatSubagents = useStore((s) => s.setChatSubagents);
  // Typeahead popup state + result caches. Commands and agents are fetched
  // lazily on first @/ and reused; file searches re-issue per-keystroke.
  const [typeahead, setTypeahead] = useState<TypeaheadState | null>(null);
  const [commands, setCommands] = useState<OpencodeCommand[] | null>(null);
  const [agents, setAgents] = useState<OpencodeAgent[] | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const fileSearchSeqRef = useRef(0);
  // Debounce timer for the @-typeahead file lookup. Without this every
  // keystroke fires a fresh `opencodeFindFiles` HTTP call over the SSH
  // tunnel; a fast typist can pile up parallel requests that don't
  // matter (the seq guard discards stale responses) but waste bandwidth
  // and contribute to perceived input lag. 80ms is small enough that
  // the suggestion list still feels live as you type.
  const fileSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Prompt history: when textarea has focus and typeahead is closed, Up/Down
  // cycle through previously-submitted prompts (terminal-style). The index
  // is internal to navigateHistory's setter — never read elsewhere, so the
  // setter is all we keep. draftInput saves whatever the user was typing
  // before they entered history mode so it can be restored on Down past end.
  const [, setHistoryIdx] = useState<number | null>(null);
  const draftInput = useRef<string>("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Wraps the pending QuestionCard(s). A notification deep-link asks us to
  // scroll here (iOS can't show inline notification actions, so the tap opens
  // the app and we bring the question into view). Set via wantQuestionScroll.
  const questionCardRef = useRef<HTMLDivElement>(null);
  const wantQuestionScroll = useRef(false);
  // Pinned-to-bottom auto-scroll: true while the viewport is near the bottom.
  // Flips to false when the user manually scrolls up to read history; flips
  // back to true when they scroll close to the bottom again. Streams only
  // auto-follow when this is true — matches the "follow tail" pattern from
  // terminals and log viewers.
  const pinnedToBottom = useRef(true);
  // Debounce-refetch timer: any non-delta event triggers a re-pull within 300ms.
  // Delta events apply inline so streams feel live; everything else (new parts,
  // tool state transitions, etc.) just retriggers the canonical fetch.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ===== Inactive-panel work gating (perf) =====
  //
  // App.tsx keeps EVERY visited chat session's ChatPanel mounted (so scroll
  // position + in-flight streaming survive a sidebar switch), and the main
  // process broadcasts ONE opencodeEvent to the renderer for every event on
  // every scoped SSE stream. So with K panels mounted, each event runs this
  // panel's `onOpencodeEvent` K times. The dominant cost is the full-
  // transcript refetch (`setMessages` with fresh IPC JSON re-renders + re-
  // tokenizes the entire conversation, defeating the row memos) and the
  // delta-buffer flush (re-renders the streaming message). Neither is needed
  // for a panel the user can't see — the sidebar status (running / attention
  // / todos / subagent count) flows through SEPARATE setState calls that we
  // keep running. While inactive we suppress the refetch + delta flush and
  // remember that a re-pull is owed; the panel does one catch-up refetch when
  // it becomes active again (see the isActive→true effect below).
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Set when a refetch was suppressed because the panel was inactive. The
  // reactivation effect consumes this to pull the canonical transcript once.
  const refetchOwedWhileInactive = useRef(false);
  // Component-level handle to the SSE effect's `scheduleRefetch`. The SSE
  // effect wires this on mount; the reactivation catch-up effect reads it.
  // (Shared so a catch-up can fire outside the SSE effect's local scope.)
  const scheduleRefetchRef = useRef<(() => void) | null>(null);

  // ===== Streamed-text delta buffer =====
  //
  // opencode emits `message.part.delta` events ~character-by-character for
  // text/reasoning parts. The earlier policy of "apply every delta to React
  // state immediately" produced visible jitter on partial markdown: bullets
  // appeared before their content, code fences flashed as inline-code
  // before closing, and Prism re-tokenized the in-progress code body on
  // every keystroke. Instead, accumulate deltas in a ref-keyed buffer and
  // flush at natural section boundaries (paragraph breaks outside code
  // blocks, closing ``` fences) — with a 250ms max-age fallback so a
  // single long paragraph doesn't stall.
  //
  // Per part: { messageID, field, text } where `text` is the unflushed
  // suffix waiting on a boundary. The flush helper slices the
  // longest-prefix-ending-at-a-boundary into `setMessages` (one render
  // for ALL pending parts) and keeps the remainder buffered.
  //
  // Force-flushed on: session.next.step.ended (each step's narration is
  // complete), message.part.updated (part snapshot — refetch will follow
  // anyway), session.idle (turn over), and on session change/unmount.
  const pendingDeltas = useRef<Map<string, PendingDelta>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The max-age fallback: 250ms of un-flushed buffered content forces a
  // flush even without a boundary character. Keeps streams feeling live
  // when paragraphs run long. Tuned to match Claude Code's perceived
  // rhythm — not so short it produces the jitter we're trying to fix,
  // not so long the user thinks the stream stalled.
  const FLUSH_MAX_AGE_MS = 250;
  const oldestPendingAt = useRef<number | null>(null);
  // Live step token/cost snapshot from session.next.step.ended. Updates the
  // footer's ctx bar / running indicator without waiting for the next message
  // re-fetch. Cleared on session change. Preferred over the transcript-derived
  // latestTokens when set.
  const [stepTokens, setStepTokens] = useState<
    (TokenUsage & { cost: number }) | null
  >(null);
  // Current VCS branch for this session's cwd. Initial value is fetched on
  // mount (the SSE `vcs.branch.updated` event only fires on change); kept
  // current via that event after that. Rendered as `⎇ <branch>` left of the
  // model picker in InputArea's footer when non-null.
  const [branch, setBranch] = useState<string | null>(null);
  // Live compaction streaming state. session.next.compaction.{started,delta,
  // ended} fire while opencode summarizes the transcript to free context;
  // without surfacing them the user sees nothing until session.compacted
  // refetches the full transcript. `phase` flips to "done" on .ended so we
  // can show a brief "Compacted" confirmation before clearing.
  const [compactionState, setCompactionState] = useState<{
    reason: string;
    text: string;
    phase: "running" | "done";
  } | null>(null);
  const compactionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live todo list from todo.updated events. Preferred over the transcript-
  // scraped activeTodos when non-null so the ActiveTodos card reflects the
  // running tool's state immediately. Cleared on session change.
  const [liveTodos, setLiveTodos] = useState<
    Array<{ content: string; status: string; priority: string }> | null
  >(null);
  // User has acknowledged a fully-completed todo list by submitting their
  // next prompt — hide it from the transcript until opencode emits a new
  // todowrite (via `todo.updated`). Without this the green-check checklist
  // stays pinned at the bottom of every subsequent turn, which clutters the
  // panel and reads as "still active work" when it's actually done. Reset on
  // session change and on any incoming todo.updated event (see SSE handler).
  const [todosDismissed, setTodosDismissed] = useState(false);
  // Server-reported retry status (rate-limited, transient failure, etc).
  // session.status with type:"retry" carries an attempt counter + an action
  // describing what the user can do. Surfaces above RunningIndicator while
  // running stays true; cleared by busy/idle/session-change.
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number;
    message: string;
    next: number;
    action?: { title: string; message: string; label: string; link?: string };
  } | null>(null);
  // Per-message truncation kind, keyed by assistant messageID. Populated
  // from `session.next.step.ended` whose `properties.finish` reveals why
  // the step stopped. Most finishes are benign (end_turn, tool_use) and
  // classifyFinish() returns null; only real truncations land here.
  //
  // Live-event pattern (matches stepTokens, liveTodos, retryInfo): the
  // canonical message re-fetch at 716–727 doesn't carry per-step finish
  // metadata back, so keeping a side map here avoids the badge flickering
  // off whenever the transcript refetches.
  const [finishByMessageId, setFinishByMessageId] = useState<
    Map<string, TruncationKind>
  >(() => new Map());

  // Slash-command provenance. `command.executed` SSE events are keyed by
  // the ASSISTANT turn id opencode created for the command's response —
  // not the user message holding the expanded template (which sits one
  // position earlier in the transcript). The render-site resolver inside
  // the messages.map call walks idx+1 to translate assistant-id → user-id
  // and pass the collapsed `/name args` info to that user MessageRow.
  // Live-event pattern same as finishByMessageId: kept as a side map
  // because the canonical messages payload has no command-origin field.
  const [commandByMessageId, setCommandByMessageId] = useState<
    Map<string, { name: string; arguments: string }>
  >(() => new Map());

  // ===== Subagent (Task tool / child session) state =====
  //
  // When the parent agent invokes the `task` tool, opencode spawns a CHILD
  // session and runs the subagent inside it. The child's events arrive on
  // the SAME scoped /event?directory= stream the parent uses (child inherits
  // parent's cwd), but with the child's sessionID — so the early sessionID
  // filter would drop them. `childSessionIds` is the runtime allowlist that
  // filter consults; we populate it from two converging sources:
  //   1. Walking `messages` for task tool parts → state.metadata.sessionId.
  //      Covers everything in the persisted transcript (including child
  //      sessions spawned in previous turns/sessions).
  //   2. Live `session.created` events whose properties.info.parentID
  //      matches our sessionId. Covers the brief window before the parent's
  //      task tool part has been stamped with the child id.
  //
  // Stored as a ref because the filter runs INSIDE the SSE handler closure
  // — needs to read the current set without triggering a re-render or
  // forcing the handler to re-subscribe on every update.
  const childSessionIds = useRef<Set<string>>(new Set());
  // Lazily fetched child transcripts, one per expanded TaskBody. The Map
  // value is { messages, loading, error } so the card can show a spinner /
  // error state without a per-card local state hook. Populated on first
  // expand; kept current by routing child message.part.* events through
  // the same buffer machinery and applying them here instead of `messages`.
  const [childMessages, setChildMessages] = useState<
    Map<string, OpencodeMessage[]>
  >(() => new Map());
  // Per-child loading/error state for the lazy fetch on expand.
  const [childFetchState, setChildFetchState] = useState<
    Map<string, "loading" | "error">
  >(() => new Map());
  // Live running/idle status per child session id, driven by the child's
  // own session.status / session.idle events. Preferred over the parent's
  // transcript snapshot of `state.status` because the parent's task-part
  // status only refreshes on the 300ms refetch — leaves a noticeable
  // window where the badge says "running" but the child has actually
  // finished. countRunningSubagents() consumes this for the sidebar.
  const [liveChildStatus, setLiveChildStatus] = useState<
    Map<string, "running" | "idle">
  >(() => new Map());
  // Which task cards are expanded. Keyed by CHILD SESSION ID (not callID)
  // so the SSE handler — which sees evSessionID, not the callID — can
  // gate per-card refetches via a ref-mirror without joining maps.
  // Cleared on session change.
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set(),
  );
  // Mirror of expandedTasks read by the SSE handler closure (which
  // wouldn't re-subscribe to state changes; refs are how we read mutable
  // values out of the long-lived effect cleanly). Kept in sync via the
  // effect below.
  const expandedTasksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    expandedTasksRef.current = expandedTasks;
  }, [expandedTasks]);
  // Ref mirrors of the child-state maps so `toggleTaskExpand` can read
  // current values synchronously without taking them as deps (which would
  // invalidate the callback on every keystroke that touches transcript
  // state and defeat MessageRow memos downstream via TaskContext).
  const childMessagesRef = useRef<Map<string, OpencodeMessage[]>>(new Map());
  const childFetchStateRef = useRef<Map<string, "loading" | "error">>(new Map());
  const liveChildStatusRef = useRef<Map<string, "running" | "idle">>(new Map());
  useEffect(() => {
    childMessagesRef.current = childMessages;
  }, [childMessages]);
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

  // Internal fetch helper. Sets loading state, hits the API, populates
  // childMessages on success, marks error on failure. Idempotent against
  // concurrent calls via the in-flight `loading` guard. Pulled out so we
  // can call it both on first expand AND on re-expand of a running child.
  const fetchChildTranscript = useCallback((childSessionId: string) => {
    if (childFetchStateRef.current.get(childSessionId) === "loading") return;
    setChildFetchState((prev) => {
      if (prev.get(childSessionId) === "loading") return prev;
      const next = new Map(prev);
      next.set(childSessionId, "loading");
      return next;
    });
    window.api
      .opencodeMessages(childSessionId)
      .then((m) => {
        setChildMessages((prev) => {
          const next = new Map(prev);
          next.set(childSessionId, m);
          return next;
        });
        setChildFetchState((prev) => {
          const next = new Map(prev);
          next.delete(childSessionId);
          return next;
        });
      })
      .catch(() => {
        setChildFetchState((prev) => {
          const next = new Map(prev);
          next.set(childSessionId, "error");
          return next;
        });
      });
  }, []);

  // Expand/collapse handler for a TaskBody card. On FIRST expand fetches
  // the child's transcript; on RE-expand fetches again when the child is
  // still running (the cached snapshot would otherwise be stale until the
  // next live event hits the now-expanded card). Idempotent: re-expanding
  // a completed child uses the cached transcript with no extra fetch.
  const toggleTaskExpand = useCallback((childSessionId: string) => {
    // Reads are synchronous via refs so we can decide the fetch policy
    // outside the state setter — strict-mode safe (no side effects inside
    // updaters that would fire twice in dev) and clearer to read.
    let willExpand = false;
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(childSessionId)) {
        next.delete(childSessionId);
        willExpand = false;
      } else {
        next.add(childSessionId);
        willExpand = true;
      }
      return next;
    });
    if (!willExpand) return;
    const cached = childMessagesRef.current.has(childSessionId);
    const isRunning = liveChildStatusRef.current.get(childSessionId) === "running";
    // Fetch when: no cached snapshot yet, OR the child is still running
    // (cache is stale by the time the user re-opens the card).
    if (!cached || isRunning) {
      fetchChildTranscript(childSessionId);
    }
  }, [fetchChildTranscript]);

  // Initial load + reload whenever sessionId changes.
  useEffect(() => {
    let cancelled = false;
    // Open the scoped SSE stream for this session while the panel is mounted;
    // release it on unmount/session-change. The main process refcounts per
    // directory so the stream lives only as long as a panel needs it — this is
    // what keeps the bus from holding a connection open for every workspace
    // opencode knows about (the connection-flood that wedged the backend).
    void window.api.opencodeOpenStream(sessionId).catch(() => { /* non-fatal */ });
    setMessages(null);
    setError(null);
    setPermissions([]);
    setQuestions([]);
    setModelOverride(readSavedModel(sessionId) ?? configDefaultModel ?? null);
    setAttachments([]);
    setAgentMentions([]);
    setTypeahead(null);
    setSystemNotice(null);
    setMessageQueue([]);
    messageQueueRef.current = [];
    drainAbortRef.current = false;
    setStepTokens(null);
    setRetryInfo(null);
    setLiveTodos(null);
    setTodosDismissed(false);
    setFinishByMessageId(new Map());
    setCommandByMessageId(new Map());
    setCompactionState(null);
    childSessionIds.current = new Set();
    setChildMessages(new Map());
    setChildFetchState(new Map());
    setLiveChildStatus(new Map());
    setExpandedTasks(new Set());
    // Drop any buffered text deltas from the previous session — they
    // refer to part IDs that no longer exist in the new transcript.
    pendingDeltas.current.clear();
    oldestPendingAt.current = null;
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (compactionClearTimer.current) {
      clearTimeout(compactionClearTimer.current);
      compactionClearTimer.current = null;
    }
    if (fileSearchTimer.current) {
      clearTimeout(fileSearchTimer.current);
      fileSearchTimer.current = null;
    }
    setBranch(null);
    // Branch indicator. opencode's `vcs.branch.updated` event NEVER fires
    // on a terminal-side `git checkout` (its internal watcher misses it)
    // and `GET /vcs` returns stale cached data, so we cannot rely on
    // event-driven updates. Instead, the main process bypasses opencode
    // entirely and reads `git -C <cwd> branch --show-current` over the
    // warm SSH ControlMaster (~30ms). We do an initial fetch on mount and
    // poll every 5s while this session is mounted, so a checkout in any
    // terminal reflects in the footer within one tick. Non-fatal on
    // non-git cwds (returns null).
    const fetchBranch = () => {
      window.api
        .opencodeVcsBranch(cwd)
        .then((b) => {
          if (!cancelled) setBranch(b);
        })
        .catch(() => { /* non-fatal — non-git cwd or transport blip */ });
    };
    fetchBranch();
    const branchPoll = setInterval(fetchBranch, 5000);

    // Cached-first render: opencode's GET /session/{id}/message is 20–35s on
    // large transcripts (3 MB JSON, no server-side cache), so blocking the
    // panel on it makes session-switches feel broken. Paint the last-known
    // transcript from disk immediately; the fresh fetch below overwrites it
    // when it lands. `refreshing` drives the footer hint so the staleness is
    // visible during the gap.
    setRefreshing(true);
    // Watchdog: opencodeMessages can hang indefinitely (wedged main-process
    // IPC, a stalled SSH ControlMaster, or opencode never responding on a
    // huge transcript). When it never settles, neither the `.then` nor the
    // `.catch` below fires, so `refreshing` would stay true forever with the
    // "↻ refreshing…" hint stuck on and no way to clear it without switching
    // sessions. Cap the hint at 60s — well past the 20–30s worst case — and
    // clear it so the footer stops lying about an in-flight fetch.
    const refreshWatchdog = setTimeout(() => {
      if (!cancelled) setRefreshing(false);
    }, 60_000);
    window.api
      .opencodeMessagesCached(sessionId)
      .then((cached) => {
        // Guard against the fresh fetch winning the race: never overwrite
        // a fresh transcript with a cached one.
        if (cancelled || !cached) return;
        setMessages((prev) => (prev === null ? cached : prev));
        for (const cid of collectChildSessionIds(cached)) {
          childSessionIds.current.add(cid);
        }
      })
      .catch(() => { /* cache miss / corrupt — fresh fetch will fill in */ });

    window.api
      .opencodeMessages(sessionId)
      .then((m) => {
        clearTimeout(refreshWatchdog);
        if (cancelled) return;
        setMessages(m);
        setRefreshing(false);
        // Seed the subagent allowlist from the persisted transcript so
        // events for previously-spawned children (still running OR finished
        // and being inspected) pass the sessionID filter. Live `session.
        // created` events keep it current for new spawns.
        for (const cid of collectChildSessionIds(m)) {
          childSessionIds.current.add(cid);
        }
        // Recover the running state from the transcript at mount. If the
        // last message is an assistant turn with no completion stamp, that
        // turn is in flight or wedged (stuck mid-tool-call — opencode never
        // emitted idle). Either way we must show `running` so the abort
        // button appears; without this a wedged session looks idle and the
        // user has no way to clear it. Mount-only — safe to set running
        // true here because no local send can have raced yet.
        if (isAssistantTurnInProgress(m)) setRunning(true);
        // NOTE: we deliberately do NOT reconstruct pending questions from
        // the transcript here. opencode v1.15 broadcasts the `que_…` reply
        // token exactly once, on the live question.asked event — it is not
        // in the transcript, /question, or any replay. A transcript-
        // recovered question would render but be unanswerable (verified:
        // reply API hard-requires the que_). Showing an un-submittable card
        // is worse than not showing it, so existing-session questions
        // asked before this panel mounted are intentionally not surfaced.
        // Questions asked while viewing a session work via the live event
        // (applyQuestionEvent) which carries the que_ as requestId.
      })
      .catch((e) => {
        clearTimeout(refreshWatchdog);
        if (!cancelled) {
          setRefreshing(false);
          // If cached painted earlier, keep showing it and surface the error
          // out-of-band would be ideal — but for now match prior behavior and
          // show the error screen (overrides any cached render).
          setError(String(e?.message ?? e));
        }
      });
    // Eagerly fetch the command list (with templates) so the renderer can
    // detect historical /command-origin user messages and collapse them on
    // first render. Without this, only commands invoked DURING this panel's
    // lifetime get tagged (via live `command.executed` events). The fetch
    // is cheap and the list is cached in `commands` state.
    window.api
      .opencodeCommands()
      .then((c) => {
        if (!cancelled) setCommands(c);
      })
      .catch(() => { /* non-fatal */ });
    // Pull current pending permissions (e.g. a tool that was waiting from a
    // previous bui session before we mounted). `sessionId` is required so
    // the main process can append `?directory=` — opencode's workspace
    // routing returns [] for non-default-workspace sessions otherwise, and
    // we'd render no PermissionCard even though one is live on the server.
    window.api
      .opencodePermissions(sessionId)
      .then((all) => {
        if (!cancelled) {
          setPermissions(all.filter((p) => p.sessionID === sessionId));
        }
      })
      .catch(() => { /* non-fatal */ });
    // Pull current pending questions. Same workspace-scoping rule as
    // permissions above — without `sessionId` the live `que_…` is invisible
    // and the QuestionCard never appears (was the root-cause wedge before
    // the `?directory=` fix on listQuestions).
    window.api
      .opencodeQuestions(sessionId)
      .then((all) => {
        if (!cancelled) {
          setQuestions(
            all
              .filter((q) => q.sessionID === sessionId)
              .map(hydrateQuestion) as QuestionRequest[],
          );
        }
      })
      .catch(() => { /* non-fatal — v2-only endpoint */ });
    return () => {
      cancelled = true;
      clearInterval(branchPoll);
      clearTimeout(refreshWatchdog);
      // Release this session's scoped stream. Main-process refcount drops it
      // only when the last panel for the dir unmounts.
      void window.api.opencodeCloseStream(sessionId).catch(() => { /* non-fatal */ });
    };
  }, [sessionId, cwd]);

  // Close the schedules card + clear its state on session change.
  useEffect(() => {
    setShowSchedules(false);
    setSchedules([]);
    setScheduleError(null);
  }, [sessionId]);

  // Keep the toolbar schedule count fresh whether or not the card is open:
  // fetch once on mount/session-change, then poll. The card being open speeds
  // the poll up (10s) for snappy create/fire feedback; while closed a slower
  // 30s background poll keeps the "(N)" count current so a model-created job
  // shows up without the user having to open the card first. Refetch-driven
  // (no bus event) so it behaves identically on desktop and mobile.
  useEffect(() => {
    void refreshSchedules();
    const intervalMs = showSchedules ? 10_000 : 30_000;
    const poll = setInterval(() => void refreshSchedules(), intervalMs);
    return () => clearInterval(poll);
  }, [showSchedules, refreshSchedules]);

  // Secrets are only fetched while the card is open (no toolbar count badge to
  // keep current in the background — unlike schedules). Refetch on open + 10s
  // poll so a secret added on another device shows up.
  useEffect(() => {
    if (!showSecrets) return;
    void refreshSecrets();
    const poll = setInterval(() => void refreshSecrets(), 10_000);
    return () => clearInterval(poll);
  }, [showSecrets, refreshSecrets]);

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
        ev.type === "session.idle" ||
        ev.type === "session.status" ||
        ev.type === "session.compacted" ||
        ev.type === "session.error" ||
        ev.type === "message.part.updated" ||
        ev.type === "message.updated"
      ) {
        // Force-flush any buffered text deltas before the refetch
        // overwrites state. Without this, a still-buffered trailing
        // paragraph would be discarded when the canonical transcript
        // arrives (the server-side snapshot has the same content but the
        // refetch races the buffer's max-age timer).
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

  // Mobile entry point for the schedules card: the ⋯ sheet (outside ChatPanel)
  // dispatches a window CustomEvent rather than reaching into this component's
  // state. Mirrors the bui-scroll-to-question bridge above.
  useEffect(() => {
    const onOpenSchedules = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setShowSchedules(true);
    };
    window.addEventListener("bui-open-schedules", onOpenSchedules);
    return () => window.removeEventListener("bui-open-schedules", onOpenSchedules);
  }, [sessionId]);

  // Mobile entry point for the secrets card (mirror of bui-open-schedules).
  useEffect(() => {
    const onOpenSecrets = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string } | undefined;
      if (detail?.sessionId === sessionId) setShowSecrets(true);
    };
    window.addEventListener("bui-open-secrets", onOpenSecrets);
    return () => window.removeEventListener("bui-open-secrets", onOpenSecrets);
  }, [sessionId]);

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

  // Prompt history from user messages — chronological, freshest last.
  const promptHistory = useMemo<string[]>(() => {
    if (!messages) return [];
    const out: string[] = [];
    for (const m of messages) {
      if (m.info.role !== "user") continue;
      const text = m.parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      if (text) out.push(text);
    }
    return out;
  }, [messages]);

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

  // ===== Voice dispatch =====
  //
  // Routes a VoiceAction (from rules classifier or LLM fallback) to the
  // matching panel callback. Panel-scoped actions call local useCallbacks;
  // App-scoped ones (switch-window / new-session / open-settings) dispatch
  // a CustomEvent App.tsx listens for — same pattern as the keyboard
  // shortcuts there. Declared AFTER every callback it depends on to dodge
  // the TDZ on the dep array.
  //
  // For "submit" we both fill the textarea AND fire submit on the next tick
  // so the dictated turn lands in transcript history exactly like a keypress.
  const groqApiKey = useStore((s) => s.groqApiKey);

  const dispatchVoiceAction = useCallback(
    (action: VoiceAction) => {
      switch (action.kind) {
        case "append": {
          // Insert at caret if possible; fall back to appending. Single-space
          // separator so spoken text doesn't glue into the previous word.
          const el = inputRef.current;
          if (el) {
            const start = el.selectionStart ?? input.length;
            const end = el.selectionEnd ?? input.length;
            const prefix = input.slice(0, start);
            const suffix = input.slice(end);
            const sep = prefix && !prefix.endsWith(" ") ? " " : "";
            const tail = suffix && !suffix.startsWith(" ") ? " " : "";
            const next = `${prefix}${sep}${action.text}${tail}${suffix}`;
            setInput(next);
            setTimeout(() => {
              if (!inputRef.current) return;
              const pos = (prefix + sep + action.text).length;
              try {
                inputRef.current.focus();
                inputRef.current.setSelectionRange(pos, pos);
              } catch { /* ignore */ }
            }, 0);
          } else {
            setInput(input ? `${input} ${action.text}` : action.text);
          }
          return;
        }
        case "submit": {
          setInput(action.text);
          setTimeout(() => submitRef.current(), 0);
          return;
        }
        case "clear":
          // Reuse the /clear builtin path so future changes
          // (model carry-forward, etc.) stay in one place.
          setInput("/clear");
          setTimeout(() => submitRef.current(), 0);
          return;
        case "compact": compactSession(); return;
        case "fork":    forkSession();    return;
        case "abort":   abort();          return;
        case "help":    setSystemNotice(buildHelpText()); return;
        case "toggle-trust":
          setChatAutoAllow(!chatAutoAllow);
          return;
        case "model": {
          const match = fuzzyMatchModel(action.query, models ?? []);
          if (match) selectModel({ providerID: match.providerID, modelID: match.id });
          else setSendError(`No model matched "${action.query}".`);
          return;
        }
        case "allow-once":
        case "allow-always":
        case "reject": {
          // PermissionCard renders above QuestionCard in the visual stack,
          // so when both are open we route permission replies there. If
          // no permission is pending and the action is "reject", fall
          // through to question-rejection — the QuestionCard's Cancel
          // button is the user's only other "reject" target (W6 fix:
          // previously we surfaced "no pending permission" even when a
          // question was the obvious target).
          //
          // We pick the LAST (newest) pending request, not the first —
          // matches the visual order: the topmost card is the most
          // recent ask. The .find()-from-end pattern is the W5 fix.
          const lastPerm = findLast(permissions, (p) => p.sessionID === sessionId);
          if (lastPerm) {
            const reply =
              action.kind === "allow-once" ? "once"
                : action.kind === "allow-always" ? "always"
                  : "reject";
            replyPermission(lastPerm.id, reply);
            return;
          }
          // No permission pending. "reject" can still mean "dismiss the
          // open question". "allow-once" / "allow-always" don't have a
          // question equivalent — surface the hint.
          if (action.kind === "reject") {
            const lastQ = findLast(questions, (q) => q.sessionID === sessionId);
            if (lastQ) {
              rejectQuestion(lastQ);
              return;
            }
          }
          setSendError("No pending permission request to respond to.");
          return;
        }
        case "answer": {
          // Newest question matches what's visually on top (W5). Same
          // findLast pattern as the permission branch above.
          const pending = findLast(
            questions,
            (q) => q.sessionID === sessionId && q.questions.length > 0,
          );
          if (!pending) {
            setSendError("No pending question to answer.");
            return;
          }
          // Same choice applied to every sub-question; abort if any
          // sub-question can't resolve the spoken option.
          const answers: string[][] = [];
          for (const sub of pending.questions) {
            const label = resolveQuestionAnswer(action.choice, sub.options);
            if (!label) {
              setSendError(
                `Couldn't match "${action.choice}" to an option. ` +
                `Available: ${sub.options.map((o) => o.label).join(", ")}.`,
              );
              return;
            }
            answers.push([label]);
          }
          replyQuestion(pending, answers);
          return;
        }
        case "switch-window":
        case "new-session":
        case "open-settings":
          window.dispatchEvent(
            new CustomEvent("bui-voice-app-action", { detail: action }),
          );
          return;
        case "unknown": {
          // Fall back to inserting the raw transcript so the user can edit
          // and resend — better than swallowing silently.
          const text = action.transcript.trim();
          if (text) setInput(input ? `${input} ${text}` : text);
          return;
        }
      }
    },
    [
      input,
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
    ],
  );

  // When the user presses Enter (or Ctrl+M) WHILE the desktop voice
  // recorder is active, we want the transcribed text to land in the
  // composer AND immediately submit, in one keystroke. The transcribe call
  // is async (Groq round-trip ~200-500ms), so we set a one-shot flag that
  // `onResult` consumes and then auto-submits. Esc just cancels.
  const submitAfterTranscribeRef = useRef(false);

  const voiceRecorder = useVoiceRecorder({
    onResult: (r) => {
      if (r.mode === "dictate") {
        dispatchVoiceAction({ kind: "append", text: r.text });
        if (submitAfterTranscribeRef.current) {
          submitAfterTranscribeRef.current = false;
          // One-tick delay so the setInput inside the append branch has
          // committed before submit() reads the textarea value.
          setTimeout(() => submitRef.current(), 0);
        }
      } else {
        dispatchVoiceAction(r.classify.action);
      }
    },
    onError: (e) => {
      submitAfterTranscribeRef.current = false;
      setSendError(e.message);
    },
    onEmpty: (reason) => {
      // Recorded fine but nothing usable came back. Don't use the red error
      // banner (it's not an error); show a transient system notice so the
      // user knows the mic worked and why nothing was inserted.
      submitAfterTranscribeRef.current = false;
      setSystemNotice(
        reason === "too-short"
          ? "Didn't catch that — the recording was too short. Hold a bit longer."
          : "Didn't catch any speech. Try again, a little louder or closer to the mic.",
      );
    },
  });

  // Gate the mic affordances on: API key present, browser capable of capture.
  // Mobile WebView typically needs RECORD_AUDIO granted at the OS layer —
  // we don't pre-check; the first start() surfaces "permission denied" via
  // setSendError if the user said no.
  const voiceEnabled =
    !!groqApiKey &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  // Convenience refs so the Ctrl+M handler + the textarea's Enter/Esc
  // handlers can read the latest phase + invoke start/stop/cancel without
  // re-subscribing the keydown listener on every recorder re-render.
  const voicePhaseRef = useRef(voiceRecorder.phase);
  voicePhaseRef.current = voiceRecorder.phase;
  const voiceStartRef = useRef(voiceRecorder.start);
  voiceStartRef.current = voiceRecorder.start;
  const voiceStopRef = useRef(voiceRecorder.stop);
  voiceStopRef.current = voiceRecorder.stop;
  const voiceCancelRef = useRef(voiceRecorder.cancel);
  voiceCancelRef.current = voiceRecorder.cancel;
  const voiceRecording =
    voiceRecorder.phase === "recording" ||
    voiceRecorder.phase === "requesting";
  const voiceProcessing = voiceRecorder.phase === "processing";

  // Desktop voice keybinds (Ctrl+M / Enter / Esc) — replace the mobile
  // mic button on Mac/Linux/Windows. Mobile keeps the touch button (no
  // physical keyboard in the typical case).
  //
  // Ctrl+M  → toggle: start recording, or stop + transcribe + append to
  //           textarea (does NOT submit; user can edit before sending).
  // Enter   → only intercepted WHILE recording: stop + transcribe + APPEND
  //           + auto-submit in one stroke (the natural "I'm done speaking,
  //           send it" gesture). The submitAfterTranscribeRef flag is what
  //           threads through the async transcribe call. Outside recording,
  //           Enter falls through to the textarea's normal submit path.
  // Esc     → cancel the current recording (discards audio, no transcribe).
  //           Outside recording, Esc falls through to its normal handlers
  //           (typeahead-close / abort-running-turn).
  //
  // Captured at the window level (with capture:true so Enter/Esc preempt
  // the textarea's own onKeyDown). The handler gates on voiceEnabled so
  // users without a Groq key never accidentally trigger a no-op.
  useEffect(() => {
    if (!voiceEnabled) return;
    const handler = (e: KeyboardEvent) => {
      // Ctrl+M toggle — always available (gated on voiceEnabled).
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        const phase = voicePhaseRef.current;
        if (phase === "recording" || phase === "requesting") {
          submitAfterTranscribeRef.current = false;
          voiceStopRef.current();
        } else if (phase === "idle" || phase === "error") {
          // Always start in dictate mode from the keyboard. Command mode
          // stays accessible via the mobile long-press path; on desktop
          // typing `/clear` etc. is just as fast.
          void voiceStartRef.current("dictate");
        }
        return;
      }
      // Enter and Esc only fire while voice is in a non-idle phase —
      // otherwise they MUST fall through to the textarea/abort handlers.
      const phase = voicePhaseRef.current;
      if (phase === "idle" || phase === "error") return;
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        // Only meaningful while actively recording. During "requesting"
        // the recorder isn't constructed yet, so stop() would no-op and
        // the eventual getUserMedia resolution would start recording
        // anyway with no way to stop — the user would be silently
        // recording until maxDurationMs (60s). During "processing" we'd
        // race the in-flight transcribe. Both fall through to the
        // textarea so Enter still submits whatever's typed.
        if (phase !== "recording") return;
        e.preventDefault();
        e.stopPropagation();
        submitAfterTranscribeRef.current = true;
        voiceStopRef.current();
        return;
      }
      if (e.key === "Escape") {
        // Esc cancels from any non-idle phase: requesting (abandons the
        // pending permission), recording (discards audio), processing
        // (lets the transcribe finish but suppresses the auto-submit
        // flag — the transcript will still land in the textarea). The
        // cancel() helper handles all three via cancelledRef.
        e.preventDefault();
        e.stopPropagation();
        submitAfterTranscribeRef.current = false;
        voiceCancelRef.current();
        return;
      }
    };
    // capture:true so we preempt the textarea's bubble-phase onKeyDown
    // (otherwise Enter would submit the empty/partial textarea before our
    // submitAfterTranscribeRef flag was set).
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [voiceEnabled]);

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

  // ===== Typeahead =====
  //
  // The textarea's onChange (in InputArea) routes through `updateInput` which
  // both updates `input` state and detects active typeahead. Three triggers:
  //   /<word>      at byte 0 → command typeahead
  //   @<token>     after whitespace (or BOF) → file+agent typeahead
  // The popup tracks the [anchorStart, anchorEnd) slice and replaces it
  // verbatim on selection.

  const ensureCommands = useCallback(async () => {
    if (commands) return;
    try {
      const c = await window.api.opencodeCommands();
      setCommands(c);
    } catch { /* non-fatal */ }
  }, [commands]);

  const ensureAgents = useCallback(async () => {
    if (agents) return;
    try {
      const a = await window.api.opencodeAgents();
      setAgents(a);
    } catch { /* non-fatal */ }
  }, [agents]);

  // File search: sequence-tracked so stale responses don't clobber the
  // latest. Empty query is passed through — opencode's /find/file returns a
  // browse-style listing of the directory's top-level entries, which is
  // exactly what we want when the user has just typed `@` with no filter.
  const searchFiles = useCallback(
    (query: string) => {
      if (fileSearchTimer.current) clearTimeout(fileSearchTimer.current);
      if (!cwd) {
        setFileResults([]);
        return;
      }
      fileSearchTimer.current = setTimeout(async () => {
        fileSearchTimer.current = null;
        const seq = ++fileSearchSeqRef.current;
        try {
          const list = await window.api.opencodeFindFiles({ query, directory: cwd });
          if (seq === fileSearchSeqRef.current) setFileResults(list.slice(0, 20));
        } catch {
          if (seq === fileSearchSeqRef.current) setFileResults([]);
        }
      }, 80);
    },
    [cwd],
  );

  const detectTypeahead = useCallback(
    (text: string, caret: number): TypeaheadState | null => {
      // Command typeahead — fires only when "/" is the very first character
      // of the input AND the caret is somewhere inside the first word (or
      // immediately after it before a space). This avoids triggering on
      // "use /etc/foo" etc.
      if (text.startsWith("/")) {
        const m = /^\/([\w-]*)/.exec(text);
        if (m && caret <= m[0].length) {
          return {
            mode: "command",
            query: m[1],
            anchorStart: 0,
            anchorEnd: m[0].length,
            selectedIdx: 0,
          };
        }
      }
      // @-mention typeahead — fires when an @ token starts at BOF or after
      // whitespace and the caret is inside that token. The token ends at the
      // next whitespace (so "@src/foo " stops being active once you space).
      const left = text.slice(0, caret);
      const at = left.lastIndexOf("@");
      if (at >= 0) {
        const prev = at > 0 ? text[at - 1] : "";
        if (at === 0 || /\s/.test(prev)) {
          const after = text.slice(at + 1, caret);
          if (!/\s/.test(after)) {
            // Token extends to the next whitespace forward (or EOL).
            let end = caret;
            while (end < text.length && !/\s/.test(text[end])) end++;
            return {
              mode: after.startsWith("@") ? "agent" : "file",
              query: after.replace(/^@/, ""),
              anchorStart: at,
              anchorEnd: end,
              selectedIdx: 0,
            };
          }
        }
      }
      return null;
    },
    [],
  );

  const updateInput = useCallback(
    (next: string) => {
      setInput(next);
      const el = inputRef.current;
      const caret = el?.selectionStart ?? next.length;
      const t = detectTypeahead(next, caret);
      setTypeahead(t);
      if (t) {
        if (t.mode === "command") void ensureCommands();
        else if (t.mode === "agent") void ensureAgents();
        else if (t.mode === "file") void searchFiles(t.query);
      }
    },
    [detectTypeahead, ensureCommands, ensureAgents, searchFiles],
  );

  // Build the active typeahead's filtered result list. Returns the rows the
  // popup will render; selection index is clamped by InputArea to its length.
  const typeaheadRows = useMemo<TypeaheadRow[]>(() => {
    if (!typeahead) return [];
    const q = typeahead.query.toLowerCase();
    if (typeahead.mode === "command") {
      // bui builtins first — they're always available even when the opencode
      // /command response hasn't loaded yet, and the user expects /clear /help
      // to "just work" before learning the rest of the surface.
      const builtins = filterCommands(BUI_BUILTIN_COMMANDS, q).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      // Drop opencode rows that collide with a builtin name so we don't
      // show two `/clear` entries if a user has defined one.
      const ocRows = dedupeAgainstBuiltins(
        filterCommands(commands ?? [], q),
        BUI_BUILTIN_NAMES,
      ).map((c) => ({
        kind: "command" as const,
        key: c.name,
        primary: `/${c.name}`,
        secondary: c.description,
      }));
      return [...builtins, ...ocRows].slice(0, 12);
    }
    if (typeahead.mode === "agent") {
      const all = agents ?? [];
      const filtered = q
        ? all.filter((a) => a.name.toLowerCase().includes(q))
        : all;
      return filtered.slice(0, 12).map((a) => ({
        kind: "agent",
        key: a.name,
        primary: `@@${a.name}`,
        secondary: a.description,
      }));
    }
    // File mode — if the active model can't take attachments, show a single
    // red "not supported" row instead of file results. Selecting it is a
    // no-op (applyTypeahead falls through harmlessly because key === "").
    if (!currentModelSupportsAttachments) {
      return [
        {
          kind: "file",
          key: "",
          primary: `⚠ ${currentModelName} doesn't support file attachments`,
          secondary: "Pick a model with attachment support to enable @-mentions",
        },
      ];
    }
    return fileResults.map((p) => ({
      kind: "file",
      key: p,
      primary: `@${p}`,
      secondary: undefined,
    }));
  }, [
    typeahead,
    commands,
    agents,
    fileResults,
    currentModelSupportsAttachments,
    currentModelName,
  ]);

  // Apply a typeahead selection: rewrite the [anchorStart, anchorEnd) slice
  // and re-position the caret. For command/file selections we leave a trailing
  // space so the user can type arguments immediately.
  const applyTypeahead = useCallback(
    (row: TypeaheadRow) => {
      if (!typeahead) return;
      const { anchorStart, anchorEnd, mode } = typeahead;
      const before = input.slice(0, anchorStart);
      const after = input.slice(anchorEnd);
      let insertion = row.primary;
      let trailingSpace = " ";
      if (mode === "command") {
        // Commands need a space before arguments.
        insertion = `/${row.key}`;
      } else if (mode === "file") {
        insertion = `@${row.key}`;
      } else if (mode === "agent") {
        // For agents we drop the @@ display prefix and store as a single @name.
        insertion = `@${row.key}`;
      }
      const next = before + insertion + trailingSpace + after;
      setInput(next);
      setTypeahead(null);

      // File @-mention is path-as-text only — the agent-native pattern.
      // The `@<path>` we just inserted into the textarea is what the AI
      // sees; if it needs the content it calls its Read tool. No FilePart,
      // no chip — matches Claude Code / Cursor / Aider, avoids burning
      // tokens on full file content the AI may not need.
      if (mode === "agent") {
        const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setAgentMentions((prev) => [...prev, { id, name: row.key }]);
      }

      // Restore focus + place caret after the inserted token + space.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        const pos = before.length + insertion.length + trailingSpace.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [typeahead, input, cwd],
  );

  const moveTypeaheadSelection = useCallback(
    (dir: 1 | -1) => {
      setTypeahead((prev) => {
        if (!prev) return prev;
        const n = typeaheadRows.length;
        if (n === 0) return prev;
        const next = (prev.selectedIdx + dir + n) % n;
        return { ...prev, selectedIdx: next };
      });
    },
    [typeaheadRows.length],
  );

  // Prompt history navigation — Up cycles back, Down cycles forward. We
  // bypass updateInput's typeahead detection here (calling setInput directly)
  // so cycling through past prompts containing `@` or `/` doesn't immediately
  // open a typeahead popup.
  const navigateHistory = useCallback(
    (dir: 1 | -1) => {
      if (promptHistory.length === 0) return;
      setHistoryIdx((cur) => {
        // dir === -1 means UP (older), +1 means DOWN (newer).
        let next: number | null;
        if (cur == null) {
          // Entering history mode — save the current draft so we can restore
          // it when the user presses Down past the newest entry.
          if (dir === -1) {
            draftInput.current = inputRef.current?.value ?? "";
            next = promptHistory.length - 1;
          } else {
            // Already at newest — no-op.
            return cur;
          }
        } else {
          const candidate = cur + dir;
          if (candidate < 0) next = 0;
          else if (candidate >= promptHistory.length) next = null;
          else next = candidate;
        }
        // null means "back to draft" (past the newest entry).
        const value = next == null ? draftInput.current : promptHistory[next];
        setInput(value);
        setTypeahead(null);
        // Place caret at end after React commits the new value.
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const pos = value.length;
          el.setSelectionRange(pos, pos);
        });
        return next;
      });
    },
    [promptHistory],
  );

  // Reset history-navigation mode whenever the user edits the input by
  // typing (not via Up/Down). Keeps history "session" per stretch of edits.
  const updateInputWithHistoryReset = useCallback(
    (next: string) => {
      setHistoryIdx(null);
      draftInput.current = next;
      updateInput(next);
    },
    [updateInput],
  );

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

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3"
      >
        <TaskContext.Provider value={taskContextValue}>
        <div className="flex flex-col justify-end min-h-full">
        {messages.length === 0 ? (
          <div className="text-text-faint">
            <span style={{ color: CLAUDE_ORANGE }}>✻</span>{" "}
            Welcome. Type a message below to start.
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m, idx) => {
              const isLastInTranscript =
                idx === messages.length - 1 && m.info.role === "assistant";
              // cmdInfo comes from `userCommandInfo` (memoized at panel
              // scope on [messages, commandByMessageId, commands]).
              // O(1) Map lookup here means MessageRow can be React.memo'd
              // without keystrokes invalidating the prop reference.
              const cmdInfo =
                m.info.role === "user"
                  ? userCommandInfo.get(m.info.id) ?? null
                  : null;
              return (
                <MessageRow
                  key={m.info.id}
                  msg={m}
                  showThinking={showThinking}
                  turnDurationMs={turnInfo.get(m.info.id)?.turnDurationMs ?? null}
                  persistentTodos={
                    isLastInTranscript && !running ? activeTodos : null
                  }
                  truncation={finishByMessageId.get(m.info.id) ?? null}
                  commandInfo={cmdInfo}
                />
              );
            })}
            {/* Live todos while a turn is running — rendered INSIDE the */}
            {/* scroll container at the tail of the transcript so the list */}
            {/* scrolls with the rest of the chat instead of sitting in a */}
            {/* shrink-0 row above the input (which made it feel "sticky" */}
            {/* and ate vertical space on long checklists). The */}
            {/* `!running` branch above still attaches activeTodos to the */}
            {/* last assistant message via persistentTodos — same data, */}
            {/* same rendering, just owned by MessageRow once idle. */}
            {running && activeTodos && activeTodos.length > 0 && (
              <ActiveTodos todos={activeTodos} />
            )}
            {/* Pending question cards. Rendered INSIDE the scroll */}
            {/* container at the tail of the transcript so they scroll */}
            {/* with the rest of the chat instead of sitting in a shrink-0 */}
            {/* row above the input. They still surface prominently (Claude */}
            {/* is blocked until answered) but feel like part of the */}
            {/* conversation — scrolling up through history doesn't keep */}
            {/* the card glued to the bottom. Same pattern as ActiveTodos. */}
            {questions.length > 0 && (
              <div className="space-y-2 pt-1" ref={questionCardRef}>
                {questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    request={q}
                    onReply={(answers) => replyQuestion(q, answers)}
                    onReject={() => rejectQuestion(q)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </div>
        </TaskContext.Provider>
      </div>

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

      {/* Attachment chips strip — only when something pending. */}
      {attachments.length > 0 && (
        <AttachmentStrip
          attachments={attachments}
          onRemove={removeAttachment}
        />
      )}

      {/* Typeahead popup — shown the moment typeahead state is set, even */}
      {/* if the result list is still loading. Empty rows render a small */}
      {/* "Searching…" placeholder so the user sees instant feedback. */}
      {typeahead && (
        <TypeaheadPopup
          rows={typeaheadRows}
          selectedIdx={Math.min(typeahead.selectedIdx, Math.max(0, typeaheadRows.length - 1))}
          onSelect={applyTypeahead}
          onHover={(idx) =>
            setTypeahead((prev) => (prev ? { ...prev, selectedIdx: idx } : prev))
          }
          emptyHint={
            typeahead.mode === "file"
              ? "Searching…"
              : typeahead.mode === "agent"
                ? "No matching agents"
                : "No matching commands"
          }
        />
      )}

      <InputArea
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

// ===== Running indicator =====
//
// Mounted only while running. Sits between transcript and input — same place
// Claude Code shows it. Combines two motion sources to make "alive vs stuck"
// unambiguous:
//   1. Spinner glyph rotates through ✻ ✳ ✶ ✽ ✢ every 200ms
//   2. CSS opacity pulse on the glyph (animate-pulse, ~2s cycle)
//   3. Elapsed-seconds counter ticks every second
// If all three stall, the user knows it's genuinely stuck — not just slow.

function RunningIndicator({ tokens, atBottom }: { tokens: TokenUsage | null; atBottom: boolean }) {
  // Tick once per second to drive the elapsed-time re-render.
  const [, setTick] = useState(0);
  const startRef = useRef<number>(Date.now());
  // Pick a verb once per indicator mount so it doesn't shuffle between
  // renders.
  const verb = useRef<string>(
    SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)],
  );

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = Date.now() - startRef.current;

  const outTokens = tokens != null ? tokens.output + tokens.reasoning : 0;

  // pt-0 + pb-3: the scroll container above already has pb-3 (12px), so
  // dropping the indicator's top padding gives 12px between the last
  // message and the ✻ glyph. pb-3 matches it on the other side (12px
  // between context bar / ✻ line and the input divider).
  return (
    <div className={`shrink-0 px-4 pb-3 text-xs ${atBottom ? "pt-0" : "pt-1"}`}>
      <div>
        <span style={{ color: CLAUDE_ORANGE }}>
          <span className="inline-block animate-pulse">✻</span>{" "}
          {verb.current}…
        </span>{" "}
        <span className="text-text-faint">
          ({formatDuration(elapsedMs)}
          {outTokens > 0 && <> · ↓ {formatTokens(outTokens)}</>})
        </span>
      </div>
    </div>
  );
}

// ===== Active todos =====
//
// Pinned right under the running indicator while a turn is in flight, showing
// the most recent TodoWrite tool's checklist. As the assistant marks items
// in_progress/completed and updates the list via subsequent TodoWrite calls,
// this re-renders automatically (messages refetch on message.part.updated).
//
// Visible items show their per-status icon (same as the inline TodoWriteBody);
// completed items collapse to a count summary so the active focus stays
// dominant when the list grows.

const ActiveTodos = memo(function ActiveTodos({ todos }: { todos: Array<Record<string, unknown>> }) {
  // Render at most VISIBLE_TODOS_CAP items inline. Order: current
  // (in_progress) → pending → done so the row the model is actively
  // working on is always on screen even when the list grows past the cap.
  // Overflow collapses into a single faint summary row at the bottom:
  // "+ N pending & M done" / "+ N pending" / "+ M done".
  // Icons: in_progress = filled orange square, pending = empty square,
  // completed = green ✓ in dim text, cancelled = ⊘ struck through.
  const { visible, hiddenPending, hiddenDone } = selectVisibleTodos(todos);
  const summary = formatHiddenTodosSummary(hiddenPending, hiddenDone);
  const lastVisibleIdx = visible.length - 1;
  return (
    <div className="px-4 pb-2 text-[13px]">
      {visible.map((t, i) => {
        const content = String(t.content ?? "");
        const status = String(t.status ?? "pending");
        const isInProgress = status === "in_progress";
        const isCompleted = status === "completed";
        const isCancelled = status === "cancelled";

        let icon = "☐";
        let iconColor: string | undefined;
        let textCls = "text-text-muted";
        if (isInProgress) {
          icon = "■";
          iconColor = CLAUDE_ORANGE;
          textCls = "text-text font-semibold";
        } else if (isCompleted) {
          icon = "✓";
          iconColor = "#22c55e";
          textCls = "text-text-faint";
        } else if (isCancelled) {
          icon = "⊘";
          textCls = "text-text-faint line-through opacity-60";
        }
        // Show the ⎿ corner only on the very first row of the card. The
        // summary row (when present) replaces the last todo row's leading
        // slot with a blank so the gutter stays aligned.
        return (
          <div key={i} className="flex">
            <span className="select-none w-5 shrink-0 text-text-faint">
              {i === 0 ? "⎿" : " "}
            </span>
            <span
              className="select-none w-4 shrink-0"
              style={{ color: iconColor }}
            >
              {icon}
            </span>
            <span className={`flex-1 whitespace-pre-wrap break-words ${textCls}`}>
              {content}
            </span>
          </div>
        );
      })}
      {summary && (
        <div className="flex">
          <span className="select-none w-5 shrink-0 text-text-faint">
            {lastVisibleIdx < 0 ? "⎿" : " "}
          </span>
          <span className="select-none w-4 shrink-0" />
          <span className="flex-1 text-text-faint">{summary}</span>
        </div>
      )}
    </div>
  );
});

// Verbose summary of an Edit/Write/MultiEdit diff: "Added 5 lines",
// "Removed 3 lines", or "Added 5 lines, removed 3 lines". Replaces the
// terse `+5 −3` header so the tool row reads more naturally at a glance.
// First letter capitalized — only the lead verb, not both (natural prose).
function formatFileDiff(additions: number, deletions: number): React.ReactNode {
  const aLead = `Added ${additions} line${additions === 1 ? "" : "s"}`;
  const dLead = `Removed ${deletions} line${deletions === 1 ? "" : "s"}`;
  const dTail = `removed ${deletions} line${deletions === 1 ? "" : "s"}`;
  if (additions > 0 && deletions > 0) {
    return (
      <>
        <span className="text-green-400">{aLead}</span>,{" "}
        <span className="text-red-400">{dTail}</span>
      </>
    );
  }
  if (additions > 0) return <span className="text-green-400">{aLead}</span>;
  if (deletions > 0) return <span className="text-red-400">{dLead}</span>;
  return null;
}

// ===== Context bar =====
//
// Chunky horizontal bar with a dotted "empty" pattern and a SEGMENTED filled
// portion: fresh-input (paid full rate) | cache.write (warm-up, paid full
// rate + 25% surcharge) | cache.read (cached, paid ~10%). Color of the
// fresh segment stages by total usage (green → yellow → orange → red);
// cache.write uses a steady amber to flag the "this turn cost extra to
// warm the cache" bucket; cache.read uses a steady muted teal for the
// "served from cache" bucket.
//
// When the session has gone stale (idle past the Anthropic cache TTL the
// user configured in Settings, AND the cached prefix is non-trivial), an
// amber `⚠ /clear to save Nk tokens` pill renders to the right of the %.
// This is the actionable warning: those tokens are about to flip from
// "served from cache (~10% rate)" to "cache_creation_input_tokens (full
// rate + surcharge)" on the next user message, so the user can either
// /clear (save them entirely) or /compact (shrink the prefix first).

// Cache-segment colors — tuned to read as distinct buckets without
// competing with the stage color of the fresh segment.
const CACHE_WRITE_COLOR = "#f59e0b"; // amber-500: warm-up, expensive
const CACHE_READ_COLOR = "#0ea5a4"; // teal-600: cached, cheap

// Format a token count compactly for the inline stale-cache pill
// ("12k", "120k", "1.2M"). Differs from `formatTokens` (which appends
// "tokens" and never reaches M-scale) because pill space is tight and
// we want a millions suffix once a session crosses 1M (Opus 4.7's full
// window).
function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatIdleDuration(ms: number): string {
  // Coarse human format for the tooltip — exact precision doesn't help.
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

function ContextBar({
  breakdown,
  limit,
  staleCache,
  modelName,
  tooltip,
}: {
  breakdown: ContextBreakdown;
  limit: number;
  staleCache: StaleCacheResult;
  modelName: string | null;
  tooltip?: string;
}) {
  const { pct, segments, freshInput, cacheRead, cacheWrite, totalInput } =
    breakdown;
  // Stage color is driven by total usage (so the % digits + fresh slice
  // share the same warning hue).
  const fill = ctxStageColor(pct);
  const dot = `${fill}55`;
  const segColor = (kind: ContextBreakdown["segments"][number]["kind"]) => {
    if (kind === "fresh") return fill;
    if (kind === "cacheWrite") return CACHE_WRITE_COLOR;
    return CACHE_READ_COLOR;
  };
  // Multi-line tooltip showing the full breakdown. Caller appends any
  // contextual hints (compact recommended, model name, etc.).
  const breakdownLines = [
    `${totalInput.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`,
    modelName ? `Model window: ${modelName}` : null,
    cacheRead > 0
      ? `  · ${cacheRead.toLocaleString()} cache read (cheap, served from cache)`
      : null,
    cacheWrite > 0
      ? `  · ${cacheWrite.toLocaleString()} cache write (warm-up — paid full rate + surcharge this turn)`
      : null,
    freshInput > 0
      ? `  · ${freshInput.toLocaleString()} fresh input (uncached, paid full rate)`
      : null,
    tooltip ?? null,
  ].filter(Boolean);
  return (
    <span
      className="flex items-center gap-1.5 shrink-0"
      title={breakdownLines.join("\n")}
    >
      <span
        // Keep the `w-24` class — mobile.css selects on it to hide the
        // track on phones. Don't rename the width without updating that
        // CSS rule.
        className="inline-block w-24 h-3 rounded-[2px] overflow-hidden align-middle"
        style={{
          backgroundColor: "#1b1e25",
          backgroundImage: `radial-gradient(circle, ${dot} 1.2px, transparent 1.4px)`,
          backgroundSize: "4px 4px",
        }}
      >
        {/* Render segments inline; each takes its share of the WHOLE track
            (not of the filled portion), so widths sum to `pct` and the
            empty remainder is the dotted pattern beneath. */}
        {segments.map((s, i) =>
          s.pct > 0 ? (
            <span
              key={s.kind}
              className="inline-block h-full align-top"
              style={{
                width: `${s.pct}%`,
                backgroundColor: segColor(s.kind),
                // Subtle inset between segments so adjacent slices read as
                // distinct buckets even when their colors are close.
                boxShadow:
                  i > 0 ? "inset 1px 0 0 rgba(0,0,0,0.35)" : undefined,
              }}
            />
          ) : null,
        )}
      </span>
      <span
        className="tabular-nums text-[12px] font-semibold"
        style={{ color: fill }}
      >
        {pct}%
      </span>
      {staleCache.isStale && (
        // Visible stale-cache pill — only appears when the session has
        // been idle past the configured Anthropic cache TTL (5m or 1h,
        // see Settings) AND the cached prefix is non-trivial. The next
        // user message will pay full rate + surcharge to re-warm exactly
        // these tokens; /clear avoids the bill entirely.
        <span
          className="tabular-nums text-[11px] font-medium px-1.5 rounded-sm shrink-0"
          style={{
            color: CACHE_WRITE_COLOR,
            backgroundColor: `${CACHE_WRITE_COLOR}1f`,
          }}
          title={[
            `Session idle for ${formatIdleDuration(staleCache.idleMs)} — prompt cache has expired.`,
            `${staleCache.staleTokens.toLocaleString()} tokens currently in cache will be re-billed as cache_creation_input_tokens on your next message (full input rate + 25% surcharge, or 2× for 1h cache).`,
            "",
            "Actions:",
            "  · /clear  — start a fresh session, skip the re-warm cost entirely",
            "  · /compact — shrink the prefix before re-warming",
            "",
            "(Cache TTL is set by opencode; bui predicts staleness from the Settings → Prompt cache TTL value. If this fires at the wrong time, that setting probably doesn't match opencode's cache_control.ttl.)",
          ].join("\n")}
        >
          ⚠ /clear to save {formatTokensCompact(staleCache.staleTokens)} tokens
        </span>
      )}
    </span>
  );
}

// ===== Model picker =====
//
// Compact dropdown that shows the active model on the left (either the
// user-selected override or the last model used by the server). Clicking the
// label expands an absolutely-positioned list above the footer. Selecting a
// row sets the per-session override (persisted in localStorage by ChatPanel);
// the "Default" row clears it so prompt_async falls back to opencode's default.

function ModelPicker({
  modelLabel,
  models,
  modelOverride,
  defaultModel,
  onOpen,
  onSelect,
}: {
  modelLabel: string | null;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  onOpen: () => void;
  onSelect: (m: ModelSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-away to dismiss the dropdown. Using mousedown (not click) so we
  // close before the inner button's onClick re-toggles. Buttons inside the
  // popup still fire their onClick because we check containment.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Label precedence — show what will be used for the NEXT prompt, not what
  // the last response happened to use:
  //   1. user-picked override (explicit choice)
  //   2. server default for the first connected provider (when no override —
  //      "Server default" was picked, so we show the actual default name)
  //   3. last assistant message's modelID (fallback while defaultModel still loading)
  //   4. "opencode" stub (initial render, nothing loaded yet)
  const label = modelOverride
    ? `${modelOverride.providerID}/${modelOverride.modelID}${modelOverride.variant ? `@${modelOverride.variant}` : ""}`
    : defaultModel
      ? `${defaultModel.providerID}/${defaultModel.modelID}`
      : modelLabel
        ? modelLabel
        : null;

  // Group models by providerID so the list reads e.g. "anthropic" → 3 models.
  const groups = useMemo(() => {
    if (!models) return null;
    const map = new Map<string, OpencodeModel[]>();
    for (const m of models) {
      if (m.enabled === false || m.status === "deprecated") continue;
      const arr = map.get(m.providerID) ?? [];
      arr.push(m);
      map.set(m.providerID, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const isActive = (m: OpencodeModel, variantId?: string): boolean => {
    if (modelOverride) {
      return (
        modelOverride.providerID === m.providerID &&
        modelOverride.modelID === m.id &&
        (modelOverride.variant ?? undefined) === variantId
      );
    }
    return false;
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        className="truncate text-[12px] text-text-muted hover:text-text flex items-center gap-1"
        onClick={() => {
          if (!open) onOpen();
          setOpen((v) => !v);
        }}
        title="Pick model for next prompt"
      >
        <span className="truncate">{label ?? <span className="opacity-60">opencode</span>}</span>
        <span className="text-text-faint text-[9px]">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 bottom-full mb-1 z-20 min-w-[240px] max-h-[360px] overflow-y-auto rounded border border-border bg-bg-elev shadow-lg text-[12px]"
        >
          <button
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className={
              "w-full text-left px-2 py-1 hover:bg-bg-soft border-b border-border " +
              (modelOverride == null ? "text-text" : "text-text-muted")
            }
          >
            <span className="mr-1" style={{ color: modelOverride == null ? CLAUDE_ORANGE : "transparent" }}>●</span>
            Server default
          </button>
          {!groups && (
            <div className="px-2 py-2 text-text-faint">Loading…</div>
          )}
          {groups?.length === 0 && (
            <div className="px-2 py-2 text-text-faint">No models</div>
          )}
          {groups?.map(([providerID, ms]) => (
            <div key={providerID} className="py-1">
              <div className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-faint">
                {providerID}
              </div>
              {ms.map((m) => {
                const variants = m.variants ?? [];
                return (
                  <div key={m.id}>
                    <button
                      onClick={() => {
                        onSelect({ providerID: m.providerID, modelID: m.id });
                        setOpen(false);
                      }}
                      className={
                        "w-full text-left px-2 py-0.5 hover:bg-bg-soft flex justify-between gap-2 " +
                        (isActive(m) ? "text-text" : "text-text-muted")
                      }
                    >
                      <span className="truncate flex items-center gap-1">
                        <span style={{ color: isActive(m) ? CLAUDE_ORANGE : "transparent" }}>●</span>
                        <span>{m.name}</span>
                      </span>
                      {m.limit?.context ? (
                        <span className="text-text-faint text-[10px] shrink-0">
                          {Math.round(m.limit.context / 1000)}k
                        </span>
                      ) : null}
                    </button>
                    {variants.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => {
                          onSelect({ providerID: m.providerID, modelID: m.id, variant: v.id });
                          setOpen(false);
                        }}
                        className={
                          "w-full text-left pl-6 pr-2 py-0.5 hover:bg-bg-soft text-[11px] " +
                          (isActive(m, v.id) ? "text-text" : "text-text-faint")
                        }
                      >
                        <span style={{ color: isActive(m, v.id) ? CLAUDE_ORANGE : "transparent" }}>●</span>{" "}
                        @{v.id}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Session toolbar =====
//
// Three compact buttons in the footer right rail: fork (copy current state
// into a new session+window), compact (in-place summarization to free
// context), delete (DELETE on the server + kill the tmux window). Fork and
// delete are disabled when the panel doesn't know its owning tmux window.

// ScheduledTasksCard — pinned card above the composer showing this session's
// scheduled prompts (created by the AI's `schedule` opencode tool) with a
// per-row delete. A card (not a footer item) so it renders on BOTH desktop and
// mobile with no mobile-CSS edits. See docs/bui-tools-scheduler.md.
const ScheduledTasksCard = memo(function ScheduledTasksCard({
  jobs,
  error,
  onDelete,
  onClose,
}: {
  jobs: ScheduledJob[];
  error: string | null;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>⏰</span>
        <span className="text-text">Scheduled</span>
        {jobs.length > 0 && <span className="text-text-faint">· {jobs.length}</span>}
        <button
          onClick={onClose}
          className="ml-auto px-1 rounded text-text-faint hover:text-text-muted"
          title="Close"
        >
          ×
        </button>
      </div>
      {error ? (
        <div className="text-red-400 break-words">{error}</div>
      ) : jobs.length === 0 ? (
        <div className="text-text-muted">No scheduled tasks in this session.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {jobs.map((j) => {
            const next = describeNextRun(j.cron, j.recurring);
            return (
              <div key={j.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-text truncate" title={j.prompt}>
                    {j.label || j.prompt}
                  </div>
                  <div className="flex items-center gap-2 text-text-faint font-mono text-[11px]">
                    <span className="shrink-0">
                      {describeCron(j.cron, j.recurring)}
                    </span>
                    {next && (
                      <span
                        className="shrink-0 truncate"
                        title="Next run"
                        style={{ color: CLAUDE_ORANGE }}
                      >
                        · next {next}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onDelete(j.id)}
                  className="shrink-0 px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/30"
                  title="Cancel this scheduled task"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// SecretsCard — pinned card above the composer for managing the secrets the
// agent can use. The user types a key + value here; the value travels to the
// box (renderer → IPC/RPC → bui-server store) and is NEVER returned or shown
// again — the list is metadata only (key, scope, hint). Agents read secrets via
// the secret_list / secret_provide opencode tools, which materialize the value
// to a 0600 file on the box and hand the agent only the path, so the value
// never enters the AI transcript. Modeled on ScheduledTasksCard so it renders
// on desktop AND mobile with no mobile-CSS edits.
const SecretsCard = memo(function SecretsCard({
  secrets,
  error,
  sessionId,
  onSave,
  onDelete,
  onClose,
}: {
  secrets: SecretMeta[];
  error: string | null;
  sessionId: string;
  onSave: (input: {
    key: string;
    value: string;
    scope: SecretScope;
    sessionID?: string | null;
    hint?: string;
  }) => Promise<boolean>;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<SecretScope>("shared");
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);

  const keyValid = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key);
  const canSave = keyValid && value.length > 0 && !saving;

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    void onSave({
      key,
      value,
      scope,
      // Pass sessionID for session scope (the owner) AND project scope (so the
      // server resolves the workspace name from this chat's session).
      sessionID: scope === "session" || scope === "project" ? sessionId : null,
      hint: hint.trim() || undefined,
    }).then((ok) => {
      setSaving(false);
      if (ok) {
        // Clear value immediately (don't keep the secret in component state),
        // and reset the form for the next entry.
        setKey("");
        setValue("");
        setHint("");
      }
    });
  };

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ color: CLAUDE_ORANGE }}>🔑</span>
        <span className="text-text">Secrets</span>
        {secrets.length > 0 && <span className="text-text-faint">· {secrets.length}</span>}
        <button
          onClick={onClose}
          className="ml-auto px-1 rounded text-text-faint hover:text-text-muted"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Add / update form */}
      <div className="flex flex-col gap-1.5 mb-2">
        <div className="flex flex-wrap gap-1.5">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="KEY (e.g. GITHUB_PAT)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`min-w-0 flex-1 rounded border bg-bg px-1.5 py-1 font-mono text-text outline-none ${
              key && !keyValid ? "border-red-500/60" : "border-border"
            }`}
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as SecretScope)}
            className="rounded border border-border bg-bg px-1.5 py-1 text-text outline-none"
            title="shared = every session · project = every chat in this workspace · session = only this chat"
          >
            <option value="shared">shared</option>
            <option value="project">this project</option>
            <option value="session">this session</option>
          </select>
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="value (stored on the box; never shown again)"
          type="password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="w-full rounded border border-border bg-bg px-1.5 py-1 font-mono text-text outline-none"
        />
        <div className="flex flex-wrap gap-1.5">
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="hint for the agent (optional, e.g. 'git push token')"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-1 text-text outline-none"
          />
          <button
            onClick={submit}
            disabled={!canSave}
            className="shrink-0 px-2 py-1 rounded border disabled:opacity-40"
            style={{ borderColor: CLAUDE_ORANGE + "88", color: CLAUDE_ORANGE }}
            title="Store this secret on the box"
          >
            {saving ? "saving…" : "Save"}
          </button>
        </div>
        {key && !keyValid && (
          <div className="text-red-400 text-[11px]">
            Key must start with a letter/underscore, then letters/digits/underscores (max 64).
          </div>
        )}
      </div>

      {error && <div className="text-red-400 break-words mb-1">{error}</div>}

      {/* Existing secrets (metadata only — no values) */}
      {secrets.length === 0 ? (
        <div className="text-text-muted">
          No secrets yet. Add one above; the agent uses it via the secret_provide tool
          without ever seeing the value.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 border-t border-border pt-1.5">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-text font-mono truncate">{s.key}</span>
                  <span
                    className="shrink-0 rounded px-1 text-[10px] text-text-faint border border-border"
                    title={
                      s.scope === "shared"
                        ? "Available to every session"
                        : s.scope === "project"
                          ? `Available to every chat in project "${s.project ?? ""}"`
                          : "Available only to this session"
                    }
                  >
                    {s.scope === "shared"
                      ? "shared"
                      : s.scope === "project"
                        ? `project:${s.project ?? "?"}`
                        : "session"}
                  </span>
                </div>
                {s.hint && (
                  <div className="text-text-faint text-[11px] truncate" title={s.hint}>
                    {s.hint}
                  </div>
                )}
              </div>
              <button
                onClick={() => onDelete(s.id)}
                className="shrink-0 px-1.5 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/30"
                title="Delete this secret"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// SessionToolbar — footer affordances. fork / compact / delete moved out of the
// footer (they live in the header ⋯ menu); only the ⏰ schedules toggle remains
// here so its live count is always visible next to the composer.
function SessionToolbar({
  scheduleCount,
  onSchedules,
  onSecrets,
}: {
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
}) {
  return (
    <span className="flex items-center gap-1 text-[10px]">
      <button
        onClick={onSchedules}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="View / cancel scheduled tasks"
      >
        ⏰ schedules{scheduleCount > 0 ? ` (${scheduleCount})` : ""}
      </button>
      <button
        onClick={onSecrets}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="Manage secrets the agent can use (values never enter the chat)"
      >
        🔑 secrets
      </button>
    </span>
  );
}

// ===== Attachment chips =====
//
// Strip of chips above the input. Each chip carries filename + status. Click
// the × to remove. Uploading shows a small spinner; error tints red with the
// remote error in the tooltip.

function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  // pt-2 above + pb-2 below leaves a clear gap between the chip row and the
  // input area's top border.
  return (
    <div className="shrink-0 px-4 pt-2 pb-2 flex flex-wrap gap-1 text-[11px]">
      {attachments.map((a) => {
        const color =
          a.status === "error"
            ? "text-red-300 border-red-500/30"
            : a.status === "uploading"
              ? "text-text-faint border-border"
              : "text-text border-border-strong";
        return (
          <span
            key={a.id}
            className={`rounded-md border px-1.5 py-0.5 flex items-center gap-1 bg-bg-elev ${color}`}
            title={a.status === "error" ? a.errorMsg : a.remotePath}
          >
            {a.status === "uploading" && (
              <span className="inline-block animate-spin" style={{ color: CLAUDE_ORANGE }}>
                ↻
              </span>
            )}
            <span className="truncate max-w-[200px]">{a.filename}</span>
            <button
              onClick={() => onRemove(a.id)}
              className="text-text-faint hover:text-red-300 leading-none px-0.5"
              title="Remove"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ===== Typeahead popup =====
//
// Anchored above the input area; rows for command/agent/file results. Keyboard
// nav is handled by InputArea (Up/Down/Enter/Tab/Esc) — this component is
// purely visual + mouse selection.

function TypeaheadPopup({
  rows,
  selectedIdx,
  onSelect,
  onHover,
  emptyHint,
}: {
  rows: TypeaheadRow[];
  selectedIdx: number;
  onSelect: (row: TypeaheadRow) => void;
  onHover: (idx: number) => void;
  emptyHint: string;
}) {
  return (
    <div className="shrink-0 mx-4 mb-1 max-h-[240px] overflow-y-auto rounded border border-border bg-bg-elev shadow-lg text-[12px]">
      {rows.length === 0 && (
        <div className="px-2 py-1 text-text-faint italic">{emptyHint}</div>
      )}
      {rows.map((row, idx) => {
        const active = idx === selectedIdx;
        // Special-case the "no attachment support" warning row — render in
        // red, non-selectable (clicking is a no-op).
        const isWarning = row.kind === "file" && row.key === "" && row.primary.startsWith("⚠");
        if (isWarning) {
          return (
            <div
              key={`warn:${idx}`}
              className="px-2 py-1 flex items-center gap-2 text-red-300 bg-red-900/15 cursor-default"
            >
              <span className="truncate flex-1">{row.primary}</span>
              {row.secondary && (
                <span className="text-red-400/70 truncate max-w-[50%] text-[11px]">
                  {row.secondary}
                </span>
              )}
            </div>
          );
        }
        return (
          <button
            key={`${row.kind}:${row.key}`}
            onClick={() => onSelect(row)}
            onMouseEnter={() => onHover(idx)}
            className={
              "w-full text-left px-2 py-1 flex items-center gap-2 " +
              (active ? "bg-bg-soft text-text" : "text-text-muted hover:bg-bg-soft")
            }
          >
            <span className="truncate flex-1">{row.primary}</span>
            {row.secondary && (
              <span className="text-text-faint truncate max-w-[50%] text-[11px]">
                {row.secondary}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ===== Retry card =====
//
// Rendered while session.status reports a "retry" attempt — opencode is
// re-trying the underlying model call (rate limit, 5xx, etc) and surfaces an
// action describing what the user can do (e.g. "Switch model"). Without
// this the running indicator just sits there silently.

function RetryCard({
  info,
}: {
  info: {
    attempt: number;
    message: string;
    next: number;
    action?: { title: string; message: string; label: string; link?: string };
  };
}) {
  const headline = info.action?.title || `Retrying… (attempt ${info.attempt})`;
  const body = info.action?.message || info.message;
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>↻</span>
        <span className="text-text">{headline}</span>
        {info.attempt > 0 && (
          <span className="text-text-faint">· attempt {info.attempt}</span>
        )}
      </div>
      {body && (
        <div className="text-text-muted break-words mb-1">{body}</div>
      )}
      {info.action?.link && (
        <div>
          <a
            href={info.action.link}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block px-2 py-0.5 rounded border border-border-strong text-text hover:bg-bg-soft"
          >
            {info.action.label || "Open"}
          </a>
        </div>
      )}
    </div>
  );
}

// ===== Compaction card =====
//
// Rendered while session.next.compaction.* events stream in. "running" shows
// the live-built summary fragment; "done" shows the first line of the final
// summary for a beat before the parent clears state.

function CompactionCard({
  state,
}: {
  state: { reason: string; text: string; phase: "running" | "done" };
}) {
  const isRunning = state.phase === "running";
  const firstLine = state.text.split("\n").find((s) => s.trim()) ?? "";
  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>
          <span className={isRunning ? "inline-block animate-pulse" : "inline-block"}>
            ✻
          </span>
        </span>
        <span className="text-text">
          {isRunning ? "Compacting…" : "Compacted"}
        </span>
        {state.reason && (
          <span className="text-text-faint">· {state.reason}</span>
        )}
      </div>
      {isRunning ? (
        state.text && (
          <div className="text-text-muted break-words whitespace-pre-wrap line-clamp-3 font-mono">
            {state.text}
          </div>
        )
      ) : (
        firstLine && (
          <div className="text-text-muted break-words font-mono">{firstLine}</div>
        )
      )}
    </div>
  );
}

// ===== Permission card =====
//
// Rendered when opencode has paused a tool waiting for user approval. We
// surface enough info to make a sensible call without digging into the
// transcript: category (e.g. "external_directory", "bash"), the filepath or
// command if available in metadata, and the "always" patterns scope.
//
// Three options match the API's three reply enum values:
//   - "once"    — allow this single execution
//   - "always"  — allow this AND save the patterns for future auto-approval
//   - "reject"  — deny; the tool errors out

function PermissionCard({
  perm,
  onReply,
}: {
  perm: PermissionRequest;
  onReply: (reply: "once" | "always" | "reject") => void;
}) {
  const meta = perm.metadata ?? {};
  const filepath = typeof meta.filepath === "string" ? meta.filepath : undefined;
  const command = typeof meta.command === "string" ? meta.command : undefined;
  const detail = filepath ?? command ?? "";
  const alwaysScope =
    perm.always && perm.always.length > 0 ? perm.always.join(", ") : null;

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span style={{ color: CLAUDE_ORANGE }}>✻</span>
        <span className="text-text">Permission needed</span>
        <span className="text-text-faint">· {perm.permission}</span>
      </div>
      {detail && (
        <div className="text-text-muted break-all mb-2 font-mono">{detail}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onReply("once")}
          className="px-2 py-0.5 rounded border border-border-strong text-text hover:bg-bg-soft"
        >
          Allow once
        </button>
        {alwaysScope && (
          <button
            onClick={() => onReply("always")}
            className="px-2 py-0.5 rounded text-bg"
            style={{ backgroundColor: CLAUDE_ORANGE }}
            title={`Always allow ${alwaysScope}`}
          >
            Always allow {alwaysScope}
          </button>
        )}
        <button
          onClick={() => onReply("reject")}
          className="px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/30"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// ===== Question card =====
//
// Rendered when Claude invokes the Question tool mid-task. Each QuestionRequest
// may contain multiple QuestionInfo entries; we render one block per question.
// The user selects option(s) and hits Submit — or clicks × to reject the whole
// request (Claude receives an error and may handle it gracefully).

function QuestionCard({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequest;
  onReply: (answers: string[][]) => void;
  onReject: () => void;
}) {
  // One Set<string> per question tracks selected option labels.
  const [selected, setSelected] = useState<Set<string>[]>(() =>
    request.questions.map(() => new Set<string>()),
  );
  // One custom text value per question (only used when info.custom is true).
  const [customValues, setCustomValues] = useState<string[]>(() =>
    request.questions.map(() => ""),
  );

  function toggleOption(qIdx: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      if (multiple) {
        if (next[qIdx].has(label)) next[qIdx].delete(label);
        else next[qIdx].add(label);
      } else {
        next[qIdx] = new Set([label]);
      }
      return next;
    });
  }

  function handleSubmit() {
    onReply(buildQuestionAnswers(selected, customValues));
  }

  // Submit is enabled once every question has either a selection OR typed text.
  const canSubmit = canSubmitQuestion(selected, customValues);

  return (
    <div
      className="rounded-md border bg-bg-elev px-3 py-2 text-[12px]"
      style={{ borderColor: CLAUDE_ORANGE + "55" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: CLAUDE_ORANGE }}>?</span>
        <span className="text-text font-medium">Question</span>
        <button
          onClick={onReject}
          className="ml-auto text-text-faint hover:text-text leading-none"
          title="Reject / dismiss"
        >
          ×
        </button>
      </div>

      <div className="space-y-3">
        {request.questions.map((info, qIdx) => (
          <div key={qIdx}>
            {/* Header as a short label, question as the full body */}
            <div className="text-text-muted mb-0.5 font-medium">{info.header}</div>
            <div className="text-text mb-1.5 leading-snug">{info.question}</div>

            {/* Option buttons */}
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              {info.options.map((opt) => {
                const isSelected = selected[qIdx].has(opt.label);
                return (
                  <button
                    key={opt.label}
                    onClick={() => toggleOption(qIdx, opt.label, info.multiple ?? false)}
                    title={opt.description}
                    className={[
                      "px-2 py-0.5 rounded border text-[12px] transition-colors",
                      isSelected
                        ? "text-bg border-transparent"
                        : "text-text border-border-strong hover:bg-bg-soft",
                    ].join(" ")}
                    style={isSelected ? { backgroundColor: CLAUDE_ORANGE } : undefined}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Free-text input — always available so the user can type a
                custom reply for any question, even when opencode didn't flag
                it as custom. Combined with any selected option(s) on submit. */}
            <input
              type="text"
              placeholder="Or type your own answer…"
              value={customValues[qIdx]}
              onChange={(e) => {
                const v = e.target.value;
                setCustomValues((prev) => {
                  const next = [...prev];
                  next[qIdx] = v;
                  return next;
                });
              }}
              onKeyDown={(e) => {
                // Enter submits when the whole request is answerable (matches
                // the composer's submit-on-Enter muscle memory). Shift+Enter
                // is left alone for anyone who wants a literal newline-free
                // multi-field flow.
                if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="mt-1.5 w-full rounded border border-border bg-transparent px-2 py-0.5 text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong"
            />
          </div>
        ))}
      </div>

      <hr className="my-2 mx-2 border-border" />

      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onReject}
          className="px-2 py-0.5 rounded text-text-faint hover:text-text border border-border"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-2 py-0.5 rounded text-bg disabled:opacity-40"
          style={{ backgroundColor: CLAUDE_ORANGE }}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

// ===== Input area =====

// Press-and-hold mic button. Plain tap = dictate (transcript inserted at
// caret). Hold + ⌥ on desktop, or a long-press (≥500ms) on touch, = command
// mode (transcript routed through the rules classifier + Groq llama).
//
// **Mode source of truth lives in `useVoiceRecorder`** — see the W2 fix in
// PR #4 review. The previous design kept a parallel `modeRef` in the
// button which never propagated to the hook, so long-press on touch
// transcribed as dictate. The button now passes "dictate" or "command"
// at press time (based on the ⌥ modifier) and the HOOK schedules the
// long-press promotion + exposes the current mode for the label.
//
// Visual states (phase):
//   - idle       → microphone glyph in text-muted
//   - requesting → spinner in text-faint (waiting on mic permission)
//   - recording  → filled circle pulsing in red, hint text "release to send"
//   - processing → spinner in accent (Groq round-trip in flight)
//   - error      → muted-red mic; click to retry by pressing again
function MicButton({
  phase,
  mode,
  onStart,
  onStop,
  onCancel,
  floating = false,
}: {
  phase: VoicePhase;
  mode: VoiceMode;
  onStart: (mode: VoiceMode, opts?: { promote?: boolean }) => Promise<void>;
  onStop: () => void;
  onCancel: () => void;
  // `floating` = the mobile WhatsApp-style push-to-talk FAB (bottom-right,
  // above the composer). It is dictation-only: it starts in "dictate" with
  // promotion DISABLED so a normal speak-length hold isn't reclassified as a
  // voice command. The inline (non-floating) variant keeps the desktop ⌥ /
  // long-press → command behavior.
  floating?: boolean;
}) {
  const recording = phase === "recording" || phase === "requesting";
  const busy = phase === "processing";

  // Track press state with a REF, not the rendered `recording` prop. This is
  // THE fix for "hold → red → release → nothing happens": the pointerup
  // handler used to gate on `recording`, which is derived from the `phase`
  // PROP. Phase transitions (idle→requesting→recording) are async React
  // state updates in the parent hook; the button only re-renders once they
  // propagate. If the user releases before `phase` has re-rendered to
  // "recording" (fast on a snappy device, or always during the "requesting"
  // window), the closure's `recording` was still false → `onStop()` was
  // never called → the recorder ran until the 60s maxDuration cap, silently.
  // A ref flips synchronously on pointerdown so release ALWAYS reaches stop.
  const pressActiveRef = useRef(false);

  // Pointer-based handlers — single code path for mouse + touch + pen so
  // we don't have to worry about emulated mouse events firing AFTER touch
  // on iOS / Android WebView (the classic "double-tap" bug).
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (busy || pressActiveRef.current) return;
    e.preventDefault();
    pressActiveRef.current = true;
    if (floating) {
      // PTT FAB: always plain dictation, no command promotion.
      onStart("dictate", { promote: false });
    } else {
      // Desktop ⌥-modifier promotes to command IMMEDIATELY. Otherwise we
      // start in dictate and let the hook's longPressMs timer flip us.
      const initial: VoiceMode = e.altKey ? "command" : "dictate";
      onStart(initial);
    }
    // Capture so onPointerUp fires even if the cursor leaves the button.
    try {
      (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    } catch { /* not all browsers support pointer capture */ }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    e.preventDefault();
    // Always stop (not cancel) on a deliberate release — even if `phase` is
    // still "requesting" (the recorder hasn't been constructed yet). The
    // hook's stop() handles the requesting-window case: it records a
    // stop-requested intent so the in-flight getUserMedia tears down cleanly
    // instead of recording to the cap. A genuine too-quick press surfaces as
    // the onEmpty("too-short") notice, never silence.
    onStop();
  };

  const handlePointerCancel = () => {
    // pointercancel is an OS-level abort of the gesture (scroll took over,
    // app backgrounded). That's the one case where discarding is right.
    if (!pressActiveRef.current) return;
    pressActiveRef.current = false;
    onCancel();
  };

  const label = busy
    ? "transcribing…"
    : recording
      ? floating
        ? "release to insert"
        : mode === "command"
          ? "release · command"
          : "release · dictate"
      : floating
        ? "hold to talk"
        : "hold to speak (⌥ = command)";

  // Floating PTT FAB: round bubble, bottom-right (positioned by the
  // `.mobile-ptt-fab` rule in mobile.css — visual/layout lives there per the
  // mobile-CSS invariant; this component only sets state modifier classes).
  if (floating) {
    return (
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        title={label}
        aria-label={label}
        className={
          "mobile-ptt-fab" +
          (busy
            ? " mobile-ptt-fab--busy"
            : recording
              ? " mobile-ptt-fab--recording"
              : phase === "error"
                ? " mobile-ptt-fab--error"
                : "")
        }
        style={{ touchAction: "none" }}
      >
        {busy ? "⋯" : "🎙"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      title={label}
      aria-label={label}
      // Inline glyph button — matches the `>` prompt next to it in size and
      // baseline so the input row stays one-line-tall when the textarea has
      // a single line. No round background bubble (the previous w-7 h-7
      // version forced the row to 28px and made it visually two lines).
      // Recording adds a subtle pulse on the glyph itself; busy swaps to a
      // dots spinner. Pointer-capture is still set on pointerdown so we
      // get the pointerup even if the user drifts off.
      className={
        "select-none pt-px shrink-0 leading-none bg-transparent " +
        (busy
          ? "text-accent cursor-progress"
          : recording
            ? "text-red-400 animate-pulse"
            : phase === "error"
              ? "text-red-400 hover:text-red-300"
              : "text-text-faint hover:text-text-muted")
      }
      style={{ touchAction: "none" }}  // suppress mobile pull-to-refresh
    >
      {busy ? "⋯" : "🎙"}
    </button>
  );
}

function InputArea({
  input,
  setInput,
  inputRef,
  submit,
  abort,
  running,
  branch,
  refreshing,
  modelLabel,
  chatAutoAllow,
  setChatAutoAllow,
  voiceEnabled,
  voicePhase,
  voiceMode,
  voiceRecording,
  voiceProcessing,
  startVoice,
  stopVoice,
  cancelVoice,
  tokens,
  staleCache,
  models,
  modelOverride,
  defaultModel,
  activeModel,
  onOpenModels,
  onSelectModel,
  scheduleCount,
  onSchedules,
  onSecrets,
  typeaheadOpen,
  typeaheadExactMatch,
  onTypeaheadConfirm,
  onTypeaheadMove,
  onTypeaheadCancel,
  onHistoryUp,
  onHistoryDown,
  onQueuePop,
  onPaste,
}: {
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  submit: () => void;
  abort: () => void;
  running: boolean;
  branch: string | null;
  refreshing: boolean;
  modelLabel: string | null;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  // Voice (Groq STT). When voiceEnabled=false the MicButton is hidden so
  // users without a configured API key never see the affordance. start/stop/
  // cancel come from useVoiceRecorder; phase drives the icon state; mode is
  // owned by the hook (W2: previously the button kept its own copy and the
  // two drifted, so long-press never reached the hook as "command").
  voiceEnabled: boolean;
  voicePhase: VoicePhase;
  voiceMode: VoiceMode;
  // Derived flags so the input row's pulse class doesn't need to recompute
  // these on every keystroke. "recording" covers both pre-permission
  // (requesting) and active capture; "processing" is the post-stop
  // transcribe round-trip. Both render the same pulsing affordance — the
  // user only cares "is the mic busy".
  voiceRecording: boolean;
  voiceProcessing: boolean;
  startVoice: (mode: VoiceMode, opts?: { promote?: boolean }) => Promise<void>;
  stopVoice: () => void;
  cancelVoice: () => void;
  tokens: TokenUsage | null;
  // Stale-prompt-cache result: when isStale is true the footer shows
  // "/clear to save Nk tokens" next to the context bar. Computed at the
  // panel scope so the tick interval doesn't run inside InputArea.
  staleCache: StaleCacheResult;
  models: OpencodeModel[] | null;
  modelOverride: ModelSelection | null;
  defaultModel: { providerID: string; modelID: string } | null;
  // Active model resolved by the parent (modelOverride ?? defaultModel,
  // looked up against `models`). Used to size the context bar against the
  // real provider window (e.g. 1M for Opus 4.7) instead of the 200k
  // fallback — without this the bar saturates at "100%" while the
  // provider happily keeps serving requests, which is misleading.
  activeModel: OpencodeModel | null;
  onOpenModels: () => void;
  onSelectModel: (m: ModelSelection | null) => void;
  scheduleCount: number;
  onSchedules: () => void;
  onSecrets: () => void;
  typeaheadOpen: boolean;
  typeaheadExactMatch: boolean;
  onTypeaheadConfirm: () => void;
  onTypeaheadMove: (dir: 1 | -1) => void;
  onTypeaheadCancel: () => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onQueuePop: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  // Persistent context usage — shown next to the model name in the footer
  // whenever the session has had at least one assistant turn (tokens > 0).
  // The running indicator above shows the LIVE version while generating;
  // this one is the resting baseline.
  //
  // Denominator is the ACTIVE model's real context window when known
  // (Opus 4.7 = 1M, Sonnet 4 = 200k, etc.) so the bar reflects what the
  // provider will actually accept on the next request. Falls back to
  // ASSUMED_CONTEXT_TOKENS (200k) when no model is selected yet.
  // Context window numerator = input + cache.read + cache.write. All three
  // input buckets are disjoint and ALL consume the request's context window;
  // the previous formula omitted cache.write and under-reported the bar on
  // cache-warming turns. computeContextBreakdown also produces the per-
  // segment widths the SEGMENTED ContextBar needs (uncached vs warm vs
  // cached) so the user can see the warm-up bucket without hovering.
  const ctxLimit = resolveContextLimit(activeModel);
  const ctxBreakdown = computeContextBreakdown(tokens, ctxLimit);
  const ctxTokens = ctxBreakdown.totalInput;
  const ctxPct = ctxBreakdown.pct;
  // Detect mobile shell (touch device using the no-window.api branch with
  // MobileApp + .mobile-body wrapper). MicButton is only rendered there;
  // on desktop the keyboard shortcut (Ctrl+M / Enter / Esc) drives voice.
  // Read once on mount via a ref callback so we don't pay a per-render
  // closest() cost.
  const [isMobileShell, setIsMobileShell] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rowRef.current) {
      setIsMobileShell(!!rowRef.current.closest(".mobile-body"));
    }
  }, []);
  // Pulsing border on the input row while the recorder is active OR the
  // transcribe round-trip is in flight. Same affordance for both phases
  // (the user only cares "the mic is busy"). Implemented as a color +
  // shadow swap on the existing top/bottom dividers — border width stays
  // 1px in both states so there's no row jump when recording toggles.
  const voiceActive = voiceRecording || voiceProcessing;
  return (
    <div className="shrink-0" ref={rowRef}>
      {/* Mobile push-to-talk FAB (WhatsApp-style, bottom-right above the
          composer). Hold to record, release to insert the transcript into
          the composer for review. Positioned + sized by `.mobile-ptt-fab` in
          mobile.css; only rendered in the mobile shell with a Groq key set.
          Desktop voice stays keyboard-driven (Ctrl+M / Enter / Esc). */}
      {voiceEnabled && isMobileShell && (
        <MicButton
          phase={voicePhase}
          mode={voiceMode}
          onStart={startVoice}
          onStop={stopVoice}
          onCancel={cancelVoice}
          floating
        />
      )}
      {/* Error banner moved to ChatPanel scope (dismissable + closer to the */}
      {/* attachment strip). Nothing rendered here for sendError anymore. */}
      {/* Top divider — white-ish, matches Claude TUI. Turns into a pulsing */}
      {/* red line while voice is active so the user has clear peripheral */}
      {/* feedback that the mic is hot (the `>` glyph also recolors red). */}
      {/* Border width stays at 1px in both states to avoid a 1px row jump */}
      {/* when recording starts/stops. */}
      <div
        className={
          voiceActive
            ? "border-t border-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            : "border-t border-text/25"
        }
      />
      {/* Input row — no box, generous vertical padding. The mic affordance */}
      {/* on desktop is keyboard-only (Ctrl+M to toggle, Enter to stop+send, */}
      {/* Esc to cancel); the visible feedback is the pulsing border above + */}
      {/* below this row. On mobile the mic lives in the floating PTT FAB */}
      {/* above the composer (rendered at the top of this wrapper). */}
      <div className="px-4 py-3 flex items-start gap-2">
        <span
          className="select-none pt-px shrink-0"
          style={{ color: voiceActive ? "#f87171" : CLAUDE_ORANGE }}
          title={
            voiceActive
              ? voiceProcessing
                ? "Transcribing… (esc cancels)"
                : "Recording — enter to send, ctrl+m to stop, esc to cancel"
              : undefined
          }
        >
          {">"}
        </span>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Typeahead nav. Arrows move, Tab/Enter insert the highlighted
            // row, Esc dismisses. EXCEPTION: when the input text already
            // exactly matches the highlighted row's primary (e.g. user typed
            // `/clear` fully), Enter dismisses the popup and SUBMITS so the
            // command executes in one keystroke instead of two.
            if (typeaheadOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                onTypeaheadMove(1);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                onTypeaheadMove(-1);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                onTypeaheadConfirm();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (typeaheadExactMatch) {
                  onTypeaheadCancel();
                  submit();
                } else {
                  onTypeaheadConfirm();
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onTypeaheadCancel();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              submit();
              return;
            }
            // Prompt history when typeahead is closed. Only navigate history
            // when the caret is already on the first line (Up) or last line
            // (Down) — otherwise let the cursor move within the multiline text.
            // While running, Up on an empty-or-first-line input pops the last
            // queued message back into the input so it can be edited/removed.
            if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget;
              const textBefore = el.value.slice(0, el.selectionStart ?? 0);
              const onFirstLine = !textBefore.includes("\n");
              if (onFirstLine) {
                e.preventDefault();
                if (running && el.value.trim() === "") {
                  onQueuePop();
                } else {
                  onHistoryUp();
                }
              }
              return;
            }
            if (e.key === "ArrowDown" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget;
              const textAfter = el.value.slice(el.selectionEnd ?? el.value.length);
              const onLastLine = !textAfter.includes("\n");
              if (onLastLine) {
                e.preventDefault();
                onHistoryDown();
              }
              return;
            }
            if (e.key === "Escape" && running) {
              e.preventDefault();
              abort();
            }
          }}
          onPaste={onPaste}
          placeholder={running ? "Queue a message…  (⏎ to queue · Esc to stop)" : "Try something…  (@ files · / commands · tab insert · ⏎ send)"}
          rows={1}
          spellCheck={false}
          className="flex-1 resize-none bg-transparent text-text text-[13px] focus:outline-none placeholder:text-text-faint font-mono"
          style={{ maxHeight: "140px", lineHeight: "1.5" }}
        />
      </div>
      {/* Bottom divider — mirrors the top so the pulsing voice ring */}
      {/* frames the input row on both sides. */}
      <div
        className={
          voiceActive
            ? "border-t border-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.6)]"
            : "border-t border-text/25"
        }
      />
      {/* Meta footer — model picker + ctx bar on the left, session ops + hints right. */}
      {/* NOTE: don't put `truncate` on this row's spans — it triggers */}
      {/* overflow:hidden which clips the model picker's absolute dropdown. */}
      <div className="px-4 py-2 flex items-center justify-between gap-3">
        <span className="flex items-center gap-3 min-w-0">
          {branch && (
            <span
              className="text-text-faint shrink-0 truncate max-w-[160px]"
              title={`Current branch: ${branch}`}
            >
              ⎇ {branch}
            </span>
          )}
          {refreshing && (
            <span
              className="text-text-faint shrink-0 animate-pulse"
              title="Refreshing transcript from opencode (large sessions can take 20–30s)"
            >
              ↻ refreshing…
            </span>
          )}
          <ModelPicker
            modelLabel={modelLabel}
            models={models}
            modelOverride={modelOverride}
            defaultModel={defaultModel}
            onOpen={onOpenModels}
            onSelect={onSelectModel}
          />
          {ctxTokens > 0 && (
            <ContextBar
              breakdown={ctxBreakdown}
              limit={ctxLimit}
              staleCache={staleCache}
              modelName={
                activeModel
                  ? activeModel.name
                  : `(fallback ${ASSUMED_CONTEXT_TOKENS.toLocaleString()}-token window)`
              }
              tooltip={
                // Action hint scales with how close we are to the wall.
                // 100% on the real model limit means the next request will
                // very likely truncate or hit `model_context_window_exceeded`
                // — make the remediation explicit instead of letting the
                // user discover it from a truncated reply. Bucket-level
                // breakdown is provided by ContextBar itself; this tooltip
                // is only the *hint* line.
                ctxPct >= 100
                  ? "Compact recommended — run /compact to free space"
                  : ctxPct >= 90
                    ? "Approaching limit — consider /compact soon"
                    : undefined
              }
            />
          )}
        </span>
        <span className="shrink-0 flex items-center gap-3">
          <SessionToolbar
            scheduleCount={scheduleCount}
            onSchedules={onSchedules}
            onSecrets={onSecrets}
          />
          {/* Transient status only — recording / interrupt feedback. The static */}
          {/* keyboard-hint (shift+⏎ newline · ⏎ send) was removed to declutter. */}
          {(voiceActive || running) && (
            <span className="text-[10px] text-text-faint">
              {voiceActive
                ? voiceProcessing
                  ? "transcribing… · esc cancels"
                  : "🎙 recording · ⏎ send · ctrl+m stop · esc cancel"
                : "esc · interrupt"}
            </span>
          )}
        </span>
      </div>
      {/* Trust toggle — its own line, more visible when ON. Below the footer */}
      {/* so it doesn't crowd the model/hints row. */}
      <div className="px-4 pb-2 flex items-center text-[10px]">
        <button
          onClick={() => setChatAutoAllow(!chatAutoAllow)}
          className={
            "px-1.5 py-px rounded " +
            (chatAutoAllow
              ? "text-red-300 hover:text-red-200"
              : "text-text-faint hover:text-text-muted")
          }
          title={
            chatAutoAllow
              ? "Trust mode ON — permissions auto-allowed (click to disable)"
              : "Trust mode OFF — permissions require approval (click to enable)"
          }
        >
          {chatAutoAllow
            ? "▶▶ bypass permissions on (click to disable)"
            : "▷▷ bypass permissions off (click to enable)"}
        </button>
      </div>
    </div>
  );
}

// ===== Message rows =====

// Collapsed render for a user message that originated from a slash command
// (e.g. `/skill-name arg`). opencode expands the command template — often
// a multi-page skill body — into the user-message text part(s); rendering
// that verbatim drowns the transcript. We show the original invocation
// (`/name args`) with a ▸/▾ chevron that toggles the full expanded text.
// Same gray-bar styling as a regular user message so it reads as "you said
// this" without a visual mode switch.
const UserCommandBar = memo(function UserCommandBar({
  name,
  args,
  expandedText,
}: {
  name: string;
  args: string;
  expandedText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmedArgs = args.trim();
  return (
    <div className="-mx-4 px-4 py-0.5 bg-bg-soft">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-baseline gap-2 w-full text-left hover:bg-bg-elev/40 -mx-1 px-1 rounded transition-colors"
        title={expanded ? "Collapse" : "Show expanded prompt"}
      >
        <span className="text-text-faint select-none shrink-0">›</span>
        <span className="text-text-faint select-none shrink-0 text-[10px] w-3">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="font-mono text-text shrink-0">/{name}</span>
        {trimmedArgs && (
          <span className="font-mono text-text-muted truncate">{trimmedArgs}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-6 pl-2 border-l border-border whitespace-pre-wrap break-words text-text-muted text-[12px]">
          {expandedText}
        </div>
      )}
    </div>
  );
});

// React.memo guards against the dominant per-keystroke cost: the chat
// input lives in ChatPanel and forces a re-render on every keystroke,
// which (without memo) cascades to re-rendering every MessageRow in the
// transcript — re-running react-markdown + Prism for every assistant
// message and producing visible input lag past ~50 messages. All props
// passed in messages.map() are either primitives or stable references
// (msg from a stable identity; turnInfo / commandInfo / finishBy*
// Maps are memoized at panel scope; persistentTodos comes from
// memoized activeTodos). The default shallow-equals check is what we
// want — no custom comparator needed.
const MessageRow = memo(function MessageRow({
  msg,
  showThinking,
  turnDurationMs,
  persistentTodos,
  truncation,
  commandInfo,
}: {
  msg: OpencodeMessage;
  showThinking: boolean;
  // Set ONLY on the final assistant message of a turn — duration spans the
  // whole turn (all consecutive assistant messages since the last user msg).
  // Intermediate messages get null so they don't show a footer at all.
  turnDurationMs: number | null;
  // Set ONLY on the LAST assistant message in the entire transcript when not
  // running — renders the latest TodoWrite list permanently below the footer.
  // Same data ChatPanel pins under the running indicator while a turn is live.
  persistentTodos: Array<Record<string, unknown>> | null;
  // Per-message truncation classification from finishByMessageId. Drives
  // the "truncated" badge appended to the turn-duration footer (or as a
  // standalone footer when there's no duration, e.g. mid-turn assistant
  // messages within a multi-step turn that hit max_tokens). null = no
  // truncation, no badge.
  truncation: TruncationKind | null;
  // Slash-command provenance from commandByMessageId. When set on a user
  // message, the row shows a collapsed `/name args` pill with an expand
  // chevron instead of the full expanded template body.
  commandInfo: { name: string; arguments: string } | null;
}) {
  const isUser = msg.info.role === "user";

  // Subtle wall-clock timestamp for each message/action. Sourced from the
  // message's own time.created — no new prop, so the MessageRow memo chain is
  // untouched. It sits at the row's top-left, absolutely positioned INSIDE the
  // content box (left-0, not overflowing into the transcript's px-4 padding —
  // that zone is clipped by the scroller's overflow). It stays out of the way
  // (faint, fades in on hover) and never shifts the message layout.
  const ts = formatClockTime(msg.info.time?.created);
  const stampedRow = (children: React.ReactNode) => (
    <div className="group relative">
      {ts && (
        <span
          className="pointer-events-none absolute left-0 -top-2 z-10 select-none whitespace-nowrap text-[10px] leading-none tabular-nums text-text-faint opacity-0 group-hover:opacity-60 transition-opacity"
          aria-hidden
        >
          {ts}
        </span>
      )}
      {children}
    </div>
  );

  // User message: rendered as a single rounded gray bar so it reads as a
  // distinct "you said this" block instead of just text with a `>` prefix.
  // `›` is the dim left marker; continuation lines wrap inside the bar.
  // FileParts attached to the message render as chips ABOVE the bar so
  // attached files stay visible alongside what the user said.
  if (isUser) {
    const text = msg.parts
      .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text ?? "")
      .join("\n")
      .replace(/\s+$/, "");
    const fileParts = msg.parts.filter((p) => p.type === "file");
    if (!text && fileParts.length === 0) return null;
    return stampedRow(
      <div>
        {fileParts.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1 text-[11px]">
            {fileParts.map((p) => {
              const raw = p as Record<string, unknown>;
              const url = typeof raw.url === "string" ? raw.url : "";
              const filename =
                (typeof raw.filename === "string" && raw.filename) ||
                url.split("/").pop() ||
                "file";
              return (
                <span
                  key={p.id}
                  className="rounded-md border border-border-strong px-1.5 py-0.5 bg-bg-elev text-text-muted truncate max-w-[260px]"
                  title={url}
                >
                  {filename}
                </span>
              );
            })}
          </div>
        )}
        {text && (
          commandInfo ? (
            <UserCommandBar
              name={commandInfo.name}
              args={commandInfo.arguments}
              expandedText={text}
            />
          ) : (
            <div className="-mx-4 px-4 py-0.5 bg-bg-soft flex">
              <span className="text-text-faint select-none mr-2 shrink-0">›</span>
              <span className="flex-1 whitespace-pre-wrap break-words text-text">
                {text}
              </span>
            </div>
          )
        )}
      </div>,
    );
  }

  // Assistant: render each part on its own. First non-trivial part gets the
  // `●` bullet; subsequent parts are indented to 2 spaces.
  // todowrite invocations are filtered out — the latest checklist is already
  // pinned under the running indicator + final assistant footer (ActiveTodos),
  // so inlining each call too would duplicate the same list multiple times
  // for any turn that updates todos.
  const visibleParts = msg.parts.filter((p) => {
    if (p.type === "text") return !p.synthetic && !p.ignored && (p.text ?? "").length > 0;
    if (p.type === "step-start" || p.type === "step-finish") return false;
    if (p.type === "tool") {
      const tool = String((p as Record<string, unknown>).tool ?? "");
      if (tool === "todowrite" || tool === "todo_write") return false;
    }
    return true;
  });
  if (visibleParts.length === 0) return null;

  return stampedRow(
    <div className="space-y-2">
      {visibleParts.map((p, i) => (
        <AssistantPart key={p.id} part={p} first={i === 0} showThinking={showThinking} />
      ))}
      {/* Turn-level duration footer — only on the FINAL assistant message */}
      {/* of a turn. -ml-[14px] breaks 14px out of the 16px px-4 padding, */}
      {/* leaving a 2px gap between the sidebar edge and the ✻ glyph. */}
      {/* Truncation badge piggy-backs onto the same line when both are set */}
      {/* (most common case: end-of-turn truncation). For mid-turn step */}
      {/* truncations there's no duration footer, so the badge renders on */}
      {/* its own row using the same baseline style. */}
      {(turnDurationMs != null || truncation != null) && (
        // -ml-[8px] places the ✻ glyph halfway between the panel's left edge
        // (where the transcript's px-4 padding starts at x=16) and the
        // assistant bullet column (x=16 inside the padding). 16 - 8 = 8 from
        // edge ≈ midway between sidebar and bullet. mt-3 adds breathing room
        // above so it doesn't crowd the last assistant part.
        <div className="-ml-[8px] mt-3 -mb-3 text-[13px] text-text-muted">
          {turnDurationMs != null && (
            <>
              <span style={{ color: CLAUDE_ORANGE }}>✻</span>{" "}
              {pastVerbFor(msg.info.id)} for {formatDuration(turnDurationMs)}
            </>
          )}
          {truncation != null && (
            <>
              {turnDurationMs != null && (
                <span className="text-text-faint mx-1.5">·</span>
              )}
              {/* File-chip-style pill tinted with CLAUDE_ORANGE — visually */}
              {/* coherent with CompactionCard / RetryCard / QuestionCard, */}
              {/* the existing "something needs your attention" color. */}
              <span
                className="rounded-md border px-1.5 py-0.5 text-[11px] inline-flex items-center gap-1"
                style={{
                  borderColor: CLAUDE_ORANGE + "55",
                  backgroundColor: CLAUDE_ORANGE + "11",
                  color: CLAUDE_ORANGE,
                }}
                title={describeTruncation(truncation).hint}
              >
                <span aria-hidden>⚠</span>
                {describeTruncation(truncation).label}
              </span>
            </>
          )}
        </div>
      )}
      {/* Persistent todo list — only on the LAST assistant message in the */}
      {/* transcript, after the turn has ended. While running, the same data */}
      {/* renders under the RunningIndicator instead (handled by ChatPanel). */}
      {persistentTodos && persistentTodos.length > 0 && (
        <ActiveTodos todos={persistentTodos} />
      )}
    </div>,
  );
});

// Bullet color/animation by part kind + tool status. Text gets grey; tools
// blink grey while running/pending, turn green on completion, red on error.
function bulletStyle(part: OpencodePart): { color: string; pulse: boolean } {
  if (part.type !== "tool") {
    return { color: "#6b7280", pulse: false };           // text/other: grey
  }
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (status === "completed") return { color: "#22c55e", pulse: false }; // green
  if (status === "error") return { color: "#ef4444", pulse: false };     // red
  // "running" / "pending" / unknown-but-active → blinking grey
  return { color: "#6b7280", pulse: true };
}

// Memoized so re-renders of a memo'd MessageRow whose parts haven't
// changed identity don't re-render every child part (and re-tokenize
// every code block). `part` references are stable across renders
// because the messages array uses object spread for updates and
// unchanged parts keep their identity. `first` and `showThinking` are
// primitives. Safe to use the default shallow comparator.
const AssistantPart = memo(function AssistantPart({
  part,
  first,
  showThinking,
}: {
  part: OpencodePart;
  first: boolean;
  showThinking: boolean;
}) {
  // Single bullet on the very first line of the very first content part;
  // everything else gets a 2-space indent to align under it.
  const Prefix = ({ char, color, pulse }: { char: string; color: string; pulse?: boolean }) => (
    <span
      className={"select-none " + (pulse ? "animate-pulse" : "")}
      style={{ color }}
    >
      {char}{" "}
    </span>
  );

  if (part.type === "text") {
    const text = (part.text ?? "").replace(/^\n+|\n+$/g, "");
    if (!text) return null;
    const { color, pulse } = bulletStyle(part);
    // No `whitespace-pre-wrap` here — react-markdown handles block structure
    // and would otherwise stack raw newlines from the source on top of its
    // own paragraph spacing, leaving huge visual gaps around code blocks.
    return (
      <div className="break-words text-text">
        <div className="flex">
          <span className="select-none w-4 shrink-0">
            {first ? <Prefix char="●" color={color} pulse={pulse} /> : <span className="invisible">●</span>}
          </span>
          <div className="flex-1">{renderMarkdown(text)}</div>
        </div>
      </div>
    );
  }

  if (part.type === "reasoning") {
    const text = (part.text ?? "").replace(/^\n+|\n+$/g, "");
    if (!text) return null;
    // Hidden entirely by default — the running indicator already signals
    // that thinking happened. Ctrl+O reveals the full content for debugging
    // or curiosity. No placeholder when collapsed.
    if (!showThinking) return null;
    return (
      <div className="whitespace-pre-wrap break-words text-text-muted italic">
        <div className="flex">
          <span className="select-none w-4 shrink-0">
            <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>✻ </span>
          </span>
          <div className="flex-1">
            <div className="text-text-faint not-italic mb-1">Thinking…</div>
            <div>{text}</div>
          </div>
        </div>
      </div>
    );
  }

  if (part.type === "tool") {
    return <ToolCall part={part} verbose={showThinking} />;
  }

  // Patch (savepoint after one or more file edits): show the files touched.
  if (part.type === "patch") {
    const files = ((part as Record<string, unknown>).files as string[] | undefined) ?? [];
    return (
      <div className="flex text-text-faint text-xs">
        <span className="select-none w-4 shrink-0">
          <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>⎿ </span>
        </span>
        <div className="flex-1">
          {files.length === 0
            ? "patched"
            : `patched ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`}
        </div>
      </div>
    );
  }

  // File reference (attached file in a prompt, or returned by a tool).
  if (part.type === "file") {
    const filename = String((part as Record<string, unknown>).filename ?? "");
    const mime = String((part as Record<string, unknown>).mime ?? "");
    return (
      <div className="flex text-text-faint text-xs">
        <span className="select-none w-4 shrink-0">
          <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>⎿ </span>
        </span>
        <div className="flex-1">
          <span className="text-text-muted">{filename || "(file)"}</span>
          {mime && <span className="text-text-faint"> · {mime}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex text-text-faint">
      <span className="select-none w-4 shrink-0">
        <span style={{ color: CLAUDE_ORANGE, opacity: 0.5 }}>○ </span>
      </span>
      <div className="flex-1 text-xs">[{part.type}]</div>
    </div>
  );
});

// Renders a tool's `output` string. If it looks like a unified diff (starts
// with `--- ` or `@@`, or has multiple `@@` headers), each line is colored
// red/green/neutral. Otherwise we render it as a monospace code block,
// truncated to a sensible height by default.
const ToolOutput = memo(function ToolOutput({ output }: { output: string }) {
  const looksLikeDiff =
    /^---\s/.test(output) ||
    /\n---\s/.test(output) ||
    /(^|\n)@@ /.test(output);
  if (looksLikeDiff) {
    return <UnifiedDiff text={output} />;
  }
  // Plain code/text output — small monospace block, scroll on overflow.
  return (
    <pre className="text-[12px] bg-bg-soft border border-border rounded px-2 py-1 max-h-64 overflow-auto whitespace-pre">
      <code>{output}</code>
    </pre>
  );
});

// ===== Tool call rendering =====
//
// One `ToolCall` switches on `state.input.tool` and dispatches to per-tool
// body renderers. Each body is small enough to inline; the shared header
// (the `● Toolname(title)` line + status/diff stats) lives in ToolHeader.
//
// Add a new tool: write a `<ToolnameBody>` function, add a case in the switch.
// Falls back to GenericBody when the tool is unrecognized.

type ToolState = {
  status?: string;
  title?: string;
  output?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const ToolCall = memo(function ToolCall({ part, verbose }: { part: OpencodePart; verbose: boolean }) {
  const rawTool = String((part as Record<string, unknown>).tool ?? "tool");
  // Title-case: "edit" → "Edit", "todo_write" → "TodoWrite".
  const toolName = rawTool
    .split(/[_-]/)
    .map((t) => (t ? t[0].toUpperCase() + t.slice(1) : t))
    .join("");
  const state = ((part as Record<string, unknown>).state ?? {}) as ToolState;
  const meta = state.metadata ?? {};
  const filediff = meta.filediff as
    | { additions?: number; deletions?: number }
    | undefined;
  // Pre-extract diff text (used by Edit/Write/MultiEdit).
  const diffText =
    typeof meta.diff === "string"
      ? (meta.diff as string)
      : typeof (meta.filediff as Record<string, unknown> | undefined)?.patch === "string"
        ? ((meta.filediff as Record<string, unknown>).patch as string)
        : null;

  const { color: bulletColor, pulse } = bulletStyle(part);
  return (
    <div>
      <div className="flex">
        <span className="select-none w-4 shrink-0">
          <span
            className={pulse ? "animate-pulse" : ""}
            style={{ color: bulletColor }}
          >
            ●{" "}
          </span>
        </span>
        <div className="flex-1">
          <span className="text-text">{toolName}</span>
          {state.title && (
            <span className="text-text-muted">({state.title})</span>
          )}
          {filediff && (filediff.additions || filediff.deletions) ? (
            <span className="text-text-faint ml-1">
              {" · "}
              {formatFileDiff(filediff.additions ?? 0, filediff.deletions ?? 0)}
            </span>
          ) : null}
          {state.status && state.status !== "completed" && (
            <span className="text-text-faint"> · {state.status}</span>
          )}
        </div>
      </div>
      <div className="ml-4 mt-0.5">
        <ToolBody tool={rawTool} state={state} diffText={diffText} verbose={verbose} />
      </div>
    </div>
  );
});

function ToolBody({
  tool,
  state,
  diffText,
  verbose,
}: {
  tool: string;
  state: ToolState;
  diffText: string | null;
  verbose: boolean;
}) {
  // Edit/Write/MultiEdit: prefer the unified diff (lives in metadata.diff).
  if (diffText) return <UnifiedDiff text={diffText} />;

  // Per-tool body. Default fall-through is the generic monospace block.
  switch (tool) {
    case "read":
      return <ReadBody state={state} verbose={verbose} />;
    case "bash":
      return <BashBody state={state} verbose={verbose} />;
    case "glob":
      return <GlobBody state={state} />;
    case "grep":
      return <GrepBody state={state} verbose={verbose} />;
    case "todowrite":
    case "todo_write":
      return <TodoWriteBody state={state} />;
    case "webfetch":
    case "web_fetch":
      return <WebFetchBody state={state} />;
    case "task":
      return <TaskBody state={state} />;
    default:
      // Unknown tool — show output (if any) as a generic block.
      return state.output ? <ToolOutput output={state.output} /> : null;
  }
}

// Task (subagent) body. Collapsed by default to a one-line summary
// (description · agent · status · duration · live tool count). On expand,
// renders the child session's full transcript inline, indented under the
// header with a left border accent so the nesting is visually unambiguous.
//
// The child transcript uses the SAME MessageRow components as the parent —
// full fidelity, including tool calls, reasoning (Ctrl+O), text markdown,
// active todos, etc. (Nested subagents would recurse for free because the
// task tool case here just re-enters the same flow on the inner ToolBody.)
//
// Data sources:
//   - The parent's task tool part (`state` prop here) gives us the headline
//     metadata: status, title, duration, child id, agent type, model, output.
//   - The child's transcript is fetched lazily on first expand via the
//     `toggle` callback in TaskContext (registered by ChatPanel as
//     `toggleTaskExpand`); subsequent SSE traffic for that child triggers
//     a debounced re-fetch (also in ChatPanel) so the expanded card stays
//     live.
//   - Live status from child's session.idle/status events (in liveStatus
//     map) overrides the parent's stale `state.status` for the badge.
//
// When no TaskContext is provided (defensive — shouldn't happen in
// ChatPanel but might in a future test harness), renders the static
// header + final output only, no expand affordance.
function TaskBody({ state }: { state: ToolState }) {
  const ctx = useContext(TaskContext);
  const info = useMemo(
    () => extractSubagentInfo({ type: "tool", tool: "task", state }),
    [state],
  );
  // HOOK ORDER: every hook used by this component must run BEFORE the
  // `!info` early return below. Previously `summary` was computed after
  // the return, so a render that flipped from `info === null` (1 hook)
  // to `info !== null` (2 hooks) crashed with "Rendered more hooks than
  // during the previous render" and blanked the whole panel. Resolve
  // `childMsgs` here (independent of `info`) so the memo's input is
  // stable across both branches.
  const childMsgsForSummary = info
    ? ctx?.childMessages.get(info.childSessionId)
    : undefined;
  const summary = useMemo(
    () => summarizeChildSession(childMsgsForSummary),
    [childMsgsForSummary],
  );
  if (!info) {
    // No child id yet (very brief window between tool-input.started and
    // the first metadata write). Fall back to whatever output is present.
    return state.output ? <ToolOutput output={state.output} /> : null;
  }
  const isExpanded = ctx?.expanded.has(info.childSessionId) ?? false;
  const childMsgs = childMsgsForSummary;
  const childFetch = ctx?.childFetchState.get(info.childSessionId);
  const liveState = ctx?.liveStatus.get(info.childSessionId);
  // Prefer live SSE status over the parent's transcript snapshot (which
  // lags by one refetch cycle). Maps "running" → still going, "idle" →
  // finished. The transcript status acts as the initial value before any
  // live event lands AND the source of truth for completed/error.
  const effectiveStatus =
    liveState === "idle" && info.status === "running"
      ? "completed"
      : liveState === "running" && info.status === "completed"
        ? "running"
        : info.status;
  const showThinking = ctx?.showThinking ?? false;

  const statusColor =
    effectiveStatus === "completed"
      ? "#22c55e"
      : effectiveStatus === "error"
        ? "#ef4444"
        : "#6b7280"; // running / pending / unknown
  const statusPulse = effectiveStatus === "running" || effectiveStatus === "pending";

  const onToggle = ctx ? () => ctx.toggle(info.childSessionId) : null;

  return (
    <div className="text-[12px] text-text-muted">
      {/* Header row: description + meta line. Click anywhere on the row to
          toggle when context is available. */}
      <div
        className={
          "flex items-start " +
          (onToggle ? "cursor-pointer hover:text-text" : "")
        }
        onClick={onToggle ?? undefined}
      >
        <span className="select-none w-4 shrink-0 text-text-faint">
          {onToggle ? (isExpanded ? "▾" : "▸") : "⎿"}
        </span>
        <div className="flex-1 min-w-0">
          {info.description && (
            <div className="text-text truncate">{info.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-1 text-text-faint">
            <span style={{ color: statusColor }} className={statusPulse ? "animate-pulse" : ""}>
              ●
            </span>
            <span>{info.agent}</span>
            <span>·</span>
            <span>{effectiveStatus}</span>
            {summary.toolCount > 0 && (
              <>
                <span>·</span>
                <span>
                  {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
                  {effectiveStatus === "running" && summary.lastToolName
                    ? ` (${summary.lastToolName})`
                    : ""}
                </span>
              </>
            )}
            {info.durationMs != null && (
              <>
                <span>·</span>
                <span>{formatDuration(info.durationMs)}</span>
              </>
            )}
            {summary.tokens > 0 && (
              <>
                <span>·</span>
                <span>{formatTokens(summary.tokens)}</span>
              </>
            )}
            {info.truncated && (
              <>
                <span>·</span>
                {/* Inline hex matches `CACHE_WRITE_COLOR` / the truncation
                    badge elsewhere; the theme has no `warning` token. */}
                <span style={{ color: "#f59e0b" }}>⚠ truncated</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Expanded body: child transcript (full fidelity, indented + bordered)
          followed by the final output. While loading, a small spinner. */}
      {isExpanded && (
        <div className="mt-1 ml-4 pl-3 border-l-2 border-border">
          {childFetch === "loading" && !childMsgs && (
            <div className="text-text-faint italic">Loading subagent transcript…</div>
          )}
          {childFetch === "error" && !childMsgs && (
            // Inline hex — theme has no `error` token; matches bulletStyle()'s
            // red used for failed tool calls.
            <div style={{ color: "#ef4444" }}>Failed to load subagent transcript.</div>
          )}
          {childMsgs && childMsgs.length > 0 && (
            <div className="flex flex-col gap-2">
              {childMsgs.map((m) => (
                <MessageRow
                  key={m.info.id}
                  msg={m}
                  showThinking={showThinking}
                  // Subagent transcripts have their own footers; don't paint
                  // turn-duration / persistent-todo / truncation overlays
                  // designed for the top-level conversation.
                  turnDurationMs={null}
                  persistentTodos={null}
                  truncation={null}
                  commandInfo={null}
                />
              ))}
            </div>
          )}
          {childMsgs && childMsgs.length === 0 && (
            <div className="text-text-faint italic">
              (no messages — subagent finished without producing a transcript)
            </div>
          )}
          {/* Final output, shown below the transcript for completed runs.
              Same visual treatment as the generic ToolOutput so users
              recognize "this is what the subagent returned to its parent". */}
          {info.output && effectiveStatus !== "running" && (
            <div className="mt-2">
              <div className="text-text-faint mb-1">Result:</div>
              <ToolOutput output={info.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Read: collapsed to a one-line summary by default — "Read N lines (ctrl+o)"
// — because most Read calls aren't worth scrolling past. When verbose, render
// the actual content (opencode's output is already line-numbered).
function ReadBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const output = state.output ?? "";
  const m = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  const body = m ? m[1] : output;
  const lineCount = body.split("\n").filter((l) => l.length > 0).length;
  if (!verbose) {
    return (
      <div className="flex text-[12px] text-text-faint">
        <span className="select-none w-4 shrink-0">⎿</span>
        <span>Read {lineCount} line{lineCount === 1 ? "" : "s"} (ctrl+o to expand)</span>
      </div>
    );
  }
  return <ConnectorOutput body={body} maxLines={Infinity} />;
}

// Bash: output rendered as ⎿-connected monospace lines under the header,
// no boxed background. The command itself is already shown in the header via
// state.title. Output is truncated to 5 lines by default; verbose expands.
function BashBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const output = state.output ?? "";
  if (!output) return null;
  return <ConnectorOutput body={output} maxLines={verbose ? Infinity : 5} />;
}

// Shared renderer for the "⎿ output\n  more lines\n  … +N more (ctrl+o)" style.
// Used by Bash and (any future tool wanting the same look).
function ConnectorOutput({ body, maxLines }: { body: string; maxLines: number }) {
  const lines = body.split("\n");
  const visibleCount = Math.min(lines.length, maxLines);
  const visible = lines.slice(0, visibleCount);
  const hidden = lines.length - visibleCount;
  return (
    <div className="text-[12px] font-mono leading-snug">
      {visible.map((l, i) => (
        <div key={i} className="flex">
          <span className="select-none w-4 shrink-0 text-text-faint">
            {i === 0 ? "⎿" : " "}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all text-text-muted">
            {l || " "}
          </span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="flex">
          <span className="select-none w-4 shrink-0"> </span>
          <span className="text-text-faint">
            … +{hidden} line{hidden === 1 ? "" : "s"} (ctrl+o to expand)
          </span>
        </div>
      )}
    </div>
  );
}

// Glob: output is newline-separated paths. Show count + first N.
function GlobBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = state.output ?? "";
  const paths = output.split("\n").filter((l) => l.length > 0);
  return (
    <div className="text-[12px] text-text-muted">
      {pattern && (
        <div className="text-text-faint mb-1">
          pattern <span className="text-text-muted">{pattern}</span> · {paths.length} match
          {paths.length === 1 ? "" : "es"}
        </div>
      )}
      <CollapsiblePathList paths={paths} maxLines={10} />
    </div>
  );
}

// Grep: collapsed to a one-line summary by default. When verbose, show hits.
function GrepBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = state.output ?? "";
  const lines = output.split("\n").filter((l) => l.length > 0);
  if (!verbose) {
    return (
      <div className="flex text-[12px] text-text-faint">
        <span className="select-none w-4 shrink-0">⎿</span>
        <span>
          {pattern ? <>Searched <code className="text-accent">{pattern}</code> · </> : null}
          {lines.length} hit{lines.length === 1 ? "" : "s"} (ctrl+o to expand)
        </span>
      </div>
    );
  }
  return <ConnectorOutput body={lines.join("\n")} maxLines={Infinity} />;
}

// TodoWrite: input.todos is an array of {content, status, ...}. Render as a
// checklist with status icons. Status values seen: "pending", "in_progress",
// "completed", "cancelled".
function TodoWriteBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const todos = (input.todos as Array<Record<string, unknown>> | undefined) ?? [];
  if (todos.length === 0) return null;
  return (
    <div className="text-[12px] space-y-0.5">
      {todos.map((t, i) => {
        const content = String(t.content ?? "");
        const status = String(t.status ?? "pending");
        const icon =
          status === "completed"
            ? "☒"
            : status === "in_progress"
              ? "◐"
              : status === "cancelled"
                ? "⊘"
                : "☐";
        const cls =
          status === "completed"
            ? "text-text-faint line-through"
            : status === "in_progress"
              ? "text-text"
              : status === "cancelled"
                ? "text-text-faint line-through opacity-50"
                : "text-text-muted";
        return (
          <div key={i} className={`flex gap-2 ${cls}`}>
            <span className="select-none shrink-0" style={{ color: status === "in_progress" ? CLAUDE_ORANGE : undefined }}>
              {icon}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">{content}</span>
          </div>
        );
      })}
    </div>
  );
}

// WebFetch: input has {url, prompt?}. Output is the fetched content / summary.
function WebFetchBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const url = typeof input.url === "string" ? input.url : "";
  const output = state.output ?? "";
  return (
    <div className="text-[12px] space-y-1">
      {url && (
        <div className="text-text-faint break-all">
          <span className="select-none">→ </span>
          <span style={{ color: CLAUDE_ORANGE }}>{url}</span>
        </div>
      )}
      {output && <CollapsibleCode body={output} maxLines={15} />}
    </div>
  );
}

// Generic collapsible monospace block — used by Read/Bash/Grep/WebFetch.
// Shows the first maxLines lines; clicking the "(N more)" footer expands.
function CollapsibleCode({ body, maxLines }: { body: string; maxLines: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = body.split("\n");
  const overflow = lines.length > maxLines && !expanded;
  const shown = overflow ? lines.slice(0, maxLines).join("\n") : body;
  const hiddenCount = lines.length - maxLines;
  return (
    <div className="text-[12px] bg-bg-soft border border-border rounded">
      <pre className="px-2 py-1 overflow-x-auto whitespace-pre">
        <code>{shown}</code>
      </pre>
      {overflow && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full text-left px-2 py-0.5 text-[10px] text-text-faint hover:text-text border-t border-border"
        >
          + {hiddenCount} more line{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

// Simpler list variant for Glob — just paths, no monospace wrapper styling.
function CollapsiblePathList({ paths, maxLines }: { paths: string[]; maxLines: number }) {
  const [expanded, setExpanded] = useState(false);
  if (paths.length === 0) return null;
  const overflow = paths.length > maxLines && !expanded;
  const shown = overflow ? paths.slice(0, maxLines) : paths;
  const hiddenCount = paths.length - maxLines;
  return (
    <div className="text-[12px] bg-bg-soft border border-border rounded">
      <div className="px-2 py-1 overflow-x-auto">
        {shown.map((p, i) => (
          <div key={i} className="text-text-muted whitespace-pre">
            {p}
          </div>
        ))}
      </div>
      {overflow && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full text-left px-2 py-0.5 text-[10px] text-text-faint hover:text-text border-t border-border"
        >
          + {hiddenCount} more
        </button>
      )}
    </div>
  );
}

// Unified diff: renders directly on the page background — no card, no border,
// no hunk-header decoration. Same font/size/weight as body text (inherits from
// the panel wrapper); diff bodies use the bright cream `text-text` color.
// Background blocks are saturated green/red for proper contrast.
//
// Line numbers come from `@@ -A,B +C,D @@` parsed per hunk; `+` and context
// use NEW line numbers, `-` uses OLD.
function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  let oldLine = 0;
  let newLine = 0;
  return (
    <div className="font-mono leading-snug my-1 overflow-x-auto">
      {lines.map((line, i) => {
        // Hunk header: parse counters silently. Skip the visible row — the
        // header carries file/range metadata that's noise next to the actual
        // changes. Line numbers from the parsed counters still drive the
        // gutter, so jumps between hunks remain obvious.
        if (line.startsWith("@@")) {
          const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (m) {
            oldLine = parseInt(m[1], 10);
            newLine = parseInt(m[2], 10);
          }
          return null;
        }
        // File markers / Index preamble — drop entirely. opencode emits these
        // for every diff and they're noise next to the actual changes.
        if (
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("Index: ") ||
          /^=+$/.test(line)
        ) {
          return null;
        }

        // +/− /context line classification.
        let bg = "";
        let signCls = "text-text-faint";
        let lnCls = "text-text-faint";
        let sign: string | null = null;
        let body = line;
        let ln: number | null = null;

        if (line.startsWith("+") && !line.startsWith("+++")) {
          // Saturated green block. Text stays the same bright cream as body
          // copy — color comes from the bg, not the text.
          bg = "bg-green-700/55";
          signCls = "text-green-300";
          lnCls = "text-green-300/70";
          sign = "+";
          body = line.slice(1);
          ln = newLine++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          bg = "bg-red-700/55";
          signCls = "text-red-300";
          lnCls = "text-red-300/70";
          sign = "−";
          body = line.slice(1);
          ln = oldLine++;
        } else if (line.startsWith(" ")) {
          sign = " ";
          body = line.slice(1);
          ln = newLine;
          newLine++;
          oldLine++;
        }

        if (sign !== null) {
          return (
            <div key={i} className={`flex whitespace-pre ${bg}`}>
              <span className={`select-none shrink-0 text-right pr-2 w-10 ${lnCls}`}>
                {ln ?? ""}
              </span>
              <span className={`select-none shrink-0 w-3 ${signCls}`}>
                {sign}
              </span>
              <span className="flex-1 text-text">{body || " "}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ===== Markdown renderer =====
//
// react-markdown + remark-gfm (tables, strikethrough, autolinks, task lists).
// Component overrides route fenced code blocks through CodeBlock (Prism), and
// links through window.api.openExternal so external URLs open in the user's
// default browser rather than navigating the Electron renderer.
//
// Streamed-fence resilience: while a code block is still streaming, the
// closing ``` hasn't arrived yet. Without a recovery step, remark sees the
// fence as "no language, body until end of message" and renders the prose
// after it as monospace. We pad with a closing fence on a tail-truncation
// heuristic so the in-flight block renders as code but the trailing text
// (which may not exist yet) doesn't get swallowed.
function preprocessForStream(text: string): string {
  // Count unescaped triple-backticks. Odd count means an unclosed fence —
  // append a synthetic close so the parser balances. This is purely a
  // streaming-display convenience; the final message will be even and skip
  // this branch.
  const matches = text.match(/```/g);
  if (matches && matches.length % 2 === 1) return text + "\n```";
  return text;
}

function renderMarkdown(text: string): React.ReactNode {
  return <MarkdownBody text={text} />;
}

// Hoisted out so component identity is stable — re-rendering on every keystroke
// otherwise causes react-markdown to throw away CodeBlock state (the Highlight
// component would re-tokenize).
const MD_COMPONENTS: MarkdownComponents = {
  code({ inline, className, children, ...rest }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  } & React.HTMLAttributes<HTMLElement>) {
    // Inline `code` — bui's accent color, no box. Block code handled below
    // by wrapping pre.
    if (inline) {
      return (
        <code className="font-mono text-accent" {...rest}>
          {children}
        </code>
      );
    }
    // Block code: defer to the <pre> override which will pull lang from
    // className "language-xxx".
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    // Pull the language + body out of the nested <code className="language-x">.
    // react-markdown nests code inside pre for fenced blocks.
    const child = Array.isArray(children) ? children[0] : children;
    if (child && typeof child === "object" && "props" in child) {
      const codeProps = (child as { props: { className?: string; children?: React.ReactNode } }).props;
      const cls = codeProps.className ?? "";
      const lang = cls.match(/language-([\w-]+)/)?.[1];
      const body = childrenToString(codeProps.children);
      return <CodeBlock lang={lang} body={body} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="underline"
        style={{ color: CLAUDE_ORANGE }}
        onClick={(e) => {
          if (window.api.openExternal && href) {
            e.preventDefault();
            window.api.openExternal(href);
          }
        }}
        {...rest}
      >
        {children}
      </a>
    );
  },
  h1: ({ children }) => <div className="text-base font-semibold text-text mt-2 mb-1">{children}</div>,
  h2: ({ children }) => <div className="text-sm font-semibold text-text mt-2 mb-1">{children}</div>,
  h3: ({ children }) => <div className="text-sm font-medium text-text mt-2 mb-1">{children}</div>,
  h4: ({ children }) => <div className="text-sm font-medium text-text mt-1 mb-0.5">{children}</div>,
  // Tight list rendering: GFM "loose" lists (blank lines between items)
  // wrap each li's content in a <p>. Without [&_p]:m-0 the inner paragraphs
  // each add an mb, stacking up to large gaps. We collapse those margins
  // inside list items so the visual spacing is driven only by space-y-* on
  // the ul/ol parent.
  ul: ({ children }) => <ul className="my-1 ml-2 list-disc list-inside space-y-0.5 [&_p]:m-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-2 list-decimal list-inside space-y-0.5 [&_p]:m-0">{children}</ol>,
  li: ({ children }) => <li className="text-text">{children}</li>,
  p: ({ children }) => <div className="mb-1 last:mb-0">{children}</div>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 my-1 text-text-muted italic">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-[12px] border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-0.5 text-left text-text font-medium bg-bg-soft">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-0.5 text-text">{children}</td>
  ),
  hr: () => <hr className="my-2 border-border" />,
};

// Above this many characters, skip the react-markdown AST parse entirely and
// render the text as a plain <pre>. Parsing + rendering a very large markdown
// body (a pasted log, a huge model dump) is synchronous and can block the main
// thread for seconds — and it re-runs whenever the row's memo is defeated (e.g.
// a full-transcript refetch swaps in fresh part objects). A multi-second freeze
// is far worse than losing markdown formatting on an unusually large message.
const MARKDOWN_MAX_CHARS = 50_000;

// Memoized so re-rendering a parent (AssistantPart, MessageRow) whose
// own props/state haven't changed doesn't re-parse the markdown AST
// and re-tokenize Prism inside CodeBlock. `text` is the only prop and
// is a primitive — default shallow comparator works.
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_CHARS) {
    // Oversized: bypass markdown + Prism to keep the main thread responsive.
    return (
      <pre className="whitespace-pre-wrap break-words text-[13px] text-text">
        {text}
      </pre>
    );
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {preprocessForStream(text)}
    </ReactMarkdown>
  );
});

// react-markdown passes children as ReactNode (array of strings/elements). For
// code blocks we want a plain string so Prism can tokenize. Walk the tree.
function childrenToString(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToString).join("");
  if (typeof node === "object" && "props" in node) {
    return childrenToString((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

// Map common language tags to Prism's canonical names. Prism doesn't recognize
// some bare extensions (e.g. "rs", "yml") — alias them so highlight works.
// Unknown langs render as plain monospace via the noop fallback below.
const PRISM_LANG_ALIAS: Record<string, Language> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  proto: "protobuf",
  dockerfile: "docker",
  html: "markup",
  xml: "markup",
  svg: "markup",
  c: "c",
  cpp: "cpp",
  go: "go",
  java: "java",
  json: "json",
  css: "css",
  scss: "scss",
  sql: "sql",
  toml: "toml",
};

const PRISM_SUPPORTED: ReadonlySet<string> = new Set<Language>([
  "markup",
  "bash",
  "clike",
  "c",
  "cpp",
  "css",
  "javascript",
  "jsx",
  "coffeescript",
  "actionscript",
  "css-extras",
  "diff",
  "git",
  "go",
  "graphql",
  "handlebars",
  "json",
  "less",
  "makefile",
  "markdown",
  "objectivec",
  "ocaml",
  "python",
  "reason",
  "sass",
  "scss",
  "sql",
  "stylus",
  "tsx",
  "typescript",
  "wasm",
  "yaml",
] as Language[]);

// Above either bound, skip Prism tokenization and render the raw code in a
// plain <pre>. Prism's <Highlight> tokenizes the WHOLE body synchronously on
// render (and is superlinear for some grammars); a large pasted file / log /
// diff can block the main thread for seconds, and it re-runs every time the
// row memo is defeated (e.g. a full-transcript refetch). Syntax colors aren't
// worth a multi-second freeze on a giant block.
const CODEBLOCK_MAX_CHARS = 30_000;
const CODEBLOCK_MAX_LINES = 2_000;

const CodeBlock = memo(function CodeBlock({ lang, body }: { lang?: string; body: string }) {
  // Trim a single trailing newline that almost always precedes the closing fence.
  const cleaned = body.replace(/\n$/, "");
  const normalized = (lang ?? "").toLowerCase();
  // Resolve alias → canonical Prism Language, falling back to a no-op token
  // mode if Prism doesn't know it (preserves spacing without throwing).
  const resolved: Language | undefined =
    PRISM_LANG_ALIAS[normalized] ??
    (PRISM_SUPPORTED.has(normalized) ? (normalized as Language) : undefined);

  // Oversized block: render plain (no Prism) to keep the UI responsive.
  const tooLarge =
    cleaned.length > CODEBLOCK_MAX_CHARS ||
    // Counting newlines is O(n) but far cheaper than tokenizing; bail before
    // <Highlight> ever sees a giant body.
    countLines(cleaned) > CODEBLOCK_MAX_LINES;

  return (
    <div className="my-2 rounded border border-border bg-bg-soft overflow-hidden">
      {lang && (
        <div className="px-2 py-0.5 text-[10px] text-text-faint border-b border-border bg-bg-elev">
          {lang}
        </div>
      )}
      {tooLarge ? (
        <pre
          className="px-2 py-1.5 text-[12px] overflow-x-auto whitespace-pre"
          style={{ background: "transparent" }}
        >
          <code>{cleaned}</code>
        </pre>
      ) : (
        <Highlight
          theme={themes.vsDark}
          code={cleaned}
          language={resolved ?? ("text" as Language)}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              className="px-2 py-1.5 text-[12px] overflow-x-auto whitespace-pre"
              // vsDark's default bg would override our bg-bg-soft — disable it.
              style={{ background: "transparent" }}
            >
              <code>
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </div>
                ))}
              </code>
            </pre>
          )}
        </Highlight>
      )}
    </div>
  );
});

// Count newlines without allocating an array (cheap O(n) line count for the
// CodeBlock size guard — body.split("\n").length would allocate a huge array
// for exactly the inputs we're trying to avoid touching).
function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

