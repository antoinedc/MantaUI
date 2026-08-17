import XCTest
@testable import MantaUI

// BET-1029 — voice notes in the transcript. Pure logic only: the message→note
// map that attaches a player bubble under the user message that dictated it,
// the `.file` attachment block emission, the `VoiceNote` wire decode, and the
// clock format. No HTTP/view involved beyond the model decode.

final class VoiceNoteTests: XCTestCase {

    // MARK: - Fixture builders

    private func textPart(_ id: String, _ messageID: String, _ text: String) -> OpencodePart {
        OpencodePart(type: "text", id: id, messageID: messageID, text: text)
    }

    private func userMessage(id: String, parts: [OpencodePart]) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: "user"),
                time: OpencodeTime(created: 0, completed: 1),
                modelID: nil,
                providerID: nil
            ),
            parts: parts
        )
    }

    private func note(id: String, transcript: String) -> VoiceNote {
        VoiceNote(
            id: id,
            sessionId: "ses",
            transcript: transcript,
            mime: "audio/mp4",
            durationMs: 7000,
            peaks: [10, 20, 30],
            createdAt: 0,
            expiresAt: nil,
            audioAvailable: true
        )
    }

    // MARK: - buildVoiceNoteMap

    func testNoteClaimsFirstUnclaimedMatchingMessage() {
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "record this note")])]
        let map = ChatTranscriptMapper.buildVoiceNoteMap(messages: msgs, notes: [note(id: "n1", transcript: "record this note")])
        XCTAssertEqual(map["m1"]?.id, "n1")
    }

    func testDuplicateTranscriptClaimsNextUnclaimedMessageNotTheSameOne() {
        let msgs = [
            userMessage(id: "m1", parts: [textPart("p1", "m1", "apple")]),
            userMessage(id: "m2", parts: [textPart("p1", "m2", "apple")]),
        ]
        let map = ChatTranscriptMapper.buildVoiceNoteMap(
            messages: msgs,
            notes: [note(id: "n1", transcript: "apple"), note(id: "n2", transcript: "apple")]
        )
        // n1 claims the FIRST unclaimed match (m1); n2 the NEXT (m2).
        XCTAssertEqual(map["m1"]?.id, "n1")
        XCTAssertEqual(map["m2"]?.id, "n2")
    }

    func testNoteMatchingNothingIsDropped() {
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "hello")])]
        let map = ChatTranscriptMapper.buildVoiceNoteMap(messages: msgs, notes: [note(id: "n1", transcript: "no such message")])
        XCTAssertTrue(map.isEmpty)
    }

    func testMatchingUsesConcatenatedTextParts() {
        // Two text parts join with a newline — the exact text a dictated message
        // claims against.
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "line one"), textPart("p2", "m1", "line two")])]
        let map = ChatTranscriptMapper.buildVoiceNoteMap(messages: msgs, notes: [note(id: "n1", transcript: "line one\nline two")])
        XCTAssertEqual(map["m1"]?.id, "n1")
    }

    func testEmptyTranscriptNoteIsSkipped() {
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "hello")])]
        let map = ChatTranscriptMapper.buildVoiceNoteMap(
            messages: msgs,
            notes: [note(id: "n1", transcript: "   ")]
        )
        XCTAssertTrue(map.isEmpty)
    }

    // MARK: - Transcript block emission

    func testBlocksEmitsAttachmentUnderUserBand() {
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "dictated")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs, voiceNotes: [note(id: "n1", transcript: "dictated")])
        XCTAssertEqual(blocks.count, 2)
        guard case .user(let text, _) = blocks[0] else { return XCTFail("expected user") }
        XCTAssertEqual(text, "dictated")
        guard case .file(let attachment) = blocks[1],
              case .voiceNote(let claimed) = attachment.kind else {
            return XCTFail("expected .file(.voiceNote) after the user band")
        }
        XCTAssertEqual(claimed.id, "n1")
    }

    func testBlocksWithNoMatchingNoteEmitsNoAttachment() {
        let msgs = [userMessage(id: "m1", parts: [textPart("p1", "m1", "typed")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs, voiceNotes: [note(id: "n1", transcript: "unrelated")])
        XCTAssertEqual(blocks.count, 1)
    }

    // MARK: - Model decode + expired row

    func testVoiceNoteDecodesAudioAvailableRecord() throws {
        let json: [String: Any] = [
            "id": "n1", "sessionId": "ses", "transcript": "hi", "mime": "audio/mp4",
            "durationMs": 7000, "peaks": Data([1, 2, 3]).base64EncodedString(),
            "createdAt": 0, "expiresAt": NSNull(), "audioAvailable": true,
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let note = try JSONDecoder().decode(VoiceNote.self, from: data)
        XCTAssertEqual(note.id, "n1")
        XCTAssertEqual(note.sessionId, "ses")
        XCTAssertEqual(note.durationMs, 7000)
        XCTAssertEqual(note.peaks, [1, 2, 3])
        XCTAssertNil(note.expiresAt)
        XCTAssertEqual(note.audioAvailable, true)
    }

    func testVoiceNoteDecodesAudioUnavailableAsExpired() throws {
        let json: [String: Any] = [
            "id": "n1", "sessionId": "ses", "transcript": "kept", "mime": "audio/mp4",
            "durationMs": 7000, "peaks": Data([1, 2, 3]).base64EncodedString(),
            "createdAt": 0, "expiresAt": 123, "audioAvailable": false,
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let note = try JSONDecoder().decode(VoiceNote.self, from: data)
        XCTAssertEqual(note.audioAvailable, false)
        // The row's expired branch is `!note.audioAvailable` — this is what
        // marks an expired note non-interactive with a "· expired" suffix.
        XCTAssertFalse(note.audioAvailable)
    }

    // MARK: - Clock format through Waveform.formatClock

    func testClockFormatGoesThroughFormatClock() {
        XCTAssertEqual(Waveform.formatClock(7000), "0:07")
        XCTAssertEqual(Waveform.formatClock(63_000), "1:03")
    }
}
