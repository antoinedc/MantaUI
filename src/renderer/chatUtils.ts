// Pure utility functions extracted from ChatPanel for testability.

// Type-only import — erased at compile time, keeps this module dependency-
// free at runtime (the whole point of chatUtils.ts: pure functions testable
// without DOM/Electron/network).
import type { ConnectionStateName } from "../shared/net/state.js";
import type { DelegateApprovalTool, PermissionRequest, Project, SubscriptionStatus, TmuxWindow } from "../shared/types";
import type { SessionMode } from "./chatShared";
// Value import — `isClientTooOld` is the pure semver compare that drives
// the renderer-side version-skew banner (BET-225 stage 3). Lives in
// shared/versionCompare.mjs so both src/server/*.mjs and the renderer share
// one source of truth; re-imported here so chooseUpdateSkewVariant is
// testable in isolation (no DOM/network, just the compare).
import { isClientTooOld } from "../shared/versionCompare.mjs";

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
}

// Fallback context size used when the active model has no `limit.context`
// (or no active model is known yet). 200k is the lowest common denominator
// across Claude Sonnet 4.5 and older — generous enough that the bar
// doesn't lie too aggressively in the dark, conservative enough that
// the user is warned well before any actual provider would refuse.
// ===== Box-side stream interpretation (BET-551) =====
// Moved to ../shared/streamInterpretation.mjs (§17). chatUtils re-exports so
// the renderer keeps one implementation while it migrates to consuming the
// box's interpreted events (S1b).
export {
  ASSUMED_CONTEXT_TOKENS,
  resolveContextLimit,
  classifyFinish,
  describeTruncation,
  findFlushBoundary,
  mergeBufferedDeltas,
  selectCacheTtlMs,
  classifyCacheAge,
  selectLastAssistantCompletion,
  STALE_CACHE_MIN_TOKENS,
  computeStaleCache,
  computeContextBreakdown,
  isTerminalTodo,
  allTodosTerminal,
  selectActiveTodos,
  VISIBLE_TODOS_CAP,
  selectVisibleTodos,
  isSelfFilteringLifecycleEvent,
  registerChildSessionFromCreated,
  shouldDropEventForSessionFilter,
  applyQuestionEvent,
  hydrateQuestion,
  isAssistantTurnComplete,
  extractSubagentInfo,
  collectChildSessionIds,
  countRunningSubagents,
  summarizeChildSession,
  isAssistantTurnInProgress,
  AUTO_RENAME_EVERY_N_TURNS,
  shouldAutoRename,
  countUserTurns,
  buildTitlePromptInput,
  sanitizeGeneratedTitle,
  buildTitleInstruction,
} from "../shared/streamInterpretation.mjs";
export type {
  TruncationKind,
  PendingDelta,
  StaleCacheResult,
  ContextSegment,
  ContextBreakdown,
  QuestionLike,
  SubagentInfo,
} from "../shared/streamInterpretation.mjs";


// Resolve the effective context window in tokens for an active model. Reads
// `limit.context` off the OpencodeModel (which mirrors the provider's real
// window — e.g. 1_000_000 for Opus 4.7, 200_000 for Sonnet 4 / Haiku 4.5).
// Falls back to ASSUMED_CONTEXT_TOKENS when unknown so the bar still moves
// and is roughly meaningful before the first turn.
//
// Accepts the minimal `{ limit?: { context?: number } } | null` shape so
// callers don't have to import OpencodeModel here.

// Compact "Nk" display for a model's context window (e.g. 200_000 → "200k").
// Returns null for a missing/non-positive limit so callers can omit the
// badge entirely rather than rendering "0k". The canonical
// `Math.round(context / 1000)k` expression — ModelPicker.tsx and
// SubagentsCard.tsx both import this instead of re-deriving it inline.
export function formatModelContextSize(
  context: number | null | undefined,
): string | null {
  if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
    return null;
  }
  return `${Math.round(context / 1000)}k`;
}

// Classify a per-step finish reason emitted by opencode into the smallest
// set the UI actually needs to act on. Opencode normalizes provider-native
// values (Anthropic stop_reason, OpenAI finish_reason, Gemini finishReason)
// into a single string. Returns null when the finish is benign (end of turn,
// tool handoff, etc.) and no badge should be shown.
//
// - "output-cap"   → hit max_tokens / length (output cap). Retryable by
//                    raising max output.
// - "context-wall" → hit the model's own context window during generation.
//                    User needs to /compact (or start a new session).
// - "tool-cutoff"  → hit max_tokens MID tool_use block — the tool call JSON
//                    is incomplete and the agent loop will choke on it.
//                    Distinct because the fix is different (retry with
//                    higher max output) AND silently fatal if missed.
// - null           → not a truncation we care about.


// Human-readable description of a truncation. Returns { label, hint } so
// the badge can render a short label and the tooltip a longer hint.
  switch (kind) {
    case "output-cap":
      return {
        label: "truncated (output limit)",
        hint:
          "Response hit the per-turn output cap. Ask the model to continue, or raise the max output budget for this provider.",
      };
    case "context-wall":
      return {
        label: "truncated (context full)",
        hint:
          "Response hit the model's context window mid-generation. Run /compact to free space, or start a new session.",
      };
    case "tool-cutoff":
      return {
        label: "tool call cut off — retry needed",
        hint:
          "The model was emitting a tool call when it hit the output limit, so the call is incomplete and won't execute. Retry the turn (optionally with a higher max output).",
      };
  }
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${Math.round(n / 1000)}k tokens`;
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

export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
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
  if (pct < 50) return cssVar("--ok"); // green
  if (pct < 75) return cssVar("--warn"); // yellow
  if (pct < 90) return cssVar("--warn"); // orange
  return cssVar("--danger"); // red
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
  "--warn": "#F0A934",
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

// ===== Streamed-text flush boundaries =====
//
// opencode streams text/reasoning content via `message.part.delta` events
// that arrive ~character-by-character (one or a few tokens per frame).
// The naive policy of "apply every delta to React state immediately"
// produces visible jitter on partially-formed markdown: a bullet appears
// before its content; a code fence opens and renders as inline-code
// briefly before closing; the cursor at the end of a half-finished line
// flickers as Prism re-tokenizes a growing code block on every keystroke.
//
// Instead, buffer deltas in-memory and FLUSH at natural section
// boundaries: paragraph breaks (`\n\n`) outside a code block, and the
// newline that follows a closing ``` fence. Plus a 250ms max-age
// fallback (handled at the caller) so a single long paragraph doesn't
// stall indefinitely.
//
// `findFlushBoundary(buffer)` returns the byte index AFTER which the
// buffer is safe to flush, or -1 if no boundary is present yet. The
// caller slices `buffer.slice(0, idx)` into state and keeps the
// remainder buffered for the next round.
//
// Algorithm:
//   - Walk the buffer left→right counting ``` fences (toggles in/out of
//     a code block).
//   - At every `\n\n` while OUTSIDE a code block, record the position
//     just after the second `\n` as a candidate.
//   - At every transition OUT of a code block (the closing ```), once
//     we hit the next `\n`, record THAT position as a candidate.
//   - Return the LARGEST candidate (the deepest safe flush point); that
//     way one delta with multiple paragraph breaks flushes them all in
//     one render.
//
// Returns -1 if no boundary is present yet. The current code-block
// state of the trailing buffer is what's preserved across flushes —
// don't flush mid-fence, even if there's a `\n\n` inside it, because
// the user wants whole code blocks to appear at once.
//
// Pure + tested in chatUtils.test.ts.


// Merge a map of buffered delta strings (partID → text) into the
// messages array. Pure — produces a new array if any change applies,
// otherwise returns the input unchanged so React skips the re-render.
//
// `buffer` is `Map<partID, { messageID, field, text }>`. Each entry
// appends `text` to the named `field` of the matching part. Parts not
// found in the messages tree are silently skipped — the caller is
// expected to fall back to a refetch when a delta arrives ahead of the
// part's `message.part.updated` snapshot.


  if (!messages || buffer.size === 0) {
    return { messages, unmatched: [] };
  }
  // Group buffered entries by messageID so we only rebuild each
  // message object once even when multiple parts of the same message
  // have pending deltas (common: text part + reasoning part stream
  // interleaved).
  const byMessage = new Map<string, PendingDelta[] & { partID?: string }>();
  for (const [partID, d] of buffer) {
    const list = byMessage.get(d.messageID) ?? [];
    // Stash the partID alongside the delta so we don't need a second
    // lookup inside the per-message map.
    (list as Array<PendingDelta & { partID: string }>).push({ ...d, partID });
    byMessage.set(d.messageID, list);
  }
  const unmatched: string[] = [];
  const matchedPartIds = new Set<string>();
  const nextMessages = messages.map((m) => {
    const pending = byMessage.get(m.info.id);
    if (!pending) return m;
    const parts = m.parts.map((p) => {
      const hit = (pending as Array<PendingDelta & { partID: string }>).find(
        (d) => d.partID === p.id,
      );
      if (!hit) return p;
      matchedPartIds.add(hit.partID);
      const prior = (p[hit.field] as string | undefined) ?? "";
      return { ...p, [hit.field]: prior + hit.text };
    });
    return { ...m, parts };
  });
  for (const partID of buffer.keys()) {
    if (!matchedPartIds.has(partID)) unmatched.push(partID);
  }
  // If nothing matched, return the same reference so React doesn't
  // bother re-rendering.
  if (matchedPartIds.size === 0) {
    return { messages, unmatched };
  }
  return { messages: nextMessages, unmatched };
}

// ===== Cache staleness =====
//
// Anthropic's prompt cache has a sliding TTL — every cache hit refreshes
// the clock. When a session goes idle past the TTL, the cache entry is
// evicted and the next request re-bills the entire cached prefix as
// `cache_creation_input_tokens` at full input rate + 25% surcharge
// (5m TTL) or 2× input rate (1h TTL). For long sessions with a deep
// cached prefix, this can be 100k+ tokens of "wasted" spend just to
// warm the cache back up — typically more expensive than just running
// /clear and starting fresh.
//
// `selectCacheTtlMs(ttl)` returns the TTL in milliseconds. The TTL value
// itself is configured per-request by opencode (NOT by manta); the
// setting here is the user's claim about what opencode is sending, used
// solely to predict when to show the "/clear to save Nk tokens" pill.
//
// `selectLastAssistantCompletion(messages)` returns the unix-ms timestamp
// of the most recent fully-completed assistant turn, or null when there
// is no completed turn yet (fresh session, or turn still in flight).
// `time.completed` is set by opencode only when the turn is fully done
// server-side, so it can't false-positive mid-turn.
//
// `computeStaleCache({...})` returns the {staleTokens, idleMs, isStale}
// the UI needs. Gated by:
//   - lastCompleted != null (a turn has finished)
//   - cachedTokens >= minCacheTokens (don't pester for trivial savings)
//   - idleMs >= ttlMs (the cache has actually expired)
// `cachedTokens` is the size of the prefix that WOULD be re-billed:
// the last step's cache.read + cache.write (= every token currently in
// the cache for this session). On a normal warm turn that's the bulk
// of the context.


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

// Classifies elapsed-since-last-message against the prompt-cache TTL so the
// sidebar age label can be colored: fresh (cache is warm) → aging (cache is
// getting close to expiring) → stale (cache has likely expired, a follow-up
// re-warms the full prefix). Thresholds are 50%/90% of ttlMs, matching the
// feature spec — NOT the same thresholds as `computeStaleCache`'s 100%
// (fully-expired) gate, which drives a different UI (the "/clear" pill).


// Minimum cached-token threshold below which we suppress the pill. 5k is
// roughly the largest a low-overhead session could be and still feel
// "throwaway" — at that size a re-warm is ~$0.02 on Sonnet and not worth
// nagging about. Above 5k the warning carries real value.



// ===== Context window breakdown =====
//
// The opencode `session.next.step.ended` event carries per-turn token usage
// as `{ input, output, reasoning, cache: { read, write } }`. These mirror
// the Anthropic `usage` object (and opencode normalizes other providers to
// the same shape):
//
//   - `input`       → uncached input tokens (paid at full rate)
//   - `cache.read`  → tokens served from prompt cache (paid at ~10% rate,
//                     "warm")
//   - `cache.write` → tokens written into prompt cache THIS turn (paid at
//                     ~125% rate — full price + 25% cache-creation
//                     surcharge — and they re-bill on the next cold turn
//                     until a hit lands)
//   - `output`      → assistant output (not relevant to context window)
//
// All THREE input buckets (input + cache.read + cache.write) are disjoint
// and ALL consume the context window on the request. The previous code
// summed only `input + cache.read`, under-counting the bar on cache-warming
// turns. Output and reasoning never enter the context window numerator
// (they're produced by the model, not fed back in until the next turn —
// where they show up under the appropriate input bucket).
//
// `computeContextBreakdown` returns the four numbers the bar/pill UI
// needs: a tuple of segment widths (% of `limit`) plus the raw token
// counts. Clamps to never exceed 100% total (very over-context turns
// would otherwise overflow the bar visually).




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

/**
 * True when a todo item is in a terminal state (completed or cancelled).
 * Both liveTodos (from todo.updated SSE) and transcript-scraped TodoWrite
 * inputs surface a free-form `status` string; opencode's canonical terminal
 * values are "completed" and "cancelled". Anything else (pending,
 * in_progress, blocked, …) keeps the list visible in the chat panel.
 */

/**
 * True when every todo in a list is terminal AND the list is non-empty —
 * the trigger condition for hiding the ActiveTodos card after the user
 * submits their next prompt. Empty lists return false (no work to dismiss).
 */

/**
 * Decide which todo list the ActiveTodos card should render, or null to hide.
 *
 * Precedence (highest first):
 *  1. `dismissed` (user submitted with an all-terminal list) → null.
 *  2. `liveTodos` is authoritative WHEN PRESENT. opencode fires `todo.updated`
 *     with the full list every time TodoWrite runs — including an **empty
 *     array when the model clears the list**. An empty live list therefore
 *     means "explicitly cleared", NOT "no data": return null. Only a
 *     `null`/`undefined` liveTodos (no todo.updated seen this session) falls
 *     through to the transcript.
 *  3. Transcript fallback: the most recent non-empty TodoWrite tool input,
 *     for sessions restored before any live event arrived.
 *
 * The bug this fixes: the old inline selector gated the live path on
 * `liveTodos.length > 0`, so an empty live list fell through to (3) and the
 * transcript scan resurfaced the PRIOR non-empty list — the card never
 * cleared. `liveTodos` being a non-null array (even `[]`) is the signal.
 */

/** Maximum todo rows the ActiveTodos card renders before collapsing the
 * tail into a "+ N pending & M done" summary line. 5 keeps the card from
 * dominating the chat scroll on long checklists while still showing the
 * full in-progress context. */

/**
 * Pick which todo rows the ActiveTodos card should render and how many were
 * truncated. Sort order is **current → pending → done** so the row the
 * model is actively working on is always visible regardless of where it
 * sits in the canonical list; within each bucket the input order is
 * preserved (don't re-sort by content — TodoWrite already returns the
 * list in the order the model chose).
 *
 * Buckets:
 *   - in_progress  → "current"
 *   - everything non-terminal that isn't in_progress (pending, blocked, …)
 *                  → "pending"
 *   - completed | cancelled → "done"
 *
 * If the total <= cap, returns every input in bucket order with zero
 * hidden counts. If it exceeds the cap, fills `visible` from the top and
 * reports how many pending vs done rows were truncated. (in_progress rows
 * can be truncated too — they spill into `hiddenPending` since the user
 * cares "there's still work to start" more than the precise sub-status.)
 */
  const inProgress: Array<Record<string, unknown>> = [];
  const pending: Array<Record<string, unknown>> = [];
  const done: Array<Record<string, unknown>> = [];
  for (const t of todos) {
    const s = String(t.status ?? "").toLowerCase();
    if (s === "in_progress") inProgress.push(t);
    else if (s === "completed" || s === "cancelled") done.push(t);
    else pending.push(t);
  }
  const ordered = [...inProgress, ...pending, ...done];
  if (ordered.length <= cap) {
    return { visible: ordered, hiddenPending: 0, hiddenDone: 0 };
  }
  const visible = ordered.slice(0, cap);
  const hidden = ordered.slice(cap);
  let hiddenPending = 0;
  let hiddenDone = 0;
  for (const t of hidden) {
    const s = String(t.status ?? "").toLowerCase();
    if (s === "completed" || s === "cancelled") hiddenDone += 1;
    else hiddenPending += 1;
  }
  return { visible, hiddenPending, hiddenDone };
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
 * Event types whose ChatPanel handler RE-FETCHES and self-filters by
 * sessionID (refreshQuestions / refreshPermissions). Their event
 * `properties` is the Question/Permission request object, so
 * `properties.sessionID` is the *request's* session — NOT necessarily the
 * viewed one. They must therefore bypass the blanket per-session early-
 * return guard in onOpencodeEvent; otherwise the refresh trigger is dropped
 * and the card never appears. (Root cause of "questions never appear":
 * question.asked is also emitted only on the scoped `?directory=` stream, so
 * the live event is the primary delivery path — it cannot be pre-filtered.)
 *
 * Pure + exported so the exemption set is asserted by tests and can't
 * silently regress when the guard is touched.
 */

/**
 * Minimal event shape consumed by the per-session filter helpers below.
 * Matches OpencodeEvent's relevant fields without dragging the type in.
 */

/**
 * If `ev` is a `session.created` event whose new session is a CHILD of
 * `viewedSessionId`, add the child's id to `childSessionIds` and return
 * true. Otherwise no-op + return false.
 *
 * MUST be called BEFORE `shouldDropEventForSessionFilter` — the filter
 * looks up the new id in `childSessionIds`, and the child wouldn't be in
 * there yet without this registration step. (HIGH-severity regression
 * that was present in the initial Phase-1 implementation: the registration
 * block ran AFTER the filter, so live `session.created` events were
 * dropped and the allowlist fell back to the slower transcript-seeding
 * path — leaving a window before the parent's task tool part was stamped
 * during which child events were silently filtered out.)
 *
 * Mutates `childSessionIds` in place; returns whether a registration
 * happened so callers can assert/trace it.
 */

/**
 * Per-session early-return guard for `onOpencodeEvent`.
 *
 * Returns true when the event should be dropped because it's scoped to a
 * different session AND not a known child subagent AND not a
 * self-filtering lifecycle event.
 *
 * The three pass-through cases:
 *   - `evSessionID === viewedSessionId` → main session event.
 *   - `evSessionID ∈ childSessionIds` → known subagent child.
 *   - `isSelfFilteringLifecycleEvent(ev.type)` → question.* / permission.*
 *     (their handlers re-filter after the refresh trigger they cause).
 *
 * Empty/missing `properties.sessionID` also passes through — some events
 * (vcs.branch.updated, certain server-wide notifications) carry no
 * sessionID and would otherwise be silently dropped.
 *
 * Pure + exported so the guard contract is tested and can't silently
 * regress when the routing is touched.
 */

/**
 * Apply a question.* lifecycle event to the pending-questions list.
 *
 * THE regression this fixes (present since 1a5a336, the feature's first
 * commit): the handler called refreshQuestions() → GET /question on every
 * question.* event. Originally `GET /question` appeared to stay EMPTY for
 * live questions, and we concluded the question payload was only deliverable
 * via the live `question.asked` event. UPDATE: the real cause was a missing
 * `?directory=` query — opencode's `GET /question` IS authoritative when
 * called workspace-scoped (see listQuestions in main/opencode.ts). The
 * event still drives live in-session updates (avoids a round-trip per event
 * and carries the full payload), but initial-mount hydration now works too,
 * so a question fired before the panel mounted is recoverable on attach.
 *
 * `applyQuestionEvent` is the live-update path; `refreshQuestions`/mount
 * hydration is the missed-event recovery path. Both must agree on shape.
 *
 *  - question.asked    → upsert the QuestionRequest from the event payload
 *  - question.replied  → remove it (answered)
 *  - question.rejected → remove it (dismissed)
 *
 * Filtered to the viewed session. Pure (prev list + event → next list) so
 * the contract is unit-tested and can't silently regress again.
 */


/**
 * Normalize a server `GET /question` response row into the renderer's
 * QuestionLike shape used by applyQuestionEvent's output. The server returns
 * `{id: "que_…", sessionID, questions, tool}`; the renderer keeps a
 * separate `requestId` field because the live-event path treats `id` as
 * the dedup key (= callID when available) and stores the `que_` reply
 * token separately. Without this normalization step, a card rendered from
 * GET hydrate looks correct but reply errors with "reply token was not
 * captured" because `requestId` is undefined.
 *
 * Pure + exported so the contract is tested and can't silently regress
 * when either shape changes.
 */

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

// === Transcript-derived turn completion ===
//
// THE regression this fixes: the renderer's `running` (spinner) state is
// cleared ONLY by live SSE events — `session.idle`, `session.status
// {type:"idle"}`, or `session.error`. There is no transcript-derived
// fallback. So if the scoped event stream drops AFTER delivering the first
// post-resume frame but BEFORE `session.idle` (the documented "got a first
// line then hangs" failure: a half-dead dedicated tunnel), that idle event
// is missed permanently — opencode does not re-emit `session.idle` for an
// already-idle session when the stream reconnects. The reconnect triggers a
// message refetch (the COMPLETED response is in it), but nothing recomputes
// "done", so the spinner spins forever though the turn finished server-side.
//
// `isAssistantTurnComplete` derives completion from the authoritative
// server-side transcript: an assistant message carries `time.completed`
// (a unix-ms stamp) only once opencode has fully finished that turn. The
// renderer calls this on every refetch and clears `running` when it returns
// true — a self-healing fallback for the missed-idle case that cannot
// false-positive mid-turn (in-flight assistant messages have no
// `time.completed`; a queued user message makes the last role "user").
//
// Returns:
//   - false  → a turn is in flight (running should NOT be cleared here):
//              last message is a user message (assistant hasn't replied),
//              or the last assistant message has no completion stamp.
//   - true   → the last assistant turn is complete server-side; safe to
//              clear a stuck spinner. Empty transcript is also "complete"
//              (nothing is running).
//
// Deliberately ONE-WAY: callers use it only to clear `running`, never to
// set it true. Driving the spinner ON from the transcript would race the
// optimistic send path (setRunning(true) before the user message lands in
// any refetch) and live `session.status {busy}` events.

// ===== Subagent (Task tool / child session) helpers =====
//
// The opencode "task" tool spawns a CHILD session and waits for it to finish.
// On the wire (verified live + OpenAPI), the parent's task tool part carries:
//   - state.input: { description, prompt, subagent_type }
//   - state.metadata.sessionId: the child session's id (present as soon as
//     the part exists, even before status === "completed")
//   - state.metadata.model: { providerID, modelID } the child runs on
//   - state.metadata.truncated: was the child's output cut off
//   - state.status: "pending" | "running" | "completed" | "error"
//   - state.title / state.output / state.time.{start,end}
//
// The child session runs in the parent's `directory`, so its events flow on
// the SAME scoped `/event?directory=` stream manta already has open. The only
// thing standing between manta and live subagent rendering is the early
// sessionID filter (it drops events whose sessionID === childId). The
// collector helpers below produce the allowlist that filter consults.

/**
 * Minimal part shape the subagent helpers consume. `tokens` is at the part
 * root for `step-finish` parts (verified against opencode's OpenAPI:
 * `StepFinishPart.tokens` is required, with `input`/`output`/`reasoning`/
 * `cache` keys) — declared here so the helpers don't need a tactical cast.
 */

/** Minimal message shape the helpers consume. */

/**
 * Structured view of a single subagent invocation, extracted from the parent's
 * task tool part. Returns null when the part isn't a task tool call or doesn't
 * carry a child session id yet (some pending parts haven't been stamped).
 */

/**
 * Extract subagent info from any part. Returns null when:
 *   - the part isn't a tool call, OR
 *   - the tool isn't "task", OR
 *   - the part hasn't been stamped with a child sessionId yet (very brief
 *     window between tool-input.started and the first state.metadata write).
 *
 * Defensive against the loose `OpencodePart` type ({ [k: string]: unknown });
 * every field is narrowed at read time.
 */

/**
 * Walk a transcript and collect every child session id mentioned in any task
 * tool part. Used to seed the panel's `childSessionIds` allowlist on initial
 * fetch (and refetches) so the sessionID filter lets child events through
 * even before the live `session.created` arrives.
 *
 * Safe with undefined / null / empty inputs.
 */

/**
 * Count task tool parts whose status is "running" (or "pending"). Live status
 * can be more accurate than the parent's transcript snapshot — when a child's
 * `session.idle` arrives, ChatPanel maps its sessionId → "idle" in a Map and
 * passes it here so we don't keep counting subagents that just finished but
 * whose parent task-part status hasn't been refetched yet.
 *
 * `liveStatus` keys are child session ids; values are the latest live state
 * inferred from child SSE events ("running" | "idle"). When a child id isn't
 * in the map, we fall back to the transcript status (running/pending count).
 */

/**
 * Lightweight summary of a child session's transcript, for the collapsed
 * TaskBody header (tool count, last tool name, cumulative tokens scraped from
 * the child's step-finish parts). Used while the child is running OR after
 * completion when the user wants a one-line glance without expanding.
 *
 * Returns zeros for an empty/null transcript so callers can render
 * unconditionally without guarding.
 */
  let toolCount = 0;
  let lastToolName: string | null = null;
  let tokens = 0;
  if (!messages) return { toolCount, lastToolName, tokens };
  for (const m of messages) {
    const parts = m?.parts;
    if (!parts) continue;
    for (const p of parts) {
      if (p.type === "tool") {
        toolCount++;
        const name = typeof p.tool === "string" ? p.tool : null;
        if (name) lastToolName = name;
        continue;
      }
      // step-finish parts carry cumulative tokens for the step at the
      // part root (verified against StepFinishPart in opencode's OpenAPI).
      if (p.type === "step-finish") {
        const tk = p.tokens;
        if (tk) {
          tokens += (tk.input ?? 0) + (tk.output ?? 0);
        }
      }
    }
  }
  return { toolCount, lastToolName, tokens };
}

// `isAssistantTurnInProgress` is the mount-time counterpart to
// `isAssistantTurnComplete`. On a fresh panel mount we fetch the
// authoritative transcript; if the last message is an assistant turn with
// no `time.completed` stamp, that turn is either genuinely running or
// WEDGED (e.g. stuck mid-tool-call — opencode never emitted `idle`). Either
// way the UI must show `running` so the abort affordance is available;
// otherwise the user has a silently-stuck session and no way to clear it
// (every new prompt just queues behind the dead turn).
//
// SAFE ONLY AT MOUNT. Unlike the one-way clear in `isAssistantTurnComplete`,
// this can set `running` true — which would race the optimistic-send path
// and live `session.status` events if used on a live refetch. Call it once,
// from the initial-load effect, before any local send can have happened.
//
// A trailing `user` message returns false here: opencode has not begun an
// assistant turn for it yet, so there is nothing to abort. (That is the
// queued-prompt case; it resolves when opencode starts the turn and emits
// `session.status {busy}`.) Empty transcript → false.

// ===== Scroll-pin classification =====
//
// The chat transcript auto-follows the bottom while a turn streams, but only
// when the user is actually watching the tail. Three designs have shipped:
//
//   v1 (80px symmetric, no intent detection): a 30px scroll-up still
//     measured "near bottom", so the next delta yanked it back.
//
//   v2 (commit 631b03e: tight 8px re-pin + wheel/touch/key intent un-pin):
//     wheel-up explicitly unpinned regardless of distance, fixing v1. But
//     scrollbar-handle drags don't fire wheel/touch/key — only `scroll` —
//     and the scroll handler ONLY re-pinned, never un-pinned. A drag from
//     the bottom past the threshold left stale `pinned == true`, next
//     delta snapped. Combined with a separate ChatPanel effect that
//     force-pinned on every `session.status` busy/idle oscillation during
//     multi-step turns, the viewport kept snapping back.
//
//   v3 (here): pure observation, single symmetric threshold. The browser
//     fires `scroll` for every scroll cause (wheel, touch, key, scrollbar
//     drag, momentum, our own writes) so it's the only signal needed.
//
//       dist <= SCROLL_REPIN_PX (8px) → pin
//       dist >  SCROLL_REPIN_PX       → unpin
//
//     Symmetric threshold means each scroll event correctly reflects the
//     current position — no stale state, no flapping (scroll events fire
//     many times per second during scrolling, so the state stabilizes well
//     before the next ~hundred-millisecond delta tick). Trade-off: scrolls
//     of < 8px stay pinned and get snapped on the next delta. Acceptable
//     because (a) most wheel detents are 40-100px, (b) a single-pixel
//     scroll-up is almost certainly accidental, (c) re-engaging follow by
//     scrolling back to the bottom is trivial.
//
//     An earlier v3 draft used asymmetric thresholds (REPIN=8, UNPIN=64)
//     with a dead-zone "no change" return. That re-introduced v1's bug:
//     a 30px wheel-up landed in the dead zone, pin stayed true, next
//     delta snapped. The dead zone PRESERVES the prior state — it does
//     not prevent the snap. Don't bring it back without state-aware
//     hysteresis (and even then, the simple symmetric model works fine).
export const SCROLL_REPIN_PX = 8;

export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/** Distance from the bottom of the scroll container, clamped to >= 0. */
export function distFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * Whether the viewport is currently close enough to the bottom to be
 * considered "pinned to tail" — i.e., new content should auto-scroll.
 *
 * Single symmetric threshold by design. See the SCROLL_REPIN_PX comment
 * block above for why a dead-zone hysteresis variant doesn't work.
 */
export function classifyScrollForPin(
  metrics: ScrollMetrics,
  thresholdPx: number = SCROLL_REPIN_PX,
): boolean {
  return distFromBottom(metrics) <= thresholdPx;
}

/**
 * Whether the viewport was at the tail of the transcript BEFORE the current
 * commit grew the scroll container. Used by the post-commit layout effect
 * to decide whether to glue to the new bottom.
 *
 * Why this exists — v3's bug (which v4 fixes):
 *
 *   v3 cached `pinnedToBottom.current` from `scroll` events and read the
 *   cache from the `[messages]` effect. `scroll` events are async (rAF
 *   batched) but `setMessages` → render → effect is synchronous in the
 *   same task. So this sequence eats the user's scroll-up:
 *
 *     1. User wheels up 50px (scrollTop drops).
 *     2. Streaming delta arrives in the SAME tick (very common during
 *        active streaming — deltas land every few ms).
 *     3. setMessages → render → effect runs with stale `pinned == true`
 *        from the LAST scroll event, fires stickToBottom, snaps to tail.
 *     4. Only NOW does the browser dispatch the scroll event for the
 *        wheel-up — but it observes dist=0 (post-snap) and re-affirms
 *        `pinned == true`. The user's scroll-up is silently erased.
 *
 *   The fix: don't rely on event-cached pin state for stick decisions.
 *   Read the live DOM in a `useLayoutEffect` (runs synchronously post-
 *   commit, pre-paint), and compute pre-commit dist as:
 *
 *     prevDist = max(0, prevScrollHeight - currentScrollTop - clientHeight)
 *
 *   `scrollTop` is unchanged by appending content (browsers preserve it),
 *   so this gives the user's actual position before the new rows landed.
 *   No event timing, no stale ref.
 */
export function wasAtBottomBeforeCommit(
  prevScrollHeight: number,
  currentScrollTop: number,
  clientHeight: number,
  thresholdPx: number = SCROLL_REPIN_PX,
): boolean {
  if (prevScrollHeight <= 0) return true; // first commit — pin
  const prevDist = Math.max(
    0,
    prevScrollHeight - currentScrollTop - clientHeight,
  );
  return prevDist <= thresholdPx;
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

// ── Auto-rename session ───────────────────────────────────────────────────
// When `autoRenameSessions` is enabled, ChatPanel periodically asks opencode
// to summarize the recent conversation into a short 3-6 word tmux window
// name (see the "Auto-rename" section in AGENTS.md). These pure helpers make the
// trigger cadence, the prompt input, and the title sanitization testable
// without spinning up a session.

// How many completed user turns between auto-rename attempts. The summarize
// path spawns a throwaway opencode session (~9s), so we don't run it every
// turn — every Nth turn keeps the cost occasional while still tracking topic
// shifts within a long session.

// Hard cap on characters fed to the summarizer. The model only needs the gist;
// shipping the whole transcript wastes tokens and latency. We take the most
// RECENT text so the name tracks where the work has moved, not where it began.

// Max length of the final window name. tmux truncates long names in the status
// line and our sidebar; a 3-6 word title should never approach this, but we
// clamp defensively so a misbehaving model can't write an essay into the name.

/**
 * Should an auto-rename fire at this user-turn count? True on every Nth
 * completed user turn (1-indexed), i.e. turns 5, 10, 15… for N=5. Turn 0
 * (no user turns yet) never fires. Pure so the cadence is unit-testable.
 */

/**
 * Count completed user turns in a transcript. A "turn" is a user-role message
 * that carries at least one non-synthetic, non-ignored text part — synthetic
 * messages (command expansions, tool stubs) and empty placeholders don't
 * count toward the rename cadence.
 */

// Minimal structural shape we read off a part — avoids importing OpencodePart
// here and keeps the helpers usable from tests with plain literals.


/**
 * Build the summarizer input string from a transcript: the most recent
 * user+assistant text, oldest-first, truncated to TITLE_INPUT_MAX_CHARS by
 * KEEPING THE TAIL (the latest work). Returns "" when there's nothing to
 * summarize (caller should skip the rename). Pure + tested.
 */

/**
 * Sanitize a model-generated title into a safe 3-6 word tmux window name.
 * Strips surrounding quotes/markdown/punctuation, collapses whitespace,
 * takes at most the first six words, preserves the model's sentence case,
 * and clamps length (cutting at a word boundary when possible). Returns ""
 * when nothing usable remains (caller MUST skip the rename rather than blank
 * the window name — the rename IPC rejects empty names anyway). Pure +
 * tested.
 */

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
// already runs today (selection copy, clipboard paste, window.prompt find,
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

// ===== Subscription provider status (BET-314) =====
//
// Single source of truth for the connected/not-connected label the
// SubscriptionsCard renders next to each row. The renderer never invents
// its own copy here — the connect-card description ("● connected") is the
// whole UX, and pinning the strings in chatUtils.ts keeps a future i18n /
// copy pass touching one place. Returns "connected" / "not connected" with
// no extra ornament (no leading dot, no uppercase — the row already draws
// the dot separately and styles the casing).
export function describeSubscriptionStatus(s: SubscriptionStatus): string {
  return s.connected ? "connected" : "not connected";
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
  jobs: Record<string, { name: string; status: string; activity: string }>,
  opencodeSessionId: string | null | undefined,
): boolean {
  if (!opencodeSessionId) return false;
  return Object.prototype.hasOwnProperty.call(jobs, opencodeSessionId);
}

// Format a finished job's summary line from its branch + files-changed count.
// Used by the jobs management card for terminal (done/failed/stopped) rows.
// The no-worktree case (job ran in the parent cwd, worktree null) renders
// without a branch. `filesChanged` null/undefined → "0 files".
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
// job.parentSessionID). Only RUNNING jobs nest; terminal jobs are filtered
// out EXCEPT when the user is currently viewing the child window (so the
// view isn't yanked mid-read). A running job whose parent window no longer
// exists is an "orphan" — it stays a top-level row in its project rather
// than being dropped.
//
// Returns:
//   hidden      — child window indices that must be REMOVED from the
//                 project's top-level window list (they render nested).
//   children    — parent window index → ordered child window indices to
//                 render indented under that parent row.
//   orphans     — child window indices to render at top level (parent gone).
export type JobNestingResult = {
  hidden: Set<number>;
  children: Map<number, number[]>;
  orphans: number[];
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
  activeWindowIndex: number | undefined,
): JobNestingResult {
  const hidden = new Set<number>();
  const children = new Map<number, number[]>();
  const orphans: number[] = [];

  // Index windows by opencodeSessionId for parent/child resolution.
  const byOpencodeId = new Map<string, TmuxWindow>();
  for (const w of project.windows) {
    if (w.opencodeSessionId) byOpencodeId.set(w.opencodeSessionId, w);
  }

  for (const job of Object.values(jobs)) {
    if (!job.childSessionID) continue;
    const childWin = byOpencodeId.get(job.childSessionID);
    if (!childWin) continue; // job's window isn't in this project
    const isRunning = job.status === "running";
    const isViewed = activeWindowIndex === childWin.index;
    if (!isRunning && !isViewed) continue; // terminal + not viewed → hidden from rail entirely

    const parentWin = job.parentSessionID
      ? byOpencodeId.get(job.parentSessionID)
      : undefined;
    if (!parentWin) {
      // Parent window gone → render the child at workspace (top) level.
      orphans.push(childWin.index);
      continue;
    }
    hidden.add(childWin.index);
    const arr = children.get(parentWin.index) ?? [];
    arr.push(childWin.index);
    children.set(parentWin.index, arr);
  }

  // Sort children by window index for stable render order.
  for (const arr of children.values()) arr.sort((a, b) => a - b);
  orphans.sort((a, b) => a - b);
  return { hidden, children, orphans };
}

// Convenience: is a given window a job child that should be nested (i.e.
// hidden from the top-level list)? Combines isJobRow with the running/viewed
// gate so the Sidebar's top-level filter stays a single expression.
export function isNestedJobChild(
  jobs: Record<
    string,
    { status: string; parentSessionID: string | null; childSessionID: string | null }
  >,
  opencodeSessionId: string | null | undefined,
  project: Project,
  activeWindowIndex: number | undefined,
): boolean {
  if (!opencodeSessionId) return false;
  const job = jobs[opencodeSessionId];
  if (!job) return false;
  if (job.status === "running") {
    // Only nested if the parent window still exists in this project.
    return job.parentSessionID
      ? project.windows.some((w) => w.opencodeSessionId === job.parentSessionID)
      : false;
  }
  // Terminal job: nested only while the user is viewing it.
  return activeWindowIndex !== undefined && project.windows.some(
    (w) => w.opencodeSessionId === opencodeSessionId && w.index === activeWindowIndex,
  );
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
