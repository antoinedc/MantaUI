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
// them (accepted — matches the prior webhook behaviour). Draining is FIFO,
// one prompt at a time, awaited in sequence (never batched into one message).

/**
 * Build the shared prompt-delivery engine.
 *
 * @param {object} deps
 * @param {(args:{sessionId:string, text:string})=>Promise<unknown>} deps.sendPrompt
 *        The underlying opencode prompt injector (oc.sendPrompt).
 * @returns {{deliver: (args:{sessionId:string, text:string})=>Promise<{delivered:boolean, queued:boolean}>, observeEvent:(evt:unknown)=>void, isBusy:(sessionId:string)=>boolean}}
 */
export function createPromptDelivery({ sendPrompt }) {
  const busy = new Set(); // sessionIds currently running a turn
  const pending = new Map(); // sessionId -> [text, ...] queued while busy

  async function drain(sessionId) {
    const queue = pending.get(sessionId);
    if (!queue || queue.length === 0) return;
    // Pop the whole queue before sending so a prompt queued during the drain
    // itself (e.g. a second webhook arriving while we flush) is not lost —
    // it lands in a fresh queue rather than being iterated mid-flush.
    pending.delete(sessionId);
    for (const text of queue) {
      try {
        await sendPrompt({ sessionId, text });
      } catch (e) {
        // Warn and continue: one wedged delivery must not strand the rest of
        // the queued prompts behind it.
        console.warn(
          `[promptDelivery] deferred send for ${sessionId} failed:`,
          e?.message ?? e,
        );
      }
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
    if (evt.type === "session.idle" || evt.type === "session.error") {
      if (busy.delete(sid)) void drain(sid);
      else void drain(sid); // also drain if we never saw a busy (defensive)
      return;
    }
    if (evt.type === "session.status") {
      const t = evt.properties?.status?.type;
      if (t === "busy" || t === "retry") busy.add(sid);
      else if (t === "idle") {
        busy.delete(sid);
        void drain(sid);
      }
    }
  }

  function isBusy(sessionId) {
    return busy.has(sessionId);
  }

  async function deliver({ sessionId, text }) {
    if (busy.has(sessionId)) {
      const q = pending.get(sessionId) ?? [];
      q.push(text);
      pending.set(sessionId, q);
      return { delivered: false, queued: true };
    }
    try {
      await sendPrompt({ sessionId, text });
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

  return { deliver, observeEvent, isBusy };
}
