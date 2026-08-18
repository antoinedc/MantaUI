// streamInterpretation.mjs — the box-side "stream interpretation" logic,
// moved here from src/renderer/chatUtils.ts (BET-551 / §17 of DECISIONS.md).
//
// §17 settles that the box is the SINGLE interpreter of the opencode session
// stream and both clients (desktop renderer + native mobile) consume what it
// produces. The partition: everything on the "Box" side of §17 lives here and
// is imported by manta-server (src/server/streamInterp.mjs). The renderer re-
// exports it so it keeps a single implementation while it is still being
// migrated to consuming the box's interpreted events (S1b).
//
// Pure + framework-free (no DOM, no fs, no fetch) so it runs under Node ESM
// on the server AND in vitest, identically. The .test.ts in this directory is
// the same test suite that used to live in src/renderer/chatUtils.test.ts,
// moved unmodified alongside the logic.

// Fallback context size used when the active model has no `limit.context`
// (or no active model is known yet). 200k is the lowest common denominator
// across Claude Sonnet 4.5 and older — generous enough that the bar
// doesn't lie too aggressively in the dark, conservative enough that
// the user is warned well before any actual provider would refuse.
export const ASSUMED_CONTEXT_TOKENS = 200_000;

// Resolve the effective context window in tokens for an active model. Reads
// `limit.context` off the OpencodeModel (which mirrors the provider's real
// window — e.g. 1_000_000 for Opus 4.7, 200_000 for Sonnet 4 / Haiku 4.5).
// Returns `null` when the model reports no usable limit (no model, no limit,
// or a non-positive / non-finite value) — the caller must render the "no max
// context" state, NOT fabricate a number.
//
// Accepts the minimal `{ limit?: { context?: number } } | null` shape so
// callers don't have to import OpencodeModel here.
export function resolveContextLimit(model) {
  const c = model?.limit?.context;
  if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  return null;
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
export function classifyFinish(finish, opts) {
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
export function describeTruncation(kind) {
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

// Pull the human sentence out of a provider rejection body, so an error banner
// that currently reads `Bad Request: {"detail":"The 'gpt-5.6-sol' model is not
// supported…"}` instead shows just the sentence inside. Pure, no I/O, no throw.
//
// The wire shape is always `<HTTP reason phrase>: <raw provider response body>`.
// Only bodies we recognise are unwrapped; anything we don't understand is
// returned byte-identical (lossless fallback — an unreadable error is far
// better than a missing one).
export function humanizeProviderError(raw) {
  if (typeof raw !== "string") return raw;
  let body = raw;
  // Split an optional leading `<reason phrase>: ` off the front. Only treat the
  // leading segment as a reason phrase when the remainder is itself JSON
  // (starts with `{` or `[`); plain prose like `Bad Request: something happened`
  // is NOT a JSON body and is left untouched.
  const sep = raw.indexOf(": ");
  if (sep > 0) {
    const rest = raw.slice(sep + 2);
    if (rest.startsWith("{") || rest.startsWith("[")) body = rest;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return raw;
  }
  const sentence = extractErrorSentence(parsed);
  if (typeof sentence === "string" && sentence.length > 0) return sentence;
  return raw;
}

// Recognise the four provider body shapes and return the human sentence, or
// null when none match.
//
//   | Provider                    | Body                                    | Extract     |
//   |-----------------------------|-----------------------------------------|-------------|
//   | Codex / ChatGPT backend     | `{"detail":"…"}`                        | `detail`    |
//   | OpenAI API                  | `{"error":{"message":"…",…}}`           | `error.message` |
//   | Anthropic                   | `{"type":"error","error":{…,"message":"…"}}` | `error.message` |
//   | Misc / OpenAI-compatible    | `{"message":"…"}`                       | `message`   |
//
// Order matters only in that `error.message` is checked before a top-level
// `message`. `detail` may also arrive as an array of objects (FastAPI
// validation errors) — if it is not a non-empty string, the shape is unmatched.
function extractErrorSentence(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const errObj = parsed.error;
  if (errObj && typeof errObj === "object") {
    const m = errObj.message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  const detail = parsed.detail;
  if (typeof detail === "string" && detail.length > 0) return detail;
  const message = parsed.message;
  if (typeof message === "string" && message.length > 0) return message;
  return null;
}

// ===== Streamed-text flush boundaries =====
//
// opencode streams text/reasoning content via `message.part.delta` events
// that arrive ~character-by-character (one or a few tokens per frame).
// The naive policy of "apply every delta immediately" produces visible
// jitter on partially-formed markdown: a bullet appears before its content;
// a code fence opens and renders as inline-code briefly before closing; the
// cursor at the end of a half-finished line flickers as Prism re-tokenizes a
// growing code block on every keystroke.
//
// Instead, buffer deltas in-memory and FLUSH at natural section boundaries:
// paragraph breaks (`\n\n`) outside a code block, the newline that follows a
// closing ``` fence, and — since BET-649 — the end of a SENTENCE. Plus a
// max-age fallback (`FLUSH_MAX_AGE_MS`, handled at the caller) so a single
// long paragraph doesn't stall indefinitely.
//
// WHY SENTENCES. Paragraph-only flushing is why streamed prose lands in slabs:
// a whole paragraph is withheld and then committed at once, so the text does
// not arrive, it appears. Cutting at sentence ends makes the same content
// arrive in roughly sentence-sized pieces, which is the single biggest change
// to how streaming FEELS. It costs more commits per turn (more re-renders,
// more scroll work), which is why the max age came down rather than to zero —
// per-character rendering was never the goal.
//
// A sentence end is only a boundary when the prefix is SAFE TO CUT — see
// `isSafeCut`. Splitting inside an inline code span, a link, or a `**bold**`
// run renders the half-finished markup literally for a frame, which is the
// exact jitter this buffer exists to prevent. Code blocks are unchanged: they
// still flush whole, never mid-fence.
//
// `findFlushBoundary(buffer)` returns the byte index AFTER which the buffer
// is safe to flush, or -1 if no boundary is present yet. The caller slices
// `buffer.slice(0, idx)` and keeps the remainder buffered for the next round.
//
// Maximum time a buffered chunk may be withheld before the caller flushes it
// at the latest safe cut. Was 250ms when only paragraph breaks could flush;
// with sentence boundaries carrying most of the traffic this is the fallback
// for a long unpunctuated run, so it can be tighter without thrashing.
export const FLUSH_MAX_AGE_MS = 120;

/**
 * Is `prefix` safe to cut at — i.e. does it end outside every markdown
 * construct that would render wrong if split?
 *
 * Deliberately a few cheap counts rather than a markdown parser: this runs on
 * every delta. It is CONSERVATIVE — when in doubt it returns false and the text
 * stays buffered until the next boundary or the max age. A false negative costs
 * a few hundred milliseconds of latency; a false positive puts `**bold` on
 * screen.
 *
 * Checks, all scoped to the prefix:
 *   - backticks: an odd count means we are inside an inline code span;
 *   - `[` vs `]` and `(` vs `)`: unbalanced means we are mid-link;
 *   - `**`: an odd count means we are inside a bold run.
 * Underscore emphasis is NOT counted — `_` appears constantly in identifiers
 * and file paths, so counting it would block almost every cut.
 */
export function isSafeCut(prefix) {
  let backticks = 0;
  let bold = 0;
  let brackets = 0;
  let parens = 0;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (ch === "`") backticks++;
    else if (ch === "*" && prefix[i + 1] === "*") {
      bold++;
      i++;
    } else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
  }
  return backticks % 2 === 0 && bold % 2 === 0 && brackets <= 0 && parens <= 0;
}

// Returns -1 if no boundary is present yet. Don't flush mid-fence, even if
// there's a `\n\n` inside it — whole code blocks should appear at once.
export function findFlushBoundary(buffer) {
  if (!buffer) return -1;
  let lastBoundary = -1;
  let inCode = false;
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] === "`" && buffer[i + 1] === "`" && buffer[i + 2] === "`") {
      const wasInCode = inCode;
      inCode = !inCode;
      // If we just CLOSED a code block, look for the newline that
      // terminates the closing fence line. Everything up to and including
      // that newline is now a safe flush point.
      if (wasInCode && !inCode) {
        let j = i + 3;
        while (j < buffer.length && buffer[j] !== "\n") j++;
        if (j < buffer.length) {
          lastBoundary = j + 1;
          i = j + 1;
          continue;
        }
        // Closing fence present but no trailing newline yet — the model is
        // still emitting the next line; don't flush here.
        return lastBoundary;
      }
      i += 3;
      continue;
    }
    // Paragraph break (`\n\n`) OUTSIDE a code block is a flush point.
    if (!inCode && buffer[i] === "\n" && buffer[i + 1] === "\n") {
      lastBoundary = i + 2;
      i += 2;
      while (i < buffer.length && buffer[i] === "\n") {
        lastBoundary = i + 1;
        i++;
      }
      continue;
    }
    // Sentence end OUTSIDE a code block: `.`/`!`/`?` (plus any closing quote
    // or bracket that belongs to it) followed by whitespace. The trailing
    // whitespace is INCLUDED in the flushed slice so the next chunk starts at
    // the next sentence's first character and the joined text is unchanged.
    if (!inCode && (buffer[i] === "." || buffer[i] === "!" || buffer[i] === "?")) {
      let j = i + 1;
      while (j < buffer.length && (buffer[j] === '"' || buffer[j] === "'" || buffer[j] === ")" || buffer[j] === "]")) j++;
      // Require the whitespace to be PRESENT: a buffer ending in "." may be
      // mid-number ("1.") or mid-abbreviation, and the next delta decides.
      if (j < buffer.length && (buffer[j] === " " || buffer[j] === "\n")) {
        const cut = j + 1;
        if (isSafeCut(buffer.slice(0, cut))) lastBoundary = cut;
        i = cut;
        continue;
      }
    }
    i++;
  }
  return lastBoundary;
}

// Merge a map of buffered delta strings (partID → text) into the messages
// array. Pure — produces a new array if any change applies, otherwise
// returns the input unchanged so the caller can skip a re-render.
//
// `buffer` is `Map<partID, { messageID, field, text }>`. Each entry appends
// `text` to the named `field` of the matching part. Parts not found in the
// messages tree are silently skipped — the caller is expected to fall back
// to a refetch when a delta arrives ahead of the part's snapshot.
export function mergeBufferedDeltas(messages, buffer) {
  if (!messages || buffer.size === 0) {
    return { messages, unmatched: [] };
  }
  // Group buffered entries by messageID so we only rebuild each message
  // object once even when multiple parts of the same message have pending
  // deltas (common: text part + reasoning part stream interleaved).
  const byMessage = new Map();
  for (const [partID, d] of buffer) {
    const list = byMessage.get(d.messageID) ?? [];
    list.push({ ...d, partID });
    byMessage.set(d.messageID, list);
  }
  const unmatched = [];
  const matchedPartIds = new Set();
  const nextMessages = messages.map((m) => {
    const pending = byMessage.get(m.info.id);
    if (!pending) return m;
    const parts = m.parts.map((p) => {
      const hit = pending.find((d) => d.partID === p.id);
      if (!hit) return p;
      matchedPartIds.add(hit.partID);
      const prior = p[hit.field] ?? "";
      return { ...p, [hit.field]: prior + hit.text };
    });
    return { ...m, parts };
  });
  for (const partID of buffer.keys()) {
    if (!matchedPartIds.has(partID)) unmatched.push(partID);
  }
  // If nothing matched, return the same reference so the caller doesn't
  // bother re-rendering.
  if (matchedPartIds.size === 0) {
    return { messages, unmatched };
  }
  return { messages: nextMessages, unmatched };
}

// ===== Cache staleness =====
//
// Anthropic's prompt cache has a sliding TTL — every cache hit refreshes the
// clock. When a session goes idle past the TTL, the cache entry is evicted
// and the next request re-bills the entire cached prefix as
// `cache_creation_input_tokens` at full input rate + 25% surcharge (5m TTL)
// or 2× input rate (1h TTL). For long sessions with a deep cached prefix,
// this can be 100k+ tokens of "wasted" spend just to warm the cache back up.
//
// `selectCacheTtlMs(ttl)` returns the TTL in milliseconds. The TTL value
// itself is configured per-request by opencode (NOT by manta); the setting
// here is the user's claim about what opencode is sending, used solely to
// predict when to show the "/clear to save Nk tokens" pill.
export function selectCacheTtlMs(ttl) {
  return ttl === "1h" ? 60 * 60_000 : 5 * 60_000;
}

// Classifies elapsed-since-last-message against the prompt-cache TTL so the
// session age label can be colored: fresh (cache is warm) → aging (cache is
// getting close to expiring) → stale (cache has likely expired, a follow-up
// re-warms the full prefix). Thresholds are 50%/90% of ttlMs, matching the
// feature spec — NOT the same thresholds as `computeStaleCache`'s 100%
// (fully-expired) gate, which drives a different UI (the "/clear" pill).
export function classifyCacheAge(lastMessageAt, now, ttlMs) {
  const elapsed = Math.max(0, now - lastMessageAt);
  if (elapsed < 0.5 * ttlMs) return "fresh";
  if (elapsed < 0.9 * ttlMs) return "aging";
  return "stale";
}

// `selectLastAssistantCompletion(messages)` returns the unix-ms timestamp of
// the most recent fully-completed assistant turn, or null when there is no
// completed turn yet (fresh session, or turn still in flight).
// `time.completed` is set by opencode only when the turn is fully done
// server-side, so it can't false-positive mid-turn.
export function selectLastAssistantCompletion(messages) {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info.role !== "assistant") continue;
    const c = m.info.time?.completed;
    if (typeof c === "number" && c > 0) return c;
  }
  return null;
}

// Minimum cached-token threshold below which we suppress the "/clear to
// save" pill. 5k is roughly the largest a low-overhead session could be and
// still feel "throwaway" — at that size a re-warm is ~$0.02 on Sonnet and
// not worth nagging about. Above 5k the warning carries real value.
export const STALE_CACHE_MIN_TOKENS = 5_000;

// `computeStaleCache({...})` returns the {staleTokens, idleMs, isStale} the
// UI needs. Gated by:
//   - lastCompleted != null (a turn has finished)
//   - cachedTokens >= minCacheTokens (don't pester for trivial savings)
//   - idleMs >= ttlMs (the cache has actually expired)
export function computeStaleCache(input) {
  const min = input.minCacheTokens ?? STALE_CACHE_MIN_TOKENS;
  const idleMs =
    input.lastCompleted != null
      ? Math.max(0, input.now - input.lastCompleted)
      : 0;
  const tokens = Math.max(0, Math.round(input.cachedTokens));
  // Never report stale while a turn is running — the cache is being actively
  // touched (writes count as touches) and a "/clear to save" suggestion is
  // meaningless until the turn ends.
  if (input.running) {
    return { isStale: false, idleMs, staleTokens: tokens, ttlMs: input.ttlMs };
  }
  // Need a completed turn to know when staleness started; need real cached
  // tokens to make the warning actionable.
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
// as `{ input, output, reasoning, cache: { read, write } }`. These mirror the
// Anthropic `usage` object (and opencode normalizes other providers to the
// same shape):
//
//   - `input`       → uncached input tokens (paid at full rate)
//   - `cache.read`  → tokens served from prompt cache (paid at ~10% rate)
//   - `cache.write` → tokens written into prompt cache THIS turn (paid at
//                     ~125% rate — full price + 25% cache-creation surcharge)
//   - `output`      → assistant output (not relevant to context window)
//
// All THREE input buckets (input + cache.read + cache.write) are disjoint and
// ALL consume the context window on the request. `computeContextBreakdown`
// returns the four numbers the bar/pill UI needs: a tuple of segment widths
// (% of `limit`) plus the raw token counts, clamped to never exceed 100%.
export function computeContextBreakdown(tokens, limit) {
  const freshInput = Math.max(0, Math.round(tokens?.input ?? 0));
  const cacheRead = Math.max(0, Math.round(tokens?.cache?.read ?? 0));
  const cacheWrite = Math.max(0, Math.round(tokens?.cache?.write ?? 0));
  const totalInput = freshInput + cacheRead + cacheWrite;

  const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  // Unknown limit (null, non-positive, non-finite) — report the token totals
  // but signal "no max context" so the consumer never renders a fake %.
  if (!hasLimit) {
    return {
      freshInput,
      cacheRead,
      cacheWrite,
      totalInput,
      pct: null,
      hasLimit: false,
      segments: [],
    };
  }

  const rawPct = (totalInput / limit) * 100;
  const pct = Math.min(100, Math.round(rawPct));

  const segFresh = (freshInput / limit) * 100;
  const segRead = (cacheRead / limit) * 100;
  const segWrite = (cacheWrite / limit) * 100;
  const segments = [
    { kind: "fresh", pct: segFresh },
    { kind: "cacheWrite", pct: segWrite },
    { kind: "cacheRead", pct: segRead },
  ];
  const sum = segments.reduce((a, s) => a + s.pct, 0);
  if (sum > 100 && sum > 0) {
    const scale = 100 / sum;
    for (const s of segments) s.pct *= scale;
  }
  return { freshInput, cacheRead, cacheWrite, totalInput, pct, hasLimit: true, segments };
}

/**
 * The newest assistant token usage in a transcript that actually consumed
 * context, plus the model that produced it (so the caller can resolve the
 * context window).
 *
 * Walks BACKWARDS and returns the first assistant message whose combined input
 * (fresh + cache read + cache write) is greater than zero. Messages reporting
 * zero are skipped: a freshly-streaming message reports zeros, and treating
 * one as authoritative makes the context meter blink off mid-turn.
 *
 * Mirrors the desktop `latestTokens` selector in src/renderer/ChatPanel.tsx so
 * both clients agree on which message is authoritative.
 *
 * @param {any[]} messages transcript as returned by listMessages
 * @returns {{tokens: any, providerID: string|null, modelID: string|null}|null}
 */
export function selectLatestTokenUsage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "assistant") continue;
    const t = info.tokens;
    if (!t) continue;
    const totalInput =
      (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (totalInput <= 0) continue;
    return {
      tokens: t,
      providerID: info.providerID ?? null,
      modelID: info.modelID ?? null,
    };
  }
  return null;
}

/**
 * True when a todo item is in a terminal state (completed or cancelled).
 * Both liveTodos (from todo.updated SSE) and transcript-scraped TodoWrite
 * inputs surface a free-form `status` string; opencode's canonical terminal
 * values are "completed" and "cancelled". Anything else (pending,
 * in_progress, blocked, …) keeps the list visible in the chat panel.
 */
export function isTerminalTodo(t) {
  const s = String(t.status ?? "").toLowerCase();
  return s === "completed" || s === "cancelled";
}

/**
 * True when every todo in a list is terminal AND the list is non-empty —
 * the trigger condition for hiding the ActiveTodos card after the user
 * submits their next prompt. Empty lists return false (no work to dismiss).
 */
export function allTodosTerminal(todos) {
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
 *  3. Transcript fallback: the most recent non-empty TodoWrite tool input.
 */
export function selectActiveTodos(liveTodos, transcriptTodos, dismissed) {
  if (dismissed) return null;
  if (liveTodos != null) {
    return liveTodos.length > 0 ? liveTodos : null;
  }
  if (transcriptTodos && transcriptTodos.length > 0) return transcriptTodos;
  return null;
}

/** Maximum todo rows the ActiveTodos card renders before collapsing the tail
 * into a "+ N pending & M done" summary line. 5 keeps the card from
 * dominating the chat scroll on long checklists. */
export const VISIBLE_TODOS_CAP = 5;

/**
 * Pick which todo rows the ActiveTodos card should render and how many were
 * truncated. Sort order is **current → pending → done** so the row the model
 * is actively working on is always visible; within each bucket the input
 * order is preserved. If the total <= cap, returns every input in bucket
 * order with zero hidden counts. Otherwise fills `visible` from the top and
 * reports how many pending vs done rows were truncated.
 */
export function selectVisibleTodos(todos, cap = VISIBLE_TODOS_CAP) {
  const inProgress = [];
  const pending = [];
  const done = [];
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

// Event types whose ChatPanel handler RE-FETCHES and self-filters by
// sessionID (refreshQuestions / refreshPermissions). Their event
// `properties` is the Question/Permission request object, so
// `properties.sessionID` is the *request's* session — NOT necessarily the
// viewed one. They must therefore bypass the blanket per-session early-return
// guard; otherwise the refresh trigger is dropped and the card never appears.
export function isSelfFilteringLifecycleEvent(type) {
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
 * If `ev` is a `session.created` event whose new session is a CHILD of
 * `viewedSessionId`, add the child's id to `childSessionIds` and return true.
 * Otherwise no-op + return false.
 *
 * MUST be called BEFORE `shouldDropEventForSessionFilter` — the filter looks
 * up the new id in `childSessionIds`, and the child wouldn't be in there yet
 * without this registration step.
 *
 * Mutates `childSessionIds` in place; returns whether a registration
 * happened so callers can assert/trace it.
 */
export function registerChildSessionFromCreated(ev, viewedSessionId, childSessionIds) {
  if (ev.type !== "session.created") return false;
  const info = ev.properties?.info;
  if (!info || info.parentID !== viewedSessionId) return false;
  if (typeof info.id !== "string" || info.id.length === 0) return false;
  if (childSessionIds.has(info.id)) return false;
  childSessionIds.add(info.id);
  return true;
}

/**
 * Per-session early-return guard for the opencode event handler.
 *
 * Returns true when the event should be dropped because it's scoped to a
 * different session AND not a known child subagent AND not a self-filtering
 * lifecycle event.
 *
 * The three pass-through cases:
 *   - `evSessionID === viewedSessionId` → main session event.
 *   - `evSessionID ∈ childSessionIds` → known subagent child.
 *   - `isSelfFilteringLifecycleEvent(ev.type)` → question.* / permission.*
 *
 * Empty/missing `properties.sessionID` also passes through — some events
 * carry no sessionID and would otherwise be silently dropped.
 */
export function shouldDropEventForSessionFilter(ev, viewedSessionId, childSessionIds) {
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
 *  - question.asked    → upsert the QuestionRequest from the event payload
 *  - question.replied  → remove it (answered)
 *  - question.rejected → remove it (dismissed)
 *
 * Filtered to the viewed session. Pure (prev list + event → next list).
 */
export function applyQuestionEvent(prev, eventType, properties, viewedSessionId) {
  const p = properties ?? {};
  const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";
  const tool = p.tool;
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
      ].filter((x) => typeof x === "string" && x.length > 0),
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
    if (sessionID !== viewedSessionId) return prev;
    if (!Array.isArray(p.questions)) return prev;
    const next = {
      id,
      sessionID,
      questions: p.questions,
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
 * Fold a permission lifecycle event into the pending-permissions list.
 * The permission twin of applyQuestionEvent, simpler because a permission has
 * no tool/callID indirection: `properties.id` (perm_…) is both the store key
 * and the reply key.
 *
 * - permission.asked    → append (dedupe on id; ignore other sessions)
 * - permission.replied / permission.rejected → remove by id
 */
export function applyPermissionEvent(prev, eventType, properties, viewedSessionId) {
  const p = properties ?? {};
  const id = typeof p.id === "string" ? p.id : "";
  if (eventType === "permission.replied" || eventType === "permission.rejected") {
    if (!id) return prev;
    return prev.filter((perm) => perm?.id !== id);
  }
  if (eventType === "permission.asked") {
    if (!id) return prev;
    const sessionID = typeof p.sessionID === "string" ? p.sessionID : "";
    if (sessionID !== viewedSessionId) return prev;
    const without = prev.filter((perm) => perm?.id !== id);
    return [...without, p];
  }
  return prev;
}

/**
 * Normalize a server `GET /question` response row into the QuestionLike shape
 * used by applyQuestionEvent's output. The server returns
 * `{id: "que_…", sessionID, questions, tool}`; the caller keeps a separate
 * `requestId` field because the live-event path treats `id` as the dedup key
 * (= callID when available). Without this normalization step, a card rendered
 * from GET hydrate looks correct but reply errors with "reply token was not
 * captured" because `requestId` is undefined.
 */
export function hydrateQuestion(server) {
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

// === Transcript-derived turn completion ===
//
// `isAssistantTurnComplete` derives completion from the authoritative
// server-side transcript: an assistant message carries `time.completed`
// (a unix-ms stamp) only once opencode has fully finished that turn. It is a
// self-healing fallback for a missed `session.idle` and cannot
// false-positive mid-turn.
//
// Returns:
//   - false  → a turn is in flight (last message is a user message, or the
//              last assistant message has no completion stamp).
//   - true   → the last assistant turn is complete server-side. Empty
//              transcript is also "complete" (nothing is running).
export function isAssistantTurnComplete(messages) {
  if (!messages || messages.length === 0) return true;
  const last = messages[messages.length - 1];
  if (last.info.role !== "assistant") return false;
  const completed = last.info.time?.completed;
  return typeof completed === "number" && completed > 0;
}

// ===== Subagent (Task tool / child session) helpers =====
//
// The opencode "task" tool spawns a CHILD session and waits for it to finish.
// On the wire, the parent's task tool part carries:
//   - state.input: { description, prompt, subagent_type }
//   - state.metadata.sessionId: the child session's id
//   - state.status: "pending" | "running" | "completed" | "error"
// These helpers produce the allowlist the per-session filter consults, the
// running count, and a collapsed summary.

/**
 * Extract subagent info from any part. Returns null when the part isn't a
 * task tool call or hasn't been stamped with a child sessionId yet.
 */
export function extractSubagentInfo(part) {
  if (!part || part.type !== "tool" || part.tool !== "task") return null;
  const state = part.state ?? {};
  const meta = state.metadata ?? {};
  const childSessionId =
    typeof meta.sessionId === "string" && meta.sessionId.length > 0
      ? meta.sessionId
      : null;
  if (!childSessionId) return null;
  const input = state.input ?? {};
  const status = (() => {
    const s = typeof state.status === "string" ? state.status : "";
    if (s === "pending" || s === "running" || s === "completed" || s === "error") return s;
    return "unknown";
  })();
  const time = state.time ?? {};
  const durationMs =
    typeof time.start === "number" && typeof time.end === "number" && time.end >= time.start
      ? time.end - time.start
      : null;
  const modelRaw = meta.model;
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
    background: meta.background === true,
    durationMs,
    model,
  };
}

/**
 * Walk a transcript and collect every child session id mentioned in any task
 * tool part. Used to seed the `childSessionIds` allowlist so the sessionID
 * filter lets child events through even before the live `session.created`
 * arrives. Safe with undefined / null / empty inputs.
 */
export function collectChildSessionIds(messages) {
  const out = new Set();
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
 * `session.idle` arrives, the caller maps its sessionId → "idle" and passes
 * it here so we don't keep counting subagents that just finished.
 *
 * `liveStatus` keys are child session ids; values are "running" | "idle".
 */
export function countRunningSubagents(messages, liveStatus) {
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
      if (info.status === "running" || info.status === "pending") n++;
    }
  }
  return n;
}

/**
 * Lightweight summary of a child session's transcript, for the collapsed
 * TaskBody header (tool count, last tool name, cumulative tokens scraped from
 * the child's step-finish parts). Returns zeros for an empty/null transcript.
 */
export function summarizeChildSession(messages) {
  let toolCount = 0;
  let lastToolName = null;
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
// `isAssistantTurnComplete`. On a fresh mount we fetch the authoritative
// transcript; if the last message is an assistant turn with no
// `time.completed` stamp, that turn is either running or WEDGED — either way
// the UI must show `running` so the abort affordance is available.
//
// SAFE ONLY AT MOUNT. Unlike the one-way clear in `isAssistantTurnComplete`,
// this can set `running` true — which would race the optimistic-send path and
// live `session.status` events if used on a live refetch. Call it once, from
// the initial-load effect, before any local send can have happened.
//
// A trailing `user` message returns false; empty transcript → false.
export function isAssistantTurnInProgress(messages) {
  if (!messages || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.info.role !== "assistant") return false;
  const completed = last.info.time?.completed;
  return !(typeof completed === "number" && completed > 0);
}

// ── Auto-rename session ───────────────────────────────────────────────────
// When `autoRenameSessions` is enabled, the box periodically asks opencode to
// summarize the recent conversation into a short 3-6 word tmux window name.
// These pure helpers make the trigger cadence, the prompt input, and the
// title sanitization testable without spinning up a session.

// How many completed user turns between auto-rename attempts. The summarize
// path spawns a throwaway opencode session (~9s), so we don't run it every
// turn — every Nth turn keeps the cost occasional while still tracking topic
// shifts within a long session.
export const AUTO_RENAME_EVERY_N_TURNS = 5;

// Hard cap on characters fed to the summarizer. We take the most RECENT text
// so the name tracks where the work has moved, not where it began.
const TITLE_INPUT_MAX_CHARS = 2000;

// Max length of the final window name. tmux truncates long names in the
// status line and our sidebar; a 3-6 word title should never approach this,
// but we clamp defensively so a misbehaving model can't write an essay.
const TITLE_MAX_CHARS = 48;

/**
 * Should an auto-rename fire at this user-turn count? True on every Nth
 * completed user turn (1-indexed), i.e. turns 5, 10, 15… for N=5. Turn 0
 * (no user turns yet) never fires. Pure so the cadence is unit-testable.
 */
export function shouldAutoRename(userTurnCount, everyN = AUTO_RENAME_EVERY_N_TURNS) {
  if (everyN <= 0) return false;
  if (userTurnCount <= 0) return false;
  return userTurnCount % everyN === 0;
}

// Extract the non-synthetic, non-ignored text/reasoning content from a list
// of parts, joined with newlines. Used to count user turns and build the
// summarizer input.
function extractTextFromParts(parts) {
  const out = [];
  for (const p of parts) {
    if (p.type !== "text" && p.type !== "reasoning") continue;
    if (p.synthetic || p.ignored) continue;
    if (typeof p.text === "string" && p.text.trim()) out.push(p.text);
  }
  return out.join("\n");
}

/**
 * Count completed user turns in a transcript. A "turn" is a user-role message
 * that carries at least one non-synthetic, non-ignored text part — synthetic
 * messages (command expansions, tool stubs) and empty placeholders don't
 * count toward the rename cadence.
 */
export function countUserTurns(messages) {
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    if (m.info.role !== "user") continue;
    if (extractTextFromParts(m.parts).trim().length > 0) n += 1;
  }
  return n;
}

/**
 * Build the summarizer input string from a transcript: the most recent
 * user+assistant text, oldest-first, truncated to TITLE_INPUT_MAX_CHARS by
 * KEEPING THE TAIL (the latest work). Returns "" when there's nothing to
 * summarize (caller should skip the rename). Pure + tested.
 */
export function buildTitlePromptInput(messages) {
  if (!messages) return "";
  const lines = [];
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
 * Strips surrounding quotes/markdown/punctuation, collapses whitespace, takes
 * at most the first six words, preserves the model's sentence case, and
 * clamps length (cutting at a word boundary when possible). Returns "" when
 * nothing usable remains (caller MUST skip the rename rather than blank the
 * window name — the rename IPC rejects empty names anyway). Pure + tested.
 */
export function sanitizeGeneratedTitle(raw) {
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

// The instruction sent to the throwaway opencode session. Kept here so the
// server, renderer and tests share one source of truth.
export function buildTitleInstruction(conversation) {
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
