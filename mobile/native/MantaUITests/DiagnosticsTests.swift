import Synchronization
import XCTest
@testable import MantaUI

// ===========================================================================
// A2 (spec 2026-11-17): OS-kill diagnostics forwarding. The pure parts (C3 body,
// upload request, reply classification, the bounded outbox) plus the reporter's
// threading and outbox behaviour with injected upload / Crashlytics seams.
// MetricKit itself is not exercised (its payload types cannot be built here).
//
// Mac-only (UIKit/MetricKit in the target); run through `ios-mantaui` `test-unit`.
// ===========================================================================

private let fallbackContext = DiagnosticContext(
    appVersion: "1.3.0", build: "99", osVersion: "26.0.0", device: "iPhone16,2")

private func json(_ object: Any) -> Data {
    // Test fixtures are always valid JSON objects.
    (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
}

private func object(_ data: Data?) -> [String: Any] {
    guard let data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return value
}

private let hangPayload: Data = json([
    "diagnosticMetaData": [
        "appVersion": "1.2.0",
        "appBuildVersion": "77",
        "osVersion": "iPhone OS 26.1 (23B85)",
        "deviceType": "iPhone17,1",
        "terminationReason": "Namespace SPRINGBOARD, Code 0x8badf00d",
        "hangDuration": "3.5 sec",
    ],
    "callStackTree": ["callStackPerThread": true, "callStacks": [[String: Any]]()] as [String: Any],
] as [String: Any])

// MARK: - Pure parts

final class DiagnosticsBodyTests: XCTestCase {

    func testTheBodyCarriesTheC3FieldsAndTheDiagnosticsOwnContext() {
        let body = object(DiagnosticsBody.make(
            kind: .hang, source: .mxdiagnostic, payload: hangPayload, fallback: fallbackContext))

        XCTAssertEqual(body["kind"] as? String, "hang")
        XCTAssertEqual(body["source"] as? String, "mxdiagnostic")
        // The diagnostic describes the process that died (an older build), so its own values win.
        XCTAssertEqual(body["appVersion"] as? String, "1.2.0")
        XCTAssertEqual(body["build"] as? String, "77")
        XCTAssertEqual(body["osVersion"] as? String, "iPhone OS 26.1 (23B85)")
        XCTAssertEqual(body["device"] as? String, "iPhone17,1")
        let payload = body["payload"] as? [String: Any]
        XCTAssertNotNil(payload?["callStackTree"], "the diagnostic's own JSON is embedded, not stringified")
        XCTAssertEqual(Set(body.keys), ["kind", "appVersion", "build", "osVersion", "device", "source", "payload"])
    }

    func testMissingMetadataFallsBackToTheRunningApp() {
        let bare = json(["callStackTree": [String: Any]()])
        let body = object(DiagnosticsBody.make(
            kind: .crash, source: .metricManager, payload: bare, fallback: fallbackContext))
        XCTAssertEqual(body["appVersion"] as? String, "1.3.0")
        XCTAssertEqual(body["build"] as? String, "99")
        XCTAssertEqual(body["osVersion"] as? String, "26.0.0")
        XCTAssertEqual(body["device"] as? String, "iPhone16,2")
        XCTAssertEqual(body["source"] as? String, "metricManager")
    }

    func testAnEmptyMetadataValueDoesNotOverrideTheFallback() {
        let payload = json(["diagnosticMetaData": ["appVersion": "", "deviceType": "iPhone17,1"]])
        let context = DiagnosticsBody.context(from: try? JSONSerialization.jsonObject(with: payload), fallback: fallbackContext)
        XCTAssertEqual(context.appVersion, "1.3.0")
        XCTAssertEqual(context.device, "iPhone17,1")
    }

    func testANonJSONPayloadStillProducesABody() {
        let body = object(DiagnosticsBody.make(
            kind: .other, source: .mxdiagnostic, payload: Data("not json".utf8), fallback: fallbackContext))
        XCTAssertEqual(body["kind"] as? String, "other")
        let payload = body["payload"] as? [String: Any]
        XCTAssertEqual(payload?["unparsed"] as? Bool, true)
        XCTAssertEqual(payload?["bytes"] as? Int, 8)
    }

    func testAnOversizedPayloadIsReplacedSoTheBoxNeverAnswers413() throws {
        let huge = json(["blob": String(repeating: "a", count: DiagnosticsBody.maxBytes + 1024)])
        let data = try XCTUnwrap(DiagnosticsBody.make(
            kind: .crash, source: .mxdiagnostic, payload: huge, fallback: fallbackContext))
        XCTAssertLessThanOrEqual(data.count, DiagnosticsBody.maxBytes)
        let payload = object(data)["payload"] as? [String: Any]
        XCTAssertEqual(payload?["truncated"] as? Bool, true)
        XCTAssertEqual(payload?["originalBytes"] as? Int, huge.count)
        XCTAssertEqual(object(data)["kind"] as? String, "crash")
    }

    func testTheSummaryReadsTheUsefulMetadataKeysOnly() {
        let summary = DiagnosticsBody.summary(fromPayload: hangPayload)
        XCTAssertEqual(summary["terminationReason"], "Namespace SPRINGBOARD, Code 0x8badf00d")
        XCTAssertEqual(summary["hangDuration"], "3.5 sec")
        XCTAssertNil(summary["appVersion"], "identity fields are not repeated in the non-fatal")
        XCTAssertTrue(DiagnosticsBody.summary(fromPayload: Data("nope".utf8)).isEmpty)
    }

    func testTheItemComputesItsSummaryOnce() {
        let item = DiagnosticItem(kind: .hang, source: .mxdiagnostic, payload: hangPayload)
        XCTAssertEqual(item.summary["hangDuration"], "3.5 sec")
        XCTAssertEqual(item.body(fallback: fallbackContext), DiagnosticsBody.make(
            kind: .hang, source: .mxdiagnostic, payload: hangPayload, fallback: fallbackContext))
    }

    /// Crashlytics groups the non-fatals by domain + code; these numbers are a public contract.
    func testTheCrashlyticsCodesAreStable() {
        XCTAssertEqual(DiagnosticKind.crash.crashlyticsCode, 1)
        XCTAssertEqual(DiagnosticKind.hang.crashlyticsCode, 2)
        XCTAssertEqual(DiagnosticKind.cpuException.crashlyticsCode, 3)
        XCTAssertEqual(DiagnosticKind.diskWriteException.crashlyticsCode, 4)
        XCTAssertEqual(DiagnosticKind.memoryException.crashlyticsCode, 5)
        XCTAssertEqual(DiagnosticKind.appLaunch.crashlyticsCode, 6)
        XCTAssertEqual(DiagnosticKind.other.crashlyticsCode, 99)
        XCTAssertEqual(Set(DiagnosticKind.allCases.map(\.crashlyticsCode)).count, DiagnosticKind.allCases.count)
    }

    func testTheC3KindValuesAreTheWireNames() {
        XCTAssertEqual(
            Set(DiagnosticKind.allCases.map(\.rawValue)),
            ["crash", "hang", "cpuException", "diskWriteException", "memoryException", "appLaunch", "other"])
    }
}

final class DiagnosticsUploadTests: XCTestCase {

    func testTheRequestIsABearerPostToTheDiagnosticsRoute() throws {
        let server = try XCTUnwrap(URL(string: "https://0123abcd.boxes.mantaui.com"))
        let body = Data(#"{"kind":"hang"}"#.utf8)
        let request = DiagnosticsUpload.request(serverURL: server, token: "tok", body: body)
        XCTAssertEqual(request.url?.absoluteString, "https://0123abcd.boxes.mantaui.com/api/diagnostics/ios")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.httpBody, body)
    }

    func testTheReplyDecidesWhatHappensToTheFile() {
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 200), .sent)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 204), .sent)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 400), .rejected)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 413), .rejected)
        // The box is upgrading / restarting / the token is dead: keep the file.
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 503), .failed)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 500), .failed)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: 401), .failed)
        XCTAssertEqual(DiagnosticsUpload.result(forStatus: nil), .failed)
    }
}

final class DiagnosticsOutboxTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diagnostics-outbox-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func read(_ url: URL) -> String {
        (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    func testTheOutboxIsBoundedAndTheOldestFilesGoFirst() throws {
        let outbox = DiagnosticsOutbox(directory: directory, limit: 20)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<25 {
            try outbox.enqueue(Data("body-\(i)".utf8), now: start.addingTimeInterval(Double(i)))
        }
        let files = outbox.pending()
        XCTAssertEqual(files.count, 20)
        XCTAssertEqual(files.map(read), (5..<25).map { "body-\($0)" }, "the five oldest were dropped, the rest stay oldest-first")
    }

    func testTheDefaultLimitIsTwenty() {
        XCTAssertEqual(DiagnosticsOutbox.defaultLimit, 20)
        XCTAssertEqual(DiagnosticsOutbox(directory: directory).limit, 20)
    }

    func testPendingIsEmptyForAMissingDirectoryAndRemoveDeletes() throws {
        let outbox = DiagnosticsOutbox(directory: directory)
        XCTAssertTrue(outbox.pending().isEmpty)
        let url = try outbox.enqueue(Data("x".utf8))
        XCTAssertEqual(outbox.pending(), [url])
        outbox.remove(url)
        XCTAssertTrue(outbox.pending().isEmpty)
    }

    func testOnlyJSONFilesCount() throws {
        let outbox = DiagnosticsOutbox(directory: directory, limit: 2)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("stray".utf8).write(to: directory.appendingPathComponent("notes.txt"))
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<3 { try outbox.enqueue(Data("b\(i)".utf8), now: start.addingTimeInterval(Double(i))) }
        XCTAssertEqual(outbox.pending().map(read), ["b1", "b2"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("notes.txt").path))
    }
}

// MARK: - The reporter

/// Scripted uploader. The reporter's `Uploader` is @Sendable, so the state lives in a `Mutex`.
private final class ScriptedUploader: Sendable {
    private struct State {
        var result: DiagnosticUploadResult
        var uploaded: [String] = []
    }
    private let state: Mutex<State>

    init(_ result: DiagnosticUploadResult) { state = Mutex(State(result: result)) }

    var uploaded: [String] { state.withLock { $0.uploaded } }
    func answer(_ result: DiagnosticUploadResult) { state.withLock { $0.result = result } }

    func upload(_ file: URL) async -> DiagnosticUploadResult {
        let body = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        return state.withLock { state in
            state.uploaded.append(body)
            return state.result
        }
    }
}

@MainActor
private final class RecordedItems {
    var items: [DiagnosticItem] = []
}

@MainActor
final class DiagnosticsReporterTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diagnostics-reporter-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func makeReporter(_ uploader: ScriptedUploader, recorded: RecordedItems) -> (DiagnosticsReporter, DiagnosticsOutbox) {
        let outbox = DiagnosticsOutbox(directory: directory)
        let reporter = DiagnosticsReporter(
            outbox: outbox,
            context: fallbackContext,
            upload: { await uploader.upload($0) },
            record: { recorded.items.append($0) }
        )
        return (reporter, outbox)
    }

    private func item(_ kind: DiagnosticKind = .hang) -> DiagnosticItem {
        DiagnosticItem(kind: kind, source: .mxdiagnostic, payload: hangPayload)
    }

    /// MetricKit delivers on its own queue: the old UpgradeStore bug class. Must not trap.
    func testIngestFromABackgroundQueueUploadsRecordsAndClearsTheOutbox() async {
        let uploader = ScriptedUploader(.sent)
        let recorded = RecordedItems()
        let (reporter, outbox) = makeReporter(uploader, recorded: recorded)
        let diagnostic = item(.memoryException)

        DispatchQueue.global().async {
            reporter.ingest([diagnostic])
        }

        let done = await eventually { uploader.uploaded.count == 1 && outbox.pending().isEmpty && recorded.items.count == 1 }
        XCTAssertTrue(done)
        XCTAssertEqual(recorded.items.first?.kind, .memoryException)
        let body = object(uploader.uploaded.first.map { Data($0.utf8) })
        XCTAssertEqual(body["kind"] as? String, "memoryException")
    }

    func testAFailedUploadKeepsTheFileAndTheNextFlushSendsIt() async {
        let uploader = ScriptedUploader(.failed)
        let recorded = RecordedItems()
        let (reporter, outbox) = makeReporter(uploader, recorded: recorded)

        reporter.ingest([item()])
        let tried = await eventually { uploader.uploaded.count == 1 }
        XCTAssertTrue(tried)
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(outbox.pending().count, 1, "a failure keeps the diagnostic for the next launch / foreground")
        XCTAssertEqual(recorded.items.count, 1, "the Crashlytics non-fatal does not depend on the upload")

        uploader.answer(.sent)
        reporter.flushOutbox()
        let cleared = await eventually { outbox.pending().isEmpty }
        XCTAssertTrue(cleared)
        XCTAssertEqual(uploader.uploaded.count, 2, "the same file was retried, not duplicated")
    }

    func testAFailureStopsTheFlushInsteadOfHammeringTheBox() async {
        let uploader = ScriptedUploader(.failed)
        let recorded = RecordedItems()
        let (reporter, outbox) = makeReporter(uploader, recorded: recorded)
        for i in 0..<3 {
            _ = try? outbox.enqueue(Data("queued-\(i)".utf8), now: Date(timeIntervalSince1970: 1_800_000_000 + Double(i)))
        }

        reporter.flushOutbox()
        let tried = await eventually { uploader.uploaded.count >= 1 }
        XCTAssertTrue(tried)
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(uploader.uploaded, ["queued-0"], "stops at the first failure, oldest first")
        XCTAssertEqual(outbox.pending().count, 3)
    }

    func testARejectedBodyIsDeletedSoItCannotBlockTheQueue() async {
        let uploader = ScriptedUploader(.rejected)
        let recorded = RecordedItems()
        let (reporter, outbox) = makeReporter(uploader, recorded: recorded)

        reporter.ingest([item(.crash)])
        let cleared = await eventually { uploader.uploaded.count == 1 && outbox.pending().isEmpty }
        XCTAssertTrue(cleared)
    }

    func testAnEmptyIngestDoesNothing() async {
        let uploader = ScriptedUploader(.sent)
        let recorded = RecordedItems()
        let (reporter, outbox) = makeReporter(uploader, recorded: recorded)
        reporter.ingest([])
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(uploader.uploaded.isEmpty)
        XCTAssertTrue(recorded.items.isEmpty)
        XCTAssertTrue(outbox.pending().isEmpty)
    }
}
