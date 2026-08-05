import Foundation
import os

// Diagnostic-only: logs the transcript-landing timeline so a blank-on-open can
// be read off a device console instead of guessed at. Deleted when the bug is
// fixed. Subsystem/category are what `log stream`/devicectl filters on.
enum LandingTrace {
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "landing")
    private static let start = ContinuousClock.now

    private static func ms() -> Int {
        let d = ContinuousClock.now - start
        return Int(d.components.seconds) * 1000 + Int(d.components.attoseconds / 1_000_000_000_000_000)
    }

    static func event(_ tag: String, _ detail: CustomStringConvertible) {
        log.info("[landing +\(ms())ms] \(tag): \(detail)")
    }
}
