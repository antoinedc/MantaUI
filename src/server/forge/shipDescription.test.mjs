// shipDescription.test.mjs — pure helpers for the out-of-band PR-description
// generation (BET-893). No opencode, no network, no filesystem: everything
// here is string/array logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrDescriptionPrompt,
  parsePrDescription,
  extractTranscriptText,
  extractAssistantText,
  extractCompletedAssistantText,
  isPrGenerationComplete,
  truncateTranscript,
  TRANSCRIPT_CHAR_CAP,
} from "./shipDescription.mjs";

// ---------------------------------------------------------------------------
// extractTranscriptText — last-N messages, text parts only
// ---------------------------------------------------------------------------

function msg(role, parts) {
  return { info: { role }, parts };
}

test("extractTranscriptText joins text parts of the last N messages, oldest first", () => {
  const messages = [
    msg("user", [{ type: "text", text: "oldest" }]),
    msg("user", [{ type: "text", text: "second" }]),
    msg("assistant", [{ type: "text", text: "a\nmulti\nline" }]),
  ];
  assert.equal(extractTranscriptText(messages), "oldest\nsecond\na\nmulti\nline");
});

test("extractTranscriptText defaults to the last 20 messages", () => {
  const messages = [];
  for (let i = 0; i < 25; i++) messages.push(msg("user", [{ type: "text", text: `m${i}` }]));
  const text = extractTranscriptText(messages);
  assert.equal(text.split("\n").length, 20);
  assert.ok(text.includes("m5"), "oldest kept message");
  assert.ok(!text.includes("m0"), "messages older than the last 20 are dropped");
});

test("extractTranscriptText honours an explicit last count and skips non-text parts", () => {
  const messages = [
    msg("user", [{ type: "text", text: "a" }]),
    msg("assistant", [
      { type: "text", text: "b" },
      { type: "tool", state: { status: "completed" }, tool: "bash", input: {}, output: "ignored" },
      { type: "text", text: "c" },
    ]),
  ];
  assert.equal(extractTranscriptText(messages, { last: 1 }), "b\nc");
});

test("extractTranscriptText is tolerant of non-array input", () => {
  assert.equal(extractTranscriptText(undefined), "");
  assert.equal(extractTranscriptText(null), "");
  assert.equal(extractTranscriptText("nope"), "");
});

test("extractAssistantText returns only assistant text; empty when absent", () => {
  const messages = [
    msg("user", [{ type: "text", text: "question" }]),
    msg("assistant", [{ type: "text", text: "  the answer  " }]),
  ];
  assert.equal(extractAssistantText(messages), "  the answer  ");
  assert.equal(extractAssistantText([msg("user", [{ type: "text", text: "x" }])]), "");
  assert.equal(extractAssistantText([]), "");
});

// --- completion-aware extractor (BET-893 reviewer Block) ---------------------

function assistantMsg(text, { completed } = {}) {
  return {
    info: { role: "assistant", ...(completed ? { time: { completed } } : {}) },
    parts: [text ? { type: "text", text } : { type: "text", text: "" }],
  };
}

test("isPrGenerationComplete requires a non-empty transcript AND a completed assistant turn", () => {
  // Empty transcript must NOT read as complete — the window right after
  // create+prompt has zero messages server-side yet (the shared helper reads
  // empty as "complete", which would fall back prematurely here).
  assert.equal(isPrGenerationComplete([]), false);
  assert.equal(isPrGenerationComplete(undefined), false);
  // A user message only → turn in flight.
  assert.equal(isPrGenerationComplete([msg("user", [{ type: "text", text: "go" }])]), false);
  // Assistant message without a completion stamp → still in flight (partial).
  assert.equal(isPrGenerationComplete([assistantMsg("partial text")]), false);
  // Assistant message WITH info.time.completed → complete.
  assert.equal(isPrGenerationComplete([assistantMsg("final", { completed: 12345 })]), true);
});

test("extractCompletedAssistantText returns null while the turn is in flight, text only once complete", () => {
  // Partial / still-streaming assistant text is NOT returned — the fix for the
  // reviewed Block (never capture a truncated reply as the final description).
  assert.equal(extractCompletedAssistantText([assistantMsg("truncated...")]), null);
  assert.equal(extractCompletedAssistantText([msg("user", [{ type: "text", text: "go" }])]), null);
  // Once complete, returns the assistant text.
  assert.equal(extractCompletedAssistantText([assistantMsg("Full title\n\nFull body", { completed: 1 })]), "Full title\n\nFull body");
  // Complete but no text → "" (the caller falls back).
  assert.equal(extractCompletedAssistantText([assistantMsg("", { completed: 1 })]), "");
});

// ---------------------------------------------------------------------------
// truncateTranscript + buildPrDescriptionPrompt
// ---------------------------------------------------------------------------

test("truncateTranscript keeps the newest tail, dropping oldest first", () => {
  assert.equal(truncateTranscript("short"), "short");
  const head = "X".repeat(100);
  const tail = "Y".repeat(TRANSCRIPT_CHAR_CAP);
  const out = truncateTranscript(head + tail);
  assert.equal(out.length, TRANSCRIPT_CHAR_CAP);
  assert.ok(out.startsWith("Y"), "keeps the newest tail");
  assert.ok(!out.includes("X"), "oldest head dropped first");
});

test("buildPrDescriptionPrompt includes commits, files, and the template when present", () => {
  const prompt = buildPrDescriptionPrompt({
    head: "feat/forge-seam",
    base: "main",
    files: ["src/server/forge/index.mjs", "src/shared/types.ts"],
    commits: ["feat(forge): add ship preview", "refactor(server): inject opencode deps"],
    template: "## Summary\n\n${head} → ${base}",
    transcript: "the why",
  });
  assert.ok(prompt.includes("feat(forge): add ship preview"));
  assert.ok(prompt.includes("refactor(server): inject opencode deps"));
  assert.ok(prompt.includes("src/server/forge/index.mjs"));
  assert.ok(prompt.includes("src/shared/types.ts"));
  assert.ok(prompt.includes("FILL IT IN"), "template instructs fill-in, not replace");
  assert.ok(prompt.includes("the why"));
  assert.ok(prompt.includes("feat/forge-seam → main"));
  assert.ok(prompt.includes("FIRST line is the title"), "output contract stated");
});

test("buildPrDescriptionPrompt omits commits/files/template blocks when absent", () => {
  const prompt = buildPrDescriptionPrompt({ head: "feat/x", base: "main" });
  assert.ok(!prompt.includes("Commits since"));
  assert.ok(!prompt.includes("Changed files"));
  assert.ok(!prompt.includes("FILL IT IN"));
  assert.ok(!prompt.includes("Relevant conversation transcript"));
});

test("buildPrDescriptionPrompt truncates the transcript at the 8000-char cap", () => {
  const transcript = "x".repeat(TRANSCRIPT_CHAR_CAP + 5000);
  const prompt = buildPrDescriptionPrompt({ head: "h", base: "b", transcript });
  // The transcript's own tail appears; the overlong head is gone.
  assert.ok(prompt.includes("x".repeat(500)), "tail of transcript kept");
  assert.ok(prompt.length < (TRANSCRIPT_CHAR_CAP + 5000), "transcript truncated");
});

// ---------------------------------------------------------------------------
// parsePrDescription
// ---------------------------------------------------------------------------

test("parsePrDescription: normal shape with a blank line", () => {
  assert.deepEqual(parsePrDescription("Fix the login redirect\n\nBody here.\n- bullet"), {
    title: "Fix the login redirect",
    body: "Body here.\n- bullet",
  });
});

test("parsePrDescription: missing blank line still parses (title first line, rest body)", () => {
  assert.deepEqual(parsePrDescription("Fix the login redirect\nBody with no blank"), {
    title: "Fix the login redirect",
    body: "Body with no blank",
  });
});

test("parsePrDescription: empty body is valid", () => {
  assert.deepEqual(parsePrDescription("Just a title\n\n"), {
    title: "Just a title",
    body: "",
  });
});

test("parsePrDescription: a title over 72 chars is still returned, never silently truncated", () => {
  const longTitle = "This is an extremely long pull request title that absolutely exceeds seventy two characters";
  assert.ok(longTitle.length > 72);
  const out = parsePrDescription(`${longTitle}\n\nBody`);
  assert.equal(out.title, longTitle);
  assert.equal(out.body, "Body");
});

test("parsePrDescription: garbage input returns null", () => {
  assert.equal(parsePrDescription(null), null);
  assert.equal(parsePrDescription(undefined), null);
  assert.equal(parsePrDescription(42), null);
  assert.equal(parsePrDescription(""), null);
  assert.equal(parsePrDescription("   \n  "), null);
});

test("parsePrDescription: a BOM is tolerated and blank leading lines fold into the title", () => {
  const out = parsePrDescription("\uFEFFTidy title\n\nBody");
  assert.deepEqual(out, { title: "Tidy title", body: "Body" });
});
