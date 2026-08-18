import XCTest
@testable import MantaUI

// BET-1085 — the bounded inline preview of a tool's output. The box streams up
// to 20,000 chars per tool and flushes the ENTIRE final output one frame before
// toolEnded, so an unbounded inline view blows out a self-sizing cell and shoves
// the composer off screen. The preview must never exceed 12 lines / 2,000 chars,
// and a trimmed tail is flagged with a "… " prefix.

final class ToolOutputPreviewTests: XCTestCase {

    func testShortOutputIsUnchanged() {
        XCTAssertEqual(ToolOutputPreview.tail("hello"), "hello")
    }

    func testThirtyLinesKeepsLastTwelveWithPrefix() {
        let lines = (1...30).map { "line \($0)" }
        let output = ToolOutputPreview.tail(lines.joined(separator: "\n"))
        XCTAssertTrue(output.hasPrefix("… \n"), "a line-trimmed tail must carry the prefix")
        XCTAssertEqual(output.components(separatedBy: "\n").count, ToolOutputPreview.maxLines + 1,
                       "prefix line + the kept \(ToolOutputPreview.maxLines) lines")
        XCTAssertTrue(output.hasSuffix("line 30"), "the tail must keep the NEWEST lines")
        XCTAssertFalse(output.contains("line 1"), "the head-most lines must be dropped")
    }

    func testSingleEnormousLineIsCharacterBounded() {
        let line = String(repeating: "x", count: 5_000)
        let output = ToolOutputPreview.tail(line)
        XCTAssertTrue(output.hasPrefix("… \n"))
        XCTAssertEqual(output.count - "… \n".count, ToolOutputPreview.maxCharacters,
                       "a single line over the character bound must be tail-capped to maxCharacters")
    }

    func testEmptyAndWhitespaceOnlyInputIsUnchanged() {
        XCTAssertEqual(ToolOutputPreview.tail(""), "")
        XCTAssertEqual(ToolOutputPreview.tail("   \n  "), "   \n  ")
    }

    func testExactlyTwelveLinesIsUnchangedAndUnprefixed() {
        let lines = (1...12).map { "line \($0)" }
        let joined = lines.joined(separator: "\n")
        let output = ToolOutputPreview.tail(joined)
        XCTAssertEqual(output, joined)
        XCTAssertFalse(output.hasPrefix("… "), "12 lines is exactly at the bound — no trim, no prefix")
    }
}
