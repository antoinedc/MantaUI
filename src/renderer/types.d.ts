import type { Api } from "../shared/api";
import type { MantaPreload } from "./preloadAccess";

declare global {
  interface Window {
    api: Api;
    __mantaPreload: MantaPreload | null;
  }
  // Build-time injected Axiom credentials (electron.vite.config.ts +
  // electron.vite.config.mobile.ts `define`). Empty string → shipping is
  // silently disabled by resolveAxiomConfig. Mobile always ships when a
  // token is present; desktop additionally honors AppConfig.shareAnalytics.
  const __MANTA_AXIOM_TOKEN__: string;
  const __MANTA_AXIOM_DATASET__: string;
  // Build-time injected app version (mirror of package.json#version at the
  // time of `npm run build`). Used by httpApi.getClientVersion as the
  // fallback when there's no Electron preload to call app.getVersion()
  // (mobile/web). On desktop httpApi prefers the live Electron value, so
  // this constant only matters on the no-preload code path. Bumping the
  // package.json version automatically propagates to every renderer build
  // at the next build run.
  const __APP_VERSION__: string;
  // Build-time injected channel id (BET-370 + BET-373). Same source as the
  // main-process baking (electron.vite.config.ts main `define`) — both the
  // renderer + main resolve to the same per-channel URL scheme via
  // `channelConfig(__MANTA_CHANNEL__).urlScheme` (src/shared/channel.mjs).
  // The renderer reads this so the desktop's pair-link QR (PairingQR.tsx)
  // + deep-link parse (App.tsx) pick up the channel's OS-registered scheme
  // instead of a hardcoded `manta://`. Mobile bakes "prod" for now (mobile
  // has no channel concept yet — out of scope per BET-373).
  const __MANTA_CHANNEL__: string;
}

export {};
