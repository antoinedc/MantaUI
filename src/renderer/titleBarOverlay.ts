// Windows caption buttons follow the theme (spec 2026-11-03 §1 "Theme"). The OS
// paints them over the top-right header, so they take that header's background
// and the muted text colour. Colours are READ from the live tokens, never
// hardcoded: main only accepts `#RRGGBB`, so a token written any other way is
// converted here.

import { useEffect } from "react";
import { getMantaPreload } from "./preloadAccess";
import { useResolvedTheme } from "./theme";
import type { RightPanel } from "./explorer/explorerStore";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/][^)]*)?\)$/i;

/** `#RGB`, `#RRGGBB` or `rgb(r g b)` / `rgb(r, g, b)` → `#RRGGBB`; null for anything else. */
export function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (HEX.test(v)) {
    const h = v.slice(1);
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return `#${full.toUpperCase()}`;
  }
  const m = RGB.exec(v);
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map(Number);
  if (ch.some((n) => n > 255)) return null;
  return `#${ch.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * `color` is the background of the header under the buttons: the panel surface
 * (`--panel`, the panel surface) when the Explorer or Artifacts is the right-hand
 * column, else the canvas the session / titlebar header sits on.
 */
export function readOverlayColors(rightPanelShown: boolean): { color: string; symbolColor: string } | null {
  const cs = getComputedStyle(document.documentElement);
  const color = cssColorToHex(cs.getPropertyValue(rightPanelShown ? "--panel" : "--canvas"));
  const symbolColor = cssColorToHex(cs.getPropertyValue("--tx2"));
  return color && symbolColor ? { color, symbolColor } : null;
}

/** Re-sends the colours on mount, on every resolved-theme change and when the right panel changes. */
export function useTitleBarOverlaySync(rightPanel: RightPanel): void {
  const theme = useResolvedTheme();
  useEffect(() => {
    const preload = getMantaPreload();
    if (!preload?.setTitleBarOverlay) return;
    const colors = readOverlayColors(rightPanel !== "none");
    if (!colors) return;
    preload.setTitleBarOverlay(colors).catch((e: unknown) => console.warn("setTitleBarOverlay failed", e));
  }, [theme, rightPanel]);
}
