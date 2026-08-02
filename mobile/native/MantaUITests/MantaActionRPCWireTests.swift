import XCTest
@testable import MantaUI

// ===========================================================================
// S3 — action-RPC wire-shape guard (BET-595 review).
//
// The server dispatches every /rpc channel as `fn(...args)`, so each of these
// action channels must send its payload as a SINGLE element (`args: [dict]`),
// NOT `args: [[dict]]`. The latter makes `args[0]` an array and the handler
// reads `undefined`. This test drives the actual client methods through a
// captured transport and asserts the wire shape, so a re-wrap cannot regress
// silently the way the double-wrap did.
// ===========================================================================

final class MantaActionRPCWireTests: XCTestCase {

    override func setUp() {
        super.setUp()
        CapturingURLProtocol.cache = []
        CapturingURLProtocol.result = #"{"result": null}"#
    }

    private func makeClient() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CapturingURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    /// Assert the most recent request has `args` = exactly one payload object.
    private func assertSingleWrapped(_ file: StaticString = #filePath, line: UInt = #line) {
        guard let request = CapturingURLProtocol.cache.last else {
            XCTFail("no request captured", file: file, line: line)
            return
        }
        let json = CapturingURLProtocol.bodyJSON(request)
        let args = json?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1, "args must contain exactly one payload", file: file, line: line)
        // The single payload must be an OBJECT (payload), never a nested array.
        XCTAssertFalse(args?.first is [Any], "args[0] must be the payload object, not an array", file: file, line: line)
        XCTAssertNotNil(args?.first as? [String: Any], "args[0] must be a JSON object", file: file, line: line)
    }

    func testNewSessionSingleWraps() async throws {
        let client = makeClient()
        try await client.newSession(NewSessionInput(name: "p", cwd: "/d", windowName: "w", createDir: true, chatMode: true))
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:new-session")
    }

    func testNewWindowSingleWraps() async throws {
        let client = makeClient()
        try await client.newWindow(NewWindowInput(sessionName: "p", windowName: "w", cwd: nil, chatMode: true))
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:new-window")
    }

    func testKillWindowSingleWraps() async throws {
        let client = makeClient()
        try await client.killWindow(KillWindowInput(sessionName: "p", windowIndex: 2))
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:kill-window")
    }

    func testDeleteSessionSingleWraps() async throws {
        let client = makeClient()
        try await client.deleteSession(sessionId: "s", sessionName: "p", windowIndex: 2)
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:delete-session")
    }

    func testRenameWindowSingleWraps() async throws {
        let client = makeClient()
        try await client.renameWindow(session: "p", index: 2, newName: "n")
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:rename-window")
    }

    func testSelectWindowSingleWraps() async throws {
        let client = makeClient()
        try await client.selectWindow(session: "p", index: 2)
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:select-window")
    }

    func testForkSessionSingleWraps() async throws {
        let client = makeClient()
        try await client.forkSession(sessionId: "s", sessionName: "p", windowName: "w")
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:fork-session")
    }

    // MARK: - request-shape (payload keys present)

    func testNewSessionCarriesCreateFields() async throws {
        let client = makeClient()
        try await client.newSession(NewSessionInput(name: "proj", cwd: "~/x", windowName: "w", createDir: true, chatMode: false))
        let payload = CapturingURLProtocol.lastPayload()
        XCTAssertEqual(payload?["name"] as? String, "proj")
        XCTAssertEqual(payload?["cwd"] as? String, "~/x")
        XCTAssertEqual(payload?["windowName"] as? String, "w")
        XCTAssertNotNil(payload?["createDir"])
        XCTAssertNotNil(payload?["chatMode"])
    }
}

// MARK: - Capturing URLProtocol

private final class CapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var cache: [URLRequest] = []
    nonisolated(unsafe) static var result: String = #"{"result": null}"#

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.cache.append(request)
        let data = Data(Self.result.utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// The request's JSON body (handles URLSession's httpBody → stream split).
    static func bodyJSON(_ request: URLRequest) -> [String: Any]? {
        let body: Data
        if let httpBody = request.httpBody {
            body = httpBody
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            let bufferSize = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: bufferSize)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            body = data
        } else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }

    static func lastPayload() -> [String: Any]? {
        guard let request = cache.last,
              let args = bodyJSON(request)?["args"] as? [Any],
              let first = args.first as? [String: Any] else {
            return nil
        }
        return first
    }
}
