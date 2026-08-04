// src/renderer/clock.ts — deterministic "now" seam for the renderer.
//
// Real renderer: `nowMs()` returns `Date.now()` (the default — no opt-in).
//
// Hero video (BET-304 stage 2 / BET-322): when the demo-mode composition
// mounts the renderer, `DemoBootstrap` (video/src/demoBootstrap.tsx)
// seeds `videoRenderNow` to `DEMO_T0` and `useFrameSync` updates it
// per-frame from `DEMO_T0 - t*1000`. With this seam, every elapsed-time
// label that used to read `Date.now()` — Sidebar's session-age chip
// (`Sidebar.tsx`), ChatPanel's running-indicator "X seconds ago"
// (`MessageRow.tsx:RunningIndicator`) — becomes a function of the
// fixture's anchored time, not the wall clock. Two consecutive renders
// are byte-identical for that frame.
//
// The renderer was already designed to subscribe to per-frame store
// updates (via `useStore()` at the top of `Sidebar`), so pushing
// `videoRenderNow` per-frame from the composition triggers the
// expected re-renders. `MessageRow.tsx`'s `setInterval(() => setTick)` is
// now a no-op for elapsed-time purposes (the deterministic clock drives
// the label) but is kept so the tick-and-re-render cycle continues to
// run — stripping it would change unrelated behavior.
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

export function nowMs(): number {
  const videoNow = useStore.getState().videoRenderNow;
  return videoNow ?? Date.now();
}

// ---------------------------------------------------------------------------
// Age ticker.
// ---------------------------------------------------------------------------
//
// An elapsed-time label reads the clock DURING RENDER (`nowMs()`), so it is
// only as fresh as its last render. Nothing about a session changes when a
// minute passes, so without a ticker the sidebar's age column never advances
// on its own — "1m" stays "1m" until some unrelated event happens to re-render
// the sidebar.
//
// It LOOKED like it worked because the activity poller pushes a status batch
// every 2s and `applyStatusBatch` always returns a fresh `status` object, so
// every subscriber re-rendered on that cadence. That was incidental coupling,
// not a design: the ages were being driven by an unrelated event stream, and
// they freeze the moment it stops (a half-open events socket, a paused poller,
// a transport that never delivers the `status` kind) — while the status dot
// keeps working, because the dot for a chat window is driven by opencode's own
// session events instead. That asymmetry is exactly the reported symptom, and
// it is why the fix belongs here rather than in the transport: an age label
// must own its clock.
//
// ONE shared interval for every subscriber (not one per row) so N rows cost N
// re-renders on the same tick rather than N staggered timers, and it is torn
// down when the last subscriber unmounts. The tick only forces a re-render —
// the value still comes from `nowMs()`, so demo mode stays deterministic: with
// `videoRenderNow` pinned, ticking re-renders are byte-identical and the
// visual baselines are unaffected.
//
// 10s: `formatAge` is whole-minute granular, so this bounds the lag at a
// minute boundary to 10s while costing one shallow re-render per 10s.
export const AGE_TICK_MS = 10_000;

const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickVersion = 0;

function subscribeTick(onChange: () => void): () => void {
  tickListeners.add(onChange);
  if (tickTimer == null) {
    tickTimer = setInterval(() => {
      tickVersion++;
      for (const fn of tickListeners) {
        try {
          fn();
        } catch {
          /* a listener throwing must not kill the shared ticker */
        }
      }
    }, AGE_TICK_MS);
    // Never hold a test runner (or the process) open for the ticker alone.
    (tickTimer as { unref?: () => void }).unref?.();
  }
  return () => {
    tickListeners.delete(onChange);
    if (tickListeners.size === 0 && tickTimer != null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

const readTickVersion = (): number => tickVersion;

/**
 * Subscribe the calling component to the shared age ticker so any label
 * derived from `nowMs()` advances on its own. Returns the tick version purely
 * so the subscription is observable in tests; callers normally ignore it.
 */
export function useAgeTick(): number {
  return useSyncExternalStore(subscribeTick, readTickVersion, readTickVersion);
}

/**
 * Pin the renderer's clock to a fixed instant. Called by `bootDemo()` in
 * main.tsx with the demo fixture's own anchor (`DEMO_T0`).
 *
 * Demo mode exists to be CAPTURED — by the marketing shots and by the visual
 * baselines — and every fixture timestamp is expressed relative to `DEMO_T0`.
 * Against a live `Date.now()` each elapsed label therefore renders the
 * distance from the fixture's anchor to today ("990d") and grows by one every
 * day, so both pipelines' committed images expire at the next day boundary and
 * the blocking drift gate then fails on unrelated PRs. Pinning makes every
 * capture a function of the fixture alone — and makes the demo read correctly
 * ("14m") instead of as a pile of year-old sessions.
 */
export function pinDemoClock(t0: number): void {
  useStore.setState({ videoRenderNow: t0 });
}
