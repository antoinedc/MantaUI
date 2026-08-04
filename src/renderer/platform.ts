// The only place the renderer reads the host platform. Everything else takes
// IS_MAC as an argument or imports these constants — see the epic's "one
// platform switch per concept" rule.
const platform =
  (typeof navigator !== "undefined" &&
    ((navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ??
      navigator.platform)) ||
  "";

export const IS_MAC = /mac/i.test(platform);

/** Windows only. macOS traffic-lights sit top-LEFT (over the sidebar);
 *  Windows mounts its caption buttons top-RIGHT (over the main area), so the
 *  top-left corner is free for sidebar content to sit flush against. */
export const IS_WINDOWS = /win/i.test(platform);

/** Prefix for the primary shortcut modifier: "⌘N" on macOS, "Ctrl+N" else. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";

/** Prefix for the alt modifier: "⌥" on macOS, "Alt" else. */
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
