import XCTest
@testable import MantaUI

// ===========================================================================
// WS08 — the pure half of the add-seat / re-sign flows (AccountsSignInModels.swift
// and the sign-in additions to AccountsModels.swift). No view, no box.
// ===========================================================================

final class AccountsSignInTests: XCTestCase {

    // MARK: - SignInConnect / SignInPhase

    private func connect(_ json: String) -> SignInConnect? {
        let value = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return SignInConnect(json: value)
    }

    func testConnectDecodesEveryShape() {
        let claude = connect(#"{"shape":"claude-login","sessionKey":"claude-login-1","startedAt":1750000000000,"cwd":"/home/dev"}"#)
        XCTAssertEqual(claude?.shape, .claudeLogin)
        XCTAssertEqual(claude?.sessionKey, "claude-login-1")
        XCTAssertEqual(claude?.startedAt, 1_750_000_000_000)
        XCTAssertEqual(claude?.cwd, "/home/dev")

        let device = connect(#"{"shape":"oauth-auto","url":"https://auth.openai.com/codex/device","instructions":"Enter code: ABCD-1234","methodIndex":1}"#)
        XCTAssertEqual(device?.shape, .oauthAuto)
        XCTAssertEqual(device?.url, "https://auth.openai.com/codex/device")
        XCTAssertEqual(device?.methodIndex, 1)

        XCTAssertEqual(connect(#"{"shape":"oauth-code"}"#)?.shape, .oauthCode)
        XCTAssertEqual(connect(#"{"shape":"api-key"}"#)?.shape, .apiKey)
        XCTAssertEqual(connect(#"{"shape":"future"}"#)?.shape, .other("future"))
    }

    func testConnectToleratesMissingAndWrongTypedFields() {
        let sparse = connect(#"{"shape":"claude-login","sessionKey":5,"startedAt":"x","methodIndex":1.5}"#)
        XCTAssertEqual(sparse?.shape, .claudeLogin)
        XCTAssertNil(sparse?.sessionKey)
        XCTAssertNil(sparse?.startedAt)
        XCTAssertNil(sparse?.methodIndex)
        XCTAssertNil(connect(#"{"url":"x"}"#), "no shape → cannot be driven")
        XCTAssertNil(connect(#"{"shape":""}"#))
        XCTAssertNil(connect(#""claude-login""#))
        XCTAssertNil(SignInConnect(json: nil))
    }

    func testPhaseMapping() {
        XCTAssertEqual(
            SignInPhase.from(SignInConnect(shape: .claudeLogin, sessionKey: "k", cwd: "/x")),
            .claude(sessionKey: "k", cwd: "/x")
        )
        XCTAssertEqual(
            SignInPhase.from(SignInConnect(shape: .claudeLogin, sessionKey: "k")),
            .claude(sessionKey: "k", cwd: "~"),
            "a missing cwd falls back to ~"
        )
        XCTAssertNil(SignInPhase.from(SignInConnect(shape: .claudeLogin, sessionKey: "")), "claude without a key")
        XCTAssertNil(SignInPhase.from(SignInConnect(shape: .claudeLogin)))
        XCTAssertEqual(
            SignInPhase.from(SignInConnect(shape: .oauthAuto, url: "https://x", instructions: "i")),
            .device(url: "https://x", instructions: "i")
        )
        XCTAssertEqual(SignInPhase.from(SignInConnect(shape: .oauthAuto)), .device(url: "", instructions: ""))
        XCTAssertNil(SignInPhase.from(SignInConnect(shape: .oauthCode)))
        XCTAssertNil(SignInPhase.from(SignInConnect(shape: .apiKey)))
        XCTAssertNil(SignInPhase.from(SignInConnect(shape: .other("future"))))
    }

    // MARK: - Terms note

    func testNeedsTosNoteTruthTable() {
        for accounts in [0, 1, 3] {
            for acknowledged in [false, true] {
                for adding in [false, true] {
                    let expected = adding && !acknowledged && accounts >= 1
                    XCTAssertEqual(
                        AccountsSignInRules.needsTosNote(accountCount: accounts, acknowledged: acknowledged, addingAccount: adding),
                        expected,
                        "accounts=\(accounts) ack=\(acknowledged) adding=\(adding)"
                    )
                }
            }
        }
    }

    // MARK: - Copy

    func testSeatFailureMessage() {
        XCTAssertEqual(
            AccountsSignInCopy.seatFailureMessage(error: "duplicate-login", timedOut: false),
            "That login is already added as a seat. Sign in with a different account."
        )
        XCTAssertEqual(
            AccountsSignInCopy.seatFailureMessage(error: "duplicate-login", timedOut: true),
            "That login is already added as a seat. Sign in with a different account.",
            "a duplicate is a duplicate even past the deadline"
        )
        XCTAssertEqual(
            AccountsSignInCopy.seatFailureMessage(error: nil, timedOut: true),
            "The sign-in wasn't finished within 15 minutes, so the box stopped waiting. Try again and finish it in the browser."
        )
        XCTAssertEqual(
            AccountsSignInCopy.seatFailureMessage(error: "login-failed", timedOut: false),
            "The sign-in failed — the code may have been wrong or expired. Try again."
        )
        XCTAssertTrue(AccountsSignInCopy.unreachableAtDeadline.hasPrefix("Couldn't reach the server to check the sign-in."))
    }

    func testAddedMessage() {
        let found = SignInSeatLocation(seatLabel: "Seat 2", accountLabel: "Work", email: "x@y.com")
        XCTAssertEqual(
            AccountsSignInCopy.addedMessage(addingToAccount: true, found: found, fallbackLabel: "the new seat", providerLabel: "Claude"),
            "Added Seat 2 to Work."
        )
        XCTAssertEqual(
            AccountsSignInCopy.addedMessage(addingToAccount: false, found: found, fallbackLabel: "the new seat", providerLabel: "Claude"),
            "Added the account “Work” — x@y.com is signed in."
        )
        let noEmail = SignInSeatLocation(seatLabel: "Seat 1", accountLabel: "Home", email: nil)
        XCTAssertEqual(
            AccountsSignInCopy.addedMessage(addingToAccount: false, found: noEmail, fallbackLabel: "x", providerLabel: "Claude"),
            "Added the account “Home” — Seat 1 is signed in."
        )
        XCTAssertEqual(
            AccountsSignInCopy.addedMessage(addingToAccount: false, found: nil, fallbackLabel: "Acme", providerLabel: "Claude"),
            "Added Acme to Claude."
        )
        XCTAssertEqual(
            AccountsSignInCopy.addedMessage(addingToAccount: true, found: nil, fallbackLabel: "the new seat", providerLabel: "OpenAI"),
            "Added the new seat to OpenAI."
        )
    }

    func testSeatLocationFindsTheSeatInTheRefreshedList() {
        let providers = [AccountsProvider(provider: "claude", accounts: [
            AccountsAccount(id: "a", label: "Work", orgName: nil, plan: nil, seats: [AccountsSeat(id: "s1", label: "Seat 1", email: "a@b.c")]),
        ])]
        XCTAssertEqual(
            SignInSeatLocation.find(seatId: "s1", provider: "claude", in: providers),
            SignInSeatLocation(seatLabel: "Seat 1", accountLabel: "Work", email: "a@b.c")
        )
        XCTAssertNil(SignInSeatLocation.find(seatId: "nope", provider: "claude", in: providers))
        XCTAssertNil(SignInSeatLocation.find(seatId: "s1", provider: "codex", in: providers))
    }

    func testDifferentOrgPromptAndTitles() {
        XCTAssertEqual(
            AccountsSignInCopy.differentOrgPrompt(orgName: "Acme", accountLabel: "Work"),
            "That sign-in belongs to a different organization (Acme), so it can't join “Work”. Create a new account for it?"
        )
        XCTAssertEqual(
            AccountsSignInCopy.differentOrgPrompt(orgName: nil, accountLabel: nil),
            "That sign-in belongs to a different organization, so it can't join this account. Create a new account for it?"
        )
        XCTAssertEqual(AccountsSignInCopy.addTitle(providerLabel: "Claude", accountLabel: "Work", addingToAccount: true), "Add a seat to Work")
        XCTAssertEqual(AccountsSignInCopy.addTitle(providerLabel: "Claude", accountLabel: nil, addingToAccount: false), "Add a Claude account")
    }

    // MARK: - Clock

    func testIsExpiredAroundTheLimit() {
        let start = Date(timeIntervalSince1970: 1_000)
        let limit: TimeInterval = 100
        XCTAssertFalse(SignInClock.isExpired(startedAt: start, now: start.addingTimeInterval(limit - 0.001), limit: limit))
        XCTAssertTrue(SignInClock.isExpired(startedAt: start, now: start.addingTimeInterval(limit), limit: limit))
        XCTAssertTrue(SignInClock.isExpired(startedAt: start, now: start.addingTimeInterval(limit + 0.001), limit: limit))
        XCTAssertFalse(SignInClock.isExpired(startedAt: start, now: start.addingTimeInterval(limit), limit: .nan), "NaN-safe")
        XCTAssertEqual(SignInClock.clientLimit, 15 * 60 + 30)
    }

    // MARK: - Claude link

    func testClaudeLoginURLExtraction() {
        let link = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
        XCTAssertEqual(ClaudeLoginURL.extract(from: "Open this link:\n\(link)\n")?.absoluteString, link)
        XCTAssertEqual(ClaudeLoginURL.extract(from: "\(link)\u{07}rest")?.absoluteString, link, "BEL terminates")
        XCTAssertEqual(ClaudeLoginURL.extract(from: "\(link)\u{1B}[0m")?.absoluteString, link, "ESC terminates")
        XCTAssertEqual(ClaudeLoginURL.extract(from: "see (\(link)) ok")?.absoluteString, link, "trailing ) stripped")
        XCTAssertEqual(ClaudeLoginURL.extract(from: "\(link). next")?.absoluteString, link, "trailing . stripped")
        XCTAssertEqual(ClaudeLoginURL.extract(from: "\(link);\n")?.absoluteString, link, "trailing ; stripped")
        XCTAssertNil(ClaudeLoginURL.extract(from: "no link here"))
        XCTAssertNil(ClaudeLoginURL.extract(from: "https://example.com/elsewhere \n"))
    }

    func testAnUnterminatedLinkIsNeverTakenHalfRead() {
        let link = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
        let first = String(link.prefix(40))
        let second = String(link.dropFirst(40))
        XCTAssertNil(ClaudeLoginURL.extract(from: "Open: " + link), "no terminator yet")
        var buffer = ClaudeLoginURL.appending("Open: ", first)
        XCTAssertNil(ClaudeLoginURL.extract(from: buffer), "first half only")
        buffer = ClaudeLoginURL.appending(buffer, second)
        XCTAssertNil(ClaudeLoginURL.extract(from: buffer), "complete but still unterminated")
        buffer = ClaudeLoginURL.appending(buffer, "\n")
        XCTAssertEqual(ClaudeLoginURL.extract(from: buffer)?.absoluteString, link, "found only after the terminator arrives")
    }

    func testBufferKeepsTheTail() {
        let big = String(repeating: "a", count: ClaudeLoginURL.bufferLimit + 500)
        let trimmed = ClaudeLoginURL.appending("", big + "END")
        XCTAssertEqual(trimmed.unicodeScalars.count, ClaudeLoginURL.bufferLimit)
        XCTAssertTrue(trimmed.hasSuffix("END"))
    }

    // MARK: - PtyEvent

    private func frame(_ json: String) -> MantaStreamFrame {
        (try? MantaStreamFrame.parse(json)) ?? MantaStreamFrame(kind: "bad", sub: nil, sessionId: nil, payload: nil, eventType: nil)
    }

    func testPtyEventFromFrames() {
        XCTAssertEqual(
            PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"data","sessionKey":"k","data":"hello"}}"#)),
            PtyEvent(sessionKey: "k", kind: .data("hello"))
        )
        XCTAssertEqual(
            PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"exit","sessionKey":"k","code":1}}"#)),
            PtyEvent(sessionKey: "k", kind: .exit(code: 1))
        )
        XCTAssertEqual(
            PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"exit","sessionKey":"k","code":null}}"#)),
            PtyEvent(sessionKey: "k", kind: .exit(code: nil))
        )
        XCTAssertEqual(
            PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"exit","sessionKey":"k"}}"#)),
            PtyEvent(sessionKey: "k", kind: .exit(code: nil))
        )
        XCTAssertNil(PtyEvent.from(frame(#"{"kind":"accounts.updated","payload":{"kind":"data","sessionKey":"k","data":"x"}}"#)), "not a pty frame")
        XCTAssertNil(PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"data","data":"x"}}"#)), "no sessionKey")
        XCTAssertNil(PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"data","sessionKey":"","data":"x"}}"#)))
        XCTAssertNil(PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"data","sessionKey":"k"}}"#)), "data without data")
        XCTAssertNil(PtyEvent.from(frame(#"{"kind":"pty","payload":{"kind":"resize","sessionKey":"k"}}"#)))
    }

    // MARK: - Teardown plan

    func testTeardownPlans() {
        XCTAssertEqual(SignInAttempt().teardownPlan(), [], "an empty attempt releases nothing")

        XCTAssertEqual(SignInAttempt(seatId: "s1").teardownPlan(), [.cancelSeat("s1")])
        XCTAssertEqual(SignInAttempt(flowId: "f1").teardownPlan(), [.resignCancel("f1")])

        // A seat / flow cancel drops its own Claude login on the box: no second call.
        XCTAssertEqual(
            SignInAttempt(seatId: "s1", loginSessionKey: "claude-login-1", loginSpawned: true).teardownPlan(),
            [.cancelSeat("s1")]
        )
        XCTAssertEqual(
            SignInAttempt(flowId: "f1", loginSessionKey: "claude-login-1", loginSpawned: true).teardownPlan(),
            [.resignCancel("f1")]
        )

        // F3 waiting on a device code.
        XCTAssertEqual(
            SignInAttempt(oauthProviderId: "openai").teardownPlan(),
            [.oauthCancel(provider: "openai")]
        )

        // F3 Claude, spawned: kill the pty, then drop the registration.
        XCTAssertEqual(
            SignInAttempt(loginSessionKey: "claude-login-1", loginSpawned: true).teardownPlan(),
            [.ptyKill("claude-login-1"), .claudeLoginCancel("claude-login-1")]
        )

        // F3 installing: the installer pty AND the registration minted at start —
        // no pty:kill for the login that was never spawned.
        XCTAssertEqual(
            SignInAttempt(loginSessionKey: "claude-login-1", loginSpawned: false, installerKey: "claude-install-9").teardownPlan(),
            [.ptyKill("claude-install-9"), .claudeLoginCancel("claude-login-1")]
        )

        // A parked different-org seat is released by cancel-seat.
        XCTAssertEqual(SignInAttempt(seatId: "s1", parked: true).teardownPlan(), [.cancelSeat("s1")])
    }

    // MARK: - Attempt gate

    func testGateRejectsRetiredAttemptsAndRoutesLateStartReplies() {
        let old = UUID()
        let new = UUID()
        XCTAssertTrue(SignInAttemptGate.accepts(resultFor: new, current: new))
        // Timeout → retry: the old attempt's poll result arrives after the new one began.
        XCTAssertFalse(SignInAttemptGate.accepts(resultFor: old, current: new))
        // Cancelled while the start was in flight: current is nil.
        XCTAssertFalse(SignInAttemptGate.accepts(resultFor: old, current: nil))
        XCTAssertEqual(SignInAttemptGate.routeStartReply(attempt: old, current: nil), .tearDownOneOff)
        XCTAssertEqual(SignInAttemptGate.routeStartReply(attempt: old, current: new), .tearDownOneOff)
        XCTAssertEqual(SignInAttemptGate.routeStartReply(attempt: new, current: new), .use)

        // A late exit for an old login key is ignored.
        XCTAssertTrue(SignInAttemptGate.accepts(ptyEventKey: "claude-login-new", attemptKey: "claude-login-new"))
        XCTAssertFalse(SignInAttemptGate.accepts(ptyEventKey: "claude-login-old", attemptKey: "claude-login-new"))
        XCTAssertFalse(SignInAttemptGate.accepts(ptyEventKey: "claude-login-old", attemptKey: nil))
        XCTAssertFalse(SignInAttemptGate.accepts(ptyEventKey: "", attemptKey: ""))
    }

    // MARK: - Poll decisions

    func testSeatPollDecisions() {
        func decide(_ reply: SeatStatusReply?, expired: Bool = false, past: Bool = false) -> SeatPollOutcome {
            SignInPollRules.decideSeat(reply: reply, expired: expired, pastServerLimit: past)
        }
        XCTAssertEqual(decide(nil), .keepPolling, "box transiently unreachable")
        XCTAssertEqual(decide(SeatStatusReply(state: .pending)), .keepPolling)
        XCTAssertEqual(decide(nil, expired: true), .abandon(unreachable: true))
        XCTAssertEqual(decide(SeatStatusReply(state: .pending), expired: true), .abandon(unreachable: false))
        let seat = AccountsSeat(id: "s1", label: "Seat 1")
        XCTAssertEqual(decide(SeatStatusReply(state: .ok, seat: seat)), .added(seat))
        XCTAssertEqual(decide(SeatStatusReply(state: .failed, error: "different-org", orgName: "Acme")), .differentOrg(orgName: "Acme"))
        XCTAssertEqual(decide(SeatStatusReply(state: .failed, error: "duplicate-login")), .failed(error: "duplicate-login", timedOut: false))
        XCTAssertEqual(decide(SeatStatusReply(state: .failed), past: true), .failed(error: nil, timedOut: true))
        // The last reading at the limit still wins over giving up.
        XCTAssertEqual(decide(SeatStatusReply(state: .ok, seat: seat), expired: true), .added(seat))
    }

    func testResignPollDecisions() {
        XCTAssertEqual(SignInPollRules.decideResign(reply: nil, expired: false), .keepPolling)
        XCTAssertEqual(SignInPollRules.decideResign(reply: nil, expired: true), .abandon(unreachable: true))
        XCTAssertEqual(SignInPollRules.decideResign(reply: ResignStatusReply(state: .pending), expired: true), .abandon(unreachable: false))
        let seat = AccountsSeat(id: "s1")
        XCTAssertEqual(SignInPollRules.decideResign(reply: ResignStatusReply(state: .ok, seat: seat), expired: false), .signedBack(seat))
        XCTAssertEqual(
            SignInPollRules.decideResign(reply: ResignStatusReply(state: .failed, error: "different-account", expectedEmail: "a@x", gotEmail: "b@x"), expired: false),
            .failed(error: "different-account", expectedEmail: "a@x", gotEmail: "b@x")
        )
    }

    // MARK: - Re-sign

    func testResignStatusReplyDecodes() throws {
        func decode(_ json: String) throws -> ResignStatusReply {
            try JSONDecoder().decode(ResignStatusReply.self, from: Data(json.utf8))
        }
        let ok = try decode(#"{"state":"ok","seat":{"id":"s1","label":"Seat 1","email":"a@x"}}"#)
        XCTAssertEqual(ok.state, .ok)
        XCTAssertEqual(ok.seat?.email, "a@x")

        let different = try decode(#"{"state":"failed","error":"different-account","expectedEmail":"a@x","gotEmail":"b@x"}"#)
        XCTAssertEqual(different.state, .failed)
        XCTAssertEqual(different.error, "different-account")
        XCTAssertEqual(different.expectedEmail, "a@x")
        XCTAssertEqual(different.gotEmail, "b@x")

        XCTAssertEqual(try decode(#"{"state":"weird"}"#).state, .pending, "unknown state keeps polling")
        XCTAssertEqual(try decode("{}").state, .pending)
        XCTAssertEqual(try decode(#"{"state":"failed","error":"unknown-flow"}"#).error, "unknown-flow")
        XCTAssertNil(try decode(#"{"state":"failed","expectedEmail":null}"#).expectedEmail)
    }

    func testResignFailureMessages() {
        func msg(_ error: String?, expected: String? = nil, got: String? = nil, email: String? = nil) -> String {
            AccountsSignInCopy.resignFailureMessage(error: error, expectedEmail: expected, gotEmail: got, seatLabel: "Seat 1", seatEmail: email)
        }
        XCTAssertEqual(msg("different-account", expected: "a@x", got: "b@x"), "You signed in as b@x, but this seat is a@x. Sign in with a@x.")
        XCTAssertEqual(msg("different-account", got: "b@x", email: "seat@x"), "You signed in as b@x, but this seat is seat@x. Sign in with seat@x.")
        XCTAssertEqual(msg("different-account"), "You signed in as a different account, but that isn't the account Seat 1 belongs to. Sign in with the same account.")
        XCTAssertEqual(msg("login-failed"), "Sign-in didn't complete. Seat 1 was not changed — try again.")
        XCTAssertEqual(msg("unknown-flow"), "Sign-in didn't complete. Seat 1 was not changed — try again.")
        XCTAssertEqual(AccountsSignInCopy.resignTimedOut(seatLabel: "Seat 1"), "The sign-in wasn't finished within 15 minutes, so the box stopped waiting. Seat 1 was not changed — try again.")
        XCTAssertEqual(AccountsSignInCopy.resignUnreachable(seatLabel: "Seat 1"), "Couldn't reach the server to check the sign-in. Seat 1 was not changed — try again once the box is reachable.")
        XCTAssertEqual(AccountsSignInCopy.resignBadCode(seatLabel: "Seat 1"), "That code didn't work (it may have expired). Seat 1 was not changed — start the sign-in again.")
        XCTAssertEqual(AccountsSignInCopy.resignDone(email: "a@x", seatLabel: "Seat 1"), "Signed back in as a@x")
        XCTAssertEqual(AccountsSignInCopy.resignDone(email: nil, seatLabel: "Seat 1"), "Seat 1 is signed back in")
        XCTAssertEqual(AccountsSignInCopy.resignCancelled(seatLabel: "Seat 1"), "Sign-in cancelled — Seat 1 was not changed.")
        XCTAssertEqual(AccountsSignInCopy.resignCancelFailed(seatLabel: "Seat 1"), "Couldn't cancel the sign-in on the server — it will expire by itself. Seat 1 was not changed.")
        XCTAssertEqual(AccountsSignInCopy.resignTitle(seatLabel: "Seat 1"), "Sign Seat 1 back in")
        XCTAssertEqual(
            AccountsSignInCopy.resignLead(seatLabel: "Seat 1", email: nil),
            "Sign in with this seat's account. Seat 1 stays as it is until the sign-in is confirmed to be the same account."
        )
    }

    func testStartFailureMapsLiveSeatOnlyForResign() {
        XCTAssertEqual(AccountsSignInCopy.startFailure(MantaError.server("live-seat"), resign: true), AccountsSignInCopy.liveSeatRace)
        XCTAssertEqual(
            AccountsSignInCopy.startFailure(MantaError.server("live-seat"), resign: false),
            "Couldn't start the sign-in — that is the box's live login — switch to another seat before removing it",
            "the general live-seat text is about removal"
        )
        XCTAssertEqual(AccountsSignInCopy.startFailure(MantaError.transport("x"), resign: true), AccountsSignInCopy.startUnreachable)
        XCTAssertEqual(
            AccountsSignInCopy.startFailure(MantaError.server("unknown-provider"), resign: false),
            "Couldn't start the sign-in — that provider isn't set up on this box"
        )
    }

    // MARK: - Live-seat advice

    private func seat(_ id: String, label: String? = nil, status: SeatStatus = .ok, live: Bool = false) -> AccountsSeat {
        AccountsSeat(id: id, label: label ?? id, status: status, live: live)
    }

    private func provider(_ name: String = "claude", active: String?, seats: [AccountsSeat]) -> AccountsProvider {
        AccountsProvider(
            provider: name, mode: .manual, activeSeatId: active, routingActive: true, nextSeatId: nil,
            accounts: [AccountsAccount(id: "a", label: "Work", orgName: nil, plan: nil, seats: seats)]
        )
    }

    func testLiveSeatAdviceNamesOnlyPathsTheBoxAccepts() {
        // 1. A usable replacement exists → remove it first, then add again.
        let withReplacement = provider(active: "s1", seats: [seat("s1", label: "Seat 1", status: .expired, live: true), seat("s2", label: "Seat 2")])
        let advice1 = AccountsSignInRules.liveSeatAdvice(provider: withReplacement, seat: withReplacement.accounts[0].seats[0], managedBy: nil)
        XCTAssertEqual(
            advice1,
            "This is the box's own login. Remove it — the box switches to “Seat 2” first — then sign it in again with Add Claude account."
        )

        // 2. Other seats, but none can take over.
        let noneUsable = provider(active: "s1", seats: [seat("s1", status: .expired, live: true), seat("s2", status: .signedOut)])
        XCTAssertEqual(
            AccountsSignInRules.liveSeatAdvice(provider: noneUsable, seat: noneUsable.accounts[0].seats[0], managedBy: nil),
            "This is the box's own login and no other login is ready to take over. Sign in another account with Add Claude account first; then this seat can be removed and added again."
        )

        // 3a. Sole seat, managed by the Claude CLI → terminal advice, no recovery from this screen.
        let sole = provider(active: "s1", seats: [seat("s1", status: .expired, live: true)])
        XCTAssertEqual(
            AccountsSignInRules.liveSeatAdvice(provider: sole, seat: sole.accounts[0].seats[0], managedBy: "the Claude CLI on this box"),
            "This login belongs to the Claude CLI on this box, so it has to be signed in again there — open a terminal session and run `claude auth login`. That isn't available from this screen."
        )

        // 3b. Sole seat, not externally managed → no path is promised.
        let advice3b = AccountsSignInRules.liveSeatAdvice(provider: sole, seat: sole.accounts[0].seats[0], managedBy: nil)
        XCTAssertEqual(advice3b, "This is the box's only Claude login, and signing it in again isn't available from this screen yet.")
        XCTAssertFalse(advice3b.contains("Disconnect"), "Disconnect → Connect would route back into Add account and be refused")
        XCTAssertFalse(advice3b.lowercased().contains("desktop"))
    }

    // MARK: - Device code / countdown

    func testDeviceCodeParse() {
        XCTAssertEqual(DeviceCode.parse("Enter code: ABCD-1234 to continue"), "ABCD-1234")
        XCTAssertEqual(DeviceCode.parse("your code abcd-12ef"), "abcd-12ef", "case-insensitive")
        XCTAssertNil(DeviceCode.parse("The user has not entered a code"))
        XCTAssertNil(DeviceCode.parse(""))
        XCTAssertNil(DeviceCode.fallback("Enter code: ABCD-1234"))
        XCTAssertEqual(DeviceCode.fallback("Go to the page and type the characters shown"), "The code is in the message below — copy it from there.")
        XCTAssertNil(DeviceCode.fallback(""))
        XCTAssertNil(DeviceCode.fallback("   "))
    }

    func testFormatRemaining() {
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(formatRemaining(startedAt: start, now: start, limit: 900), "15:00 remaining")
        XCTAssertEqual(formatRemaining(startedAt: start, now: start.addingTimeInterval(61), limit: 900), "13:59 remaining")
        XCTAssertEqual(formatRemaining(startedAt: start, now: start.addingTimeInterval(899.2), limit: 900), "0:01 remaining", "rounds up")
        XCTAssertEqual(formatRemaining(startedAt: start, now: start.addingTimeInterval(901), limit: 900), "0:00 remaining", "past the limit clamps at 0")
        XCTAssertEqual(formatRemaining(startedAt: start, now: Date(timeIntervalSince1970: .nan), limit: 900), "0:00 remaining")
        XCTAssertEqual(formatRemaining(startedAt: start, now: start, limit: .infinity), "0:00 remaining")
    }

    // MARK: - ProviderChange

    func testShouldAnnounce() {
        XCTAssertTrue(ProviderChange.shouldAnnounce(.confirmed))
        XCTAssertTrue(ProviderChange.shouldAnnounce(.partial))
        XCTAssertFalse(ProviderChange.shouldAnnounce(.rejected))
        XCTAssertFalse(ProviderChange.shouldAnnounce(.unconfirmed))
    }

    func testAnnouncePostsTheProvidersChangedNotification() {
        var posted: [Notification.Name] = []
        ProviderChange.announce(post: { posted.append($0) })
        XCTAssertEqual(posted, [.mantaProvidersChanged])
        XCTAssertEqual(Notification.Name.mantaProvidersChanged.rawValue, "manta.providersChanged")
    }
}
