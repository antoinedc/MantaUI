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
