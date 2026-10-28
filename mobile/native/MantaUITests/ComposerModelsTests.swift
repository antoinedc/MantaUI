import XCTest
@testable import MantaUI

// ===========================================================================
// WS03 — composer wire types + the submission settle rules.
//
// The settle rules are what keep a slow command from eating what the user did
// while it was in flight: only what was submitted is removed, and only once the
// box accepted it.
// ===========================================================================

final class ComposerModelsTests: XCTestCase {

    private func chip(_ name: String, path: String? = "/box/file") -> ComposerAttachment {
        ComposerAttachment(filename: name, mime: "text/plain", remotePath: path, isImage: false)
    }

    // MARK: - accepted

    func testAcceptedUnchangedDraftClearsTextMentionsAndSubmittedChips() {
        let a = chip("a.txt")
        let snapshot = ComposerSubmission(text: "/review x", attachmentIDs: [a.id], agentNames: ["general"])
        let result = ComposerSubmissionSettle.accepted(snapshot, text: "/review x", attachments: [a], agentNames: ["general"])
        XCTAssertEqual(result.text, "")
        XCTAssertTrue(result.attachments.isEmpty)
        XCTAssertTrue(result.agentNames.isEmpty)
    }

    /// A chip added while the request was in flight is not in the snapshot: it survives.
    func testAcceptedKeepsChipAddedDuringRequest() {
        let sent = chip("sent.txt")
        let added = chip("added.txt")
        let snapshot = ComposerSubmission(text: "/cmd", attachmentIDs: [sent.id], agentNames: [])
        let result = ComposerSubmissionSettle.accepted(snapshot, text: "/cmd", attachments: [sent, added], agentNames: [])
        XCTAssertEqual(result.attachments.map(\.id), [added.id])
        XCTAssertEqual(result.text, "")
    }

    /// Text edited during the request survives with its agent selections, while
    /// the submitted chips are still removed (no double send).
    func testAcceptedKeepsEditedTextAndMentionsButRemovesSubmittedChips() {
        let sent = chip("sent.txt")
        let snapshot = ComposerSubmission(text: "/cmd one", attachmentIDs: [sent.id], agentNames: ["plan"])
        let result = ComposerSubmissionSettle.accepted(
            snapshot, text: "/cmd one and more", attachments: [sent], agentNames: ["plan", "build"])
        XCTAssertEqual(result.text, "/cmd one and more")
        XCTAssertEqual(result.agentNames, ["plan", "build"])
        XCTAssertTrue(result.attachments.isEmpty)
    }

    /// The user already removed a submitted chip: nothing else is touched, nothing crashes.
    func testAcceptedWhenSubmittedChipAlreadyRemoved() {
        let gone = chip("gone.txt")
        let other = chip("other.txt")
        let snapshot = ComposerSubmission(text: "hi", attachmentIDs: [gone.id], agentNames: [])
        let result = ComposerSubmissionSettle.accepted(snapshot, text: "hi", attachments: [other], agentNames: [])
        XCTAssertEqual(result.attachments.map(\.id), [other.id])
        XCTAssertEqual(result.text, "")
    }

    // MARK: - localAction

    /// `/fork` with one ready chip and one agent selection: only the command text
    /// is consumed. The chip and the selection are never passed in, so they stay —
    /// identically whether the fork later succeeds or fails.
    func testLocalActionConsumesOnlyUnchangedCommandText() {
        let ready = chip("ready.txt")
        let agents = ["general"]
        let snapshot = ComposerSubmission(text: "/fork", attachmentIDs: [ready.id], agentNames: agents)

        XCTAssertEqual(ComposerSubmissionSettle.localAction(snapshot, text: "/fork"), "")
        XCTAssertEqual(ComposerSubmissionSettle.localAction(snapshot, text: "/fork now"), "/fork now")
    }

    // MARK: - Wire types

    func testCommandInfoDecodesFixtureWithExtraKeys() throws {
        let json = """
        [
          {"name":"review","description":"Review code","source":"project","argumentHint":"<file>",
           "agent":"build","model":"anthropic/x","template":"do $ARGUMENTS","background":true},
          {"name":"brainstorm","source":"skill"}
        ]
        """
        let list = try JSONDecoder().decode([OpencodeCommandInfo].self, from: Data(json.utf8))
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0].name, "review")
        XCTAssertEqual(list[0].background, true)
        XCTAssertEqual(list[0].argumentHint, "<file>")
        XCTAssertFalse(list[0].isSkill)
        XCTAssertTrue(list[1].isSkill)
        XCTAssertNil(list[1].description)
    }

    /// Documents why `commands(directory:)` uses `callRequired`: a JSON `null`
    /// result cannot decode into a list (it would otherwise read as "loaded, empty").
    func testNullCommandListFailsToDecodeWhileEmptyArraySucceeds() throws {
        XCTAssertThrowsError(try JSONDecoder().decode([OpencodeCommandInfo].self, from: Data("null".utf8)))
        let empty = try JSONDecoder().decode([OpencodeCommandInfo].self, from: Data("[]".utf8))
        XCTAssertTrue(empty.isEmpty)
    }

    func testReferenceInfoDecodesFixtureAndNullFails() throws {
        let json = #"[{"name":"docs","path":"/srv/docs","repository":"org/docs","branch":"main","description":"Docs","hidden":false,"extra":1}]"#
        let list = try JSONDecoder().decode([OpencodeReferenceInfo].self, from: Data(json.utf8))
        XCTAssertEqual(list.first?.name, "docs")
        XCTAssertEqual(list.first?.repository, "org/docs")
        XCTAssertEqual(list.first?.hidden, false)
        XCTAssertThrowsError(try JSONDecoder().decode([OpencodeReferenceInfo].self, from: Data("null".utf8)))
    }

    func testRunCommandResultDecodesJobIdAndToleratesOtherShapes() throws {
        let withJob = try JSONDecoder().decode(RunCommandResult.self, from: Data(#"{"jobId":"abc"}"#.utf8))
        XCTAssertEqual(withJob.jobId, "abc")
        let empty = try JSONDecoder().decode(RunCommandResult.self, from: Data("{}".utf8))
        XCTAssertNil(empty.jobId)
        let other = try JSONDecoder().decode(RunCommandResult.self, from: Data(#""accepted""#.utf8))
        XCTAssertNil(other.jobId)
    }

    // MARK: - Error copy

    func testErrorCopyUsesServerAndTransportText() {
        XCTAssertEqual(ComposerErrorCopy.message(for: MantaError.server("opencode runCommand 400: nope")), "opencode runCommand 400: nope")
        XCTAssertEqual(ComposerErrorCopy.message(for: MantaError.transport("offline")), "offline")
    }
}
