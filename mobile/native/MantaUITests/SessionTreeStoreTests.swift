import XCTest
@testable import MantaUI

// Mac-only half of the session-tree tests (stage (b), iOS): the store's wiring around the pure decisions in
// `SessionTreeTests` — the rows and counts it derives from a project's `tree`, a virtual row's live status, and a tap
// on a virtual row (`sessions:materialize`: opened / refused / failed, one in flight at a time).

@MainActor
final class SessionTreeStoreTests: XCTestCase {

    // MARK: - Fixtures

    /// Minimal injectable stream so `windowStatus` frames can be pushed through the real event store (mirrors the
    /// suite's other `MantaEventStreamControl` fakes).
    @MainActor
    private final class TreeStream: MantaEventStreamControl {
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

    private var suites: [String] = []

    override func tearDown() {
        for name in suites { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        suites = []
        super.tearDown()
    }

    private func defaults() -> UserDefaults {
        let name = "SessionTreeStoreTests.\(UUID().uuidString)"
        suites.append(name)
        return UserDefaults(suiteName: name) ?? .standard
    }

    private func makeStore(_ fake: SessionListFake = SessionListFake(), stream: TreeStream = TreeStream()) -> (store: SessionListStore, stream: TreeStream) {
        let eventStore = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        // Dead localhost port so any stray background I/O fails fast and is swallowed; the seam is what these drive.
        let store = SessionListStore(
            api: MantaAPIClient(serverURL: URL(string: "https://127.0.0.1:1")!),
            eventStore: eventStore,
            mutations: fake,
            defaults: defaults()
        )
        return (store, stream)
    }

    private func win(_ index: Int, sid: String? = nil, owner: String? = nil) -> MantaWindow {
        MantaWindow(index: index, name: "w\(index)", active: false, paneCurrentPath: "/p", opencodeSessionId: sid,
                    worktreePath: nil, owner: owner)
    }

    private func proj(_ windows: [MantaWindow], tree: [SessionTreeNode]? = nil) -> MantaProject {
        MantaProject(tmuxSession: "p", defaultCwd: "/p", windows: windows, attached: false, mantaOwned: nil, tree: tree)
    }

    private func windowNode(_ index: Int, sid: String, children: [SessionTreeNode] = []) -> SessionTreeNode {
        SessionTreeNode(key: sid, sessionId: sid, kind: "window", windowIndex: index, title: "w\(index)", children: children)
    }

    private func virtualNode(_ sid: String, title: String = "driver", outside: Bool = false,
                             job: SessionTreeJob? = nil, children: [SessionTreeNode] = []) -> SessionTreeNode {
        SessionTreeNode(key: sid, sessionId: sid, kind: "virtual", title: title, job: job, outside: outside, children: children)
    }

    private func job(_ status: String) -> SessionTreeJob { SessionTreeJob(id: "j-\(status)", status: status, origin: "delegate") }

    private func windowStatusFrame(_ sid: String, busy: Bool = false, subagents: Int = 0, attention: String? = nil) -> String {
        let attentionJSON = attention.map { "\"\($0)\"" } ?? "null"
        return #"{"kind":"stream","sub":"windowStatus","sessionId":"\#(sid)","payload":{"running":false,"busy":\#(busy),"startedAt":null,"attention":\#(attentionJSON),"subagents":\#(subagents),"stopped":false}}"#
    }

    // MARK: - Rows

    func testRowsComeFromTheTreesRootsAndADescendantWindowIsNotATopLevelRow() {
        let (store, _) = makeStore()
        store.applyProjects([proj([win(0, sid: "ses_a"), win(1, sid: "ses_b")], tree: [
            windowNode(0, sid: "ses_a", children: [windowNode(1, sid: "ses_b")]),
            virtualNode("ses_v"),
        ])])

        XCTAssertEqual(store.visibleProjectRows.map(\.name), ["p"])
        XCTAssertEqual(store.visibleProjectRows[0].rows.map(\.id), ["w0", "v:ses_v"])
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0], "a virtual row has no window")
        XCTAssertEqual(store.visibleProjects.first?.windows.map(\.index), [0])
    }

    func testAProjectWhoseOnlyRowIsVirtualIsNotDropped() {
        let (store, _) = makeStore()
        // Its one window is a descendant of the virtual root: no window row, but there IS a row.
        store.applyProjects([proj([win(1, sid: "ses_b")], tree: [virtualNode("ses_v", children: [windowNode(1, sid: "ses_b")])])])

        XCTAssertEqual(store.visibleProjectRows.map(\.name), ["p"])
        XCTAssertEqual(store.visibleProjectRows[0].rows.map(\.id), ["v:ses_v"])
        XCTAssertEqual(store.visibleProjects.map(\.tmuxSession), ["p"])
        XCTAssertEqual(store.visibleProjects.first?.windows.count, 0)
    }

    func testWithoutATreeTheListIsExactlyToday() {
        let (store, _) = makeStore()
        store.applyProjects([proj([win(0, sid: "ses_a"), win(1, sid: "ses_job", owner: "job")])])

        XCTAssertEqual(store.visibleProjectRows[0].rows.map(\.id), ["w0"])
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0])
    }

    // MARK: - Counts and status

    func testARootsBackgroundCountComesFromItsTreeDescendants() {
        let (store, stream) = makeStore()
        let root = win(0, sid: "ses_a")
        store.applyProjects([proj([root], tree: [windowNode(0, sid: "ses_a", children: [
            virtualNode("b", job: job("running"), children: [virtualNode("c", job: job("paused"))]),
            virtualNode("d", job: job("done")),
        ])])])

        XCTAssertEqual(store.rowStatus(for: root).backgroundJobs, 2, "the running and the paused job, at any depth; not the finished one")

        // The box's rollup wins once it has reported (it also counts collapsed descendants).
        stream.inject(windowStatusFrame("ses_a", busy: true, subagents: 3))
        XCTAssertEqual(store.rowStatus(for: root).backgroundJobs, 3)
        stream.inject(windowStatusFrame("ses_a", busy: false, subagents: 0))
        XCTAssertEqual(store.rowStatus(for: root).backgroundJobs, 0)
    }

    func testARootWithNoListedDescendantsStillShowsTheBoxsRollup() {
        let (store, stream) = makeStore()
        let root = win(0, sid: "ses_a")
        store.applyProjects([proj([root], tree: [windowNode(0, sid: "ses_a")])])
        XCTAssertEqual(store.rowStatus(for: root).backgroundJobs, 0)

        stream.inject(windowStatusFrame("ses_a", busy: true, subagents: 2))
        XCTAssertEqual(store.rowStatus(for: root).backgroundJobs, 2)
    }

    func testWithoutATreeTheCountStillComesFromTheWindowsJobNesting() {
        let (store, _) = makeStore()
        let parent = win(0, sid: "ses_p")
        var child = win(1, sid: "ses_c")
        child.job = MantaWindowJob(id: "j", status: "running", parentWindowIndex: 0)
        store.applyProjects([proj([parent, child])])

        XCTAssertEqual(store.rowStatus(for: parent).backgroundJobs, 1)
        XCTAssertEqual(store.visibleWindows(in: store.projects[0]).map(\.index), [0])
    }

    func testAVirtualRowsStatusComesFromTheWindowStatusMapBySessionId() {
        let (store, stream) = makeStore()
        let v = SessionVirtualRow(key: "ses_v", sessionId: "ses_v", title: "driver", outside: true, job: nil)
        store.applyProjects([proj([], tree: [virtualNode("ses_v", outside: true, children: [virtualNode("ses_x")])])])

        let idle = store.rowStatus(for: .virtual(v))
        XCTAssertFalse(idle.running)
        XCTAssertFalse(idle.attention)
        XCTAssertFalse(idle.isTerminal)

        stream.inject(windowStatusFrame("ses_v", busy: true, subagents: 2))
        let busy = store.rowStatus(for: .virtual(v))
        XCTAssertTrue(busy.running)
        XCTAssertEqual(busy.backgroundJobs, 2)
        XCTAssertEqual(store.runningCount(in: store.visibleProjectRows[0]), 1)

        stream.inject(windowStatusFrame("ses_v", busy: false, subagents: 0, attention: "question"))
        XCTAssertTrue(store.rowStatus(for: .virtual(v)).attention)
    }

    // MARK: - Opening a virtual row

    private let virtualID = "ses_v"

    private func opened(_ index: Int = 4) -> Result<SessionMaterializeResult, Error> {
        .success(.opened(project: "p", windowIndex: index, sessionId: virtualID))
    }

    func testTapOpensTheWindowTheBoxMadeWithoutAnotherRefreshWhenTheListHasIt() async {
        let fake = SessionListFake()
        fake.materializeResults[virtualID] = [opened()]
        let (store, _) = makeStore(fake)
        store.applyProjects([proj([win(4, sid: virtualID)], tree: [windowNode(4, sid: virtualID)])])

        let outcome = await store.materialize(sessionId: virtualID)

        XCTAssertEqual(outcome, .opened(project: "p", windowIndex: 4, sessionId: virtualID))
        XCTAssertEqual(fake.materializeCalls, [virtualID])
        XCTAssertEqual(store.refreshRequestCount, 0)
        XCTAssertTrue(store.materializing.isEmpty)
    }

    func testTapRefreshesTheListFirstWhenTheNewWindowIsNotInIt() async {
        let fake = SessionListFake()
        fake.materializeResults[virtualID] = [opened()]
        let (store, _) = makeStore(fake)
        store.applyProjects([proj([win(0, sid: "ses_a")], tree: [windowNode(0, sid: "ses_a"), virtualNode(virtualID)])])
        store.projectsReader = { [self] in
            [proj([win(0, sid: "ses_a"), win(4, sid: virtualID)], tree: [windowNode(0, sid: "ses_a"), windowNode(4, sid: virtualID)])]
        }
        XCTAssertNil(store.window(session: "p", index: 4))

        let outcome = await store.materialize(sessionId: virtualID)

        XCTAssertEqual(outcome, .opened(project: "p", windowIndex: 4, sessionId: virtualID))
        XCTAssertEqual(store.refreshRequestCount, 1)
        XCTAssertNotNil(store.window(session: "p", index: 4), "the window can be opened by the time the caller pushes it")
    }

    func testARefusalShowsTheBoxsSentenceAndOpensNothing() async {
        let fake = SessionListFake()
        fake.materializeResults[virtualID] = [.success(.refused(reason: "handoff", message: "A handoff of this conversation is in progress — try again in a moment."))]
        let (store, _) = makeStore(fake)

        let outcome = await store.materialize(sessionId: virtualID)

        XCTAssertEqual(outcome, .message("A handoff of this conversation is in progress — try again in a moment."))
        XCTAssertEqual(store.refreshRequestCount, 0)
        XCTAssertTrue(store.materializing.isEmpty)
    }

    func testAThrownErrorShowsTheGenericSentence() async {
        let fake = SessionListFake()
        fake.materializeResults[virtualID] = [.failure(MantaError.transport("offline"))]
        let (store, _) = makeStore(fake)

        let outcome = await store.materialize(sessionId: virtualID)

        XCTAssertEqual(outcome, .message("Couldn't open this session."))
        XCTAssertTrue(store.materializing.isEmpty, "the row is tappable again")
    }

    func testASecondTapWhileTheFirstIsInFlightDoesNothing() async {
        let fake = SessionListFake()
        fake.heldMaterialize = [virtualID]
        fake.materializeResults[virtualID] = [opened()]
        let (store, _) = makeStore(fake)
        store.applyProjects([proj([win(4, sid: virtualID)], tree: [windowNode(4, sid: virtualID)])])

        let first = Task { await store.materialize(sessionId: virtualID) }
        var spins = 0
        while !fake.isHoldingMaterialize(virtualID), spins < 1000 { await Task.yield(); spins += 1 }
        XCTAssertTrue(fake.isHoldingMaterialize(virtualID))
        XCTAssertTrue(store.materializing.contains(virtualID))

        let second = await store.materialize(sessionId: virtualID)
        XCTAssertEqual(second, .ignored)

        fake.releaseMaterialize(virtualID)
        let result = await first.value
        XCTAssertEqual(result, .opened(project: "p", windowIndex: 4, sessionId: virtualID))
        XCTAssertEqual(fake.materializeCalls, [virtualID], "one request reached the box")
        XCTAssertTrue(store.materializing.isEmpty)

        // …and once it has finished the row can be opened again.
        fake.heldMaterialize = []
        let again = await store.materialize(sessionId: virtualID)
        XCTAssertEqual(again, .opened(project: "p", windowIndex: 4, sessionId: virtualID))
    }

    func testTwoDifferentRowsCanOpenAtOnce() async {
        let fake = SessionListFake()
        fake.heldMaterialize = ["ses_1"]
        fake.materializeResults["ses_1"] = [.success(.opened(project: "p", windowIndex: 1, sessionId: "ses_1"))]
        fake.materializeResults["ses_2"] = [.success(.opened(project: "p", windowIndex: 2, sessionId: "ses_2"))]
        let (store, _) = makeStore(fake)
        store.applyProjects([proj([win(1, sid: "ses_1"), win(2, sid: "ses_2")])])

        let first = Task { await store.materialize(sessionId: "ses_1") }
        var spins = 0
        while !fake.isHoldingMaterialize("ses_1"), spins < 1000 { await Task.yield(); spins += 1 }
        let other = await store.materialize(sessionId: "ses_2")
        XCTAssertEqual(other, .opened(project: "p", windowIndex: 2, sessionId: "ses_2"))

        fake.releaseMaterialize("ses_1")
        _ = await first.value
    }

    func testAnAnswerFromABoxWeHaveLeftIsDropped() async {
        let fake = SessionListFake()
        fake.heldMaterialize = [virtualID]
        fake.materializeResults[virtualID] = [opened()]
        let (store, _) = makeStore(fake)

        let first = Task { await store.materialize(sessionId: virtualID) }
        var spins = 0
        while !fake.isHoldingMaterialize(virtualID), spins < 1000 { await Task.yield(); spins += 1 }
        store.resetForBoxChange()
        XCTAssertTrue(store.materializing.isEmpty)
        fake.releaseMaterialize(virtualID)

        let result = await first.value
        XCTAssertEqual(result, .ignored)
        XCTAssertTrue(store.materializing.isEmpty)
    }

    func testAnEmptySessionIdIsIgnored() async {
        let fake = SessionListFake()
        let (store, _) = makeStore(fake)
        let outcome = await store.materialize(sessionId: "")
        XCTAssertEqual(outcome, .ignored)
        XCTAssertTrue(fake.materializeCalls.isEmpty)
    }
}

// MARK: - The RPC itself

private final class MaterializeCapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responseBody = #"{"result":null}"#
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        Self.lastBody = Self.bodyData(of: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// A request's body, whether URLSession handed it over as bytes or as a stream.
    private static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

@MainActor
final class SessionMaterializeRequestTests: XCTestCase {

    private func makeAPI() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MaterializeCapturingURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    func testTheRequestIsTheMaterializeChannelWithTheSessionId() async throws {
        MaterializeCapturingURLProtocol.responseBody = #"{"result":{"ok":true,"project":"p","windowIndex":4,"sessionId":"ses_v"}}"#
        MaterializeCapturingURLProtocol.lastRequest = nil
        MaterializeCapturingURLProtocol.lastBody = nil

        let result = try await makeAPI().sessionsMaterialize(sessionId: "ses_v")

        XCTAssertEqual(result, .opened(project: "p", windowIndex: 4, sessionId: "ses_v"))
        let request = try XCTUnwrap(MaterializeCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertTrue(request.url?.path.hasSuffix("/rpc/sessions:materialize") == true, "\(request.url?.absoluteString ?? "")")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        let body = try XCTUnwrap(MaterializeCapturingURLProtocol.lastBody)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let args = try XCTUnwrap(object["args"] as? [[String: Any]])
        XCTAssertEqual(args.count, 1)
        XCTAssertEqual(args.first?["sessionId"] as? String, "ses_v")
        XCTAssertEqual(args.first?.count, 1)
    }

    func testARefusalIsAnAnswerNotAnError() async throws {
        MaterializeCapturingURLProtocol.responseBody = #"{"result":{"ok":false,"reason":"no-project","message":"No workspace owns this session."}}"#
        let result = try await makeAPI().sessionsMaterialize(sessionId: "ses_v")
        XCTAssertEqual(result, .refused(reason: "no-project", message: "No workspace owns this session."))
    }

    func testAnErrorEnvelopeThrows() async {
        MaterializeCapturingURLProtocol.responseBody = #"{"error":"unknown rpc channel: sessions:materialize"}"#
        do {
            _ = try await makeAPI().sessionsMaterialize(sessionId: "ses_v")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? MantaError, .server("unknown rpc channel: sessions:materialize"))
        }
    }
}
