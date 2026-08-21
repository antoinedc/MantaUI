import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1263 — the durable prompt outbox's pure layer: `PendingPromptStore`.
// Round-trips through an injected UserDefaults, migrates stale rows on launch,
// preserves FIFO submit order through upsert, filters per session, and removes
// by id. No view, no HTTP, no box — and never touches `.standard`.
// ===========================================================================

final class PendingPromptStoreTests: XCTestCase {

    private let suiteName = "PendingPromptStoreTests"

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

    private func prompt(
        _ id: String = UUID().uuidString,
        sessionId: String = "ses",
        text: String = "hi",
        state: PendingPrompt.State = .waiting
    ) -> PendingPrompt {
        PendingPrompt(
            id: id, sessionId: sessionId, text: text,
            attachments: [], model: nil, mentions: nil, agent: nil, state: state
        )
    }

    private func pendingState(_ p: PendingPrompt) -> PendingPrompt.State { p.state }

    // MARK: - Load / save round-trip

    func testRoundTripPreservesAllFields() {
        let attachment = SendPromptInput.Attachment(remotePath: "/tmp/a.png", mime: "image/png", filename: "a.png")
        let model = SendPromptInput.Model(providerID: "anthropic", modelID: "opus")
        let mention = SendPromptInput.Mention(
            name: "file.txt",
            source: SendPromptInput.MentionSource(value: "file.txt", start: 0, end: 8)
        )
        let original = PendingPrompt(
            id: "id-1", sessionId: "ses",
            text: "write it",
            attachments: [attachment], model: model,
            mentions: [mention], agent: "plan",
            state: .sending
        )
        PendingPromptStore.save([original], to: defaults)
        let loaded = PendingPromptStore.load(defaults)
        XCTAssertEqual(loaded, [original])
    }

    func testLoadMissingKeyReturnsEmpty() {
        XCTAssertEqual(PendingPromptStore.load(defaults), [])
    }

    func testLoadCorruptDataReturnsEmptyWithoutThrowing() {
        defaults.set(Data("not json".utf8), forKey: PendingPromptStore.defaultsKey)
        XCTAssertEqual(PendingPromptStore.load(defaults), [], "a decode failure must return [], never throw or trap")
    }

    // MARK: - failStaleOnLaunch

    func testFailStaleMapsWaitingToFailed() {
        PendingPromptStore.save([prompt("w", state: .waiting)], to: defaults)
        let migrated = PendingPromptStore.failStaleOnLaunch(defaults)
        XCTAssertEqual(migrated.map(pendingState), [.failed])
        XCTAssertEqual(PendingPromptStore.load(defaults).map(pendingState), [.failed],
                       "failStaleOnLaunch must also WRITE the migrated list back")
    }

    func testFailStaleMapsSendingToFailed() {
        PendingPromptStore.save([prompt("s", state: .sending)], to: defaults)
        let migrated = PendingPromptStore.failStaleOnLaunch(defaults)
        XCTAssertEqual(migrated.map(pendingState), [.failed])
    }

    func testFailStaleLeavesFailedAlone() {
        PendingPromptStore.save([prompt("f", state: .failed)], to: defaults)
        let migrated = PendingPromptStore.failStaleOnLaunch(defaults)
        XCTAssertEqual(migrated.map(pendingState), [.failed], "an already-failed row stays failed (no state change)")
    }

    func testFailStalePreservesContentAndOrder() {
        let waiting = prompt("w", text: "first", state: .waiting)
        let sending = prompt("s", text: "second", state: .sending)
        let failed = prompt("f", text: "third", state: .failed)
        PendingPromptStore.save([waiting, sending, failed], to: defaults)

        let migrated = PendingPromptStore.failStaleOnLaunch(defaults)
        XCTAssertEqual(migrated.map(pendingState), [.failed, .failed, .failed])
        XCTAssertEqual(migrated.map(\.text), ["first", "second", "third"],
                       "migration must not reorder or mutate the carried text")
    }

    // MARK: - upsert (FIFO + in-place replace)

    func testUpsertAppendsNewToEnd() {
        let a = prompt("a", text: "A")
        let b = prompt("b", text: "B")
        let both = PendingPromptStore.upsert(b, into: PendingPromptStore.upsert(a, into: []))
        XCTAssertEqual(both.map(\.id), ["a", "b"], "FIFO submit order: new items append to the end")
    }

    func testUpsertExistingReplacesInPlaceWithoutMoving() {
        let a = prompt("a", text: "A")
        let b = prompt("b", text: "B")
        let c = prompt("c", text: "C")
        let all = [a, b, c]

        // Re-submit the FIRST row with a new state: it updates in place and does
        // NOT move to the end.
        let updatedA = PendingPrompt(id: a.id, sessionId: a.sessionId, text: a.text,
                                     attachments: a.attachments, model: a.model,
                                     mentions: a.mentions, agent: a.agent, state: .failed)
        let result = PendingPromptStore.upsert(updatedA, into: all)
        XCTAssertEqual(result.map(\.id), ["a", "b", "c"], "an upsert of an existing id replaces in place, not at the end")
        XCTAssertEqual(result.map(pendingState), [.failed, .waiting, .waiting])
    }

    // MARK: - prompts(for:in:)

    func testPromptsForSessionFilters() {
        let mineA = prompt("a", sessionId: "ses")
        let mineB = prompt("b", sessionId: "ses")
        let other = prompt("c", sessionId: "ses-2")
        let out = PendingPromptStore.prompts(for: "ses", in: [mineA, other, mineB])
        XCTAssertEqual(out.map(\.id), ["a", "b"],
                       "only this session's prompts, in FIFO order")
    }

    func testPromptsForSessionEmptyWhenNone() {
        let other = prompt("c", sessionId: "ses-2")
        XCTAssertEqual(PendingPromptStore.prompts(for: "ses", in: [other]), [])
    }

    // MARK: - remove(id:from:)

    func testRemoveDeletesById() {
        let a = prompt("a")
        let b = prompt("b")
        let out = PendingPromptStore.remove(id: "a", from: [a, b])
        XCTAssertEqual(out.map(\.id), ["b"])
    }

    func testRemoveUnknownIdIsNoOp() {
        let a = prompt("a")
        XCTAssertEqual(PendingPromptStore.remove(id: "nope", from: [a]).map(\.id), ["a"])
    }
}
