// waveform.mjs — shared maths for voice-note waveforms.
//
// Used by the live recorder, the transcript player, and (later) the iOS
// client, which ports this exact spec. Keep it dependency-free and pure so it
// stays portable — same rule voiceClassifier.mjs follows. No I/O, no React.
//
// The peak contract — fixed, do not vary:
//   A voice note's waveform is stored as `Uint8Array`, one byte per sample,
//   0-255, where 255 is full scale. At most VOICE_MAX_STORED_PEAKS samples per
//   note regardless of length (~400 bytes, small enough to keep forever even
//   after the audio is swept).

export const VOICE_SAMPLE_INTERVAL_MS = 40;      // peak capture cadence
export const VOICE_MAX_STORED_PEAKS = 400;       // max samples kept per note
export const VOICE_LIVE_WINDOW_BARS = 90;        // ≈3.6 s visible at 40 ms
export const VOICE_MAX_DURATION_MS = 300_000;    // 5 min hard cap
export const VOICE_WARN_REMAINING_MS = 30_000;   // warn in the last 30 s
export const VOICE_MIN_DURATION_MS = 400;        // shorter is a mis-tap, discarded silently
export const VOICE_CONFIRM_DISCARD_MS = 30_000;  // above this, discard asks for confirmation
export const VOICE_TAP_HOLD_MS = 500;            // key/button: hold >= this = push-to-talk, < this = tap

/**
 * Clamp a float 0..1 to an integer 0..255.
 * `v <= 0 -> 0`, `v >= 1 -> 255`, `NaN -> 0`.
 * @param {number} v
 * @returns {number}
 */
export function quantizePeak(v) {
  if (Number.isNaN(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return Math.round(v * 255);
}

/**
 * Reduce a stream of float peaks (one every VOICE_SAMPLE_INTERVAL_MS) to at
 * most `max` quantized bytes.
 *
 * - `samples.length <= max` -> quantize each and return as-is (do NOT pad).
 * - Otherwise split into exactly `max` contiguous buckets as evenly as
 *   possible and take the MAXIMUM of each bucket, then quantize.
 * - Max, never mean. Averaging flattens speech into a featureless band; the
 *   peak is what makes a waveform look like speech.
 * - Empty input -> empty `Uint8Array`.
 *
 * @param {number[]} samples
 * @param {number} [max]
 * @returns {Uint8Array}
 */
export function downsamplePeaks(samples, max = 400) {
  const n = samples.length;
  if (n === 0) return new Uint8Array(0);
  if (n <= max) return Uint8Array.from(samples, quantizePeak);
  const out = new Uint8Array(max);
  for (let b = 0; b < max; b++) {
    const start = Math.floor((b * n) / max);
    const end = Math.floor(((b + 1) * n) / max);
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (samples[i] > peak) peak = samples[i];
    }
    out[b] = quantizePeak(peak);
  }
  return out;
}

/**
 * Render-time reduction of a stored waveform to a fixed bar count. Returns
 * floats 0..1.
 *
 * - `bars <= 0` or empty input -> `[]`.
 * - Fewer peaks than bars -> one value per peak (the caller draws fewer bars;
 *   it must not stretch).
 * - Otherwise bucket and take the MAXIMUM per bucket, divided by 255.
 *
 * @param {Uint8Array} peaks
 * @param {number} bars
 * @returns {number[]}
 */
export function bucketPeaks(peaks, bars) {
  if (bars <= 0 || peaks.length === 0) return [];
  const n = peaks.length;
  if (n <= bars) return Array.from(peaks, (p) => p / 255);
  const out = new Array(bars);
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * n) / bars);
    const end = Math.floor(((b + 1) * n) / bars);
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (peaks[i] > peak) peak = peaks[i];
    }
    out[b] = peak / 255;
  }
  return out;
}

/**
 * Scale so the loudest bar is 1.0. For the stored/playback waveform only.
 * Empty -> `[]`. Max is 0 -> return all zeros unchanged.
 *
 * This function must NOT be used for the live meter. The live meter pins its
 * ceiling at 1.0 deliberately: renormalising a scrolling window makes every
 * previously-drawn bar jump each time a new loudest sample arrives, and the
 * waveform visibly dances.
 *
 * @param {number[]} values
 * @returns {number[]}
 */
export function normalizeForDisplay(values) {
  const n = values.length;
  if (n === 0) return [];
  let max = 0;
  for (const v of values) {
    if (v > max) max = v;
  }
  if (max === 0) return values.slice();
  return values.map((v) => v / max);
}

/**
 * Format a millisecond duration as `m:ss`, zero-padded seconds, no hours (the
 * cap is VOICE_MAX_DURATION_MS). `0 -> "0:00"`, `14200 -> "0:14"`, `63000 ->
 * "1:03"`. Negative / non-finite -> `"0:00"`.
 *
 * Do NOT consolidate this with `formatDuration` in chatUtils.ts. That one
 * renders `"1m3s"` for turn durations and is used elsewhere (turn list). This
 * is a different format for a different job; the near-duplicate is
 * intentional.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}
