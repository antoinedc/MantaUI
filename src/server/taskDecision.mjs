// taskDecision.mjs — the decision a specialist's task puts to the user (spec docs/superpowers/specs/2026-11-24-ask-user-tool.md).
//
// A background task can't wait on a person. A specialist's task may use OpenCode's standard `question` tool anyway: the server
// captures the question form its session raises (`decisionFromForm`), stores it on the job record as the decision, and ends
// the task as "needs a decision". The result then carries a block the SERVER writes (`decisionLines`, like the Architect's
// `Outcome:` lines), which the lead puts to the user. Pure: nothing here knows any domain, and nothing does I/O.

import { questionFromForm } from "../shared/opencodeV2.mjs";

/** What the lead looks for in a result. */
export const DECISION_MARKER = "Question for the user";
export const DECISION_HEADER = `${DECISION_MARKER} (written by the server; the task ended waiting for the user's answer):`;

const QUESTIONS_MAX = 8;
const OPTIONS_MAX = 12;
const QUESTION_MAX = 1500;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 300;

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * A V2 question form → the stored decision `{ questions: [{question, options: [{label, description}], multiple}], at }`, or null
 * when the form holds no question with text. The question text is the model's own: its recommendation and what it found go there.
 */
export function decisionFromForm(form, at) {
  if (!form || typeof form !== "object") return null;
  const asked = questionFromForm(form)?.questions;
  if (!Array.isArray(asked)) return null;
  const questions = [];
  for (const q of asked) {
    const question = oneLine(q?.question).slice(0, QUESTION_MAX);
    if (!question) continue;
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => ({ label: oneLine(o?.label).slice(0, LABEL_MAX), description: oneLine(o?.description).slice(0, DESCRIPTION_MAX) }))
      .filter((o) => o.label)
      .slice(0, OPTIONS_MAX);
    questions.push({ question, options, multiple: q.multiple === true });
    if (questions.length === QUESTIONS_MAX) break;
  }
  return questions.length > 0 ? { questions, at } : null;
}

/** The lines of the block the server writes into a result for a stored decision. One line per field; deterministic. Pure. */
export function decisionLines(decision) {
  const questions = Array.isArray(decision?.questions) ? decision.questions : [];
  if (questions.length === 0) return [];
  const lines = [DECISION_HEADER];
  questions.forEach((q, i) => {
    lines.push(questions.length > 1 ? `Question ${i + 1} of ${questions.length}: ${oneLine(q.question)}` : `Question: ${oneLine(q.question)}`);
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length > 0) {
      lines.push("Options:");
      options.forEach((o, n) => lines.push(`${n + 1}. ${oneLine(o.label)}${oneLine(o.description) ? ` — ${oneLine(o.description)}` : ""}`));
    }
    if (q.multiple === true) lines.push("Several options may be chosen.");
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Non-blocking questions (docs/superpowers/specs/2026-11-26-agents-screens.md §4). OpenCode's question tool blocks the
// calling turn until its form is replied to, so a task's question is answered AT ONCE with a placeholder and the user's real
// answer is delivered later as a message. Everything the task reads here is written by the server; the question text echoed
// back is the model's own, quoted on one line and cut short.
// ---------------------------------------------------------------------------

/** What the question tool returns to the task when its question is captured (fixed wording, never model text). */
export const PLACEHOLDER_ANSWER =
  "Not answered yet: the user sees your question and can answer at any time. Keep working on everything that doesn't depend on it; the answer will arrive as a new message from the user. If all remaining work depends on it, finish what you can, say what is left, and end your turn.";

const ECHO_MAX = 300;
const ANSWER_MAX = 4000;
const echo = (s) => {
  const one = oneLine(s);
  return one.length > ECHO_MAX ? `${one.slice(0, ECHO_MAX - 1)}…` : one;
};

/**
 * Can the user answer every question of this RAW form in free text? True only for a form with at least one field in which
 * every field allows it (`custom !== false`, the flag `questionFromForm` reads). A form that forbids typing can't be answered
 * later by a message, so it takes the old path (the task ends "needs a decision"). Checked on the raw form, before `decisionFromForm`
 * drops what it doesn't keep.
 */
export function acceptsFreeText(form) {
  const fields = form && typeof form === "object" ? form.fields : null;
  return Array.isArray(fields) && fields.length > 0 && fields.every((f) => f && typeof f === "object" && f.custom !== false);
}

/**
 * The message that delivers the user's answer to the task: one line per question, `answers[i]` being the labels and typed
 * text the card sent for question i (joined with ", "). Pure.
 */
export function answerText(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [];
  return qs
    .map((q, i) => {
      const picked = (Array.isArray(answers?.[i]) ? answers[i] : []).map((a) => oneLine(a).slice(0, ANSWER_MAX)).filter(Boolean);
      return `Answer from the user to your question "${echo(q?.question)}": ${picked.length > 0 ? picked.join(", ") : "(no answer given)"}`;
    })
    .join("\n");
}

/** The message sent to a running task when the user dismisses its question. Pure. */
export function dismissText(question) {
  return `The user dismissed your question "${echo(question?.question)}". Decide yourself, or say what is left undecided.`;
}

/** The line a result carries for a task that ended while its question was still open (the answer will continue it). Pure. */
export function waitingLine(questions) {
  const first = Array.isArray(questions) ? questions[0] : null;
  if (!first) return "";
  return `Waiting for the user's answer to: "${echo(first.question)}" (the answer will continue this task).`;
}
