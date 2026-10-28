import XCTest
@testable import MantaUI

// ===========================================================================
// OpenCode V2 cutover, slice C4 — UpgradeStore: the producers that feed the
// iPhone's read-only upgrade screen. The fetcher is injected, so no network and
// no event store: this covers the part the pure model tests cannot — that a
// failed read is never read as "the upgrade is over", that the 1 Hz poll runs
// only while an upgrade is believed active AND the stream is down, and that a
// refusal (503) raises the screen and triggers an immediate read.
//
// Mac-only (UpgradeStore is main-actor, Combine-based and not in the Linux
// SwiftPM package); run through the `ios-mantaui` plugin's `test-unit`.
// ===========================================================================

/// A scripted box. `@unchecked Sendable` because the store's fetcher is a
/// @Sendable closure and a test needs to change the answer between calls; every
/// access here goes through the lock.
private final class FakeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _answer: Result<UpgradeStatus?, Error> = .success(nil)
    private var _calls = 0

    var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }
    func answer(_ r: Result<UpgradeStatus?, Error>) { lock.lock(); _answer = r; lock.unlock() }
    /// Synchronous on purpose: `NSLock.lock()` is unavailable from an async
    /// context in Swift 6 mode, so the locking lives in a plain function.
    private func nextAnswer() -> Result<UpgradeStatus?, Error> {
        lock.lock()
        defer { lock.unlock() }
        _calls += 1
        return _answer
    }
    func fetch() async throws -> UpgradeStatus? {
        try nextAnswer().get()
    }
}

/// A scripted answer to Retry / Roll back. Same locking discipline as `FakeBox`.
private final class FakeActions: @unchecked Sendable {
    private let lock = NSLock()
    private var _result = UpgradeActionResult(ok: true)
    private var _calls: [UpgradeAction] = []
    private let delay: Duration

    init(delay: Duration = .milliseconds(60)) { self.delay = delay }

    var calls: [UpgradeAction] { lock.lock(); defer { lock.unlock() }; return _calls }
    func answer(_ r: UpgradeActionResult) { lock.lock(); _result = r; lock.unlock() }
    private func record(_ action: UpgradeAction) -> UpgradeActionResult {
        lock.lock()
        defer { lock.unlock() }
        _calls.append(action)
        return _result
    }
    func run(_ action: UpgradeAction) async -> UpgradeActionResult {
        let result = record(action)
        try? await Task.sleep(for: delay)
        return result
    }
}

@MainActor
final class UpgradeStoreTests: XCTestCase {

    private func running() -> UpgradeStatus {
        UpgradeStatus(state: .running, steps: [UpgradeStep(id: "copy", status: .running)], overall: 0.5)
    }
    private func completed() -> UpgradeStatus {
        UpgradeStatus(state: .completed, steps: [], overall: 1)
    }

    private func makeStore(_ box: FakeBox, poll: Duration = .milliseconds(10),
                           actions: FakeActions = FakeActions()) -> UpgradeStore {
        UpgradeStore(fetch: { try await box.fetch() }, pollInterval: poll, act: { await actions.run($0) })
    }

    private func failed(step: String = "copy") -> UpgradeStatus {
        UpgradeStatus(state: .failed, steps: [UpgradeStep(id: step, status: .failed)], overall: 0.4,
                      error: UpgradeFailure(step: step, message: "It broke"))
    }

    /// Spin until `condition` holds or two seconds pass.
    private func eventually(_ message: String, _ condition: @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(condition(), message)
    }

    func testAFrameShowsTheScreenAndCompletedClearsIt() {
        let store = makeStore(FakeBox())
        XCTAssertNil(store.screen)
        store.apply(running())
        XCTAssertEqual(store.screen?.kind, .running)
        store.apply(completed())
        XCTAssertNil(store.screen)
    }

    func testAReadFeedsTheScreen() async {
        let box = FakeBox()
        box.answer(.success(running()))
        let store = makeStore(box)
        await store.read()
        XCTAssertEqual(store.screen?.kind, .running)
    }

    /// The box is restarting: every read fails. The screen must stay up — a
    /// failure is not an answer.
    func testAFailedReadKeepsTheLastStatus() async {
        let box = FakeBox()
        box.answer(.success(running()))
        let store = makeStore(box)
        await store.read()
        box.answer(.failure(MantaError.transport("connection lost")))
        await store.read()
        XCTAssertEqual(store.screen?.kind, .running)
    }

    func testAnOldBoxsNilAnswerMeansNotUpgrading() async {
        let box = FakeBox()
        let store = makeStore(box)
        store.apply(running())
        box.answer(.success(nil)) // 404
        await store.read()
        XCTAssertNil(store.screen)
    }

    func testARefusalRaisesTheWaitingScreenAndReadsImmediately() async {
        let box = FakeBox()
        box.answer(.failure(MantaError.transport("down"))) // can't answer yet
        let store = makeStore(box)
        store.connectionChanged(connected: true)
        let before = box.calls
        store.noteUpgradeMode()
        XCTAssertEqual(store.screen?.kind, .waiting)
        await eventually("a refusal triggers a read of /api/upgrade") { box.calls > before }
        box.answer(.success(running()))
        await store.read()
        XCTAssertEqual(store.screen?.kind, .running)
    }

    func testPollsWhileTheStreamIsDownAndAnUpgradeIsActive() async {
        let box = FakeBox()
        box.answer(.success(running()))
        let store = makeStore(box)
        store.connectionChanged(connected: false)
        store.apply(running())
        let start = box.calls
        await eventually("polls repeatedly while down + active") { box.calls >= start + 3 }
    }

    func testDoesNotPollWhenNothingIsUpgrading() async {
        let box = FakeBox()
        let store = makeStore(box)
        store.connectionChanged(connected: false) // merely offline
        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(box.calls, 0, "an offline phone with no upgrade must not poll")
        XCTAssertNil(store.screen)
    }

    func testStopsPollingWhenTheStreamReturns() async {
        let box = FakeBox()
        box.answer(.success(running()))
        let store = makeStore(box)
        store.connectionChanged(connected: false)
        store.apply(running())
        await eventually("polling started") { box.calls >= 2 }
        store.connectionChanged(connected: true)
        try? await Task.sleep(for: .milliseconds(60)) // let the reconnect read + any in-flight poll land
        let settled = box.calls
        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(box.calls, settled, "frames take over once the stream is back")
    }

    func testPollingStopsWhenTheBoxSaysItIsDone() async {
        let box = FakeBox()
        box.answer(.success(running()))
        let store = makeStore(box)
        store.connectionChanged(connected: false)
        store.apply(running())
        await eventually("polling started") { box.calls >= 2 }
        box.answer(.success(completed()))
        await eventually("the completed answer clears the screen") { store.screen == nil }
        try? await Task.sleep(for: .milliseconds(60))
        let settled = box.calls
        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(box.calls, settled, "nothing left to poll for")
    }

    func testReconnectRereadsBecauseFramesAreNotReplayed() async {
        let box = FakeBox()
        let store = makeStore(box)
        store.connectionChanged(connected: false)
        box.answer(.success(running())) // changed while we were disconnected
        store.connectionChanged(connected: true)
        await eventually("the reconnect read surfaces the missed state") { store.screen?.kind == .running }
    }

    // MARK: - Retry / Roll back (WS10 F19)

    func testRetryGoesPendingThenOkThenRereads() async {
        let box = FakeBox()
        box.answer(.success(failed()))
        let actions = FakeActions()
        let store = makeStore(box, actions: actions)
        store.apply(failed())
        let readsBefore = box.calls

        let task = Task { await store.retry() }
        await eventually("the press is pending while the call runs") { store.gate.retry == .pending }
        XCTAssertEqual(store.screen?.retry, .pending)
        await task.value

        XCTAssertEqual(actions.calls, [.retry])
        XCTAssertEqual(store.gate.retry, .ok)
        XCTAssertGreaterThan(box.calls, readsBefore, "the screen re-reads so it moves on the moment the box does")
    }

    func testAnErrorResultSurfacesItsMessage() async {
        let box = FakeBox()
        box.answer(.success(failed()))
        let actions = FakeActions()
        actions.answer(UpgradeActionResult(ok: false, error: "HTTP 500"))
        let store = makeStore(box, actions: actions)
        store.apply(failed())
        await store.retry()
        XCTAssertEqual(store.gate.retry, .error("HTTP 500"))
        XCTAssertEqual(store.screen?.retry.line(okText: "x"), "HTTP 500")
    }

    func testRollbackBehavesTheSame() async {
        let box = FakeBox()
        box.answer(.success(failed()))
        let actions = FakeActions()
        let store = makeStore(box, actions: actions)
        store.apply(failed())

        await store.rollback()
        XCTAssertEqual(actions.calls, [.rollback])
        XCTAssertEqual(store.gate.rollback, .ok)

        actions.answer(UpgradeActionResult(ok: false, error: "The box refused the request."))
        await store.rollback()
        XCTAssertEqual(store.gate.rollback, .error("The box refused the request."))
    }

    func testOnlyOneActionAtATime() async {
        let box = FakeBox()
        box.answer(.success(failed()))
        let actions = FakeActions(delay: .milliseconds(120))
        let store = makeStore(box, actions: actions)
        store.apply(failed())

        let first = Task { await store.retry() }
        await eventually("first press pending") { store.gate.retry == .pending }
        await store.rollback()
        XCTAssertEqual(actions.calls, [.retry], "a second action is refused while one is pending")
        await first.value
    }

    func testTheOutcomeIsClearedWhenAFrameMovesFailedToRunning() async {
        let box = FakeBox()
        box.answer(.success(failed()))
        let store = makeStore(box)
        store.apply(failed())
        await store.retry()
        XCTAssertEqual(store.gate.retry, .ok)

        store.apply(running())
        XCTAssertEqual(store.gate.retry, .idle)
        XCTAssertEqual(store.screen?.kind, .running)
    }
}
