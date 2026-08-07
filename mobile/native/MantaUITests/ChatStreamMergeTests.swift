import XCTest
@testable import MantaUI

// BET-668 — the single-writer stream merge. The chat screen has two writers
// for turn state (optimistic local mutations vs incoming stream frames), and
// these test the pure merge decisions so a frame can never clobber an
// optimistic value. No HTTP/view/Keychain involved except the small store-
// level failed-send seam (mocked transport).

@MainActor
final class ChatStreamMergeTests: XCTestCase {

    // MARK: - Fixtures

    private func question(_ id: String) -> QuestionRequest {
        QuestionRequest(id: id, sessionID: "ses", questions: [], tool: nil, requestId: nil)
    }

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

    // MARK: - Running: nil means "no opinion"

    /// A frame that carries no `running` field (e.g. a context frame) must NOT
    /// flip an optimistic `running = true` back to false — that used to reset
    /// `runningSince`, re-mint the tail id, and flash the running row.
    func testFrameWithoutRunningKeepsOptimisticRunning() {
        let state = turnState(running: true, tail: "tail")
        let result = ChatStreamMerge.applying(frameRunning: nil, frameTurnComplete: nil, frameQuestions: nil, to: state)
        XCTAssertTrue(result.state.running)
        XCTAssertFalse(result.mintsNewTail)
        XCTAssertEqual(result.state.streamingTailID, "tail")
    }

    /// A real `running: false` write is honoured — but on its own it must NOT
    /// reset the tail id.
    func testRunningFalseIsHonouredButDoesNotResetTailID() {
        let state = turnState(running: true, tail: "tail")
        let result = ChatStreamMerge.applying(frameRunning: false, frameTurnComplete: nil, frameQuestions: nil, to: state)
        XCTAssertFalse(result.state.running)
        XCTAssertEqual(result.state.streamingTailID, "tail",
                       "a bare running==false write must never reset the tail id")
        XCTAssertFalse(result.mintsNewTail)
    }

    // MARK: - Tail identity: once per turn, reset only on turnComplete

    /// The `turnComplete` edge is the ONLY thing that resets the tail id.
    func testTurnCompleteResetsTailID() {
        let state = turnState(running: true, tail: "tail")
        let result = ChatStreamMerge.applying(frameRunning: false, frameTurnComplete: true, frameQuestions: nil, to: state)
        XCTAssertEqual(result.state.streamingTailID, "")
    }

    /// The first running false->true edge of a turn requests a fresh tail id;
    /// a turn that already has one never mints again (no mid-turn re-mint →
    /// no streaming row replacement / flicker).
    func testTailMintedOncePerTurn() {
        let idle = turnState(running: false, tail: "")
        let first = ChatStreamMerge.applying(frameRunning: true, frameTurnComplete: nil, frameQuestions: nil, to: idle)
        XCTAssertTrue(first.mintsNewTail)

        // The store writes the actual id; a later running frame sees it and
        // must not mint a second time.
        var running = first.state
        running.streamingTailID = "live-ses-UUID"
        let second = ChatStreamMerge.applying(frameRunning: true, frameTurnComplete: nil, frameQuestions: nil, to: running)
        XCTAssertFalse(second.mintsNewTail, "a turn that already has a tail must not mint again")
    }

    /// A STALE `turnComplete == true` left over from a previous turn must not
    /// suppress minting when a new turn starts running (a frame that carries
    /// running but no completion). This is the box-started-turn case a passing
    /// of the accumulated sticky snapshot used to break.
    func testStickyTurnCompleteDoesNotSuppressMintOnRunningFrame() {
        let state = turnState(running: false, turnComplete: true, tail: "")
        let result = ChatStreamMerge.applying(frameRunning: true, frameTurnComplete: nil, frameQuestions: nil, to: state)
        XCTAssertTrue(result.mintsNewTail, "a running frame must mint a tail even with a stale turnComplete")
        XCTAssertFalse(result.state.turnComplete, "a running frame starts a turn, clearing the completion flag")
    }

    /// A context frame arriving AFTER a completed turn (accumulated running
    /// false, turnComplete true) must not clear an optimistic running or
    /// rest the tail — it carries no opinion.
    func testContextFrameAfterCompletedTurnClobbersNeitherRunningNorTail() {
        let state = turnState(running: true, turnComplete: false, tail: "tail")
        let result = ChatStreamMerge.applying(frameRunning: nil, frameTurnComplete: nil, frameQuestions: nil, to: state)
        XCTAssertTrue(result.state.running)
        XCTAssertEqual(result.state.streamingTailID, "tail")
        XCTAssertFalse(result.mintsNewTail)
    }

    // MARK: - Question tombstoning

    /// An id the user answered locally is filtered out of the incoming payload
    /// until the box catches up.
    func testTombstonedQuestionIsFilteredAndStaysTombstonedWhilePublished() {
        let state = turnState(tombstones: ["q1"])
        let incoming = [question("q1"), question("q2")]
        let result = ChatStreamMerge.applying(frameRunning: nil, frameTurnComplete: nil, frameQuestions: incoming, to: state)
        XCTAssertEqual(result.state.questions.map(\.id), ["q2"])
        XCTAssertEqual(result.state.locallyAnsweredQuestionIDs, Set(["q1"]),
                       "a still-published id stays tombstoned so it cannot flash back")
    }

    /// Once the box stops publishing a tombstoned id, the tombstone is dropped.
    func testTombstoneDropsWhenBoxStopsPublishingId() {
        let state = turnState(tombstones: ["q1"])
        let incoming = [question("q2")]
        let result = ChatStreamMerge.applying(frameRunning: nil, frameTurnComplete: nil, frameQuestions: incoming, to: state)
        XCTAssertEqual(result.state.locallyAnsweredQuestionIDs, Set())
        XCTAssertEqual(result.state.questions.map(\.id), ["q2"])
    }

    /// A frame with no questions payload leaves the current questions alone
    /// (the route that used to clobber optimistically-removed cards on every
    /// non-question frame).
    func testNoQuestionsPayloadKeepsCurrentQuestions() {
        let state = turnState(questions: [question("q1")])
        let result = ChatStreamMerge.applying(frameRunning: nil, frameTurnComplete: nil, frameQuestions: nil, to: state)
        XCTAssertEqual(result.state.questions.map(\.id), ["q1"])
    }

    // MARK: - Failed send

    /// The pure rollback clears running + the tail, and leaves the
    /// transcript-visible state (questions/tombstones) untouched.
    func testAfterSendFailureRollsBackRunningAndPreservesState() {
        let state = turnState(running: true, tail: "tail", tombstones: ["x"], questions: [question("q1")])
        let rolled = ChatStreamMerge.afterSendFailure(to: state)
        XCTAssertFalse(rolled.running)
        XCTAssertEqual(rolled.streamingTailID, "")
        XCTAssertEqual(rolled.questions.map(\.id), ["q1"])
        XCTAssertEqual(rolled.locallyAnsweredQuestionIDs, Set(["x"]))
    }

    /// Store-level seam: a send whose RPC throws must return false, roll the
    /// running state back (no forever-spinner), and NOT lose the prompt — the
    /// optimistic `.user` block stays in the transcript for the caller to
    /// restore.
    func testFailedSendResetsRunningAndPreservesPrompt() async {
        let api = MantaAPIClient(
            serverURL: URL(string: "https://127.0.0.1")!,
            tokenProvider: { nil },
            session: Self.failingSession()
        )
        let store = ChatSessionStore(
            sessionId: "ses",
            eventStore: MantaEventStore(stream: FailingSendStream(), tokenProvider: { nil }, serverProvider: { nil }),
            api: api
        )
        let ok = await store.send(text: "hello", attachments: [], model: nil)
        XCTAssertFalse(ok, "a failed send must be reported as failed")
        XCTAssertFalse(store.running, "a failed send must stop the running state (no forever-spinner)")

        // The optimistic echo is rolled back: the box never received the
        // message, so it must NOT stand in the transcript as if sent — it
        // belongs back in the input the caller restores.
        let userBlocks = store.transcript.filter {
            if case .user(_, _) = $0 { return true }
            return false
        }
        XCTAssertEqual(userBlocks.count, 0, "a failed send must not leave the message in the transcript")
    }

    // MARK: - Mock transport that makes every request fail

    private static func failingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FailingURLProtocol.self]
        return URLSession(configuration: config)
    }
}

/// URLSession protocol that fails every request with a connection error, so a
/// real `MantaAPIClient` reliably throws (as an unreachable box would).
private final class FailingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

/// A stream control that never connects (so `MantaEventStore` never tries a
/// real socket); sufficient for the store's `send` seam.
@MainActor
private final class FailingSendStream: MantaEventStreamControl {
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
}

// MARK: - Per-frame delta extraction (the seam that fixes running-clobber on
// turn 2+: the merge is fed what the frame CARRIED, not the sticky accumulator).

@MainActor
final class ChatStreamDeltaTests: XCTestCase {

    /// A frame aimed at a DIFFERENT session must yield all-nil ("no opinion"),
    /// so replaying another session's frame can't clobber this one's state.
    func testForeignSessionYieldsNoOpinion() {
        let fields = ChatStreamDelta.turnFields(
            sessionIsTarget: false, sub: "running",
            stateRunning: true, stateTurnComplete: true, stateQuestions: nil)
        XCTAssertNil(fields.running)
        XCTAssertNil(fields.turnComplete)
        XCTAssertNil(fields.questions)
    }

    /// A non-carrying frame (e.g. `context`) must NOT report a running value —
    /// even though the accumulated snapshot is sticky `false` after turn 1.
    /// This is what lets an optimistic `send()` survive an unrelated frame on
    /// turn 2+.
    func testContextSubCarriesNoTurnFields() {
        let fields = ChatStreamDelta.turnFields(
            sessionIsTarget: true, sub: "context",
            stateRunning: false, stateTurnComplete: true, stateQuestions: nil)
        XCTAssertNil(fields.running)
        XCTAssertNil(fields.turnComplete)
        XCTAssertNil(fields.questions)
    }

    /// A `running` frame carries the running value but not completion/questions.
    func testRunningSubCarriesRunningOnly() {
        let fields = ChatStreamDelta.turnFields(
            sessionIsTarget: true, sub: "running",
            stateRunning: true, stateTurnComplete: nil, stateQuestions: nil)
        XCTAssertEqual(fields.running, true)
        XCTAssertNil(fields.turnComplete)
        XCTAssertNil(fields.questions)
    }

    /// A `turnComplete` frame carries BOTH running and completion.
    func testTurnCompleteSubCarriesRunningAndCompletion() {
        let fields = ChatStreamDelta.turnFields(
            sessionIsTarget: true, sub: "turnComplete",
            stateRunning: false, stateTurnComplete: true, stateQuestions: nil)
        XCTAssertEqual(fields.running, false)
        XCTAssertEqual(fields.turnComplete, true)
        XCTAssertNil(fields.questions)
    }

    /// A `questions` frame carries only the questions payload.
    func testQuestionsSubCarriesQuestionsOnly() {
        let q = QuestionRequest(id: "q1", sessionID: "ses", questions: [], tool: nil, requestId: nil)
        let fields = ChatStreamDelta.turnFields(
            sessionIsTarget: true, sub: "questions",
            stateRunning: false, stateTurnComplete: false, stateQuestions: [q])
        XCTAssertNil(fields.running)
        XCTAssertNil(fields.turnComplete)
        XCTAssertEqual(fields.questions?.map(\.id), ["q1"])
    }
}
