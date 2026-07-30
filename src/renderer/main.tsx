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
import { pickDemoLayout } from "./demoLayout";
import { applyTheme } from "./theme";

// Demo mode (BET-302): `?demo` in the URL swaps the real httpApi for a
// fixture-backed transport and skips pairing / config / credential logic
// entirely — the renderer renders the full desktop UI from a fictional
// state with zero network calls. Dynamic-imported so the production bundle
// doesn't carry the demo fixture (verified at PR-time by checking
// out/renderer/ chunk sizes before/after).
//
// `?demo` works on every entry path (desktop + mobile/web): the URL is
// parsed before we branch on preload presence, and the demoApi install
// short-circuits both the desktop chooseDesktopTransport AND the mobile
// installHttpTransport flows below. setWindowApi is the same seam
// transportInstall.ts exposes; no parallel install path is added (per the
// ticket's "use the existing seam" rule).
//
// Shell override (BET-302 review): `?demo` alone used to always render
// <MobileApp/> in a browser because the only branch was `isMobile =
// !preload`, and a browser never has an Electron preload. The override
// (`?demo&desktop` / `?demo&mobile`) is applied ONLY inside bootDemo() so
// BET-303's desktop hero is reachable from `?demo` in a browser. The real
// boot path's isMobile derivation is unchanged — that's production
// transport selection.
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
  // Shell override: `?demo&desktop` / `?demo&mobile` force a layout
  // independent of preload presence. Without an override we fall back to
  // isMobile (the production transport-selection flag). The override is
  // applied ONLY here — the real boot path below keeps its isMobile-based
  // selection unchanged so production transport selection is not perturbed.
  const layout = pickDemoLayout(
    new URLSearchParams(window.location.search),
  );
  const renderDesktop = layout === "desktop" || (layout === null && !isMobile);
  // Initialize renderer logging AFTER window.api is wired so configGet
  // works. The demo branch makes logging a no-op (no real token), but we
  // still call it for parity with the real boot path so future log-target
  // side effects don't diverge. Tag follows the rendered shell so logs and
  // UI agree.
  void initRendererLogging(renderDesktop ? "desktop" : "mobile");
  // BET-409: demo has no config — default to "system" so the demo shell still
  // follows the OS (and re-themes live) without needing a configGet.
  applyTheme();
  // Same React render as the real paths — the demoApi satisfies the Api
  // contract, so App / MobileApp render identically against the fixture.
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{renderDesktop ? <App /> : <MobileApp />}</React.StrictMode>,
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
    // BET-409: apply "system" immediately so a light-OS phone doesn't flash
    // the dark HTML default before the (async, post-pairing) configGet lands.
    // The store's applyConfig re-applies the box's configured theme once
    // MobileApp's refresh() resolves.
    applyTheme();
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{isMobile ? <MobileApp /> : <App />}</React.StrictMode>,
  );
}

void boot();
