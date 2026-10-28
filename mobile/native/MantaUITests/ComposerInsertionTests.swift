import XCTest
@testable import MantaUI

// ===========================================================================
// WS03 C3 — the pure half of the composer insertion API.
// ===========================================================================

final class ComposerInsertionTests: XCTestCase {

    private func stubQuote(_ selection: String) -> String? {
        let trimmed = selection.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : "> \(trimmed)\n\n"
    }

    private func insert(_ text: String, into draft: String, _ mode: ComposerInsertMode) -> String? {
        ComposerInsertion.insert(text, into: draft, mode: mode, quoteBlock: stubQuote)
    }

    // MARK: - insert

    func testAppendIntoBlankDraftIsJustTheText() {
        XCTAssertEqual(insert("new", into: "", .append), "new")
        XCTAssertEqual(insert("new", into: "  \n", .append), "new")
    }

    func testAppendPutsExactlyOneBlankLineBetween() {
        XCTAssertEqual(insert("new", into: "hi", .append), "hi\n\nnew")
        XCTAssertEqual(insert("new", into: "hi\n", .append), "hi\n\nnew")
        XCTAssertEqual(insert("new", into: "hi\n\n\n", .append), "hi\n\nnew")
    }

    func testReplaceReplacesTheWholeDraft() {
        XCTAssertEqual(insert("edited", into: "old draft", .replace), "edited")
    }

    func testQuotePrependsTheBlockToTheDraft() {
        XCTAssertEqual(insert("picked text", into: "my reply", .quote), "> picked text\n\nmy reply")
        XCTAssertEqual(insert("picked text", into: "", .quote), "> picked text\n\n")
    }

    func testBlankInputIsRejected() {
        XCTAssertNil(insert("", into: "draft", .append))
        XCTAssertNil(insert("   \n", into: "draft", .append))
        XCTAssertNil(insert("  ", into: "draft", .replace))
        XCTAssertNil(insert("  ", into: "draft", .quote))
    }

    func testQuoteBlockReturningNilIsRejected() {
        let result = ComposerInsertion.insert("anything", into: "draft", mode: .quote, quoteBlock: { _ in nil })
        XCTAssertNil(result)
    }

    // MARK: - checkAttach

    private func chip(path: String?) -> ComposerAttachment {
        ComposerAttachment(filename: "f", mime: "text/plain", remotePath: path, isImage: false)
    }

    func testCheckAttachRelativePathIsNotAbsolute() {
        XCTAssertEqual(ComposerInsertion.checkAttach(remotePath: "docs/a.md", existing: [], acceptsInput: true), .notAbsolute)
        XCTAssertEqual(ComposerInsertion.checkAttach(remotePath: "", existing: [], acceptsInput: true), .notAbsolute)
    }

    func testCheckAttachDuplicatePath() {
        let existing = [chip(path: "/box/a.md"), chip(path: nil)]
        XCTAssertEqual(ComposerInsertion.checkAttach(remotePath: "/box/a.md", existing: existing, acceptsInput: true), .duplicate)
        XCTAssertNil(ComposerInsertion.checkAttach(remotePath: "/box/b.md", existing: existing, acceptsInput: true))
    }

    func testCheckAttachReadOnlyWinsOverEverything() {
        XCTAssertEqual(ComposerInsertion.checkAttach(remotePath: "/box/a.md", existing: [], acceptsInput: false), .readOnly)
        XCTAssertEqual(ComposerInsertion.checkAttach(remotePath: "relative", existing: [], acceptsInput: false), .readOnly)
    }

    // MARK: - makeChip

    func testMakeChipIsReadyAndImageByMime() {
        let png = ComposerInsertion.makeChip(remotePath: "/box/a.png", displayName: "a.png", mime: "image/png")
        XCTAssertEqual(png.remotePath, "/box/a.png")
        XCTAssertFalse(png.isUploading)
        XCTAssertTrue(png.isImage)
        XCTAssertEqual(png.filename, "a.png")
        let doc = ComposerInsertion.makeChip(remotePath: "/box/a.pdf", displayName: "a.pdf", mime: "application/pdf")
        XCTAssertFalse(doc.isImage)
    }
}
