// The one line a Fleet row shows about what a session is doing now (docs/superpowers/specs/2026-11-28-fleet-redesign.md §5b).
// Same source as the background job card's line: the latest progress report, else the in-progress to-do, else the last short
// assistant status line. Pure priority logic plus a reader with injected I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionLines, sessionOneLiner, statusLineOf, LINE_MAX } from "./sessionLine.mjs";
import { LABEL_FRESH_MS } from "./jobProgressView.mjs";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test("sessionOneLiner: a fresh progress report label wins over the to-do and the assistant's text", () => {
  const line = sessionOneLiner({
    report: { label: "Building the Fleet fixes", updatedAt: NOW - 2 * MIN },
    todos: [{ content: "write tests", status: "in_progress" }],
    lastAssistant: "Running the tests now.",
    now: NOW,
  });
  assert.equal(line, "Building the Fleet fixes");
});

test("sessionOneLiner: without a fresh report the in-progress to-do item is the line", () => {
  const todos = [
    { content: "read the code", status: "completed" },
    { content: "write the failing test", status: "in_progress" },
    { content: "make it pass", status: "pending" },
  ];
  assert.equal(sessionOneLiner({ report: null, todos, lastAssistant: "Something else.", now: NOW }), "write the failing test");
  // a report older than the card's freshness window is not the line any more
  assert.equal(sessionOneLiner({ report: { label: "old news", updatedAt: NOW - LABEL_FRESH_MS - MIN }, todos, now: NOW }), "write the failing test");
});

test("sessionOneLiner: with neither, the last short line of the last assistant message", () => {
  const text = "I read the tracker.\n\nThe handoff tool refuses a second call.\nNow changing the limit in the engine.";
  assert.equal(sessionOneLiner({ report: null, todos: null, lastAssistant: text, now: NOW }), "Now changing the limit in the engine.");
});

test("sessionOneLiner: nothing at all is an empty line, never a name", () => {
  assert.equal(sessionOneLiner({ report: null, todos: [], lastAssistant: "", now: NOW }), "");
  assert.equal(sessionOneLiner({ now: NOW }), "");
});

test("sessionOneLiner: a job record's own label and checklist count the same as a session's", () => {
  const jobProgress = { label: "Writing the fix", labelAt: NOW - MIN, checklist: null };
  assert.equal(sessionOneLiner({ jobProgress, now: NOW }), "Writing the fix");
  const jp2 = { label: "", labelAt: null, checklist: [{ text: "run the gate", status: "in_progress" }, { text: "report", status: "pending" }] };
  assert.equal(sessionOneLiner({ jobProgress: jp2, now: NOW }), "run the gate");
});

test("sessionOneLiner: the newer of a job's label and the session's own report wins", () => {
  const out = sessionOneLiner({
    jobProgress: { label: "older job label", labelAt: NOW - 10 * MIN, checklist: null },
    report: { label: "newer session report", updatedAt: NOW - MIN },
    now: NOW,
  });
  assert.equal(out, "newer session report");
});

test("statusLineOf: last non-empty line, markdown marks and fences removed, one line, capped", () => {
  assert.equal(statusLineOf("First.\n\n**Done with the parser.**\n"), "Done with the parser.");
  assert.equal(statusLineOf("```js\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(statusLineOf("- fixed the bug\n- added a test"), "added a test");
  assert.equal(statusLineOf("   \n\n"), "");
  const long = statusLineOf("x".repeat(400));
  assert.ok(long.length <= LINE_MAX, `got ${long.length}`);
});

test("createSessionLines: reads the report and live to-dos first and only reads the transcript when both are empty", async () => {
  const reads = { report: 0, last: 0 };
  const lines = createSessionLines({
    readReports: async () => {
      reads.report += 1;
      return { ses_a: { label: "Auditing the pricing page", updatedAt: NOW - MIN }, ses_b: null };
    },
    todosOf: (sid) => (sid === "ses_b" ? [{ content: "compare the plans", status: "in_progress" }] : null),
    lastAssistantOf: async (sid) => {
      reads.last += 1;
      return sid === "ses_c" ? "Waiting for the build.\nChecking the logs." : "";
    },
    now: () => NOW,
  });
  assert.deepEqual(await lines.read([{ sessionId: "ses_a" }, { sessionId: "ses_b" }, { sessionId: "ses_c" }]), {
    ses_a: "Auditing the pricing page",
    ses_b: "compare the plans",
    ses_c: "Checking the logs.",
  });
  assert.equal(reads.report, 1, "one read of the report store for the whole page");
  assert.equal(reads.last, 1, "only the session with no report and no to-do reads its transcript");
});

test("createSessionLines: a failing transcript read gives an empty line, not an error; a job row's own progress counts", async () => {
  const lines = createSessionLines({
    readReports: async () => ({}),
    todosOf: () => null,
    lastAssistantOf: async () => {
      throw new Error("opencode is away");
    },
    now: () => NOW,
  });
  const out = await lines.read([{ sessionId: "ses_x" }, { sessionId: "ses_y", jobProgress: { label: "Packing the release", labelAt: NOW - MIN } }]);
  assert.deepEqual(out, { ses_x: "", ses_y: "Packing the release" });
});
