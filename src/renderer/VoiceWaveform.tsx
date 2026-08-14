// VoiceWaveform.tsx — the live recording meter, hand-rolled on canvas.
//
// Reads the recorder's live level window (`liveWindowRef.current`, a rolling
// Float32Array ring written 25×/s by the recorder) in its own
// requestAnimationFrame loop. It must NOT subscribe to React state — routing
// the 25/s updates through state would re-render the composer 25 times a
// second, a regression this panel has a documented history of.
//
// The ceiling is pinned at 1.0 and the live window is never normalised. If we
// rescaled to the loudest visible sample, every previously-drawn bar would
// jump each time a new peak arrives and the whole meter would visibly dance.
// `normalizeForDisplay` in waveform.mjs exists for the STORED waveform only —
// do not call it here.
//
// It keeps drawing under prefers-reduced-motion: the meter is functional, not
// decorative — a waveform that stops moving is how a user diagnoses a dead
// microphone. Only the dot's pulse (handled by .manta-recording-dot in CSS)
// is suppressed.

import { RefObject, useEffect, useRef } from "react";
import { VOICE_LIVE_WINDOW_BARS } from "../shared/waveform.mjs";

const WAVE_HEIGHT_CSS = 24;

export function VoiceWaveform({
  phase,
  liveWindowRef,
}: {
  phase: "recording" | "paused";
  liveWindowRef: RefObject<Float32Array>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Theme colours, resolved from CSS custom properties on the canvas so both
  // themes work. Re-read when the phase changes so a theme toggle mid-recording
  // still paints the right colour on the next frame.
  const colorsRef = useRef({ recording: "", paused: "" });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cs = getComputedStyle(canvas);
    colorsRef.current = {
      recording: (cs.getPropertyValue("--danger") || "").trim(),
      paused: (cs.getPropertyValue("--warn") || "").trim(),
    };
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.round(WAVE_HEIGHT_CSS * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const N = VOICE_LIVE_WINDOW_BARS;
    const gap = 1.5;

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      ctx.clearRect(0, 0, W, H);
      const window_ = liveWindowRef.current;
      if (!window_) return;
      const barW = Math.max(1.2, (W - (N - 1) * gap) / N);
      const recording = phase === "recording";
      const fill = colorsRef.current[recording ? "recording" : "paused"] || "";
      if (fill) ctx.fillStyle = fill;
      for (let i = 0; i < N; i++) {
        const v = window_[i];
        if (v <= 0) continue;
        const h = Math.max(1.5, v * (H - 2));
        const x = i * (barW + gap);
        const y = (H - h) / 2;
        ctx.globalAlpha = recording ? 0.35 + 0.65 * (i / N) : 0.45;
        ctx.beginPath();
        if (typeof (ctx as CanvasRenderingContext2D).roundRect === "function") {
          ctx.roundRect(x, y, barW, h, barW / 2);
        } else {
          ctx.rect(x, y, barW, h);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [phase, liveWindowRef]);

  return (
    <canvas
      ref={canvasRef}
      className="flex-1 h-6 min-w-0"
      aria-hidden="true"
    />
  );
}
