import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, countSubagents, collectPanes, MARK } from "./status.mjs";

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

function mkStdout(entries) {
  // Simulates the shell loop output:
  //   \n__MANTA_PANE__<session>:<index>__MANTA_PANE__\n<body>
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

// ----------------------------------------------------------------------------
// collectPanes — bounded-concurrency parallel pane capture (order-preserving)
// ----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("collectPanes preserves target order regardless of capture-pane resolve order", async () => {
  const targets = ["a:0", "b:1", "c:2"];
  // Delays chosen so "a:0" (index 0) resolves LAST despite being first in
  // target order — proving the output is ordered by target index, not by
  // which capture-pane call settles first.
  const delays = { "a:0": 30, "b:1": 10, "c:2": 5 };

  const fakeRun = async (cmd, args) => {
    if (args[0] === "list-windows") {
      return { stdout: targets.join("\n") + "\n" };
    }
    // args: ["capture-pane", "-t", target, "-p", "-S", ...]
    const target = args[2];
    await sleep(delays[target]);
    return { stdout: `body-${target}\n` };
  };

  const stdout = await collectPanes(fakeRun);
  const parsed = parseStatus(stdout);

  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((w) => `${w.session}:${w.windowIndex}`),
    targets,
  );

  // Also verify the raw MARK ordering directly (belt-and-suspenders — parseStatus
  // could theoretically reorder, though it doesn't).
  const markPositions = targets.map((t) => stdout.indexOf(`${MARK}${t}${MARK}`));
  assert.deepEqual(
    [...markPositions].sort((x, y) => x - y),
    markPositions,
  );
});

test("collectPanes isolates a per-window capture-pane failure without rejecting the whole call", async () => {
  const targets = ["a:0", "b:1", "c:2"];

  const fakeRun = async (cmd, args) => {
    if (args[0] === "list-windows") {
      return { stdout: targets.join("\n") + "\n" };
    }
    const target = args[2];
    if (target === "b:1") {
      throw new Error("window killed between list and capture");
    }
    return { stdout: `body-${target}\n` };
  };

  const stdout = await collectPanes(fakeRun);
  const parsed = parseStatus(stdout);

  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map((w) => `${w.session}:${w.windowIndex}`),
    targets,
  );
  // The failed window's body is empty (no captured text), but it still
  // produced a slot — the whole tick did not reject.
  assert.equal(parsed[1].running, false);
  assert.equal(parsed[1].subagents, 0);
});

test("collectPanes returns empty string when no windows exist", async () => {
  const fakeRun = async (cmd, args) => {
    if (args[0] === "list-windows") return { stdout: "" };
    throw new Error("should not be called");
  };
  assert.equal(await collectPanes(fakeRun), "");
});

test("collectPanes returns empty string when list-windows itself fails", async () => {
  const fakeRun = async () => {
    throw new Error("no tmux server running");
  };
  assert.equal(await collectPanes(fakeRun), "");
});
