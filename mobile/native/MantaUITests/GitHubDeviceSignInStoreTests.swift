import XCTest
@testable import MantaUI

// ===========================================================================
// WS04 §6 / D14 — the device sign-in STORE's lifecycle (Mac-only), with a fake
// API whose replies the test releases by hand and an injected clock. The pure
// state machine is covered in `GitHubDeviceSignInTests` (Linux-eligible).
//
// The invariants under test are the WS05 §C.3 lifecycle: no poll before the first
// interval; a foreground wake reuses the ONE loop and polls only when a full
// interval has passed; a late start/poll reply from a cancelled or restarted
// attempt is dropped; cancel is awaited.
// ===========================================================================

actor FakeDeviceAPI: GitHubDeviceSignInAPI {
    /// Grants handed out by successive `start()` calls (the last repeats).
    var grants: [GitHubDeviceStart] = [FakeDeviceAPI.grant("g1")]
    /// Replies for successive polls; an empty queue answers `pending(5)`.
    var pollReplies: [GitHubDevicePoll] = []
    var holdStart = false
    var holdPolls = false

    private(set) var startCount = 0
    private(set) var pollCalls: [String] = []
    private(set) var cancelCalls: [String] = []
    private(set) var cancelCompleted = false

    private var startWaiters: [CheckedContinuation<GitHubDeviceStart, Error>] = []
    private var pollWaiters: [(grantId: String, continuation: CheckedContinuation<GitHubDevicePoll, Error>)] = []

    static func grant(_ id: String, poll: Int = 5, expires: Int = 900) -> GitHubDeviceStart {
        GitHubDeviceStart(grant: GitHubDeviceGrant(
            grantId: id, userCode: "CODE-\(id)", verificationUri: "https://github.com/login/device",
            expiresIn: expires, pollInterval: poll
        ))
    }

    func configure(grants: [GitHubDeviceStart]? = nil, pollReplies: [GitHubDevicePoll]? = nil,
                   holdStart: Bool? = nil, holdPolls: Bool? = nil) {
        if let grants { self.grants = grants }
        if let pollReplies { self.pollReplies = pollReplies }
        if let holdStart { self.holdStart = holdStart }
        if let holdPolls { self.holdPolls = holdPolls }
    }

    func start() async throws -> GitHubDeviceStart {
        startCount += 1
        let reply = grants.count > 1 ? grants.removeFirst() : (grants.first ?? GitHubDeviceStart())
        if holdStart {
            return try await withCheckedThrowingContinuation { startWaiters.append($0) }
        }
        return reply
    }

    func poll(grantId: String) async throws -> GitHubDevicePoll {
        pollCalls.append(grantId)
        if holdPolls {
            return try await withCheckedThrowingContinuation { pollWaiters.append((grantId, $0)) }
        }
        return pollReplies.isEmpty ? GitHubDevicePoll(status: "pending", pollInterval: 5) : pollReplies.removeFirst()
    }

    func cancel(grantId: String) async {
        cancelCalls.append(grantId)
        await Task.yield()
        cancelCompleted = true
    }

    /// Answer every held `start()` with `reply`.
    func releaseStarts(with reply: GitHubDeviceStart) {
        let waiting = startWaiters
        startWaiters = []
        for waiter in waiting { waiter.resume(returning: reply) }
    }

    /// Answer every held poll with `reply`.
    func releasePolls(with reply: GitHubDevicePoll) {
        let waiting = pollWaiters
        pollWaiters = []
        for waiter in waiting { waiter.continuation.resume(returning: reply) }
    }
}

@MainActor
final class FakeClock {
    var now = Date(timeIntervalSince1970: 2_000_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

@MainActor
final class GitHubDeviceSignInStoreTests: XCTestCase {
    private var copied: [String] = []

    private func makeStore(_ api: GitHubDeviceSignInAPI, _ clock: FakeClock) -> GitHubDeviceSignInStore {
        GitHubDeviceSignInStore(api: api, now: { clock.now }, pasteboard: { [weak self] in self?.copied.append($0) })
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 3, _ condition: () async -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    /// Long enough for a wrongly-scheduled poll to show up, short enough to keep
    /// the suite fast.
    private func settle() async {
        try? await Task.sleep(nanoseconds: 150_000_000)
    }

    // MARK: - Start

    func testStartAlreadyConnectedIsConnected() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [GitHubDeviceStart(connected: true)])
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("connected") { store.flow.stage == .connected }
        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty)
    }

    func testStartNotConfigured() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [GitHubDeviceStart(notConfigured: true)])
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("notConfigured") { store.flow.stage == .notConfigured }
    }

    func testStartShowsTheCodeAndCopiesItOnce() async {
        let api = FakeDeviceAPI()
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        XCTAssertEqual(copied, ["CODE-g1"])
        XCTAssertEqual(store.note, "Code copied to clipboard")
        store.copyLink()
        XCTAssertEqual(copied.last, "https://github.com/login/device")
        XCTAssertEqual(store.note, "Link copied")
    }

    func testStartFailureIsAnError() async {
        let api = FailingStartAPI()
        let store = GitHubDeviceSignInStore(api: api, now: Date.init, pasteboard: { _ in })
        store.start()
        await waitUntil("error") { store.flow.stage == .error(GitHubDeviceFlow.unreachableMessage) }
    }

    // MARK: - Polling cadence

    func testNoPollBeforeFirstInterval() async {
        let api = FakeDeviceAPI()
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        await settle()
        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty, "the first poll waits a full interval")
    }

    func testResumeBeforeIntervalDoesNotPoll() async {
        let api = FakeDeviceAPI()
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(2)

        store.sceneBecameActive()
        await settle()

        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty)
        XCTAssertEqual(store.flow.stage, .code)
    }

    func testResumeAfterIntervalPollsOnce() async {
        let api = FakeDeviceAPI()
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(6)

        store.sceneBecameActive()
        await waitUntil("one poll") { await api.pollCalls.count == 1 }
        // Back to back with no time passing: never faster than the interval.
        store.sceneBecameActive()
        await settle()

        let polls = await api.pollCalls
        XCTAssertEqual(polls, ["g1"])
    }

    func testResumeAfterDeadlineExpiresWithoutPoll() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [FakeDeviceAPI.grant("g1", expires: 60)])
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(61)

        store.sceneBecameActive()
        XCTAssertEqual(store.flow.stage, .expired)
        await settle()

        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty, "an expired countdown makes no request")
    }

    func testDoneReplyConnectsAndStopsPolling() async {
        let api = FakeDeviceAPI()
        await api.configure(pollReplies: [GitHubDevicePoll(status: "done")])
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("connected") { store.flow.stage == .connected }
        clock.advance(60)
        store.sceneBecameActive()
        await settle()
        let polls = await api.pollCalls
        XCTAssertEqual(polls.count, 1)
    }

    // MARK: - Late replies

    func testLateReplyAfterCancelIsDropped() async {
        let api = FakeDeviceAPI()
        await api.configure(holdPolls: true)
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("poll in flight") { await api.pollCalls.count == 1 }

        await store.cancel()
        await api.releasePolls(with: GitHubDevicePoll(status: "done"))
        await settle()

        XCTAssertNotEqual(store.flow.stage, .connected, "a reply from a cancelled attempt can never connect")
        XCTAssertEqual(store.flow.stage, .code)
    }

    func testRestartDiscardsOldGrantReplies() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [FakeDeviceAPI.grant("g1"), FakeDeviceAPI.grant("g2")], holdPolls: true)
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("g1 code") { store.flow.grant?.grantId == "g1" }
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("g1 poll in flight") { await api.pollCalls == ["g1"] }

        store.start()
        await waitUntil("g2 code") { store.flow.grant?.grantId == "g2" }
        await api.releasePolls(with: GitHubDevicePoll(status: "expired"))
        await settle()

        XCTAssertEqual(store.flow.stage, .code, "the old grant's reply must not expire the new one")
        XCTAssertEqual(store.flow.grant?.grantId, "g2")
        let cancels = await api.cancelCalls
        XCTAssertEqual(cancels, ["g1"], "the superseded grant is released")
    }

    func testDismissDuringStartIgnoresLateStartReply() async {
        let api = FakeDeviceAPI()
        await api.configure(holdStart: true)
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("start in flight") { await api.startCount == 1 }

        await store.cancel()
        await api.releaseStarts(with: FakeDeviceAPI.grant("late"))
        await settle()

        // Stage untouched, no grant, never connected, nothing copied.
        XCTAssertEqual(store.flow.stage, .starting)
        XCTAssertNil(store.flow.grant)
        XCTAssertTrue(copied.isEmpty, "a late code is never copied")
        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty)
    }

    func testRetryDuringOutstandingPollDropsOldReply() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [FakeDeviceAPI.grant("g1"), FakeDeviceAPI.grant("g2")], holdPolls: true)
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("g1 code") { store.flow.grant?.grantId == "g1" }
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("g1 poll in flight") { await api.pollCalls == ["g1"] }

        store.start()
        await waitUntil("g2 code") { store.flow.grant?.grantId == "g2" }
        await api.releasePolls(with: GitHubDevicePoll(status: "pending", pollInterval: 99))
        await settle()
        // The stale reply must not have touched the interval either.
        XCTAssertEqual(store.flow.interval, 5)

        // Exactly ONE loop is running: one wake after an interval = one poll.
        await api.configure(holdPolls: false)
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("g2 poll") { await api.pollCalls.contains("g2") }
        await settle()
        let g2Polls = await api.pollCalls.filter { $0 == "g2" }
        XCTAssertEqual(g2Polls.count, 1)
    }

    func testWakeDuringSleepUsesExistingLoop() async {
        let api = FakeDeviceAPI()
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(6)

        store.sceneBecameActive()
        store.sceneBecameActive()
        store.sceneBecameActive()
        await waitUntil("a poll") { await api.pollCalls.count >= 1 }
        await settle()

        let polls = await api.pollCalls
        XCTAssertEqual(polls.count, 1, "wakes feed the one loop; they never start another")
    }

    func testWakeWithNoLoopIsANoOp() async {
        let api = FakeDeviceAPI()
        await api.configure(grants: [FakeDeviceAPI.grant("g1", expires: 10)])
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(11)
        store.sceneBecameActive()
        await waitUntil("expired") { store.flow.stage == .expired }
        await settle()

        // The loop has ended; waking again must not poll or spawn a second loop.
        clock.advance(30)
        store.sceneBecameActive()
        await settle()
        let polls = await api.pollCalls
        XCTAssertTrue(polls.isEmpty)
    }

    // MARK: - Cancel

    func testCancelAwaitsDeviceCancelBeforeOnCancel() async {
        let api = FakeDeviceAPI()
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("code") { store.flow.stage == .code }

        await store.cancel()

        // By the time `cancel()` returns (which is when the view calls
        // `onCancel`), the server cancel has COMPLETED.
        let done = await api.cancelCompleted
        let calls = await api.cancelCalls
        XCTAssertTrue(done)
        XCTAssertEqual(calls, ["g1"])
        // A second dismissal (the view's onDisappear) doesn't cancel twice.
        await store.cancel()
        let again = await api.cancelCalls
        XCTAssertEqual(again, ["g1"])
    }

    func testCancelAfterConnectedDoesNotCancelTheGrant() async {
        let api = FakeDeviceAPI()
        await api.configure(pollReplies: [GitHubDevicePoll(status: "done")])
        let clock = FakeClock()
        let store = makeStore(api, clock)
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        clock.advance(6)
        store.sceneBecameActive()
        await waitUntil("connected") { store.flow.stage == .connected }

        await store.cancel()

        let calls = await api.cancelCalls
        XCTAssertTrue(calls.isEmpty)
    }

    func testCancelFailureIsLoggedAndStillDismisses() async {
        // The live adapter swallows (and logs) a failed cancel: `cancel` never
        // throws, so dismissal can't be blocked by it. A dead port fails fast.
        let live = ServerGitHubDeviceSignIn(client: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!))
        await live.cancel(grantId: "g1")

        let api = FakeDeviceAPI()
        let store = makeStore(api, FakeClock())
        store.start()
        await waitUntil("code") { store.flow.stage == .code }
        await store.cancel()
        XCTAssertNotEqual(store.flow.stage, .connected)
    }
}

private actor FailingStartAPI: GitHubDeviceSignInAPI {
    struct Boom: Error {}
    func start() async throws -> GitHubDeviceStart { throw Boom() }
    func poll(grantId: String) async throws -> GitHubDevicePoll { GitHubDevicePoll(status: "pending") }
    func cancel(grantId: String) async {}
}
