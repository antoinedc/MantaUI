// askUser.mjs — `ask_user`, the generic way for any specialist's task to put a question to the user (spec
// docs/superpowers/specs/2026-11-24-ask-user-tool.md).
//
// A background task can't wait on a person, so the tool does not wait: it records the structured question on the task's job
// record and marks the task as blocked (the existing "needs a decision" path, `endedBlocked`). The task then ends, and its
// result carries the question in a block the SERVER writes (`askUserLines`, like the Architect's `Outcome:` lines), which
// the lead puts to the user. Nothing here knows any domain: what the agent asks, and why, is its own.
//
// Dependency-injected like the other engines: tests drive it with a fake binding and a fake record.

export const ASK_USER_TOOL = "ask_user";
export const ASK_USER_HEADER = "Question for the user (written by the server; the task ended waiting for the user's answer):";

const QUESTION_MAX = 500;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 300;
const WHY_MAX = 800;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 4;
const UNEXPECTED = "The question couldn't be recorded; try again";
const NOT_RUNNING = "This task is no longer running, so the question wasn't recorded";

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const within = (s, max) => s.length >= 1 && s.length <= max;

/** The question as the model gave it → the stored one, or `{ ok: false, error }` (a sentence the model can act on). Pure. */
export function normalizeAsk(input) {
  const question = typeof input?.question === "string" ? oneLine(input.question) : "";
  if (!within(question, QUESTION_MAX)) return { ok: false, error: `The question must be 1 to ${QUESTION_MAX} characters` };
  const raw = input?.options;
  if (!Array.isArray(raw) || raw.length < OPTIONS_MIN || raw.length > OPTIONS_MAX) return { ok: false, error: `Give 2 to ${OPTIONS_MAX} options` };
  const options = [];
  for (const o of raw) {
    const label = typeof o?.label === "string" ? oneLine(o.label) : "";
    if (!within(label, LABEL_MAX)) return { ok: false, error: `Every option needs a label of 1 to ${LABEL_MAX} characters` };
    const description = typeof o?.description === "string" ? oneLine(o.description) : "";
    if (!within(description, DESCRIPTION_MAX)) return { ok: false, error: `Every option needs a description of 1 to ${DESCRIPTION_MAX} characters` };
    options.push({ label, description });
  }
  let recommended = null;
  if (input.recommended !== undefined && input.recommended !== null) {
    if (!Number.isInteger(input.recommended) || input.recommended < 0 || input.recommended >= options.length) {
      return { ok: false, error: `recommended must be the 0-based index of one of the ${options.length} options` };
    }
    recommended = input.recommended;
  }
  let why = "";
  if (input.why !== undefined && input.why !== null) {
    if (typeof input.why !== "string" || oneLine(input.why).length > WHY_MAX) return { ok: false, error: `why must be text of up to ${WHY_MAX} characters` };
    why = oneLine(input.why);
  }
  if (input.concern !== undefined && typeof input.concern !== "boolean") return { ok: false, error: "concern must be true or false" };
  return { ok: true, ask: { question, options, recommended, why, concern: input.concern === true } };
}

/** The lines of the block the server writes into a result for a stored question. One line per field; deterministic. Pure. */
export function askUserLines(ask) {
  if (!ask || typeof ask !== "object" || !Array.isArray(ask.options)) return [];
  const lines = [ASK_USER_HEADER, `Question: ${oneLine(ask.question)}`, "Options:"];
  ask.options.forEach((o, i) => lines.push(`${i + 1}. ${oneLine(o.label)} — ${oneLine(o.description)}`));
  const rec = Number.isInteger(ask.recommended) ? ask.options[ask.recommended] : null;
  if (rec) lines.push(`Recommended: option ${ask.recommended + 1} (${oneLine(rec.label)})`);
  if (oneLine(ask.why)) lines.push(`Why: ${oneLine(ask.why)}`);
  if (ask.concern === true) lines.push("Concern: yes — the agent thinks the request as given is likely a mistake.");
  return lines;
}

/**
 * @param {object} deps
 * @param {(b:object, tool:string)=>Promise<{jobId?:string, childSessionID?:string, refused?:string}>} deps.bind  the research binding: the exact running tool part, the calling specialist, its RUNNING task
 * @param {(jobId:string, ask:object)=>Promise<object|null>} deps.record  stores the question on the running record; null when it is not running
 */
export function createAskUser({ bind, record, now = Date.now, log = console } = {}) {
  async function ask(input) {
    const str = (k) => (typeof input?.[k] === "string" ? input[k] : "");
    const raw = {};
    for (const k of ["question", "options", "recommended", "why", "concern"]) if (input && typeof input === "object" && Object.hasOwn(input, k)) raw[k] = input[k];
    const b = { sessionID: str("sessionID"), messageID: str("messageID"), callID: str("callID"), raw };
    const bound = await bind(b, ASK_USER_TOOL);
    if (bound.refused) return { ok: false, error: bound.refused };
    const checked = normalizeAsk(raw);
    if (!checked.ok) return checked;
    try {
      const stored = await record(bound.jobId, { ...checked.ask, at: now() });
      return stored ? { ok: true } : { ok: false, error: NOT_RUNNING };
    } catch (e) {
      log.warn?.(`[ask_user] couldn't record the question: ${e?.message ?? e}`);
      return { ok: false, error: UNEXPECTED };
    }
  }
  return { ask };
}
