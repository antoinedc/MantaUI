// pairClaim.ts — single source of truth for turning a { boxId, code } pair
// into a paired desktop session (BET-255).
//
// Replaces the two divergent claim+persist+seed paths that used to live in
// PairStep.tsx (link-wins branch + server-URL branch) and the now-removed
// PairStep pair-link prefill. Both call sites use this helper so the desktop
// has exactly ONE code path from "I have a box id + code" to "I'm paired":
//
//   • PairStep.tsx          — Connect button (manual Box ID + 6-digit code)
//   • App.tsx onPairLink    — OS protocol handler, fires on
//                             `manta://pair?box=…&code=…` click; auto-claims
//                             without a manual Connect click
//
// The helper is intentionally non-pure (it touches window.api, the store,
// and the httpApi transport swap), but the parts that ARE pure (claim input
// shape, persisted server URL) live in renderer/mobile/setupLogic.ts and are
// already tested in setupLogic.test.ts — single source of truth reused here.
//
// Side effects on success:
//   1. `useStore.getState().applyPairing({ serverUrl, boxId, boxToken })`
//      — mirrors main's persisted config.json into the renderer store so
//      resolveTransportMode() reads "http" immediately (BET-49-T2).
//   2. `installHttpTransport(seed)` — seeds localStorage + swaps window.api
//      to httpApi so the next onboarding step (Providers/Model) reaches the
//      box in the same session (BET-254).
// On failure: returns the classified ClaimOutcome; no store/transport
// mutation happens — the caller shows the error and stays where it was.

import { useStore } from "./store";
import {
  buildSetupClaimInput,
  resolveSetupServerUrl,
} from "./mobile/setupLogic";
import { desktopHttpClientSeed } from "../shared/transport.mjs";
import { installHttpTransport } from "./transportInstall";
import { networkFailure, type ClaimOutcome } from "../shared/claim.mjs";

/**
 * Claim a box by its 32-hex boxId + 6-digit pairing code. On success
 * persists + swaps the transport; on failure returns the classified outcome.
 *
 * @param input.boxId  32-hex box id (validated by canConnectSetup upstream)
 * @param input.code   6-digit pairing code (validated by canConnectSetup upstream)
 * @returns the ClaimOutcome from `window.api.authClaim` — never throws for an
 *          expected auth failure (network / wrong code / rate limited).
 */
export async function claimBox(input: {
  boxId: string;
  code: string;
}): Promise<ClaimOutcome> {
  // Box-form claim input — `serverUrl` is the resolved direct hostname
  // (https://<boxId>.boxes.mantaui.com). Main's claimPairing dispatcher
  // accepts either the resolved URL or the empty + boxId shape; using the
  // pre-resolved URL mirrors the mobile client (renderer/mobile/
  // setupLogic.buildSetupClaimInput) and keeps `boxDirectUrl` as the single
  // source of truth for the URL shape.
  const claimInput = buildSetupClaimInput({ boxId: input.boxId, code: input.code });

  let result: ClaimOutcome;
  try {
    result = await window.api.authClaim(claimInput);
  } catch {
    // Defensive: authClaim should never throw on the shared classifiers
    // (returns ClaimOutcome for every failure kind), but a buggy IPC or
    // preload swap could. Map to a network failure so the caller shows the
    // same error shape as an unreachable host.
    return networkFailure();
  }
  if (!result.ok) return result;

  // Success: persist + transport swap.
  const persistedServerUrl = resolveSetupServerUrl({ boxId: input.boxId });
  useStore.getState().applyPairing({
    serverUrl: persistedServerUrl,
    boxId: result.boxId,
    boxToken: result.boxToken,
  });
  const seed = desktopHttpClientSeed({
    serverUrl: persistedServerUrl,
    boxToken: result.boxToken,
  });
  if (seed) installHttpTransport(seed);
  return result;
}
