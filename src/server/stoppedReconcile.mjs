// stoppedReconcile.mjs — keeps the usage-stopped record (stoppedStore.mjs)
// honest over time. Enrolment only ever ADDS; before this sweep an entry left
// only by an explicit uncheck or a resume the engine itself sent, so a stale
// row could sit in the sidebar pill and the resume modal forever:
//
//   - "gone"      the opencode session was deleted (a definitive 404);
//   - "hidden"    no sidebar window carries the session any more — a closed
//                 window, a /clear that replaced the session id, or an inline
//                 `task` subagent child that never had a window. The user has
//                 nothing to resume from, and a "Keep going" would run unseen;
//   - "recovered" an UNARMED entry whose provider is back under every limit.
//                 The user declined auto-resume (or never chose), quota is
//                 back, so "stopped by a limit" is no longer true and they can
//                 simply carry on by hand. ARMED entries are left to the resume
//                 engine, which sends "Keep going" on that same recovery.
//
// "Recovered" needs a reading taken AFTER the stop: a snapshot fetched before
// the refusal can still show headroom and must not clear a fresh entry.
//
// Unknowns never drop: a transient opencode error counts as "exists" (that is
// sessionExists' contract) and a failed tmux listing skips the window check.
//
// Pure decision (staleReason) + injected I/O (createStoppedReconciler), the
// same shape as usageResume.mjs. Driven from index.mjs on a slow interval and
// on every `usage.updated`.

import { isUsageAtLimit } from "./usageStopper.mjs";
import { loadStoppedState } from "./stoppedStore.mjs";

/** How often the sweep runs on its own (in addition to every usage poll). */
export const RECONCILE_INTERVAL_MS = 60_000;
/** Max session-existence checks in flight during one sweep. */
const EXISTS_CONCURRENCY = 4;

/**
 * Has the provider recovered since this entry was stopped? Only a real,
 * post-stop reading with every active window under its limit counts.
 * @param {object} record
 * @param {Array<object>|null|undefined} snapshots  usage poller snapshots
 * @returns {boolean}
 */
export function providerRecoveredSince(record, snapshots) {
  const snap = (snapshots ?? []).find((s) => s?.provider === record?.provider);
  if (!snap) return false;
  if (typeof snap.fetchedAt !== "number" || typeof record?.stoppedAt !== "number") return false;
  if (snap.fetchedAt <= record.stoppedAt) return false;
  const windows = Array.isArray(snap.windows) ? snap.windows.filter((w) => w && w.active !== false) : [];
  if (windows.length === 0) return false;
  return !isUsageAtLimit(windows);
}

/**
 * Why (if at all) should this entry leave the record? Pure.
 * @param {object} record
 * @param {object} facts
 * @param {boolean} facts.exists          the opencode session still exists
 * @param {Set<string>|null} facts.visible  session ids shown in the sidebar, or null when unknown
 * @param {Array<object>} [facts.snapshots]
 * @returns {"gone"|"hidden"|"recovered"|null}
 */
export function staleReason(record, { exists, visible, snapshots }) {
  if (!exists) return "gone";
  if (visible && !visible.has(record?.conversation)) return "hidden";
  if (record?.armed !== true && providerRecoveredSince(record, snapshots)) return "recovered";
  return null;
}

/**
 * @param {object} deps
 * @param {() => {records: Array<object>}} [deps.load]
 * @param {(input: {entries: Array<object>}) => Promise<string[]>} deps.remove  wire to removeStopped
 * @param {(sessionId: string) => Promise<boolean>} deps.sessionExists
 * @param {() => Promise<Set<string>>} deps.visibleSessionIds  session ids stamped on tmux windows
 * @param {() => Array<object>} deps.snapshots  current usage poller snapshots
 * @param {number} [deps.intervalMs]
 */
export function createStoppedReconciler({
  load = loadStoppedState,
  remove,
  sessionExists,
  visibleSessionIds,
  snapshots = () => [],
  intervalMs = RECONCILE_INTERVAL_MS,
} = {}) {
  let inFlight = null;
  let again = false;
  let timer = null;

  async function sweep() {
    const { records = [] } = load();
    if (records.length === 0) return [];
    let visible = null;
    try {
      visible = await visibleSessionIds();
      // tmux listing swallows its own errors into an empty list, so "no chat
      // windows at all" is indistinguishable from a failed read — treat it as
      // unknown rather than wiping every entry.
      if (!(visible instanceof Set) || visible.size === 0) visible = null;
    } catch {
      visible = null; // unknown → skip the window check, never drop on it
    }
    const snaps = snapshots() ?? [];
    const live = records.filter((r) => r?.conversation);
    // A few checks at a time: quick for the usual handful, gentle on opencode
    // for a large stale backlog.
    const existence = new Array(live.length);
    let next = 0;
    const worker = async () => {
      while (next < live.length) {
        const i = next++;
        existence[i] = await Promise.resolve()
          .then(() => sessionExists(live[i].conversation))
          .catch(() => true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXISTS_CONCURRENCY, live.length) }, worker));
    const drop = [];
    const reasons = new Map();
    live.forEach((r, i) => {
      const reason = staleReason(r, { exists: existence[i] !== false, visible, snapshots: snaps });
      if (reason) {
        drop.push(r);
        reasons.set(r.conversation, reason);
      }
    });
    if (drop.length === 0) return [];
    const removed = await remove({ entries: drop });
    for (const c of removed) console.log(`[usage-stopped] cleared ${c} (${reasons.get(c)})`);
    return removed;
  }

  /** Run one sweep; overlapping calls coalesce into one follow-up run. */
  function run() {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = sweep()
      .catch((e) => {
        console.warn("[usage-stopped] reconcile failed:", e?.message ?? e);
        return [];
      })
      .finally(() => {
        inFlight = null;
        if (again) {
          again = false;
          void run();
        }
      });
    return inFlight;
  }

  return {
    run,
    start() {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
