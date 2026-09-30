// promptDelivery.mjs — the single defer-while-busy prompt-delivery engine.
//
// Every path that injects a prompt into an opencode session — webhook
// delivery, scheduled-prompt firing, peer messages, capability-job
// completion — routes through ONE instance of this engine (constructed in
// src/server/index.mjs). The engine tracks per-session busy state from the
// opencode event firehose and defers a delivery when its target session is
// mid-turn, so an external event, a scheduled tick, a peer agent, or a
// plugin job finishing can NEVER abort the user's in-flight model turn.
//
// The busy/pending mechanics were lifted verbatim from the webhook engine
// (src/server/webhooks.mjs), which was the only sender that already deferred.
// See BET-375 for the full rationale. `deliver` NEVER rejects — three of the
// four callers today swallow errors and must keep doing so; a rejection here
// would surface as an unhandled promise in a timer-driven poll loop.
//
// The queue is in-memory only; a server restart with prompts queued loses
// them (accepted — matches the prior webhook behaviour).
//
// PACING (2026-09-30 incident): a recurring 30-minute schedule sat in front of
// a session whose turn died without opencode ever emitting idle. The engine
// kept believing the session was busy, queued 20 identical copies, and when
// the session finally went idle the old drain sent all 20 back-to-back in
// 0.6s — 20 identical user messages, each re-sending ~250k tokens of context.
// Three rules now prevent that class of failure:
//   1. COALESCING — a delivery carrying a `coalesceKey` that is already
//      waiting REPLACES the waiting item (newest text wins, queue position
//      kept) instead of stacking; a waiting item with identical text+model is
//      merged too. Both report {queued:true, coalesced:true}.
//   2. ONE PER IDLE — drain sends only the FIRST waiting item, then waits for
//      that turn to finish (busy → idle) before sending the next. The session
//      is marked busy synchronously at pop time (opencode emits several idle
//      signals per turn boundary), and an "awaiting start" marker ignores
//      stale idle/error events until the drained turn is seen to start (or a
//      start timeout elapses).
//   3. STALE-BUSY RE-CHECK — a session marked busy with no opencode event for
//      a long time is re-checked against opencode itself (injected
//      getSessionStatus, driven by startStaleSweep); if opencode says it is not
//      busy the state is released like an idle event.
//
// The queue is BOUNDED: each session can hold at most MAX_PENDING_PER_SESSION
// deferred prompts (BET-772, audit P3-3). An unbounded queue would grow
// without limit while a session stays busy under a flood of deferred
// deliveries — a memory/correctness concern, not data loss (restart already
// drops the queue). When a session's queue is at the cap, the new delivery is
// REJECTED and surfaced (deliver returns {rejected:true}) instead of pushing,
// so the caller knows its prompt was not queued and can decide how to handle
// the overflow rather than having it silently dropped on a later drain.

function sameModel(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    (a.variant ?? undefined) === (b.variant ?? undefined)
  );
}

/**
 * Build the shared prompt-delivery engine.
 *
 * @param {object} deps
 * @param {(args:{sessionId:string, text:string, model?:{providerID:string, modelID:string, variant?:string}})=>Promise<unknown>} deps.sendPrompt
 *        The underlying opencode prompt injector (oc.sendPrompt).
 * @param {((args:object)=>Promise<{result:object}|null>)|null} [deps.redirect]
 *        CTO admission redirect; runs first in deliver().
 * @param {((sessionId:string)=>Promise<"busy"|"retry"|"idle">)|null} [deps.getSessionStatus]
 *        Asks opencode for a session's real status (stale-busy re-check).
 * @param {() => number} [deps.now] Injectable clock (ms).
 * @param {{setTimeout:Function, clearTimeout:Function, setInterval:Function, clearInterval:Function}} [deps.timers]
 *        Injectable timers.
 * @param {number} [deps.startTimeoutMs] How long to wait for a drained send to start a turn.
 * @param {number} [deps.staleAfterMs] Silence after which a busy session is re-checked.
 * @param {number} [deps.sweepIntervalMs] Stale sweep cadence.
 * @returns {{deliver: Function, observeEvent:(evt:unknown)=>void, isBusy:(sessionId:string)=>boolean, anyBusy:()=>boolean, startStaleSweep:()=>{stop:()=>void}, sweepStale:()=>Promise<void>}}
 */
export function createPromptDelivery({
  sendPrompt,
  redirect = null,
  getSessionStatus = null,
  now = Date.now,
  timers = {
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
  },
  startTimeoutMs = 60_000,
  staleAfterMs = 10 * 60_000,
  sweepIntervalMs = 60_000,
}) {
  const busy = new Set(); // sessionIds currently running a turn
  const pending = new Map(); // sessionId -> [{text, model, coalesceKey}, ...] queued while busy
  // sessionId -> {token, timer}: a drained item was sent and its turn has not
  // been seen to start yet. Idle/error events are stale until it clears.
  const awaitingStart = new Map();
  const lastEventAt = new Map(); // sessionId -> ms of the last opencode event

  // Build the sendPrompt argument, including `model` only when one was given —
  // an omitted model must leave the call byte-identical to the pre-model engine.
  function withModel(sessionId, text, model) {
    return model ? { sessionId, text, model } : { sessionId, text };
  }

  // Upper bound on deferred prompts per session (BET-772). Chosen well above
  // what a realistic burst needs but small enough that a flood cannot balloon
  // memory. The queue is drained only when the (busy) session goes idle, so an
  // unbounded cap under a sustained flood is the exact unbounded-growth case
  // this bound exists to prevent.
  const MAX_PENDING_PER_SESSION = 20;

  function clearAwaiting(sessionId) {
    const a = awaitingStart.get(sessionId);
    if (!a) return;
    if (a.timer) timers.clearTimeout(a.timer);
    awaitingStart.delete(sessionId);
  }

  // Send ONE waiting item, then stop: the turn it starts must finish before the
  // next item goes out. Everything that decides "this call owns the send" runs
  // synchronously before the first await, so concurrent drain calls (opencode
  // emits status-idle + session.idle for one boundary) send exactly one item.
  //
  // P3a3 note: the drain flushes RAW (sendPrompt), bypassing the cto
  // redirect. That is safe by construction — a conversation-targeted
  // delivery is redirected BEFORE the busy check in deliver and never enters
  // this queue; only ordinary deliveries (and a delivery that slipped in
  // while the binding was unreadable) reach this degraded flush path.
  async function drain(sessionId) {
    for (;;) {
      if (busy.has(sessionId) || awaitingStart.has(sessionId)) return;
      const queue = pending.get(sessionId);
      if (!queue || queue.length === 0) {
        pending.delete(sessionId);
        return;
      }
      const { text, model } = queue.shift();
      if (queue.length === 0) pending.delete(sessionId);
      busy.add(sessionId);
      lastEventAt.set(sessionId, now());
      const mark = { timer: null };
      awaitingStart.set(sessionId, mark);
      try {
        await sendPrompt(withModel(sessionId, text, model));
      } catch (e) {
        // Warn and move on: one wedged delivery must not strand the rest of
        // the queued prompts behind it.
        console.warn(
          `[promptDelivery] deferred send for ${sessionId} failed:`,
          e?.message ?? e,
        );
        if (awaitingStart.get(sessionId) === mark) {
          clearAwaiting(sessionId);
          busy.delete(sessionId);
          continue;
        }
        return; // a busy event arrived meanwhile: the session is really running
      }
      // Sent. If the turn has not been seen to start yet, give it a bounded
      // time to do so, then treat the send as finished and release the next.
      if (awaitingStart.get(sessionId) === mark) {
        mark.timer = timers.setTimeout(() => {
          if (awaitingStart.get(sessionId) !== mark) return;
          awaitingStart.delete(sessionId);
          busy.delete(sessionId);
          void drain(sessionId);
        }, startTimeoutMs);
        mark.timer?.unref?.();
      }
      return;
    }
  }

  // Observe the opencode event firehose to know which sessions are busy.
  // Mirrors the renderer's running derivation:
  //   session.status{status.type:"busy"|"retry"} → busy
  //   session.status{status.type:"idle"} / session.idle / session.error → idle (drain)
  // Every other event type is ignored.
  function observeEvent(evt) {
    const sid = evt?.properties?.sessionID;
    if (typeof sid !== "string" || !sid) return;
    lastEventAt.set(sid, now());
    if (evt.type === "session.deleted") {
      lastEventAt.delete(sid);
      return;
    }
    if (evt.type === "session.idle" || evt.type === "session.error") {
      // A drained item was just sent and its turn hasn't started: this is the
      // late idle/error of the PREVIOUS turn. Ignore it.
      if (awaitingStart.has(sid)) return;
      busy.delete(sid);
      void drain(sid); // also drain if we never saw a busy (defensive)
      return;
    }
    if (evt.type === "session.status") {
      const t = evt.properties?.status?.type;
      if (t === "busy" || t === "retry") {
        busy.add(sid);
        clearAwaiting(sid); // the drained turn has started
      } else if (t === "idle") {
        if (awaitingStart.has(sid)) return;
        busy.delete(sid);
        void drain(sid);
      }
    }
  }

  // Stale-busy re-check: a session marked busy with no event for staleAfterMs
  // may have lost its idle signal. Ask opencode; only a definitive "idle"
  // releases it. Any failure leaves the state alone for the next sweep.
  let sweeping = false;
  async function sweepStale() {
    if (!getSessionStatus || sweeping) return;
    sweeping = true;
    try {
      const t = now();
      for (const [sid, at] of lastEventAt) {
        if (!busy.has(sid) && t - at > staleAfterMs) lastEventAt.delete(sid); // prune
      }
      for (const sid of [...busy]) {
        const at = lastEventAt.get(sid);
        if (at !== undefined && now() - at <= staleAfterMs) continue;
        let status;
        try {
          status = await getSessionStatus(sid);
        } catch (e) {
          console.warn(
            `[promptDelivery] status check for ${sid} failed:`,
            e?.message ?? e,
          );
          continue;
        }
        if (status !== "idle") continue;
        // An event may have arrived while we were asking; then it isn't silent.
        const cur = lastEventAt.get(sid);
        if (cur !== at || !busy.has(sid)) continue;
        console.warn(`[promptDelivery] ${sid} was marked busy but opencode reports idle; releasing`);
        clearAwaiting(sid);
        busy.delete(sid);
        void drain(sid);
      }
    } finally {
      sweeping = false;
    }
  }

  // Started explicitly by index.mjs (never from the factory, so tests that
  // construct the engine cannot leak a timer).
  function startStaleSweep() {
    const h = timers.setInterval(() => {
      sweepStale().catch((e) =>
        console.warn("[promptDelivery] stale sweep failed:", e?.message ?? e),
      );
    }, sweepIntervalMs);
    h?.unref?.();
    return { stop: () => timers.clearInterval(h) };
  }

  function isBusy(sessionId) {
    return busy.has(sessionId);
  }

  // Box-level idle view for consumers that need "ANY opencode turn in
  // flight?" (the doctrine restart manager): the same firehose-derived set
  // the per-session gate trusts. claude-TUI/shell panes are not opencode
  // sessions and never appear here.
  function anyBusy() {
    return busy.size > 0;
  }

  async function deliver({ sessionId, text, model, ctoKey, coalesceKey }) {
    // P3a3 (spec §8.3): every writer to the CTO role session goes through the
    // durable admission queue — including this engine's background senders.
    // The redirect runs FIRST so a conversation-targeted delivery never
    // enters the in-memory defer queue below. `ctoKey` is the caller's
    // stable delivery identity (schedule job+minute, capability job+status)
    // that becomes the admission dedupe id; senders without one omit it and
    // each delivery mints a fresh unique id. The redirect never throws (its
    // own contract); the guard keeps even a buggy redirect from breaking
    // ordinary delivery — it degrades to the historical path with a warn.
    if (redirect) {
      try {
        const r = await redirect({ sessionId, text, model, ctoKey });
        if (r) return r.result;
      } catch (e) {
        console.warn(
          `[promptDelivery] cto redirect failed for ${sessionId}; delivering ordinarily:`,
          e?.message ?? e,
        );
      }
    }
    if (busy.has(sessionId)) {
      const q = pending.get(sessionId) ?? [];
      // A recurring sender's newer firing supersedes its own waiting one
      // (keeps the queue position); identical text+model is never queued twice.
      // Neither counts against the cap.
      const same = coalesceKey
        ? q.find((it) => it.coalesceKey === coalesceKey)
        : undefined;
      if (same) {
        same.text = text;
        same.model = model;
        return { delivered: false, queued: true, coalesced: true };
      }
      if (q.some((it) => it.text === text && sameModel(it.model, model))) {
        return { delivered: false, queued: true, coalesced: true };
      }
      if (q.length >= MAX_PENDING_PER_SESSION) {
        // Queue is at the cap (BET-772). Reject + surface rather than grow
        // the queue unboundedly: the caller learns this delivery was not
        // queued and must be surfaced/handled, instead of assuming a drain
        // will deliver it.
        console.warn(
          `[promptDelivery] deferred delivery queue for ${sessionId} is full (${MAX_PENDING_PER_SESSION}); rejecting`,
        );
        return { delivered: false, queued: false, rejected: true };
      }
      q.push({ text, model, ...(coalesceKey ? { coalesceKey } : {}) });
      pending.set(sessionId, q);
      return { delivered: false, queued: true };
    }
    try {
      await sendPrompt(withModel(sessionId, text, model));
      return { delivered: true, queued: false };
    } catch (e) {
      // Never reject: callers swallow errors and a rejection would surface as
      // an unhandled promise in timer-driven loops. Log and report not-delivered.
      console.warn(
        `[promptDelivery] sendPrompt for ${sessionId} failed:`,
        e?.message ?? e,
      );
      return { delivered: false, queued: false };
    }
  }

  return { deliver, observeEvent, isBusy, anyBusy, startStaleSweep, sweepStale };
}
