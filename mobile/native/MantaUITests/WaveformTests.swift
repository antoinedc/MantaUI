import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1027 — the Swift port of src/shared/waveform.mjs is checked against the
// SAME table as the JS side (src/shared/waveform.test.ts), so both sides of
// the peak contract stay honest: one byte per sample 0...255, max per bucket
// (never mean), at most VOICE_MAX_STORED_PEAKS stored per note.
// ===========================================================================

final class WaveformTests: XCTestCase {

    // MARK: - constants

    func testSharedConstants() {
        XCTAssertEqual(Waveform.Constants.sampleIntervalMs, 40)
        XCTAssertEqual(Waveform.Constants.maxStoredPeaks, 400)
        XCTAssertEqual(Waveform.Constants.liveWindowBars, 90)
        XCTAssertEqual(Waveform.Constants.maxDurationMs, 300_000)
        XCTAssertEqual(Waveform.Constants.warnRemainingMs, 30_000)
        XCTAssertEqual(Waveform.Constants.minDurationMs, 400)
        XCTAssertEqual(Waveform.Constants.confirmDiscardMs, 30_000)
        XCTAssertEqual(Waveform.Constants.tapHoldMs, 250)
    }

    // MARK: - quantizePeak

    func testQuantizePeakClampsAtBounds() {
        XCTAssertEqual(Waveform.quantizePeak(0), 0)
        XCTAssertEqual(Waveform.quantizePeak(-1), 0)
        XCTAssertEqual(Waveform.quantizePeak(1), 255)
        XCTAssertEqual(Waveform.quantizePeak(2), 255)
    }

    func testQuantizePeakNaN() {
        XCTAssertEqual(Waveform.quantizePeak(Double.nan), 0)
    }

    func testQuantizePeakRoundsInterior() {
        XCTAssertEqual(Waveform.quantizePeak(0.5), 128)
        XCTAssertEqual(Waveform.quantizePeak(0.1), 26)
    }

    // MARK: - downsamplePeaks

    func testDownsamplePeaksEmpty() {
        XCTAssertEqual(Waveform.downsamplePeaks([]), [])
    }

    func testDownsamplePeaksNoPadWhenAtOrBelowMax() {
        XCTAssertEqual(Waveform.downsamplePeaks([0, 0.5, 1], max: 400), [0, 128, 255])
    }

    func testDownsamplePeaksCapsAtMax() {
        let samples = [Double](repeating: 0.5, count: 7500)
        let out = Waveform.downsamplePeaks(samples, max: 400)
        XCTAssertEqual(out.count, 400)
        XCTAssertEqual(out[0], 128)
    }

    /// A single loud sample inside a quiet bucket survives — proves MAX, not
    /// mean. (A mean implementation would flatten it to ~25 and this test fails.)
    func testDownsamplePeaksTakesMaxNotMean() {
        let out = Waveform.downsamplePeaks([0.1, 0.1, 0.1, 1.0, 0.1, 0.1], max: 2)
        XCTAssertEqual(out, [26, 255])
    }

    // MARK: - bucketPeaks

    func testBucketPeaksEmptyForNonPositiveBars() {
        XCTAssertEqual(Waveform.bucketPeaks([1, 2], bars: 0), [])
        XCTAssertEqual(Waveform.bucketPeaks([1, 2], bars: -3), [])
    }

    func testBucketPeaksEmptyForEmptyInput() {
        XCTAssertEqual(Waveform.bucketPeaks([], bars: 10), [])
    }

    func testBucketPeaksNoStretchWhenFewerPeaksThanBars() {
        XCTAssertEqual(Waveform.bucketPeaks([255, 0], bars: 10), [1, 0])
        XCTAssertEqual(Waveform.bucketPeaks([255], bars: 5), [1])
    }

    func testBucketPeaksTakesMaxPerBucketDividedBy255() {
        let peaks: [UInt8] = [26, 51, 77, 102, 128, 153, 179, 204, 230, 255]
        // buckets of widths 3,3,4 → max(0..2)=77, max(3..5)=153, max(6..9)=255
        let expected: [Double] = [77.0 / 255.0, 153.0 / 255.0, 255.0 / 255.0]
        let out = Waveform.bucketPeaks(peaks, bars: 3)
        XCTAssertEqual(out.count, expected.count)
        for (a, b) in zip(out, expected) {
            XCTAssertEqual(a, b, accuracy: 0.000001)
        }
    }

    // MARK: - normalizeForDisplay

    func testNormalizeForDisplayEmpty() {
        XCTAssertEqual(Waveform.normalizeForDisplay([]), [])
    }

    func testNormalizeForDisplayAllZeroUnchanged() {
        XCTAssertEqual(Waveform.normalizeForDisplay([0, 0, 0]), [0, 0, 0])
    }

    func testNormalizeForDisplayLoudestBecomesOne() {
        let out = Waveform.normalizeForDisplay([0.5, 0.25])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0], 1.0, accuracy: 0.000001)
        XCTAssertEqual(out[1], 0.5, accuracy: 0.000001)
    }

    func testNormalizeForDisplayDoesNotMutateInput() {
        let input = [0.5, 0.25]
        _ = Waveform.normalizeForDisplay(input)
        XCTAssertEqual(input, [0.5, 0.25])
    }

    // MARK: - formatClock

    func testFormatClockBasic() {
        XCTAssertEqual(Waveform.formatClock(0), "0:00")
        XCTAssertEqual(Waveform.formatClock(14200), "0:14")
        XCTAssertEqual(Waveform.formatClock(63000), "1:03")
    }

    func testFormatClockNegative() {
        XCTAssertEqual(Waveform.formatClock(-5), "0:00")
    }

    func testFormatClockAtCap() {
        XCTAssertEqual(Waveform.formatClock(Waveform.Constants.maxDurationMs), "5:00")
    }
}
