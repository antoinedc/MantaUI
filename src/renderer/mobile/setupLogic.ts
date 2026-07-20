import { isSubmittableCode } from "../../shared/claim.mjs";
import { boxDirectUrl, isValidBoxToken } from "../../shared/transport.mjs";

export type SetupFields = {
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
 * - Always requires a valid 32-hex Box ID — the box's public hostname
 *   (`https://<boxId>.boxes.mantaui.com`, see `boxDirectUrl`) is derived from
 *   it; the box is reached directly via this hostname.
 */
export function canConnectSetup(input: SetupFields): boolean {
  if (input.submitting) return false;
  if (!isSubmittableCode(input.code)) return false;
  return isValidBoxToken(input.boxId.trim());
}

/**
 * Build the {serverUrl, code} input for httpApi.authClaim. The box's public
 * hostname is derived from the box ID via the shared `boxDirectUrl` helper
 * (src/shared/transport.mjs) — single source of truth for the URL shape. The
 * claim POSTs `{pairing_code}` to `<serverUrl>/auth/claim` against the box's
 * own bui-server. The Box ID is trimmed.
 */
export function buildSetupClaimInput(input: {
  boxId: string;
  code: string;
}): { serverUrl: string; code: string } {
  return { serverUrl: boxDirectUrl(input.boxId.trim()), code: input.code };
}

/**
 * Resolve the server URL to persist to localStorage["manta_server"] after a
 * successful claim. Post-BET-198 every box has a public hostname
 * (`<boxId>.boxes.mantaui.com`) built by the shared `boxDirectUrl` helper, so
 * the manual-setup flow writes the same string the deep-link handler writes.
 */
export function resolveSetupServerUrl(input: { boxId: string }): string {
  return boxDirectUrl(input.boxId.trim());
}

/**
 * Whether the ACTIVE connection (the persisted `manta_server`) is a direct
 * HTTPS connection to a box's public hostname. Post-BET-198 there is no
 * intermediary; every configured base is direct. Empty/unset is also "direct"
 * (it just means the mobile/web hasn't yet paired — the bootstrap will route
 * to the setup screen).
 *
 * Drives the ConnectingScreen copy: "Connecting to your box" (+ the host pill).
 * Kept as a typed single-string return for API compatibility with the renderer
 * call sites; the value is always "direct".
 */
export function resolveConnectRoute(_serverBase: string): "direct" {
  return "direct";
}
