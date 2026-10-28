import Foundation

// ===========================================================================
// WS09 F3 — chart geometry for the optimizer screen (M8, KEEP-CLIENT). Every
// string, band and tone on that screen comes from the box's `view` blocks
// (src/server/optimizer/view.mjs); only the cumulative line and the axis ticks
// are computed here. Mirrors `buildCumulativePath` / `chartAxisTicks` /
// `formatClockTime` in src/renderer/chatUtils.ts.
// ===========================================================================

enum OptimizerChart {
    /// Running sum of per-bucket values, oldest → newest; a non-finite or
    /// negative-infinite bucket counts as 0 so one bad value never poisons the line.
    static func cumulative(_ values: [Double]) -> [Double] {
        var total = 0.0
        return values.map { v in
            total += v.isFinite ? v : 0
            return total
        }
    }

    /// Evenly spaced x-axis ticks: at most 5 for "hour" and 4 for "day", always
    /// including the first and last point; fewer points than the budget → one tick
    /// per point. "14:00" (hour) / "Aug 3" (day), in `timeZone`.
    static func axisTicks(_ timestampsMs: [Double], bucket: String, timeZone: TimeZone = .current) -> [(index: Int, label: String)] {
        let isHour = bucket == "hour"
        let budget = isHour ? 5 : 4
        guard !timestampsMs.isEmpty else { return [] }
        func label(_ ms: Double) -> String { tickLabel(ms, isHour: isHour, timeZone: timeZone) }
        if timestampsMs.count <= budget {
            return timestampsMs.enumerated().map { (index: $0.offset, label: label($0.element)) }
        }
        var out: [(index: Int, label: String)] = []
        var seen = Set<Int>()
        for i in 0..<budget {
            let index = Int((Double(i * (timestampsMs.count - 1)) / Double(budget - 1)).rounded())
            if seen.contains(index) { continue }
            seen.insert(index)
            out.append((index: index, label: label(timestampsMs[index])))
        }
        return out
    }

    /// "HH:MM" in `timeZone`; "" for a non-finite timestamp.
    static func formatClock(_ ms: Double, timeZone: TimeZone = .current) -> String {
        guard ms.isFinite else { return "" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: Date(timeIntervalSince1970: ms / 1000))
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    private static func tickLabel(_ ms: Double, isHour: Bool, timeZone: TimeZone) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        if isHour {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            return String(format: "%02d:00", calendar.component(.hour, from: date))
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}
