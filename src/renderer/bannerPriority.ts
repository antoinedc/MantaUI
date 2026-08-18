// ===== Banner priority (BET-416 §E, stage 3 of the unified-update epic) =====
//
// App.tsx renders AT MOST ONE full-width bar, chosen by severity. The spec
// collapsed the five update banner kinds (version-skew, update-failed,
// server-update, plus the folded "behind" compat variant) into ONE `updates`
// banner — its copy is produced by `describeUpdateBanner` in
// src/shared/updateTargets.mjs. So the priority chain is:
//
//   reconnecting > incompatible > updates
//
// `reconnecting` and `incompatible` stay ABOVE `updates` because they are a
// different class of problem (connectivity, and a hard wire-contract block) —
// an update prompt must not mask a broken link or a version that cannot talk
// to the box at all.
//
// "Update available" (a downloaded desktop auto-update) is NOT a bar at all —
// it is demoted to a small --accent dot on the Settings entry in the sidebar
// footer; the bar is reserved for states that actually block you.
//
// `pickBanner` is pure so the severity order is unit-tested without mounting
// App.

export type BannerKind = "reconnecting" | "incompatible" | "updates";

export type BannerState = {
  /** Events-WebSocket is degraded (anything but connected/idle). */
  reconnecting: boolean;
  /** Desktop↔box are on different majors (wire-contract mismatch). */
  incompatible: boolean;
  /** Any update state warrants the banner (available / mandatory / failed). */
  updates: boolean;
};

/** Severity order, highest first. */
export const BANNER_PRIORITY: BannerKind[] = [
  "reconnecting",
  "incompatible",
  "updates",
];

/** Map a BannerKind to its BannerState flag (kebab kind → camelCase flag). */
function flagFor(kind: BannerKind, state: BannerState): boolean {
  switch (kind) {
    case "reconnecting": return state.reconnecting;
    case "incompatible": return state.incompatible;
    case "updates": return state.updates;
  }
}

/**
 * Pure: return the single highest-severity banner to render, or null if no
 * banner condition is active. The first true flag in `BANNER_PRIORITY` wins.
 */
export function pickBanner(state: BannerState): BannerKind | null {
  for (const kind of BANNER_PRIORITY) {
    if (flagFor(kind, state)) return kind;
  }
  return null;
}
