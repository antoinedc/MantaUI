import Combine
import XCTest
@testable import MantaUI

// ===========================================================================
// iOS stability — the event store's per-session change notifications, the
// derived /events subscription (C1), the replay rule (C4) and the
// background/foreground socket policy (B1, B6, B7, B8).
// ===========================================================================

@MainActor
private final class SubscriptionStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle
    var sent: [String] = []
    var calls: [String] = []
    var backgroundFlags: [Bool] = []

    func ensure() { calls.append("ensure") }
    func markReconnectAndEnsure() { calls.append("markReconnectAndEnsure") }
    func retryNow() { calls.append("retryNow") }
    func forceReconnect() { calls.append("forceReconnect") }
    func close(reason: String) { calls.append("close:\(reason)") }
    func send(_ text: String) { sent.append(text) }
    func setBackground(_ background: Bool) { backgroundFlags.append(background) }

    func connect() {
        hasConnectedOnce = true
        currentState = .connected
        onState?(.connected)
    }

    func inject(_ text: String) { onMessage?(text) }
}

@MainActor
private final class TestClock {
    var now = Date(timeIntervalSince1970: 1_000_000)
}

@MainActor
final class MantaEventStoreSubscriptionTests: XCTestCase {
    private var cancellables = Set<AnyCancellable>()

    private func make(clock: TestClock? = nil) -> (MantaEventStore, SubscriptionStream) {
        let stream = SubscriptionStream()
        let store = MantaEventStore(
            stream: stream,
            tokenProvider: { nil },
            serverProvider: { nil },
            clock: { clock?.now ?? Date() }
        )
        return (store, stream)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func running(_ sid: String = "ses_1", _ on: Bool = true) -> String {
        #"{"kind":"stream","sub":"running","sessionId":"\#(sid)","payload":{"running":\#(on)}}"#
    }

    private func flush(_ sid: String = "ses_1", _ text: String = "x") -> String {
        #"{"kind":"stream","sub":"flush","sessionId":"\#(sid)","payload":{"messageID":"m","partID":"p","field":"text","text":"\#(text)"}}"#
    }

    private func windowStatus(_ sid: String = "ses_1", attention: String? = nil, below: String? = nil) -> String {
        let a = attention.map { "\"\($0)\"" } ?? "null"
        let b = below.map { "\"\($0)\"" } ?? "null"
        return #"{"kind":"stream","sub":"windowStatus","sessionId":"\#(sid)","payload":{"running":false,"busy":true,"attention":\#(a),"attentionBelow":\#(b),"subagents":1,"stopped":false}}"#
    }

    private let questionsFrame = #"{"kind":"stream","sub":"questions","sessionId":"ses_1","payload":{"questions":[{"id":"q_1","sessionID":"ses_1","requestId":"que_5","questions":[{"question":"Pick","header":"Pick a DB","options":[{"label":"Postgres","description":""}]}],"tool":{"messageID":"msg_3","callID":"toolu_9"}}]}}"#

    // MARK: - Derived subscription (B6)

    func testARegistrationUpdatesTheSubscriptionAndTheConnectSendsIt() throws {
        let (store, stream) = make()
        let registration = store.addRawFrameHandler(kinds: ["media"]) { _ in }
        XCTAssertTrue(store.subscribedKinds.contains("media"))
        XCTAssertTrue(stream.sent.isEmpty, "nothing is sent while the socket is down: the URL carries the kinds")

        stream.connect()
        XCTAssertEqual(stream.sent.count, 2, "kinds, then focus, after every connect")
        let kinds = try object(stream.sent[0])
        XCTAssertEqual(kinds["type"] as? String, "kinds")
        XCTAssertTrue((kinds["kinds"] as? [String] ?? []).contains("media"))
        let focus = try object(stream.sent[1])
        XCTAssertEqual(focus["type"] as? String, "focus")
        XCTAssertEqual(focus["sessions"] as? [String], [])

        stream.sent.removeAll()
        _ = store.addRawFrameHandler(kinds: ["widget"]) { _ in }
        XCTAssertEqual(stream.sent.count, 1, "a registration after connect updates the subscription at once")
        XCTAssertTrue(((try object(stream.sent[0]))["kinds"] as? [String] ?? []).contains("widget"))

        stream.sent.removeAll()
        _ = store.addRawFrameHandler(kinds: ["media"]) { _ in }
        XCTAssertTrue(stream.sent.isEmpty, "a kind already subscribed changes nothing")

        store.removeRawFrameHandler(registration)
        XCTAssertTrue(store.subscribedKinds.contains("media"), "the second registration still wants it")
    }

    func testRemovingTheLastRegistrationOfAKindUnsubscribesIt() throws {
        let (store, stream) = make()
        stream.connect()
        let registration = store.addRawFrameHandler(kinds: ["pty"]) { _ in }
        XCTAssertTrue(store.subscribedKinds.contains("pty"))
        stream.sent.removeAll()
        store.removeRawFrameHandler(registration)
        XCTAssertFalse(store.subscribedKinds.contains("pty"))
        XCTAssertFalse(((try object(try XCTUnwrap(stream.sent.last)))["kinds"] as? [String] ?? []).contains("pty"))
    }

    func testAHandlerOnlyReceivesTheKindsItDeclared() {
        let (store, stream) = make()
        var seen: [String] = []
        _ = store.addRawFrameHandler(kinds: ["media"]) { seen.append($0.kind) }
        stream.inject(#"{"kind":"media","sessionId":"ses_1","payload":{}}"#)
        stream.inject(#"{"kind":"widget","payload":{}}"#)
        XCTAssertEqual(seen, ["media"])
    }

    func testBindingAStoreDeclaresItsKinds() {
        let (store, _) = make()
        let media = TranscriptMediaStore()
        media.bind(eventStore: store)
        XCTAssertTrue(store.subscribedKinds.contains("media"))
    }

    func testPtyIsRequestedOnlyWhileASignInFlowHoldsTheLease() throws {
        let (store, stream) = make()
        stream.connect()
        let accounts = AccountsStore(api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!), eventStore: store)
        XCTAssertFalse(accounts.isListeningForPty)
        XCTAssertFalse(store.subscribedKinds.contains("pty"), "a store that only reads seats never asks for pty")

        var received: [PtyEvent] = []
        accounts.ptyEvents.sink { received.append($0) }.store(in: &cancellables)
        XCTAssertTrue(accounts.isListeningForPty)
        XCTAssertTrue(store.subscribedKinds.contains("pty"))

        stream.inject(#"{"kind":"pty","payload":{"sessionKey":"claude-login-1","kind":"data","data":"hello"}}"#)
        XCTAssertEqual(received.count, 1)

        accounts.endPtyListening()
        XCTAssertFalse(accounts.isListeningForPty)
        XCTAssertFalse(store.subscribedKinds.contains("pty"))
    }

    // MARK: - Focus (C1)

    func testFocusIsSentWhenItChangesAndResentAfterEveryConnect() throws {
        let (store, stream) = make()
        store.setFocus(owner: "chat", sessions: ["ses_1"])
        XCTAssertTrue(stream.sent.isEmpty, "not connected: the connect sends it")
        stream.connect()
        XCTAssertEqual(try object(stream.sent[1])["sessions"] as? [String], ["ses_1"])

        stream.sent.removeAll()
        store.setFocus(owner: "chat", sessions: ["ses_1"])
        XCTAssertTrue(stream.sent.isEmpty, "an unchanged union is not re-sent")
        store.setFocus(owner: "child", sessions: ["ses_2"])
        XCTAssertEqual(try object(stream.sent[0])["sessions"] as? [String], ["ses_1", "ses_2"])
        store.clearFocus(owner: "chat")
        XCTAssertEqual(try object(try XCTUnwrap(stream.sent.last))["sessions"] as? [String], ["ses_2"])
        store.clearAllFocus()
        XCTAssertEqual(try object(try XCTUnwrap(stream.sent.last))["sessions"] as? [String], [])
        XCTAssertEqual(store.focusedSessions, [])

        store.setFocus(owner: "chat", sessions: ["ses_9"])
        stream.sent.removeAll()
        stream.onState?(.reconnecting(attempt: 1, backoffMs: 1000))
        stream.connect()
        XCTAssertEqual(stream.sent.count, 2, "the reconnect re-sends kinds and focus")
        XCTAssertEqual(try object(stream.sent[1])["sessions"] as? [String], ["ses_9"])
    }

    // MARK: - Per-session change notifications (B1)

    func testAChunkNotifiesOnlyItsOwnSession() {
        let (store, stream) = make()
        var changes: [MantaSessionChange] = []
        store.sessionChanges.sink { changes.append($0) }.store(in: &cancellables)
        stream.inject(flush("ses_1", "a"))
        stream.inject(flush("ses_1", "b"))
        stream.inject(flush("ses_2", "c"))
        XCTAssertEqual(changes.map(\.sessionId), ["ses_1", "ses_1", "ses_2"])
        XCTAssertTrue(changes.allSatisfy { $0.sub == "flush" })
        XCTAssertEqual(store.sessionStates["ses_1"]?.textByPart["p"], "ab")
    }

    func testAFrameThatChangesNothingNotifiesNobody() {
        let (store, stream) = make()
        var changes = 0
        store.sessionChanges.sink { _ in changes += 1 }.store(in: &cancellables)
        stream.inject(running())
        XCTAssertEqual(changes, 1)
        stream.inject(running())
        XCTAssertEqual(changes, 1, "an identical running frame is not a change")
    }

    func testRowStatusChangesOnlyOnEdges() {
        let (store, stream) = make()
        var edges = 0
        store.rowStatusChanges.sink { edges += 1 }.store(in: &cancellables)
        stream.inject(flush())
        stream.inject(flush())
        XCTAssertEqual(edges, 0, "streamed text never changes a row")
        stream.inject(running())
        XCTAssertEqual(edges, 1)
        stream.inject(flush())
        stream.inject(running())
        XCTAssertEqual(edges, 1)
        stream.inject(windowStatus(below: "question"))
        XCTAssertEqual(edges, 2)
        stream.inject(questionsFrame)
        XCTAssertEqual(edges, 3)
    }

    func testRunningSetNotifiesEachChangedSessionThenOnceGlobally() {
        let (store, stream) = make()
        stream.inject(running("ses_1"))
        stream.inject(running("ses_2"))
        var changes: [MantaSessionChange] = []
        store.sessionChanges.sink { changes.append($0) }.store(in: &cancellables)
        stream.inject(#"{"kind":"runningSet","payload":{"sessions":[{"sessionId":"ses_1","since":1700000000000}]}}"#)
        XCTAssertEqual(changes.last, .runningSetApplied)
        XCTAssertTrue(changes.contains(MantaSessionChange(sessionId: "ses_2", sub: "runningSet")), "ses_2 stopped running")
        XCTAssertEqual(store.sessionStates["ses_2"]?.running, false)
    }

    // MARK: - C4 replay rule + B8 waiting badge

    func testRunningSetStartsTheReplayAndClearsAskDerivedState() {
        let (store, stream) = make()
        stream.inject(questionsFrame)
        stream.inject(windowStatus(attention: "question", below: "permission"))
        XCTAssertNotNil(store.sessionStates["ses_1"]?.questions)
        XCTAssertEqual(store.sessionStates["ses_1"]?.windowStatus?.attentionBelow, "permission")

        stream.inject(#"{"kind":"runningSet","payload":{"sessions":[]}}"#)
        let state = store.sessionStates["ses_1"]
        XCTAssertNil(state?.questions)
        XCTAssertNil(state?.permissions)
        XCTAssertNil(state?.windowStatus?.attention)
        XCTAssertNil(state?.windowStatus?.attentionBelow)
        XCTAssertEqual(state?.windowStatus?.busy, true, "only the asks are cleared; the replay's frames repopulate them")
        XCTAssertFalse(SessionListStore.waiting(state))

        stream.inject(windowStatus(below: "question"))
        XCTAssertTrue(SessionListStore.waiting(store.sessionStates["ses_1"]))
    }

    func testARowIsWaitingOnYouFromItsOwnAskOrFromBelow() {
        let (store, stream) = make()
        XCTAssertFalse(SessionListStore.waiting(nil))
        stream.inject(windowStatus(below: "permission"))
        XCTAssertTrue(SessionListStore.waiting(store.sessionStates["ses_1"]), "a subagent's question shows on the parent row")
        stream.inject(windowStatus())
        XCTAssertFalse(SessionListStore.waiting(store.sessionStates["ses_1"]))
        stream.inject(questionsFrame)
        XCTAssertTrue(SessionListStore.waiting(store.sessionStates["ses_1"]))
    }

    // MARK: - Background / foreground (B7)

    func testReturningAfterTheGraceAlwaysReopensTheSocket() {
        let clock = TestClock()
        let (store, stream) = make(clock: clock)
        stream.connect()
        store.enteredBackground()
        XCTAssertEqual(stream.backgroundFlags, [true])
        clock.now = clock.now.addingTimeInterval(10)
        store.resume()
        XCTAssertEqual(stream.backgroundFlags, [true, false])
        XCTAssertTrue(stream.calls.contains("forceReconnect"))
        XCTAssertFalse(stream.calls.contains("markReconnectAndEnsure"))
    }

    func testAQuickTripKeepsAHealthySocket() {
        let clock = TestClock()
        let (store, stream) = make(clock: clock)
        stream.connect()
        store.enteredBackground()
        clock.now = clock.now.addingTimeInterval(2)
        store.resume()
        XCTAssertTrue(stream.calls.contains("markReconnectAndEnsure"))
        XCTAssertFalse(stream.calls.contains("forceReconnect"))
    }

    func testTheSocketIsClosedForTheBackgroundWithoutCallingItAnOutage() {
        let (store, stream) = make()
        stream.connect()
        store.enteredBackground()
        store.closeForBackground()
        XCTAssertTrue(stream.calls.contains("close:\(MantaCloseReason.background)"))
        stream.onState?(.closed(reason: MantaCloseReason.background))
        XCTAssertFalse(store.degraded)
        store.resume()
    }
}
