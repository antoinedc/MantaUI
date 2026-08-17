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
// is reporting the OLD window's numbers. It must never RAISE an alert — see
// the guard in shouldFireUsageAlert. It is deliberately NOT special-cased when
// computing the baseline; see buildUsageLevels.
//
// There is deliberately no React and no provider-name branching here beyond
// the exact strings the spec dictates.

import type { UsageSnapshot, UsageWindow } from "../shared/types";
import { formatWindowReset } from "./chatUtils";

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
 *  what re-arms a key once a window resets and drops below the threshold.
 *
 *  A stale window is NOT special-cased here on purpose. Its `pct` is the
 *  number the window that just ended finished on, so reading it verbatim
 *  records the level we would already have alerted at — which is exactly the
 *  fire-once baseline we want, and it is correct on a COLD START too. An
 *  earlier version defaulted a stale window to "none" when there was no prior
 *  level, which armed the alert at zero while usage was really at 100% and
 *  made the next update look like a fresh climb into the limit. */
export function buildUsageLevels(
  snapshots: UsageSnapshot[] | null | undefined,
): Record<string, UsageAlertLevel> {
  const out: Record<string, UsageAlertLevel> = {};
  for (const snap of snapshots ?? []) {
    for (const win of snap.windows ?? []) {
      out[`${snap.provider}:${win.kind}`] = usageAlertLevel(win.pct);
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
 * The warn (>=90%) toast body — plain, no actions, takes the default 6s TTL.
 * "Claude Session (5h) 93% used — resets in 2h10m."
 */
export function buildWarnMessage(
  providerLabel: string,
  windowLabel: string,
  pct: number,
  resetsAt: number | null | undefined,
  nowMs: number,
): string {
  const line = formatWindowReset(resetsAt, nowMs);
  return `${providerLabel} ${windowLabel} ${Math.round(pct)}% used${line ? ` — ${line}` : ""}.`;
}

/**
 * The limit (>=100%) toast body — error tone, two actions, never auto-dismisses.
 * "Weekly limit reached on Claude — resets in 6d 3h (Thu, 21 Aug, 09:00)."
 */
export function buildLimitMessage(
  providerLabel: string,
  windowLabel: string,
  resetsAt: number | null | undefined,
  nowMs: number,
): string {
  const line = formatWindowReset(resetsAt, nowMs);
  return `${windowLabel} limit reached on ${providerLabel}${line ? ` — ${line}` : ""}.`;
}
