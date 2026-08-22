import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1305 — the pure prompt-history layer: persistence (`PromptHistoryStore`),
// the merge (`mergePromptHistory`), the transcript derivation
// (`ChatTranscriptMapper.userTurnTexts`) and the up/down navigator
// (`ComposerHistoryNavigator`). No views, no RPC.
// ===========================================================================

final class ComposerHistoryTests: XCTestCase {

    // MARK: - UserDefaults plumbing

    private func makeDefaults() -> UserDefaults {
        let suite = "ComposerHistoryTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock {
            UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        }
        return defaults
    }

    private func key(_ session: String = "main", _ index: Int = 0) -> String {
        PromptHistoryStore.key(tmuxSession: session, windowIndex: index)
    }

    // MARK: - OpencodeMessage fixture

    private func message(id: String, role: String, parts: [OpencodePart]) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: role),
                time: nil,
                modelID: nil,
                providerID: nil
            ),
            parts: parts
        )
    }

    private func textPart(_ id: String, _ messageID: String, _ text: String) -> OpencodePart {
        OpencodePart(type: "text", id: id, messageID: messageID, text: text)
    }

    // MARK: - PromptHistoryStore.append

    func testAppendSkipsEmptyAndWhitespaceOnly() {
        let d = makeDefaults()
        PromptHistoryStore.append("   ", tmuxSession: "main", windowIndex: 0, defaults: d)
        PromptHistoryStore.append("", tmuxSession: "main", windowIndex: 0, defaults: d)
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d).isEmpty)
    }

    func testAppendCollapsesConsecutiveDuplicate() {
        let d = makeDefaults()
        PromptHistoryStore.append("hello", tmuxSession: "main", windowIndex: 0, defaults: d)
        PromptHistoryStore.append("hello", tmuxSession: "main", windowIndex: 0, defaults: d)
        let list = PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d)
        XCTAssertEqual(list, ["hello"])
    }

    func testAppendCapsAtMaxDroppingOldest() {
        let d = makeDefaults()
        for i in 0..<250 {
            PromptHistoryStore.append("p\(i)", tmuxSession: "main", windowIndex: 0, defaults: d)
        }
        let list = PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d)
        XCTAssertEqual(list.count, PromptHistoryStore.historyMax)
        XCTAssertEqual(list.last, "p249")
        XCTAssertEqual(list.first, "p50")
    }

    func testAppendNoOpWhenSessionOrWindowNil() {
        let d = makeDefaults()
        PromptHistoryStore.append("hello", tmuxSession: nil, windowIndex: 0, defaults: d)
        PromptHistoryStore.append("hello", tmuxSession: "main", windowIndex: nil, defaults: d)
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d).isEmpty)
    }

    // MARK: - PromptHistoryStore.read

    func testReadMissingKeyIsEmpty() {
        let d = makeDefaults()
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d).isEmpty)
    }

    func testReadNilIdentityIsEmpty() {
        let d = makeDefaults()
        PromptHistoryStore.append("a", tmuxSession: "main", windowIndex: 0, defaults: d)
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: nil, windowIndex: 0, defaults: d).isEmpty)
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: nil, defaults: d).isEmpty)
    }

    func testReadMalformedJSONIsEmpty() {
        let d = makeDefaults()
        d.set("{not json", forKey: key())
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d).isEmpty)
    }

    func testReadNonStringElementsDropped() {
        let d = makeDefaults()
        guard let data = try? JSONSerialization.data(withJSONObject: ["a", 42, [1], "b"] as [Any]) else {
            return XCTFail("could not serialize fixture")
        }
        d.set(String(data: data, encoding: .utf8), forKey: key())
        XCTAssertEqual(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 0, defaults: d), ["a", "b"])
    }

    func testAppendReadRoundTrip() {
        let d = makeDefaults()
        PromptHistoryStore.append("one", tmuxSession: "main", windowIndex: 2, defaults: d)
        PromptHistoryStore.append("two", tmuxSession: "main", windowIndex: 2, defaults: d)
        XCTAssertEqual(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 2, defaults: d), ["one", "two"])
        // Different window index does not bleed across.
        XCTAssertTrue(PromptHistoryStore.read(tmuxSession: "main", windowIndex: 3, defaults: d).isEmpty)
    }

    // MARK: - mergePromptHistory

    func testMergeSeamDedupeLastPersistedEqualsFirstTranscript() {
        let merged = mergePromptHistory(persisted: ["a", "b"], transcript: ["b", "c"])
        XCTAssertEqual(merged, ["a", "b", "c"])
    }

    func testMergeDropsEmpties() {
        let merged = mergePromptHistory(persisted: ["", "a", ""], transcript: ["", "b"])
        XCTAssertEqual(merged, ["a", "b"])
    }

    func testMergeCollapsesConsecutiveDuplicatesOnly() {
        let merged = mergePromptHistory(persisted: ["x", "x", "y"], transcript: ["y", "z", "z"])
        XCTAssertEqual(merged, ["x", "y", "z"])
    }

    func testMergePreservesOrder() {
        let merged = mergePromptHistory(persisted: ["a", "b"], transcript: ["c"])
        XCTAssertEqual(merged, ["a", "b", "c"])
    }

    // MARK: - ChatTranscriptMapper.userTurnTexts

    func testUserTurnTextsFiltersTrimsAndSkipsEmpties() {
        let msgs = [
            message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "a reply")]),
            message(id: "m2", role: "user", parts: [textPart("p2", "m2", "  prompt one  ")]),
            message(id: "m3", role: "user", parts: [textPart("p3", "m3", "   ")]),
            message(id: "m4", role: "user", parts: [textPart("p4", "m4", "prompt two")]),
        ]
        XCTAssertEqual(ChatTranscriptMapper.userTurnTexts(from: msgs), ["prompt one", "prompt two"])
    }

    func testUserTurnTextsJoinsTextPartsAndSkipsSynthetic() {
        let msgs = [
            message(id: "m1", role: "user", parts: [
                textPart("p1", "m1", "part one"),
                textPart("p2", "m1", "part two"),
                OpencodePart(type: "text", id: "p3", messageID: "m1", text: "synthetic", synthetic: true),
            ]),
        ]
        XCTAssertEqual(ChatTranscriptMapper.userTurnTexts(from: msgs), ["part one\npart two"])
    }

    // MARK: - ComposerHistoryNavigator

    func testNavigatorUpFromDraftSavesAndLandsOnNewest() {
        var nav = ComposerHistoryNavigator(entries: ["a", "b", "c"])
        XCTAssertEqual(nav.up(currentDraft: "draft"), "c")
        XCTAssertEqual(nav.index, 2)
        XCTAssertEqual(nav.savedDraft, "draft")
    }

    func testNavigatorRepeatedUpReachesOldestAndStays() {
        var nav = ComposerHistoryNavigator(entries: ["a", "b", "c"])
        _ = nav.up(currentDraft: "draft")
        XCTAssertEqual(nav.up(currentDraft: "draft"), "b")
        XCTAssertEqual(nav.up(currentDraft: "draft"), "a")
        XCTAssertEqual(nav.up(currentDraft: "draft"), "a")
        XCTAssertEqual(nav.index, 0)
    }

    func testNavigatorDownPastNewestRestoresSavedDraft() {
        var nav = ComposerHistoryNavigator(entries: ["a", "b", "c"])
        _ = nav.up(currentDraft: "draft")   // -> c (idx 2)
        _ = nav.up(currentDraft: "draft")   // -> b (idx 1)
        _ = nav.up(currentDraft: "draft")   // -> a (idx 0)
        XCTAssertEqual(nav.down(), "b")     // idx 1
        XCTAssertEqual(nav.down(), "c")     // idx 2
        XCTAssertEqual(nav.down(), "draft") // past newest -> draft
        XCTAssertNil(nav.index)
    }

    func testNavigatorDownWhenNotCyclingIsNoOp() {
        var nav = ComposerHistoryNavigator(entries: ["a", "b"])
        XCTAssertNil(nav.down())
        XCTAssertNil(nav.index)
    }

    func testNavigatorResetExitsCycling() {
        var nav = ComposerHistoryNavigator(entries: ["a", "b"])
        _ = nav.up(currentDraft: "draft")
        nav.reset()
        XCTAssertNil(nav.index)
        XCTAssertNil(nav.down())
    }

    func testNavigatorUpOnEmptyEntriesIsNoOp() {
        var nav = ComposerHistoryNavigator(entries: [])
        XCTAssertNil(nav.up(currentDraft: "draft"))
        XCTAssertNil(nav.index)
    }
}
