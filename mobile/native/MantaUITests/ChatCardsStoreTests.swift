import XCTest
import Combine
@testable import MantaUI

// ===========================================================================
// WS02 — the router / store half of the chat cards. MAC ONLY (the event store,
// the chat store and the approval / ownership stores need Combine + UIKit).
// The pure half is `ChatCardsTests` (runs under verify.sh too).
// ===========================================================================

// MARK: - Router

final class ChatCardsRouterTests: XCTestCase {

    private func apply(_ json: String, to state: MantaSessionStreamState? = nil) throws -> MantaSessionStreamState {
        let frame = try MantaStreamFrame.parse(json)
        return MantaStreamRouter.applying(frame, to: state)
    }
    private func stream(_ sub: String, _ payload: String) -> String {
        #"{"kind":"stream","sub":"\#(sub)","sessionId":"ses","payload":\#(payload)}"#
    }

    func testRetryFrameShowsAndNullClearsAndTurnEndClears() throws {
        var s = try apply(stream("retry", #"{"attempt":2,"message":"m","headline":"HL"}"#))
        XCTAssertEqual(s.retry?.headline, "HL")
        s = try apply(stream("retry", "null"), to: s)
        XCTAssertNil(s.retry)

        s = try apply(stream("retry", #"{"attempt":1,"message":"m"}"#), to: s)
        s = try apply(stream("running", #"{"running":false}"#), to: s)
        XCTAssertNil(s.retry, "the turn ended")
        s = try apply(stream("retry", #"{"attempt":1,"message":"m"}"#), to: s)
        s = try apply(stream("turnComplete", #"{"complete":true,"running":false}"#), to: s)
        XCTAssertNil(s.retry)
    }

    func testReconnectRunningSetWithoutTheSessionClearsRetry() throws {
        var s = try apply(stream("retry", #"{"attempt":1,"message":"m"}"#))
        let payload = StreamRunningSetPayload(sessions: [])
        s = MantaStreamRouter.applyingRunningSet(payload, to: ["ses": s])["ses"] ?? s
        XCTAssertNil(s.retry, "the box does not replay `retry`")
    }

    func testCompactionGenerationIncrementsAndTranscriptStaleClearsIt() throws {
        var s = try apply(stream("compaction", #"{"phase":"started","text":"","reason":"manual"}"#))
        XCTAssertEqual(s.compactionGeneration, 1)
        s = try apply(stream("compaction", #"{"phase":"delta","text":"abc"}"#), to: s)
        s = try apply(stream("compaction", #"{"phase":"ended","firstLine":"LINE"}"#), to: s)
        XCTAssertEqual(s.compaction?.firstLine, "LINE")
        XCTAssertEqual(s.compaction?.phase, .done)
        s = try apply(stream("transcriptStale", "{}"), to: s)
        XCTAssertNil(s.compaction)
        XCTAssertEqual(s.transcriptStaleSeq, 1)
        s = try apply(stream("compaction", #"{"phase":"started"}"#), to: s)
        XCTAssertEqual(s.compactionGeneration, 2)
    }

    func testSessionErrorSequenceBumpsOnIdenticalPayloads() throws {
        let payload = #"{"name":"ApiError","message":"same"}"#
        var s = try apply(stream("sessionError", payload))
        XCTAssertEqual(s.sessionErrorSeq, 1)
        s = try apply(stream("sessionError", payload), to: s)
        XCTAssertEqual(s.sessionErrorSeq, 2, "two identical errors are two occurrences")
    }

    func testOptimizerCompactedWithoutTextPublishesNothing() throws {
        var s = try apply(stream("optimizer.compacted", #"{"beforeTokens":1,"afterTokens":2,"away":true}"#))
        XCTAssertNil(s.compactionNotice)
        XCTAssertEqual(s.compactionNoticeSeq, 0)
        s = try apply(stream("optimizer.compacted", #"{"away":true,"text":"LINE"}"#), to: s)
        XCTAssertEqual(s.compactionNotice?.text, "LINE")
        XCTAssertEqual(s.compactionNoticeSeq, 1)
    }

    func testCommandExecutedMapIsBoundedTo200() throws {
        var s: MantaSessionStreamState?
        for i in 0..<205 {
            s = try apply(stream("commandExecuted", #"{"messageID":"m\#(i)","name":"review","arguments":""}"#), to: s)
        }
        XCTAssertEqual(s?.commands.count, 200)
        XCTAssertNil(s?.commands.values["m0"])
        XCTAssertEqual(s?.commands.values["m204"]?.name, "review")
    }

    func testSessionErrorStillDecodesFromAnOlderBox() throws {
        let s = try apply(stream("sessionError", #"{"name":"ApiError","message":"raw"}"#))
        XCTAssertEqual(s.sessionError?.shownText, "raw")
    }
}

// MARK: - Fakes

private final class FakeApprovalAPI: ChatCardApprovalAPI, @unchecked Sendable {
    var list: [ChatCardApproval] = []
    var approveResult = ChatCardApproveResult(ok: true)
    var approveError: Error?
    var declineResult = true
    var listDelay: UInt64 = 0
    private(set) var approveCalls: [(id: String, tools: [ChatCardApprovalTool])] = []
    private(set) var declineCalls: [String] = []

    func delegatePendingApprovals(sessionId: String) async throws -> [ChatCardApproval] {
        if listDelay > 0 { try? await Task.sleep(nanoseconds: listDelay) }
        return list
    }
    func delegateApprove(id: String, tools: [ChatCardApprovalTool]) async throws -> ChatCardApproveResult {
        approveCalls.append((id, tools))
        if let approveError { throw approveError }
        return approveResult
    }
    func delegateDecline(id: String) async throws -> Bool {
        declineCalls.append(id)
        return declineResult
    }
}

private final class FakeJobAPI: ChatCardJobAPI, @unchecked Sendable {
    var answer: Result<ChatCardJobForSession, Error> = .success(.writable)
    var stopError: Error?
    private(set) var lookups = 0
    private(set) var stops: [String] = []

    func delegateJobForSession(sessionId: String) async throws -> ChatCardJobForSession {
        lookups += 1
        return try answer.get()
    }
    func delegateStop(id: String) async throws {
        stops.append(id)
        if let stopError { throw stopError }
    }
}

private func jobView(stoppable: Bool = true) -> ChatCardJobView {
    ChatCardJobView(id: "j", status: "running", statusLabel: "running", headline: "H", statusLine: "S",
                    parentLine: "P", stoppable: stoppable, parent: nil)
}

// MARK: - Approval store

@MainActor
final class ChatCardApprovalStoreTests: XCTestCase {

    private let tool = ChatCardApprovalTool(permission: "bash", pattern: "npm *")
    private func approval(_ id: String = "a1") -> ChatCardApproval {
        ChatCardApproval(id: id, parentSessionID: "ses", name: "job", prompt: "p", tools: [tool])
    }

    func testAPendingApprovalNeverAutoApproves() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        await store.refresh()
        XCTAssertEqual(store.pending?.id, "a1")
        XCTAssertTrue(api.approveCalls.isEmpty, "no approval of any kind happens without the user's tap")
    }

    func testAFetchThatFinishesAfterALocalApproveDoesNotBringTheCardBack() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        await store.refresh()
        await store.approve(tools: [tool])
        XCTAssertNil(store.pending)
        await store.refresh()          // a stale poll still lists it
        XCTAssertNil(store.pending, "the id was decided locally — tombstoned")
    }

    func testOkFalseWithAnErrorKeepsTheCardAndShowsTheBoxsReason() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        api.approveResult = ChatCardApproveResult(ok: false, error: "BOX: need a rule")
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        await store.refresh()
        await store.approve(tools: [tool])
        XCTAssertEqual(store.pending?.id, "a1")
        XCTAssertEqual(store.error, "BOX: need a rule")
    }

    func testOkFalseWithoutAnErrorDropsTheCardWithAHint() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        api.approveResult = ChatCardApproveResult(ok: false)
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        var hints: [String] = []
        store.onHint = { hints.append($0) }
        await store.refresh()
        api.list = []
        await store.approve(tools: [tool])
        XCTAssertNil(store.pending)
        XCTAssertEqual(hints.first, "That request is no longer pending")
    }

    func testAnEmptyOrBlankRuleListSendsNoRequest() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        await store.refresh()
        await store.approve(tools: [])
        await store.approve(tools: [ChatCardApprovalTool(permission: "bash", pattern: " ")])
        XCTAssertTrue(api.approveCalls.isEmpty)
    }

    func testATransportFailureKeepsTheCardAndSaysSo() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        api.approveError = MantaError.transport("offline")
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        await store.refresh()
        await store.approve(tools: [tool])
        XCTAssertEqual(store.pending?.id, "a1")
        XCTAssertEqual(store.error, "Couldn't reach your box — try again")
    }

    func testDeclineRemovesTheCardAndConfirms() async {
        let api = FakeApprovalAPI()
        api.list = [approval()]
        let store = ChatCardApprovalStore(sessionId: "ses", api: api)
        var hints: [String] = []
        store.onHint = { hints.append($0) }
        await store.refresh()
        await store.decline()
        XCTAssertNil(store.pending)
        XCTAssertEqual(hints.first, "Background job declined")
        XCTAssertEqual(api.declineCalls, ["a1"])
    }

    func testAPushedApprovalForAnotherSessionIsIgnored() {
        let store = ChatCardApprovalStore(sessionId: "ses", api: FakeApprovalAPI())
        store.received(ChatCardApproval(id: "x", parentSessionID: "other", name: "n", prompt: "p", tools: [tool]))
        XCTAssertNil(store.pending)
        store.received(approval("y"))
        XCTAssertEqual(store.pending?.id, "y")
    }
}

// MARK: - Job ownership store

@MainActor
final class ChatCardJobOwnershipStoreTests: XCTestCase {

    private func make(_ api: FakeJobAPI, caps: Set<String>?) -> (ChatCardJobOwnershipStore, ChatCardCapabilities) {
        let capabilities = ChatCardCapabilities(load: { throw MantaError.transport("offline") })
        if let caps { capabilities.apply(caps) }
        return (ChatCardJobOwnershipStore(sessionId: "ses", api: api, capabilities: capabilities), capabilities)
    }

    func testReadOnlyAnswerPushesThePolicyAndPublishesTheJob() async {
        let api = FakeJobAPI()
        api.answer = .success(.readOnly(jobView()))
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        var policies: [ChatCardMutationPolicy] = []
        store.onPolicy = { policies.append($0) }
        await store.resolve()
        XCTAssertEqual(store.policy, .readOnlyJob)
        XCTAssertEqual(store.job?.id, "j")
        XCTAssertEqual(policies, [.readOnlyJob])
    }

    func testWritableAnswerIsAllowed() async {
        let api = FakeJobAPI()
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        await store.resolve()
        XCTAssertEqual(store.policy, .allowed)
        XCTAssertNil(store.job)
    }

    func testAnOlderBoxResolvesWritableWithNoBarAndNoLookup() async {
        let api = FakeJobAPI()
        let (store, _) = make(api, caps: [])
        await store.resolve()
        XCTAssertEqual(store.policy, .allowed)
        XCTAssertTrue(store.jobBarUnavailable)
        XCTAssertEqual(api.lookups, 0)
    }

    func testAFailureOfEitherClassKeepsResolvingAndNeverReleasesHeldSends() async {
        let api = FakeJobAPI()
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        api.answer = .failure(MantaError.transport("offline"))
        await store.resolve()
        XCTAssertEqual(store.policy, .resolving)
        XCTAssertNotNil(store.lastFailure)
        api.answer = .failure(MantaError.server("could not read the job store"))
        await store.resolve()
        XCTAssertEqual(store.policy, .resolving, "a server error string is a failure too")
    }

    func testAKnownJobStaysReadOnlyWhenALaterLookupFails() async {
        let api = FakeJobAPI()
        api.answer = .success(.readOnly(jobView()))
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        await store.resolve()
        api.answer = .failure(MantaError.transport("offline"))
        await store.resolve()
        XCTAssertEqual(store.policy, .readOnlyJob)
        XCTAssertEqual(store.job?.id, "j")
    }

    func testUnknownCapabilityCannotBeAskedMeansFailure() async {
        let api = FakeJobAPI()
        let (store, _) = make(api, caps: nil)
        await store.resolve()
        XCTAssertEqual(store.policy, .resolving)
        XCTAssertEqual(api.lookups, 0)
    }

    func testStopReportsSuccessAndFailure() async {
        let api = FakeJobAPI()
        api.answer = .success(.readOnly(jobView()))
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        var hints: [String] = []
        store.onHint = { hints.append($0) }
        await store.resolve()
        await store.stop()
        XCTAssertEqual(hints.last, "Job stopped")
        XCTAssertEqual(api.stops, ["j"])
        api.stopError = MantaError.server("already finished")
        await store.stop()
        XCTAssertEqual(hints.last, "Couldn't stop the job: already finished")
    }

    // Review finding 2: the first chat open started the capability load (store.start)
    // and the job lookup (wireChatCards) together; the lookup read "unknown" and parked
    // the session in "can't confirm" for up to 30 s.
    func testAResolveThatArrivesDuringTheCapabilityLoadWaitsForIt() async {
        let gate = LoadGate()
        let capabilities = ChatCardCapabilities(load: {
            await gate.wait()
            return [ChatCardCapabilities.chatCards]
        })
        let api = FakeJobAPI()
        let store = ChatCardJobOwnershipStore(sessionId: "ses", api: api, capabilities: capabilities)

        let load = Task { await capabilities.refresh() }
        await gate.waitUntilStarted()
        let resolving = Task { await store.resolve() }
        await Task.yield()
        await gate.open()
        await load.value
        await resolving.value

        XCTAssertEqual(store.policy, .allowed)
        XCTAssertNil(store.lastFailure)
        XCTAssertEqual(api.lookups, 1)
        let loads = await gate.started
        XCTAssertEqual(loads, 1, "both callers shared one capability request")
    }

    func testFirstOpenDeliversAHeldSendOnceTheSharedLoadLands() async {
        let gate = LoadGate()
        let capabilities = ChatCardCapabilities(load: {
            await gate.wait()
            return [ChatCardCapabilities.chatCards]
        })
        PendingPromptStore.save([])
        defer { PendingPromptStore.save([]) }
        let stream = ChatCardsTestStream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatCardsRPCStub.self]
        ChatCardsRPCStub.reset()
        let client = MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil },
                                    session: URLSession(configuration: config))
        let chat = ChatSessionStore(sessionId: "ses", eventStore: eventStore, api: client,
                                    mutationPolicy: .resolving, chatCardCapabilities: capabilities)
        let ownership = ChatCardJobOwnershipStore(sessionId: "ses", api: FakeJobAPI(), capabilities: capabilities)
        ownership.onPolicy = { chat.applyMutationPolicy($0) }

        await chat.send(text: "hello", attachments: [], model: nil)
        XCTAssertEqual(chat.pendingPrompts.map(\.state), [.waiting])

        chat.start()                               // enqueues the capability load
        await gate.waitUntilStarted()
        let resolving = Task { await ownership.resolve() }   // the screen's job lookup, concurrently
        await Task.yield()
        await gate.open()
        await resolving.value

        XCTAssertEqual(ownership.policy, .allowed)
        XCTAssertNil(ownership.lastFailure)
        for _ in 0..<100 where chat.pendingPrompts.first?.state == .waiting { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotEqual(chat.pendingPrompts.first?.state, .waiting, "the held message was delivered")
    }

    func testTheCapabilityListLandingLaterReResolvesAStuckSession() async {
        let capabilities = ChatCardCapabilities(load: { throw MantaError.transport("offline") })
        let api = FakeJobAPI()
        let store = ChatCardJobOwnershipStore(sessionId: "ses", api: api, capabilities: capabilities)
        await store.resolve()
        XCTAssertEqual(store.policy, .resolving)
        XCTAssertNotNil(store.lastFailure)
        capabilities.apply([ChatCardCapabilities.chatCards])
        for _ in 0..<100 where store.policy == .resolving { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(store.policy, .allowed, "no 30 s wait: the list landing asks again at once")
        XCTAssertNil(store.lastFailure)
    }

    func testNeedsPollingWhileResolvingOrWhileARunningJobShows() async {
        let api = FakeJobAPI()
        let (store, _) = make(api, caps: [ChatCardCapabilities.chatCards])
        XCTAssertTrue(store.needsPolling)           // resolving
        await store.resolve()
        XCTAssertFalse(store.needsPolling)          // ordinary session
        api.answer = .success(.readOnly(jobView(stoppable: true)))
        await store.resolve()
        XCTAssertTrue(store.needsPolling)
        api.answer = .success(.readOnly(jobView(stoppable: false)))
        await store.resolve()
        XCTAssertFalse(store.needsPolling)
    }
}

// MARK: - Chat store: policy, errors, notices

@MainActor
final class ChatCardsChatStoreTests: XCTestCase {

    private func makeStore(policy: ChatCardMutationPolicy = .resolving, readOnly: Bool = false) -> (ChatSessionStore, MantaEventStore, ChatCardsTestStream) {
        let stream = ChatCardsTestStream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatCardsFailingProtocol.self]
        let api = MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil },
                                 session: URLSession(configuration: config))
        PendingPromptStore.save([])
        let store = ChatSessionStore(sessionId: "ses", eventStore: eventStore, api: api,
                                     isReadOnly: readOnly, mutationPolicy: policy)
        return (store, eventStore, stream)
    }

    override func tearDown() async throws {
        PendingPromptStore.save([])
        try await super.tearDown()
    }

    func testAResolvingSessionHoldsASendAsWaitingAndNeverDeliversIt() async {
        let (store, _, _) = makeStore(policy: .resolving)
        await store.send(text: "hello", attachments: [], model: nil)
        XCTAssertEqual(store.pendingPrompts.map(\.state), [.waiting])
        XCTAssertFalse(store.running, "nothing was delivered")
    }

    func testAnAllowedSessionReleasesTheHeldPromptOnTheIdleEdge() async {
        let (store, _, _) = makeStore(policy: .resolving)
        await store.send(text: "hello", attachments: [], model: nil)
        store.applyMutationPolicy(.allowed)
        for _ in 0..<50 where store.pendingPrompts.first?.state == .waiting { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotEqual(store.pendingPrompts.first?.state, .waiting, "the drain picked it up")
    }

    func testAReadOnlyJobFailsHeldPromptsWithTheReason() async {
        let (store, _, _) = makeStore(policy: .resolving)
        await store.send(text: "hello", attachments: [], model: nil)
        store.applyMutationPolicy(.readOnlyJob)
        XCTAssertEqual(store.pendingPrompts.first?.state, .failed)
        XCTAssertEqual(store.pendingPrompts.first?.failureReason, "This is a background job — it can't take messages")
        XCTAssertTrue(store.isBackgroundJobReadOnly)
        XCTAssertFalse(store.canMutate)
    }

    func testResolvingRefusesOtherMutationsWithAHint() {
        let (store, _, _) = makeStore(policy: .resolving)
        store.compact()
        XCTAssertEqual(store.actionHint, "One moment — checking this session")
    }

    func testAReadOnlyJobRefusesASendWithTheBoxsWording() async {
        let (store, _, _) = makeStore(policy: .allowed)
        store.applyMutationPolicy(.readOnlyJob)
        await store.send(text: "hi", attachments: [], model: nil)
        XCTAssertEqual(store.actionHint, "This is a background job — it can't take messages")
        XCTAssertTrue(store.pendingPrompts.isEmpty)
    }

    func testReadOnlyChildStoresNeverLeaveResolving() {
        let (store, _, _) = makeStore(policy: .resolving, readOnly: true)
        store.applyMutationPolicy(.allowed)
        XCTAssertEqual(store.mutationPolicy, .resolving)
    }

    func testTrailingBlocksUseTheErrorTextAndSkipOnlyAFooterBackedTruncation() {
        let tail = ChatSessionStore.trailingBlocks(
            sessionErrorText: "API error: m", truncation: nil, running: false,
            permission: nil, planExitQuestion: nil, question: nil, pendingPrompts: [])
        XCTAssertEqual(tail.count, 1)

        let truncation = StreamTruncationPayload(kind: "output-cap", label: "truncated", messageID: "m1")
        let kept = ChatSessionStore.trailingBlocks(
            sessionErrorText: nil, truncation: truncation, running: false,
            permission: nil, planExitQuestion: nil, question: nil, pendingPrompts: [],
            footerTruncationIDs: [])
        XCTAssertEqual(kept.count, 1, "no rendered footer shows it: the standalone notice stays")
        let dropped = ChatSessionStore.trailingBlocks(
            sessionErrorText: nil, truncation: truncation, running: false,
            permission: nil, planExitQuestion: nil, question: nil, pendingPrompts: [],
            footerTruncationIDs: ["m1"])
        XCTAssertTrue(dropped.isEmpty, "a footer already shows it for that message")
    }

    func testDismissingAnErrorHidesThatOccurrenceButAnIdenticalNewOneShows() throws {
        let (store, eventStore, stream) = makeStore(policy: .allowed)
        func inject(_ json: String) { stream.inject(json) }
        let error = #"{"kind":"stream","sub":"sessionError","sessionId":"ses","payload":{"name":"ApiError","message":"same"}}"#
        inject(error)
        XCTAssertNotNil(eventStore.sessionStates["ses"]?.sessionError)
        store.start()
        store.dismissSessionError()
        XCTAssertNil(store.sessionError)
        inject(error)   // an identical payload is a NEW occurrence
        let expectation = expectation(description: "shown again")
        Task { @MainActor in
            for _ in 0..<50 where store.sessionError == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 3)
        XCTAssertNotNil(store.sessionError)
    }

    func testFocusStartsLocatingSynchronously() {
        let (store, _, _) = makeStore(policy: .allowed)
        store.focus(messageID: "nope")
        XCTAssertEqual(store.focusPhase, .locating(id: "nope", token: 1))
    }

    func testCapabilityGateReportsUnknownThenAbsent() {
        let (store, _, _) = makeStore(policy: .allowed)
        XCTAssertNil(store.chatCardsAvailable)
        store.chatCardCapabilities.apply([])
        let expectation = expectation(description: "published")
        let sub = store.$chatCardsAvailable.dropFirst().first(where: { $0 == false }).sink { _ in expectation.fulfill() }
        wait(for: [expectation], timeout: 2)
        sub.cancel()
        XCTAssertEqual(store.chatCardsAvailable, false)
    }
}

// MARK: - Chat store: end-to-end (stub box)

@MainActor
final class ChatCardsStubBoxTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        ChatCardsRPCStub.reset()
        PendingPromptStore.save([])
    }

    override func tearDown() async throws {
        ChatCardsRPCStub.reset()
        PendingPromptStore.save([])
        TranscriptDisplayOptions.setShowDetails(false)
        try await super.tearDown()
    }

    private struct Harness {
        let store: ChatSessionStore
        let stream: ChatCardsTestStream
    }

    private func makeHarness(policy: ChatCardMutationPolicy = .allowed) -> Harness {
        let stream = ChatCardsTestStream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatCardsRPCStub.self]
        let api = MantaAPIClient(serverURL: URL(string: "https://127.0.0.1")!, tokenProvider: { nil },
                                 session: URLSession(configuration: config))
        let store = ChatSessionStore(sessionId: "ses", eventStore: eventStore, api: api, mutationPolicy: policy)
        store.chatCardCapabilities.apply([ChatCardCapabilities.chatCards])
        return Harness(store: store, stream: stream)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool, timeout: TimeInterval = 5.0) async {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func truncationFrame(kind: String, label: String, messageID: String) -> String {
        #"{"kind":"stream","sub":"truncation","sessionId":"ses","payload":{"kind":"\#(kind)","label":"\#(label)","messageID":"\#(messageID)"}}"#
    }

    private func footer(for id: String, in blocks: [TranscriptBlock]) -> TranscriptTurnFooter? {
        for case .turnFooter(let f) in blocks where f.messageID == id { return f }
        return nil
    }

    private func warnNotices(in blocks: [TranscriptBlock]) -> [String] {
        blocks.compactMap { block in
            if case .notice(let text, let kind) = block, kind == .warn { return text }
            return nil
        }
    }

    // MARK: #16 — live truncation, mapper + store

    func testALiveTruncationOnASettledMessageShowsTheFooterBadgeAndDropsTheNotice() async {
        ChatCardsRPCStub.messages = [
            ChatCardsRPCStub.user("m1", "go"),
            ChatCardsRPCStub.assistant("m2", "done", completed: true),
        ]
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 2 }
        h.stream.inject(truncationFrame(kind: "output-cap", label: "Response truncated (output cap)", messageID: "m2"))
        await waitUntil { self.footer(for: "m2", in: h.store.blocks)?.truncation != nil }
        XCTAssertEqual(footer(for: "m2", in: h.store.blocks)?.truncation, .outputCap, "the footer shows the live truncation")
        XCTAssertEqual(warnNotices(in: h.store.blocks), [], "…so the tail notice is gone")
    }

    func testAnUnknownTruncationKindKeepsTheNoticeAndShowsNoBadge() async {
        ChatCardsRPCStub.messages = [
            ChatCardsRPCStub.user("m1", "go"),
            ChatCardsRPCStub.assistant("m2", "done", completed: true),
        ]
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 2 }
        h.stream.inject(truncationFrame(kind: "mystery", label: "Odd one", messageID: "m2"))
        await waitUntil { self.warnNotices(in: h.store.blocks) == ["Odd one"] }
        XCTAssertEqual(warnNotices(in: h.store.blocks), ["Odd one"], "no footer shows it, so the notice stays")
        XCTAssertNil(footer(for: "m2", in: h.store.blocks)?.truncation)
    }

    func testATruncationOnAMessageStillIncompleteInTheSnapshotKeepsTheNotice() async {
        ChatCardsRPCStub.messages = [
            ChatCardsRPCStub.user("m1", "go"),
            ChatCardsRPCStub.assistant("m2", "partial", completed: false),
        ]
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 2 }
        h.stream.inject(truncationFrame(kind: "output-cap", label: "Cut off", messageID: "m2"))
        await waitUntil { self.warnNotices(in: h.store.blocks) == ["Cut off"] }
        XCTAssertEqual(warnNotices(in: h.store.blocks), ["Cut off"])
        XCTAssertNil(footer(for: "m2", in: h.store.blocks), "an unsettled message draws no footer")
    }

    // MARK: #18 — the composer follows the policy (M-03-7)

    func testTheComposerAcceptsInputWhileResolvingNotForAJobAndAgainAfter() {
        let h = makeHarness(policy: .resolving)
        let composer = ComposerTextController()
        composer.acceptsInput = h.store.composerAcceptsInput
        XCTAssertTrue(composer.acceptsInput, "typing stays possible while the session is being checked")
        XCTAssertTrue(composer.insert(text: "draft", mode: .append))
        XCTAssertTrue(composer.attach(remotePath: "/home/dev/a.txt", displayName: "a.txt", mime: nil))

        h.store.applyMutationPolicy(.readOnlyJob)
        composer.acceptsInput = h.store.composerAcceptsInput
        XCTAssertFalse(composer.acceptsInput)
        XCTAssertFalse(composer.insert(text: "x", mode: .append))
        XCTAssertFalse(composer.attach(remotePath: "/home/dev/b.txt", displayName: "b.txt", mime: nil))

        h.store.applyMutationPolicy(.allowed)
        composer.acceptsInput = h.store.composerAcceptsInput
        XCTAssertTrue(composer.acceptsInput, "an ordinary session again")
        XCTAssertTrue(composer.insert(text: "y", mode: .append))
    }

    // MARK: #19 — Load earlier while a message is focused

    private func fillHistory(_ count: Int) {
        ChatCardsRPCStub.messages = (0..<count).map { ChatCardsRPCStub.user(String(format: "m%03d", $0), "message \($0)") }
    }

    private func focus(_ h: Harness, _ id: String) async {
        h.store.focus(messageID: id)
        await waitUntil { if case .presented = h.store.focusPhase { return true } else { return false } }
    }

    func testLoadEarlierWhileFocusedRevealsTheHiddenMessagesWithoutRefetchingOrWidening() async {
        fillHistory(60)                          // the window holds the last 30: m030…m059
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 30 }
        await focus(h, "m042")                   // index 12 in the window
        XCTAssertEqual(h.store.messages.count, 30)
        XCTAssertEqual(h.store.rows.count, 18, "the slice starts at the target (30 − 12)")
        let fetches = h.store.transcriptFetchCount
        let calls = ChatCardsRPCStub.messageCalls.count

        h.store.loadEarlier()

        XCTAssertEqual(h.store.rows.count, 30, "the 12 hidden rows are revealed")
        XCTAssertEqual(h.store.messages.count, 30, "the loaded window is unchanged")
        XCTAssertEqual(h.store.focusPhase, .none)
        XCTAssertEqual(h.store.transcriptFetchCount, fetches, "no refetch")
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.count, calls)
    }

    func testLoadEarlierAtTheFirstFetchedMessageAlsoWidensTheWindow() async {
        fillHistory(120)                         // window m090…m119, history continues above
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 30 }
        await focus(h, "m090")                   // index 0: nothing local to reveal
        XCTAssertTrue(h.store.hasEarlier)

        h.store.loadEarlier()

        await waitUntil { h.store.messages.count == 80 }
        XCTAssertEqual(h.store.messages.count, 80, "30 + the 50-message step")
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.last?.limit, 80)
    }

    func testAJumpToAMessageBeyond500ReportsHowFarBack() async {
        fillHistory(700)
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 30 }
        h.store.focus(messageID: "m000")
        await waitUntil({ h.store.actionHint == ChatCardFocusMachine.tooFarBackMessage }, timeout: 15)
        XCTAssertEqual(h.store.actionHint, "That message is too far back to open here — it's more than 500 messages ago")
        XCTAssertEqual(h.store.focusPhase, .none)
    }

    // MARK: #20 — slim follows "show reasoning & full output" (M-01-7)

    func testTheFetchIsSlimWhileDetailsAreOffAndFullWhenTheyAreOn() async {
        TranscriptDisplayOptions.setShowDetails(false)
        fillHistory(5)
        let h = makeHarness()
        h.store.start()
        await waitUntil { h.store.messages.count == 5 }
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.last?.slim, true)
        try? await Task.sleep(nanoseconds: 300_000_000)   // let the open's own fetches settle

        let before = ChatCardsRPCStub.messageCalls.count
        TranscriptDisplayOptions.setShowDetails(true)
        await waitUntil { ChatCardsRPCStub.messageCalls.count > before }
        try? await Task.sleep(nanoseconds: 300_000_000)   // any second, unwanted refetch would land by now
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.count, before + 1, "flipping the switch refetches once")
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.last?.slim, false)

        TranscriptDisplayOptions.setShowDetails(false)
        await waitUntil { ChatCardsRPCStub.messageCalls.count > before + 1 }
        XCTAssertEqual(ChatCardsRPCStub.messageCalls.last?.slim, true)
    }

    // MARK: Review finding 7 — a push/pop must not leave a notice latched

    func testLeavingTheScreenEndsTheCompactionHoldSoItCannotStayPinned() async {
        let h = makeHarness()
        h.store.start()
        func frame(_ payload: String) -> String {
            #"{"kind":"stream","sub":"compaction","sessionId":"ses","payload":\#(payload)}"#
        }
        h.stream.inject(frame(#"{"phase":"started","text":""}"#))
        await waitUntil { h.store.compaction != nil }
        h.stream.inject(frame(#"{"phase":"ended","firstLine":"Summary"}"#))
        await waitUntil { h.store.compaction?.phase == .done }
        XCTAssertEqual(h.store.compaction?.phase, .done, "fixture: the done card is in its 3 s hold")

        h.store.stop()      // a subagent push: the hold timer is cancelled
        XCTAssertNil(h.store.compaction, "leaving the screen ends the hold")
        h.store.start()     // the pop
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(h.store.compaction, "the expired card is not revived")
    }
}

/// A stream control that never connects but can inject frames.
@MainActor
private final class ChatCardsTestStream: MantaEventStreamControl {
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

/// Every request fails: these tests assert what the store does WITHOUT a box.
private final class ChatCardsFailingProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}

/// Holds a loader open until the test releases it; counts how many loads began.
private actor LoadGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var started = 0

    func wait() async {
        started += 1
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }

    func waitUntilStarted() async {
        while started == 0 { try? await Task.sleep(nanoseconds: 10_000_000) }
    }
}

/// A box that answers `opencode:messages` from a list (honouring `limit` / `slim`) and
/// `null` to every other channel; records each messages request.
private final class ChatCardsRPCStub: URLProtocol {
    nonisolated(unsafe) static var messages: [String] = []
    nonisolated(unsafe) static var messageCalls: [(limit: Int?, slim: Bool)] = []

    static func reset() {
        messages = []
        messageCalls = []
    }

    static func user(_ id: String, _ text: String) -> String {
        #"{"info":{"id":"\#(id)","sessionID":"ses","role":"user","time":{"created":1}},"parts":[{"type":"text","id":"p-\#(id)","messageID":"\#(id)","text":"\#(text)"}]}"#
    }

    static func assistant(_ id: String, _ text: String, completed: Bool) -> String {
        let time = completed ? #"{"created":1,"completed":2}"# : #"{"created":1}"#
        return #"{"info":{"id":"\#(id)","sessionID":"ses","role":"assistant","time":\#(time)},"parts":[{"type":"text","id":"p-\#(id)","messageID":"\#(id)","text":"\#(text)"}]}"#
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let channel = request.url?.lastPathComponent ?? ""
        var body = #"{"result":null}"#
        if channel == "opencode:prompt" { body = #"{"result":{}}"# }
        if channel == "opencode:messages" {
            let args = Self.bodyJSON(of: request).flatMap { $0["args"] as? [Any] } ?? []
            let opts = args.count > 1 ? args[1] as? [String: Any] : nil
            let limit = opts?["limit"] as? Int
            let slim = opts?["slim"] as? Bool ?? false
            Self.messageCalls.append((limit, slim))
            let all = Self.messages
            let page = limit.map { Array(all.suffix($0)) } ?? all
            body = #"{"result":[\#(page.joined(separator: ","))]}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

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
