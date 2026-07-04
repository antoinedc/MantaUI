import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";
import type { Api } from "../preload/index";
import {
  desktopHttpClientSeed,
} from "../shared/transport.mjs";

// Transport selection at renderer entry (BET-82):
//
//  1. NO preload (window.api absent) → mobile/web build. Install the httpApi
//     shim and render the mobile-native <MobileApp/>. (Unchanged.)
//
//  2. Preload present (Electron desktop) → always install httpApi as
//     window.api (SSH main path gone). We keep the real preload available as
//     window.__buiPreload so Electron-LOCAL affordances (clipboard, reveal-
//     in-folder, OS notifications) still work — the split is: data/tmux/
//     opencode go over http; OS-integration stays on the preload.
//
// Reading config requires the preload's async configGet(), so entry is async.
// We render the desktop <App/> only after the transport is chosen, so no
// component ever observes a half-installed window.api.

const preload = (window as unknown as { api?: Api }).api;
const isMobile = !preload;

async function chooseDesktopTransport(realPreload: Api): Promise<void> {
  // Desktop always uses httpApi (BET-82: SSH main path gone).
  // Preserve the real preload for Electron-local affordances, then install
  // httpApi as the primary window.api.
  window.__buiPreload = realPreload as unknown as NonNullable<
    typeof window.__buiPreload
  >;
  (window as unknown as { api: Api }).api = httpApi as unknown as Api;

  // Try to seed localStorage with paired credentials so httpApi has a base
  // URL + token. Non-fatal if configGet fails or seed is null — httpApi is
  // already installed and will show "Not configured" until pairing completes.
  try {
    const config = await realPreload.configGet();
    const seed = desktopHttpClientSeed(config);
    if (seed) {
      localStorage.setItem("bui_server", seed.bui_server);
      localStorage.setItem("bui_token", seed.bui_token);
    }
  } catch (e) {
    console.warn("[bui] configGet failed at entry:", e);
  }
}

async function boot(): Promise<void> {
  if (!isMobile && preload) {
    await chooseDesktopTransport(preload);
    // chooseDesktopTransport already assigned window.__buiPreload.
  } else {
    // Mobile/web: install the shim (no preload to preserve).
    (window as unknown as { api: unknown }).api = httpApi;
    window.__buiPreload = null;
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
  );
}

void boot();
