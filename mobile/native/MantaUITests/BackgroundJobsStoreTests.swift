import XCTest
@testable import MantaUI

// The store behind the Background jobs sheet, driven through a stubbed
// URLSession (same technique as SessionListJobToleranceTests). Needs the app
// target (SwiftUI/Combine), so this runs on the Mac with the rest of
// MantaUITests; the pure row/ordering logic is in SessionActivityOrderTests.

@MainActor
final class BackgroundJobsStoreTests: XCTestCase {

    private final class StubChannelURLProtocol: URLProtocol {
        /// RPC channel name (the last path component) → raw response body.
        nonisolated(unsafe) static var responses: [String: String] = [:]

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            let channel = request.url?.lastPathComponent ?? ""
            let body = Self.responses[channel] ?? #"{"result":null}"#
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    private let jobsJSON = #"""
    {"result":[
      {"id":"done1","name":"Old job","status":"done","childSessionID":"c_done","parentSessionID":"ses_p","finishedAt":1000},
      {"id":"run1","name":"New job","status":"running","origin":"subagent","childSessionID":"c_run","parentSessionID":"ses_p","startedAt":2000},
      {"id":"broken"}
    ]}
    """#

    private let projectsJSON = #"""
    {"result":[{"tmuxSession":"proj","defaultCwd":"/tmp","windows":[
      {"index":0,"name":"parent","active":false,"paneCurrentPath":"/p","opencodeSessionId":"ses_p"},
      {"index":4,"name":"job window","active":false,"paneCurrentPath":"/p","opencodeSessionId":"c_run","owner":"job"}
    ],"attached":false}]}
    """#

    override func setUp() {
        super.setUp()
        StubChannelURLProtocol.responses = [:]
    }

    private func makeStore() -> BackgroundJobsStore {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubChannelURLProtocol.self]
        let api = MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
        return BackgroundJobsStore(api: api, sessionId: "ses_p")
    }

    func testRefreshLoadsJobsLiveFirstAndSkipsTheMalformedOne() async {
        StubChannelURLProtocol.responses = ["delegate:list": jobsJSON, "tmux:list": projectsJSON]
        let store = makeStore()

        await store.refresh()

        XCTAssertEqual(store.jobs.map(\.id), ["run1", "done1"])
        XCTAssertEqual(store.runningCount, 1)
        XCTAssertTrue(store.loaded)
        XCTAssertNil(store.loadError)
        XCTAssertEqual(store.childStatus("c_run"), "running")
        XCTAssertEqual(store.childStatus("c_done"), "done")
        XCTAssertNil(store.childStatus("c_unknown"))
    }

    func testOnlyJobsWithALiveWindowAreOpenable() async {
        StubChannelURLProtocol.responses = ["delegate:list": jobsJSON, "tmux:list": projectsJSON]
        let store = makeStore()

        await store.refresh()

        XCTAssertEqual(store.openableChildIDs, ["c_run"])
        XCTAssertTrue(store.windowsKnown)
        XCTAssertEqual(store.window(forChild: "c_run"), BackgroundJobWindow(project: "proj", index: 4, name: "job window"))
        XCTAssertNil(store.window(forChild: "c_done"))
    }

    func testFailedRefreshKeepsTheJobsAlreadyShown() async {
        StubChannelURLProtocol.responses = ["delegate:list": jobsJSON, "tmux:list": projectsJSON]
        let store = makeStore()
        await store.refresh()
        XCTAssertEqual(store.jobs.count, 2)

        StubChannelURLProtocol.responses = ["delegate:list": #"{"error":"boom"}"#, "tmux:list": projectsJSON]
        await store.refresh()

        XCTAssertEqual(store.jobs.map(\.id), ["run1", "done1"], "a failed refresh must not blank the list")
        XCTAssertEqual(store.loadError, "boom")
        XCTAssertTrue(store.loaded)
    }

    func testStopThrowsTheBoxsReasonWhenItRefuses() async {
        StubChannelURLProtocol.responses = [
            "delegate:stop": #"{"result":{"ok":false,"error":"job not running"}}"#,
        ]
        let store = makeStore()

        do {
            try await store.stop("run1")
            XCTFail("a refused stop must throw, not read as a success")
        } catch {
            XCTAssertEqual(error as? MantaError, .server("job not running"))
        }
    }

    func testStopSucceedsAndRefreshes() async throws {
        StubChannelURLProtocol.responses = [
            "delegate:stop": #"{"result":{"ok":true}}"#,
            "delegate:list": #"{"result":[{"id":"run1","status":"stopped","finishedAt":3000}]}"#,
        ]
        let store = makeStore()

        try await store.stop("run1")

        XCTAssertEqual(store.jobs.map(\.status), ["stopped"])
        XCTAssertEqual(store.runningCount, 0)
    }

    func testEmptyEngineAnswerIsAnEmptyListNotAnError() async {
        StubChannelURLProtocol.responses = ["delegate:list": #"{"result":{"jobs":[]}}"#]
        let store = makeStore()

        await store.refresh()

        XCTAssertTrue(store.jobs.isEmpty)
        XCTAssertTrue(store.loaded)
        XCTAssertNil(store.loadError)
    }

    func testStartAndStopAutoRefreshAreIdempotent() async {
        StubChannelURLProtocol.responses = ["delegate:list": jobsJSON, "tmux:list": projectsJSON]
        let store = makeStore()

        store.startAutoRefresh()
        store.startAutoRefresh()   // second call must not spawn a second poller
        store.stopAutoRefresh()
        store.stopAutoRefresh()
        store.startAutoRefresh()   // and it can be restarted after a stop
        store.stopAutoRefresh()
    }

    /// The chat screen and the Background jobs sheet share ONE store. Closing
    /// the sheet (its stop) must not silence the chat screen's polling.
    func testAutoRefreshIsReferenceCountedAcrossSharedHolders() async {
        StubChannelURLProtocol.responses = ["delegate:list": jobsJSON, "tmux:list": projectsJSON]
        let store = makeStore()
        XCTAssertFalse(store.isAutoRefreshing)

        store.startAutoRefresh()   // chat screen appears
        store.startAutoRefresh()   // sheet opens
        XCTAssertTrue(store.isAutoRefreshing)

        store.stopAutoRefresh()    // sheet closes
        XCTAssertTrue(store.isAutoRefreshing, "closing the sheet must leave the chat screen's polling running")

        store.stopAutoRefresh()    // chat screen disappears
        XCTAssertFalse(store.isAutoRefreshing)

        store.stopAutoRefresh()    // an unbalanced extra stop is harmless...
        XCTAssertFalse(store.isAutoRefreshing)
        store.startAutoRefresh()   // ...and does not leave a negative count behind
        XCTAssertTrue(store.isAutoRefreshing)
        store.stopAutoRefresh()
        XCTAssertFalse(store.isAutoRefreshing)
    }
}
