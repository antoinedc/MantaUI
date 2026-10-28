import XCTest
@testable import MantaUI

// ===========================================================================
// WS03 C3 — ComposerTextController (SwiftUI/Combine, so it runs only in the
// Mac `test-unit` bundle; the pure rules it delegates to are covered by
// ComposerInsertionTests under verify.sh).
// ===========================================================================

@MainActor
final class ComposerTextControllerTests: XCTestCase {

    // MARK: - insert

    func testQuoteUsesRealQuoteTextTruncatedWithSingleMarker() {
        let controller = ComposerTextController(text: "reply")
        let selection = String(repeating: "word ", count: 80)   // 400 chars
        XCTAssertTrue(controller.insert(text: selection, mode: .quote))
        XCTAssertTrue(controller.text.hasPrefix("> "))
        XCTAssertTrue(controller.text.hasSuffix("\n\nreply"))
        XCTAssertEqual(controller.text.components(separatedBy: "> ").count, 2, "exactly one quote marker")
        XCTAssertTrue(controller.text.contains(" \u{2026} "))
        let quoted = controller.text.dropFirst(2).components(separatedBy: "\n\n").first ?? ""
        XCTAssertLessThanOrEqual(quoted.count, QuoteText.max + 3)
    }

    func testFocusRequestBumpsOnlyOnSuccess() {
        let controller = ComposerTextController()
        XCTAssertEqual(controller.focusRequest, 0)
        XCTAssertFalse(controller.insert(text: "   ", mode: .append))
        XCTAssertEqual(controller.focusRequest, 0)
        XCTAssertTrue(controller.insert(text: "hello", mode: .append))
        XCTAssertEqual(controller.focusRequest, 1)
        XCTAssertFalse(controller.attach(remotePath: "relative.txt", displayName: "relative.txt", mime: nil))
        XCTAssertEqual(controller.focusRequest, 1)
        XCTAssertTrue(controller.attach(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil))
        XCTAssertEqual(controller.focusRequest, 2)
    }

    func testReplaceKeepsChips() {
        let chip = ComposerInsertion.makeChip(remotePath: "/box/a.txt", displayName: "a.txt", mime: "text/plain")
        let controller = ComposerTextController(text: "old", attachments: [chip])
        XCTAssertTrue(controller.insert(text: "new text", mode: .replace))
        XCTAssertEqual(controller.text, "new text")
        XCTAssertEqual(controller.attachments.map(\.id), [chip.id])
    }

    // MARK: - attach

    func testAttachInfersMimeFromDisplayName() {
        let controller = ComposerTextController()
        XCTAssertTrue(controller.attach(remotePath: "/box/blob", displayName: "a.png", mime: nil))
        XCTAssertEqual(controller.attachments.first?.mime, "image/png")
        XCTAssertEqual(controller.attachments.first?.isImage, true)
        XCTAssertEqual(controller.attachments.first?.isUploading, false)
    }

    func testAttachFallsBackToPathNameWhenDisplayNameHasNoExtension() {
        let controller = ComposerTextController()
        XCTAssertTrue(controller.attach(remotePath: "/box/report.pdf", displayName: "Report", mime: nil))
        XCTAssertEqual(controller.attachments.first?.mime, "application/pdf")
        XCTAssertEqual(controller.attachments.first?.filename, "Report")
    }

    func testExplicitMimeWins() {
        let controller = ComposerTextController()
        XCTAssertTrue(controller.attach(remotePath: "/box/a.png", displayName: "a.png", mime: "application/x-custom"))
        XCTAssertEqual(controller.attachments.first?.mime, "application/x-custom")
    }

    func testDuplicateAttachIsRefusedWithReason() {
        let controller = ComposerTextController()
        XCTAssertTrue(controller.attach(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil))
        XCTAssertFalse(controller.attach(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil))
        XCTAssertEqual(controller.lastAttachRejection, .duplicate)
        XCTAssertEqual(controller.attachments.count, 1)
    }

    func testReadOnlyRejectsBothApis() {
        let controller = ComposerTextController(text: "keep")
        controller.acceptsInput = false
        XCTAssertFalse(controller.insert(text: "x", mode: .append))
        XCTAssertFalse(controller.attach(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil))
        XCTAssertEqual(controller.lastAttachRejection, .readOnly)
        XCTAssertEqual(controller.text, "keep")
        XCTAssertTrue(controller.attachments.isEmpty)
        XCTAssertEqual(controller.focusRequest, 0)
    }

    // MARK: - New-session draft

    func testNewSessionDraftDropsUploadingChipsAndMapsFields() {
        let ready = ComposerInsertion.makeChip(remotePath: "/box/a.png", displayName: "a.png", mime: "image/png")
        let uploading = ComposerAttachment(filename: "b.txt", mime: "text/plain", remotePath: nil, isImage: false)
        let controller = ComposerTextController(text: "do the thing", attachments: [ready, uploading])
        let draft = controller.newSessionDraft(cwd: "/work/repo")
        XCTAssertEqual(draft.text, "do the thing")
        XCTAssertEqual(draft.cwd, "/work/repo")
        XCTAssertEqual(draft.attachments, [NewSessionDraftAttachment(remotePath: "/box/a.png", displayName: "a.png", mime: "image/png")])
        XCTAssertNil(draft.worktreeBranch)
        XCTAssertNil(draft.linkedIssueURL)
        XCTAssertNil(controller.newSessionDraft(cwd: nil).cwd)
    }

    func testApplySeedsEmptyComposerAndAppendsBelowExistingDraft() {
        let draft = NewSessionDraft(text: "seed", attachments: [
            NewSessionDraftAttachment(remotePath: "/box/a.txt", displayName: "a.txt", mime: "text/plain"),
        ])
        let empty = ComposerTextController()
        XCTAssertEqual(empty.apply(draft), 0)
        XCTAssertEqual(empty.text, "seed")
        XCTAssertEqual(empty.attachments.count, 1)

        let typed = ComposerTextController(text: "already typed")
        XCTAssertEqual(typed.apply(draft), 0)
        XCTAssertEqual(typed.text, "already typed\n\nseed")
    }

    func testApplyCountsDuplicateAsRejected() {
        let attachment = NewSessionDraftAttachment(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil)
        let controller = ComposerTextController()
        let rejected = controller.apply(NewSessionDraft(text: "", attachments: [attachment, attachment]))
        XCTAssertEqual(rejected, 1)
        XCTAssertEqual(controller.attachments.count, 1)
    }

    func testSeedingInitWithRejectedAttachmentSetsNoticeOnce() {
        let draft = NewSessionDraft(text: "hello", attachments: [
            NewSessionDraftAttachment(remotePath: "/box/ok.txt", displayName: "ok.txt", mime: nil),
            NewSessionDraftAttachment(remotePath: "relative/bad.txt", displayName: "bad.txt", mime: nil),
        ])
        let controller = ComposerTextController(draft: draft)
        XCTAssertEqual(controller.text, "hello")
        XCTAssertEqual(controller.attachments.count, 1)
        XCTAssertEqual(controller.seedNotice, "1 attachment couldn't be carried over")
        XCTAssertEqual(controller.consumeSeedNotice(), "1 attachment couldn't be carried over")
        XCTAssertNil(controller.consumeSeedNotice())
    }

    /// A read-only composer takes neither the text nor the chips, and reports
    /// every attachment as rejected instead of dropping the draft silently.
    func testApplyOnReadOnlyComposerRejectsEverything() {
        let controller = ComposerTextController()
        controller.acceptsInput = false
        let draft = NewSessionDraft(text: "hello", attachments: [
            NewSessionDraftAttachment(remotePath: "/box/a.txt", displayName: "a.txt", mime: nil),
        ])
        XCTAssertEqual(controller.apply(draft), 1)
        XCTAssertEqual(controller.text, "")
        XCTAssertTrue(controller.attachments.isEmpty)
    }

    func testSeedNoticeIsPluralForSeveralRejections() {
        let bad = NewSessionDraftAttachment(remotePath: "x", displayName: "x", mime: nil)
        let controller = ComposerTextController(draft: NewSessionDraft(attachments: [bad, bad]))
        XCTAssertEqual(controller.consumeSeedNotice(), "2 attachments couldn't be carried over")
    }

    /// The rebuilt composer after a clear / handoff has no draft: no seed text, no notice.
    func testControllerWithoutDraftHasNoSeedTextOrNotice() {
        let controller = ComposerTextController()
        XCTAssertEqual(controller.text, "")
        XCTAssertTrue(controller.attachments.isEmpty)
        XCTAssertNil(controller.seedNotice)
        XCTAssertNil(controller.consumeSeedNotice())
    }
}
