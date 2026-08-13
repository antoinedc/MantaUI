import XCTest
@testable import MantaUI

// BET-668 — the single-writer stream merge. The chat screen has two writers
// for turn state (optimistic local mutations vs incoming stream frames). These
// tests pin the pure merge/lifecycle decisions and the store seams (seeding on
// open, optimistic-running protection, no stale replay on retirement) so a
// frame can never clobber an optimistic value. Network is mocked.

@MainActor
final class ChatStreamMergeTests: XCTestCase {

    // MARK: - Fixtures

    private func turnState(
        running: Bool = false,
        turnComplete: Bool = false,
        tail: String = "",
        tombstones: Set<String> = [],
        questions: [QuestionRequest] = []
    ) -> ChatStreamTurnState {
        ChatStreamTurnState(
            running: running,
            turnComplete: turnComplete,
            streamingTailID: tail,
            locallyAnsweredQuestionIDs: tombstones,
            questions: questions
        )
    }

    // MARK: - Tail identity: once per turn, reset only on the frame's turnComplete

    /// The `turnComplete` EDGE carried by the frame is the only thing that
    /// resets the tail id.
    func testTurnCompleteResetsTailID() {
        let state = turnState(tail: "tail")
        let result = ChatStreamMerge.applying(frameTurnComplete: true, frameStartedRunning: false, to: state)
        XCTAssertEqual(result.streamingTailID, "")
    }

    /// A STALE `turnComplete == true` left over from a previous turn clears
    /// when a new turn starts running.
    func testRunningStartClearsStaleComplete() {
        let state = turnState(turnComplete: true, tail: "")
        let result = ChatStreamMerge.applying(frameTurnComplete: nil, frameStartedRunning: true, to: state)
        XCTAssertFalse(result.turnComplete, "a running frame starts a turn, clearing the completion flag")
    }

    /// A frame that carries neither a completion edge nor a turn start (e.g. a
    /// context/flush frame, or a retirement republish) leaves the tail alone —
    /// it carries no opinion.
    func testNonCarryingFrameClobbersNeitherTurnCompleteNorTail() {
        let state = turnState(turnComplete: false, tail: "tail")
        let result = ChatStreamMerge.applying(frameTurnComplete: nil, frameStartedRunning: false, to: state)
        XCTAssertEqual(result.turnComplete, false)
        XCTAssertEqual(result.streamingTailID, "tail")
    }

    // MARK: - Failed send

    /// The pure rollback clears running + the tail and leaves the question
    /// tombstones untouched.
    func testAfterSendFailureRollsBackRunningAndPreservesState() {
        let state = turnState(running: true, tail: "tail", tombstones: ["x"], questions: [])
        let rolled = ChatStreamMerge.afterSendFailure(to: state)
        XCTAssertFalse(rolled.running)
        XCTAssertEqual(rolled.streamingTailID, "")
        XCTAssertEqual(rolled.locallyAnsweredQuestionIDs, Set(["x"]))
    }

    // MARK: - Store seams (integration over a fake stream)

    /// Block 1: opening a session that is already running must show the working
    /// indicator. The accumulated snapshot's `running` is seeded even though the
    /// most recent frame (a flush) carried no running field.
    func testOpeningMidTurnSessionSeedsRunningFromSnapshot() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        // A later non-running frame must NOT erase the seeded running.
        stream.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses","payload":{"messageID":"m","partID":"p","field":"text","text":"hi"}}"#)

        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        await Task.yield()
        XCTAssertTrue(store.running, "opening a mid-turn session must show its working indicator")
        XCTAssertFalse(store.streamingTailID.isEmpty,
                       "opening a mid-turn session must have a stable tail id")

        // The tail id must be STABLE across later frames, so the streaming row
        // is never replaced mid-turn (seeding, not a per-edge re-mint).
        let minted = store.streamingTailID
        stream.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses","payload":{"messageID":"m2","partID":"p2","field":"text","text":"more"}}"#)
        await Task.yield()
        XCTAssertEqual(store.streamingTailID, minted,
                       "a running turn's tail id must not change across frames")
    }

    /// Block 1: opening a session with a question already waiting must show the
    /// card — questions are seeded from the accumulated snapshot.
    func testOpeningSessionSeedsPendingQuestion() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        stream.inject(#"{"kind":"stream","sub":"questions","sessionId":"ses","payload":{"questions":[{"id":"q1","sessionID":"ses","questions":[]}]}}"#)

        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        await Task.yield()
        XCTAssertEqual(store.questions.map(\.id), ["q1"], "a pending question must show on open")
    }

    /// The optimistic `running = true` `send()` set must NOT be clobbered by an
    /// unrelated frame while the box hasn't yet confirmed running. Once the box
    /// reports running, the snapshot is authoritative; a real turnComplete
    /// stops it.
    func testOptimisticRunningSurvivesUnrelatedFrameUntilBoxConfirms() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.succeedingSession())
        )
        await Task.yield()

        let ok = await store.send(text: "hello", attachments: [], model: nil)
        XCTAssertTrue(ok)
        XCTAssertTrue(store.running, "a send reports running optimistically")

        // Unrelated context frame while the box hasn't confirmed → keep running.
        stream.inject(#"{"kind":"stream","sub":"context","sessionId":"ses","payload":{"freshInput":0,"cacheRead":0,"cacheWrite":0,"totalInput":0,"pct":0,"segments":[]}}"#)
        await Task.yield()
        XCTAssertTrue(store.running, "an unrelated frame must not clobber the optimistic running")

        // Box confirms running → still running.
        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await Task.yield()
        XCTAssertTrue(store.running)

        // Genuine completion stops it.
        stream.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses","payload":{"complete":true,"running":false}}"#)
        await Task.yield()
        XCTAssertFalse(store.running)
    }

    /// Block 2: a local transcript-refetch republish (retireCoveredStreamText)
    /// must NOT replay the previous frame's fields over an optimistic send — the
    /// freshly-minted tail and optimistic running survive it.
    func testRetirementRepublishDoesNotReplayStaleDelta() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        // A completed turn sits at the snapshot surface: some streamed text
        // (a chunk) then a turnComplete (running false, complete true).
        stream.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses","payload":{"messageID":"m1","partID":"p1","field":"text","text":"hi"}}"#)
        stream.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses","payload":{"complete":true,"running":false}}"#)

        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.succeedingSession())
        )
        await Task.yield()
        XCTAssertFalse(store.running)
        XCTAssertEqual(store.streamingTailID, "")

        // User sends the next message before the refetch lands.
        let ok = await store.send(text: "next", attachments: [], model: nil)
        XCTAssertTrue(ok)
        XCTAssertTrue(store.running)
        let mintedTail = store.streamingTailID
        XCTAssertFalse(mintedTail.isEmpty, "send() mints the streaming tail")

        // The refetch's own republish (which retires the covered chunk) must
        // not replay the stale turnComplete over the optimistic send.
        eventStore.retireCoveredStreamText(sessionId: "ses", covered: ["m1"])
        await Task.yield()
        XCTAssertTrue(store.running, "a retire republish must not clobber optimistic running")
        XCTAssertEqual(store.streamingTailID, mintedTail,
                       "a retire republish must not reset the freshly-minted tail")
    }

    /// A failed send removes the optimistic user bubble so the message isn't
    /// shown twice (restored input + transcript).
    func testFailedSendResetsRunningAndRemovesBubble() async {
        let api = MantaAPIClient(
            serverURL: URL(string: "https://127.0.0.1")!,
            tokenProvider: { nil },
            session: Self.failingSession()
        )
        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: MantaEventStore(stream: TestStreamControl(), tokenProvider: { nil }, serverProvider: { nil }),
            api: api
        )
        let ok = await store.send(text: "hello", attachments: [], model: nil)
        XCTAssertFalse(ok, "a failed send must be reported as failed")
        XCTAssertFalse(store.running, "a failed send must stop the running state (no forever-spinner)")

        let userBlocks = store.transcript.filter {
            if case .user(_, _) = $0 { return true }
            return false
        }
        XCTAssertEqual(userBlocks.count, 0, "a failed send must not leave the message in the transcript")
    }

    // MARK: - Permissions routing (BET-715)

    // BET-669's original concern — a 2.5s permission poll timer leaking or
    // piling up across subagent drill-in (`start() → stop() → start()`) — is
    // MOOT: the poll is gone (BET-715). Permissions now ride the interpreted
    // stream as `sub: "permissions"` frames, so this section pins the frame
    // → `store.permissions` routing instead of timer lifecycle.

    func testPermissionsFramePopulatesAndClears() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        stream.inject(#"{"kind":"stream","sub":"permissions","sessionId":"ses","payload":{"permissions":[{"id":"perm_1","sessionID":"ses","permission":"Bash","patterns":["~/secrets.json"]}]}}"#)

        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        await Task.yield()
        XCTAssertEqual(store.permissions.map(\.id), ["perm_1"],
                       "a permissions frame must surface the pending permission")

        // A replied-removal frame clears it.
        stream.inject(#"{"kind":"stream","sub":"permissions","sessionId":"ses","payload":{"permissions":[]}}"#)
        await Task.yield()
        XCTAssertEqual(store.permissions, [], "a replied/removed permission must clear on the stream frame")
    }

    /// The accumulated snapshot only republishes on a genuine `permissions`
    /// frame. A frame of any other sub (running, todos, ...) must not
    /// reapply the sticky snapshot — otherwise it would clobber whatever
    /// `refreshPermissions()` (seed/resync) just wrote, or resurrect a
    /// permission that was just cleared, before the box's own frame lands.
    func testNonPermissionsFrameDoesNotResurrectClearedPermission() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        stream.inject(#"{"kind":"stream","sub":"permissions","sessionId":"ses","payload":{"permissions":[{"id":"perm_1","sessionID":"ses","permission":"Bash","patterns":["~/secrets.json"]}]}}"#)

        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        await Task.yield()
        XCTAssertEqual(store.permissions.map(\.id), ["perm_1"])

        // The accumulated snapshot still carries perm_1 (no permissions frame
        // has cleared it yet), but a reconnect just resynced the truth to
        // empty via refreshPermissions().
        await store.refreshPermissions()
        XCTAssertEqual(store.permissions, [], "refreshPermissions must win immediately after resync")

        // An unrelated frame (e.g. `running`) must not reapply the stale
        // snapshot over the resync.
        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await Task.yield()
        XCTAssertEqual(store.permissions, [],
                       "a non-permissions frame must not resurrect a permission cleared by resync")
    }

    /// A permissions frame followed immediately by an unrelated frame for the
    /// SAME session must not lose the permission. `lastStreamFrame` is a
    /// single mutable slot read one run-loop turn later than the frame that
    /// set it (the sink is `receive(on: .main)`), so a following frame can
    /// overwrite that slot before the deferred sink observes it. Gating the
    /// apply on the stamp (the cycle-1 fix) fails this case — the permissions
    /// frame is silently dropped and the card never renders. Edge-triggering
    /// on the payload VALUE instead is immune to this ordering.
    func testPermissionsFrameSurvivesImmediatelyFollowingFrame() async {
        let stream = TestStreamControl()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: eventStore,
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        await Task.yield()

        stream.inject(#"{"kind":"stream","sub":"permissions","sessionId":"ses","payload":{"permissions":[{"id":"perm_1","sessionID":"ses","permission":"Bash","patterns":["~/secrets.json"]}]}}"#)
        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await Task.yield()

        XCTAssertEqual(store.permissions.map(\.id), ["perm_1"],
                       "a permissions frame must not be lost when a following frame for the same session arrives before the deferred sink runs")
    }

    /// start() twice must not double the one-time work: one transcript fetch,
    /// even when the loading branch fires twice in a row.
    func testStartTwiceCreatesOneFetch() async {
        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: MantaEventStore(stream: TestStreamControl(), tokenProvider: { nil }, serverProvider: { nil }),
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil }, session: Self.failingSession())
        )
        store.start()
        store.start()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(store.transcriptFetchCount, 1,
                       "start() twice must not double-fetch the transcript")
    }

    // MARK: - Mock transport

    private static func failingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailingURLProtocol.self]
        return URLSession(configuration: config)
    }

    private static func succeedingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SucceedingURLProtocol.self]
        return URLSession(configuration: config)
    }
}

/// URLSession protocol that fails every request with a connection error (an
/// unreachable box).
private final class FailingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

/// URLSession protocol that succeeds with an empty RPC result, so `send()`
/// reports success (as a reachable box would).
private final class SucceedingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Data(#"{"result":{}}"#.utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A stream control that never connects but can inject frames into the store,
/// so tests can drive `sessionStates` deterministically.
@MainActor
private final class TestStreamControl: MantaEventStreamControl {
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

// MARK: - Per-frame carried facts (which turn-state fields the frame carried)

@MainActor
final class ChatStreamDeltaTests: XCTestCase {

    /// A frame aimed at a DIFFERENT session carries nothing for this one.
    func testForeignSessionCarriesNothing() {
        let c = ChatStreamDelta.carried(sessionIsTarget: false, sub: "running")
        XCTAssertFalse(c.running)
        XCTAssertFalse(c.turnComplete)
    }

    /// A non-carrying frame (e.g. `context`) carries no turn-state fields — even
    /// though the accumulated snapshot is sticky after turn 1.
    func testContextSubCarriesNothing() {
        let c = ChatStreamDelta.carried(sessionIsTarget: true, sub: "context")
        XCTAssertFalse(c.running)
        XCTAssertFalse(c.turnComplete)
    }

    /// A `running` frame carries a running value, not completion.
    func testRunningSubCarriesRunningOnly() {
        let c = ChatStreamDelta.carried(sessionIsTarget: true, sub: "running")
        XCTAssertTrue(c.running)
        XCTAssertFalse(c.turnComplete)
    }

    /// A `turnComplete` frame carries BOTH running and completion.
    func testTurnCompleteSubCarriesRunningAndCompletion() {
        let c = ChatStreamDelta.carried(sessionIsTarget: true, sub: "turnComplete")
        XCTAssertTrue(c.running)
        XCTAssertTrue(c.turnComplete)
    }
}
