import XCTest
@testable import MantaUI

// ===========================================================================
// WS08 — connecting a subscription provider: wire types, the section plan, what
// each connection row says, the connect flow's transitions, the route decision,
// and the device-wait lease (ProviderConnectionModels.swift,
// ProviderOAuthLease.swift).
// ===========================================================================

final class ProviderConnectTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: - Wire types

    func testStartReplyDecodesEveryShape() throws {
        let claude = try decode(ProviderAuthStartReply.self, #"{"action":"start","shape":"claude-login","sessionKey":"claude-login-1","startedAt":1750000000000,"cwd":"/home/dev"}"#)
        XCTAssertEqual(claude.shape, .claudeLogin)
        XCTAssertEqual(claude.sessionKey, "claude-login-1")

        let device = try decode(ProviderAuthStartReply.self, #"{"action":"start","shape":"oauth-auto","url":"https://x","instructions":"code: AB-12","methodIndex":0}"#)
        XCTAssertEqual(device.shape, .oauthAuto)
        XCTAssertEqual(device.methodIndex, 0)

        let code = try decode(ProviderAuthStartReply.self, #"{"action":"start","shape":"oauth-code","url":"https://x","methodIndex":2}"#)
        XCTAssertEqual(code.shape, .oauthCode)
        XCTAssertEqual(code.methodIndex, 2)

        let key = try decode(ProviderAuthStartReply.self, #"{"action":"start","shape":"api-key"}"#)
        XCTAssertEqual(key.shape, .apiKey)
        XCTAssertNil(key.url)

        XCTAssertThrowsError(try decode(ProviderAuthStartReply.self, #"{"action":"start"}"#))
    }

    func testClaudeStatusReplyDecodes() throws {
        XCTAssertEqual(try decode(ClaudeStatusReply.self, #"{"action":"claude-status","ok":true,"progress":{"state":"no-file"}}"#),
                       ClaudeStatusReply(ok: true, progress: .noFile))
        XCTAssertEqual(try decode(ClaudeStatusReply.self, #"{"ok":true,"progress":{"state":"pre-existing"}}"#).progress, .preExisting)
        let completed = try decode(ClaudeStatusReply.self, #"{"ok":true,"progress":{"state":"completed","restart":{"ok":true},"connected":true,"restore":{"restored":false}}}"#)
        XCTAssertEqual(completed.progress, .completed)
        XCTAssertEqual(try decode(ClaudeStatusReply.self, #"{"ok":true,"progress":{"state":"brand-new"}}"#).progress, .other("brand-new"))
        let gone = try decode(ClaudeStatusReply.self, #"{"action":"claude-status","ok":false,"error":"unknown_session"}"#)
        XCTAssertFalse(gone.ok)
        XCTAssertEqual(gone.error, "unknown_session")
        XCTAssertNil(gone.progress)
    }

    func testOauthStatusKeyAndStatusReplies() throws {
        XCTAssertEqual(try decode(OauthStatusReply.self, #"{"action":"oauth-status","state":"ok"}"#).state, .ok)
        XCTAssertEqual(try decode(OauthStatusReply.self, #"{"state":"error","error":"expired"}"#), OauthStatusReply(state: .error, error: "expired"))
        XCTAssertEqual(try decode(OauthStatusReply.self, #"{"state":"strange"}"#).state, .pending)
        XCTAssertEqual(try decode(ProviderAuthOkReply.self, #"{"action":"key","ok":false,"error":"unauthorized"}"#), ProviderAuthOkReply(ok: false, error: "unauthorized"))
        XCTAssertEqual(try decode(ProviderAuthOkReply.self, #"{"action":"disconnect","ok":true}"#).ok, true)
        XCTAssertEqual(try decode(ClaudeCliStatus.self, #"{"installed":false,"path":null}"#), ClaudeCliStatus(installed: false, path: nil))
        XCTAssertEqual(try decode(ClaudeCliStatus.self, #"{"installed":true,"path":"/home/dev/.local/bin/claude"}"#).installed, true)

        let status = try decode(ProviderAuthStatusReply.self, #"""
        {"action":"status","providers":[
          {"id":"anthropic","label":"Claude","plan":"Claude Pro / Max","console":null,"docs":"https://claude.com/pricing","connected":true,"managedExternally":true,"managedBy":"the Claude CLI on this box"},
          {"id":"kimi-for-coding","label":"Kimi","console":"https://www.kimi.com/code/console","connected":false},
          {"nope":true}]}
        """#)
        XCTAssertEqual(status.providers.map(\.id), ["anthropic", "kimi-for-coding"], "a malformed row is skipped")
        XCTAssertTrue(status.providers[0].managedExternally)
        XCTAssertEqual(status.providers[0].managedBy, "the Claude CLI on this box")
        XCTAssertEqual(status.providers[1].console, "https://www.kimi.com/code/console")
        XCTAssertFalse(status.providers[1].managedExternally)
    }

    func testHealthDecodes() throws {
        let health = try decode(AccountsHealth.self, #"""
        {"providers":{"anthropic":{"state":"rate-limited","retryInMs":125000},"openai":{"state":"out-of-credit"}},
         "endpoints":{"voska/m1":{"state":"dead","stateLine":"Dead · HTTP 503"},
                      "voska/m2":{"state":"rate-limited","retryInMs":30000}},
         "providerLines":{"voska":{"key":"voska/m1","stateLine":"Dead · HTTP 503"},"bare":{"key":null,"stateLine":"Unproven"}}}
        """#)
        XCTAssertEqual(health.providers["anthropic"], ProviderHealthEntry(state: "rate-limited", retryInMs: 125_000))
        XCTAssertEqual(health.providers["openai"]?.state, "out-of-credit")
        // The wording is the box's (WS11 D4 / K3); an older box sends no line.
        XCTAssertEqual(health.endpoints["voska/m1"]?.stateLine, "Dead · HTTP 503")
        XCTAssertNil(health.endpoints["voska/m2"]?.stateLine)
        XCTAssertEqual(health.providerLines["voska"], ProviderHealthLine(key: "voska/m1", stateLine: "Dead · HTTP 503"))
        XCTAssertEqual(health.providerLines["bare"], ProviderHealthLine(key: nil, stateLine: "Unproven"))

        let empty = try decode(AccountsHealth.self, #"{"providers":{},"endpoints":{}}"#)
        XCTAssertEqual(empty, AccountsHealth())
        let junk = try decode(AccountsHealth.self, #"{"providers":{"a":{"state":5},"b":3},"endpoints":[],"providerLines":{"x":{"stateLine":""}}}"#)
        XCTAssertEqual(junk, AccountsHealth(), "unreadable entries are dropped, never invented")
    }

    func testRetryAndProbeReplies() throws {
        XCTAssertEqual(try decode(AccountsRetryReply.self, #"{"ok":true,"state":"ok","message":"claude is back in the pool"}"#).message, "claude is back in the pool")
        XCTAssertEqual(try decode(EndpointProbeReply.self, #"{"ok":false,"outcome":"failure","message":"voska/m1 did not respond (503)."}"#),
                       EndpointProbeReply(ok: false, outcome: "failure", message: "voska/m1 did not respond (503)."))
    }

    // MARK: - Connection row

    private func status(connected: Bool, external: Bool = false, by: String? = nil) -> SubscriptionStatus {
        SubscriptionStatus(id: "anthropic", label: "Claude", plan: "Claude Pro / Max", connected: connected, managedExternally: external, managedBy: by)
    }

    // The row's words and control are the box's (`accounts:row-states`; the precedence is pinned in
    // accountsRowState.test.mjs). The phone decodes them and shows what it is given.
    func testRowStatesDecodeAsGiven() throws {
        let reply = try decode(AccountRowStatesReply.self, #"""
        {"rows":{"anthropic":{"text":"Out of credit","tone":"danger","control":"retry","registerLine":null},
                 "openai":{"text":"Not connected","tone":"quiet","control":"connect","registerLine":null},
                 "acme":{"text":"No usage data","tone":"quiet","control":"none","registerLine":"Dead"}}}
        """#)
        XCTAssertEqual(reply.rows["anthropic"], AccountRowState(text: "Out of credit", tone: .danger, control: .tryAgain))
        XCTAssertEqual(reply.rows["openai"]?.control, .connect)
        XCTAssertEqual(reply.rows["acme"]?.registerLine, "Dead")
    }

    // With no row state from the box (an older box, or none read yet) the controls fall back to plain data, so
    // Connect / Disconnect / Try again never disappear.
    func testFallbackControlsComeFromPlainData() {
        typealias S = AccountRowState
        XCTAssertEqual(S.fallbackControl(connected: false, managedExternally: false, health: nil), .connect)
        XCTAssertEqual(S.fallbackControl(connected: true, managedExternally: false, health: "ok"), .disconnect)
        XCTAssertEqual(S.fallbackControl(connected: true, managedExternally: true, health: nil), .none)
        XCTAssertEqual(S.fallbackControl(connected: true, managedExternally: false, health: "out-of-credit"), .tryAgain)
    }

    func testAnUnreadableToneOrControlIsTheSafeOne() throws {
        let reply = try decode(AccountRowStatesReply.self, #"{"rows":{"x":{"text":"t","tone":"purple","control":"explode"}}}"#)
        XCTAssertEqual(reply.rows["x"], AccountRowState(text: "t", tone: .quiet, control: .none))
    }

    // MARK: - Section plan

    private func seatView(_ id: String, seats: Int = 1) -> AccountsProvider {
        AccountsProvider(provider: id, accounts: [AccountsAccount(
            id: "a", label: "Work", orgName: nil, plan: nil,
            seats: (0..<seats).map { AccountsSeat(id: "\(id)-\($0)", label: "Seat \($0)") }
        )])
    }

    private let statuses = [
        SubscriptionStatus(id: "anthropic", label: "Claude", connected: true),
        SubscriptionStatus(id: "openai", label: "Codex", connected: false),
        SubscriptionStatus(id: "kimi-for-coding", label: "Kimi", connected: false),
    ]

    func testSectionPlanFollowsTheBoxOrderAndAttachesSeats() {
        let plan = AccountsSectionPlan.build(statuses: statuses, seatProviders: [seatView("claude")], endpoints: [], focus: nil)
        XCTAssertEqual(plan.subscriptions.map(\.canonicalId), ["anthropic", "openai", "kimi-for-coding"])
        XCTAssertEqual(plan.subscriptions.map(\.title), ["Claude", "Codex", "Kimi"])
        XCTAssertEqual(plan.subscriptions[0].seats?.provider, "claude")
        XCTAssertNil(plan.subscriptions[1].seats)
        XCTAssertFalse(plan.isEmpty)
    }

    func testFocusAcceptsEveryAliasAndMovesTheSectionFirst() {
        for alias in ["kimi", "kimi-for-coding"] {
            let plan = AccountsSectionPlan.build(statuses: statuses, seatProviders: [], endpoints: [], focus: alias)
            XCTAssertEqual(plan.subscriptions.first?.canonicalId, "kimi-for-coding", alias)
        }
        for alias in ["codex", "openai"] {
            let plan = AccountsSectionPlan.build(statuses: statuses, seatProviders: [], endpoints: [], focus: alias)
            XCTAssertEqual(plan.subscriptions.first?.canonicalId, "openai", alias)
        }
        for alias in ["claude", "anthropic"] {
            let plan = AccountsSectionPlan.build(statuses: statuses, seatProviders: [], endpoints: [], focus: alias)
            XCTAssertEqual(plan.subscriptions.map(\.canonicalId), ["anthropic", "openai", "kimi-for-coding"], alias)
        }
        let unknown = AccountsSectionPlan.build(statuses: statuses, seatProviders: [], endpoints: [], focus: "nope")
        XCTAssertEqual(unknown.subscriptions.map(\.canonicalId), ["anthropic", "openai", "kimi-for-coding"])
        XCTAssertNil(AccountsSectionPlan.normalizeFocus(nil))
        XCTAssertNil(AccountsSectionPlan.normalizeFocus("  "))
        XCTAssertEqual(AccountsSectionPlan.normalizeFocus("claude"), "anthropic")
        XCTAssertEqual(AccountsSectionPlan.normalizeFocus("kimi"), "kimi-for-coding")
        XCTAssertEqual(AccountsSectionPlan.normalizeFocus("something"), "something")
    }

    func testASeatProviderWithNoStatusRowStillGetsASection() {
        let plan = AccountsSectionPlan.build(statuses: [], seatProviders: [seatView("claude", seats: 2)], endpoints: [], focus: nil)
        XCTAssertEqual(plan.subscriptions.count, 1)
        XCTAssertNil(plan.subscriptions[0].status, "an old box: no connection row")
        XCTAssertEqual(plan.subscriptions[0].canonicalId, "anthropic")
        XCTAssertEqual(plan.subscriptions[0].title, "Claude")
        XCTAssertEqual(plan.subscriptions[0].seats?.provider, "claude")
    }

    func testAnEmptyBoxPlanIsEmpty() {
        XCTAssertTrue(AccountsSectionPlan.build(statuses: [], seatProviders: [], endpoints: [], focus: nil).isEmpty)
    }

    func testAddEndpointStateFollowsTheInventory() {
        XCTAssertEqual(AccountsSectionPlan.addEndpointState(inventory: .idle), .loading)
        XCTAssertEqual(AccountsSectionPlan.addEndpointState(inventory: .loading), .loading)
        XCTAssertEqual(AccountsSectionPlan.addEndpointState(inventory: .failed("boom")), .retry(reason: "boom"))
        XCTAssertEqual(AccountsSectionPlan.addEndpointState(inventory: .loaded), .enabled)
    }

    // MARK: - Connect route

    private struct Boom: Error {}

    func testConnectRoute() {
        // Kimi has no seats concept: connect without any fetch.
        XCTAssertEqual(ConnectRoute.decide(statusId: "kimi-for-coding", seatProviderId: nil, fresh: nil), .connect)

        // A first-load failure blocks, even though the store still holds its initial empty list.
        XCTAssertEqual(
            ConnectRoute.decide(statusId: "anthropic", seatProviderId: "claude", fresh: .failure(MantaError.transport("x"))),
            .blocked("check the connection and try again")
        )

        // Stale empty store data, but the FRESH list has seats → add an account.
        XCTAssertEqual(
            ConnectRoute.decide(statusId: "anthropic", seatProviderId: "claude", fresh: .success([seatView("claude")])),
            .addAccount
        )
        // The provider gained seats since the store last read → add account.
        XCTAssertEqual(
            ConnectRoute.decide(statusId: "openai", seatProviderId: "codex", fresh: .success([seatView("codex", seats: 3), seatView("claude")])),
            .addAccount
        )
        // The fresh list has no entry for the provider → connect.
        XCTAssertEqual(
            ConnectRoute.decide(statusId: "openai", seatProviderId: "codex", fresh: .success([seatView("claude")])),
            .connect
        )
        // Present with zero seats → connect.
        let zero = AccountsProvider(provider: "claude", accounts: [AccountsAccount(id: "a", label: "x", orgName: nil, plan: nil, seats: [])])
        XCTAssertEqual(ConnectRoute.decide(statusId: "anthropic", seatProviderId: "claude", fresh: .success([zero])), .connect)
        XCTAssertEqual(ConnectRoute.decide(statusId: "anthropic", seatProviderId: "claude", fresh: .success([])), .connect)

        XCTAssertEqual(
            ConnectRoute.blockedMessage(label: "Claude", reason: "check the connection and try again"),
            "Couldn't check Claude's existing logins — check the connection and try again. Try again."
        )
        XCTAssertEqual(SeatProviderMap.statusId(forSeatProvider: "claude"), "anthropic")
        XCTAssertEqual(SeatProviderMap.seatProvider(forStatusId: "openai"), "codex")
        XCTAssertNil(SeatProviderMap.seatProvider(forStatusId: "kimi-for-coding"))
    }

    // MARK: - Flow transitions

    func testTransitionsAfterClaudeStatus() {
        func next(_ reply: ClaudeStatusReply) -> ConnectTransition { ProviderConnectRules.next(after: .claudeStatus(reply)) }
        XCTAssertEqual(next(ClaudeStatusReply(ok: true, progress: .completed)), .to(.applying(restarted: true)))
        XCTAssertEqual(next(ClaudeStatusReply(ok: true, progress: .preExisting)), .to(.applying(restarted: false)))
        XCTAssertEqual(next(ClaudeStatusReply(ok: true, progress: .noFile)), .stay)
        XCTAssertEqual(next(ClaudeStatusReply(ok: true, progress: .other("x"))), .stay)
        XCTAssertEqual(next(ClaudeStatusReply(ok: true, progress: nil)), .stay)
        XCTAssertEqual(next(ClaudeStatusReply(ok: false, progress: nil)), .stay, "not ok and not unknown_session: keep polling")
        // unknown_session is terminal on iOS: the record is gone and can never recover.
        XCTAssertEqual(
            next(ClaudeStatusReply(ok: false, progress: nil, error: "unknown_session")),
            .to(.failed("This sign-in has expired. Start again.", claudeInstall: false))
        )
    }

    func testTransitionsAfterOauthStatus() {
        func next(_ reply: OauthStatusReply) -> ConnectTransition { ProviderConnectRules.next(after: .oauthStatus(reply)) }
        XCTAssertEqual(next(OauthStatusReply(state: .pending)), .stay)
        XCTAssertEqual(next(OauthStatusReply(state: .ok)), .to(.applying(restarted: false)))
        XCTAssertEqual(next(OauthStatusReply(state: .error, error: "expired")), .to(.failed("The sign-in code expired. Try again.", claudeInstall: false)))
        XCTAssertEqual(next(OauthStatusReply(state: .error, error: "not_started")), .to(.failed("Sign-in didn't start. Try again.", claudeInstall: false)))
        XCTAssertEqual(next(OauthStatusReply(state: .error, error: "other")), .to(.failed("Sign-in failed. Try again.", claudeInstall: false)))
        XCTAssertEqual(next(OauthStatusReply(state: .error)), .to(.failed("Sign-in failed. Try again.", claudeInstall: false)))
    }

    func testKeyAndCodeErrorText() {
        XCTAssertEqual(ProviderConnectCopy.keyErrorText("unauthorized"), "That key didn't work. Try again.")
        XCTAssertEqual(ProviderConnectCopy.keyErrorText("bad_response"), "Save failed: bad_response")
        XCTAssertEqual(ProviderConnectCopy.keyErrorText(nil), "Save failed: unknown")
        XCTAssertEqual(ProviderConnectCopy.codeErrorText("unauthorized"), "That code didn't work. Try again.")
        XCTAssertEqual(ProviderConnectCopy.codeErrorText("x"), "Save failed: x")
        XCTAssertEqual(ProviderConnectCopy.codeErrorText(nil), "Save failed: unknown")
    }

    func testPhaseLabelsAndCopy() {
        XCTAssertEqual(ProviderConnectCopy.phaseLabel(.starting), "Connecting…")
        XCTAssertEqual(ProviderConnectCopy.phaseLabel(.waiting(url: "", instructions: "")), "Waiting for sign-in")
        XCTAssertEqual(ProviderConnectCopy.phaseLabel(.needsKey(consoleURL: nil, error: nil)), "Enter your API key")
        XCTAssertEqual(ProviderConnectCopy.title(label: "Kimi"), "Connect Kimi")
        XCTAssertEqual(ProviderConnectCopy.connected(label: "Kimi"), "Kimi connected.")
        XCTAssertEqual(ProviderConnectCopy.disconnected(label: "Codex"), "Codex disconnected.")
        XCTAssertEqual(ProviderConnectCopy.disconnectFailed(label: "Codex", reason: "boom"), "Couldn't disconnect Codex — boom")
        XCTAssertTrue(ProviderConnectPhase.done.isTerminal)
        XCTAssertTrue(ProviderConnectPhase.failed("x", claudeInstall: false).isTerminal)
        XCTAssertFalse(ProviderConnectPhase.starting.isTerminal)
    }

    // MARK: - Lease: pure reducer

    private let a = UUID()
    private let b = UUID()
    private let c = UUID()

    func testLeaseReducerReviewScenario() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        // A's start is in flight.
        XCTAssertEqual(state.reduce(.request(a)), [.runStart(a)])
        // Cancel A (its reply has not landed): nothing is sent yet.
        XCTAssertEqual(state.reduce(.retire(a)), [])
        // Connect again: B queues behind A — no start for B.
        XCTAssertEqual(state.reduce(.request(b)), [])
        XCTAssertEqual(state.waiters, [b])
        // A's late reply lands: NOW the cancel goes out — for A.
        XCTAssertEqual(state.reduce(.startFinished(a)), [.sendCancel("openai")])
        // A's cleanup completes: B starts and owns the slot.
        XCTAssertEqual(state.reduce(.cancelFinished), [.runStart(b)])
        XCTAssertEqual(state.owner, b)
        // From here no cancel is ever emitted while B owns the slot unless B is retired.
        XCTAssertEqual(state.reduce(.startFinished(b)), [])
        XCTAssertEqual(state.reduce(.cancelFinished), [], "a stray completion is ignored")
        XCTAssertEqual(state.reduce(.retire(a)), [], "the old attempt can no longer cancel anything")
        XCTAssertEqual(state.owner, b)
        XCTAssertEqual(state.reduce(.retire(b)), [.sendCancel("openai")], "only the owner's retire cancels")
        XCTAssertEqual(state.reduce(.cancelFinished), [])
        XCTAssertTrue(state.isIdle)
    }

    func testLeaseRetireAfterTheReplyCancelsAtOnce() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        _ = state.reduce(.request(a))
        XCTAssertEqual(state.reduce(.startFinished(a)), [])
        XCTAssertEqual(state.reduce(.retire(a)), [.sendCancel("openai")])
        // A second retire while the cancel is out does not send another.
        XCTAssertEqual(state.reduce(.retire(a)), [])
        XCTAssertEqual(state.reduce(.cancelFinished), [])
        XCTAssertTrue(state.isIdle)
    }

    func testLeaseRetiringAQueuedWaiterSendsNothing() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        _ = state.reduce(.request(a))
        _ = state.reduce(.request(b))
        _ = state.reduce(.request(c))
        XCTAssertEqual(state.reduce(.retire(b)), [.drop(b)])
        XCTAssertEqual(state.waiters, [c])
        // A settles: the next waiter (C), not the dropped B, runs — no cancel.
        _ = state.reduce(.startFinished(a))
        XCTAssertEqual(state.reduce(.settled(a)), [.runStart(c)])
        XCTAssertEqual(state.owner, c)
    }

    func testLeaseSettledFreesWithoutCancelling() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        _ = state.reduce(.request(a))
        _ = state.reduce(.startFinished(a))
        XCTAssertEqual(state.reduce(.settled(a)), [])
        XCTAssertTrue(state.isIdle)
        XCTAssertEqual(state.reduce(.settled(b)), [], "a stranger cannot free a slot")
        XCTAssertEqual(state.reduce(.request(b)), [.runStart(b)], "the slot is free for the next attempt")
    }

    func testLeaseCancelFailureStillFreesTheSlot() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        _ = state.reduce(.request(a))
        _ = state.reduce(.startFinished(a))
        _ = state.reduce(.request(b))
        XCTAssertEqual(state.reduce(.retire(a)), [.sendCancel("openai")])
        // `.cancelFinished` is raised on failure too.
        XCTAssertEqual(state.reduce(.cancelFinished), [.runStart(b)])
    }

    func testLeaseGrantedButRetiredBeforeRunningFreesWithoutACancel() {
        var state = ProviderOAuthLeaseState(provider: "openai")
        _ = state.reduce(.request(a))                       // A owns, start in flight
        XCTAssertEqual(state.reduce(.retire(a)), [])        // retired before its reply
        XCTAssertEqual(state.reduce(.request(b)), [])       // B queues
        // A's start was never actually sent: free the slot, no oauth-cancel.
        XCTAssertEqual(state.reduce(.grantedButRetired(a)), [.runStart(b)])
        XCTAssertEqual(state.owner, b)
        XCTAssertEqual(state.reduce(.grantedButRetired(a)), [], "only the owner, once")
        // Not retired → not applicable.
        var other = ProviderOAuthLeaseState(provider: "openai")
        _ = other.reduce(.request(a))
        XCTAssertEqual(other.reduce(.grantedButRetired(a)), [])
    }

    func testLeaseProvidersAreIndependent() {
        var openai = ProviderOAuthLeaseState(provider: "openai")
        var other = ProviderOAuthLeaseState(provider: "other")
        XCTAssertEqual(openai.reduce(.request(a)), [.runStart(a)])
        XCTAssertEqual(other.reduce(.request(b)), [.runStart(b)])
    }

    // MARK: - Lease: async, end to end

    @MainActor
    private final class Recorder {
        var events: [String] = []
        var releaseA: CheckedContinuation<Void, Never>?
        var cancelled: [String] { events.filter { $0.hasPrefix("cancel:") }.map { String($0.dropFirst(7)) } }
    }

    private static func isSuccess(_ result: Result<Void, MantaError>) -> Bool {
        if case .success = result { return true }
        return false
    }

    @MainActor
    func testLeaseNeverCancelsTheNewerAttempt() async throws {
        let rec = Recorder()
        let lease = ProviderOAuthLease(cancel: { provider in rec.events.append("cancel:\(provider)") })
        let attemptA = UUID()
        let attemptB = UUID()

        // A's start is gated: it replies only when we say so.
        let aTask = Task { @MainActor in
            try await lease.start(provider: "openai", attempt: attemptA) {
                rec.events.append("A-start")
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in rec.releaseA = c }
                rec.events.append("A-reply")
                return "A"
            }
        }
        await Self.yield(until: { rec.releaseA != nil })

        // Cancel A before its reply: the cancel waits for the reply.
        let retireA = Task { @MainActor in await lease.retire(provider: "openai", attempt: attemptA) }
        await Task.yield()
        XCTAssertEqual(rec.cancelled, [], "no cancel before A's start has replied")

        // Connect again: B must wait for A's cleanup.
        let bTask = Task { @MainActor in
            try await lease.start(provider: "openai", attempt: attemptB) {
                rec.events.append("B-start")
                return "B"
            }
        }
        await Task.yield()
        XCTAssertFalse(rec.events.contains("B-start"), "B waits for the previous section")

        // A's late reply lands.
        rec.releaseA?.resume()
        let aValue = try await aTask.value
        XCTAssertEqual(aValue, "A", "the reply of a retired attempt is still returned to its caller, which drops it")
        let retireResult = await retireA.value
        XCTAssertTrue(Self.isSuccess(retireResult))
        let bValue = try await bTask.value
        XCTAssertEqual(bValue, "B")

        XCTAssertEqual(rec.cancelled, ["openai"], "exactly one cancel — A's")
        let cancelIndex = try XCTUnwrap(rec.events.firstIndex(of: "cancel:openai"))
        let bIndex = try XCTUnwrap(rec.events.firstIndex(of: "B-start"))
        XCTAssertLessThan(cancelIndex, bIndex, "the cancel completed before B's start ran")

        // B settles normally: no cancel is sent on its behalf.
        lease.settled(provider: "openai", attempt: attemptB)
        await Task.yield()
        XCTAssertEqual(rec.cancelled, ["openai"])
    }

    @MainActor
    func testLeaseRetireReportsAFailedCancel() async {
        let lease = ProviderOAuthLease(cancel: { _ in throw MantaError.transport("down") })
        let attempt = UUID()
        _ = try? await lease.start(provider: "openai", attempt: attempt) { "ok" }
        let result = await lease.retire(provider: "openai", attempt: attempt)
        if case .failure(let error) = result {
            XCTAssertEqual(error, .transport("down"), "the caller receives the failure")
        } else {
            XCTFail("expected the cancel failure to reach the caller")
        }
        // The slot is free anyway: a new attempt starts at once.
        let next = try? await lease.start(provider: "openai", attempt: UUID()) { "next" }
        XCTAssertEqual(next, "next")
    }

    @MainActor
    func testLeaseDropsARetiredWaiter() async throws {
        let rec = Recorder()
        let lease = ProviderOAuthLease()
        let a = UUID(), b = UUID()
        let aTask = Task { @MainActor in
            try await lease.start(provider: "openai", attempt: a) {
                await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in rec.releaseA = c }
                return 1
            }
        }
        await Self.yield(until: { rec.releaseA != nil })
        let bTask = Task { @MainActor in try await lease.start(provider: "openai", attempt: b) { 2 } }
        await Task.yield()
        let retire = await lease.retire(provider: "openai", attempt: b)
        XCTAssertTrue(Self.isSuccess(retire))
        let bValue = try await bTask.value
        XCTAssertNil(bValue, "a retired waiter starts nothing")
        rec.releaseA?.resume()
        let aValue = try await aTask.value
        XCTAssertEqual(aValue, 1)
    }

    @MainActor
    private static func yield(until condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { await Task.yield() }
    }
}
