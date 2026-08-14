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

    /// Builds a catalogue row with the capability flags directly (mirroring
    /// the wire shape: `reasoning` and `input.image` are the declared Bool
    /// flags, not a variant list). `nil` = the key is absent on the wire.
    private func gylphModel(reasoning: Bool? = nil, image: Bool? = nil) -> OpencodeModel {
        OpencodeModel(
            id: "m",
            providerID: "p",
            name: "m",
            capabilities: ModelCapabilities(
                reasoning: reasoning,
                input: image.map { ModelCapabilities.Modalities(image: $0) }
            )
        )
    }

    func testReasoningFromCapabilityFlag() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(reasoning: true)), ["reasoning"])
    }

    func testVisionFromImageFlag() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(image: true)), ["vision"])
    }

    func testBothInOrderReasoningThenVision() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(reasoning: true, image: true)), ["reasoning", "vision"])
    }

    func testEmptyWhenNeither() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel()), [])
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(reasoning: false)), [])
    }

    func testNoVisionWhenImageFlagMissingOrFalse() {
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(image: false)), [])
        XCTAssertEqual(ChatModel.capabilityGlyphs(gylphModel(reasoning: true, image: false)), ["reasoning"])
    }

    // MARK: - Wire decode (regression guard)
    //
    // Captured verbatim from `POST /rpc/opencode:models` on a live box. The
    // point of this fixture is that it is NOT hand-written: the previous
    // capability tests built ModelCapabilities in Swift and passed green while
    // every real model failed to decode. Note `interleaved` is a Bool on the
    // first model and an OBJECT on the second — declaring a field this app
    // does not use would fail here.
    private static let wireModelsJSON = """
    [
      {
        "id": "claude-opus-4-7",
        "providerID": "anthropic",
        "family": "claude-opus",
        "name": "Claude Opus 4.7",
        "status": "active",
        "limit": { "context": 1000000, "output": 128000 },
        "capabilities": {
          "temperature": false,
          "reasoning": true,
          "attachment": true,
          "toolcall": true,
          "input":  { "text": true, "audio": false, "image": true,  "video": false, "pdf": true  },
          "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
          "interleaved": false
        },
        "variants": [
          { "id": "low" }, { "id": "medium" }, { "id": "high" },
          { "id": "xhigh" }, { "id": "max" }
        ]
      },
      {
        "id": "nemotron-3.5-lightning-free",
        "providerID": "opencode",
        "family": "nemotron-free",
        "name": "Nemotron 3.5 Lightning Free",
        "status": "active",
        "limit": { "context": 262144, "output": 262144 },
        "capabilities": {
          "temperature": true,
          "reasoning": true,
          "attachment": false,
          "toolcall": true,
          "input":  { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
          "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
          "interleaved": { "field": "reasoning_content" }
        }
      }
    ]
    """

    private func wireModels() throws -> [OpencodeModel] {
        try JSONDecoder().decode(
            [OpencodeModel].self,
            from: Data(Self.wireModelsJSON.utf8))
    }

    func testWireModelsDecode() throws {
        let models = try wireModels()
        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].providerID, "anthropic")
        XCTAssertEqual(models[0].id, "claude-opus-4-7")
        XCTAssertEqual(models[0].name, "Claude Opus 4.7")
        XCTAssertEqual(models[1].providerID, "opencode")
        XCTAssertEqual(models[1].id, "nemotron-3.5-lightning-free")
        XCTAssertEqual(models[1].name, "Nemotron 3.5 Lightning Free")
    }

    func testWireContextLimits() throws {
        let models = try wireModels()
        XCTAssertEqual(ChatModel.contextSize(models[0].limit?.context), "1M")
        XCTAssertEqual(ChatModel.contextSize(models[1].limit?.context), "262k")
    }

    func testWireCapabilityGlyphs() throws {
        let models = try wireModels()
        XCTAssertEqual(ChatModel.capabilityGlyphs(models[0]), ["reasoning", "vision"])
        XCTAssertEqual(ChatModel.capabilityGlyphs(models[1]), ["reasoning"])
    }

    func testWireVariants() throws {
        let models = try wireModels()
        XCTAssertEqual(models[0].variants?.map(\.id), ["low", "medium", "high", "xhigh", "max"])
        XCTAssertEqual(models[1].variants?.count ?? 0, 0)
    }

    func testWireModelIsPickable() throws {
        let models = try wireModels()
        XCTAssertTrue(ChatModel.isPickable(models[0]))
        XCTAssertTrue(ChatModel.isPickable(models[1]))
    }

    // MARK: - ChatModel.effortLabel (BET-888)

    func testEffortLabelKnownLevels() {
        XCTAssertEqual(ChatModel.effortLabel("low"), "Low")
        XCTAssertEqual(ChatModel.effortLabel("medium"), "Medium")
        XCTAssertEqual(ChatModel.effortLabel("high"), "High")
        XCTAssertEqual(ChatModel.effortLabel("xhigh"), "xHigh")
        XCTAssertEqual(ChatModel.effortLabel("max"), "Max")
    }

    func testEffortLabelIsCaseInsensitive() {
        XCTAssertEqual(ChatModel.effortLabel("XHIGH"), "xHigh")
    }

    func testEffortLabelUnknownFallsBack() {
        XCTAssertEqual(ChatModel.effortLabel("turbo"), "Turbo")
    }

    func testRecentsLabelUsesEffortLabel() {
        let c = ModelChoice(providerID: "anthropic", modelID: "opus", variant: "xhigh", fast: false)
        let label = ModelRecents.label(for: c, models: [])
        XCTAssertTrue(label.contains("xHigh"))
        XCTAssertFalse(label.contains("Xhigh"))
    }

    // MARK: - Cockpit + catalogue copy (BET-894): catalogueBadge / cardSubtitle / pickableCount

    /// A bare model for the badge/subtitle tests, with the context limit and
    /// capability flags explicit the way the wire object carries them.
    private func badgeModel(context: Double?, reasoning: Bool? = nil, image: Bool? = nil) -> OpencodeModel {
        OpencodeModel(
            id: "m",
            providerID: "anthropic",
            name: "m",
            limit: context.map { ModelLimit(context: $0) },
            capabilities: ModelCapabilities(
                reasoning: reasoning,
                input: image.map { ModelCapabilities.Modalities(image: $0) }
            )
        )
    }

    // MARK: - ChatModel.catalogueBadge

    func testCatalogueBadgeFullModel() {
        let m = badgeModel(context: 1_000_000, reasoning: true, image: true)
        XCTAssertEqual(ChatModel.catalogueBadge(m), "1M · reasoning · vision")
    }

    func testCatalogueBadgeNoLimitGlyphsOnly() {
        let m = badgeModel(context: nil, reasoning: true, image: true)
        XCTAssertEqual(ChatModel.catalogueBadge(m), "reasoning · vision")
    }

    func testCatalogueBadgeNoLimitNoCapabilitiesIsEmpty() {
        let m = badgeModel(context: nil)
        XCTAssertEqual(ChatModel.catalogueBadge(m), "")
    }

    // MARK: - ChatModel.cardSubtitle

    func testCardSubtitleFullModel() {
        let m = badgeModel(context: 1_000_000, reasoning: true)
        XCTAssertEqual(ChatModel.cardSubtitle(m), "anthropic · 1M context · reasoning")
    }

    func testCardSubtitleMissingLimitOmitsContextClause() {
        let m = badgeModel(context: nil, reasoning: true)
        XCTAssertEqual(ChatModel.cardSubtitle(m), "anthropic · reasoning")
    }

    func testCardSubtitleNoCapabilitiesProviderAndContext() {
        let m = badgeModel(context: 1_000_000)
        XCTAssertEqual(ChatModel.cardSubtitle(m), "anthropic · 1M context")
    }

    // MARK: - ChatModel.pickableCount

    func testPickableCountExcludesDisabledDeprecatedAndFastTwins() {
        let base = OpencodeModel(id: "gpt-5.6", providerID: "openai", name: "GPT-5.6")
        // The -fast twin of a visible base is a MODE, not a choice — excluded.
        let fast = OpencodeModel(id: "gpt-5.6-fast", providerID: "openai", name: "GPT-5.6 Fast")
        let disabled = OpencodeModel(id: "disabled", providerID: "openai", name: "Disabled", enabled: false)
        let deprecated = OpencodeModel(id: "deprecated", providerID: "openai", name: "Deprecated", status: "deprecated")
        let regular = OpencodeModel(id: "gpt-4o", providerID: "openai", name: "GPT-4o")
        let models = [base, fast, disabled, deprecated, regular]

        XCTAssertEqual(ChatModel.pickableCount(models), 2)
        // Must equal the sum of the sections `groups(_:)` actually renders.
        let groupsSum = ChatModel.groups(models).reduce(0) { $0 + $1.models.count }
        XCTAssertEqual(ChatModel.pickableCount(models), groupsSum)
    }

    func testPickableCountSingleModel() {
        let models = [OpencodeModel(id: "opus", providerID: "anthropic", name: "Claude Opus 4.7")]
        XCTAssertEqual(ChatModel.pickableCount(models), 1)
    }
}
