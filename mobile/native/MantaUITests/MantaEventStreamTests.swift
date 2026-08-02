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

    func testParsesContextPayload() throws {
        let f = try frame(#"{"kind":"stream","sub":"context","sessionId":"ses_1","payload":{"freshInput":10,"cacheRead":5,"cacheWrite":2,"totalInput":17,"pct":8,"segments":[{"kind":"fresh","pct":5},{"kind":"cacheWrite","pct":1},{"kind":"cacheRead","pct":2}]}}"#)
        let p = try XCTUnwrap(f.decodedPayload(StreamContextPayload.self))
        XCTAssertEqual(p.freshInput, 10)
        XCTAssertEqual(p.cacheRead, 5)
        XCTAssertEqual(p.pct, 8)
        XCTAssertEqual(p.segments.count, 3)
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
        XCTAssertEqual(state.running, true) // running is only set by `running` sub
    }

    func testNonStreamFrameLeavesStateUntouched() throws {
        let original = MantaSessionStreamState(sessionId: "ses_1")
        let status = try MantaStreamFrame.parse(#"{"kind":"status","payload":[]}"#)
        let resulting = MantaStreamRouter.applying(status, to: original)
        XCTAssertEqual(resulting, original)
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
