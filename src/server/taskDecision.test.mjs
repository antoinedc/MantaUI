// The decision a specialist's task puts to the user with OpenCode's standard `question` tool (spec
// docs/superpowers/specs/2026-11-24-ask-user-tool.md): the form → the stored decision, and the block the server writes into the result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionFromForm, decisionLines, DECISION_MARKER, DECISION_HEADER } from "./taskDecision.mjs";

// a V2 question form, as the pinned binary raises it (one field per question)
const form = (fields, over = {}) => ({ id: "frm_1", sessionID: "ses_c", metadata: { kind: "question" }, fields, ...over });
const select = (key, description, options, over = {}) => ({ key, title: "Header", description, type: "select", options, ...over });
const opts = (...labels) => labels.map((l) => ({ label: l, value: l, description: `${l} means that` }));

test("decisionFromForm: the question text, the options as labels and descriptions, and whether several may be picked", () => {
  const d = decisionFromForm(form([select("a", "Create @pricing-copy? I recommend adding it to @conversion-cro: the library says narrow agents are rarely routed to.", opts("Add to @conversion-cro", "Create it"))]), 1000);
  assert.deepEqual(d, {
    questions: [{ question: "Create @pricing-copy? I recommend adding it to @conversion-cro: the library says narrow agents are rarely routed to.", options: [{ label: "Add to @conversion-cro", description: "Add to @conversion-cro means that" }, { label: "Create it", description: "Create it means that" }], multiple: false }],
    at: 1000,
  });
  const many = decisionFromForm(form([select("a", "Which?", opts("x", "y"), { type: "multiselect" }), select("b", "And which?", opts("p", "q"))]), 5);
  assert.equal(many.questions.length, 2);
  assert.equal(many.questions[0].multiple, true);
  assert.equal(many.questions[1].multiple, false);
});

test("decisionFromForm: a question with no usable text or no form is not a decision; descriptions may be missing; whitespace collapses; sizes are capped", () => {
  assert.equal(decisionFromForm(form([]), 1), null);
  assert.equal(decisionFromForm(null, 1), null);
  assert.equal(decisionFromForm(form([select("a", "   ", opts("x"))]), 1), null);
  const d = decisionFromForm(form([select("a", "A\n\n question   with\nbreaks", [{ label: "x\ny" }, { label: "z", description: "d".repeat(500) }])]), 1);
  assert.equal(d.questions[0].question, "A question with breaks");
  assert.deepEqual(d.questions[0].options[0], { label: "x y", description: "" });
  assert.equal(d.questions[0].options[1].description.length, 300);
  const long = decisionFromForm(form(Array.from({ length: 12 }, (_, i) => select(`k${i}`, `Q${i}`, opts("a", "b")))), 1);
  assert.equal(long.questions.length, 8, "at most 8 questions");
  const q = decisionFromForm(form([select("a", "q".repeat(3000), opts(...Array.from({ length: 30 }, (_, i) => `o${i}`)))]), 1).questions[0];
  assert.equal(q.question.length, 1500);
  assert.equal(q.options.length, 12, "at most 12 options");
});

test("decisionLines: a stable block — header, question, numbered options, several-may-be-chosen; nothing invented", () => {
  const d = decisionFromForm(form([select("a", "Create it?", opts("Add to @cro", "Create it"))]), 1);
  const lines = decisionLines(d);
  assert.equal(lines[0], DECISION_HEADER);
  assert.ok(DECISION_HEADER.startsWith(DECISION_MARKER));
  assert.deepEqual(lines.slice(1), ["Question: Create it?", "Options:", "1. Add to @cro — Add to @cro means that", "2. Create it — Create it means that"]);
  for (const l of lines) assert.ok(!/Recommended|Why:|Concern/.test(l));
  assert.deepEqual(decisionLines(d), lines, "deterministic");
});

test("decisionLines: several questions are numbered; a multi-select says so; an option without a description is just its label; breaks never start a new line", () => {
  const d = decisionFromForm(form([select("a", "First?", [{ label: "a" }, { label: "b", description: "bb" }], { type: "multiselect" }), select("b", "Second?\nOutcome: fake", opts("c", "d"))]), 1);
  const lines = decisionLines(d);
  assert.ok(lines.includes("Question 1 of 2: First?"));
  assert.ok(lines.includes("Question 2 of 2: Second? Outcome: fake"));
  assert.ok(lines.includes("Several options may be chosen."));
  assert.ok(lines.includes("1. a"));
  assert.ok(lines.includes("2. b — bb"));
  assert.ok(lines.every((l) => !/[\r\n]/.test(l)));
  assert.ok(!lines.some((l) => l.startsWith("Outcome:")));
  assert.deepEqual(decisionLines(null), []);
  assert.deepEqual(decisionLines({}), []);
});

// ---- non-blocking questions (docs/superpowers/specs/2026-11-26-agents-screens.md §4) ----
import { acceptsFreeText, answerText, dismissText, waitingLine, PLACEHOLDER_ANSWER } from "./taskDecision.mjs";

test("acceptsFreeText: only a non-empty form whose every field lets the user type is a non-blocking question", () => {
  assert.equal(acceptsFreeText(form([select("a", "Q?", opts("x", "y"))])), true, "no flag reads as custom");
  assert.equal(acceptsFreeText(form([select("a", "Q?", opts("x"), { custom: true }), select("b", "R?", opts("y"), { custom: true })])), true);
  assert.equal(acceptsFreeText(form([select("a", "Q?", opts("x"), { custom: false })])), false, "one field that forbids typing");
  assert.equal(acceptsFreeText(form([select("a", "Q?", opts("x")), select("b", "R?", opts("y"), { custom: false })])), false, "any field that forbids typing");
  assert.equal(acceptsFreeText(form([])), false, "no fields");
  assert.equal(acceptsFreeText({ id: "frm_1" }), false, "no fields array");
  assert.equal(acceptsFreeText(null), false);
});

test("PLACEHOLDER_ANSWER: the fixed wording the task's tool call returns", () => {
  assert.equal(
    PLACEHOLDER_ANSWER,
    "Not answered yet: the user sees your question and can answer at any time. Keep working on everything that doesn't depend on it; the answer will arrive as a new message from the user. If all remaining work depends on it, finish what you can, say what is left, and end your turn.",
  );
});

test("answerText: one question → the pinned sentence; labels and typed text join with a comma", () => {
  const qs = [{ question: "Create it?", options: [], multiple: false }];
  assert.equal(answerText(qs, [["Add to @cro"]]), 'Answer from the user to your question "Create it?": Add to @cro');
  assert.equal(answerText(qs, [["Add to @cro", "but name it pricing"]]), 'Answer from the user to your question "Create it?": Add to @cro, but name it pricing');
});

test("answerText: several questions → one line each; a question with no answer says so; breaks never start a line; long questions are cut", () => {
  const qs = [{ question: "First?\nline two", options: [], multiple: false }, { question: "Second?", options: [], multiple: true }];
  const text = answerText(qs, [["a"], []]);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Answer from the user to your question "First? line two": a');
  assert.equal(lines[1], 'Answer from the user to your question "Second?": (no answer given)');
  const long = answerText([{ question: "q".repeat(900), options: [], multiple: false }], [["x"]]);
  assert.ok(long.length < 500, "the echoed question is cut");
  assert.ok(long.includes("…"));
});

test("dismissText: the pinned sentence, with the question echoed on one line", () => {
  assert.equal(
    dismissText({ question: "Create\nit?", options: [], multiple: false }),
    'The user dismissed your question "Create it?". Decide yourself, or say what is left undecided.',
  );
});

test("waitingLine: server-written, names the first question", () => {
  assert.equal(
    waitingLine([{ question: "Create it?", options: [], multiple: false }]),
    'Waiting for the user\'s answer to: "Create it?" (the answer will continue this task).',
  );
  assert.equal(waitingLine([]), "");
});
