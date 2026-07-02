// auth.ts (desktop) — the onboarding pairing handshake (BET-49-T2).
//
// The desktop onboarding shell's Step 1 (Pair) sends a 6-digit pairing code +
// the target server URL over the `auth:claim` IPC channel. This module owns the
// main-process half: POST <serverUrl>/auth/claim, classify the outcome with the
// SHARED classifier (src/shared/claim.mjs — the same one the mobile client and
// the pure tests use), and on success persist { serverUrl, boxId, boxToken } to
// config so resolveTransportMode flips the app into "http" mode on next read.
//
// Why main (not the renderer) does the fetch: only main can write config.json.
// The mobile client authenticates with a localStorage Bearer token instead, so
// it claims in the renderer (renderer/api/httpApi submitPairingCode). Same wire
// contract, different persistence — hence the shared classifier keeps the two
// entry points from drifting.

import { classifyClaimResult, networkFailure } from "../shared/claim.mjs";
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
  const serverUrl = (input?.serverUrl ?? "").trim();
  const code = input?.code ?? "";

  // An empty / whitespace-only URL can't be fetched — surface it as a network
  // failure (the UI shows the URL for correction) rather than throwing.
  if (serverUrl === "") return networkFailure();

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
