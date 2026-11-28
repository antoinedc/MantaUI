// How alike are two handoff briefs? (spec 2026-11-28-research-layer.md §6.5). Cheap and deterministic: no model call, no embeddings.
//
//   brief + title → boilerplate removed → content words (stemmed, a set ≤ 40; title words count twice) → "signature"
//   similarity = IDF-weighted Jaccard of two signatures, idf taken over the stored signatures
//   a new signature joins the best of the 5 stored candidates MiniSearch retrieves, when the similarity reaches SIMILARITY_THRESHOLD
//
// SIMILARITY_THRESHOLD is not a number picked in advance: briefSimilarity.test.mjs sweeps thresholds over the labelled pairs of
// fixtures/briefSimilarity.json and fails when the constant is not the value the sweep picks, so changing the fixture or anything
// below forces a re-tune. Pure functions only; the store that remembers signatures is agentSuggestions.mjs.

import { createHash } from "node:crypto";
import MiniSearch from "minisearch";

/**
 * BLOCKED, NOT TUNED: on the fixture no threshold meets the AC-4.2 targets (best case: precision 1.00, recall 0.27, templated recall 0.70 at
 * 0.225, which is the placeholder below: the highest-precision point with no hard negative leaking). The spec says slice 4 then does not ship.
 * Once a better measure exists: change it, run the test, copy the number the sweep asks for.
 */
export const SIMILARITY_THRESHOLD = 0.225;
/** A brief is compared with the "don't ask again" set at this share of the clustering threshold, to err on the side of silence. */
export const SUPPRESSION_FACTOR = 0.8;

export const SIGNATURE_TOKENS_MAX = 40;
export const SIGNATURE_BRIEF_CHARS = 600;
export const TITLE_WEIGHT = 2;
export const CANDIDATES = 5;
export const LEARNED_LINE_SHARE = 0.3; // a whole line found in this share of the stored briefs is template, not content
export const LEARNED_LINE_MIN = 10; // ... once there are this many briefs
export const COMMON_TOKEN_SHARE = 0.5; // a word found in more than this share of the stored signatures says nothing
export const COMMON_TOKEN_MIN = 10; // ... once there are this many signatures

// ---- boilerplate: the fixed headings and labels of the brief template Manta's instructions ask for, and the dispatch markers ----

export const FIXED_TEMPLATE_LABELS = [
  "goal",
  "why",
  "scope",
  "in scope",
  "out of scope",
  "scope in",
  "scope out",
  "done when",
  "done",
  "definition of done",
  "output wanted",
  "output",
  "decisions already made",
  "decisions",
  "context",
  "background",
  "constraints",
  "acceptance criteria",
  "files to read first",
  "report",
  "report format",
  "hand-off",
  "handoff",
  "verification",
  "notes",
  "the user's words",
  "your brief for this project",
  "recent conversation in the chat that asked you (oldest first), for context",
];
const LABEL_ALT = [...FIXED_TEMPLATE_LABELS].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const MARKUP = /^\s*(?:#{1,6}\s+|[-*•>]\s+|\d{1,2}[.)]\s+)*/; // heading / bullet / number markup at the start of a line
const EMPHASIS = /(\*\*|__|`)/g;
const LABEL_LINE = new RegExp(`^(?:${LABEL_ALT})\\s*:?$`, "i"); // the whole line is a heading
const LABEL_PREFIX = new RegExp(`^(?:${LABEL_ALT})\\s*[:—–-]\\s+`, "i"); // "Goal: …" keeps the "…"
const RULE_LINE = /^[-=_*\s]{3,}$/; // markdown rules and the dispatch block separator

const wsNorm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/** One line of a brief with its markup and its label removed; "" when the line is pure template. */
function contentOfLine(rawLine) {
  let line = String(rawLine ?? "").replace(MARKUP, "").replace(EMPHASIS, "").trim();
  if (!line || RULE_LINE.test(line) || LABEL_LINE.test(line)) return "";
  return line.replace(LABEL_PREFIX, "").trim();
}

/** The key a learned-template statistic is kept under: the normalised line (lowercase, spaces collapsed, digits → 0), hashed. */
export const lineKey = (line) => createHash("sha1").update(wsNorm(line).toLowerCase().replace(/\d/g, "0")).digest("hex").slice(0, 12);

/** The distinct line keys of a brief, after the fixed template is removed. The store counts these (hashes only, never text). */
export function lineKeysOf(brief) {
  const keys = new Set();
  for (const raw of String(brief ?? "").split(/\r?\n/)) {
    const line = contentOfLine(raw);
    if (line.length >= 8) keys.add(lineKey(line));
  }
  return [...keys];
}

/** The lines that are template, learned from the briefs seen so far: those present in at least 30 % of them, once there are 10. */
export function learnedLineSet(lineDf, briefCount) {
  const out = new Set();
  if (!(briefCount >= LEARNED_LINE_MIN) || !lineDf) return out;
  const entries = lineDf instanceof Map ? lineDf.entries() : Object.entries(lineDf);
  for (const [key, count] of entries) if (count / briefCount >= LEARNED_LINE_SHARE) out.add(key);
  return out;
}

// ---- words ----

const STOP = new Set(
  (
    "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each " +
    "few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or " +
    "other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us " +
    "very was we were what when where which while who whom why will with would you your yours yet via per etc please get got want wants need needs needed make makes " +
    "made using use used like within without across around onto upon whether either neither may might must shall every anything everything something nothing " +
    "thing things way ways one two three first last next new old still even ever never always often sometimes already really actually maybe both"
  ).split(" "),
);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HEX_ID_RE = /^(?:0x)?[0-9a-f]{7,}$/i;
const FILE_RE = /^[\w-]+(?:\.[\w-]+)*\.[a-z0-9]{1,5}$/i; // upload.test.ts, README.md, example.com
const NUMERIC_RE = /^v?\d+$/i;
const EDGE = /^[("'[{<]+|[.,;:!?)"'\]}>]+$/g;

/** Whether a whitespace-separated chunk of a brief is a path, URL, id, file name or code identifier, which carries no word of the work's kind. */
function isCodeLike(chunk) {
  if (URL_RE.test(chunk) || /[\\/]/.test(chunk)) return true;
  if (/_/.test(chunk) || /[a-z][A-Z]/.test(chunk)) return true; // snake_case, camelCase
  if (HEX_ID_RE.test(chunk) && /\d/.test(chunk)) return true;
  if (FILE_RE.test(chunk) && /[a-z]/i.test(chunk) && !/^[\d.]+$/.test(chunk)) return true;
  return false;
}

/** Light suffix stemming: -ing, -ed, -es/-ies, -s. Both sides of a comparison are stemmed the same way, so consistency is all it needs. */
export function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) {
    w = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1); // running → run
  } else if (w.length > 4 && w.endsWith("ied")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) {
    w = w.slice(0, -2);
    if (/([^aeiou])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(ses|xes|zes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  return w;
}

const defaultTokenize = MiniSearch.getDefault("tokenize");

/** The content words of one text, in order (duplicates kept): code-like chunks and stop words dropped, the rest lowercased and stemmed. */
function wordsOf(text) {
  const kept = [];
  for (const chunk of String(text ?? "").split(/\s+/)) {
    const c = chunk.replace(EDGE, "");
    if (!c || isCodeLike(c)) continue;
    kept.push(c);
  }
  const out = [];
  for (const piece of defaultTokenize(kept.join(" "))) {
    const w = piece.toLowerCase();
    if (w.length < 2 || NUMERIC_RE.test(w) || STOP.has(w)) continue;
    const s = stem(w);
    if (s.length >= 2 && !STOP.has(s)) out.push(s);
  }
  return out;
}

/**
 * The signature of one handoff: `tokens` (the set of content words, at most 40, title words first) and `titleTokens` (the ones that came from
 * the title, which count twice). Boilerplate is removed first: the fixed template lines and labels, then the lines the box has learned are
 * template (`learnedLines`, from `learnedLineSet`). The brief contributes its first 600 characters of what remains.
 */
export function signatureOf({ title = "", brief = "" } = {}, { learnedLines = null } = {}) {
  const kept = [];
  for (const raw of String(brief ?? "").split(/\r?\n/)) {
    const line = contentOfLine(raw);
    if (!line) continue;
    if (line.length >= 8 && learnedLines?.has(lineKey(line))) continue;
    kept.push(line);
  }
  const body = kept.join(" ").slice(0, SIGNATURE_BRIEF_CHARS);
  const titleWords = [...new Set(wordsOf(title))];
  const tokens = [];
  const seen = new Set();
  for (const w of [...titleWords, ...wordsOf(body)]) {
    if (seen.has(w) || tokens.length >= SIGNATURE_TOKENS_MAX) continue;
    seen.add(w);
    tokens.push(w);
  }
  return { tokens, titleTokens: titleWords.filter((w) => seen.has(w)) };
}

// ---- comparing ----

/** Statistics over the stored signatures: how many there are, how common each word is, and the words too common to say anything. */
export function buildStats(signatures) {
  const sigs = Array.isArray(signatures) ? signatures : [];
  const df = new Map();
  for (const s of sigs) for (const t of new Set(s.tokens ?? [])) df.set(t, (df.get(t) ?? 0) + 1);
  const n = sigs.length;
  const dropped = new Set();
  if (n >= COMMON_TOKEN_MIN) for (const [t, c] of df) if (c / n > COMMON_TOKEN_SHARE) dropped.add(t);
  return { n, df, dropped, idf: (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5)) };
}

const weightsOf = (sig, dropped) => {
  const title = new Set(sig.titleTokens ?? []);
  const w = new Map();
  for (const t of sig.tokens ?? []) if (!dropped.has(t)) w.set(t, title.has(t) ? TITLE_WEIGHT : 1);
  return w;
};

/** IDF-weighted Jaccard of two signatures, 0..1: Σ idf(common)·min(weight) / Σ idf(union)·max(weight). Words too common in `stats` are ignored. */
export function similarity(a, b, stats) {
  const wa = weightsOf(a, stats.dropped);
  const wb = weightsOf(b, stats.dropped);
  let common = 0;
  let union = 0;
  for (const t of new Set([...wa.keys(), ...wb.keys()])) {
    const x = wa.get(t) ?? 0;
    const y = wb.get(t) ?? 0;
    const idf = stats.idf(t);
    common += idf * Math.min(x, y);
    union += idf * Math.max(x, y);
  }
  return union > 0 ? common / union : 0;
}

/**
 * The stored items most like `signature`: MiniSearch picks the top `limit` candidates by shared words, then each is scored with `similarity`.
 * `items`: `{ tokens, titleTokens? }`. Returns `[{ item, score }]`, best first.
 */
export function topMatches(signature, items, stats, { limit = CANDIDATES } = {}) {
  if (!items.length || !signature.tokens.length) return [];
  const index = new MiniSearch({ fields: ["text"], idField: "id", tokenize: (s) => s.split(" "), processTerm: (t) => t, searchOptions: { combineWith: "OR" } });
  index.addAll(items.map((it, i) => ({ id: String(i), text: it.tokens.join(" ") })));
  const hits = index.search(signature.tokens.filter((t) => !stats.dropped.has(t)).join(" ")).slice(0, limit);
  return hits
    .map((h) => ({ item: items[Number(h.id)], score: similarity(signature, items[Number(h.id)], stats) }))
    .sort((x, y) => y.score - x.score);
}
