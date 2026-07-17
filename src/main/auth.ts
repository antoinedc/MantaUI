// auth.ts (desktop) — the onboarding pairing handshake (BET-49-T2, BET-156).
//
// The desktop onboarding shell's Step 1 (Pair) accepts a 6-digit pairing code
// plus ONE OF two addressing shapes (typed AuthClaimInput, src/shared/types.ts):
//   • serverUrl — direct-HTTPS pairing (BET-49): POST <serverUrl>/auth/claim
//     { pairing_code } → { box_id, box_token }. Persist
//     { serverUrl, boxId, boxToken } to config.
//   • boxId — relay-paired pairing (BET-156, ADR-2/3): POST
//     https://relay.mantaui.com/pair { box_id, code } →
//     { box_id, account_id, account_token }. Persist
//     { serverUrl: "<RELAY_BASE>/box/<box_id>", boxId, boxToken:
//     account_token }. From that point on EVERYTHING downstream (httpApi base,
//     Bearer header, /events EventSource ?token=, uploads) works untouched
//     because the relay's /box/:box_id/* proxy makes the box's HTTP surface
//     appear under that prefix — ADR-3, no httpApi edits.
//
// Both flows route through the SAME `claimPairing` function (no `*V2`, no
// parallel copies). The branch is INSIDE this function, keyed by which input
// field is populated. Outcome classification reuses the shared helper in
// src/shared/claim.mjs (the same one the mobile client and pure tests use).
//
// Why main (not the renderer) does the fetch: only main can write config.json.
// The mobile client authenticates with a localStorage Bearer token instead, so
// it claims in the renderer (renderer/api/httpApi submitPairingCode). Same wire
// contract, different persistence — hence the shared classifier keeps the two
// entry points from drifting.

import {
  classifyClaimResult,
  classifyRelayClaimResult,
  networkFailure,
} from "../shared/claim.mjs";
import type { ClaimOutcome } from "../shared/claim.mjs";
import type { AppConfig, AuthClaimInput } from "../shared/types.js";
import { isValidToken } from "../server/webhooks.mjs";

// The single relay base URL every relay-mode desktop pairs through. Hardcoded
// per BET-156 (ADR-3) so a desktop user doesn't need to know or type the
// relay hostname — they paste the pair link (manta://pair?box=…&code=…) which
// only carries the box id. `MANTA_RELAY_BASE` is an env override used by tests
// (and any future staging ring) — not a user-facing knob.
export const RELAY_BASE = "https://relay.mantaui.com";

function relayBase() {
  return process.env.MANTA_RELAY_BASE || RELAY_BASE;
}

/**
 * Perform a pairing claim and, on success, persist the credentials to config.
 *
 * @param input    { serverUrl?, boxId?, code } from the renderer.
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
  const boxId = (input?.boxId ?? "").trim();

  // Branch routing: when the caller passes a boxId, take the relay path even
  // if they ALSO passed a (necessarily empty) serverUrl — see AuthClaimInput.
  // We treat "non-empty boxId" as the sole signal because the desktop PairStep
  // is the only caller that uses the box form, and it always sends serverUrl=""
  // in that case. A non-empty serverUrl + non-empty boxId is a caller invariant
  // violation (UI never sends both) → network failure.
  if (boxId !== "") {
    return claimPairingRelay(boxId, code, persist, fetchImpl);
  }
  if (serverUrl !== "") {
    return claimPairingDirect(serverUrl, code, persist, fetchImpl);
  }
  // Neither present → nothing to claim against.
  return networkFailure();
}

// ---- Direct-HTTPS branch (legacy BET-49 behavior, unchanged) ----

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

// ---- Relay branch (BET-156 / ADR-3) ----

/**
 * POST `${RELAY_BASE}/pair { box_id, code }` and, on 200, persist the relay-
 * shaped triple (the box's HTTP surface appears under `<RELAY_BASE>/box/<id>`
 * from the desktop's point of view). The relay is responsible for:
 *   1. rate-limiting unauthenticated /pair (its own createRateLimiter),
 *   2. forwarding the claim to the box's live tunnel (`/auth/claim`),
 *   3. minting an account_token (the desktop's "boxToken" slot) and binding it
 *      to the box.
 * The desktop never sees the box's box_token (ADR-1) — only the relay-minted
 * account_token, presented as `Authorization: Bearer <boxToken>` to the
 * relay. From httpApi's perspective the URL is just `serverUrl + subpath` —
 * no httpApi changes required.
 */
async function claimPairingRelay(
  boxId: string,
  code: string,
  persist: (patch: Partial<AppConfig>) => void,
  fetchImpl: typeof fetch,
): Promise<ClaimOutcome> {
  // Shape-gate the box_id before we spend a round-trip. isValidToken is the
  // canonical 32-hex check (same one the relay handshake uses); a malformed id
  // is a network failure from the desktop's POV (the UI prompts to re-paste).
  if (!isValidToken(boxId)) return networkFailure();

  const base = relayBase();
  const url = `${base.replace(/\/+$/, "")}/pair`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ box_id: boxId, code }),
    });
  } catch {
    return networkFailure();
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* leave null; classify by status */
  }

  // We classify a /pair response with the SAME ClaimOutcome shape the direct
  // branch returns so the renderer can keep one error-handling path. The relay
  // returns the same failure semantics (400/403/429/5xx) as the box's own
  // /auth/claim; classifyRelayClaimResult collapses both 400/403 into
  // `wrong_code` and 5xx into `server_error` — exactly what we want. The only
  // difference vs the direct branch is the 200 body parser (account_token
  // vs box_token field name) — see claim.mjs.
  const outcome = classifyRelayClaimResult(res.status, body);
  if (outcome.ok) {
    // Persist the relay-shaped triple. serverUrl is the relay's per-box proxy
    // prefix so every downstream /rpc + /events + upload call naturally lands
    // on `/box/<box_id>/*` — ADR-3, zero new data-path code.
    persist({
      serverUrl: `${base.replace(/\/+$/, "")}/box/${boxId}`,
      boxId,
      boxToken: outcome.boxToken,
    });
  }
  return outcome;
}
