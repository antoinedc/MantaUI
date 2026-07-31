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
import { useStore } from "./store";

export function nowMs(): number {
  const videoNow = useStore.getState().videoRenderNow;
  return videoNow ?? Date.now();
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
