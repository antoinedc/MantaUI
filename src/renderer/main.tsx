import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import "./index.css";
import "./mobile/mobile.css";
import { httpApi } from "./api/httpApi";
import type { Api } from "../preload/index";
import {
  selectDesktopTransport,
  desktopHttpClientSeed,
} from "../shared/transport.mjs";

// Transport selection at renderer entry (BET-58):
//
//  1. NO preload (window.api absent) → mobile/web build. Install the httpApi
//     shim and render the mobile-native <MobileApp/>. (Unchanged.)
//
//  2. Preload present (Electron desktop) → the config mode decides:
//       • SSH / onboarding / skipped → keep the preload bridge as window.api
//         (legacy SSH+tmux transport). SSH users are completely unaffected.
//       • "http" (paired to a bui-server) → talk to that server over the SAME
//         httpApi client the mobile build uses (Bearer token, /rpc, /events WS)
//         INSTEAD of the SSH bridge. We keep the real preload available as
//         window.__buiPreload so Electron-LOCAL affordances (clipboard, reveal-
//         in-folder, OS notifications) still work — the split is: data/tmux/
//         opencode go over http; OS-integration stays on the preload.
//
// Reading config requires the preload's async configGet(), so entry is async.
// We render the desktop <App/> only after the transport is chosen, so no
// component ever observes a half-installed window.api.

// The genuine Electron preload bridge is exposed by src/preload/index.ts under
// `__buiPreload` (a read-only contextBridge property). We NEVER write to that
// name; instead we install our own writable `window.api` below, so http mode
// can swap it for the httpApi client. On the mobile/web build there is no
// preload at all → `__buiPreload` is undefined → mobile path.
const preload = (window as unknown as { __buiPreload?: Api }).__buiPreload;
const isMobile = !preload;

// Install `window.api` as a WRITABLE, configurable property. contextBridge
// properties are read-only, which is why main.tsx (not the preload) owns
// `window.api` — this makes the http-mode swap at boot a legal assignment
// rather than a "Cannot assign to read only property 'api'" TypeError.
function setWindowApi(next: unknown): void {
  Object.defineProperty(window, "api", {
    value: next,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

async function chooseDesktopTransport(realPreload: Api): Promise<void> {
  // Read the persisted config to learn the transport mode. A failure here
  // (IPC error) must NOT white-screen the app — fall back to the preload
  // bridge (the legacy, always-available transport).
  let mode: "http" | "preload" = "preload";
  let config: Awaited<ReturnType<Api["configGet"]>> | null = null;
  try {
    config = await realPreload.configGet();
    mode = selectDesktopTransport(config, true);
  } catch (e) {
    console.warn("[bui] configGet failed at entry; using preload transport:", e);
    mode = "preload";
  }

  if (mode === "http" && config) {
    const seed = desktopHttpClientSeed(config);
    if (seed) {
      // Seed the two localStorage keys httpApi reads for its base URL + token.
      let seeded = true;
      try {
        localStorage.setItem("bui_server", seed.bui_server);
        localStorage.setItem("bui_token", seed.bui_token);
      } catch (e) {
        // localStorage unavailable is fatal for http mode (httpApi can't read
        // its base) — fall back to preload rather than a 401-looping client.
        // Do NOT return here: chooseDesktopTransport must fall through so boot()
        // still renders. We simply leave window.api as the preload bridge by
        // skipping the httpApi swap below.
        console.warn("[bui] localStorage seed failed; using preload transport:", e);
        seeded = false;
      }
      if (seeded) {
        // The real preload already lives at window.__buiPreload (contextBridge)
        // for Electron-local affordances (clipboard, reveal, OS notifications).
        // Install httpApi as the primary window.api.
        setWindowApi(httpApi);
      }
    }
    // If seed is null the config claimed http mode but lacks a usable
    // serverUrl/token — leave the preload bridge in place (safer than a broken
    // http client). resolveTransportMode won't report "http" without a valid
    // boxToken, so this is a defensive belt-and-braces branch.
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
  } else {
    // Mobile/web: install the shim (no preload to preserve).
    setWindowApi(httpApi);
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
  );
}

void boot();
