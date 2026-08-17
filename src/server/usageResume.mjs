// usageResume.mjs — the resume engine (BET-1048, box-side). Watches the armed
// entries in the usage-stopped record (BET-1047) and resumes them once their
// provider's usage genuinely recovers.
//
// Replaces the old single-conversation "Keep going at reset" path, which
// fired at a fixed reset+60s whether or not quota returned, was silently
// dropped if the box slept through that minute, and ran on no pinned model.
// The old path (renderer confirm dialog + per-continuation scheduler job +
// its Undo) is deleted; THIS engine is the only thing that resumes an armed
// conversation. See docs/usage-resume.md §8 + §9 and the BET-1048 issue.
//
// Design (per the issue, all load-bearing):
//  - Gate on recovery, not a clock: an armed conversation waits until EVERY
//    window its provider reports is under its limit (not just the named one).
//  - Reuse the existing usage poller: the engine is driven by its
//    `usage.updated` snapshots, and schedules a ONE-SHOT re-check at the
//    expected reset instant which forces the poller to tick immediately —
//    no second polling loop.
//  - Stagger: continuations in a batch go out a few seconds apart, so a dozen
//    conversations firing at once can't re-exhaust a fresh window.
//  - The prompt is the literal "Keep going", on the model pinned in the record.
//  - Mid-turn deferral reuses the shared prompt-delivery engine (the ONLY
//    deferral mechanism) — no second deferral is written here.
//  - A conversation that comes back still refused stays armed and waits for
//    the next check. After a small number of attempts it stops retrying and
//    is flagged as needing attention (never loops forever, never drops
//    silently).
//  - Late resume: if the box was asleep past the reset, the batch runs on
//    wake, however late. Deliberate — no expiry.
//  - On a successful resume the entry leaves the record.
//
// Shape: pure decision logic (planResumeBatch / refusalAction) separated from
// the sending I/O, both dependency-injected — the prevailing convention
// (usage.mjs / usageStopEnroll.mjs). This is ONE module with ONE entry point
// (`createUsageResumeEngine`).

import { isUsageAtLimit, classifyUsageStopped } from "./usageStopper.mjs";
import { loadStoppedState } from "./stoppedStore.mjs";

/** The exact continuation prompt. Kept as a constant so it has one home. */
export const KEEP_GOING_PROMPT = "Keep going";

/**
 * The most times a permanently-refused conversation will be resumed before it
 * stops retrying and is flagged. Deliberately small ("a small number"). An
 * armed entry's `attempts` starts at 1 (it was stopped once) and is bumped on
 * each refused resume; the batch keeps sending while attempts <= this, and a
 * refusal that would push attempts past it flags the entry.
 */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * Delay between stacked continuations in a single batch. "A few seconds
 * apart" — long enough that a burst of resumes cannot re-exhaust a freshly
 * reset window at the same instant.
 */
export const STAGGER_MS = 4_000;

const PROVIDER_NOT_READY = "wait"; // provider still at/over its limit (or no reading) → wait
const PROVIDER_READY = "ready"; // every window under its limit → may resume
const PROVIDER_FLAGGED = "flagged"; // attempts exhausted → stop retrying, needs attention

/**
 * Build `{ adapterId -> UsageWindow[] }` from poller snapshots. Present
 * windows only; a provider with no snapshot simply has no windows, which
 * isUsageAtLimit treats as not-at-limit (we must never block a resume on a
 * reading we do not have).
 * @param {Array<{provider:string, windows?:Array<object>}|undefined>|null|undefined} snapshots
 * @returns {Record<string, object[]>}
 */
export function windowsFromSnapshots(snapshots) {
  const out = {};
  for (const s of snapshots ?? []) {
    if (!s || typeof s?.provider !== "string") continue;
    const windows = Array.isArray(s.windows) ? s.windows.filter(Boolean) : [];
    // Only key providers we actually have a usable reading for — a provider
    // with no windows is absent, never "under its limit" (isUsageAtLimit([])
    // is false, but that reading doesn't exist and must not hold a resume up).
    if (windows.length > 0) out[s.provider] = windows;
  }
  return out;
}

/**
 * The pure resume decision for one armed entry against its provider's current
 * windows. Never raises a reading we do not have: no windows -> ready (the
 * gate is "every window under its limit", and there are none to block it).
 * @param {object} entry  an armed StoppedRecord
 * @param {object[]|undefined} windows  the provider's windows (all of them)
 * @param {object} [cfg]
 * @param {number} [cfg.maxAttempts]
 * @returns {"wait"|"ready"|"flagged"}
 */
export function providerState(entry, windows, { maxAttempts = MAX_RESUME_ATTEMPTS } = {}) {
  // An entry that has exhausted its retries stops being resumed and is
  // surfaced as needing attention — it stays in the record, armed, but is
  // never sent again (spec §8 / issue "up to the cap, then flagged").
  if ((entry?.attempts ?? 0) > maxAttempts) return PROVIDER_FLAGGED;
  if (isUsageAtLimit(windows)) return PROVIDER_NOT_READY;
  return PROVIDER_READY;
}

/**
 * Pure batch planner. Given the full record and the current per-provider
 * windows, decide an ordered set of resume sends, the flagged entries, and
 * when to re-check next.
 *
 * Returns:
 *   sends          [{conversation, provider, model, at}] — armed + recovered +
 *                  not-flagged, ordered by stoppedAt (oldest first), each
 *                  stamped with a stagger time `at = now + idx*STAGGER_MS` so
 *                  the I/O layer simply sends on `at`.
 *   flagged        [{conversation, provider, attempts}] — armed + recovered but
 *                  attempts exhausted: needs attention, no send.
 *   nextRecheckAt  epoch ms — the earliest FUTURE reset instant among the armed
 *                  providers that are still at their limit (the ones waiting on
 *                  a clock). null when nothing is waiting or data is absent.
 *
 * @param {Array<object>|undefined} records
 * @param {Record<string, object[]>} windowsByProvider
 * @param {object} [cfg]
 * @param {() => number} [cfg.now]
 * @param {number} [cfg.staggerMs]
 * @param {number} [cfg.maxAttempts]
 */
export function planResumeBatch(records, windowsByProvider = {}, { now = () => Date.now(), staggerMs = STAGGER_MS, maxAttempts = MAX_RESUME_ATTEMPTS } = {}) {
  const nowMs = now();
  const armed = (records ?? []).filter((r) => r?.armed === true);
  // Deterministic order for the stagger: oldest stopped first.
  armed.sort((a, b) => (a?.stoppedAt ?? 0) - (b?.stoppedAt ?? 0));

  const sends = [];
  const flagged = [];
  let nextRecheckAt = null;

  for (const entry of armed) {
    const provider = entry?.provider;
    const windows = windowsByProvider?.[provider];
    const state = providerState(entry, windows, { maxAttempts });
    if (state === PROVIDER_NOT_READY || state === PROVIDER_FLAGGED) {
      // Flagged entries are surfaced (never looped) and skipped.
      if (state === PROVIDER_FLAGGED) {
        flagged.push({ conversation: entry.conversation, provider, attempts: entry.attempts ?? 0 });
      }
      // Still-limited entries are the ones a reset re-check can unblock: the
      // earliest reset instant (a past reset — the box slept through it —
      // re-checks immediately, however late). Clamped to `now` so a reset that
      // already passed still schedules an immediate re-poll, never a past one.
      if (state === PROVIDER_NOT_READY && Array.isArray(windows)) {
        for (const w of windows) {
          if (typeof w?.resetsAt !== "number" || !Number.isFinite(w.resetsAt)) continue;
          const when = Math.max(w.resetsAt, nowMs);
          if (nextRecheckAt == null || when < nextRecheckAt) nextRecheckAt = when;
        }
      }
      continue;
    }
    // state === ready → recovered, resume it.
    sends.push({
      conversation: entry.conversation,
      provider,
      ...(typeof entry.model === "string" && entry.model ? { model: entry.model } : {}),
      at: nowMs + sends.length * staggerMs,
    });
  }

  return { sends, flagged, nextRecheckAt };
}

/**
 * Pure post-refusal decision. After a resumed conversation comes back refused,
 * does it re-queue for the next check, or has it hit the attempt cap and must
 * be flagged?
 * @param {object} entry  the current record entry (pre-refusal attempts)
 * @param {object} [cfg]
 * @param {number} [cfg.maxAttempts]
 * @returns {{action:"requeue"}|{action:"flag", attempts:number}}
 */
export function refusalAction(entry, { maxAttempts = MAX_RESUME_ATTEMPTS } = {}) {
  const next = (entry?.attempts ?? 0) + 1;
  // Re-queue while we have not yet exceeded the cap; flag the moment this
  // refusal would push us past it ("up to the cap, then flagged").
  return next > maxAttempts ? { action: "flag", attempts: next } : { action: "requeue" };
}

/**
 * The resume engine. ONE entry point. Pure decision logic (above) + injected
 * I/O (below): the caller wires real loading/publishing/prompt delivery and
 * the tests wire fakes. In production (index.mjs):
 *   - `deliverSnapshots(snapshots)` is called on every `usage.updated` bus
 *     event (from the existing usage poller) and schedules a one-shot re-check
 *     at the earliest future reset — an injected `forceRecheck` (wired to the
 *     poller's own tick) is invoked when that timer fires, so the poller does
 *     the fetching and there is no second polling loop.
 *   - `observeEvent(evt)` is fed the opencode stream so the engine can tell a
 *     refused resume (re-queue/flag) from a successful one (remove the entry).
 *
 * @param {object} deps
 * @param {() => Promise<{records:Array<object>, lastLooked:number|null}>} [deps.load]
 * @param {(input:{conversation:string})=>Promise<void>} [deps.markRan]     wire to markStoppedRan
 * @param {(input:{conversation:string})=>Promise<void>} [deps.bumpAttempts] wire to bumpStoppedAttempts
 * @param {(args:{sessionId:string, text:string, model?:object})=>Promise<unknown>} [deps.deliver]
 *   wire to promptDelivery.deliver — the shared defer-until-idle path.
 * @param {(adapterId:string)=>string|null} [deps.providerIDForAdapter]  adapter id -> opencode providerID
 * @param {() => Promise<void>} [deps.forceRecheck]  forces the usage poller to tick once
 * @param {(evt:object)=>void} [deps.publish]  bus publish (usage-stopped.updated / .needs-attention)
 * @param {() => number} [deps.now]
 * @param {(fn:()=>void, ms:number)=>ReturnType<typeof setTimeout>} [deps.setTimeoutFn]
 * @param {(t?:unknown)=>void} [deps.clearTimeoutFn]
 * @param {number} [deps.staggerMs]
 * @param {number} [deps.maxAttempts]
 * @returns {{
 *   deliverSnapshots: (snapshots:Array<object>|null|undefined)=>Promise<void>,
 *   observeEvent: (evt:object|null|undefined)=>void,
 *   stop: ()=>void,
 * }}
 */
export function createUsageResumeEngine({
  load = loadStoppedState,
  markRan = async () => {},
  bumpAttempts = async () => {},
  deliver = async () => {},
  providerIDForAdapter = () => null,
  forceRecheck = async () => {},
  publish = () => {},
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  staggerMs = STAGGER_MS,
  maxAttempts = MAX_RESUME_ATTEMPTS,
} = {}) {
  // Conversations we have sent "Keep going" to and are awaiting the outcome
  // of — used by observeEvent to tell a refused resume from a successful one.
  const pendingResume = new Set();
  // The single one-shot re-check timer (never a second polling loop), plus the
  // per-send stagger timers for the current batch.
  let recheckTimer = null;
  const sendTimers = new Set();

  function clearAll() {
    if (recheckTimer != null) {
      clearTimeoutFn(recheckTimer);
      recheckTimer = null;
    }
    for (const t of sendTimers) clearTimeoutFn(t);
    sendTimers.clear();
  }

  function scheduleRecheck(atMs) {
    if (recheckTimer != null) {
      clearTimeoutFn(recheckTimer);
      recheckTimer = null;
    }
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return;
    const delay = Math.max(0, atMs - now());
    recheckTimer = setTimeoutFn(() => {
      recheckTimer = null;
      // Fire-and-forget: a failed recheck is caught inside the poller's tick.
      void forceRecheck();
    }, delay);
    // Don't hold the process open for a re-check that may be far off (the same
    // discipline as the poller's own timers). Injectable fakes need no unref.
    recheckTimer?.unref?.();
  }

  function scheduleSend(send, atMs) {
    const delay = Math.max(0, atMs - now());
    const timer = setTimeoutFn(() => {
      sendTimers.delete(timer);
      void sendOne(send);
    }, delay);
    sendTimers.add(timer);
    timer?.unref?.();
  }

  // Send one "Keep going" on the model pinned in the record, through the shared
  // prompt-delivery engine (which defers to idle if the conversation is busy).
  async function sendOne(send) {
    pendingResume.add(send.conversation);
    const providerID = send.provider ? providerIDForAdapter(send.provider) : null;
    const model =
      providerID && typeof send.model === "string" && send.model
        ? { providerID, modelID: send.model }
        : null;
    const res = await deliver({
      sessionId: send.conversation,
      text: KEEP_GOING_PROMPT,
      ...(model ? { model } : {}),
    });
    // A rejected delivery (queue at its cap) was not queued — don't hold the
    // conversation pending for an outcome that will not come (BET-772).
    if (res?.rejected) pendingResume.delete(send.conversation);
  }

  // A resume came back refused by the plan limit again. Re-queue up to the cap,
  // then flag as needing attention. The entry stays armed either way.
  async function handleRefusal(sid, evt) {
    const { records = [] } = await load();
    const entry = records.find((r) => r?.conversation === sid);
    if (!entry) return; // already removed — nothing to re-queue
    const props = evt?.properties ?? {};
    const err = props.error ?? {};
    const errorName = typeof err?.name === "string" ? err.name : undefined;
    const errorMessage =
      typeof err?.data?.message === "string" ? err.data.message : typeof err?.message === "string" ? err.message : undefined;
    // Only a genuine plan-limit refusal (the classifier reuses the SAME
    // classifier as enrolment — there is exactly one) re-queues. Any other
    // error leaves the entry armed to wait for the next check un-bumped.
    const match = classifyUsageStopped({ provider: entry.provider, errorName, errorMessage, error: err });
    if (!match?.enrolled) return;
    const action = refusalAction(entry, { maxAttempts });
    await bumpAttempts({ conversation: sid });
    if (action.action === "flag") {
      publish({ kind: "usage-stopped.needs-attention", payload: { conversation: sid, attempts: action.attempts } });
    }
  }

  /**
   * React to fresh usage snapshots: plan + fire the batch and re-arm the
   * one-shot re-check at the earliest still-limited provider reset.
   * @param {Array<object>|null|undefined} snapshots
   */
  async function deliverSnapshots(snapshots) {
    const { records = [] } = await load();
    const windows = windowsFromSnapshots(snapshots);
    const { sends, flagged, nextRecheckAt } = planResumeBatch(records, windows, {
      now,
      staggerMs,
      maxAttempts,
    });
    // `flagged` (attempts exhausted) are surfaced exactly once, at the flag
    // TRANSITION in observeEvent/handleRefusal — never re-published every check
    // (that would spam the bus for a permanently-refused entry). Here they are
    // simply never scheduled a send again.
    for (const send of sends) scheduleSend(send, send.at);
    scheduleRecheck(nextRecheckAt);
  }

  /**
   * Observe the opencode stream for the outcome of a pending resume:
   *   - a plan-limit refusal (session.error that the classifier enrols) →
   *     re-queue (or flag at the cap);
   *   - reaching idle WITHOUT such an error → the resume ran, remove the entry.
   * @param {object|null|undefined} evt
   */
  function observeEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    const sid = evt?.properties?.sessionID;
    if (typeof sid !== "string" || !sid) return;
    if (evt.type === "session.error") {
      if (!pendingResume.has(sid)) return;
      pendingResume.delete(sid);
      void handleRefusal(sid, evt).catch((e) => console.warn("[usage-resume] refusal handling failed:", e?.message ?? e));
      return;
    }
    if (evt.type === "session.idle" && pendingResume.has(sid)) {
      // No plan-limit error fired before idle → the "Keep going" turn completed.
      // Remove the entry from the record (successful resume, spec §5.1/§8).
      pendingResume.delete(sid);
      void markRan({ conversation: sid }).catch((e) => console.warn("[usage-resume] markRan failed:", e?.message ?? e));
      return;
    }
    if (evt.type === "session.next.step.ended" && pendingResume.has(sid)) {
      // The model actually produced a step after our resume — an early, strong
      // success signal; clear the entry promptly rather than on a later idle.
      pendingResume.delete(sid);
      void markRan({ conversation: sid }).catch((e) => console.warn("[usage-resume] markRan failed:", e?.message ?? e));
    }
  }

  return {
    deliverSnapshots,
    observeEvent,
    stop() {
      clearAll();
      pendingResume.clear();
    },
  };
}
