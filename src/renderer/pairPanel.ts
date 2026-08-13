// pairPanel.ts — pure panel-state helpers for the desktop "Add a phone"
// pairing card (BET-493). The server mints a six-digit pairing code, and the
// panel auto-rotates it on expiry while it is open (§6.4).
//
// Everything here is deterministic + clock-injectable so the expiry/refresh
// edge cases are unit-tested (repo pattern: chatUtils.ts → chatUtils.test.ts)
// without DOM or timers. The React component (AddPhonePanel) calls these.

import { boxDirectUrl, isPrivateServerUrl } from "../shared/transport.mjs";
import { normalizeServerUrl } from "../shared/setupLogic";

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

/**
 * Decide whether the "Add a phone" QR should carry a `server=` override
 * (BET-703). On a tailnet / macOS box (no public `boxes.mantaui.com`
 * hostname), a scanned QR that omits `server=` sends the phone to a
 * non-existent public host → "Can't reach your box" with no hint. So when
 * the desktop's configured server URL differs from the box's derived public
 * hostname, we include it as `serverUrl` — but ONLY when that URL is a
 * private/tailnet address (`isPrivateServerUrl`): a custom PUBLIC domain
 * must stay out because the iOS parser refuses non-private `server=` by
 * design (the crafted-link guard). Returns `undefined` when no override
 * should be attached: configured URL missing, identical to the public
 * hostname, or a non-private custom domain.
 *
 * Pure — the caller (AddPhonePanel) feeds the desktop's configured server
 * URL read from `localStorage["manta_server"]`.
 */
export function resolveQrServerOverride(
  boxId: string,
  configuredServerUrl: string | undefined | null,
): string | undefined {
  const direct = boxDirectUrl(boxId.trim());
  const configured = normalizeServerUrl(configuredServerUrl);
  if (configured === null || configured === direct) return undefined;
  if (!isPrivateServerUrl(configured)) return undefined;
  return configured;
}
