import Foundation
import os

// Diagnostic-only: logs the transcript-landing timeline so a blank-on-open can
// be read off a device console instead of guessed at. Deleted when the bug is
// fixed. Subsystem/category are what `log stream`/devicectl filters on.
enum LandingTrace {
    private static let log = Logger(subsystem: "com.antoinedc.mantaui", category: "landing")
    private static let start = DispatchTime.now()

    private static func ms() -> Int {
        Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
    }

    static func event(_ tag: String, _ detail: String) {
        log.info("[landing +\(ms())ms] \(tag): \(detail)")
    }
}
