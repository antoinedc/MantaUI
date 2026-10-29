// usageWindowTone.mjs — the ONE colour band rule for a subscription usage
// window (WS09 SF-M18). The box stamps it on every window it publishes
// (src/server/usageWindowView.mjs); the desktop applies the same rule to the
// windows it derives itself (the automatic-mode combined ring), so a figure can
// never be one colour on the box and another in the app.

/** "under" (<70) | "warn" (70–89) | "danger" (90–99) | "over" (≥100). */
export function windowTone(pct) {
  if (pct >= 100) return "over";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "under";
}
