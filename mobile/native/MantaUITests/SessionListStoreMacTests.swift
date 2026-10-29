import XCTest
@testable import MantaUI

// Mac-only half of the session-model tests: these drive `SessionListStore`, the
// event store and `URLProtocol`, none of which build in the Linux package. The
// pure half stays in `SessionModelsTests.swift` (Linux-eligible).

// MARK: - BET-746 rename/fork failure feedback

private enum SessionListMutationTestError: Error {
    case rejected
}

@MainActor
final class SessionListMutationTests: XCTestCase {

    private func makeStore(_ stub: SessionListFake) -> SessionListStore {
        // Dead localhost port so any stray background config/refresh I/O fails
        // fast and is swallowed; the mutation seam is what these tests drive.
        SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: MantaEventStore(),
            mutations: stub
        )
    }

    private func project(_ name: String, _ window: String) -> MantaProject {
        MantaProject(
            tmuxSession: name,
            defaultCwd: "/tmp",
            windows: [MantaWindow(index: 0, name: window, active: false, paneCurrentPath: "", opencodeSessionId: nil, worktreePath: nil)],
            attached: false,
            mantaOwned: nil
        )
    }

    func testRenameFailureLeavesListUnchangedAndPublishesMessage() async {
        let stub = SessionListFake()
        stub.renameError = SessionListMutationTestError.rejected
        let store = makeStore(stub)
        let snapshot = [project("ethernal", "dev"), project("manta", "main")]
        store.applyProjects(snapshot)

        let message = await store.renameSession(project: "ethernal", index: 0, newName: "renamed")

        XCTAssertEqual(stub.renameCalls, 1)
        // The reason is RETURNED (the rename sheet keeps itself open with it) —
        // the list-wide toast is not touched.
        XCTAssertEqual(message, "Couldn't rename — check the connection")
        XCTAssertNil(store.actionMessage)
        XCTAssertEqual(store.projects, snapshot)
    }

    func testForkFailureLeavesListUnchangedAndPublishesMessage() async {
        let stub = SessionListFake()
        stub.forkError = SessionListMutationTestError.rejected
        let store = makeStore(stub)
        let snapshot = [project("ethernal", "dev")]
        store.applyProjects(snapshot)

        await store.forkSession(sessionId: "ses", project: "ethernal", newName: "dev fork")

        XCTAssertEqual(stub.forkCalls, 1)
        XCTAssertEqual(store.actionMessage, "Couldn't fork — check the connection")
        XCTAssertEqual(store.projects, snapshot)
    }

    func testRenameSuccessPublishesNoFailure() async {
        let stub = SessionListFake()
        let store = makeStore(stub)
        store.applyProjects([project("ethernal", "dev")])

        let message = await store.renameSession(project: "ethernal", index: 0, newName: "renamed")

        XCTAssertEqual(stub.renameCalls, 1)
        XCTAssertNil(message)
        XCTAssertNil(store.actionMessage)
    }

    func testForkSuccessPublishesNoFailure() async {
        let stub = SessionListFake()
        let store = makeStore(stub)
        store.applyProjects([project("ethernal", "dev")])

        await store.forkSession(sessionId: "ses", project: "ethernal", newName: "dev fork")

        XCTAssertEqual(stub.forkCalls, 1)
        XCTAssertNil(store.actionMessage)
    }

    // MARK: - Pin ordering (BET-898)

    private func windows(_ names: [String]) -> [MantaWindow] {
        names.enumerated().map { i, name in
            MantaWindow(index: i, name: name, active: false, paneCurrentPath: "", opencodeSessionId: nil, worktreePath: nil)
        }
    }

    private func names(_ ws: [MantaWindow]) -> [String] { ws.map(\.name) }

    func testPinOrderNoPinsReturnsArrayUnchanged() {
        let ws = windows(["a", "b", "c"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [])), ["a", "b", "c"])
    }

    func testPinOrderOnePinnedJumpsToFrontKeepsRestOrder() {
        let ws = windows(["a", "b", "c", "d"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("proj", index: 2)])), ["c", "a", "b", "d"])
    }

    func testPinOrderSeveralPinnedKeepTheirOriginalRelativeOrder() {
        let ws = windows(["a", "b", "c", "d", "e"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("proj", index: 3), SessionPinID.window("proj", index: 1)])), ["b", "d", "a", "c", "e"])
    }

    func testPinOrderOtherProjectPinDoesNotAffect() {
        let ws = windows(["a", "b"])
        XCTAssertEqual(names(SessionOrder.sorted(ws, project: "proj", pinned: [SessionPinID.window("other", index: 0)])), ["a", "b"])
    }
}

// MARK: - BET-1213 delegate:list failure tolerance
//
// A box that predates delegation answers `delegate:list` with an unknown-
// channel error. That must leave the project list fully working: every window
// visible, no count, no error banner, no empty state. This drives the real
// store seam through a stubbed URLSession (same pattern as
// MantaEventStreamTests' StubTranscriptURLProtocol), with the jobs channel
// returning the server's `{error: "unknown rpc channel: …"}` envelope while
// `tmux:list` succeeds.

@MainActor
final class SessionListJobToleranceTests: XCTestCase {

    private final class StubChannelURLProtocol: URLProtocol {
        nonisolated(unsafe) static var responseBySubstring: [String: String] = [:]

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            let urlString = request.url?.absoluteString ?? ""
            var body = Self.responseBySubstring["default"] ?? #"{"result": null}"#
            for (key, value) in Self.responseBySubstring where urlString.contains(key) {
                body = value
                break
            }
            let data = Data(body.utf8)
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

    private let projectJSON = #"""
    {"result":[{"tmuxSession":"proj","defaultCwd":"/tmp","windows":[
      {"index":0,"name":"a","active":false,"paneCurrentPath":"","opencodeSessionId":"ses_a"},
      {"index":1,"name":"b","active":false,"paneCurrentPath":"","opencodeSessionId":"ses_b"}
    ],"attached":false}]}
    """#

    private func makeAPI() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubChannelURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    func testUnknownDelegateChannelLeavesProjectListIntact() async {
        StubChannelURLProtocol.responseBySubstring = [
            "default": #"{"error":"unknown rpc channel: delegate:list"}"#,
            "tmux:list": projectJSON,
        ]
        let store = SessionListStore(api: makeAPI(), eventStore: MantaEventStore())

        await store.refresh()

        // The project list loaded fully despite the failing jobs fetch.
        XCTAssertEqual(store.projects.count, 1)
        let project = store.projects[0]
        XCTAssertEqual(project.windows.count, 2)
        // Every window stays visible — a missing job list hides nothing.
        XCTAssertEqual(store.visibleWindows(in: project).map(\.index), [0, 1])
        // And no window carries a background-job count.
        for w in project.windows {
            XCTAssertEqual(store.rowStatus(for: w).backgroundJobs, 0)
        }
        XCTAssertNil(store.loadError)
    }

    // MARK: - Spec §2: job windows hidden by the box's own `owner` tag

    private let taggedProjectJSON = #"""
    {"result":[{"tmuxSession":"proj","defaultCwd":"/tmp","windows":[
      {"index":0,"name":"a","active":false,"paneCurrentPath":"/p","opencodeSessionId":"ses_a"},
      {"index":1,"name":"job","active":false,"paneCurrentPath":"/p","opencodeSessionId":"ses_job","owner":"job"}
    ],"attached":false},
    {"tmuxSession":"onlyjobs","defaultCwd":"/tmp","windows":[
      {"index":0,"name":"orphan","active":false,"paneCurrentPath":"/q","opencodeSessionId":"ses_orphan","owner":"job"}
    ],"attached":false}]}
    """#

    func testOwnerTaggedJobWindowIsHiddenEvenWhenTheJobListFails() async {
        StubChannelURLProtocol.responseBySubstring = [
            "default": #"{"error":"unknown rpc channel: delegate:list"}"#,
            "tmux:list": taggedProjectJSON,
        ]
        let store = SessionListStore(api: makeAPI(), eventStore: MantaEventStore())

        await store.refresh()

        // The tag alone hides the window — no job record was ever loaded.
        let visible = store.visibleProjects
        XCTAssertEqual(visible.map(\.tmuxSession), ["proj"], "a project holding only job windows is not listed")
        XCTAssertEqual(visible[0].windows.map(\.index), [0])
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0])
        // The raw list still has the window (a push deep-link can open it).
        XCTAssertEqual(store.projects.first?.windows.count, 2)
    }

    // MARK: - Spec §3: last activity from per-directory session lists

    func testLastActivityComesFromTheListedSessionAndRespectsLiveTransitions() async {
        StubChannelURLProtocol.responseBySubstring = [
            "default": #"{"error":"unknown rpc channel"}"#,
            "tmux:list": projectJSON,
            "opencode:list-sessions": #"{"result":[{"id":"ses_a","time":{"updated":1000000}},{"id":"ses_b","time":{"updated":2000000}}]}"#,
        ]
        let store = SessionListStore(api: makeAPI(), eventStore: MantaEventStore())

        await store.refresh()

        let a = store.projects[0].windows[0]
        let b = store.projects[0].windows[1]
        XCTAssertEqual(store.lastActivity(for: a), Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(store.lastActivity(for: b), Date(timeIntervalSince1970: 2000))
        // The age chip's own data is untouched by the ordering signal.
        XCTAssertEqual(store.rowStatus(for: a).lastActivity, Date(timeIntervalSince1970: 1000))
    }

    func testTerminalWindowHasNoLastActivity() async {
        StubChannelURLProtocol.responseBySubstring = [
            "default": #"{"error":"unknown rpc channel"}"#,
            "tmux:list": #"{"result":[{"tmuxSession":"proj","defaultCwd":"/tmp","windows":[{"index":0,"name":"sh","active":false,"paneCurrentPath":"/p"}],"attached":false}]}"#,
        ]
        let store = SessionListStore(api: makeAPI(), eventStore: MantaEventStore())

        await store.refresh()

        XCTAssertNil(store.lastActivity(for: store.projects[0].windows[0]))
    }
}

// MARK: - BET-1350 terminal-window running status (tmux poller frames)

@MainActor
final class TerminalStatusTests: XCTestCase {

    /// Minimal injectable stream so `kind: "status"` frames can be pushed
    /// straight through the store's raw-frame path — no live socket (mirrors
    /// the suite's other `MantaEventStreamControl` fakes).
    @MainActor
    private final class Stream: MantaEventStreamControl {
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

    private func makeStore() -> (store: SessionListStore, stream: Stream) {
        let stream = Stream()
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: eventStore
        )
        return (store, stream)
    }

    private func project(_ session: String, _ window: MantaWindow) -> MantaProject {
        MantaProject(tmuxSession: session, defaultCwd: "/tmp", windows: [window], attached: false, mantaOwned: nil)
    }

    private func terminalWindow(_ index: Int) -> MantaWindow {
        MantaWindow(index: index, name: "dev", active: false, paneCurrentPath: "/x", opencodeSessionId: nil, worktreePath: nil)
    }

    private func chatWindow(_ index: Int, sid: String) -> MantaWindow {
        MantaWindow(index: index, name: "chat", active: false, paneCurrentPath: "/x", opencodeSessionId: sid, worktreePath: nil)
    }

    private func statusFrame(session: String, windowIndex: Int, running: Bool) -> String {
        #"{"kind":"status","payload":[{"session":"\#(session)","windowIndex":\#(windowIndex),"running":\#(running),"subagents":0}]}"#
    }

    // Background-job nesting refreshes on the box's `sessions.nesting` signal ONLY. `delegate.updated` fires about every
    // 10 s per running job for activity text and must cost nothing.
    func testActivityOnlyDelegateFramesReadNoProjectListAndANestingSignalReadsExactlyOne() async {
        let (store, stream) = makeStore()
        var reads = 0
        let nested = MantaWindow(index: 1, name: "job", active: false, paneCurrentPath: "/x", opencodeSessionId: "ses_job",
                                 worktreePath: nil, job: MantaWindowJob(id: "j", status: "running", parentWindowIndex: 0))
        let parent = MantaWindow(index: 0, name: "parent", active: true, paneCurrentPath: "/x", opencodeSessionId: "ses_p", worktreePath: nil)
        store.projectsReader = {
            reads += 1
            return [MantaProject(tmuxSession: "proj", defaultCwd: "/tmp", windows: [parent, nested], attached: false, mantaOwned: nil)]
        }

        for n in 0..<5 {
            stream.inject(#"{"kind":"delegate.updated","payload":{"id":"j","status":"running","activity":"step \#(n)"}}"#)
        }
        await store.waitForNestingRefresh()
        XCTAssertEqual(reads, 0, "activity-only frames trigger no tmux:list")

        stream.inject(#"{"kind":"sessions.nesting","payload":{}}"#)
        await store.waitForNestingRefresh()
        XCTAssertEqual(reads, 1, "a nesting signal triggers exactly one")
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0], "the nested job window is hidden under its parent")
    }

    func testStatusFrameDecodesToSingleEntryKeyedProjectHashWindow() {
        let (store, stream) = makeStore()

        stream.inject(#"{"kind":"status","payload":[{"session":"proj","windowIndex":2,"running":true,"subagents":0}]}"#)

        XCTAssertEqual(store.terminalStatus.count, 1)
        XCTAssertEqual(Set(store.terminalStatus.keys), ["proj#2"])
        XCTAssertEqual(store.terminalStatus["proj#2"]?.running, true)
        XCTAssertEqual(store.terminalStatus["proj#2"]?.subagents, 0)
    }

    func testTerminalRowWithRunningPollerEntryIsRunningWithRunningDotAndSubtitle() {
        let (store, stream) = makeStore()
        let w = terminalWindow(2)
        store.applyProjects([project("proj", w)])

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))

        let status = store.rowStatus(for: w)
        XCTAssertTrue(status.isTerminal)
        XCTAssertTrue(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .running)
        // A running terminal row falls into the running subtitle branch and
        // reads "running" (no model label, so not the "running · model" variant).
        XCTAssertEqual(SessionRowSubtitle.text(for: status), "running")
    }

    func testChatWindowUnaffectedByPollerEntryNamingItsWindowIndex() {
        let (store, stream) = makeStore()
        let w = chatWindow(2, sid: "ses-1")
        store.applyProjects([project("proj", w)])

        // The poller names this chat window's index — it must be ignored; the
        // window's status still comes from the stream (no entry → idle).
        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))

        let status = store.rowStatus(for: w)
        XCTAssertFalse(status.isTerminal)
        XCTAssertFalse(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .idle)
    }

    func testLaterBatchReportingWindowIdleFlipsTerminalRowBack() {
        let (store, stream) = makeStore()
        let w = terminalWindow(2)
        store.applyProjects([project("proj", w)])

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: true))
        XCTAssertTrue(store.rowStatus(for: w).running)

        stream.inject(statusFrame(session: "proj", windowIndex: 2, running: false))
        let status = store.rowStatus(for: w)
        XCTAssertFalse(status.running)
        XCTAssertEqual(SessionDotState.forRow(status), .idle)
    }

    // MARK: - QuoteText (BET-1353) — ports of chatUtils truncateMiddle / buildQuoteBlock

    func testTruncateMiddleReturnsUnchangedAtAndBelowMax() {
        let atMax = String(repeating: "a", count: QuoteText.max)
        XCTAssertEqual(QuoteText.truncateMiddle(atMax, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail), atMax)
        XCTAssertEqual(QuoteText.truncateMiddle("short", max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail), "short")
    }

    func testTruncateMiddleProducesHeadEllipsisTailAboveMaxAndIsShorter() {
        let text = String(repeating: "x", count: QuoteText.max + 50)
        let out = QuoteText.truncateMiddle(text, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        let expected = String(repeating: "x", count: QuoteText.head) + " \u{2026} " + String(repeating: "x", count: QuoteText.tail)
        XCTAssertEqual(out, expected)
        XCTAssertLessThan(out.count, text.count)
        XCTAssertLessThanOrEqual(out.count, QuoteText.max)
    }

    func testTruncateMiddleUsesSingleU2026WithOneSpaceEachSide() {
        let text = String(repeating: "a", count: QuoteText.max + 10)
        let out = QuoteText.truncateMiddle(text, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        XCTAssertTrue(out.contains(" \u{2026} "))
        XCTAssertEqual(out.components(separatedBy: "\u{2026}").count, 2)
        XCTAssertFalse(out.contains("..."))
    }

    func testTruncateMiddleNeverSplitsACharacter() {
        let emoji = String(repeating: "\u{1F600}", count: QuoteText.max + 20)
        let out = QuoteText.truncateMiddle(emoji, max: QuoteText.max, head: QuoteText.head, tail: QuoteText.tail)
        // Head + tail of whole grapheme clusters, joined by one " … ".
        XCTAssertEqual(out.count, QuoteText.head + QuoteText.tail + 3)
        XCTAssertTrue(out.allSatisfy { $0 == "\u{1F600}" || $0 == " " || $0 == "\u{2026}" })
    }

    func testBuildQuoteBlockCollapsesWhitespaceAndTrims() {
        XCTAssertEqual(QuoteText.buildQuoteBlock("  hello   world\n\nsecond  line  "), "> hello world second line\n\n")
    }

    func testBuildQuoteBlockNilForEmptyAndWhitespaceOnly() {
        XCTAssertNil(QuoteText.buildQuoteBlock(""))
        XCTAssertNil(QuoteText.buildQuoteBlock("   \n\t  "))
    }

    func testBuildQuoteBlockPrefixesExactlyQuoteAndEndsWithBlankLine() {
        XCTAssertEqual(QuoteText.buildQuoteBlock("hello"), "> hello\n\n")
    }

    func testBuildQuoteBlockReducesLongMultiParagraphToOneLineWithOneEllipsis() {
        let paragraph = Array(repeating: "word ", count: 120).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let multi = "\(paragraph)\n\n\(paragraph)"
        let out = QuoteText.buildQuoteBlock(multi)!
        XCTAssertEqual(out.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").count, 1)
        XCTAssertEqual(out.components(separatedBy: " \u{2026} ").count, 2)
    }

    func testBuildQuoteBlockEmojiSelectionNeverSplitsACharacter() {
        let selection = String(repeating: "\u{1F600}", count: QuoteText.max + 60)
        let out = QuoteText.buildQuoteBlock(selection)!
        // "> " (2) + head + " … " (3) + tail + "\n\n" (2) = head + tail + 7.
        XCTAssertEqual(out.count, QuoteText.head + QuoteText.tail + 7)
        let body = out.dropFirst(2).dropLast(2)
        XCTAssertTrue(body.allSatisfy { $0 == "\u{1F600}" || $0 == " " || $0 == "\u{2026}" })
    }
}
