// Keeps the running / waiting picture true to opencode, whatever events were missed (a box restart, a dropped or
// silent stream, an ask answered elsewhere). opencode has no event replay, so the box compares what it holds with
// what opencode reports NOW and corrects only the differences, through the stream interpreter's normal frames.
//
//  - `run`: enumerate opencode's active sessions plus the sessions the interpreter holds asks for, read each one's
//    pending questions/permissions, and reconcile. Runs on every opencode (re)connect (this is what seeds a freshly
//    restarted box) and every 45 s.
//  - `afterTurnEnd`: when a turn ends, one re-read of that session's asks drops any the box still holds that opencode
//    no longer reports (an ask answered from another client whose event was missed).
//
// A failed read never clears state: a failed active-session read skips the whole tick, a failed per-session read
// skips that session's ask correction. Asks the box has never held are adopted with care (see `adopt`).
import { startPoller } from "./startPoller.mjs";

export const RECONCILE_INTERVAL_MS = 45_000;
const READ_CONCURRENCY = 4;

/**
 * @param {{
 *   listActiveSessionIds: () => Promise<string[]>,
 *   listPermissions: (sid: string, o: { strict: boolean }) => Promise<any[]>,
 *   listQuestions: (sid: string, o: { strict: boolean }) => Promise<any[]>,
 *   interp: { knownSessionIds: () => string[], getState: (sid: string) => any, revOf: (sid: string) => number,
 *             reconcile: (sid: string, a: object) => { changed: boolean, stale: boolean } },
 *   autoAllow?: () => Promise<boolean>,
 *   ownsSession?: (sid: string) => boolean,
 *   isAutoAnswered?: (permissionId: string) => boolean,
 *   log?: (...a: unknown[]) => void,
 *   warn?: (...a: unknown[]) => void,
 * }} d
 */
export function createStatusReconciler(d) {
  const log = d.log ?? (() => {});
  const warn = d.warn ?? (() => {});
  let inFlight = null;
  let failing = false;
  // Permissions not adopted yet because trust mode may be about to answer them: adopted if still pending next time.
  let pendingConfirm = new Set();

  const holdsAsk = (st) => (st?.questions?.length ?? 0) > 0 || (st?.permissions?.length ?? 0) > 0;
  const readAsks = (sid) => Promise.all([d.listPermissions(sid, { strict: true }), d.listQuestions(sid, { strict: true })]);

  async function pool(items, fn) {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  }

  async function runOnce(reason) {
    // Revisions BEFORE any read: a session an event touched while we were reading is left to the stream.
    const revs = new Map(d.interp.knownSessionIds().map((sid) => [sid, d.interp.revOf(sid)]));
    let active;
    try {
      active = new Set(await d.listActiveSessionIds());
    } catch (e) {
      if (!failing) warn(`[status-reconcile] ${reason}: opencode read failed, skipping (${e?.message ?? e})`);
      failing = true;
      return { skipped: true, sessions: 0, changed: 0 };
    }
    failing = false;
    let autoAllow = false;
    try {
      autoAllow = (await d.autoAllow?.()) === true;
    } catch { /* unknown: treat as off */ }

    // Sessions worth a look: running at opencode, believed running here, or holding an ask here.
    const candidates = new Set(active);
    for (const sid of d.interp.knownSessionIds()) {
      const st = d.interp.getState(sid);
      if (st?.running || holdsAsk(st)) candidates.add(sid);
    }
    const nextConfirm = new Set();
    let changed = 0;
    await pool([...candidates], async (sid) => {
      // Asks live on sessions that run or that this box already shows as waiting; an idle, ask-free session needs no read.
      const needsAskRead = active.has(sid) || holdsAsk(d.interp.getState(sid));
      let permissions;
      let questions;
      if (needsAskRead) {
        try {
          [permissions, questions] = await readAsks(sid);
        } catch (e) {
          log(`[status-reconcile] ${sid}: ask read failed, asks left as they are (${e?.message ?? e})`);
        }
      }
      const adopt = (kind, item) => {
        if (d.ownsSession?.(sid)) return false; // a background job's asks are rejected, never shown
        if (kind !== "permission") return true;
        if (d.isAutoAnswered?.(item?.id)) return false;
        if (!autoAllow) return true;
        if (pendingConfirm.has(item?.id)) return true;
        nextConfirm.add(item?.id);
        return false;
      };
      const r = d.interp.reconcile(sid, { running: active.has(sid), permissions, questions, expectRev: revs.get(sid) ?? -1, adopt });
      if (r.changed) changed++;
    });
    pendingConfirm = nextConfirm;
    if (changed > 0) log(`[status-reconcile] ${reason}: corrected ${changed} of ${candidates.size} session(s)`);
    return { skipped: false, sessions: candidates.size, changed };
  }

  /** One reconcile pass; a call while one is running joins it. Never throws. */
  function run({ reason = "periodic" } = {}) {
    if (!inFlight) {
      inFlight = runOnce(reason)
        .catch((e) => {
          warn("[status-reconcile] pass failed:", e?.message ?? e);
          return { skipped: true, sessions: 0, changed: 0 };
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /** A turn ended: drop any ask this box still holds for the session that opencode no longer reports. */
  async function afterTurnEnd(sid) {
    if (typeof sid !== "string" || !sid || !holdsAsk(d.interp.getState(sid))) return false;
    const expectRev = d.interp.revOf(sid);
    let permissions;
    let questions;
    try {
      [permissions, questions] = await readAsks(sid);
    } catch {
      return false; // unknown: leave the asks as they are
    }
    return d.interp.reconcile(sid, { permissions, questions, expectRev, onlyDrop: true }).changed;
  }

  /** The periodic pass (unref'd, never re-entered). Returns `{ stop }`. */
  function start({ intervalMs = RECONCILE_INTERVAL_MS } = {}) {
    return startPoller(() => run({ reason: "periodic" }), { intervalMs, label: "status-reconcile", immediate: false });
  }

  return { run, afterTurnEnd, start };
}
