// pairPanel.ts — pure panel-state helpers for the desktop "Add a phone"
// pairing card (BET-493). The server mints a six-digit pairing code, and the
// panel auto-rotates it on expiry while it is open (§6.4).
//
// Everything here is deterministic + clock-injectable so the expiry/refresh
// edge cases are unit-tested (repo pattern: chatUtils.ts → chatUtils.test.ts)
// without DOM or timers. The React component (AddPhonePanel) calls these.

// Is the code expired at `now`? Expiry is inclusive: at/after expiresAt it's
// dead (a joiner claiming it would get 403).
export function isPairCodeExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

// Should the panel rotate the code now, while it is open? Auto-rotation happens
// on expiry (§6.4 row 2). `graceMs` lets a caller rotate slightly EARLY to hide
// mint latency; default 0 rotates exactly on expiry so a still-valid code is
// never wasted by a premature re-mint that would orphan a phone mid-scan.
export function shouldRefreshPairCode(
  expiresAt: number,
  now: number,
  graceMs = 0,
): boolean {
  return now >= expiresAt - graceMs;
}

// Milliseconds until the code should be refreshed (0 when it already has).
export function msUntilRefresh(
  expiresAt: number,
  now: number,
  graceMs = 0,
): number {
  return Math.max(0, expiresAt - graceMs - now);
}

// Manual six-digit path (§5.2.9/§5.2.10): the desktop shows the six digits; a
// phone types them. Validate the exact 6-digit code shape.
export function isValidManualPairCode(code: string): boolean {
  return typeof code === "string" && /^\d{6}$/.test(code);
}
