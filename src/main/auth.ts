// auth.ts (desktop) — the onboarding pairing handshake (BET-49-T2, BET-198).
//
// The desktop onboarding shell's Step 1 (Pair) accepts a 6-digit pairing code
// plus the direct-HTTPS addressing shape (typed AuthClaimInput,
// src/shared/types.ts):
//   • serverUrl — direct-HTTPS pairing (BET-49): POST <serverUrl>/auth/claim
//     { pairing_code } → { box_id, box_token }.
//     Persist { serverUrl, boxId, boxToken } to config.
//   • boxId — box-form pair link (BET-156, BET-198): a box-form
//     `manta://pair?box=<boxId>&code=<code>` QR (or its paste equivalent) sets
//     `boxId` + empty `serverUrl`. Main resolves the box's public hostname
//     via `boxDirectUrl(boxId)` (src/shared/transport.mjs) and POSTs
//     `/auth/claim` against it. Persisted `serverUrl` is the SAME
//     `boxDirectUrl(boxId)` string the mobile deep-link handler writes.
//
// Every box serves its own public hostname directly. Both input shapes route
// through the SAME `claimPairingDirect` fetch; `claimPairing` is a thin
// dispatcher that builds the URL from whichever input field is populated.
//
// Why main (not the renderer) does the fetch: only main can write
// config.json. The mobile client authenticates with a localStorage Bearer
// token instead, so it claims in the renderer (renderer/api/httpApi
// submitPairingCode). Same wire contract, different persistence — hence
// the shared classifier keeps the two entry points from drifting.

import {
  classifyClaimResult,
  networkFailure,
} from "../shared/claim.mjs";
import type { ClaimOutcome } from "../shared/claim.mjs";
import type { AppConfig, AuthClaimInput } from "../shared/types.js";
import { boxDirectUrl } from "../shared/transport.mjs";

/**
 * Perform a pairing claim and, on success, persist the credentials to config.
 *
 * @param input    { serverUrl, boxId?, code } from the renderer. The mobile/web
 *                 client only ever supplies `serverUrl` (already-built by the
 *                 caller's `boxDirectUrl(boxId)` for the box form, see
 *                 src/renderer/mobile/setupLogic.ts); the desktop onboarding
 *                 paste-pair-link path may supply either `serverUrl` (direct
 *                 form) or `boxId` (box form). Exactly one of the two is
 *                 consumed.
 * @param persist  commit a config patch (main's `commit`); called ONLY on a
 *                 successful, token-validated claim.
 * @param fetchImpl  injectable for tests; defaults to the global fetch.
 * @returns the classified {@link ClaimOutcome}. A wrong/expired code, a rate
 *          limit, an unreachable server, etc. are all normal `{ ok:false }`
 *          results — this never throws for an expected auth failure.
 */
export async function claimPairing(
  input: AuthClaimInput,
  persist: (patch: Partial<AppConfig>) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const code = input?.code ?? "";
  const typedServerUrl = (input?.serverUrl ?? "").trim();
  const boxId = (input?.boxId ?? "").trim();

  // Resolve the claim URL: explicit serverUrl wins; otherwise build the box's
  // public hostname from the boxId. A malformed boxId (not 32-hex) throws here
  // — map to a network-classified failure so the UI surfaces the same error
  // shape as an unreachable host.
  let serverUrl = typedServerUrl;
  if (serverUrl === "" && boxId !== "") {
    try {
      serverUrl = boxDirectUrl(boxId);
    } catch {
      return networkFailure();
    }
  }
  if (serverUrl === "") {
    return networkFailure();
  }
  return claimPairingDirect(serverUrl, code, persist, fetchImpl);
}

// ---- Direct-HTTPS branch (BET-49, BET-198) ----

async function claimPairingDirect(
  serverUrl: string,
  code: string,
  persist: (patch: Partial<AppConfig>) => void,
  fetchImpl: typeof fetch,
): Promise<ClaimOutcome> {
  // Trim trailing slashes so "http://box:8787/" and "http://box:8787" behave
  // identically before appending the claim path. boxDirectUrl already
  // produces a no-trailing-slash URL, so the box form is a no-op here.
  const url = `${serverUrl.replace(/\/+$/, "")}/auth/claim`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: code }),
    });
  } catch {
    // fetch rejected (offline / DNS / TLS / malformed URL) — no HTTP response.
    return networkFailure();
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body (proxy / HTML error page) — leave null; classify by status */
  }

  const outcome = classifyClaimResult(res.status, body);
  if (outcome.ok) {
    // Single persistence site: serverUrl (where to reach the box) + the two
    // credentials. Presence of a valid boxToken is what flips transport to
    // "http" (see src/shared/transport.mjs resolveTransportMode).
    persist({
      serverUrl: serverUrl.replace(/\/+$/, ""),
      boxId: outcome.boxId,
      boxToken: outcome.boxToken,
    });
  }
  return outcome;
}
