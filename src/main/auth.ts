// auth.ts (desktop) — the onboarding pairing handshake (BET-49-T2, BET-198).
//
// The desktop onboarding shell's Step 1 (Pair) accepts a 6-digit pairing code
// plus the direct-HTTPS addressing shape (typed AuthClaimInput,
// src/shared/types.ts):
//   • serverUrl — direct-HTTPS pairing (BET-49, BET-198): POST
//     <serverUrl>/auth/claim { pairing_code } → { box_id, box_token }.
//     Persist { serverUrl, boxId, boxToken } to config.
//
// Post-BET-198 the relay is gone: every box now serves its own public
// hostname directly (https://<boxId>.boxes.mantaui.com — see
// src/shared/transport.mjs `boxDirectUrl`), so the desktop pairing flow has
// exactly ONE branch — the direct /auth/claim fetch. serverUrl is built by
// the caller (PairStep / MobileApp / deep-link) from the shared
// `boxDirectUrl(boxId)` helper, then handed to claimPairing as the
// `serverUrl` field of AuthClaimInput.
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

/**
 * Perform a pairing claim and, on success, persist the credentials to config.
 *
 * @param input    { serverUrl, code } from the renderer.
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
  const serverUrl = (input?.serverUrl ?? "").trim();

  if (serverUrl !== "") {
    return claimPairingDirect(serverUrl, code, persist, fetchImpl);
  }
  // No serverUrl → nothing to claim against.
  return networkFailure();
}

// ---- Direct-HTTPS branch (BET-49, unchanged) ----

async function claimPairingDirect(
  serverUrl: string,
  code: string,
  persist: (patch: Partial<AppConfig>) => void,
  fetchImpl: typeof fetch,
): Promise<ClaimOutcome> {
  // Trim trailing slashes so "http://box:8787/" and "http://box:8787" behave
  // identically before appending the claim path.
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
