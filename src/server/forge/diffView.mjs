// diffView.mjs — the structured review diff the box hands both clients (WS05,
// G10). Parses the forge's unified diff into files → rows with line numbers and
// comment anchors, and places every incoming thread and every draft comment on
// a row by COORDINATE, so neither client parses diffs or loses a note.
//
// Parsing is jsdiff's `parsePatch` (follows the hunk counts), NOT a line-prefix
// scan: a scan that tests for `--- `/`+++ ` before hunk content swallows an
// added line `++ heading` (encoded `+++ heading`) and desynchronises both
// counters. Inside a hunk only the FIRST character decides the row kind.

import { parsePatch } from "diff";

export const PARSE_FAILED_MESSAGE = "Couldn't read this diff.";

const unplaced = () => ({ at: "unplaced" });

function stripPrefix(name, prefix) {
  return typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function patchPath(patch) {
  const next = patch.newFileName;
  if (next && next !== "/dev/null") return stripPrefix(next, "b/");
  const prev = patch.oldFileName;
  if (prev && prev !== "/dev/null") return stripPrefix(prev, "a/");
  return "";
}

// jsdiff adds 1 to a hunk start whose count is 0 (`@@ -0,0 +1 @@` is parsed as
// oldStart 1). Undo that for DISPLAY only; row counters keep the parsed value.
function hunkHeader(h) {
  const a = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
  const c = h.newLines === 0 ? h.newStart - 1 : h.newStart;
  return `@@ -${a},${h.oldLines} +${c},${h.newLines} @@`;
}

function rowsForPatch(patch, path) {
  const rows = [];
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    rows.push({ kind: "hunk", text: hunkHeader(hunk), oldLine: null, newLine: null, anchor: null });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const c = line.charAt(0);
      if (c === "\\") continue;
      if (c === "+") {
        rows.push({
          kind: "added", text: line.slice(1), oldLine: null, newLine,
          anchor: path ? { path, line: newLine, side: "new" } : null,
        });
        newLine++;
        added++;
      } else if (c === "-") {
        rows.push({
          kind: "removed", text: line.slice(1), oldLine, newLine: null,
          anchor: path ? { path, line: oldLine, side: "old" } : null,
        });
        oldLine++;
        removed++;
      } else {
        rows.push({
          kind: "context", text: line.slice(1), oldLine, newLine,
          anchor: path ? { path, line: newLine, side: "both" } : null,
        });
        oldLine++;
        newLine++;
      }
    }
  }
  return { rows, added, removed };
}

function findRow(rows, pred) {
  for (let i = 0; i < rows.length; i++) if (pred(rows[i])) return i;
  return -1;
}

// Where one note lands. `file` is the index into `files`; `want` describes the
// coordinate. A note with no usable coordinate, or none that matches, sits at
// the top of its file; a note whose path is not in the diff is unplaced.
function place(files, path, want) {
  const file = path ? files.findIndex((f) => f.path === path) : -1;
  if (file < 0) return unplaced();
  const f = files[file];
  if (f.truncated || want == null) return { at: "file", file };
  const row = findRow(f.rows, want);
  return row < 0 ? { at: "file", file } : { at: "row", file, row };
}

function threadWant(t) {
  const line = t.line;
  if (!Number.isInteger(line)) return null;
  if (String(t.side ?? "").toUpperCase() === "LEFT") {
    return (r) => r.oldLine === line && (r.kind === "removed" || r.kind === "context");
  }
  return (r) => r.newLine === line && (r.kind === "added" || r.kind === "context");
}

function draftWant(c) {
  const line = c.line;
  if (!Number.isInteger(line)) return null;
  if (c.side === "old") return (r) => r.kind === "removed" && r.oldLine === line;
  if (c.side === "both") return (r) => r.kind === "context" && r.newLine === line;
  return (r) => r.kind === "added" && r.newLine === line;
}

/**
 * @param {string} diffText raw unified diff
 * @param {Array<object>} threads incoming forge threads
 * @param {Array<object>} draftComments the draft's comments
 * @param {{ maxRowsPerFile?: number }} [opts]
 * @returns {{ files: Array<object>, threads: Array<object>, draftComments: Array<object>, parseFailed: boolean, message: string|null }}
 */
export function buildDiffView(diffText, threads = [], draftComments = [], { maxRowsPerFile = 2000 } = {}) {
  const threadList = Array.isArray(threads) ? threads : [];
  const draftList = Array.isArray(draftComments) ? draftComments : [];

  let patches;
  try {
    patches = parsePatch(String(diffText ?? ""));
  } catch (err) {
    console.warn(`[forge] diff parse failed: ${err?.message ?? err}`);
    return {
      files: [],
      threads: threadList.map((t) => ({ ...t, placement: unplaced() })),
      draftComments: draftList.map((c) => ({ ...c, placement: unplaced() })),
      parseFailed: true,
      message: PARSE_FAILED_MESSAGE,
    };
  }

  const files = [];
  for (const patch of patches) {
    const path = patchPath(patch);
    if (!path && patch.hunks.length === 0) continue;
    const { rows, added, removed } = rowsForPatch(patch, path);
    const truncated = rows.length > maxRowsPerFile;
    files.push({
      path,
      added,
      removed,
      rowCount: rows.length,
      truncated,
      rows: truncated ? [] : rows,
    });
  }

  return {
    files,
    threads: threadList.map((t) => ({ ...t, placement: place(files, t.path, threadWant(t)) })),
    draftComments: draftList.map((c) => ({ ...c, placement: place(files, c.path, draftWant(c)) })),
    parseFailed: false,
    message: null,
  };
}
