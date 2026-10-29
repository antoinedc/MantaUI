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

    // MARK: - providerLabel (BET-1130 — mirrors the desktop dial lookup)

    /// The three known adapters map to their spoken names, matching
    /// `providerLabel` in src/renderer/UsageDial.tsx exactly.
    func testProviderLabelKnownAdapters() {
        XCTAssertEqual(UsageMeters.providerLabel("claude"), "Claude")
        XCTAssertEqual(UsageMeters.providerLabel("codex"), "OpenAI")
        XCTAssertEqual(UsageMeters.providerLabel("kimi"), "Kimi")
    }

    /// An unknown adapter id is capitalised (first char upper, rest unchanged)
    /// so a 4th adapter needs no client change — same fallback as the desktop.
    func testProviderLabelUnknownCapitalised() {
        XCTAssertEqual(UsageMeters.providerLabel("openai"), "Openai")
        XCTAssertEqual(UsageMeters.providerLabel("deepseek"), "Deepseek")
    }

    /// A missing/empty provider yields "" — never a crash or "null".
    func testProviderLabelMissingIsEmpty() {
        XCTAssertEqual(UsageMeters.providerLabel(nil), "")
        XCTAssertEqual(UsageMeters.providerLabel(""), "")
    }

    // MARK: - staleChipLabel / isCold (WS11 D2 — the box sends the instant)

    private func cache(staleAt: Double?, staleTokens: Double) -> StreamCachePayload {
        StreamCachePayload(isStale: false, idleMs: 0, staleTokens: staleTokens, ttlMs: 300_000, lastCompleted: 1_000, staleAt: staleAt)
    }

    private func at(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    func testStaleChipNilWhenNoCache() {
        XCTAssertNil(UsageMeters.staleChipLabel(nil, now: at(5_000)))
    }

    func testColdFlipsAtTheBoxInstantWithoutANewFrame() {
        let c = cache(staleAt: 301_000, staleTokens: 344_000)
        XCTAssertNil(UsageMeters.staleChipLabel(c, now: at(300_999)))
        XCTAssertEqual(UsageMeters.staleChipLabel(c, now: at(301_000)), "344k cold")
        XCTAssertEqual(UsageMeters.staleChipLabel(c, now: at(900_000)), "344k cold")
    }

    func testNoStaleAtIsNeverCold() {
        XCTAssertFalse(UsageMeters.isCold(cache(staleAt: nil, staleTokens: 900_000), now: at(9_999_999)))
    }

    /// An old box's frame (no `staleAt`) decodes and is never cold; a new frame decodes both.
    func testCachePayloadDecodesOldAndNewShapes() throws {
        let old = try JSONDecoder().decode(StreamCachePayload.self, from: Data(#"{"isStale":false,"idleMs":0,"staleTokens":10,"ttlMs":300000}"#.utf8))
        XCTAssertNil(old.staleAt)
        XCTAssertFalse(UsageMeters.isCold(old, now: at(9_999_999_999)))
        let new = try JSONDecoder().decode(StreamCachePayload.self, from: Data(#"{"isStale":false,"idleMs":0,"staleTokens":10,"ttlMs":300000,"lastCompleted":5,"staleAt":300005}"#.utf8))
        XCTAssertEqual(new.staleAt, 300_005)
        XCTAssertEqual(new.lastCompleted, 5)
    }

    func testContextPayloadDecodesTheSelectedModelFields() throws {
        let json = #"{"freshInput":1,"cacheRead":2,"cacheWrite":3,"totalInput":6,"pct":1,"hasLimit":true,"segments":[],"limit":1000000,"model":{"providerID":"anthropic","modelID":"opus"},"basis":"selected"}"#
        let ctx = try JSONDecoder().decode(StreamContextPayload.self, from: Data(json.utf8))
        XCTAssertEqual(ctx.limit, 1_000_000)
        XCTAssertEqual(ctx.model, StreamContextModel(providerID: "anthropic", modelID: "opus"))
        XCTAssertEqual(ctx.basis, "selected")
        let old = try JSONDecoder().decode(StreamContextPayload.self, from: Data(#"{"freshInput":1,"cacheRead":2,"cacheWrite":3,"totalInput":6,"pct":1,"hasLimit":true,"segments":[]}"#.utf8))
        XCTAssertNil(old.limit)
        XCTAssertNil(old.basis)
    }

    // WS11 D2 review #7: the box sends `pct: null` when the selected model's limit is unknown; it must decode (a
    // failed decode blanked the meter and made the unknown-limit UI unreachable).
    func testContextPayloadDecodesAnUnknownLimit() throws {
        let json = #"{"freshInput":1,"cacheRead":2,"cacheWrite":3,"totalInput":6,"pct":null,"hasLimit":false,"segments":[],"model":{"providerID":"x","modelID":"y"},"basis":"selected"}"#
        let ctx = try JSONDecoder().decode(StreamContextPayload.self, from: Data(json.utf8))
        XCTAssertNil(ctx.pct)
        XCTAssertFalse(ctx.hasLimit)
        XCTAssertFalse(UsageMeters.shouldShowContext(pct: ctx.pct))
    }

    // Decision 4: the sheet names the model the BOX measured, and says so when it was the last reply's.
    func testContextSheetNamesTheMeasuredModel() {
        let models = [OpencodeModel(id: "opus", providerID: "anthropic", name: "Claude Opus")]
        let opus = StreamContextModel(providerID: "anthropic", modelID: "opus")
        XCTAssertEqual(ChatModel.contextModelLabel(models, measured: opus, basis: "selected", fallback: "Other"), "Claude Opus")
        XCTAssertEqual(ChatModel.contextModelLabel(models, measured: opus, basis: "last-used", fallback: "Other"), "Claude Opus (last reply's model)")
        XCTAssertEqual(ChatModel.contextModelLabel(models, measured: StreamContextModel(providerID: "x", modelID: "mystery"), basis: nil, fallback: "Other"), "mystery")
        XCTAssertEqual(ChatModel.contextModelLabel(models, measured: nil, basis: nil, fallback: "Other"), "Other", "an older box sends no model")
    }

    func testIdleMsReadsTheInstantAgainstTheClock() {
        let c = cache(staleAt: 301_000, staleTokens: 1)
        XCTAssertEqual(UsageMeters.idleMs(c, now: at(61_000)), 60_000)
    }

    // MARK: - MeterRing clamp / isFull (BET-877)

    /// `pct` is clamped to 0...100 before drawing — a provider can report
    /// over 100, and a negative never wraps around into a full ring.
    func testMeterRingClampBounds() {
        XCTAssertEqual(UsageMeters.clamp(-5), 0)
        XCTAssertEqual(UsageMeters.clamp(0), 0)
        XCTAssertEqual(UsageMeters.clamp(140), 100)
        XCTAssertEqual(UsageMeters.clamp(100), 100)
    }

    /// The ≥100 boundary: 99.9 is still a ring (not full); 100 (and anything
    /// over, once clamped) is a solid disc — a "full" ring would be
    /// indistinguishable from 99%.
    func testMeterRingIsFullBoundary() {
        XCTAssertFalse(UsageMeters.isFull(99.9))
        XCTAssertFalse(UsageMeters.isFull(0))
        XCTAssertTrue(UsageMeters.isFull(100))
        XCTAssertTrue(UsageMeters.isFull(120))
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

    // MARK: - band(window) — the BOX's tone, never a client computation (WS09 SF-M18)

    func testBandFromTheBoxsTone() {
        func tone(_ t: String?, pct: Double = 50) -> UsageWindow {
            UsageWindow(kind: "session", pct: pct, tone: t)
        }
        XCTAssertEqual(UsageMeters.band(tone("under")), .ok)
        XCTAssertEqual(UsageMeters.band(tone("warn")), .warn)
        XCTAssertEqual(UsageMeters.band(tone("danger")), .danger)
        XCTAssertEqual(UsageMeters.band(tone("over")), .danger)
    }

    /// An older box sends no tone: the window has no band (callers tint it neutral)
    /// even when its percentage would have banded red — the colour is the box's call.
    func testWindowWithoutToneHasNoBand() {
        XCTAssertNil(UsageMeters.band(UsageWindow(kind: "session", pct: 99)))
        XCTAssertNil(UsageMeters.band(UsageWindow(kind: "session", pct: 99, tone: "unheard-of")))
    }

    func testToneDecodesWhenPresentAndIsNilWhenAbsent() throws {
        let with = try JSONDecoder().decode(UsageWindow.self, from: Data(#"{"kind":"weekly","pct":91,"tone":"danger"}"#.utf8))
        XCTAssertEqual(with.tone, "danger")
        let without = try JSONDecoder().decode(UsageWindow.self, from: Data(#"{"kind":"weekly","pct":91}"#.utf8))
        XCTAssertNil(without.tone)
    }
}
