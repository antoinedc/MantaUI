// usageWindowView.mjs — the colour band of a subscription usage window, decided
// on the box (WS09 SF-M18). Every `UsageWindow` the poller publishes (`usage:list`,
// `usage:list-seats`, the `usage.updated` frame, the seat windows inside
// `accounts:list`) carries the same `tone`, so the desktop dial and the iOS
// rings can never disagree about what colour 85% is. `kind` stays the window's
// role (session / weekly …): comparing it to a literal is not a rule.

/** "under" (<70) | "warn" (70–89) | "danger" (90–99) | "over" (≥100). */
export function windowTone(pct) {
  if (pct >= 100) return "over";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "under";
}

/**
 * A snapshot with `tone` on every window (the input is not mutated). A snapshot
 * that already carries the right tones is returned as-is, so a carried-forward
 * snapshot (usage.mjs keeps the SAME object across failed ticks) stays the same
 * reference when it is decorated again.
 */
export function decorateSnapshot(s) {
  if (Array.isArray(s.windows) && s.windows.every((w) => w.tone === windowTone(w.pct))) return s;
  return { ...s, windows: (s.windows ?? []).map((w) => ({ ...w, tone: windowTone(w.pct) })) };
}
