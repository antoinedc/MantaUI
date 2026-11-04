import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MantaUI

// ===========================================================================
// WS08 — wire-shape guard for the sign-in / provider / endpoint channels.
//
// The box dispatches every /rpc channel as `fn(...args)`, so the shape of `args`
// is the contract: most channels take ONE object, but the three `pty:*`
// channels, `claude:login-cancel` and `opencode:discover-models` take
// POSITIONAL arguments (an object there is read as the first positional value —
// discovery silently probes ""). These tests drive the real client methods
// through a captured transport so a re-wrap cannot regress silently.
//
// Mac only (needs `MantaAPIClient`, which is not part of the Linux package).
// ===========================================================================

final class AccountsRPCWireTests: XCTestCase {

    override func setUp() {
        super.setUp()
        AccountsCapturingURLProtocol.reset()
    }

    private func makeClient() -> MantaAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AccountsCapturingURLProtocol.self]
        return MantaAPIClient(
            serverURL: URL(string: "https://box.example")!,
            tokenProvider: { "tok" },
            session: URLSession(configuration: config)
        )
    }

    private var lastPath: String? { AccountsCapturingURLProtocol.cache.last?.url?.path }
    private var lastArgs: [Any]? {
        guard let request = AccountsCapturingURLProtocol.cache.last else { return nil }
        return AccountsCapturingURLProtocol.bodyJSON(request)?["args"] as? [Any]
    }
    private var lastObject: [String: Any]? { lastArgs?.first as? [String: Any] }

    private func assertSingleObject(_ file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(lastArgs?.count, 1, "args must hold exactly one payload", file: file, line: line)
        XCTAssertNotNil(lastObject, "args[0] must be a JSON object", file: file, line: line)
    }

    // MARK: - Re-sign

    func testResignChannelsSendOneObject() async throws {
        let client = makeClient()

        AccountsCapturingURLProtocol.result = #"{"result": {"flowId": "f1", "connect": {"shape": "claude-login", "sessionKey": "k"}}}"#
        let started = try await client.accountsResignSeat(provider: "claude", seatId: "s1")
        XCTAssertEqual(lastPath, "/rpc/accounts:resign-seat")
        assertSingleObject()
        XCTAssertEqual(lastObject?["provider"] as? String, "claude")
        XCTAssertEqual(lastObject?["seatId"] as? String, "s1")
        XCTAssertEqual(started.flowId, "f1")
        XCTAssertEqual(SignInConnect(json: started.connect)?.sessionKey, "k")

        AccountsCapturingURLProtocol.result = #"{"result": {"state": "failed", "error": "different-account", "expectedEmail": "a@x", "gotEmail": "b@x"}}"#
        let status = try await client.accountsResignStatus(flowId: "f1")
        XCTAssertEqual(lastPath, "/rpc/accounts:resign-status")
        assertSingleObject()
        XCTAssertEqual(lastObject?["flowId"] as? String, "f1")
        XCTAssertEqual(status.error, "different-account")

        AccountsCapturingURLProtocol.result = #"{"result": {"ok": true}}"#
        try await client.accountsResignCancel(flowId: "f1")
        XCTAssertEqual(lastPath, "/rpc/accounts:resign-cancel")
        assertSingleObject()
        XCTAssertEqual(lastObject?["flowId"] as? String, "f1")
    }

    func testResignRefusalCarriesTheCodeAndTheBoxsSentence() async {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": {"error": "live-seat", "message": "This is the login the box is using right now, so it can't be removed."}}"#
        do {
            _ = try await client.accountsResignSeat(provider: "claude", seatId: "s1")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? AccountsRefusal,
                           AccountsRefusal(code: "live-seat", message: "This is the login the box is using right now, so it can't be removed."))
        }
        // An older box words no error: the static fallback, never the raw code.
        AccountsCapturingURLProtocol.result = #"{"result": {"error": "live-seat"}}"#
        do {
            _ = try await client.accountsResignSeat(provider: "claude", seatId: "s1")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? AccountsRefusal, AccountsRefusal(code: "live-seat", message: AccountsCopy.fallback))
        }
        // The rpc envelope's own error (a sentence) is still a plain server error.
        AccountsCapturingURLProtocol.result = #"{"error": "This sign-in has expired. Close it and start again."}"#
        do {
            _ = try await client.accountsResignSeat(provider: "claude", seatId: "s1")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? MantaError, .server("This sign-in has expired. Close it and start again."))
        }
    }

    // MARK: - Health, retry, probe

    func testHealthSendsNoArgsAndRetryProbeSendOneObject() async throws {
        let client = makeClient()

        AccountsCapturingURLProtocol.result = #"{"result": {"providers": {"anthropic": {"state": "failing"}}, "endpoints": {}}}"#
        let health = try await client.accountsHealth()
        XCTAssertEqual(lastPath, "/rpc/accounts:health")
        XCTAssertEqual(lastArgs?.count, 0, "health takes no arguments")
        XCTAssertEqual(health.providers["anthropic"]?.state, "failing")

        AccountsCapturingURLProtocol.result = #"{"result": {"ok": true, "state": "ok", "message": "back"}}"#
        let retry = try await client.accountsRetry(providerID: "anthropic")
        XCTAssertEqual(lastPath, "/rpc/accounts:retry")
        assertSingleObject()
        XCTAssertEqual(lastObject?["providerID"] as? String, "anthropic")
        XCTAssertEqual(retry.message, "back")

        AccountsCapturingURLProtocol.result = #"{"result": {"ok": false, "outcome": "failure", "message": "did not respond"}}"#
        let probe = try await client.accountsEndpointProbe(endpointKey: "voska/m1")
        XCTAssertEqual(lastPath, "/rpc/accounts:endpoint-probe")
        assertSingleObject()
        XCTAssertEqual(lastObject?["endpointKey"] as? String, "voska/m1")
        XCTAssertFalse(probe.ok)
    }

    // MARK: - opencode:provider-auth

    func testProviderAuthActionsSendOneObjectEach() async throws {
        let client = makeClient()

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "status", "providers": [{"id": "openai", "label": "Codex", "connected": false}]}}"#
        let statuses = try await client.providerAuthStatus()
        XCTAssertEqual(lastPath, "/rpc/opencode:provider-auth")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "status")
        XCTAssertEqual(statuses.map(\.id), ["openai"])

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "start", "shape": "oauth-auto", "url": "https://x", "instructions": "code: AB-12", "methodIndex": 1}}"#
        let start = try await client.providerAuthStart(id: "openai")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "start")
        XCTAssertEqual(lastObject?["id"] as? String, "openai")
        XCTAssertEqual(start.shape, .oauthAuto)

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "code", "ok": false, "error": "unauthorized"}}"#
        let code = try await client.providerAuthCode(id: "openai", methodIndex: 2, code: "abc")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "code")
        XCTAssertEqual(lastObject?["methodIndex"] as? Int, 2)
        XCTAssertEqual(lastObject?["code"] as? String, "abc")
        XCTAssertEqual(code.error, "unauthorized")

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "key", "ok": true}}"#
        let key = try await client.providerAuthKey(id: "kimi-for-coding", key: "sk-secret")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "key")
        XCTAssertEqual(lastObject?["id"] as? String, "kimi-for-coding")
        XCTAssertEqual(lastObject?["key"] as? String, "sk-secret")
        XCTAssertTrue(key.ok)

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "disconnect", "ok": true}}"#
        let gone = try await client.providerAuthDisconnect(id: "openai")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "disconnect")
        XCTAssertEqual(lastObject?["id"] as? String, "openai")
        XCTAssertTrue(gone.ok)

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "claude-status", "ok": true, "progress": {"state": "no-file"}}}"#
        let claude = try await client.providerAuthClaudeStatus(sessionKey: "claude-login-1", startedAt: 1_750_000_000_000)
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "claude-status")
        XCTAssertEqual(lastObject?["sessionKey"] as? String, "claude-login-1")
        XCTAssertEqual(lastObject?["startedAt"] as? Double, 1_750_000_000_000)
        XCTAssertEqual(claude.progress, .noFile)

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "oauth-status", "state": "pending"}}"#
        let oauth = try await client.providerAuthOauthStatus(id: "openai")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "oauth-status")
        XCTAssertEqual(oauth.state, .pending)

        AccountsCapturingURLProtocol.result = #"{"result": {"action": "oauth-cancel", "ok": true}}"#
        try await client.providerAuthOauthCancel(id: "openai")
        assertSingleObject()
        XCTAssertEqual(lastObject?["action"] as? String, "oauth-cancel")
        XCTAssertEqual(lastObject?["id"] as? String, "openai")
    }

    func testClaudeCliStatusAndLoginCancel() async throws {
        let client = makeClient()

        AccountsCapturingURLProtocol.result = #"{"result": {"installed": false, "path": null}}"#
        let cli = try await client.providerClaudeCliStatus()
        XCTAssertEqual(lastPath, "/rpc/opencode:claude-cli-status")
        XCTAssertEqual(lastArgs?.count, 0)
        XCTAssertFalse(cli.installed)

        // claude:login-cancel takes the session key POSITIONALLY.
        AccountsCapturingURLProtocol.result = #"{"result": {"ok": true}}"#
        try await client.providerClaudeLoginCancel(sessionKey: "claude-login-1")
        XCTAssertEqual(lastPath, "/rpc/claude:login-cancel")
        XCTAssertEqual(lastArgs?.count, 1)
        XCTAssertEqual(lastArgs?.first as? String, "claude-login-1", "a string, not an object")
    }

    // MARK: - pty

    func testPtySpawnSendsOneOptionsObjectWithTheLauncher() async throws {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": null}"#
        try await client.signInPtySpawn(sessionKey: "claude-login-1", cwd: "/home/dev", cols: 500, rows: 50, launcherId: "claude-auth-login")
        XCTAssertEqual(lastPath, "/rpc/pty:spawn")
        assertSingleObject()
        XCTAssertEqual(lastObject?["sessionKey"] as? String, "claude-login-1")
        XCTAssertEqual(lastObject?["cwd"] as? String, "/home/dev")
        XCTAssertEqual(lastObject?["cols"] as? Int, 500)
        XCTAssertEqual(lastObject?["rows"] as? Int, 50)
        let launcher = lastObject?["launcher"] as? [String: Any]
        XCTAssertEqual(launcher?["id"] as? String, "claude-auth-login")
        XCTAssertEqual((launcher?["flags"] as? [String: Any])?.count, 0, "flags is an empty object")
        XCTAssertNil(lastObject?["extraEnv"], "the box owns the environment; the client never sends one")
    }

    func testPtyWriteAndKillArePositional() async throws {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": null}"#

        try await client.signInPtyWrite(sessionKey: "claude-login-1", data: "the-code\r")
        XCTAssertEqual(lastPath, "/rpc/pty:write")
        XCTAssertEqual(lastArgs?.count, 2)
        XCTAssertEqual(lastArgs?[0] as? String, "claude-login-1")
        XCTAssertEqual(lastArgs?[1] as? String, "the-code\r")

        try await client.signInPtyKill(sessionKey: "claude-install-9")
        XCTAssertEqual(lastPath, "/rpc/pty:kill")
        XCTAssertEqual(lastArgs?.count, 1)
        XCTAssertEqual(lastArgs?.first as? String, "claude-install-9")
    }

    func testPtySpawnRefusalThrows() async {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"error": "This sign-in has expired. Close it and start again."}"#
        do {
            try await client.signInPtySpawn(sessionKey: "k", cwd: "~", cols: 500, rows: 50, launcherId: "claude-auth-login")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? MantaError, .server("This sign-in has expired. Close it and start again."))
        }
    }

    // MARK: - Custom endpoints

    func testDiscoverModelsSendsTwoPositionalStrings() async throws {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": {"ok": true, "models": [{"id": "m1"}]}}"#
        let result = try await client.providerDiscoverModels(baseURL: "https://api.example.com/v1", apiKey: "sk-1")
        XCTAssertEqual(lastPath, "/rpc/opencode:discover-models")
        XCTAssertEqual(lastArgs?.count, 2, "two positional arguments, NOT one object")
        XCTAssertEqual(lastArgs?[0] as? String, "https://api.example.com/v1")
        XCTAssertEqual(lastArgs?[1] as? String, "sk-1")
        XCTAssertEqual(result.models, ["m1"])

        // Refresh sends an empty key so the box uses the stored one.
        _ = try await client.providerDiscoverModels(baseURL: "https://api.example.com/v1", apiKey: "")
        XCTAssertEqual(lastArgs?[1] as? String, "")
    }

    func testSetProvidersSendsOneObjectAndOmitsTheKeyWhenNil() async throws {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": {"ok": true}}"#

        let input = ProviderEndpointInput(id: "voska", name: "VoskaAI", baseURL: "https://x/v1", apiKey: nil, enabledModels: ["a", "b"])
        let reply = try await client.providerSetEndpoints(upsert: [input], remove: [])
        XCTAssertEqual(lastPath, "/rpc/opencode:set-providers")
        assertSingleObject()
        XCTAssertTrue(reply.ok)
        let upsert = lastObject?["upsert"] as? [[String: Any]]
        XCTAssertEqual(upsert?.count, 1)
        XCTAssertEqual(upsert?.first?["id"] as? String, "voska")
        XCTAssertEqual(upsert?.first?["enabledModels"] as? [String], ["a", "b"])
        XCTAssertNil(upsert?.first?["apiKey"], "the key is omitted entirely so the box keeps the stored one")
        XCTAssertNil(lastObject?["remove"], "an empty remove list is omitted")

        let withKey = ProviderEndpointInput(id: "voska", name: "VoskaAI", baseURL: "https://x/v1", apiKey: "sk-1", enabledModels: [])
        _ = try await client.providerSetEndpoints(upsert: [withKey], remove: [])
        XCTAssertEqual((lastObject?["upsert"] as? [[String: Any]])?.first?["apiKey"] as? String, "sk-1")

        _ = try await client.providerSetEndpoints(upsert: [], remove: ["voska"])
        assertSingleObject()
        XCTAssertEqual(lastObject?["remove"] as? [String], ["voska"])
        XCTAssertNil(lastObject?["upsert"], "an empty upsert list is omitted")
    }

    func testGetProvidersSendsNoArgs() async throws {
        let client = makeClient()
        AccountsCapturingURLProtocol.result = #"{"result": [{"id": "voska", "name": "VoskaAI", "baseURL": "https://x/v1", "hasApiKey": true, "enabledModels": ["a"]}]}"#
        let list = try await client.providerEndpoints()
        XCTAssertEqual(lastPath, "/rpc/opencode:get-providers")
        XCTAssertEqual(lastArgs?.count, 0)
        XCTAssertEqual(list.map(\.id), ["voska"])
    }

    // MARK: - AccountsStore.freshProviders

    @MainActor
    func testFreshProvidersThrowsOnTransportErrorWithoutChangingTheList() async {
        let client = makeClient()
        let store = AccountsStore(api: client)

        AccountsCapturingURLProtocol.result = #"{"result": {"providers": [{"provider": "claude", "accounts": [{"id": "a", "label": "Work", "seats": [{"id": "s1", "label": "Seat 1"}]}]}]}}"#
        await store.refresh()
        XCTAssertEqual(store.providers.map(\.provider), ["claude"])

        AccountsCapturingURLProtocol.failure = URLError(.notConnectedToInternet)
        do {
            _ = try await store.freshProviders()
            XCTFail("expected a throw")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        XCTAssertEqual(store.providers.map(\.provider), ["claude"], "a failed read leaves the store's data untouched")
    }

    @MainActor
    func testASuccessfulFreshReadClearsAStaleRefreshWarning() async throws {
        let client = makeClient()
        let store = AccountsStore(api: client)
        AccountsCapturingURLProtocol.result = #"{"result": {"providers": [{"provider": "claude", "accounts": [{"id": "a", "label": "Work", "seats": [{"id": "s1"}]}]}]}}"#
        await store.refresh()
        AccountsCapturingURLProtocol.failure = URLError(.notConnectedToInternet)
        await store.refresh()
        XCTAssertNotNil(store.refreshError, "the failed refresh is surfaced")
        AccountsCapturingURLProtocol.failure = nil
        _ = try await store.freshProviders()
        XCTAssertNil(store.refreshError, "a good read clears the warning")
    }

    @MainActor
    func testFreshProvidersIssuesItsOwnRequestEvenWhileARefreshIsInFlight() async throws {
        let client = makeClient()
        let store = AccountsStore(api: client)
        AccountsCapturingURLProtocol.result = #"{"result": {"providers": [{"provider": "codex", "accounts": [{"id": "a", "label": "Home", "seats": [{"id": "s1"}]}]}]}}"#

        let refresh = Task { await store.refresh() }
        let fresh = try await store.freshProviders()
        await refresh.value

        let listRequests = AccountsCapturingURLProtocol.cache.filter { $0.url?.path == "/rpc/accounts:list" }
        XCTAssertGreaterThanOrEqual(listRequests.count, 2, "freshProviders is not coalesced into refresh()")
        XCTAssertEqual(fresh.map(\.provider), ["codex"])
        XCTAssertEqual(store.providers.map(\.provider), ["codex"])
        XCTAssertEqual(store.phase, .loaded)
    }
}

// MARK: - Capturing URLProtocol

private final class AccountsCapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var cache: [URLRequest] = []
    nonisolated(unsafe) static var result: String = #"{"result": null}"#
    nonisolated(unsafe) static var failure: Error?

    static func reset() {
        cache = []
        result = #"{"result": null}"#
        failure = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.cache.append(request)
        if let failure = Self.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
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
}
