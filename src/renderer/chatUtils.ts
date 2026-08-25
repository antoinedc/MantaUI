// Pure utility functions extracted from ChatPanel for testability.

// Type-only import — erased at compile time, keeps this module dependency-
// free at runtime (the whole point of chatUtils.ts: pure functions testable
// without DOM/Electron/network).
import type { ReactNode } from "react";
import type { ConnectionStateName } from "../shared/net/state.js";
import type { AppControlPayload, CheckRollup, DelegateApprovalTool, ForgeCheckRun, ForgeInboxItem, InboxReason, MediaEventPayload, OpencodeAgent, OpencodeMessage, OpencodeModel, OpencodePart, PermissionRequest, ProgressRecord, ProgressState, Project, PullRequest, QuestionRequest, RepoHit, TmuxWindow, UpdateTarget, UsageSnapshot, UsageWindow, WidgetEventPayload } from "../shared/types";
import type { SessionMode } from "./chatShared";
import type { VoiceNoteRecord } from "../shared/types";
// Value import — `isClientTooOld` is the pure semver compare that drives
// the renderer-side version-skew banner (BET-225 stage 3). Lives in
// shared/versionCompare.mjs so both src/server/*.mjs and the renderer share
// one source of truth; re-imported here so chooseUpdateSkewVariant is
// testable in isolation (no DOM/network, just the compare).
import { isClientTooOld } from "../shared/versionCompare.mjs";
// BET-1139: the deprecated-model predicate lives in the shared node-safe
// module (the ONE place the literal "deprecated" is compared) and is imported
// here so renderer consumers call `isDeprecated` rather than re-comparing.
import { isDeprecated } from "../shared/modelGuide.mjs";

// Stable identity for a mounted Terminal in App.tsx's visitedModes map. A
// tmux window is identified by its session name + index, which EVERY window
// has — unlike the opencode session id, which only manta-created windows
// carry. Without this, opening a pre-existing tmux session in the sidebar
// renders a black pane (BET-347).
//
// The NUL separator is deliberate: tmux session names may contain `:` (the
// only character tmux forbids in a session name is `.`), and the key is
// NEVER parsed back apart — the map value carries the fields. Do not write a
// matching parse function; if you find yourself needing one, you have kept a
// string where the map value should be used instead.
export function terminalMountKey(
  tmuxSession: string,
  windowIndex: number,
  modeId: string,
): string {
  return `${tmuxSession}\u0000${windowIndex}\u0000${modeId}`;
}

// One mounted Terminal record (BET-347). `tmuxTarget` is set iff the window
// has no opencodeSessionId (a window Manta did not create) — the server's
// pty:spawn then runs `tmux attach-session -t <target>` so the user sees
// the live contents of their pre-existing tmux window instead of a blank
// pane.
export type MountedTerminal = {
  tmuxSession: string;
  windowIndex: number;
  modeId: string;
  cwd: string;
  tmuxTarget?: string;
};

// Record (or refresh) a Terminal mount for the given window + mode in
// App.tsx's visitedModes map. Sets `tmuxTarget` iff chatSessionId is null
// (adopted window) so the server spawns `tmux attach-session` instead of a
// fresh shell. Centralising this keeps the mode-reset effect and setMode
// from drifting (BET-347).
export function registerMountedTerminal(
  visited: Map<string, MountedTerminal>,
  tmuxSession: string,
  windowIndex: number,
  m: SessionMode,
  cwd: string,
  chatSessionId: string | null,
): void {
  if (m === "chat") return;
  const modeId = m === "terminal" ? "terminal" : m.slice("tui:".length);
  visited.set(terminalMountKey(tmuxSession, windowIndex, modeId), {
    tmuxSession,
    windowIndex,
    modeId,
    cwd,
    tmuxTarget: chatSessionId ? undefined : `${tmuxSession}:${windowIndex}`,
  });
}// ===== Box-side stream interpretation (BET-551) =====
// Moved to ../shared/streamInterpretation.mjs (§17). chatUtils re-exports so
// the renderer keeps one implementation while it migrates to consuming the
// box's interpreted events (S1b).
export {
  ASSUMED_CONTEXT_TOKENS,
  AUTO_RENAME_EVERY_N_TURNS,
  STALE_CACHE_MIN_TOKENS,
  VISIBLE_TODOS_CAP,
  allTodosTerminal,
  applyQuestionEvent,
  buildTitleInstruction,
  buildTitlePromptInput,
  classifyCacheAge,
  classifyFinish,
  collectChildSessionIds,
  computeContextBreakdown,
  computeStaleCache,
  countRunningSubagents,
  countUserTurns,
  describeTruncation,
  extractSubagentInfo,
  findFlushBoundary,
  humanizeProviderError,
  hydrateQuestion,
  isAssistantTurnComplete,
  isAssistantTurnInProgress,
  isSelfFilteringLifecycleEvent,
  isTerminalTodo,
  mergeBufferedDeltas,
  registerChildSessionFromCreated,
  resolveContextLimit,
  sanitizeGeneratedTitle,
  selectActiveTodos,
  selectCacheTtlMs,
  selectLastAssistantCompletion,
  selectVisibleTodos,
  shouldAutoRename,
  shouldDropEventForSessionFilter,
  summarizeChildSession,
} from "../shared/streamInterpretation.mjs";
export type {
  ContextBreakdown,
  ContextSegment,
  PendingDelta,
  QuestionLike,
  StaleCacheResult,
  SubagentInfo,
  TruncationKind,
} from "../shared/streamInterpretation.mjs";


// Compact "Nk" / "NM" display for a model's context window (e.g. 200_000 →
// "200k", 1_000_000 → "1M", 1_500_000 → "1.5M"). Returns null for a
// missing/non-positive limit so callers can omit the badge entirely rather
// than rendering "0k". The canonical formatting expression — ModelPicker,
// ModelsCard and SubagentsCard all import this instead of re-deriving it
// inline. At or above 1_000_000 it switches to millions and strips a
// trailing ".0"; below it keeps the k form (BET-644).
export function formatModelContextSize(
  context: number | null | undefined,
): string | null {
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return null;
  }
  if (context >= 1_000_000) {
    const m = context / 1_000_000;
    return `${(Math.round(m * 10) / 10).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(context / 1000)}k`;
}

// Find the opencode session title for a given session id, from the session
// list returned by opencodeListSessions (GET /session). opencode names a
// session from its first user message only when it has one — a manta-created
// chat session is created with an EMPTY title and opencode leaves it empty
// even after the first turn (verified live, 1.18.10; BET-1100's premise was
// wrong), so for those sessions this returns "". The auto-rename first-name
// caller therefore falls through to the title agent
// (opencodeGenerateTitle), and only uses this cheap list path for sessions
// that genuinely carry a title (e.g. adopted/externally-created ones).
// Returns "" when the session is missing or hasn't been titled — the caller
// falls through to generation, and retries on the next turn if that also
// fails.
export function findSessionTitle(
  sessions: { id: string; title?: string }[],
  sessionId: string,
): string {
  if (!sessions || !sessionId) return "";
  const s = sessions.find((x) => x.id === sessionId);
  return s && typeof s.title === "string" ? s.title.trim() : "";
}

// Title-case a model variant / effort id for display: "high" → "High",
// "extended-thinking" → "Extended Thinking". The raw id is preserved for the
// wire; this is display-only. Extracted to chatUtils so ModelPicker's effort
// trigger label and the effort menu share one source (BET-644).
export function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// Client-side filter over already-grouped models for the model menu's search
// strip (BET-644): case-insensitive substring against the model NAME or the
// provider id. A group whose models all filter out is elided (its header
// disappears too). An empty / whitespace query returns the groups unchanged.
export function filterModelGroups(
  groups: Array<[string, OpencodeModel[]]>,
  query: string,
): Array<[string, OpencodeModel[]]> {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: Array<[string, OpencodeModel[]]> = [];
  for (const [providerID, ms] of groups) {
    const filtered = ms.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.providerID.toLowerCase().includes(q),
    );
    if (filtered.length > 0) out.push([providerID, filtered]);
  }
  return out;
}

// Move the model menu's roving highlight index one step, wrapping at both
// ends (BET-644). Returns -1 for an empty option list. From a cold (-1)
// index, down starts at the top (0) and up starts at the bottom (length - 1).
export function moveMenuHighlight(
  index: number,
  dir: -1 | 1,
  length: number,
): number {
  if (length <= 0) return -1;
  if (index < 0) return dir > 0 ? 0 : length - 1;
  return (index + dir + length) % length;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${Math.round(n / 1000)}k tokens`;
}

// Compact token figure for inline surfaces (the compaction saving pill / the
// "128k → 31k" one-liner). Built on formatTokens — never a second formatter —
// with the " tokens" suffix stripped.
function formatTokensCompact(n: number): string {
  return formatTokens(n).replace(/\s+tokens$/, "");
}

// ---- Optimizer P2.5 (BET-1347) pure formatters ------------------------------

export type PressureTone = "neutral" | "ok" | "warn";

/**
 * Describe a subscription window's pacing pressure for the pressure chip that
 * sits under its gauge. `hasSignal` is false when there is no pressure signal
 * yet (tokensPerPct is null or there are too few samples) — that renders the
 * documented NEUTRAL state, never a fabricated pace.
 *
 *   hasSignal=false        -> "no pressure signal yet"      (neutral)
 *   hasSignal, deficit<=0  -> "on pace"                     (ok)
 *   hasSignal, deficit>0   -> "+N pts ahead of pace"        (warn)
 */
export function describePressure(deficit: number, hasSignal: boolean): { text: string; tone: PressureTone } {
  if (!hasSignal) return { text: "no pressure signal yet", tone: "neutral" };
  const pts = Math.round(deficit);
  if (deficit > 0) return { text: `+${pts} pts ahead of pace`, tone: "warn" };
  return { text: "on pace", tone: "ok" };
}

export type ActivityEntry = {
  id?: string;
  ts?: number;
  kind: string;
  subject?: string;
  from?: string | number;
  to?: string | number;
  verdict: string;
  evidence?: Record<string, string | number>;
  revertedAt?: number;
};

const VERDICT_WORD: Record<string, string> = {
  kept: "Kept",
  "rolled-back": "Rolled back",
  applied: "Applied",
};

// A compact evidence line: "62 turns · hit 74.1% · churn 0.4%" — joined from
// the counts/measurements, never content.
function evidenceLine(evidence?: Record<string, string | number>): string {
  if (!evidence) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (v === undefined || v === null || String(v) === "") continue;
    const label = k.replace(/([A-Z])/g, " $1").replace(/^[a-z]/g, (c) => c.toUpperCase()).trim();
    parts.push(`${label} ${v}`);
  }
  return parts.join(" · ");
}

/**
 * Describe one activity-log entry for the feed: a headline (the verdict with
 * the change it describes) and the evidence line. The prefix is derived from
 * `verdict` (so a rolled-back entry is visually distinct); `subject` is the
 * change itself.
 */
export function describeActivityEntry(entry: ActivityEntry): { headline: string; detail: string } {
  const word = VERDICT_WORD[entry.verdict] ?? entry.verdict ?? "Changed";
  const subject = typeof entry.subject === "string" && entry.subject ? entry.subject : "optimizer change";
  return {
    headline: `${word} — ${subject}`,
    detail: evidenceLine(entry.evidence),
  };
}

/**
 * Format a compaction's before/after token sizes for the "⟳ Compacted ... ·
 * 128k → 31k" one-liner. Returns the arrowed savings when the compaction
 * actually shrank the context, or "0" when there was no reduction (before and
 * after equal or after > before) — never fabricates a saving.
 */
export function formatCompactionSaving(before: number, after: number): string {
  const isNum = (n: number): boolean => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!isNum(before) || !isNum(after)) return "0";
  if (after >= before) return "0";
  return `${formatTokensCompact(before)} → ${formatTokensCompact(after)}`;
}

// Build an SVG path string for a CUMULATIVE series over `values` (oldest →
// newest), for the Optimizer's "sent vs raw counterfactual" consumption chart
// (BET-1337). Each point's x is spaced linearly across `width`; its y is the
// running sum, inverted (larger = higher up = smaller y) and scaled by `max`
// against `height` so `max` maps to the very top (y=0). Coordinates are
// quantized to 2 decimal places so repeated renders are byte-stable. empty input → ""
// so callers can render nothing rather than an "M x y" with no points.
export function buildCumulativePath(
  values: number[],
  width: number,
  height: number,
  max: number,
): string {
  if (!Array.isArray(values) || values.length === 0) return "";
  let cum = 0;
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    cum += typeof v === "number" && Number.isFinite(v) ? v : 0;
    const x = i === 0 ? 0 : (i / (values.length - 1)) * width;
    const y = max > 0 ? height - (cum / max) * height : height;
    parts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M ${parts.join(" L ")}`;
}

// Human-readable file size for the agent-file toast. Binary units (KiB-style
// thresholds) but SI-ish labels (KB/MB/GB) to match what users expect from a
// download chip. 0 / unknown → "" so the caller can omit the size entirely.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val < 10 ? val.toFixed(1).replace(/\.0$/, "") : Math.round(val)} ${units[i]}`;
}

// ===== Download confirmation (BET-1198) =====
//
// Every desktop download (outbox toast Save, inline-media hover/preview
// Download, artifacts row) ends by writing a REAL file to the downloads
// folder — but the only feedback used to be a faint "· saved to Downloads"
// on one of the three, and nothing at all on the other two. A save the user
// can't see reads as a save that didn't happen (that is exactly how a working
// inline-media download got reported as broken). The confirmation names the
// FULL folder so the file is findable without guessing which folder "Downloads"
// meant — a custom `downloadsDir` in Settings makes that genuinely ambiguous.
//
// Pure: split a saved absolute path into the folder that holds it and the file
// name. Returns null when there is no OS path to describe — mobile/web, where
// agentPullFile hands the bytes to the browser and returns "" (the browser owns
// the "downloaded" chrome there, so we must not claim a path we don't have).
export function describeSavedFile(
  localPath: string | undefined | null,
): { dir: string; name: string } | null {
  if (typeof localPath !== "string") return null;
  const trimmed = localPath.trim();
  if (!trimmed) return null;
  // Windows separators too — the desktop app ships on Windows and main hands
  // back whatever `path.join` produced there.
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return { dir: "", name: trimmed };
  const name = trimmed.slice(cut + 1);
  if (!name) return null; // a bare directory ("/a/b/") is not a saved file
  // Keep the root slash: dirname("/x.png") is "/", not "".
  const dir = cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
  return { dir, name };
}

// Decode a `data:<mime>;base64,<payload>` (or url-encoded) URI into its MIME
// type and raw bytes. Used by the artifacts panel so a self-contained inline
// image (href is a data URI, not a box path) can be downloaded/attached
// without a network round-trip. Returns null for anything that isn't a data
// URI. `atob` / `TextEncoder` are global in the browser and Node 16+.
export function decodeDataUri(dataUri: string): { mime: string; data: Uint8Array } | null {
  if (!dataUri.startsWith("data:")) return null;
  const comma = dataUri.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUri.slice(5, comma);
  const mime = /^[^;]+/.exec(meta)?.[0] ?? "application/octet-stream";
  const payload = dataUri.slice(comma + 1);
  let data: Uint8Array;
  if (meta.includes(";base64")) {
    const bin = atob(payload);
    data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  } else {
    data = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { mime, data };
}

// Short expiry label for a hosted-page state pill: "23h" / "2h" for live/soon
// pages (whole hours, floor at 1 so a fresh page never reads "0h"), "" for an
// expired or unexpiring artifact (the pill is omitted entirely then).
export function expiryLabel(expiresAt: number | null | undefined, now: number): string {
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= now) return "";
  const hours = Math.floor((expiresAt - now) / 3_600_000);
  return `${Math.max(1, hours)}h`;
}

// Compact wall-clock duration (no spaces): "59s", "1m44s", "2h3m4s".
// Used by the turn footer (`✻ 1m44s · 12.4k`) and the live running row so
// the two read identically.
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// Canonical compact timer format shared across the app (and mirrored 1:1 by the
// iOS `SessionTimerFormat.compact`): "2h57m" / "57m" / "2h" / "45s". No spaces,
// h/m/s abbreviations; seconds shown only under a minute; hours drop the
// minutes when they're zero. Use THIS for any elapsed/distance timer (reset
// distances, idle text, running rows) instead of hand-rolling another shape.
// This is the compact *timer* ladder — see `formatDuration` above for the
// seconds-precise task/turn form ("1m44s", "2h3m4s"), which is a distinct thing.
export function formatTimerDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Wall-clock time for the subtle per-message timestamp gutter. Renders a
// 24-hour "HH:MM" from an epoch-ms value. Returns "" for null/undefined or
// non-finite input so the caller can render nothing without extra guards.
// 24h is locale-stable and compact (5 chars) — important because the gutter
// is fixed-width and sits left of every message.
export function formatClockTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function ctxStageColor(pct: number): string {
  if (pct < 50) return cssVar("--ok");
  if (pct < 90) return cssVar("--warn");
  return cssVar("--danger");
}

// ===== Theme token access from JS =====
//
// Inline styles and pure helpers (bulletStyle, ctxStageColor, cache colours,
// mobile status dots, voice mic) need a token's resolved value rather than a
// `var(--…)` string. cssVar reads the CSS custom property off the root element
// so the value follows the active theme. In non-DOM contexts (unit tests in
// node/jsdom, where getComputedStyle returns "" for custom properties) it
// falls back to the literal value the token held at the time of this rename —
// keeping tests green without re-asserting hex at every call site. The
// fallback map lives here (a .ts module) so no .tsx file carries a hex
// literal (BET-408 acceptance: `grep '#[0-9A-Fa-f]{6}' src/renderer --include=*.tsx`
// returns only Terminal.tsx).
const TOKEN_FALLBACK: Record<string, string> = {
  "--ok": "#22C79A",
  "--warn": "#FACC15",
  "--danger": "#F0505F",
  "--info": "#22BEE0",
  "--tx4": "#5C6578",
};

export function cssVar(name: string): string {
  if (typeof document !== "undefined" && document.documentElement) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) return v;
  }
  return TOKEN_FALLBACK[name] ?? "";
}

// Sidebar/mobile "time since last message" label (BET-119). Floors to the
// coarsest unit that still fits so the label stays short ("3m", "1h", "2d").
// Sub-minute elapsed collapses to "now" to avoid per-second re-renders — the
// label is driven by whatever re-renders the status map already (2s poller
// batches / SSE-driven store updates), not a dedicated ticking interval.
export function formatAge(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(elapsedMs / 86_400_000);
  return `${days}d`;
}

// ===== Quote selection → composer (BET-1351) =====
//
// Normalises a transcript selection into ONE middle-truncated blockquote line
// (`"> ...\n\n"`) that gets PREPENDED to whatever is already in the composer.
// There is deliberately no hidden payload / chip / extra composer state: the
// model already holds the full transcript in its context, so the quote only
// has to be a locatable pointer. Collapsing to a single line also kills the
// class of bug where a selection spanning several flex-laid-out paragraph
// blocks serialises without its newlines.

/** Longest quoted line, in chars. */
export const QUOTE_MAX = 240;
/** Chars kept from the head of a quote that exceeds `QUOTE_MAX`. */
export const QUOTE_HEAD = 140;
/** Chars kept from the tail of a quote that exceeds `QUOTE_MAX`. */
export const QUOTE_TAIL = 80;

/** "beginning … end". Returns `text` unchanged when it fits within `max`. */
export function truncateMiddle(text: string, max: number, head: number, tail: number): string {
  if (text.length <= max) return text;
  return text.slice(0, head).trimEnd() + " \u2026 " + text.slice(text.length - tail).trimStart();
}

/**
 * Selection → the exact string to prepend to the composer, or null when the
 * selection has no usable text. Whitespace runs collapse to a single space,
 * the result is trimmed, truncated, then prefixed with `"> "` and suffixed
 * with a blank line (`"\n\n"`).
 */
export function buildQuoteBlock(selection: string, max: number, head: number, tail: number): string | null {
  const collapsed = selection.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const truncated = truncateMiddle(collapsed, max, head, tail);
  return "> " + truncated + "\n\n";
}

export type TypeaheadCommandRow = {
  name: string;
  description?: string;
};

/**
 * Filter a list of commands by a query string (case-insensitive substring match).
 * Empty query returns all commands.
 */
export function filterCommands<T extends TypeaheadCommandRow>(
  commands: T[],
  query: string,
): T[] {
  if (!query) return commands;
  const q = query.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * Deduplicate opencode commands against a set of builtin names so we never
 * show two entries for the same command name.
 */
export function dedupeAgainstBuiltins<T extends TypeaheadCommandRow>(
  commands: T[],
  builtinNames: Set<string>,
): T[] {
  return commands.filter((c) => !builtinNames.has(c.name));
}

// ===== manta-local slash commands =====
//
// The single source for the renderer's local slash commands ("clear", "fork",
// "compact", "help"). These are handled in the renderer (never forwarded to
// opencode's /command endpoint) because opencode doesn't ship equivalents —
// they're terminal-TUI conventions users expect to "just work". Both ChatPanel
// (execution + /help text) and useTypeahead (typeahead completion) import this
// ONE definition, so a builtin added here both runs and autocompletes.
export type BuiltinCommand = {
  name: string;
  description: string;
};
export const MANTA_BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "clear", description: "Start a fresh chat in this window" },
  { name: "fork", description: "Copy this session's history into a new window" },
  { name: "compact", description: "Summarize to free context" },
  { name: "help", description: "Show available commands" },
];
export const MANTA_BUILTIN_NAMES = new Set(MANTA_BUILTIN_COMMANDS.map((c) => c.name));

/**
 * The four todo states the ActiveTodos card renders, normalized.
 *
 * `status` arrives as a free-form string on both paths (the `todo.updated`
 * SSE payload and the transcript-scraped TodoWrite input), and the selectors
 * in streamInterpretation.mjs already lowercase before comparing. The RENDER
 * path used to compare case-sensitively, so a `"In_Progress"` sorted into the
 * current bucket but drew the pending checkbox. One normalizer now feeds both
 * the row and the progress summary, so they can't disagree.
 */
export type TodoStatus = "in_progress" | "completed" | "cancelled" | "pending";

export function todoStatusOf(t: Record<string, unknown>): TodoStatus {
  const s = String(t.status ?? "").toLowerCase();
  if (s === "in_progress") return "in_progress";
  if (s === "completed") return "completed";
  if (s === "cancelled") return "cancelled";
  return "pending";
}

export type TodoProgress = {
  total: number;
  /** completed + cancelled — everything the model is finished with. */
  settled: number;
  inProgress: number;
  /** Width of the green settled segment of the progress bar, 0-100. */
  settledPct: number;
  /** Width of the amber in-flight segment, 0-100. */
  activePct: number;
  /** Header label: the done/total counter, e.g. "3/5", "7/7". */
  label: string;
  allSettled: boolean;
};

/**
 * Count a todo list into the ActiveTodos card's header label and the two
 * progress-bar segment widths.
 *
 * Counts run over the WHOLE list, not the <= 5 rows `selectVisibleTodos`
 * renders — the bar's job is to say how much of the plan is left, which is
 * exactly the thing the visible-row cap hides. Cancelled counts as settled
 * (the model is done with it) but is drawn neutral rather than green by the
 * row itself, so a cancelled item advances the bar without claiming success.
 */
export function summarizeTodoProgress(
  todos: Array<Record<string, unknown>>,
): TodoProgress {
  let settled = 0;
  let inProgress = 0;
  for (const t of todos) {
    const s = todoStatusOf(t);
    if (s === "completed" || s === "cancelled") settled += 1;
    else if (s === "in_progress") inProgress += 1;
  }
  const total = todos.length;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const allSettled = total > 0 && settled === total;
  return {
    total,
    settled,
    inProgress,
    settledPct: pct(settled),
    activePct: pct(inProgress),
    label: `${settled}/${total}`,
    allSettled,
  };
}

/**
 * Format the hidden-counts overflow line for the ActiveTodos card.
 * Returns null when nothing is hidden (caller skips the row entirely).
 * Examples: "+ 5 pending & 5 done", "+ 5 pending", "+ 4 done".
 */
export function formatHiddenTodosSummary(
  hiddenPending: number,
  hiddenDone: number,
): string | null {
  const parts: string[] = [];
  if (hiddenPending > 0) parts.push(`${hiddenPending} pending`);
  if (hiddenDone > 0) parts.push(`${hiddenDone} done`);
  if (parts.length === 0) return null;
  return `+ ${parts.join(" & ")}`;
}

/**
 * Build the `string[][]` reply payload for a Question tool request from the
 * per-question selected option labels and the per-question free-text input.
 *
 * Custom text is always honored (the card now shows the free-text box for
 * every question, regardless of opencode's `custom` flag). When the user typed
 * something it is appended AFTER any selected option labels for that question,
 * so a picked option + a typed clarification both reach the model. A blank
 * custom field contributes nothing; selection-only and typed-only both work.
 *
 * Pure: no component state, fully unit-testable.
 *
 * @param selected one Set of selected option labels per question
 * @param customValues one free-text string per question (untrimmed)
 */
export function buildQuestionAnswers(
  selected: Array<ReadonlySet<string>>,
  customValues: readonly string[],
): string[][] {
  return selected.map((sel, i) => {
    const labels = Array.from(sel);
    const custom = (customValues[i] ?? "").trim();
    return custom ? [...labels, custom] : labels;
  });
}

/**
 * Whether a Question request is submittable: every question must have at least
 * one selected option OR non-empty typed text. Mirror of buildQuestionAnswers'
 * "an answer is a selection and/or custom text" contract.
 */
export function canSubmitQuestion(
  selected: Array<ReadonlySet<string>>,
  customValues: readonly string[],
): boolean {
  return selected.every(
    (sel, i) => sel.size > 0 || (customValues[i] ?? "").trim().length > 0,
  );
}

// === Slash-command provenance ===
//
// opencode injects a command's `template` into the transcript verbatim as a
// user message (with `$ARGUMENTS` / `$1`...`$9` substituted before injection).
// The canonical messages payload carries no flag identifying these messages
// as command-origin — only the live `command.executed` SSE event tags them,
// and only for commands invoked during the current panel session.
//
// `commandPrefixKey(template)` returns the longest static prefix of a command
// template (the substring before the first $-placeholder). At render time the
// renderer matches user-message text against this prefix to detect historical
// command invocations without needing the live event.
//
// We require a meaningful minimum length so trivial templates ("$1") don't
// match every short user message.
export const MIN_COMMAND_PREFIX_LEN = 12;

export function commandPrefixKey(template: string): string | null {
  if (typeof template !== "string") return null;
  // Find the first $-placeholder. `$1..$9` and `$ARGUMENTS` both start with $;
  // a `$` followed by anything that isn't a word char (e.g. `$5,000`) is NOT a
  // placeholder, but templates almost never have such literals — and even if
  // they do, treating them as a placeholder boundary just makes the prefix
  // shorter, never wrong.
  const dollarIdx = template.search(/\$(?:[1-9]|ARGUMENTS|[A-Z_]+)/);
  const prefix = dollarIdx >= 0 ? template.slice(0, dollarIdx) : template;
  // Strip trailing whitespace so we don't accidentally fail to match when
  // opencode substitutes a placeholder that abuts non-whitespace.
  const trimmed = prefix.replace(/\s+$/, "");
  if (trimmed.length < MIN_COMMAND_PREFIX_LEN) return null;
  return trimmed;
}

/**
 * Detect which command, if any, produced a given user-message text. Returns
 * the command name on hit, null on miss. O(commands) per call — caller is
 * expected to memoize over the messages list.
 *
 * Match strategy: the message text must start with the command's static
 * prefix (template up to the first $-placeholder). Ties broken by longest
 * prefix (most specific match wins).
 */
export function detectCommandFromText(
  text: string,
  commands: Array<{ name: string; template?: string }>,
): string | null {
  if (!text) return null;
  let best: { name: string; len: number } | null = null;
  for (const c of commands) {
    if (!c.template) continue;
    const prefix = commandPrefixKey(c.template);
    if (!prefix) continue;
    if (text.startsWith(prefix)) {
      if (!best || prefix.length > best.len) {
        best = { name: c.name, len: prefix.length };
      }
    }
  }
  return best?.name ?? null;
}

// ── Queued-message drain (step-boundary abort) ────────────────────────────
// When the user queues a prompt mid-turn, manta no longer waits for the whole
// turn to finish. At the next mid-turn STEP BOUNDARY it aborts the in-flight
// turn and lets the idle-drain submit the queued prompt as a fresh turn.
// These pure predicates make the decision points testable.
//
// IMPORTANT — the step boundary is a COMPLETED TOOL PART, not
// `session.next.step.ended`. That event (and the whole `session.next.*`
// family) is NOT emitted by the deployed opencode build — verified live by
// streaming `/event` during a multi-tool turn: only `message.part.updated`,
// `message.part.delta`, `session.status`, and a final `session.idle` arrive.
// The original step.ended trigger therefore never fired, so a queued prompt
// waited for full idle (the bug). A tool part flipping to a terminal status
// IS a genuine step boundary (the model just finished a tool round-trip and
// is about to think/call again), so aborting there is clean.

/**
 * Should a `message.part.updated` event trigger a drain-abort? True when the
 * updated part is a TOOL part that just reached a terminal status
 * ("completed" or "error") — i.e. a real mid-turn step boundary. The caller
 * still gates on a non-empty queue + the re-entrancy flag via
 * `shouldAbortForQueuedDrain`; this predicate only classifies the event.
 *
 * `part` is the loosely-typed `properties.part` off the SSE event.
 */
export function isToolStepBoundary(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as { type?: unknown; state?: { status?: unknown } };
  if (p.type !== "tool") return false;
  const status = p.state?.status;
  return status === "completed" || status === "error";
}

/**
 * Should a step boundary trigger a drain-abort? True when at least one prompt
 * is queued AND we have not already issued a drain-abort for the current turn
 * (`alreadyDraining` guards re-entrancy against the multiple boundary events
 * that can arrive before the abort POST lands).
 */
export function shouldAbortForQueuedDrain(
  queueLength: number,
  alreadyDraining: boolean,
): boolean {
  return queueLength > 0 && !alreadyDraining;
}

/**
 * Should a `session.error` be swallowed silently? True only for the
 * `MessageAbortedError` produced by our own drain-abort — the queued prompt
 * is about to be submitted on the upcoming idle, so the abort must be
 * invisible to the user (no error banner, no "aborted" framing). Any other
 * error name, or an abort the user triggered manually (`draining === false`),
 * falls through to normal error handling.
 */
export function isDrainAbortError(
  errName: string | undefined,
  draining: boolean,
): boolean {
  return draining && errName === "MessageAbortedError";
}

// BET-640: server-rpc unsupported-channel predicate. manta-server throws
// `unknown rpc channel: <ch>` (src/server/rpc.mjs) and httpApi surfaces that
// string as the Error message, so a box that doesn't implement a channel (e.g.
// the background-jobs endpoint on a box that predates delegation) rejects the
// RPC with exactly this text. Renderers use it to tell "endpoint not
// implemented" apart from a transport blip — the former should raise the
// incompatible banner, the latter should stay silent (BET-640).
export function isUnknownChannelError(message: string): boolean {
  return typeof message === "string" && message.includes("unknown rpc channel");
}

// describeCron — best-effort human-readable label for a 5-field cron
// expression, for the ScheduledTasksCard. Covers the common shapes the model
// emits; falls back to the raw expression for anything it doesn't recognize.
// Pure + never throws. cron fields: minute hour day-of-month month day-of-week.
export function describeCron(expr: string, recurring = true): string {
  const raw = (expr ?? "").trim();
  const f = raw.split(/\s+/);
  if (f.length !== 5) return raw || "(invalid)";
  const [min, hour, dom, month, dow] = f;

  const pad = (n: string) => (n.length === 1 ? `0${n}` : n);
  const isNum = (s: string) => /^\d+$/.test(s);
  const time = () =>
    isNum(min) && isNum(hour) ? `${hour}:${pad(min)}` : null;

  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowLabel = (s: string): string | null => {
    if (s === "1-5") return "weekdays";
    if (s === "0,6" || s === "6,0" || s === "0,7") return "weekends";
    if (isNum(s)) {
      const n = Number(s) % 7; // 7 → 0 (Sunday)
      return DOW_NAMES[n] ?? null;
    }
    return null;
  };

  // every-N-minutes: "*/N * * * *"
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = Number(stepMin[1]);
    return `every ${n} min`;
  }
  // hourly: "M * * * *"
  if (isNum(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return min === "0" ? "hourly" : `hourly at :${pad(min)}`;
  }
  // every-N-hours: "M */N * * *"
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (isNum(min) && stepHour && dom === "*" && month === "*" && dow === "*") {
    return `every ${Number(stepHour[1])}h`;
  }

  const t = time();
  // weekday/specific-day at time: "M H * * DOW"
  if (t && dom === "*" && month === "*" && dow !== "*") {
    const d = dowLabel(dow);
    if (d) return `${d} ${t}`;
  }
  // daily at time: "M H * * *"
  if (t && dom === "*" && month === "*" && dow === "*") {
    return recurring ? `daily ${t}` : `once at ${t}`;
  }
  // day-of-month at time: "M H DOM * *"
  if (t && isNum(dom) && month === "*" && dow === "*") {
    return `monthly on the ${dom}${ordinal(Number(dom))} at ${t}`;
  }

  return raw; // unrecognized — show the raw cron
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}

// --- Next-run computation (mirrors src/server/schedule.mjs cron semantics) ---
//
// The renderer computes the next fire time client-side because ScheduledJob has
// no nextRun field. These two helpers are a faithful port of `parseField` +
// `cronMatches` from the server so the displayed time matches when the server
// will actually fire. cron is interpreted in LOCAL time (same as the box). Pure
// + never throws.

// Returns the set of allowed values for one cron field, or null for "*"
// (wildcard), or undefined for an unparseable field. Port of schedule.mjs.
function cronFieldSet(field: string, min: number, max: number): Set<number> | null | undefined {
  if (field === "*") return null;
  const allowed = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let body = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return undefined;
    }
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(body);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

// Does `expr` fire at `date` (LOCAL time, minute granularity)? Port of
// schedule.mjs cronMatches, including vixie either-match for DOM+DOW.
function cronMatchesLocal(expr: string, date: Date): boolean {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const min = cronFieldSet(fields[0], 0, 59);
  const hour = cronFieldSet(fields[1], 0, 23);
  const dom = cronFieldSet(fields[2], 1, 31);
  const month = cronFieldSet(fields[3], 1, 12);
  let dow = cronFieldSet(fields[4], 0, 7);
  if (
    min === undefined || hour === undefined || dom === undefined ||
    month === undefined || dow === undefined
  )
    return false;
  if (dow && dow.has(7)) dow = new Set([...dow].map((d) => (d === 7 ? 0 : d)));

  if (min && !min.has(date.getMinutes())) return false;
  if (hour && !hour.has(date.getHours())) return false;
  if (month && !month.has(date.getMonth() + 1)) return false;

  const domRestricted = dom !== null;
  const dowRestricted = dow !== null;
  const dmonth = date.getDate();
  const wday = date.getDay();
  if (domRestricted && dowRestricted) return dom!.has(dmonth) || dow!.has(wday);
  if (domRestricted) return dom!.has(dmonth);
  if (dowRestricted) return dow!.has(wday);
  return true;
}

// Next epoch-ms at which `expr` fires strictly AFTER `from` (default now).
// Searches minute-by-minute up to ~366 days ahead (covers every 5-field cron,
// including "0 0 29 2 *"). Returns null if the expression is invalid or no
// match is found within the horizon. LOCAL time, matching the server poller.
export function nextCronRun(expr: string, from: number = Date.now()): number | null {
  const fields = String(expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  // Validate up front so a bad field doesn't burn the whole search loop.
  if (
    cronFieldSet(fields[0], 0, 59) === undefined ||
    cronFieldSet(fields[1], 0, 23) === undefined ||
    cronFieldSet(fields[2], 1, 31) === undefined ||
    cronFieldSet(fields[3], 1, 12) === undefined ||
    cronFieldSet(fields[4], 0, 7) === undefined
  )
    return null;

  // Start at the next whole minute after `from` (seconds zeroed) — a match at
  // the current minute is "now/just-fired", not "next".
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const HORIZON_MIN = 366 * 24 * 60;
  for (let i = 0; i < HORIZON_MIN; i++) {
    if (cronMatchesLocal(expr, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Compact relative + absolute label for a job's next run, e.g.
// "in 4m", "in 2h", "tomorrow 09:00", "Mon 14:30", "Mar 3". Returns "" when
// there's no upcoming run (invalid cron, or a one-shot already past).
export function describeNextRun(
  expr: string,
  recurring = true,
  from: number = Date.now(),
): string {
  const next = nextCronRun(expr, from);
  if (next == null) return "";
  // A non-recurring job that has no future match (its single time is in the
  // past) returns null above; if it DOES have a future match we still show it.
  void recurring;

  const deltaMs = next - from;
  const mins = Math.round(deltaMs / 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nd = new Date(next);
  const hhmm = `${pad(nd.getHours())}:${pad(nd.getMinutes())}`;

  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 6) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }

  // Same calendar day → just the time.
  const fromD = new Date(from);
  const sameDay =
    nd.getFullYear() === fromD.getFullYear() &&
    nd.getMonth() === fromD.getMonth() &&
    nd.getDate() === fromD.getDate();
  if (sameDay) return `today ${hhmm}`;

  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    nd.getFullYear() === tomorrow.getFullYear() &&
    nd.getMonth() === tomorrow.getMonth() &&
    nd.getDate() === tomorrow.getDate();
  if (isTomorrow) return `tomorrow ${hhmm}`;

  // Within a week → weekday + time. Beyond → month + day.
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  if (deltaMs < 7 * 24 * 60 * 60_000) {
    return `${DOW_NAMES[nd.getDay()]} ${hhmm}`;
  }
  return `${MON_NAMES[nd.getMonth()]} ${nd.getDate()} ${hhmm}`;
}

// ===== Optimistic user-message reconciliation =====
//
// When the user sends a prompt, ChatPanel immediately appends a synthetic
// "optimistic" user message (id `optimistic-user-<timestamp>`) so the UI
// shows the bubble instantly. The real user message arrives a few hundred
// ms later via SSE (`message.updated` → `spliceMessage`). If `spliceMessage`
// does a blind insert (because the real id doesn't match the optimistic id),
// BOTH messages render briefly — the visible "double bubble" flicker.
//
// `reconcileOptimisticUser` is the single source of truth for stripping the
// optimistic placeholder the moment the canonical server message arrives.
// It is called from `spliceMessage`'s insert path: if the incoming message
// is role "user" AND the previous messages contain an `optimistic-user-*`
// entry, that entry is dropped before the real message is appended.
//
// Pure + exported so the contract is unit-tested and can't silently regress.

/**
 * Strip any optimistic user placeholder from `prev` that belongs to the same
 * send as `incoming`. Returns a new array (or `prev` unchanged) so React
 * skips the re-render when nothing changed.
 *
 * Rules:
 *   - Only fires for `incoming.info.role === "user"`. Assistant / system
 *     messages never trigger reconciliation (they have no optimistic twin).
 *   - Drops every message whose id starts with `optimistic-user-`. In
 *     practice there is at most one per send, but we scan all of them
 *     defensively — a prior run that failed to reconcile could have left
 *     a stale one behind.
 *   - Returns `prev` unchanged when there is no optimistic entry to drop,
 *     so the caller's splice can proceed with the canonical array.
 */
export function reconcileOptimisticUser<M extends { info: { id: string; role: string } }>(
  prev: M[] | null | undefined,
  incoming: M,
): M[] | null | undefined {
  if (incoming.info.role !== "user") return prev;
  if (!prev || prev.length === 0) return prev;
  // Scan for any optimistic placeholder. If none found, return the original
  // reference so the caller's splice operates on the canonical array.
  const next = prev.filter((m) => !m.info.id.startsWith("optimistic-user-"));
  if (next.length === prev.length) return prev; // no optimistic entry to drop
  return next;
}

// ===== Live tool output =====
//
// A tool part's *final* output lands in `state.output`, but that field only
// exists once `state.status === "completed"` (see opencode's `ToolStateRunning`
// vs `ToolStateCompleted` schemas — Running has no `output`). While a tool is
// still running, opencode streams incremental stdout into
// `state.metadata.output` instead, growing it via `message.part.updated`
// events. Verified live against a long bash: `metadata.output` ticks up
// `line-1\n` → `line-1\nline-2\n` → … before `status` flips to "completed".
//
// `resolveToolOutput` is the single source of truth every tool body uses so a
// long-running command shows its latest lines as it works (instead of an empty
// "· running" body) and the same ctrl+o expand mechanism applies. It prefers
// the final `state.output` when present (completed / error), and falls back to
// the live `state.metadata.output` while running. Returns "" when neither is a
// non-empty string.
/**
 * Strip leading and trailing blank lines from a tool's output, for RENDERING
 * only.
 *
 * Almost every command ends its output with a newline, and plenty end with
 * several (git push, pytest). A tool body renders one row per line and gives an
 * empty line a non-breaking height, so those invisible trailing lines became
 * real vertical space inside the card — up to three blank rows hanging under
 * the last line of output, which read as a padding bug in the card rather than
 * as content. Trimming here rather than in `resolveToolOutput` keeps the
 * resolver a data accessor: the raw string still carries whatever the process
 * emitted (and the live-stream case still grows byte-for-byte), while the
 * presenter decides not to draw the empty tail.
 *
 * Interior blank lines are preserved — they are part of the output's shape.
 */
export function trimOutputEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

export function resolveToolOutput(state: {
  output?: unknown;
  metadata?: Record<string, unknown> | undefined;
} | null | undefined): string {
  if (!state) return "";
  if (typeof state.output === "string" && state.output.length > 0) {
    return state.output;
  }
  const meta = state.metadata;
  const live = meta && typeof meta.output === "string" ? meta.output : "";
  return live;
}

// ---------------------------------------------------------------------------
// Client liveness watchdog (BET-115 fix A)
//
// A half-open WebSocket is undetectable from `readyState` alone — it stays
// "OPEN" even when the underlying path is dead (tunnel restart, sleep/wake,
// NAT timeout), so the browser never fires onclose/onerror and the shared
// reconnect controller never retries. The server sends an app-level
// `{kind:"heartbeat"}` frame every 15s (src/server/events.mjs); the renderer
// stamps `lastFrameAt` on every frame it receives (heartbeat or real) and a
// watchdog interval calls this pure decision function to decide whether the
// connection is stale enough to force a reconnect even though the socket
// still LOOKS open.
// ---------------------------------------------------------------------------

/**
 * Decide whether the events WebSocket should be force-reconnected.
 *
 * Only fires when the controller believes it's `connected` — a socket that's
 * already `connecting`/`reconnecting`/`closed` is already on the recovery
 * path and doesn't need the watchdog to intervene. `thresholdMs` is the
 * caller's staleness bound (BET-115 spec: 45s = 3 missed 15s heartbeats).
 */
export function shouldForceReconnect(
  state: ConnectionStateName,
  lastFrameAt: number,
  now: number,
  thresholdMs: number,
): boolean {
  if (state !== "connected") return false;
  return now - lastFrameAt > thresholdMs;
}

/**
 * Decide whether a Capacitor `appStateChange` event should trigger an SSE
 * WebSocket reconnect (BET-177 §4.2 — native lifecycle hardening).
 *
 * iOS suspends sockets while the app is backgrounded. On resume (the
 * inactive→active transition) the resume-watchdog needs to force a reconnect
 * + resync so any state missed during the suspend gets recovered. The
 * suspend transition (active→inactive) is a no-op — iOS is about to kill the
 * socket anyway, and a redundant reconnect would just race the suspend.
 *
 * Pure: takes only the boolean iOS sends, returns whether to reconnect.
 * Tested in chatUtils.test.ts. Wired into MobileApp.tsx (the only context
 * with Capacitor present); desktop / PWA / frozen web client never call it
 * because getCapacitorApp(window) returns null there.
 */
export function shouldReconnectOnAppStateChange(isActive: boolean): boolean {
  return isActive === true;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency fan-out (BET-135)
//
// The store's startup fan-outs (`replayChatAttention`,
// `backfillLastMessageTimes`) used `Promise.all` over every chat session /
// directory, firing every opencode request in one unbounded burst. With many
// sessions this hammers opencode and makes the whole app feel sluggish right
// after the session list loads. `runWithConcurrency` caps how many `fn`
// calls are in flight at once while still resolving once every item has
// settled (success or failure) — callers keep the exact same "run for every
// item, don't stop on one failure" semantics, just scheduled more gently.
// ---------------------------------------------------------------------------

/**
 * Run `fn` over every item in `items`, at most `limit` concurrently.
 * Resolves once every item has settled. A rejecting `fn` is swallowed
 * per-item (matching the callers' existing best-effort try/catch bodies)
 * so one failure can't abort the rest of the batch.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        await fn(items[idx]);
      } catch {
        /* per-item failure is non-fatal — isolate and continue the batch */
      }
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Version-skew guard (BET-225 stage 3)
// ---------------------------------------------------------------------------
//
// The renderer's UpdateBar component has two variants:
//   - "ok"       → no banner
//   - "outdated" → non-dismissible "this app is out of date" banner
//
// `chooseUpdateSkewVariant` picks the variant purely from the two version
// strings the renderer already has on hand (the desktop's own version from
// `getClientVersion()` + the server's `minClient` from `getServerVersion()`).
// Pure: no DOM, no Electron, no network. Tested in chatUtils.test.ts.
//
// Treats missing/empty inputs as "no skew signal yet" → "ok", so a renderer
// that's mid-bootstrap (versions not fetched yet) never spuriously flashes
// the blocking banner. Both inputs run through `isClientTooOld`, which itself
// treats malformed versions as "0.0.0" — see src/shared/versionCompare.mjs.
//
// The helper is intentionally a string literal union (not a boolean) so the
// test surface is the exact "two variants" contract the UpdateBar component
// encodes — extending the set later (e.g. a "warn" tier for non-blocking
// deprecation hints) is a deliberate choice, not a happy accident.
export type UpdateSkewVariant = "ok" | "outdated";

export function chooseUpdateSkewVariant(
  clientVersion: string | null | undefined,
  minClient: string | null | undefined,
): UpdateSkewVariant {
  if (!clientVersion || !minClient) return "ok";
  return isClientTooOld(clientVersion, minClient) ? "outdated" : "ok";
}

// ===== "Check for updates": rendering the two verdicts =====
//
// Settings → About checks two INDEPENDENT things behind one button: the desktop
// app (electron-updater, a local concern) and the box server (the update
// poller's manifest compare, a remote concern). Either can be up to date,
// behind, or unanswerable, and the three must stay visually distinct.
//
// The tone matters more than it looks. "up to date" and "couldn't check" are
// opposite facts that a careless UI renders identically as an absence of an
// update button — and a reassuring silence over a failed check is exactly how
// this app shipped a macOS updater that could never install anything for its
// whole life without anyone noticing. So an unanswerable check is NEVER
// rendered as "ok".

export type UpdateRowTone = "ok" | "action" | "muted" | "error";
export type UpdateRow = { tone: UpdateRowTone; text: string };

/**
 * Describe ONE update target for its row.
 *
 * One function for every target. The old code had two bespoke functions
 * (`describeDesktopUpdate` / `describeServerUpdate`) doing the same job for
 * two targets; there are about to be six, so both are replaced by this single
 * one keyed off the shared `UpdateTarget` shape.
 *
 * Rules, in this exact order — the ordering IS the semantics:
 *  - `!t.ok`       → error, "Couldn't check"
 *  - `t.manual`    → muted, "Update manually"
 *  - `t.available` → action, "Update available"
 *  - else          → ok, "Up to date"
 *
 * The invariant that must survive: an unanswerable check is NEVER rendered as
 * "ok". "Up to date" and "couldn't check" otherwise look identical — both are
 * a sentence with no button — and a reassuring silence over a failed check is
 * exactly how a permanently broken macOS updater passed for a healthy one. So
 * `!ok` wins over everything, and `manual` (a dev build with no updater, or a
 * CLI with no safe upgrade command) is "muted", never "ok".
 */
export function describeUpdateTarget(t: UpdateTarget): UpdateRow {
  if (!t.ok) return { tone: "error", text: "Couldn't check" };
  if (t.manual) return { tone: "muted", text: "Update manually" };
  if (t.available) return { tone: "action", text: "Update available" };
  return { tone: "ok", text: "Up to date" };
}

// ===== Box self-update: transient network failure vs real failure =====
//
// When a box self-upgrade SUCCEEDS, `scripts/self-update.sh` restarts
// manta-server (its final step) BEFORE the `/rpc/server:update-apply` promise
// resolves. The renderer's fetch therefore dies mid-flight with a bare
// `TypeError: Failed to fetch` — an unavoidable side-effect of the success
// path, NOT a sign the update failed. Surfacing that as the update-failed
// banner made every successful upgrade look broken.
//
// This predicate distinguishes that benign connection-drop from a GENUINE
// early failure (which the RPC reports as a structured `{ok:false, error}`
// string, e.g. "self-update: manifest fetch failed: ..."). App.tsx uses it in
// `applyServerUpdate`'s catch: a transient network error is swallowed (the
// reconnect + version re-check resolves the real outcome); anything else is a
// real failure and still raises the banner.
//
// Browser fetch throws `TypeError: Failed to fetch` (Chrome) / `Load failed`
// (Safari) / `NetworkError` (older WebKit) on connection loss; a reconnecting
// SSE can also surface wrapped variants. The match is deliberately loose but
// never matches a structured server error string.
export function isTransientUpdateNetworkError(err: unknown): boolean {
  if (err == null) return false;
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  // The box's own structured self-update reports ("self-update: manifest
  // fetch failed: ...", "self-update: bad tarball ...") are GENUINE early
  // failures and must never be classified transient — the banner-relevant
  // resolver's `res.ok === false` branch surfaces them for real.
  if (msg.includes("self-update:")) return false;
  // When a reverse proxy (Cloudflare/Caddy) sits between the app and the box,
  // the SAME benign "box is restarting itself mid-update" drop that a direct
  // socket surfaces as `Failed to fetch` arrives as a gateway 5xx — the proxy
  // answers the in-flight update RPC with origin-unreachable while the box is
  // briefly down. That is the success path's side-effect, not a real failure:
  // the reconnect + version re-check resolve it, so it must not flip the
  // update-failed banner (which would abort the graceful boxUpgrading flow).
  // 502 bad-gateway / 503 / 504 gateway-timeout, plus Cloudflare's
  // origin-down codes (521/522/524). A bare 500 ("Internal Server Error") is
  // NOT in the set — the box is up, so that is a genuine failure.
  if (/http (502|503|504|521|522|524)\b|bad gateway|gateway timeout|origin is unreachable/.test(msg)) return true;
  return (
    msg.includes("failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("load failed") ||
    msg.includes("networkerror") ||
    msg.includes("network error") ||
    msg.includes("cancelled") ||
    msg.includes("aborted")
  );
}

/**
 * Has the box restarted onto a different build than the one it was running
 * when the upgrade was started?
 *
 * This is the ONLY signal that ends the in-flight upgrade state. It is an
 * edge (the version CHANGED), never a level — the previous implementation
 * asked "is the box currently not behind the desktop", which is already true
 * when the user clicks and so cancelled the in-flight state instantly.
 *
 * Any change counts, not just a newer version: a different build means the
 * box restarted, which is what the state is waiting for. Deliberately no
 * version comparison — that would drag in ordering rules for no benefit.
 *
 * A missing value on either side can never satisfy this. That is intentional:
 * "we don't know" must not read as "it worked". Those cases fall through to
 * the caller's timeout.
 */
export function boxUpgradeLanded(
  fromVersion: string | null | undefined,
  currentVersion: string | null | undefined,
): boolean {
  if (!fromVersion || !currentVersion) return false;
  return fromVersion !== currentVersion;
}

// ===== Composer arrow-key: history vs caret navigation =====
//
// The OLD logic scanned for `\n` before/after the caret to decide "first/last
// line". That is blind to SOFT WRAP: a long single line with no `\n` wraps to
// multiple rows, so a caret on visual row 2 wrongly triggered history. The DOM
// measures the caret's VISUAL row (see caretRowInfo in InputArea) and passes it
// here; these pure predicates decide whether the arrow cycles history.
export type CaretRow = {
  atFirstRow: boolean; // caret on the topmost visual row
  atLastRow: boolean;  // caret on the bottommost visual row
};

// True when ArrowUp should navigate prompt history (caret on first visual row).
// False → caller must let the browser move the caret up one row (no preventDefault).
export function arrowUpNavigatesHistory(row: CaretRow): boolean {
  return row.atFirstRow;
}

// True when ArrowDown should navigate prompt history (caret on last visual row).
export function arrowDownNavigatesHistory(row: CaretRow): boolean {
  return row.atLastRow;
}

// ===== Subscription provider connect flow (BET-312) =====
//
// Pure helpers for the ConnectProvider state machine. The component itself
// lives in src/renderer/ConnectProvider.tsx; these helpers are the testable
// bits it composes from. Kept here (rather than inlined in the component) so
// every "what does state X mean?" / "has the poll expired yet?" decision
// pins against a unit test instead of an integration one. The renderer's
// existing test suite is pure-only; adding DOM-testing infra would be out of
// scope for this epic.

// State machine phases the connect card can be in. Mirrors the
// `idle -> starting -> (waiting | needsCode | needsKey) -> applying -> done |
// failed` transition graph from BET-312; BET-354 adds `needsClaudeLogin`
// for the in-app Claude connect flow. The transition graph is now:
//   starting -> (waiting | needsCode | needsKey | needsClaudeLogin) ->
//               applying -> done | failed
//
//   needsClaudeLogin (BET-354):
//     Active during an in-app Claude OAuth. `ptySessionKey` is the
//     server-generated id (consumed by the existing pty bus) the renderer
//     mounts a Terminal pane for. `startedAt` is the server-side timestamp
//     the renderer passes back to the claude-status poll for the
//     credentials-file mtime check. `url` is extracted from the live
//     stream so the user gets a clickable "Open in browser" button
//     without the terminal filling the card. `inputError` re-arms a
//     failed submit. `preExisting` flips to true on a "pre-existing"
//     poll result so the card can show the distinct copy
//     ("Claude is already signed in. Restart didn't help…") instead of
//     hanging in `waiting`.
export type ConnectPhase =
  | { kind: "starting" }
  | { kind: "waiting"; url: string; instructions: string; methodIndex: number }
  | {
      kind: "needsCode";
      url: string;
      instructions: string;
      methodIndex: number;
      inputError?: string;
    }
  | { kind: "needsKey"; consoleUrl: string | null; inputError?: string }
  | {
      kind: "needsClaudeLogin";
      ptySessionKey: string;
      startedAt: number;
      cwd: string;
      url: string;
      inputError?: string;
      preExisting?: boolean;
    }
  | {
      // BET-421 §E: the `claude` CLI is not on the box. The card spawns the
      // official installer over the pty bus (launcher `claude-cli-install`)
      // and polls `opencodeClaudeCliStatus()` until the binary appears. On
      // success it re-fires `{action:"start"}` to enter `needsClaudeLogin`
      // using the SAME server-side sessionKey (startClaudeLogin only stamps
      // metadata + backs up credentials; it does not spawn, so the key is
      // still valid). On failure the user gets Try again / Use a different
      // model / Install manually.
      kind: "installingClaudeCli";
      ptySessionKey: string;
      // The sessionKey the server already minted for the eventual
      // `needsClaudeLogin` — reused after install so we don't double-mint.
      loginSessionKey: string;
      startedAt: number;
      cwd: string;
    }
  | {
      // BET-354: `restarted` is true when the server already called
      // `restartOpencode()` for this transition (the Claude "completed"
      // path). When true, the `applying` effect skips the renderer's
      // own restart call — a second restart would flap opencode-serve
      // and drop every in-flight opencode turn across the box. The
      // Codex / Kimi paths leave `restarted` undefined (treated as
      // false) so they still trigger the renderer's restart — that one
      // is the only restart for those flows.
      kind: "applying";
      restartConfirmed: boolean;
      restarted?: boolean;
    }
  | { kind: "done" }
  | { kind: "failed"; message: string; reason?: "claude-cli-install" };

/**
 * Pull the device code out of an opencode OAuth instructions string, e.g.
 * `"Enter code: TOQR-BUA7Z"` → `"TOQR-BUA7Z"`. Returns null when the string
 * has no recognisable code (no "code" anchor or no code-shaped token after
 * it), in which case the UI shows `instructions` verbatim with no copy
 * button. Empty / non-string input → null.
 *
 * The match is anchored to a `code:` / `code ` cue (case-insensitive) so a
 * sentence like "the user has not entered a code" does not pick up its
 * inline "code" as a token.
 */
export function parseDeviceCode(instructions: string): string | null {
  if (typeof instructions !== "string" || instructions.length === 0) return null;
  const m = instructions.match(/\bcode[:\s]+([A-Z0-9]+-[A-Z0-9]+)/i);
  return m ? m[1] : null;
}

/**
 * BET-421 §D: when parseDeviceCode returns null (the provider reformatted
 * the sentence and the chip would silently vanish), point the user at the
 * verbatim instructions block instead of rendering an empty code slot.
 * Returns the hint string the waiting card renders under the URL; null when
 * a code WAS parsed (caller shows the chip instead).
 */
export function deviceCodeFallback(instructions: string): string | null {
  if (parseDeviceCode(instructions) !== null) return null;
  if (typeof instructions === "string" && instructions.trim().length > 0) {
    return "The code is in the message below — copy it from there.";
  }
  return null;
}

/**
 * BET-421 §D: format the remaining time on a device-code poll as
 * "M:SS remaining". Clamped at 0; NaN-safe. Pure so the countdown display
 * is unit-testable.
 */
export function formatRemaining(
  startedAt: number,
  now: number,
  limitMs: number,
): string {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(limitMs)
  ) {
    return "0:00 remaining";
  }
  const ms = Math.max(0, limitMs - (now - startedAt));
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")} remaining`;
}

/**
 * BET-421 §D: derive an opencode provider `id` from a human-readable name.
 * Lowercase, ASCII alphanumeric + hyphens only, collapsed whitespace →
 * single hyphen, trimmed leading/trailing hyphens. Non-ASCII chars are
 * dropped (opencode ids are ASCII-safe keys persisted in opencode.jsonc).
 * Returns "" for an empty/whitespace-only name so the caller can gate the
 * save button. Pure so the derivation is unit-testable.
 */
export function slugifyProviderId(name: string): string {
  if (typeof name !== "string") return "";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/**
 * BET-421 §D: shared validator for the custom-provider add form used by BOTH
 * the onboarding step (ProvidersStep) and Settings → Accounts (ProvidersCard).
 * The id is DERIVED from the name (slugifyProviderId), so the form never asks
 * for it — this validator gates on name + baseURL, not id. Returns the reason
 * the draft is invalid, or null when it's submittable. Pure so both call sites
 * share one source of truth and the validator is unit-testable.
 */
export function customProviderDraftError(draft: {
  name: string;
  baseURL: string;
}): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (!slugifyProviderId(draft.name)) {
    return "Name must contain a letter or digit.";
  }
  if (!draft.baseURL.trim()) return "Base URL is required.";
  if (!/^https?:\/\//i.test(draft.baseURL.trim())) {
    return "Base URL must start with http:// or https://.";
  }
  return null;
}

/**
 * Single source of user-facing status text for every phase of the connect
 * flow. Centralised so no string is duplicated across branches and so a
 * future i18n pass replaces one place, not five.
 */
export function connectPhaseLabel(state: ConnectPhase): string {
  switch (state.kind) {
    case "starting":
      return "Connecting…";
    case "waiting":
      return "Waiting for sign-in";
    case "needsCode":
      return "Enter the code";
    case "needsKey":
      return "Enter your API key";
    case "needsClaudeLogin":
      return state.preExisting
        ? "Already signed in"
        : "Awaiting Claude sign-in";
    case "installingClaudeCli":
      return "Installing the Claude CLI";
    case "applying":
      return "Applying…";
    case "done":
      return "Connected";
    case "failed":
      return "Failed";
  }
}

/**
 * Pure deadline predicate shared by both the 5-minute device-code poll and
 * the 30-second restart poll. `now >= startedAt + limitMs` means the cap
 * has elapsed. NaN-safe: any non-finite input returns false so a poll that
 * started without a clock (tests, SSR) cannot spuriously expire.
 */
export function isPollExpired(
  startedAt: number,
  now: number,
  limitMs: number,
): boolean {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(limitMs)
  ) {
    return false;
  }
  return now - startedAt >= limitMs;
}

/**
 * Map the `oauth-status` action's error vocabulary to a user-facing message
 * on the connect card. The server owns the expiry deadline now (BET-1043),
 * so "expired" from here is truthful — the device code really did time out.
 */
export function deviceAuthErrorMessage(error?: string): string {
  if (error === "expired") return "The sign-in code expired. Try again.";
  if (error === "not_started") return "Sign-in didn't start. Try again.";
  return "Sign-in failed. Try again.";
}

// ===== Terminal keyboard shortcuts (BET-333) =====
//
// Inside a terminal, plain Ctrl on Windows / Linux is the application's own
// modifier (it must reach the process — SIGINT, readline forward-char, etc.).
// Treating Ctrl as equivalent to Cmd swallows Ctrl+C whenever text is
// selected, so a running process can never be interrupted. The fix is the
// every-other-terminal convention: on macOS the trigger is Cmd alone, on
// every other platform the trigger is Ctrl+Shift. Plain Ctrl falls straight
// through to the PTY.
//
// `terminalShortcut(ev, isMac)` is the pure matcher. Returns which terminal-
// emulator action the keydown maps to (or null = "not ours, let it through").
// The four actions map to the same four bodies xterm.js's custom key handler
// already runs today (selection copy, clipboard paste, in-pane find bar,
// term.clear scrollback).
//
// `isMac` is passed in rather than read from `navigator` so the function is
// testable in isolation and so all platform gating in the renderer reads
// `src/renderer/platform.ts` (the only place `navigator.platform` is touched).
export type TerminalShortcut = "copy" | "paste" | "find" | "clear" | null;

export function terminalShortcut(
  ev: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  isMac: boolean,
): TerminalShortcut {
  const macTrigger = isMac
    ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey
    : ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey;
  if (!macTrigger) return null;
  switch (ev.key.toLowerCase()) {
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "f":
      return "find";
    case "k":
      return "clear";
    default:
      return null;
  }
}

// ===== Auth-error banner (BET-316) =====
//
// Opencode emits `session.error` whenever a turn fails. The legacy path in
// useSseBus falls through to `default:` and surfaces the raw error message
// — fine for Claude, where the upstream message is already actionable, but
// misleading for Codex and Kimi: their messages can land without context, and
// for Claude specifically the message ends with "Run `claude` to refresh
// them." regardless of which provider the user is on.
//
// The banner this helper feeds into fixes both. When the error is recognisably
// a credential/auth failure on one of the three providers in the subscription
// registry, the banner shows `<Label> needs to be reconnected.` with a single
// [Reconnect] button that dispatches `manta-open-subscriptions`. Claude's own
// server-side auto-refresh (`maybeRecoverCredentials`, the 10-min pre-expiry
// poller) still runs in parallel — it is additive, not a replacement.
//
// Deliberately Claude-agnostic at the renderer level: only the active model's
// providerID decides which label to render. We never reach into the message
// text to "guess" the provider — a wrong attribution is worse than falling
// through to the existing raw-message path, which still names the right CLI
// for Claude specifically and surfaces opencode's own message for the others.

// Human label per provider, for the banner text. Single source of truth at
// the renderer layer; mirrors `SUBSCRIPTION_PROVIDERS` in
// src/server/subscriptionProviders.mjs (server) and the demo fixture in
// src/renderer/api/demoApi.ts. Three entries — the entire registry.
export const AUTH_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
  "kimi-for-coding": "Kimi",
};

/**
 * Decide whether to surface a "needs to be reconnected" banner for a
 * `session.error` event. Returns the provider id + label when ALL of:
 *
 *   1. The error is recognisably a credential/auth failure. We accept
 *      `ProviderAuthError` (the legacy typed name opencode emitted pre-BET-280)
 *      AND `ApiError` whose message carries credential-shaped keywords
 *      (`credential`, `authentication`, `unauthorized`, `api[-_ ]?key`,
 *      `auth token`/`auth failed`, `token expired`, `key expired`). The
 *      `ApiError` keyword gate is tight enough that an unrelated API failure
 *      (rate limit, 5xx, network blip) does NOT match — those messages
 *      contain none of the auth tokens above.
 *   2. `providerID` (the session's active model's provider) is a known
 *      registry entry — `anthropic` / `openai` / `kimi-for-coding`. Any
 *      other value, or null/undefined, returns null. The active model is
 *      authoritative: the user just tried to run a turn with that provider,
 *      so any auth failure on this turn belongs to it.
 *   3. A label exists for that provider (always true given condition 2,
 *      but asserted here so the registry and the helper stay in sync).
 *
 * Returns null otherwise — the caller falls back to the existing raw-
 * message path. Non-string / nullish inputs are tolerated (defensive against
 * malformed upstream payloads) and treated as "no match".
 *
 * @param errorName  the typed error name from `properties.error.name`
 *                   (`"ProviderAuthError"`, `"ApiError"`, etc.) — pass
 *                   `undefined` when the event has no name field.
 * @param message    the raw message from `properties.error.data.message`
 *                   (or `error.name` as the ultimate fallback the caller
 *                   already resolved). Pass `undefined` when neither exists.
 * @param providerID the session's active model's `providerID`. The single
 *                   authoritative source for "which provider's banner do we
 *                   show". `null`/`undefined` → no banner.
 */
export function authErrorAdvice(
  errorName: string | null | undefined,
  message: string | null | undefined,
  providerID: string | null | undefined,
): { providerID: string; label: string } | null {
  if (!isAuthErrorName(errorName, message)) return null;
  if (typeof providerID !== "string" || providerID.length === 0) return null;
  const label = AUTH_PROVIDER_LABELS[providerID];
  if (!label) return null;
  return { providerID, label };
}

/**
 * Inner predicate for authErrorAdvice. Exposed for tests so the keyword
 * matching can be asserted independently from the provider-label lookup.
 * Not exported on the renderer's public API — chatUtils re-exports the
 * surface-level `authErrorAdvice` only.
 */
function isAuthErrorName(
  errorName: string | null | undefined,
  message: string | null | undefined,
): boolean {
  const name = typeof errorName === "string" ? errorName : "";
  if (name === "ProviderAuthError") return true;
  // `ApiError` is broad (rate limit, 5xx, network blip all land here too);
  // require credential-shaped keywords in the message so we only catch the
  // auth sub-type. Provider-agnostic — Claude/Codex/Kimi all phrase auth
  // failures with one of these tokens. Standalone "expired" is intentionally
  // excluded (too broad: matches "rate limit window expired", "context
  // expired", etc.) — the combined keywords above always co-occur with the
  // expired-word in the real failure messages.
  if (name !== "ApiError") return false;
  const msg = typeof message === "string" ? message : "";
  return /credential|authentication|unauthorized|api[-_ ]?key|auth(?:entication)?\s+(?:token|failed)|token\s+expired|key\s+expired/i.test(
    msg,
  );
}

// ===== Background delegation job rows (BET-381) =====
//
// Pure helpers for the sidebar / mobile session list second line and the jobs
// management card. The renderer never computes the activity text itself — it
// comes from the job record's `activity` field (server-computed on a 10s
// poll, no model call). These helpers only decide WHETHER a window is a job
// row and format a finished job's summary line.

// A window is a job row when the jobs map has an entry for its opencode
// session id. False for ordinary chat/terminal windows and when the window
// has no opencode session id (a claude-TUI window).
export function isJobRow(
  jobs: Record<string, { name: string; status: string; activity: string | null }>,
  opencodeSessionId: string | null | undefined,
): boolean {
  if (!opencodeSessionId) return false;
  return Object.prototype.hasOwnProperty.call(jobs, opencodeSessionId);
}

// Format a finished job's summary line from its branch + files-changed count.
// Used by the jobs management card for terminal (done/failed/stopped) rows.
// The no-worktree case (job ran in the parent cwd, worktree null) renders
// without a branch. `filesChanged` null/undefined → "0 files".
// A job record's `model` is the canonical "providerID/modelID" ref. This
// splits it on the FIRST "/" only — model ids contain slashes, provider ids
// do not. Returns null for absent/malformed input and for any non-string
// (defends against a legacy object shape persisted on disk, so the job footer
// renders plain rather than crashing).
export function parseModelRef(
  ref: string | null | undefined,
): { providerID: string; modelID: string } | null {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const idx = ref.indexOf("/");
  if (idx < 1 || idx === ref.length - 1) return null;
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) };
}

export function formatJobSummary(job: {
  branch?: string | null;
  filesChanged?: number | null;
  worktree?: string | null;
}): string {
  const files =
    job.filesChanged == null ? 0 : Math.max(0, Math.floor(job.filesChanged));
  const filesLabel = `${files} file${files === 1 ? "" : "s"} changed`;
  if (!job.worktree || !job.branch) return filesLabel;
  return `${job.branch} · ${filesLabel}`;
}

// ===== Background-job completion turn suppression (BET-418 §C) =====
//
// A background job's completion report is delivered to the parent session via
// oc.sendPrompt, so it lands in the parent transcript as a FAKE USER turn
// whose first line is the machine-generated marker
// `[background job "<name>" <status>]` (see buildCompletionText in
// src/server/delegate.mjs). Under the redesign that would render as a
// right-aligned user bubble reading as if the user typed it. The model still
// receives the turn (it is a real user message in opencode's transcript), but
// the user must not SEE it — the assistant's own next turn reports the result
// conversationally. This predicate detects the marker so Transcript can skip
// rendering the row. Pure + tested.
export function isBackgroundJobCompletionTurn(msg: {
  info?: { role?: string; id?: string };
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean; id?: string }>;
}): boolean {
  if (msg?.info?.role !== "user") return false;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const text = parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text ?? "")
    .join("\n")
    .trimStart();
  return text.startsWith("[background job \"");
}

// Which of an ASSISTANT message's parts actually render in the transcript.
// The single source of truth for "does this assistant row draw anything":
// text parts must be non-synthetic, non-ignored and non-empty; the
// `step-start` / `step-finish` markers are never drawn; `todowrite` /
// `todo_write` tool parts are suppressed (the checklist renders once as the
// ActiveTodos card at the tail of the transcript, not inlined per turn).
// Everything else renders. Pure — shared by MessageRow (rendering) and
// isRenderableMessage (list filtering).
export function visibleAssistantParts(msg: OpencodeMessage): OpencodePart[] {
  return msg.parts.filter((p) => {
    if (p.type === "text") return !p.synthetic && !p.ignored && (p.text ?? "").length > 0;
    if (p.type === "step-start" || p.type === "step-finish") return false;
    if (p.type === "tool") {
      const tool = String((p as Record<string, unknown>).tool ?? "");
      if (tool === "todowrite" || tool === "todo_write") return false;
    }
    return true;
  });
}

// Single source of truth for "does this transcript row render anything".
// A row that renders nothing must not be handed to Virtuoso as a data item —
// else it allocates a slot and measures it at zero height, poisoning its
// item-size cache and producing `Zero-sized element` errors, scroll jitter
// and wrong `scrollToIndex` landings (BET-874). Pure + tested.
export function isRenderableMessage(msg: OpencodeMessage): boolean {
  if (isBackgroundJobCompletionTurn(msg)) return false;
  if (msg.info.role === "user") {
    return (
      concatUserMessageText(msg).length > 0 ||
      msg.parts.some((p) => p.type === "file")
    );
  }
  return visibleAssistantParts(msg).length > 0;
}

// ===== Sidebar redesign (BET-414) =====
//
// Pure helpers for the redesigned sidebar: window pin ids, ⌘K fuzzy match,
// and background-job nesting. All pure + tested — the Sidebar component
// composes them; no React/state in here.

// Stable id for a window used as the `pinnedWindows` entry. `<tmuxSession>/
// <windowIndex>`. windowIndex is stable for a tmux window's lifetime; the
// pair uniquely identifies a row. Stale ids (window killed) are pruned at
// render by resolving against the live projects tree.
export function windowPinId(tmuxSession: string, windowIndex: number): string {
  return `${tmuxSession}/${windowIndex}`;
}

export function parsePinId(id: string): {
  tmuxSession: string;
  windowIndex: number;
} | null {
  const slash = id.lastIndexOf("/");
  if (slash <= 0 || slash >= id.length - 1) return null;
  const idx = Number(id.slice(slash + 1));
  if (!Number.isInteger(idx) || idx < 0) return null;
  return { tmuxSession: id.slice(0, slash), windowIndex: idx };
}

// Resolve a pin id to the live (project, window) it refers to, or null when
// the window no longer exists (killed remotely). Used both to render the
// pinned section and to prune stale pins.
export function resolvePin(
  projects: Project[],
  pinId: string,
): { project: Project; window: TmuxWindow } | null {
  const parsed = parsePinId(pinId);
  if (!parsed) return null;
  const proj = projects.find((p) => p.tmuxSession === parsed.tmuxSession);
  if (!proj) return null;
  const win = proj.windows.find((w) => w.index === parsed.windowIndex);
  return win ? { project: proj, window: win } : null;
}

// The project a rail nav key belongs to, or null when it names no project.
// `group:<session>` → `<session>`; `win:<session>:<idx>` and
// `job:<session>:<idx>` → `<session>`. `pin:<id>` and any other key → null
// (the caller resolves pins via `resolvePin`, and a malformed key names
// nothing). The encoding always ends in a trailing `:<index>`, so the session
// is everything after the 4-char kind/colon prefix and before the LAST colon
// — safe even for a session name that itself contains a colon.
export function projectForNavKey(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith("group:")) return key.slice("group:".length);
  if (key.startsWith("win:") || key.startsWith("job:")) {
    const rest = key.slice(4);
    const colon = rest.lastIndexOf(":");
    return colon < 0 ? null : rest.slice(0, colon);
  }
  return null;
}

// ⌘K palette fuzzy match. Subsequence match (case-insensitive) across the
// session (window) name and workspace (project) name. Returns a score > 0
// when the query matches, 0 when it doesn't. Tighter/earlier matches score
// higher so the palette can sort. Empty query matches everything at score 1
// (the palette shows the full flatSessions order in that case).
export function fuzzySessionScore(
  query: string,
  sessionName: string,
  workspaceName: string,
): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const hay = `${sessionName} ${workspaceName}`.toLowerCase();
  // Contiguous substring match beats subsequence.
  if (hay.includes(q)) {
    // Earlier match → higher score.
    return 1000 - hay.indexOf(q);
  }
  // Subsequence match: walk the query chars through the haystack in order.
  let qi = 0;
  let gapBonus = 0;
  let lastIdx = -1;
  for (let hi = 0; hi < hay.length && qi < q.length; hi++) {
    if (hay[hi] === q[qi]) {
      // Reward consecutive matches (small gaps) to rank tighter matches higher.
      gapBonus += lastIdx >= 0 && hi === lastIdx + 1 ? 10 : 0;
      lastIdx = hi;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  return 100 + gapBonus;
}

// Background-job nesting for one project. A job's child window (the window
// whose opencodeSessionId === job.childSessionID) renders as an indented
// CHILD row under its parent window (the window whose opencodeSessionId ===
// job.parentSessionID) whenever both windows exist.
//
// Returns:
//   hidden      — child window indices that must be REMOVED from the
//                 project's top-level window list (they render nested).
//   children    — parent window index → ordered child window indices to
//                 render indented under that parent row.
export type JobNestingResult = {
  hidden: Set<number>;
  children: Map<number, number[]>;
};

export function computeJobNesting(
  project: Project,
  jobs: Record<
    string,
    {
      status: string;
      parentSessionID: string | null;
      childSessionID: string | null;
    }
  >,
): JobNestingResult {
  const hidden = new Set<number>();
  const children = new Map<number, number[]>();

  // Index windows by opencodeSessionId for parent/child resolution.
  const byOpencodeId = new Map<string, TmuxWindow>();
  for (const w of project.windows) {
    if (w.opencodeSessionId) byOpencodeId.set(w.opencodeSessionId, w);
  }

  for (const job of Object.values(jobs)) {
    if (!job.childSessionID) continue;
    const childWin = byOpencodeId.get(job.childSessionID);
    if (!childWin) continue; // job's window isn't in this project
    const parentWin = job.parentSessionID
      ? byOpencodeId.get(job.parentSessionID)
      : undefined;
    if (!parentWin) continue; // child stays top-level; parent window is gone
    hidden.add(childWin.index);
    const arr = children.get(parentWin.index) ?? [];
    arr.push(childWin.index);
    children.set(parentWin.index, arr);
  }

  // Sort children by window index for stable render order.
  for (const arr of children.values()) arr.sort((a, b) => a - b);
  return { hidden, children };
}

// Does the window tree disagree with the jobs slice, so the tree needs a
// re-list?
//
// `computeJobNesting` can only render a job it can find a WINDOW for
// (`byOpencodeId.get(job.childSessionID)`), and drops the job outright when it
// can't. The two inputs refresh on completely different schedules: the jobs
// slice re-fetches on every `delegate.updated` bus event, while the window tree
// is only re-listed by `refresh()` — which the app runs at bootstrap and then
// only after an action it performed itself. A background job creates its tmux
// window on the BOX, after boot and without the app doing anything, so its
// window is absent from the tree and the job renders NOWHERE: not nested, not
// orphaned, not top-level. That is the "delegated jobs never appear in the
// sidebar" bug, and it self-heals only if the user happens to do something
// that re-lists windows.
//
// Rather than re-listing tmux on a timer (polling the box for a change that is
// already announced) or on every `delegate.updated` (activity updates fire
// every ~10s per job, so that is a tmux call per job per tick), this states the
// invariant the renderer actually depends on and lets the caller re-list only
// when it is violated:
//
//   - a RUNNING job whose child window is missing  → the tree is behind a
//     window that was created (job would be invisible)
//   - a window whose session belongs to a TERMINAL job → the tree is behind a
//     window that was removed (a finished job's window would otherwise linger
//     and, once its record is swept, reappear as an ordinary session)
//
// Pure so it can be tested without a tree, a socket, or a live job.
export function shouldResyncWindowsForJobs(
  projects: Project[],
  jobs: Record<string, { status: string; childSessionID: string | null }>,
): boolean {
  const known = new Set<string>();
  for (const p of projects) {
    for (const w of p.windows) {
      if (w.opencodeSessionId) known.add(w.opencodeSessionId);
    }
  }
  for (const job of Object.values(jobs)) {
    if (!job.childSessionID) continue;
    const present = known.has(job.childSessionID);
    if (job.status === "running" && !present) return true;
    if (job.status !== "running" && present) return true;
  }
  return false;
}

// BET-418 §A5: conservative glob-cover check. An `always` pattern covers a
// requested pattern when they are equal, or the always pattern is a prefix-
// star superset (ends with `*` and the requested stem starts with the always
// prefix). Intentionally conservative — when in doubt, return false so the
// card is shown rather than silently auto-approving.
export function globCovers(always: string, pattern: string): boolean {
  if (always === pattern) return true;
  if (always === "*") return true;
  if (always.endsWith("*")) {
    const prefix = always.slice(0, -1);
    const reqStem = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    if (reqStem.startsWith(prefix)) return true;
  }
  return false;
}

// BET-418 §A5: check whether the parent session's existing `always[]` grants
// (from pending/retained PermissionRequest records) already cover every tool
// the delegate approval requests. When fully covered, the renderer auto-
// approves via delegateApprove without rendering the card. Returns false when
// any tool lacks a covering always grant — the card is shown in that case.
export function isApprovalCoveredByAlways(
  approval: { tools: DelegateApprovalTool[] },
  permissions: PermissionRequest[],
): boolean {
  if (approval.tools.length === 0) return false;
  const alwaysByPerm = new Map<string, Set<string>>();
  for (const p of permissions) {
    if (!p.always || p.always.length === 0) continue;
    const set = alwaysByPerm.get(p.permission) ?? new Set<string>();
    for (const a of p.always) set.add(a);
    alwaysByPerm.set(p.permission, set);
  }
  return approval.tools.every((tool) => {
    const set = alwaysByPerm.get(tool.permission);
    if (!set) return false;
    for (const always of set) {
      if (globCovers(always, tool.pattern)) return true;
    }
    return false;
  });
}

// Compact model display name for the composer model pill (BET-460). The
// friendly name opencode returns is often "<brand> <family> <version>"
// (e.g. "Claude Opus 4.7"); the design shows the family + version only
// ("Opus 4.7"), leaving the effort pill (`High`) beside it as the only
// accent element. Stripping a leading known vendor brand token is safe:
// an unknown prefix falls through unchanged, so no name is ever mangled.
const MODEL_BRAND_PREFIXES = new Set([
  "Claude",
  "Gemini",
  "DeepSeek",
  "Grok",
  "Mistral",
  "Llama",
  "Qwen",
  "Command",
  "Gemma",
  "Phi",
  "Gpt",
]);
export function shortModelName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const space = trimmed.indexOf(" ");
  if (space > 0) {
    const first = trimmed.slice(0, space);
    if (MODEL_BRAND_PREFIXES.has(first)) {
      const rest = trimmed.slice(space + 1).trim();
      if (rest) return rest;
    }
  }
  return trimmed;
}

// ===== Fast-mode sibling models (composer ⚡ toggle) =====
//
// Several providers ship a "fast" flavour of a model as a SEPARATE model id
// with a `-fast` suffix rather than as a variant: `gpt-5.6` / `gpt-5.6-fast`,
// `gpt-5.4-mini` / `gpt-5.4-mini-fast`, `databricks-claude-opus-4-7` /
// `…-4-7-fast`. Listing both in the model dropdown doubles its length and
// makes an orthogonal speed/quality choice look like two unrelated models.
//
// So the composer treats fast as a MODE of the base model: the `-fast` id is
// hidden from the dropdown (as long as its base twin is also visible, else it
// would be unreachable) and reached instead through a lightning toggle in the
// model chip. These helpers are the whole rule — the id arithmetic and the
// availability predicate — kept pure so the toggle's disabled/on states are
// testable without a live provider list.

const FAST_SUFFIX = "-fast";

/** True when `modelID` is the fast flavour of some base model. */
export function isFastModelId(modelID: string): boolean {
  return modelID.length > FAST_SUFFIX.length && modelID.endsWith(FAST_SUFFIX);
}

/** `"gpt-5.6-fast"` → `"gpt-5.6"`; a non-fast id is returned unchanged. */
export function baseModelId(modelID: string): string {
  return isFastModelId(modelID) ? modelID.slice(0, -FAST_SUFFIX.length) : modelID;
}

/** `"gpt-5.6"` → `"gpt-5.6-fast"`; a fast id is returned unchanged. */
export function fastModelId(modelID: string): string {
  return isFastModelId(modelID) ? modelID : `${modelID}${FAST_SUFFIX}`;
}

/**
 * Drop `-fast` models from the grouped dropdown list, but ONLY where the base
 * twin survives in the same provider group — a `-fast` model whose base is
 * absent (or deactivated) has no toggle to reach it by, so hiding it would
 * make it unselectable. Groups left empty are dropped so the menu never
 * renders a provider heading with nothing under it.
 */
export function hideFastSiblingGroups(
  groups: Array<[string, OpencodeModel[]]>,
): Array<[string, OpencodeModel[]]> {
  const out: Array<[string, OpencodeModel[]]> = [];
  for (const [providerID, models] of groups) {
    const ids = new Set(models.map((m) => m.id));
    const kept = models.filter((m) => !(isFastModelId(m.id) && ids.has(baseModelId(m.id))));
    if (kept.length > 0) out.push([providerID, kept]);
  }
  return out;
}

// ===== deprecated-model predicate (BET-1139) =====
//
// `isDeprecated` (a model the provider still serves but flags as deprecated)
// is disabled-by-default in the main picker and skipped by subagent
// auto-registration, both reversed by an explicit per-model opt-in
// (`optInModels`). The predicate lives in the shared node-safe module
// `src/shared/modelGuide.mjs` — the ONE place the literal "deprecated" is
// compared — and is re-exported here so renderer consumers call it, never
// re-compare the literal.
export { isDeprecated };

// ===== selectableModelGroups =====
//
// The model set a user may actually switch TO — the answer to "does
// delegation respect the Main toggle?". Enabled, not deprecated, not
// deactivated in Settings (`deactivatedMainModels`), grouped by provider,
// sorted, then `hideFastSiblingGroups`. Shared by ModelPicker's dropdown and
// the delegate model picker so both read one source of truth (the `enabled !==
// false` filter lives here and nowhere else in the renderer).

/**
 * The flat selectable model list (enabled, not deprecated, not deactivated).
 * `null` input → `null` (the loading signal callers rely on). The flat list,
 * not the grouped one, is what `resolveFastToggle` needs — it must still see a
 * `-fast` twin whose base is present, which `hideFastSiblingGroups` would fold
 * out of the groups.
 */
export function selectableModelList(
  models: OpencodeModel[] | null,
  deactivatedMainModels: string[] | undefined,
): OpencodeModel[] | null {
  if (!models) return null;
  const deactivatedMain = new Set(deactivatedMainModels ?? []);
  return models.filter(
    (m) =>
      m.enabled !== false &&
      !isDeprecated(m) &&
      !deactivatedMain.has(`${m.providerID}/${m.id}`),
  );
}

/**
 * The grouped, sorted, fast-sibling-folded selectable list — the candidate
 * model set for dropdowns and pickers. `null` models → `null` (loading).
 */
export function selectableModelGroups(
  models: OpencodeModel[] | null,
  deactivatedMainModels: string[] | undefined,
): Array<[string, OpencodeModel[]]> | null {
  const selectable = selectableModelList(models, deactivatedMainModels);
  if (selectable === null) return null;
  const map = new Map<string, OpencodeModel[]>();
  for (const m of selectable) {
    const arr = map.get(m.providerID) ?? [];
    arr.push(m);
    map.set(m.providerID, arr);
  }
  const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return hideFastSiblingGroups(sorted);
}

export type MainPickerGroups = {
  /** Groups for the main model menu — includes deprecated models so they stay
   *  importable/visible, with the same enabled/deactivated/fast-folding gates
   *  as `selectableModelGroups`. */
  groups: Array<[string, OpencodeModel[]]> | null;
  /** "providerID/modelID" keys of DEPRECATED models shown disabled (not yet
   *  opted in). Deprecated-but-opted-in models are ordinary selectable rows. */
  disabledKeys: string[];
};

/**
 * The main picker's candidate set (BET-1139). Unlike `selectableModelGroups`,
 * a deprecated model is KEPT in the list — the user must be able to see and
 * opt in to a model the provider is deprecating — but it is rendered disabled
 * unless its "providerID/modelID" is in `optInModels` (`disabledKeys`). A
 * deprecated model that HAS been opted in is fully selectable, same as a live
 * model. Non-deprecated models behave exactly as `selectableModelGroups`.
 * Used ONLY by the main composer picker; the delegate picker keeps filtering
 * deprecated models via `selectableModelGroups`. `null` models → `null`
 * groups (loading).
 */
export function mainPickerGroups(
  models: OpencodeModel[] | null,
  deactivatedMainModels: string[] | undefined,
  optInModels: string[] | undefined,
): MainPickerGroups {
  if (!models) return { groups: null, disabledKeys: [] };
  const deactivatedMain = new Set(deactivatedMainModels ?? []);
  const optIn = new Set(optInModels ?? []);
  const disabledKeys: string[] = [];
  const kept = models.filter((m) => {
    const key = `${m.providerID}/${m.id}`;
    if (m.enabled === false) return false;
    if (deactivatedMain.has(key)) return false;
    if (isDeprecated(m) && !optIn.has(key)) {
      disabledKeys.push(key);
    }
    return true;
  });
  const map = new Map<string, OpencodeModel[]>();
  for (const m of kept) {
    const arr = map.get(m.providerID) ?? [];
    arr.push(m);
    map.set(m.providerID, arr);
  }
  const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { groups: hideFastSiblingGroups(sorted), disabledKeys };
}

export type FastToggleState = {
  /** The toggle can be clicked (a counterpart exists that keeps the effort). */
  available: boolean;
  /** The active model IS the fast flavour. */
  on: boolean;
  /** The selection a click produces; null when unavailable. */
  target: { providerID: string; modelID: string; variant?: string } | null;
  /** Tooltip copy explaining the current state. */
  title: string;
};

/**
 * Resolve the ⚡ toggle for the active model.
 *
 * Available only when the counterpart model exists AND still offers the
 * currently-selected effort/variant — flipping to fast must never silently
 * drop the user's effort choice, so a fast twin that lacks it reads as "no
 * fast mode for this effort" and the toggle goes disabled (the user's ask).
 * With no variant selected, only the counterpart's existence matters.
 */
export function resolveFastToggle(
  models: OpencodeModel[] | null,
  active: OpencodeModel | null,
  variantId: string | undefined,
): FastToggleState {
  const off = (title: string): FastToggleState => ({ available: false, on: false, target: null, title });
  if (!active || !models) return off("No fast mode for this model");

  const on = isFastModelId(active.id);
  const counterpartId = on ? baseModelId(active.id) : fastModelId(active.id);
  const counterpart =
    models.find(
      (m) =>
        m.providerID === active.providerID &&
        m.id === counterpartId &&
        m.enabled !== false &&
        !isDeprecated(m),
    ) ?? null;

  if (!counterpart) {
    // Already on a fast model whose base vanished: report the truth (on) but
    // give the user nothing to click, rather than lying that fast is off.
    return on
      ? { available: false, on: true, target: null, title: "Fast mode on (no standard model available)" }
      : off("No fast mode for this model");
  }

  const keepsVariant =
    variantId === undefined || (counterpart.variants ?? []).some((v) => v.id === variantId);
  if (!keepsVariant) {
    return {
      available: false,
      on,
      target: null,
      title: `No fast mode at ${variantId} effort`,
    };
  }

  return {
    available: true,
    on,
    target: {
      providerID: counterpart.providerID,
      modelID: counterpart.id,
      ...(variantId === undefined ? {} : { variant: variantId }),
    },
    title: on ? "Fast mode on — click for the standard model" : "Fast mode off — click for the faster model",
  };
}

// ===== resolvePlanToggle =====
//
// The composer's Plan-mode chip (BET-949). Same three-state shape as the fast
// toggle above and the same "unavailable gets its own glyph" philosophy: a
// lit-but-frozen control is honest; a control that flips itself to "off" lies.
// The `plan` primary agent is native opencode — plan mode REMOVES the edit
// tools from the model's toolbelt, so it raises no permission cards. The chip
// is usable only when the box actually exposes a `plan` agent.
export type PlanToggleState = {
  available: boolean;
  on: boolean;
  loading?: boolean;
  agent?: string;
  title: string;
};

export function resolvePlanToggle(
  agents: OpencodeAgent[] | null,
  on: boolean,
): PlanToggleState {
  if (!agents) return { available: false, on, loading: true, title: "Loading agents…" };
  const plan = ["manta-plan", "plan"]
    .map((name) => agents.find((a) => a.name === name && a.mode !== "subagent"))
    .find((a) => !!a);
  if (!plan)
    return on
      ? { available: false, on: true, title: "Plan mode on (plan agent unavailable)" }
      : { available: false, on: false, title: "This server has no plan agent" };
  return {
    available: true,
    on,
    agent: plan.name,
    title: on
      ? "Plan mode on — edits blocked. Click to build."
      : "Plan mode off — click to plan without editing",
  };
}

// ===== Plan card data (BET-951) =====
//
// The plan_exit question is upgraded into a plan card in the pinned card
// stack. Its title ("the plan's title/first heading") and the FULL plan text
// are derived from the `plan_exit` tool call's carried plan. Detection is
// EXACT, never heuristic: the question's `tool.callID` links back to the
// `plan_exit` tool part in the transcript — match on that, never on the
// question text.

// A tool part may surface its name/callID directly (the live `message.part.*`
// event shape used by useSseBus) or nested under `state.input` (the reconciled
// transcript shape Toolkit parts carry). Read both tolerantly.
function toolPartName(part: OpencodePart): string {
  const direct = part.tool;
  if (typeof direct === "string" && direct) return direct;
  const state = part.state as { input?: { tool?: unknown } } | undefined;
  const nested = state?.input?.tool;
  return typeof nested === "string" ? nested : "";
}

/**
 * Is `question` the plan_exit ask? True iff a transcript tool part named
 * `plan_exit` carries the SAME `callID` as `question.tool.callID`. A callID is
 * required (an orphaned/recovered question without one can never be matched)
 * and the match must be exact — the question text is never consulted.
 */
export function isPlanExitQuestion(
  question: QuestionRequest,
  messages: OpencodeMessage[] | null,
): boolean {
  const qCallID = question.tool?.callID;
  if (!qCallID) return false;
  for (const msg of messages ?? []) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (part.callID !== qCallID) continue;
      if (toolPartName(part) === "plan_exit") return true;
    }
  }
  return false;
}

// ---- Plan-file discovery (tolerant of how the plan was authored) ----
//
// Plan paths live in different part shapes depending on how the plan was
// authored. The classic announcing message mentions the path in PROSE (a text
// part). But the plan-mode flow WRITES the plan with the `write`/`plan` tool —
// which records the path in `state.input.filePath` (and sometimes
// `planPath`/`path`) plus a `patch` part listing the file — so the path never
// reaches a text part, and `plan_exit` sometimes doesn't echo it either.
// Scanning only one surface (e.g. only the plan_exit input) misses plans
// authored via the plan tool. So we scan text, authoring-tool input, and
// patch-file lists for any `.opencode/plans/*.md` reference. Cheap by design:
// we never read tool output or file content, only path fields and prose.

const PLAN_REF_RE = /\.opencode\/plans\/[\w.-]+\.md/g;

// Tools that AUTHOR the plan file (or confirm it at plan_exit). A `read` tool
// pointed at a plan path is a reference, not an authoring signal, and must not
// resolve as the plan — the write/plan tool (or a prose mention) already does.
const PLAN_AUTHORING_TOOLS = new Set([
  "write", "edit", "multiEdit", "patch", "plan", "plan_exit",
]);

/** Every distinct `.opencode/plans/*.md` reference a single part carries. */
export function planRefsFromPart(part: OpencodePart): string[] {
  const out: string[] = [];
  const candidates: string[] = [];
  if (typeof part.text === "string") candidates.push(part.text);
  const raw = part as Record<string, unknown>;
  const isTool = raw.type === "tool";
  if (isTool && PLAN_AUTHORING_TOOLS.has(String(raw.tool ?? ""))) {
    const input =
      (raw.state as { input?: Record<string, unknown> } | undefined)?.input ??
      (raw.input as Record<string, unknown> | undefined);
    if (input) {
      for (const key of ["filePath", "path", "planPath"]) {
        const v = input[key];
        if (typeof v === "string") candidates.push(v);
      }
    }
  }
  if (Array.isArray(raw.files)) candidates.push(...raw.files.map(String));
  for (const c of candidates) {
    for (const m of c.matchAll(PLAN_REF_RE)) {
      if (!out.includes(m[0])) out.push(m[0]);
    }
  }
  return out;
}

/**
 * The plan card's display data: the title (first markdown heading of the plan
 * text, falling back to the question header) and the FULL plan text (what
 * "Build here" resubmits as the next prompt with the build model). Everything
 * is tolerant — when the `plan_exit` part's input carries no plan text the
 * card still renders, just with the question's header as the title.
 */
export function extractPlanData(
  question: QuestionRequest,
  messages: OpencodeMessage[] | null,
): {
  title: string;
  text: string;
} {
  let text = "";
  for (const msg of messages ?? []) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (part.callID !== question.tool?.callID) continue;
      if (toolPartName(part) !== "plan_exit") continue;
      const state = part.state as { input?: Record<string, unknown> } | undefined;
      const input = (state?.input ?? part.input) as
        | Record<string, unknown>
        | undefined;
      const t = input?.plan ?? input?.content ?? input?.text;
      if (typeof t === "string") text = t;
      break;
    }
  }
  const firstHeading = text.match(/^#{1,6}[ \t]+(.+)$/m)?.[1]?.trim();
  const firstLine = text.split("\n").find((l) => l.trim())?.trim();
  const title =
    firstHeading ??
    firstLine ??
    question.questions[0]?.header ??
    "Plan complete";
  return { title, text };
}

// ===== resolveDelegateModel (BET-951) =====
//
// The delegate split control's model precedence — implement EXACTLY this
// order, in a pure helper:
//   1. An explicit pick made on the card (component state) — wins while open.
//   2. The last model EXPLICITLY overridden for a delegation in this project
//      (the `manta:delegate:<projectKey>:model` key). Never promote an
//      inherited default into a remembered one — the memory would just pin
//      whatever happened to be current the first time.
//   3. The session's BUILD-side model.
//
// "Same as current" means the session's one model — there is exactly one model
// per session now, so (3) is simply that model.
// Sending a background job to the planning model is the bug this order exists
// to prevent.
//
// If a remembered model is no longer selectable (deactivated in Settings or
// gone from the catalog), fall through to (3) silently — never render a dead
// label. Carries the full `{providerID, modelID, variant?}` shape.
//
// `overridden` reports whether an explicit override (level 1 or 2) is in
// effect — the split control's right-segment accent.
export type DelegateModelResolution = {
  model: import("./chatShared").ModelSelection | null;
  overridden: boolean;
};

function selectionKey(s: { providerID: string; modelID: string }): string {
  return `${s.providerID}/${s.modelID}`;
}

export function resolveDelegateModel(input: {
  picked: import("./chatShared").ModelSelection | null;
  remembered: import("./chatShared").ModelSelection | null;
  sessionModel: import("./chatShared").ModelSelection | null;
  selectable: Array<[string, OpencodeModel[]]> | null;
}): DelegateModelResolution {
  const { picked, remembered, sessionModel, selectable } = input;
  // While models are still loading we cannot validate, so a remembered or
  // picked selection must not be discarded just because the catalogue isn't
  // in yet — the live session model is a fine stand-in until it re-resolves.
  const selectableKeys =
    selectable === null
      ? null
      : new Set(
          selectable
            .flatMap(([, ms]) => ms)
            .map((m) => `${m.providerID}/${m.id}`),
        );
  const usable = (s: import("./chatShared").ModelSelection | null): boolean =>
    !!s && (selectableKeys === null || selectableKeys.has(selectionKey(s)));
  if (usable(picked) && picked)
    return { model: { ...picked }, overridden: true };
  if (usable(remembered) && remembered)
    return { model: { ...remembered }, overridden: true };
  return { model: sessionModel ? { ...sessionModel } : null, overridden: false };
}

// ===== Transcript entry motion =====
//
// Which transcript rows are allowed to ANIMATE their arrival. The rule the
// user actually wants is narrow: a message that lands while they are watching
// animates; everything else — the transcript they just loaded, the session
// they just switched into, history paged in above — appears instantly.
//
// This is the third attempt at that gate, and the two failures are worth
// recording because both looked correct in review:
//
//   1. The user bubble carried its animation class UNCONDITIONALLY, so every
//      bubble in a loaded transcript popped on mount. Session switch replayed
//      the entire history's sends.
//   2. The assistant row's flag lived for exactly ONE render. React removes
//      the class on the next render, which CANCELS a running CSS animation and
//      snaps the element to its end state. During a live turn the transcript
//      re-renders every few milliseconds, so the animation was destroyed about
//      one frame after it started — it never visibly played at all.
//
// Hence the two invariants this module exists to enforce:
//
//   PRIMED — nothing animates until the transcript has been populated once.
//   The first non-empty render defines "history"; only ids appearing AFTER it
//   are new. An empty transcript (the "Welcome" state) must NOT prime, or a
//   brand-new session's first send would be classified as history.
//
//   STICKY — once an id is marked entering it STAYS marked for as long as it
//   is on screen. A CSS animation is a mount-time, play-once effect (fill mode
//   `both` holds the end state), so keeping the class costs nothing and is the
//   only way to survive the re-render storm of a streaming turn.
//
// Kept pure + mutation-in-place so the caller can hold it in a ref and update
// it during render without scheduling another one.

/** A message reduced to what the entry-motion gate needs. */
export type EntryMotionRow = { id: string; role: string };

export type EntryMotionState = {
  /** Ids already accounted for. `null` until the first non-empty render. */
  seen: Set<string> | null;
  /** Ids cleared to animate. Sticky for as long as the id is present. */
  entering: Set<string>;
  /** Whether the previous update saw a live optimistic placeholder. */
  hadOptimistic: boolean;
};

export function createEntryMotionState(): EntryMotionState {
  return { seen: null, entering: new Set(), hadOptimistic: false };
}

/** The renderer's optimistic placeholder id prefix (see ChatPanel `submit`). */
const OPTIMISTIC_USER_PREFIX = "optimistic-user-";

export function isOptimisticUserId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_USER_PREFIX);
}

/**
 * Register a canonical message id as already-entered because it REPLACED an
 * optimistic placeholder in this same state update.
 *
 * `updateEntryMotion` consults `state.seen` as the "already accounted for"
 * set: an id already there is folded in as history and never marked
 * `entering`. Registering the canonical id here, at the exact moment it swaps
 * in for the placeholder the user just watched animate, makes the swap
 * invisible — the bubble the placeholder already played must not "pop" a
 * second time under the server's real id. This is strictly more reliable than
 * `updateEntryMotion`'s `hadOptimistic` handover heuristic, which can be
 * spent on the wrong row (or never fire) when sends overlap.
 *
 * Call this from the reconcile site immediately before the canonical row is
 * committed to the transcript.
 */
export function markReconciledFromOptimistic(
  state: EntryMotionState,
  canonicalId: string,
): void {
  // `seen` is null only before the transcript has primed; in that window the
  // canonical message would be absorbed as the first-populated history
  // render anyway, so there is nothing to suppress.
  if (state.seen) state.seen.add(canonicalId);
}

/**
 * Fold the current message list into `state`, deciding which ids animate.
 * MUTATES `state` and returns it (it lives in a ref; a new object per render
 * would defeat the point).
 *
 * The optimistic-placeholder handover is the subtle case. A send appends a
 * placeholder immediately, then the server's canonical message REPLACES it
 * under a different id. React sees a different key, so it tears the bubble
 * down and builds a new one — which would replay the send animation a second
 * time, a visible double-pop a few hundred milliseconds apart. When a
 * placeholder retires, the first new user message in that same update is
 * therefore treated as its continuation and does NOT animate: the bubble it
 * replaces already played, and the swap should be invisible.
 *
 * `animate` (default true) is the "is the user actually looking at this panel"
 * gate. A hidden panel must absorb its new messages as history. CSS animations
 * do not run on a `display:none` element, so a turn that lands while the panel
 * is hidden would otherwise slide its whole batch in at the instant the user
 * switches to it — the exact "history animates on session switch" bug. When
 * `animate` is false, new ids are still folded into `seen` (and `hadOptimistic`
 * / the drop-stale sweep still run) but are NOT added to `entering`, so they
 * are permanently history. Everything else about the function is unchanged.
 */
export function updateEntryMotion(
  state: EntryMotionState,
  rows: EntryMotionRow[],
  animate = true,
): EntryMotionState {
  const ids = new Set(rows.map((r) => r.id));
  const hasOptimistic = rows.some((r) => isOptimisticUserId(r.id));

  if (state.seen == null) {
    // Nothing to do until the transcript is populated — an empty render is
    // the "Welcome" state, not a history load.
    if (rows.length === 0) return state;
    // First non-empty render IS the history. Prime, animate nothing.
    state.seen = ids;
    state.hadOptimistic = hasOptimistic;
    return state;
  }

  // A placeholder was live last update and is gone now: the canonical message
  // for that send has landed, and exactly one new user row inherits its
  // already-played animation instead of starting a fresh one.
  let handover = state.hadOptimistic && !hasOptimistic;

  for (const row of rows) {
    if (state.seen.has(row.id)) continue;
    state.seen.add(row.id);
    if (handover && row.role === "user" && !isOptimisticUserId(row.id)) {
      handover = false;
      continue;
    }
    // A hidden panel folds new ids into `seen` above but never marks them
    // entering — CSS animations don't run on display:none, so the whole batch
    // would otherwise slide in the instant the user switches to this session.
    if (!animate) continue;
    state.entering.add(row.id);
  }

  // Drop ids that have left the transcript so the sticky set stays bounded
  // (a cleared/compacted session replaces the whole list).
  for (const id of state.entering) {
    if (!ids.has(id)) state.entering.delete(id);
  }

  state.hadOptimistic = hasOptimistic;
  return state;
}

// =============================================================================
// Artifact preview (BET-661) — pure helpers for the in-app preview overlay.
// Type routing, the size-limit guard, and the footer/metadata formatting all
// live here so the overlay component's per-type body switch is the only
// renderer-specific bit and everything else is unit-testable.
// =============================================================================

/** The preview size cap: > <this> bytes and we do not fetch the body at all.
 *  Exactly this many bytes passes; one more byte refuses (`isWithinPreviewSize`). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export type PreviewType = "image" | "video" | "pdf" | "text" | "refuse";

/** The small text-extension allowlist (the "text renderer" fallback when the
 *  mime gives no text/*-family answer). `.csv` is deliberately ABSENT — it is
 *  out of scope and must refuse (download), per BET-661. */
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".log", ".ts", ".tsx", ".js", ".mjs",
  ".css", ".html", ".yml", ".yaml", ".sh",
]);

/** Lowercased extension (including the dot) of `filename`, "" when none. */
export function previewExtension(filename: string): string {
  const lower = (filename ?? "").toLowerCase();
  const i = lower.lastIndexOf(".");
  return i >= 0 ? lower.slice(i) : "";
}

/** Resolve which renderer an artifact should use, from its mime with a
 *  fallback to its filename extension. Exactly four renderers plus a refusal:
 *
 *    image/*            → image
 *    video/*            → video
 *    application/pdf    → pdf
 *    text/csv           → refuse (out of scope; downloads)
 *    text/*             → text
 *    any other mime     → text when the extension is in the allowlist, else refuse
 *    (null mime)        → text when the extension is in the allowlist, else refuse
 *
 *  The extension fallback therefore applies both when mime is null AND when
 *  mime is a recognized-but-unknown family (e.g. application/octet-stream for
 *  a `.ts` source) — either way a known source extension still previews. */
export function resolvePreviewType(mime: string | null, filename: string): PreviewType {
  if (mime) {
    const m = mime.toLowerCase();
    if (m.startsWith("image/")) return "image";
    if (m.startsWith("video/")) return "video";
    if (m === "application/pdf") return "pdf";
    if (m === "text/csv") return "refuse";
    if (m.startsWith("text/")) return "text";
  }
  if (TEXT_PREVIEW_EXTENSIONS.has(previewExtension(filename))) return "text";
  return "refuse";
}

/** The size guardian — the load-bearing predicate for BET-657's `HEAD` guard.
 *  Exactly `MAX_PREVIEW_BYTES` (25 MiB) passes; one more byte refuses. */
export function isWithinPreviewSize(contentLength: number): boolean {
  return Number.isFinite(contentLength) && contentLength >= 0 && contentLength <= MAX_PREVIEW_BYTES;
}

/** Origin word for the footer, matching the file rows: `you sent this` for a
 *  user upload, `generated` for an agent-produced artifact. */
export function previewOriginWord(origin: "user" | "agent"): string {
  return origin === "user" ? "you sent this" : "generated";
}

/** Line count for the text footer — matches CodeBlock's "trim a single
 *  trailing newline" convention so the reported count is the displayed one. */
export function countPreviewLines(text: string): number {
  if (!text) return 0;
  const cleaned = text.replace(/\n$/, "");
  return cleaned.length === 0 ? 1 : cleaned.split("\n").length;
}

/** Language label for the text renderer's CodeBlock, from the filename. Falls
 *  to "text" (Prism no-op) for anything unmapped. */
const PREVIEW_LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".mjs": "javascript",
  ".json": "json", ".css": "css", ".html": "markup", ".md": "markdown",
  ".yml": "yaml", ".yaml": "yaml", ".sh": "bash", ".txt": "text", ".log": "text",
};

export function previewLanguage(filename: string): string {
  return PREVIEW_LANGUAGE_BY_EXT[previewExtension(filename)] ?? "text";
}

/** The preview footer metadata line, per type:
 *   image → `<width> × <height> · <size> · <origin word>`
 *   pdf   → `<size>`
 *   text  → `<n> lines · <language>`
 * Unknown/absent fields degrade to "0" / "text" rather than crashing the
 * layout. `formatBytes` (shared with the file rows) supplies the size token. */
export function formatPreviewFooter(
  type: PreviewType,
  info: {
    size?: number;
    width?: number;
    height?: number;
    lines?: number;
    language?: string;
    origin?: "user" | "agent";
  },
): string {
  if (type === "image") {
    return `${info.width ?? 0} × ${info.height ?? 0} · ${formatBytes(info.size ?? 0)} · ${previewOriginWord(info.origin ?? "agent")}`;
  }
  if (type === "video") {
    return `${formatBytes(info.size ?? 0)} · ${previewOriginWord(info.origin ?? "agent")}`;
  }
  if (type === "pdf") return formatBytes(info.size ?? 0);
  return `${info.lines ?? 0} lines · ${info.language ?? "text"}`;
}

/** Run one async fetch attempt with a timeout. Mirrors the rpcWithTimeout
 *  pattern (a suffering remote must not hang the caller forever). The timer is
 *  cleared on settle so a fast resolve doesn't leave a stale timeout pending. */
export function withTranscriptFetchTimeout<T>(
  fetchOnce: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fetchOnce(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`transcript fetch timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Initial mount transcript fetch: one attempt under a timeout, and on failure
 *  ONE retry after a short cooldown. Resolves with the fetched transcript or
 *  rejects once both attempts have failed. Pure — the caller provides the fetch
 *  (window.api.opencodeMessages with tail opts) so this is mock-timer testable. */
export async function fetchTranscriptWithRetry<T>(
  fetchOnce: () => Promise<T>,
  opts: { timeoutMs: number; retryDelayMs: number },
): Promise<T> {
  try {
    return await withTranscriptFetchTimeout(fetchOnce, opts.timeoutMs);
  } catch {
    await new Promise((r) => setTimeout(r, opts.retryDelayMs));
    return withTranscriptFetchTimeout(fetchOnce, opts.timeoutMs);
  }
}

// Turn boundary metadata: which assistant messages are the FINAL one of their
// turn (i.e., immediately followed by a user message or end-of-list), the
// cumulative duration of that turn (first assistant `created` → last assistant
// `completed`), the whole turn's token figure (sum of `output + reasoning`
// across every assistant step — one ASSISTANT MESSAGE PER STEP, and each
// message's `tokens` describes only that step, so reading the last one
// under-reports by an order of magnitude), and the seed id (the turn's FIRST
// assistant message) that both the live verb and the footer verb are derived
// from. Intermediate assistant messages within a multi-step turn get no footer
// — only the final one does.
//
// The `running` gate: while a turn is still in progress we do NOT stamp the
// footer on its in-progress last assistant message — it would render behind the
// working indicator at the transcript tail. When `running` flips false the turn
// is complete and its footer computes normally. When the transcript's last
// message is a USER message (just submitted), `lastAssistantId` belongs to the
// previous, already-complete turn, so the gate's comparison is false and that
// turn keeps its footer.
export function computeTurnInfo(
  messages: OpencodeMessage[] | null,
  running: boolean,
): Map<
  string,
  { turnDurationMs: number | null; turnTokens: number | null; verbSeedId: string | null }
> {
  const out = new Map<
    string,
    { turnDurationMs: number | null; turnTokens: number | null; verbSeedId: string | null }
  >();
  if (!messages) return out;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].info.role === "user") {
      // Walk forward over the run of assistant messages that follow.
      let j = i + 1;
      let firstStart: number | null = null;
      let lastEnd: number | null = null;
      let turnTokens = 0;
      let lastAssistantId: string | null = null;
      let verbSeedId: string | null = null;
      while (j < messages.length && messages[j].info.role === "assistant") {
        const t = messages[j].info.time;
        if (firstStart == null && t?.created != null) firstStart = t.created;
        if (t?.completed != null) lastEnd = t.completed;
        // `tokens` is declared on OpencodeMessageInfo (BET-733/L10) — no cast.
        const tok = messages[j].info.tokens;
        if (tok) turnTokens += (tok.output ?? 0) + (tok.reasoning ?? 0);
        if (verbSeedId == null) verbSeedId = messages[j].info.id;
        lastAssistantId = messages[j].info.id;
        j++;
      }
      // Mid-turn: don't stamp the footer on the in-progress turn's last
      // assistant message — it renders behind the working indicator. It
      // appears once running flips false (BET per owner decision).
      if (
        running &&
        lastAssistantId === messages[messages.length - 1]?.info.id
      ) {
        i = j;
        continue;
      }
      if (lastAssistantId) {
        out.set(lastAssistantId, {
          turnDurationMs:
            firstStart != null && lastEnd != null && lastEnd > firstStart
              ? lastEnd - firstStart
              : null,
          turnTokens: turnTokens > 0 ? turnTokens : null,
          verbSeedId,
        });
      }
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export type LiveTurn = { startedAt: number; tokens: number; verbSeedId: string };

/**
 * Metrics for the turn at the tail of the transcript, for the live working
 * row. Deliberately does NOT decide whether a turn is in flight — the caller
 * passes `running` from the event stream and only renders this when true.
 * Returns null only when there is no trailing turn to describe.
 */
export function computeLiveTurn(messages: OpencodeMessage[] | null): LiveTurn | null {
  if (!messages) return null;
  let lastUserIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].info.role === "user") lastUserIndex = i;
  }
  if (lastUserIndex < 0) return null;
  const userInfo = messages[lastUserIndex].info;
  let startedAt: number | null = null;
  let tokens = 0;
  let verbSeedId: string | null = null;
  for (
    let j = lastUserIndex + 1;
    j < messages.length && messages[j].info.role === "assistant";
    j++
  ) {
    if (verbSeedId == null) {
      verbSeedId = messages[j].info.id;
      const c = messages[j].info.time?.created;
      if (typeof c === "number") startedAt = c;
    }
    const tok = messages[j].info.tokens;
    if (tok) tokens += (tok.output ?? 0) + (tok.reasoning ?? 0);
  }
  if (startedAt == null) {
    const c = userInfo.time?.created;
    if (typeof c === "number") startedAt = c;
  }
  if (startedAt == null) return null;
  return { startedAt, tokens, verbSeedId: verbSeedId ?? userInfo.id };
}

// ===== Session progress (BET-790/791) =====
//
// `ProgressRecord`/`ProgressState` are the canonical shapes from
// src/shared/types.ts (BET-790). The renderer treats the record as opaque
// presentation input: the server owns monotonicity (a regressing step is
// clamped there and the renderer never re-derives one), and this module only
// decides how a state is PRESENTED.

/**
 * The sidebar attention kind a progress state lights. Only a model reporting
 * in its own words that it has stopped and needs a human (`blocked`) earns
 * the same attention dot a pending question does; every other state lights
 * nothing (working already has the running dot, done/failed are the turn
 * ending). Reuses the existing attention mechanism rather than a parallel one.
 */
export function progressAttentionKind(state: ProgressState | null | undefined): "blocked" | null {
  return state === "blocked" ? "blocked" : null;
}

/**
 * Build the mono meta run for the working row at the transcript tail (the
 * part after the label). With NO progress record the whole line — verb +
 * elapsed + tokens — is one faint span, byte-identical to before BET-791.
 *
 * When a WORKING record exists the model's label is rendered separately (as
 * the headline span) and this returns only the tail: `· 3/5 · 4m 12s · 18k`.
 * The `step/total` counter is appended ONLY when both are present —
 * indeterminate work shows no counter, never `3/?`, because a bar (or count)
 * that stalls mid-way is worse than none for work of unknown length.
 *
 * Any non-`working` state falls through to the unchanged generic line:
 * `blocked` yields to its card, `done`/`failed` to the turn ending.
 */
export function workingIndicatorLabel({
  progress,
  fallbackVerb,
  elapsed,
  tokens,
}: {
  progress: ProgressRecord | null | undefined;
  /** The present-tense verb WITHOUT an ellipsis (e.g. "Ruminating"). */
  fallbackVerb: string;
  elapsed: string;
  tokens: number;
}): string {
  const tok = tokens > 0 ? ` · ${formatTokens(tokens)}` : "";
  if (!progress || progress.state !== "working") {
    return `${fallbackVerb}… · ${elapsed}${tok}`;
  }
  const count =
    progress.step != null && progress.total != null ? ` ${progress.step}/${progress.total} ·` : "";
  return `·${count} ${elapsed}${tok}`;
}

// Cross-file contract for the ⌘F cross-conversation jump: SearchPalette sets
// this global, ChatPanel consumes it once the target session's transcript has
// rendered. Same pre-mount-bridge pattern as __mantaScrollQuestionSession.
// `query` is the trimmed search term; when present ChatPanel also highlights
// the matched text in the destination row (BET-806). Absent ⇒ flash only, as
// with the artifacts-panel jump.
export type PendingMessageScroll = {
  sessionId: string;
  messageId: string;
  query?: string;
};
export type PendingScrollWin = Window & {
  __mantaPendingMessageScroll?: PendingMessageScroll | null;
};

/**
 * Plan case-insensitive highlight ranges for `query` across a row's text nodes.
 *
 * `lengths` is the character length of each text node, in document order. The
 * function works on the CONCATENATION of those nodes, so a match that straddles
 * a node boundary (e.g. bold in the middle of a sentence) still produces one
 * range. Returns the ranges as node-index + offset pairs, which the DOM caller
 * turns into `Range` objects.
 *
 * Returns [] for an empty query, a query of only whitespace, or no match.
 * Matches do not overlap: scanning continues after the end of each match.
 */
export type HighlightRange = {
  startNode: number;
  startOffset: number;
  endNode: number;
  endOffset: number;
};

export function planHighlightRanges(
  lengths: number[],
  text: string,
  query: string,
): HighlightRange[] {
  const q = query.toLowerCase();
  if (q.length === 0 || q.trim().length === 0 || text.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: HighlightRange[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = lower.indexOf(q, searchFrom);
    if (idx === -1) break;
    const start = idx;
    const end = idx + q.length;
    ranges.push({
      startNode: nodeForOffset(lengths, start),
      startOffset: start - offsetAtNode(lengths, nodeForOffset(lengths, start)),
      endNode: nodeForOffset(lengths, end),
      endOffset: end - offsetAtNode(lengths, nodeForOffset(lengths, end)),
    });
    searchFrom = end;
  }
  return ranges;
}

function offsetAtNode(lengths: number[], node: number): number {
  let sum = 0;
  for (let i = 0; i < node; i++) sum += lengths[i];
  return sum;
}

function nodeForOffset(lengths: number[], offset: number): number {
  let sum = 0;
  for (let i = 0; i < lengths.length; i++) {
    sum += lengths[i];
    if (offset < sum) return i;
  }
  return lengths.length > 0 ? lengths.length - 1 : 0;
}

// ===== Subscription plan usage (BET-738: composer dial + popover) =====
//
// Pure selection + threshold logic for the composer's usage dial. THIS IS
// NOT THE CONTEXT-WINDOW INDICATOR (ctxStageColor above, SessionHeader's
// ContextPill) — per-SUBSCRIPTION plan usage, a different meter with its own
// colour scale, never sharing code/placement with the context pill.

/**
 * Pick the UsageSnapshot that covers the active model's providerID, or null
 * when there's no match (no data yet, that provider isn't connected, or
 * `providerID` itself is absent). Matches on `providerIDs` — never on
 * `provider` (the usage engine's own adapter id, e.g. "claude") or a
 * provider display name; those are different namespaces from opencode's
 * providerID (e.g. "anthropic") by design (see the field's doc comment in
 * shared/types.ts).
 */
export function selectUsageSnapshot(
  snapshots: UsageSnapshot[] | null | undefined,
  providerID: string | null | undefined,
): UsageSnapshot | null {
  if (!snapshots || snapshots.length === 0 || !providerID) return null;
  return snapshots.find((s) => s.providerIDs?.includes(providerID)) ?? null;
}

export type UsageDialTone = "under" | "warn" | "danger" | "over";

export type UsageDialState = {
  visible: boolean;
  pct: number;
  tone: UsageDialTone;
  // The reported window has passed its reset instant and the provider has not
  // published its replacement numbers yet.
  awaitingReset: boolean;
  // The window the dial reports — always `windows[0]`, the snapshot's primary
  // (shortest) window. NOT the highest-pct one: visibility uses the worst
  // window, but the number and colour shown are the primary window's.
  window: UsageWindow | null;
};

export function usageTone(pct: number): UsageDialTone {
  if (pct >= 100) return "over";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "under";
}

/**
 * Derive the composer dial's visibility/colour/headline window from a usage
 * snapshot. Pure — every threshold for the dial lives here, so the trigger
 * component only maps `tone` to a CSS token.
 *
 * Visibility: renders only when the highest window's pct is >= 70, OR
 * `alwaysShow` (the opt-in "Always show plan usage" setting) is on. Below
 * that with the setting off, `visible` is false — callers render nothing;
 * absence is the healthy signal, not a loading/error state.
 */
export function usageDialState(
  snapshot: UsageSnapshot | null | undefined,
  alwaysShow: boolean,
): UsageDialState {
  const windows = snapshot?.windows ?? [];
  if (windows.length === 0) {
    return { visible: false, pct: 0, tone: "under", awaitingReset: false, window: null };
  }
  // The dial reports the PRIMARY window — `windows[0]`, which every adapter
  // emits shortest-first (session before weekly; see the ordering contract on
  // UsageSnapshot.windows in src/shared/types.ts). It used to report the
  // highest-pct window instead, which meant a 0%-used 5h session rendered a
  // 40%-full ring because the WEEKLY window was at 40% — read next to the send
  // button, that says "you have burnt 40% of what you can do right now", which
  // is the opposite of the truth. The weekly number is still one click away in
  // the popover, which lists every window.
  const primary = windows[0];
  // Visibility, unlike the value, is still driven by the WORST window: a
  // weekly at 95% must still surface the dial when the session window is
  // empty, or the number about to block you is invisible unless the opt-in
  // "always show" setting is on.
  const worstPct = windows.reduce((max, w) => (w.pct > max ? w.pct : max), 0);
  // A window past its reset instant is reporting the number the PREVIOUS
  // window finished on. We keep reporting that SAME window (switching to the
  // next one would silently swap which number the dial means), but we report
  // no value for it: pct 0 and the neutral tone render the existing ring as an
  // empty track with no branching in the component. Visibility deliberately
  // still uses the pre-reset worst pct, so the dial holds its place instead of
  // vanishing.
  const awaitingReset = primary.stale === true;
  return {
    visible: worstPct >= 70 || alwaysShow,
    pct: awaitingReset ? 0 : primary.pct,
    tone: awaitingReset ? "under" : usageTone(primary.pct),
    awaitingReset,
    window: primary,
  };
}

// Reset-time formatting for the usage dial, the "keep going" modal and the
// alert toasts. There is exactly ONE relative distance primitive and ONE
// absolute anchor below, composed into a single line by formatWindowReset —
// no per-caller vocabulary (BET-966).
//
// OS locale on purpose (`undefined`), and NEVER an explicit `hour12` — the
// user's locale decides 12- vs 24-hour. That single rule is what stops the dial
// and the alert toasts contradicting each other.
const RESET_TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const RESET_DAY_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", hour: "numeric", minute: "2-digit",
});
const RESET_DATE_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** Same LOCAL calendar day — not "within 24 hours". The one predicate behind
 *  both the absolute format and whether the composed line carries an anchor. */
function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

/** The relative "how far away" distance, floored to at most two units:
 *  "45m" / "2h10m" / "2d4h". Reuses `formatTimerDuration` for the sub-day
 *  ladder so h/m timers read identically everywhere. Pure arithmetic — no
 *  locale involvement. */
export function formatResetDistance(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return "now";
  if (deltaMs < 60_000) return "under a minute";
  if (deltaMs < 86_400_000) return formatTimerDuration(deltaMs);
  const d = Math.floor(deltaMs / 86_400_000);
  const hh = Math.floor((deltaMs % 86_400_000) / 3_600_000);
  return hh === 0 ? `${d}d` : `${d}d${hh}h`;
}

/** The absolute anchor: "09:00" (same local day), "Thu 09:00" (<7 days), or
 *  "Thu, 21 Aug, 09:00" otherwise — locale-dependent via Intl. Returns ""
 *  for missing/non-finite input so callers omit the clause rather than
 *  rendering something broken. */
export function formatResetAt(
  resetsAt: number | null | undefined,
  nowMs: number,
): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return "";
  if (isSameLocalDay(resetsAt, nowMs)) return RESET_TIME_FMT.format(resetsAt);
  if (resetsAt - nowMs < 7 * 86_400_000) return RESET_DAY_TIME_FMT.format(resetsAt);
  return RESET_DATE_TIME_FMT.format(resetsAt);
}

// "resets in 2h10m" / "resets in 45m" / "resets in 5d20h (Thu, 21 Aug, 09:00)"
// — the popover's per-window reset line. The absolute anchor is appended only
// when the reset is NOT on the same local calendar day as `now` (a same-day
// reset is unambiguous from the relative time alone). Returns null only for a
// missing/non-finite timestamp; once the reset instant has passed it returns
// "resetting…".
export function formatWindowReset(
  resetsAt: number | null | undefined,
  nowMs: number,
): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  const deltaMs = resetsAt - nowMs;
  // The reset instant has passed but the provider has not published the new
  // window yet (server marks the window `stale`). The dial carries the old
  // number forward, so say why it looks wrong instead of showing no line.
  if (deltaMs <= 0) return "resetting…";
  const line = `resets in ${formatResetDistance(deltaMs)}`;
  return isSameLocalDay(resetsAt, nowMs) ? line : `${line} (${formatResetAt(resetsAt, nowMs)})`;
}

// "updated 3m ago" / "updated just now" — the popover footer's freshness
// line. Reuses formatAge's unit ladder (now/Nm/Nh/Nd) for the same relative-
// time vocabulary as the sidebar, above.
export function formatUpdatedAgo(fetchedAt: number, nowMs: number): string {
  const age = formatAge(Math.max(0, nowMs - fetchedAt));
  return age === "now" ? "updated just now" : `updated ${age} ago`;
}

// True once a snapshot is more than 25 minutes stale — the popover footer's
// "updated Nm ago" line turns --warn at this point. The box's poller runs
// every 10 minutes, so 25 minutes means at least two missed ticks; it also
// sits below the box's 30-minute carry-forward cap, so a reading the box is
// holding on to visibly ages into a warning before it is dropped.
export function usageStale(fetchedAt: number, nowMs: number): boolean {
  return nowMs - fetchedAt > 25 * 60_000;
}

// M6/BET-730: given the set of "visited" chat session ids (panels kept
// mounted) and the set of session ids that still exist in some project
// window, return the ids that should be unmounted. A visited session that no
// longer exists anywhere is a zombie — its panel leaks its transcript, SSE
// filters, intervals and a store.chatMessages copy. The active session is
// never pruned even if it momentarily isn't in a project window.
export function pruneVisitedSessions(
  visited: Set<string>,
  liveSessionIds: Set<string>,
  activeId: string | null,
): string[] {
  const toRemove: string[] = [];
  for (const sid of visited) {
    if (!liveSessionIds.has(sid) && sid !== activeId) toRemove.push(sid);
  }
  return toRemove;
}

// ===== Session header status-item registry (BET-782) =====
//
// The right group of the session header is a REGISTRY of status items, each
// carrying a stable id, a priority and a render function. Higher priority =
// further LEFT in the right group = kept longer as the pane narrows. A pure
// selection function decides, for a given container width + the user's hide
// list, which items render in the bar vs the overflow dropdown. Purely
// presentational — no DOM, no React state.
export type StatusItem = {
  /** Stable id — the key for the user-hide setting (AppConfig.hiddenStatusItems). */
  id: string;
  /** Higher = further LEFT in the right group = kept longer. */
  priority: number;
  /** The chip itself. */
  render: () => ReactNode;
};

// The two container breakpoints the spec mandates (BET-782 §3). The width
// passed in here is the header element's own measured width, taken by a
// ResizeObserver in SessionHeader.tsx — NOT the viewport, which measures
// the wrong thing when the sidebar / artifacts panel resize the pane.
const STATUS_CUT_560 = 560;
const STATUS_CUT_420 = 420;
// The overflow cut refuses to auto-hide anything at ≥ 80 (artifacts / menu are
// always present at every width). Priority is the ONLY "pinned" mechanism —
// there is deliberately no separate flag.
const STATUS_NEVER_AUTO_HIDE = 80;
// The 560px seam hides priority < 60 (the band future forge items occupy);
// the 420px cut additionally hides `context` (priority 60).
const STATUS_CUT_HIDE_BELOW_560 = 60;

// Whether the overflow cut sends `it` to overflow at the given container
// width. Never hides priority ≥ 80 (artifacts / menu) via this cut — the user
// hide list is the only thing that can remove those.
function overflowFor(it: StatusItem, containerWidth: number): boolean {
  if (it.priority >= STATUS_NEVER_AUTO_HIDE) return false;
  if (containerWidth < STATUS_CUT_420) return it.priority <= STATUS_CUT_HIDE_BELOW_560;
  if (containerWidth < STATUS_CUT_560) return it.priority < STATUS_CUT_HIDE_BELOW_560;
  return false;
}

// Select which registry items render in the header bar vs the overflow
// dropdown for a container width + the user's hide list. Hidden ids are never
// present in either array (removed entirely).
//
// ORDERING NOTE (BET-782): acceptance criterion #1 requires the wide-width
// header to render EXACTLY as it does today, and the spec's §2 "sort
// descending by priority; render left-to-right" would put the ⋯ menu (100)
// left of the context pill (60) — a visual change, and a direct conflict
// between the two requirements. Criterion #1 is the DoD, so this preserves the
// registry's construction order (today: context, artifacts, menu) rather than
// re-sorting by priority. Priority is therefore ONLY the overflow-sacrifice
// order (which items the cut drops as the pane narrows), not a reordering of
// the bar. Equal-priority ties are still broken deterministically by stable id
// sort (the spec's Tests section requires it); Array.prototype.sort is stable,
// so leaving differing-priority pairs in construction order while id-sorting
// only the tied runs is safe. If the descending-order rule is ever made
// authoritative instead, swap the tie comparator below for a full priority
// sort.
export function selectStatusItems(
  items: StatusItem[],
  containerWidth: number,
  hiddenIds: string[],
): { visible: StatusItem[]; overflow: StatusItem[] } {
  const hidden = new Set(hiddenIds);
  const ordered = [...items].sort((a, b) => {
    if (a.priority === b.priority) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return 0; // different priorities keep their construction (today's) order
  });
  const visible: StatusItem[] = [];
  const overflow: StatusItem[] = [];
  for (const it of ordered) {
    if (hidden.has(it.id)) continue;
    (overflowFor(it, containerWidth) ? overflow : visible).push(it);
  }
  return { visible, overflow };
}

// ===== Session-header forge delta (BET-789) =====
// Pure helpers for the forge chips in the session header: the checks chip's
// per-state descriptor, the PR-suffixed branch label, and the connect-offer
// decision. All computed from props alone — no DOM, no channels, no network.

/** One check's traffic-light state — THE single classifier. A check with no
 * conclusion yet (queued / in progress / pending) is "running". Everything that
 * finished on something other than success is "error".
 *
 * `countsForChecks`, `failuresToAgentPrompt` and the checks popover all read
 * this, so the three can never drift on what "failed" means (they were three
 * hand-written copies before). The return values are deliberately StatusDot's
 * tone names, so the popover row needs no mapping table. */
export function checkTone(c: ForgeCheckRun): "ok" | "running" | "error" {
  const done = c.conclusion;
  if (!done || c.status === "queued" || c.status === "in_progress") return "running";
  return done === "success" ? "ok" : "error";
}

/** Every check in display order: failed, then running, then passed. The popover
 * lists ALL of them — the dot carries the state and this order carries the
 * grouping, so there are no headings and no per-row status label. `sort` is
 * stable, so within a bucket the forge's own order survives. */
export function orderChecks(checks: ForgeCheckRun[]): ForgeCheckRun[] {
  const rank = { error: 0, running: 1, ok: 2 } as const;
  return [...checks].sort((a, b) => rank[checkTone(a)] - rank[checkTone(b)]);
}

/** Count a check list into the three traffic-light buckets. A check with no
 * conclusion yet (still queued / in progress / pending) is "running". */
export function countsForChecks(checks: ForgeCheckRun[]): {
  passed: number;
  failed: number;
  running: number;
} {
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const c of checks) {
    const tone = checkTone(c);
    if (tone === "running") running++;
    else if (tone === "ok") passed++;
    else failed++;
  }
  return { passed, failed, running };
}

export type ChecksChipTone = "ok" | "warn" | "danger";

/** The checks chip's label + tone + registry priority for a given rollup.
 * `none` yields null — no chip at all. The caller additionally gates on "no
 * PR" and "forge not connected" before calling, so absence of a chip is the
 * "there is nothing to say" state (§4.3 [C2]). Priority is a function of
 * state (§4.3): red outranks the menu+artifacts pin (survives the narrow
 * layout), green/yellow sit low so they are the first thing to overflow. */
export function checksChipDescriptor(
  rollup: CheckRollup,
  counts: { passed: number; failed: number; running: number },
): { label: string; tone: ChecksChipTone; priority: number } | null {
  switch (rollup) {
    case "green":
      return { label: `✓ ${counts.passed}`, tone: "ok", priority: 40 };
    case "red":
      return { label: `✗ ${counts.failed} failed`, tone: "danger", priority: 90 };
    case "yellow":
      return { label: `◐ ${counts.running} running`, tone: "warn", priority: 40 };
    case "none":
    default:
      return null;
  }
}

/** Branch chip label: plain `⎇ branch`, or `⎇ branch · #412` when a PR
 * rides the chip. Null when there is no branch (chip not rendered at all).
 * The `⎇` stands in for the GitBranch icon the chip actually renders — the
 * label is the string form for tests/titles. */
export function branchChipLabel(
  branch: string | null,
  pr: { number: number } | null,
): string | null {
  if (!branch) return null;
  return pr ? `⎇ ${branch} · #${pr.number}` : `⎇ ${branch}`;
}

/** Whether to surface the one-line "Connect GitHub" offer under the header
 * (§4.5 [S10]). Only when the forge is NOT connected AND the session origin
 * is a recognised forge AND the offer has not been permanently dismissed. */
export function shouldOfferForgeConnect({
  connected,
  forgeKind,
  dismissed,
}: {
  connected: boolean;
  forgeKind: string | null;
  dismissed: boolean;
}): boolean {
  if (connected) return false;
  if (dismissed) return false;
  return forgeKind != null;
}

/** The "send failures to the agent" composer fill — names each failing check
 * (plus its log URL) so the agent can act without the user transcribing. This
 * FILLS the composer; it does not submit. */
export function failuresToAgentPrompt(checks: ForgeCheckRun[]): string {
  const failed = checks.filter((c) => checkTone(c) === "error");
  if (failed.length === 0) return "";
  const lines = failed.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`);
  return `Checks are failing on this pull request:\n${lines.join("\n")}\n\nPlease investigate and fix them.`;
}

// ===== Pinned card stack arbiter (BET-783) =====
//
// Ten cards mount above the composer (permission ×N, retry, compaction,
// delegate-approval, schedules|secrets|webhooks, queued, send-error) and used
// to stack in hardcoded JSX order, so the transcript was the only flexible
// child and a permission request (the single most urgent thing in the app)
// could end up below several ambient cards. `arrangeCards` is the composer-
// stack counterpart to `pickBanner` (bannerPriority.ts): where pickBanner
// collapses boolean state to ONE top-of-window bar, this takes a LIST of
// independent cards and splits it into two tiers with count + rollup.
//
// Tier rules:
//   blocking — permission, question, delegate-approval. Always above ambient,
//              never chronologically interleaved; at most ONE expanded, the
//              newest; the rest collapse into an "N more requests" row.
//   ambient  — retry, compaction, send-error, queued, resource cards. Fixed
//              priority order (not arrival order); at most MAX_AMBIENT_EXPANDED
//              expanded; the rest collapse into a rollup row.
//
// Deliberately NOT folded into pickBanner: pickBanner takes a flat boolean
// BannerState and returns a single winner; arrangeCards takes an ordered LIST
// of mutable cards and returns expanded + counted-rollup subsets. Different
// shape, different callers — merging them would force both to give up what
// makes them simple.

export type CardTier = "blocking" | "ambient" | "management";

export interface PinnedCard {
  /** Stable key for the mount slot (e.g. "permission-<id>", "retry"). */
  id: string;
  tier: CardTier;
  /**
   * Within-tier ordering. Blocking: higher = newer (newest renders first).
   * Ambient: higher = more prominent (fixed priority, independent of the
   * input order of the cards array).
   */
  order: number;
  /** Optional ambient-rollup label (e.g. "schedule"). Ignored for blocking. */
  label?: string;
}

export interface PinnedCardStack<T extends PinnedCard = PinnedCard> {
  /** The single blocking card to render expanded (newest), or null. */
  blocking: T | null;
  /** Number of additional pending blocking cards ("N more requests"). */
  blockingMore: number;
  /** Ambient cards rendered expanded, priority order, at most MAX_AMBIENT_EXPANDED. */
  ambient: T[];
  /** Remaining ambient cards collapsed into a rollup row, priority order. */
  ambientRollup: T[];
  /** User-toggled management cards (schedules/secrets/webhooks) — rendered full-height, un-capped. */
  management: T[];
}

/** Max ambient cards rendered expanded; the rest collapse into the rollup row. */
export const MAX_AMBIENT_EXPANDED = 2;

export function arrangeCards<T extends PinnedCard>(cards: T[]): PinnedCardStack<T> {
  const blocking = cards
    .filter((c) => c.tier === "blocking")
    .sort((a, b) => b.order - a.order);
  const ambient = cards
    .filter((c) => c.tier === "ambient")
    .sort((a, b) => b.order - a.order);
  const management = cards
    .filter((c) => c.tier === "management")
    .sort((a, b) => b.order - a.order);
  return {
    blocking: blocking[0] ?? null,
    blockingMore: Math.max(0, blocking.length - 1),
    ambient: ambient.slice(0, MAX_AMBIENT_EXPANDED),
    ambientRollup: ambient.slice(MAX_AMBIENT_EXPANDED),
    management,
  };
}

// ===== BET-787: repo-probe zero state =====

// A probe result row augmented with `local` — true when the repo already
// exists on disk and can therefore be pre-checked without a clone. Clone rows,
// added by a later forge issue, land here with `local: false` and must never be
// pre-checked. The pre-check rule is a property of the row's data, not a
// "default all true", so the clone rows arrive unchecked without a rewrite.
export type RepoRow = RepoHit & { local: boolean };

// The zero-state mode for the new-project screen, derived from the probe
// lifecycle. The one rule to get exactly right: "probe succeeded but returned
// zero repos" is `"fresh"`, never `"degraded"` — a successful scan with nothing
// found is real information (an empty box invites a clone), a failed scan is a
// different, worse-off state that degrades to the folder picker.
export function zeroStateMode(input: {
  probePending: boolean;
  probeFailed: boolean;
  repos: RepoHit[];
}): "scanning" | "list" | "fresh" | "degraded" {
  if (input.probePending) return "scanning";
  if (input.probeFailed) return "degraded";
  return input.repos.length > 0 ? "list" : "fresh";
}

// Substitute a leading home-dir prefix with `~` for display, matching the
// manta-forge zero-state mockup (`~/scratch`). Given no homeDir (unavailable),
// the absolute path is shown unchanged. Pure.
export function homeRelativePath(path: string, homeDir?: string | null): string {
  if (!homeDir || !path) return path;
  if (path === homeDir) return "~";
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

// The secondary line under a repo row. With an origin, the branch alone
// identifies the row; without one the bare basename does not, so the path and
// "no remote" are added so the user can tell the row apart. `homeDir` (the
// box's $HOME, from the forge probe) lets a repo under the home dir render
// as `~/scratch` instead of the absolute path, per the manta-forge mockup.
export function describeRepoRow(repo: RepoHit, homeDir?: string | null): string {
  const branch = repo.branch ? `⎇ ${repo.branch}` : "no branch";
  if (!repo.originUrl) {
    const path = homeRelativePath(repo.path, homeDir);
    return `${branch} · ${path} · no remote`;
  }
  return branch;
}

// ===== Forge clone flow (BET-796) =====

// The distinguished cause of a failed clone ([E3]). Only `permission` is
// actionable by the user (token scope, or an org that hasn't approved the
// token), so it must be named specifically; `disk` and `network` are
// distinguished so the failure text can say which one occurred rather than a
// generic "clone failed".
export type CloneErrorKind = "permission" | "disk" | "network" | "destination" | "unknown";

/**
 * Classify a `git clone` failure's stderr into an actionable kind. Order
 * matters: the destination regex runs first (a destination path problem must
 * never be attributed to the GitHub token), then permission (GitHub's "could
 * not read Username" / "Repository not found" for a private repo reads like a
 * generic error but is really an auth (scope) problem). Pure.
 */
export function cloneErrorKind(stderr: string): CloneErrorKind {
  const s = String(stderr ?? "").toLowerCase();
  if (
    /could not create leading directories|destination path .* already exists|not an empty directory/.test(s)
  ) {
    return "destination";
  }
  if (
    /permission to .* denied|permission denied|could not read (username|password)|authentication failed|not authorized|repository not found|\b403\b|check that you have the correct access rights/.test(s)
  ) {
    return "permission";
  }
  if (/no space left on device|disk (is )?full|insufficient|write error: no space|enosPC/.test(s)) {
    return "disk";
  }
  if (
    /could not resolve host|connection (timed out|refused|reset)|network is unreachable|failed to connect|unable to access|temporary failure in name resolution|ssl|tls/.test(s)
  ) {
    return "network";
  }
  return "unknown";
}

// The box returns machine codes (`not_connected`, `rejected`, `rate_limited`,
// `forbidden`, `network`) or a raw exception string for a failed repo listing;
// neither is something to show a person. One mapping, so the picker never
// renders a server code verbatim.
export function repoListErrorMessage(code: string | null | undefined): string {
  if (code === "not_connected" || code === "rejected") {
    return "GitHub isn't connected. Go back and sign in again.";
  }
  if (code === "rate_limited") {
    return "GitHub's rate limit is used up. Try again in a few minutes.";
  }
  if (code === "forbidden") {
    return "GitHub refused this request. If the repositories belong to an organisation, it may require SSO authorisation for your sign-in.";
  }
  if (code === "network") {
    return "Couldn't reach GitHub from your server. Check its connection and try again.";
  }
  return "Couldn't list your repositories from GitHub.";
}

/** The secondary line on the Settings GitHub row: who is connected, where the
 *  credential came from, and — when GitHub has rejected it — what to do. Pure. */
export function forgeCredentialSecondary(status: {
  login: string | null;
  source: "cli" | "env" | "stored" | null;
  valid: boolean | null;
}): string {
  if (status.valid === false) {
    if (status.source === "cli") {
      return "GitHub rejected the gh CLI sign-in on your server. Run `gh auth login` there, or Disconnect.";
    }
    if (status.source === "env") {
      return "GitHub rejected the MANTA_GITHUB_TOKEN environment variable on your server. Replace it there, or Disconnect.";
    }
    return "GitHub rejected this sign-in. Disconnect, then connect again.";
  }
  const where =
    status.source === "cli" ? "from the gh CLI on your server"
    : status.source === "env" ? "from the MANTA_GITHUB_TOKEN env var"
    : status.source === "stored" ? "signed in on this server"
    : "connected";
  return status.login ? `@${status.login} · ${where}` : where;
}

// ===== Forge merge gate (BET-794) =====

/**
 * Whether the merge affordance is enabled for a pull request, plus a
 * user-visible reason when it is not. Merge is enabled ONLY when ALL hold:
 * the checks rollup is `green`, there are no unresolved review threads, and
 * the forge reports `mergeable === true`. Every blocking combination yields a
 * distinct reason so the UI can explain "why can't I merge" instead of a bare
 * disabled button.
 *
 * `mergeable: null` means the forge is still computing mergeability — NOT
 * mergeable, reason "still computing" (the caller may retry).
 *
 * @param {{ rollup: CheckRollup, unresolvedThreads: number, mergeable: true | false | null }} input
 * @returns {{ can: boolean, reason: string | null }}
 */
export function canMerge({
  rollup,
  unresolvedThreads,
  mergeable,
}: {
  rollup: CheckRollup;
  unresolvedThreads: number;
  mergeable: true | false | null;
}): { can: boolean; reason: string | null } {
  if (mergeable === null) return { can: false, reason: "still computing" };
  if (mergeable !== true) return { can: false, reason: "not mergeable" };
  if (rollup !== "green") {
    const reason = rollup === "yellow" ? "checks still running" : rollup === "red" ? "checks failing" : "no checks";
    return { can: false, reason };
  }
  if (unresolvedThreads > 0) {
    return { can: false, reason: `${unresolvedThreads} unresolved thread${unresolvedThreads === 1 ? "" : "s"}` };
  }
  return { can: true, reason: null };
}

/**
 * The user-facing message for a merge failure, keyed by its distinguished kind
 * (status code, not a generic error): `sha_mismatch` (409), `cannot_merge`
 * (405), `permission` (403). Each has a different next action, so each must be
 * surfaced distinctly rather than as a bare "Merge failed".
 */
export function describeMergeFailure(kind: string | null | undefined): string {
  switch (kind) {
    case "sha_mismatch":
      return "Merge failed — the head SHA moved. This PR changed after you reviewed it; re-review before merging.";
    case "cannot_merge":
      return "Cannot merge — the PR is blocked (branch protection, draft, or a conflict).";
    case "permission":
      return "No permission to merge this pull request.";
    default:
      return kind ? `Merge failed (${kind}).` : "Merge failed.";
  }
}

/**
 * The single decision for how the session-header branch chip renders and
 * whether it opens a popover (the ONE git surface, BET-867). `"none"` means the
 * plain, non-interactive `Tag` — either there is no branch, or the forge is not
 * connected for this cwd (a scratch dir with no forge must stay byte-identical
 * to a non-forge session). `"no-pr"` opens the popover in its Draft PR / Create
 * PR state; `"pr"` opens it in the merge surface state.
 */
export function branchPanelState({
  pr,
  forgeConnected,
  branch,
}: {
  pr: PullRequest | null;
  forgeConnected: boolean;
  branch: string | null;
}): "none" | "no-pr" | "pr" {
  if (!branch || !forgeConnected) return "none";
  return pr ? "pr" : "no-pr";
}

/**
 * The ship gate for the forge surface (BET-892): whether a "Create pull
 * request" action even makes sense for the current branch, evaluated in this
 * order — first match wins.
 *
 *  1. `has-pr`    — a PR is already open on this branch.
 *  2. `detached`  — no branch (detached HEAD / non-git cwd).
 *  3. `unknown`   — base branch unknown (cannot tell if on the default branch).
 *  4. `on-base`   — sitting on the repo default branch (no PR to open).
 *  5. `no-commits`— no commits ahead of origin/<base> (nothing to ship).
 *  6. `ready`     — ship away.
 *
 * One deliberate asymmetry — do not "fix" it:
 * - `base === null` → `"unknown"`. The base is a *safety* fact: without it we
 *   cannot tell whether the current branch is the default branch, and a PR
 *   from a branch onto itself cannot exist. No base means no PR action.
 * - `aheadCount === null` still falls through to `"ready"`. The commit count is
 *   an *optimisation*, not a safety fact. It is legitimately unknown whenever
 *   `origin/<base>` is not fetched locally (shallow clone, fresh worktree), and
 *   hiding the action there would break a normal case for no safety gain — an
 *   empty PR is refused by the forge with a clear message.
 */
export type ShipState = "on-base" | "detached" | "unknown" | "no-commits" | "ready" | "has-pr";

export function resolveShipState(input: {
  branch: string | null;
  base: string | null;
  aheadCount: number | null;
  hasPr: boolean;
}): ShipState {
  if (input.hasPr) return "has-pr";
  if (!input.branch) return "detached";
  if (!input.base) return "unknown";
  if (input.branch === input.base) return "on-base";
  if (input.aheadCount === 0) return "no-commits";
  return "ready";
}

// ---- Forge review pane (BET-792) -------------------------------------------

// The line anchor a comment may attach to, in the forge-neutral shape the spec
// (§3.4③) normalises on: `path` names the FILE, `side` is "new" (added lines —
// GitHub's RIGHT), "old" (removed lines — GitHub's LEFT) or "both" (unchanged
// context lines, present in both versions — GitLab positions them with both
// `new_line` and `old_line`, BET-856), and `line` is the corresponding line
// number. `path` is load-bearing — a PR diff is a single merged stream of many
// files, so an anchor that drops it misplaces a thread whenever two files share
// a line number. The renderer maps these onto the rows UnifiedDiff draws, keyed
// per-file.
export type CommentableLine = { path: string; line: number; side: "new" | "old" | "both" };

// Derive the set of commentable line anchors from a unified-diff text, walking
// the `@@ -A,B +C,D @@` hunk headers so numbers are exact per hunk. Added lines
// anchor on the NEW side (new line number); removed lines on the OLD side (old
// line number); unchanged context lines on BOTH (present in both versions, so
// GitLab positions them with both `new_line` and `old_line` — BET-856). The
// active file path is tracked from the `+++ b/` marker (falling back to `--- a/`
// when a file is deleted to `/dev/null`), so every anchor is keyed to its file.
// File markers / hunk headers are not commentable. An empty diff yields `[]`.
// This is the SINGLE anchor producer (BET-859): `UnifiedDiff` (ToolBodies.tsx)
// consumes its output rather than re-deriving `(path, side, line)` inline, so
// the line-classification rule can't diverge from a second implementation.
export function commentableLines(diffText: string): CommentableLine[] {
  const result: CommentableLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let path = "";
  let aPath = "";
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      const m = /^--- a\/(.+)$/.exec(line);
      if (m) aPath = m[1].trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m) path = m[1].trim();
      else if (/^\+\+\+ \/dev\/null$/.test(line.trim())) path = aPath;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (path) result.push({ path, line: newLine, side: "new" });
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (path) result.push({ path, line: oldLine, side: "old" });
      oldLine++;
    } else if (line.startsWith(" ")) {
      if (path) result.push({ path, line: newLine, side: "both" });
      oldLine++;
      newLine++;
    }
  }
  return result;
}

// The plain text of a USER message — its non-synthetic text parts concatenated
// with newlines, trailing whitespace stripped. This is the single source for
// "what text did the user send" and is shared by MessageRow (rendering) and
// buildVoiceNoteMap (claiming a note to the message whose transcript it
// matches). Keep it the same here and in MessageRow or the claim can diverge
// from what the row displays.
export function concatUserMessageText(msg: OpencodeMessage): string {
  return msg.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text ?? "")
    .join("\n")
    .replace(/\s+$/, "");
}

/**
 * Build a user-message-id → voice-note map by matching each note's transcript
 * to a user message whose concatenated text exactly equals it.
 *
 * Walk user messages OLDEST → NEWEST and notes OLDEST → NEWEST (the order the
 * server lists them); claim the FIRST unclaimed user message whose text
 * equals the note's transcript. Notes with an empty transcript are skipped.
 * A given note and a given message are each claimed at most once.
 *
 * KNOWN, ACCEPTED LIMITATION: because a message's transcript is just text, if
 * a user later TYPES a message identical to something they once dictated, it
 * could inherit an old note's chip. The consequence is cosmetic (a playable
 * chip next to the text) and the probability is negligible — do not build
 * machinery to prevent it.
 *
 * @returns Map<messageId, VoiceNoteRecord>
 */
export function buildVoiceNoteMap(
  messages: OpencodeMessage[] | null,
  notes: VoiceNoteRecord[] | null,
): Map<string, VoiceNoteRecord> {
  const map = new Map<string, VoiceNoteRecord>();
  if (!messages || !notes || notes.length === 0) return map;
  const claimed = new Set<string>();
  const users = messages.filter((m) => m.info.role === "user");
  for (const note of notes) {
    const transcript = note.transcript.trim();
    if (!transcript) continue;
    for (const m of users) {
      if (claimed.has(m.info.id)) continue;
      if (concatUserMessageText(m) === transcript) {
        map.set(m.info.id, note);
        claimed.add(m.info.id);
        break;
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// App-control bus dispatcher (BET-840/841).
//
// The box publishes ONE `appControl` bus kind with an `action` discriminator.
// The desktop renderer subscribes once (App.tsx) and funnels every envelope
// through this pure dispatcher, which routes each known action to a handler
// from the injected `handlers` bag. Pure and side-effect-free so it can be
// unit-tested without mounting App.
//
// - switch-model  -> handlers.switchModel (persist override + apply to the
//                    open panel via the shared model-selection path)
// - rename-session-> handlers.renameSession (refresh the sidebar; tmux is the
//                    source of truth)
// - compact-session -> no-op by design: opencode emits `session.compacted` and
//                    the renderer already reacts to it. Kept so nobody adds a
//                    redundant branch.
// - unknown action -> ignored silently. A newer box may publish an action an
//                    older desktop does not know; that must not throw.
// ---------------------------------------------------------------------------
export type AppControlHandlers = {
  switchModel?: (m: { sessionId: string; providerID: string; modelID: string }) => void;
  renameSession?: (p: { sessionId?: string; name: string }) => void;
};

export function dispatchAppControl(
  payload: unknown,
  handlers: AppControlHandlers,
): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as AppControlPayload;
  if (p.action === "switch-model") {
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const providerID = typeof p.providerID === "string" ? p.providerID : "";
    const modelID = typeof p.modelID === "string" ? p.modelID : "";
    if (sessionId && providerID && modelID) {
      handlers.switchModel?.({ sessionId, providerID, modelID });
    }
    return;
  }
  if (p.action === "rename-session") {
    const name = typeof p.name === "string" ? p.name : "";
    handlers.renameSession?.({
      sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
      name,
    });
    return;
  }
  // compact-session + any unknown action: no-op.
}

// =============================================================================
// Inline media (BET-1148) — pure model for the transcript media renderer.
//
// The server half (src/server/media.mjs) publishes ONE `media` bus kind with
// an `action` discriminator (`begin` | `show` | `fail`). The renderer keeps a
// per-session map of placeholder entries keyed by messageID (store
// `inlineMedia`, fed by the single App-level `onMedia` listener) and a shared
// `MediaBody` draws them. Everything derivable is kept pure and tested here so
// the component stays a thin presenter, per the repo's standing rule.
//
// The load-bearing invariant (from the BET-1148 spec): the placeholder MUST
// reserve the media's final aspect box before the bytes arrive, so the
// transcript's pin-to-bottom logic never sees a height change under the
// reader. `resolveMediaAspect` is the single source of that box.
// =============================================================================

/** What the media is. `begin` declares it; `show`/`file` derive it from mime. */
export type MediaKind = "image" | "video";

/** The four render states a media entry can be in. `expired` is a supported
 *  render state (a labelled placeholder, like `failed`) that the degrade
 *  ladder can reach; `begin`/`show`/`fail` events map to pending/ready/failed. */
export type MediaState = "pending" | "ready" | "failed" | "expired";

/** Resolved presentational metadata for a media item. Width/height/aspectRatio
 *  are the "reserve the final box" inputs — unknown → the 16:9 default. */
export type MediaMeta = {
  kind: MediaKind;
  /** Absolute box path (ready only) served by /api/peek. */
  path: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  /** Width÷height ratio declared up front, when dimensions are unknown. */
  aspectRatio: number | null;
  /** Expected variant count (the grid of numbered tiles). */
  count: number | null;
  title: string | null;
};

/** One placeholder/media item, keyed by messageID within a session. */
export type MediaEntry = {
  handle: string | null;
  state: MediaState;
  meta: MediaMeta;
  /** When the `begin` landed (pending only) — drives the elapsed clock. */
  beganAt: number | null;
};

/** The default reserved box: 16:9 (width÷height) when nothing is known. The
 *  card labels itself as possibly-reflowing in that case (one bounded reflow,
 *  never a growth from zero height). */
export const DEFAULT_MEDIA_ASPECT = 16 / 9;

/** Map a mime to a media kind, or null when it isn't image/video. */
export function mediaKindFromMime(mime: string | null | undefined): MediaKind | null {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}

/** True when the mime is image/* or video/* — i.e. the file-part branch should
 *  render MediaBody instead of the header-only file card. */
export function isMediaMime(mime: string | null | undefined): boolean {
  return mediaKindFromMime(mime) != null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function baseMeta(kind: MediaKind): MediaMeta {
  return {
    kind,
    path: null,
    mime: null,
    width: null,
    height: null,
    aspectRatio: null,
    count: null,
    title: null,
  };
}

/** The reserved box's width÷height. Explicit dimensions win, then the declared
 *  aspect ratio, then the 16:9 default. Used both to reserve the placeholder
 *  and to keep the finished media in the exact same box. */
export function resolveMediaAspect(meta: Pick<MediaMeta, "width" | "height" | "aspectRatio">): number {
  if (
    typeof meta.width === "number" &&
    meta.width > 0 &&
    typeof meta.height === "number" &&
    meta.height > 0
  ) {
    return meta.width / meta.height;
  }
  if (typeof meta.aspectRatio === "number" && meta.aspectRatio > 0) return meta.aspectRatio;
  return DEFAULT_MEDIA_ASPECT;
}

/** The variant grid, from the `begin`-declared count: at most 4 numbered tiles
 *  in 2 columns; anything beyond collapses behind a `+N more` row. */
export function mediaGrid(count: number | null): { tiles: number; more: number } {
  const c = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : 0;
  if (c <= 1) return { tiles: 1, more: 0 };
  return { tiles: Math.min(c, 4), more: Math.max(0, c - 4) };
}

/** Parse a transcript `file` part into a ready media entry. A file part's wire
 *  shape (src/server/opencode.mjs) is { type:"file", mime, url:"file://<abs>",
 *  filename? } — the absolute path is the `file://` URL stripped. */
export function filePartToMediaEntry(part: OpencodePart): MediaEntry {
  const url = String((part as Record<string, unknown>).url ?? "");
  const mime = strOrNull((part as Record<string, unknown>).mime);
  const kind = mediaKindFromMime(mime) ?? "image";
  return {
    handle: null,
    state: "ready",
    beganAt: null,
    meta: {
      ...baseMeta(kind),
      path: url.replace(/^file:\/\//, "") || null,
      mime,
    },
  };
}

/** State derivation from the media bus events. `prev` is the entry already
 *  stored for this messageID (undefined on first sight). `begin` reserves a
 *  pending box; `show` swaps in the file (ready); `fail` ends a never-shown
 *  placeholder as a labelled failure, keeping whatever reserved-box metadata
 *  `begin` declared so the box doesn't collapse. */
export function applyMediaEvent(
  prev: MediaEntry | undefined,
  payload: MediaEventPayload,
  now: number = Date.now(),
): MediaEntry {
  const action = payload.action;
  if (action === "begin") {
    const kind = payload.kind === "video" ? "video" : "image";
    return {
      handle: strOrNull(payload.handle),
      state: "pending",
      beganAt: now,
      meta: {
        ...baseMeta(kind),
        width: numOrNull(payload.width),
        height: numOrNull(payload.height),
        aspectRatio: numOrNull(payload.aspectRatio),
        count: numOrNull(payload.count),
        title: strOrNull(payload.title),
      },
    };
  }
  if (action === "show") {
    const prevMeta = prev?.meta ?? baseMeta("image");
    const mime = strOrNull(payload.mime) ?? prevMeta.mime;
    const kind = mediaKindFromMime(mime) ?? prevMeta.kind;
    return {
      handle: strOrNull(payload.handle) ?? prev?.handle ?? null,
      state: "ready",
      beganAt: prev?.beganAt ?? null,
      meta: {
        ...prevMeta,
        kind,
        path: strOrNull(payload.path) ?? prevMeta.path,
        mime,
        width: numOrNull(payload.width),
        height: numOrNull(payload.height),
        count: prevMeta.count,
        title: strOrNull(payload.title) ?? prevMeta.title,
      },
    };
  }
  if (action === "fail") {
    const meta = prev?.meta ?? baseMeta("image");
    return {
      handle: strOrNull(payload.handle) ?? prev?.handle ?? null,
      state: "failed",
      beganAt: prev?.beganAt ?? null,
      meta,
    };
  }
  // Unknown action: leave whatever was there (or a neutral pending box).
  return prev ?? { handle: null, state: "pending", beganAt: null, meta: baseMeta("image") };
}

/** The one-switch media dispatcher (mirrors dispatchAppControl). The App-level
 *  `onMedia` listener hands it the raw payload; it routes to the matching
 *  handler so call sites never switch on `action` themselves. */
export type MediaHandlers = {
  begin?: (p: MediaEventPayload) => void;
  show?: (p: MediaEventPayload) => void;
  fail?: (p: MediaEventPayload) => void;
};

export function dispatchMedia(payload: unknown, handlers: MediaHandlers): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as MediaEventPayload;
  if (p.action === "begin") {
    handlers.begin?.(p);
    return;
  }
  if (p.action === "show") {
    handlers.show?.(p);
    return;
  }
  if (p.action === "fail") {
    handlers.fail?.(p);
    return;
  }
}

// =============================================================================
// Inline widgets (BET-1325) — pure model for the transcript widget renderer.
//
// Mirrors the inline-media model (BET-1148) above at every level: the box
// spine (src/server/widgets.mjs) publishes ONE `widget` bus kind with an
// `action` discriminator, the renderer keeps a per-session map of entries
// keyed by messageId (store `inlineWidgets`, fed by the single App-level
// `onWidget` listener), and the memoized `WidgetBody` draws them. Everything
// derivable is kept pure and tested here so the component stays a thin
// presenter.
//
// The load-bearing invariant matches the media spec: the widget reserves its
// final aspect box (the same width/height/aspectRatio fields the media kind
// carries) so every render state occupies an identical box and the
// transcript's pin-to-bottom logic never sees a height change. `resolveMediaAspect`
// is reused as the single source of that box. Widgets arrive on the bus
// (never through markdown — see the "Do not touch" contract), so there is no
// renderer-side raw-HTML path to guard.
// =============================================================================

/** The render states a widget entry can be in (shared vocabulary with media). */
export type WidgetState = "pending" | "ready" | "failed" | "expired";

/** Resolved presentational metadata for a widget. Width/height/aspectRatio are
 *  the "reserve the final box" inputs, exactly like the media meta. */
export type WidgetMeta = {
  id: string | null;
  /** Absolute widget URL (ready only) served by the box at GET /widgets/<id>. */
  url: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
};

/** One widget entry, keyed by messageId within a session. */
export type WidgetEntry = {
  state: WidgetState;
  meta: WidgetMeta;
};

function baseWidgetMeta(): WidgetMeta {
  return { id: null, url: null, title: null, width: null, height: null, aspectRatio: null };
}

/** State derivation from the widget bus events. `prev` is the entry already
 *  stored for this messageId (undefined on first sight). The box spine
 *  currently publishes `show` (ready) only; `fail` is accepted so a later
 *  degrade path can mark a never-shown entry as a labelled placeholder,
 *  keeping whatever reserved-box metadata it declared so the box stays the
 *  same size. Unknown actions leave the prior entry untouched. */
export function applyWidgetEvent(
  prev: WidgetEntry | undefined,
  payload: WidgetEventPayload,
): WidgetEntry {
  const action = payload.action;
  if (action === "show") {
    const prevMeta = prev?.meta ?? baseWidgetMeta();
    return {
      state: "ready",
      meta: {
        id: strOrNull(payload.id) ?? prevMeta.id,
        url: strOrNull(payload.url) ?? prevMeta.url,
        title: strOrNull(payload.title) ?? prevMeta.title,
        width: numOrNull(payload.width),
        height: numOrNull(payload.height),
        aspectRatio: numOrNull(payload.aspectRatio),
      },
    };
  }
  if (action === "fail") {
    const meta = prev?.meta ?? baseWidgetMeta();
    return { state: "failed", meta };
  }
  // Unknown action: leave whatever was there (or a neutral pending box).
  return prev ?? { state: "pending", meta: baseWidgetMeta() };
}

/** The one-switch widget dispatcher (mirrors dispatchMedia). The App-level
 *  `onWidget` listener hands it the raw payload; it routes to the matching
 *  handler so call sites never switch on `action` themselves. */
export type WidgetHandlers = {
  show?: (p: WidgetEventPayload) => void;
  fail?: (p: WidgetEventPayload) => void;
};

export function dispatchWidget(payload: unknown, handlers: WidgetHandlers): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as WidgetEventPayload;
  if (p.action === "show") {
    handlers.show?.(p);
    return;
  }
  if (p.action === "fail") {
    handlers.fail?.(p);
    return;
  }
}

// ---- Work inbox (BET-795) --------------------------------------------------

// How urgent each inbox reason is — the merge tiebreak. A checks-failing PR is
// the most urgent (bad dot), a requested review next (warn dot), a plain
// assignment least (mute dot) — the dot-tone order of the mockup. Mirrors the
// server's precedence so a renderer that ever receives a duplicated key settles
// it the same way, independently of the box.
const INBOX_REASON_PRIORITY: Record<InboxReason, number> = {
  "checks failing": 3,
  "review requested": 2,
  assigned: 1,
};

/**
 * The human phrase for an inbox reason — what the row's secondary column shows,
 * with the mockup's copy verbatim ("checks red", "review requested",
 * "issue · assigned to you"). Pure + tested.
 */
export function inboxReasonLabel(reason: InboxReason): string {
  switch (reason) {
    case "checks failing":
      return "checks red";
    case "review requested":
      return "review requested";
    case "assigned":
      return "issue · assigned to you";
  }
}

/**
 * Sort inbox rows by `updatedAt` descending (most recent first), AND dedupe by
 * `repoKey#number` with the more urgent reason winning when the same object
 * appears twice (a PR matching two inbox populations). The server already
 * merges + dedupes, but the renderer guarantees the invariant it renders by —
 * nothing displays a duplicated row or a stale lower-priority reason. Pure +
 * tested, including the dedupe-precedence case.
 */
export function sortInbox(items: ForgeInboxItem[]): ForgeInboxItem[] {
  const byKey = new Map<string, ForgeInboxItem>();
  for (const item of items) {
    const key = `${item.repoKey}#${item.number}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    if (INBOX_REASON_PRIORITY[item.reason] > INBOX_REASON_PRIORITY[existing.reason]) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Scroll a scroll container to its very bottom.
 *
 * `scrollTop = scrollHeight` (rather than Virtuoso's
 * `scrollToIndex({ index: "LAST", align: "end" })`) because the transcript's
 * Footer — the working indicator, the todo checklist, the question cards —
 * renders BELOW the last item, and an item-aligned scroll leaves it under the
 * fold. The browser clamps an over-large `scrollTop`, so no max() is needed.
 * Instant only, deliberately: a smooth scroll toward a target that is still
 * growing lands short, which is one of the ways the transcript used to detach.
 */
export function scrollElementToTail(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/**
 * Decide what a scroll event means for the transcript's "following" state.
 *
 * Returns the NEW following value, or `null` when the event carries no
 * decision (leave the state alone). This is the whole reason the transcript no
 * longer detaches on its own: content growing does not fire a scroll event, so
 * it can never reach this function, and only a real position change can turn
 * following off.
 *
 * - Landing within FOLLOW_THRESHOLD_PX of the bottom always means following,
 *   whatever caused it (the user scrolling back down, our own tail scroll, or
 *   the scroller clamping after the transcript shrank on /compact).
 * - Moving UP while away from the bottom stops it — but ONLY when the move
 *   came from the user (`userIntent`). A scroll event is not by itself
 *   evidence of intent: react-virtuoso writes to the scroller behind our back
 *   (its "upward scrolling compensation" when a row above the viewport is
 *   re-measured, and the unshift/deviation corrections), and those arrive as
 *   ordinary scroll events with a LOWER scrollTop. Treating them as a
 *   scroll-up is what detached the transcript on every tool call: the card
 *   lands, its row is re-measured, Virtuoso compensates, and the transcript
 *   stopped following with no user input at all. See the intent tracker in
 *   Transcript.tsx for what counts as a gesture.
 */
export const FOLLOW_THRESHOLD_PX = 64;

export function classifyFollowOnScroll(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  prevScrollTop: number,
  userIntent: boolean,
): boolean | null {
  const distanceFromBottom = m.scrollHeight - m.scrollTop - m.clientHeight;
  if (distanceFromBottom <= FOLLOW_THRESHOLD_PX) return true;
  if (userIntent && m.scrollTop < prevScrollTop) return false;
  return null;
}

/**
 * How long a user input event vouches for the scroll events that follow it.
 *
 * A gesture and the scrolling it causes are not one event: a wheel tick is
 * followed by trackpad momentum that fires scroll events with no further
 * wheel events, and a keyboard PageUp scrolls a frame later. The window has
 * to outlive that gap while staying far shorter than the interval between a
 * gesture and the next unrelated re-measure.
 */
export const USER_SCROLL_INTENT_WINDOW_MS = 250;

/** Mutable "did the user just do something" record. Owned by Transcript.tsx. */
export type UserScrollIntent = {
  /** Timestamp of the last wheel / touch / key input on the scroller. */
  lastInputAt: number;
  /** A pointer button is held down on the scroller. */
  pointerDown: boolean;
  /** A scroll fired while that button was held — this press IS a scroll drag. */
  pointerScrolled: boolean;
};

export function createUserScrollIntent(): UserScrollIntent {
  return {
    lastInputAt: Number.NEGATIVE_INFINITY,
    pointerDown: false,
    pointerScrolled: false,
  };
}

export function hasUserScrollIntent(intent: UserScrollIntent, now: number): boolean {
  // A held button covers every pointer-driven scroll: dragging the scrollbar
  // thumb, click-to-page in the track, and drag-selecting past the top edge
  // (which auto-scrolls). See the note on pointer intent below for why this is
  // a held FLAG and not a geometric test of where the press landed.
  if (intent.pointerDown) return true;
  return now - intent.lastInputAt <= USER_SCROLL_INTENT_WINDOW_MS;
}

/**
 * A pointer press became a scroll gesture — grant it the trailing window on
 * release.
 *
 * WHY POINTER INTENT IS "BUTTON HELD", NOT "PRESSED ON THE SCROLLBAR".
 * The obvious discriminator is geometry: a press past `clientWidth` is on the
 * scrollbar gutter, a press inside the content box is a click (expanding a
 * tool card, selecting text) and must not vouch for the re-measure scrolls
 * that follow it. That test is a NO-OP under overlay scrollbars — the macOS
 * default, and therefore the primary platform — where the bar is painted over
 * the content and `clientWidth` equals the full border-box width, so no press
 * is ever past it. Measured in headed Chromium: classic scrollbars report
 * clientWidth 385 / offsetWidth 400, overlay reports 400 / 400, and BOTH
 * dispatch pointerdown to the scroller at the same clientX. Geometry cannot
 * tell them apart; the button state can. In the same measurement every scroll
 * of a thumb drag fired with the button held, and a plain content click fired
 * none.
 *
 * The residue is a press-and-hold ON CONTENT that spans a re-measure — a text
 * selection drag, mostly, where detaching is the right behaviour anyway.
 *
 * A quick track click can release before its later scroll events land, so a
 * press that demonstrably scrolled earns the normal input window on pointerup.
 * A press that never scrolled earns nothing, which is what keeps a tool-card
 * click from vouching for the compensation its own expansion causes.
 */
export function releaseUserScrollIntent(intent: UserScrollIntent, now: number): void {
  if (intent.pointerScrolled) intent.lastInputAt = now;
  intent.pointerDown = false;
  intent.pointerScrolled = false;
}

/**
 * Confirm copy for destructive "Close" actions in the sidebar rail (BET-935).
 * Pure string assembly so the confirm wording is testable without a DOM.
 */

export type CloseConfirmCopy = {
  title: string;
  body: string;
  confirmLabel: string;
};

/** Confirm copy for closing ONE session (a tmux window). */
export function describeSessionClose(args: {
  name: string;
  /** true when a turn is in flight for this window. */
  running: boolean;
  /** The worktree that WILL be removed, or null when none will be. */
  worktreePath: string | null;
}): CloseConfirmCopy {
  const parts = ["Its tmux window will be killed on the server."];
  if (args.running) parts.push("A turn is currently running and will be stopped.");
  if (args.worktreePath) parts.push(`Its worktree at ${args.worktreePath} will be removed.`);
  return {
    title: `Close “${args.name}”?`,
    body: parts.join(" "),
    confirmLabel: "Close session",
  };
}

/** Confirm copy for closing a WHOLE project (a tmux session). */
export function describeProjectClose(args: {
  name: string;
  sessionCount: number;
  runningCount: number;
  /** Worktrees that WILL be removed. Pass 0 when project close does not remove them. */
  worktreeCount: number;
}): CloseConfirmCopy {
  const { name, sessionCount, runningCount, worktreeCount } = args;
  const title =
    sessionCount === 0
      ? `Close “${name}”?`
      : `Close “${name}” and its ${sessionCount} session${sessionCount === 1 ? "" : "s"}?`;
  const parts = [
    sessionCount === 0
      ? "Its tmux session will be killed on the server."
      : `All ${sessionCount} tmux window${sessionCount === 1 ? "" : "s"} will be killed on the server.`,
  ];
  if (runningCount > 0) {
    parts.push(
      `${runningCount} session${runningCount === 1 ? " is" : "s are"} mid-turn and will be stopped.`,
    );
  }
  if (worktreeCount > 0) {
    parts.push(`${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"} will be removed.`);
  }
  return { title, body: parts.join(" "), confirmLabel: "Close project" };
}

// ===== On-call CTO voice UI build flag (BET-1191) =====
//
// The voice-call feature is being rebuilt on a different stack; until then its
// UI is hidden unless explicitly enabled at build/dev time. `voiceUiEnabled` is
// the PURE predicate (off unless the flag is exactly "1"), so it can be
// unit-tested by passing the env value in; `voiceUi` is THE single call site
// that reads `import.meta.env` — every consumer consults `voiceUi`, never the
// flag directly.

/** BET-1191 — hide the on-call CTO voice UI unless `VITE_MANTA_VOICE === "1"`.
 *  Pure: pass the build-time env value in, don't mock the build environment. */
export function voiceUiEnabled(voiceFlag: string | undefined): boolean {
  return voiceFlag === "1";
}

/** The one read of the build-time flag. Off by default; a developer turns the
 *  voice UI on with `VITE_MANTA_VOICE=1 npm run dev`. */
export const voiceUi: boolean = voiceUiEnabled(import.meta.env.VITE_MANTA_VOICE);
