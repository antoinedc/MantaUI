import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// BET-413: self-host the two typefaces. Both are bundled by Vite (same-origin),
// so no CSP change is needed — the CSP in index.html blocks remote fonts, and
// these never leave our origin. Inter Variable for language (sans default),
// JetBrains Mono Variable for code/paths/IDs/timers/diffs.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import type { Api } from "../shared/api";
import { initRendererLogging } from "./log";
import { desktopHttpClientSeed } from "../shared/transport.mjs";
import { installHttpTransport, setWindowApi } from "./transportInstall";
import { applyTheme } from "./theme";
import { pinDemoClock } from "./clock";
import { loadPersistedSnapshot } from "./store";

// Demo mode (BET-302): `?demo` in the URL swaps the real httpApi for a
// fixture-backed transport and skips pairing / config / credential logic
// entirely — the renderer renders the full desktop UI from a fictional
// state with zero network calls. Dynamic-imported so the production bundle
// doesn't carry the demo fixture (verified at PR-time by checking
// out/renderer/ chunk sizes before/after).
//
// `?demo` parses the URL before any transport selection and installs the
// demoApi via the same transportInstall seam. BET-559: the renderer is
// desktop-only, so `?demo` always renders <App/> — the old mobile-shell
// override that could force <MobileApp/> (BET-302) is gone with it.
//
// Reading config requires the preload's async configGet(), so entry is async.
// We render the desktop <App/> only after the transport is chosen, so no
// component ever observes a half-installed window.api.

// The genuine Electron preload bridge is exposed by src/preload/index.ts under
// `__mantaPreload` (a read-only contextBridge property). We NEVER write to that
// name; instead we install our own writable `window.api` below, so http mode
// can swap it for the httpApi client.
//
// BET-559: the renderer is the DESKTOP app only. The mobile web client (the
// shell that used to branch on `!preload`) is retired — a browser without a
// preload is now only reachable through `?demo` for the visual gates and
// marketing shots, which never run the real boot path.
const preload = (window as unknown as { __mantaPreload?: Api }).__mantaPreload;

// Demo mode (BET-302): parsed once at module load so the demo branch is
// reachable from inside boot() without re-parsing the URL.
const isDemoMode = new URLSearchParams(window.location.search).has("demo");

async function bootDemo(): Promise<void> {
  // Dynamic import keeps the demo fixture + transport out of the production
  // bundle (Vite code-splits the chunk; the desktop/mobile entry never
  // references demoApi/demoFixture statically). Importing the proxy triggers
  // the fixture + transportInstall.setWindowApi(demoApi) install.
  const { demoApi } = await import("./api/demoApi");
  setWindowApi(demoApi);
  // Pin the renderer's clock to the fixture's own anchor. Every timestamp in
  // the demo fixture is expressed relative to DEMO_T0, so with a live
  // `Date.now()` every elapsed-time label renders the distance from the
  // fixture's anchor to TODAY — the mobile session list read "990d", and it
  // grew by one every day.
  //
  // That made both capture pipelines time-dependent: the marketing shots and
  // the visual baselines encode those labels, so a committed baseline expired
  // at the next day boundary and the (required, blocking) drift gate then
  // failed on every open PR for a reason unrelated to any of them. It cost a
  // day of debugging as "non-deterministic capture" before the labels were
  // spotted — the captures are perfectly deterministic, the clock isn't.
  //
  // `videoRenderNow` is the existing seam for exactly this (src/renderer/
  // clock.ts, added for the hero video, which had the same problem per-frame).
  // Real transports leave it null and `nowMs()` falls back to `Date.now()`.
  // It also just makes the demo read correctly: "14m", not "990d".
  const { DEMO_T0 } = await import("./api/demoFixture");
  pinDemoClock(DEMO_T0);
  // Initialize renderer logging AFTER window.api is wired so configGet
  // works. The demo branch makes logging a no-op (no real token), but we
  // still call it for parity with the real boot path so future log-target
  // side effects don't diverge.
  void initRendererLogging("desktop");
  // BET-409: demo has no config — default to "system" so the demo shell still
  // follows the OS (and re-themes live) without needing a configGet.
  applyTheme();
  // Same React render as the real path — the demoApi satisfies the Api
  // contract, so App renders identically against the fixture.
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}

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
    // BET-409: apply the resolved theme as early as possible (before React
    // mounts) so the first paint is already on the correct theme and a
    // light-OS user doesn't flash the dark HTML default. The store's
    // applyConfig re-applies on subsequent config refreshes; this call wins
    // the first paint.
    applyTheme(config.theme);
    const seed = desktopHttpClientSeed(config);
    if (seed) {
      // Sole transport-install path (BET-254) — also called from PairStep on
      // first-time pairing so the next onboarding step can use httpApi in the
      // SAME session. On localStorage failure it falls back to the preload
      // bridge (window.api stays as-is).
      installHttpTransport(seed);
      // BET-678: restore the persisted local snapshot BEFORE the React root
      // renders so the first paint is instant (zero round trips). Only on the
      // paired/http path — there is no snapshot to restore pre-pairing. The
      // App bootstrap effect then syncs the cursor with the box.
      loadPersistedSnapshot();
    }
  } catch (e) {
    console.warn("[bui] configGet failed at entry:", e);
    // No config → default to "system" (follows OS) so the shell still themes.
    applyTheme();
  }
}

async function boot(): Promise<void> {
  // Short-circuit BEFORE any pairing / config / credential logic runs.
  // Demo mode must not touch configGet, install localStorage seeds, or
  // initialize the http transport — the demoApi returns the full fixture
  // synchronously and the renderer renders from it.
  if (isDemoMode) {
    await bootDemo();
    return;
  }

  // Desktop: default window.api to the real preload bridge, then let the
  // transport chooser swap it to httpApi if the config is paired (http mode).
  // Because `window.api` is now main-owned (not the contextBridge property),
  // this default install + the http-mode swap are both legal assignments.
  // BET-559: the renderer is desktop-only now — there is no web-client
  // fallback path to install the http shim into.
  if (preload) {
    setWindowApi(preload);
    await chooseDesktopTransport(preload);
    // chooseDesktopTransport already assigned window.__mantaPreload.
    // Initialize renderer logging AFTER window.api is wired so configGet
    // works — but BEFORE React mounts so early-render errors still ship.
    // Fire-and-forget; initRendererLogging is no-op when no token is set.
    void initRendererLogging("desktop");
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}

void boot();
