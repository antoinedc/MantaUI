// questionsDecorator.mjs — the plan card's data, decided on the box (WS11 D10 / audit T16).
//
// The model's `plan_exit` tool asks a question ("Plan ready — build?"). Each client used to find the matching
// `plan_exit` tool part in its OWN copy of the transcript to turn that question into a plan card (title, text, step
// and file counts, the plan file, the shareable page). Now every question the box publishes — on the `questions` stream
// frame, in its connect snapshot and from `opencode:questions` — may carry `plan`:
//
//   plan?: { title, text, steps, files, path, pageUrl }
//
// present iff a `plan_exit` tool part with the question's `tool.callID` exists (exact match, never the text).
//
// The interpreter stays synchronous: `createQuestionsDecorator().publish` wraps its publish. A `questions` frame whose
// questions carry a `tool.callID` is decorated (one transcript read per (session, callID), cached) before it goes out;
// a per-session sequence number drops a decorated publish a NEWER frame has overtaken. The decorated list is kept so the
// connect snapshot replays it.

import { planRefsFromPart } from "./artifacts.mjs";
import { planPageUrl } from "../shared/planMode.mjs";

// ---- pure ----------------------------------------------------------------------------------------------------------

function toolPartName(part) {
  if (typeof part?.tool === "string" && part.tool) return part.tool;
  const nested = part?.state?.input?.tool;
  return typeof nested === "string" ? nested : "";
}

/** The first markdown heading (`/^#{1,6}[ \t]+(.+)$/m`), trimmed, or null. */
export function firstHeading(text) {
  return /^#{1,6}[ \t]+(.+)$/m.exec(text)?.[1]?.trim() || null;
}

/**
 * Steps and files in a plan body, for the card's metrics line. A step is a markdown heading whose text begins with
 * "Step"; a file is a bullet whose content names a path-like code span. Empty input → (0, 0). (The phone's definition,
 * moved verbatim; the desktop never showed counts.)
 */
export function planMetrics(text) {
  if (!text) return { steps: 0, files: 0 };
  let steps = 0;
  let files = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const heading = /^#{1,6}[ \t]+(.+)$/.exec(trimmed)?.[1]?.trim();
    if (heading !== undefined && heading.toLowerCase().startsWith("step")) steps += 1;
    else if (/^[-*][ \t]+[^`]*`[^`]*\.[A-Za-z0-9_-]+`/.test(trimmed)) files += 1;
  }
  return { steps, files };
}

/**
 * The plan for one question, from the session's transcript: null when no `plan_exit` part carries the question's
 * callID. `path` = the part's own plan ref, else the first `.opencode/plans/*.md` ref anywhere in the transcript
 * (authoring tools only — `planRefsFromPart`'s rules); `pageUrl` is null when the box has no public base URL.
 */
export function planForQuestion({ question, messages, sessionId, baseUrl }) {
  const callID = question?.tool?.callID;
  if (!callID) return null;
  let text = "";
  let partPath = null;
  let found = false;
  outer: for (const msg of messages ?? []) {
    for (const part of msg?.parts ?? []) {
      if (part?.type !== "tool" || part.callID !== callID || toolPartName(part) !== "plan_exit") continue;
      found = true;
      const input = part.state?.input ?? part.input;
      const t = input?.plan ?? input?.content ?? input?.text;
      if (typeof t === "string") text = t;
      partPath = planRefsFromPart(part)[0] ?? null;
      break outer;
    }
  }
  if (!found) return null;
  let path = partPath;
  if (!path) {
    scan: for (const msg of messages ?? []) {
      for (const part of msg?.parts ?? []) {
        const ref = planRefsFromPart(part)[0];
        if (ref) {
          path = ref;
          break scan;
        }
      }
    }
  }
  const firstLine = text.split("\n").find((l) => l.trim())?.trim();
  const title = firstHeading(text) ?? firstLine ?? (question.questions?.[0]?.header || "Plan complete");
  const { steps, files } = planMetrics(text);
  return { title, text, steps, files, path: path ?? null, pageUrl: baseUrl ? planPageUrl(sessionId, baseUrl) : null };
}

/**
 * Whether a question is opencode's plan_exit approval: decorated (`q.plan`), else by opencode's own literal — it starts
 * "Plan at " and carries header "Build Agent". THE one predicate server code uses (the push notification fires on the
 * raw event, before decoration), so it must not be re-declared elsewhere.
 */
export function isPlanExitQuestion(q) {
  if (!q || typeof q !== "object") return false;
  if (q.plan != null) return true;
  const question = typeof q.question === "string" ? q.question : "";
  return question.startsWith("Plan at ") || q.header === "Build Agent";
}

// ---- stateful ------------------------------------------------------------------------------------------------------

const NEGATIVE_TTL_MS = 10_000;
const CACHE_MAX = 200;

/**
 * @param {object} d
 * @param {(evt: object) => void} d.publish  the real bus publish
 * @param {(sessionId: string) => Promise<object[]>} d.listMessages  `oc.listMessages(sid, {slim:true})`
 * @param {() => string|null} d.baseUrl  the box's public base URL (null when none)
 * @param {() => number} [d.now]
 * @param {(msg: string, err?: unknown) => void} [d.warn]
 */
export function createQuestionsDecorator({ publish, listMessages, baseUrl, now = Date.now, warn = (m, e) => console.warn(m, e?.message ?? e ?? "") }) {
  const cache = new Map(); // `${sid}\0${callID}` → { plan: object|null, at: number }
  const seq = new Map(); // sid → latest questions-frame sequence
  const latest = new Map(); // sid → the last decorated list published

  const key = (sid, callID) => `${sid}\u0000${callID}`;
  const callIDs = (questions) => questions.map((q) => q?.tool?.callID).filter(Boolean);

  function cached(sid, callID) {
    const e = cache.get(key(sid, callID));
    if (!e) return undefined;
    if (e.plan === null && now() - e.at > NEGATIVE_TTL_MS) {
      cache.delete(key(sid, callID));
      return undefined;
    }
    return e.plan;
  }

  function remember(sid, callID, plan) {
    cache.delete(key(sid, callID));
    cache.set(key(sid, callID), { plan, at: now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** Decorate from what is already known; `pending` are the callIDs still to look up. */
  function decorateFromCache(sid, questions) {
    const pending = [];
    const out = questions.map((q) => {
      const callID = q?.tool?.callID;
      if (!callID) return q;
      const plan = cached(sid, callID);
      if (plan === undefined) {
        pending.push(callID);
        return q;
      }
      return plan ? { ...q, plan } : q;
    });
    return { questions: out, pending };
  }

  async function decorate(sid, questions) {
    const first = decorateFromCache(sid, questions);
    if (first.pending.length === 0) return first.questions;
    let messages = [];
    try {
      messages = await listMessages(sid);
    } catch (e) {
      warn(`[questions] transcript read for ${sid} failed`, e);
      return questions; // undecorated beats blocked: the question is still answerable
    }
    const url = baseUrl();
    for (const q of questions) {
      const callID = q?.tool?.callID;
      if (!callID || cached(sid, callID) !== undefined) continue;
      remember(sid, callID, planForQuestion({ question: q, messages, sessionId: sid, baseUrl: url }));
    }
    return decorateFromCache(sid, questions).questions;
  }

  function publishQuestions(evt) {
    const sid = evt.sessionId;
    const questions = Array.isArray(evt.payload?.questions) ? evt.payload.questions : [];
    const mine = (seq.get(sid) ?? 0) + 1;
    seq.set(sid, mine);
    const sync = decorateFromCache(sid, questions);
    const emit = (list) => {
      latest.set(sid, list);
      publish({ ...evt, payload: { ...evt.payload, questions: list } });
    };
    if (callIDs(questions).length === 0 || sync.pending.length === 0) {
      emit(sync.questions);
      return;
    }
    void decorate(sid, questions).then((list) => {
      if (seq.get(sid) !== mine) return; // a newer `questions` frame overtook this one
      emit(list);
    });
  }

  return {
    /** The interpreter's publish: `questions` frames are decorated, everything else passes straight through. */
    publish(evt) {
      if (evt?.kind === "stream" && evt.sub === "questions") publishQuestions(evt);
      else publish(evt);
    },
    /** `opencode:questions` — the same decoration. */
    decorate,
    /** The connect snapshot's `questions` frames, decorated from what is cached (a session never decorated stays plain). */
    decorateSnapshot(frames) {
      return frames.map((f) => {
        if (f?.kind !== "stream" || f.sub !== "questions") return f;
        const { questions } = decorateFromCache(f.sessionId, f.payload?.questions ?? []);
        return { ...f, payload: { ...f.payload, questions } };
      });
    },
    _state: { cache, seq, latest },
  };
}
