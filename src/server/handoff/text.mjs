// handoff/text.mjs — the pure text side of auto-handoff (spec §2): the
// template, its heading check, the generation prompt, the appended facts
// (§2.1, each line labelled observed or inferred), and the size cap.
// No I/O: callers gather the raw facts and pass them in.

/** Marker line every server `generate` prompt starts with (§15) — the optimizer plugin skips its budget note for it. */
export const GENERATE_MARKER = "<!-- manta-handoff-generate -->";
/** The tool output / card marker (§15): `<!-- manta-handoff:<id> -->`. */
export const TOOL_MARKER_RE = /<!-- manta-handoff:([A-Za-z0-9_-]+) -->/;

export const TEMPLATE_HEADINGS = Object.freeze([
  "Goal",
  "Current state",
  "Decisions (and why)",
  "Dead ends tried",
  "Next step",
  "Open questions",
]);
export const FACTS_HEADING = "## Context from the previous session";
export const MAX_TEXT_TOKENS = 6000;

const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** PURE. Template headings that are not present as `## <heading>` lines. */
export function missingHeadings(body) {
  const present = new Set();
  for (const line of String(body ?? "").split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
    if (m) present.add(norm(m[1]));
  }
  return TEMPLATE_HEADINGS.filter((h) => !present.has(norm(h)));
}

/** PURE. The prompt handed to `/session/{id}/generate`. */
export function buildGeneratePrompt({ goal } = {}) {
  const steer = typeof goal === "string" && goal.trim() ? `\nThe user wants this handoff to focus on: ${goal.trim()}\n` : "";
  return [
    GENERATE_MARKER,
    "Write a handoff prompt that lets a fresh session continue this work with no other context.",
    "Use exactly these markdown sections, in this order, each as a `## ` heading:",
    ...TEMPLATE_HEADINGS.map((h) => `## ${h}`),
    "Be concrete: name files, commands, decisions and the reason for each, what was tried and failed, and the single next step.",
    "Do not include anything that is not true of this conversation. Output only the handoff prompt.",
    steer,
  ].join("\n");
}

/** ~4 characters per token — the same heuristic opencode's own compaction retention uses. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

const OBS = "observed";
const INF = "inferred";
const line = (label, s) => `- (${label}) ${s}`;

/**
 * PURE. The appended `## Context from the previous session` section.
 * Every line is labelled; sections with nothing to say are omitted.
 *
 * @param {{
 *   predecessor?: { id?: string, title?: string },
 *   editedFiles?: string[],
 *   git?: { branch?: string|null, changes?: Array<{status?: string, path: string}> }|null,
 *   todos?: Array<{content?: string, status?: string}>,
 *   constraints?: { items: string[], at?: number|null }|null,
 *   testRun?: { command: string, exit: number }|null,
 *   lastReply?: string|null,
 * }} f
 * @returns {string[]} the lines, most important first (the cap drops from the end)
 */
export function factLines(f = {}) {
  const out = [];
  const pred = f.predecessor ?? {};
  if (pred.id) out.push(line(OBS, `previous session: ${pred.id}${pred.title ? ` — “${pred.title}”` : ""} (read its transcript on demand if you need detail)`));
  if (typeof f.lastReply === "string" && f.lastReply.trim()) {
    // Kept near the top so the size cap drops it last: a question the user has not
    // answered yet must survive the handoff, or the new session runs past it.
    out.push(line(OBS, "the previous session's last reply to the user, which the user has not answered yet. If it asks the user something, ask it again as your first action and wait for the answer before doing anything else:"));
    for (const l of f.lastReply.trim().split("\n")) out.push(`  > ${l}`);
  }
  if (f.git) {
    if (f.git.branch) out.push(line(OBS, `branch: ${f.git.branch}`));
    const ch = Array.isArray(f.git.changes) ? f.git.changes : [];
    if (ch.length > 0) {
      out.push(line(OBS, `current worktree changes (may include changes this session did not make): ${ch.length} file(s)`));
      for (const c of ch.slice(0, 30)) out.push(`  - ${c.status ? `${c.status} ` : ""}${c.path}`);
      if (ch.length > 30) out.push(`  - … and ${ch.length - 30} more`);
    }
  }
  const files = [...new Set((f.editedFiles ?? []).filter((p) => typeof p === "string" && p))];
  if (files.length > 0) {
    out.push(line(OBS, `files this session edited: ${files.length}`));
    for (const p of files.slice(0, 40)) out.push(`  - ${p}`);
    if (files.length > 40) out.push(`  - … and ${files.length - 40} more`);
  }
  const todos = (f.todos ?? []).filter((t) => t && typeof t.content === "string");
  if (todos.length > 0) {
    out.push(line(OBS, "todo list:"));
    for (const t of todos) out.push(`  - [${t.status ?? "pending"}] ${t.content}`);
  }
  if (f.testRun && typeof f.testRun.command === "string" && Number.isFinite(f.testRun.exit)) {
    out.push(line(OBS, `last test/build run: \`${f.testRun.command}\` exited ${f.testRun.exit}`));
  }
  const items = (f.constraints?.items ?? []).filter((c) => typeof c === "string" && c);
  if (items.length > 0) {
    const at = typeof f.constraints?.at === "number" ? ` (extracted ${new Date(f.constraints.at).toISOString()})` : "";
    out.push(line(INF, `standing instructions the user gave this session${at}:`));
    for (const c of items) out.push(`  - ${c}`);
  }
  return out;
}

/**
 * PURE. Compose the record text: body + facts, capped at `maxTokens` — facts
 * are truncated first (from the end), then the body from the bottom up.
 * @returns {{ text: string, truncated: { facts: boolean, body: boolean } }}
 */
export function composeHandoffText({ body, facts = [], maxTokens = MAX_TEXT_TOKENS } = {}) {
  let b = String(body ?? "").replace(/\s+$/, "");
  const kept = [...facts];
  const build = (bodyText, factList, trunc) =>
    factList.length === 0 && !trunc.facts
      ? bodyText
      : `${bodyText}\n\n${FACTS_HEADING}\n${[...factList, ...(trunc.facts ? ["- (observed) … more context omitted to keep this prompt short"] : [])].join("\n")}`;
  const trunc = { facts: false, body: false };
  let text = build(b, kept, trunc);
  while (estimateTokens(text) > maxTokens && kept.length > 0) {
    kept.pop();
    trunc.facts = true;
    text = build(b, kept, trunc);
  }
  if (estimateTokens(text) > maxTokens) {
    // Facts are gone; trim the body from its end, on line boundaries.
    const note = "\n\n… (truncated to fit the handoff size cap)";
    const lines = b.split("\n");
    while (lines.length > 1 && estimateTokens(build(lines.join("\n") + note, kept, trunc)) > maxTokens) lines.pop();
    b = lines.join("\n") + note;
    trunc.body = true;
    text = build(b, kept, trunc);
    const hard = maxTokens * 4;
    if (text.length > hard) text = text.slice(0, hard);
  }
  return { text, truncated: trunc };
}

// ---- extractors over the mapped transcript ({info, parts}[]) -----------------

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

function toolParts(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const p of m?.parts ?? []) if (p?.type === "tool") out.push(p);
  }
  return out;
}

/** PURE. Paths written by edit/write/patch tool parts that completed. */
export function extractEditedFiles(messages) {
  const files = [];
  for (const p of toolParts(messages)) {
    if (!EDIT_TOOLS.has(String(p.tool))) continue;
    if (p.state?.status === "error") continue;
    const input = p.state?.input ?? {};
    const path = input.filePath ?? input.path ?? input.file;
    if (typeof path === "string" && path) files.push(path);
    for (const f of Array.isArray(p.state?.metadata?.files) ? p.state.metadata.files : []) {
      if (typeof f?.file === "string" && f.file) files.push(f.file);
      else if (typeof f?.path === "string" && f.path) files.push(f.path);
    }
  }
  return [...new Set(files)];
}

/** PURE. The latest todo list a todowrite tool part carried. */
export function extractTodos(messages) {
  let todos = [];
  for (const p of toolParts(messages)) {
    if (!["todowrite", "todo_write", "TodoWrite"].includes(String(p.tool))) continue;
    if (Array.isArray(p.state?.input?.todos)) todos = p.state.input.todos;
  }
  return todos;
}

const RUNNER_RE =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint)\b|npx\s+(?:vitest|jest|tsc)\b|vitest\b|jest\b|pytest\b|cargo\s+(?:test|build|check)\b|go\s+(?:test|build)\b|tsc\b|make\s+(?:test|build)\b|node\s+--test\b)/;

/** PURE. The latest bash tool part whose command is a known test/build runner AND whose exit status is known. */
export function extractTestRun(messages) {
  let found = null;
  for (const p of toolParts(messages)) {
    if (p.tool !== "bash" && p.tool !== "shell") continue;
    if (p.state?.status !== "completed" && p.state?.status !== "error") continue;
    const cmd = p.state?.input?.command;
    if (typeof cmd !== "string" || !RUNNER_RE.test(cmd)) continue;
    const md = p.state?.metadata ?? {};
    const exit = [md.exit, md.exitCode, md.exit_code].find((v) => typeof v === "number" && Number.isFinite(v));
    if (exit === undefined) continue;
    found = { command: cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd, exit };
  }
  return found;
}

export const LAST_REPLY_MAX_CHARS = 1500;

/**
 * PURE. The text of the newest assistant message when nothing from the user came
 * after it (the user has not answered it), else null. Long replies keep their
 * END — that is where a question to the user sits.
 */
export function extractLastReply(messages, maxChars = LAST_REPLY_MAX_CHARS) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list[list.length - 1];
  if (last?.info?.role !== "assistant") return null;
  const text = (last.parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n\n")
    .trim();
  if (!text) return null;
  return text.length > maxChars ? `…${text.slice(text.length - maxChars).trimStart()}` : text;
}

/** PURE. Epoch ms of the newest user message (0 when none) — constraint freshness. */
export function lastUserMessageAt(messages) {
  let at = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role === "user" && typeof m.info.time?.created === "number") at = Math.max(at, m.info.time.created);
  }
  return at;
}
