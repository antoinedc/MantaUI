import XCTest
@testable import MantaUI

// ===========================================================================
// WS02 — the pure half of the chat cards (Foundation only: runs under
// `verify.sh` on Linux AND on the Mac). The router / store half is
// `ChatCardsStoreTests` (Mac only).
//
// Server-first (D23/D24): there are no copy tests here — the box writes the
// sentences. These pin the DECODING of what it sends and the client-only rules.
// ===========================================================================

final class ChatCardsTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: 1. retry payload + clears

    func testRetryPayloadDecodesTheBoxsCopy() throws {
        let p = try decode(StreamRetryPayload.self,
            #"{"attempt":2,"message":"overloaded","next":99,"headline":"HL","caption":"attempt 2","body":"BODY"}"#)
        XCTAssertEqual(p.attempt, 2)
        XCTAssertEqual(p.headline, "HL")
        XCTAssertEqual(p.caption, "attempt 2")
        XCTAssertEqual(p.body, "BODY")
        XCTAssertEqual(p.next, 99)
    }

    func testRetryPayloadFromAnOlderBoxHasNoCopy() throws {
        let p = try decode(StreamRetryPayload.self, #"{"attempt":1,"message":"x"}"#)
        XCTAssertNil(p.headline); XCTAssertNil(p.caption); XCTAssertNil(p.body)
        XCTAssertEqual(p.message, "x")
    }

    func testRetryActionDecodes() throws {
        let p = try decode(StreamRetryPayload.self,
            #"{"attempt":1,"message":"m","action":{"title":"T","message":"M","label":"L","link":"https://x"}}"#)
        XCTAssertEqual(p.action?.link, "https://x")
        XCTAssertEqual(p.action?.label, "L")
    }

    func testClearsRetry() {
        XCTAssertTrue(ChatCardStreamRules.clearsRetry(sub: "running", running: false, complete: nil))
        XCTAssertFalse(ChatCardStreamRules.clearsRetry(sub: "running", running: true, complete: nil))
        XCTAssertTrue(ChatCardStreamRules.clearsRetry(sub: "turnComplete", running: nil, complete: true))
        XCTAssertFalse(ChatCardStreamRules.clearsRetry(sub: "turnComplete", running: nil, complete: false))
        XCTAssertFalse(ChatCardStreamRules.clearsRetry(sub: "flush", running: false, complete: true))
    }

    // MARK: 2. compaction reducer

    private func frame(_ phase: String, text: String? = nil, reason: String? = nil, firstLine: String? = nil) -> StreamCompactionPayload {
        StreamCompactionPayload(phase: phase, text: text, reason: reason, firstLine: firstLine)
    }

    func testCompactionStartedDeltaEnded() {
        var s = ChatCardCompactionReducer.apply(frame("started", text: "", reason: "manual"), to: nil, generation: 1)
        XCTAssertEqual(s?.phase, .running)
        XCTAssertEqual(s?.reason, "manual")
        XCTAssertEqual(s?.generation, 1)
        s = ChatCardCompactionReducer.apply(frame("delta", text: "Sum"), to: s, generation: 1)
        s = ChatCardCompactionReducer.apply(frame("delta", text: "mary"), to: s, generation: 1)
        XCTAssertEqual(s?.text, "Summary")
        s = ChatCardCompactionReducer.apply(frame("ended", firstLine: "## Objective"), to: s, generation: 1)
        XCTAssertEqual(s?.phase, .done)
        XCTAssertEqual(s?.firstLine, "## Objective")
    }

    func testCompactionDeltaOrEndedWithNoPriorStateStaysNil() {
        XCTAssertNil(ChatCardCompactionReducer.apply(frame("delta", text: "x"), to: nil, generation: 3))
        XCTAssertNil(ChatCardCompactionReducer.apply(frame("ended", firstLine: "x"), to: nil, generation: 3))
    }

    func testCompactionDefaultsReasonAndOmitsAnAbsentFirstLine() {
        let started = ChatCardCompactionReducer.apply(frame("started"), to: nil, generation: 1)
        XCTAssertEqual(started?.reason, "context")
        let ended = ChatCardCompactionReducer.apply(frame("ended"), to: started, generation: 1)
        XCTAssertNil(ended?.firstLine)
        let blank = ChatCardCompactionReducer.apply(frame("ended", firstLine: ""), to: started, generation: 1)
        XCTAssertNil(blank?.firstLine)
    }

    // MARK: 3. expiry latch

    func testLatchSchedulesOnceAndHidesAfterExpiry() {
        var latch = ChatCardExpiryLatch(seed: 0)
        let first = latch.observe(key: 1, expiring: true)
        XCTAssertTrue(first.visible)
        XCTAssertEqual(first.schedule, 1)
        // Unrelated snapshots inside the window do not reschedule.
        let again = latch.observe(key: 1, expiring: true)
        XCTAssertTrue(again.visible)
        XCTAssertNil(again.schedule)
        latch.expire(1)
        XCTAssertFalse(latch.observe(key: 1, expiring: true).visible, "after expiry the same key stays hidden")
        XCTAssertNil(latch.scheduled)
    }

    func testLatchNewKeyWhileAnOldTimerIsPendingIsVisible() {
        var latch = ChatCardExpiryLatch(seed: 0)
        _ = latch.observe(key: 1, expiring: true)
        let second = latch.observe(key: 2, expiring: false)
        XCTAssertTrue(second.visible)
        latch.expire(1)                       // the OLD timer fires
        XCTAssertTrue(latch.observe(key: 2, expiring: false).visible, "an old expiry cannot hide a newer card")
    }

    func testLatchSeedHidesAnExistingDoneCardAndShowsARunningOne() {
        var done = ChatCardExpiryLatch(seed: 4)            // opened with generation 4 already done
        XCTAssertFalse(done.observe(key: 4, expiring: true).visible)
        var running = ChatCardExpiryLatch(seed: 3)         // generation 4 still running at open
        XCTAssertTrue(running.observe(key: 4, expiring: false).visible)
    }

    func testLatchNonExpiringNeverSchedules() {
        var latch = ChatCardExpiryLatch(seed: 0)
        XCTAssertNil(latch.observe(key: 1, expiring: false).schedule)
    }

    // MARK: 4/5. optimizer.compacted + sessionError decode

    func testOptimizerCompactedDecodesTheBoxsText() throws {
        let p = try decode(StreamOptimizerCompactedPayload.self, #"{"beforeTokens":1,"afterTokens":2,"away":true,"text":"LINE"}"#)
        XCTAssertEqual(p.text, "LINE")
        let old = try decode(StreamOptimizerCompactedPayload.self, #"{"beforeTokens":1,"afterTokens":2,"away":true}"#)
        XCTAssertNil(old.text, "an older box sends no text: nothing is shown")
    }

    func testSessionErrorDisplayWithAndWithoutReconnect() throws {
        let auth = try decode(StreamSessionErrorPayload.self, """
        {"name":"ProviderAuthError","message":"x","display":{"text":"Claude needs to be reconnected.",
         "reconnect":{"providerID":"anthropic","label":"Claude","accountsId":"claude"}}}
        """)
        XCTAssertEqual(auth.shownText, "Claude needs to be reconnected.")
        XCTAssertEqual(auth.display?.reconnect?.accountsId, "claude")

        let plain = try decode(StreamSessionErrorPayload.self,
            #"{"name":"ApiError","message":"m","display":{"text":"API error: m","reconnect":null}}"#)
        XCTAssertEqual(plain.shownText, "API error: m")
        XCTAssertNil(plain.display?.reconnect)
    }

    func testSessionErrorFromAnOlderBoxShowsTheRawMessageAndNoReconnect() throws {
        let old = try decode(StreamSessionErrorPayload.self, #"{"name":"ApiError","message":"raw words"}"#)
        XCTAssertEqual(old.shownText, "raw words")
        XCTAssertNil(old.display)
    }

    // MARK: 6. approval gating + decoding

    func testCanStartIsFalseForAnEmptyListAndBlankFields() {
        XCTAssertFalse(ChatCardApprovalLogic.canStart(tools: []))
        XCTAssertFalse(ChatCardApprovalLogic.canStart(tools: [ChatCardApprovalTool(permission: "bash", pattern: "")]))
        XCTAssertFalse(ChatCardApprovalLogic.canStart(tools: [ChatCardApprovalTool(permission: "  ", pattern: "x")]))
        XCTAssertTrue(ChatCardApprovalLogic.canStart(tools: [ChatCardApprovalTool(permission: "bash", pattern: "npm *")]))
    }

    func testApprovalFootnotes() {
        XCTAssertEqual(ChatCardApprovalLogic.footnote(tools: []),
                       "A job needs at least one rule. To give it no access, tap Not now.")
        XCTAssertEqual(ChatCardApprovalLogic.footnote(tools: [ChatCardApprovalTool(permission: "", pattern: "")]),
                       "Fill in or remove empty rules.")
        XCTAssertNil(ChatCardApprovalLogic.footnote(tools: [ChatCardApprovalTool(permission: "a", pattern: "b")]))
    }

    func testOutcomeHints() {
        XCTAssertEqual(ChatCardApprovalLogic.outcomeHint(ok: true, approved: true), "Background job approved")
        XCTAssertEqual(ChatCardApprovalLogic.outcomeHint(ok: true, approved: false), "Background job declined")
        XCTAssertEqual(ChatCardApprovalLogic.outcomeHint(ok: false, approved: true), "That request is no longer pending")
    }

    func testFilterResolvedDropsLocallyDecidedIDs() {
        let list = [ChatCardApproval(id: "a"), ChatCardApproval(id: "b")]
        XCTAssertEqual(ChatCardApprovalLogic.filterResolved(list, resolved: ["a"]).map(\.id), ["b"])
    }

    func testApprovalsDecodeBothShapesAndSkipMalformedElements() {
        let bare = #"[{"id":"a1","parentSessionID":"ses","name":"n","prompt":"p","tools":[{"permission":"bash","pattern":"ls"}],"createdAt":5}]"#
        let wrapped = #"{"approvals":[{"id":"a1","name":"n","tools":[]}]}"#
        let withJunk = #"[{"id":"ok","tools":[]},{"nope":1},{"id":""}]"#
        XCTAssertEqual(ChatCardApprovalsDecoding.decode(Data(bare.utf8)).first?.tools.first?.pattern, "ls")
        XCTAssertEqual(ChatCardApprovalsDecoding.decode(Data(wrapped.utf8)).map(\.id), ["a1"])
        XCTAssertEqual(ChatCardApprovalsDecoding.decode(Data(withJunk.utf8)).map(\.id), ["ok"])
        XCTAssertEqual(ChatCardApprovalsDecoding.decode(Data("null".utf8)), [])
    }

    func testApproveResultDistinguishesARefusalFromNoLongerPending() throws {
        let refused = try decode(ChatCardApproveResult.self, #"{"ok":false,"error":"A job needs at least one rule"}"#)
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.error, "A job needs at least one rule")
        let gone = try decode(ChatCardApproveResult.self, #"{"ok":false}"#)
        XCTAssertNil(gone.error)
        let ok = try decode(ChatCardApproveResult.self, #"{"ok":true}"#)
        XCTAssertTrue(ok.ok)
    }

    // MARK: 7. job view decoding

    func testJobForSessionDecodesBothAnswers() throws {
        XCTAssertEqual(try decode(ChatCardJobForSession.self, #"{"readOnly":false}"#), .writable)
        let withParent = try decode(ChatCardJobForSession.self, """
        {"readOnly":true,"job":{"id":"j","status":"running","statusLabel":"running","headline":"H","statusLine":"S",
         "parentLine":"P","stoppable":true,"parent":{"sessionId":"ses_p","name":"main","project":"proj","windowIndex":2}}}
        """)
        guard case .readOnly(let job) = withParent else { return XCTFail("expected a read-only job") }
        XCTAssertEqual(job.headline, "H")
        XCTAssertTrue(job.stoppable)
        XCTAssertEqual(job.parent?.windowIndex, 2)
        let noParent = try decode(ChatCardJobForSession.self, """
        {"readOnly":true,"job":{"id":"j","status":"done","statusLabel":"done","headline":"H","statusLine":"S",
         "parentLine":"It reports to a session that's closed.","stoppable":false,"parent":null,"extra":"ignored"}}
        """)
        guard case .readOnly(let closed) = noParent else { return XCTFail("expected a read-only job") }
        XCTAssertNil(closed.parent)
    }

    func testAReadOnlyAnswerWithoutAJobThrowsRatherThanReadingAsWritable() {
        XCTAssertThrowsError(try decode(ChatCardJobForSession.self, #"{"readOnly":true}"#))
    }

    // MARK: 8. ownership resolver

    private func jobView() -> ChatCardJobView {
        ChatCardJobView(id: "j", status: "running", statusLabel: "running", headline: "H", statusLine: "S",
                        parentLine: "P", stoppable: true, parent: nil)
    }

    func testResolvingPlusAnswers() {
        let writable = ChatCardOwnershipResolver.next(current: .resolving, result: .answer(.writable))
        XCTAssertEqual(writable.policy, .allowed)
        XCTAssertNil(writable.job)
        let job = ChatCardOwnershipResolver.next(current: .resolving, result: .answer(.readOnly(jobView())))
        XCTAssertEqual(job.policy, .readOnlyJob)
        XCTAssertEqual(job.job?.id, "j")
    }

    func testCapabilityAbsentIsAllowedWithNoBar() {
        let v = ChatCardOwnershipResolver.next(current: .resolving, result: .capabilityAbsent)
        XCTAssertEqual(v.policy, .allowed)
        XCTAssertTrue(v.jobBarUnavailable)
        XCTAssertNil(v.job)
    }

    func testAnyFailureKeepsTheCurrentState() {
        XCTAssertEqual(ChatCardOwnershipResolver.next(current: .resolving, result: .failure).policy, .resolving,
                       "a failed lookup — transport OR server error — never releases held sends")
        let kept = ChatCardOwnershipResolver.next(current: .readOnlyJob, currentJob: jobView(), result: .failure)
        XCTAssertEqual(kept.policy, .readOnlyJob)
        XCTAssertEqual(kept.job?.id, "j", "a known job stays read-only with its bar")
        XCTAssertEqual(ChatCardOwnershipResolver.next(current: .allowed, result: .failure).policy, .allowed)
    }

    // MARK: 9. mutation gate

    func testMutationGate() {
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .resolving, action: .send), .hold)
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .resolving, action: .mutate),
                       .refuse("One moment — checking this session"))
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .readOnlyJob, action: .send),
                       .refuse("This is a background job — it can't take messages"))
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .readOnlyJob, action: .mutate),
                       .refuse("This is a background job — it can't take messages"))
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .allowed, action: .send), .run)
        XCTAssertEqual(ChatCardMutationGate.decide(policy: .allowed, action: .mutate), .run)
    }

    // MARK: 10. edit last + inbox result decoding

    func testEditLastPicksTheNewestItemWithNoActionInFlight() {
        let items = [
            InboxItem(id: "a", text: "a", delivery: .steer, createdAt: 1, attachmentCount: 0),
            InboxItem(id: "b", text: "b", delivery: .queue, createdAt: 2, attachmentCount: 0),
        ]
        XCTAssertEqual(ChatCardEditLast.pick(items: items, busy: [])?.id, "b")
        XCTAssertEqual(ChatCardEditLast.pick(items: items, busy: ["b"])?.id, "a")
        XCTAssertNil(ChatCardEditLast.pick(items: items, busy: ["a", "b"]))
        XCTAssertNil(ChatCardEditLast.pick(items: [], busy: []))
    }

    // MARK: 11. seat line

    func testSeatLineIsNilWithoutASeatOrName() {
        XCTAssertNil(ChatCardSeatLine.value(nil))
    }

    // MARK: progress rule

    func testBlockedProgressRule() {
        XCTAssertTrue(ChatCardProgressRule.isBlocked(state: "blocked"))
        XCTAssertFalse(ChatCardProgressRule.isBlocked(state: "working"))
        XCTAssertFalse(ChatCardProgressRule.isBlocked(state: "done"))
    }

    // MARK: 12. focus planner / highlight / policy / machine

    func testPlannerFoundPresentsAndSurvivesAppendedMessages() {
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "m5", messageIDs: ["m1", "m5", "m9"], limit: 30, hasEarlier: true),
                       .present(index: 1))
        // Two messages were appended since the lookup: the target is found by id.
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "m5", messageIDs: ["m1", "m5", "m9", "m10", "m11"], limit: 30, hasEarlier: true),
                       .present(index: 1))
    }

    func testPlannerWidensCappedAt500() {
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "x", messageIDs: ["a"], limit: 30, hasEarlier: true, step: 50),
                       .widen(newLimit: 80))
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "x", messageIDs: ["a"], limit: 480, hasEarlier: true, step: 50),
                       .widen(newLimit: 500))
    }

    func testPlannerDistinguishesTooFarBackFromNotFound() {
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "x", messageIDs: ["a"], limit: 500, hasEarlier: true),
                       .tooFarBack, "a valid target beyond the cap")
        XCTAssertEqual(ChatCardFocusPlanner.next(target: "x", messageIDs: ["a"], limit: 30, hasEarlier: false),
                       .notFound, "everything is loaded and it is not there")
    }

    func testHighlightRowOnlyWhenTheTargetItselfMapsToBlocks() {
        XCTAssertEqual(ChatCardFocusHighlight.resolve(targetBlockCount: 2, targetIsUnfinishedAssistant: false, sliceRowIDs: ["r0", "r1"]),
                       .row("r0"))
        XCTAssertEqual(ChatCardFocusHighlight.resolve(targetBlockCount: 0, targetIsUnfinishedAssistant: true, sliceRowIDs: ["next"]),
                       .unfinished, "a still-streaming target never highlights the NEXT message")
        XCTAssertEqual(ChatCardFocusHighlight.resolve(targetBlockCount: 0, targetIsUnfinishedAssistant: false, sliceRowIDs: ["next"]),
                       .nothingToShow)
        XCTAssertEqual(ChatCardFocusHighlight.resolve(targetBlockCount: 1, targetIsUnfinishedAssistant: false, sliceRowIDs: []),
                       .nothingToShow)
    }

    func testFocusPolicy() {
        XCTAssertTrue(ChatCardFocusPolicy.allowsBottomJump(phase: .none))
        XCTAssertFalse(ChatCardFocusPolicy.allowsBottomJump(phase: .locating(id: "m", token: 1)))
        XCTAssertFalse(ChatCardFocusPolicy.allowsBottomJump(phase: .presented(id: "m", token: 1)))
        XCTAssertEqual(ChatCardFocusPolicy.loadEarlierAction(index: 12), .revealLocal)
        XCTAssertEqual(ChatCardFocusPolicy.loadEarlierAction(index: 0), .revealLocalThenWiden)
    }

    func testFocusMachineIgnoresStaleTokensAndLatestWins() {
        var phase = ChatCardFocusPhase.none
        phase = ChatCardFocusMachine.reduce(phase, event: .focus(id: "a", token: 1))
        phase = ChatCardFocusMachine.reduce(phase, event: .focus(id: "b", token: 2))      // second focus wins
        XCTAssertEqual(phase, .locating(id: "b", token: 2))
        XCTAssertEqual(ChatCardFocusMachine.reduce(phase, event: .presented(token: 1)), phase, "the first jump's late result is ignored")
        XCTAssertEqual(ChatCardFocusMachine.reduce(phase, event: .notFound(token: 1)), phase)
        phase = ChatCardFocusMachine.reduce(phase, event: .presented(token: 2))
        XCTAssertEqual(phase, .presented(id: "b", token: 2))
        XCTAssertEqual(ChatCardFocusMachine.reduce(phase, event: .clear), .none)
    }

    func testFocusMachineFailureCopy() {
        let locating = ChatCardFocusPhase.locating(id: "m", token: 1)
        XCTAssertEqual(ChatCardFocusMachine.reduce(locating, event: .tooFarBack(token: 1)),
                       .failed("That message is too far back to open here — it's more than 500 messages ago"))
        XCTAssertEqual(ChatCardFocusMachine.reduce(locating, event: .notFound(token: 1)),
                       .failed("Couldn't find that message — it may have been compacted away"))
        XCTAssertEqual(ChatCardFocusMachine.reduce(locating, event: .fetchFailed(token: 1)),
                       .failed("Couldn't load that message — check the connection"))
    }

    // MARK: 13. bounded log

    func testBoundedLogEvictsTheOldestPastTheLimit() {
        var log = ChatCardBoundedLog<Int>(limit: 200)
        for i in 0..<205 { log.set("k\(i)", i) }
        XCTAssertEqual(log.count, 200)
        XCTAssertNil(log.values["k0"])
        XCTAssertNil(log.values["k4"])
        XCTAssertEqual(log.values["k5"], 5)
        XCTAssertEqual(log.values["k204"], 204)
        // Re-setting a key updates it in place (no growth, no reorder).
        log.set("k5", 99)
        XCTAssertEqual(log.count, 200)
        XCTAssertEqual(log.values["k5"], 99)
    }

    // MARK: command frame

    func testCommandExecutedDecodesAStringArgumentsAlways() throws {
        let p = try decode(StreamCommandExecutedPayload.self, #"{"messageID":"m","name":"review","arguments":""}"#)
        XCTAssertEqual(p.name, "review")
        XCTAssertEqual(p.arguments, "")
    }

    // MARK: review round — approval rules, composer gate, pending-card gate

    func testRuleLabelMarksADenyRule() {
        XCTAssertEqual(ChatCardApprovalLogic.ruleLabel(ChatCardApprovalTool(permission: "bash", pattern: "npm *")), "bash: npm *")
        XCTAssertEqual(ChatCardApprovalLogic.ruleLabel(ChatCardApprovalTool(permission: "bash", pattern: "rm *", action: "deny")),
                       "deny · bash: rm *")
    }

    func testApprovalToolDecodesAndKeepsItsAction() throws {
        let tool = try decode(ChatCardApprovalTool.self, #"{"permission":"bash","pattern":"rm *","action":"deny"}"#)
        XCTAssertEqual(tool.action, "deny")
        let plain = try decode(ChatCardApprovalTool.self, #"{"permission":"bash","pattern":"ls"}"#)
        XCTAssertNil(plain.action)
    }

    // M-03-7: typing stays possible while the session is being checked.
    func testComposerAcceptsInputInEveryStateButAReadOnlyJob() {
        XCTAssertTrue(ChatCardMutationGate.composerAcceptsInput(.resolving))
        XCTAssertTrue(ChatCardMutationGate.composerAcceptsInput(.allowed))
        XCTAssertFalse(ChatCardMutationGate.composerAcceptsInput(.readOnlyJob))
    }

    // #21: unknown capability = disabled, no note; absent = disabled + the update note.
    func testPendingCardGate() {
        let unknown = ChatCardInboxGate.resolve(available: nil, canMutate: true)
        XCTAssertFalse(unknown.actionsEnabled)
        XCTAssertNil(unknown.gateNote)
        let absent = ChatCardInboxGate.resolve(available: false, canMutate: true)
        XCTAssertFalse(absent.actionsEnabled)
        XCTAssertEqual(absent.gateNote, "Update your box to use this")
        let present = ChatCardInboxGate.resolve(available: true, canMutate: true)
        XCTAssertTrue(present.actionsEnabled)
        XCTAssertNil(present.gateNote)
        XCTAssertFalse(ChatCardInboxGate.resolve(available: true, canMutate: false).actionsEnabled,
                       "a resolving session or a job never acts on the queue")
    }
}
