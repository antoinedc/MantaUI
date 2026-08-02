// deepLink.ts — native Capacitor deep-link handler for `manta://pair?…` URLs.
//
// Post-BET-198, phones connect DIRECTLY to https://<box_id>.boxes.mantaui.com
// (Caddy on the box reverse-proxies 127.0.0.1:8787). The only live pair
// payload shape is the box form `manta://pair?box=<box_id>&code=<6-digit>`,
// optionally with a `server=<url>` for the Tailscale path (BET-336) — when
// present, the link-supplied URL must be a private/tailnet address (gated by
// `isPrivateServerUrl` in parsePairPayload) and is used verbatim for both
// the claim and the persisted listener, so a Tailscale box with no public
// hostname can still ship a working one-click / QR pair link.
//
// Phase 2 of BET-177: the iOS app registers the `manta://` custom scheme (see
// Info.plist's CFBundleURLTypes + AndroidManifest.xml's intent-filter); the
// desktop Settings QR and the `manta pair` terminal QR both emit
// `manta://pair?box=<id>&code=<6-digit>`. When the user scans the QR with
// the iOS Camera, iOS opens the manta app via this scheme; the Capacitor App
// plugin delivers the URL to the renderer via
//   • `getLaunchUrl()` — the URL the app was COLD-STARTED with
//   • `appUrlOpen` event — URLs delivered while the app is already RUNNING
//
// This module owns the wiring in TWO halves:
//   1. `getCapacitorApp(win)` — feature-detects the Capacitor bridge. The
//      renderer bundle is shared with desktop Electron + the frozen web
//      client; the bridge is only present on the native shell. Returns null
//      on every other context (the caller no-ops).
//   2. `handlePairUrl(raw, deps)` — pure dispatch: parses the raw URL with
//      the shared `parsePairPayload`, claims via injected `authClaim`, and
//      persists the server URL via injected `persistServer`. Returns a typed
//      outcome ("paired" | "ignored" | "failed") so the caller can decide
//      what to do — the pair URL may be a foreign URL (returns "ignored"
//      with no side effects), or a foreign host (e.g. https://…/m/?box=…&code=…,
//      same parsing rules), or a malformed pair payload (also "ignored").
//
// Dep injection keeps handlePairUrl unit-testable without DOM / fetch / the
// Capacitor bridge — see deepLink.test.ts beside this file.

import { parsePairPayload } from "../../shared/pairPayload";
import {
  buildSetupClaimInput,
  resolveSetupServerUrl,
} from "../../shared/setupLogic";
import type { ClaimOutcome } from "../../shared/claim.mjs";
import { dlog } from "./debugLog";

// The shape the Capacitor App plugin exposes — feature-detected by reading
// window.Capacitor?.Plugins?.App. Kept intentionally minimal: we only touch
// addListener + getLaunchUrl. Documented here because @capacitor/app ships
// its own .d.ts but we deliberately don't add it to the root package.json
// (the bundle ships to desktop + PWA where it would be dead weight).
//
// `appStateChange` is consumed by BET-177 §4 lifecycle hardening (MobileApp
// focus reporting + resume reconnect). Typed here so the renderer side
// stays typecheck-clean without taking a hard runtime dependency on
// @capacitor/app's d.ts.
//
// Interface (not type alias) so `addListener` can be overloaded across the
// two event-name signatures — same pattern as nativePush.ts's
// PushNotificationsPlugin.
export interface CapacitorAppPlugin {
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { url: string }) => void,
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
  addListener(
    eventName: "appStateChange",
    listener: (event: { isActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
  getLaunchUrl(): Promise<{ url?: string } | null | undefined>;
}

/**
 * Feature-detect the Capacitor App plugin on a window-like object. Returns
 * the plugin handle when present, null otherwise. `win` is the renderer's
 * `window` at the call site; tests pass a plain object shaped like
 * `{ Capacitor?: { Plugins?: { App?: CapacitorAppPlugin } } }`.
 */
export function getCapacitorApp(
  win: unknown,
): CapacitorAppPlugin | null {
  const cap = (win as { Capacitor?: { Plugins?: { App?: unknown } } } | null | undefined)?.Capacitor;
  const plugin = cap?.Plugins?.App;
  if (!plugin || typeof plugin !== "object") return null;
  const p = plugin as Partial<CapacitorAppPlugin>;
  if (typeof p.addListener !== "function" || typeof p.getLaunchUrl !== "function") {
    return null;
  }
  return p as CapacitorAppPlugin;
}

/** Outcome of a deep-link pair URL — drives the caller branch. */
export type DeepLinkOutcome = "paired" | "ignored" | "failed";

/** Dependencies for handlePairUrl — injected so tests don't need DOM/fetch. */
export type DeepLinkDeps = {
  /** httpApi.authClaim (or a stub). Receives the same AuthClaimInput the
   *  mobile pairing screen feeds in. */
  authClaim: (input: {
    serverUrl: string;
    code: string;
    verify?: string;
  }) => Promise<ClaimOutcome>;
  /** Persist the resolved server URL to localStorage["manta_server"]. Called
   *  AFTER a successful claim — the URL is whatever `resolveSetupServerUrl`
   *  returned for the parsed payload: the link-supplied `serverUrl` when
   *  present (BET-336, Tailscale path) or the shared public hostname
   *  `https://<boxId>.boxes.mantaui.com` otherwise. The deep-link handler is
   *  the only caller that needs this — direct pairing flows (PairingScreen /
   *  SetupScreen) persist serverUrl directly because the user already typed
   *  it. */
  persistServer: (serverUrl: string) => void;
};

/**
 * Resolve a raw deep-link URL into a paired/ignored/failed outcome. Pure +
 * injectable: tests assert on the deps, not on DOM/fetch/Capacitor.
 *
 * - `raw` is the URL the OS handed the app (cold-start `getLaunchUrl()` or
 *   warm `appUrlOpen` payload).
 * - Foreign URLs (any non-manta scheme, or a manta:// URL that fails
 *   parsePairPayload) → "ignored" — no claim is attempted, no localStorage
 *   write happens.
 * - A box-form pair URL → claim with the SHARED
 *   `buildSetupClaimInput({boxId, code, serverUrl: payload.serverUrl})`
 *   helper (the same one the desktop PairStep and the mobile setup screen
 *   use). When the payload carries a `serverUrl` (BET-336 — Tailscale pair
 *   link), that URL is used verbatim for both the claim AND the persisted
 *   listener so the post-claim refresh points at the same box the claim
 *   just succeeded against. With no `serverUrl`, the helper falls through
 *   to the public hostname (`https://<boxId>.boxes.mantaui.com`).
 */
export async function handlePairUrl(
  raw: string,
  deps: DeepLinkDeps,
): Promise<DeepLinkOutcome> {
  const payload = parsePairPayload(raw);
  if (!payload) {
    dlog("[deeplink] parse: not a valid pair payload (ignored)");
    return "ignored";
  }
  dlog(
    payload.serverUrl
      ? `[deeplink] parsed: box=${payload.boxId.slice(0, 8)}… server=${payload.serverUrl} code=${payload.code}`
      : `[deeplink] parsed: box=${payload.boxId.slice(0, 8)}… (direct) code=${payload.code}`,
  );

  const claimInput = buildSetupClaimInput({
    boxId: payload.boxId,
    code: payload.code,
    serverUrl: payload.serverUrl,
    verify: payload.verify,
  });
  let outcome: ClaimOutcome;
  try {
    outcome = await deps.authClaim(claimInput);
  } catch (e) {
    // authClaim should never throw on the shared classifiers — they return
    // ClaimOutcome for every failure kind — but defend against a buggy impl.
    dlog(`[deeplink] claim threw: ${String(e)}`);
    return "failed";
  }
  if (!outcome.ok) {
    // Surface the classified failure reason (wrong_code / rate_limited /
    // network / server_error) — THIS is the line that tells us why pairing
    // failed on-device.
    dlog(`[deeplink] claim FAILED: ${(outcome as { kind?: string }).kind ?? "unknown"} — ${(outcome as { message?: string }).message ?? ""}`);
    return "failed";
  }
  dlog("[deeplink] claim OK; persisting server URL");

  // Successful claim. Persist the resolved server URL to localStorage so the
  // next serverBase() call resolves correctly and doRefresh() finds the
  // bootstrap data path. The token is persisted by authClaim itself (single
  // write-site in httpApi.saveClientToken). `resolveSetupServerUrl` honours
  // the link-supplied `serverUrl` (BET-336) and otherwise falls through to
  // the public hostname — same call site the desktop PairStep + manual
  // mobile setup use, so all three flows write the EXACT same string.
  const serverUrl = resolveSetupServerUrl({
    boxId: payload.boxId,
    serverUrl: payload.serverUrl,
  });
  deps.persistServer(serverUrl);
  return "paired";
}
