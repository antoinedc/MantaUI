// ===== Banner priority (BET-416 §E) =====
//
// App.tsx used to stack up to six full-width bars — five UpdateBar variants
// (app update, update error, server update, version skew, compatibility) plus
// ReconnectingBanner — that could all co-occur. The spec collapses them to
// AT MOST ONE bar, chosen by severity:
//
//   reconnecting > incompatible > version skew > update failed > server update
//
// "Update available" (a downloaded desktop auto-update) is NOT a bar at all —
// it is demoted to a small --accent dot on the Settings entry in the sidebar
// footer; the bar is reserved for states that actually block you.
//
// `pickBanner` is pure so the severity order is unit-tested without mounting
// App. The "behind" compatibility variant (box on the supported major but
// older than the desktop) folds into `server-update` — it is an upgrade
// prompt with the same self-update action, not a blocking incompatibility.

export type BannerKind =
  | "reconnecting"
  | "incompatible"
  | "version-skew"
  | "update-failed"
  | "server-update";

export type BannerState = {
  /** Events-WebSocket is degraded (anything but connected/idle). */
  reconnecting: boolean;
  /** Desktop↔box are on different majors (wire-contract mismatch). */
  incompatible: boolean;
  /** Client is older than the server's `minClient` (non-dismissible). */
  versionSkew: boolean;
  /** A desktop auto-update failed (integrity / permission). */
  updateFailed: boolean;
  /** A server update is available, OR the box is "behind" (upgradeable). */
  serverUpdate: boolean;
};

/** Severity order, highest first. */
export const BANNER_PRIORITY: BannerKind[] = [
  "reconnecting",
  "incompatible",
  "version-skew",
  "update-failed",
  "server-update",
];

/** Map a BannerKind to its BannerState flag (kebab kind → camelCase flag). */
function flagFor(kind: BannerKind, state: BannerState): boolean {
  switch (kind) {
    case "reconnecting": return state.reconnecting;
    case "incompatible": return state.incompatible;
    case "version-skew": return state.versionSkew;
    case "update-failed": return state.updateFailed;
    case "server-update": return state.serverUpdate;
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
