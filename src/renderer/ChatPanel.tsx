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
} from "../shared/types";
import { useStore } from "./store";
import {
  ASSUMED_CONTEXT_TOKENS,
  formatTokens,
  formatDuration,
  ctxStageColor,
  filterCommands,
  dedupeAgainstBuiltins,
  resolveContextLimit,
  classifyFinish,
  describeTruncation,
  allTodosTerminal,
  detectCommandFromText,
  type TruncationKind,
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
  const configDefaultModel = useStore((s) => s.defaultModel);
  const [messages, setMessages] = useState<OpencodeMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pending permission requests for THIS session. Polled on mount and refreshed
  // on permission.asked / permission.replied events.
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  // Pending question requests for THIS session. Polled on mount and refreshed
  // on question.asked / question.replied / question.rejected events.
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  // Reasoning ("Thinking…") visibility — hidden by default to keep the
  // transcript focused on results. Ctrl+O toggles like Claude Code's TUI.
  const [showThinking, setShowThinking] = useState(false);
  // Running mirrors opencode session status (busy/idle/retry). We feed it from
  // session.status events for accuracy, but also set it optimistically on send
  // so the UI flips to "Stop" instantly rather than waiting for the next event.
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // Messages queued while the AI was still running. Sent automatically one
  // at a time as running flips to false. Shown below the RunningIndicator
  // while waiting; each moves into the transcript once dispatched.
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
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
  // Typeahead popup state + result caches. Commands and agents are fetched
  // lazily on first @/ and reused; file searches re-issue per-keystroke.
  const [typeahead, setTypeahead] = useState<TypeaheadState | null>(null);
  const [commands, setCommands] = useState<OpencodeCommand[] | null>(null);
  const [agents, setAgents] = useState<OpencodeAgent[] | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const fileSearchSeqRef = useRef(0);
  // Prompt history: when textarea has focus and typeahead is closed, Up/Down
  // cycle through previously-submitted prompts (terminal-style). The index
  // is internal to navigateHistory's setter — never read elsewhere, so the
  // setter is all we keep. draftInput saves whatever the user was typing
  // before they entered history mode so it can be restored on Down past end.
  const [, setHistoryIdx] = useState<number | null>(null);
  const draftInput = useRef<string>("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Initial load + reload whenever sessionId changes.
  useEffect(() => {
    let cancelled = false;
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
    setStepTokens(null);
    setRetryInfo(null);
    setLiveTodos(null);
    setTodosDismissed(false);
    setFinishByMessageId(new Map());
    setCommandByMessageId(new Map());
    setCompactionState(null);
    if (compactionClearTimer.current) {
      clearTimeout(compactionClearTimer.current);
      compactionClearTimer.current = null;
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
    window.api
      .opencodeMessages(sessionId)
      .then((m) => {
        if (!cancelled) setMessages(m);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
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
    // previous bui session before we mounted).
    window.api
      .opencodePermissions()
      .then((all) => {
        if (!cancelled) {
          setPermissions(all.filter((p) => p.sessionID === sessionId));
        }
      })
      .catch(() => { /* non-fatal */ });
    // Pull current pending questions (v2 API — may return 404 on older servers).
    window.api
      .opencodeQuestions()
      .then((all) => {
        if (!cancelled) {
          setQuestions(all.filter((q) => q.sessionID === sessionId));
        }
      })
      .catch(() => { /* non-fatal — v2-only endpoint */ });
    return () => {
      cancelled = true;
      clearInterval(branchPoll);
    };
  }, [sessionId, cwd]);

  // Refresh permissions list. Called on any permission event.
  const refreshPermissions = useCallback(() => {
    window.api
      .opencodePermissions()
      .then((all) =>
        setPermissions(all.filter((p) => p.sessionID === sessionId)),
      )
      .catch(() => { /* keep last-known */ });
  }, [sessionId]);

  // Refresh question list. Called on any question event.
  const refreshQuestions = useCallback(() => {
    window.api
      .opencodeQuestions()
      .then((all) =>
        setQuestions(all.filter((q) => q.sessionID === sessionId)),
      )
      .catch(() => { /* keep last-known — v2-only endpoint */ });
  }, [sessionId]);

  // Subscribe to the global opencode event stream; filter by sessionID.
  useEffect(() => {
    const scheduleRefetch = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        window.api
          .opencodeMessages(sessionId)
          .then((m) => setMessages(m))
          .catch(() => { /* keep last-known state */ });
      }, 300);
    };

    const off = window.api.onOpencodeEvent((ev: OpencodeEvent) => {
      const props = ev.properties ?? {};
      if (props.sessionID && props.sessionID !== sessionId) return;

      if (ev.type === "message.part.delta") {
        const partID = String(props.partID ?? "");
        const messageID = String(props.messageID ?? "");
        const field = String(props.field ?? "text");
        const delta = String(props.delta ?? "");
        if (!partID || !delta) return;

        setMessages((prev) => {
          if (!prev) return prev;
          let matched = false;
          const next = prev.map((m) => {
            if (m.info.id !== messageID) return m;
            const parts = m.parts.map((p) => {
              if (p.id !== partID) return p;
              matched = true;
              return { ...p, [field]: ((p as Record<string, unknown>)[field] as string ?? "") + delta };
            });
            return { ...m, parts };
          });
          if (!matched) {
            scheduleRefetch();
          }
          return next;
        });
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

      if (
        ev.type === "session.idle" ||
        ev.type === "session.status" ||
        ev.type === "session.compacted" ||
        ev.type === "session.error" ||
        ev.type === "message.part.updated" ||
        ev.type === "message.updated"
      ) {
        scheduleRefetch();
      }

      // Drain the queue between tool calls — send the next queued message as
      // soon as a tool part completes, rather than waiting for session.idle.
      if (
        ev.type === "message.part.updated" &&
        props.type === "tool" &&
        (props.state as Record<string, unknown> | undefined)?.status === "completed" &&
        messageQueueRef.current.length > 0
      ) {
        sendQueuedRef.current();
      }

      // Permission lifecycle — refresh the inline approval list so the card
      // appears/disappears in real time as opencode requests/closes them.
      if (ev.type === "permission.asked" || ev.type === "permission.replied") {
        refreshPermissions();
        // permission.replied implies the matching tool just unstuck — pull
        // the canonical message state so the ToolPart re-renders as running.
        if (ev.type === "permission.replied") scheduleRefetch();
      }

      // Question lifecycle — refresh the inline question list so the card
      // appears/disappears in real time as opencode requests/closes them.
      if (
        ev.type === "question.asked" ||
        ev.type === "question.replied" ||
        ev.type === "question.rejected"
      ) {
        refreshQuestions();
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
    };
  }, [sessionId]);

  // Track scroll position to set the pinned-to-bottom flag. A small threshold
  // (~80px) means user has to scroll a meaningful amount UP to break out of
  // tail-follow mode, and scrolling back close to the bottom rejoins it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedToBottom.current = dist < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // On every messages update (initial fetch, refetch, or in-flight delta),
  // if we're pinned to the bottom, glue to it. Streaming text triggers this
  // many times per second so the viewport follows the tail naturally.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Going from idle → running (just sent a message): force pin to bottom so
  // the user sees their own message and the live spinner appear.
  // Only fires on the false→true edge; does NOT re-pin on every streaming
  // update (that would yank the viewport while the user is reading history).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running && !wasRunning.current) {
      pinnedToBottom.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    wasRunning.current = running;
  }, [running]);

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

  // Textarea auto-resize up to a 6-line cap. After resizing, if the scroll
  // container is pinned to bottom we re-scroll so the input growing pushes
  // the chat content up rather than sliding over it.
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cap = 6 * 20;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    if (pinnedToBottom.current) {
      const sc = scrollRef.current;
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  }, []);
  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    // Block submit while any attachment is still uploading — easy to forget
    // a file is mid-transfer when the input is short.
    if (attachments.some((a) => a.status === "uploading")) {
      setSendError("Wait for attachments to finish uploading.");
      return;
    }
    // If the AI is already running, push to the queue instead of aborting.
    // Items are sent automatically one at a time as running flips to false.
    if (running) {
      setMessageQueue((q) => [...q, text]);
      setInput("");
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

    const readyAttachments = attachments
      .filter((a) => a.status === "ready" && a.remotePath)
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

  // Always-current mirror of messageQueue for use inside the SSE handler
  // (effects capture a stale closure; a ref stays live).
  const messageQueueRef = useRef<string[]>([]);
  messageQueueRef.current = messageQueue;

  // Pops the front of the queue and fires it directly to opencode without
  // going through submit(). Used by the SSE handler to drain between tool
  // calls — submit()'s `running` guard would block it there.
  const sendQueuedRef = useRef<() => void>(() => {});
  sendQueuedRef.current = () => {
    const q = messageQueueRef.current;
    if (q.length === 0) return;
    const [next, ...rest] = q;
    setMessageQueue(rest);
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
        parts: [{ id: `${optimisticUserId}-text`, messageID: optimisticUserId, type: "text", text: next }],
      },
    ]);
    window.api
      .opencodePrompt(sessionId, next, modelOverride ?? undefined, [], undefined)
      .catch((e: unknown) => {
        setSendError(String((e as Error)?.message ?? e));
        setMessages((prev) =>
          prev ? prev.filter((m) => m.info.id !== optimisticUserId) : prev,
        );
      });
  };

  // When the AI finishes and there are queued messages, send the next one
  // automatically. We pop the front item, restore it into `input`, and defer
  // one tick so the state update propagates before submit() reads `input`.
  useEffect(() => {
    if (running || messageQueue.length === 0) return;
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
      try {
        await window.api.opencodePermissionReply(requestId, reply);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        // Re-pull on failure so the card comes back if reply didn't land.
        refreshPermissions();
      }
    },
    [refreshPermissions],
  );

  const replyQuestion = useCallback(
    async (requestId: string, answers: string[][]) => {
      // Optimistically drop so the card disappears immediately.
      setQuestions((prev) => prev.filter((q) => q.id !== requestId));
      try {
        await window.api.opencodeQuestionReply(requestId, answers);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        // Re-pull on failure so the card comes back if reply didn't land.
        refreshQuestions();
      }
    },
    [refreshQuestions],
  );

  const rejectQuestion = useCallback(
    async (requestId: string) => {
      // Optimistically drop so the card disappears immediately.
      setQuestions((prev) => prev.filter((q) => q.id !== requestId));
      try {
        await window.api.opencodeQuestionReject(requestId);
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

  const deleteSession = useCallback(async () => {
    if (!tmuxSession || windowIndex == null) return;
    const ok = window.confirm(
      "Delete this session? This will remove the chat history on the server and close this window. Cannot be undone.",
    );
    if (!ok) return;
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

      // Split by mime. Image/PDF: send as FilePart (multimodal models need
      // bytes; the AI's Read tool can't decode an image). Everything else:
      // upload for AI accessibility, then drop the path into the textarea
      // as `@<absolute-path>` — agent-native pattern, the AI uses Read if
      // it actually needs the content.
      type Pending = { file: File; lp: string; mime: string; asAttachment: boolean };
      const pending: Pending[] = [];
      for (const f of list) {
        const lp = window.api.getPathForFile(f);
        if (!lp) continue;
        const mime = f.type || guessMime(f.name);
        const mode = mimeToInputMode(mime);
        // FilePart-eligible mimes: image, pdf, video, audio. Everything
        // else goes path-as-text.
        const asAttachment = mode !== "other";
        pending.push({ file: f, lp, mime, asAttachment });
      }
      if (pending.length === 0) return;

      // Pre-upload chip placeholders for the FilePart-bound entries only.
      const chipIds: string[] = [];
      const newChips: Attachment[] = [];
      for (const p of pending) {
        if (!p.asAttachment) continue;
        const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        chipIds.push(id);
        newChips.push({
          id,
          filename: p.file.name,
          mime: p.mime,
          status: "uploading",
          source: "drop",
        });
      }
      if (newChips.length > 0) setAttachments((prev) => [...prev, ...newChips]);

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
        if (chipIds.length > 0) {
          setAttachments((prev) =>
            prev.map((a) =>
              chipIds.includes(a.id) ? { ...a, status: "error", errorMsg: msg } : a,
            ),
          );
        } else {
          setSendError(msg);
        }
        return;
      }

      // Wire results back to chips (FilePart entries) and append text
      // references (path-only entries).
      let chipCursor = 0;
      const pathRefs: string[] = [];
      for (let i = 0; i < pending.length; i++) {
        const rp = remotePaths[i];
        if (!rp) continue;
        if (pending[i].asAttachment) {
          const id = chipIds[chipCursor++];
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: "ready", remotePath: rp } : a)),
          );
        } else {
          pathRefs.push(rp);
        }
      }
      if (pathRefs.length > 0) {
        // Insert each path as a `@<abs-path>` token at the end of the
        // current input. Keeps the cursor wherever the user left it.
        setInput((prev) => {
          const sep = prev.length === 0 || prev.endsWith(" ") || prev.endsWith("\n") ? "" : " ";
          return prev + sep + pathRefs.map((p) => `@${p}`).join(" ") + " ";
        });
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
    async (query: string) => {
      const seq = ++fileSearchSeqRef.current;
      if (!cwd) {
        setFileResults([]);
        return;
      }
      try {
        const list = await window.api.opencodeFindFiles({ query, directory: cwd });
        if (seq === fileSearchSeqRef.current) setFileResults(list.slice(0, 20));
      } catch {
        if (seq === fileSearchSeqRef.current) setFileResults([]);
      }
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
      if (info.role === "assistant") {
        // OpencodeMessageInfo type doesn't surface `tokens` directly — read
        // it off the underlying record. Shape matches AssistantMessage.tokens
        // from the OpenAPI doc.
        return (info as unknown as { tokens?: TokenUsage }).tokens ?? null;
      }
    }
    return null;
  }, [messages, stepTokens]);

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
    if (todosDismissed) return null;
    if (liveTodos && liveTodos.length > 0) {
      return liveTodos as unknown as Array<Record<string, unknown>>;
    }
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p.type === "tool" && (p as Record<string, unknown>).tool === "todowrite") {
          const state = (p as Record<string, unknown>).state as
            | { input?: { todos?: Array<Record<string, unknown>> } }
            | undefined;
          const todos = state?.input?.todos;
          if (Array.isArray(todos) && todos.length > 0) return todos;
        }
      }
    }
    return null;
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
              // Slash-command provenance resolution — two paths:
              //
              // (1) Live: `command.executed.messageID` points at the
              //     ASSISTANT turn the command kicked off (the new,
              //     initially-empty assistant message), not the user
              //     message holding the expanded template. The expanded
              //     user message sits at messages[idx], the assistant at
              //     messages[idx+1]. If the next message's id is in the
              //     live map, use that.
              // (2) Historical: live events only fire for commands invoked
              //     during this panel's lifetime. For older transcripts,
              //     detect command-origin by matching the user-message
              //     text against the static prefix of every known command
              //     template (see detectCommandFromText). When a match
              //     hits we don't have the run-time `arguments` string —
              //     just the name. That's fine for the collapsed pill.
              let cmdInfo: { name: string; arguments: string } | null = null;
              if (m.info.role === "user") {
                const nextMsg = messages[idx + 1];
                if (nextMsg && nextMsg.info.role === "assistant") {
                  cmdInfo = commandByMessageId.get(nextMsg.info.id) ?? null;
                }
                if (!cmdInfo && commands && commands.length > 0) {
                  const userText = m.parts
                    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
                    .map((p) => p.text ?? "")
                    .join("\n");
                  const detected = detectCommandFromText(userText, commands);
                  if (detected) cmdInfo = { name: detected, arguments: "" };
                }
              }
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
          </div>
        )}
        </div>
      </div>

      {/* Pending question cards. Shown above permissions + running indicator */}
      {/* so they're hard to miss — tool execution blocks until answered. */}
      {questions.length > 0 && (
        <div className="shrink-0 px-4 pt-2 space-y-2">
          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              request={q}
              onReply={(answers) => replyQuestion(q.id, answers)}
              onReject={() => rejectQuestion(q.id)}
            />
          ))}
        </div>
      )}

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

      {running && (
        <>
          <RunningIndicator tokens={latestTokens} atBottom={pinnedToBottom.current} />
          {activeTodos && <ActiveTodos todos={activeTodos} />}
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
        modelLabel={modelLabel}
        showThinking={showThinking}
        chatAutoAllow={chatAutoAllow}
        setChatAutoAllow={setChatAutoAllow}
        tokens={latestTokens}
        models={models}
        modelOverride={modelOverride}
        defaultModel={defaultModel}
        activeModel={activeModel}
        onOpenModels={ensureModels}
        onSelectModel={selectModel}
        canFork={!!tmuxSession}
        canDelete={tmuxSession != null && windowIndex != null}
        onFork={forkSession}
        onCompact={compactSession}
        onDelete={deleteSession}
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

function ActiveTodos({ todos }: { todos: Array<Record<string, unknown>> }) {
  // Render every item inline — in_progress as a filled square (orange),
  // pending as empty square, completed as green ✓ in dim text, cancelled
  // as ⊘. Collapsing completed items reads worse than just listing them.
  return (
    <div className="px-4 pb-2 text-[13px]">
      {todos.map((t, i) => {
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
    </div>
  );
}

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
// Chunky horizontal bar with a dotted "empty" pattern and a solid filled
// portion. Color staged by usage: green → yellow → orange → red.
// Matches the Claude TUI style.

function ContextBar({ pct, tooltip }: { pct: number; tooltip?: string }) {
  const fill = ctxStageColor(pct);
  // Dot pattern uses the same hue at ~35% alpha so the "remaining" area still
  // reads as the same stage color, just dimmer.
  const dot = `${fill}55`;
  return (
    <span className="flex items-center gap-1.5 shrink-0" title={tooltip}>
      <span
        className="inline-block w-24 h-3 rounded-[2px] overflow-hidden align-middle"
        style={{
          // Solid base for the dot pattern to sit on.
          backgroundColor: "#1b1e25",
          backgroundImage: `radial-gradient(circle, ${dot} 1.2px, transparent 1.4px)`,
          backgroundSize: "4px 4px",
        }}
      >
        <span
          className="block h-full"
          style={{ width: `${pct}%`, backgroundColor: fill }}
        />
      </span>
      <span
        className="tabular-nums text-[12px] font-semibold"
        style={{ color: fill }}
      >
        {pct}%
      </span>
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

function SessionToolbar({
  canFork,
  canDelete,
  onFork,
  onCompact,
  onDelete,
}: {
  canFork: boolean;
  canDelete: boolean;
  onFork: () => void;
  onCompact: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="flex items-center gap-1 text-[10px]">
      <button
        onClick={onFork}
        disabled={!canFork}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted disabled:opacity-40 disabled:hover:text-text-faint"
        title="Fork — copy this session's history into a new window"
      >
        ⑂ fork
      </button>
      <button
        onClick={onCompact}
        className="px-1.5 py-px rounded text-text-faint hover:text-text-muted"
        title="Compact — summarize to free context"
      >
        ⌥ compact
      </button>
      <button
        onClick={onDelete}
        disabled={!canDelete}
        className="px-1.5 py-px rounded text-text-faint hover:text-red-300 disabled:opacity-40 disabled:hover:text-text-faint"
        title="Delete this session and close the window"
      >
        ✕ delete
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
    const answers = request.questions.map((info, i) => {
      const sel = Array.from(selected[i]);
      // If nothing was selected but custom text was entered, send that.
      if (sel.length === 0 && info.custom && customValues[i].trim()) {
        return [customValues[i].trim()];
      }
      return sel;
    });
    onReply(answers);
  }

  // Disable submit if any question has no selection AND no custom text.
  const canSubmit = request.questions.every((info, i) => {
    if (selected[i].size > 0) return true;
    if (info.custom && customValues[i].trim()) return true;
    return false;
  });

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

            {/* Free-text input when custom is true */}
            {info.custom && (
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
                className="mt-1.5 w-full rounded border border-border bg-transparent px-2 py-0.5 text-[12px] text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong"
              />
            )}
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

function InputArea({
  input,
  setInput,
  inputRef,
  submit,
  abort,
  running,
  branch,
  modelLabel,
  showThinking,
  chatAutoAllow,
  setChatAutoAllow,
  tokens,
  models,
  modelOverride,
  defaultModel,
  activeModel,
  onOpenModels,
  onSelectModel,
  canFork,
  canDelete,
  onFork,
  onCompact,
  onDelete,
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
  modelLabel: string | null;
  showThinking: boolean;
  chatAutoAllow: boolean;
  setChatAutoAllow: (v: boolean) => Promise<void>;
  tokens: TokenUsage | null;
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
  canFork: boolean;
  canDelete: boolean;
  onFork: () => void;
  onCompact: () => void;
  onDelete: () => void;
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
  const ctxTokens =
    tokens != null ? tokens.input + (tokens.cache?.read ?? 0) : 0;
  const ctxLimit = resolveContextLimit(activeModel);
  const ctxPct = Math.min(100, Math.round((ctxTokens / ctxLimit) * 100));
  return (
    <div className="shrink-0">
      {/* Error banner moved to ChatPanel scope (dismissable + closer to the */}
      {/* attachment strip). Nothing rendered here for sendError anymore. */}
      {/* Top divider — white-ish, matches Claude TUI. */}
      <div className="border-t border-text/25" />
      {/* Input row — no box, generous vertical padding. */}
      <div className="px-4 py-3 flex items-start gap-3">
        <span
          className="select-none pt-px shrink-0"
          style={{ color: CLAUDE_ORANGE }}
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
      {/* Bottom divider — white-ish. */}
      <div className="border-t border-text/25" />
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
              pct={ctxPct}
              tooltip={[
                `${ctxTokens.toLocaleString()} / ${ctxLimit.toLocaleString()} tokens`,
                activeModel
                  ? `Model window: ${activeModel.name}`
                  : `No active model — using ${ASSUMED_CONTEXT_TOKENS.toLocaleString()}-token fallback`,
                // Action hint scales with how close we are to the wall.
                // 100% on the real model limit means the next request will
                // very likely truncate or hit `model_context_window_exceeded`
                // — make the remediation explicit instead of letting the
                // user discover it from a truncated reply.
                ctxPct >= 100
                  ? "Compact recommended — run /compact to free space"
                  : ctxPct >= 90
                    ? "Approaching limit — consider /compact soon"
                    : null,
                tokens?.cache?.write
                  ? `${tokens.cache.write.toLocaleString()} cache write tokens — billed again on next cold turn`
                  : null,
              ]
                .filter(Boolean)
                .join("\n")}
            />
          )}
        </span>
        <span className="shrink-0 flex items-center gap-3">
          <SessionToolbar
            canFork={canFork}
            canDelete={canDelete}
            onFork={onFork}
            onCompact={onCompact}
            onDelete={onDelete}
          />
          <span className="text-[10px] text-text-faint">
            {running
              ? "esc · interrupt"
              : `ctrl+o · thinking ${showThinking ? "on" : "off"} · shift+⏎ newline · ⏎ send`}
          </span>
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
function UserCommandBar({
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
}

function MessageRow({
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
    return (
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
      </div>
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

  return (
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
    </div>
  );
}

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

function AssistantPart({
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
}

// Renders a tool's `output` string. If it looks like a unified diff (starts
// with `--- ` or `@@`, or has multiple `@@` headers), each line is colored
// red/green/neutral. Otherwise we render it as a monospace code block,
// truncated to a sensible height by default.
function ToolOutput({ output }: { output: string }) {
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
}

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

function ToolCall({ part, verbose }: { part: OpencodePart; verbose: boolean }) {
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
}

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
    default:
      // Unknown tool — show output (if any) as a generic block.
      return state.output ? <ToolOutput output={state.output} /> : null;
  }
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

function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {preprocessForStream(text)}
    </ReactMarkdown>
  );
}

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

function CodeBlock({ lang, body }: { lang?: string; body: string }) {
  // Trim a single trailing newline that almost always precedes the closing fence.
  const cleaned = body.replace(/\n$/, "");
  const normalized = (lang ?? "").toLowerCase();
  // Resolve alias → canonical Prism Language, falling back to a no-op token
  // mode if Prism doesn't know it (preserves spacing without throwing).
  const resolved: Language | undefined =
    PRISM_LANG_ALIAS[normalized] ??
    (PRISM_SUPPORTED.has(normalized) ? (normalized as Language) : undefined);

  return (
    <div className="my-2 rounded border border-border bg-bg-soft overflow-hidden">
      {lang && (
        <div className="px-2 py-0.5 text-[10px] text-text-faint border-b border-border bg-bg-elev">
          {lang}
        </div>
      )}
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
    </div>
  );
}

