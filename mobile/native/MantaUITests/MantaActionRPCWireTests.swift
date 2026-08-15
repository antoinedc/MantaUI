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
        CapturingURLProtocol.statusCode = 200
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
        // The create channels return the project LIST, and a reply carrying no
        // result is now an error rather than an empty list (that laundering is
        // what let an unanswered `tmux:list` blank the session list). These
        // tests only assert the REQUEST shape, so they need a reply the method
        // can actually return — the class-wide `{"result": null}` default is
        // not one for these three.
        CapturingURLProtocol.result = #"{"result": []}"#
        try await client.newSession(NewSessionInput(name: "p", cwd: "/d", windowName: "w", createDir: true, chatMode: true))
        assertSingleWrapped()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/tmux:new-session")
    }

    func testNewWindowSingleWraps() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": []}"#
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
        CapturingURLProtocol.result = #"{"result": []}"#
        try await client.newSession(NewSessionInput(name: "proj", cwd: "~/x", windowName: "w", createDir: true, chatMode: false))
        let payload = CapturingURLProtocol.lastPayload()
        XCTAssertEqual(payload?["name"] as? String, "proj")
        XCTAssertEqual(payload?["cwd"] as? String, "~/x")
        XCTAssertEqual(payload?["windowName"] as? String, "w")
        XCTAssertNotNil(payload?["createDir"])
        XCTAssertNotNil(payload?["chatMode"])
    }

    // MARK: - transcript window (mobile session-load perf)

    /// `opencode:messages` is dispatched as `fn(sessionId, opts)`, so the
    /// window options MUST be a SECOND arg — not merged into the first, and not
    /// wrapped in an array. Getting this wrong is silent: the server reads
    /// `opts` as undefined and quietly serves the whole history again.
    func testMessagesSendsWindowOptionsAsASecondArg() async throws {
        CapturingURLProtocol.result = #"{"result": []}"#
        let client = makeClient()
        _ = try await client.messages(sessionId: "ses_1", limit: 30, slim: true)
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:messages")
        XCTAssertEqual(args?.count, 2)
        XCTAssertEqual(args?.first as? String, "ses_1")
        let opts = args?.last as? [String: Any]
        XCTAssertEqual(opts?["limit"] as? Int, 30)
        XCTAssertEqual(opts?["slim"] as? Bool, true)
    }

    /// The un-windowed call must stay a ONE-arg request — that is the shape the
    /// server treats as "the whole history, verbatim".
    func testMessagesWithoutOptionsSendsOnlyTheSessionId() async throws {
        CapturingURLProtocol.result = #"{"result": []}"#
        let client = makeClient()
        _ = try await client.messages(sessionId: "ses_1")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1)
        XCTAssertEqual(args?.first as? String, "ses_1")
    }
    // MARK: - scheduled tasks & secrets edit (BET-744)

    /// `schedule:delete` is dispatched as `fn(id)` — `args[0]` must be the job
    /// `ScheduledJob.id` as a bare string (not an array/object).
    func testScheduleDeleteSendsTheJobIdAsArg0() async throws {
        let client = makeClient()
        try await client.deleteSchedule(id: "a1b2c3d4")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/schedule:delete")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1)
        XCTAssertEqual(args?.first as? String, "a1b2c3d4")
    }

    /// `secrets:delete` is dispatched as `fn(id)` — `args[0]` is the
    /// `SecretMeta.id` store id as a bare string.
    func testSecretDeleteSendsTheSecretIdAsArg0() async throws {
        let client = makeClient()
        try await client.deleteSecret(id: "ab12cd34")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/secrets:delete")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1)
        XCTAssertEqual(args?.first as? String, "ab12cd34")
    }

    /// `secrets:set` serialises `{key, value, scope, sessionID, hint}` into
    /// `args[0]` — the box's `{...i}` merge shape (src/server/rpc.mjs).
    func testSecretSetSerializesKeyValueScopeSessionIDAndHint() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": {"ok": true, "meta": {"id": "x", "key": "GITHUB_PAT", "scope": "session", "sessionID": "ses_1", "project": null, "hint": "access", "hasValue": true}}}"#
        _ = try await client.setSecret(SecretInput(key: "GITHUB_PAT", value: "secret", scope: "session", sessionID: "ses_1", hint: "access"))
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/secrets:set")
        let payload = CapturingURLProtocol.lastPayload()
        XCTAssertEqual(payload?["key"] as? String, "GITHUB_PAT")
        XCTAssertEqual(payload?["value"] as? String, "secret")
        XCTAssertEqual(payload?["scope"] as? String, "session")
        XCTAssertEqual(payload?["sessionID"] as? String, "ses_1")
        XCTAssertEqual(payload?["hint"] as? String, "access")
    }

    /// `secrets:set` decodes `{ok, error}` — the failure reply, surfacing the
    /// box's error message (e.g. "value is required").
    func testSecretSetDecodesErrorString() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": {"ok": false, "error": "value is required"}}"#
        let result = try await client.setSecret(SecretInput(key: "K", value: ""))
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.error, "value is required")
        XCTAssertNil(result.meta)
    }

    /// `secrets:set` decodes `{ok, meta}` — the success reply carries the
    /// value-stripped metadata, never a value.
    func testSecretSetDecodesOkAndMeta() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": {"ok": true, "meta": {"id": "x", "key": "K", "scope": "shared", "sessionID": null, "project": null, "hint": "", "hasValue": true, "createdAt": 1750000000000, "updatedAt": 1750000000000}}}"#
        let result = try await client.setSecret(SecretInput(key: "K", value: "v", scope: "shared"))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.meta?.key, "K")
        XCTAssertEqual(result.meta?.scope, "shared")
        XCTAssertNil(result.error)
    }

    // MARK: - @-file typeahead (BET-749 gap #10)

    /// `opencode:find-files` is dispatched as `fn({query, directory})` — a
    /// SINGLE payload object carrying both keys — and decodes the box's bare
    /// `[String]` path list.
    func testFindFilesSendsQueryAndDirectoryAndDecodesStrings() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": ["src/foo.swift", "src/bar.swift"]}"#
        let results = try await client.findFiles(query: "foo", directory: "/home/user/project")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:find-files")
        let payload = CapturingURLProtocol.lastPayload()
        XCTAssertEqual(payload?["query"] as? String, "foo")
        XCTAssertEqual(payload?["directory"] as? String, "/home/user/project")
        XCTAssertEqual(results, ["src/foo.swift", "src/bar.swift"])
    }

    /// A nil directory omits the key entirely — the box then returns a
    /// browse-style listing rather than searching a specific cwd.
    func testFindFilesOmitsDirectoryWhenNil() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": []}"#
        let results = try await client.findFiles(query: "foo")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:find-files")
        let payload = CapturingURLProtocol.lastPayload()
        XCTAssertEqual(payload?["query"] as? String, "foo")
        XCTAssertNil(payload?["directory"])
        XCTAssertEqual(results, [])
    }

    /// A `Mention` built from a file name + range serializes onto
    /// `opencode:prompt` args UNCHANGED through the existing send path —
    /// `name` and `source.value/start/end` all land in `args[0].mentions[i]`.
    func testSendPromptSerializesMentionUnchanged() async throws {
        let client = makeClient()
        let mention = SendPromptInput.Mention(
            name: "src/foo.swift",
            source: SendPromptInput.MentionSource(value: "@src/foo.swift", start: 4, end: 18)
        )
        _ = try await client.sendPrompt(SendPromptInput(
            sessionId: "ses_1",
            text: "see @src/foo.swift",
            mentions: [mention]
        ))
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:prompt")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        let payload = args?.first as? [String: Any]
        let mentions = payload?["mentions"] as? [[String: Any]]
        let m = mentions?.first
        XCTAssertEqual(m?["name"] as? String, "src/foo.swift")
        let source = m?["source"] as? [String: Any]
        XCTAssertEqual(source?["value"] as? String, "@src/foo.swift")
        XCTAssertEqual(source?["start"] as? Int, 4)
        XCTAssertEqual(source?["end"] as? Int, 18)
    }

    /// A plan-mode prompt carries `agent` onto `opencode:prompt` args (BET-952),
    /// structurally identical to how `model`/`variant` travel — and omits the
    /// key entirely when unset, so a build-mode prompt is byte-identical.
    func testSendPromptCarriesAgentWhenSetAndOmitsWhenNil() async throws {
        let client = makeClient()
        _ = try await client.sendPrompt(SendPromptInput(
            sessionId: "ses_1",
            text: "plan this",
            agent: "plan"
        ))
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/opencode:prompt")
        var args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        var payload = args?.first as? [String: Any]
        XCTAssertEqual(payload?["agent"] as? String, "plan")

        _ = try await client.sendPrompt(SendPromptInput(
            sessionId: "ses_1",
            text: "build this"
        ))
        args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        payload = args?.first as? [String: Any]
        XCTAssertNil(payload?["agent"])
    }

    // MARK: - artifacts / agent-file outbox (BET-750)

    /// `outbox:list` is dispatched as `fn(sessionId)` — scoped to the session —
    /// and decodes the box's `[OutboxFile]` rows.
    func testListOutboxSendsSessionIdAndDecodesFiles() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": [{"path": "/home/dev/.manta-outbox/ses_1/report.pdf", "name": "report.pdf", "size": 1234, "sessionID": "ses_1", "mtime": 1750000000000, "expiresAt": 1750604800000}]}"#
        let files = try await client.listOutbox(sessionId: "ses_1")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/outbox:list")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 1)
        XCTAssertEqual(args?.first as? String, "ses_1")
        let file = try XCTUnwrap(files.first)
        XCTAssertEqual(file.path, "/home/dev/.manta-outbox/ses_1/report.pdf")
        XCTAssertEqual(file.name, "report.pdf")
        XCTAssertEqual(file.size, 1234)
        XCTAssertEqual(file.sessionID, "ses_1")
        XCTAssertEqual(file.mtime, 1750000000000)
        XCTAssertEqual(file.expiresAt, 1750604800000)
    }

    /// `outbox:list` with a nil sessionId sends no args — the box then lists
    /// every artifact across sessions.
    func testListOutboxOmitsSessionIdWhenNil() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"{"result": []}"#
        let files = try await client.listOutbox()
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/rpc/outbox:list")
        let args = CapturingURLProtocol.bodyJSON(CapturingURLProtocol.cache.last!)?["args"] as? [Any]
        XCTAssertEqual(args?.count, 0)
        XCTAssertTrue(files.isEmpty)
    }

    /// `downloadOutboxFile` GETs `/api/download?path=<abs>` with a bearer token
    /// and returns the file bytes on 200.
    func testDownloadOutboxFileReturnsBytesOn200() async throws {
        let client = makeClient()
        CapturingURLProtocol.result = #"PDFBYTES"#
        let data = try await client.downloadOutboxFile(path: "/home/dev/.manta-outbox/ses_1/report.pdf")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.url?.path, "/api/download")
        // Assert the `path` query item carries the absolute box path, decoding
        // the percent-encoding rather than pinning a specific escape form.
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(CapturingURLProtocol.cache.last?.url), resolvingAgainstBaseURL: false))
        let pathValue = components.queryItems?.first { $0.name == "path" }?.value
        XCTAssertEqual(pathValue, "/home/dev/.manta-outbox/ses_1/report.pdf")
        XCTAssertEqual(CapturingURLProtocol.cache.last?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(data, Data("PDFBYTES".utf8))
    }

    /// A `403 "path outside outbox"` must throw — never surface as empty bytes.
    func testDownloadOutboxFileThrowsOn403() async throws {
        let client = makeClient()
        CapturingURLProtocol.statusCode = 403
        CapturingURLProtocol.result = #"{"error": "path outside outbox"}"#
        do {
            _ = try await client.downloadOutboxFile(path: "/etc/passwd")
            XCTFail("expected a throw for a path outside the outbox")
        } catch let error as MantaError {
            guard case .server(let message) = error else {
                return XCTFail("expected MantaError.server, got \(error)")
            }
            XCTAssertEqual(message, "path outside outbox")
        }
    }

    /// A `404` for a missing file must throw rather than return empty `Data`.
    func testDownloadOutboxFileThrowsOn404() async throws {
        let client = makeClient()
        CapturingURLProtocol.statusCode = 404
        CapturingURLProtocol.result = #"{"error": "not found"}"#
        do {
            _ = try await client.downloadOutboxFile(path: "/home/dev/.manta-outbox/ses_1/gone.txt")
            XCTFail("expected a throw for a missing file")
        } catch let error as MantaError {
            guard case .server(let message) = error else {
                return XCTFail("expected MantaError.server, got \(error)")
            }
            XCTAssertEqual(message, "not found")
        }
    }
}

// MARK: - Capturing URLProtocol

private final class CapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var cache: [URLRequest] = []
    nonisolated(unsafe) static var result: String = #"{"result": null}"#
    nonisolated(unsafe) static var statusCode: Int = 200

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.cache.append(request)
        let data = Data(Self.result.utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: nil, headerFields: nil)!
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
