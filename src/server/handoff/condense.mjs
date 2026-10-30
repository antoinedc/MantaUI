// handoff/condense.mjs — shrink a transcript so a cheap model can write the
// handoff without re-reading the whole conversation (cold-cache spec B2).
//
// PURE: messages in ({info, parts}[], oldest first), text out. No I/O, no clock.
//
// Tool output is the bulk of a transcript and the least useful part of a
// summary, so it is dropped first; the user's words are kept as long as
// possible. Exchanges (a user message + the assistant messages until the next
// one) shrink OLDEST first through levels L1 → L4:
//
//   L1  user full · assistant prose full · one line per tool call
//       (+ 300 head / 300 tail chars of output, errored tools only)
//   L2  user full · prose clipped to 1 000 chars · tool lines, no output
//   L3  user clipped to 4 000 chars · prose dropped · "(N tool calls)"
//   L4  gone — merged into "[N earlier exchanges omitted]"
//
// Three regions are protected, each with its own hard cap, so the result is
// bounded no matter how large one message is: the earlier compaction summary,
// the original ask (the first rendered exchange, never below L3) and the newest
// exchange (never below L2, lowered last).

import { estimateTokens } from "./text.mjs";

export const CONDENSE_MAX_TOKENS = 48_000;
/** Room kept for the reply and the model's own framing. */
export const RESPONSE_RESERVE_TOKENS = 8_000;
/** chars/4 is an estimate; this much of the window is what we trust it for. */
export const ESTIMATE_SAFETY = 0.75;

// Protected-region caps (tokens unless a name says chars).
export const SUMMARY_CAP_TOKENS = 8_000;
export const FIRST_USER_CAP_TOKENS = 2_000;
export const NEWEST_USER_CAP_TOKENS = 4_000;
export const NEWEST_PROSE_CAP_TOKENS = 250;
export const NEWEST_TOOL_LINES = 40;
export const CLIP_EACH_CAP_TOKENS = 500;
export const CLIP_TOTAL_CAP_TOKENS = 2_000;

const L1_CLIP_HEAD = 300;
const L1_CLIP_TAIL = 300;
const L2_PROSE_CHARS = 1_000;
const L3_USER_CHARS = 4_000;
const COMMAND_CHARS = 200;
const KEY_CHARS = 160;
const SEP = "\n\n";
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

/** PURE. The condensed transcript's token budget for one summary model. */
export function condenseBudget({ contextLimit, promptOverhead = 0 } = {}) {
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return 0;
  const raw = Math.floor((contextLimit - RESPONSE_RESERVE_TOKENS - promptOverhead) * ESTIMATE_SAFETY);
  return Math.max(0, Math.min(CONDENSE_MAX_TOKENS, raw));
}

/** PURE. The most the FULL prompt may estimate to before the attempt fails visibly. */
export function inputBudget(contextLimit) {
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return 0;
  return Math.max(0, Math.floor((contextLimit - RESPONSE_RESERVE_TOKENS) * ESTIMATE_SAFETY));
}

/** PURE. Epoch ms the newest assistant message completed (null when none did) — how long the prompt cache has been idle. */
export function lastAssistantCompletedAt(messages) {
  let at = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role !== "assistant") continue;
    const t = m.info.time?.completed;
    if (typeof t === "number" && Number.isFinite(t)) at = at === null ? t : Math.max(at, t);
  }
  return at;
}

// ---- small text helpers --------------------------------------------------------

const clipHead = (s, max) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);
function clipMiddle(s, max) {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}
/** Content can never close or reopen the transcript fence. */
const esc = (s) => s.replace(/<\/?transcript/gi, "<\\/transcript");
const oneLine = (v) => String(v).replace(/\s+/g, " ").trim();

function visibleText(m) {
  return (m?.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function keyInput(input) {
  const i = input && typeof input === "object" ? input : {};
  for (const [k, max] of [["command", COMMAND_CHARS], ["pattern", KEY_CHARS], ["filePath", KEY_CHARS], ["path", KEY_CHARS], ["url", KEY_CHARS], ["description", KEY_CHARS]]) {
    if (typeof i[k] === "string" && i[k].trim()) return clipHead(oneLine(i[k]), max);
  }
  return "";
}

function parseTool(p) {
  const st = p.state ?? {};
  const md = st.metadata ?? {};
  const exit = [md.exit, md.exitCode, md.exit_code].find((v) => typeof v === "number" && Number.isFinite(v));
  const errText = st.status === "error" ? String(st.error ?? st.output ?? "") : "";
  return { name: String(p.tool ?? "tool"), key: keyInput(st.input), status: String(st.status ?? "pending"), exit, errText };
}

function toolLine(t) {
  if (EDIT_TOOLS.has(t.name) && t.status !== "error") return `[edit] ${t.key}`.trimEnd();
  const name = EDIT_TOOLS.has(t.name) ? "edit" : t.name;
  return `[${name}]${t.key ? ` ${t.key}` : ""} → ${t.status}${t.exit !== undefined ? ` exit ${t.exit}` : ""}`;
}

// ---- parsing ---------------------------------------------------------------------

function parse(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.info?.summary === true) {
      at = i;
      break;
    }
  }
  const summary = at >= 0 ? visibleText(list[at]) : "";
  const exchanges = [];
  let cur = null;
  for (const m of list.slice(at + 1)) {
    const role = m?.info?.role;
    if (role === "user") {
      const text = visibleText(m);
      const files = (m.parts ?? []).filter((p) => p?.type === "file").map((p) => String(p.filename ?? p.name ?? p.mime ?? "file"));
      if (!text && files.length === 0) continue;
      cur = { user: { text, files }, prose: [], tools: [] };
      exchanges.push(cur);
    } else if (role === "assistant") {
      if (!cur) {
        cur = { user: null, prose: [], tools: [] };
        exchanges.push(cur);
      }
      for (const p of m.parts ?? []) {
        if (p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored && p.text.trim()) cur.prose.push(p.text.trim());
        else if (p?.type === "tool") cur.tools.push(parseTool(p));
      }
    }
  }
  return { summary, exchanges };
}

// ---- rendering one exchange at one level ---------------------------------------------

const tok = (n) => n * 4;

/** @param {"first"|"newest"|null} role  the protected role (newest wins when first is newest) */
function renderExchange(ex, level, role) {
  const out = [];
  if (ex.user) {
    let text = ex.user.text;
    const limit = role === "newest" ? tok(NEWEST_USER_CAP_TOKENS) : role === "first" ? tok(FIRST_USER_CAP_TOKENS) : level >= 3 ? L3_USER_CHARS : Infinity;
    if (text.length > limit) text = role === "first" ? clipHead(text, limit) : clipMiddle(text, limit);
    const block = [text, ...ex.user.files.map((f) => `[attachment: ${oneLine(f)}]`)].filter(Boolean).join("\n");
    if (block) out.push(`user: ${esc(block)}`);
  }
  if (level <= 2) {
    let prose = ex.prose.join("\n\n");
    const limit = role === "newest" ? tok(NEWEST_PROSE_CAP_TOKENS) : level === 2 ? L2_PROSE_CHARS : Infinity;
    if (prose.length > limit) prose = clipMiddle(prose, limit);
    if (prose) out.push(`assistant: ${esc(prose)}`);
  }
  const tools = ex.tools;
  if (tools.length > 0) {
    if (level >= 3) {
      out.push(`(${tools.length} tool call${tools.length === 1 ? "" : "s"})`);
    } else {
      const shown = role === "newest" && tools.length > NEWEST_TOOL_LINES ? tools.slice(-NEWEST_TOOL_LINES) : tools;
      if (shown.length < tools.length) out.push(`… ${tools.length - shown.length} more tool calls`);
      let clipBudget = tok(CLIP_TOTAL_CAP_TOKENS);
      for (const t of shown) {
        out.push(esc(toolLine(t)));
        if (level === 1 && t.errText.trim()) {
          let clip = clipMiddle(t.errText.trim(), L1_CLIP_HEAD + L1_CLIP_TAIL);
          clip = clipHead(clip, tok(CLIP_EACH_CAP_TOKENS));
          if (role !== "newest" || clip.length <= clipBudget) {
            if (role === "newest") clipBudget -= clip.length;
            out.push(esc(clip.split("\n").map((l) => `  | ${l}`).join("\n")));
          }
        }
      }
    }
  }
  return out.join("\n");
}

/**
 * PURE. Condense a transcript to at most `maxTokens` (chars/4) where the
 * protected regions allow.
 * @param {any[]} messages
 * @param {{ maxTokens: number }} opts
 * @returns {{ text: string, tokens: number, levels: { l1: number, l2: number, l3: number, omitted: number, truncated: boolean, fits: boolean } }}
 */
export function condenseTranscript(messages, { maxTokens } = {}) {
  const budget = typeof maxTokens === "number" && Number.isFinite(maxTokens) ? maxTokens : CONDENSE_MAX_TOKENS;
  const { summary, exchanges } = parse(messages);
  const n = exchanges.length;
  const summaryText = summary ? `Earlier summary:\n${esc(clipMiddle(summary, tok(SUMMARY_CAP_TOKENS)))}` : "";
  const roleOf = (i) => (i === n - 1 ? "newest" : i === 0 ? "first" : null);
  // First exchange floor L3, newest L2, the middle L3: they are only ever REMOVED (L4) in the last phase below.
  const floorOf = (i) => (i === n - 1 ? 2 : 3);
  const rendered = exchanges.map((ex, i) => [null, renderExchange(ex, 1, roleOf(i)), renderExchange(ex, 2, roleOf(i)), renderExchange(ex, 3, roleOf(i))]);
  const levels = new Array(n).fill(1);

  let sumPresent = 0;
  let present = 0;
  let omitted = 0;
  for (let i = 0; i < n; i++) {
    sumPresent += rendered[i][1].length;
    present++;
  }
  const markerLen = (k) => `[${k} earlier exchanges omitted]`.length;
  const totalChars = () => {
    const pieces = (summaryText ? 1 : 0) + present + (omitted > 0 ? 1 : 0);
    return summaryText.length + sumPresent + (omitted > 0 ? markerLen(omitted) : 0) + Math.max(0, pieces - 1) * SEP.length;
  };

  const over = () => Math.ceil(totalChars() / 4) > budget;
  const drop = (i) => {
    sumPresent -= rendered[i][levels[i]].length;
    levels[i] = 4;
    present--;
    omitted++;
  };

  // Phase 1 — lower the OLDEST exchange not yet at its floor, one level at a time.
  // The newest exchange is last in line, so it is lowered only after every other
  // exchange reached its floor. Every step lowers one level of a finite ladder.
  let p = 0;
  while (over()) {
    while (p < n && levels[p] >= floorOf(p)) p++;
    if (p >= n) break; // everything at its floor
    const from = levels[p];
    levels[p] = from + 1;
    sumPresent += rendered[p][levels[p]].length - rendered[p][from].length;
  }
  // Phase 2 — still over: remove MIDDLE exchanges from the oldest side. The first
  // exchange, the newest one and the earlier summary are never removed.
  for (let i = 1; i < n - 1 && over(); i++) drop(i);

  const pieces = [];
  if (summaryText) pieces.push(summaryText);
  let run = 0;
  const flush = () => {
    if (run > 0) pieces.push(`[${run} earlier exchange${run === 1 ? "" : "s"} omitted]`);
    run = 0;
  };
  for (let i = 0; i < n; i++) {
    if (levels[i] === 4) {
      run++;
      continue;
    }
    flush();
    const r = rendered[i][levels[i]];
    if (r) pieces.push(r);
  }
  flush();
  const text = pieces.join(SEP);
  const tokens = estimateTokens(text);
  const counts = { l1: 0, l2: 0, l3: 0 };
  for (const l of levels) if (l <= 3) counts[`l${l}`]++;
  return { text, tokens, levels: { ...counts, omitted, truncated: omitted > 0, fits: tokens <= budget } };
}
