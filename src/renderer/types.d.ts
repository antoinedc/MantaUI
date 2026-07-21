import type { Api } from "../shared/api";
import type { BuiPreload } from "./preloadAccess";

declare global {
  interface Window {
    api: Api;
    __buiPreload: BuiPreload | null;
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
}

export {};
