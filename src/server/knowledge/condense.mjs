// condense.mjs — deterministic, model-free shrinking of a backlog of raw messages before capture reads it
// (spec 2026-11-17-background-budget-followups §5.2).
//
// Input and output are the capture reader's normalized messages
//   { id, role, at, parts: [{id?, type: "text"|"tool"|"note", text?, tool?, command?, output?, status?, exit?}] }.
//
//   keep whole     user messages (also empty ones: they bound a turn); the LAST assistant text of each turn; failed tool calls (first and last output line);
//                  edits/writes (as one "edited <path>" note per file and turn)
//   one-line note  runs of reads / searches / listings, web fetches, passing test/build commands, other commands
//   drop           successful read-only output, intermediate assistant text, anything else a turn produced
//
// Message ids are kept (citations still resolve) and every output message carries `srcIndex`, its position in the
// input. A message left with nothing in it is dropped. Pure; running it on its own output changes nothing.

const FAIL_LINE_CLIP = 200;
const NOTE_CLIP = 240;

const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "codesearch"]);
const LIST_TOOLS = new Set(["list", "ls"]);
const FETCH_TOOLS = new Set(["webfetch", "websearch"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const CHECK_COMMAND = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b|\b(?:vitest|jest|pytest|tsc|eslint|mocha)\b|\bnode\s+(?:--\S+\s+)*--test\b|\bcargo\s+(?:test|build|check|clippy)\b|\bgo\s+(?:test|build|vet)\b|\bmake(?:\s+(?:test|build|check))?\s*$)/;

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dirOf = (path) => {
  const p = String(path ?? "");
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

/** First and last non-empty output line, each clipped; one line (or two) is kept as is. Idempotent. */
function failOutput(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return lines.length === 1 ? clip(lines[0], FAIL_LINE_CLIP * 2 + 3) : `${clip(lines[0], FAIL_LINE_CLIP)} … ${clip(lines[lines.length - 1], FAIL_LINE_CLIP)}`;
}

const isFailed = (p) => p.status === "error" || (typeof p.exit === "number" && p.exit !== 0);

function runText(run) {
  const bits = [];
  if (run.reads.size) {
    const dirs = new Set([...run.reads].map(dirOf));
    const dir = dirs.size === 1 ? [...dirs][0] : "";
    bits.push(`read ${plural(run.reads.size, "file", "files")}${dir ? ` in ${clip(dir, 80)}` : ""}`);
  }
  if (run.searches) bits.push(`searched ${plural(run.searches, "time", "times")}`);
  if (run.lists) bits.push(`listed ${plural(run.lists, "directory", "directories")}`);
  if (run.fetches) bits.push(`fetched ${plural(run.fetches, "page", "pages")}`);
  return bits.join("; ");
}

/**
 * @param {Array<{id:string, role:string, at:number, parts:Array<object>, srcIndex?:number}>} messages  oldest first
 * @returns {Array<object>} condensed messages (new objects; the input is untouched), oldest first
 */
export function condenseForCapture(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (m.role !== "assistant") {
      // user / summary messages: kept whole (text only); one with no text stays as an empty turn boundary
      const parts = (m.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim());
      out.push({ ...m, parts, srcIndex: m.srcIndex ?? i });
      i++;
      continue;
    }
    // A turn: the run of assistant messages up to the next non-assistant one.
    let j = i;
    while (j < list.length && list[j].role === "assistant") j++;
    condenseTurn(list, i, j, out);
    i = j;
  }
  return out;
}

function condenseTurn(list, from, to, out) {
  // The last assistant text of the turn is the one that stays.
  let lastText = null;
  for (let mi = from; mi < to; mi++) {
    (list[mi].parts ?? []).forEach((p, pi) => {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) lastText = `${mi}:${pi}`;
    });
  }
  const kept = new Map(); // message index → emitted parts
  const emit = (mi, part) => {
    if (!kept.has(mi)) kept.set(mi, []);
    kept.get(mi).push(part);
  };
  let run = null; // the open read/search/list/fetch run: {note, reads:Set, searches, lists, fetches}
  let lastCheck = null; // the open passing-check marker: {note, base, n}
  const edited = new Set();
  const close = () => {
    run = null;
    lastCheck = null;
  };

  for (let mi = from; mi < to; mi++) {
    (list[mi].parts ?? []).forEach((p, pi) => {
      if (!p || typeof p !== "object") return;
      if (p.type === "text") {
        if (`${mi}:${pi}` === lastText) {
          emit(mi, { ...p });
          close();
        }
        return;
      }
      if (p.type === "note") {
        emit(mi, { ...p });
        close();
        return;
      }
      if (p.type !== "tool") return;
      const tool = String(p.tool ?? "").toLowerCase();
      if (isFailed(p)) {
        emit(mi, { ...p, output: failOutput(p.output) });
        close();
        return;
      }
      if (EDIT_TOOLS.has(tool)) {
        const path = oneLine(p.command);
        if (!path || edited.has(path)) return;
        edited.add(path);
        emit(mi, { type: "note", text: clip(`edited ${path}`, NOTE_CLIP) });
        close();
        return;
      }
      const collapsible = READ_TOOLS.has(tool) || SEARCH_TOOLS.has(tool) || LIST_TOOLS.has(tool) || FETCH_TOOLS.has(tool);
      if (collapsible) {
        if (!run) {
          run = { note: { type: "note", text: "" }, reads: new Set(), searches: 0, lists: 0, fetches: 0 };
          lastCheck = null;
          emit(mi, run.note);
        }
        if (READ_TOOLS.has(tool)) run.reads.add(oneLine(p.command) || `#${mi}.${pi}`);
        else if (SEARCH_TOOLS.has(tool)) run.searches++;
        else if (LIST_TOOLS.has(tool)) run.lists++;
        else run.fetches++;
        run.note.text = runText(run);
        return;
      }
      if (tool === "bash") {
        const command = oneLine(p.command);
        if (!command) return;
        if (CHECK_COMMAND.test(command)) {
          const base = clip(`ran ${command}: passed`, NOTE_CLIP);
          if (lastCheck && lastCheck.base === base) {
            lastCheck.n++;
            lastCheck.note.text = `${base} (×${lastCheck.n})`;
            return;
          }
          const note = { type: "note", text: base };
          emit(mi, note);
          run = null;
          lastCheck = { note, base, n: 1 };
          return;
        }
        emit(mi, { type: "note", text: clip(`ran ${command}`, NOTE_CLIP) });
        close();
        return;
      }
      if (tool === "task" || tool === "subagent") {
        const what = oneLine(p.command);
        if (what) {
          emit(mi, { type: "note", text: clip(`ran a subagent: ${what}`, NOTE_CLIP) });
          close();
        }
      }
      // everything else (todo lists, skills, other tools): dropped
    });
  }

  for (let mi = from; mi < to; mi++) {
    const parts = kept.get(mi);
    if (parts?.length) out.push({ ...list[mi], parts, srcIndex: list[mi].srcIndex ?? mi });
  }
}
