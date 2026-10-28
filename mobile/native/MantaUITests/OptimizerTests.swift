import XCTest
@testable import MantaUI

// WS09 F3 — chart geometry (the only optimizer logic left on the phone) and the
// decoding of the box's `view` blocks (fixtures = real output of
// src/server/optimizer/view.mjs).

private enum OptFx {
    static let summary = #"""
{"supported":true,"view":{"switch":{"on":true,"label":"On","body":"Manta trims, paces and compacts your conversations to make a plan last longer. It never changes which model you picked by hand. Everything it changes is listed below."},"subrows":[{"id":"pacing","name":"Pacing","text":"Cheaper models while a plan window is ahead of pace. Build and plan work keeps its quality floor.","chip":"eco · +6 pts ahead of pace"},{"id":"compacting","name":"Compacting","text":"Long idle conversations are summarized in the background, before you come back to them.","chip":"3 of 5 in background"},{"id":"cache","name":"Prompt cache","text":"Reads billed at 0.1×; TTL 5m measured.","chip":"74% hit"}],"windowsCaption":"Forecast from your recent usage. Tick = forecast at reset. Pressure chip = how far ahead of pace this window is right now.","windows":[{"key":"claude:session","title":"Max 20x — Session (5h)","resetsAt":1761660000000,"pct":62,"pctLabel":"62% used","band":"warn","forecastPct":88,"forecastWarn":true,"forecastLabel":"forecast 88%","pressure":{"text":"+6 pts ahead of pace","tone":"warn"}},{"key":"claude:weekly","title":"Max 20x — Weekly","resetsAt":null,"pct":90,"pctLabel":"90% used","band":"danger","forecastPct":null,"forecastWarn":false,"forecastLabel":"gathering history…","pressure":{"text":"no pressure signal yet","tone":"neutral"}}],"metered":[{"name":"Endpoint A","role":"fast","price":"$1/M"}],"meteredCaption":"Pay-per-token endpoints have no window and never reset, so there is nothing to fill — only a role and the price at which they beat the subscription.","activity":[{"id":"a1","ts":1761650000000,"headline":"Kept — eco level 2","detail":"Turns 62 · Hit 74.1%","rolledBack":false},{"id":"a2","ts":1761640000000,"headline":"Rolled back — x","detail":"","rolledBack":true}],"activityCaption":"Every parameter change the optimizer made on its own, with the evidence it used. Rolled-back entries stay — that is the point.","activityEmpty":"Nothing changed yet. Manta needs a few days of your usage before it starts tuning anything.","stats":[{"id":"cacheHit","label":"Cache hit","value":"74%","detail":"TTL 5m measured · 30d","tone":"neutral"},{"id":"sessions","label":"Sessions","value":"3","detail":"3 of 5 in background · 30d","tone":"neutral"}]}}
"""#
    static let series = #"""
{"supported":true,"range":"24h","bucket":"hour","series":[{"t":1761600000000,"tokensSent":100,"actualTrimmedTokens":0,"potentialTrimmedTokens":0,"maskedTokens":0},{"t":1761603600000,"tokensSent":200,"actualTrimmedTokens":50,"potentialTrimmedTokens":0,"maskedTokens":0}],"counterfactualAvailable":true,"totals":{"turns":10,"cost":1.5,"tokensSent":300,"actualTrimmedTokens":50,"potentialTrimmedTokens":20,"maskedTokens":0,"rewarmTokens":0},"saved":{"usd":3.4,"potentialUsd":4.5,"pricedShare":0.8,"basis":"measured"},"view":{"heading":"Token consumption — with & without optimization","trimming":{"name":"Trimming","text":"Old tool output is replaced by a one-line placeholder after a few newer tool uses. The last 40k tokens are never touched.","chip":"−14% sent"},"hasCounterfactual":true,"noActivity":false,"emptyText":"No model activity in the last 24h.","legend":{"sent":"sent","raw":"raw counterfactual — same turns, nothing trimmed (est.)","noCounterfactual":null},"savingLabel":{"text":"−50 tokens · ≈ $3.40 est.","tone":"ok"},"potentialLine":null,"rawValues":[100,250],"stats":[{"id":"sent","label":"Sent (24h)","value":"300 tokens","detail":"raw 350 tokens","tone":"neutral"},{"id":"saved","label":"Saved (est.)","value":"≈ $3.40","detail":"≈$4.50 potential","tone":"ok"},{"id":"costPerTurn","label":"Cost / turn","value":"$0.15","detail":"24h average","tone":"neutral"}]}}
"""#
    static let summaryOld = #"""
{"supported":true}
"""#
    static let seriesOff = #"""
{"supported":false}
"""#
}

final class OptimizerTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    func testCumulativeIsARunningSum() {
        XCTAssertEqual(OptimizerChart.cumulative([1, 2, 3]), [1, 3, 6])
        XCTAssertEqual(OptimizerChart.cumulative([]), [])
    }

    func testCumulativeTreatsNonFiniteAsZero() {
        XCTAssertEqual(OptimizerChart.cumulative([1, .nan, 2, .infinity, 3]), [1, 1, 3, 3, 6])
    }

    func testAxisTicksOneePerPointUnderBudget() {
        let hour = 3_600_000.0
        let base = 1_761_600_000_000.0 // 2025-10-27 22:40 UTC
        let ticks = OptimizerChart.axisTicks([base, base + hour, base + 2 * hour], bucket: "hour", timeZone: utc)
        XCTAssertEqual(ticks.map(\.index), [0, 1, 2])
        XCTAssertEqual(ticks.map(\.label), ["21:00", "22:00", "23:00"])
    }

    func testAxisTicksBudgetsAndFirstLast() {
        let hour = 3_600_000.0
        let base = 1_761_600_000_000.0
        let hours = (0..<24).map { base + Double($0) * hour }
        let hourTicks = OptimizerChart.axisTicks(hours, bucket: "hour", timeZone: utc)
        XCTAssertEqual(hourTicks.count, 5)
        XCTAssertEqual(hourTicks.first?.index, 0)
        XCTAssertEqual(hourTicks.last?.index, 23)
        let day = 86_400_000.0
        let days = (0..<30).map { base + Double($0) * day }
        let dayTicks = OptimizerChart.axisTicks(days, bucket: "day", timeZone: utc)
        XCTAssertEqual(dayTicks.count, 4)
        XCTAssertEqual(dayTicks.first?.index, 0)
        XCTAssertEqual(dayTicks.last?.index, 29)
        XCTAssertEqual(dayTicks.first?.label, "Oct 27")
        XCTAssertTrue(OptimizerChart.axisTicks([], bucket: "day").isEmpty)
    }

    func testFormatClock() {
        XCTAssertEqual(OptimizerChart.formatClock(1_761_650_000_000, timeZone: utc), "11:13")
        XCTAssertEqual(OptimizerChart.formatClock(0, timeZone: utc), "00:00")
        XCTAssertEqual(OptimizerChart.formatClock(.nan), "")
    }

    func testDecodeSummaryView() throws {
        let s = try JSONDecoder().decode(OptimizerSummaryWire.self, from: Data(OptFx.summary.utf8))
        let v = try XCTUnwrap(s.view)
        XCTAssertTrue(v.switch.on)
        XCTAssertEqual(v.switch.label, "On")
        XCTAssertEqual(v.subrows.map(\.id), ["pacing", "compacting", "cache"])
        XCTAssertEqual(v.windows.count, 2)
        XCTAssertEqual(v.windows[0].band, "warn")
        XCTAssertEqual(v.windows[0].forecastWarn, true)
        XCTAssertEqual(v.windows[0].pressure.tone, "warn")
        XCTAssertNil(v.windows[1].resetsAt)
        XCTAssertNil(v.windows[1].forecastPct)
        XCTAssertEqual(v.windows[1].forecastLabel, "gathering history…")
        XCTAssertEqual(v.metered.first?.name, "Endpoint A")
        XCTAssertEqual(v.activity.map(\.rolledBack), [false, true])
        XCTAssertEqual(v.stats.map(\.id), ["cacheHit", "sessions"])
    }

    func testDecodeSeriesView() throws {
        let s = try JSONDecoder().decode(OptimizerSeriesWire.self, from: Data(OptFx.series.utf8))
        XCTAssertEqual(s.bucket, "hour")
        XCTAssertEqual(s.series?.count, 2)
        XCTAssertEqual(s.series?[1].tokensSent, 200)
        let v = try XCTUnwrap(s.view)
        XCTAssertTrue(v.hasCounterfactual)
        XCTAssertFalse(v.noActivity)
        XCTAssertEqual(v.rawValues, [100, 250])
        XCTAssertEqual(v.trimming?.chip, "−14% sent")
        XCTAssertEqual(v.savingLabel?.tone, "ok")
        XCTAssertNil(v.potentialLine)
        XCTAssertNil(v.legend.noCounterfactual)
        XCTAssertEqual(v.stats.map(\.id), ["sent", "saved", "costPerTurn"])
    }

    func testNoViewAndUnsupportedDecode() throws {
        let old = try JSONDecoder().decode(OptimizerSummaryWire.self, from: Data(OptFx.summaryOld.utf8))
        XCTAssertTrue(old.supported)
        XCTAssertNil(old.view)
        let off = try JSONDecoder().decode(OptimizerSeriesWire.self, from: Data(OptFx.seriesOff.utf8))
        XCTAssertFalse(off.supported)
        XCTAssertNil(off.view)
        XCTAssertNil(off.series)
    }
}
