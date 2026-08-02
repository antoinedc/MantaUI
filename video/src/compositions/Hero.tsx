// video/src/compositions/Hero.tsx — BET-304 stage 2 hero composition.
//
// Drives the renderer inside Remotion: at each frame, evaluate the
// time-varying `applyDemoStateAt(t)` fixture (a still is one evaluation of a
// time-varying fixture) and render the renderer's own `<App />` on the desktop
// (and, while the retired web-mobile-client's shell is gone, <App/> again as a
// placeholder in the phone frame) at scaled positions on a 1920x1080 canvas.
//
// Six beats per BET-304:
//   1. Desktop. User submits a task. Agent begins, tool calls streaming.
//   2. The laptop closes. Desktop frame dims out.
//   3. Hold on nothing for a beat — do not rush it; it's the whole argument.
//   4. Phone lights up with a push notification: permission needed.
//   5. Tap Allow on the phone. Transcript continues on the phone.
//   6. Desktop reopens, already caught up. Tests pass. Work is done.
//
// Stop here for review (per parent ticket's "two passes and stop after the
// first for review" rule). Stage 3 — timing polish, easing, captions
// typography, compression tuning — requires human sign-off on the sequence.

import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { useEffect } from "react";
import { App } from "@renderer/App";
import { applyDemoStateAt, DEMO_T0, HERO_BEATS } from "@renderer/api/demoFixture";
import { useStore } from "@renderer/store";
import { DemoBootstrap } from "../demoBootstrap";

import "@renderer/index.css";

// 1920x1080 @ 30fps gives 1500 frames over 50 seconds. Anything in 50–70s is
// in spec (acceptance criterion "Sequence duration lands in the 50–70s
// band"). HERO_BEATS.BEAT_6_END is the source of truth for the total — the
// seconds → frames math below is purely derived.
export const HERO_WIDTH = 1920;
export const HERO_HEIGHT = 1080;
export const HERO_FPS = 30;
export const HERO_DURATION_SECONDS = HERO_BEATS.BEAT_6_END;
export const HERO_DURATION_FRAMES =
  HERO_DURATION_SECONDS * HERO_FPS;

// Per-beat captions. One line per beat, captioned the whole way through. The
// 6th beat's caption also doubles as the "catch up" punchline.
const BEAT_CAPTIONS: { from: number; to: number; text: string }[] = [
  { from: 0, to: HERO_BEATS.BEAT_1_END, text: "Run your agent from your laptop." },
  { from: HERO_BEATS.BEAT_1_END, to: HERO_BEATS.BEAT_2_END, text: "Close the lid…" },
  {
    from: HERO_BEATS.BEAT_2_END,
    to: HERO_BEATS.BEAT_3_END,
    text: "…the box keeps working.",
  },
  {
    from: HERO_BEATS.BEAT_3_END,
    to: HERO_BEATS.BEAT_4_END,
    text: "Your phone lights up when the agent is blocked.",
  },
  {
    from: HERO_BEATS.BEAT_4_END,
    to: HERO_BEATS.BEAT_5_END,
    text: "Approve from anywhere — full transcript, live tools.",
  },
  {
    from: HERO_BEATS.BEAT_5_END,
    to: HERO_BEATS.BEAT_6_END,
    text: "Reopen the laptop. Already caught up.",
  },
];

// Linear-fade helper for the per-frame visibility overlay. `prefers-reduced-
// motion` is honoured at the website level (see `prefers-reduced-motion: reduce`
// in website/site.css which hides the `<video>` entirely); pass 1 is a rough
// pass, so we keep the fade linear for now and let stage 3 tune easing.
function fadeFor(
  t: number,
  startSec: number,
  endSec: number,
  fadeInSec: number,
  fadeOutSec: number,
): number {
  // Pre-fade-in window — element hidden.
  if (t < startSec) return 0;
  // Fade in.
  if (t < startSec + fadeInSec) {
    return interpolate(t, [startSec, startSec + fadeInSec], [0, 1], {
      easing: Easing.linear,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  // Hold.
  if (t < endSec - fadeOutSec) return 1;
  // Fade out.
  if (t < endSec) {
    return interpolate(t, [endSec - fadeOutSec, endSec], [1, 0], {
      easing: Easing.linear,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  // Post-fade-out — element hidden.
  return 0;
}

// Desktop-area visibility per beat. Each entry is `[fromSec, toSec, lit]`;
// `lit` is the steady-state alpha (1 = full bright, ~0.15 = dimmed laptop,
// 0 = off). We ramp between values inside the fade-in/out windows.
function desktopAlpha(t: number): number {
  if (t < HERO_BEATS.BEAT_1_END) return fadeFor(t, 0, HERO_BEATS.BEAT_1_END, 0.3, 0.4);
  // Beat 2 — dim from 1 → 0.15 over the beat, then hold 0.15.
  if (t < HERO_BEATS.BEAT_2_END) {
    return interpolate(t, [HERO_BEATS.BEAT_1_END, HERO_BEATS.BEAT_2_END], [1, 0.15], {
      easing: Easing.linear,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  // Beat 3 — desktop off entirely (the "hold on nothing" beat).
  if (t < HERO_BEATS.BEAT_3_END) return 0;
  // Beat 4 + 5 — desktop still off.
  if (t < HERO_BEATS.BEAT_5_END) return 0;
  // Beat 6 — fade back in over the first second.
  return interpolate(t, [HERO_BEATS.BEAT_5_END, HERO_BEATS.BEAT_5_END + 1], [0, 1], {
    easing: Easing.linear,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function phoneAlpha(t: number): number {
  if (t < HERO_BEATS.BEAT_3_END) return 0;
  // Beat 4 — fade in.
  if (t < HERO_BEATS.BEAT_4_END) {
    return interpolate(t, [HERO_BEATS.BEAT_3_END, HERO_BEATS.BEAT_3_END + 1], [0, 1], {
      easing: Easing.linear,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }
  // Beat 5 — full.
  if (t < HERO_BEATS.BEAT_5_END) return 1;
  // Beat 6 — fade out.
  return interpolate(
    t,
    [HERO_BEATS.BEAT_5_END, HERO_BEATS.BEAT_5_END + 1],
    [1, 0],
    {
      easing: Easing.linear,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
}

// Caption text for the current beat. Returns the matching BEAT_CAPTIONS row
// or empty when between beats (which never happens given the from/to
// coverage but keeps the type honest).
function captionFor(t: number): string {
  for (const c of BEAT_CAPTIONS) {
    if (t >= c.from && t < c.to) return c.text;
  }
  return "";
}

// Per-frame sync. `applyDemoStateAt(t)` mutates the module-level `demoState`
// (the closure target of the `demoApi` Proxy's lazy reads) AND returns the
// mutated object — we pull the beat-shaped fields that the renderer
// components actually subscribe to and push them into the zustand store
// so the next render sees the new values.
//
// What we push and what we don't:
//   - `activeProjectName` + `activeWindowByProject`: the renderer reads
//     these directly via `useStore((s) => s.activeProjectName)` and
//     `useStore((s) => s.activeWindowByProject[s.activeProjectName])`
//     (e.g. `SessionListScreen.tsx:108`). Push these.
//   - `status`: the renderer's `applyStatusBatch` is what populates this,
//     but it normally fires once at mount from `demoApi.onStatusEvent`.
//     Pushing it per-frame makes the sidebar's running dot / pulse
//     match the beat's `running` flag (beat 1 running, beat 6 not).
//   - `question` / `permission`: these live in ChatPanel's local
//     `useState`, NOT in the store. The renderer fetches them via
//     `window.api.opencodeQuestions/Permissions(sessionId)` on mount and
//     on permission/question events. For pass 1 we accept that the
//     ChatPanel card doesn't visually transition mid-video — the demo
//     state mutation still drives the data, but the renderer doesn't
//     re-fetch. The visible beats (desktop→phone→desktop) are conveyed
//     by the `desktopAlpha` / `phoneAlpha` opacity gates above.
//
// `useEffect` runs after the render commit; combined with `useCurrentFrame`
// driven re-renders the composition fires this once per frame. Doing the
// mutation in `useEffect` (not the render body) keeps the side-effects off
// the synchronous render path — the renderer's child components observe
// the new store state on their next render, not as a mid-render write.
function useFrameSync(t: number) {
  useEffect(() => {
    const next = applyDemoStateAt(t);
    // Translate the demoState's `activeWindowIndex` (single int for the
    // active session) into the store's `activeWindowByProject` shape
    // (Record<projectName, windowIndex>) so the renderer's selectors
    // resolve to the right window.
    const activeWindowByProject = {
      ...useStore.getState().activeWindowByProject,
    };
    if (next.activeProjectName != null && next.activeWindowIndex != null) {
      activeWindowByProject[next.activeProjectName] = next.activeWindowIndex;
    }
    // Advance the deterministic clock: `DEMO_T0 - t*1000` puts the
    // composition's "now" at t=0 seconds BEFORE DEMO_T0 and walks
    // backward in time as the video plays. lastMessageAt in demoStateAt
    // uses the same anchor (DEMO_T0 - t*1000), so the sidebar's
    // classifyCacheAge computation (`(now - lastMessageAt) / ttlMs`)
    // produces the same number across two consecutive renders — the
    // byte-comparable contract lands for the visual side too.
    const videoRenderNow = HERO_BEATS.BEAT_6_END >= t
      ? Math.round(DEMO_T0 - t * 1000)
      : useStore.getState().videoRenderNow;
    useStore.setState({
      activeProjectName: next.activeProjectName,
      activeWindowByProject,
      status: next.status,
      videoRenderNow,
    });
  }, [t]);
}

export const Hero: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Drive the demo state from `t`.
  useFrameSync(t);

  const dAlpha = desktopAlpha(t);
  const pAlpha = phoneAlpha(t);

  return (
    <AbsoluteFill style={{ background: "#0B1020" }}>
      {/* Background brand glow — the same radial-gradient aura the website
          hero uses, so the video frame-0 reads as a natural extension of the
          page. Cheap to render (single absolute-fill, no animation). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          pointerEvents: "none",
        }}
        aria-hidden
      >
        <div
          style={{
            position: "absolute",
            top: -260,
            left: "50%",
            transform: "translateX(-50%)",
            width: 900,
            height: 640,
            background:
              "radial-gradient(ellipse at center,rgba(46,107,255,.28),rgba(73,215,245,.10) 40%,transparent 70%)",
            filter: "blur(12px)",
          }}
        />
      </div>

      {/* Desktop frame — left 1440px. App renders at the renderer's native
          viewport (no transform) so its layout, scrollbars, and pixel-grid
          match what the website screenshot harness (BET-303) produces. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1440,
          height: 1080,
          opacity: dAlpha,
          // Brand card chrome — same border + shadow the website's hero-video
          // element uses (see website/index.html .hero-video).
          borderRight: "1px solid #1c2542",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
        }}
      >
        <DemoBootstrap>
          <App />
        </DemoBootstrap>
      </div>

      {/* Phone bezel — right 480px. The mobile shell renders at its native
          393x852 viewport, scaled to fit the 480-wide bezel. The bezel +
          screen border match the static "phone" mockup in
          website/index.html so a side-by-side comparison of the static
          shot-sync.webp and the video reads as one product. */}
      <div
        style={{
          position: "absolute",
          right: 24,
          top: 60,
          width: 432,
          height: 960,
          opacity: pAlpha,
          borderRadius: 48,
          border: "1px solid #2a3756",
          background: "#0a1224",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        {/* Inner screen — BET-559: the mobile web-client shell (MobileApp) is
            retired, so the phone frame now renders the desktop <App/> as a
            placeholder. A native-Swift-app mockup should replace this when the
            native client has a renderable surface (see BET-559 follow-up). */}
        <div
          style={{
            position: "absolute",
            left: 8,
            top: 60,
            width: 416,
            height: 840,
            transformOrigin: "top left",
            transform: "scale(1.06)",
            // status bar notch mock — matches the website's static phone.
          }}
        >
          <DemoBootstrap>
            <App />
          </DemoBootstrap>
        </div>
        {/* Notch */}
        <div
          style={{
            position: "absolute",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            width: 110,
            height: 8,
            borderRadius: 99,
            background: "#101a30",
            zIndex: 3,
          }}
          aria-hidden
        />
      </div>

      {/* Caption overlay — bottom-centre of the canvas, large enough to be
          legible at 393px phone preview. Pass 1 keeps it plain (no easing,
          no per-letter animation); stage 3 refines typography + entrance. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 32,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            color: "#e6eefc",
            fontFamily:
              "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            padding: "10px 22px",
            borderRadius: 14,
            background: "rgba(11, 16, 32, 0.7)",
            border: "1px solid #1c2542",
            backdropFilter: "blur(6px)",
          }}
        >
          {captionFor(t)}
        </div>
      </div>
    </AbsoluteFill>
  );
};
