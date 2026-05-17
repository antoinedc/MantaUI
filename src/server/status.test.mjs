import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, countSubagents } from "./status.mjs";

// ----------------------------------------------------------------------------
// countSubagents — pure helper
// ----------------------------------------------------------------------------

test("countSubagents returns 0 when no Task headers", () => {
  const body = "some output\nmore text\n⎿  Running…\n";
  assert.equal(countSubagents(body), 0);
});

test("countSubagents counts a Task with Running immediately after", () => {
  const body = "● Task(write a file)\n⎿  Running…\n";
  assert.equal(countSubagents(body), 1);
});

test("countSubagents counts multiple in-flight tasks", () => {
  const body = [
    "● Task(task one)",
    "⎿  Running…",
    "● Task(task two)",
    "⎿  Running…",
  ].join("\n");
  assert.equal(countSubagents(body), 2);
});

test("countSubagents does not count a Task whose next ⎿ line is not Running", () => {
  // Task produced output — it's no longer in-flight
  const body = "● Task(task done)\n⎿  Result of the task\n";
  assert.equal(countSubagents(body), 0);
});

test("countSubagents ignores plain ⎿ Running lines without a preceding Task", () => {
  // A Bash tool running — shouldn't count as a subagent
  const body = "● Bash(ls)\n⎿  Running…\n";
  assert.equal(countSubagents(body), 0);
});

// ----------------------------------------------------------------------------
// parseStatus — parses tmux capture-pane output batched with MARK sentinels
// ----------------------------------------------------------------------------

const MARK = "__BUI_PANE__";

function mkStdout(entries) {
  // Simulates the shell loop output:
  //   \n__BUI_PANE__<session>:<index>__BUI_PANE__\n<body>
  return entries
    .map(({ target, body }) => `\n${MARK}${target}${MARK}\n${body}`)
    .join("");
}

test("parseStatus returns empty array for empty stdout", () => {
  assert.deepEqual(parseStatus(""), []);
});

test("parseStatus parses a single idle window", () => {
  const stdout = mkStdout([{ target: "myproject:0", body: "some terminal output\n" }]);
  const out = parseStatus(stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0].session, "myproject");
  assert.equal(out[0].windowIndex, 0);
  assert.equal(out[0].running, false);
  assert.equal(out[0].subagents, 0);
});

test("parseStatus detects running window from BUSY_RE pattern", () => {
  // Exact pattern: spinner glyph at col 0, non-empty word + …, then (…·…)
  const busyLine = "✻ Ruminating… (27s · still thinking)";
  const stdout = mkStdout([{ target: "work:1", body: `${busyLine}\n` }]);
  const out = parseStatus(stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0].session, "work");
  assert.equal(out[0].windowIndex, 1);
  assert.equal(out[0].running, true);
});

test("parseStatus detects ascii spinner variant", () => {
  const busyLine = "* Cogitating… (12s · ↑ 1.2k tokens)";
  const stdout = mkStdout([{ target: "alpha:2", body: `${busyLine}\n` }]);
  const out = parseStatus(stdout);
  assert.equal(out[0].running, true);
});

test("parseStatus does NOT mark as running a past-tense line (no ellipsis)", () => {
  const doneLine = "✻ Cogitated for 39s";
  const stdout = mkStdout([{ target: "beta:0", body: `${doneLine}\n` }]);
  const out = parseStatus(stdout);
  assert.equal(out[0].running, false);
});

test("parseStatus handles session names with colons (uses lastIndexOf)", () => {
  // session names cannot contain ':' per tmux but our parser uses lastIndexOf
  // to be safe; windowIndex must still parse correctly.
  const stdout = mkStdout([{ target: "my-project:3", body: "" }]);
  const out = parseStatus(stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0].session, "my-project");
  assert.equal(out[0].windowIndex, 3);
});

test("parseStatus parses multiple windows", () => {
  const busy = "✳ Ruminating… (5s · still thinking)";
  const stdout = mkStdout([
    { target: "proj:0", body: "idle output\n" },
    { target: "proj:1", body: `${busy}\n` },
    { target: "other:0", body: "also idle\n" },
  ]);
  const out = parseStatus(stdout);
  assert.equal(out.length, 3);
  const running = out.filter((w) => w.running);
  assert.equal(running.length, 1);
  assert.equal(running[0].windowIndex, 1);
});

test("parseStatus includes subagents count", () => {
  const body = [
    "✻ Ruminating… (10s · still thinking)",
    "● Task(write something)",
    "⎿  Running…",
  ].join("\n");
  const stdout = mkStdout([{ target: "work:0", body }]);
  const out = parseStatus(stdout);
  assert.equal(out[0].running, true);
  assert.equal(out[0].subagents, 1);
});
