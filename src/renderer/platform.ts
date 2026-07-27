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

/** Prefix for the primary shortcut modifier: "⌘N" on macOS, "Ctrl+N" else. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";

/** Prefix for the alt modifier: "⌥" on macOS, "Alt" else. */
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
