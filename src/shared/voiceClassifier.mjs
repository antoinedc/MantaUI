// voiceClassifier.mjs — pure rules-based router for voice-command utterances.
//
// Used by BOTH transports (src/main/index.ts via Bundler .mjs import, and
// src/server/index.mjs via native ESM) and the renderer (imported indirectly
// via the IPC result type). Keep it dependency-free so it stays portable.
//
// Strategy: short whitelist of verbs + regex matchers. Returns a structured
// VoiceAction (see src/shared/types.ts) when a match is confident, null
// otherwise. The caller decides whether to fall back to an LLM classifier.
//
// Design choices baked in here — do NOT regress:
//   - Normalization strips Whisper's chronic punctuation noise BEFORE matching
//     ("Send.", "Clear!", "Compact, please." all match).
//   - Word-boundary anchors (e.g. /\bcompact\b/) — matching "act" inside
//     "context" used to misfire as `compact`.
//   - Numbers: written digits ("two", "three") AND figures ("2", "3") map to
//     the same int via wordToNumber(); the model/window matchers consume both.
//   - Multi-word verbs ("hold on" → abort, "go ahead" → allow-once) earn
//     their place only if Whisper transcribes them stably; add tests when
//     extending.
//   - When in doubt, return null and let the LLM fallback decide. Better to
//     pay $0.0001 than to mis-fire a destructive action.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** @param {string} word @returns {number | null} */
function wordToNumber(word) {
  const w = word.toLowerCase();
  if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
  const n = Number.parseInt(w, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Normalize a Whisper transcript for rule matching. Lowercase, strip
 * surrounding whitespace + trailing punctuation, collapse runs of spaces.
 * Internal punctuation is preserved (verbs anchor on \b so commas don't
 * matter, but contractions like "don't" must survive).
 * @param {string} raw
 */
export function normalizeTranscript(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/^[\s"'`]+|[\s"'`.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Run the rules classifier on a transcript. Returns a VoiceAction or null.
 *
 * Match priority (first match wins — order matters):
 *   1. Pure dispatch verbs (clear/compact/fork/abort/help/trust)
 *   2. Permission replies (allow-once / allow-always / reject)
 *   3. Question answers ("answer N" / "option N" / "yes" / "no")
 *   4. Model switch ("use opus" / "switch to sonnet")
 *   5. Window switch ("window 3" / "session 3" / "go to 3")
 *   6. New session / settings
 *   7. Append-to-input ("append <text>" / "type <text>" / "insert <text>")
 *   8. Submit prefix ("send <text>" / "submit <text>") — text becomes the
 *      message body.
 *
 * @param {string} transcript
 * @returns {import("./types.js").VoiceAction | null}
 */
export function classifyByRules(transcript) {
  const t = normalizeTranscript(transcript);
  if (!t) return null;

  // 1. Dispatch verbs — exact or near-exact phrases. Single-word matches
  //    require the WHOLE utterance to be that word so "compact the response"
  //    isn't routed to the destructive /compact action.
  if (/^(clear(\s+(this|the)?\s*(session|chat|history))?|new\s+chat|start\s+over)$/.test(t)) {
    return { kind: "clear" };
  }
  if (/^(compact|compact\s+(this|the)?\s*(session|chat|context|history))$/.test(t)) {
    return { kind: "compact" };
  }
  if (/^(fork|fork\s+(this|the)?\s*(session|chat))$/.test(t)) {
    return { kind: "fork" };
  }
  if (/^(abort|stop|cancel|halt|hold\s+on|never\s+mind|nevermind|escape|interrupt)$/.test(t)) {
    return { kind: "abort" };
  }
  if (/^(help|show\s+help|what\s+can\s+(i|you)\s+(do|say))$/.test(t)) {
    return { kind: "help" };
  }
  if (/^(toggle\s+trust|toggle\s+(auto[\s-]?allow|bypass)|trust\s+mode|bypass\s+permissions)$/.test(t)) {
    return { kind: "toggle-trust" };
  }
  if (/^(open\s+)?settings$/.test(t)) {
    return { kind: "open-settings" };
  }
  if (/^(new\s+(session|window|chat)|create\s+(a\s+)?new\s+(session|window|chat))$/.test(t)) {
    return { kind: "new-session" };
  }

  // 2. Permission replies. Multi-token to dodge the "yes"/"no" question path.
  if (/^(allow\s+once|approve\s+once|just\s+this\s+time|once)$/.test(t)) {
    return { kind: "allow-once" };
  }
  if (/^(allow\s+always|always\s+allow|approve\s+always|always)$/.test(t)) {
    return { kind: "allow-always" };
  }
  if (/^(reject|deny|don'?t\s+allow|refuse|block)$/.test(t)) {
    return { kind: "reject" };
  }

  // 3. Question answers
  //    "answer two", "option 3", "pick yes", "choose first" — explicit prefix.
  //    Bare "yes"/"no" also map to answer (the renderer matches case-insensitive
  //    to a QuestionOption.label; if no option matches, the action is a no-op).
  let m;
  m = t.match(/^(?:answer|option|choice|pick|choose|select)\s+(.+)$/);
  if (m) {
    const rest = m[1].trim();
    // Numeric choice → keep the digit so renderer can match by index OR by
    // a label like "1. yes". Word numbers get expanded.
    const asNum = wordToNumber(rest.split(/\s+/)[0]);
    if (asNum != null) {
      return { kind: "answer", choice: String(asNum) };
    }
    return { kind: "answer", choice: rest };
  }
  if (/^(yes|yeah|yep|sure|ok|okay|go\s+ahead|do\s+it|proceed|confirm)$/.test(t)) {
    return { kind: "answer", choice: "yes" };
  }
  if (/^(no|nope|nah|negative)$/.test(t)) {
    return { kind: "answer", choice: "no" };
  }

  // 4. Model switch — common families. Renderer fuzzy-matches the query to
  //    the available models list; we just pass the raw token.
  m = t.match(/^(?:(?:switch|change)\s+to|use|set\s+model\s+to|model)\s+(.+)$/);
  if (m) {
    return { kind: "model", query: m[1].trim() };
  }

  // 5. Window / session switch — 1-based flat index over sidebar tuple list.
  m = t.match(/^(?:go\s+to|switch\s+to|open|window|session|tab)\s+(?:window\s+|session\s+|tab\s+|number\s+|#)?(\S+)$/);
  if (m) {
    const n = wordToNumber(m[1]);
    if (n != null && n >= 1 && n <= 9) {
      return { kind: "switch-window", index: n };
    }
  }
  m = t.match(/^(window|session|tab)\s+(\S+)$/);
  if (m) {
    const n = wordToNumber(m[2]);
    if (n != null && n >= 1 && n <= 9) {
      return { kind: "switch-window", index: n };
    }
  }

  // 6. Explicit dictation prefix — text is appended to the textarea, NOT sent.
  //    "type ..." / "insert ..." / "append ...". Useful in command mode when
  //    the user wants to dictate without immediately submitting.
  m = t.match(/^(?:type|insert|append|dictate|write)\s+(.+)$/);
  if (m) {
    return { kind: "append", text: m[1].trim() };
  }

  // 7. Explicit submit prefix — text becomes the message body and sends.
  //    "send <body>" / "submit <body>" / "ask <body>".
  m = t.match(/^(?:send|submit|ask|prompt)\s+(.+)$/);
  if (m) {
    return { kind: "submit", text: m[1].trim() };
  }

  return null;
}

/**
 * Build the system prompt + user prompt for the Groq LLM fallback. Returns
 * an object the caller passes to chat/completions with JSON response_format.
 * Kept pure (no fetch) so it's unit-testable and the client module owns the
 * HTTP concern.
 *
 * The shape we ask the LLM to emit is { kind: <one of>, ... } — same as
 * VoiceAction but constrained. The classifier endpoint validates the
 * response before returning to the renderer, so a malformed reply degrades
 * to { kind: "unknown", transcript }.
 *
 * @param {string} transcript
 * @returns {{ system: string; user: string }}
 */
export function buildClassifierPrompt(transcript) {
  const system = [
    "You route voice commands for a code-assistant chat app to a small set of actions.",
    "Reply with a JSON object — no prose, no markdown, just JSON.",
    "Allowed shapes (pick exactly one):",
    '  {"kind":"submit","text":"<message body>"}              — send a prompt to the AI',
    '  {"kind":"append","text":"<text>"}                       — insert into composer without sending',
    '  {"kind":"clear"}                                        — /clear the session',
    '  {"kind":"compact"}                                      — /compact to free context',
    '  {"kind":"fork"}                                         — fork to a new session',
    '  {"kind":"abort"}                                        — interrupt running generation',
    '  {"kind":"help"}                                         — show help',
    '  {"kind":"toggle-trust"}                                 — toggle auto-allow permissions',
    '  {"kind":"allow-once"} | {"kind":"allow-always"} | {"kind":"reject"}  — answer a permission prompt',
    '  {"kind":"answer","choice":"<option label or number>"}   — answer a Question tool prompt',
    '  {"kind":"model","query":"<spoken model name>"}          — switch model',
    '  {"kind":"switch-window","index":<1-9>}                  — jump to a session in the sidebar',
    '  {"kind":"new-session"} | {"kind":"open-settings"}',
    '  {"kind":"unknown","transcript":"<verbatim>"}            — when nothing fits',
    "Rules:",
    "- Prefer `submit` for sentence-like utterances directed AT the assistant.",
    "- Prefer `append` only when the user explicitly says insert/append/type/write.",
    "- Use `unknown` if the intent is ambiguous; never guess destructive actions.",
  ].join("\n");
  const user = `Transcript: ${JSON.stringify(transcript)}`;
  return { system, user };
}

/**
 * Validate a parsed LLM reply and coerce it to a VoiceAction. Returns null
 * when the shape doesn't match anything we recognize. Kept pure for testing.
 *
 * @param {unknown} parsed
 * @returns {import("./types.js").VoiceAction | null}
 */
export function coerceLlmAction(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  const kind = obj.kind;
  if (typeof kind !== "string") return null;
  switch (kind) {
    case "submit":
    case "append":
      if (typeof obj.text === "string" && obj.text.trim()) {
        return { kind, text: obj.text.trim() };
      }
      return null;
    case "clear":
    case "compact":
    case "fork":
    case "abort":
    case "help":
    case "toggle-trust":
    case "allow-once":
    case "allow-always":
    case "reject":
    case "new-session":
    case "open-settings":
      return { kind };
    case "answer":
      if (typeof obj.choice === "string" && obj.choice.trim()) {
        return { kind: "answer", choice: obj.choice.trim() };
      }
      return null;
    case "model":
      if (typeof obj.query === "string" && obj.query.trim()) {
        return { kind: "model", query: obj.query.trim() };
      }
      return null;
    case "switch-window": {
      // Strict: index must be a real number, not a numeric string. A
      // string here means the LLM didn't follow the JSON schema — better
      // to fail closed and degrade to "unknown" than to risk handing a
      // surprise type to the renderer's switch-case handler.
      if (typeof obj.index !== "number") return null;
      const idx = obj.index;
      if (Number.isInteger(idx) && idx >= 1 && idx <= 9) {
        return { kind: "switch-window", index: idx };
      }
      return null;
    }
    case "unknown":
      return {
        kind: "unknown",
        transcript: typeof obj.transcript === "string" ? obj.transcript : "",
      };
    default:
      return null;
  }
}
