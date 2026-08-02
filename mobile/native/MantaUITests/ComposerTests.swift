import XCTest
@testable import MantaUI

// ===========================================================================
// S5 — composer pure logic (BET-597). Covers ChatModel (model resolution for
// the picker) and ChatVoice (classifier-reply mapping + attachment MIME). No
// HTTP / view / Keychain / AVAudioRecorder involved.
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

    // MARK: - ChatVoice.parse

    private func classify(_ kind: String, text: String? = nil, choice: String? = nil, query: String? = nil, index: Int? = nil, transcript: String? = nil) -> VoiceClassifyResult {
        VoiceClassifyResult(kind: kind, text: text, index: index, query: query, choice: choice, transcript: transcript, actions: nil)
    }

    func testParseStandardActions() {
        XCTAssertEqual(ChatVoice.parse(classify("abort")), .abort)
        XCTAssertEqual(ChatVoice.parse(classify("compact")), .compact)
        XCTAssertEqual(ChatVoice.parse(classify("allow-once")), .allowOnce)
        XCTAssertEqual(ChatVoice.parse(classify("reject")), .reject)
        XCTAssertEqual(ChatVoice.parse(classify("submit", text: "look at this")), .submit(text: "look at this"))
        XCTAssertEqual(ChatVoice.parse(classify("append", text: "remember")), .append(text: "remember"))
        XCTAssertEqual(ChatVoice.parse(classify("answer", choice: "3")), .answer(choice: "3"))
        XCTAssertEqual(ChatVoice.parse(classify("model", query: "haiku")), .model(query: "haiku"))
        XCTAssertEqual(ChatVoice.parse(classify("switch-window", index: 2)), .switchWindow(index: 2))
    }

    func testParseUnknownDegrades() {
        XCTAssertEqual(ChatVoice.parse(classify("unknown", transcript: "do the thing")), .unknown(transcript: "do the thing"))
        // A nil/empty kind is treated as unknown.
        XCTAssertEqual(ChatVoice.parse(classify("", transcript: "hi")), .unknown(transcript: "hi"))
    }

    // MARK: - ChatVoice.choiceToken

    func testChoiceTokenCores() {
        XCTAssertEqual(ChatVoice.choiceToken("yes"), "yes")
        XCTAssertEqual(ChatVoice.choiceToken("NOPE"), "no")
        XCTAssertEqual(ChatVoice.choiceToken("okay"), "yes")
        XCTAssertNil(ChatVoice.choiceToken("the third one"))
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

    // MARK: - Voice action store routing (permission/question)

    @MainActor
    func testDispatchVoiceAnswerFallsBackWhenNoQuestion() {
        // No question pending → a hint (non-nil), and it must not crash.
        let store = ChatSessionStore(sessionId: "ses", eventStore: MantaEventStore(), api: MantaAPIClient(serverURL: URL(string: "https://box.example")!))
        let hint = store.dispatchVoice(.answer(choice: "yes"))
        XCTAssertNotNil(hint)
    }
}
