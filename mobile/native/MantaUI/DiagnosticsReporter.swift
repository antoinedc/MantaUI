import Combine
import FirebaseCrashlytics
import Foundation
import MetricKit
import UIKit

// ===========================================================================
// OS-kill visibility (spec 2026-11-17-ios-stability-and-status-freshness, A2).
//
// Crashlytics only sees crashes the app itself survives long enough to record.
// A main-thread hang kill, a memory (jetsam) kill or a CPU / disk-write
// exception never reaches it. MetricKit delivers those as diagnostics, on a
// background queue, usually on the next launch. This forwards each one to:
//
//   - the box (`POST /api/diagnostics/ios`, contract C3), through a small
//     on-disk outbox so a failed upload is retried at the next launch and on
//     every foreground; and
//   - Crashlytics as ONE non-fatal (domain "MetricKit", a stable code per kind)
//     plus the custom key `last_os_kill`, so the console we already read can
//     count and alert on them. The frames are NOT forwarded as an exception
//     model: their addresses belong to the dead process (a different ASLR
//     slide) and Crashlytics would symbolicate them wrongly.
//
// Threading: MetricKit calls `didReceive` on its own queue. That entry point is
// `nonisolated`, reduces the payload to `Sendable` values there, and only then
// hops to the main actor (the same bug class as the UpgradeStore crash).
// ===========================================================================

@MainActor
final class DiagnosticsReporter: NSObject, MXMetricManagerSubscriber {
    /// Uploads one outbox file. Runs off the main actor (it reads the file itself).
    typealias Uploader = @Sendable (URL) async -> DiagnosticUploadResult
    typealias Recorder = @MainActor (DiagnosticItem) -> Void

    /// Kept for the life of the app: MetricKit may not retain its subscribers.
    static let shared = DiagnosticsReporter()

    private let outbox: DiagnosticsOutbox?
    private let context: DiagnosticContext
    private let upload: Uploader
    private let record: Recorder

    private var started = false
    private var cancellables = Set<AnyCancellable>()
    private var modernTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    private var flushAgain = false

    init(outbox: DiagnosticsOutbox? = DiagnosticsOutbox.standard(),
         context: DiagnosticContext = DiagnosticContext.current(),
         upload: @escaping Uploader = DiagnosticsReporter.liveUpload,
         record: @escaping Recorder = DiagnosticsReporter.recordToCrashlytics) {
        self.outbox = outbox
        self.context = context
        self.upload = upload
        self.record = record
        super.init()
    }

    /// Subscribe and retry whatever an earlier run could not upload. Idempotent.
    /// Call once at launch, right after `FirebaseApp.configure()`.
    func start() {
        guard !started else { return }
        started = true

        MXMetricManager.shared.add(self)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.flushOutbox() }
            .store(in: &cancellables)

        startModernDiagnostics()
        flushOutbox()
    }

    // MARK: - MetricKit (iOS 26 and earlier, still delivered on 27)

    /// MetricKit's queue, not the main thread: no state is touched here.
    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        ingest(Self.items(from: payloads))
    }

    nonisolated static func items(from payloads: [MXDiagnosticPayload]) -> [DiagnosticItem] {
        var items: [DiagnosticItem] = []
        for payload in payloads {
            for d in payload.crashDiagnostics ?? [] {
                items.append(DiagnosticItem(kind: .crash, source: .mxdiagnostic, payload: d.jsonRepresentation()))
            }
            for d in payload.hangDiagnostics ?? [] {
                items.append(DiagnosticItem(kind: .hang, source: .mxdiagnostic, payload: d.jsonRepresentation()))
            }
            for d in payload.cpuExceptionDiagnostics ?? [] {
                items.append(DiagnosticItem(kind: .cpuException, source: .mxdiagnostic, payload: d.jsonRepresentation()))
            }
            for d in payload.diskWriteExceptionDiagnostics ?? [] {
                items.append(DiagnosticItem(kind: .diskWriteException, source: .mxdiagnostic, payload: d.jsonRepresentation()))
            }
            for d in payload.appLaunchDiagnostics ?? [] {
                items.append(DiagnosticItem(kind: .appLaunch, source: .mxdiagnostic, payload: d.jsonRepresentation()))
            }
        }
        return items
    }

    // MARK: - iOS 27 MetricManager (memory exceptions only)

    /// iOS 27's `MetricManager.diagnosticReports` is the only source of memory
    /// exception diagnostics. Everything else it carries already arrives through
    /// the subscriber above, so only memory exceptions are forwarded from here
    /// (no duplicates). Compiled only with a toolchain that knows the API; the
    /// task owns the manager, which must stay alive for the stream to deliver.
    private func startModernDiagnostics() {
        #if compiler(>=6.4)
        if #available(iOS 27.0, *) {
            guard modernTask == nil else { return }
            modernTask = Task { [weak self] in
                let manager = MetricManager()
                for await report in manager.diagnosticReports {
                    guard case .memoryException = report.result else { continue }
                    guard let data = try? JSONEncoder().encode(report) else { continue }
                    self?.ingest([DiagnosticItem(kind: .memoryException, source: .metricManager, payload: data)])
                }
            }
        }
        #endif
    }

    // MARK: - Ingest

    /// Any thread: hands the (plain, `Sendable`) items to the main actor.
    nonisolated func ingest(_ items: [DiagnosticItem]) {
        guard !items.isEmpty else { return }
        Task { @MainActor in self.handle(items) }
    }

    private func handle(_ items: [DiagnosticItem]) {
        for item in items {
            record(item)
            // Persist before uploading so a kill or a flaky network cannot lose it.
            // A failed write only loses the box copy; the Crashlytics non-fatal above is already recorded.
            if let outbox, let body = item.body(fallback: context) {
                _ = try? outbox.enqueue(body)
            }
        }
        flushOutbox()
    }

    // MARK: - Outbox flush

    /// Upload what is waiting, oldest first. One flush at a time; a request that
    /// arrives mid-flush makes it look again when it ends.
    func flushOutbox() {
        guard outbox != nil else { return }
        if flushTask != nil {
            flushAgain = true
            return
        }
        flushTask = Task { [weak self] in await self?.runFlush() }
    }

    private func runFlush() async {
        repeat {
            flushAgain = false
            guard await flushPass() else { break }
        } while flushAgain
        flushTask = nil
    }

    /// False when an upload failed: stop, the files stay for the next launch / foreground.
    private func flushPass() async -> Bool {
        guard let outbox else { return true }
        for file in outbox.pending() {
            switch await upload(file) {
            case .sent, .rejected:
                outbox.remove(file)
            case .failed:
                return false
            }
        }
        return true
    }

    // MARK: - Defaults

    static let liveUpload: Uploader = { file in
        guard let body = try? Data(contentsOf: file) else { return .failed }
        let keychain = KeychainCredentialStore.shared
        guard let serverURL = keychain.serverURL, let token = keychain.boxToken, !token.isEmpty else { return .failed }
        let request = DiagnosticsUpload.request(serverURL: serverURL, token: token, body: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return DiagnosticsUpload.result(forStatus: (response as? HTTPURLResponse)?.statusCode)
        } catch {
            return .failed
        }
    }

    static let recordToCrashlytics: Recorder = { item in
        let crashlytics = Crashlytics.crashlytics()
        crashlytics.setCustomValue(item.kind.rawValue, forKey: "last_os_kill")
        var info: [String: Any] = item.summary
        info[NSLocalizedDescriptionKey] = "MetricKit \(item.kind.rawValue) diagnostic"
        crashlytics.record(error: NSError(domain: "MetricKit", code: item.kind.crashlyticsCode, userInfo: info))
    }
}
