import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";
import { initRendererLogging } from "./log";
import type { Api } from "../shared/api";
import { desktopHttpClientSeed } from "../shared/transport.mjs";
import { installHttpTransport, setWindowApi } from "./transportInstall";

// Transport selection at renderer entry (BET-82):
//
//  1. NO preload (window.api absent) → mobile/web build. Install the httpApi
//     shim and render the mobile-native <MobileApp/>. (Unchanged.)
//
//  2. Preload present (Electron desktop) → always install httpApi as
//     window.api (SSH main path gone). We keep the real preload available as
//     window.__mantaPreload so Electron-LOCAL affordances (clipboard, reveal-
//     in-folder, OS notifications) still work — the split is: data/tmux/
//     opencode go over http; OS-integration stays on the preload.
//
// Reading config requires the preload's async configGet(), so entry is async.
// We render the desktop <App/> only after the transport is chosen, so no
// component ever observes a half-installed window.api.

// The genuine Electron preload bridge is exposed by src/preload/index.ts under
// `__mantaPreload` (a read-only contextBridge property). We NEVER write to that
// name; instead we install our own writable `window.api` below, so http mode
// can swap it for the httpApi client. On the mobile/web build there is no
// preload at all → `__mantaPreload` is undefined → mobile path.
const preload = (window as unknown as { __mantaPreload?: Api }).__mantaPreload;
const isMobile = !preload;

async function chooseDesktopTransport(realPreload: Api): Promise<void> {
  // Desktop always uses httpApi (BET-82: SSH main path gone).
  // The real preload already lives at window.__mantaPreload (exposed read-only by
  // the preload's contextBridge) — we NEVER write to that name. Here we only
  // decide whether to swap the primary window.api over to httpApi.

  // Try to seed localStorage with paired credentials so httpApi has a base
  // URL + token. Non-fatal if configGet fails or seed is null — window.api
  // stays on the preload bridge and will show "Not configured" until pairing
  // completes.
  try {
    const config = await realPreload.configGet();
    const seed = desktopHttpClientSeed(config);
    if (seed) {
      // Sole transport-install path (BET-254) — also called from PairStep on
      // first-time pairing so the next onboarding step can use httpApi in the
      // SAME session. On localStorage failure it falls back to the preload
      // bridge (window.api stays as-is).
      installHttpTransport(seed);
    }
  } catch (e) {
    console.warn("[bui] configGet failed at entry:", e);
  }
}

async function boot(): Promise<void> {
  if (!isMobile && preload) {
    // Desktop: default window.api to the real preload bridge, then let the
    // transport chooser swap it to httpApi if the config is paired (http mode).
    // Because `window.api` is now main-owned (not the contextBridge property),
    // this default install + the http-mode swap are both legal assignments.
    setWindowApi(preload);
    await chooseDesktopTransport(preload);
    // chooseDesktopTransport already assigned window.__mantaPreload.
    // Initialize renderer logging AFTER window.api is wired so configGet
    // works — but BEFORE React mounts so early-render errors still ship.
    // Fire-and-forget; initRendererLogging is no-op when no token is set.
    void initRendererLogging("desktop");
  } else {
    // Mobile/web: install the shim (no preload to preserve).
    setWindowApi(httpApi);
    // Mobile reads config (and thus shareAnalytics) via the same httpApi
    // configGet; no MobileSettings UI per the spec — preference is set
    // once on desktop. Mobile always ships regardless.
    void initRendererLogging("mobile");
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
  );
}

void boot();
