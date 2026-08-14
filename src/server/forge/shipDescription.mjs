// shipDescription.mjs — pure helpers for generating a PR title + body with the
// session's selected model, OUT OF BAND (BET-893).
//
// Everything in this module is pure: no I/O, no opencode, no network — so it
// is unit-testable in isolation. `shipPreview` in index.mjs owns the I/O
// (spinning up a throwaway opencode session, polling it, deleting it) and the
// fallback to the deterministic `draftTitle` / `draftBody`; it is only here to
// turn the raw inputs into a prompt and to turn the model's raw reply into a
// `{ title, body }`.

// Hard cap on how much transcript context we hand the model. The conversation
// is the *why* behind the diff — that is the point — but a whole session is
// too much. Oldest text drops first so the model sees the most recent context.
export const TRANSCRIPT_CHAR_CAP = 8000;

// Default: how many trailing transcript messages count as context.
export const DEFAULT_LAST_MESSAGES = 20;

/** Join the `text` parts of the LAST `last` messages of an opencode transcript
 *  into one string (one part per line). Only `text` parts count — tool calls,
 *  tool output and other part types are dropped. Oldest selected message first.
 */
export function extractTranscriptText(messages, { last = DEFAULT_LAST_MESSAGES } = {}) {
  if (!Array.isArray(messages)) return "";
  const selected = messages.slice(-last);
  const lines = [];
  for (const m of selected) {
    for (const p of m?.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text) lines.push(p.text);
    }
  }
  return lines.join("\n");
}

/** The raw concatenated assistant text from a transcript — used to detect that
 *  the throwaway session's generation produced a reply. Returns `""` while no
 *  assistant text is present (generation still running). The text is NOT
 *  trimmed here so a whitespace-only reply stays distinguishable from "nothing
 *  yet" — `parsePrDescription` (which trims the title line) decides whether a
 *  non-empty reply is actually usable.
 */
export function extractAssistantText(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role !== "assistant") continue;
    for (const p of m?.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    }
  }
  return out.join("");
}

/** Truncate a transcript string to the character cap, dropping the OLDEST text
 *  first (keep the newest tail). A string already under the cap is returned
 *  unchanged.
 */
export function truncateTranscript(text, cap = TRANSCRIPT_CHAR_CAP) {
  const s = String(text ?? "");
  if (s.length <= cap) return s;
  return s.slice(s.length - cap);
}

/** Build the prompt for the out-of-band PR-description generation.
 *
 *  The output contract is stated IN the prompt: first line = title (max 72
 *  chars, no trailing period), then a blank line, then the markdown body. A
 *  non-empty repo template is FILLED IN rather than replaced. The transcript
 *  (the *why*) is truncated to the 8000-char cap, oldest first.
 */
export function buildPrDescriptionPrompt({ head, base, files, commits, template, transcript } = {}) {
  const parts = [
    "You are helping open a pull request for the branch currently open in Manta.",
    "Write the pull request title and description for these changes.",
    "Output contract: the FIRST line is the title (max 72 chars, no trailing period).",
    "Then a BLANK line. Then the description body in markdown.",
  ];

  const tpl = String(template ?? "").trim();
  if (tpl) {
    parts.push("", "The repository has a pull-request template. FILL IT IN rather than replacing it:", "", tpl);
  }

  if (Array.isArray(commits) && commits.length) {
    parts.push("", "Commits since the base branch:", ...commits.map((c) => `- ${c}`));
  }

  if (Array.isArray(files) && files.length) {
    parts.push("", "Changed files:", ...files.map((f) => `- ${f}`));
  }

  const branch = [head, base].filter(Boolean).join(" → ");
  if (branch) parts.push("", `Branch: ${branch}`);

  const ctxText = truncateTranscript(transcript);
  if (ctxText) {
    parts.push("", "Relevant conversation transcript (context — the *why* behind these changes):", "", ctxText);
  }

  return parts.join("\n");
}

/** Parse the model's reply into a `{ title, body }` PR draft. The first non-empty
 *  line is the title; everything after it is the body (trimmed). Trust the model
 *  on length — a title over 72 chars is returned as-is, never silently truncated
 *  (the prompt requested ≤72; parsing must not second-guess the model). Returns
 *  null only for genuinely unparseable input (not a string, or an empty title).
 */
export function parsePrDescription(text) {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  const title = (lines[0] ?? "").trim();
  if (!title) return null;
  const body = lines.slice(1).join("\n").trim();
  return { title, body };
}
