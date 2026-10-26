import XCTest
@testable import MantaUI

// Auto-handoff — the pure half (spec 2026-10-26-auto-handoff §3, §6.4, §7, §8,
// §9, §11, §15): wire decoding, the tool-part marker, badge/enablement/pinning,
// the "should this chat switch" decision, draft + composer carry-over, mode, the
// previous-sessions list. No view, no box.

private final class MemoryKV: HandoffKeyValueStore {
    var values: [String: String] = [:]
    func string(forKey key: String) -> String? { values[key] }
    func set(_ value: String?, forKey key: String) { values[key] = value }
}

private struct Chip: Identifiable, Equatable {
    let id: Int
    let name: String
}

final class HandoffModelsTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func record(
        _ id: String = "hof_1",
        from: String = "ses_a",
        successor: String? = nil,
        trigger: String = "user",
        state: HandoffState,
        how: String? = nil,
        disposition: String? = nil,
        text: String = "## Goal\nship it",
        createdAt: Double? = nil
    ) -> HandoffRecord {
        HandoffRecord(id: id, fromSessionId: from, successorId: successor, trigger: trigger, state: state,
                      how: how, disposition: disposition, text: text, createdAt: createdAt)
    }

    // MARK: - Decoding

    func testRecordDecodesTheContractShape() throws {
        let r = try decode(HandoffRecord.self, """
        {"id":"hof_abc","fromSessionId":"ses_a","successorId":"ses_b","messageId":"msg_1","kind":"auto",
         "trigger":"agent","state":"committed","step":"commit","how":"clear","disposition":"send",
         "text":"## Goal\\nx","reason":null,"createdAt":1700000000000,"updatedAt":1700000001000}
        """)
        XCTAssertEqual(r.id, "hof_abc")
        XCTAssertEqual(r.fromSessionId, "ses_a")
        XCTAssertEqual(r.successorId, "ses_b")
        XCTAssertEqual(r.state, .committed)
        XCTAssertEqual(r.how, "clear")
        XCTAssertEqual(r.disposition, "send")
        XCTAssertEqual(r.trigger, "agent")
        XCTAssertNil(r.reason)
        XCTAssertEqual(r.createdAt, 1_700_000_000_000)
    }

    func testRecordToleratesMissingFieldsAndUnknownState() throws {
        let r = try decode(HandoffRecord.self, #"{"id":"hof_x","state":"hibernating"}"#)
        XCTAssertEqual(r.state, .other("hibernating"))
        XCTAssertEqual(r.fromSessionId, "")
        XCTAssertEqual(r.text, "")
        XCTAssertNil(r.successorId)
        // An empty successor id is "none", not a session.
        let e = try decode(HandoffRecord.self, #"{"id":"hof_y","state":"ready","successorId":""}"#)
        XCTAssertNil(e.successorId)
    }

    func testEnvelopeAcceptsWrappedAndBareRecord() throws {
        let wrapped = try decode(HandoffEnvelope.self, #"{"handoff":{"id":"hof_1","state":"ready","text":"t"}}"#)
        XCTAssertEqual(wrapped.handoff.id, "hof_1")
        let bare = try decode(HandoffEnvelope.self, #"{"id":"hof_2","state":"failed","reason":"nope"}"#)
        XCTAssertEqual(bare.handoff.id, "hof_2")
        XCTAssertEqual(bare.handoff.reason, "nope")
    }

    func testListDropsAMalformedRecordButKeepsTheRest() throws {
        let list = try decode(HandoffListResult.self, """
        {"records":[{"id":"hof_1","state":"ready"},{"state":"ready"},{"id":"hof_3","state":"failed"}],
         "links":{"replacedBy":"ses_b","replaces":null,"branches":["ses_c"]}}
        """)
        XCTAssertEqual(list.records.map(\.id), ["hof_1", "hof_3"])
        XCTAssertEqual(list.links, HandoffLinks(replacedBy: "ses_b", branches: ["ses_c"]))
        XCTAssertNil(list.continuation)
    }

    func testContinuationKeepsTheRevisionExactlyAsSent() throws {
        let numeric = try decode(HandoffListResult.self, #"{"records":[],"continuation":{"draft":"d","draftRevision":3}}"#)
        XCTAssertEqual(numeric.continuation?.draft, "d")
        XCTAssertEqual(numeric.continuation?.draftRevision, .number(3))
        let text = try decode(HandoffListResult.self, #"{"records":[],"continuation":{"preamble":"p","draftRevision":"r7"}}"#)
        XCTAssertEqual(text.continuation?.draftRevision, .string("r7"))
        XCTAssertTrue(text.continuation?.hasPreamble == true)
        let none = try decode(HandoffListResult.self, #"{"records":[],"continuation":{"draftRevision":null}}"#)
        XCTAssertNil(none.continuation?.draftRevision)
        XCTAssertFalse(none.continuation?.hasPreamble == true)
    }

    func testBusEventFromFrame() throws {
        let frame = try MantaStreamFrame.parse(#"""
        {"kind":"handoff","payload":{"id":"hof_1","fromSessionId":"ses_a","successorId":"ses_b","state":"committed","how":"clear","disposition":"armed"}}
        """#)
        let event = try XCTUnwrap(HandoffBusEvent.from(frame: frame))
        XCTAssertEqual(event.commit, HandoffCommit(id: "hof_1", fromSessionId: "ses_a", successorId: "ses_b",
                                                   state: .committed, how: "clear", disposition: "armed"))
        let other = try MantaStreamFrame.parse(#"{"kind":"delegate.updated","payload":{"id":"hof_1"}}"#)
        XCTAssertNil(HandoffBusEvent.from(frame: other))
        let broken = try MantaStreamFrame.parse(#"{"kind":"handoff","payload":{"state":"ready"}}"#)
        XCTAssertNil(HandoffBusEvent.from(frame: broken))
    }

    // MARK: - Tool part marker

    func testMarkerIsParsedAndStripped() {
        let output = "Handoff prompt ready below.\n<!-- manta-handoff:hof_a1B2-c3 -->"
        XCTAssertEqual(HandoffToolMarker.id(in: output), "hof_a1B2-c3")
        XCTAssertEqual(HandoffToolMarker.stripped(output), "Handoff prompt ready below.")
        XCTAssertNil(HandoffToolMarker.id(in: "no marker here"))
        XCTAssertNil(HandoffToolMarker.id(in: "<!-- manta-handoff: -->"))
        XCTAssertEqual(HandoffToolMarker.stripped("plain"), "plain")
    }

    func testToolRefReadsTheMarkerFromTheCompletedPart() {
        let part = ToolPartFixture.make(tool: "handoff", status: "completed",
                                        output: "Handoff queued — it happens when this turn ends. End your turn now.\n<!-- manta-handoff:hof_z9 -->")
        let ref = HandoffToolRef.from(part: part)
        XCTAssertEqual(ref?.handoffId, "hof_z9")
        XCTAssertEqual(ref?.statusLine, "Handoff queued — it happens when this turn ends. End your turn now.")
        XCTAssertEqual(ref?.toolStatus, "completed")
        XCTAssertEqual(ref?.partId, part.id)
    }

    func testToolRefForARunningPartHasNoRecordYet() {
        let ref = HandoffToolRef.from(part: ToolPartFixture.make(tool: "handoff", status: "running", output: nil))
        XCTAssertNotNil(ref)
        XCTAssertNil(ref?.handoffId)
        XCTAssertEqual(ref?.toolStatus, "running")
    }

    func testOtherToolsAreNotHandoffs() {
        XCTAssertNil(HandoffToolRef.from(part: ToolPartFixture.make(tool: "bash", status: "completed", output: "x")))
        XCTAssertFalse(HandoffToolRef.isHandoffTool(OpencodePart(type: "text", id: "p", messageID: "m", text: "handoff")))
    }

    // MARK: - Badge, enablement, pinning

    func testBadgeForEveryState() {
        func badge(_ s: HandoffState, successor: String? = nil) -> HandoffBadge {
            HandoffCardLogic.badge(for: record(successor: successor, state: s))
        }
        XCTAssertEqual(badge(.requested).label, "Preparing")
        XCTAssertEqual(badge(.generating).tone, .progress)
        XCTAssertEqual(badge(.ready), HandoffBadge(label: "Ready", tone: .ok, opensSuccessor: false))
        XCTAssertEqual(badge(.starting).label, "Starting")
        XCTAssertEqual(badge(.failed).tone, .danger)
        XCTAssertEqual(badge(.cancelled).tone, .neutral)
        // "started → tap to open" only when there is a successor to open.
        XCTAssertTrue(badge(.committed, successor: "ses_b").opensSuccessor)
        XCTAssertFalse(badge(.committed).opensSuccessor)
        XCTAssertEqual(badge(.other("weird")).label, "weird")
    }

    func testActionsAreEnabledOnlyInReady() {
        for state: HandoffState in [.requested, .generating, .starting, .committed, .failed, .cancelled, .other("x")] {
            XCTAssertFalse(HandoffCardLogic.actionsEnabled(record(state: state)), "\(state)")
        }
        XCTAssertTrue(HandoffCardLogic.actionsEnabled(record(state: .ready)))
        XCTAssertTrue(HandoffCardLogic.showsRetry(record(state: .failed)))
        XCTAssertFalse(HandoffCardLogic.showsRetry(record(state: .ready)))
    }

    func testPinnedKeepsServerRecordsForThisSessionOldestFirst() {
        let records = [
            record("a", state: .ready, createdAt: 30),
            record("b", state: .failed, createdAt: 10),
            record("c", state: .generating, createdAt: 20),
            record("agent", trigger: "agent", state: .ready, createdAt: 5),      // inline tool card instead
            record("done", state: .committed, createdAt: 1),                      // started: not pinned
            record("other", from: "ses_other", state: .ready, createdAt: 2),      // another session
            record("gone", state: .cancelled, createdAt: 3),
        ]
        XCTAssertEqual(HandoffCardLogic.pinned(records: records, sessionId: "ses_a").map(\.id), ["b", "c", "a"])
    }

    func testBodyCollapsesPastTwelveLines() {
        let short = (1...12).map { "l\($0)" }.joined(separator: "\n")
        let long = (1...30).map { "l\($0)" }.joined(separator: "\n")
        XCTAssertFalse(HandoffCardLogic.isCollapsible(short))
        XCTAssertTrue(HandoffCardLogic.isCollapsible(long))
        XCTAssertEqual(HandoffCardLogic.visibleText(short, expanded: false), short)
        XCTAssertEqual(HandoffCardLogic.visibleText(long, expanded: false).components(separatedBy: "\n").count, 12)
        XCTAssertEqual(HandoffCardLogic.visibleText(long, expanded: true), long)
    }

    func testSourceLabels() {
        XCTAssertEqual(HandoffCardLogic.sourceLabel(record(trigger: "agent", state: .ready)), "agent")
        XCTAssertEqual(HandoffCardLogic.sourceLabel(record(trigger: "auto", state: .ready)), "auto")
        XCTAssertEqual(HandoffCardLogic.sourceLabel(record(trigger: "button", state: .ready)), "button")
        XCTAssertEqual(HandoffCardLogic.sourceLabel(record(trigger: "user", state: .ready)), "you")
    }

    // MARK: - Reconciliation (§6.4)

    func testReplacementSwitchesWhateverDeviceShowsThePredecessor() {
        let commit = record(successor: "ses_b", state: .committed, how: "clear").commit
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", commit: commit, awaitingBranch: []), .switchTo("ses_b"))
    }

    func testBranchOnlyOpensOnTheDeviceThatStartedIt() {
        let commit = record("hof_9", successor: "ses_c", state: .committed, how: "new-session").commit
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", commit: commit, awaitingBranch: ["hof_9"]), .openBranch("ses_c"))
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", commit: commit, awaitingBranch: []), .none)
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", commit: commit, awaitingBranch: ["other"]), .none)
    }

    func testNothingHappensUnlessCommittedWithASuccessorForThisChat() {
        func act(_ r: HandoffRecord, viewing: String = "ses_a") -> HandoffReconcile.Action {
            HandoffReconcile.action(viewing: viewing, commit: r.commit, awaitingBranch: ["hof_1"])
        }
        XCTAssertEqual(act(record(successor: "ses_b", state: .starting, how: "clear")), .none)
        XCTAssertEqual(act(record(state: .committed, how: "clear")), .none)
        XCTAssertEqual(act(record(successor: "ses_b", state: .committed, how: "clear"), viewing: "ses_zzz"), .none)
        // Already on the successor.
        XCTAssertEqual(act(record(successor: "ses_a", state: .committed, how: "clear")), .none)
        XCTAssertEqual(act(record(successor: "ses_b", state: .committed, how: nil)), .none)
    }

    func testReplacementLinkSwitchesOnLoadOrReconnect() {
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", links: HandoffLinks(replacedBy: "ses_b")), .switchTo("ses_b"))
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", links: HandoffLinks(replacedBy: "ses_a")), .none)
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", links: HandoffLinks(replaces: "ses_0")), .none)
        XCTAssertEqual(HandoffReconcile.action(viewing: "ses_a", links: nil), .none)
    }

    // MARK: - Composer carry-over (§8)

    func testCarriedTextGoesBelowAnExistingDraft() {
        XCTAssertEqual(HandoffComposerCarry.appendBelow("", "typed"), "typed")
        XCTAssertEqual(HandoffComposerCarry.appendBelow("draft", ""), "draft")
        XCTAssertEqual(HandoffComposerCarry.appendBelow("draft", "  \n"), "draft")
        XCTAssertEqual(HandoffComposerCarry.appendBelow("draft\n", "typed"), "draft\n\ntyped")
        XCTAssertEqual(HandoffComposerCarry.appendBelow("  ", "typed"), "typed")
    }

    func testCarriedAttachmentsAreAppendedWithoutDuplicates() {
        let base = [Chip(id: 1, name: "a")]
        let added = [Chip(id: 1, name: "a"), Chip(id: 2, name: "b")]
        XCTAssertEqual(HandoffComposerCarry.appendAttachments(base, added).map(\.id), [1, 2])
        XCTAssertEqual(HandoffComposerCarry.appendAttachments([Chip](), added).map(\.id), [1, 2])
    }

    // MARK: - Draft consumption (§7)

    func testRevisionKey() {
        XCTAssertEqual(HandoffDraftStorage.revisionKey(.number(3)), "3")
        XCTAssertEqual(HandoffDraftStorage.revisionKey(.number(2.5)), "2.5")
        XCTAssertEqual(HandoffDraftStorage.revisionKey(.string("r7")), "r7")
        XCTAssertEqual(HandoffDraftStorage.revisionKey(.null), "")
    }

    func testLocalDraftRoundTripsAndClears() {
        let kv = MemoryKV()
        let draft = HandoffLocalDraft(sessionId: "ses_b", recordId: "hof_1", revision: "3", text: "edit me")
        XCTAssertNil(HandoffDraftStorage.load(sessionId: "ses_b", from: kv))
        HandoffDraftStorage.save(draft, in: kv)
        XCTAssertEqual(HandoffDraftStorage.load(sessionId: "ses_b", from: kv), draft)
        XCTAssertNil(HandoffDraftStorage.load(sessionId: "ses_other", from: kv))
        HandoffDraftStorage.clear(sessionId: "ses_b", in: kv)
        XCTAssertNil(HandoffDraftStorage.load(sessionId: "ses_b", from: kv))
    }

    func testConsumedRevisionIsRememberedPerRecord() {
        let kv = MemoryKV()
        XCTAssertFalse(HandoffDraftStorage.isConsumed(recordId: "hof_1", revision: "3", in: kv))
        HandoffDraftStorage.markConsumed(recordId: "hof_1", revision: "3", in: kv)
        XCTAssertTrue(HandoffDraftStorage.isConsumed(recordId: "hof_1", revision: "3", in: kv))
        // A NEW revision of the same draft is not consumed yet.
        XCTAssertFalse(HandoffDraftStorage.isConsumed(recordId: "hof_1", revision: "4", in: kv))
        XCTAssertFalse(HandoffDraftStorage.isConsumed(recordId: "hof_2", revision: "3", in: kv))
    }

    func testPendingDraftIsTheUnconsumedOneOnTheRecordThatCarriesIt() {
        let carrier = record("hof_1", from: "ses_a", successor: "ses_b", state: .committed, how: "clear", disposition: "draft")
        let unrelated = record("hof_2", from: "ses_a", successor: "ses_b", state: .committed, how: "clear", disposition: "send")
        let continuation = HandoffContinuation(draft: "edit me", draftRevision: .number(3))

        let pending = HandoffDraftStorage.pending(sessionId: "ses_b", records: [unrelated, carrier],
                                                  continuation: continuation, isConsumed: { _, _ in false })
        XCTAssertEqual(pending, HandoffLocalDraft(sessionId: "ses_b", recordId: "hof_1", revision: "3", text: "edit me"))

        // Already consumed (here) → nothing to load.
        XCTAssertNil(HandoffDraftStorage.pending(sessionId: "ses_b", records: [carrier], continuation: continuation,
                                                 isConsumed: { id, rev in id == "hof_1" && rev == "3" }))
        // No draft / no revision / no carrying record → nothing.
        XCTAssertNil(HandoffDraftStorage.pending(sessionId: "ses_b", records: [carrier],
                                                 continuation: HandoffContinuation(preamble: "p"), isConsumed: { _, _ in false }))
        XCTAssertNil(HandoffDraftStorage.pending(sessionId: "ses_b", records: [carrier],
                                                 continuation: HandoffContinuation(draft: "d"), isConsumed: { _, _ in false }))
        XCTAssertNil(HandoffDraftStorage.pending(sessionId: "ses_b", records: [unrelated], continuation: continuation,
                                                 isConsumed: { _, _ in false }))
        XCTAssertNil(HandoffDraftStorage.pending(sessionId: "ses_other", records: [carrier], continuation: continuation,
                                                 isConsumed: { _, _ in false }))
    }

    // MARK: - Mode (§9)

    func testModeDefaultsToAutoAndReadsTheConfig() {
        XCTAssertEqual(HandoffMode.from(config: nil), .auto)
        XCTAssertEqual(HandoffMode.from(config: [:]), .auto)
        XCTAssertEqual(HandoffMode.from(config: ["handoffMode": .string("suggest")]), .suggest)
        XCTAssertEqual(HandoffMode.from(config: ["handoffMode": .string("off")]), .off)
        XCTAssertEqual(HandoffMode.from(config: ["handoffMode": .string("bogus")]), .auto)
        XCTAssertEqual(HandoffMode.allCases.map(\.rawValue), ["auto", "suggest", "off"])
    }

    // MARK: - Previous sessions + notice (§9)

    private typealias Hop = (sessionId: String, links: HandoffLinks?)

    func testPreviousSessionsAreNewestFirstWithTheBranchOriginAfterItsMember() {
        let lineage: [Hop] = [
            ("ses_c", HandoffLinks(replaces: "ses_b")),
            ("ses_b", HandoffLinks(replacedBy: "ses_c", replaces: "ses_a")),
            ("ses_a", HandoffLinks(replacedBy: "ses_b", branchedFrom: "ses_root")),
        ]
        let entries = HandoffPrevious.entries(lineage: lineage)
        XCTAssertEqual(entries.map(\.sessionId), ["ses_b", "ses_a", "ses_root"])
        XCTAssertEqual(entries.map(\.kind), [.predecessor, .predecessor, .branchedFrom])
    }

    func testPreviousSessionsEmptyWithNoLinks() {
        XCTAssertTrue(HandoffPrevious.entries(lineage: [("ses_a", nil)]).isEmpty)
        XCTAssertTrue(HandoffPrevious.entries(lineage: [("ses_a", HandoffLinks(branches: ["ses_x"]))]).isEmpty)
    }

    func testBranchOriginOfTheSessionOnScreenIsListed() {
        let entries = HandoffPrevious.entries(lineage: [("ses_b", HandoffLinks(branchedFrom: "ses_a"))])
        XCTAssertEqual(entries, [HandoffPreviousEntry(sessionId: "ses_a", kind: .branchedFrom)])
    }

    func testNoticeNamesThePredecessorAndTheHandoffSize() {
        let titles = ["ses_a": "Fix auth"]
        let continued = HandoffPrevious.notice(links: HandoffLinks(replaces: "ses_a"), title: { titles[$0] }, handedOffTokens: 182_000)
        XCTAssertEqual(continued?.previousSessionId, "ses_a")
        XCTAssertEqual(continued?.text, "Continued from Fix auth — handed off at 182k tokens")
        let untitled = HandoffPrevious.notice(links: HandoffLinks(replaces: "ses_zz"), title: { _ in nil }, handedOffTokens: nil)
        XCTAssertEqual(untitled?.text, "Continued from previous session")
        let branched = HandoffPrevious.notice(links: HandoffLinks(branchedFrom: "ses_a"), title: { titles[$0] }, handedOffTokens: nil)
        XCTAssertEqual(branched?.text, "Branched from Fix auth")
        XCTAssertNil(HandoffPrevious.notice(links: HandoffLinks(), title: { _ in nil }, handedOffTokens: nil))
        XCTAssertNil(HandoffPrevious.notice(links: nil, title: { _ in nil }, handedOffTokens: nil))
    }

    // MARK: - Failures

    func testFailureMessages() {
        XCTAssertEqual(HandoffFailure.message(MantaError.server("busy"), doing: "Couldn't start"),
                       "Couldn't start — the session is busy, try again in a moment")
        XCTAssertEqual(HandoffFailure.message(MantaError.server("already_started"), doing: "x"), "That handoff was already started")
        XCTAssertEqual(HandoffFailure.message(MantaError.server("not_ready"), doing: "Couldn't start"),
                       "Couldn't start — the handoff isn't ready yet")
        XCTAssertEqual(HandoffFailure.message(MantaError.transport("offline"), doing: "Couldn't start"),
                       "Couldn't start — check the connection")
        XCTAssertTrue(HandoffFailure.isExpired(MantaError.server("expired")))
        XCTAssertFalse(HandoffFailure.isExpired(MantaError.transport("expired")))
        XCTAssertTrue(HandoffFailure.isAlreadyStarted(MantaError.server("already_started")))
        XCTAssertFalse(HandoffFailure.isAlreadyStarted(MantaError.server("busy")))
    }
}

/// A tool part as opencode ships it: `{type:"tool", tool, state:{status, output}}`.
private enum ToolPartFixture {
    static func make(tool: String, status: String, output: String?) -> OpencodePart {
        var state: [String: JSONValue] = ["status": .string(status)]
        if let output { state["output"] = .string(output) }
        return OpencodePart(type: "tool", id: "prt_1", messageID: "msg_1",
                            extra: ["tool": .string(tool), "state": .object(state)])
    }
}
