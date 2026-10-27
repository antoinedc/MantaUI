// handoff/engine.mjs — the stateful auto-handoff engine (spec §2–§7, §15).
//
// One in-memory source of truth (`state`, loaded SYNCHRONOUSLY so a fence is in
// force from the first admission after a boot) mirrored to disk through the
// injected `save`. Everything a restart must reconstruct is in `state`:
// records, links, continuations, fences, held admissions. Everything else
// (reservations, userRevision, the operation registry, the release flags) is
// deliberately in-memory and starts empty.
//
// Three rules the rest of the file is arranged around:
//   • Every check-and-set that guards admission is SYNCHRONOUS (no `await`
//     between the check and the set) — that is what makes a single-process
//     server race-free without a lock on the hot path.
//   • Steps 1–3 of a start are reversible; from the first delivery POST attempt
//     (or the first commit sub-step) the start only ever recovers FORWARD.
//   • Nothing talks to opencode or tmux except through the injected `oc` /
//     `tmux` objects, so the whole protocol is unit-testable with a fake world.

import { randomUUID } from "node:crypto";
import { COOLDOWN_MS, DEFAULT_HANDOFF_MODE, HANDOFF_MODES, decideAutoTrigger, entryPlan, handoffBudget, normalizeMode } from "./policy.mjs";
import { buildGeneratePrompt, composeHandoffText, factLines, missingHeadings } from "./text.mjs";
import { continuationUnconsumed, emptyState, mintRecordId, normalizeState, pruneLinks, pruneRecords, publicEvent, publicRecord } from "./state.mjs";

export class HandoffError extends Error {
  /** @param {string} code @param {string} message @param {{ handoff?: object }} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.handoff = extra.handoff;
  }
}
/** HTTP status for a HandoffError code (the REST route and the rpc layer share it). */
export const ERROR_STATUS = Object.freeze({
  invalid: 400,
  expired: 404,
  already_started: 409,
  busy: 409,
  dismissed: 409,
  not_ready: 422,
  no_window: 422,
  generation_failed: 502,
  unavailable: 503,
});

// Thrown inside the reversible phase to unwind through rollback().
class Rollback extends Error {}

const PREAMBLE_SEP = "\n\n---\n\n";
const OP_GENERATE = "handoff-generate";
const OP_START = "handoff-start";
const MAX_POST_ATTEMPTS = 4;
const MAX_CHAIN = 50;
const isDefinite = (e) => typeof e?.status === "number" && e.status >= 400 && e.status < 500;
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shift agent/skill mention offsets by `by` characters (the preamble prefix). PURE. */
export function shiftOffsets(args, by) {
  const out = { ...args };
  if (Array.isArray(args.mentions)) {
    out.mentions = args.mentions.map((m) => ({
      ...m,
      source: m?.source ? { ...m.source, start: m.source.start + by, end: m.source.end + by } : m?.source,
    }));
  }
  if (Array.isArray(args.skills)) out.skills = args.skills.map((s) => ({ ...s, start: s.start + by, end: s.end + by }));
  return out;
}

/** The armed claim's payload: preamble + separator + the admission's own text, offsets shifted. PURE. */
export function applyPreamble(kind, args, preamble) {
  const prefix = `${preamble}${PREAMBLE_SEP}`;
  const text = typeof args.text === "string" ? args.text : "";
  if (kind === "synthetic") return { ...args, text: `${prefix}${text}` };
  return { ...shiftOffsets(args, prefix.length), text: `${prefix}${text}` };
}

/**
 * @param {object} deps  see the field comments below
 */
export function createHandoffEngine(deps = {}) {
  const {
    load = () => emptyState(),
    save = async () => {},
    now = Date.now,
    getMode = () => DEFAULT_HANDOFF_MODE,
    publish = () => {},
    warn = (...a) => console.warn(...a),
    oc = {},
    tmux = {},
    ownership = { repoint: async () => {} },
    onPendingSendCleared = () => {},
    onHeldFailure = () => {},
    gather = {},
    contextLimitFor = () => null,
    isExcluded = () => false,
    isJobSession = () => false,
    hooks = {},
    timers = { setTimeout: (fn, ms) => setTimeout(fn, ms) },
    sleep = sleepReal,
    retryDelayMs = 2000,
    generateTimeoutMs = 120_000,
    quietRetries = 3,
    quietDelayMs = 500,
    cooldownMs = COOLDOWN_MS,
    lookupTimeoutMs = 2000,
  } = deps;

  const mintSessionId = deps.mintSessionId ?? (() => `ses_${randomUUID().replaceAll("-", "")}`);
  const mintMessageId = deps.mintMessageId ?? (() => `msg_${randomUUID().replaceAll("-", "")}`);
  const mintId = deps.mintRecordId ?? mintRecordId;

  const state = normalizeState(load());
  for (const r of Object.values(state.records)) r.internal ??= {};

  // ---- in-memory runtime state (starts empty on every boot) -----------------
  const reservations = new Map(); // target session -> admissions in flight
  const userRev = new Map(); // target session -> accepted admissions so far
  const ops = new Map(); // session -> "handoff-generate" | "handoff-start" | "compaction"
  const releasing = new Set(); // targets whose held queue must drain before anything posts directly
  const draining = new Set();
  const running = new Set(); // record ids with a runStart in flight
  const stepCtx = new Map(); // session -> { tokens, providerID, modelID, at }
  const turns = new Map(); // session -> { busy, errored }
  const chains = new Map();
  const waiters = new Map(); // held item id -> { resolve, reject } (a direct admission waiting on its own claim)
  const retryTimers = new Map();

  // Targets with held admissions from before a restart keep joining the queue
  // until recovery drains it; a commit that was mid-flight too.
  for (const [target, q] of Object.entries(state.held)) if (q.length > 0 && !state.fences[target]) releasing.add(target);
  for (const r of Object.values(state.records)) if (r.state === "starting" && r.internal.commit && r.successorId) releasing.add(r.successorId);

  const hook = async (name) => {
    if (typeof hooks.step === "function") await hooks.step(name);
  };

  // ---- persistence ----------------------------------------------------------
  let saveTail = Promise.resolve();
  function persist() {
    const snapshot = JSON.parse(JSON.stringify(state));
    const p = saveTail.then(() => save(snapshot));
    saveTail = p.catch(() => {});
    return p;
  }
  function touch(rec) {
    rec.updatedAt = now();
    try {
      publish({ kind: "handoff", payload: publicEvent(rec) });
    } catch (e) {
      warn("[handoff] publish failed:", e?.message ?? e);
    }
  }
  /** Run a detached async job: its failure is logged, never an unhandled rejection. */
  function detach(label, fn) {
    return Promise.resolve()
      .then(fn)
      .catch((e) => {
        if (e?.crash) return; // a simulated process death (tests): nothing further happens
        warn(`[handoff] ${label} failed:`, e?.message ?? e);
      });
  }
  function serialize(key, fn) {
    const tail = (chains.get(key) ?? Promise.resolve())
      .then(fn)
      .catch((e) => warn(`[handoff] ${key} handling failed:`, e?.message ?? e));
    chains.set(key, tail);
    const drop = () => {
      if (chains.get(key) === tail) chains.delete(key);
    };
    tail.then(drop, drop);
    return tail;
  }

  // ---- §6.2 one maintenance operation per session -----------------------------
  function acquireOperation(sessionId, op) {
    const cur = ops.get(sessionId);
    if (cur && cur !== op) return false;
    ops.set(sessionId, op);
    return true;
  }
  function releaseOperation(sessionId, op) {
    if (ops.get(sessionId) === op) ops.delete(sessionId);
  }

  // ---- §6.1 the resolver -------------------------------------------------------
  function followReplacement(sessionId) {
    let t = sessionId;
    const seen = new Set();
    while (state.links[t]?.replacedBy && !seen.has(t)) {
      seen.add(t);
      t = state.links[t].replacedBy;
    }
    return t;
  }
  /**
   * SYNC. Follow REPLACEMENT links (never ancestry) to the live end. `fenced`
   * means admissions to `target` must be held right now (a transition fence).
   * @returns {{ target: string, fenced: boolean }}
   */
  function resolveAdmissionTarget(sessionId) {
    const target = followReplacement(sessionId);
    return { target, fenced: Boolean(state.fences[target]) };
  }
  const queueLen = (t) => state.held[t]?.length ?? 0;
  const holdActive = (t) => Boolean(state.fences[t]) || queueLen(t) > 0 || releasing.has(t) || Boolean(state.continuations[t]?.claim);

  // ---- admissions ---------------------------------------------------------------
  const rawPost = (kind, target, args) =>
    kind === "synthetic" ? oc.postSynthetic(target, args) : oc.sendPrompt({ ...args, sessionId: target });

  function stampId(kind, args) {
    if (kind === "synthetic") {
      const id = args.id ?? mintMessageId();
      return { id, args: { ...args, id } };
    }
    const id = args.messageID ?? mintMessageId();
    return { id, args: { ...args, messageID: id } };
  }

  async function enqueue(target, kind, args, id) {
    (state.held[target] ??= []).push({ id, kind, args, at: now() });
    await persist();
  }

  /** The message is in the session's inbox or history. true / false / "unknown". */
  async function reconcile(target, id) {
    try {
      const inbox = await oc.listInbox(target);
      if (Array.isArray(inbox) && inbox.some((i) => i?.id === id)) return true;
      if (await oc.getMessage(target, id)) return true;
      return false;
    } catch {
      return "unknown";
    }
  }

  /**
   * Post with the idempotent-id discipline of §5.3 step 3: a definitive refusal
   * of the FIRST attempt is a refusal; anything uncertain is reconciled by id
   * (inbox + history), and an absent message is re-posted with the same id.
   * `st.uncertain` carries across calls (and restarts, via `attempted`).
   * @returns {Promise<{ outcome: "accepted"|"refused"|"pending", error?: any }>}
   */
  async function postReconcile(target, kind, args, id, st) {
    for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      if (st.uncertain) {
        const found = await reconcile(target, id);
        if (found === true) return { outcome: "accepted" };
      }
      reservations.set(target, (reservations.get(target) ?? 0) + 1);
      try {
        await rawPost(kind, target, args);
        userRev.set(target, (userRev.get(target) ?? 0) + 1);
        return { outcome: "accepted" };
      } catch (e) {
        if (isDefinite(e) && !st.uncertain) return { outcome: "refused", error: e };
        st.uncertain = true;
      } finally {
        reservations.set(target, Math.max(0, (reservations.get(target) ?? 1) - 1));
      }
    }
    return { outcome: "pending" };
  }

  /**
   * Post one held item to `target`; the head item of an armed successor claims
   * its preamble first (§5.4).
   */
  async function postHeldItem(target, item) {
    const cont = state.continuations[target];
    let args = item.args;
    let claiming = false;
    if (cont?.preamble) {
      if (!cont.claim) {
        cont.claim = { messageId: item.id, kind: item.kind, args: applyPreamble(item.kind, item.args, cont.preamble) };
        await persist();
        await hook("claim");
        args = cont.claim.args;
        claiming = true;
      } else if (cont.claim.messageId === item.id) {
        args = cont.claim.args;
        claiming = true;
        item.attempted = true; // a claim found on disk was (maybe) already posted
      } else {
        return { outcome: "pending" };
      }
    }
    const wasAttempted = item.attempted === true;
    if (!claiming && !wasAttempted) {
      item.attempted = true;
      await persist();
    }
    const res = await postReconcile(target, item.kind, args, item.id, { uncertain: wasAttempted });
    if (claiming) {
      if (res.outcome === "accepted") {
        delete cont.preamble;
        delete cont.claim;
      } else if (res.outcome === "refused") {
        delete cont.claim;
      }
    }
    return res;
  }

  /** Drain `target`'s held queue in order. Re-entrancy safe; keeps `releasing` set until the queue is empty. */
  async function drainHeld(target) {
    if (draining.has(target)) return;
    draining.add(target);
    releasing.add(target);
    try {
      for (;;) {
        const q = state.held[target];
        if (!q || q.length === 0) break;
        const item = q[0];
        const res = await postHeldItem(target, item);
        if (res.outcome === "pending") {
          scheduleRetry(`drain:${target}`, () => drainHeld(target));
          const w = waiters.get(item.id);
          if (w) {
            waiters.delete(item.id);
            w.reject(Object.assign(new Error("delivery could not be confirmed yet"), { uncertain: true }));
          }
          return;
        }
        // Sync with the claim clearing above: one persist covers both. (Re-read the
        // queue: a commit may have replaced the array while the post was in flight.)
        if (state.held[target]?.[0] === item) state.held[target].shift();
        await hook("release-post");
        await persist();
        const w = waiters.get(item.id);
        if (w) {
          waiters.delete(item.id);
          if (res.outcome === "accepted") w.resolve({ deliveredTo: target });
          else w.reject(res.error);
        } else if (res.outcome === "refused") {
          try {
            await onHeldFailure({ target, item, error: res.error });
          } catch (e) {
            warn("[handoff] held-failure report failed:", e?.message ?? e);
          }
        }
      }
      // Empty: end the hold in the same synchronous block as the emptiness check.
      delete state.held[target];
      releasing.delete(target);
      await persist();
    } finally {
      draining.delete(target);
    }
  }

  function scheduleRetry(key, fn, attempt = 1) {
    if (retryTimers.has(key)) return;
    const h = timers.setTimeout(() => {
      retryTimers.delete(key);
      detach(key, fn);
    }, retryDelayMs * Math.min(attempt, 8));
    h?.unref?.();
    retryTimers.set(key, h);
  }

  /**
   * A message to a session — the one entry point every prompt/synthetic writer
   * goes through (promptDelivery's send, the rpc send handler, delegate's result
   * post). The FIRST synchronous action is the resolve + reserve.
   * @param {"prompt"|"synthetic"} kind
   * @param {string} sessionId
   * @param {object} rawArgs sendPrompt args (minus sessionId), or the synthetic body
   * @returns {Promise<{ deliveredTo: string, held?: boolean, messageId?: string }>}
   */
  async function admit(kind, sessionId, rawArgs) {
    const { target, fenced } = resolveAdmissionTarget(sessionId); // sync, before any await
    const cont = state.continuations[target];
    const queued = queueLen(target) > 0 || releasing.has(target) || Boolean(cont?.claim);
    if (!fenced && !queued && !cont?.preamble) {
      // The ordinary case: nothing is in the way. Reserve, post, bump the revision.
      reservations.set(target, (reservations.get(target) ?? 0) + 1);
      try {
        await rawPost(kind, target, rawArgs ?? {});
        userRev.set(target, (userRev.get(target) ?? 0) + 1);
        return { deliveredTo: target };
      } finally {
        reservations.set(target, Math.max(0, (reservations.get(target) ?? 1) - 1));
      }
    }
    // Held / claiming: the message needs a stable id before it is persisted.
    const { id, args } = stampId(kind, rawArgs ?? {});
    if (fenced) {
      const deliveredTo = state.fences[target].successorId;
      await enqueue(target, kind, args, id);
      return { deliveredTo, held: true, messageId: id };
    }
    if (queued) {
      await enqueue(target, kind, args, id);
      return { deliveredTo: target, held: true, messageId: id };
    }
    // First admission to an armed successor: it claims the preamble. Its own
    // queue entry makes the claim durable and orders everything behind it.
    (state.held[target] ??= []).push({ id, kind, args, at: now() });
    releasing.add(target);
    const done = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    done.catch(() => {});
    await persist();
    detach(`drain:${target}`, () => drainHeld(target));
    return { ...(await done), messageId: id };
  }

  /** A slash command is never held: while a handoff owns the session it is refused with a reason the user can act on. */
  function guardCommand(sessionId) {
    const { target } = resolveAdmissionTarget(sessionId);
    if (holdActive(target)) throw new HandoffError("busy", "A handoff is starting — try again in a moment.");
    return { target };
  }

  // ---- records -------------------------------------------------------------------
  const recordsFor = (sid) => Object.values(state.records).filter((r) => r.fromSessionId === sid);
  const isDismissed = (sid) => typeof state.dismissedSessions[sid] === "number";
  const hasOwnMode = (sid) => HANDOFF_MODES.includes(state.sessionModes[sid]);
  /** A session's own mode, else the box default (`getMode`). */
  async function modeFor(sid) {
    return hasOwnMode(sid) ? state.sessionModes[sid] : normalizeMode(await getMode());
  }
  // Only these block a new automatic attempt: a `ready` card has no dismiss action, so it must never wedge auto mode.
  const IN_FLIGHT_STATES = ["requested", "generating", "starting"];

  function newRecord({ fromSessionId, kind, trigger, plan, body, goal, contextTokens }) {
    const t = now();
    const rec = {
      id: mintId(),
      fromSessionId,
      kind,
      trigger,
      state: "requested",
      text: typeof body === "string" ? body : "",
      ...(typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0 ? { contextTokens } : {}),
      createdAt: t,
      updatedAt: t,
      internal: {
        plan: plan ?? null,
        body: typeof body === "string" && body.trim() ? body : undefined,
        goal: typeof goal === "string" && goal.trim() ? goal.trim() : undefined,
        baselineRevision: userRev.get(followReplacement(fromSessionId)) ?? 0,
      },
    };
    state.records[rec.id] = rec;
    return rec;
  }

  /** §6.3: a pending `send` handoff — the delegate settler defers a job's completion while one exists on its session. */
  function hasPendingSend(sessionId) {
    return recordsFor(sessionId).some(
      (r) =>
        (r.state === "requested" || r.state === "generating" || r.state === "starting") &&
        (r.internal.plan?.disposition === "send" || r.disposition === "send"),
    );
  }

  /** True while `sessionId` is a handoff's minted successor that isn't committed and released yet — busy, but not a run to adopt. */
  function isSuccessor(sessionId) {
    if (!sessionId) return false;
    if (releasing.has(sessionId)) return true;
    return Object.values(state.records).some((r) => r.successorId === sessionId && r.state === "starting");
  }

  async function gatherFactLines(sessionId) {
    try {
      const raw = await gather.facts?.(sessionId);
      return raw ? factLines(raw) : [];
    } catch (e) {
      warn("[handoff] gathering facts failed:", e?.message ?? e);
      return [];
    }
  }

  async function sessionQuiet(sessionId) {
    for (let i = 0; i < quietRetries; i++) {
      if (i > 0) await sleep(quietDelayMs);
      try {
        const active = await oc.listActive();
        if (Array.isArray(active) && active.includes(sessionId)) continue;
        const inbox = await oc.listInbox(sessionId);
        if (Array.isArray(inbox) && inbox.length > 0) continue;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** The session's context size right now: the last observed step, else one transcript measurement; undefined when unknown. */
  async function measuredTokens(sessionId) {
    const seen = stepCtx.get(sessionId)?.tokens;
    if (typeof seen === "number") return seen;
    try {
      return (await gather.measureContext?.(sessionId))?.tokens ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Server-generated text via POST /session/{id}/generate: 120 s timeout, one retry (§2). */
  async function generateText(sessionId, goal) {
    const prompt = buildGeneratePrompt({ goal });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await oc.generate(sessionId, prompt, { signal: AbortSignal.timeout(generateTimeoutMs) });
        if (typeof text === "string" && text.trim()) return text.trim();
        lastErr = new Error("empty response");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("generation failed");
  }

  /**
   * Fill `rec.text` and move it to `ready` (or `failed`). The agent's own body is
   * used when it carries every template heading; otherwise the server generates.
   * @returns {Promise<boolean>} whether the record is now `ready`
   */
  async function produceText(rec) {
    const j = rec.internal;
    const sid = rec.fromSessionId;
    const fail = async (reason) => {
      rec.state = "failed";
      rec.reason = reason;
      touch(rec);
      await persist();
      if (j.plan?.disposition === "send") onPendingSendCleared(sid);
      return false;
    };
    let body = j.body && missingHeadings(j.body).length === 0 ? j.body : null;
    if (!body) {
      if (!acquireOperation(sid, OP_GENERATE)) return fail("Another operation is running on this conversation. Try again in a moment.");
      try {
        rec.state = "generating";
        rec.reason = undefined;
        j.baselineRevision ??= userRev.get(followReplacement(sid)) ?? 0;
        touch(rec);
        await persist();
        if (!(await sessionQuiet(sid))) return fail("The conversation wasn't idle, so the handoff prompt couldn't be written. Try again when it is.");
        try {
          body = await generateText(sid, j.goal);
        } catch (e) {
          warn("[handoff] generation failed:", e?.message ?? e);
          return fail("The model couldn't write the handoff prompt. Try again.");
        }
      } finally {
        releaseOperation(sid, OP_GENERATE);
      }
    }
    const lines = await gatherFactLines(sid);
    rec.text = composeHandoffText({ body, facts: lines }).text;
    j.textReady = true;
    rec.state = "ready";
    rec.reason = undefined;
    touch(rec);
    await persist();
    return true;
  }

  // ---- create (the routes' / the tool's entry) ------------------------------------
  /**
   * @param {{ sessionId: string, trigger: "user"|"button"|"agent", action?: "suggest"|"handoff", goal?: string, body?: string }} input
   */
  async function create(input = {}) {
    const { sessionId, trigger, action, goal, body } = input;
    if (typeof sessionId !== "string" || !sessionId) throw new HandoffError("invalid", "sessionId is required");
    if (!["user", "button", "agent"].includes(trigger)) throw new HandoffError("invalid", "trigger must be user, button or agent");
    if (trigger === "agent" && !["suggest", "handoff"].includes(action)) throw new HandoffError("invalid", "action must be suggest or handoff");
    if (body !== undefined && typeof body !== "string") throw new HandoffError("invalid", "body must be a string");
    const sid = followReplacement(sessionId);
    if (trigger === "agent" && isDismissed(sid)) {
      throw new HandoffError("dismissed", "The user dismissed handoff suggestions in this conversation. Do not suggest a handoff again unless the user asks.");
    }
    const plan = entryPlan({ mode: await modeFor(sid), trigger, action });
    const rec = newRecord({
      contextTokens: await measuredTokens(sid),
      fromSessionId: sid,
      kind: plan.kind,
      trigger,
      plan: plan.produce === "start" ? { how: plan.how, disposition: plan.disposition } : null,
      body,
      goal,
    });
    pruneRecords(state, now());
    if (trigger === "agent") {
      // The agent is mid-turn: never generate inside its tool call. A complete
      // body of a plain card is usable at once; everything else waits for the
      // turn to end (fresh facts for a send, a regeneration for a thin body).
      const complete = rec.internal.body && missingHeadings(rec.internal.body).length === 0;
      if (complete && !rec.internal.plan) await produceText(rec);
      else {
        touch(rec);
        await persist();
      }
      return publicRecord(rec);
    }
    // /handoff and the button.
    let active = false;
    try {
      active = ((await oc.listActive?.()) ?? []).includes(sid);
    } catch {
      active = false;
    }
    if (active) {
      touch(rec);
      await persist();
    } else {
      if (ops.has(sid)) {
        delete state.records[rec.id];
        throw new HandoffError("busy", "Another operation is running on this conversation.");
      }
      rec.state = "generating";
      touch(rec);
      await persist();
      detach("generate", async () => {
        if (await produceText(rec)) return;
      });
    }
    return publicRecord(rec);
  }

  // ---- turn end --------------------------------------------------------------------
  async function processRequested(rec, success) {
    const j = rec.internal;
    const sid = rec.fromSessionId;
    const planned = j.plan;
    if (planned && !success) j.plan = null; // the turn failed / was aborted: a card instead
    const ok = await produceText(rec);
    if (!ok) return;
    if (j.plan && success) {
      await startRecord(rec.id, { how: j.plan.how, disposition: j.plan.disposition, origin: "auto" }).catch((e) => {
        if (!(e instanceof HandoffError)) warn("[handoff] planned start failed:", e?.message ?? e);
      });
    } else if (planned) {
      onPendingSendCleared(sid);
    }
  }

  async function maybeAuto(sid, success) {
    if (isDismissed(sid)) return;
    const mode = await modeFor(sid);
    if (mode === "off") return;
    if (recordsFor(sid).some((r) => IN_FLIGHT_STATES.includes(r.state))) return;
    // Suggest mode: an unanswered automatic card already says "hand off" — don't
    // pay a full-history generation every turn to say it again. (Auto mode does
    // not wait on it: it supersedes the card and hands off.)
    if (mode === "suggest" && recordsFor(sid).some((r) => r.trigger === "auto" && r.state === "ready")) return;
    // A failed automatic attempt costs a full-history generation: don't loop on it.
    if (recordsFor(sid).some((r) => r.trigger === "auto" && r.state === "failed" && now() - r.updatedAt < cooldownMs)) return;
    if (ops.has(sid)) return; // another maintenance operation owns the session (§6.2)
    // The cheap decision first (budget vs the last measured context); only a
    // session that is actually over budget pays for the lookups below.
    let ctx = stepCtx.get(sid) ?? null;
    if (!ctx) {
      try {
        ctx = (await gather.measureContext?.(sid)) ?? null;
      } catch {
        ctx = null;
      }
    }
    const successor = Object.values(state.records).find((r) => r.successorId === sid && r.internal.successorCreatedAt);
    const budget = ctx ? handoffBudget({ providerID: ctx.providerID, modelID: ctx.modelID, contextLimit: contextLimitFor(ctx.providerID, ctx.modelID) }) : null;
    const decision = decideAutoTrigger({
      mode,
      turnSucceeded: success,
      contextTokens: ctx?.tokens ?? null,
      budget,
      now: now(),
      successorCreatedAt: successor?.internal.successorCreatedAt ?? null,
      cooldownMs,
    });
    if (!decision.fire) return;
    if (await isExcluded(sid)) return;
    if (mode === "auto" && (await isJobSession(sid))) return; // a job's turn end is its completion signal (§6.3)
    if (mode === "auto" && !(await tmux.findWindow?.(sid))) return; // nothing to take over
    const plan = entryPlan({ mode, trigger: "auto" });
    const rec = newRecord({
      contextTokens: ctx?.tokens,
      fromSessionId: sid,
      kind: plan.kind,
      trigger: "auto",
      plan: plan.produce === "start" ? { how: plan.how, disposition: plan.disposition } : null,
    });
    // The new automatic record supersedes this session's older automatic ready
    // cards (clients drop a cancelled card). Cards from the user or the agent are
    // their suggestions and stay.
    for (const old of recordsFor(sid)) {
      if (old !== rec && old.trigger === "auto" && old.state === "ready") {
        old.state = "cancelled";
        touch(old);
      }
    }
    touch(rec);
    await persist();
    detach("auto handoff", () => processRequested(rec, true));
  }

  function onTurnEnd(sid, { success }) {
    return serialize(`turn:${sid}`, async () => {
      const pending = recordsFor(sid).filter((r) => r.state === "requested");
      for (const r of pending) await processRequested(r, success);
      if (pending.length === 0) await maybeAuto(sid, success);
    });
  }

  /** Feed every lifecycle event (the adapted vocabulary) here. Never throws. */
  function observeEvent(evt) {
    const type = evt?.type;
    const p = evt?.properties;
    const sid = type === "session.deleted" ? [p?.sessionID, p?.info?.sessionID, p?.info?.id].find((v) => typeof v === "string" && v) : p?.sessionID;
    if (typeof sid !== "string" || !sid) return;
    if (type === "session.deleted") {
      stepCtx.delete(sid);
      turns.delete(sid);
      delete state.dismissedSessions[sid];
      delete state.sessionModes[sid];
      for (const r of recordsFor(sid)) {
        if (["requested", "generating", "ready"].includes(r.state)) {
          r.state = "cancelled";
          touch(r);
        }
      }
      void persist().catch(() => {});
      return;
    }
    if (type === "session.next.step.ended") {
      const t = evt.properties.tokens;
      const tokens = (t?.input ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);
      if (tokens > 0) stepCtx.set(sid, { tokens, providerID: evt.properties.providerID ?? null, modelID: evt.properties.modelID ?? null, at: now() });
      return;
    }
    const turn = turns.get(sid) ?? { busy: false, errored: false };
    turns.set(sid, turn);
    if (type === "session.status") {
      const st = evt.properties?.status?.type;
      if (st === "busy" || st === "retry") {
        turn.busy = true;
        turn.errored = false;
      }
    } else if (type === "session.error") {
      turn.errored = true;
    } else if (type === "session.idle") {
      if (!turn.busy) return;
      turn.busy = false;
      const success = !turn.errored;
      turn.errored = false;
      void onTurnEnd(sid, { success }); // serialize() already swallows + logs
    }
  }

  // ---- start (§5.3) ------------------------------------------------------------------
  const settingsOf = (s) => ({
    directory: s?.directory || s?.location?.directory || "",
    agent: typeof s?.agent === "string" && s.agent ? s.agent : undefined,
    model: s?.model?.providerID && (s.model.id || s.model.modelID) ? { providerID: s.model.providerID, modelID: s.model.id ?? s.model.modelID, ...(s.model.variant ? { variant: s.model.variant } : {}) } : undefined,
    permissions: Array.isArray(s?.permissions) && s.permissions.length > 0 ? s.permissions : undefined,
    parentID: typeof s?.parentID === "string" && s.parentID ? s.parentID : undefined,
  });

  /**
   * Begin a start on a `ready` record. The check-and-set that claims the record
   * is synchronous, so two concurrent starts cannot both proceed (§5.6).
   * @param {string} id
   * @param {{ how: "clear"|"new-session", disposition: "send"|"draft"|"armed", text?: string, origin?: "user"|"auto" }} req
   */
  async function startRecord(id, req = {}) {
    const rec = state.records[id];
    if (!rec) throw new HandoffError("expired", "This handoff has expired.");
    const { how, disposition, text, origin = "user" } = req;
    if (!["clear", "new-session"].includes(how)) throw new HandoffError("invalid", "how must be clear or new-session");
    const allowed = origin === "auto" ? ["send", "draft", "armed"] : ["send", "draft"];
    if (!allowed.includes(disposition)) throw new HandoffError("invalid", "disposition must be send or draft");
    if (text !== undefined && typeof text !== "string") throw new HandoffError("invalid", "text must be a string");
    if (rec.state === "starting" || rec.state === "committed") {
      throw new HandoffError("already_started", "This handoff was already started.", { handoff: publicRecord(rec) });
    }
    if (rec.state !== "ready") throw new HandoffError("not_ready", "This handoff isn't ready yet.", { handoff: publicRecord(rec) });
    const pred = rec.fromSessionId;
    if (how === "clear" && state.links[pred]?.replacedBy) {
      // Another card for this conversation already replaced it: starting a second
      // replacement from a stale conversation would fork the chain.
      throw new HandoffError("already_started", "This conversation was already handed off.", { handoff: publicRecord(rec) });
    }
    let branchWindow = null;
    if (how === "new-session") {
      // A branch needs a project to put its window in.
      const w = await tmux.findWindow?.(pred);
      if (!w) throw new HandoffError("no_window", "There is no window to place a new session next to.", { handoff: publicRecord(rec) });
      branchWindow = { sessionName: w.sessionName, name: w.name, cwd: w.cwd };
    }
    // ---- synchronous check-and-set from here to the first await ----
    if (rec.state !== "ready") {
      throw new HandoffError("already_started", "This handoff was already started.", { handoff: publicRecord(rec) });
    }
    const cur = ops.get(pred);
    if (cur && cur !== OP_START) throw new HandoffError("busy", "Another operation is running on this conversation.", { handoff: publicRecord(rec) });
    if (state.fences[pred]) throw new HandoffError("busy", "Another handoff is starting on this conversation.", { handoff: publicRecord(rec) });
    ops.set(pred, OP_START);
    const j = rec.internal;
    if (origin === "user") j.baselineRevision = userRev.get(pred) ?? 0; // an explicit press: only what is in flight now matters
    j.textOverride = text !== undefined && text.trim() ? text : undefined;
    rec.state = "starting";
    rec.how = how;
    rec.disposition = disposition;
    rec.successorId = mintSessionId();
    rec.messageId = disposition === "send" ? mintMessageId() : undefined;
    rec.step = "begin";
    rec.reason = undefined;
    j.commit = undefined;
    j.created = false;
    j.settings = undefined;
    j.tempName = how === "new-session" ? `handoff-${rec.id}` : undefined;
    j.window = branchWindow ?? undefined;
    touch(rec);
    try {
      await persist();
    } catch (e) {
      // Nothing durable happened: give the record and the session back.
      rec.state = "ready";
      rec.how = undefined;
      rec.disposition = undefined;
      rec.successorId = undefined;
      rec.messageId = undefined;
      rec.step = undefined;
      releaseOperation(pred, OP_START);
      throw e;
    }
    running.add(rec.id);
    try {
      await runStart(rec, { recovering: false });
    } finally {
      running.delete(rec.id);
    }
    if (rec.state === "ready" && rec.reason) {
      throw new HandoffError("busy", "The conversation changed while the handoff was starting, so nothing was changed.", { handoff: publicRecord(rec) });
    }
    return publicRecord(rec);
  }

  function tryFence(rec, { recovering }) {
    const sid = rec.fromSessionId;
    if ((reservations.get(sid) ?? 0) !== 0) return "you kept working";
    if (!recovering && (userRev.get(sid) ?? 0) !== rec.internal.baselineRevision) return "you kept working";
    const other = ops.get(sid);
    if (other && other !== OP_START) return "another operation is running on this conversation";
    if (state.fences[sid] && state.fences[sid].recordId !== rec.id) return "another handoff is starting on this conversation";
    state.fences[sid] = { successorId: rec.successorId, recordId: rec.id };
    return null;
  }

  async function abortToReady(rec, reason) {
    const sid = rec.fromSessionId;
    if (state.fences[sid]?.recordId === rec.id) delete state.fences[sid];
    rec.state = "ready";
    rec.reason = reason;
    rec.step = undefined;
    rec.how = undefined;
    rec.disposition = undefined;
    rec.successorId = undefined;
    rec.messageId = undefined;
    releaseOperation(sid, OP_START);
    touch(rec);
    await persist();
    if (rec.internal.plan?.disposition === "send") onPendingSendCleared(sid);
    if (queueLen(sid) > 0) detach(`drain:${sid}`, () => drainHeld(sid));
    return rec;
  }

  async function rollback(rec, reason) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    if (succ) {
      try {
        await oc.deleteSession(succ);
      } catch (e) {
        if (e?.status !== 404) warn("[handoff] deleting the unused successor failed:", e?.message ?? e);
      }
      delete state.continuations[succ];
      releasing.delete(succ);
    }
    if (state.fences[pred]?.recordId === rec.id) delete state.fences[pred];
    rec.state = "failed";
    rec.reason = reason;
    rec.step = undefined;
    rec.successorId = undefined;
    rec.messageId = undefined;
    rec.internal.created = false;
    rec.internal.commit = undefined;
    releaseOperation(pred, OP_START);
    touch(rec);
    await persist();
    if (rec.internal.plan?.disposition === "send" || rec.disposition === "send") onPendingSendCleared(pred);
    if (queueLen(pred) > 0) detach(`drain:${pred}`, () => drainHeld(pred)); // held while fenced: back to the predecessor, in order
    return rec;
  }

  const pointOfNoReturn = (rec) => Boolean(rec.internal.commit) || Boolean(state.continuations[rec.successorId]?.send?.attempted);

  /** The resumable state machine behind start(), recovery and the retry timer. Each step observes before it acts. */
  async function runStart(rec, { recovering }) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    const j = rec.internal;
    try {
      // 1. fence (replacement only)
      if (rec.how === "clear" && !j.commit && state.fences[pred]?.recordId !== rec.id) {
        const why = tryFence(rec, { recovering });
        if (why) return await abortToReady(rec, why);
        rec.step = "fence";
        await hook("fence");
        await persist();
        if (!(await sessionQuiet(pred))) return await abortToReady(rec, "couldn't confirm the conversation is idle");
      }
      // 2. create
      if (!j.created) await stepCreate(rec);
      // 3. prepare delivery
      if (!state.continuations[succ]) {
        const payload = j.textOverride ?? rec.text;
        const cont = { recordId: rec.id };
        if (rec.disposition === "send") cont.send = { messageId: rec.messageId, text: payload, attempted: false, confirmed: false };
        else if (rec.disposition === "armed") cont.preamble = payload;
        else {
          cont.draft = payload;
          cont.draftRevision = 1;
        }
        state.continuations[succ] = cont;
        rec.step = "prepare";
        await hook("prepare");
        await persist();
      }
      if (rec.disposition === "send") {
        const r = await deliverSend(rec, { recovering });
        if (r === "pending") {
          scheduleRetry(`start:${rec.id}`, () => resumeStart(rec.id));
          touch(rec);
          return rec;
        }
      }
      // 4. commit — forward only
      await commit(rec);
      // 5. release
      await drainHeld(succ);
      return rec;
    } catch (e) {
      if (e?.crash) throw e;
      if (e instanceof Rollback) return await rollback(rec, e.message);
      if (!pointOfNoReturn(rec)) {
        // opencode may simply not be up yet right after a boot: retry a few times
        // before giving the (still fully reversible) start up.
        const transient = recovering && typeof e?.status !== "number" && (j.resumeAttempts ?? 0) < 5;
        if (transient) {
          j.resumeAttempts = (j.resumeAttempts ?? 0) + 1;
          scheduleRetry(`start:${rec.id}`, () => resumeStart(rec.id), j.resumeAttempts);
          return rec;
        }
        return await rollback(rec, "couldn't start the handoff");
      }
      warn("[handoff] start hit an error after the point of no return; will recover forward:", e?.message ?? e);
      scheduleRetry(`start:${rec.id}`, () => resumeStart(rec.id));
      return rec;
    }
  }

  async function stepCreate(rec) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    const j = rec.internal;
    if (!j.settings) {
      const rs = await oc.readSession(pred);
      if (rs.state !== "found") throw new Rollback(rs.state === "missing" ? "the conversation no longer exists" : "couldn't read the conversation");
      j.settings = settingsOf(rs.session);
    }
    const existing = await oc.readSession(succ);
    if (existing.state !== "found") {
      try {
        await oc.createSession({ directory: j.settings.directory, id: succ, parentID: j.settings.parentID, agent: j.settings.agent, model: j.settings.model, permissions: j.settings.permissions });
      } catch (e) {
        if (isDefinite(e)) throw new Rollback("couldn't create the new session");
        const again = await oc.readSession(succ);
        if (again.state !== "found") throw new Rollback("couldn't create the new session");
      }
    }
    await hook("create");
    j.created = true;
    j.successorCreatedAt = now();
    rec.step = "create";
    await persist();
  }

  /** Step 3 `send`: persist attempted, post, reconcile by id when uncertain, never roll back after an uncertain first POST. */
  async function deliverSend(rec, { recovering }) {
    const succ = rec.successorId;
    const cont = state.continuations[succ];
    const s = cont.send;
    if (s.confirmed) return "confirmed";
    const wasAttempted = s.attempted === true;
    if (!wasAttempted) {
      s.attempted = true;
      rec.step = "send";
      await hook("send-attempt");
      await persist();
    }
    const j = rec.internal;
    const args = { text: s.text, messageID: s.messageId, ...(j.settings?.agent ? { agent: j.settings.agent } : {}), ...(j.settings?.model ? { model: j.settings.model } : {}) };
    const st = { uncertain: wasAttempted || s.uncertain === true };
    const res = await postReconcile(succ, "prompt", args, s.messageId, st);
    if (res.outcome === "refused") throw new Rollback("the new session refused the message");
    if (res.outcome === "pending") {
      s.uncertain = true;
      await persist();
      return "pending";
    }
    await hook("send");
    s.confirmed = true;
    await persist();
    return "confirmed";
  }

  async function attachWindow(rec) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    if (rec.how === "clear") {
      if (await tmux.findWindow?.(succ)) return; // already restamped
      const w = await tmux.findWindow?.(pred);
      if (!w) return; // a session with no window: the link alone redirects delivery
      await tmux.restamp(w.sessionName, w.windowIndex, succ);
      return;
    }
    // branch: found by stamp OR by the temporary name; created otherwise; then renamed.
    let w = await tmux.findWindow?.(succ);
    if (!w && rec.internal.tempName) w = (await tmux.findWindowByName?.(rec.internal.tempName)) ?? null;
    if (!w) {
      const p = rec.internal.window ?? (await tmux.findWindow?.(pred));
      if (!p) throw new Error("no window to place the branch next to");
      rec.internal.window = { sessionName: p.sessionName, name: p.name, cwd: p.cwd };
      const idx = await tmux.createStampedWindow({ sessionName: p.sessionName, tempName: rec.internal.tempName, cwd: rec.internal.settings?.directory || p.cwd, sessionId: succ });
      w = { sessionName: p.sessionName, windowIndex: idx };
    }
    const finalName = `${rec.internal.window?.name ?? "session"} ↪`;
    await tmux.rename({ sessionName: w.sessionName, windowIndex: w.windowIndex, newName: finalName });
  }

  function writeLinks(rec) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    const lp = (state.links[pred] ??= { branches: [] });
    const ls = (state.links[succ] ??= { branches: [] });
    if (rec.how === "clear") {
      lp.replacedBy = succ;
      ls.replaces = pred;
      if (state.fences[pred]?.recordId === rec.id) delete state.fences[pred]; // the fence becomes the permanent link
      const moved = state.held[pred];
      if (moved?.length) {
        state.held[succ] = [...moved, ...(state.held[succ] ?? [])];
        delete state.held[pred];
        releasing.add(succ);
      }
    } else {
      ls.branchedFrom = pred;
      lp.branches ??= [];
      if (!lp.branches.includes(succ)) lp.branches.push(succ);
    }
  }

  async function commit(rec) {
    const pred = rec.fromSessionId;
    const succ = rec.successorId;
    const j = rec.internal;
    if (!j.commit) {
      // From here until the held queue is empty, anything resolving to the
      // successor joins it (§5.3 ordering during commit and release).
      releasing.add(succ);
      j.commit = {};
    }
    const c = j.commit;
    rec.step = "commit";
    if (!c.modeInherited) {
      // The successor keeps the predecessor's effective mode, stored explicitly (a later change to the box default doesn't move it).
      if (!hasOwnMode(succ)) {
        try {
          state.sessionModes[succ] = await modeFor(pred);
        } catch (e) {
          warn("[handoff] the successor couldn't inherit the handoff mode:", e?.message ?? e);
        }
      }
      c.modeInherited = true;
      await persist();
    }
    if (!c.attached) {
      await attachWindow(rec);
      await hook("attach");
      c.attached = true;
      await persist();
    }
    if (!c.linkWritten) {
      writeLinks(rec);
      c.linkWritten = true;
      await hook("link");
      await persist();
    }
    if (!c.ownership) {
      if (rec.how === "clear") await ownership.repoint(pred, succ);
      await hook("ownership");
      c.ownership = true;
      await persist();
    }
    rec.state = "committed";
    rec.step = undefined;
    releaseOperation(pred, OP_START);
    touch(rec);
    await hook("committed");
    await persist();
  }

  async function resumeStart(id) {
    const rec = state.records[id];
    if (!rec || rec.state !== "starting" || running.has(id)) return;
    running.add(id);
    ops.set(rec.fromSessionId, OP_START);
    try {
      await runStart(rec, { recovering: true });
    } finally {
      running.delete(id);
    }
  }

  // ---- retry / draft ---------------------------------------------------------------------
  async function retry(id) {
    const rec = state.records[id];
    if (!rec) throw new HandoffError("expired", "This handoff has expired.");
    if (rec.state !== "failed") throw new HandoffError("not_ready", "Only a failed handoff can be retried.", { handoff: publicRecord(rec) });
    const j = rec.internal;
    j.created = false;
    j.commit = undefined;
    j.settings = undefined;
    rec.how = undefined;
    rec.disposition = undefined;
    rec.reason = undefined;
    j.baselineRevision = userRev.get(followReplacement(rec.fromSessionId)) ?? 0;
    if (j.textReady) {
      rec.state = "ready";
      touch(rec);
      await persist();
    } else {
      rec.state = "generating";
      touch(rec);
      await persist();
      detach("retry generate", () => produceText(rec));
    }
    return publicRecord(rec);
  }

  /** Hide a `ready`/`failed` card and stop proposing handoffs in its session (explicit /handoff and the button still work). */
  async function dismiss(id) {
    const rec = state.records[id];
    if (!rec) throw new HandoffError("expired", "This handoff has expired.");
    if (rec.state !== "ready" && rec.state !== "failed") {
      throw new HandoffError("not_ready", "This handoff can no longer be dismissed.", { handoff: publicRecord(rec) });
    }
    rec.state = "dismissed";
    state.dismissedSessions[rec.fromSessionId] = now();
    touch(rec);
    await persist();
    return publicRecord(rec);
  }

  async function setMode(sessionId, mode) {
    if (typeof sessionId !== "string" || !sessionId) throw new HandoffError("invalid", "sessionId is required");
    if (!HANDOFF_MODES.includes(mode)) throw new HandoffError("invalid", 'mode must be "auto", "suggest" or "off"');
    state.sessionModes[sessionId] = mode;
    await persist();
    return mode;
  }

  async function draftConsumed(id, draftRevision) {
    const rec = state.records[id];
    if (!rec) throw new HandoffError("expired", "This handoff has expired.");
    const cont = rec.successorId ? state.continuations[rec.successorId] : null;
    if (!cont || typeof draftRevision !== "number") return;
    if (cont.draftRevision === draftRevision && cont.draftConsumed !== draftRevision) {
      cont.draftConsumed = draftRevision;
      await persist();
    }
  }

  // ---- reads --------------------------------------------------------------------------------
  function chainOf(sessionId) {
    const out = new Set([sessionId]);
    let t = sessionId;
    while (state.links[t]?.replaces && !out.has(state.links[t].replaces)) {
      t = state.links[t].replaces;
      out.add(t);
    }
    t = sessionId;
    while (state.links[t]?.replacedBy && !out.has(state.links[t].replacedBy)) {
      t = state.links[t].replacedBy;
      out.add(t);
    }
    return [...out];
  }

  const publicLink = (l) => ({ ...(l.replacedBy ? { replacedBy: l.replacedBy } : {}), ...(l.replaces ? { replaces: l.replaces } : {}), ...(l.branchedFrom ? { branchedFrom: l.branchedFrom } : {}), branches: [...(l.branches ?? [])] });

  /** Predecessors of a session, nearest first, then (last) the session its chain was branched from. Ids only. */
  function predecessorIds(sessionId) {
    const ids = [];
    const seen = new Set([sessionId]);
    let t = sessionId;
    while (state.links[t]?.replaces && !seen.has(state.links[t].replaces) && ids.length < MAX_CHAIN) {
      t = state.links[t].replaces;
      seen.add(t);
      ids.push({ id: t });
    }
    const origin = state.links[t]?.branchedFrom; // the oldest session of the chain is the one a branch hangs off
    if (origin && !seen.has(origin)) ids.push({ id: origin, branchedFrom: true });
    return ids;
  }

  /** One session's title / deletion, bounded: a 404 is `deleted`; any other failure or a timeout says nothing. */
  async function lookupSession(id) {
    let timer;
    try {
      const rs = await Promise.race([
        oc.readSession(id),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ state: "unknown" }), lookupTimeoutMs); // cleared below, so it never outlives the call
        }),
      ]);
      if (rs?.state === "missing") return { deleted: true };
      if (rs?.state === "found" && typeof rs.session?.title === "string" && rs.session.title) return { title: rs.session.title };
      return {};
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function list({ sessionId } = {}) {
    if (typeof sessionId !== "string" || !sessionId) throw new HandoffError("invalid", "sessionId is required");
    const records = Object.values(state.records)
      .filter((r) => r.fromSessionId === sessionId || r.successorId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicRecord);
    const preds = predecessorIds(sessionId);
    const looked = await Promise.all(preds.map((p) => lookupSession(p.id)));
    const predecessors = preds.map((p, i) => ({ ...p, ...looked[i] }));
    const c = state.continuations[sessionId];
    const out = {
      records,
      links: publicLink(state.links[sessionId] ?? {}),
      chain: { predecessors },
      dismissed: isDismissed(sessionId),
      mode: await modeFor(sessionId),
      modeIsDefault: !hasOwnMode(sessionId),
    };
    if (c && (c.preamble || c.draft !== undefined || c.send)) {
      out.continuation = {
        recordId: c.recordId,
        ...(c.preamble ? { preamble: c.preamble } : {}),
        ...(c.draft !== undefined ? { draft: c.draft, draftRevision: c.draftRevision, draftConsumed: c.draftConsumed === c.draftRevision } : {}),
      };
    }
    return out;
  }

  function get(id) {
    const rec = state.records[id];
    return rec ? publicRecord(rec) : null;
  }

  /** §15: the plugin's budget policy. Authoritative per session only — null when this session has no measurement. */
  async function policyFor(sessionId) {
    const ctx = stepCtx.get(sessionId);
    if (!ctx) return null;
    const budget = handoffBudget({ providerID: ctx.providerID, modelID: ctx.modelID, contextLimit: contextLimitFor(ctx.providerID, ctx.modelID) });
    if (budget === null) return null;
    return { contextTokens: ctx.tokens, budget, measuredAt: ctx.at, mode: isDismissed(sessionId) ? "off" : await modeFor(sessionId) };
  }

  // ---- boot recovery (§5.5) ---------------------------------------------------------------------
  async function recover() {
    let changed = false;
    for (const rec of Object.values(state.records)) {
      if (rec.state === "generating") {
        rec.state = "failed";
        rec.reason = "interrupted by a restart";
        touch(rec);
        changed = true;
      }
    }
    if (changed) await persist();
    const jobs = [];
    for (const rec of Object.values(state.records)) {
      if (rec.state === "starting") {
        if (!running.has(rec.id)) {
          jobs.push(resumeStart(rec.id));
        }
      } else if (rec.state === "requested") {
        jobs.push(serialize(`turn:${rec.fromSessionId}`, () => processRequested(rec, false)));
      }
    }
    for (const target of Object.keys(state.held)) if (!state.fences[target]) jobs.push(drainHeld(target));
    await Promise.allSettled(jobs);
  }

  /** Drop links while neither end exists; callers pass a definitive-absence probe. */
  async function sweep(exists) {
    pruneRecords(state, now());
    if (typeof exists === "function") await pruneLinks(state, exists);
    await persist();
  }

  return {
    // admission
    resolveAdmissionTarget,
    admitPrompt: (args) => admit("prompt", args?.sessionId, stripSession(args)),
    admitSynthetic: (sessionId, body) => admit("synthetic", sessionId, body),
    guardCommand,
    // operations (§6.2)
    acquireOperation,
    releaseOperation,
    // triggers
    observeEvent,
    onTurnEnd,
    // routes
    create,
    start: startRecord,
    retry,
    dismiss,
    setMode,
    modeFor,
    draftConsumed,
    list,
    get,
    // ownership / listings
    hasPendingSend,
    isSuccessor,
    chainOf,
    policyFor,
    // lifecycle
    recover,
    sweep,
    /** Test seams. */
    _state: state,
    _runtime: { reservations, userRev, ops, releasing, stepCtx, waiters },
    _drainHeld: drainHeld,
    _persist: persist,
  };

  function stripSession(args) {
    const { sessionId: _s, ...rest } = args ?? {};
    return rest;
  }
}

export { continuationUnconsumed };
