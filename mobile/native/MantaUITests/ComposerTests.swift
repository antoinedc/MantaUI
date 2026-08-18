import XCTest
@testable import MantaUI

// ===========================================================================
// S5 — composer pure logic (BET-597). Covers ChatModel (model resolution for
// the picker) and ChatVoice (attachment MIME). No HTTP / view / Keychain /
// AVAudioRecorder involved.
// ===========================================================================

final class ComposerTests: XCTestCase {

    // MARK: - Fixtures

    private func model(_ provider: String, _ id: String, name: String? = nil, enabled: Bool? = nil, status: String? = nil) -> OpencodeModel {
        OpencodeModel(
            id: id,
            providerID: provider,
            name: name ?? id,
            family: nil,
            status: status,
            enabled: enabled,
            variants: nil
        )
    }

    private func selection(_ provider: String, _ id: String) -> OpencodeModelID {
        OpencodeModelID(providerID: provider, modelID: id)
    }

    // MARK: - ChatModel.groups

    func testGroupsAlphabeticalAndEnabledOnly() {
        let models = [
            model("zebra", "z1"),
            model("anthropic", "haiku"),
            model("anthropic", "deprecated", status: "deprecated"),
            model("groq", "disabled", enabled: false),
            model("anthropic", "sonnet"),
        ]
        let groups = ChatModel.groups(models)
        XCTAssertEqual(groups.map(\.provider), ["anthropic", "zebra"])
        XCTAssertEqual(groups[0].models.map(\.id), ["haiku", "sonnet"])
    }

    // MARK: - ChatModel.effective

    func testEffectiveOverrideWinsOverDefault() {
        XCTAssertEqual(
            ChatModel.effective(selection("anthropic", "sonnet"), selection("anthropic", "opus")),
            selection("anthropic", "sonnet")
        )
        XCTAssertEqual(ChatModel.effective(nil, selection("anthropic", "opus")), selection("anthropic", "opus"))
        XCTAssertNil(ChatModel.effective(nil, nil))
    }

    // MARK: - ChatModel.activeModel + label

    func testActiveModelResolvesOverrideThenDefaultThenNil() {
        let models = [model("anthropic", "sonnet"), model("anthropic", "opus")]
        XCTAssertEqual(
            ChatModel.activeModel(models, override: selection("anthropic", "sonnet"), default: selection("anthropic", "opus"))?.id,
            "sonnet"
        )
        XCTAssertEqual(
            ChatModel.activeModel(models, override: nil, default: selection("anthropic", "opus"))?.id,
            "opus"
        )
        XCTAssertEqual(ChatModel.activeModel(models, override: nil, default: selection("other", "x"))?.id, nil)
        XCTAssertEqual(ChatModel.activeModel(models, override: nil, default: nil), nil)
    }

    func testLabelUsesFriendlyNameAndDefaults() {
        let models = [model("anthropic", "sonnet", name: "Claude Sonnet 4.6")]
        XCTAssertEqual(ChatModel.label(models, override: selection("anthropic", "sonnet"), default: nil), "Claude Sonnet 4.6")
        XCTAssertEqual(ChatModel.label(models, override: nil, default: nil), "Default")
    }

    // MARK: - ChatModel.findByQuery

    func testFindByQueryExactThenSubstring() {
        let models = [model("anthropic", "claude-sonnet-4-6", name: "Claude Sonnet"), model("deepseek", "deepseek-chat")]
        XCTAssertEqual(ChatModel.findByQuery(models, query: "deepseek-chat")?.id, "deepseek-chat")
        XCTAssertEqual(ChatModel.findByQuery(models, query: "CLAUDE SONNET")?.id, "claude-sonnet-4-6")
        XCTAssertEqual(ChatModel.findByQuery(models, query: "sonnet")?.id, "claude-sonnet-4-6")
        XCTAssertNil(ChatModel.findByQuery(models, query: "   "))
    }

    // MARK: - ChatModel.encode/decode

    func testOverrideEncodeDecodeRoundTrip() {
        let id = selection("anthropic", "claude-sonnet-4-6")
        XCTAssertEqual(ChatModel.decode(ChatModel.encode(id)), id)
        XCTAssertNil(ChatModel.decode(""))
        XCTAssertNil(ChatModel.decode("no-slash"))
    }

    // MARK: - Fast-mode helpers + grouped picker

    private func variantModel(_ provider: String, _ id: String, variants: [String]) -> OpencodeModel {
        OpencodeModel(
            id: id,
            providerID: provider,
            name: id,
            family: nil,
            status: nil,
            enabled: nil,
            variants: variants.map { OpencodeModel.Variant(id: $0) }
        )
    }

    func testFastIDArithmetic() {
        XCTAssertTrue(ChatModel.isFastModelID("gpt-5.6-fast"))
        XCTAssertFalse(ChatModel.isFastModelID("gpt-5.6"))
        XCTAssertFalse(ChatModel.isFastModelID("fast"))
        XCTAssertEqual(ChatModel.baseModelID("gpt-5.6-fast"), "gpt-5.6")
        XCTAssertEqual(ChatModel.baseModelID("gpt-5.6"), "gpt-5.6")
        XCTAssertEqual(ChatModel.fastModelID("gpt-5.6"), "gpt-5.6-fast")
        XCTAssertEqual(ChatModel.fastModelID("gpt-5.6-fast"), "gpt-5.6-fast")
    }

    func testFastToggleBaseModelWithTwinIsAvailableAndOff() {
        let models = [variantModel("openai", "gpt-5.6", variants: ["high"]), variantModel("openai", "gpt-5.6-fast", variants: ["high"])]
        let r = ChatModel.fastToggle(models: models, active: models[0], variantId: "high")
        XCTAssertTrue(r.available)
        XCTAssertFalse(r.on)
        XCTAssertEqual(r.target?.modelID, "gpt-5.6-fast")
    }

    func testFastToggleFastModelReportsOnAndTargetsBase() {
        let models = [variantModel("openai", "gpt-5.6", variants: ["low"]), variantModel("openai", "gpt-5.6-fast", variants: ["low"])]
        let r = ChatModel.fastToggle(models: models, active: models[1], variantId: "low")
        XCTAssertTrue(r.available)
        XCTAssertTrue(r.on)
        XCTAssertEqual(r.target?.modelID, "gpt-5.6")
    }

    func testFastToggleDisabledWhenTwinLacksSelectedEffort() {
        let models = [variantModel("openai", "gpt-5.6", variants: ["high"]), variantModel("openai", "gpt-5.6-fast", variants: ["low"])]
        let r = ChatModel.fastToggle(models: models, active: models[0], variantId: "high")
        XCTAssertFalse(r.available)
        XCTAssertNil(r.target)
    }

    func testFastToggleNullAndNoTwin() {
        XCTAssertFalse(ChatModel.fastToggle(models: [], active: nil, variantId: nil).available)
        XCTAssertFalse(ChatModel.fastToggle(models: [variantModel("openai", "gpt-5.6", variants: [])], active: nil, variantId: nil).available)
        let only = variantModel("openai", "gpt-5.6", variants: [])
        XCTAssertFalse(ChatModel.fastToggle(models: [only], active: only, variantId: nil).available)
    }

    func testFastToggleTwinInDifferentProviderDoesNotCount() {
        let base = variantModel("openai", "gpt-5.6", variants: [])
        let twin = variantModel("other", "gpt-5.6-fast", variants: [])
        let r = ChatModel.fastToggle(models: [base, twin], active: base, variantId: nil)
        XCTAssertFalse(r.available)
    }

    func testGroupsDropsFastSiblingButKeepsOrphan() {
        let withBase = [model("openai", "gpt-5.6"), model("openai", "gpt-5.6-fast")]
        XCTAssertEqual(ChatModel.groups(withBase).first?.models.map(\.id), ["gpt-5.6"])
        // An orphan fast model (no base) stays reachable via its own row.
        let orphan = [model("openai", "solo-fast")]
        XCTAssertEqual(ChatModel.groups(orphan).first?.models.map(\.id), ["solo-fast"])
    }

    func testFilteredGroupsMatchesNameIdAndProvider() {
        let g = [("anthropic", [variantModel("anthropic", "claude-sonnet-4-6", variants: []), variantModel("anthropic", "haiku", variants: [])])]
        XCTAssertEqual(ChatModel.filteredGroups(g, query: "sonnet").first?.models.count, 1)
        XCTAssertEqual(ChatModel.filteredGroups(g, query: "anthropic").first?.models.count, 2)
        XCTAssertEqual(ChatModel.filteredGroups(g, query: "nope").count, 0)
        XCTAssertEqual(ChatModel.filteredGroups(g, query: "  ").first?.models.count, 2)
    }

    // MARK: - ChatModel.planToggle (BET-952, mirrors desktop resolvePlanToggle)

    private func agent(_ name: String, mode: String?) -> OpencodeAgent {
        OpencodeAgent(name: name, description: nil, mode: mode, native: nil, builtIn: nil)
    }

    func testPlanToggleNilAgentsIsLoading() {
        let r = ChatModel.planToggle(agents: nil, on: false)
        XCTAssertTrue(r.loading)
        XCTAssertFalse(r.available)
        XCTAssertEqual(r.title, "Loading agents…")
    }

    func testPlanToggleNoPlanAgentIsUnavailableOff() {
        let r = ChatModel.planToggle(agents: [agent("build", mode: "primary")], on: false)
        XCTAssertFalse(r.available)
        XCTAssertFalse(r.on)
        XCTAssertEqual(r.title, "This server has no plan agent")
        XCTAssertNil(r.agent)
    }

    func testPlanToggleNoPlanAgentButOnStaysLit() {
        let r = ChatModel.planToggle(agents: [agent("build", mode: "primary")], on: true)
        XCTAssertFalse(r.available)
        XCTAssertTrue(r.on)
        XCTAssertEqual(r.title, "Plan mode on (plan agent unavailable)")
    }

    func testPlanToggleSubagentNamedPlanDoesNotCount() {
        let r = ChatModel.planToggle(agents: [agent("plan", mode: "subagent")], on: false)
        XCTAssertFalse(r.available)
        XCTAssertEqual(r.title, "This server has no plan agent")
    }

    func testPlanToggleAvailableOffAndOn() {
        let agents = [agent("build", mode: "primary"), agent("plan", mode: "primary")]
        let off = ChatModel.planToggle(agents: agents, on: false)
        XCTAssertTrue(off.available)
        XCTAssertFalse(off.on)
        XCTAssertEqual(off.agent, "plan")
        XCTAssertEqual(off.title, "Plan mode off — click to plan without editing")
        let on = ChatModel.planToggle(agents: agents, on: true)
        XCTAssertTrue(on.available)
        XCTAssertTrue(on.on)
        XCTAssertEqual(on.agent, "plan")
        XCTAssertEqual(on.title, "Plan mode on — edits blocked. Click to build.")
    }

    // MARK: - ChatModel.shortName

    func testShortNameStripsKnownBrandPrefix() {
        XCTAssertEqual(ChatModel.shortName("Claude Opus 5"), "Opus 5")
    }

    func testShortNameLeavesUnknownPrefixAlone() {
        XCTAssertEqual(ChatModel.shortName("Kimi K3 Turbo"), "Kimi K3 Turbo")
    }

    func testShortNameLeavesSingleWordAlone() {
        XCTAssertEqual(ChatModel.shortName("Claude"), "Claude")
        XCTAssertEqual(ChatModel.shortName("o3"), "o3")
    }

    func testShortNameMatchingIsCaseSensitive() {
        XCTAssertEqual(ChatModel.shortName("claude opus 5"), "claude opus 5")
    }

    func testShortNameHandlesSurroundingAndDoubledInnerWhitespace() {
        XCTAssertEqual(ChatModel.shortName("  Claude  Opus 5  "), "Opus 5")
    }

    func testShortNameRemovesOnlyFirstWord() {
        XCTAssertEqual(ChatModel.shortName("Gemini Claude Weird"), "Claude Weird")
    }

    // MARK: - ChatVoice.mime

    func testMimeFromFilenameExtension() {
        XCTAssertEqual(ChatVoice.mime(forFilename: "report.pdf"), "application/pdf")
        XCTAssertEqual(ChatVoice.mime(forFilename: "shot.PNG"), "image/png")
        XCTAssertEqual(ChatVoice.mime(forFilename: "notes"), "application/octet-stream")
    }

    func testMimeFromImageDataSniff() {
        let jpeg: [UInt8] = [0xFF, 0xD8, 0xFF, 0xE0]
        let png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]
        XCTAssertEqual(ChatVoice.mime(forImageData: Data(jpeg)), "image/jpeg")
        XCTAssertEqual(ChatVoice.mime(forImageData: Data(png)), "image/png")
        XCTAssertEqual(ChatVoice.mime(forImageData: Data([0x00, 0x01, 0x02])), "image/jpeg")
    }
}
