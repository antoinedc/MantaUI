// demoLayout.ts — pure helper for the demo-mode shell override (BET-302).
//
// `?demo` in a browser used to always render <MobileApp/> because the only
// branch was `isMobile = !preload`, and a browser never has an Electron
// preload. That made BET-303's desktop hero unreachable from `?demo` alone.
// This helper adds an explicit override that lives ONLY inside demo mode
// (bootDemo); the real boot path's isMobile derivation is unchanged because
// that is production transport selection.
//
// Resolves the override from URL search params. Returning null means "no
// override — caller falls back to its production isMobile flag", so the
// override never affects how the real (non-demo) boot path picks a layout.
//
// Conflict resolution: when both `desktop` and `mobile` are set, `desktop`
// wins. The screenshot harness (BET-303) is the harder-reach consumer
// (desktop in a browser needs the explicit override; mobile in Electron
// is the default behaviour without any flag), so we bias toward it.

export type DemoLayout = "desktop" | "mobile";

export function pickDemoLayout(params: URLSearchParams): DemoLayout | null {
  if (params.has("desktop")) return "desktop";
  if (params.has("mobile")) return "mobile";
  return null;
}

// Which fixture state the demo transport serves.
//
// Every fixture state the demo transport can serve is a single named member
// here plus its branch in demoApi — never a new URL boolean. Each state is
// reachable by pasting a URL into a browser, so a human reviewer sees
// exactly what the machine captured.
//
// "full"         — the populated fixture (projects, sessions, a transcript).
//                  The default, and what the marketing shots capture.
// "empty"        — a box with no projects yet. This is a REAL product state
//                  (a freshly-paired box), and it is the only way to reach
//                  the zero-project screens, which otherwise require
//                  deleting fixture data from a live box.
// "version-skew" — minClient raised above the client so the non-dismissible
//                  version-skew banner renders (the first non-happy-path
//                  capture).
export const DEMO_STATES = ["full", "empty", "version-skew"] as const;
export type DemoState = (typeof DEMO_STATES)[number];

/** `?demo&state=<name>`. An unknown or absent value falls back to "full", so
 *  a typo degrades to the default capture rather than a blank screen. */
export function pickDemoState(params: URLSearchParams): DemoState {
  const raw = params.get("state");
  return (DEMO_STATES as readonly string[]).includes(raw ?? "")
    ? (raw as DemoState)
    : "full";
}
