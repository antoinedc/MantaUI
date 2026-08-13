import { describe, it, expect } from "vitest";
import {
  VOICE_SAMPLE_INTERVAL_MS,
  VOICE_MAX_STORED_PEAKS,
  VOICE_LIVE_WINDOW_BARS,
  VOICE_MAX_DURATION_MS,
  VOICE_WARN_REMAINING_MS,
  VOICE_MIN_DURATION_MS,
  VOICE_CONFIRM_DISCARD_MS,
  quantizePeak,
  downsamplePeaks,
  bucketPeaks,
  normalizeForDisplay,
  formatClock,
} from "./waveform.mjs";

describe("recording constants", () => {
  it("export the documented values so later tickets never hardcode them", () => {
    expect(VOICE_SAMPLE_INTERVAL_MS).toBe(40);
    expect(VOICE_MAX_STORED_PEAKS).toBe(400);
    expect(VOICE_LIVE_WINDOW_BARS).toBe(90);
    expect(VOICE_MAX_DURATION_MS).toBe(300_000);
    expect(VOICE_WARN_REMAINING_MS).toBe(30_000);
    expect(VOICE_MIN_DURATION_MS).toBe(400);
    expect(VOICE_CONFIRM_DISCARD_MS).toBe(30_000);
  });
});

describe("quantizePeak", () => {
  it("clamps at the bounds", () => {
    expect(quantizePeak(0)).toBe(0);
    expect(quantizePeak(-0.5)).toBe(0);
    expect(quantizePeak(1)).toBe(255);
    expect(quantizePeak(2)).toBe(255);
  });
  it("rounds interior values to 0..255", () => {
    expect(quantizePeak(0.5)).toBe(128);
    expect(quantizePeak(0.1)).toBe(26);
    expect(quantizePeak(0.9)).toBe(230);
  });
  it("maps NaN to 0", () => {
    expect(quantizePeak(NaN)).toBe(0);
  });
});

describe("downsamplePeaks", () => {
  it("returns empty for empty input", () => {
    expect(Array.from(downsamplePeaks([]))).toEqual([]);
  });
  it("quantizes and returns as-is (no padding) when <= max", () => {
    const out = downsamplePeaks([0, 0.5, 1], 400);
    expect(Array.from(out)).toEqual([0, 128, 255]);
  });
  it("splits non-multiple sample counts into even buckets", () => {
    // 10 samples into 3 buckets -> bucket widths 3, 3, 4.
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const out = downsamplePeaks(samples, 3);
    // bucket0 max 0.3 -> 77, bucket1 max 0.6 -> 153, bucket2 max 1.0 -> 255
    expect(Array.from(out)).toEqual([77, 153, 255]);
  });
  it("keeps a single loud spike inside a quiet bucket (max, not mean)", () => {
    // Bucket 0 is all quiet (~0.1); bucket 1 holds the 1.0 spike.
    const samples = [0.1, 0.1, 0.1, 1.0, 0.1, 0.1];
    const out = downsamplePeaks(samples, 2);
    // A mean would give ~25 for the quiet bucket; the peak survives instead.
    expect(Array.from(out)).toEqual([26, 255]);
  });
  it("caps output length at max for a long recording", () => {
    const samples = new Array(7500).fill(0.5);
    const out = downsamplePeaks(samples, 400);
    expect(out.length).toBe(400);
    expect(out[0]).toBe(128);
  });
});

describe("bucketPeaks", () => {
  it("returns [] for bars <= 0", () => {
    expect(bucketPeaks(new Uint8Array([1, 2]), 0)).toEqual([]);
    expect(bucketPeaks(new Uint8Array([1, 2]), -3)).toEqual([]);
  });
  it("returns [] for empty input", () => {
    expect(bucketPeaks(new Uint8Array(0), 10)).toEqual([]);
  });
  it("returns one value per peak when fewer peaks than bars (no stretch)", () => {
    expect(bucketPeaks(new Uint8Array([255, 0]), 10)).toEqual([1, 0]);
    expect(bucketPeaks(new Uint8Array([255]), 5)).toEqual([1]);
  });
  it("buckets and divides by 255", () => {
    const peaks = new Uint8Array([26, 51, 77, 102, 128, 153, 179, 204, 230, 255]);
    const out = bucketPeaks(peaks, 3);
    // buckets of widths 3,3,4: max(0..2)=77, max(3..5)=153, max(6..9)=255
    expect(out).toEqual([77 / 255, 153 / 255, 255 / 255]);
  });
});

describe("normalizeForDisplay", () => {
  it("returns [] for empty input", () => {
    expect(normalizeForDisplay([])).toEqual([]);
  });
  it("returns all zeros unchanged when max is 0", () => {
    expect(normalizeForDisplay([0, 0, 0])).toEqual([0, 0, 0]);
  });
  it("scales so the loudest bar is 1.0", () => {
    expect(normalizeForDisplay([0.25, 0.5, 1.0])).toEqual([0.25, 0.5, 1.0]);
    expect(normalizeForDisplay([0.5, 0.25])).toEqual([1.0, 0.5]);
  });
  it("does not mutate the input", () => {
    const input = [0.5, 0.25];
    const out = normalizeForDisplay(input);
    expect(out).toEqual([1.0, 0.5]);
    expect(input).toEqual([0.5, 0.25]);
  });
});

describe("formatClock", () => {
  it("formats as m:ss with zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(14200)).toBe("0:14");
    expect(formatClock(63000)).toBe("1:03");
    expect(formatClock(5 * 60_000 + 9000)).toBe("5:09");
  });
  it("handles negatives and non-finite as 0:00", () => {
    expect(formatClock(-1)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
    expect(formatClock(Infinity)).toBe("0:00");
  });
});
