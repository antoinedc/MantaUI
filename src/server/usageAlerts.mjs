// usageAlerts.mjs — the 90% / limit usage alerts, owned by the box
// (WS09 SF-M16 / SF-M17; ports usageEscalation.ts). The usage poller feeds
// `observe(snapshots)`; this module remembers the per-window level baseline,
// fires an alert only on an UPWARD transition, keeps the set of currently
// active alerts, and publishes them as raw bus frames so every client (desktop
// toast host, iOS banner) shows the same alert once. In-app only — there is no
// push and no `fireNotify` dependency here (D24).
//
// Client reconciliation contract (iOS UsageAlertQueue, desktop
// usageAlertsQueue.ts) relies on two guarantees pinned by the tests:
//   * every change to the active set bumps `revision` by exactly 1 and
//     publishes exactly one frame carrying that revision;
//   * `list()` reports the active set as of its `revision`.

import { randomUUID } from "node:crypto";

const WARN_AT = 90;
const LIMIT_AT = 100;
const WARN_TTL_MS = 15 * 60_000;
const REMIND_OFFSET_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const RANK = { none: 0, warn: 1, limit: 2 };

const PROVIDER_LABELS = { claude: "Claude", codex: "OpenAI", kimi: "Kimi" };

export function providerLabel(provider) {
  const p = String(provider ?? "");
  return PROVIDER_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/** none | warn (>= 90) | limit (>= 100). */
export function level(pct) {
  if (pct >= LIMIT_AT) return "limit";
  if (pct >= WARN_AT) return "warn";
  return "none";
}

/**
 * Level of every present `provider:window.kind`. A stale window is NOT special-
 * cased: its pct is what the window that just ended finished on, which is
 * exactly the fire-once baseline we want (and is correct on a cold start too).
 */
export function levels(snapshots) {
  const out = {};
  for (const snap of snapshots ?? []) {
    for (const win of snap.windows ?? []) out[`${snap.provider}:${win.kind}`] = level(win.pct);
  }
  return out;
}

/** "Claude Session (5h) 93% used" / "Weekly limit reached on Claude" (the reset clause is the client's). */
export function alertText({ provider, window, level: lvl }) {
  const label = providerLabel(provider);
  return lvl === "limit"
    ? `${window.label} limit reached on ${label}`
    : `${label} ${window.label} ${Math.round(window.pct)}% used`;
}

function buildAlert({ snap, win, level: lvl, now }) {
  const key = `${snap.provider}:${win.kind}`;
  const resetsAt = typeof win.resetsAt === "number" ? win.resetsAt : null;
  return {
    id: `${key}:${lvl}:${resetsAt ?? "none"}`,
    key,
    level: lvl,
    provider: snap.provider,
    windowKind: win.kind,
    windowLabel: win.label,
    pct: win.pct,
    resetsAt,
    text: alertText({ provider: snap.provider, window: win, level: lvl }),
    raisedAt: now,
    expiresAt: lvl === "limit" ? resetsAt : now + WARN_TTL_MS,
    sticky: lvl === "limit",
  };
}

/**
 * The alerts an observation fires: only on an UPWARD level transition for a
 * key; a stale window never fires; holding a level never re-fires; a drop
 * re-arms the key (the caller replaces its baseline with `levels(next)`).
 */
export function transitions(prev, next, now) {
  const fired = [];
  for (const snap of next ?? []) {
    for (const win of snap.windows ?? []) {
      if (win.stale) continue;
      const key = `${snap.provider}:${win.kind}`;
      const newLevel = level(win.pct);
      const oldLevel = prev?.[key] ?? "none";
      if (newLevel !== "none" && RANK[newLevel] > RANK[oldLevel]) {
        fired.push(buildAlert({ snap, win, level: newLevel, now }));
      }
    }
  }
  return fired;
}

export function createUsageAlerts({
  now = Date.now,
  publish,
  bootId = randomUUID(),
  timers = { setTimeout, clearTimeout },
} = {}) {
  let seeded = false;
  let baseline = {};
  let lastSnapshots = [];
  let revision = 0;
  let timer = null;
  const active = new Map(); // id → alert (raise order)

  const emit = (body) => {
    revision += 1;
    publish?.({ kind: "usage.alert", payload: { bootId, revision, ...body } });
  };

  const view = (alert, at) => {
    const live = alert.resetsAt != null && alert.resetsAt > at;
    return { ...alert, canRemind: live, canKeepGoing: live };
  };

  function rearmTimer() {
    timers.clearTimeout(timer);
    timer = null;
    let soonest = null;
    for (const a of active.values()) {
      if (a.expiresAt != null && (soonest === null || a.expiresAt < soonest)) soonest = a.expiresAt;
    }
    if (soonest === null) return;
    const wait = Math.min(Math.max(soonest - now(), 0) + 5, MAX_TIMER_MS);
    timer = timers.setTimeout(() => {
      timer = null;
      sweep();
    }, wait);
    timer?.unref?.();
  }

  const retire = (id) => {
    if (!active.delete(id)) return;
    emit({ retired: [id] });
  };

  /** Retire every alert whose expiry has passed. */
  function sweep() {
    const at = now();
    for (const [id, a] of [...active]) {
      if (a.expiresAt != null && a.expiresAt <= at) retire(id);
    }
    rearmTimer();
  }

  function observe(snapshots) {
    const at = now();
    lastSnapshots = Array.isArray(snapshots) ? snapshots : [];
    const next = levels(lastSnapshots);
    if (!seeded) {
      // The first observation after box start seeds the baseline silently.
      seeded = true;
      baseline = next;
      return;
    }
    // Retire alerts whose key dropped below the level that raised them.
    for (const [id, a] of [...active]) {
      if (RANK[next[a.key] ?? "none"] < RANK[a.level]) retire(id);
    }
    for (const a of transitions(baseline, lastSnapshots, at)) {
      if (active.has(a.id)) continue;
      active.set(a.id, a);
      emit({ alert: view(a, at) });
    }
    baseline = next;
    sweep();
  }

  function list() {
    sweep();
    const at = now();
    return { supported: true, bootId, revision, alerts: [...active.values()].map((a) => view(a, at)) };
  }

  /** `usage:remind-at-reset` — the box uses the CURRENT snapshot's reset instant, never a client copy. */
  async function remind({ key, sessionID } = {}, { createJob } = {}) {
    const at = now();
    let win = null;
    let provider = "";
    for (const snap of lastSnapshots) {
      const w = (snap.windows ?? []).find((x) => `${snap.provider}:${x.kind}` === key);
      if (w) {
        win = w;
        provider = snap.provider;
        break;
      }
    }
    const resetsAt = typeof win?.resetsAt === "number" ? win.resetsAt : null;
    if (resetsAt === null) return { ok: false, code: "no-reset", message: "This window has no reset time." };
    if (resetsAt <= at) {
      return { ok: false, code: "expired", message: "This window has already reset — you can keep working." };
    }
    if (typeof sessionID !== "string" || sessionID === "") {
      return { ok: false, code: "no-session", message: "Open a chat to set a reminder." };
    }
    const label = providerLabel(provider);
    const fireAt = resetsAt + REMIND_OFFSET_MS;
    const res = await createJob({
      fireAt,
      kind: "notify",
      recurring: false,
      sessionID,
      prompt: `${label} ${win.label} has reset — you can keep working.`,
      label: `Reminder: ${label} ${win.label} reset`,
    });
    if (!res?.ok) {
      return { ok: false, code: "schedule-failed", message: `Couldn't set a reminder: ${res?.error ?? "unknown error"}` };
    }
    return { ok: true, job: res.job, fireAt };
  }

  function stop() {
    timers.clearTimeout(timer);
    timer = null;
  }

  return { observe, list, remind, sweep, stop };
}
