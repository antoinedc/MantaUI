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
