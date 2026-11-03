/**
 * Platform-specific BrowserWindow title-bar options, spread into the
 * constructor. Exactly one place in the app decides this.
 *
 *   darwin → hiddenInset + traffic-light inset (unchanged from today)
 *   win32  → hidden + a Windows Controls Overlay matching our header
 *   other  → {} — Linux keeps its native title bar
 *
 * Pure: no `electron` import. That is what makes it unit-testable —
 * `src/main/index.ts` constructs an `app` at module scope and cannot
 * itself be imported from a test.
 *
 * The two initial colours are the existing theme tokens, not new ones:
 *   • "#0B1020" is `bg.DEFAULT` (already the window's `backgroundColor`)
 *   • "#A7B1C4" is `text.muted`
 * both from tailwind.config.js. The renderer re-sends the live theme colours
 * through `titleBarOverlayUpdate` on mount and on every theme / right-panel
 * change, so these only show until that first sync.
 *
 * `height: 44` is the height of every header that sits under the caption
 * buttons: SessionHeader, the Explorer top bar, the App titlebar (terminal /
 * new-session panes), the Routines header and the Settings drag strip, all
 * `h-11`. If those ever disagree, the caption buttons stop lining up with the
 * header.
 */
export const TITLE_BAR_OVERLAY_HEIGHT = 44;

export function titleBarOptions(platform: string): Record<string, unknown> {
  switch (platform) {
    case "darwin":
      return {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 14 },
      };
    case "win32":
      return {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#0B1020",
          symbolColor: "#A7B1C4",
          height: TITLE_BAR_OVERLAY_HEIGHT,
        },
      };
    default:
      // Linux and anything else: hand the OS its default title bar.
      return {};
  }
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * The argument for `BrowserWindow.setTitleBarOverlay` for a renderer-supplied
 * `{ color, symbolColor }`, or null when nothing should be applied: any
 * platform but win32 (the overlay only exists there), or a value that is not a
 * `#RRGGBB` string (the renderer is untrusted input to a native call).
 */
export function titleBarOverlayUpdate(
  platform: string,
  input: unknown,
): { color: string; symbolColor: string; height: number } | null {
  if (platform !== "win32") return null;
  if (typeof input !== "object" || input === null) return null;
  const { color, symbolColor } = input as { color?: unknown; symbolColor?: unknown };
  if (typeof color !== "string" || !HEX6.test(color)) return null;
  if (typeof symbolColor !== "string" || !HEX6.test(symbolColor)) return null;
  return { color, symbolColor, height: TITLE_BAR_OVERLAY_HEIGHT };
}
