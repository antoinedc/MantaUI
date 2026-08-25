// constraintPin.mjs — preserve the user's standing instructions across
// background compaction (Optimizer P2.4, BET-1346, Part B).
//
// The whole point of compaction is to summarise history; a summariser
// silently loses whatever it was not told to keep. A conversation that has
// accumulated coding conventions, "don't touch this file", output format,
// language, etc. is a conversation whose standing instructions MUST survive a
// compaction. opencode's own compaction prompt has no idea they exist.
//
// This module is PURE: it knows how to ASK (the extraction prompt), how to
// NORMALISE the model's reply into a clean list (parseConstraints), how to
// RENDER that list into a fixed block (renderConstraintBlock), and how to
// APPEND it to opencode's own compaction prompt (buildCompactionPrompt —
// append ONLY, never replace: replacing opencode's prompt is how a summariser
// silently loses everything it was not told to keep).
//
// No node:* imports, no Date.now(), no I/O — everything is a function of the
// inputs, so it is unit-testable without a box.

export const MAX_CONSTRAINTS = 20;
export const MAX_CONSTRAINT_CHARS = 300;

/**
 * The verbatim extraction prompt handed to the cheap throwaway-session model
 * at compaction time. Copy this string EXACTLY — it is the contract with the
 * model. It demands verbatim, one-per-line output with no commentary, so the
 * parser below can rely on line-oriented output.
 */
export const CONSTRAINT_EXTRACT_PROMPT =
  "List every standing instruction the user gave in this conversation that must still apply after the history is summarized — coding conventions, tools to avoid, files not to touch, output format, language. One per line, copied VERBATIM from the user's own words. No commentary, no numbering, no invention. If there are none, output nothing.";

// Strip a single leading bullet or numbering token so the model saying
// "- use tabs" or "1. use tabs" still yields a clean verbatim line. A line
// that is ONLY a prefix ("-", "1.") collapses to "".
function stripPrefix(line) {
  let s = line.trim();
  s = s.replace(/^[-\*\+•]\s*/, "");
  s = s.replace(/^(?:\d+[\.\):]|\(\d+\))\s*/, "");
  return s.trim();
}

/**
 * PURE. Normalise the extraction model's raw reply into a clean constraint
 * list. Splits on newlines, trims, drops empty lines, strips pure
 * numbering/bullet prefixes, caps the list at MAX_CONSTRAINTS and each line at
 * MAX_CONSTRAINT_CHARS, and de-duplicates case-insensitively. Never throws;
 * garbage in → [].
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseConstraints(raw) {
  if (typeof raw !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const line of raw.split("\n")) {
    const cleaned = stripPrefix(line);
    if (cleaned === "") continue;
    if (out.length >= MAX_CONSTRAINTS) break;
    const capped = cleaned.length > MAX_CONSTRAINT_CHARS ? cleaned.slice(0, MAX_CONSTRAINT_CHARS) : cleaned;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
  }
  return out;
}

/**
 * PURE. Render a constraint list into the fixed block appended to the
 * compaction prompt. Returns "" for an empty list (nothing to brace). The
 * prose line is fixed and load-bearing — it is what tells the summariser these
 * lines are verbatim user instructions, not new guidance.
 *
 * @param {string[]} constraints
 * @returns {string}
 */
export function renderConstraintBlock(constraints) {
  const list = Array.isArray(constraints) ? constraints.filter((c) => typeof c === "string" && c.trim() !== "") : [];
  if (list.length === 0) return "";
  return (
    "\n\nStanding instructions from the user, preserved verbatim across compaction:\n" +
    list.map((c) => "- " + c).join("\n")
  );
}

/**
 * PURE. Build the effective compaction prompt: opencode's own base prompt plus
 * (when there are constraints) the constraint block. APPEND ONLY — the base
 * prompt must always be a prefix of the result, so a summariser can never
 * lose opencode's own summarisation guidance.
 *
 * @param {string} basePrompt
 * @param {string[]} constraints
 * @returns {string}
 */
export function buildCompactionPrompt(basePrompt, constraints) {
  return (typeof basePrompt === "string" ? basePrompt : "") + renderConstraintBlock(constraints);
}
