import { isSubmittableCode } from "./claim.mjs";
import { boxDirectUrl, isValidBoxToken } from "./transport.mjs";
import { parsePairPayload } from "./pairPayload";

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
 * - When the user has typed a non-empty `serverUrl` (Advanced / Host), it
 *   must be a valid `http(s)://` URL, AND it is sufficient on its own — the
 *   Box ID becomes OPTIONAL because the claim can run against that explicit
 *   URL and backfill `box_id` from the claim response (BET-703). A malformed
 *   `serverUrl` still blocks submit (the inline error renders).
 * - When NO `serverUrl` is present (the default direct-hostname path), a
 *   valid 32-hex Box ID is still required — the box's public hostname
 *   (`https://<boxId>.boxes.mantaui.com`, see `boxDirectUrl`) is derived
 *   from it and the box is reached directly via that hostname.
 */
export function canConnectSetup(input: SetupFields): boolean {
  if (input.submitting) return false;
  if (!isSubmittableCode(input.code)) return false;
  if (input.serverUrl !== undefined && input.serverUrl.trim() !== "") {
    return normalizeServerUrl(input.serverUrl) !== null;
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

/**
 * Prefill helper for the deep-link pairing flow (BET-335; extended BET-336
 * for the optional server URL).
 *
 * PairStep lazily initializes its Box ID + code fields from this function so
 * clicking a `manta://pair?box=…&code=…` link opens the Connect screen with
 * both fields already filled — the user clicks Connect to confirm. Routing
 * through the existing screen (rather than auto-claiming) means the pair
 * page's "click Connect" copy is true.
 *
 * BET-336 (Tailscale pair link): when the link carries a `server=<url>`,
 * that URL is returned as `serverUrl` so PairStep can pre-fill the Advanced
 * "Server URL" field and open the Advanced section by default — the user
 * sees the listener they are about to pair against BEFORE clicking Connect
 * (the deep-link confirmation screen promises exactly this). The server URL
 * is the SAME `isPrivateServerUrl`-gated value `parsePairPayload` already
 * validated, so callers can pass it straight to `buildSetupClaimInput` /
 * `resolveSetupServerUrl`.
 *
 * Pure — delegates to the canonical `parsePairPayload` parser (the same one
 * App.tsx uses to validate the deep-link URL) and returns `null` for any
 * nullish/empty/invalid input. Lives here (not in the component) because
 * setupLogic is the project's home for pure pairing helpers and is already
 * covered by setupLogic.test.ts — that's what makes the behaviour testable
 * without mounting React.
 *
 * BET-373 (channel-aware wire format, review cycle 1): `scheme` defaults to
 * `"manta"` (unchanged shape for legacy callers) but MUST be passed by
 * PairStep.tsx as `channelConfig(__MANTA_CHANNEL__).urlScheme` — the same
 * constant App.tsx already uses to accept the deep-link in the first place.
 * Without it, a staging/dev pair link is accepted by App.tsx (which DOES
 * pass the channel scheme) and stored as `pendingPairLink`, but then
 * silently dropped here because the default `"manta"` scheme doesn't match
 * `manta-staging:` / `manta-dev:` — the user lands on an empty form one
 * step after the link was correctly routed.
 */
export function prefillFromPairLink(
  raw: string | null | undefined,
  scheme: string = "manta",
): { boxId: string; code: string; serverUrl?: string } | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return parsePairPayload(trimmed, scheme);
}
