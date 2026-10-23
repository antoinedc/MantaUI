import XCTest
@testable import MantaUI

// ===========================================================================
// Pending messages — the chat session store's half (Stage A-iOS).
//
//   - a send made while a turn runs POSTs at once with a client-minted message
//     id and its delivery, and never touches `running`, the streaming tail or
//     the completion state;
//   - a definite refusal marks the row failed with the reason; an uncertain
//     failure marks it "may have been sent", keeps the id for the retry, and
//     the row clears itself when the id turns up;
//   - the pending list renders from `inbox` frames under the K3 acceptance rule;
//   - every inbox action reports its outcome.
//
// The network is a URLProtocol stub that answers per RPC channel; the events
// stream is a control that can inject frames.
// ===========================================================================

@MainActor
final class ChatInboxStoreTests: XCTestCase {

    private var epoch = ""

    override func setUp() async throws {
        try await super.setUp()
        epoch = "epoch-" + UUID().uuidString
        InboxRPCStub.reset()
        InboxRetiredEpochs.shared.epochs = []
        PendingPromptStore.save([])
    }

    override func tearDown() async throws {
        PendingPromptStore.save([])
        InboxRPCStub.reset()
        try await super.tearDown()
    }

    // MARK: - Fixtures

    private struct Harness {
        let store: ChatSessionStore
        let stream: InboxTestStream
        let eventStore: MantaEventStore
    }

    private func makeHarness(sessionId: String = "ses", readOnly: Bool = false) -> Harness {
        let stream = InboxTestStream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [InboxRPCStub.self]
        let api = MantaAPIClient(
            serverURL: URL(string: "https://127.0.0.1")!,
            tokenProvider: { nil },
            session: URLSession(configuration: config)
        )
        let store = ChatSessionStore(sessionId: sessionId, eventStore: eventStore, api: api, isReadOnly: readOnly)
        return Harness(store: store, stream: stream, eventStore: eventStore)
    }

    private func startRunning(_ h: Harness) async {
        h.stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await waitUntil { h.store.running }
        XCTAssertTrue(h.store.running, "fixture: a turn is running")
    }

    private func inboxFrame(_ rev: Int, epoch: String? = nil, sessionId: String = "ses", items: [(String, String)] = []) -> String {
        let rows = items.map { #"{"id":"\#($0.0)","text":"\#($0.0)","delivery":"\#($0.1)","createdAt":1,"attachmentCount":0}"# }
        return #"{"kind":"stream","sub":"inbox","sessionId":"\#(sessionId)","payload":{"epoch":"\#(epoch ?? self.epoch)","rev":\#(rev),"items":[\#(rows.joined(separator: ","))]}}"#
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 3.0) async {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func promptCalls() -> [[String: Any]] {
        InboxRPCStub.calls.filter { $0.channel == "opencode:prompt" }.compactMap { $0.arg }
    }

    // MARK: - Send while running: the request

    func testSteerPostsAtOnceWithMintedIDAndDeliveryAndNothingElseChanges() async {
        let h = makeHarness()
        await startRunning(h)
        let tail = h.store.streamingTailID
        let completions = h.store.turnCompletionCount

        await h.store.sendOrSteer(text: "also fix the tests", attachments: [], model: nil, delivery: .steer)

        let calls = promptCalls()
        XCTAssertEqual(calls.count, 1, "posted immediately, not held until idle")
        XCTAssertEqual(calls.first?["text"] as? String, "also fix the tests")
        XCTAssertEqual(calls.first?["delivery"] as? String, "steer")
        XCTAssertTrue((calls.first?["messageID"] as? String ?? "").hasPrefix("msg_"), "a client-minted V2 id")
        XCTAssertNil(calls.first?["model"], "V2 never applies a model to a steered message")
        XCTAssertNil(calls.first?["agent"])
        XCTAssertTrue(h.store.running, "a busy send never touches `running`")
        XCTAssertEqual(h.store.streamingTailID, tail, "…nor the streaming tail")
        XCTAssertEqual(h.store.turnCompletionCount, completions, "…nor the completion state")
        XCTAssertTrue(h.store.pendingPrompts.isEmpty, "success hands the message to the pending card; the outbox row is gone")
    }

    func testAfterThisTurnPostsQueueDelivery() async {
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "then deploy", attachments: [], model: nil, delivery: .queue)
        XCTAssertEqual(promptCalls().first?["delivery"] as? String, "queue")
        XCTAssertTrue(h.store.running)
    }

    func testEachSendMintsItsOwnID() async {
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "one", attachments: [], model: nil)
        await h.store.sendOrSteer(text: "two", attachments: [], model: nil)
        let ids = promptCalls().compactMap { $0["messageID"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertNotEqual(ids[0], ids[1])
    }

    func testIdleSendIsOrdinary() async {
        let h = makeHarness()
        await h.store.sendOrSteer(text: "hello", attachments: [], model: nil, delivery: .queue)
        let call = promptCalls().first
        XCTAssertEqual(call?["text"] as? String, "hello")
        XCTAssertNil(call?["delivery"], "idle: no delivery — the model / agent choice applies")
        XCTAssertTrue(h.store.running, "an ordinary send starts a turn optimistically, as before")
    }

    // MARK: - Send while running: failures

    func testDefiniteRefusalMarksTheRowFailedWithTheReason() async {
        InboxRPCStub.handler = { channel, _ in
            channel == "opencode:prompt" ? .rpcError("opencode sendPrompt 400: {\"message\":\"nope\"}") : .result("null")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "refused", attachments: [], model: nil)

        XCTAssertEqual(h.store.pendingPrompts.count, 1)
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .failed)
        XCTAssertTrue(h.store.pendingPrompts.first?.failureReason?.contains("nope") ?? false)
        XCTAssertTrue(h.store.running, "a failed busy send must not roll `running` back — the turn is still going")
    }

    func testUncertainFailureKeepsTheIDForTheRetry() async {
        InboxRPCStub.handler = { channel, _ in
            channel == "opencode:prompt" ? .failure(.timedOut) : .result("null")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "maybe", attachments: [], model: nil, delivery: .queue)

        XCTAssertEqual(h.store.pendingPrompts.count, 1)
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .uncertain)
        XCTAssertEqual(h.store.pendingPrompts.first?.messageID, promptCalls().first?["messageID"] as? String)
        XCTAssertEqual(h.store.pendingPrompts.first?.delivery, "queue")
        XCTAssertTrue(h.store.running)
    }

    func testServerErrorIsUncertainNotARefusal() async {
        InboxRPCStub.handler = { channel, _ in
            channel == "opencode:prompt" ? .rpcError("opencode sendPrompt 503: busy") : .result("null")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "x", attachments: [], model: nil)
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .uncertain)
    }

    /// The uncertain row asks the box what it holds; when its id is in the
    /// answer the row disappears by itself.
    func testUncertainRowDisappearsWhenTheInboxReportsItsID() async {
        let epoch = self.epoch
        InboxRPCStub.handler = { channel, _ in
            switch channel {
            case "opencode:prompt":
                return .failure(.timedOut)
            case "opencode:inbox":
                let id = InboxRPCStub.lastMessageID ?? ""
                return .result(#"{"epoch":"\#(epoch)","rev":3,"items":[{"id":"\#(id)","text":"maybe","delivery":"steer"}]}"#)
            default:
                return .result("null")
            }
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "maybe", attachments: [], model: nil)

        await waitUntil { h.store.pendingPrompts.isEmpty }
        XCTAssertTrue(h.store.pendingPrompts.isEmpty, "it was received after all")
        XCTAssertEqual(h.store.inboxItems.map(\.text), ["maybe"], "…and now shows as a pending message")
    }

    func testUncertainRowDisappearsWhenAnInboxFrameCarriesItsID() async {
        InboxRPCStub.handler = { channel, _ in channel == "opencode:prompt" ? .failure(.timedOut) : .result("null") }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "maybe", attachments: [], model: nil)
        let id = h.store.pendingPrompts.first?.messageID ?? "?"

        h.stream.inject(inboxFrame(1, items: [(id, "steer")]))
        await waitUntil { h.store.pendingPrompts.isEmpty }
        XCTAssertTrue(h.store.pendingPrompts.isEmpty)
    }

    func testUncertainRowWithAnUnrelatedFrameStays() async {
        InboxRPCStub.handler = { channel, _ in channel == "opencode:prompt" ? .failure(.timedOut) : .result("null") }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "maybe", attachments: [], model: nil)

        h.stream.inject(inboxFrame(1, items: [("msg_somebody_else", "steer")]))
        await waitUntil { !h.store.inboxItems.isEmpty }
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .uncertain, "someone else's message proves nothing about ours")
    }

    func testRetryReusesTheSameMessageID() async {
        nonisolated(unsafe) var prompts = 0
        InboxRPCStub.handler = { channel, _ in
            guard channel == "opencode:prompt" else { return .result("null") }
            prompts += 1
            return prompts == 1 ? .failure(.networkConnectionLost) : .result("{}")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "retry me", attachments: [], model: nil, delivery: .queue)
        let row = h.store.pendingPrompts.first
        XCTAssertEqual(row?.state, .uncertain)

        h.store.retry(promptID: row?.id ?? "")
        await waitUntil { h.store.pendingPrompts.isEmpty }

        let ids = promptCalls().compactMap { $0["messageID"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(ids[0], ids[1], "same id → V2 admits it once however many times it was posted")
        XCTAssertEqual(promptCalls().last?["delivery"] as? String, "queue", "retried while still running: same delivery")
        XCTAssertTrue(h.store.pendingPrompts.isEmpty)
    }

    func testRetryAfterTheTurnEndedIsAnOrdinarySendWithTheSameID() async {
        nonisolated(unsafe) var prompts = 0
        InboxRPCStub.handler = { channel, _ in
            guard channel == "opencode:prompt" else { return .result("null") }
            prompts += 1
            return prompts == 1 ? .failure(.timedOut) : .result("{}")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "late", attachments: [], model: nil, delivery: .steer)
        let row = h.store.pendingPrompts.first
        XCTAssertEqual(row?.state, .uncertain)

        h.stream.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses","payload":{"complete":true,"running":false}}"#)
        await waitUntil { !h.store.running }
        XCTAssertFalse(h.store.running)

        h.store.retry(promptID: row?.id ?? "")
        await waitUntil { promptCalls().count == 2 }

        let calls = promptCalls()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0]["messageID"] as? String, calls[1]["messageID"] as? String)
        XCTAssertNil(calls[1]["delivery"], "the turn is over: this is a normal send, so the picker's model / agent apply")
    }

    func testRetryOfARefusedRowIsPossible() async {
        nonisolated(unsafe) var prompts = 0
        InboxRPCStub.handler = { channel, _ in
            guard channel == "opencode:prompt" else { return .result("null") }
            prompts += 1
            return prompts == 1 ? .rpcError("opencode sendPrompt 409: conflict") : .result("{}")
        }
        let h = makeHarness()
        await startRunning(h)
        await h.store.sendOrSteer(text: "again", attachments: [], model: nil)
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .failed)
        h.store.retry(promptID: h.store.pendingPrompts.first?.id ?? "")
        await waitUntil { h.store.pendingPrompts.isEmpty }
        XCTAssertTrue(h.store.pendingPrompts.isEmpty)
    }

    /// The old hold-until-idle path (used by the plan flows, which need the
    /// picker's model applied) is untouched by all of this.
    func testPlainSendWhileRunningStillHoldsUntilIdle() async {
        let h = makeHarness()
        await startRunning(h)
        await h.store.send(text: "held", attachments: [], model: nil)
        XCTAssertEqual(h.store.pendingPrompts.first?.state, .waiting)
        XCTAssertTrue(promptCalls().isEmpty)
    }

    // MARK: - The pending list from frames (K3)

    func testInboxFrameFillsTheList() async {
        let h = makeHarness()
        h.stream.inject(inboxFrame(1, items: [("a", "steer"), ("b", "queue")]))
        await waitUntil { h.store.inboxItems.count == 2 }
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["a", "b"])
        XCTAssertEqual(h.store.inboxItems.map(\.delivery), [.steer, .queue])
    }

    func testStaleRevIsDroppedAndNewerRevReplaces() async {
        let h = makeHarness()
        h.stream.inject(inboxFrame(5, items: [("a", "steer")]))
        await waitUntil { h.store.inboxItems.count == 1 }
        h.stream.inject(inboxFrame(4, items: [("zzz", "steer")]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["a"], "rev 4 is older than the rev 5 shown: dropped")
        h.stream.inject(inboxFrame(5, items: [("zzz", "steer")]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["a"], "an equal rev is not newer either")
        h.stream.inject(inboxFrame(6, items: []))
        await waitUntil { h.store.inboxItems.isEmpty }
        XCTAssertTrue(h.store.inboxItems.isEmpty, "rev 6 (empty) replaces")
    }

    func testANewEpochReplacesAndTheOldOneIsRetiredForGood() async {
        let h = makeHarness()
        let old = epoch
        let new = "epoch-new-" + UUID().uuidString
        h.stream.inject(inboxFrame(40, epoch: old, items: [("old", "steer")]))
        await waitUntil { h.store.inboxItems.first?.id == "old" }
        h.stream.inject(inboxFrame(1, epoch: new, items: [("fresh", "queue")]))
        await waitUntil { h.store.inboxItems.first?.id == "fresh" }
        h.stream.inject(inboxFrame(999, epoch: old, items: [("ghost", "steer")]))
        h.stream.inject(inboxFrame(2, epoch: new, items: [("fresh", "queue"), ("next", "steer")]))
        await waitUntil { h.store.inboxItems.count == 2 }
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["fresh", "next"], "a dead server's frame never lands, whatever its rev")
        XCTAssertTrue(InboxRetiredEpochs.shared.epochs.contains(old))
    }

    func testFramesForAnotherSessionAreIgnored() async {
        let h = makeHarness()
        h.stream.inject(inboxFrame(1, sessionId: "other", items: [("x", "steer")]))
        h.stream.inject(inboxFrame(1, items: [("mine", "steer")]))
        await waitUntil { !h.store.inboxItems.isEmpty }
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["mine"])
    }

    func testUnknownAndMalformedFramesNeverCrashOrClobber() async {
        let h = makeHarness()
        h.stream.inject(inboxFrame(1, items: [("a", "steer")]))
        await waitUntil { h.store.inboxItems.count == 1 }
        h.stream.inject(#"{"kind":"stream","sub":"inbox","sessionId":"ses","payload":{"epoch":"x"}}"#)
        h.stream.inject(#"{"kind":"stream","sub":"inbox","sessionId":"ses"}"#)
        h.stream.inject(#"{"kind":"stream","sub":"inbox","sessionId":"ses","payload":"nope"}"#)
        h.stream.inject(#"{"kind":"stream","sub":"someFutureSub","sessionId":"ses","payload":{"a":1}}"#)
        h.stream.inject(#"{"kind":"someFutureKind","sessionId":"ses","payload":{}}"#)
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["a"])
        XCTAssertTrue(h.store.transcript.isEmpty, "the store is still alive and its transcript untouched")
    }

    func testAReadOnlyChildSessionShowsNoPendingMessages() async {
        let h = makeHarness(readOnly: true)
        h.stream.inject(inboxFrame(1, items: [("a", "steer")]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(h.store.inboxItems.isEmpty)
        h.store.refreshInbox()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(InboxRPCStub.calls.filter { $0.channel == "opencode:inbox" }.isEmpty, "a child session never asks")
    }

    func testStartSeedsTheListFromTheRPC() async {
        let epoch = self.epoch
        InboxRPCStub.handler = { channel, _ in
            channel == "opencode:inbox"
                ? .result(#"{"epoch":"\#(epoch)","rev":2,"items":[{"id":"seeded","text":"s","delivery":"queue"}]}"#)
                : .result("null")
        }
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.inboxItems.count == 1 }
        XCTAssertEqual(h.store.inboxItems.map(\.id), ["seeded"])
        XCTAssertEqual(InboxRPCStub.calls.first { $0.channel == "opencode:inbox" }?.first as? String, "ses",
                       "opencode:inbox takes the bare session id as its argument")
    }

    // MARK: - Actions

    func testSendNowAndWaitPostTheRightDelivery() async {
        let h = makeHarness()
        h.store.setInboxDelivery(id: "m1", to: .steer)
        await waitUntil { InboxRPCStub.calls.contains { $0.channel == "opencode:inbox-set-delivery" } }
        h.store.setInboxDelivery(id: "m2", to: .queue)
        await waitUntil { InboxRPCStub.calls.filter { $0.channel == "opencode:inbox-set-delivery" }.count == 2 }
        let args = InboxRPCStub.calls.filter { $0.channel == "opencode:inbox-set-delivery" }.compactMap(\.arg)
        XCTAssertEqual(args.map { $0["id"] as? String }, ["m1", "m2"])
        XCTAssertEqual(args.map { $0["delivery"] as? String }, ["steer", "queue"])
        XCTAssertEqual(args.first?["sessionId"] as? String, "ses")
    }

    func testSetDeliveryChangedIsSilent() async {
        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-set-delivery" ? .result(#"{"outcome":"changed"}"#) : .result("null") }
        let h = makeHarness()
        h.store.setInboxDelivery(id: "m", to: .steer)
        await waitUntil { InboxRPCStub.calls.contains { $0.channel == "opencode:inbox-set-delivery" } }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(h.store.actionHint, "`changed` is confirmed by the next inbox frame")
        XCTAssertTrue(h.store.inboxBusyIDs.isEmpty, "the row is usable again")
    }

    func testSetDeliveryDeliveredAndUnknownAreReported() async {
        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-set-delivery" ? .result(#"{"outcome":"delivered"}"#) : .result("null") }
        let h = makeHarness()
        h.store.setInboxDelivery(id: "m", to: .steer)
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, "Already sent to the agent")

        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-set-delivery" ? .result(#"{"outcome":"unknown"}"#) : .result("null") }
        h.store.actionHint = nil
        h.store.setInboxDelivery(id: "m", to: .queue)
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, "Couldn't confirm the change — check the pending list")
    }

    func testSetDeliveryUnrecognisedOutcomeIsReportedNotSwallowed() async {
        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-set-delivery" ? .result(#"{"outcome":"teleported"}"#) : .result("null") }
        let h = makeHarness()
        h.store.setInboxDelivery(id: "m", to: .steer)
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, "Couldn't confirm the change — check the pending list")
    }

    func testSetDeliveryTransportFailureIsReported() async {
        InboxRPCStub.handler = { _, _ in .failure(.notConnectedToInternet) }
        let h = makeHarness()
        h.store.setInboxDelivery(id: "m", to: .steer)
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, InboxActionReport.setDeliveryFailed)
        XCTAssertTrue(h.store.inboxBusyIDs.isEmpty)
    }

    func testCancelOutcomesAreReported() async {
        let h = makeHarness()

        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-cancel" ? .result(#"{"outcome":"cancelled","item":{"id":"m","text":"t","delivery":"queue"}}"#) : .result("null") }
        h.store.cancelInboxItem(id: "m")
        await waitUntil { InboxRPCStub.calls.contains { $0.channel == "opencode:inbox-cancel" } }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(h.store.actionHint, "a cancelled message needs no words — the row leaves")

        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-cancel" ? .result(#"{"outcome":"delivered"}"#) : .result("null") }
        h.store.cancelInboxItem(id: "m")
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, "Already sent to the agent")

        InboxRPCStub.handler = { channel, _ in channel == "opencode:inbox-cancel" ? .result(#"{"outcome":"unknown"}"#) : .result("null") }
        h.store.actionHint = nil
        h.store.cancelInboxItem(id: "m")
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, "Couldn't confirm it was cancelled — it may still be sent")

        InboxRPCStub.handler = { _, _ in .rpcError("not available for the CTO conversation") }
        h.store.actionHint = nil
        h.store.cancelInboxItem(id: "m")
        await waitUntil { h.store.actionHint != nil }
        XCTAssertEqual(h.store.actionHint, InboxActionReport.cancelFailed)
    }

    func testCancelPostsTheSessionAndID() async {
        let h = makeHarness()
        h.store.cancelInboxItem(id: "msg_zz")
        await waitUntil { InboxRPCStub.calls.contains { $0.channel == "opencode:inbox-cancel" } }
        let arg = InboxRPCStub.calls.first { $0.channel == "opencode:inbox-cancel" }?.arg
        XCTAssertEqual(arg?["sessionId"] as? String, "ses")
        XCTAssertEqual(arg?["id"] as? String, "msg_zz")
    }

    func testADoubleTapRunsTheActionOnce() async {
        InboxRPCStub.handler = { channel, _ in
            channel == "opencode:inbox-cancel" ? .delayed(0.15, #"{"outcome":"cancelled"}"#) : .result("null")
        }
        let h = makeHarness()
        h.store.cancelInboxItem(id: "m")
        h.store.cancelInboxItem(id: "m")
        XCTAssertTrue(h.store.inboxBusyIDs.contains("m"))
        await waitUntil { h.store.inboxBusyIDs.isEmpty }
        XCTAssertEqual(InboxRPCStub.calls.filter { $0.channel == "opencode:inbox-cancel" }.count, 1)
    }

    // MARK: - Event store seam

    func testInboxFrameIsDeliveredOutOfBandNotAsSessionState() async {
        let h = makeHarness()
        nonisolated(unsafe) var received: [InboxFrameEvent] = []
        let sub = h.eventStore.inboxFrames.sink { received.append($0) }
        h.stream.inject(inboxFrame(1, items: [("a", "steer")]))
        XCTAssertEqual(received.map(\.sessionId), ["ses"])
        XCTAssertNil(h.eventStore.sessionStates["ses"], "the pending list is not session stream state")
        sub.cancel()
    }
}

// MARK: - Test doubles

/// A stream control that never connects but can inject frames.
@MainActor
private final class InboxTestStream: MantaEventStreamControl {
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

/// Answers every RPC per channel and records what was asked. Test-only
/// ledger: written from the URLSession delegate queue inside `startLoading`,
/// read from the @MainActor test after an await — `nonisolated(unsafe)` is the
/// test seam, not shared state.
private final class InboxRPCStub: URLProtocol {
    enum Reply {
        /// HTTP 200 `{"result": <json>}`.
        case result(String)
        /// HTTP 500 `{"error": <message>}` — how the box reports a thrown error.
        case rpcError(String)
        /// The request itself fails (no verdict).
        case failure(URLError.Code)
        /// `.result` after a delay, so a test can tap twice while it is in flight.
        case delayed(TimeInterval, String)
    }

    /// `arg` is the first argument when it is an object; `first` is the first
    /// argument whatever its shape (`opencode:inbox` takes a bare string).
    nonisolated(unsafe) static var calls: [(channel: String, arg: [String: Any]?, first: Any?)] = []
    nonisolated(unsafe) static var lastMessageID: String?
    nonisolated(unsafe) static var handler: (String, [String: Any]?) -> Reply = { _, _ in .result("null") }

    static func reset() {
        calls = []
        lastMessageID = nil
        handler = { channel, _ in channel == "opencode:prompt" ? .result("{}") : .result("null") }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let channel = request.url?.lastPathComponent ?? ""
        let rawFirst = Self.bodyJSON(of: request).flatMap { ($0["args"] as? [Any])?.first }
        let first = rawFirst as? [String: Any]
        Self.calls.append((channel, first, rawFirst))
        if channel == "opencode:prompt", let id = first?["messageID"] as? String { Self.lastMessageID = id }

        switch Self.handler(channel, first) {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .result(let json):
            respond(status: 200, body: #"{"result":\#(json)}"#)
        case .rpcError(let message):
            let escaped = message.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            respond(status: 500, body: #"{"error":"\#(escaped)"}"#)
        case .delayed(let seconds, let json):
            Thread.sleep(forTimeInterval: seconds)
            respond(status: 200, body: #"{"result":\#(json)}"#)
        }
    }

    override func stopLoading() {}

    private func respond(status: Int, body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    /// URLSession moves an outgoing body from `httpBody` to `httpBodyStream`
    /// before a URLProtocol sees the request, so read whichever carries it.
    private static func bodyJSON(of request: URLRequest) -> [String: Any]? {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var collected = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                collected.append(buffer, count: read)
            }
            data = collected
        }
        return data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }
}
