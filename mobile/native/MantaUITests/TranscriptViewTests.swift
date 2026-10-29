import XCTest
@testable import MantaUI

// WS11 D8–D11 — decoding the box's transcript view. Foundation-only (Linux-eligible): the decode tests and the
// pieces that need no SwiftUI. Mapper/placement tests that need `ChatTranscriptMapper` live in TranscriptMapperTests
// (Mac).

final class TranscriptViewTests: XCTestCase {

    private func decode(_ json: String) throws -> [OpencodeMessage] {
        try JSONDecoder().decode([OpencodeMessage].self, from: Data(json.utf8))
    }

    private let info = #""info":{"id":"a1","sessionID":"s","role":"assistant"}"#

    func testAMessageWithoutAViewDecodesAsBefore() throws {
        let m = try decode(#"[{\#(info),"parts":[]}]"#)
        XCTAssertNil(m[0].view)
    }

    func testTurnAndTruncationDecode() throws {
        let json = #"[{\#(info),"parts":[],"view":{"turn":{"durationMs":4000,"tokens":42,"verbSeedId":"a0"},"truncation":{"kind":"output-cap","label":"truncated (output limit)","hint":"Ask to continue."}}}]"#
        let v = try XCTUnwrap(try decode(json)[0].view)
        XCTAssertEqual(v.turn, TranscriptTurnView(durationMs: 4000, tokens: 42, verbSeedId: "a0"))
        XCTAssertEqual(v.truncation, TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "Ask to continue."))
    }

    func testNullDurationAndTokensDecodeAsNil() throws {
        let json = #"[{\#(info),"parts":[],"view":{"turn":{"durationMs":null,"tokens":null,"verbSeedId":"a1"}}}]"#
        let turn = try XCTUnwrap(try decode(json)[0].view?.turn)
        XCTAssertNil(turn.durationMs)
        XCTAssertNil(turn.tokens)
    }

    func testAMalformedViewNeverFailsTheMessageItRidesOn() throws {
        for bad in [#""view":"junk""#, #""view":[1,2]"#, #""view":{"turn":"x","truncation":7}"#, #""view":{"turn":{"verbSeedId":5}}"#, #""view":null"#] {
            let m = try decode(#"[{\#(info),"parts":[],\#(bad)}]"#)
            XCTAssertEqual(m[0].info.id, "a1", "the message survives: \(bad)")
            XCTAssertNil(m[0].view?.turn, bad)
            XCTAssertNil(m[0].view?.truncation, bad)
        }
    }

    func testAnEmptyHintIsNoHint() throws {
        let v = TranscriptTruncationView(kind: "output-cap", label: "L", hint: "")
        XCTAssertNil(v.hint)
        let json = #"[{\#(info),"parts":[],"view":{"truncation":{"kind":"output-cap","label":"L","hint":""}}}]"#
        XCTAssertNil(try decode(json)[0].view?.truncation?.hint)
    }

    func testTheStreamTruncationPayloadCarriesTheHint() throws {
        let p = try JSONDecoder().decode(StreamTruncationPayload.self, from: Data(#"{"kind":"output-cap","label":"L","hint":"H","messageID":"m"}"#.utf8))
        XCTAssertEqual(p.hint, "H")
        let old = try JSONDecoder().decode(StreamTruncationPayload.self, from: Data(#"{"kind":"output-cap","label":"L","messageID":"m"}"#.utf8))
        XCTAssertNil(old.hint)
    }

    func testTheMessagesRequestSendsViewOnlyWhenAsked() {
        // The option is the wire contract; `messages(... view:)` adds `view: true` and nothing else changes.
        // (Pinned end-to-end by MantaActionRPCWireTests on the Mac.)
        XCTAssertEqual(TranscriptTruncationKind(rawValue: "tool-cutoff"), .toolCutoff)
    }

    // MARK: - D9 media decode

    func testMediaEntriesDecodeAndAMalformedOneIsSkippedNotTheWholeList() throws {
        let json = #"[{\#(info),"parts":[],"view":{"media":[{"id":"media:h:a","kind":"image","path":"/a.png","mime":"image/png","width":null,"height":null,"aspectRatio":1.78,"count":null,"size":10,"title":null,"handle":"a"},"junk",{"kind":"image"},{"id":"media:s:m:/b.mp4","kind":"video","path":"/b.mp4"}]}}]"#
        let media = try XCTUnwrap(try decode(json)[0].view?.media)
        XCTAssertEqual(media.map(\.id), ["media:h:a", "media:s:m:/b.mp4"])
        XCTAssertEqual(media[0].aspectRatio, 1.78)
        XCTAssertEqual(media[1].kind, "video")
    }

    func testAMessageViewWithoutMediaHasAnEmptyList() throws {
        XCTAssertEqual(try decode(#"[{\#(info),"parts":[],"view":{}}]"#)[0].view?.media, [])
    }

    // MARK: - D10 plan question decode

    private func decodeQuestion(_ json: String) throws -> QuestionRequest {
        try JSONDecoder().decode(QuestionRequest.self, from: Data(json.utf8))
    }

    func testAQuestionWithAPlanDecodesIt() throws {
        let json = ##"{"id":"q1","sessionID":"s","questions":[],"tool":{"messageID":"m","callID":"c"},"plan":{"title":"Ship login","text":"# Ship login","steps":3,"files":2,"path":".opencode/plans/x.md","pageUrl":"https://b.example/pages/plan-s"}}"##
        let plan = try XCTUnwrap(try decodeQuestion(json).plan)
        XCTAssertEqual(plan, PlanQuestionView(title: "Ship login", text: "# Ship login", steps: 3, files: 2, path: ".opencode/plans/x.md", pageUrl: "https://b.example/pages/plan-s"))
    }

    func testAnOrdinaryQuestionAndAMalformedPlanBothDecodeWithNoPlan() throws {
        XCTAssertNil(try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[]}"#).plan)
        for bad in [#""plan":"junk""#, #""plan":{"text":"no title"}"#, #""plan":null"#] {
            let q = try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[],\#(bad)}"#)
            XCTAssertEqual(q.id, "q1", "the question stays answerable: \(bad)")
            XCTAssertNil(q.plan, bad)
        }
    }

    func testAPlanWithNoPathOrPageDecodesThoseAsNil() throws {
        let plan = try XCTUnwrap(try decodeQuestion(#"{"id":"q1","sessionID":"s","questions":[],"plan":{"title":"T","text":"","steps":0,"files":0,"path":null,"pageUrl":null}}"#).plan)
        XCTAssertNil(plan.path)
        XCTAssertNil(plan.pageUrl)
    }

    // MARK: - The box's golden (src/server/transcriptView.test.mjs pins the box to the same file)

    func testTheBoxGoldenDecodesAndCarriesTheRulesTheBoxPins() throws {
        let scenarios = try TranscriptViewGolden.load()
        XCTAssertGreaterThanOrEqual(scenarios.count, 8)
        let multi = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("a multi-step turn") })
        XCTAssertNil(multi.output.first { $0.info.id == "a1" }?.view)
        XCTAssertEqual(multi.output.first { $0.info.id == "a2" }?.view?.turn,
                       TranscriptTurnView(durationMs: 6000, tokens: 30, verbSeedId: "a1"))
        let running = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("a still-running turn") })
        XCTAssertTrue(running.output.allSatisfy { $0.view == nil })
        let trunc = try XCTUnwrap(scenarios.first { $0.name.hasPrefix("truncation:") })
        XCTAssertEqual(trunc.output.compactMap { $0.view?.truncation?.kind }, ["output-cap", "tool-cutoff", "context-wall", "output-cap"])
        XCTAssertTrue(trunc.output.compactMap { $0.view?.truncation }.allSatisfy { $0.hint != nil })
    }
}

/// `Fixtures/transcript-view.golden.json`: raw messages + the box's `view` annotation for each scenario. A test resource
/// of the app's test bundle; a bare `swift test` has no resource bundle, so it falls back to the checkout the test was
/// compiled from.
struct TranscriptViewGolden: Decodable {
    var name: String
    var running: Bool
    var input: [OpencodeMessage]
    var output: [OpencodeMessage]

    static func load(file: StaticString = #filePath) throws -> [TranscriptViewGolden] {
        let data: Data
        if let url = Bundle(for: TranscriptViewTests.self).url(forResource: "transcript-view.golden", withExtension: "json") {
            data = try Data(contentsOf: url)
        } else {
            var url = URL(fileURLWithPath: "\(file)")
            url.deleteLastPathComponent()
            url.appendPathComponent("Fixtures/transcript-view.golden.json")
            data = try Data(contentsOf: url)
        }
        return try JSONDecoder().decode([TranscriptViewGolden].self, from: data)
    }
}
