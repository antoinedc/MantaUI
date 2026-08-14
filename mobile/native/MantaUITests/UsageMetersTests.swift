import XCTest
@testable import MantaUI

// ===========================================================================
// BET-824 — pure decisions of the plan + context meters (UsageMeters). No view,
// no HTTP, no box. Tests every boundary exactly: 69.9/70/89.9/90, `unknown`
// never banding to `ok` (contextStripVisible / band never fed unknown),
// `absent` hiding the dot (sessionWindow nil), a snapshot holding only a
// weekly window, `formatReset` under and over 24h, and `alwaysShow` overriding
// the 70% gate.
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

    // MARK: - contextStripVisible (70% gate + alwaysShow override)

    func testStripHiddenBelow70() {
        XCTAssertEqual(UsageMeters.contextStripVisible(.known(pct: 69.9), alwaysShow: false), false)
    }

    func testAlwaysShowOverrides70Gate() {
        XCTAssertEqual(UsageMeters.contextStripVisible(.known(pct: 69.9), alwaysShow: true), true)
    }

    func testStripShownAt70() {
        XCTAssertEqual(UsageMeters.contextStripVisible(.known(pct: 70), alwaysShow: false), true)
        XCTAssertEqual(UsageMeters.contextStripVisible(.known(pct: 89.9), alwaysShow: false), true)
        XCTAssertEqual(UsageMeters.contextStripVisible(.known(pct: 90), alwaysShow: false), true)
    }

    /// `unknown` never reads as a confident meter, even when alwaysShow is on —
    /// a "we don't know" must not look like a healthy 0%.
    func testUnknownNeverShownEvenWithAlwaysShow() {
        XCTAssertEqual(UsageMeters.contextStripVisible(.unknown, alwaysShow: true), false)
        XCTAssertEqual(UsageMeters.contextStripVisible(.unknown, alwaysShow: false), false)
    }

    func testAbsentNeverShown() {
        XCTAssertEqual(UsageMeters.contextStripVisible(.absent, alwaysShow: true), false)
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
}
