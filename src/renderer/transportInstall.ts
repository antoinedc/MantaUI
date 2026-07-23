import { httpApi } from "./api/httpApi";

// transportInstall.ts — single transport-install path for desktop renderer.
//
// Sole place that seeds localStorage + swaps window.api to httpApi on the
// desktop. Called from boot (chooseDesktopTransport in main.tsx) AND from
// PairStep after first-time pairing so the next onboarding step's
// opencodeModels() call reaches the box in the same session — without a
// reload (BET-254).
//
// Lives in a leaf module (not main.tsx) so both call sites can import it
// without an import edge into the app entry, which would risk a circular
// import / double-evaluation of `void boot();`.

// Install `window.api` as a WRITABLE, configurable property. contextBridge
// exposes `__mantaPreload` read-only, so the renderer owns `window.api` here
// to make the http-mode swap a legal assignment (not "Cannot assign to read
// only property 'api'").
export function setWindowApi(next: unknown): void {
  Object.defineProperty(window, "api", {
    value: next,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Install the httpApi client as window.api using a paired seed
 * ({ manta_server, manta_token }). Safe to call at boot AND right after
 * first-time pairing so the current session switches transport without a
 * reload. Returns true if the swap happened, false if localStorage was
 * unavailable (in which case window.api stays on the preload bridge).
 *
 * SINGLE place that swaps window.api to httpApi on desktop — boot
 * (chooseDesktopTransport) and PairStep both call it.
 */
export function installHttpTransport(seed: {
  manta_server: string;
  manta_token: string;
}): boolean {
  try {
    localStorage.setItem("manta_server", seed.manta_server);
    localStorage.setItem("manta_token", seed.manta_token);
  } catch (e) {
    console.warn("[manta] localStorage seed failed; keeping preload transport:", e);
    return false;
  }
  setWindowApi(httpApi);
  return true;
}
