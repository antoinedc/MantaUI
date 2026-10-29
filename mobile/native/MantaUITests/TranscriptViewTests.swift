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
}
