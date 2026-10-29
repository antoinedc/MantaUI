import XCTest
@testable import MantaUI

// Auto-handoff — the parts that touch app-target code (not in the Linux package):
// the `handoff` tool part becoming its own transcript block, and the rpc wire
// shape of the six handoff channels.

final class HandoffTranscriptTests: XCTestCase {

    private func handoffPart(_ id: String, output: String? = "Handoff prompt ready below.\n<!-- manta-handoff:hof_a -->", status: String = "completed") -> OpencodePart {
        ToolActivity.makeToolPart(id: id, tool: "handoff", status: status, output: output)
    }

    private func bash(_ id: String) -> OpencodePart {
        ToolActivity.makeToolPart(id: id, tool: "bash", status: "completed", input: ["command": .string("ls")], output: "ok", startMs: 1000, endMs: 1400)
    }

    private func assistant(_ id: String, _ parts: [OpencodePart]) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(id: id, sessionID: "ses", role: OpencodeRole(rawValue: "assistant"),
                                      time: OpencodeTime(created: 0, completed: 1), modelID: nil, providerID: nil),
            parts: parts
        )
    }

    func testHandoffToolPartBecomesACardBlockThatSplitsTheRun() {
        let blocks = ChatTranscriptMapper.blocks(from: [assistant("m1", [bash("t1"), handoffPart("h1"), bash("t2")])])
        XCTAssertEqual(blocks.count, 3)
        guard case .activity(let first) = blocks[0], case .handoff(let ref) = blocks[1], case .activity(let last) = blocks[2] else {
            return XCTFail("expected activity, handoff, activity — got \(blocks)")
        }
        XCTAssertEqual(first.parts.map(\.id), ["t1"])
        XCTAssertEqual(last.parts.map(\.id), ["t2"])
        XCTAssertEqual(ref.partId, "h1")
        XCTAssertEqual(ref.handoffId, "hof_a")
        XCTAssertEqual(ref.statusLine, "Handoff prompt ready below.")
    }

    func testRunningHandoffPartStillDrawsAsAHandoffBlockWithNoRecordYet() {
        let blocks = ChatTranscriptMapper.blocks(from: [assistant("m1", [handoffPart("h1", output: nil, status: "running")])])
        guard case .handoff(let ref)? = blocks.first else { return XCTFail("expected a handoff block") }
        XCTAssertNil(ref.handoffId)
        XCTAssertEqual(ref.toolStatus, "running")
    }

    /// Row identity is the PART id: reproduced by every refetch, unique per call.
    func testHandoffRowIdentityIsThePartId() {
        let blocks = ChatTranscriptMapper.blocks(from: [assistant("m1", [handoffPart("h1"), handoffPart("h2", output: "x\n<!-- manta-handoff:hof_b -->")])])
        let rows = uniqueTranscriptRows(blocks)
        XCTAssertEqual(rows.map(\.id), ["hof-h1", "hof-h2"])
        XCTAssertEqual(uniqueTranscriptRows(blocks).map(\.id), rows.map(\.id))
        XCTAssertNil(blocks[0].timestamp)
    }

    /// A `handoff` call is a card of its own: the box leaves it out of every run (canonical and live), so it never
    /// appears as a run line only to vanish when the card takes over.
    func testAHandoffCallStandsApartFromTheRunAroundIt() {
        let blocks = ChatTranscriptMapper.blocks(from: BoxViewFixture.stampRuns([
            assistant("m1", [bash("t1"), handoffPart("h1"), bash("t2")]),
        ]))
        XCTAssertEqual(blocks.count, 3)
        guard case .activity(let first) = blocks[0], case .handoff = blocks[1], case .activity(let second) = blocks[2] else {
            return XCTFail("expected [.activity, .handoff, .activity], got \(blocks)")
        }
        XCTAssertEqual(first.parts.map(\.id), ["t1"])
        XCTAssertEqual(second.parts.map(\.id), ["t2"])
    }

    func testToolWithoutAHandoffIsUnchanged() {
        let blocks = ChatTranscriptMapper.blocks(from: [assistant("m1", [bash("t1"), bash("t2")])])
        XCTAssertEqual(blocks.count, 1)
        guard case .activity(let run) = blocks[0] else { return XCTFail("expected one run") }
        XCTAssertEqual(run.parts.map(\.id), ["t1", "t2"])
    }
}

// MARK: - Wire shape

final class HandoffWireTests: XCTestCase {

    override func setUp() {
        super.setUp()
        HandoffWireProtocol.cache = []
        HandoffWireProtocol.result = #"{"result": null}"#
    }

    private func makeClient() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HandoffWireProtocol.self]
        return MantaAPIClient(serverURL: URL(string: "https://box.example")!, tokenProvider: { "tok" },
                              session: URLSession(configuration: config))
    }

    /// Every handoff channel sends ONE payload object (`args: [dict]`), never a
    /// nested array — the shape the box dispatches as `fn(...args)`.
    private func assertSingleObject(path: String, file: StaticString = #filePath, line: UInt = #line) -> [String: Any]? {
        guard let request = HandoffWireProtocol.cache.last else {
            XCTFail("no request captured", file: file, line: line)
            return nil
        }
        XCTAssertEqual(request.url?.path, "/rpc/\(path)", file: file, line: line)
        let args = HandoffWireProtocol.bodyJSON(request)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1, file: file, line: line)
        return args?.first as? [String: Any]
    }

    func testCreateSendsOneObjectAndDecodesTheEnvelope() async throws {
        HandoffWireProtocol.result = #"{"result":{"handoff":{"id":"hof_1","fromSessionId":"ses_a","state":"generating","trigger":"user"}}}"#
        let record = try await makeClient().handoffCreate(sessionId: "ses_a", trigger: "user", action: "suggest", goal: "fix auth")
        let payload = assertSingleObject(path: "handoff:create")
        XCTAssertEqual(payload?["sessionId"] as? String, "ses_a")
        XCTAssertEqual(payload?["trigger"] as? String, "user")
        XCTAssertEqual(payload?["action"] as? String, "suggest")
        XCTAssertEqual(payload?["goal"] as? String, "fix auth")
        XCTAssertEqual(record.id, "hof_1")
        XCTAssertEqual(record.state, .generating)
    }

    func testCreateOmitsAnEmptyGoal() async throws {
        HandoffWireProtocol.result = #"{"result":{"handoff":{"id":"hof_1","state":"requested"}}}"#
        _ = try await makeClient().handoffCreate(sessionId: "ses_a", trigger: "button", action: "suggest", goal: "")
        XCTAssertNil(assertSingleObject(path: "handoff:create")?["goal"])
    }

    func testListSendsTheSessionIdAndDecodes() async throws {
        HandoffWireProtocol.result = #"{"result":{"records":[{"id":"hof_1","state":"ready"}],"links":{"replaces":"ses_0","branches":[]}}}"#
        let list = try await makeClient().handoffList(sessionId: "ses_a")
        XCTAssertEqual(assertSingleObject(path: "handoff:list")?["sessionId"] as? String, "ses_a")
        XCTAssertEqual(list.records.map(\.id), ["hof_1"])
        XCTAssertEqual(list.links?.replaces, "ses_0")
    }

    func testGetStartRetryShapes() async throws {
        let client = makeClient()
        HandoffWireProtocol.result = #"{"result":{"handoff":{"id":"hof_1","state":"ready"}}}"#
        _ = try await client.handoffGet(id: "hof_1")
        XCTAssertEqual(assertSingleObject(path: "handoff:get")?["id"] as? String, "hof_1")

        _ = try await client.handoffStart(id: "hof_1", how: .newSession, disposition: .draft)
        let start = assertSingleObject(path: "handoff:start")
        XCTAssertEqual(start?["id"] as? String, "hof_1")
        XCTAssertEqual(start?["how"] as? String, "new-session")
        XCTAssertEqual(start?["disposition"] as? String, "draft")
        XCTAssertNil(start?["text"])

        _ = try await client.handoffStart(id: "hof_1", how: .clear, disposition: .send)
        XCTAssertEqual(assertSingleObject(path: "handoff:start")?["how"] as? String, "clear")

        _ = try await client.handoffRetry(id: "hof_1")
        XCTAssertEqual(assertSingleObject(path: "handoff:retry")?["id"] as? String, "hof_1")
    }

    func testDraftConsumedEchoesTheRevisionAsSent() async throws {
        let client = makeClient()
        try await client.handoffDraftConsumed(id: "hof_1", draftRevision: .number(3))
        let numeric = assertSingleObject(path: "handoff:draft-consumed")
        XCTAssertEqual(numeric?["id"] as? String, "hof_1")
        XCTAssertEqual((numeric?["draftRevision"] as? NSNumber)?.intValue, 3)

        try await client.handoffDraftConsumed(id: "hof_1", draftRevision: .string("r7"))
        XCTAssertEqual(assertSingleObject(path: "handoff:draft-consumed")?["draftRevision"] as? String, "r7")
    }

    func testARefusalSurfacesTheBoxsCode() async {
        HandoffWireProtocol.result = #"{"error":"already_started"}"#
        do {
            _ = try await makeClient().handoffStart(id: "hof_1", how: .clear, disposition: .send)
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? MantaError, .server("already_started"))
            XCTAssertTrue(HandoffFailure.isAlreadyStarted(error))
        }
    }
}

private final class HandoffWireProtocol: URLProtocol {
    nonisolated(unsafe) static var cache: [URLRequest] = []
    nonisolated(unsafe) static var result: String = #"{"result": null}"#

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.cache.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.result.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func bodyJSON(_ request: URLRequest) -> [String: Any]? {
        let body: Data
        if let httpBody = request.httpBody {
            body = httpBody
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: 4096)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            body = data
        } else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }
}
