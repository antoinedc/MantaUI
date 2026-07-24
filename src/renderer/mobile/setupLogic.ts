import { isSubmittableCode } from "../../shared/claim.mjs";
import { boxDirectUrl, isValidBoxToken } from "../../shared/transport.mjs";

export type SetupFields = {
  boxId: string;
  code: string;
  submitting: boolean;
  /**
   * Optional Advanced server URL (BET-268). When present and non-empty, it
   * overrides the box-derived hostname — used to reach a box over its tailnet
   * (e.g. `http://100.x.y.z:8787`) or any other non-public-hostname listener.
   * Validation lives in `normalizeServerUrl`; callers consult it for both
   * gating (canConnectSetup) and the user-facing inline error.
   */
  serverUrl?: string;
};

/**
 * Normalize a user-entered Advanced server URL (BET-268, tailnet path).
 *
 * - Trims surrounding whitespace and strips trailing slashes.
 * - Returns the value only when it begins with `http://` or `https://`.
 * - Returns `null` when the input is empty OR uses any other scheme
 *   (incl. `ftp://`, `file://`, bare host `100.x.y.z:8787`).
 *
 * Single source of truth — shared by desktop PairStep and mobile SetupScreen
 * (and the unit tests), so the two pairing screens can never disagree about
 * what counts as a usable URL. Pure; no I/O.
 */
export function normalizeServerUrl(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (v === "") return null;
  if (!/^https?:\/\//.test(v)) return null;
  return v;
}

/**
 * True when the Connect button should be enabled. Pure — the caller passes the
 * live field values + in-flight flag.
 *
 * - Never while a request is in flight.
 * - Always requires a submittable (6-digit) code.
 * - Always requires a valid 32-hex Box ID — the box's public hostname
 *   (`https://<boxId>.boxes.mantaui.com`, see `boxDirectUrl`) is derived from
 *   it; the box is reached directly via this hostname.
 * - When the user has typed a non-empty `serverUrl` (Advanced), it must be a
 *   valid `http(s)://` URL — otherwise the inline error renders and submit is
 *   blocked. An absent/empty `serverUrl` is the default path (no override).
 */
export function canConnectSetup(input: SetupFields): boolean {
  if (input.submitting) return false;
  if (!isSubmittableCode(input.code)) return false;
  if (input.serverUrl !== undefined && input.serverUrl.trim() !== "") {
    if (normalizeServerUrl(input.serverUrl) === null) return false;
  }
  return isValidBoxToken(input.boxId.trim());
}

/**
 * Build the {serverUrl, code} input for httpApi.authClaim.
 *
 * Default: the box's public hostname is derived from the box ID via the shared
 * `boxDirectUrl` helper (src/shared/transport.mjs) — single source of truth
 * for the URL shape. The claim POSTs `{pairing_code}` to `<serverUrl>/auth/claim`
 * against the box's own manta-server. The Box ID is trimmed.
 *
 * BET-268 (tailnet path): when the caller supplies an explicit `serverUrl`,
 * use it verbatim (after `normalizeServerUrl`) instead of the derived
 * hostname — the box may live at a non-public listener (e.g.
 * `http://100.x.y.z:8787`) and the claim must POST there. An empty/absent
 * `serverUrl` falls through to the default `boxDirectUrl` path.
 */
export function buildSetupClaimInput(input: {
  boxId: string;
  code: string;
  serverUrl?: string;
}): { serverUrl: string; code: string } {
  const explicit = normalizeServerUrl(input.serverUrl);
  return {
    serverUrl: explicit ?? boxDirectUrl(input.boxId.trim()),
    code: input.code,
  };
}

/**
 * Resolve the server URL to persist to localStorage["manta_server"] after a
 * successful claim. Post-BET-198 every box has a public hostname
 * (`<boxId>.boxes.mantaui.com`) built by the shared `boxDirectUrl` helper, so
 * the manual-setup flow writes the same string the deep-link handler writes.
 *
 * BET-268 (tailnet path): when an explicit `serverUrl` was supplied (Advanced
 * field), persist that normalized URL instead of the derived hostname — so
 * `serverBase()` resolves to the same listener the claim just succeeded
 * against, and the next page refresh points the app at the same box.
 */
export function resolveSetupServerUrl(input: {
  boxId: string;
  serverUrl?: string;
}): string {
  const explicit = normalizeServerUrl(input.serverUrl);
  return explicit ?? boxDirectUrl(input.boxId.trim());
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
