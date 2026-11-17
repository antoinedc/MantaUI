// repoBlock.mjs — the managed AGENTS.md block the curator writes into a repository (spec §4.1).
//
// Pure text logic, no I/O:
//   • sanitizeRule / renderBlock: repo-facing text is one rule per line plus an optional one-line
//     reason — never transcript quotes, session ids or message refs. They are stripped, then asserted.
//   • findBlock / applyBlock: locate and replace/append/remove the block between the markers,
//     leaving every other byte of the file alone.
//   • hashBlock: the hash the hand-edit baseline is kept in.

import { createHash } from "node:crypto";

export const START_MARKER = "<!-- manta:knowledge:start -->";
export const END_MARKER = "<!-- manta:knowledge:end -->";
export const BLOCK_HEADING = "## Project rules (managed by Manta)";
export const BLOCK_BUDGET_LINES = 120;
export const MAX_RULE_CHARS = 300;

// Ref grammar entries that point into the box (messages, parts, store pages, box-local files) and
// opencode's own id shapes. Commits, PRs and URLs are public by nature and stay.
const REF_RES = [
  /\b(?:msg|part|page|file):[^\s)\],;]+/gi,
  /\bses_[A-Za-z0-9]{6,}\b/g,
  /\b(?:msg|prt)_[A-Za-z0-9]{6,}\b/g,
  /\b[ndbc]_[0-9A-Za-z]{20,}\b/g,
];
const COMMENT_RE = /<!--[\s\S]*?-->/g;

const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n");

/**
 * One safe repo-facing rule line, or null when nothing is left. HTML comments (a rule can never
 * carry a marker), refs, session/message ids, blockquote/heading/bullet leaders are removed and
 * whitespace collapsed onto one line.
 */
export function sanitizeRule(raw) {
  let t = norm(raw);
  t = t.replace(COMMENT_RE, " ");
  for (const re of REF_RES) t = t.replace(re, " ");
  t = t
    .split("\n")
    .map((l) => l.replace(/^\s*(?:>+|#{1,6}|[-*+]|\d+[.)])\s*/, ""))
    .join(" ");
  t = t.replace(/`{3,}/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[(\[]\s*[)\]]/g, "").trim(); // brackets left empty by a stripped ref
  if (t.length > MAX_RULE_CHARS) t = `${t.slice(0, MAX_RULE_CHARS - 1).trimEnd()}…`;
  return t === "" ? null : t;
}

/** Reasons `text` must not be written to a repository (empty = safe). */
export function repoTextViolations(text) {
  const t = norm(text);
  const out = [];
  for (const re of REF_RES) {
    re.lastIndex = 0;
    if (re.test(t)) out.push("contains a message, session or store reference");
    re.lastIndex = 0;
  }
  if (/^\s*>/m.test(t)) out.push("contains a quoted passage");
  return [...new Set(out)];
}

/** Throws when `text` carries anything repoTextViolations reports. */
export function assertRepoSafe(text) {
  const v = repoTextViolations(text);
  if (v.length) throw new Error(`Repository text ${v.join("; ")}.`);
  return text;
}

/**
 * Render the managed block. `rules` is the complete rule set (strings, optionally with a one-line
 * reason after an em dash). Returns `{ block, rules, dropped, truncated }`; `block` is null when no
 * rule survives (the caller then removes an existing block).
 */
export function renderBlock(rules, { budgetLines = BLOCK_BUDGET_LINES } = {}) {
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of Array.isArray(rules) ? rules : []) {
    const clean = sanitizeRule(raw);
    if (clean === null) {
      dropped.push({ rule: String(raw ?? "").slice(0, 80), reason: "empty after removing references" });
      continue;
    }
    if (repoTextViolations(clean).length) {
      dropped.push({ rule: clean.slice(0, 80), reason: "still carries a reference" });
      continue;
    }
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(clean);
  }
  // start marker, heading, blank line, rules…, end marker
  const overhead = 4;
  const room = Math.max(0, budgetLines - overhead);
  const truncated = Math.max(0, kept.length - room);
  const final = kept.slice(0, room);
  if (final.length === 0) return { block: null, rules: [], dropped, truncated };
  const block = [START_MARKER, BLOCK_HEADING, "", ...final.map((r) => `- ${r}`), END_MARKER].join("\n");
  return { block, rules: final, dropped, truncated };
}

/** The rule lines of a block (hand-edited or ours). */
export function parseBlockRules(blockText) {
  return norm(blockText)
    .split("\n")
    .map((l) => /^\s*[-*+]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter(Boolean);
}

/**
 * Locate the block in a file. `{status:"none"}`, `{status:"found", start, end, text}` (end is
 * exclusive, text includes both markers) or `{status:"corrupt", reason}` for an unterminated,
 * orphaned, duplicated or reversed marker pair — the file is then never touched.
 */
export function findBlock(src) {
  const s = norm(src);
  const a = s.indexOf(START_MARKER);
  const b = s.indexOf(END_MARKER);
  if (a < 0 && b < 0) return { status: "none" };
  if (a < 0) return { status: "corrupt", reason: "the file has an end marker but no start marker" };
  if (b < 0) return { status: "corrupt", reason: "the file has a start marker but no end marker" };
  if (b < a) return { status: "corrupt", reason: "the end marker comes before the start marker" };
  if (s.indexOf(START_MARKER, a + START_MARKER.length) >= 0 || s.indexOf(END_MARKER, b + END_MARKER.length) >= 0) {
    return { status: "corrupt", reason: "the file has more than one managed block" };
  }
  const end = b + END_MARKER.length;
  return { status: "found", start: a, end, text: s.slice(a, end) };
}

/** sha256 of a block (line endings normalised, trimmed); null block → null. */
export function hashBlock(blockText) {
  if (blockText === null || blockText === undefined) return null;
  return createHash("sha256").update(norm(blockText).trim()).digest("hex");
}

/**
 * Put `block` into `src`: replace the existing block, or append at the end (after one blank
 * line). `block === null` removes the block and the blank line before it. The file's line
 * endings are kept. Throws on a corrupt marker pair.
 */
export function applyBlock(src, block) {
  const crlf = /\r\n/.test(String(src ?? ""));
  const s = norm(src);
  const f = findBlock(s);
  if (f.status === "corrupt") throw new Error(`The managed block can't be edited: ${f.reason}.`);
  let out;
  if (f.status === "found") {
    if (block === null) {
      const before = s.slice(0, f.start).replace(/\n{2,}$/, "\n");
      const after = s.slice(f.end).replace(/^\n/, "");
      out = before + after;
      if (out.trim() === "") out = "";
    } else out = s.slice(0, f.start) + norm(block) + s.slice(f.end);
  } else if (block === null) out = s;
  else if (s.trim() === "") out = `${norm(block)}\n`;
  else out = `${s.replace(/\n*$/, "\n")}\n${norm(block)}\n`;
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}
