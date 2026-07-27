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
 * The two colours are the existing theme tokens, not new ones:
 *   • "#0B1020" is `bg.DEFAULT` (already the window's `backgroundColor`)
 *   • "#A7B1C4" is `text.muted`
 * both from tailwind.config.js. `height: 40` matches the renderer's
 * `h-10` header row — if those ever disagree, the caption buttons stop
 * lining up with the header.
 */
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
          height: 40,
        },
      };
    default:
      // Linux and anything else: hand the OS its default title bar.
      return {};
  }
}
