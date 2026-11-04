import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MantaUI

// ===========================================================================
// WS08 — the sign-in / connect / endpoint CONTROLLERS, driven end to end against
// a scripted box (every /rpc call is answered by a stub and recorded in order).
//
// What these pin down is behaviour the pure tests cannot: that a failed or
// cancelled attempt releases exactly what it allocated, in order; that a late
// reply for a retired attempt is torn down instead of shown; that a wrong
// Claude code fails at once; that the provider-wide device-wait cancel can never
// hit a newer attempt; and that an endpoint write whose outcome is unknown says
// so instead of claiming a rollback.
//
// Mac only (needs `MantaAPIClient`, which is not part of the Linux package).
// ===========================================================================

// MARK: - The scripted box

private final class FlowStub: URLProtocol, @unchecked Sendable {
    enum Reply {
        /// HTTP 200 `{"result": <json>}`.
        case result(String)
        /// The request itself fails.
        case failure(URLError.Code)
        /// `.result`, after a delay.
        case delayed(TimeInterval, String)
    }

    struct Call {
        var channel: String
        var args: [Any]
        var first: [String: Any]? { args.first as? [String: Any] }
        var action: String? { first?["action"] as? String }
    }

    nonisolated(unsafe) private static var recorded: [Call] = []
    nonisolated(unsafe) static var handler: (String, [Any]) -> Reply = { _, _ in .result("null") }
    private static let lock = NSRecursiveLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        recorded = []
        handler = { _, _ in .result("null") }
    }

    static var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    static func calls(_ channel: String) -> [Call] { calls.filter { $0.channel == channel } }

    /// The `action` of every `opencode:provider-auth` call, in order.
    static var providerAuthActions: [String] {
        calls("opencode:provider-auth").compactMap(\.action)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let channel = request.url?.lastPathComponent ?? ""
        let args = (Self.bodyJSON(of: request)?["args"] as? [Any]) ?? []
        Self.lock.lock()
        Self.recorded.append(Call(channel: channel, args: args))
        let reply = Self.handler(channel, args)
        Self.lock.unlock()
        switch reply {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .result(let json):
            respond(json)
        case .delayed(let seconds, let json):
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [self] in respond(json) }
        }
    }

    override func stopLoading() {}

    private func respond(_ json: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"result":\#(json)}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

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

/// A stream that never connects but can inject bus frames.
@MainActor
private final class FlowTestStream: MantaEventStreamControl {
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

@MainActor
private final class Harness {
    let api: MantaAPIClient
    let stream = FlowTestStream()
    let store: AccountsStore
    let defaults: UserDefaults
    var providersChangedPosts = 0

    init(withEventStream: Bool = true) {
        FlowStub.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FlowStub.self]
        api = MantaAPIClient(serverURL: URL(string: "https://box.example")!, tokenProvider: { "tok" }, session: URLSession(configuration: config))
        let suite = "AccountsFlowTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite) ?? .standard
        let events: MantaEventStore? = withEventStream ? MantaEventStore(stream: stream) : nil
        store = AccountsStore(api: api, eventStore: events)
        // A harness lives for one test; its observer holds it weakly and goes inert
        // when it is released.
        _ = NotificationCenter.default.addObserver(forName: .mantaProvidersChanged, object: nil, queue: nil) { [weak self] _ in
            Task { @MainActor in self?.providersChangedPosts += 1 }
        }
    }

    func ptyFrame(key: String, kind: String, data: String? = nil, code: Int? = nil) -> String {
        var payload: [String: Any] = ["kind": kind, "sessionKey": key]
        if let data { payload["data"] = data }
        if let code { payload["code"] = code }
        let body = (try? JSONSerialization.data(withJSONObject: ["kind": "pty", "payload": payload])) ?? Data()
        return String(decoding: body, as: UTF8.self)
    }
}

@MainActor
private final class ResultBox {
    var value: String?
}

@MainActor
private func waitFor(_ timeout: TimeInterval = 10, _ condition: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(25))
    }
    return condition()
}

private let homeList = #"{"providers":[{"provider":"codex","mode":"manual","accounts":[{"id":"acct-1","label":"Home","seats":[{"id":"seat-9","label":"Seat 1","email":"x@y.com","status":"ok"}]}]}]}"#
private let deviceConnect = #"{"shape":"oauth-auto","url":"https://auth.openai.com/codex/device","instructions":"Enter code: ABCD-1234"}"#
private let claudeConnect = #"{"shape":"claude-login","sessionKey":"claude-login-1","startedAt":1750000000000,"cwd":"/home/dev"}"#

// MARK: - Add a seat

final class AccountsFlowTests: XCTestCase {

    @MainActor
    func testAddingACodexAccountShowsTheCodeThenFinishesAndAnnounces() async throws {
        let h = Harness()
        var statusReads = 0
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:add-seat": return .result(#"{"seatId":"seat-9","connect":\#(deviceConnect)}"#)
            case "accounts:seat-status":
                statusReads += 1
                return statusReads == 1
                    ? .result(#"{"state":"pending"}"#)
                    : .result(#"{"state":"ok","seat":{"id":"seat-9","label":"Seat 1","email":"x@y.com","status":"ok"}}"#)
            case "accounts:list": return .result(homeList)
            default: return .result("null")
            }
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()

        let showedCode = await waitFor { if case .device = flow.phase { return true } else { return false } }
        XCTAssertTrue(showedCode, "the device code is shown")
        if case .device(let url, let instructions, _) = flow.phase {
            XCTAssertEqual(url, "https://auth.openai.com/codex/device")
            XCTAssertEqual(DeviceCode.parse(instructions), "ABCD-1234")
        }
        XCTAssertTrue(flow.isOpen, "a stray swipe must not drop an open sign-in")

        let finished = await waitFor(12) { flow.shouldDismiss }
        XCTAssertTrue(finished)
        let expected = "Added the account “Home” — x@y.com is signed in."
        XCTAssertEqual(flow.phase, .done(expected))
        XCTAssertEqual(h.store.feedback?.text, expected, "the banner says what was added")
        XCTAssertEqual(h.store.feedback?.isError, false)
        XCTAssertEqual(h.store.providers.first?.accounts.first?.label, "Home", "the new seat is on screen before the sheet closes")
        _ = await waitFor(2) { h.providersChangedPosts >= 1 }
        XCTAssertEqual(h.providersChangedPosts, 1, "the model picker is told once")
        XCTAssertTrue(
            FlowStub.calls("accounts:cancel-seat").filter { $0.first?["seatId"] as? String == "seat-9" }.isEmpty,
            "a finished sign-in releases nothing"
        )
        XCTAssertFalse(flow.isOpen)
    }

    @MainActor
    func testCancelTellsTheBoxAndReportsIt() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:add-seat" ? .result(#"{"seatId":"seat-9","connect":\#(deviceConnect)}"#) : .result(#"{"state":"pending"}"#)
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()
        _ = await waitFor { if case .device = flow.phase { return true } else { return false } }

        await flow.cancel()

        XCTAssertTrue(flow.shouldDismiss)
        let cancels = FlowStub.calls("accounts:cancel-seat")
        XCTAssertEqual(cancels.count, 1)
        XCTAssertEqual(cancels.first?.first?["seatId"] as? String, "seat-9")
        XCTAssertEqual(h.store.feedback?.text, "Sign-in cancelled.")
        XCTAssertEqual(h.store.feedback?.isError, false)
    }

    @MainActor
    func testCancelThatCannotReachTheBoxSaysSo() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:add-seat": return .result(#"{"seatId":"seat-9","connect":\#(deviceConnect)}"#)
            case "accounts:cancel-seat": return .failure(.notConnectedToInternet)
            default: return .result(#"{"state":"pending"}"#)
            }
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()
        _ = await waitFor { if case .device = flow.phase { return true } else { return false } }

        await flow.cancel()

        XCTAssertEqual(h.store.feedback?.text, "Couldn't cancel the sign-in on the server — it will expire by itself.")
        XCTAssertEqual(h.store.feedback?.isError, true)
        XCTAssertTrue(flow.shouldDismiss, "the sheet still closes")
    }

    @MainActor
    func testALateStartReplyForACancelledAttemptIsTornDownNotShown() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:add-seat" ? .delayed(0.4, #"{"seatId":"seat-late","connect":\#(deviceConnect)}"#) : .result("null")
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()
        _ = await waitFor { !FlowStub.calls("accounts:add-seat").isEmpty }

        await flow.cancel()   // the start is still in flight

        let released = await waitFor(5) { !FlowStub.calls("accounts:cancel-seat").isEmpty }
        XCTAssertTrue(released, "the seat the late reply allocated is given back")
        XCTAssertEqual(FlowStub.calls("accounts:cancel-seat").first?.first?["seatId"] as? String, "seat-late")
        if case .device = flow.phase { XCTFail("a cancelled attempt must never show its late reply") }
        XCTAssertTrue(FlowStub.calls("accounts:seat-status").isEmpty, "and is never polled")
    }

    @MainActor
    func testARetryReleasesTheOldAttemptBeforeAllocatingANewOne() async {
        let h = Harness()
        var adds = 0
        FlowStub.handler = { channel, _ in
            guard channel == "accounts:add-seat" else { return .result(#"{"state":"pending"}"#) }
            adds += 1
            return adds == 1
                ? .result(#"{"seatId":"seat-1","connect":{"shape":"oauth-code"}}"#)   // a shape this client cannot drive
                : .result(#"{"seatId":"seat-2","connect":\#(deviceConnect)}"#)
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()

        _ = await waitFor { if case .failed = flow.phase { return true } else { return false } }
        XCTAssertEqual(flow.phase, .failed(AccountsSignInCopy.cantStartFromHere))

        flow.retry()
        _ = await waitFor { if case .device = flow.phase { return true } else { return false } }

        let order = FlowStub.calls.map { call -> String in
            if call.channel == "accounts:cancel-seat" { return "cancel:\(call.first?["seatId"] as? String ?? "?")" }
            return call.channel == "accounts:add-seat" ? "add" : call.channel
        }
        let cancelOld = order.firstIndex(of: "cancel:seat-1")
        let secondAdd = order.indices.filter { order[$0] == "add" }.dropFirst().first
        XCTAssertNotNil(cancelOld, "the failed attempt's seat was released")
        XCTAssertNotNil(secondAdd)
        if let cancelOld, let secondAdd { XCTAssertLessThan(cancelOld, secondAdd, "released BEFORE the new seat is allocated") }
        await flow.cancel()   // awaited, so nothing is left running into the next test
    }

    @MainActor
    func testADifferentOrgLoginIsParkedUntilTheUserChooses() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:add-seat": return .result(#"{"seatId":"seat-9","connect":\#(deviceConnect)}"#)
            case "accounts:seat-status": return .result(#"{"state":"failed","error":"different-org","orgName":"Acme"}"#)
            case "accounts:add-seat-confirm": return .result(#"{"provider":"codex","accounts":[{"id":"acct-2","label":"Acme","seats":[{"id":"seat-9","label":"Seat 1"}]}]}"#)
            case "accounts:list": return .result(#"{"providers":[{"provider":"codex","accounts":[{"id":"acct-2","label":"Acme","seats":[{"id":"seat-9","label":"Seat 1","email":"a@acme.com"}]}]}]}"#)
            default: return .result("null")
            }
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: "acct-1", accountLabel: "Home")), accounts: h.store, defaults: h.defaults)
        flow.begin()

        let parked = await waitFor { if case .differentOrg = flow.phase { return true } else { return false } }
        XCTAssertTrue(parked)
        XCTAssertEqual(flow.phase, .differentOrg(orgName: "Acme", busy: false))
        XCTAssertTrue(FlowStub.calls("accounts:cancel-seat").isEmpty, "the box holds it; nothing is cancelled while the user decides")

        await flow.createNewAccount()

        XCTAssertEqual(FlowStub.calls("accounts:add-seat-confirm").first?.first?["newAccount"] as? Bool, true)
        XCTAssertEqual(flow.phase, .done("Added the account “Acme” — a@acme.com is signed in."))
        XCTAssertTrue(flow.shouldDismiss)
        XCTAssertTrue(FlowStub.calls("accounts:cancel-seat").isEmpty)
    }

    @MainActor
    func testCancelDuringARetrysCleanupStartsNothingOnTheBox() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:add-seat": return .result(#"{"seatId":"seat-1","connect":{"shape":"oauth-code"}}"#)   // cannot be driven
            case "accounts:cancel-seat": return .delayed(0.6, #"{"ok":true}"#)                                   // the release is slow
            default: return .result("null")
            }
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "codex", accountId: nil, accountLabel: nil)), accounts: h.store, defaults: h.defaults)
        flow.begin()
        _ = await waitFor { if case .failed = flow.phase { return true } else { return false } }

        flow.retry()
        await flow.cancel()   // pressed while the old attempt is still being released

        try? await Task.sleep(for: .milliseconds(1_000))
        XCTAssertTrue(flow.shouldDismiss)
        XCTAssertEqual(FlowStub.calls("accounts:add-seat").count, 1, "a closed flow allocates nothing new")
        XCTAssertEqual(FlowStub.calls("accounts:cancel-seat").count, 1, "and the first seat was still released")
    }

    // MARK: - Claude through the pty RPCs

    @MainActor
    func testClaudeSignInFindsTheLinkAcrossChunksAndAWrongCodeFailsAtOnce() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:add-seat" ? .result(#"{"seatId":"seat-1","connect":\#(claudeConnect)}"#) : .result(#"{"state":"pending"}"#)
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "claude", accountId: "acct-1", accountLabel: "Work")), accounts: h.store, defaults: h.defaults)
        flow.begin()

        let spawned = await waitFor { !FlowStub.calls("pty:spawn").isEmpty }
        XCTAssertTrue(spawned)
        let options = FlowStub.calls("pty:spawn").first?.first
        XCTAssertEqual(options?["sessionKey"] as? String, "claude-login-1")
        XCTAssertEqual(options?["cwd"] as? String, "/home/dev")
        XCTAssertEqual(options?["cols"] as? Int, 500, "wide enough that the link stays on one line")
        XCTAssertEqual((options?["launcher"] as? [String: Any])?["id"] as? String, "claude-auth-login")
        XCTAssertEqual(flow.phase, .claude)

        // The link arrives split across two chunks: never taken half-read.
        h.stream.inject(h.ptyFrame(key: "claude-login-1", kind: "data", data: "Open this link:\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc"))
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(flow.claudeSession?.url)
        // Another session's output is ignored.
        h.stream.inject(h.ptyFrame(key: "someone-else", kind: "data", data: "&state=nope\n"))
        h.stream.inject(h.ptyFrame(key: "claude-login-1", kind: "data", data: "&state=xyz\n"))
        let found = await waitFor { flow.claudeSession?.url != nil }
        XCTAssertTrue(found)
        XCTAssertEqual(flow.claudeSession?.url?.absoluteString, "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz")

        // The pasted code is written into the terminal, with a carriage return.
        await flow.claudeSession?.submit("  abc123 ")
        let write = FlowStub.calls("pty:write").first
        XCTAssertEqual(write?.args.first as? String, "claude-login-1")
        XCTAssertEqual(write?.args.dropFirst().first as? String, "abc123\r")

        // A wrong code makes the login exit with an error: fail now, not in 15 minutes.
        h.stream.inject(h.ptyFrame(key: "claude-login-1", kind: "exit", code: 1))
        let failed = await waitFor { if case .failed = flow.phase { return true } else { return false } }
        XCTAssertTrue(failed)
        XCTAssertEqual(flow.phase, .failed(AccountsSignInCopy.badCode))
        let released = await waitFor { !FlowStub.calls("accounts:cancel-seat").isEmpty }
        XCTAssertTrue(released, "the half-made seat is given back")
        XCTAssertEqual(FlowStub.calls("accounts:cancel-seat").first?.first?["seatId"] as? String, "seat-1")
    }

    @MainActor
    func testAClaudeSignInThatExitsCleanlyKeepsWaitingForTheBox() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:add-seat" ? .result(#"{"seatId":"seat-1","connect":\#(claudeConnect)}"#) : .result(#"{"state":"pending"}"#)
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "claude", accountId: "acct-1", accountLabel: "Work")), accounts: h.store, defaults: h.defaults)
        flow.begin()
        _ = await waitFor { !FlowStub.calls("pty:spawn").isEmpty }

        h.stream.inject(h.ptyFrame(key: "claude-login-1", kind: "exit", code: 0))
        try? await Task.sleep(for: .milliseconds(200))

        XCTAssertEqual(flow.phase, .claude, "exit 0 is a successful login; the box files the seat")
        XCTAssertTrue(FlowStub.calls("accounts:cancel-seat").isEmpty)
        await flow.cancel()
    }

    @MainActor
    func testClaudeWithoutAnEventStreamFailsInsteadOfSpinning() async {
        let h = Harness(withEventStream: false)
        FlowStub.handler = { channel, _ in
            channel == "accounts:add-seat" ? .result(#"{"seatId":"seat-1","connect":\#(claudeConnect)}"#) : .result("null")
        }
        let flow = AccountsSeatSignIn(request: AccountsSignInRequest(mode: .add(provider: "claude", accountId: "acct-1", accountLabel: "Work")), accounts: h.store, defaults: h.defaults)
        flow.begin()

        _ = await waitFor { if case .failed = flow.phase { return true } else { return false } }
        XCTAssertEqual(flow.phase, .failed(AccountsSignInCopy.noEventStream))
        XCTAssertTrue(FlowStub.calls("pty:spawn").isEmpty, "nothing is spawned that could not be watched")
        let released = await waitFor { !FlowStub.calls("accounts:cancel-seat").isEmpty }
        XCTAssertTrue(released)
    }

    @MainActor
    func testTheClaudeSessionReportsALinkThatNeverAppearsAndStopsListening() async {
        let h = Harness()
        var timedOut = 0
        var failedExits = 0
        let session = ClaudeLoginSession(
            sessionKey: "claude-login-9", cwd: "/home/dev", api: h.api, events: h.store.ptyEvents, linkTimeout: 0.2,
            onFailedExit: { failedExits += 1 },
            onLinkTimeout: { timedOut += 1 }
        )
        try? await session.start()
        let fired = await waitFor(3) { timedOut == 1 }
        XCTAssertTrue(fired, "no link within the limit: the owner is told, so it can tear the attempt down")
        XCTAssertNil(session.url)

        session.stop()
        h.stream.inject(h.ptyFrame(key: "claude-login-9", kind: "exit", code: 2))
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(failedExits, 0, "a stopped session ignores late frames")
        XCTAssertEqual(timedOut, 1, "and never fires twice")
    }

    // MARK: - Re-sign

    @MainActor
    func testResigningTheLiveSeatIsRefusedWithAnExplanation() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:resign-seat" ? .result(#"{"error":"live-seat"}"#) : .result("null")
        }
        let flow = AccountsSeatSignIn(
            request: AccountsSignInRequest(mode: .resign(provider: "claude", seatId: "s1", seatLabel: "Seat 1", accountLabel: "Work", email: "a@x")),
            accounts: h.store, defaults: h.defaults
        )
        flow.begin()
        _ = await waitFor { if case .failed = flow.phase { return true } else { return false } }
        XCTAssertEqual(flow.phase, .failed(AccountsSignInCopy.liveSeatRace))
        XCTAssertTrue(FlowStub.calls("accounts:resign-cancel").isEmpty, "nothing was allocated")
    }

    @MainActor
    func testResigningTheSameAccountConfirmsAndRefreshes() async {
        let h = Harness()
        var reads = 0
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:resign-seat": return .result(#"{"flowId":"f1","connect":\#(deviceConnect)}"#)
            case "accounts:resign-status":
                reads += 1
                return reads == 1 ? .result(#"{"state":"pending"}"#) : .result(#"{"state":"ok","seat":{"id":"s1","label":"Seat 1","email":"a@x"}}"#)
            case "accounts:list": return .result(#"{"providers":[{"provider":"codex","accounts":[{"id":"a","label":"Work","seats":[{"id":"s1","label":"Seat 1","email":"a@x","status":"ok"}]}]}]}"#)
            default: return .result("null")
            }
        }
        let flow = AccountsSeatSignIn(
            request: AccountsSignInRequest(mode: .resign(provider: "codex", seatId: "s1", seatLabel: "Seat 1", accountLabel: "Work", email: "a@x")),
            accounts: h.store, defaults: h.defaults
        )
        flow.begin()

        let closed = await waitFor(14) { flow.shouldDismiss }
        XCTAssertTrue(closed)
        XCTAssertEqual(flow.phase, .done("Signed back in as a@x"))
        XCTAssertEqual(h.store.feedback?.text, "Signed back in as a@x")
        XCTAssertFalse(FlowStub.calls("accounts:list").isEmpty, "the list refreshed while the confirmation was held")
        XCTAssertTrue(FlowStub.calls("accounts:resign-cancel").isEmpty, "a settled flow is not cancelled")
        XCTAssertEqual(h.providersChangedPosts, 1)
    }

    @MainActor
    func testResignCancelNamesThatTheSeatWasNotChanged() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "accounts:resign-seat" ? .result(#"{"flowId":"f1","connect":\#(deviceConnect)}"#) : .result(#"{"state":"pending"}"#)
        }
        let flow = AccountsSeatSignIn(
            request: AccountsSignInRequest(mode: .resign(provider: "codex", seatId: "s1", seatLabel: "Seat 1", accountLabel: nil, email: nil)),
            accounts: h.store, defaults: h.defaults
        )
        flow.begin()
        _ = await waitFor { if case .device = flow.phase { return true } else { return false } }
        await flow.cancel()
        XCTAssertEqual(FlowStub.calls("accounts:resign-cancel").first?.first?["flowId"] as? String, "f1")
        XCTAssertEqual(h.store.feedback?.text, "Sign-in cancelled — Seat 1 was not changed.")
    }

    @MainActor
    func testSwipingAwayDuringTheResignHoldStillDeliversTheBannerAndTheNotice() async {
        let h = Harness()
        var reads = 0
        FlowStub.handler = { channel, _ in
            switch channel {
            case "accounts:resign-seat": return .result(#"{"flowId":"f1","connect":\#(deviceConnect)}"#)
            case "accounts:resign-status":
                reads += 1
                return reads == 1 ? .result(#"{"state":"pending"}"#) : .result(#"{"state":"ok","seat":{"id":"s1","label":"Seat 1","email":"a@x"}}"#)
            case "accounts:list": return .result(#"{"providers":[]}"#)
            default: return .result("null")
            }
        }
        let flow = AccountsSeatSignIn(
            request: AccountsSignInRequest(mode: .resign(provider: "codex", seatId: "s1", seatLabel: "Seat 1", accountLabel: "Work", email: "a@x")),
            accounts: h.store, defaults: h.defaults
        )
        flow.begin()
        let held = await waitFor(8) { if case .done = flow.phase { return true } else { return false } }
        XCTAssertTrue(held)

        flow.abandonIfOpen()   // the sheet is swiped away during the 1.5 s hold
        _ = await waitFor(2) { h.providersChangedPosts >= 1 }

        XCTAssertEqual(h.store.feedback?.text, "Signed back in as a@x")
        XCTAssertEqual(h.providersChangedPosts, 1, "the picker is told even though the sheet is gone")
        try? await Task.sleep(for: .milliseconds(1_800))
        XCTAssertTrue(FlowStub.calls("accounts:resign-cancel").isEmpty, "a settled flow has nothing to release")
        XCTAssertTrue(FlowStub.calls("pty:kill").isEmpty)
        XCTAssertTrue(FlowStub.calls("claude:login-cancel").isEmpty)
    }

    // MARK: - Connect a subscription

    @MainActor
    private func connections(_ h: Harness, said: @escaping @MainActor (String, Bool) -> Void = { _, _ in }) -> ProviderConnectionsStore {
        ProviderConnectionsStore(api: h.api, announce: said)
    }

    @MainActor
    func testAFailedRowStatesReadKeepsTheLastGoodRowsAndSaysSo() async {
        let h = Harness()
        let rows = #"{"rows":{"openai":{"text":"Box words","tone":"ok","control":"disconnect","registerLine":null}}}"#
        var failing = false
        FlowStub.handler = { channel, _ in
            guard channel == "accounts:row-states" else { return .result("null") }
            return failing ? .failure(.timedOut) : .result(rows)
        }
        let conns = connections(h)
        await conns.readRowStates()
        XCTAssertEqual(conns.rowState(for: "openai")?.text, "Box words")
        XCTAssertFalse(conns.rowStatesReadFailed)

        failing = true
        await conns.readRowStates()

        XCTAssertTrue(conns.rowStatesReadFailed, "the screen says it could not load them")
        XCTAssertTrue(conns.rowStatesSupported, "a failed read is not an older box")
        XCTAssertEqual(conns.rowState(for: "openai")?.control, .disconnect, "the last good controls stay")

        failing = false
        await conns.readRowStates()
        XCTAssertFalse(conns.rowStatesReadFailed)
    }

    private let openai = SubscriptionStatus(id: "openai", label: "Codex", plan: "ChatGPT Plus / Pro", connected: false)
    private let kimi = SubscriptionStatus(id: "kimi-for-coding", label: "Kimi", console: "https://www.kimi.com/code/console", connected: false)

    @MainActor
    func testAKeyThatTheBoxRejectsKeepsTheFormAndClearsTheSecret() async {
        let h = Harness()
        FlowStub.handler = { channel, args in
            guard channel == "opencode:provider-auth" else { return .result("null") }
            switch (args.first as? [String: Any])?["action"] as? String {
            case "start": return .result(#"{"action":"start","shape":"api-key"}"#)
            case "key": return .result(#"{"action":"key","ok":false,"error":"unauthorized"}"#)
            default: return .result("null")
            }
        }
        let flow = ProviderConnectFlow(status: kimi, accounts: h.store, connections: connections(h), lease: ProviderOAuthLease())
        flow.begin()
        _ = await waitFor { if case .needsKey = flow.phase { return true } else { return false } }
        XCTAssertEqual(flow.phase, .needsKey(consoleURL: "https://www.kimi.com/code/console", error: nil))

        flow.keyDraft = "sk-secret"
        await flow.submitKey()

        XCTAssertEqual(flow.keyDraft, "", "the key is cleared as it is sent")
        XCTAssertEqual(flow.phase, .needsKey(consoleURL: "https://www.kimi.com/code/console", error: "That key didn't work. Try again."))
        XCTAssertEqual(FlowStub.calls("opencode:provider-auth").last?.first?["key"] as? String, "sk-secret")
        XCTAssertTrue(FlowStub.calls("opencode:restart").isEmpty, "a refused key restarts nothing")
        await flow.cancel()
    }

    @MainActor
    func testAKeyThatSavesRestartsThenWaitsForTheProviderToComeOnline() async {
        let h = Harness()
        var statusReads = 0
        FlowStub.handler = { channel, args in
            switch channel {
            case "opencode:provider-auth":
                switch (args.first as? [String: Any])?["action"] as? String {
                case "start": return .result(#"{"action":"start","shape":"api-key"}"#)
                case "key": return .result(#"{"action":"key","ok":true}"#)
                case "status":
                    statusReads += 1
                    return .result(#"{"action":"status","providers":[{"id":"kimi-for-coding","label":"Kimi","connected":\#(statusReads >= 1 ? "true" : "false")}]}"#)
                default: return .result("null")
                }
            case "opencode:restart": return .result(#"{"ok":true}"#)
            case "accounts:list": return .result(#"{"providers":[]}"#)
            case "opencode:get-providers": return .result("[]")
            case "accounts:health": return .result(#"{"providers":{},"endpoints":{}}"#)
            default: return .result("null")
            }
        }
        let flow = ProviderConnectFlow(status: kimi, accounts: h.store, connections: connections(h), lease: ProviderOAuthLease())
        flow.begin()
        _ = await waitFor { if case .needsKey = flow.phase { return true } else { return false } }
        flow.keyDraft = "sk-good"
        await flow.submitKey()
        XCTAssertEqual(flow.phase, .applying(restarted: false))

        let done = await waitFor(10) { flow.shouldDismiss }
        XCTAssertTrue(done)
        XCTAssertEqual(flow.phase, .done)
        XCTAssertEqual(FlowStub.calls("opencode:restart").count, 1, "the box did not restart on its own, so the client does")
        XCTAssertEqual(h.store.feedback?.text, "Kimi connected.")
        XCTAssertEqual(flow.keyDraft, "")
        _ = await waitFor(2) { h.providersChangedPosts >= 1 }
        XCTAssertEqual(h.providersChangedPosts, 1)
    }

    @MainActor
    func testACancelledDeviceStartCanNeverCancelTheNewerAttempt() async {
        // Start A in flight → Cancel → Connect again (B). A's late reply must be
        // cancelled BEFORE B starts, and B's wait must never be cancelled.
        let h = Harness()
        var starts = 0
        FlowStub.handler = { channel, args in
            guard channel == "opencode:provider-auth" else { return .result("null") }
            switch (args.first as? [String: Any])?["action"] as? String {
            case "start":
                starts += 1
                let reply = #"{"action":"start","shape":"oauth-auto","url":"https://auth.openai.com/codex/device","instructions":"Enter code: ABCD-1234","methodIndex":0}"#
                return starts == 1 ? .delayed(0.5, reply) : .result(reply)
            case "oauth-cancel": return .result(#"{"action":"oauth-cancel","ok":true}"#)
            case "oauth-status": return .result(#"{"action":"oauth-status","state":"pending"}"#)
            default: return .result("null")
            }
        }
        let lease = ProviderOAuthLease()
        let conns = connections(h)
        let flowA = ProviderConnectFlow(status: openai, accounts: h.store, connections: conns, lease: lease)
        let flowB = ProviderConnectFlow(status: openai, accounts: h.store, connections: conns, lease: lease)

        flowA.begin()
        _ = await waitFor { FlowStub.providerAuthActions.contains("start") }
        let cancelA = Task { await flowA.cancel() }
        try? await Task.sleep(for: .milliseconds(50))
        flowB.begin()

        let waiting = await waitFor { if case .waiting = flowB.phase { return true } else { return false } }
        XCTAssertTrue(waiting, "B reaches its device code")
        await cancelA.value
        try? await Task.sleep(for: .milliseconds(400))

        XCTAssertEqual(
            FlowStub.providerAuthActions.filter { $0 != "oauth-status" },
            ["start", "oauth-cancel", "start"],
            "A's late reply is cancelled, then B starts — and nothing cancels B"
        )
        XCTAssertEqual(flowA.shouldDismiss, true)

        // B's own cancel is the only one that may follow.
        await flowB.cancel()
        XCTAssertEqual(FlowStub.providerAuthActions.filter { $0 == "oauth-cancel" }.count, 2)
    }

    @MainActor
    func testConnectCancelDuringARetrysCleanupStartsNothingAndLeavesTheLeaseFree() async {
        let h = Harness(withEventStream: false)   // Claude cannot show its link: the first attempt fails
        FlowStub.handler = { channel, args in
            switch channel {
            case "opencode:provider-auth":
                return (args.first as? [String: Any])?["action"] as? String == "start"
                    ? .result(#"{"action":"start","shape":"claude-login","sessionKey":"claude-login-1","startedAt":1750000000000,"cwd":"/home/dev"}"#)
                    : .result("null")
            case "opencode:claude-cli-status": return .result(#"{"installed":true}"#)
            case "claude:login-cancel": return .delayed(0.6, #"{"ok":true}"#)   // the release is slow
            default: return .result("null")
            }
        }
        let lease = ProviderOAuthLease()
        let flow = ProviderConnectFlow(status: SubscriptionStatus(id: "anthropic", label: "Claude"), accounts: h.store, connections: connections(h), lease: lease)
        flow.begin()
        _ = await waitFor { if case .failed = flow.phase { return true } else { return false } }

        flow.retry()
        await flow.cancel()   // pressed while the old attempt is still being released

        try? await Task.sleep(for: .milliseconds(1_000))
        XCTAssertTrue(flow.shouldDismiss)
        XCTAssertEqual(FlowStub.providerAuthActions.filter { $0 == "start" }.count, 1, "a closed flow starts nothing")

        // The provider-wide slot is not held by an orphan: the next start runs at once.
        let box = ResultBox()
        let next = Task { @MainActor in
            box.value = try? await lease.start(provider: "anthropic", attempt: UUID()) { "ran" }
        }
        let ran = await waitFor(2) { box.value == "ran" }
        XCTAssertTrue(ran, "the lease is free")
        _ = await next.value
    }

    @MainActor
    func testDisconnectReportsTheReasonWhenTheBoxRefuses() async {
        let h = Harness()
        var said: [(String, Bool)] = []
        FlowStub.handler = { channel, args in
            if channel == "opencode:provider-auth", (args.first as? [String: Any])?["action"] as? String == "disconnect" {
                return .result(#"{"action":"disconnect","ok":false,"error":"restart failed"}"#)
            }
            return .result("null")
        }
        let conns = connections(h) { said.append(($0, $1)) }
        await conns.disconnect(SubscriptionStatus(id: "openai", label: "Codex", connected: true))
        XCTAssertEqual(said.count, 1)
        XCTAssertEqual(said.first?.0, "Couldn't disconnect Codex — restart failed")
        XCTAssertEqual(said.first?.1, true)
        XCTAssertNil(conns.busyProvider)
    }

    // MARK: - Custom endpoints

    private let voska = #"{"id":"voska","name":"Voska","baseURL":"https://api.voska.org/v1","hasApiKey":true,"enabledModels":["a","b"]}"#

    @MainActor
    func testSwitchingAModelOffWritesAtOnceWithoutTheKeyAndAdoptsTheBox() async {
        let h = Harness()
        var posts = 0
        var written = false
        FlowStub.handler = { [voska] channel, _ in
            switch channel {
            case "opencode:get-providers":
                return .result(written ? #"[{"id":"voska","name":"Voska","baseURL":"https://api.voska.org/v1","hasApiKey":true,"enabledModels":["b"]}]"# : "[\(voska)]")
            case "opencode:set-providers":
                written = true
                return .result(#"{"ok":true}"#)
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { _, _ in }, announceChange: { posts += 1 })
        await conns.loadEndpoints()
        guard let endpoint = conns.endpoints.first else { return XCTFail("no endpoint loaded") }

        await conns.toggle(endpoint, model: "a", on: false)

        let sent = FlowStub.calls("opencode:set-providers").first?.first
        let upsert = (sent?["upsert"] as? [[String: Any]])?.first
        XCTAssertEqual(upsert?["id"] as? String, "voska")
        XCTAssertEqual(upsert?["enabledModels"] as? [String], ["b"])
        XCTAssertNil(upsert?["apiKey"], "the stored key is kept, so none is sent")
        XCTAssertEqual(conns.endpoints.first?.enabledModels, ["b"])
        XCTAssertEqual(conns.endpointRows(conns.endpoints[0]), ["b", "a"], "the switched-off row stays, so it can be switched back on")
        XCTAssertEqual(posts, 1)
        XCTAssertTrue(conns.writing.isEmpty)
        XCTAssertTrue(conns.unconfirmed.isEmpty)
    }

    @MainActor
    func testARefusedWriteThatLeftAThirdStateSaysItWasSavedInPart() async {
        let h = Harness()
        var said: [(String, Bool)] = []
        var posts = 0
        FlowStub.handler = { [voska] channel, _ in
            switch channel {
            case "opencode:get-providers":
                return FlowStub.calls("opencode:set-providers").isEmpty
                    ? .result("[\(voska)]")
                    : .result(#"[{"id":"voska","name":"Voska","baseURL":"https://api.voska.org/v1","hasApiKey":true,"enabledModels":["a","c"]}]"#)
            case "opencode:set-providers": return .result(#"{"ok":false,"error":"boom"}"#)
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { said.append(($0, $1)) }, announceChange: { posts += 1 })
        await conns.loadEndpoints()
        await conns.toggle(conns.endpoints[0], model: "b", on: false)

        XCTAssertEqual(said.first?.0, "Saved Voska, but the model list couldn't be fully applied — boom.")
        XCTAssertEqual(said.first?.1, true)
        XCTAssertEqual(conns.endpoints.first?.enabledModels, ["a", "c"], "the screen adopts what the box actually has")
        XCTAssertEqual(posts, 1, "a partly applied write may have changed the model list")
    }

    @MainActor
    func testAnUnreadableBoxLeavesTheEndpointUnconfirmedAndNeverClaimsARollback() async {
        let h = Harness()
        var said: [(String, Bool)] = []
        var posts = 0
        var boxReadable = true
        FlowStub.handler = { [voska] channel, _ in
            switch channel {
            case "opencode:get-providers": return boxReadable ? .result("[\(voska)]") : .failure(.notConnectedToInternet)
            case "opencode:set-providers":
                boxReadable = false
                return .failure(.timedOut)
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { said.append(($0, $1)) }, announceChange: { posts += 1 })
        await conns.loadEndpoints()
        await conns.toggle(conns.endpoints[0], model: "a", on: false)

        XCTAssertTrue(conns.unconfirmed.contains("voska"))
        XCTAssertTrue(said.isEmpty, "no claim either way")
        XCTAssertEqual(posts, 0)

        // Switches are disabled while unconfirmed: another tap writes nothing.
        let writesBefore = FlowStub.calls("opencode:set-providers").count
        await conns.toggle(conns.endpoints[0], model: "b", on: false)
        XCTAssertEqual(FlowStub.calls("opencode:set-providers").count, writesBefore)

        // Refresh reads the box again; the block adopts it and re-enables.
        boxReadable = true
        await conns.refreshUnconfirmed(conns.endpoints[0])
        XCTAssertTrue(conns.unconfirmed.isEmpty)
    }

    @MainActor
    func testRemovingAnEndpointThatTheBoxAlreadyDroppedIsConfirmedAfterALostReply() async {
        let h = Harness()
        var said: [(String, Bool)] = []
        var posts = 0
        var removed = false
        FlowStub.handler = { [voska] channel, _ in
            switch channel {
            case "opencode:get-providers": return .result(removed ? "[]" : "[\(voska)]")
            case "opencode:set-providers":
                removed = true
                return .failure(.networkConnectionLost)   // the write landed; its reply did not
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { said.append(($0, $1)) }, announceChange: { posts += 1 })
        await conns.loadEndpoints()
        await conns.remove(conns.endpoints[0])

        XCTAssertEqual(said.first?.0, "Removed Voska.")
        XCTAssertEqual(said.first?.1, false)
        XCTAssertTrue(conns.endpoints.isEmpty)
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(FlowStub.calls("opencode:set-providers").first?.first?["remove"] as? [String], ["voska"])
    }

    // MARK: - The add form

    @MainActor
    func testTheFormRefusesToSaveACollisionIntroducedAfterTheTest() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            switch channel {
            case "opencode:discover-models": return .result(#"{"ok":true,"models":[{"id":"m1"},{"id":"m2"}]}"#)
            // The same name was added from another device after Test.
            case "opencode:get-providers":
                return FlowStub.calls("opencode:discover-models").isEmpty
                    ? .result("[]")
                    : .result(#"[{"id":"newbox","name":"NewBox","baseURL":"https://x/v1","enabledModels":["m1"]}]"#)
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { _, _ in })
        await conns.loadEndpoints()
        let form = ProviderEndpointFormModel(connections: conns, accounts: h.store)
        form.name = "NewBox"
        form.baseURL = "https://other.example/v1"
        await form.test()
        XCTAssertEqual(form.phase, .tested)
        XCTAssertEqual(form.checklist?.selectedCount, 2)
        let args = FlowStub.calls("opencode:discover-models").first?.args
        XCTAssertEqual(args?.count, 2, "two positional strings")
        XCTAssertEqual(args?.first as? String, "https://other.example/v1")

        await form.save()

        XCTAssertEqual(form.saveError, "An endpoint with the id “newbox” already exists — choose another name.")
        XCTAssertTrue(FlowStub.calls("opencode:set-providers").isEmpty, "nothing was written")
        XCTAssertFalse(form.shouldDismiss)
    }

    @MainActor
    func testTheFormSavesWithoutRestartingAndAnnounces() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            switch channel {
            case "opencode:discover-models": return .result(#"{"ok":true,"models":[{"id":"m1"},{"id":"m2"},{"id":"m3"}]}"#)
            case "opencode:get-providers": return .result("[]")
            case "opencode:set-providers": return .result(#"{"ok":true}"#)
            default: return .result(#"{"providers":{},"endpoints":{}}"#)
            }
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { _, _ in })
        await conns.loadEndpoints()
        let form = ProviderEndpointFormModel(connections: conns, accounts: h.store)
        form.name = "My Box"
        form.baseURL = "https://box.example/v1"
        form.apiKey = "sk-1"
        await form.test()
        form.setModel("m3", selected: false)

        await form.save()

        XCTAssertTrue(form.shouldDismiss)
        let sent = FlowStub.calls("opencode:set-providers").first?.first
        let upsert = (sent?["upsert"] as? [[String: Any]])?.first
        XCTAssertEqual(upsert?["id"] as? String, "my-box")
        XCTAssertEqual(upsert?["enabledModels"] as? [String], ["m1", "m2"])
        XCTAssertEqual(upsert?["apiKey"] as? String, "sk-1")
        XCTAssertTrue(FlowStub.calls("opencode:restart").isEmpty, "saving an endpoint never restarts opencode")
        XCTAssertEqual(h.store.feedback?.text, "Added My Box with 2 models.")
        _ = await waitFor(2) { h.providersChangedPosts >= 1 }
        XCTAssertEqual(h.providersChangedPosts, 1)
    }

    @MainActor
    func testEditingTheDraftAfterATestClearsTheResult() async {
        let h = Harness()
        FlowStub.handler = { channel, _ in
            channel == "opencode:discover-models" ? .result(#"{"ok":true,"models":[{"id":"m1"}]}"#) : .result("[]")
        }
        let conns = ProviderConnectionsStore(api: h.api, announce: { _, _ in })
        await conns.loadEndpoints()
        let form = ProviderEndpointFormModel(connections: conns, accounts: h.store)
        form.name = "Box"
        form.baseURL = "https://box.example/v1"
        await form.test()
        XCTAssertNotNil(form.checklist)

        form.baseURL = "https://other.example/v1"

        XCTAssertNil(form.checklist, "a stale test can never be saved")
        XCTAssertEqual(form.phase, .editing)
    }
}
