// Hand-written type declarations for waveform.mjs. The implementation is
// plain JS so it can be imported by both Node-side modules (.mjs natively,
// .ts via Bundler resolution) and the renderer test suite (vitest .ts file).
// Keep this in sync with src/shared/waveform.mjs.

export const VOICE_SAMPLE_INTERVAL_MS: number;
export const VOICE_MAX_STORED_PEAKS: number;
export const VOICE_LIVE_WINDOW_BARS: number;
export const VOICE_MAX_DURATION_MS: number;
export const VOICE_WARN_REMAINING_MS: number;
export const VOICE_MIN_DURATION_MS: number;
export const VOICE_CONFIRM_DISCARD_MS: number;
export const VOICE_TAP_HOLD_MS: number;

export function quantizePeak(v: number): number;

export function downsamplePeaks(samples: number[], max?: number): Uint8Array;

export function bucketPeaks(peaks: Uint8Array, bars: number): number[];

export function normalizeForDisplay(values: number[]): number[];

export function formatClock(ms: number): string;
