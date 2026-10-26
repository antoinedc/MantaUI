import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTS_HEADING,
  GENERATE_MARKER,
  TEMPLATE_HEADINGS,
  TOOL_MARKER_RE,
  buildGeneratePrompt,
  composeHandoffText,
  estimateTokens,
  extractEditedFiles,
  extractTestRun,
  extractTodos,
  factLines,
  lastUserMessageAt,
  missingHeadings,
} from "./text.mjs";

const FULL = TEMPLATE_HEADINGS.map((h) => `## ${h}\nx`).join("\n\n");

test("missingHeadings: every template heading must be present as a markdown heading", () => {
  assert.deepEqual(missingHeadings(FULL), []);
  assert.deepEqual(missingHeadings(FULL.replace("## Next step", "Next step")), ["Next step"]);
  assert.deepEqual(missingHeadings("just prose"), [...TEMPLATE_HEADINGS]);
  assert.deepEqual(missingHeadings(FULL.replace("## Goal", "### goal ")), [], "level and case are forgiving");
  assert.deepEqual(missingHeadings(undefined), [...TEMPLATE_HEADINGS]);
});

test("generate prompt starts with the marker line, names every heading, carries the user's goal", () => {
  const p = buildGeneratePrompt({ goal: "the migration" });
  assert.equal(p.split("\n")[0], GENERATE_MARKER);
  for (const h of TEMPLATE_HEADINGS) assert.ok(p.includes(`## ${h}`));
  assert.ok(p.includes("the migration"));
  assert.ok(!buildGeneratePrompt().includes("focus on"));
});

test("tool marker regex matches the §15 form and nothing else", () => {
  assert.equal("ok\n<!-- manta-handoff:hof_abc123 -->".match(TOOL_MARKER_RE)?.[1], "hof_abc123");
  assert.equal("<!-- manta-handoff-generate -->".match(TOOL_MARKER_RE), null);
});

test("facts: every line is labelled observed or inferred, and an empty input yields nothing", () => {
  assert.deepEqual(factLines({}), []);
  const lines = factLines({
    predecessor: { id: "ses_a", title: "Fix auth" },
    git: { branch: "feat/x", changes: [{ status: "M", path: "a.ts" }] },
    editedFiles: ["a.ts", "a.ts", "b.ts"],
    todos: [{ content: "ship", status: "in_progress" }],
    testRun: { command: "npm test", exit: 1 },
    constraints: { items: ["never touch prod"], at: 1_700_000_000_000 },
  });
  const top = lines.filter((l) => l.startsWith("- "));
  assert.ok(top.length >= 6);
  for (const l of top) assert.match(l, /^- \((observed|inferred)\) /);
  assert.ok(top.find((l) => l.includes("standing instructions") && l.startsWith("- (inferred)")), "constraints are inferred, with extraction time");
  assert.ok(top.find((l) => l.includes("extracted 2023-")));
  assert.ok(top.find((l) => l.includes("may include changes this session did not make")), "worktree changes are not claimed as this session's");
  assert.ok(lines.includes("  - M a.ts"), "the worktree change line");
  assert.equal(lines.filter((l) => l === "  - a.ts").length, 1, "edited-file list is de-duplicated");
  assert.ok(lines.includes("  - b.ts"));
  assert.ok(top.find((l) => l.includes("`npm test` exited 1")));
});

test("facts: a test run without a known exit status is omitted entirely", () => {
  assert.ok(!factLines({ testRun: { command: "npm test", exit: undefined } }).join("\n").includes("npm test"));
});

test("compose: body + facts section under the cap, untouched", () => {
  const { text, truncated } = composeHandoffText({ body: FULL, facts: ["- (observed) a"] });
  assert.ok(text.startsWith(FULL));
  assert.ok(text.includes(`${FACTS_HEADING}\n- (observed) a`));
  assert.deepEqual(truncated, { facts: false, body: false });
  assert.equal(composeHandoffText({ body: FULL, facts: [] }).text, FULL, "no facts → no empty section");
});

test("compose cap: facts are truncated first, from the end, and the body survives", () => {
  const facts = Array.from({ length: 200 }, (_, i) => `- (observed) fact ${i} ${"x".repeat(100)}`);
  const { text, truncated } = composeHandoffText({ body: FULL, facts, maxTokens: 600 });
  assert.ok(estimateTokens(text) <= 600);
  assert.ok(text.startsWith(FULL), "body intact");
  assert.equal(truncated.facts, true);
  assert.equal(truncated.body, false);
  assert.ok(text.includes("fact 0 "), "most important facts kept");
  assert.ok(!text.includes("fact 199 "));
});

test("compose cap: with no facts left the body is trimmed from the bottom up", () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n");
  const { text, truncated } = composeHandoffText({ body, facts: ["- (observed) a"], maxTokens: 500 });
  assert.ok(estimateTokens(text) <= 500);
  assert.equal(truncated.body, true);
  assert.ok(text.startsWith("line 0 "));
  assert.ok(!text.includes("line 399 "));
});

test("extractors read edit/write/patch parts, the latest todo list, and only known test runners with an exit status", () => {
  const messages = [
    { parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/r/a.ts" } } }] },
    { parts: [{ type: "tool", tool: "write", state: { status: "error", input: { filePath: "/r/failed.ts" } } }] },
    { parts: [{ type: "tool", tool: "apply_patch", state: { status: "completed", input: {}, metadata: { files: [{ file: "/r/b.ts" }] } } }] },
    { parts: [{ type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "old", status: "completed" }] } } }] },
    { parts: [{ type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "new", status: "pending" }] } } }] },
    { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, metadata: { exit: 0 } } }] },
    { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "cd x && npm run test -- --watch=false" }, metadata: { exit: 2 } } }] },
    { parts: [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, metadata: {} } }] },
    { info: { role: "user", time: { created: 5 } }, parts: [] },
    { info: { role: "user", time: { created: 9 } }, parts: [] },
  ];
  assert.deepEqual(extractEditedFiles(messages), ["/r/a.ts", "/r/b.ts"]);
  assert.deepEqual(extractTodos(messages), [{ content: "new", status: "pending" }]);
  assert.deepEqual(extractTestRun(messages), { command: "cd x && npm run test -- --watch=false", exit: 2 }, "the later npm test has no exit status, so it is not the observed run");
  assert.equal(lastUserMessageAt(messages), 9);
  assert.equal(extractTestRun([]), null);
});
