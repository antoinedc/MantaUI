// setupLogic.ts — pure, framework-free core for the mobile first-run setup
// screen (SetupScreen.tsx). Extracted so the submit gate + claim-input
// construction are unit-testable without a DOM, fetch, or the Capacitor
// bridge (see setupLogic.test.ts beside this file).
//
// The setup screen has two pairing modes, keyed off whether the Server URL
// field still holds the default MantaUI relay:
//
//   • relay mode  (Server URL === the MantaUI relay): the relay routes to a
//     box strictly by Box ID, so pairing needs a valid 32-hex Box ID + a
//     6-digit code. The relay URL itself is hardcoded, so authClaim routes on
//     the boxId (serverUrl is left empty for that branch).
//   • custom mode (Server URL edited to a self-hosted box): a direct claim
//     against that URL needs only the URL + a 6-digit code. The Box ID field
//     is disabled in this mode (a direct box has no relay routing step).
//
// The shared contracts (URL shape, 6-digit code, 32-hex box id) are reused
// from pairStepLogic / ../../shared/claim.mjs / ../../shared/transport.mjs so
// there is a single source of truth for each.
//
// BET-198 SCOPE NOTE: the relay itself is gone (src/shared/transport.mjs no
// longer exports RELAY_BASE / relayBase / relayBoxUrl). The setup screen's
// "relay mode" is now semantically a legacy UI affordance — BET-205 will gut
// the relay concept from the UI. For now we keep the in-file literal so
// typecheck and tests stay green; the relay URL is still hardcoded here.

import { normalizeServerUrl, isValidServerUrl } from "../pairStepLogic";
import { isSubmittableCode } from "../../shared/claim.mjs";
import { isValidBoxToken } from "../../shared/transport.mjs";

/** Legacy relay host — kept as an in-file literal so setupLogic still
 *  compiles after BET-198 removed RELAY_BASE from shared/transport. Will be
 *  replaced by direct-hostname pairing in BET-205. */
const RELAY_BASE = "https://relay.mantaui.com";

/** The Server URL the setup form pre-fills with (the official MantaUI relay).
 *  Typed as `string` so consumers like useState<string> accept it without
 *  narrowing to the literal type. */
export const DEFAULT_SERVER_URL: string = RELAY_BASE;

/**
 * True when the current Server URL is (still) the official MantaUI relay. Used
 * to decide relay-vs-custom mode: whitespace / trailing slashes are ignored so
 * "https://relay.mantaui.com/" counts as the default too.
 */
export function isRelayServer(serverUrl: string): boolean {
  return normalizeServerUrl(serverUrl) === normalizeServerUrl(DEFAULT_SERVER_URL);
}

export type SetupFields = {
  serverUrl: string;
  boxId: string;
  code: string;
  submitting: boolean;
};

/**
 * True when the Connect button should be enabled. Pure — the caller passes the
 * live field values + in-flight flag.
 *
 * - Never while a request is in flight.
 * - Always requires a submittable (6-digit) code.
 * - relay mode  → additionally requires a valid 32-hex Box ID.
 * - custom mode → additionally requires a valid http(s) Server URL.
 */
export function canConnectSetup(input: SetupFields): boolean {
  if (input.submitting) return false;
  if (!isSubmittableCode(input.code)) return false;
  if (isRelayServer(input.serverUrl)) {
    return isValidBoxToken(input.boxId.trim());
  }
  return isValidServerUrl(input.serverUrl);
}

/**
 * Build the AuthClaimInput for the current fields. Mirrors the deep-link
 * handler's contract (deepLink.ts buildClaimInput):
 *
 * - relay mode  → { serverUrl: "", boxId, code } so httpApi.authClaim routes
 *   through the relay claim (keyed on boxId), NOT a direct POST to an empty base.
 * - custom mode → { serverUrl, code } for a direct /auth/claim.
 *
 * The Box ID is trimmed; the server URL is normalized (trailing slashes off).
 */
export function buildSetupClaimInput(input: {
  serverUrl: string;
  boxId: string;
  code: string;
}): { serverUrl: string; boxId?: string; code: string } {
  if (isRelayServer(input.serverUrl)) {
    return { serverUrl: "", boxId: input.boxId.trim(), code: input.code };
  }
  return { serverUrl: normalizeServerUrl(input.serverUrl), code: input.code };
}

/**
 * Resolve the server URL to persist to localStorage["manta_server"] after a
 * successful claim. relay mode persists the per-box relay proxy URL
 * (`${RELAY_BASE}/box/<boxId>`); custom mode persists the normalized URL the
 * user typed. Single-sourced via relayBoxUrl so it matches the deep-link path.
 */
export function resolveSetupServerUrl(input: {
  serverUrl: string;
  boxId: string;
}): string {
  if (isRelayServer(input.serverUrl)) {
    // relayBoxUrl validates the boxId; the caller only reaches here after a
    // successful claim, which already required a valid boxId.
    return `${RELAY_BASE}/box/${input.boxId.trim()}`;
  }
  return normalizeServerUrl(input.serverUrl);
}

/**
 * Whether the ACTIVE connection (the persisted `manta_server`) goes through the
 * MantaUI relay or directly to a self-hosted box. The relay's persisted form is
 * the per-box proxy URL `${RELAY_BASE}/box/<id>`, so we match by prefix (NOT the
 * exact base, which is only the pre-claim form). Anything else — a typed box
 * URL, or a same-origin PWA base — is "direct". An empty/unset base is treated
 * as relay (the default), since that's what a fresh install pairs into.
 *
 * Drives the ConnectingScreen copy: "Connecting to relay…" (no host shown) vs
 * "Connecting to remote box…" (+ the host, since a custom endpoint is worth
 * surfacing).
 */
export function resolveConnectRoute(serverBase: string): "relay" | "direct" {
  const base = normalizeServerUrl(serverBase);
  if (base === "") return "relay";
  const relay = normalizeServerUrl(DEFAULT_SERVER_URL);
  return base === relay || base.startsWith(`${relay}/`) ? "relay" : "direct";
}
