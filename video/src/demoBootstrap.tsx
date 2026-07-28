// video/src/demoBootstrap.tsx — single mount seam for the renderer inside the
// Remotion composition (BET-322 / BET-304 stage 2).
//
// The renderer was originally built to mount inside Electron (desktop) or a
// Capacitor/bare-browser shell (mobile). It talks to its transport through
// `window.api` and reads/writes a zustand store. To render it inside a
// Remotion composition (which runs the React code in Puppeteer/Chromium),
// we need to:
//
//   1. Install `window.api` as the demoApi Proxy from src/renderer/api/demoApi.
//   2. Mark the desktop preload bridge as absent (`window.__mantaPreload = null`)
//      so `getMantaPreload()` callers (screenshot detection, auto-update, etc.)
//      no-op instead of throwing.
//   3. Seed the zustand store with the demo fixture's config + projects so
//      App.tsx's resolveTransportMode() reads "http" and the demo lands on
//      the normal shell instead of the onboarding flow. mergeLocalPairing()
//      in src/renderer/store.ts reads localStorage["manta_server" /
//      "manta_token"]; we seed those too so the same overlay code path that
//      runs in `?demo` mode here doesn't blank the boxToken it just seeded.
//   4. Hand the children the same `useStore` instance the renderer uses so
//      per-frame state pushes from `applyDemoStateAt(t)` reach the renderer.
//
// This module intentionally does NOT fork the renderer or duplicate its
// bootstrap — it runs the exact same code paths the `?demo` browser entry
// uses (setWindowApi + demoApi + a seeded store), then renders the renderer's
// own `<App />` / `<MobileApp />` as-is. Per BET-304: "If a component refuses
// to mount outside the app shell, refactor the composition so it can — do
// not duplicate the component, do not fork the renderer."

import { useEffect, useState, type ReactNode } from "react";
import { setWindowApi } from "@renderer/transportInstall";
import { demoApi } from "@renderer/api/demoApi";
import { applyDemoStateAt, DEMO_T0, demoState } from "@renderer/api/demoFixture";
import { useStore } from "@renderer/store";

// Run-once bootstrap. Mounts a `useEffect` that wires the demo environment
// exactly the way src/renderer/main.tsx's `bootDemo()` does, then renders the
// children. We `useState` an "isReady" flag so the first paint doesn't show
// the children before window.api + the store are seeded (without this gate
// the children render once with an empty store, then re-render — a one-frame
// flicker that the byte-comparable test catches).
export function DemoBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  // Seed the demo fixture immediately at t=0 so the very first render
  // reflects the demo state (not the empty initial zustand state). The
  // per-frame `useFrameSync` below takes over after mount.
  useEffect(() => {
    applyDemoStateAt(0);
    setWindowApi(demoApi);
    // No Electron preload — every `getMantaPreload()` call returns null.
    try {
      Object.defineProperty(window, "__mantaPreload", {
        value: null,
        writable: true,
        configurable: true,
      });
    } catch {
      /* SSR / non-browser env — ignore */
    }
    // Mirror the localStorage seed the desktop bootstrap writes so
    // mergeLocalPairing() in store.ts doesn't blank the boxToken we just
    // seeded via applyConfig().
    try {
      localStorage.setItem("manta_server", demoState.config.serverUrl ?? "");
      localStorage.setItem(
        "manta_token",
        demoState.config.boxToken ?? "",
      );
    } catch {
      /* localStorage unavailable — fall through; renderer tolerates empty values */
    }
    // Push the demo fixture's config + projects into the zustand store so
    // App.tsx's first render sees the demo state, not the empty initial
    // state. applyConfig mirrors what `refresh()` does for the httpApi path.
    useStore.getState().applyConfig(demoState.config);
    useStore.getState().applyProjects(demoState.projects);
    useStore.setState({
      loaded: true,
      activeProjectName: demoState.activeProjectName,
      activeWindowByProject: {
        ...(demoState.activeProjectName
          ? { [demoState.activeProjectName]: demoState.activeWindowIndex ?? 0 }
          : {}),
      },
      // Seed the deterministic clock at DEMO_T0 (the fixture's reference
      // time). `useFrameSync` advances this per frame to `DEMO_T0 - t*1000`
      // so `Sidebar.tsx:978`'s `nowMs()` and `MessageRow.tsx:RunningIndicator`'s
      // `nowMs()` resolve to a deterministic value across renders. Real
      // apps leave `videoRenderNow` null and `nowMs()` falls back to
      // `Date.now()` (see src/renderer/clock.ts).
      videoRenderNow: DEMO_T0,
    });
    // runBackgroundSync fires replayChatAttention + backfillLastMessageTimes
    // so the sidebar status block (running dot, attention kind) and
    // lastMessageAt ages are populated from demoState.status on first paint.
    void useStore.getState().runBackgroundSync();
    setReady(true);
  }, []);
  if (!ready) return null;
  return <>{children}</>;
}
