import XCTest
@testable import MantaUI

// ===========================================================================
// BET-824 — pure decisions of the plan + context meters (UsageMeters). No view,
// no HTTP, no box. Tests every boundary exactly: 69.9/70/89.9/90, a missing
// value rendering nothing (sessionWindow nil), a snapshot holding only a
// weekly window, the reset-distance ladder (BET-967) and the stale-window
// banner gate (BET-965/967).
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

    /// A STALE weekly window (reset instant already passed, provider hasn't
    /// published the new numbers yet) must not raise the ≥90% banner — the pct
    /// still belongs to the window that just ended (BET-965/967).
    func testBannerHiddenWhenWeeklyStale() {
        var weekly = window("weekly", pct: 95)
        weekly.stale = true
        XCTAssertFalse(UsageMeters.shouldShowWeeklyBanner(weekly, alreadyShown: false))
    }

    /// Sanity: a FRESH 95% window still raises the banner even at the same pct.
    func testBannerShownWhenWeeklyFresh() {
        let weekly = window("weekly", pct: 95)
        XCTAssertTrue(UsageMeters.shouldShowWeeklyBanner(weekly, alreadyShown: false))
    }

    // MARK: - resetDistance (exact desktop ladder — BET-966/967)

    /// Exact strings, mirroring the desktop `formatResetDistance` table
    /// including the drop-zero and the motivating 140h 12m cases.
    func testResetDistanceExactLadder() {
        XCTAssertEqual(UsageMeters.resetDistance(0), "now")
        XCTAssertEqual(UsageMeters.resetDistance(-5), "now")
        XCTAssertEqual(UsageMeters.resetDistance(30), "under a minute")
        XCTAssertEqual(UsageMeters.resetDistance(45 * 60), "45m")
        XCTAssertEqual(UsageMeters.resetDistance(2 * 3600 + 10 * 60), "2h10m")
        XCTAssertEqual(UsageMeters.resetDistance(3 * 3600), "3h")
        XCTAssertEqual(UsageMeters.resetDistance(26 * 3600), "1d2h")
        XCTAssertEqual(UsageMeters.resetDistance(48 * 3600), "2d")
        XCTAssertEqual(UsageMeters.resetDistance(140 * 3600 + 12 * 60), "5d20h")
    }

    // MARK: - resetAt / formatReset (shape only — locale-fixed, BET-967)

    /// The absolute anchor is device-locale: all three tiers render non-empty,
    /// and the same-day tier carries no calendar date.
    func testResetAtTiersNonEmpty() {
        let now = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        XCTAssertFalse(UsageMeters.resetAt(now.addingTimeInterval(2 * 3600), now: now).isEmpty)
        XCTAssertFalse(UsageMeters.resetAt(now.addingTimeInterval(24 * 3600), now: now).isEmpty)
        XCTAssertFalse(UsageMeters.resetAt(now.addingTimeInterval(10 * 24 * 3600), now: now).isEmpty)
    }

    /// A same-local-day reset has no anchor — no "(" — and reads "in <distance>".
    func testFormatResetSameDayNoAnchor() {
        let now = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        let resetsAt = now.addingTimeInterval(2 * 3600)
        let result = UsageMeters.formatReset(resetsAt, now: now)
        XCTAssertFalse(result.contains("("), "same-day reset must not append an anchor, got: \(result)")
        XCTAssertTrue(result.contains(UsageMeters.resetDistance(Int(resetsAt.timeIntervalSince(now)))))
    }

    /// A cross-day reset appends " (…)" and still contains the distance.
    func testFormatResetCrossDayHasAnchor() {
        let now = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        let resetsAt = now.addingTimeInterval(3 * 24 * 3600)
        let result = UsageMeters.formatReset(resetsAt, now: now)
        XCTAssertTrue(result.contains("("), "cross-day reset must append an anchor, got: \(result)")
        XCTAssertTrue(result.contains(")"))
        XCTAssertTrue(result.contains(UsageMeters.resetDistance(Int(resetsAt.timeIntervalSince(now)))))
    }

    /// A reset instant that has already passed reads exactly "resetting…".
    func testFormatResetPastIsResetting() {
        let now = Date()
        let resetsAt = now.addingTimeInterval(-60)
        XCTAssertEqual(UsageMeters.formatReset(resetsAt, now: now), "resetting…")
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

    // MARK: - shouldShowContext (BET-1022)

    /// A fresh session with no billed turn reports 0%; a "Context 0%" row is
    /// noise and must not render. `nil` (unknown) and non-finite values never
    /// render either. Anything above zero renders.
    func testShouldShowContextGate() {
        XCTAssertFalse(UsageMeters.shouldShowContext(pct: nil))
        XCTAssertFalse(UsageMeters.shouldShowContext(pct: 0))
        XCTAssertFalse(UsageMeters.shouldShowContext(pct: Double.nan))
        XCTAssertFalse(UsageMeters.shouldShowContext(pct: Double.infinity))
        XCTAssertTrue(UsageMeters.shouldShowContext(pct: 0.4))
        XCTAssertTrue(UsageMeters.shouldShowContext(pct: 100))
    }
}
