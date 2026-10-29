// transcriptView.mjs — what a transcript MEANS, decided on the box (WS11 D8–D11 / audit T1–T5, T8, T16).
//
// Both clients used to derive the same facts from the raw messages — a finished turn's footer, a truncation warning,
// the inline media, the plan card, a tool run's wording — each with its own copy of the rules. `opencode:messages` /
// `opencode:message` called with `{view:true}` now carry them: `message.view` (+ `part.view`). Pure; no I/O.
//
// D8: `view.turn` and `view.truncation`.

import { classifyFinish, describeTruncation } from "../shared/streamInterpretation.mjs";

/** A finished background run (v2-next N4) carries a `background-result` part. */
export function isBackgroundResultMessage(message) {
  return Array.isArray(message?.parts) && message.parts.some((p) => p?.type === "background-result");
}

/**
 * Turn footers, keyed by the turn's LAST assistant message id. A user message or a background result starts a turn;
 * `tokens` = Σ output + reasoning over the turn's assistant steps; `verbSeedId` = the turn's FIRST assistant message.
 * A turn gets no entry when its last assistant message has no `time.completed`, or — while `running` — when that
 * message is the window's last (the in-flight turn).
 * @returns {Map<string, { durationMs: number|null, tokens: number|null, verbSeedId: string }>}
 */
export function computeTurns(messages, { running = false } = {}) {
  const out = new Map();
  if (!Array.isArray(messages)) return out;
  const lastId = messages[messages.length - 1]?.info?.id;
  let i = 0;
  while (i < messages.length) {
    const head = messages[i];
    if (head?.info?.role !== "user" && !isBackgroundResultMessage(head)) {
      i++;
      continue;
    }
    let j = i + 1;
    let firstStart = null;
    let lastEnd = null;
    let tokens = 0;
    let last = null;
    let seed = null;
    while (j < messages.length && messages[j]?.info?.role === "assistant" && !isBackgroundResultMessage(messages[j])) {
      const m = messages[j];
      const t = m.info.time;
      if (firstStart == null && t?.created != null) firstStart = t.created;
      if (t?.completed != null) lastEnd = t.completed;
      const tok = m.info.tokens;
      if (tok) tokens += (tok.output ?? 0) + (tok.reasoning ?? 0);
      if (seed == null) seed = m.info.id;
      last = m;
      j++;
    }
    if (last && seed != null && !(running && last.info.id === lastId) && last.info.time?.completed != null) {
      out.set(last.info.id, {
        durationMs: firstStart != null && lastEnd != null && lastEnd > firstStart ? lastEnd - firstStart : null,
        tokens: tokens > 0 ? tokens : null,
        verbSeedId: seed,
      });
    }
    i = j;
  }
  return out;
}

/** The truncation the transcript itself records for an assistant message: `{kind, label, hint}` or null. */
export function truncationOf(message) {
  if (message?.info?.role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let stepReason = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.type === "step-finish" && typeof p.reason === "string" && p.reason !== "") {
      stepReason = p.reason;
      break;
    }
  }
  const finish = message.info.finish;
  const kind = classifyFinish(stepReason ?? finish, { lastPartIsToolUse: finish === "tool-calls" });
  if (!kind) return null;
  const { label, hint } = describeTruncation(kind);
  return { kind, label, hint };
}

/**
 * Add `view` to each message. Pure: returns new message objects; a message with nothing to say gets no `view`.
 * `running`: the session has a turn in flight (the box reads it from the interpreter), which withholds the footer of
 * the in-flight turn.
 */
export function annotateView(messages, { running = false } = {}) {
  const turns = computeTurns(messages, { running });
  return messages.map((m) => {
    const view = {};
    const turn = turns.get(m?.info?.id);
    if (turn) view.turn = turn;
    const truncation = truncationOf(m);
    if (truncation) view.truncation = truncation;
    return Object.keys(view).length > 0 ? { ...m, view } : m;
  });
}

/** A single message annotated alone (`getMessage`): a truncation, never a turn (a turn needs its neighbours). */
export function annotateSingle(message) {
  if (!message) return message;
  const truncation = truncationOf(message);
  return truncation ? { ...message, view: { truncation } } : message;
}
