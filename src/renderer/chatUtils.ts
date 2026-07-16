// Pure utility functions extracted from ChatPanel for testability.

// Type-only import — erased at compile time, keeps this module dependency-
// free at runtime (the whole point of chatUtils.ts: pure functions testable
// without DOM/Electron/network).
import type { ConnectionStateName } from "../shared/net/state.js";

// Fallback context size used when the active model has no `limit.context`
// (or no active model is known yet). 200k is the lowest common denominator
// across Claude Sonnet 4.5 and older — generous enough that the bar
// doesn't lie too aggressively in the dark, conservative enough that
// the user is warned well before any actual provider would refuse.
export const ASSUMED_CONTEXT_TOKENS = 200_000;

// Resolve the effective context window in tokens for an active model. Reads
// `limit.context` off the OpencodeModel (which mirrors the provider's real
// window — e.g. 1_000_000 for Opus 4.7, 200_000 for Sonnet 4 / Haiku 4.5).
// Falls back to ASSUMED_CONTEXT_TOKENS when unknown so the bar still moves
// and is roughly meaningful before the first turn.
//
// Accepts the minimal `{ limit?: { context?: number } } | null` shape so
// callers don't have to import OpencodeModel here.
export function resolveContextLimit(
  model: { limit?: { context?: number } } | null | undefined,
): number {
  const c = model?.limit?.context;
  if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  return ASSUMED_CONTEXT_TOKENS;
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
export type TruncationKind = "output-cap" | "context-wall" | "tool-cutoff";

export function classifyFinish(
  finish: string | null | undefined,
  opts?: { lastPartIsToolUse?: boolean },
): TruncationKind | null {
  if (!finish) return null;
  const f = finish.toLowerCase();

  // Anthropic-native: explicit "I ran out of context window mid-generation".
  if (f === "model_context_window_exceeded") return "context-wall";

  // Output-cap family. Anthropic: "max_tokens". OpenAI: "length".
  // Gemini: "MAX_TOKENS" (lowercased above). When the last assistant
  // block was a tool_use, we know the JSON is half-written and the
  // tool call is unusable — promote to "tool-cutoff" so the user gets
  // a more specific message and we can offer a retry later.
  if (f === "max_tokens" || f === "length") {
    return opts?.lastPartIsToolUse ? "tool-cutoff" : "output-cap";
  }

  // Everything else ("end_turn", "stop", "tool_use", "tool_calls",
  // "stop_sequence", "pause_turn", "refusal", etc.) is not a truncation.
  return null;
}

// Human-readable description of a truncation. Returns { label, hint } so
// the badge can render a short label and the tooltip a longer hint.
export function describeTruncation(kind: TruncationKind): {
  label: string;
  hint: string;
} {
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
  if (pct < 50) return "#22C79A"; // green-500
  if (pct < 75) return "#F7C15A"; // yellow-500
  if (pct < 90) return "#F0A934"; // orange-500
  return "#F0505F"; // red-500
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

export function findFlushBoundary(buffer: string): number {
  if (!buffer) return -1;
  let lastBoundary = -1;
  let inCode = false;
  let i = 0;
  while (i < buffer.length) {
    // Check for ``` fence (open or close). The opencode stream uses
    // standard markdown; backtick-only code blocks don't appear in the
    // assistant's narration outside of explicit ``` fences.
    if (
      buffer[i] === "`" &&
      buffer[i + 1] === "`" &&
      buffer[i + 2] === "`"
    ) {
      const wasInCode = inCode;
      inCode = !inCode;
      // If we just CLOSED a code block, look for the newline that
      // terminates the closing fence line. Everything up to and
      // including that newline is now a safe flush point.
      if (wasInCode && !inCode) {
        let j = i + 3;
        while (j < buffer.length && buffer[j] !== "\n") j++;
        if (j < buffer.length) {
          // We have the trailing newline of the close fence — include
          // it in the flush.
          lastBoundary = j + 1;
          i = j + 1;
          continue;
        }
        // Closing fence present but no trailing newline yet — the
        // model is still emitting the next line; don't flush here.
        return lastBoundary;
      }
      // Opened a code block — keep walking.
      i += 3;
      continue;
    }
    // Paragraph break (`\n\n`) OUTSIDE a code block is a flush point.
    // Inside a code block, blank lines are part of the code; don't
    // flush there.
    if (!inCode && buffer[i] === "\n" && buffer[i + 1] === "\n") {
      lastBoundary = i + 2;
      // Skip past the doubled newline; subsequent characters may form
      // another paragraph that flushes even deeper.
      i += 2;
      // Coalesce more consecutive newlines into the same boundary
      // (\n\n\n etc. — rare but harmless).
      while (i < buffer.length && buffer[i] === "\n") {
        lastBoundary = i + 1;
        i++;
      }
      continue;
    }
    i++;
  }
  return lastBoundary;
}

// Merge a map of buffered delta strings (partID → text) into the
// messages array. Pure — produces a new array if any change applies,
// otherwise returns the input unchanged so React skips the re-render.
//
// `buffer` is `Map<partID, { messageID, field, text }>`. Each entry
// appends `text` to the named `field` of the matching part. Parts not
// found in the messages tree are silently skipped — the caller is
// expected to fall back to a refetch when a delta arrives ahead of the
// part's `message.part.updated` snapshot.

export type PendingDelta = {
  messageID: string;
  field: string;
  text: string;
};

export function mergeBufferedDeltas<M extends {
  info: { id: string };
  parts: Array<Record<string, unknown> & { id: string }>;
}>(
  messages: M[] | null | undefined,
  buffer: Map<string, PendingDelta>,
): { messages: M[] | null | undefined; unmatched: string[] } {
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
// itself is configured per-request by opencode (NOT by bui); the
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

export function selectCacheTtlMs(ttl: "5m" | "1h"): number {
  return ttl === "1h" ? 60 * 60_000 : 5 * 60_000;
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

// Classifies elapsed-since-last-message against the prompt-cache TTL so the
// sidebar age label can be colored: fresh (cache is warm) → aging (cache is
// getting close to expiring) → stale (cache has likely expired, a follow-up
// re-warms the full prefix). Thresholds are 50%/90% of ttlMs, matching the
// feature spec — NOT the same thresholds as `computeStaleCache`'s 100%
// (fully-expired) gate, which drives a different UI (the "/clear" pill).
export function classifyCacheAge(
  lastMessageAt: number,
  now: number,
  ttlMs: number,
): "fresh" | "aging" | "stale" {
  const elapsed = Math.max(0, now - lastMessageAt);
  if (elapsed < 0.5 * ttlMs) return "fresh";
  if (elapsed < 0.9 * ttlMs) return "aging";
  return "stale";
}

export function selectLastAssistantCompletion(
  messages:
    | Array<{
        info: {
          role: string;
          time?: { completed?: number; [k: string]: unknown };
        };
      }>
    | null
    | undefined,
): number | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info.role !== "assistant") continue;
    const c = m.info.time?.completed;
    if (typeof c === "number" && c > 0) return c;
  }
  return null;
}

// Minimum cached-token threshold below which we suppress the pill. 5k is
// roughly the largest a low-overhead session could be and still feel
// "throwaway" — at that size a re-warm is ~$0.02 on Sonnet and not worth
// nagging about. Above 5k the warning carries real value.
export const STALE_CACHE_MIN_TOKENS = 5_000;

export type StaleCacheResult = {
  isStale: boolean;
  idleMs: number;
  staleTokens: number;
  ttlMs: number;
};

export function computeStaleCache(input: {
  lastCompleted: number | null;
  now: number;
  ttlMs: number;
  cachedTokens: number;
  minCacheTokens?: number;
  running?: boolean;
}): StaleCacheResult {
  const min = input.minCacheTokens ?? STALE_CACHE_MIN_TOKENS;
  const idleMs =
    input.lastCompleted != null
      ? Math.max(0, input.now - input.lastCompleted)
      : 0;
  const tokens = Math.max(0, Math.round(input.cachedTokens));
  // Never report stale while a turn is running — the cache is being
  // actively touched (writes count as touches) and a "/clear to save"
  // suggestion is meaningless until the turn ends.
  if (input.running) {
    return { isStale: false, idleMs, staleTokens: tokens, ttlMs: input.ttlMs };
  }
  // Need a completed turn to know when staleness started; need real
  // cached tokens to make the warning actionable.
  if (input.lastCompleted == null || tokens < min) {
    return { isStale: false, idleMs, staleTokens: tokens, ttlMs: input.ttlMs };
  }
  return {
    isStale: idleMs >= input.ttlMs,
    idleMs,
    staleTokens: tokens,
    ttlMs: input.ttlMs,
  };
}

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

export type ContextSegment = "fresh" | "cacheRead" | "cacheWrite";

export type ContextBreakdown = {
  // Raw counts. Always non-negative, ints.
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  // Total input tokens that consume the context window this request.
  totalInput: number;
  // Percent of `limit` used, clamped to [0, 100], rounded.
  pct: number;
  // Per-segment percentages of `limit` (NOT of totalInput) so the segmented
  // bar can render them as proportional slices that visually sum to `pct`.
  // Clamped so their sum never exceeds 100 (the last segment absorbs the
  // clamp when over-context).
  segments: { kind: ContextSegment; pct: number }[];
};

export function computeContextBreakdown(
  tokens: {
    input?: number;
    cache?: { read?: number; write?: number };
  } | null | undefined,
  limit: number,
): ContextBreakdown {
  const freshInput = Math.max(0, Math.round(tokens?.input ?? 0));
  const cacheRead = Math.max(0, Math.round(tokens?.cache?.read ?? 0));
  const cacheWrite = Math.max(0, Math.round(tokens?.cache?.write ?? 0));
  const totalInput = freshInput + cacheRead + cacheWrite;
  const safeLimit = limit > 0 ? limit : ASSUMED_CONTEXT_TOKENS;
  const rawPct = (totalInput / safeLimit) * 100;
  const pct = Math.min(100, Math.round(rawPct));

  // Compute segment percentages with the same clamp envelope. Convert
  // each bucket to its share of the LIMIT (not totalInput) so the
  // segmented bar's filled portion equals `pct` exactly.
  const segFresh = (freshInput / safeLimit) * 100;
  const segRead = (cacheRead / safeLimit) * 100;
  const segWrite = (cacheWrite / safeLimit) * 100;
  // Render order: fresh (uncached, paid full rate) | cache.write (warm-up,
  // paid full rate + surcharge) | cache.read (cheap, paid ~10%). Putting
  // cache.write between fresh and cache.read groups the "expensive" buckets
  // visually on the left so the bar reads left→right as cost-decreasing.
  const segments: { kind: ContextSegment; pct: number }[] = [
    { kind: "fresh", pct: segFresh },
    { kind: "cacheWrite", pct: segWrite },
    { kind: "cacheRead", pct: segRead },
  ];
  // Clamp the sum to `pct` (handles both rounding drift and over-context
  // overflow): scale down proportionally if we'd exceed 100%.
  const sum = segments.reduce((a, s) => a + s.pct, 0);
  if (sum > 100 && sum > 0) {
    const scale = 100 / sum;
    for (const s of segments) s.pct *= scale;
  }
  return { freshInput, cacheRead, cacheWrite, totalInput, pct, segments };
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

/**
 * True when a todo item is in a terminal state (completed or cancelled).
 * Both liveTodos (from todo.updated SSE) and transcript-scraped TodoWrite
 * inputs surface a free-form `status` string; opencode's canonical terminal
 * values are "completed" and "cancelled". Anything else (pending,
 * in_progress, blocked, …) keeps the list visible in the chat panel.
 */
export function isTerminalTodo(t: Record<string, unknown>): boolean {
  const s = String(t.status ?? "").toLowerCase();
  return s === "completed" || s === "cancelled";
}

/**
 * True when every todo in a list is terminal AND the list is non-empty —
 * the trigger condition for hiding the ActiveTodos card after the user
 * submits their next prompt. Empty lists return false (no work to dismiss).
 */
export function allTodosTerminal(todos: Array<Record<string, unknown>>): boolean {
  return todos.length > 0 && todos.every(isTerminalTodo);
}

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
export function selectActiveTodos(
  liveTodos: Array<Record<string, unknown>> | null | undefined,
  transcriptTodos: Array<Record<string, unknown>> | null | undefined,
  dismissed: boolean,
): Array<Record<string, unknown>> | null {
  if (dismissed) return null;
  if (liveTodos != null) {
    // Present (even if empty) = authoritative. Empty = cleared = hide.
    return liveTodos.length > 0 ? liveTodos : null;
  }
  if (transcriptTodos && transcriptTodos.length > 0) return transcriptTodos;
  return null;
}

/** Maximum todo rows the ActiveTodos card renders before collapsing the
 * tail into a "+ N pending & M done" summary line. 5 keeps the card from
 * dominating the chat scroll on long checklists while still showing the
 * full in-progress context. */
export const VISIBLE_TODOS_CAP = 5;

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
export function selectVisibleTodos(
  todos: Array<Record<string, unknown>>,
  cap: number = VISIBLE_TODOS_CAP,
): {
  visible: Array<Record<string, unknown>>;
  hiddenPending: number;
  hiddenDone: number;
} {
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
export function isSelfFilteringLifecycleEvent(type: string): boolean {
  return (
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected" ||
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "permission.rejected"
  );
}

/**
 * Minimal event shape consumed by the per-session filter helpers below.
 * Matches OpencodeEvent's relevant fields without dragging the type in.
 */
type FilterEvent = {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string; parentID?: string };
    [k: string]: unknown;
  };
};

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
export function registerChildSessionFromCreated(
  ev: FilterEvent,
  viewedSessionId: string,
  childSessionIds: Set<string>,
): boolean {
  if (ev.type !== "session.created") return false;
  const info = ev.properties?.info;
  if (!info || info.parentID !== viewedSessionId) return false;
  if (typeof info.id !== "string" || info.id.length === 0) return false;
  if (childSessionIds.has(info.id)) return false;
  childSessionIds.add(info.id);
  return true;
}

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
export function shouldDropEventForSessionFilter(
  ev: FilterEvent,
  viewedSessionId: string,
  childSessionIds: Set<string>,
): boolean {
  if (isSelfFilteringLifecycleEvent(ev.type)) return false;
  const evSessionID = ev.properties?.sessionID;
  if (typeof evSessionID !== "string" || evSessionID.length === 0) return false;
  if (evSessionID === viewedSessionId) return false;
  if (childSessionIds.has(evSessionID)) return false;
  return true;
}

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
export type QuestionLike = {
  id: string; // canonical: tool.callID when present (unifies event+transcript)
  sessionID: string;
  questions: unknown[];
  tool?: { messageID: string; callID: string };
  // The opencode `que_…` request id from the asked event, when present.
  // Kept ALONGSIDE the callID-keyed `id` so a replied/rejected event that
  // echoes only the `que_` id can still clear a callID-keyed card.
  requestId?: string;
};

export function applyQuestionEvent(
  prev: QuestionLike[],
  eventType: string,
  properties: Record<string, unknown> | undefined,
  viewedSessionId: string,
): QuestionLike[] {
  const p = properties ?? {};
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";
  const tool = p.tool as { messageID?: string; callID?: string } | undefined;
  // Canonical id = the tool callID when present (stable across re-asks);
  // fall back to the event's own `que_…` id. The `que_` is preserved
  // separately as `requestId` because opencode's reply/reject API accepts
  // ONLY that form (verified: server rejects a callID with HTTP 400).
  const callID = typeof tool?.callID === "string" ? tool.callID : "";
  const id = callID || (typeof p.id === "string" ? p.id : "");

  if (eventType === "question.replied" || eventType === "question.rejected") {
    // The replied/rejected event's id field is not guaranteed to match the
    // id we stored on `asked` (asked is keyed on tool.callID for transcript
    // unification; replied may carry `que_…`/requestID instead). Match
    // defensively on ANY id form the event exposes so the card always
    // clears, regardless of which identifier opencode echoes back.
    const ids = new Set(
      [
        p.id,
        p.requestID,
        p.callID,
        tool?.callID,
        tool?.messageID,
      ].filter((x): x is string => typeof x === "string" && x.length > 0),
    );
    if (ids.size === 0) return prev;
    return prev.filter(
      (q) =>
        !ids.has(q.id) &&
        !(q.requestId !== undefined && ids.has(q.requestId)) &&
        !(q.tool && (ids.has(q.tool.callID) || ids.has(q.tool.messageID))),
    );
  }
  if (eventType === "question.asked") {
    if (!id) return prev; // need a stable key to store/dedupe
    // Only surface questions for the session the user is viewing.
    if (sessionID !== viewedSessionId) return prev;
    if (!Array.isArray(p.questions)) return prev;
    const next: QuestionLike = {
      id,
      sessionID,
      questions: p.questions as unknown[],
      tool:
        tool?.messageID && tool?.callID
          ? { messageID: tool.messageID, callID: tool.callID }
          : undefined,
      requestId: typeof p.id === "string" ? p.id : undefined,
    };
    const without = prev.filter((q) => q.id !== id); // dedupe re-asks
    return [...without, next];
  }
  return prev;
}

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
export function hydrateQuestion(server: {
  id: string;
  sessionID: string;
  questions: unknown[];
  tool?: { messageID: string; callID: string };
}): QuestionLike {
  // Dedup key prefers tool.callID (matches applyQuestionEvent so a live
  // event arriving after GET hydrate updates the same row instead of
  // duplicating it). Falls back to `que_…` when no tool info is present.
  const id =
    typeof server.tool?.callID === "string" && server.tool.callID.length > 0
      ? server.tool.callID
      : server.id;
  return {
    id,
    sessionID: server.sessionID,
    questions: server.questions,
    tool: server.tool,
    requestId: server.id, // the `que_…` — what opencode's reply API requires
  };
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
export function isAssistantTurnComplete(
  messages:
    | Array<{
        info: {
          role: string;
          // `completed?` is the only field read; the open member keeps the
          // type assignable from the real OpencodeMessageInfo.time (which
          // also carries `created`) and from test fixtures.
          time?: { completed?: number; [k: string]: unknown };
        };
      }>
    | null
    | undefined,
): boolean {
  if (!messages || messages.length === 0) return true;
  const last = messages[messages.length - 1];
  if (last.info.role !== "assistant") return false;
  const completed = last.info.time?.completed;
  return typeof completed === "number" && completed > 0;
}

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
// the SAME scoped `/event?directory=` stream bui already has open. The only
// thing standing between bui and live subagent rendering is the early
// sessionID filter (it drops events whose sessionID === childId). The
// collector helpers below produce the allowlist that filter consults.

/**
 * Minimal part shape the subagent helpers consume. `tokens` is at the part
 * root for `step-finish` parts (verified against opencode's OpenAPI:
 * `StepFinishPart.tokens` is required, with `input`/`output`/`reasoning`/
 * `cache` keys) — declared here so the helpers don't need a tactical cast.
 */
type SubagentPart = {
  type?: string;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    output?: string;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  // step-finish parts only.
  tokens?: { input?: number; output?: number };
};

/** Minimal message shape the helpers consume. */
type SubagentMessage = { parts?: SubagentPart[] };

/**
 * Structured view of a single subagent invocation, extracted from the parent's
 * task tool part. Returns null when the part isn't a task tool call or doesn't
 * carry a child session id yet (some pending parts haven't been stamped).
 */
export type SubagentInfo = {
  childSessionId: string;
  // From state.input
  agent: string;                 // subagent_type, e.g. "explore"
  description: string;           // human-readable summary
  prompt: string;                // full prompt sent to the child
  // From state
  status: "pending" | "running" | "completed" | "error" | "unknown";
  title: string | null;          // opencode-generated short label
  output: string | null;         // child's final text (only when completed)
  truncated: boolean;            // state.metadata.truncated
  durationMs: number | null;     // end - start when both stamps exist
  model: { providerID: string; modelID: string } | null;
};

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
export function extractSubagentInfo(part: SubagentPart): SubagentInfo | null {
  if (!part || part.type !== "tool" || part.tool !== "task") return null;
  const state = part.state ?? {};
  const meta = (state.metadata ?? {}) as Record<string, unknown>;
  const childSessionId =
    typeof meta.sessionId === "string" && meta.sessionId.length > 0
      ? meta.sessionId
      : null;
  if (!childSessionId) return null;
  const input = (state.input ?? {}) as Record<string, unknown>;
  const status = ((): SubagentInfo["status"] => {
    const s = typeof state.status === "string" ? state.status : "";
    if (s === "pending" || s === "running" || s === "completed" || s === "error") return s;
    return "unknown";
  })();
  const time = state.time ?? {};
  const durationMs =
    typeof time.start === "number" && typeof time.end === "number" && time.end >= time.start
      ? time.end - time.start
      : null;
  const modelRaw = meta.model as Record<string, unknown> | undefined;
  const model =
    modelRaw &&
    typeof modelRaw.providerID === "string" &&
    typeof modelRaw.modelID === "string"
      ? { providerID: modelRaw.providerID, modelID: modelRaw.modelID }
      : null;
  return {
    childSessionId,
    agent: typeof input.subagent_type === "string" ? input.subagent_type : "subagent",
    description: typeof input.description === "string" ? input.description : "",
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    status,
    title: typeof state.title === "string" ? state.title : null,
    output: typeof state.output === "string" ? state.output : null,
    truncated: meta.truncated === true,
    durationMs,
    model,
  };
}

/**
 * Walk a transcript and collect every child session id mentioned in any task
 * tool part. Used to seed the panel's `childSessionIds` allowlist on initial
 * fetch (and refetches) so the sessionID filter lets child events through
 * even before the live `session.created` arrives.
 *
 * Safe with undefined / null / empty inputs.
 */
export function collectChildSessionIds(
  messages: SubagentMessage[] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!messages) return out;
  for (const m of messages) {
    const parts = m?.parts;
    if (!parts) continue;
    for (const p of parts) {
      const info = extractSubagentInfo(p);
      if (info) out.add(info.childSessionId);
    }
  }
  return out;
}

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
export function countRunningSubagents(
  messages: SubagentMessage[] | null | undefined,
  liveStatus?: Map<string, "running" | "idle"> | null,
): number {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    const parts = m?.parts;
    if (!parts) continue;
    for (const p of parts) {
      const info = extractSubagentInfo(p);
      if (!info) continue;
      const live = liveStatus?.get(info.childSessionId);
      if (live === "idle") continue;
      if (live === "running") {
        n++;
        continue;
      }
      // No live signal — fall back to transcript status.
      if (info.status === "running" || info.status === "pending") n++;
    }
  }
  return n;
}

/**
 * Lightweight summary of a child session's transcript, for the collapsed
 * TaskBody header (tool count, last tool name, cumulative tokens scraped from
 * the child's step-finish parts). Used while the child is running OR after
 * completion when the user wants a one-line glance without expanding.
 *
 * Returns zeros for an empty/null transcript so callers can render
 * unconditionally without guarding.
 */
export function summarizeChildSession(
  messages: SubagentMessage[] | null | undefined,
): { toolCount: number; lastToolName: string | null; tokens: number } {
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
export function isAssistantTurnInProgress(
  messages:
    | Array<{
        info: {
          role: string;
          time?: { completed?: number; [k: string]: unknown };
        };
      }>
    | null
    | undefined,
): boolean {
  if (!messages || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.info.role !== "assistant") return false;
  const completed = last.info.time?.completed;
  return !(typeof completed === "number" && completed > 0);
}

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
// When the user queues a prompt mid-turn, bui no longer waits for the whole
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
export const AUTO_RENAME_EVERY_N_TURNS = 5;

// Hard cap on characters fed to the summarizer. The model only needs the gist;
// shipping the whole transcript wastes tokens and latency. We take the most
// RECENT text so the name tracks where the work has moved, not where it began.
const TITLE_INPUT_MAX_CHARS = 2000;

// Max length of the final window name. tmux truncates long names in the status
// line and our sidebar; a 3-6 word title should never approach this, but we
// clamp defensively so a misbehaving model can't write an essay into the name.
const TITLE_MAX_CHARS = 48;

/**
 * Should an auto-rename fire at this user-turn count? True on every Nth
 * completed user turn (1-indexed), i.e. turns 5, 10, 15… for N=5. Turn 0
 * (no user turns yet) never fires. Pure so the cadence is unit-testable.
 */
export function shouldAutoRename(
  userTurnCount: number,
  everyN: number = AUTO_RENAME_EVERY_N_TURNS,
): boolean {
  if (everyN <= 0) return false;
  if (userTurnCount <= 0) return false;
  return userTurnCount % everyN === 0;
}

/**
 * Count completed user turns in a transcript. A "turn" is a user-role message
 * that carries at least one non-synthetic, non-ignored text part — synthetic
 * messages (command expansions, tool stubs) and empty placeholders don't
 * count toward the rename cadence.
 */
export function countUserTurns(
  messages: { info: { role: string }; parts: OpencodePartLike[] }[] | null,
): number {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.info.role !== "user") continue;
    if (extractTextFromParts(m.parts).trim().length > 0) n += 1;
  }
  return n;
}

// Minimal structural shape we read off a part — avoids importing OpencodePart
// here and keeps the helpers usable from tests with plain literals.
type OpencodePartLike = {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
};

function extractTextFromParts(parts: OpencodePartLike[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type !== "text" && p.type !== "reasoning") continue;
    if (p.synthetic || p.ignored) continue;
    if (typeof p.text === "string" && p.text.trim()) out.push(p.text);
  }
  return out.join("\n");
}

/**
 * Build the summarizer input string from a transcript: the most recent
 * user+assistant text, oldest-first, truncated to TITLE_INPUT_MAX_CHARS by
 * KEEPING THE TAIL (the latest work). Returns "" when there's nothing to
 * summarize (caller should skip the rename). Pure + tested.
 */
export function buildTitlePromptInput(
  messages: { info: { role: string }; parts: OpencodePartLike[] }[] | null,
): string {
  if (!messages) return "";
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromParts(m.parts).trim();
    if (!text) continue;
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= TITLE_INPUT_MAX_CHARS) return joined;
  // Keep the tail — the most recent work is what the name should reflect.
  return joined.slice(joined.length - TITLE_INPUT_MAX_CHARS);
}

/**
 * Sanitize a model-generated title into a safe 3-6 word tmux window name.
 * Strips surrounding quotes/markdown/punctuation, collapses whitespace,
 * takes at most the first six words, preserves the model's sentence case,
 * and clamps length (cutting at a word boundary when possible). Returns ""
 * when nothing usable remains (caller MUST skip the rename rather than blank
 * the window name — the rename IPC rejects empty names anyway). Pure +
 * tested.
 */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim();
  // Drop a leading "Title:" / "Name:" preamble the model sometimes adds.
  s = s.replace(/^\s*(title|name)\s*[:\-]\s*/i, "");
  // Strip markdown emphasis / code fences / surrounding quotes.
  s = s.replace(/[`*_#]/g, "");
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  // Keep only the first line (models occasionally explain on a second line).
  s = s.split(/\r?\n/)[0] ?? "";
  // Drop trailing sentence punctuation.
  s = s.replace(/[.!?,;:]+$/g, "");
  // Collapse internal whitespace, take at most six words. Preserve case.
  const words = s.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  let out = words.join(" ").trim();
  if (out.length > TITLE_MAX_CHARS) {
    const window = out.slice(0, TITLE_MAX_CHARS);
    const lastSpace = window.lastIndexOf(" ");
    out = (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
  }
  return out;
}

// The instruction sent to the throwaway opencode session. Kept here (not in
// the main process) so the renderer and tests share one source of truth.
export function buildTitleInstruction(conversation: string): string {
  return (
    "You are titling a work session. Reply with ONLY a short descriptive " +
    "title of 3 to 6 words that names the concrete task, feature, or bug " +
    "being worked on in this conversation. Sentence case. No trailing " +
    "punctuation, no quotes, no explanation. Be specific — prefer 'Fix SSE " +
    "reconnect after sleep' or 'Sidebar session age indicator' over vague " +
    "titles like 'Code fixes' or 'Debugging session'. Title the CURRENT " +
    "focus, weighting the most recent messages:\n\n" +
    conversation
  );
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
// Claude credential auto-refresh (BET-139)
// ---------------------------------------------------------------------------

/**
 * Map a failed `opencodeRefreshCredentials()` outcome to the actionable
 * banner text shown via `setSendError`. Pure so the copy is testable without
 * exercising the async refresh flow. Keep in sync with the reasons returned
 * by `refreshClaudeCredentials` in src/server/opencode.mjs.
 */
export function credentialRefreshBannerText(
  reason?: "no-credentials" | "refresh-token-expired" | "failed",
): string {
  switch (reason) {
    case "refresh-token-expired":
      return "Claude login expired — run `opencode auth login anthropic` on the box, then retry.";
    case "no-credentials":
      return "No Claude credentials found — run `opencode auth login anthropic` on the box.";
    default:
      return "Couldn't refresh Claude credentials automatically. Run `claude` on the box, then retry.";
  }
}

/**
 * The text of the most recent user-role message with non-empty text —
 * i.e. the turn that just errored with ProviderAuthError and needs to be
 * auto-resent once credentials are refreshed. Returns null when there's no
 * such message (empty/synthetic transcript).
 */
export function lastUserMessageText(
  messages: { info: { role: string }; parts: OpencodePartLike[] }[] | null,
): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info.role !== "user") continue;
    const text = extractTextFromParts(m.parts).trim();
    if (text) return text;
  }
  return null;
}
