// taskQuestions.mjs — a specialist task's question that does NOT block the task
// (docs/superpowers/specs/2026-11-26-agents-screens.md §4).
//
// OpenCode's `question` tool blocks the calling turn until its form is replied to, which can't be changed from here. So a
// captured question is answered AT ONCE with a fixed placeholder (the task keeps working), the question waits in a store the
// chat and "Needs you" read, and the user's real answer is delivered later as a message: steered into the running turn, or as
// a continuation of a task that has finished.
//
// Dependency-injected like routines.mjs / agents.mjs: tests drive it with fakes and a temp root.
//
// LOCKS (one order, spec §4.7). Outermost first: the delegate's per-session resource lock → the delegate's jobs lock → THE
// STORE MUTEX HERE. The store mutex guards only reads and writes of `.questions.json`: no network call (`replyQuestion`,
// `deliverToTask`, `readMessageStrict`, `loadRecords`) ever runs under it. Every operation is read-decide-write inside the mutex,
// then I/O outside it, then a second short read-decide-write that records the outcome.
//
// Nothing here marks a question answered before its delivery succeeded: a refusal leaves it `open` with `error` set.

import fsPromises from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { createMutex, writeJsonAtomic } from "./jsonStore.mjs";
import { acceptsFreeText, answerText, decisionFromForm, dismissText, PLACEHOLDER_ANSWER } from "./taskDecision.mjs";

export const QUESTIONS_FILE = ".questions.json";
/** Questions one task may have waiting at the same time; the next one takes the old path (the task ends "needs a decision"). */
export const QUESTIONS_OPEN_MAX = 3;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const STORE_MAX = 300;
/** A claim (an answer being delivered) younger than this may still be in flight: the sweep leaves it alone. */
const CLAIM_GRACE_MS = 90_000;
/** A capture younger than this may still be between its store write and its reply. */
const REPLY_GRACE_MS = 60_000;
const MILESTONE_MAX = 120;

const STORE_UNREADABLE = "Couldn't read the saved questions, so nothing was changed; try again";
const LOST_IN_RESTART = "The task's question was lost in a restart";
const ALREADY_SENDING = "Already sending your answer";
const NO_SUCH_QUESTION = "That question no longer exists.";
const NEEDS_ANSWER = "Answer every question first.";

class StoreError extends Error {}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mintMessageId = () => `msg_${randomUUID().replaceAll("-", "")}`;
const mintQuestionId = () => `tq_${randomBytes(8).toString("hex")}`;
const errorText = (e) => String(e?.message ?? e);

// What leaves the box: the contract's fields only (the bookkeeping of a capture / delivery stays here).
// eslint-disable-next-line no-unused-vars
const wire = ({ childSessionID, formID, pendingReply, sent, ...q }) => structuredClone(q);

// a question the engine still owes something for: waiting for the user, being delivered, or answered but not yet sent
const isLive = (q) => q.state === "open" || !!q.delivering || q.delivery === "continue-pending";

const plain = (q) => !!q && typeof q === "object" && typeof q.id === "string" && typeof q.rootJobId === "string";
const isTerminal = (r) => r?.status === "done" || r?.status === "failed" || r?.status === "stopped";

/** "You answered: …" — the labels and typed text of every question, short. */
const shortAnswer = (answer) =>
  cut(
    (Array.isArray(answer) ? answer : [])
      .map((a) => (Array.isArray(a) ? a.map(oneLine).filter(Boolean).join(", ") : ""))
      .filter(Boolean)
      .join("; "),
    MILESTONE_MAX,
  );

/**
 * @param {object} deps
 * @param {string} [deps.root]       ~/.manta/agents (the store is `<root>/.questions.json`)
 * @param {object} [deps.fs]         node:fs/promises
 * @param {() => number} [deps.now]
 * @param {(payload: {id: string, parentSessionID: string, rootJobId: string, state: string}) => void} deps.publish  a hint that a question changed
 * @param {object} deps.delegate     { rootJobOf(job), loadRecords(), deliverToTask(rootJobId, text, {messageID, steerOnly?}), addJobMilestone(rootJobId, text) — on the task's newest round }
 * @param {object} deps.oc           { replyQuestion({requestId, answers, sessionId}), readMessageStrict(sessionId, messageId), listQuestions(sessionId) }
 * @param {{ runExclusive(fn: () => Promise<any>): Promise<any> }} [deps.mutex]  the store mutex (a test seam)
 * @param {(job: object) => string | null | Promise<string | null>} [deps.projectOf]  the registry slug of a task's folder
 * @param {{ warn?: Function }} [deps.log]
 */
export function createTaskQuestions({
  root = statePath("agents"),
  fs = fsPromises,
  now = () => Date.now(),
  publish = () => {},
  delegate,
  oc,
  mutex = createMutex(),
  projectOf = null,
  log = console,
} = {}) {
  const file = join(root, QUESTIONS_FILE);
  let cache = null; // the last list read or written, for the synchronous questions (hasOpen / openCountFor)

  function primeSync() {
    if (cache) return cache;
    try {
      const doc = JSON.parse(readFileSync(file, "utf-8"));
      cache = Array.isArray(doc?.questions) ? doc.questions.filter(plain) : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  /** The store. `strict`: a missing file is empty, anything unreadable THROWS (every mutation reads this way: never saved over). */
  async function readStore({ strict = false } = {}) {
    let text;
    try {
      text = await fs.readFile(file, "utf-8");
    } catch (e) {
      if (e?.code === "ENOENT") return [];
      if (strict) throw new StoreError(STORE_UNREADABLE);
      return null;
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      if (strict) throw new StoreError(STORE_UNREADABLE);
      return null;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.questions) || !doc.questions.every(plain)) {
      if (strict) throw new StoreError(STORE_UNREADABLE);
      return null;
    }
    return doc.questions;
  }

  // open and in-flight questions are never evicted; the rest go after a week, and the cap drops the oldest of them first
  function prune(list) {
    const t = now();
    let out = list.filter((q) => isLive(q) || t - (q.answeredAt ?? q.askedAt ?? 0) <= KEEP_MS);
    if (out.length > STORE_MAX) {
      const droppable = out.filter((q) => !isLive(q)).sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
      const drop = new Set(droppable.slice(0, out.length - STORE_MAX).map((q) => q.id));
      out = out.filter((q) => !drop.has(q.id));
    }
    return out;
  }

  /**
   * One read-decide-write under the store mutex. `fn(list)` is SYNCHRONOUS (no I/O may happen under the mutex): it edits the list
   * in place and returns `{ write, result }`. Throws StoreError when the store can't be read.
   */
  function mutate(fn) {
    return mutex.runExclusive(async () => {
      const list = await readStore({ strict: true });
      const { write, result } = fn(list);
      if (write) {
        const next = prune(list);
        await writeJsonAtomic(file, `${JSON.stringify({ version: 1, questions: next }, null, 2)}\n`);
        cache = next;
      } else {
        cache = list;
      }
      return result;
    });
  }

  /** Display reads: anything unreadable is "nothing to show", and the last good picture stays for the synchronous reads. */
  async function readLoose() {
    const list = await mutex.runExclusive(() => readStore());
    if (list) cache = list;
    return list ?? [];
  }

  function hint(q) {
    try {
      publish({ id: q.id, parentSessionID: q.parentSessionID, rootJobId: q.rootJobId, state: q.state });
    } catch (e) {
      log.warn?.(`[task-questions] couldn't publish a hint: ${errorText(e)}`);
    }
  }

  async function milestone(jobId, text) {
    try {
      await delegate.addJobMilestone?.(jobId, text);
    } catch (e) {
      log.warn?.(`[task-questions] couldn't add a milestone to ${jobId}: ${errorText(e)}`);
    }
  }

  const rootOf = (job) => delegate.rootJobOf(job);

  /** The newest round of a task: nothing supersedes it (highest attempt as the tie-break). */
  function newestRound(records, rootJobId) {
    const rounds = records.filter((r) => rootOf(r) === rootJobId);
    const live = rounds.filter((r) => !r.supersededBy);
    const pool = live.length > 0 ? live : rounds;
    return pool.reduce((best, r) => (!best || (r.attempt ?? 1) > (best.attempt ?? 1) || ((r.attempt ?? 1) === (best.attempt ?? 1) && (r.createdAt ?? 0) >= (best.createdAt ?? 0)) ? r : best), null);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // capture
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * A question form raised in the ROOT session of a running, Manta-owned specialist task. Stores it open, answers the form with the
   * placeholder, then records that the reply happened.
   * @returns {Promise<{captured: true, id: string} | {captured: false, reason: "free-text" | "no-question" | "limit" | "store" | "reply-failed"}>}
   *   `captured:false` means NOTHING was stored or replied: the caller takes the old path (the task ends "needs a decision").
   */
  async function capture(form, job) {
    if (!acceptsFreeText(form)) return { captured: false, reason: "free-text" };
    const decision = decisionFromForm(form, now());
    if (!decision) return { captured: false, reason: "no-question" };
    const rootJobId = rootOf(job);
    let project = null;
    try {
      project = (await projectOf?.(job)) ?? null;
    } catch {
      project = null; // the grid shows "—": never a reason to lose a question
    }
    const agent = typeof job.agent === "string" ? job.agent : "";
    const rec = {
      id: mintQuestionId(),
      rootJobId,
      jobId: job.id,
      parentSessionID: job.parentSessionID,
      agentSlug: agent.startsWith("agent-") ? agent.slice("agent-".length) : null,
      agentName: typeof job.agentName === "string" && job.agentName ? job.agentName : agent.replace(/^agent-/, "") || "Agent",
      project,
      taskName: job.name ?? "",
      questions: decision.questions,
      state: "open",
      askedAt: now(),
      answeredAt: null,
      answer: null,
      delivery: null,
      delivering: null,
      error: null,
      childSessionID: job.childSessionID,
      formID: form.id,
      pendingReply: true,
    };

    let stored;
    try {
      stored = await mutate((list) => {
        if (list.filter((q) => q.rootJobId === rootJobId && q.state === "open").length >= QUESTIONS_OPEN_MAX) return { write: false, result: "limit" };
        list.push(rec);
        return { write: true, result: "stored" };
      });
    } catch (e) {
      log.warn?.(`[task-questions] ${errorText(e)}`);
      return { captured: false, reason: "store" };
    }
    if (stored === "limit") return { captured: false, reason: "limit" };

    // the placeholder goes to the form, no lock held: the task's turn goes on
    try {
      await oc.replyQuestion({ requestId: form.id, sessionId: form.sessionID, answers: form.fields.map(() => [PLACEHOLDER_ANSWER]) });
    } catch (e) {
      log.warn?.(`[task-questions] replying to the question of ${job.id} failed: ${errorText(e)}`);
      try {
        await mutate((list) => {
          const i = list.findIndex((q) => q.id === rec.id);
          if (i >= 0) list.splice(i, 1);
          return { write: i >= 0, result: null };
        });
      } catch (e2) {
        log.warn?.(`[task-questions] couldn't take back an unanswered question: ${errorText(e2)}`); // the sweep fails it
      }
      return { captured: false, reason: "reply-failed" };
    }
    try {
      await mutate((list) => {
        const q = list.find((x) => x.id === rec.id);
        if (q) q.pendingReply = false;
        return { write: !!q, result: null };
      });
    } catch (e) {
      log.warn?.(`[task-questions] couldn't record the reply to ${rec.id} (the sweep will): ${errorText(e)}`);
    }
    await milestone(rootJobId, `Asked you: ${cut(oneLine(decision.questions[0].question), MILESTONE_MAX)}`);
    hint(rec);
    return { captured: true, id: rec.id };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // answer / dismiss
  // ---------------------------------------------------------------------------------------------------------------------

  const clean = (answers, questions) => {
    if (!Array.isArray(answers) || answers.length !== questions.length) return null;
    const out = [];
    for (const a of answers) {
      if (!Array.isArray(a)) return null;
      const picked = a.map((x) => oneLine(x)).filter(Boolean);
      if (picked.length === 0) return null;
      out.push(picked);
    }
    return out;
  };

  /**
   * The user's answer: claim → deliver → record (spec §4.2 step 3).
   * @returns {Promise<{ok: true, question: object} | {ok: false, error: string, question?: object}>}
   */
  async function answer(id, answers) {
    let claim;
    try {
      claim = await mutate((list) => {
        const q = list.find((x) => x.id === id);
        if (!q) return { write: false, result: { refusal: NO_SUCH_QUESTION } };
        if (q.state === "answered") return { write: false, result: { unchanged: wire(q) } };
        if (q.state === "dismissed") return { write: false, result: { refusal: "That question was dismissed.", q: wire(q) } };
        if (q.state === "failed") return { write: false, result: { refusal: q.error ?? "That question can't be answered any more.", q: wire(q) } };
        if (q.delivering) return { write: false, result: { refusal: ALREADY_SENDING, q: wire(q) } };
        const picked = clean(answers, q.questions);
        if (!picked) return { write: false, result: { refusal: NEEDS_ANSWER, q: wire(q) } };
        const messageID = mintMessageId();
        const text = answerText(q.questions, picked);
        q.delivering = { messageID, at: now() };
        q.answer = picked;
        q.sent = { messageID, text };
        return { write: true, result: { messageID, text, rootJobId: q.rootJobId } };
      });
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    if (claim.unchanged) return { ok: true, question: claim.unchanged };
    if (claim.refusal) return { ok: false, error: claim.refusal, ...(claim.q ? { question: claim.q } : {}) };

    // deliver, no lock held
    let res;
    try {
      res = await delegate.deliverToTask(claim.rootJobId, claim.text, { messageID: claim.messageID });
    } catch (e) {
      res = { error: `Couldn't send your answer: ${errorText(e)}` };
    }
    const failed = !res || typeof res.error === "string" || !res.delivery;
    const error = failed ? (typeof res?.error === "string" ? res.error : "Couldn't send your answer.") : null;

    let recorded;
    try {
      recorded = await mutate((list) => {
        const q = list.find((x) => x.id === id);
        if (!q) return { write: false, result: null };
        // (a sweep may have cleared a claim it judged lost while this was still in flight; the send itself decides the outcome)
        if (q.state !== "open" || (q.delivering && q.delivering.messageID !== claim.messageID)) return { write: false, result: wire(q) };
        q.delivering = null;
        if (failed) {
          q.error = error;
          q.answer = null;
          delete q.sent;
        } else {
          q.state = "answered";
          q.answeredAt = now();
          q.delivery = res.delivery;
          q.error = null;
        }
        return { write: true, result: wire(q) };
      });
    } catch (e) {
      // the message may already have been sent: say so rather than hide it (the sweep settles the claim from the session)
      return { ok: false, error: failed ? error : `Your answer was sent, but couldn't be recorded: ${errorText(e)}` };
    }
    if (recorded) hint(recorded);
    if (failed) return { ok: false, error, ...(recorded ? { question: recorded } : {}) };
    await milestone(claim.rootJobId, `You answered: ${shortAnswer(recorded?.answer)}`);
    return { ok: true, question: recorded };
  }

  /**
   * Dismiss a question: it is marked dismissed, and a running task is told (a steer only: a finished task is left as is).
   * @returns {Promise<{ok: true, question: object, warning?: string} | {ok: false, error: string}>}
   */
  async function dismiss(id) {
    let out;
    try {
      out = await mutate((list) => {
        const q = list.find((x) => x.id === id);
        if (!q) return { write: false, result: { refusal: NO_SUCH_QUESTION } };
        if (q.delivering) return { write: false, result: { refusal: ALREADY_SENDING } };
        if (q.state === "answered" || q.state === "dismissed") return { write: false, result: { unchanged: wire(q) } };
        q.state = "dismissed";
        q.error = null;
        return { write: true, result: { question: wire(q), rootJobId: q.rootJobId, questions: q.questions } };
      });
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    if (out.unchanged) return { ok: true, question: out.unchanged };
    if (out.refusal) return { ok: false, error: out.refusal };
    hint(out.question);
    let warning;
    try {
      const res = await delegate.deliverToTask(out.rootJobId, out.questions.map(dismissText).join("\n"), { messageID: mintMessageId(), steerOnly: true });
      if (typeof res?.error === "string" && !/no longer exists/.test(res.error)) warning = res.error;
    } catch (e) {
      warning = `Couldn't tell the task: ${errorText(e)}`;
    }
    return { ok: true, question: out.question, ...(warning ? { warning } : {}) };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------------------------------------------------

  /** The questions waiting for the user, newest first: one chat's (`sessionID`), or every chat's. */
  async function listOpen({ sessionID } = {}) {
    const open = (await readLoose()).filter((q) => q.state === "open");
    if (open.length === 0) return [];
    // a handoff re-points the task's records to the successor chat, not the questions: ask the task where it lives now
    let records = null;
    try {
      records = (await delegate.loadRecords?.()) ?? null;
    } catch {
      records = null;
    }
    const out = open.map((q) => {
      const round = records ? newestRound(records, q.rootJobId) : null;
      return wire(round?.parentSessionID ? { ...q, parentSessionID: round.parentSessionID } : q);
    });
    return out.filter((q) => sessionID === undefined || q.parentSessionID === sessionID).sort((a, b) => b.askedAt - a.askedAt);
  }

  /** Is anything of this task still unresolved — waiting, being delivered, or answered but not yet sent? (open proposals never release meanwhile) */
  const hasOpen = (rootJobId) => primeSync().some((q) => q.rootJobId === rootJobId && isLive(q));
  /** How many questions of this task are waiting for the user (a card each). */
  const openCountFor = (rootJobId) => primeSync().filter((q) => q.rootJobId === rootJobId && q.state === "open").length;

  /**
   * The questions of this task still waiting for the user's answer — the first question of each card — as the result of a round that ended
   * meanwhile says it ("Waiting for the user's answer to: …"). Synchronous: the delegate reads it while it writes the round's terminal state.
   */
  const waitingFor = (rootJobId) =>
    primeSync()
      .filter((q) => q.rootJobId === rootJobId && q.state === "open" && Array.isArray(q.questions) && q.questions[0])
      .sort((a, b) => a.askedAt - b.askedAt)
      .map((q) => structuredClone(q.questions[0]));

  // ---------------------------------------------------------------------------------------------------------------------
  // the ending gate's side (delegate.mjs runs the gate itself, under the session lock)
  // ---------------------------------------------------------------------------------------------------------------------

  /** The answers of a task that were steered into its turn and may still sit unconsumed in its inbox: `[{id, messageID, text}]`. Throws when the store is unreadable. */
  async function pendingSteer(rootJobId) {
    const list = await mutate((l) => ({ write: false, result: l.map((q) => structuredClone(q)) }));
    return list
      .filter((q) => q.rootJobId === rootJobId && q.sent && ((q.state === "answered" && q.delivery === "steer") || (q.state === "open" && q.delivering)))
      .map((q) => ({ id: q.id, messageID: q.sent.messageID, text: q.sent.text }));
  }

  /** The steered answers `ids` were taken back out of the inbox: they are to be sent with a continuation instead. */
  async function markContinuePending(rootJobId, ids) {
    const wanted = new Set(ids);
    if (wanted.size === 0) return;
    const changed = await mutate((list) => {
      const hit = [];
      for (const q of list) {
        if (q.rootJobId !== rootJobId || !wanted.has(q.id)) continue;
        q.state = "answered";
        q.answeredAt = q.answeredAt ?? now();
        q.delivery = "continue-pending";
        q.delivering = null;
        q.error = null;
        hit.push(wire(q));
      }
      return { write: hit.length > 0, result: hit };
    });
    for (const q of changed) hint(q);
  }

  /** Does this task hold an answer that is waiting for its round to end? Throws when the store is unreadable. */
  async function hasContinuePending(rootJobId) {
    const list = await mutate((l) => ({ write: false, result: l.map((q) => structuredClone(q)) }));
    return list.some((q) => q.rootJobId === rootJobId && q.state === "answered" && q.delivery === "continue-pending");
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // a round ended with answers waiting
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * The round `job` ended (its record says "deferred"): every continue-pending answer of its task goes out in ONE continuation.
   * @returns {Promise<{continued: boolean, error?: string}>} `continued:true`: the answers are on their way in a new round (the caller then
   *   posts no result and skips the cleanup); `false` with `error`: the answers are open again; `false` without: nothing to send, or it will be sent later.
   */
  async function onRoundSettled(job) {
    const rootJobId = rootOf(job);
    let claim;
    try {
      claim = await mutate((list) => {
        const mine = list.filter((q) => q.rootJobId === rootJobId && q.state === "answered" && q.delivery === "continue-pending" && !q.delivering);
        if (mine.length === 0) return { write: false, result: null };
        const messageID = mintMessageId();
        const text = mine.map((q) => answerText(q.questions, q.answer)).join("\n\n");
        for (const q of mine) {
          q.delivering = { messageID, at: now() };
          q.sent = { messageID, text };
        }
        return { write: true, result: { ids: mine.map((q) => q.id), messageID, text } };
      });
    } catch (e) {
      log.warn?.(`[task-questions] ${errorText(e)}`);
      return { continued: false, error: errorText(e) };
    }
    if (!claim) return { continued: false };

    let res;
    try {
      res = await delegate.deliverToTask(rootJobId, claim.text, { messageID: claim.messageID });
    } catch (e) {
      res = { error: `Couldn't send your answer: ${errorText(e)}` };
    }
    const failed = !res || typeof res.error === "string" || !res.delivery;
    const error = failed ? (typeof res?.error === "string" ? res.error : "Couldn't send your answer.") : null;
    let changed = [];
    try {
      changed = await mutate((list) => {
        const hit = [];
        for (const q of list) {
          if (!claim.ids.includes(q.id) || q.delivering?.messageID !== claim.messageID) continue;
          q.delivering = null;
          if (failed) {
            // the answers go back to the user, with the reason
            q.state = "open";
            q.answeredAt = null;
            q.delivery = null;
            q.error = error;
            delete q.sent;
          } else {
            q.delivery = res.delivery;
          }
          hit.push(wire(q));
        }
        return { write: hit.length > 0, result: hit };
      });
    } catch (e) {
      log.warn?.(`[task-questions] couldn't record the continuation of ${rootJobId} (the sweep will): ${errorText(e)}`);
    }
    for (const q of changed) hint(q);
    if (failed) return { continued: false, error };
    return { continued: res.delivery === "continue" || res.delivery === "steer" };
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // sweep (boot and every 60 s)
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * Settle what a crash or a lost response left behind:
   *  - a claim (an answer being delivered) with no outcome, older than the grace: the child holds the message → answered (steer); a newer round
   *    was created with that message id → answered (continue); neither → the claim is cleared (the question stays as it was; the user can press again);
   *  - a capture whose reply never happened: the form is still pending → failed; the form is gone → only the record was lost;
   *  - an answer waiting for a finished task that isn't being deferred → sent now.
   */
  async function sweep() {
    const t = now();
    const list = await readLoose();
    if (list.length === 0) return;
    let records = null;
    try {
      records = (await delegate.loadRecords?.()) ?? null;
    } catch {
      records = null;
    }

    // 1. stale claims
    for (const q of list.filter((x) => x.delivering && t - x.delivering.at > CLAIM_GRACE_MS)) {
      const messageID = q.delivering.messageID;
      let found = null;
      if (records?.some((r) => r?.launch?.messageId === messageID && r.launch?.continuation)) found = "continue";
      else if (q.childSessionID) {
        try {
          const read = oc.readMessageStrict ? await oc.readMessageStrict(q.childSessionID, messageID) : { state: "unknown" };
          if (read?.state === "found") found = "steer";
          else if (read?.state !== "missing") continue; // unknown proves nothing
        } catch {
          continue;
        }
      }
      try {
        const changed = await mutate((l) => {
          const x = l.find((y) => y.id === q.id);
          if (!x || x.delivering?.messageID !== messageID) return { write: false, result: null };
          x.delivering = null;
          if (found) {
            x.state = "answered";
            x.answeredAt = x.answeredAt ?? now();
            x.delivery = found;
            x.error = null;
          } else if (x.state === "open") {
            delete x.sent;
            x.answer = null;
          }
          return { write: true, result: wire(x) };
        });
        if (changed) hint(changed);
      } catch (e) {
        log.warn?.(`[task-questions] sweep: ${errorText(e)}`);
      }
    }

    // 2. captures that never got their reply
    for (const q of list.filter((x) => x.pendingReply && x.state === "open" && t - x.askedAt > REPLY_GRACE_MS)) {
      let stillPending;
      try {
        stillPending = ((await oc.listQuestions?.(q.childSessionID)) ?? []).some((f) => f?.id === q.formID);
      } catch {
        continue;
      }
      try {
        const changed = await mutate((l) => {
          const x = l.find((y) => y.id === q.id);
          if (!x || !x.pendingReply || x.state !== "open") return { write: false, result: null };
          x.pendingReply = false;
          if (stillPending) {
            x.state = "failed";
            x.error = LOST_IN_RESTART;
          }
          return { write: true, result: wire(x) };
        });
        if (changed) hint(changed);
      } catch (e) {
        log.warn?.(`[task-questions] sweep: ${errorText(e)}`);
      }
    }

    // 3. answers waiting for a task that has already finished (a deferred round is the engine's: it calls onRoundSettled itself)
    if (records) {
      const roots = new Set(list.filter((q) => q.state === "answered" && q.delivery === "continue-pending" && !q.delivering).map((q) => q.rootJobId));
      for (const rootJobId of roots) {
        const round = newestRound(records, rootJobId);
        if (!round || !isTerminal(round) || round.completionDelivery === "deferred" || round.completionDelivery === "pending") continue;
        await onRoundSettled(round);
      }
    }
  }

  return {
    capture,
    answer,
    dismiss,
    listOpen,
    openCountFor,
    hasOpen,
    waitingFor,
    onRoundSettled,
    sweep,
    // the ending gate's side of the store (delegate.mjs)
    pendingSteer,
    markContinuePending,
    hasContinuePending,
  };
}
