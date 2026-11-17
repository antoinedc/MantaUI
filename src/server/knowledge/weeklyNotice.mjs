// weeklyNotice.mjs — the weekly informational notification (spec §8).
//
// Once a week, if something changed, `fireNotify` (the informational tier) summarises it and points at
// Settings → Knowledge (the Recent changes list with Undo). "Changed" = decisions applied, repository
// writes, undos, or the blackboard import since the previous notice. A quiet week sends nothing.
//
// Not here: the ONE-TIME post-upgrade notice ("shared knowledge is on, spends up to the cap…") is already
// sent by the engine core (`engine.mjs` maybeNotifyUpgrade, kv `upgrade.notified`) — not duplicated.
//
// `tick()` is cheap (one kv read) — call it from the maintenance poller; it self-throttles to once a week.
// The first tick on a box only starts the clock (no notice for a feature turned on a minute ago).

export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const NOTICE_AT_KEY = "weekly.notice.at";
const RETRY_MS = 60 * 60 * 1000;
const MAX_LATEST = 3;
const MESSAGE_MAX = 400;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** PURE. The notification text for the week's counts, or null when nothing changed. */
export function composeWeeklyNotice(counts, latest = []) {
  const applied = counts.applied ?? 0;
  const outward = counts.outward ?? 0;
  const undone = counts.undo ?? 0;
  const imported = counts.import ?? 0;
  if (applied + outward + undone + imported === 0) return null;
  const parts = [];
  if (applied) parts.push(`${plural(applied, "update")} added to what Manta knows`);
  if (outward) parts.push(`${plural(outward, "repository change")}`);
  if (undone) parts.push(`${undone} undone`);
  if (!applied && !outward && !undone && imported) parts.push("earlier notes imported");
  let msg = `This week: ${parts.join(", ")}.`;
  if (latest.length) msg += ` Latest: ${latest.map((s) => clip(s, 70)).join("; ")}.`;
  if (counts.waiting) msg += ` ${plural(counts.waiting, "item")} waiting (spend cap or no capable model).`;
  msg += " Open Settings → Knowledge to review or undo anything.";
  return clip(msg, MESSAGE_MAX);
}

/**
 * deps: state (kv), changesLog {countsSince(ms), list({limit})}, settings {get → {enabled}},
 *       fireNotify({message, title, tag}), now, log.
 * `tick(t?)` → `{sent:boolean, reason?:string}`.
 */
export function createWeeklyNotice({ state, changesLog, settings, fireNotify, now = Date.now, log = console.warn } = {}) {
  if (!state || !changesLog || !settings || typeof fireNotify !== "function") throw new Error("createWeeklyNotice: state, changesLog, settings and fireNotify are required");
  let retryAt = 0;

  async function tick(t = now()) {
    try {
      if (!(await settings.get()).enabled) return { sent: false, reason: "disabled" };
      const last = Number(state.kvGet(NOTICE_AT_KEY, "0")) || 0;
      if (!last) {
        state.kvSet(NOTICE_AT_KEY, String(t));
        return { sent: false, reason: "clock-started" };
      }
      if (t - last < WEEK_MS) return { sent: false, reason: "not-due" };
      if (t < retryAt) return { sent: false, reason: "backoff" };
      const counts = changesLog.countsSince(last);
      const latest = changesLog
        .list({ limit: 50 })
        .items.filter((c) => c.kind === "applied" && c.at >= last && !c.undoneAt)
        .slice(0, MAX_LATEST)
        .map((c) => c.summary);
      const message = composeWeeklyNotice(counts, latest);
      if (!message) {
        state.kvSet(NOTICE_AT_KEY, String(t));
        return { sent: false, reason: "nothing-changed" };
      }
      try {
        await fireNotify({ title: "Shared knowledge: this week", message, tag: "knowledge-weekly" });
      } catch (e) {
        retryAt = t + RETRY_MS;
        log("[knowledge] weekly notification failed:", e?.message ?? e);
        return { sent: false, reason: "notify-failed" };
      }
      state.kvSet(NOTICE_AT_KEY, String(t));
      return { sent: true, message };
    } catch (e) {
      log("[knowledge] weekly notice tick failed:", e?.message ?? e);
      return { sent: false, reason: "error" };
    }
  }
  return { tick };
}
