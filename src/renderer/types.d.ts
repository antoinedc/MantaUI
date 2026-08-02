import type { Api } from "../shared/api";
import type { MantaPreload } from "./preloadAccess";

declare global {
  interface Window {
    api: Api;
    __mantaPreload: MantaPreload | null;
    // BET-560 — demo-only stepped-stream handle, installed ONLY in the
    // `?demo&desktop&state=stream` fixture state by demoApi. Absent in every
    // other state and in every production path (the demo transport is only
    // ever loaded by bootDemo). The visual harness reads `pending`/`served`
    // to wait out the assembler's splice debounce and drives `advance()` to
    // move the transcript between the early/mid/late phase captures.
    __mantaDemoStream?: {
      steps: number;
      phase: string;
      advance: () => void;
      pending: boolean;
      served: boolean;
      // BET-553 §17 — most recent first-token→rendered measurement per path
      // (see firstTokenLatency.ts), exposed so a probe / harness can reproduce
      // and quote the latency numbers the demo actually produced.
      latency: { interpreted: number | null; raw: number | null };
    };
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
