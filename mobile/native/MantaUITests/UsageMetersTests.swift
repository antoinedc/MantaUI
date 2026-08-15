import XCTest
@testable import MantaUI

// ===========================================================================
// BET-824 — pure decisions of the plan + context meters (UsageMeters). No view,
// no HTTP, no box. Tests every boundary exactly: 69.9/70/89.9/90, a missing
// value rendering nothing (sessionWindow nil), a snapshot holding only a
// weekly window, and `formatReset` under and over 24h.
// ===========================================================================

final class UsageMetersTests: XCTestCase {

    private func window(_ kind: String, pct: Double, resetsAt: Double? = nil) -> UsageWindow {
        UsageWindow(kind: kind, pct: pct, resetsAt: resetsAt)
    }

    private func snapshot(_ windows: [UsageWindow]) -> UsageSnapshot {
        UsageSnapshot(windows: windows)
    }

    // MARK: - band (70 / 90 breakpoints, exact)

    func testBandBelow70IsOk() {
        XCTAssertEqual(UsageMeters.band(69.9), .ok)
        XCTAssertEqual(UsageMeters.band(0), .ok)
    }

    func testBand70To89IsWarn() {
        XCTAssertEqual(UsageMeters.band(70), .warn)
        XCTAssertEqual(UsageMeters.band(89.9), .warn)
    }

    func testBand90AndAboveIsDanger() {
        XCTAssertEqual(UsageMeters.band(90), .danger)
        XCTAssertEqual(UsageMeters.band(100), .danger)
    }

    // MARK: - sessionWindow (the dot's 5-hour window)

    func testSessionWindowPicksKind() {
        let s = snapshot([window("weekly", pct: 82), window("session", pct: 7)])
        XCTAssertEqual(UsageMeters.sessionWindow([s])?.pct, 7)
    }

    /// A snapshot holding ONLY a weekly window → no session window → the dot is
    /// absent (hidden), never a confident green.
    func testSessionWindowNilWhenOnlyWeekly() {
        let s = snapshot([window("weekly", pct: 82)])
        XCTAssertNil(UsageMeters.sessionWindow([s]))
    }

    func testSessionWindowNilWhenNone() {
        XCTAssertNil(UsageMeters.sessionWindow([]))
        XCTAssertNil(UsageMeters.sessionWindow([snapshot([window("daily", pct: 10)])]))
    }

    // MARK: - weeklyWindow

    func testWeeklyWindowPicksKind() {
        let s = snapshot([window("session", pct: 7), window("weekly", pct: 82)])
        XCTAssertEqual(UsageMeters.weeklyWindow([s])?.pct, 82)
    }

    func testWeeklyWindowNilWhenNone() {
        XCTAssertNil(UsageMeters.weeklyWindow([snapshot([window("session", pct: 7)])]))
    }

    // MARK: - shouldShowWeeklyBanner (the one-interrupt gate)

    func testBannerShownAt90() {
        let weekly = window("weekly", pct: 90)
        XCTAssertTrue(UsageMeters.shouldShowWeeklyBanner(weekly, alreadyShown: false))
    }

    func testBannerHiddenBelow90() {
        let weekly = window("weekly", pct: 89.9)
        XCTAssertFalse(UsageMeters.shouldShowWeeklyBanner(weekly, alreadyShown: false))
    }

    func testBannerHiddenOnceShown() {
        let weekly = window("weekly", pct: 95)
        XCTAssertFalse(UsageMeters.shouldShowWeeklyBanner(weekly, alreadyShown: true))
    }

    func testBannerHiddenWhenNoWeekly() {
        XCTAssertFalse(UsageMeters.shouldShowWeeklyBanner(nil, alreadyShown: false))
    }

    // MARK: - formatReset (under / over 24h)

    func testFormatResetUnder24h() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let resetsAt = now.addingTimeInterval(4 * 3600 + 12 * 60)
        XCTAssertEqual(UsageMeters.formatReset(resetsAt, now: now), "in 4h 12m")
    }

    func testFormatResetUnderAnHour() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let resetsAt = now.addingTimeInterval(45 * 60)
        XCTAssertEqual(UsageMeters.formatReset(resetsAt, now: now), "in 45m")
    }

    /// Exactly 24h is NOT under 24h — it flips to the absolute weekday form.
    func testFormatResetAt24hIsAbsolute() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let resetsAt = now.addingTimeInterval(24 * 3600)
        let result = UsageMeters.formatReset(resetsAt, now: now)
        XCTAssertFalse(result.hasPrefix("in "), "24h+ must be an absolute weekday, not a relative countdown")
        XCTAssertTrue(result.contains(":"), "weekday form is 'Thursday 09:00'")
    }

    func testFormatResetBeyond24h() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let resetsAt = now.addingTimeInterval(3 * 24 * 3600)
        let result = UsageMeters.formatReset(resetsAt, now: now)
        XCTAssertFalse(result.hasPrefix("in "))
        XCTAssertTrue(result.contains(":"))
    }

    // MARK: - formatTokens

    func testFormatTokensCompact() {
        XCTAssertEqual(UsageMeters.formatTokens(148_000), "148k")
        XCTAssertEqual(UsageMeters.formatTokens(584_000), "584k")
        XCTAssertEqual(UsageMeters.formatTokens(1_000_000), "1M")
        XCTAssertEqual(UsageMeters.formatTokens(500), "500")
        XCTAssertEqual(UsageMeters.formatTokens(nil), "0")
    }

    // MARK: - staleChipLabel (BET-969)

    private func cache(_ isStale: Bool, staleTokens: Double) -> StreamCachePayload {
        StreamCachePayload(isStale: isStale, idleMs: 0, staleTokens: staleTokens, ttlMs: 0)
    }

    func testStaleChipNilWhenNoCache() {
        XCTAssertNil(UsageMeters.staleChipLabel(nil))
    }

    /// A warm cache never labels, regardless of size.
    func testStaleChipNilWhenWarm() {
        XCTAssertNil(UsageMeters.staleChipLabel(cache(false, staleTokens: 900_000)))
    }

    func testStaleChipFormatsColdTokens() {
        XCTAssertEqual(UsageMeters.staleChipLabel(cache(true, staleTokens: 344_000)), "344k cold")
    }

    /// Proves the chip delegates to `formatTokens` rather than rounding on its
    /// own: whatever the formatter emits is what the label carries.
    func testStaleChipDelegatesToFormatTokens() {
        let value: Double = 148_000
        let label = UsageMeters.staleChipLabel(cache(true, staleTokens: value))
        XCTAssertEqual(label, "\(UsageMeters.formatTokens(value)) cold")
    }

    // MARK: - MeterRing clamp / isFull (BET-877)

    /// `pct` is clamped to 0...100 before drawing — a provider can report
    /// over 100, and a negative never wraps around into a full ring.
    func testMeterRingClampBounds() {
        XCTAssertEqual(MeterRing.clamp(-5), 0)
        XCTAssertEqual(MeterRing.clamp(0), 0)
        XCTAssertEqual(MeterRing.clamp(140), 100)
        XCTAssertEqual(MeterRing.clamp(100), 100)
    }

    /// The ≥100 boundary: 99.9 is still a ring (not full); 100 (and anything
    /// over, once clamped) is a solid disc — a "full" ring would be
    /// indistinguishable from 99%.
    func testMeterRingIsFullBoundary() {
        XCTAssertFalse(MeterRing.isFull(99.9))
        XCTAssertFalse(MeterRing.isFull(0))
        XCTAssertTrue(MeterRing.isFull(100))
        XCTAssertTrue(MeterRing.isFull(120))
    }
}
