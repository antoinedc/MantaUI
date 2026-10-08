import XCTest
@testable import MantaUI

// ===========================================================================
// Multi-account & seats, phase 3 — decoding of the `accounts:*` contract and
// the pure decisions behind the Accounts screen / usage sheet
// (AccountsModels.swift). No view, no HTTP, no box.
// ===========================================================================

final class AccountsTests: XCTestCase {

    // MARK: - Fixtures

    private let listJSON = """
    {"providers":[{"provider":"claude","mode":"auto","activeSeatId":"seat-1","routingActive":true,"nextSeatId":"seat-2",
      "accounts":[
        {"id":"org-a","label":"Work","orgName":"Acme","plan":"Max 20x","seats":[
          {"id":"seat-1","label":"Seat 1","email":"a@x.com","status":"ok","live":true,
           "windows":[{"kind":"session","label":"5h","pct":42,"resetsAt":1750000000000},{"kind":"weekly","label":"Weekly","pct":10}],
           "load":42,"fetchedAt":1750000000000,"conversations":3},
          {"id":"seat-2","label":"Seat 2","email":null,"status":"ok","live":false,"windows":[],"load":null,"fetchedAt":null,"conversations":0}]},
        {"id":"personal","label":"Personal","orgName":null,"plan":"Pro","seats":[
          {"id":"seat-3","label":"Me","email":"me@x.com","status":"signed-out","live":false,"windows":[],"load":null,"fetchedAt":null,"conversations":0}]}
      ]}]}
    """

    private func decodeList(_ json: String) throws -> [AccountsProvider] {
        try JSONDecoder().decode(AccountsListReply.self, from: Data(json.utf8)).providers
    }

    private func win(_ kind: String, _ pct: Double, label: String? = nil, scope: String? = nil,
                     active: Bool? = nil, resetsAt: Double? = nil, stale: Bool? = nil) -> UsageWindow {
        UsageWindow(kind: kind, label: label, pct: pct, resetsAt: resetsAt, stale: stale, scope: scope, active: active)
    }

    private func seat(_ id: String, label: String = "", status: SeatStatus = .ok, live: Bool = false,
                      windows: [UsageWindow] = [], load: Double? = nil, conversations: Int = 0,
                      email: String? = nil) -> AccountsSeat {
        AccountsSeat(id: id, label: label.isEmpty ? id : label, email: email, status: status, live: live,
                     windows: windows, load: load, conversations: conversations)
    }

    private func provider(_ name: String = "claude", mode: AccountsMode = .manual, active: String? = nil,
                          next: String? = nil, accounts: [AccountsAccount]) -> AccountsProvider {
        AccountsProvider(provider: name, mode: mode, activeSeatId: active, routingActive: true, nextSeatId: next, accounts: accounts)
    }

    private func account(_ id: String, _ label: String, plan: String? = nil, seats: [AccountsSeat]) -> AccountsAccount {
        AccountsAccount(id: id, label: label, orgName: nil, plan: plan, seats: seats)
    }

    /// Two accounts (one with two seats, one personal) — the shape most tests need.
    private func twoAccountProvider(mode: AccountsMode = .manual, active: String? = "s1", next: String? = nil) -> AccountsProvider {
        provider(mode: mode, active: active, next: next, accounts: [
            account("work", "Work", plan: "Max", seats: [seat("s1", label: "Seat 1", live: true), seat("s2", label: "Seat 2")]),
            account("me", "Personal", seats: [seat("s3", label: "Me")]),
        ])
    }

    // MARK: - Decoding: the happy path

    func testDecodesTheFullList() throws {
        let providers = try decodeList(listJSON)
        XCTAssertEqual(providers.count, 1)
        let claude = providers[0]
        XCTAssertEqual(claude.provider, "claude")
        XCTAssertEqual(claude.mode, .auto)
        XCTAssertEqual(claude.activeSeatId, "seat-1")
        XCTAssertTrue(claude.routingActive)
        XCTAssertEqual(claude.nextSeatId, "seat-2")
        XCTAssertEqual(claude.accounts.map(\.id), ["org-a", "personal"])
        XCTAssertEqual(claude.accounts[0].orgName, "Acme")
        XCTAssertEqual(claude.accounts[0].plan, "Max 20x")
        XCTAssertNil(claude.accounts[1].orgName)

        let first = claude.accounts[0].seats[0]
        XCTAssertEqual(first.label, "Seat 1")
        XCTAssertEqual(first.email, "a@x.com")
        XCTAssertEqual(first.status, .ok)
        XCTAssertTrue(first.live)
        XCTAssertEqual(first.windows.count, 2)
        XCTAssertEqual(first.windows[0].kind, "session")
        XCTAssertEqual(first.load, 42)
        XCTAssertEqual(first.conversations, 3)

        let second = claude.accounts[0].seats[1]
        XCTAssertNil(second.email)
        XCTAssertNil(second.load)
        XCTAssertEqual(second.windows, [])
        XCTAssertEqual(claude.accounts[1].seats[0].status, .signedOut)
    }

    // MARK: - Decoding: tolerance

    func testMissingOptionalFieldsAndUnknownValuesDecodeToNeutralDefaults() throws {
        let json = """
        {"providers":[{"provider":"codex","mode":"turbo","accounts":[{"id":"a","seats":[
          {"id":"s","status":"weird","windows":[{"kind":"session"},{"kind":"weekly","pct":5}],"brandNewField":{"x":1}}]}]}]}
        """
        let providers = try decodeList(json)
        XCTAssertEqual(providers.count, 1)
        // An unrecognised mode is the one that makes no claim about auto moves.
        XCTAssertEqual(providers[0].mode, .manual)
        XCTAssertNil(providers[0].activeSeatId)
        XCTAssertFalse(providers[0].routingActive)
        let seat = providers[0].accounts[0].seats[0]
        XCTAssertEqual(seat.status, .unknown)
        XCTAssertEqual(seat.label, "")
        XCTAssertEqual(seat.conversations, 0)
        XCTAssertFalse(seat.live)
        // The window without a `pct` was skipped; the good one survived.
        XCTAssertEqual(seat.windows.map(\.kind), ["weekly"])
    }

    func testAMalformedSeatOrProviderIsSkippedNotFatal() throws {
        let json = """
        {"providers":[{"nope":true},{"provider":"claude","accounts":[{"id":"a","seats":[{"label":"no id"},{"id":"ok"}]},{"label":"no id either"}]}]}
        """
        let providers = try decodeList(json)
        XCTAssertEqual(providers.map(\.provider), ["claude"])
        XCTAssertEqual(providers[0].accounts.map(\.id), ["a"])
        XCTAssertEqual(providers[0].accounts[0].seats.map(\.id), ["ok"])
    }

    func testAnEmptyOrAbsentProvidersListIsEmpty() throws {
        XCTAssertEqual(try decodeList(#"{"providers":[]}"#), [])
        XCTAssertEqual(try decodeList("{}"), [])
    }

    // MARK: - Decoding: session seat

    func testSessionSeatDecodesWithAnEpochMove() throws {
        let json = #"{"provider":"claude","seatId":"s1","seatLabel":"Seat 1","accountLabel":"Work","lastMove":{"from":"s0","fromLabel":"Seat 0","at":1750000000000,"reason":"exhausted"}}"#
        let seat = try JSONDecoder().decode(SessionSeat.self, from: Data(json.utf8))
        XCTAssertEqual(seat.provider, "claude")
        XCTAssertEqual(seat.seatId, "s1")
        XCTAssertEqual(seat.accountLabel, "Work")
        XCTAssertEqual(seat.lastMove?.from, "s0")
        XCTAssertEqual(seat.lastMove?.fromLabel, "Seat 0")
        XCTAssertEqual(seat.lastMove?.at, 1_750_000_000_000)
        XCTAssertEqual(seat.lastMove?.reason, "exhausted")
    }

    func testSessionSeatToleratesAnIsoMoveTimeAndNoMove() throws {
        let iso = "2026-10-08T12:00:00Z"
        let json = #"{"provider":"claude","seatId":"s1","lastMove":{"fromLabel":"Seat 0","at":"2026-10-08T12:00:00Z"}}"#
        let seat = try JSONDecoder().decode(SessionSeat.self, from: Data(json.utf8))
        let expected = try XCTUnwrap(ISO8601DateFormatter().date(from: iso)).timeIntervalSince1970 * 1000
        XCTAssertEqual(seat.lastMove?.at, expected)
        XCTAssertEqual(seat.seatLabel, "")

        let bare = try JSONDecoder().decode(SessionSeat.self, from: Data(#"{"provider":"codex","seatId":"x"}"#.utf8))
        XCTAssertNil(bare.lastMove)
    }

    func testSessionSeatWithoutIdentityDoesNotDecode() {
        XCTAssertThrowsError(try JSONDecoder().decode(SessionSeat.self, from: Data(#"{"provider":"claude"}"#.utf8)))
    }

    // MARK: - Decoding: action replies

    func testActionReplyDecodesAProviderOrAnErrorBody() throws {
        let ok = try JSONDecoder().decode(AccountsActionReply.self,
            from: Data(#"{"provider":"claude","mode":"auto","accounts":[]}"#.utf8))
        XCTAssertNil(ok.error)
        XCTAssertEqual(ok.provider?.mode, .auto)

        let refused = try JSONDecoder().decode(AccountsActionReply.self, from: Data(#"{"error":"live-seat"}"#.utf8))
        XCTAssertEqual(refused.error, "live-seat")
        XCTAssertNil(refused.provider)
    }

    func testSeatStatusReplyDecodesEveryState() throws {
        let pending = try JSONDecoder().decode(SeatStatusReply.self, from: Data(#"{"state":"pending"}"#.utf8))
        XCTAssertEqual(pending.state, .pending)

        let failed = try JSONDecoder().decode(SeatStatusReply.self,
            from: Data(#"{"state":"failed","error":"different-org","orgName":"Acme"}"#.utf8))
        XCTAssertEqual(failed.state, .failed)
        XCTAssertEqual(failed.error, "different-org")
        XCTAssertEqual(failed.orgName, "Acme")

        let done = try JSONDecoder().decode(SeatStatusReply.self,
            from: Data(#"{"state":"ok","seat":{"id":"new","label":"New"}}"#.utf8))
        XCTAssertEqual(done.state, .ok)
        XCTAssertEqual(done.seat?.id, "new")

        // A state this client has never heard of is "still working", never "ok".
        let odd = try JSONDecoder().decode(SeatStatusReply.self, from: Data(#"{"state":"quantum"}"#.utf8))
        XCTAssertEqual(odd.state, .pending)
    }

    // MARK: - Bus events

    func testBusEventsParseFromFrames() throws {
        let updated = try MantaStreamFrame.parse(#"{"kind":"accounts.updated","payload":{"provider":"claude"}}"#)
        XCTAssertEqual(AccountsBusEvent.from(updated), .updated(provider: "claude"))

        let bare = try MantaStreamFrame.parse(#"{"kind":"accounts.updated"}"#)
        XCTAssertEqual(AccountsBusEvent.from(bare), .updated(provider: nil))

        let moved = try MantaStreamFrame.parse(
            #"{"kind":"accounts.moved","payload":{"sessionId":"ses_1","provider":"claude","from":"a","to":"b","reason":"exhausted"}}"#)
        let movedDetail = SeatMoveEvent(sessionId: "ses_1", provider: "claude", from: "a", to: "b", reason: "exhausted")
        XCTAssertEqual(AccountsBusEvent.from(moved), .moved(sessionId: "ses_1", provider: "claude", detail: movedDetail))
        XCTAssertEqual(AccountsBusEvent.from(moved)?.sessionId, "ses_1")

        let other = try MantaStreamFrame.parse(#"{"kind":"delegate.updated","payload":{"id":"j"}}"#)
        XCTAssertNil(AccountsBusEvent.from(other))
    }

    // MARK: - Seat-move notice (phase 4)

    func testMoveNoticeTextMatchesTheSpecSentences() {
        func text(_ reason: String?, trigger: SeatMoveTrigger? = nil, crossOrg: Bool? = nil, to: String? = "Work · Seat 2", from: String? = "Seat 1") -> String {
            AccountsSelectors.moveNoticeText(SeatMoveNoticeInput(reason: reason, fromLabel: from, toLabel: to, trigger: trigger, crossOrg: crossOrg))
        }
        XCTAssertEqual(text("load", trigger: SeatMoveTrigger(kind: "session", pct: 91)),
                       "Moved to Work · Seat 2 (Seat 1 at 91% of 5h).")
        XCTAssertEqual(text("exhausted", trigger: SeatMoveTrigger(kind: "weekly", pct: 90.6)),
                       "Moved to Work · Seat 2 (Seat 1 at 91% of the weekly limit).")
        XCTAssertEqual(text("load", trigger: SeatMoveTrigger(kind: "opus", pct: 92)),
                       "Moved to Work · Seat 2 (Seat 1 at 92%).")
        XCTAssertEqual(text("exhausted"), "Moved to Work · Seat 2 (Seat 1 was at its limit).")
        XCTAssertEqual(text("load"), "Moved to Work · Seat 2 (Seat 1 was near its limit).")
        XCTAssertEqual(text("unusable"), "Moved to Work · Seat 2 (Seat 1 needed sign-in).")
        XCTAssertEqual(text("manual", to: "Personal"), "Switched to Personal.")
    }

    func testMoveNoticeAppendsHistoryResentForACrossOrgMoveAndDegradesGracefully() {
        func text(_ input: SeatMoveNoticeInput) -> String { AccountsSelectors.moveNoticeText(input) }
        XCTAssertEqual(
            text(SeatMoveNoticeInput(reason: "load", fromLabel: "Seat 1", toLabel: "Personal",
                                     trigger: SeatMoveTrigger(kind: "session", pct: 91), crossOrg: true)),
            "Moved to Personal (Seat 1 at 91% of 5h). History re-sent.")
        XCTAssertEqual(text(SeatMoveNoticeInput(reason: "manual", toLabel: "Personal", crossOrg: true)),
                       "Switched to Personal. History re-sent.")
        // No labels / unknown reason / empty input: never a guess.
        XCTAssertEqual(text(SeatMoveNoticeInput(reason: "load", trigger: SeatMoveTrigger(kind: "session", pct: 91))),
                       "Moved to another seat.")
        XCTAssertEqual(text(SeatMoveNoticeInput(reason: "weird", fromLabel: "A", toLabel: "B")), "Moved to B.")
        XCTAssertEqual(text(SeatMoveNoticeInput()), "Moved to another seat.")
        XCTAssertEqual(text(SeatMoveNoticeInput(reason: "load", fromLabel: "A", toLabel: "  ")), "Moved to another seat (A was near its limit).")
    }

    func testSeatMoveDecodesTheOptionalPhaseFourFields() throws {
        let json = """
        {"provider":"claude","seatId":"seat-2","seatLabel":"Seat 2","accountLabel":"Work",
         "lastMove":{"from":"seat-1","fromLabel":"Seat 1","at":1750000000000,"reason":"load",
                     "trigger":{"kind":"session","pct":91},"crossOrg":true}}
        """
        let seat = try JSONDecoder().decode(SessionSeat.self, from: Data(json.utf8))
        XCTAssertEqual(seat.lastMove?.trigger, SeatMoveTrigger(kind: "session", pct: 91))
        XCTAssertEqual(seat.lastMove?.crossOrg, true)

        // An older box (no trigger / crossOrg), and a malformed trigger, still decode.
        let old = try JSONDecoder().decode(SessionSeat.self, from: Data(
            #"{"provider":"claude","seatId":"s","lastMove":{"from":"a","fromLabel":"A","at":1,"reason":"load"}}"#.utf8))
        XCTAssertNil(old.lastMove?.trigger)
        XCTAssertNil(old.lastMove?.crossOrg)
        let bad = try JSONDecoder().decode(SessionSeat.self, from: Data(
            #"{"provider":"claude","seatId":"s","lastMove":{"from":"a","fromLabel":"A","trigger":"nope","crossOrg":"yes"}}"#.utf8))
        XCTAssertNotNil(bad.lastMove)
        XCTAssertNil(bad.lastMove?.trigger)
    }

    func testMovedEventCarriesItsDetail() throws {
        let frame = try MantaStreamFrame.parse(
            #"{"kind":"accounts.moved","payload":{"sessionId":"ses_1","provider":"claude","from":"seat-1","to":"seat-2","reason":"load","fromLabel":"Seat 1","toLabel":"Work · Seat 2","trigger":{"kind":"weekly","pct":90},"crossOrg":true}}"#)
        guard case .moved(_, _, let detail?)? = AccountsBusEvent.from(frame) else { return XCTFail("expected a moved event with detail") }
        XCTAssertEqual(detail.sessionId, "ses_1")
        XCTAssertEqual(detail.to, "seat-2")
        XCTAssertEqual(detail.toLabel, "Work · Seat 2")
        XCTAssertEqual(detail.trigger, SeatMoveTrigger(kind: "weekly", pct: 90))
        XCTAssertEqual(detail.crossOrg, true)
    }

    private let moveNow = Date(timeIntervalSince1970: 1_750_000_000)

    private func movedSeat(atAgo seconds: Double, trigger: SeatMoveTrigger? = nil, crossOrg: Bool? = nil) -> SessionSeat {
        let atMs = (moveNow.timeIntervalSince1970 - seconds) * 1000
        return SessionSeat(
            provider: "claude", seatId: "seat-2", seatLabel: "Seat 2", accountLabel: "Work",
            lastMove: SeatMove(from: "seat-1", fromLabel: "Seat 1", at: atMs, reason: "load", trigger: trigger, crossOrg: crossOrg))
    }

    func testTrackerShowsARecentRecordOnOpenButNotAnOldOne() throws {
        let providers = try decodeList(listJSON)
        let tracker = SeatMoveTracker(hidden: [:], now: moveNow)
        let fresh = tracker.notice(sessionId: "ses_1", sessionSeat: movedSeat(atAgo: 10 * 60, trigger: SeatMoveTrigger(kind: "session", pct: 91)),
                                   providers: providers, now: moveNow)
        XCTAssertEqual(fresh?.text, "Moved to Work · Seat 2 (Seat 1 at 91% of 5h).")
        XCTAssertEqual(fresh?.key, "ses_1|seat-1|seat-2")

        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: movedSeat(atAgo: 31 * 60), providers: providers, now: moveNow))
        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: SessionSeat(provider: "claude", seatId: "seat-2"), providers: providers, now: moveNow))
        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow))
    }

    func testTrackerShowsABusEventForThisConversationOnly() throws {
        let providers = try decodeList(listJSON)
        var tracker = SeatMoveTracker(hidden: [:], now: moveNow)
        let event = SeatMoveEvent(sessionId: "ses_1", provider: "claude", from: "seat-1", to: "seat-3", reason: "exhausted", crossOrg: true)
        tracker.noteMoved(SeatMoveEvent(sessionId: "ses_other", from: "seat-1", to: "seat-3", reason: "load"), sessionId: "ses_1", now: moveNow)
        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow))

        tracker.noteMoved(event, sessionId: "ses_1", now: moveNow)
        // Names come from the live list: to = "Personal" (single-seat account), from = "Seat 1".
        XCTAssertEqual(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow)?.text,
                       "Moved to Personal (Seat 1 was at its limit). History re-sent.")
    }

    func testDismissalIsPerMoveAndSurvivesTheBoxRecordCatchingUp() throws {
        let providers = try decodeList(listJSON)
        var tracker = SeatMoveTracker(hidden: [:], now: moveNow)
        tracker.noteMoved(SeatMoveEvent(sessionId: "ses_1", provider: "claude", from: "seat-1", to: "seat-2",
                                        fromLabel: "Seat 1", toLabel: "Work · Seat 2", reason: "load"), sessionId: "ses_1", now: moveNow)
        let shown = try XCTUnwrap(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow))
        tracker.hide(shown.key, now: moveNow)
        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow))

        // The box's record of the SAME move arrives with its own clock: still hidden, never doubled.
        let record = movedSeat(atAgo: -1, trigger: SeatMoveTrigger(kind: "session", pct: 91))
        XCTAssertNil(tracker.notice(sessionId: "ses_1", sessionSeat: record, providers: providers, now: moveNow))

        // A DIFFERENT move (seat-2 → seat-3) is a new notice.
        tracker.noteMoved(SeatMoveEvent(sessionId: "ses_1", provider: "claude", from: "seat-2", to: "seat-3", reason: "manual"),
                          sessionId: "ses_1", now: moveNow)
        XCTAssertEqual(tracker.notice(sessionId: "ses_1", sessionSeat: nil, providers: providers, now: moveNow)?.text, "Switched to Personal.")
    }

    func testBusEventAndBoxRecordForOneMoveMergeIntoOneLine() throws {
        let providers = try decodeList(listJSON)
        var tracker = SeatMoveTracker(hidden: [:], now: moveNow)
        // The bus event had no trigger; the box's record (which arrives next) does.
        tracker.noteMoved(SeatMoveEvent(sessionId: "ses_1", provider: "claude", from: "seat-1", to: "seat-2", reason: "load"),
                          sessionId: "ses_1", now: moveNow)
        let notice = tracker.notice(
            sessionId: "ses_1",
            sessionSeat: movedSeat(atAgo: 0, trigger: SeatMoveTrigger(kind: "session", pct: 93)),
            providers: providers, now: moveNow)
        XCTAssertEqual(notice?.text, "Moved to Work · Seat 2 (Seat 1 at 93% of 5h).")
    }

    func testAHiddenMoveStaysHiddenAcrossReopeningButNotForever() throws {
        let providers = try decodeList(listJSON)
        let key = AccountsSelectors.moveNoticeKey(sessionId: "ses_1", from: "seat-1", to: "seat-2")
        var first = SeatMoveTracker(hidden: [:], now: moveNow)
        first.hide(key, now: moveNow)
        // "Reopen": a new tracker seeded from what the first persisted.
        let reopened = SeatMoveTracker(hidden: first.hidden, now: moveNow)
        XCTAssertNil(reopened.notice(sessionId: "ses_1", sessionSeat: movedSeat(atAgo: 60), providers: providers, now: moveNow))

        // A day later the entry is pruned away (it would be past the 30-minute window anyway).
        let later = moveNow.addingTimeInterval(SeatMoveTracker.hiddenRetentionSeconds + 1)
        XCTAssertTrue(SeatMoveTracker(hidden: first.hidden, now: later).hidden.isEmpty)
        XCTAssertEqual(SeatMoveTracker.pruned(["fresh": moveNow.timeIntervalSince1970, "junk": .nan], now: moveNow).keys.sorted(), ["fresh"])
    }

    func testAnEventForAnotherConversationNeverTouchesTheHiddenSet() {
        var tracker = SeatMoveTracker(hidden: ["ses_1|seat-1|seat-2": moveNow.timeIntervalSince1970], now: moveNow)
        tracker.noteMoved(SeatMoveEvent(sessionId: "ses_2", from: "seat-1", to: "seat-2"), sessionId: "ses_1", now: moveNow)
        XCTAssertEqual(tracker.hidden.count, 1)
        XCTAssertNil(tracker.live)
    }

    // MARK: - Load

    func testLoadPrefersTheBoxNumberThenFallsBackToTheInForceWindows() {
        XCTAssertEqual(AccountsSelectors.load(seat("a", windows: [win("session", 10)], load: 77)), 77)
        XCTAssertEqual(AccountsSelectors.load(seat("a", windows: [win("session", 30), win("weekly", 55)])), 55)
        // An inactive window and a scoped one never drive the load.
        XCTAssertEqual(AccountsSelectors.load(seat("a", windows: [win("session", 30), win("weekly", 95, active: false),
                                                                  win("weekly_scoped:fable", 99, scope: "Fable")])), 30)
        // No reading is "unknown", never a confident 0.
        XCTAssertNil(AccountsSelectors.load(seat("a")))
    }

    // MARK: - Conversation seat

    func testConversationSeatNamesAreAccountDotSeat() {
        let p = twoAccountProvider()
        let multi = AccountsSelectors.conversationSeat(
            providers: [p], sessionSeat: SessionSeat(provider: "claude", seatId: "s2", seatLabel: "Seat 2", accountLabel: "Work"))
        XCTAssertEqual(multi?.displayName, "Work · Seat 2")
        XCTAssertEqual(multi?.seat?.id, "s2")
        XCTAssertEqual(multi?.account?.id, "work")

        // A one-seat account is just the account label.
        let single = AccountsSelectors.conversationSeat(
            providers: [p], sessionSeat: SessionSeat(provider: "claude", seatId: "s3", seatLabel: "Me", accountLabel: "Personal"))
        XCTAssertEqual(single?.displayName, "Personal")
    }

    func testConversationSeatFallsBackToTheBoxLabelsWhenTheListLacksIt() {
        let conv = AccountsSelectors.conversationSeat(
            providers: [], sessionSeat: SessionSeat(provider: "claude", seatId: "gone", seatLabel: "Seat 9", accountLabel: "Old"))
        XCTAssertEqual(conv?.displayName, "Old · Seat 9")
        XCTAssertNil(conv?.seat)
        XCTAssertNil(AccountsSelectors.conversationSeat(providers: [], sessionSeat: nil))
    }

    func testTheSeatLayoutNeedsTwoSeatsAndTheConversationsOwnSeat() {
        let two = twoAccountProvider()
        let on = { (id: String) in
            AccountsSelectors.conversationSeat(
                providers: [two], sessionSeat: SessionSeat(provider: "claude", seatId: id, seatLabel: id, accountLabel: "Work"))
        }
        XCTAssertTrue(AccountsSelectors.usesSeatLayout(on("s1")))
        XCTAssertFalse(AccountsSelectors.usesSeatLayout(on("missing")), "seat not in the list → today's layout")
        XCTAssertFalse(AccountsSelectors.usesSeatLayout(nil))

        // One seat, one subscription looks exactly like today.
        let one = provider(accounts: [account("a", "Solo", seats: [seat("only")])])
        let conv = AccountsSelectors.conversationSeat(
            providers: [one], sessionSeat: SessionSeat(provider: "claude", seatId: "only", seatLabel: "only", accountLabel: "Solo"))
        XCTAssertFalse(AccountsSelectors.usesSeatLayout(conv))
    }

    func testTheDotReadsTheConversationsSeatWindow() {
        let s = seat("s1", windows: [win("weekly", 80), win("session", 12)])
        let p = provider(accounts: [account("a", "A", seats: [s, seat("s2")])])
        let conv = AccountsSelectors.conversationSeat(
            providers: [p], sessionSeat: SessionSeat(provider: "claude", seatId: "s1", seatLabel: "s1", accountLabel: "A"))
        XCTAssertEqual(AccountsSelectors.dotWindow(conv)?.pct, 12)

        // A seat with no 5h reading hands the dot back to the provider snapshot.
        let none = AccountsSelectors.conversationSeat(
            providers: [p], sessionSeat: SessionSeat(provider: "claude", seatId: "s2", seatLabel: "s2", accountLabel: "A"))
        XCTAssertNil(AccountsSelectors.dotWindow(none))
        XCTAssertNil(AccountsSelectors.dotWindow(nil))
    }

    // MARK: - Windows

    func testWindowRowsAreOrderedAndFlagInactiveScopedWindows() {
        let s = seat("s", windows: [
            win("weekly", 40, label: "Weekly"),
            win("weekly_scoped:old", 90, label: "Weekly · Old", scope: "Old", active: false),
            win("session", 12, label: "5h"),
            win("weekly_scoped:fable", 30, scope: "Fable"),
            win("daily", 5),
        ])
        let rows = AccountsSelectors.windowRows(s)
        XCTAssertEqual(rows.map(\.window.kind), ["session", "weekly", "daily", "weekly_scoped:fable", "weekly_scoped:old"])
        XCTAssertEqual(rows.map(\.inactive), [false, false, false, false, true])
        XCTAssertEqual(rows.map(\.title), ["5h", "Weekly", "daily", "Weekly · Fable", "Weekly · Old"])
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "row ids must be unique")
    }

    func testResetHintOnlyForAnInForceWindowAtOrOver90() {
        let hot = seat("s", windows: [win("session", 91, resetsAt: 1_750_000_000_000), win("weekly", 50, resetsAt: 1_750_100_000_000)])
        XCTAssertEqual(AccountsSelectors.resetHintWindow(hot)?.kind, "session")
        XCTAssertNil(AccountsSelectors.resetHintWindow(seat("s", windows: [win("session", 89.9, resetsAt: 1)])))
        XCTAssertNil(AccountsSelectors.resetHintWindow(seat("s", windows: [win("session", 95, resetsAt: 1, stale: true)])))
        XCTAssertNil(AccountsSelectors.resetHintWindow(seat("s", windows: [win("session", 95, active: false, resetsAt: 1)])))
    }

    // MARK: - Other seats

    func testOtherSeatGroupsHaveHeadingsOnlyWithTwoAccounts() {
        let groups = AccountsSelectors.otherSeatGroups(twoAccountProvider(), excluding: "s1")
        XCTAssertEqual(groups.map(\.heading), ["Work", "Personal"])
        XCTAssertEqual(groups[0].seats.map(\.id), ["s2"])
        XCTAssertEqual(groups[1].seats.map(\.id), ["s3"])

        let oneAccount = provider(accounts: [account("a", "A", seats: [seat("s1"), seat("s2"), seat("s3")])])
        let flat = AccountsSelectors.otherSeatGroups(oneAccount, excluding: "s2")
        XCTAssertEqual(flat.count, 1)
        XCTAssertNil(flat[0].heading)
        XCTAssertEqual(flat[0].seats.map(\.id), ["s1", "s3"])
    }

    func testAnAccountWhoseOnlySeatIsTheConversationsIsNotListed() {
        let groups = AccountsSelectors.otherSeatGroups(twoAccountProvider(), excluding: "s3")
        XCTAssertEqual(groups.map(\.id), ["work"])
    }

    func testTheNextTagIsAutomaticModeOnly() {
        let auto = twoAccountProvider(mode: .auto, next: "s2")
        XCTAssertTrue(AccountsSelectors.isNextSeat(seat("s2"), in: auto))
        XCTAssertFalse(AccountsSelectors.isNextSeat(seat("s3"), in: auto))
        let manual = twoAccountProvider(mode: .manual, next: "s2")
        XCTAssertFalse(AccountsSelectors.isNextSeat(seat("s2"), in: manual))
        let unset = twoAccountProvider(mode: .auto, next: nil)
        XCTAssertFalse(AccountsSelectors.isNextSeat(seat("s2"), in: unset))
    }

    func testRowActionByModeAndStatus() {
        let manual = twoAccountProvider(mode: .manual, active: "s1")
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s1"), in: manual), .inUse)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2"), in: manual), .use)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2", status: .unknown), in: manual), .use)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2", status: .expired), in: manual), .fix)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2", status: .signedOut), in: manual), .fix)

        let auto = twoAccountProvider(mode: .auto)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2"), in: auto), .readOnly)
        XCTAssertEqual(AccountsSelectors.rowAction(seat("s2", status: .expired), in: auto), .fix)

        // One seat has nothing to switch to, whatever the mode says.
        let solo = provider(mode: .manual, active: "only", accounts: [account("a", "A", seats: [seat("only")])])
        XCTAssertEqual(AccountsSelectors.rowAction(seat("only"), in: solo), .readOnly)
    }

    func testOnlyACrossAccountSwitchNeedsConfirmation() {
        let p = twoAccountProvider(active: "s1")
        XCTAssertFalse(AccountsSelectors.needsResendConfirmation(p, switchingTo: "s2"), "same account shares the cache")
        XCTAssertTrue(AccountsSelectors.needsResendConfirmation(p, switchingTo: "s3"))
        XCTAssertFalse(AccountsSelectors.needsResendConfirmation(p, switchingTo: "nope"))
        let noActive = twoAccountProvider(active: nil)
        XCTAssertFalse(AccountsSelectors.needsResendConfirmation(noActive, switchingTo: "s3"))
    }

    // MARK: - Other subscriptions

    func testBestSeatIsTheLeastLoadedUsableOne() {
        let p = provider("codex", accounts: [account("a", "A", seats: [
            seat("hot", load: 80),
            seat("cool", windows: [win("session", 12, label: "5h")], load: 12),
            seat("gone", status: .expired, load: 1),
            seat("blank"),
        ])])
        XCTAssertEqual(AccountsSelectors.bestSeat(p)?.id, "cool")
        XCTAssertEqual(AccountsSelectors.otherSubscriptionLine(p), "OpenAI · best seat 12% of 5h")
    }

    func testOtherSubscriptionLineWithoutAWindowOrAReading() {
        let loadOnly = provider("codex", accounts: [account("a", "A", seats: [seat("s", load: 30.4)])])
        XCTAssertEqual(AccountsSelectors.otherSubscriptionLine(loadOnly), "OpenAI · best seat 30% used")

        let unread = provider("codex", accounts: [account("a", "A", seats: [seat("s")])])
        XCTAssertEqual(AccountsSelectors.otherSubscriptionLine(unread), "OpenAI · no usage reading yet")

        let signedOut = provider("codex", accounts: [account("a", "A", seats: [seat("s", status: .signedOut)])])
        XCTAssertEqual(AccountsSelectors.otherSubscriptionLine(signedOut), "OpenAI · needs sign-in")
    }

    func testOtherProvidersExcludeTheConversationsOwn() {
        let claude = twoAccountProvider()
        let codex = provider("codex", accounts: [account("c", "C", seats: [seat("x")])])
        XCTAssertEqual(AccountsSelectors.otherProviders([claude, codex], than: "claude").map(\.provider), ["codex"])
        // Without a known conversation provider there is no "other".
        XCTAssertEqual(AccountsSelectors.otherProviders([claude, codex], than: nil), [])
    }

    func testFocusedProviderMovesToTheTop() {
        let a = provider("claude", accounts: [])
        let b = provider("codex", accounts: [])
        XCTAssertEqual(AccountsSelectors.ordered([a, b], focus: "codex").map(\.provider), ["codex", "claude"])
        XCTAssertEqual(AccountsSelectors.ordered([a, b], focus: "nope").map(\.provider), ["claude", "codex"])
        XCTAssertEqual(AccountsSelectors.ordered([a, b], focus: nil).map(\.provider), ["claude", "codex"])
    }

    // MARK: - Last move

    func testLastMoveLineIsShownOnlyWithinFiveHours() {
        let now = Date(timeIntervalSince1970: 1_750_000_000)
        let nowMs = 1_750_000_000_000.0
        let recent = SeatMove(from: "s0", fromLabel: "Seat 1", at: nowMs - 2 * 3600 * 1000, reason: "exhausted")
        XCTAssertEqual(AccountsSelectors.lastMoveLine(recent, now: now), "Moved from Seat 1 · seat was at its limit · 2h ago")

        let justNow = SeatMove(from: nil, fromLabel: "Seat 1", at: nowMs - 10_000, reason: nil)
        XCTAssertEqual(AccountsSelectors.lastMoveLine(justNow, now: now), "Moved from Seat 1 · just now")

        let old = SeatMove(from: "s0", fromLabel: "Seat 1", at: nowMs - 5 * 3600 * 1000 - 1000, reason: "exhausted")
        XCTAssertNil(AccountsSelectors.lastMoveLine(old, now: now))

        // No timestamp → no claim of recency.
        XCTAssertNil(AccountsSelectors.lastMoveLine(SeatMove(from: "s0", fromLabel: "Seat 1", at: nil, reason: nil), now: now))
        XCTAssertNil(AccountsSelectors.lastMoveLine(nil, now: now))
    }

    func testLastMoveFallsBackToTheSeatIdAndPrettifiesAnUnknownReason() {
        let now = Date(timeIntervalSince1970: 1_750_000_000)
        let move = SeatMove(from: "seat-0", fromLabel: "", at: 1_750_000_000_000 - 90 * 60 * 1000, reason: "load-balance_x")
        XCTAssertEqual(AccountsSelectors.lastMoveLine(move, now: now), "Moved from seat-0 · load balance x · 1h30m ago")
    }

    // MARK: - Labels + copy

    func testNormalizedLabelRules() {
        XCTAssertEqual(AccountsSelectors.normalizedLabel("  Work  "), "Work")
        XCTAssertNil(AccountsSelectors.normalizedLabel(""))
        XCTAssertNil(AccountsSelectors.normalizedLabel("   "))
        XCTAssertEqual(AccountsSelectors.normalizedLabel(String(repeating: "a", count: 40))?.count, 40)
        XCTAssertNil(AccountsSelectors.normalizedLabel(String(repeating: "a", count: 41)))
        XCTAssertNil(AccountsSelectors.normalizedLabel("a\u{0007}b"))
        XCTAssertNil(AccountsSelectors.normalizedLabel("two\nlines"))
        // Counted the way the box counts (UTF-16 units): 21 emoji is 42 units.
        XCTAssertNil(AccountsSelectors.normalizedLabel(String(repeating: "😀", count: 21)))
        XCTAssertNotNil(AccountsSelectors.normalizedLabel(String(repeating: "😀", count: 20)))
    }

    func testFailureCopyNamesTheActionAndTheReason() {
        XCTAssertEqual(AccountsCopy.failure("remove the seat", MantaError.server("live-seat")),
                       "Couldn't remove the seat — that is the box's live login — switch to another seat before removing it")
        XCTAssertEqual(AccountsCopy.reason(forCode: "invalid-label"), "names must be 1–40 characters")
        XCTAssertEqual(AccountsCopy.reason(forCode: "unknown-seat"), "that seat no longer exists — pull to refresh")
        XCTAssertEqual(AccountsCopy.reason(forCode: "login-failed"), "sign-in failed — try again")
        XCTAssertEqual(AccountsCopy.reason(for: MantaError.transport("x")), "check the connection and try again")
        XCTAssertEqual(AccountsCopy.reason(for: MantaError.authRequired), "the box rejected this device — pair it again")
        // A box that predates the feature answers with an unknown-channel error.
        XCTAssertEqual(AccountsCopy.reason(forCode: "unknown rpc channel: accounts:list"), AccountsCopy.staleBox)
        // Anything else is shown as the box sent it, never swallowed.
        XCTAssertEqual(AccountsCopy.reason(forCode: "disk on fire"), "disk on fire")
        XCTAssertEqual(AccountsCopy.reason(forCode: "  "), "something went wrong — try again")
    }

    func testSmallFormatters() {
        XCTAssertEqual(AccountsSelectors.percent(42.4), "42%")
        XCTAssertEqual(AccountsSelectors.percent(142), "100%")
        XCTAssertEqual(AccountsSelectors.percent(.nan), "–")
        XCTAssertEqual(AccountsSelectors.conversationsText(0), nil)
        XCTAssertEqual(AccountsSelectors.conversationsText(1), "1 conversation")
        XCTAssertEqual(AccountsSelectors.conversationsText(3), "3 conversations")
        XCTAssertEqual(AccountsSelectors.seatSubtitle(seat("s", email: "a@x.com"), plan: "Max"), "a@x.com · Max")
        XCTAssertEqual(AccountsSelectors.seatSubtitle(seat("s"), plan: nil), nil)
        XCTAssertEqual(AccountsSelectors.providerName("claude"), "Claude")
        XCTAssertEqual(AccountsSelectors.providerName("codex"), "OpenAI")
        XCTAssertEqual(AccountsSelectors.statusText(.expired), "Expired")
        XCTAssertEqual(AccountsSelectors.statusText(.signedOut), "Signed out")
        XCTAssertNil(AccountsSelectors.statusText(.ok))
        XCTAssertNil(AccountsSelectors.statusText(.unknown))
        XCTAssertEqual(AccountsCopy.usingSeat("Seat 3"), "All conversations now use Seat 3")
    }
}
