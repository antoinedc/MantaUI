import Foundation
import CrashReporter

// ===========================================================================
// Crash capture -> the box.
//
// A device's crash reports only reach a Mac through a live Xcode connection,
// and this phone is used untethered — so a reproducible crash was undiagnosable
// and had to be guessed at from behaviour. PLCrashReporter (BSD, the capture
// engine inside several commercial crash SDKs) records the crash on-device; the
// report is uploaded to the box on the NEXT launch, over the connection the app
// already has. No cable, no Xcode, no third-party service.
//
// Deliberately NOT hand-rolled: a crash handler runs in a dying process, where
// only async-signal-safe work is allowed, and a naive `signal()` + backtrace
// handler is exactly the thing that lies (or hangs) at the moment you need it.
//
// The uploaded file is the formatted text report — reason, signal, and the
// crashed thread's frames — so it is readable as-is on the box with no
// symbolication tool in the loop.
// ===========================================================================

@MainActor
enum CrashReports {

    private static var reporter: PLCrashReporter?

    /// Start recording crashes. Call as early as possible in the launch path.
    static func install() {
        // Mach exceptions catch the Swift runtime traps that matter here (index
        // out of range, forced unwrap of nil, precondition failure); BSD signals
        // alone miss some of them.
        let config = PLCrashReporterConfig(
            signalHandlerType: .mach,
            symbolicationStrategy: .all
        )
        guard let reporter = PLCrashReporter(configuration: config) else { return }
        self.reporter = reporter
        do {
            try reporter.enableAndReturnError()
        } catch {
            NSLog("[crash] could not enable crash reporting: \(error)")
        }
    }

    /// Upload a report left by a previous run, then purge it. Safe to call on
    /// every launch; does nothing when there is no pending report.
    static func uploadPending(using api: MantaAPIClient) {
        guard let reporter, reporter.hasPendingCrashReport() else { return }
        guard let data = try? reporter.loadPendingCrashReportDataAndReturnError() else {
            reporter.purgePendingCrashReport()
            return
        }
        let text: String
        if let report = try? PLCrashReport(data: data),
           let formatted = PLCrashReportTextFormatter.stringValue(for: report, with: PLCrashReportTextFormatiOS) {
            text = formatted
        } else {
            text = "unreadable crash report (\(data.count) bytes)"
        }
        reporter.purgePendingCrashReport()

        let name = "crash-\(Int(Date().timeIntervalSince1970)).txt"
        guard let body = text.data(using: .utf8) else { return }
        Task.detached {
            _ = try? await api.upload(project: "crash", filename: name, data: body)
        }
    }
}
