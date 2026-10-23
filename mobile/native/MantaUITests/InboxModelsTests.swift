import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MantaUI

// ===========================================================================
// Pending messages — the pure layer (InboxModels.swift + the outbox additions
// in PendingPrompt.swift). No view, no HTTP, no box.
//
//   - decoding: a frame / RPC payload is narrowed leniently; unknown values and
//     malformed items never crash and never cost the rest of the list;
//   - the K3 client acceptance rule (port of src/renderer/inboxState.test.ts);
//   - what a send-while-running outcome means (refused vs uncertain);
//   - what the pending card shows;
//   - the durable outbox's busy-send rows.
// ===========================================================================

private func json(_ text: String) -> JSONValue? {
    try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

private func item(_ id: String, text: String = "", delivery: InboxDelivery = .steer, attachments: Int = 0) -> InboxItem {
    InboxItem(id: id, text: text.isEmpty ? id : text, delivery: delivery, createdAt: 1, attachmentCount: attachments)
}

private func snap(_ epoch: String, _ rev: Int, _ ids: String...) -> InboxSnapshot {
    InboxSnapshot(epoch: epoch, rev: rev, items: ids.map { item($0) })
}

// MARK: - Decoding

final class InboxDecodingTests: XCTestCase {

    func testWellFormedSnapshotDecodes() {
        let value = json(#"""
        {"epoch":"e1","rev":7,"items":[
          {"id":"msg_a","text":"hello","delivery":"steer","createdAt":1700000000000,"attachmentCount":2},
          {"id":"msg_b","text":"later","delivery":"queue","createdAt":1700000000500,"attachmentCount":0}
        ]}
        """#)
        let snapshot = InboxSnapshot.parse(value)
        XCTAssertEqual(snapshot?.epoch, "e1")
        XCTAssertEqual(snapshot?.rev, 7)
        XCTAssertEqual(snapshot?.items.map(\.id), ["msg_a", "msg_b"])
        XCTAssertEqual(snapshot?.items.map(\.delivery), [.steer, .queue])
        XCTAssertEqual(snapshot?.items.first?.attachmentCount, 2)
        XCTAssertEqual(snapshot?.items.first?.text, "hello")
    }

    func testEmptyListIsAValidSnapshot() {
        XCTAssertEqual(InboxSnapshot.parse(json(#"{"epoch":"e","rev":1,"items":[]}"#))?.items, [])
    }

    func testPayloadsThatAreNotSnapshotsAreRejected() {
        let bad: [String?] = [
            nil, "5", "\"x\"", "null", "{}",
            #"{"epoch":"","rev":1,"items":[]}"#,
            #"{"epoch":"e","rev":"1","items":[]}"#,
            #"{"epoch":"e","rev":1}"#,
            #"{"epoch":"e","rev":1,"items":"nope"}"#,
            #"{"rev":1,"items":[]}"#,
        ]
        for text in bad {
            XCTAssertNil(InboxSnapshot.parse(text.flatMap { json($0) }), "must reject \(text ?? "nil")")
        }
    }

    /// A rev that is not a representable integer must reject the payload, not
    /// trap — `Int(_:)` on a huge double is a runtime crash.
    func testAbsurdRevRejectedWithoutTrapping() {
        XCTAssertNil(InboxSnapshot.parse(json(#"{"epoch":"e","rev":1e300,"items":[]}"#)))
        XCTAssertNil(InboxSnapshot.parse(json(#"{"epoch":"e","rev":1.5,"items":[]}"#)))
        let parsed = InboxItem.parse(json(#"{"id":"m","attachmentCount":1e300}"#))
        XCTAssertEqual(parsed?.attachmentCount, 0, "an unrepresentable count degrades to 0")
    }

    func testMalformedItemsAreSkippedAndTheRestKept() {
        let snapshot = InboxSnapshot.parse(json(#"""
        {"epoch":"e","rev":1,"items":[
          {"id":"a","text":"ok","delivery":"steer"}, null, 5, {"text":"no id"}, {"id":""}, {"id":"b"}
        ]}
        """#))
        XCTAssertEqual(snapshot?.items.map(\.id), ["a", "b"])
    }

    func testUnknownDeliveryAndExtraFieldsAreTolerated() {
        let parsed = InboxItem.parse(json(#"{"id":"m","text":"t","delivery":"interrupt","novel":{"x":1},"createdAt":3}"#))
        XCTAssertEqual(parsed?.delivery, .other("interrupt"))
        XCTAssertEqual(parsed?.delivery.wire, "interrupt", "an unknown delivery round-trips verbatim")
        XCTAssertEqual(parsed?.createdAt, 3)
    }

    func testMissingOptionalFieldsFallBack() {
        let parsed = InboxItem.parse(json(#"{"id":"m"}"#))
        XCTAssertEqual(parsed?.text, "")
        XCTAssertEqual(parsed?.delivery, .other(""))
        XCTAssertEqual(parsed?.attachmentCount, 0)
        XCTAssertEqual(parsed?.createdAt, 0)
    }

    func testDeliveryWireRoundTrip() {
        XCTAssertEqual(InboxDelivery(wire: "steer"), .steer)
        XCTAssertEqual(InboxDelivery(wire: "queue"), .queue)
        XCTAssertEqual(InboxDelivery.steer.wire, "steer")
        XCTAssertEqual(InboxDelivery.queue.wire, "queue")
    }

    func testSnapshotDecodesThroughJSONDecoder() throws {
        let data = Data(#"{"epoch":"e","rev":2,"items":[{"id":"a"}]}"#.utf8)
        let decoded = try JSONDecoder().decode(InboxSnapshot.self, from: data)
        XCTAssertEqual(decoded.rev, 2)
        XCTAssertThrowsError(try JSONDecoder().decode(InboxSnapshot.self, from: Data(#"{"epoch":"e"}"#.utf8)),
                             "a payload without the stamp must fail to decode, not produce an empty list")
    }

    // MARK: Action replies

    func testCancelResultDecodesAllOutcomesAndUnknownString() throws {
        func decode(_ text: String) throws -> InboxCancelResult {
            try JSONDecoder().decode(InboxCancelResult.self, from: Data(text.utf8))
        }
        XCTAssertEqual(try decode(#"{"outcome":"cancelled","item":{"id":"m","text":"t","delivery":"queue"}}"#).outcome, .cancelled)
        XCTAssertEqual(try decode(#"{"outcome":"cancelled","item":{"id":"m","text":"t","delivery":"queue"}}"#).item?.id, "m")
        XCTAssertEqual(try decode(#"{"outcome":"delivered"}"#).outcome, .delivered)
        XCTAssertEqual(try decode(#"{"outcome":"unknown"}"#).outcome, .unknown)
        XCTAssertEqual(try decode(#"{"outcome":"vaporised"}"#).outcome, .unknown, "an outcome from a newer box is 'couldn't confirm'")
        XCTAssertEqual(try decode(#"{}"#).outcome, .unknown)
        XCTAssertEqual(try decode(#"{"outcome":"cancelled","item":"garbage"}"#).item, nil)
    }

    func testSetDeliveryResultDecodesAllOutcomesAndUnknownString() throws {
        func decode(_ text: String) throws -> InboxSetDeliveryResult {
            try JSONDecoder().decode(InboxSetDeliveryResult.self, from: Data(text.utf8))
        }
        XCTAssertEqual(try decode(#"{"outcome":"changed"}"#).outcome, .changed)
        XCTAssertEqual(try decode(#"{"outcome":"delivered"}"#).outcome, .delivered)
        XCTAssertEqual(try decode(#"{"outcome":"unknown"}"#).outcome, .unknown)
        XCTAssertEqual(try decode(#"{"outcome":"teleported"}"#).outcome, .unknown)
        XCTAssertEqual(try decode(#"{"outcome":7}"#).outcome, .unknown)
    }

    func testEveryNonSilentOutcomeHasAVisibleMessage() {
        XCTAssertNil(InboxActionReport.cancel(InboxCancelResult(outcome: .cancelled)),
                     "a cancelled message needs no words: the row leaves")
        XCTAssertEqual(InboxActionReport.cancel(InboxCancelResult(outcome: .delivered)), "Already sent to the agent")
        XCTAssertEqual(InboxActionReport.cancel(InboxCancelResult(outcome: .unknown)),
                       "Couldn't confirm it was cancelled — it may still be sent")
        XCTAssertNil(InboxActionReport.setDelivery(InboxSetDeliveryResult(outcome: .changed)),
                     "`changed` is confirmed by the next inbox frame")
        XCTAssertEqual(InboxActionReport.setDelivery(InboxSetDeliveryResult(outcome: .delivered)), "Already sent to the agent")
        XCTAssertEqual(InboxActionReport.setDelivery(InboxSetDeliveryResult(outcome: .unknown)),
                       "Couldn't confirm the change — check the pending list")
        XCTAssertFalse(InboxActionReport.cancelFailed.isEmpty)
        XCTAssertFalse(InboxActionReport.setDeliveryFailed.isEmpty)
    }
}

// MARK: - K3 acceptance rule

final class InboxAcceptanceTests: XCTestCase {

    func testFirstPayloadIsShown() {
        var retired = Set<String>()
        let r = InboxAcceptance.accept(shown: nil, incoming: snap("e", 1, "a"), retired: &retired)
        XCTAssertTrue(r.accepted)
        XCTAssertEqual(r.next?.items.map(\.id), ["a"])
    }

    func testSameEpochOnlyAHigherRevReplaces() {
        var retired = Set<String>()
        let shown = snap("e", 5, "a")
        XCTAssertFalse(InboxAcceptance.accept(shown: shown, incoming: snap("e", 5, "b"), retired: &retired).accepted)
        XCTAssertFalse(InboxAcceptance.accept(shown: shown, incoming: snap("e", 4, "b"), retired: &retired).accepted)
        let r = InboxAcceptance.accept(shown: shown, incoming: snap("e", 6, "b"), retired: &retired)
        XCTAssertTrue(r.accepted)
        XCTAssertEqual(r.next?.items.first?.id, "b")
    }

    func testNewNonRetiredEpochReplacesEvenAtLowerRevAndRetiresThePreviousEpoch() {
        var retired = Set<String>()
        let r = InboxAcceptance.accept(shown: snap("old", 50, "a"), incoming: snap("new", 1, "b"), retired: &retired)
        XCTAssertTrue(r.accepted)
        XCTAssertTrue(retired.contains("old"))
    }

    func testRetiredEpochIsAlwaysDropped() {
        var retired: Set<String> = ["old"]
        XCTAssertFalse(InboxAcceptance.accept(shown: snap("new", 1, "b"), incoming: snap("old", 999, "z"), retired: &retired).accepted)
        XCTAssertFalse(InboxAcceptance.accept(shown: nil, incoming: snap("old", 1, "z"), retired: &retired).accepted)
    }

    func testNilIncomingChangesNothing() {
        var retired = Set<String>()
        let shown = snap("e", 1, "a")
        let r = InboxAcceptance.accept(shown: shown, incoming: nil, retired: &retired)
        XCTAssertFalse(r.accepted)
        XCTAssertEqual(r.next, shown)
    }

    /// A session shown from the OLD server must not be able to resurrect once a
    /// DIFFERENT session has already seen the new epoch: the retired set is
    /// shared client-wide.
    func testRetiredEpochsAreSharedAcrossTrackers() {
        var retired = Set<String>()
        var a = InboxTracker()
        var b = InboxTracker()
        XCTAssertTrue(a.offerFrame(json(#"{"epoch":"old","rev":9,"items":[]}"#), retired: &retired))
        XCTAssertTrue(a.offerFrame(json(#"{"epoch":"new","rev":1,"items":[]}"#), retired: &retired))
        XCTAssertFalse(b.offerFrame(json(#"{"epoch":"old","rev":99,"items":[]}"#), retired: &retired),
                       "tracker b never saw the old epoch, but a's move to the new one retired it for everyone")
    }
}

// MARK: - Tracker (requests, resync, dispose)

final class InboxTrackerTests: XCTestCase {

    func testFrameReplacesOnlyWhenAccepted() {
        var retired = Set<String>()
        var t = InboxTracker()
        XCTAssertTrue(t.offerFrame(json(#"{"epoch":"e","rev":1,"items":[{"id":"a"}]}"#), retired: &retired))
        XCTAssertFalse(t.offerFrame(json(#"{"epoch":"e","rev":1,"items":[{"id":"b"}]}"#), retired: &retired))
        XCTAssertTrue(t.offerFrame(json(#"{"epoch":"e","rev":2,"items":[]}"#), retired: &retired))
        XCTAssertEqual(t.shown?.items.map(\.id), [])
    }

    func testGarbageFrameChangesNothing() {
        var retired = Set<String>()
        var t = InboxTracker()
        XCTAssertTrue(t.offerFrame(json(#"{"epoch":"e","rev":1,"items":[{"id":"a"}]}"#), retired: &retired))
        XCTAssertFalse(t.offerFrame(json(#"{"epoch":"e"}"#), retired: &retired))
        XCTAssertFalse(t.offerFrame(nil, retired: &retired))
        XCTAssertEqual(t.shown?.items.map(\.id), ["a"])
    }

    /// An `opencode:inbox` answer asked for before the events socket reconnected
    /// may be a dead server's word: it is dropped, the one asked after is kept.
    func testResponseRequestedBeforeResyncIsDropped() {
        var retired = Set<String>()
        var t = InboxTracker()
        let before = t.beginRequest()
        t.markResync()
        let after = t.beginRequest()
        XCTAssertTrue(t.offerResponse(stamp: after, snapshot: snap("new", 1, "fresh"), retired: &retired))
        XCTAssertFalse(t.offerResponse(stamp: before, snapshot: snap("dead", 99, "stale"), retired: &retired))
        XCTAssertEqual(t.shown?.items.map(\.id), ["fresh"])
        XCTAssertFalse(retired.contains("new"), "nothing was retired by a dropped answer")
    }

    func testResponseIssuedAfterTheResyncIsAccepted() {
        var retired = Set<String>()
        var t = InboxTracker()
        t.markResync()
        XCTAssertTrue(t.offerResponse(stamp: t.beginRequest(), snapshot: snap("e", 1, "a"), retired: &retired))
    }

    func testResponseWithNoSnapshotChangesNothing() {
        var retired = Set<String>()
        var t = InboxTracker()
        XCTAssertFalse(t.offerResponse(stamp: t.beginRequest(), snapshot: nil, retired: &retired))
    }

    func testDisposedTrackerAcceptsNothing() {
        var retired = Set<String>()
        var t = InboxTracker()
        let stamp = t.beginRequest()
        t.dispose()
        XCTAssertFalse(t.offerResponse(stamp: stamp, snapshot: snap("e", 1, "a"), retired: &retired))
        XCTAssertFalse(t.offerFrame(json(#"{"epoch":"e","rev":2,"items":[]}"#), retired: &retired))
        XCTAssertNil(t.shown)
    }
}

// MARK: - Send-while-running outcomes

final class BusySendClassifierTests: XCTestCase {

    func testDefiniteRefusalIsA4xxTheBoxReports() {
        let outcome = BusySendClassifier.classify(MantaError.server("opencode sendPrompt 400: {\"message\":\"bad id\"}"))
        guard case .refused(let reason) = outcome else { return XCTFail("expected refused, got \(outcome)") }
        XCTAssertTrue(reason.contains("400"))
        XCTAssertTrue(reason.contains("bad id"), "the refusal's own words reach the user")
        XCTAssertEqual(BusySendClassifier.opencodeStatus(in: "opencode sendPrompt 422: x"), 422)
        if case .refused = BusySendClassifier.classify(MantaError.server("opencode sendPrompt 429: slow down")) {} else { XCTFail("429 is a refusal") }
    }

    func testAnEmptyRefusalBodyStillGetsAReason() {
        guard case .refused(let reason) = BusySendClassifier.classify(MantaError.server("opencode sendPrompt 404:")) else {
            return XCTFail("expected refused")
        }
        XCTAssertFalse(reason.isEmpty)
    }

    func testALongRefusalBodyIsClipped() {
        let long = String(repeating: "x", count: 500)
        guard case .refused(let reason) = BusySendClassifier.classify(MantaError.server("opencode sendPrompt 400: \(long)")) else {
            return XCTFail("expected refused")
        }
        XCTAssertLessThan(reason.count, 200)
    }

    func testAuthRequiredIsARefusal() {
        if case .refused = BusySendClassifier.classify(MantaError.authRequired) {} else { XCTFail("401 was not admitted") }
    }

    func testServerErrorsTimeoutsAndNetworkFailuresAreUncertain() {
        let uncertain: [Error] = [
            MantaError.server("opencode sendPrompt 500: boom"),
            MantaError.server("opencode sendPrompt 503: unavailable"),
            MantaError.server("This operation was aborted"),
            MantaError.server("box upgrading"),
            MantaError.server("some message from a newer box"),
            MantaError.server(""),
            MantaError.transport("invalid rpc envelope"),
            MantaError.transport("timed out"),
            MantaError.storedButUntranscribed(noteID: "n"),
            URLError(.timedOut),
            URLError(.notConnectedToInternet),
            URLError(.networkConnectionLost),
            CancellationError(),
        ]
        for error in uncertain {
            XCTAssertEqual(BusySendClassifier.classify(error), .uncertain, "\(error) gives no verdict")
        }
    }

    /// A status that is not a clean three-digit code must never read as a 4xx.
    func testMalformedStatusIsUncertain() {
        for message in ["opencode sendPrompt 40: x", "opencode sendPrompt 4000: x", "opencode sendPrompt abc: x",
                        "opencode sendPrompt : x", "opencode sendPrompt", "sendPrompt 400: x", "OPENCODE sendPrompt 400: x"] {
            XCTAssertEqual(BusySendClassifier.classify(MantaError.server(message)), .uncertain, message)
        }
    }

    func testStatusOutside4xxIsUncertain() {
        XCTAssertEqual(BusySendClassifier.classify(MantaError.server("opencode sendPrompt 399: x")), .uncertain)
        XCTAssertEqual(BusySendClassifier.classify(MantaError.server("opencode sendPrompt 500: x")), .uncertain)
        XCTAssertEqual(BusySendClassifier.classify(MantaError.server("opencode sendPrompt 200: x")), .uncertain)
    }
}

// MARK: - The pending card

final class PendingCardLogicTests: XCTestCase {

    func testNowRowShowsCaptionAndWaitNotSendNow() {
        let rows = PendingCardLogic.rows(items: [item("a", delivery: .steer)], running: true)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].badge, .now)
        XCTAssertEqual(rows[0].caption, "at next step")
        XCTAssertTrue(rows[0].offersWait)
        XCTAssertFalse(rows[0].offersSendNow)
    }

    func testNowRowSaysRunsNextOnceTheAgentHasStopped() {
        XCTAssertEqual(PendingCardLogic.rows(items: [item("a", delivery: .steer)], running: false)[0].caption, "runs next")
    }

    func testAfterRowOffersSendNowAndNoCaption() {
        let rows = PendingCardLogic.rows(items: [item("a", delivery: .queue)], running: true)
        XCTAssertEqual(rows[0].badge, .afterThisTurn)
        XCTAssertNil(rows[0].caption)
        XCTAssertFalse(rows[0].offersWait)
        XCTAssertTrue(rows[0].offersSendNow)
    }

    func testUnknownDeliveryRendersNeutrallyWithOnlyCancel() {
        let rows = PendingCardLogic.rows(items: [item("a", delivery: .other("interrupt"))], running: true)
        XCTAssertEqual(rows[0].badge, .other("interrupt"))
        XCTAssertFalse(rows[0].offersWait)
        XCTAssertFalse(rows[0].offersSendNow)
        XCTAssertNil(rows[0].caption)
    }

    func testRowsKeepTheBoxsOrder() {
        let rows = PendingCardLogic.rows(items: [item("c"), item("a", delivery: .queue), item("b")], running: true)
        XCTAssertEqual(rows.map(\.id), ["c", "a", "b"], "no reordering (D-A2)")
    }

    func testHeaderPluralises() {
        XCTAssertEqual(PendingCardLogic.header(count: 1), "Pending · 1 message")
        XCTAssertEqual(PendingCardLogic.header(count: 2), "Pending · 2 messages")
    }

    func testStoppedFooterNeedsAStoppedAgentAndAnAfterItem() {
        let now = item("a", delivery: .steer)
        let after = item("b", delivery: .queue)
        XCTAssertTrue(PendingCardLogic.showsStoppedFooter(items: [now, after], running: false))
        XCTAssertFalse(PendingCardLogic.showsStoppedFooter(items: [now, after], running: true))
        XCTAssertFalse(PendingCardLogic.showsStoppedFooter(items: [now], running: false),
                       "a Now item runs next by itself — nothing is stuck waiting")
        XCTAssertFalse(PendingCardLogic.showsStoppedFooter(items: [], running: false))
        XCTAssertEqual(PendingCardLogic.stoppedFooter, "Agent stopped — these are waiting. Send now, or ×.")
    }

    func testTextIsCollapsedToOneLine() {
        XCTAssertEqual(PendingCardLogic.singleLine("first\nsecond\r\n\n  third  "), "first second third")
        XCTAssertEqual(PendingCardLogic.singleLine("   "), "")
        XCTAssertEqual(PendingCardLogic.rows(items: [item("a", text: "one\ntwo")], running: true)[0].text, "one two")
    }

    func testAttachmentCountCarriesThrough() {
        XCTAssertEqual(PendingCardLogic.rows(items: [item("a", attachments: 3)], running: true)[0].attachmentCount, 3)
    }
}

// MARK: - The durable outbox's busy-send rows

final class PendingPromptBusySendTests: XCTestCase {

    private let suiteName = "InboxModelsTests.PendingPrompt"
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func row(
        _ id: String,
        session: String = "ses",
        state: PendingPrompt.State,
        messageID: String? = nil,
        delivery: String? = nil
    ) -> PendingPrompt {
        PendingPrompt(
            id: id, sessionId: session, text: id, attachments: [], model: nil, mentions: nil, agent: nil,
            state: state, messageID: messageID, delivery: delivery
        )
    }

    func testMintedMessageIDsCarryTheV2PrefixAndAreUnique() {
        let ids = (0..<50).map { _ in PendingPrompt.mintMessageID() }
        XCTAssertTrue(ids.allSatisfy { $0.hasPrefix("msg_") })
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    /// Rows persisted by an app version that predates busy-send have none of the
    /// new fields: they must still load.
    func testOldPersistedRowsStillDecode() {
        let old = #"[{"id":"i","sessionId":"s","text":"t","attachments":[],"state":"failed"}]"#
        defaults.set(Data(old.utf8), forKey: PendingPromptStore.defaultsKey)
        let loaded = PendingPromptStore.load(defaults)
        XCTAssertEqual(loaded.count, 1)
        XCTAssertNil(loaded[0].messageID)
        XCTAssertNil(loaded[0].delivery)
        XCTAssertFalse(loaded[0].isBusySend)
    }

    func testBusyRowRoundTripsWithItsIdentity() {
        let original = PendingPrompt(
            id: "i", sessionId: "s", text: "t", attachments: [], model: nil, mentions: nil, agent: nil,
            state: .failed, messageID: "msg_abc", delivery: "queue", failureReason: "the box refused it (400)"
        )
        PendingPromptStore.save([original], to: defaults)
        XCTAssertEqual(PendingPromptStore.load(defaults), [original])
        XCTAssertTrue(PendingPromptStore.load(defaults)[0].isBusySend)
    }

    func testRelaunchTurnsASendingRowWithAnIdIntoUncertainNotFailed() {
        PendingPromptStore.save([
            row("busy", state: .sending, messageID: "msg_1", delivery: "steer"),
            row("idle-sending", state: .sending),
            row("waiting", state: .waiting),
            row("uncertain", state: .uncertain, messageID: "msg_2", delivery: "queue"),
            row("failed", state: .failed, messageID: "msg_3", delivery: "queue"),
        ], to: defaults)
        let migrated = PendingPromptStore.failStaleOnLaunch(defaults)
        XCTAssertEqual(migrated.map(\.state), [.uncertain, .failed, .failed, .uncertain, .failed],
                       "a busy send may have landed before the process died; a row with no id cannot be told apart, so it stays failed")
    }

    // MARK: settling

    func testUncertainRowVanishesWhenItsIdShowsUp() {
        let rows = [row("a", state: .uncertain, messageID: "msg_a", delivery: "steer"),
                    row("b", state: .uncertain, messageID: "msg_b", delivery: "steer")]
        XCTAssertEqual(PendingPromptStore.settling(rows, seenIDs: ["msg_a"]).map(\.id), ["b"])
    }

    func testSendingRowVanishesWhenAFrameBeatsTheResponse() {
        let rows = [row("a", state: .sending, messageID: "msg_a", delivery: "steer")]
        XCTAssertEqual(PendingPromptStore.settling(rows, seenIDs: ["msg_a"]), [])
    }

    func testFailedAndWaitingRowsAreNeverSettledByAnId() {
        let rows = [row("f", state: .failed, messageID: "msg_f", delivery: "steer"),
                    row("w", state: .waiting, messageID: "msg_w")]
        XCTAssertEqual(PendingPromptStore.settling(rows, seenIDs: ["msg_f", "msg_w"]).map(\.id), ["f", "w"],
                       "a definite refusal cannot be undone by an id, and a waiting row never left the device")
    }

    func testRowsWithoutAnIdAreNeverSettled() {
        let rows = [row("a", state: .sending)]
        XCTAssertEqual(PendingPromptStore.settling(rows, seenIDs: ["msg_a", "a"]), rows)
    }

    func testSettlingWithNothingSeenIsANoOp() {
        let rows = [row("a", state: .uncertain, messageID: "msg_a", delivery: "steer")]
        XCTAssertEqual(PendingPromptStore.settling(rows, seenIDs: []), rows)
    }

    // MARK: persist (per-session)

    func testPersistingOneSessionKeepsTheOthersRows() {
        let other = row("other", session: "ses-2", state: .uncertain, messageID: "msg_o", delivery: "steer")
        PendingPromptStore.save([other, row("old", session: "ses", state: .failed)], to: defaults)
        PendingPromptStore.persist([row("new", session: "ses", state: .uncertain, messageID: "msg_n", delivery: "queue")],
                                   sessionId: "ses", to: defaults)
        let loaded = PendingPromptStore.load(defaults)
        XCTAssertEqual(loaded.map(\.id), ["other", "new"], "the other session's retry row survives; this session's rows are replaced")
    }

    func testPersistingAnEmptySessionRemovesOnlyItsRows() {
        PendingPromptStore.save([row("a", session: "ses", state: .failed), row("b", session: "ses-2", state: .failed)], to: defaults)
        PendingPromptStore.persist([], sessionId: "ses", to: defaults)
        XCTAssertEqual(PendingPromptStore.load(defaults).map(\.id), ["b"])
    }

    // MARK: notices

    func testNoticesName() {
        XCTAssertEqual(PendingPromptNotice.uncertain, "May have been sent — tap to retry")
        XCTAssertEqual(PendingPromptNotice.failed(reason: nil), "Couldn't send — tap to retry")
        XCTAssertEqual(PendingPromptNotice.failed(reason: ""), "Couldn't send — tap to retry")
        XCTAssertEqual(PendingPromptNotice.failed(reason: "the box refused it (400)"),
                       "Couldn't send: the box refused it (400) — tap to retry")
    }

    // MARK: the request the busy send makes

    func testSendPromptInputCarriesIdentityAndDelivery() {
        let input = SendPromptInput(sessionId: "s", text: "t", messageID: "msg_x", delivery: "steer")
        XCTAssertEqual(input.messageID, "msg_x")
        XCTAssertEqual(input.delivery, "steer")
        let idle = SendPromptInput(sessionId: "s", text: "t")
        XCTAssertNil(idle.messageID)
        XCTAssertNil(idle.delivery)
    }
}
