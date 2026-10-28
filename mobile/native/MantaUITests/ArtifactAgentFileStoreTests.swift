import XCTest
@testable import MantaUI

// ===========================================================================
// WS07 F6 — the REAL store around the pure machine: injected download that
// suspends on a continuation the test controls, an injected sleep, and a temp
// dir. The point is that every staged file is actually REMOVED from disk on each
// path that drops one, and that late completions never touch a newer notice.
// Mac-only (the store is UIKit + MainActor); run through `ios-mantaui` `test-unit`.
// ===========================================================================

@MainActor
final class ArtifactAgentFileStoreTests: XCTestCase {

    /// A downloader the test releases by hand.
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: [String: CheckedContinuation<Data, Error>] = [:]
        private var requested: [String] = []

        func download(_ path: String) async throws -> Data {
            try await withCheckedThrowingContinuation { continuation in
                register(path, continuation)
            }
        }

        private func register(_ path: String, _ continuation: CheckedContinuation<Data, Error>) {
            lock.lock()
            waiting[path] = continuation
            requested.append(path)
            lock.unlock()
        }

        func release(_ path: String, with result: Result<Data, Error>) {
            lock.lock()
            let continuation = waiting.removeValue(forKey: path)
            lock.unlock()
            continuation?.resume(with: result)
        }

        var requestedPaths: [String] {
            lock.lock()
            defer { lock.unlock() }
            return requested
        }
    }

    private struct DownloadFailed: Error {}

    private var root: URL = FileManager.default.temporaryDirectory

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("agentfile-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
        try await super.tearDown()
    }

    private func event(_ name: String) -> AgentFileEvent {
        AgentFileEvent(remotePath: "/o/\(name)", name: name, size: 10, sessionID: "ses_1", autoPulled: false)
    }

    private func makeStore(_ gate: Gate, instantSleep: Bool = true) -> ArtifactAgentFileStore {
        ArtifactAgentFileStore(
            download: { path in try await gate.download(path) },
            tempRoot: root,
            sleep: { _ in if !instantSleep { try? await Task.sleep(for: .seconds(3600)) } }
        )
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 3) async {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func stagedFileURL(_ store: ArtifactAgentFileStore) -> URL? {
        if case .presenting(_, _, let url)? = store.machine.current?.phase { return url }
        if case .saved(_, let url)? = store.machine.current?.phase { return url }
        return nil
    }

    private func stagedDirectoryExists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path)
    }

    private func presentAndFinish(_ store: ArtifactAgentFileStore, completed: Bool) throws -> URL {
        let notice = try XCTUnwrap(store.machine.current)
        guard case .presenting(_, let opID, let url) = notice.phase else {
            XCTFail("expected a presenting notice, got \(notice.phase)")
            return root
        }
        store.presentationFinished(token: notice.token, opID: opID, fileURL: url, completed: completed)
        return url
    }

    // MARK: Interleaving

    func testADownloadThatLandsAfterANewerArrivalKeepsTheFirstNoticeAndTheSecondQueued() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        var presented: [AgentFilePresentation] = []
        store.presenter = { presented.append($0) }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        store.receive(event("b.pdf"))
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }

        XCTAssertEqual(store.machine.current?.event, event("a.pdf"))
        XCTAssertEqual(store.machine.queued, [event("b.pdf")])
        let url = try XCTUnwrap(stagedFileURL(store))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "A's temp file exists")
        XCTAssertEqual(url.lastPathComponent, "a.pdf", "the real filename is kept")
        XCTAssertEqual(presented.count, 1)
    }

    func testDismissWhileDownloadingThenTheLateCompletionDeletesTheFile() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        store.presenter = { _ in XCTFail("nothing should be presented for a dismissed notice") }
        store.receive(event("a.pdf"))
        store.share()
        await waitUntil { !gate.requestedPaths.isEmpty }
        store.dismiss()
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        try? await Task.sleep(nanoseconds: 200_000_000)

        XCTAssertNil(store.machine.current)
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(ArtifactAgentFileStore.stagingDirName).path)) ?? []
        XCTAssertTrue(leftovers.isEmpty, "the staged copy was removed: \(leftovers)")
    }

    // MARK: Files really go away

    func testSaveThenTheTimerClosesTheNoticeAndRemovesTheFile() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        var savedCount = 0
        store.onSaved = { savedCount += 1 }
        store.presenter = { _ in }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }
        let url = try presentAndFinish(store, completed: true)
        XCTAssertEqual(savedCount, 1)
        await waitUntil { store.machine.current == nil }

        XCTAssertNil(store.machine.current)
        XCTAssertFalse(stagedDirectoryExists(url), "save + timer close removes the staged file")
    }

    func testSaveThenDismissRemovesTheFile() async throws {
        let gate = Gate()
        let store = makeStore(gate, instantSleep: false)
        store.presenter = { _ in }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }
        let url = try presentAndFinish(store, completed: true)
        XCTAssertTrue(stagedDirectoryExists(url), "kept while the confirmation shows")
        store.dismiss()
        XCTAssertFalse(stagedDirectoryExists(url))
        XCTAssertNil(store.machine.current)
    }

    func testExporterCancelRemovesTheFileAndAllowsARetry() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        store.presenter = { _ in }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }
        let url = try presentAndFinish(store, completed: false)

        XCTAssertFalse(stagedDirectoryExists(url))
        XCTAssertEqual(store.machine.current?.phase, .idle)
    }

    func testShareCompletionAndShareCancelRemoveTheFile() async throws {
        for completed in [true, false] {
            let gate = Gate()
            let store = makeStore(gate)
            store.presenter = { _ in }
            store.receive(event("s\(completed).pdf"))
            store.share()
            await waitUntil { !gate.requestedPaths.isEmpty }
            gate.release("/o/s\(completed).pdf", with: .success(Data("S".utf8)))
            await waitUntil { self.stagedFileURL(store) != nil }
            let url = try presentAndFinish(store, completed: completed)
            XCTAssertFalse(stagedDirectoryExists(url), "share completed=\(completed)")
        }
    }

    func testAStalePresentationCallbackRemovesItsOwnFile() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        store.presenter = { _ in }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }
        let notice = try XCTUnwrap(store.machine.current)
        guard case .presenting(_, let opID, let url) = notice.phase else { return XCTFail("expected presenting") }
        store.presentationFinished(token: notice.token, opID: opID, fileURL: url, completed: false) // real cancel
        XCTAssertFalse(stagedDirectoryExists(url))

        // a duplicate delegate callback for the same presentation, with the file re-created
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("again".utf8).write(to: url)
        store.presentationFinished(token: notice.token, opID: opID, fileURL: url, completed: true)
        XCTAssertFalse(stagedDirectoryExists(url), "the stale callback cleaned up its own file")
        XCTAssertEqual(store.machine.current?.phase, .idle, "and changed nothing else")
    }

    func testADownloadFailureShowsTheFailureAndLeavesNoFile() async throws {
        let gate = Gate()
        let store = makeStore(gate)
        store.presenter = { _ in XCTFail("nothing to present") }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .failure(DownloadFailed()))
        await waitUntil { if case .failed? = store.machine.current?.phase { return true } else { return false } }

        XCTAssertEqual(store.machine.current?.phase, .failed(AgentFileNoticeCopy.failure(event("a.pdf"))))
    }

    // MARK: Saved timer vs a newer notice

    func testAStaleSavedTimerNeverClosesALaterNotice() async throws {
        let gate = Gate()
        let store = makeStore(gate, instantSleep: false)
        store.presenter = { _ in }
        store.receive(event("a.pdf"))
        store.save()
        await waitUntil { !gate.requestedPaths.isEmpty }
        gate.release("/o/a.pdf", with: .success(Data("A".utf8)))
        await waitUntil { self.stagedFileURL(store) != nil }
        let aNotice = try XCTUnwrap(store.machine.current)
        guard case .presenting(_, let aOp, _) = aNotice.phase else { return XCTFail("expected presenting") }
        _ = try presentAndFinish(store, completed: true)
        store.receive(event("b.pdf"))
        store.dismiss() // closes A (saved) and promotes B

        store.savedTimerFired(token: aNotice.token, opID: aOp) // A's old timer, late
        XCTAssertEqual(store.machine.current?.event, event("b.pdf"))
    }

    // MARK: bind

    func testBindingTwiceRegistersOneHandler() async throws {
        let stream = StoreTestStream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = makeStore(Gate())
        var arrivals = 0
        store.onArrival = { _ in arrivals += 1 }
        store.bind(eventStore: eventStore)
        store.bind(eventStore: eventStore)
        stream.inject(#"{"kind":"agentFile","payload":{"remotePath":"/o/a.pdf","name":"a.pdf","size":10,"sessionName":"ses_1","autoPulled":false}}"#)
        await waitUntil { arrivals > 0 }

        XCTAssertEqual(arrivals, 1)
        XCTAssertEqual(store.machine.current?.event.remotePath, "/o/a.pdf")
        XCTAssertTrue(store.machine.queued.isEmpty)
    }
}

/// A stream control that never connects but can inject frames.
@MainActor
private final class StoreTestStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}

    func inject(_ text: String) { onMessage?(text) }
}
