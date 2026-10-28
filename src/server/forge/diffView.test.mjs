import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiffView, PARSE_FAILED_MESSAGE } from "./diffView.mjs";

const hdr = (path) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n`;

test("empty diff → no files, not a parse failure", () => {
  const v = buildDiffView("", [], []);
  assert.deepEqual(v.files, []);
  assert.equal(v.parseFailed, false);
  assert.equal(v.message, null);
});

test("two files with counts; hunk resets counters; preamble dropped", () => {
  const text =
    hdr("src/a.ts") + "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n" +
    hdr("src/b.ts") + "@@ -10,2 +10,2 @@\n ctx\n-x\n+y\n";
  const { files } = buildDiffView(text, [], []);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].rowCount, 5);
  assert.equal(files[0].truncated, false);
  assert.deepEqual(files[0].rows.map((r) => r.kind), ["hunk", "context", "removed", "added", "added"]);
  assert.equal(files[0].rows[0].text, "@@ -1,2 +1,3 @@");
  assert.deepEqual(files[0].rows[2].anchor, { path: "src/a.ts", line: 2, side: "old" });
  assert.deepEqual(files[0].rows[3].anchor, { path: "src/a.ts", line: 2, side: "new" });
  assert.deepEqual(files[0].rows[1].anchor, { path: "src/a.ts", line: 1, side: "both" });
  assert.equal(files[1].path, "src/b.ts");
  assert.equal(files[1].rows[1].newLine, 10);
  assert.equal(files[1].rows[1].oldLine, 10);
});

test("deleted file uses the a/ path", () => {
  const text = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 1..0\n--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
  const { files } = buildDiffView(text, [], []);
  assert.equal(files[0].path, "gone.txt");
  assert.equal(files[0].removed, 2);
  assert.deepEqual(files[0].rows[1].anchor, { path: "gone.txt", line: 1, side: "old" });
});

test("a second hunk resets counters to its own header", () => {
  const text = hdr("f.js") + "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,2 +30,2 @@\n ctx\n-c\n+d\n";
  const { files } = buildDiffView(text, [], []);
  const rows = files[0].rows;
  assert.equal(rows[3].text, "@@ -20,2 +30,2 @@");
  assert.deepEqual([rows[4].oldLine, rows[4].newLine], [20, 30]);
  assert.equal(rows[5].oldLine, 21);
  assert.equal(rows[6].newLine, 31);
});

test("header-like content stays content: added `+++ heading`", () => {
  const text = hdr("doc.md") + "@@ -1,2 +1,3 @@\n first\n+++ heading\n last\n";
  const { files } = buildDiffView(text, [], []);
  const rows = files[0].rows.slice(1);
  assert.deepEqual(rows.map((r) => r.kind), ["context", "added", "context"]);
  assert.deepEqual(rows.map((r) => r.anchor.side + ":" + r.anchor.line), ["both:1", "new:2", "both:3"]);
  assert.equal(rows[1].text, "++ heading");
});

test("removed `-- heading` and `--- a/x` lines inside a hunk are removed rows; counters stay right", () => {
  const text = hdr("doc.md") + "@@ -1,4 +1,1 @@\n--- heading\n--- a/x\n-- sub\n tail\n";
  const { files } = buildDiffView(text, [], []);
  const rows = files[0].rows.slice(1);
  assert.deepEqual(rows.map((r) => r.kind), ["removed", "removed", "removed", "context"]);
  assert.deepEqual(rows.map((r) => r.oldLine), [1, 2, 3, 4]);
  assert.equal(rows[3].newLine, 1);
  // a thread on the line after each such row lands on the right row
  const { threads } = buildDiffView(text, [{ id: "t", path: "doc.md", line: 4, side: "LEFT" }], []);
  assert.deepEqual(threads[0].placement, { at: "row", file: 0, row: 4 });
});

test("an added `@@ x` line is content, not a hunk", () => {
  const text = hdr("f.txt") + "@@ -1,1 +1,2 @@\n a\n+@@ x\n";
  const { files } = buildDiffView(text, [], []);
  assert.deepEqual(files[0].rows.map((r) => r.kind), ["hunk", "context", "added"]);
  assert.equal(files[0].rows[2].text, "@@ x");
});

test("`\\ No newline at end of file` produces no row; empty context line is context", () => {
  const text = hdr("f.txt") + "@@ -1,3 +1,3 @@\n a\n\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
  const { files } = buildDiffView(text, [], []);
  assert.deepEqual(files[0].rows.map((r) => r.kind), ["hunk", "context", "context", "removed", "added"]);
});

test("zero-length ranges: insertion-only and deletion-only headers show their counts", () => {
  const ins = buildDiffView("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n", [], []).files[0];
  assert.equal(ins.rows[0].text, "@@ -0,0 +1,2 @@");
  assert.deepEqual(ins.rows.slice(1).map((r) => `${r.kind}:${r.newLine}`), ["added:1", "added:2"]);
  const del = buildDiffView("--- a/x.txt\n+++ b/x.txt\n@@ -3,2 +2,0 @@\n-p\n-q\n", [], []).files[0];
  assert.equal(del.rows[0].text, "@@ -3,2 +2,0 @@");
  assert.deepEqual(del.rows.slice(1).map((r) => `${r.kind}:${r.oldLine}`), ["removed:3", "removed:4"]);
});

test("malformed input → parseFailed, raw threads/draft comments all unplaced, never lost", () => {
  const bad = "@@ -1,2 +1,3 @@\n first\n+new\n";
  const origWarn = console.warn;
  console.warn = () => {};
  let v;
  try {
    v = buildDiffView(bad, [{ id: "t1", path: "a", line: 1, side: "RIGHT" }], [{ id: "c1", path: "a", line: 1, side: "new", body: "x" }]);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(v.parseFailed, true);
  assert.equal(v.message, PARSE_FAILED_MESSAGE);
  assert.equal(v.message, "Couldn't read this diff.");
  assert.deepEqual(v.files, []);
  assert.deepEqual(v.threads[0].placement, { at: "unplaced" });
  assert.deepEqual(v.draftComments[0].placement, { at: "unplaced" });
  assert.equal(v.threads[0].id, "t1");
  assert.equal(v.draftComments[0].body, "x");
});

test("LEFT thread on a context row lands on the old-line row even with unequal offsets", () => {
  // two lines added above, so the context line is old 1 / new 3
  const text = hdr("f.txt") + "@@ -1,1 +1,3 @@\n+x\n+y\n ctx\n";
  const { threads } = buildDiffView(text, [
    { id: "L", path: "f.txt", line: 1, side: "LEFT" },
    { id: "R", path: "f.txt", line: 3, side: "RIGHT" },
    { id: "R1", path: "f.txt", line: 1, side: "RIGHT" },
  ], []);
  assert.deepEqual(threads[0].placement, { at: "row", file: 0, row: 3 });
  assert.deepEqual(threads[1].placement, { at: "row", file: 0, row: 3 });
  assert.deepEqual(threads[2].placement, { at: "row", file: 0, row: 1 });
});

test("draft comments place by side: new → added, old → removed, both → context (new line)", () => {
  const text = hdr("f.txt") + "@@ -1,3 +1,3 @@\n ctx\n-gone\n+here\n tail\n";
  const { draftComments } = buildDiffView(text, [], [
    { id: "n", path: "f.txt", line: 2, side: "new" },
    { id: "o", path: "f.txt", line: 2, side: "old" },
    { id: "b", path: "f.txt", line: 3, side: "both" },
  ]);
  assert.deepEqual(draftComments.map((c) => c.placement), [
    { at: "row", file: 0, row: 3 },
    { at: "row", file: 0, row: 2 },
    { at: "row", file: 0, row: 4 },
  ]);
});

test("unmatched coordinate → file top; no line → file top; unknown path / null path → unplaced", () => {
  const text = hdr("f.txt") + "@@ -1,1 +1,1 @@\n-a\n+b\n";
  const { threads } = buildDiffView(text, [
    { id: "1", path: "f.txt", line: 99, side: "RIGHT" },
    { id: "2", path: "f.txt", line: null, side: null },
    { id: "3", path: "other.txt", line: 1, side: "RIGHT" },
    { id: "4", path: null, line: 1, side: "RIGHT" },
  ], []);
  assert.deepEqual(threads.map((t) => t.placement), [
    { at: "file", file: 0 },
    { at: "file", file: 0 },
    { at: "unplaced" },
    { at: "unplaced" },
  ]);
});

test("a file over maxRowsPerFile is truncated: no rows, counts kept, notes at the file", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `+l${i}`).join("\n");
  const text = hdr("big.txt") + `@@ -0,0 +1,10 @@\n${lines}\n`;
  const { files, threads } = buildDiffView(text, [{ id: "t", path: "big.txt", line: 3, side: "RIGHT" }], [], { maxRowsPerFile: 5 });
  assert.equal(files[0].truncated, true);
  assert.deepEqual(files[0].rows, []);
  assert.equal(files[0].rowCount, 11);
  assert.equal(files[0].added, 10);
  assert.deepEqual(threads[0].placement, { at: "file", file: 0 });
});
