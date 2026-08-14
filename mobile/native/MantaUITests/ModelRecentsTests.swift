import XCTest
@testable import MantaUI

// ===========================================================================
// BET-825 — the composer model menu's pure logic: ModelRecents (ordered,
// capped, de-duplicated on the whole triple) and the catalogue row badges
// (ChatModel.contextSize port of the desktop formatModelContextSize, and
// ChatModel.capabilityGlyphs). No view, no HTTP, no box.
// ===========================================================================

final class ModelRecentsTests: XCTestCase {

    private func choice(_ model: String = "opus", variant: String? = nil, fast: Bool = false) -> ModelChoice {
        ModelChoice(providerID: "anthropic", modelID: model, variant: variant, fast: fast)
    }

    // MARK: - record (ordering, dedup, cap)

    func testNewChoiceGoesToFront() {
        let list = ModelRecents.record(choice("sonnet"), into: [])
        let list2 = ModelRecents.record(choice("haiku"), into: list)
        XCTAssertEqual(list2.map(\.modelID), ["haiku", "sonnet"])
    }

    func testReSelectingExistingMovesToFrontWithoutDuplicate() {
        let list = ModelRecents.record(choice("haiku"), into: [])
        let list2 = ModelRecents.record(choice("opus"), into: list)
        let list3 = ModelRecents.record(choice("haiku"), into: list2)
        XCTAssertEqual(list3.map(\.modelID), ["haiku", "opus"])
        XCTAssertEqual(list3.count, 2)
    }

    func testCapsAtFiveAndDropsOldest() {
        var list: [ModelChoice] = []
        for i in 0..<7 {
            list = ModelRecents.record(choice("m\(i)"), into: list)
        }
        XCTAssertEqual(list.count, 5)
        // Most recent first; the two oldest (m0, m1) dropped.
        XCTAssertEqual(list.map(\.modelID), ["m6", "m5", "m4", "m3", "m2"])
    }

    func testSameModelDifferentEffortIsDistinct() {
        let low = choice("opus", variant: "low")
        let high = choice("opus", variant: "high")
        let list = ModelRecents.record(low, into: [])
        let list2 = ModelRecents.record(high, into: list)
        XCTAssertEqual(list2.count, 2)
        XCTAssertEqual(list2.map { $0.variant ?? "" }.sorted(), ["high", "low"])
    }

    func testSameModelDifferentFastIsDistinct() {
        let normal = choice("haiku")
        let fast = choice("haiku", fast: true)
        let list = ModelRecents.record(normal, into: [])
        let list2 = ModelRecents.record(fast, into: list)
        XCTAssertEqual(list2.count, 2)
    }

    func testRecordIsMostRecentFirstAfterRefill() {
        // De-duplication happens on the whole triple each time.
        let a = choice("opus", variant: "high")
        let b = choice("opus", variant: "max")
        var list: [ModelChoice] = []
        list = ModelRecents.record(a, into: list)
        list = ModelRecents.record(b, into: list)
        // Re-picking A brings it back to front, keeping B.
        list = ModelRecents.record(a, into: list)
        XCTAssertEqual(list.map { $0.variant ?? "" }, ["high", "max"])
    }

    // MARK: - label

    func testLabelResolvesFriendlyNameAndEffort() {
        let models = [OpencodeModel(id: "opus", providerID: "anthropic", name: "Claude Opus 4.7")]
        let c = ModelChoice(providerID: "anthropic", modelID: "opus", variant: "high", fast: false)
        XCTAssertEqual(ModelRecents.label(for: c, models: models), "Claude Opus 4.7 · High")
    }

    func testLabelAppendsBoltWhenFast() {
        let models = [OpencodeModel(id: "haiku", providerID: "anthropic", name: "Claude Haiku 4")]
        let c = ModelChoice(providerID: "anthropic", modelID: "haiku", variant: nil, fast: true)
        XCTAssertEqual(ModelRecents.label(for: c, models: models), "Claude Haiku 4 · ⚡")
    }

    func testLabelFallsBackToModelIDWhenUnknown() {
        let c = ModelChoice(providerID: "deepseek", modelID: "deepseek-chat", variant: nil, fast: false)
        XCTAssertEqual(ModelRecents.label(for: c, models: []), "deepseek-chat")
    }

    // MARK: - ChatModel.contextSize (desktop formatModelContextSize port)

    func testContextSizeKForm() {
        XCTAssertEqual(ChatModel.contextSize(200_000), "200k")
        XCTAssertEqual(ChatModel.contextSize(250_000), "250k")
    }

    func testContextSizeMForm() {
        XCTAssertEqual(ChatModel.contextSize(1_000_000), "1M")
        XCTAssertEqual(ChatModel.contextSize(1_500_000), "1.5M")
    }

    func testContextSizeNilAndInvalid() {
        XCTAssertNil(ChatModel.contextSize(nil))
        XCTAssertNil(ChatModel.contextSize(0))
        XCTAssertNil(ChatModel.contextSize(-5))
        XCTAssertNil(ChatModel.contextSize(.infinity))
    }

    // MARK: - ChatModel.capabilityGlyphs

    private func gylphModel(variants: Int = 0, input: [String] = []) -> OpencodeModel {
        OpencodeModel(
            id: "m",
            providerID: "p",
            name: "m",
            variants: (0..<variants).map { OpencodeModel.Variant(id: "v\($0)") },
            capabilities: ModelCapabilities(input: input)
        )
    }

    func testReasoningFromVariants() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(variants: 3)), ["reasoning"])
    }

    func testVisionFromImageInput() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(input: ["text", "image"])), ["vision"])
    }

    func testBothInOrderReasoningThenVision() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(variants: 5, input: ["text", "image"])), ["reasoning", "vision"])
    }

    func testEmptyWhenNeither() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel()), [])
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(input: ["text"])), [])
    }

    func testVisionCaseInsensitive() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(input: ["Image"])), ["vision"])
    }
}
