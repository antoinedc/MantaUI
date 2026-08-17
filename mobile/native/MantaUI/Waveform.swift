import Foundation

// ===========================================================================
// Waveform.swift — shared maths for voice-note waveforms (pure port of
// `src/shared/waveform.mjs`).
//
// Used by the live recorder, the transcript player and the waveform view. A
// voice note recorded on the phone must render identically on desktop, so the
// peak contract is fixed and not negotiable: maximum per bucket (never the
// mean), one byte per sample, `0...255`, at most `VOICE_MAX_STORED_PEAKS`
// stored per note. Keep every implementation greppable as a pair with its JS
// sibling (`quantizePeak`, `downsamplePeaks`, `bucketPeaks`,
// `normalizeForDisplay`, `formatClock`).
//
// Deliberately pure — no AVFoundation, no SwiftUI, no timers.
// ===========================================================================

enum Waveform {

    /// The shared voice constants. LAW — ported from `src/shared/waveform.mjs`,
    /// do not choose your own.
    enum Constants {
        static let sampleIntervalMs = 40          // peak capture cadence
        static let maxStoredPeaks = 400           // max samples kept per note
        static let liveWindowBars = 90            // ≈3.6 s visible at 40 ms
        static let maxDurationMs = 300_000        // 5 min hard cap
        static let warnRemainingMs = 30_000       // warn in the last 30 s
        static let minDurationMs = 400            // shorter is a mis-tap, discarded silently
        static let confirmDiscardMs = 30_000      // above this, discard asks for confirmation
        static let tapHoldMs = 250                // held this long = push-to-talk (stop+send), shorter = a tap (toggle)
    }

    /// Clamp a float `0...1` to an integer `0...255`.
    /// `v <= 0 -> 0`, `v >= 1 -> 255`, `NaN -> 0`.
    static func quantizePeak(_ v: Double) -> UInt8 {
        if v.isNaN { return 0 }
        if v <= 0 { return 0 }
        if v >= 1 { return 255 }
        return UInt8((v * 255).rounded())
    }

    /// Reduce a stream of float peaks (one every `VOICE_SAMPLE_INTERVAL_MS`)
    /// to at most `max` quantized bytes.
    ///
    /// - `samples.count <= max` -> quantize each and return as-is (do NOT pad).
    /// - Otherwise split into exactly `max` contiguous buckets as evenly as
    ///   possible and take the MAXIMUM of each bucket, then quantize.
    /// - Max, never mean. Averaging flattens speech into a featureless band;
    ///   the peak is what makes a waveform look like speech.
    /// - Empty input -> empty.
    static func downsamplePeaks(_ samples: [Double], max: Int = Waveform.Constants.maxStoredPeaks) -> [UInt8] {
        let n = samples.count
        if n == 0 { return [] }
        if n <= max { return samples.map { quantizePeak($0) } }
        var out = [UInt8](repeating: 0, count: max)
        for b in 0..<max {
            let start = (b * n) / max
            let end = ((b + 1) * n) / max
            var peak: Double = 0
            for i in start..<end {
                if samples[i] > peak { peak = samples[i] }
            }
            out[b] = quantizePeak(peak)
        }
        return out
    }

    /// Render-time reduction of a stored waveform to a fixed bar count.
    /// Returns floats `0...1`.
    ///
    /// - `bars <= 0` or empty input -> `[]`.
    /// - Fewer peaks than bars -> one value per peak (the caller draws fewer
    ///   bars; it must not stretch).
    /// - Otherwise bucket and take the MAXIMUM per bucket, divided by 255.
    static func bucketPeaks(_ peaks: [UInt8], bars: Int) -> [Double] {
        if bars <= 0 || peaks.isEmpty { return [] }
        let n = peaks.count
        if n <= bars { return peaks.map { Double($0) / 255.0 } }
        var out = [Double](repeating: 0, count: bars)
        for b in 0..<bars {
            let start = (b * n) / bars
            let end = ((b + 1) * n) / bars
            var peak: UInt8 = 0
            for i in start..<end {
                if peaks[i] > peak { peak = peaks[i] }
            }
            out[b] = Double(peak) / 255.0
        }
        return out
    }

    /// Scale so the loudest bar is `1.0`. For the stored/playback waveform
    /// only. Empty -> `[]`. Max is 0 -> return all zeros unchanged.
    ///
    /// This function must NOT be used for the live meter. The live meter pins
    /// its ceiling at 1.0 deliberately: renormalising a scrolling window makes
    /// every previously-drawn bar jump each time a new loudest sample arrives,
    /// and the waveform visibly dances. (Rationale preserved from the JS doc
    /// comment; the shared module's own comment, mirrored here.)
    static func normalizeForDisplay(_ values: [Double]) -> [Double] {
        let n = values.count
        if n == 0 { return [] }
        var maxValue: Double = 0
        for v in values { if v > maxValue { maxValue = v } }
        if maxValue == 0 { return values }
        return values.map { $0 / maxValue }
    }

    /// Format a millisecond duration as `m:ss`, zero-padded seconds, no hours
    /// (the cap is `VOICE_MAX_DURATION_MS`). `0 -> "0:00"`, `14200 -> "0:14"`,
    /// `63000 -> "1:03"`. Negative -> `"0:00"`.
    static func formatClock(_ ms: Int) -> String {
        if ms < 0 { return "0:00" }
        let total = ms / 1000
        let min = total / 60
        let sec = total % 60
        return String(format: "%d:%02d", min, sec)
    }
}
