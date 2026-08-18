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

    // MARK: - recompute (BET-1086 — selected-model context breakdown)

    /// A payload shaped like the box's `opencode:context` — raw counts plus the
    /// derived `pct`/`segments` the box computed against the LAST-REPLY model's
    /// window. `totalInput` mirrors the box summing the three disjoint buckets.
    private func payload(fresh: Double = 0, read: Double = 0, write: Double = 0,
                         pct: Double = 0, hasLimit: Bool = true,
                         segments: [StreamContextSegment]) -> StreamContextPayload {
        StreamContextPayload(
            freshInput: fresh,
            cacheRead: read,
            cacheWrite: write,
            totalInput: fresh + read + write,
            pct: pct,
            hasLimit: hasLimit,
            segments: segments
        )
    }

    /// The reported bug, stated as a test: a 200k-window payload (the box read
    /// 40k tokens, 20% of 200k) recomputed against the user's SELECTED 1M
    /// window is one fifth as full — the percentage changes with the model,
    /// with no new reply and no refetch.
    func testRecomputeChangesPctWithSelectedModel() {
        let s = payload(fresh: 40_000, pct: 20,
                        segments: [StreamContextSegment(kind: "fresh", pct: 20)])
        let r = UsageMeters.recompute(s, limit: 1_000_000)
        XCTAssertEqual(r.pct, 4)
        XCTAssertEqual(r.segments.first { $0.kind == "fresh" }?.pct, 4)
        XCTAssertEqual(r.hasLimit, true)
    }

    /// The box drives the unknown signal (`hasLimit:false`), and recompute must
    /// preserve it — it never re-derives "no max context" from the SELECTED
    /// model's window (BET-1138: use hasLimit from the payload, no second
    /// unknown representation). Raw token totals ride through, derived fields
    /// stay empty.
    func testRecomputePreservesUnknownWhenPayloadHasNoLimit() {
        let s = payload(fresh: 10_000, read: 30_000, write: 5_000, pct: 0,
                        hasLimit: false, segments: [])
        let r = UsageMeters.recompute(s, limit: 1_000_000)
        XCTAssertEqual(r.hasLimit, false)
        XCTAssertEqual(r.pct, 0)
        XCTAssertEqual(r.segments, [])
        XCTAssertEqual(r.totalInput, 45_000)
    }

    /// `limit: nil` (an unknown SELECTED-model window) does NOT turn a known
    /// box reading into "no max context": the box already flagged hasLimit:true,
    /// so recompute keeps it and sizes the bar against the assumed 200k — the
    /// unknown-type signal is the box's hasLimit:false, not this pct.
    func testRecomputeNilLimitKeepsKnownPct() {
        let s = payload(fresh: 10_000, read: 30_000, write: 5_000, pct: 23,
                        segments: [
                            StreamContextSegment(kind: "fresh", pct: 5),
                            StreamContextSegment(kind: "cacheWrite", pct: 2.5),
                            StreamContextSegment(kind: "cacheRead", pct: 15),
                        ])
        let r = UsageMeters.recompute(s, limit: nil)
        XCTAssertEqual(r.hasLimit, true)
        XCTAssertEqual(r.pct, 23) // 45_000 / 200_000 → 22.5 → 23
        XCTAssertEqual(r.segments.map(\.pct), [5, 2.5, 15])
        XCTAssertEqual(r.totalInput, 45_000)
    }

    /// A zero or negative SELECTED-model limit likewise keeps a box-confirmed
    /// hasLimit:true, bar-sized against the assumed 200k — never NaN, and
    /// never an invented "no max context" (that stays the box's call).
    func testRecomputeNonPositiveLimitKeepsKnownPct() {
        let s = payload(fresh: 100_000, pct: 50,
                        segments: [StreamContextSegment(kind: "fresh", pct: 50)])
        for limit in [0.0, -200_000.0] {
            let r = UsageMeters.recompute(s, limit: limit)
            XCTAssertEqual(r.hasLimit, true)
            XCTAssertEqual(r.pct, 50) // 100_000 / 200_000 → 50
        }
    }

    /// The raw counts ride through untouched — only the derived fields change.
    func testRecomputeCopiesRawCountsThrough() {
        let s = payload(fresh: 20_000, read: 60_000, write: 20_000, pct: 50,
                        segments: [StreamContextSegment(kind: "fresh", pct: 20)])
        let r = UsageMeters.recompute(s, limit: 1_000_000)
        XCTAssertEqual(r.freshInput, 20_000)
        XCTAssertEqual(r.cacheRead, 60_000)
        XCTAssertEqual(r.cacheWrite, 20_000)
        XCTAssertEqual(r.totalInput, 100_000)
    }

    /// Over-context: `totalInput` clamps `pct` to 100 and the segment widths
    /// rescale so they never sum past 100. Oracle: clamps-pct-to-100 case.
    func testRecomputeClampsPctAndSegmentsWhenOverContext() {
        let s = payload(fresh: 250_000, pct: 100,
                        segments: [StreamContextSegment(kind: "fresh", pct: 125)])
        let r = UsageMeters.recompute(s, limit: 200_000)
        XCTAssertEqual(r.pct, 100)
        XCTAssertLessThanOrEqual(r.segments.reduce(0) { $0 + $1.pct }, 100 + 0.001)
    }

    /// Zero tokens yields 0% and zero-width segments — never NaN.
    func testRecomputeZeroTokensIsZeroNotNaN() {
        let r = UsageMeters.recompute(payload(segments: []), limit: 200_000)
        XCTAssertEqual(r.pct, 0)
        XCTAssertFalse(r.pct.isNaN)
        XCTAssertTrue(r.segments.allSatisfy { $0.pct == 0 })
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
