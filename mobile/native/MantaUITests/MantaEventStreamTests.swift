import XCTest
@testable import MantaUI

// ===========================================================================
// S1b — event stream tests (BET-593)
//
// Covers the pure + transport-injectable halves: frame parsing, typed
// interpreted-payload decoding, the router (box `stream.*` subs -> session
// state), the backoff/connection-state/liveness policies, the reconnect
// controller (drop -> backup -> reconnect -> re-fetch), and the store's
// degraded mode (only NEW interpretation stops; already-delivered data is
// never cleared or re-derived).
// ===========================================================================

// MARK: - Fakes

private final class FakeSocket: MantaWebSocketSession {
    var onOpen: (@MainActor () -> Void)?
    var onMessage: (@MainActor (String) -> Void)?
    var onDrop: (@MainActor () -> Void)?
    var isOpen = false
    var connectCount = 0
    var openedURL: URL?
    var closeCount = 0

    func connect(to url: URL) {
        connectCount += 1
        openedURL = url
        isOpen = true
    }
    func close() { isOpen = false; closeCount += 1 }
    @MainActor func simulateOpen() { onOpen?() }
    @MainActor func simulateMessage(_ text: String) { onMessage?(text) }
    @MainActor func simulateDrop() { isOpen = false; onDrop?() }
}

@MainActor
private final class FakeScheduler: MantaScheduler {
    struct Item {
        let delayMs: Double
        let token: UUID
        let block: @MainActor () -> Void
    }
    private var items: [Item] = []
    private var cancelled: Set<UUID> = []

    func schedule(after delayMs: Double, _ block: @escaping @MainActor () -> Void) -> any MantaCancelable {
        let item = Item(delayMs: delayMs, token: UUID(), block: block)
        items.append(item)
        return FakeCancelable(token: item.token) { [weak self] token in self?.cancelled.insert(token) }
    }

    var count: Int { items.count }
    func delay(at index: Int) -> Double? { items.indices.contains(index) ? items[index].delayMs : nil }
    func fire(at index: Int) {
        guard items.indices.contains(index), !cancelled.contains(items[index].token) else { return }
        items[index].block()
    }
}

@MainActor
private final class FakeCancelable: MantaCancelable {
    private let token: UUID
    private let onCancel: (UUID) -> Void
    init(token: UUID, onCancel: @escaping (UUID) -> Void) {
        self.token = token
        self.onCancel = onCancel
    }
    func cancel() { onCancel(token) }
}

@MainActor
private final class FakeStreamControl: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle
    var makeSocket: ((URL) -> any MantaWebSocketSession)?

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}

    func drive(_ state: MantaConnectionState) { onState?(state) }
    func inject(_ text: String) { onMessage?(text) }
    func injectReconnect() { onReconnect?() }
}

// MARK: - Frame parsing + payload decoding

@MainActor
final class MantaEventStreamModelTests: XCTestCase {
    private func frame(_ text: String) throws -> MantaStreamFrame {
        try MantaStreamFrame.parse(text)
    }

    func testParsesStreamFlushEnvelope() throws {
        let f = try frame(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        XCTAssertEqual(f.kind, "stream")
        XCTAssertEqual(f.sub, "flush")
        XCTAssertEqual(f.sessionId, "ses_1")
        XCTAssertFalse(f.isHeartbeat)
        let p = try XCTUnwrap(f.decodedPayload(StreamFlushPayload.self))
        XCTAssertEqual(p.messageID, "msg_2")
        XCTAssertEqual(p.partID, "part_3")
        XCTAssertEqual(p.field, "text")
        XCTAssertEqual(p.text, "Hello")
    }

    func testParsesHeartbeatFrame() throws {
        let f = try frame(#"{"kind":"heartbeat","ts":1750000000000}"#)
        XCTAssertTrue(f.isHeartbeat)
        XCTAssertNil(f.payload)
    }

    // MARK: - sessionId / eventType resolution (BET-1348)

    /// Raw opencode events carry the session id inside the payload (the box
    /// envelope has none). The parser must fall back to it.
    func testParseTakesSessionIDFromPayloadWhenEnvelopeHasNone() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"sessionID":"ses_payload"}}"#)
        XCTAssertEqual(f.sessionId, "ses_payload")
        XCTAssertNil(f.eventType)
    }

    /// The session id can also sit under payload.properties (the box nests it
    /// there for raw opencode events). The parser must descend into it.
    func testParseTakesSessionIDFromPayloadProperties() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"properties":{"sessionID":"ses_1"}}}"#)
        XCTAssertEqual(f.sessionId, "ses_1")
    }

    /// The envelope key wins when both are present.
    func testParsePrefersEnvelopeSessionIDOverPayload() throws {
        let f = try frame(#"{"kind":"stream","sessionId":"ses_env","payload":{"sessionID":"ses_payload"}}"#)
        XCTAssertEqual(f.sessionId, "ses_env")
    }

    /// No session id anywhere -> nil, not a crash.
    func testParseReturnsNilSessionIDWhenNeitherExists() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"type":"question.asked"}}"#)
        XCTAssertNil(f.sessionId)
    }

    /// The event type lives at payload.type for raw opencode frames.
    func testParseResolvesEventTypeFromPayloadType() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"type":"question.asked"}}"#)
        XCTAssertEqual(f.eventType, "question.asked")
    }

    /// Older boxes put the type at payload.kind; that is the fallback.
    func testParseFallsBackEventTypeToPayloadKind() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"kind":"permission.asked"}}"#)
        XCTAssertEqual(f.eventType, "permission.asked")
    }

    /// No type anywhere -> eventType nil.
    func testParseReturnsNilEventTypeWhenNeitherExists() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"properties":{"foo":"bar"}}}"#)
        XCTAssertNil(f.eventType)
    }

    /// REGRESSION — the literal frame that ships the needs-you dot. Both the
    /// session id (from payload.sessionID) and the type (from payload.type)
    /// must resolve, because the box envelope carries neither.
    func testParseQuestionAskedFrameResolvesSessionAndType() throws {
        let f = try frame(#"{"kind":"opencode","payload":{"type":"question.asked","properties":{"sessionID":"ses_1"}}}"#)
        XCTAssertEqual(f.sessionId, "ses_1")
        XCTAssertEqual(f.eventType, "question.asked")
        XCTAssertEqual(f.kind, "opencode")
    }

    func testParsesRunningPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamRunningPayload.self))
        XCTAssertTrue(p.running)
    }

    func testParsesTurnCompletePayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamTurnCompletePayload.self))
        XCTAssertTrue(p.complete)
        XCTAssertFalse(p.running)
    }

    // MARK: - Live tool frames (BET-753)

    func testParsesToolStartedPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"toolStarted","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"toolu_1","toolName":"bash","toolPresentationHint":"Run: npm test","status":"running"}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamToolStartedPayload.self))
        XCTAssertEqual(p.idx, "toolu_1")
        XCTAssertEqual(p.toolName, "bash")
        XCTAssertEqual(p.toolPresentationHint, "Run: npm test")
        XCTAssertEqual(p.status, "running")
    }

    func testParsesToolOutputPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"toolOutput","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"toolu_1","text":"line1\n"}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamToolOutputPayload.self))
        XCTAssertEqual(p.idx, "toolu_1")
        XCTAssertEqual(p.text, "line1\n")
    }

    func testParsesToolEndedPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"toolEnded","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"toolu_1","ok":false,"truncated":true}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamToolEndedPayload.self))
        XCTAssertEqual(p.idx, "toolu_1")
        XCTAssertEqual(p.ok, false)
        XCTAssertEqual(p.truncated, true)
    }

    func testParsesContextPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"context","sessionId":"ses_1","payload":{"freshInput":10,"cacheRead":5,"cacheWrite":2,"totalInput":17,"pct":8,"hasLimit":true,"segments":[{"kind":"fresh","pct":5},{"kind":"cacheWrite","pct":1},{"kind":"cacheRead","pct":2}]}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamContextPayload.self))
        XCTAssertEqual(p.freshInput, 10)
        XCTAssertEqual(p.cacheRead, 5)
        XCTAssertEqual(p.pct, 8)
        XCTAssertEqual(p.hasLimit, true)
        XCTAssertEqual(p.segments.count, 3)
    }

    func testParsesContextPayloadWithoutLimit() throws {
        let f = try frame(#"{"kind":"stream","sub":"context","sessionId":"ses_1","payload":{"freshInput":10,"cacheRead":5,"cacheWrite":2,"totalInput":17,"pct":0,"hasLimit":false,"segments":[]}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamContextPayload.self))
        XCTAssertEqual(p.hasLimit, false)
        XCTAssertEqual(p.segments.count, 0)
    }

    func testParsesTruncationPayloadWithMessageID() throws {
        let f = try frame(#"{"kind":"stream","sub":"truncation","sessionId":"ses_1","payload":{"kind":"output-cap","label":"truncated (output limit)","messageID":"msg_2"}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamTruncationPayload.self))
        XCTAssertEqual(p.kind, "output-cap")
        XCTAssertEqual(p.messageID, "msg_2")
    }

    func testParsesTodosPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"todos","sessionId":"ses_1","payload":{"active":[{"status":"in_progress","content":"run tests"}],"visible":{"visible":[{"status":"in_progress","content":"run tests"}],"hiddenPending":0,"hiddenDone":0},"allTerminal":false,"anyTerminal":false}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamTodosPayload.self))
        XCTAssertEqual(p.active?.first?.content, "run tests")
        XCTAssertEqual(p.visible?.visible.count, 1)
        XCTAssertFalse(p.allTerminal)
    }

    func testParsesSubagentPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"subagent","sessionId":"ses_1","payload":{"childSessionId":"ses_child","agent":"general","status":"running","runningCount":1,"model":{"providerID":"anthropic","modelID":"claude-sonnet-4-6"}}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamSubagentPayload.self))
        XCTAssertEqual(p.childSessionId, "ses_child")
        XCTAssertEqual(p.runningCount, 1)
        XCTAssertEqual(p.model?.providerID, "anthropic")
    }

    func testParsesQuestionsPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"questions","sessionId":"ses_1","payload":{"questions":[{"id":"q_1","sessionID":"ses_1","requestId":"que_5","questions":[{"question":"Pick","header":"Pick a DB","options":[{"label":"Postgres","description":""}]}],"tool":{"messageID":"msg_3","callID":"toolu_9"}}]}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamQuestionsPayload.self))
        XCTAssertEqual(p.questions.count, 1)
        XCTAssertEqual(p.questions[0].id, "q_1")
        XCTAssertEqual(p.questions[0].requestId, "que_5")
        XCTAssertEqual(p.questions[0].questions[0].header, "Pick a DB")
        XCTAssertEqual(p.questions[0].tool?.callID, "toolu_9")
    }

    func testFrameMissingKindThrows() {
        XCTAssertThrowsError(try MantaStreamFrame.parse(#"{"payload":{}}"#))
    }

    func testFrameNotObjectThrows() {
        XCTAssertThrowsError(try MantaStreamFrame.parse(#"[1,2,3]"#))
    }

    func testBackoffCappedSchedule() {
        let b = ExponentialBackoff(jitter: false)
        XCTAssertEqual(b.cappedDelayMs(forAttempt: 0), 1000)
        XCTAssertEqual(b.cappedDelayMs(forAttempt: 1), 2000)
        XCTAssertEqual(b.cappedDelayMs(forAttempt: 4), 15000) // capped at max
        XCTAssertEqual(b.delayMs(forAttempt: 4, rng: { 1.0 }), 15000) // capped at max
    }

    func testBackoffJitterWithinBounds() {
        let b = ExponentialBackoff(jitter: true)
        for attempt in 0..<5 {
            for _ in 0..<50 {
                let d = b.delayMs(forAttempt: attempt, rng: { 0.5 })
                XCTAssertGreaterThanOrEqual(d, 0)
                XCTAssertLessThanOrEqual(d, b.cappedDelayMs(forAttempt: attempt))
            }
        }
    }

    func testConnectionStateTransitions() {
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .idle, to: .connecting(attempt: 0)))
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .connecting(attempt: 0), to: .connected))
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .connected, to: .stalled))
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .stalled, to: .reconnecting(attempt: 1, backoffMs: 1000)))
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .reconnecting(attempt: 1, backoffMs: 1000), to: .connected))
        XCTAssertTrue(MantaConnectionRule.canTransition(from: .closed(reason: "x"), to: .idle))
        XCTAssertFalse(MantaConnectionRule.canTransition(from: .connected, to: .connecting(attempt: 0)))
        XCTAssertFalse(MantaConnectionRule.canTransition(from: .idle, to: .closed(reason: "x")))
    }

    func testConnectionStateUnreachableFlags() {
        XCTAssertFalse(MantaConnectionState.connected.isUnreachable)
        XCTAssertFalse(MantaConnectionState.connecting(attempt: 0).isUnreachable)
        XCTAssertTrue(MantaConnectionState.reconnecting(attempt: 1, backoffMs: 1000).isUnreachable)
        XCTAssertTrue(MantaConnectionState.closed(reason: "x").isUnreachable)
    }

    func testLivenessPolicy() {
        let last = Date()
        let future = last.addingTimeInterval(50) // 50s later
        XCTAssertTrue(MantaLivenessPolicy.shouldForceReconnect(
            state: .connected, lastFrameAt: last, now: future, staleMs: 45_000))
        XCTAssertFalse(MantaLivenessPolicy.shouldForceReconnect(
            state: .connected, lastFrameAt: last, now: future.addingTimeInterval(-10), staleMs: 45_000))
        XCTAssertFalse(MantaLivenessPolicy.shouldForceReconnect(
            state: .reconnecting(attempt: 1, backoffMs: 1000), lastFrameAt: last, now: future, staleMs: 45_000))
    }
}

// MARK: - Router

@MainActor
final class MantaEventStreamRouterTests: XCTestCase {
    func testAccumulatesFlushDeltasAcrossParts() throws {
        let f1 = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello "}}"#)
        let f2 = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"world"}}"#)
        let f3 = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"other","field":"text","text":"x"}}"#)

        var state = MantaStreamRouter.applying(f1, to: nil)
        state = MantaStreamRouter.applying(f2, to: state)
        state = MantaStreamRouter.applying(f3, to: state)

        XCTAssertEqual(state.textByPart["part_3"], "Hello world")
        XCTAssertEqual(state.textByPart["other"], "x")
    }

    func testSetsRunningAndTurnComplete() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        let running = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#)
        let complete = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)
        state = MantaStreamRouter.applying(running, to: state)
        XCTAssertEqual(state.running, true)
        state = MantaStreamRouter.applying(complete, to: state)
        XCTAssertEqual(state.turnComplete, true)
        // turnComplete ALSO clears `running`: the box never sends running:false
        // on the `running` sub, so turnComplete's own `running` field is the
        // only end-of-turn signal (otherwise the flag latches true forever).
        XCTAssertEqual(state.running, false)
    }

    /// FINDING: the box never sends `running:false` on the `running` sub —
    /// every `running` frame observed on a live `/events` capture carried
    /// `running:true`. The end of a turn is announced ONLY by turnComplete's
    /// own `running` field, so this is the sole signal that lowers the flag.
    /// Ignoring it (the old behaviour) latched `running` true for the life of
    /// the session, keeping the working row and the list timer running forever.
    func testTurnCompleteLowersTheLatchedRunningFlag() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#),
            to: state
        )
        XCTAssertEqual(state.running, true)

        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#),
            to: state
        )

        XCTAssertEqual(state.running, false)
        XCTAssertEqual(state.turnComplete, true)
    }

    // MARK: - Plan-mode mirror (BET-977)

    func testPlanModeFrameToRecordedValue() throws {
        // The box mirrors opencode's LOCAL plan switch: a completed plan_enter
        // emits {on:true}, plan_exit {on:false}. The router records whichever
        // value landed so the per-session store can route it to setPlan.
        let enter = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"planMode","sessionId":"ses_1","payload":{"on":true}}"#)
        var state = MantaStreamRouter.applying(enter, to: nil)
        XCTAssertEqual(state.planOn, true)

        let exit = try MantaStreamFrame.parse(#"{"kind":"stream","sub":"planMode","sessionId":"ses_1","payload":{"on":false}}"#)
        state = MantaStreamRouter.applying(exit, to: state)
        XCTAssertEqual(state.planOn, false)
    }

    func testPlanModeStartsNilUntilAFrameLands() {
        // A fresh session has no plan-mode fact until the box emits one.
        let state = MantaSessionStreamState(sessionId: "ses_1")
        XCTAssertNil(state.planOn)
    }

    // MARK: - Turn-start stamp (BET-896)

    /// The box stamps `since` (epoch ms) on the idle->busy edge; the router
    /// converts it to a Date (ms -> seconds) that the UI counts from.
    func testRunningFrameWithSinceProducesMatchingDate() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true,"since":1700000000000}}"#),
            to: state
        )
        XCTAssertEqual(state.runningSince, Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// An older box omits `since`; a running:true frame must keep whatever we
    /// already had rather than restart the clock.
    func testRunningFrameWithoutSinceKeepsExistingStamp() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state.runningSince = Date(timeIntervalSince1970: 1234)
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#),
            to: state
        )
        XCTAssertEqual(state.runningSince, Date(timeIntervalSince1970: 1234))
    }

    /// running:true with neither a box stamp nor an existing value falls back
    /// to the local clock so a timer still shows.
    func testRunningFrameWithoutSinceAndNoExistingFallsBackToNow() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#),
            to: state
        )
        XCTAssertNotNil(state.runningSince)
    }

    /// running:false on either sub clears the stamp back to nil.
    func testRunningFalseClearsStamp() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state.runningSince = Date(timeIntervalSince1970: 5000)
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":false,"since":null}}"#),
            to: state
        )
        XCTAssertNil(state.runningSince)

        var state2 = MantaSessionStreamState(sessionId: "ses_1")
        state2.runningSince = Date(timeIntervalSince1970: 5000)
        state2 = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false,"since":null}}"#),
            to: state2
        )
        XCTAssertNil(state2.runningSince)
    }

    func testNonStreamFrameLeavesStateUntouched() throws {
        let original = MantaSessionStreamState(sessionId: "ses_1")
        let status = try MantaStreamFrame.parse(#"{"kind":"status","payload":[]}"#)
        let resulting = MantaStreamRouter.applying(status, to: original)
        XCTAssertEqual(resulting, original)
    }

    // MARK: - Running-set reconcile on reconnect (BET-922)

    /// The box's reconnect snapshot is an authoritative `runningSet` frame. A
    /// session in the set is running, with `since` converted ms -> seconds.
    func testRunningSetMarksListedSessionRunningWithSinceConverted() {
        var states: [String: MantaSessionStreamState] = [:]
        states["ses_1"] = MantaSessionStreamState(sessionId: "ses_1")
        let payload = StreamRunningSetPayload(sessions: [
            .init(sessionId: "ses_1", since: 1_700_000_000_000, type: "busy")
        ])
        states = MantaStreamRouter.applyingRunningSet(payload, to: states)
        XCTAssertEqual(states["ses_1"]?.running, true)
        XCTAssertEqual(states["ses_1"]?.runningSince, Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// REGRESSION (the whole point of BET-922): a session latched `running:true`
    /// in state but absent from the authoritative set must flip to idle. Silence
    /// from the box is now "it stopped".
    func testRunningSetClearsLatchedRunningAbsentFromTheSet() {
        var states: [String: MantaSessionStreamState] = [:]
        var s = MantaSessionStreamState(sessionId: "ses_1")
        s.running = true
        s.runningSince = Date(timeIntervalSince1970: 1000)
        states["ses_1"] = s
        let payload = StreamRunningSetPayload(sessions: [])
        states = MantaStreamRouter.applyingRunningSet(payload, to: states)
        XCTAssertEqual(states["ses_1"]?.running, false)
        XCTAssertNil(states["ses_1"]?.runningSince)
    }

    /// A session the device has never seen a frame for can still be running on
    /// the box, so the set must materialise it.
    func testRunningSetCreatesStateForSessionItHasNeverSeen() {
        var states: [String: MantaSessionStreamState] = [:]
        let payload = StreamRunningSetPayload(sessions: [
            .init(sessionId: "ses_new", since: 1_700_000_000_000, type: nil)
        ])
        states = MantaStreamRouter.applyingRunningSet(payload, to: states)
        XCTAssertEqual(states["ses_new"]?.running, true)
        XCTAssertEqual(states["ses_new"]?.runningSince, Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// An empty set is the correction a stale client needs: every running
    /// session is cleared.
    func testRunningSetEmptyClearsEveryRunningSession() {
        var states: [String: MantaSessionStreamState] = [:]
        for id in ["ses_a", "ses_b"] {
            var s = MantaSessionStreamState(sessionId: id)
            s.running = true
            s.runningSince = Date(timeIntervalSince1970: 1000)
            states[id] = s
        }
        states = MantaStreamRouter.applyingRunningSet(
            StreamRunningSetPayload(sessions: []), to: states
        )
        XCTAssertEqual(states["ses_a"]?.running, false)
        XCTAssertEqual(states["ses_b"]?.running, false)
        XCTAssertNil(states["ses_a"]?.runningSince)
        XCTAssertNil(states["ses_b"]?.runningSince)
    }

    /// Only `running` / `runningSince` are reconciled — turn retirement, stream
    /// chunks and live tools are owned by the reconnect transcript refetch and
    /// must survive the apply untouched.
    func testRunningSetLeavesTurnCompleteChunksAndToolsUntouched() {
        var s = MantaSessionStreamState(sessionId: "ses_1")
        s.turnComplete = true
        s.chunks = [StreamTextChunk(partID: "p", messageID: "m", field: "text", text: "hi")]
        s.tools["t1"] = LiveTool(idx: "t1", callID: "t1", name: "bash", presentationHint: nil, status: "running")
        s.toolStartOrder = ["t1"]
        let payload = StreamRunningSetPayload(sessions: [
            .init(sessionId: "ses_1", since: 1_700_000_000_000, type: "busy")
        ])
        let next = MantaStreamRouter.applyingRunningSet(payload, to: ["ses_1": s])
        XCTAssertEqual(next["ses_1"]?.running, true)
        XCTAssertEqual(next["ses_1"]?.turnComplete, true)
        XCTAssertEqual(next["ses_1"]?.chunks, [StreamTextChunk(partID: "p", messageID: "m", field: "text", text: "hi")])
        XCTAssertEqual(next["ses_1"]?.tools["t1"]?.name, "bash")
        XCTAssertEqual(next["ses_1"]?.toolStartOrder, ["t1"])
    }

    /// REGRESSION (BET-1066): a `runningSet` entry with a box `since` MUST set
    /// `runningSince` to that epoch-derived date — never the local clock. This
    /// is what makes a mid-turn force-quit + relaunch resume the session-list
    /// timer at the real elapsed time.
    func testRunningSetWithBoxSinceOnFreshStateUsesBoxStartNotNow() {
        var states: [String: MantaSessionStreamState] = [:]
        let payload = StreamRunningSetPayload(sessions: [
            .init(sessionId: "ses_1", since: 1_700_000_000_000, type: "busy")
        ])
        states = MantaStreamRouter.applyingRunningSet(payload, to: states)
        XCTAssertEqual(states["ses_1"]?.running, true)
        XCTAssertEqual(states["ses_1"]?.runningSince, Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// REGRESSION (BET-1066): a `runningSet` entry with nil `since` applied to a
    /// FRESH state must NOT silently seed the local clock — that renders the
    /// force-quit turn timer as "0" (counting from the launch moment). The
    /// start stays unknown (`nil`) rather than being fabricated.
    func testRunningSetNilSinceOnFreshStateDoesNotSeedLocalClock() {
        var states: [String: MantaSessionStreamState] = [:]
        let payload = StreamRunningSetPayload(sessions: [
            .init(sessionId: "ses_new", since: nil, type: "busy")
        ])
        states = MantaStreamRouter.applyingRunningSet(payload, to: states)
        XCTAssertEqual(states["ses_new"]?.running, true)
        XCTAssertNil(states["ses_new"]?.runningSince)
    }

    /// An older box may omit `since` on a running-set entry for a session we
    /// already know about; the existing stamp must be kept, not restarted at
    /// the local clock.
    func testRunningSetNilSinceKeepsExistingStamp() {
        var s = MantaSessionStreamState(sessionId: "ses_1")
        s.runningSince = Date(timeIntervalSince1970: 1234)
        let next = MantaStreamRouter.applyingRunningSet(
            StreamRunningSetPayload(sessions: [.init(sessionId: "ses_1", since: nil, type: "busy")]),
            to: ["ses_1": s]
        )
        XCTAssertEqual(next["ses_1"]?.running, true)
        XCTAssertEqual(next["ses_1"]?.runningSince, Date(timeIntervalSince1970: 1234))
    }

    /// REGRESSION (BET-1348): the connect snapshot re-emits a `questions` /
    /// `permissions` frame only for sessions whose list is NON-empty, so a
    /// card answered while the device was disconnected would otherwise stay
    /// latched forever. The running set must clear both so the snapshot is
    /// authoritative for pending cards — on a session absent from the set.
    func testRunningSetClearsQuestionsAndPermissionsAbsentFromTheSet() {
        var s = MantaSessionStreamState(sessionId: "ses_1")
        s.questions = StreamQuestionsPayload(questions: [])
        s.permissions = StreamPermissionsPayload(permissions: [])
        let next = MantaStreamRouter.applyingRunningSet(
            StreamRunningSetPayload(sessions: []), to: ["ses_1": s]
        )
        XCTAssertNil(next["ses_1"]?.questions)
        XCTAssertNil(next["ses_1"]?.permissions)
    }

    /// ... and on a session PRESENT in the running set (its still-pending
    /// cards are restored by the snapshot's own frames that follow).
    func testRunningSetClearsQuestionsAndPermissionsPresentInTheSet() {
        var s = MantaSessionStreamState(sessionId: "ses_1")
        s.questions = StreamQuestionsPayload(questions: [])
        s.permissions = StreamPermissionsPayload(permissions: [])
        let next = MantaStreamRouter.applyingRunningSet(
            StreamRunningSetPayload(sessions: [.init(sessionId: "ses_1", since: nil, type: nil)]),
            to: ["ses_1": s]
        )
        XCTAssertNil(next["ses_1"]?.questions)
        XCTAssertNil(next["ses_1"]?.permissions)
    }

    // MARK: - Subagent upsert (BET-672)

    /// A subagent that goes running→done for the SAME child must leave exactly
    /// one record with status `done`, and its running count over the array must
    /// be 0 — the previous append left BOTH records and inflated the count.
    func testSubagentUpsertReplacesByChildSessionID() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"subagent","sessionId":"ses_1","payload":{"childSessionId":"ses_child","status":"running","runningCount":1}}"#),
            to: state
        )
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"subagent","sessionId":"ses_1","payload":{"childSessionId":"ses_child","status":"done"}}"#),
            to: state
        )

        XCTAssertEqual(state.subagents.count, 1)
        XCTAssertEqual(state.subagents[0].childSessionId, "ses_child")
        XCTAssertEqual(state.subagents[0].status, "done")
        let running = state.subagents.filter { $0.status == "running" }
        XCTAssertEqual(running.count, 0)
    }

    /// Distinct children still append — the upsert is keyed by child id, so two
    /// different children coexist.
    func testSubagentUpsertAppendsDistinctChildren() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"subagent","sessionId":"ses_1","payload":{"childSessionId":"ses_a","status":"running"}}"#),
            to: state
        )
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"subagent","sessionId":"ses_1","payload":{"childSessionId":"ses_b","status":"running"}}"#),
            to: state
        )

        XCTAssertEqual(state.subagents.count, 2)
    }

    // MARK: - Live tool frames (BET-753)

    /// A `toolStarted` frame starts a running tool row, keyed by its stable
    /// part id.
    func testToolStartedStartsRunningTool() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolStarted","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"toolu_1","toolName":"bash","toolPresentationHint":"Run: npm test","status":"running"}}"#),
            to: state
        )
        XCTAssertEqual(state.runningTools.count, 1)
        XCTAssertEqual(state.runningTools[0].idx, "toolu_1")
        XCTAssertEqual(state.runningTools[0].name, "bash")
        XCTAssertEqual(state.runningTools[0].presentationHint, "Run: npm test")
        XCTAssertEqual(state.tools["toolu_1"]?.status, "running")
    }

    /// Appended `toolOutput` deltas for the same `idx` concatenate in order; a
    /// new `idx` starts a fresh tail. Running tools render in start order.
    func testToolOutputAppendsByIDAndFreshIndexStartsFreshTail() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        func start(_ idx: String, _ name: String) throws -> MantaStreamFrame {
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolStarted","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"\#(idx)","toolName":"\#(name)","status":"running"}}"#)
        }
        func output(_ idx: String, _ text: String) throws -> MantaStreamFrame {
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolOutput","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"\#(idx)","text":"\#(text)"}}"#)
        }
        state = MantaStreamRouter.applying(try start("a", "bash"), to: state)
        state = MantaStreamRouter.applying(try output("a", "chunk1"), to: state)
        state = MantaStreamRouter.applying(try output("a", "chunk2"), to: state)
        state = MantaStreamRouter.applying(try start("b", "read"), to: state)
        state = MantaStreamRouter.applying(try output("b", "file.txt"), to: state)

        XCTAssertEqual(state.tools["a"]?.tail, "chunk1chunk2", "deltas for the same idx concatenate in arrival order")
        XCTAssertEqual(state.tools["b"]?.tail, "file.txt", "a new idx starts a fresh tail")
        XCTAssertEqual(state.runningTools.map(\.idx), ["a", "b"], "running tools render in start order")
    }

    /// `toolEnded` removes the tool from the running set AND reflects its
    /// outcome (`ok:false` / `truncated`) on the retained record.
    func testToolEndedRemovesFromRunningAndReflectsOutcome() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolStarted","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"a","toolName":"bash","status":"running"}}"#),
            to: state
        )
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolEnded","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"a","ok":false,"truncated":true}}"#),
            to: state
        )
        XCTAssertEqual(state.runningTools.count, 0, "an ended tool leaves the running set")
        XCTAssertEqual(state.tools["a"]?.ended, true, "the outcome is reflected on the record")
        XCTAssertEqual(state.tools["a"]?.ok, false)
        XCTAssertEqual(state.tools["a"]?.truncated, true)
    }

    /// Once the turn completes its running-tool state is dropped — the
    /// canonical refetch now owns the tools as step rows.
    func testTurnCompleteClearsRunningTools() throws {
        var state = MantaSessionStreamState(sessionId: "ses_1")
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"toolStarted","sessionId":"ses_1","payload":{"sessionId":"ses_1","idx":"a","toolName":"bash","status":"running"}}"#),
            to: state
        )
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#),
            to: state
        )
        XCTAssertTrue(state.tools.isEmpty, "the live tool map clears on turnComplete")
        XCTAssertEqual(state.runningTools.count, 0)
    }

    // MARK: - Retiring covered text (BET-655)

    private func flush(_ messageID: String, _ partID: String, _ text: String, field: String = "text") throws -> MantaStreamFrame {
        try MantaStreamFrame.parse(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"\#(messageID)","partID":"\#(partID)","field":"\#(field)","text":"\#(text)"}}"#)
    }

    /// The live tail is joined in ARRIVAL order. A dictionary's values are
    /// unordered, so the previous shape could shuffle a multi-part answer.
    /// Separator is a PARAGRAPH break (`\n\n`) so step-narrations don't render
    /// merged and then pop on the canonical refetch (BET-752 task 6).
    func testLiveTextKeepsArrivalOrder() throws {
        var state = MantaStreamRouter.applying(try flush("msg_2", "part_1", "first"), to: nil)
        state = MantaStreamRouter.applying(try flush("msg_2", "part_2", "second"), to: state)
        state = MantaStreamRouter.applying(try flush("msg_2", "part_3", "third"), to: state)

        XCTAssertEqual(state.liveText, "first\n\nsecond\n\nthird")
    }

    func testReasoningIsNotPartOfTheLiveTail() throws {
        var state = MantaStreamRouter.applying(try flush("msg_2", "part_1", "prose"), to: nil)
        state = MantaStreamRouter.applying(try flush("msg_2", "part_1", "thinking", field: "reasoning"), to: state)

        XCTAssertEqual(state.liveText, "prose")
        XCTAssertEqual(state.textByPart["part_1"], "prose")
        XCTAssertEqual(state.reasoningByPart["part_1"], "thinking")
    }

    /// THE REGRESSION: a finished turn whose message the canonical transcript
    /// now carries must leave NO live text behind, or the screen renders the
    /// same answer twice — once canonical, once live.
    func testRetiresTextCoveredByTheTranscript() throws {
        var state = MantaStreamRouter.applying(try flush("msg_2", "part_3", "the answer"), to: nil)
        state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#),
            to: state
        )

        let retired = MantaStreamRouter.retiring(state, covered: ["msg_2"])

        XCTAssertEqual(retired.liveText, "")
        XCTAssertTrue(retired.chunks.isEmpty)
    }

    func testKeepsTextTheTranscriptDoesNotCoverYet() throws {
        let state = MantaStreamRouter.applying(try flush("msg_9", "part_3", "brand new"), to: nil)
        let retired = MantaStreamRouter.retiring(state, covered: ["msg_2"])
        XCTAssertEqual(retired.liveText, "brand new")
    }

    /// The streaming message is protected by the CALLER, not by `retiring`:
    /// `covered` names only COMPLETED messages (the transcript mapper skips an
    /// assistant message still in flight), so the in-flight one never appears
    /// and its live text survives. Here msg_2 completed and is covered; msg_7
    /// is still streaming and is absent from `covered`, so its tail stays.
    func testKeepsTextForAMessageTheTranscriptDoesNotRenderYet() throws {
        var state = MantaStreamRouter.applying(try flush("msg_2", "part_1", "done earlier"), to: nil)
        state = MantaStreamRouter.applying(try flush("msg_7", "part_2", "still writing"), to: state)

        let retired = MantaStreamRouter.retiring(state, covered: ["msg_2"])

        XCTAssertEqual(retired.liveText, "still writing")
    }

    /// REGRESSION (BUG A): retirement must NOT depend on the `running` flag.
    /// A chunk whose message the transcript renders must retire whatever
    /// `running` says — the old guard kept the last chunk while running, and
    /// with `running` latched true (BUG B) that left the finished answer live,
    /// so it rendered twice. `running:true` is applied here to prove it is
    /// ignored: msg_2 is covered, so it retires and the tail empties.
    func testRetirementIgnoresTheRunningFlag() throws {
        var state = MantaStreamRouter.applying(
            try MantaStreamFrame.parse(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#),
            to: nil
        )
        state = MantaStreamRouter.applying(try flush("msg_2", "part_1", "the answer"), to: state)

        let retired = MantaStreamRouter.retiring(state, covered: ["msg_2"])

        XCTAssertTrue(retired.chunks.isEmpty)
        XCTAssertEqual(retired.liveText, "")
    }

    /// Retirement runs after every fetch, so it must be idempotent — a second
    /// pass over already-clean state must not change it (or the store would
    /// republish and wake every subscriber on a no-op).
    func testRetiringIsIdempotent() throws {
        let state = MantaStreamRouter.applying(try flush("msg_2", "part_3", "answer"), to: nil)
        let once = MantaStreamRouter.retiring(state, covered: ["msg_2"])
        let twice = MantaStreamRouter.retiring(once, covered: ["msg_2"])
        XCTAssertEqual(once, twice)
    }
}

// MARK: - Reconnect controller

@MainActor
final class MantaReconnectControllerTests: XCTestCase {
    private func makeController(socket: FakeSocket, scheduler: FakeScheduler) -> MantaReconnectController {
        MantaReconnectController(
            url: { URL(string: "wss://0123.boxes.mantaui.com/events") },
            makeSocket: { _ in socket },
            backoff: ExponentialBackoff(jitter: false),
            maxTotalWindowMs: 10 * 60_000,
            scheduler: scheduler
        )
    }

    func testInitialOpenIsNotARecoverableReconnect() async {
        let socket = FakeSocket()
        let scheduler = FakeScheduler()
        let controller = makeController(socket: socket, scheduler: scheduler)
        var reconnectCount = 0
        controller.onReconnect = { reconnectCount += 1 }

        await MainActor.run {
            controller.ensure()
            XCTAssertEqual(controller.currentState, .connecting(attempt: 0))
            socket.simulateOpen()
            XCTAssertEqual(controller.currentState, .connected)
            XCTAssertEqual(reconnectCount, 0) // initial open is not a reconnect
            XCTAssertEqual(socket.openedURL?.absoluteString, "wss://0123.boxes.mantaui.com/events")
        }
    }

    func testDropBacksOffAndReconnectRefetches() async {
        let socket = FakeSocket()
        let scheduler = FakeScheduler()
        let controller = makeController(socket: socket, scheduler: scheduler)
        var reconnectCount = 0
        controller.onReconnect = { reconnectCount += 1 }

        await MainActor.run {
            controller.ensure()
            socket.simulateOpen()
            XCTAssertEqual(socket.connectCount, 1)

            socket.simulateDrop()
            guard case .reconnecting(let attempt, let backoffMs) = controller.currentState else {
                return XCTFail("expected reconnecting, got \(controller.currentState)")
            }
            XCTAssertEqual(attempt, 1)
            XCTAssertEqual(backoffMs, 1000) // attempt 0, base 1000ms, no jitter
            XCTAssertGreaterThanOrEqual(scheduler.count, 2)
            XCTAssertEqual(scheduler.delay(at: 0), 1000) // reconnect scheduled first
            XCTAssertEqual(scheduler.delay(at: 1), 10 * 60_000) // deadline second

            // Fire the scheduled reconnect -> fresh open
            scheduler.fire(at: 0)
            XCTAssertEqual(socket.connectCount, 2)

            socket.simulateOpen()
            XCTAssertEqual(controller.currentState, .connected)
            XCTAssertEqual(reconnectCount, 1) // drop then open => re-fetch
        }
    }

    func testReconnectResetsBackoffAfterHealthyOpen() async {
        let socket = FakeSocket()
        let scheduler = FakeScheduler()
        let controller = makeController(socket: socket, scheduler: scheduler)

        await MainActor.run {
            controller.ensure()
            socket.simulateOpen()
            socket.simulateDrop()
            XCTAssertEqual(scheduler.delay(at: 0), 1000) // first reconnect
            scheduler.fire(at: 0)
            socket.simulateOpen() // healthy reconnect: onReconnect fires
            socket.simulateDrop() // fresh drop after healthy open
            // Backoff restarts at base after a healthy open (attempt reset).
            guard case .reconnecting(let attempt, let backoffMs) = controller.currentState else {
                return XCTFail("expected reconnecting, got \(controller.currentState)")
            }
            XCTAssertEqual(attempt, 1)
            XCTAssertEqual(backoffMs, 1000)
        }
    }

    func testTotalWindowExceededCloses() async {
        let socket = FakeSocket()
        let scheduler = FakeScheduler()
        let controller = makeController(socket: socket, scheduler: scheduler)

        await MainActor.run {
            controller.ensure()
            socket.simulateOpen()
            socket.simulateDrop()
            // entry 1 is the deadline (maxTotalWindowMs): reconnect is entry 0.
            XCTAssertEqual(scheduler.delay(at: 1), 10 * 60_000)
            scheduler.fire(at: 1)
            XCTAssertEqual(controller.currentState, .closed(reason: "reconnect window exceeded"))
        }
    }

    func testForceReconnectMarksNextOpenAsReconnect() async {
        let socket = FakeSocket()
        let scheduler = FakeScheduler()
        let controller = makeController(socket: socket, scheduler: scheduler)
        var reconnectCount = 0
        controller.onReconnect = { reconnectCount += 1 }

        await MainActor.run {
            controller.ensure()
            socket.simulateOpen()
            XCTAssertEqual(reconnectCount, 0)
            controller.forceReconnect()
            XCTAssertEqual(socket.connectCount, 2)
            socket.simulateOpen()
            XCTAssertEqual(reconnectCount, 1)
        }
    }
}

// MARK: - Store + degraded mode

@MainActor
final class MantaEventStoreTests: XCTestCase {
    private func makeStore(_ fake: FakeStreamControl) -> MantaEventStore {
        MantaEventStore(
            stream: fake,
            tokenProvider: { "feedfacefeedfacefeedfacefeedface" },
            serverProvider: { URL(string: "https://0123.boxes.mantaui.com") }
        )
    }

    func testRoutesFramesIntoSessionState() throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let store = makeStore(fake)

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        fake.inject(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#)

        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, true)
    }

    func testHeartbeatDoesNotMutateSessionState() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)
        fake.inject(#"{"kind":"heartbeat","ts":1e12}"#)
        XCTAssertTrue(store.sessionStates.isEmpty)
    }

    // MARK: - Running-set routing (BET-922)

    /// A `runningSet` frame reconciles running state across sessions and bumps
    /// `runningSetSeq`.
    func testRunningSetFrameReconcilesAndBumpsSeq() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)

        // Session latched running by a live `running` frame...
        fake.inject(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true,"since":1700000000000}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, true)

        XCTAssertEqual(store.runningSetSeq, 0)
        // ...then the box's authoritative set omits it -> cleared.
        fake.inject(#"{"kind":"runningSet","payload":{"sessions":[]}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, false)
        XCTAssertNil(store.sessionStates["ses_1"]?.runningSince)
        XCTAssertEqual(store.runningSetSeq, 1)
    }

    /// The running set is delivered even while degraded: a client that dropped
    /// frames while unreachable is exactly the one whose running state needs
    /// correcting the moment the box speaks again.
    func testRunningSetAppliesEvenWhileDegraded() throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let store = makeStore(fake)

        fake.inject(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true,"since":1700000000000}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, true)

        fake.drive(.reconnecting(attempt: 1, backoffMs: 1000))
        XCTAssertTrue(store.degraded)

        // A normal stream frame is dropped while degraded...
        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"m","partID":"p","field":"text","text":"ignored"}}"#)
        XCTAssertNil(store.sessionStates["ses_1"]?.textByPart["p"])
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, true)

        // ...but the runningSet still lands and corrects the latched flag.
        fake.inject(#"{"kind":"runningSet","payload":{"sessions":[]}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, false)
        XCTAssertEqual(store.runningSetSeq, 1)
    }

    /// REGRESSION (BET-1066): a JSON-decoded `runningSet` frame carrying a box
    /// `since` MUST seed `runningSince` from that epoch (ms -> seconds) — the
    /// force-quit + relaunch persistence path. This pins the full decode chain
    /// (frame parse -> typed payload -> router), not just the router.
    func testRunningSetFrameWithSinceSeedsBoxStartThroughDecode() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)

        fake.inject(#"{"kind":"runningSet","payload":{"sessions":[{"sessionId":"ses_1","since":1700000000000,"type":"busy"}]}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.running, true)
        XCTAssertEqual(store.sessionStates["ses_1"]?.runningSince, Date(timeIntervalSince1970: 1_700_000_000))
    }

    // MARK: - Turn-complete chunk eviction for unobserved sessions (BET-672)

    /// A turn that COMPLETES with no observer attached has nobody to retire its
    /// accumulated chunks, so the store must clear them or they accumulate
    /// without bound for an unopened session.
    func testTurnCompleteClearsChunksWhenSessionUnobserved() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")

        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)

        XCTAssertEqual(store.sessionStates["ses_1"]?.turnComplete, true)
        XCTAssertTrue(store.sessionStates["ses_1"]?.chunks.isEmpty ?? false)
        XCTAssertEqual(store.sessionStates["ses_1"]?.liveText, "")
    }

    /// An OBSERVED session keeps its chunks past completion — the observing
    /// ChatSessionStore owns retirement via its refetch, and the live text is
    /// load-bearing for the open transcript.
    func testTurnCompleteKeepsChunksWhenSessionObserved() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)
        store.registerSession("ses_1")

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)

        XCTAssertEqual(store.sessionStates["ses_1"]?.turnComplete, true)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")
    }

    /// Registration is un-done by unregistering, so a session that later stops
    /// being observed becomes eligible again.
    func testUnregisterSessionRestoresEviction() throws {
        let fake = FakeStreamControl()
        fake.drive(.connected)
        let store = makeStore(fake)
        store.registerSession("ses_1")

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")

        store.unregisterSession("ses_1")
        // A fresh turn streams + completes while unobserved -> chunks clear.
        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_9","partID":"part_1","field":"text","text":"next"}}"#)
        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)

        XCTAssertEqual(store.sessionStates["ses_1"]?.liveText, "")
    }

    func testDegradedStopsNewInterpretationButKeepsDeliveredData() throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let store = makeStore(fake)

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"Hello"}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")
        XCTAssertFalse(store.degraded)

        // Box becomes unreachable -> degraded, but delivered data is intact.
        fake.drive(.reconnecting(attempt: 1, backoffMs: 1000))
        XCTAssertTrue(store.degraded)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")

        // New interpretation while degraded is NOT applied.
        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_4","field":"text","text":"NEW"}}"#)
        XCTAssertNil(store.sessionStates["ses_1"]?.textByPart["part_4"])

        // Restore -> re-fetch fires + new interpretation applies again.
        var resyncCount = 0
        store.resyncHandler = { resyncCount += 1 }
        fake.injectReconnect()
        XCTAssertEqual(resyncCount, 1)
        fake.drive(.connected)
        XCTAssertFalse(store.degraded)
        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_4","field":"text","text":"AFTER"}}"#)
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_4"], "AFTER")
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["part_3"], "Hello")
    }

    func testFreshConnectingIsNotDegraded() {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = false
        let store = makeStore(fake)
        fake.drive(.connecting(attempt: 0))
        XCTAssertFalse(store.degraded)
    }

    func testBuildsWebSocketURLFromServerURL() throws {
        let server = URL(string: "https://0123.boxes.mantaui.com")
        let ws = try XCTUnwrap(MantaEventStore.eventsWebSocketURL(from: server))
        XCTAssertEqual(ws.absoluteString, "wss://0123.boxes.mantaui.com/events")
    }

    func testBearerHeader() {
        XCTAssertEqual(MantaEventStore.bearer(token: "abc"), "Bearer abc")
        XCTAssertNil(MantaEventStore.bearer(token: ""))
        XCTAssertNil(MantaEventStore.bearer(token: nil))
    }
}

// MARK: - Stream text ↔ canonical transcript seam (BET-655)
//
// The screen draws the canonical transcript PLUS the live streamed tail. The
// two must never hold the same prose at once. Nothing retired the tail, so
// every finished answer was drawn twice — once canonical, once live — and the
// tail then accumulated across the whole session. These tests drive the real
// seam: frames in through the stream, a canonical transcript in over the wire.

private final class StubTranscriptURLProtocol: URLProtocol {
    nonisolated(unsafe) static var result: String = #"{"result": []}"#

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data = Data(Self.result.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class ChatSessionStoreRetirementTests: XCTestCase {

    private func makeEventStore(_ fake: FakeStreamControl) -> MantaEventStore {
        MantaEventStore(
            stream: fake,
            tokenProvider: { "feedfacefeedfacefeedfacefeedface" },
            serverProvider: { URL(string: "https://0123.boxes.mantaui.com") }
        )
    }

    private func makeAPI() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubTranscriptURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    /// A canonical transcript carrying one COMPLETED assistant message. The
    /// `time.completed` is load-bearing: the transcript mapper skips an
    /// assistant message without it, and retirement now covers only completed
    /// messages, so an in-flight message (no `completed`) is neither drawn nor
    /// retired — exactly what protects the running turn's live tail.
    private func transcriptResult(messageID: String, text: String) -> String {
        """
        {"result":[{"info":{"id":"\(messageID)","sessionID":"ses_1","role":"assistant","time":{"created":1750000000000,"completed":1750000001000}},\
        "parts":[{"type":"text","id":"part_3","messageID":"\(messageID)","text":"\(text)"}]}]}
        """
    }

    private func proseCount(_ blocks: [TranscriptBlock], containing needle: String) -> Int {
        blocks.reduce(into: 0) { total, block in
            if case .prose(let body, _) = block, body.contains(needle) { total += 1 }
        }
    }

    /// THE REGRESSION. Stream an answer, complete the turn, then let the
    /// canonical refetch land: the answer must appear exactly ONCE.
    func testFinishedAnswerIsNotRenderedTwice() async throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let eventStore = makeEventStore(fake)

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"the answer"}}"#)
        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)

        StubTranscriptURLProtocol.result = transcriptResult(messageID: "msg_2", text: "the answer")
        let store = ChatSessionStore(sessionId: "ses_1", eventStore: eventStore, api: makeAPI())

        await store.refetch()

        XCTAssertEqual(proseCount(store.blocks, containing: "the answer"), 1)
        XCTAssertTrue(store.inProgressText.isEmpty)
    }

    /// While the turn is still streaming the tail is the ONLY copy, so a
    /// refetch that returns nothing for it must leave it on screen.
    func testStreamingTailSurvivesARefetchThatDoesNotCoverIt() async throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let eventStore = makeEventStore(fake)

        fake.inject(#"{"kind":"stream","sub":"running","sessionId":"ses_1","payload":{"running":true}}"#)
        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_9","partID":"part_1","field":"text","text":"still writing"}}"#)

        StubTranscriptURLProtocol.result = transcriptResult(messageID: "msg_2", text: "an older turn")
        let store = ChatSessionStore(sessionId: "ses_1", eventStore: eventStore, api: makeAPI())

        await store.refetch()

        XCTAssertEqual(store.inProgressText, "still writing")
        XCTAssertEqual(proseCount(store.blocks, containing: "still writing"), 1)
    }

    /// A failed refetch proves nothing about what the transcript carries, so it
    /// must not retire the tail — that would erase the answer from the screen.
    func testAFailedRefetchDoesNotRetireTheTail() async throws {
        let fake = FakeStreamControl()
        fake.hasConnectedOnce = true
        fake.drive(.connected)
        let eventStore = makeEventStore(fake)
        // This test drives the refetch path, which lives in the observing
        // ChatSessionStore — register the session as the observed consumer so
        // turn-complete chunk eviction (BET-672) doesn't apply here.
        eventStore.registerSession("ses_1")

        fake.inject(#"{"kind":"stream","sub":"flush","sessionId":"ses_1","payload":{"messageID":"msg_2","partID":"part_3","field":"text","text":"the answer"}}"#)
        fake.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses_1","payload":{"complete":true,"running":false}}"#)

        StubTranscriptURLProtocol.result = "not json at all"
        let store = ChatSessionStore(sessionId: "ses_1", eventStore: eventStore, api: makeAPI())

        await store.refetch()

        // Asserted on the event store, not the published tail: retirement is
        // synchronous, whereas the store's sink lands on a later run-loop turn.
        XCTAssertEqual(eventStore.sessionStates["ses_1"]?.liveText, "the answer")
    }
}
