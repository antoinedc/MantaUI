// Pure utility functions extracted from ChatPanel for testability.

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

export function ctxStageColor(pct: number): string {
  if (pct < 50) return "#22c55e"; // green-500
  if (pct < 75) return "#eab308"; // yellow-500
  if (pct < 90) return "#f97316"; // orange-500
  return "#ef4444"; // red-500
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
