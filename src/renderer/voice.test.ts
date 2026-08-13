// Pure-part tests for the reworked voice recorder (BET-835). The recorder
// hook itself wires MediaRecorder + AnalyserNode (not unit-testable here);
// everything pure — peak reduction, elapsed maths across a pause/resume
// cycle, the near-limit threshold, and the too-short discard — lives in the
// extracted functions below and is what we pin.

import { describe, expect, it } from "vitest";
import {
  elapsedCurrent,
  elapsedPause,
  elapsedResume,
  elapsedStart,
  isTooShort,
  nearLimitAt,
} from "./voice";
import {
  VOICE_MAX_DURATION_MS,
  VOICE_MIN_DURATION_MS,
  VOICE_WARN_REMAINING_MS,
  downsamplePeaks,
} from "../shared/waveform.mjs";

describe("peak reduction over a synthetic buffer", () => {
  it("keeps a short buffer as-is (quantized, unpadded)", () => {
    const out = downsamplePeaks([0.1, 0.5, 1.0, 0.0]);
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([26, 128, 255, 0]);
  });

  it("reduces a long buffer to at most the stored-peak cap", () => {
    const long = Array.from({ length: 5000 }, (_, i) => (i % 2 ? 0.9 : 0.1));
    const out = downsamplePeaks(long);
    expect(out.length).toBeLessThanOrEqual(400);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });

  it("uses the max per bucket, never the mean, and never flattens a spike", () => {
    const samples = new Array(400).fill(0);
    samples[120] = 1.0; // one loud spike somewhere mid-buffer
    const out = downsamplePeaks(samples);
    // A single full-scale sample must survive reduction as at least one 255.
    expect(Math.max(...out)).toBe(255);
  });

  it("maps silence to all zeros and empty input to empty output", () => {
    expect(Array.from(downsamplePeaks(new Array(1000).fill(0)))).toEqual(
      new Array(400).fill(0),
    );
    expect(downsamplePeaks([]).length).toBe(0);
  });
});

describe("elapsed maths across a pause/resume cycle", () => {
  it("tracks a linear recording with no pauses", () => {
    const s = elapsedStart();
    expect(elapsedCurrent(s, 0)).toBe(0);
    expect(elapsedCurrent(s, 1000)).toBe(1000);
    expect(elapsedCurrent(s, 3500)).toBe(3500);
  });

  it("freezes while paused and excludes the paused span after resume", () => {
    let s = elapsedStart(); // t=0 take starts
    expect(elapsedCurrent(s, 2000)).toBe(2000); // 2s live

    s = elapsedPause(s, 2000); // pause at t=2s
    expect(elapsedCurrent(s, 3000)).toBe(2000); // paused: frozen at 2s

    s = elapsedResume(s, 3000); // resume at t=3s
    expect(elapsedCurrent(s, 3500)).toBe(2500); // 2s + 0.5s, paused 1s excluded
    expect(elapsedCurrent(s, 4000)).toBe(3000);
  });

  it("supports multiple pause/resume cycles summing only live segments", () => {
    let s = elapsedStart();
    s = elapsedPause(s, 1000); // ran 1s
    s = elapsedResume(s, 2000); // paused 1s
    s = elapsedPause(s, 2500); // ran 0.5s -> accum 1.5s
    expect(elapsedCurrent(s, 9000)).toBe(1500); // paused: frozen
    s = elapsedResume(s, 9000);
    expect(elapsedCurrent(s, 9500)).toBe(2000); // resumed 0.5s
  });
});

describe("near-limit threshold", () => {
  it("is false fresh and well under the cap", () => {
    expect(nearLimitAt(0)).toBe(false);
    expect(nearLimitAt(VOICE_MAX_DURATION_MS / 2)).toBe(false);
  });

  it("flips true only once remaining time is under the warn window", () => {
    // remaining == warn is NOT under it
    expect(
      nearLimitAt(VOICE_MAX_DURATION_MS - VOICE_WARN_REMAINING_MS),
    ).toBe(false);
    // remaining < warn
    expect(
      nearLimitAt(VOICE_MAX_DURATION_MS - VOICE_WARN_REMAINING_MS + 1),
    ).toBe(true);
    // at/over the cap
    expect(nearLimitAt(VOICE_MAX_DURATION_MS)).toBe(true);
  });
});

describe("too-short discard", () => {
  it("accepts a take at or above the minimum with a real blob", () => {
    expect(isTooShort(VOICE_MIN_DURATION_MS, 1024)).toBe(false);
    expect(isTooShort(VOICE_MIN_DURATION_MS + 1000, 4096)).toBe(false);
  });

  it("discards a sub-minimum take or a sub-1KB blob", () => {
    expect(isTooShort(VOICE_MIN_DURATION_MS - 1, 4096)).toBe(true);
    expect(isTooShort(5000, 1023)).toBe(true);
    expect(isTooShort(VOICE_MIN_DURATION_MS, 1023)).toBe(true);
  });
});
