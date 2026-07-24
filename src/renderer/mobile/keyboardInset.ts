// Visual-viewport keyboard-inset computation (BET-259).
//
// On iOS Safari (PWA mode) the layout viewport does NOT resize when the
// soft keyboard opens — the keyboard overlays the page. To dock a bar above
// the keyboard we translate it up by the gap between the layout viewport
// (window.innerHeight) and the visual viewport (window.visualViewport.height)
// plus the offset the visual viewport has scrolled from the layout origin.
//
// On Capacitor (Android & iOS native shell) the WebView resizes the layout
// viewport as the keyboard slides in, so innerHeight === visualViewport.height
// and the helper returns 0 → the bar sits in normal flow at the bottom of
// the flex column, exactly where its sibling .mobile-body already accounts
// for the resize. One code path serves both hosts.
//
// Pure function — no DOM access — so it's trivially testable.

export function computeKeyboardInset(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
): number {
  // `innerHeight - vvHeight` is the gap covered by the keyboard.
  // `vvOffsetTop` is the visual viewport's offset from the layout origin
  // (positive when Safari's "shrink viewport" / form-zoom has pushed the
  // visual viewport down inside the layout). Subtracting it makes the
  // computed inset track the keyboard edge rather than the layout edge.
  const inset = innerHeight - vvHeight - vvOffsetTop;
  return Math.max(0, inset);
}
