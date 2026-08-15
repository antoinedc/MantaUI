// ===== Subscription usage escalation =====
//
// Pure logic for surfacing plan-usage alerts (>=90% warn / >=100% limit) to
// the global toast host (BET-739). The subscriber lives in App.tsx (the same
// app-level place that already consumes bus events) and pushes the produced
// toasts through the existing `pushAppToast` store action — there is no new
// toast component and no new host.
//
// Fire-once semantics are the whole point: an alert fires only on a
// TRANSITION UPWARD into a level for a given `provider:window` key. It must
// not re-fire while the level holds, and it must re-arm when the level drops
// (i.e. after the window resets). The previous-level map lives in a ref held
// by the subscriber; this module is pure.
//
// Stale rule: a window whose reset instant has already passed (`stale: true`)
// is reporting the OLD window's numbers. It must never raise an alert — the
// key carries its previous level forward instead of re-arming (a re-arm at the
// boundary is precisely what lets the same limit fire twice across a reset).
//
// There is deliberately no React and no provider-name branching here beyond
// the exact strings the spec dictates.

import type { UsageSnapshot, UsageWindow } from "../shared/types";
import { selectCacheTtlMs } from "./chatUtils";

/** >=90 = warn, >=100 = limit; anything below 90 is "none". */
export type UsageAlertLevel = "none" | "warn" | "limit";

const LEVEL_RANK: Record<UsageAlertLevel, number> = { none: 0, warn: 1, limit: 2 };

/** Classify one window's pct into an alert level. Boundaries: exactly 90 ->
 *  warn, exactly 100 -> limit. */
export function usageAlertLevel(pct: number): UsageAlertLevel {
  if (pct >= 100) return "limit";
  if (pct >= 90) return "warn";
  return "none";
}

/** The current alert level for every present `provider:window.kind` key.
 *  Windows absent from the snapshots are absent from the record — the
 *  subscriber writes this back into its prev map after each event, which is
 *  what re-arms a key once a window resets and drops below the threshold. */
export function buildUsageLevels(
  snapshots: UsageSnapshot[] | null | undefined,
  prev: Record<string, UsageAlertLevel> = {},
): Record<string, UsageAlertLevel> {
  const out: Record<string, UsageAlertLevel> = {};
  for (const snap of snapshots ?? []) {
    for (const win of snap.windows ?? []) {
      const key = `${snap.provider}:${win.kind}`;
      // A stale window's pct belongs to the window that just ended. Carrying
      // the level forward keeps fire-once intact across the boundary: the key
      // neither re-arms (which would re-fire the same limit) nor disappears.
      out[key] = win.stale ? (prev[key] ?? "none") : usageAlertLevel(win.pct);
    }
  }
  return out;
}

export type UsageAlert = {
  key: string; // `${provider}:${window.kind}`
  level: UsageAlertLevel;
  provider: string;
  window: UsageWindow;
};

/**
 * Which alerts fire given the previous level map and the incoming snapshots.
 * An alert fires only when the level TRANSITIONS UPWARD (none→warn, none→limit
 * via warn, warn→limit) for a key. It does not re-fire while the level holds.
 * Re-arming is the caller's responsibility: write the new level map (see
 * buildUsageLevels) back into `prev` after consuming the fired alerts.
 */
export function shouldFireUsageAlert(
  prev: Record<string, UsageAlertLevel>,
  next: UsageSnapshot[] | null | undefined,
): UsageAlert[] {
  const fired: UsageAlert[] = [];
  for (const snap of next ?? []) {
    for (const win of snap.windows ?? []) {
      if (win.stale) continue;
      const key = `${snap.provider}:${win.kind}`;
      const newLevel = usageAlertLevel(win.pct);
      const oldLevel = prev[key] ?? "none";
      if (newLevel !== "none" && LEVEL_RANK[newLevel] > LEVEL_RANK[oldLevel]) {
        fired.push({ key, level: newLevel, provider: snap.provider, window: win });
      }
    }
  }
  return fired;
}

/**
 * "Shall the 'keep going' modal show the amber stale-cache warning?" True when
 * the reset is beyond the configured prompt-cache window — exactly when the
 * cached prefix will have expired and the next turn re-bills the whole
 * conversation as fresh input. Reuses selectCacheTtlMs (do not re-derive).
 */
export function shouldWarnStaleCache(
  fireAt: number,
  now: number,
  cacheTtl: "5m" | "1h",
): boolean {
  return fireAt - now > selectCacheTtlMs(cacheTtl);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * 12-hour wall clock for reset times in the alert toast copy: "3:05 pm", or
 * with a leading weekday "Tue 9:00 am". Returns "" for a missing/invalid
 * timestamp so callers can omit the "resets …" clause rather than rendering
 * a broken time.
 */
export function formatResetClock(
  resetsAt: number | null | undefined,
  withWeekday: boolean,
): string {
  if (resetsAt == null || !Number.isFinite(resetsAt) || Number.isNaN(new Date(resetsAt).getTime())) {
    return "";
  }
  const d = new Date(resetsAt);
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = h24 < 12 ? "am" : "pm";
  const clock = `${h12}:${mm} ${ampm}`;
  return withWeekday ? `${WEEKDAYS[d.getDay()]} ${clock}` : clock;
}

/**
 * Human "… away" distance used by the keep-going modal's stale-cache warning:
 * "4 days", "2 hours", "45 minutes", "less than a minute". Floors to the
 * coarsest unit that's still >= 1.
 */
export function describeResetDistance(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 60_000) return "less than a minute";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(deltaMs / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The warn (>=90%) toast body — plain, no actions, takes the default 6s TTL.
 * "Claude Session (5h) 93% used — resets 3:05 pm."
 */
export function buildWarnMessage(
  providerLabel: string,
  windowLabel: string,
  pct: number,
  resetsAt: number | null | undefined,
): string {
  const pctShown = Math.round(pct);
  const reset = formatResetClock(resetsAt, false);
  return `${providerLabel} ${windowLabel} ${pctShown}% used${reset ? ` — resets ${reset}` : ""}.`;
}

/**
 * The limit (>=100%) toast body — error tone, two actions, never auto-dismisses.
 * "Weekly limit reached on Claude — resets Tue 9:00 am."
 */
export function buildLimitMessage(
  providerLabel: string,
  windowLabel: string,
  resetsAt: number | null | undefined,
): string {
  const reset = formatResetClock(resetsAt, true);
  return `${windowLabel} limit reached on ${providerLabel}${reset ? ` — resets ${reset}` : ""}.`;
}
