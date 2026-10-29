import XCTest
@testable import MantaUI

// Transcript autolinking (docs/superpowers/specs/2026-10-29-transcript-autolink.md):
// the scanner mirrors src/renderer/linkify.test.ts for http(s), and adds `mailto:`.
// The desktop's schemeless / `www.` cases are deliberately absent: on iOS only
// http(s) and mailto are links, so those inputs must NOT link (asserted below).

final class TranscriptLinkifyTests: XCTestCase {

    private func texts(_ s: String) -> [String] { TranscriptLinkify.findLinks(in: s).map(\.text) }

    // MARK: - Detection

    func testEmptyAndLinkFreeInputHasNoLinks() {
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "").isEmpty)
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "just some words here").isEmpty)
    }

    func testSchemefulUrlIsKeptAsWritten() throws {
        let s = "see https://example.com/a?b=1&c=2 now"
        let link = try XCTUnwrap(TranscriptLinkify.findLinks(in: s).first)
        XCTAssertEqual(link.text, "https://example.com/a?b=1&c=2")
        XCTAssertEqual(link.url.absoluteString, "https://example.com/a?b=1&c=2")
        XCTAssertEqual(s.distance(from: s.startIndex, to: link.range.lowerBound), 4)
        XCTAssertEqual(s.distance(from: s.startIndex, to: link.range.upperBound), 33)
        XCTAssertEqual(TranscriptLinkify.findLinks(in: "http://localhost:3000/x").first?.url.absoluteString, "http://localhost:3000/x")
    }

    func testSchemeIsCaseInsensitive() {
        XCTAssertEqual(texts("go HTTPS://Example.com/x"), ["HTTPS://Example.com/x"])
    }

    func testMailtoLinksButBareAddressesDoNot() {
        XCTAssertEqual(texts("write mailto:a@b.com please"), ["mailto:a@b.com"])
        XCTAssertEqual(texts("write mailto:a.b+c@x.co.uk."), ["mailto:a.b+c@x.co.uk"])
        XCTAssertEqual(TranscriptLinkify.findLinks(in: "mailto:a@b.com").first?.url.scheme, "mailto")
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "mail user@x.com ok").isEmpty)
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "mailto:nobody").isEmpty)
    }

    func testOnlyHttpAndMailtoAreLinks() {
        for s in ["mantaui.com", "cto.useronda.com", "www.example.com/x", "foo.app/x", "ftp://x.com", "//foo.com",
                  "install.sh", "main.py", "lib.rs", "README.md", "package.json", "x.ts", "MantaUI.app", "logo.ai",
                  "/home/dev/foo.com", "src/a.io", "user@x.com", "~/foo.com", "--foo.com", "1.2.3.4", "file:///tmp/x"] {
            XCTAssertTrue(TranscriptLinkify.findLinks(in: "see \(s) ok").isEmpty, s)
        }
    }

    func testTemplatePlaceholdersAreNotLinks() {
        for s in ["http://localhost:<port>", "https://{host}/x", "http://localhost:$PORT/x", "https://x.com/<path>"] {
            XCTAssertTrue(TranscriptLinkify.findLinks(in: "see \(s) ok").isEmpty, s)
        }
    }

    func testUrlJoinedToAnIdentifierOrPathIsNotALink() {
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "xhttps://a.com").isEmpty)
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "/x/https://a.com").isEmpty)
        XCTAssertTrue(TranscriptLinkify.findLinks(in: "a-https://a.com").isEmpty)
    }

    func testTrailingPunctuationIsDroppedButBalancedParenthesesStay() {
        XCTAssertEqual(texts("https://github.com/a/b/pull/1."), ["https://github.com/a/b/pull/1"])
        XCTAssertEqual(texts("visit https://mantaui.com, then https://mantaui.org!"), ["https://mantaui.com", "https://mantaui.org"])
        XCTAssertEqual(texts("(see https://a.com/x)"), ["https://a.com/x"])
        XCTAssertEqual(texts("https://a.com/a_(b)"), ["https://a.com/a_(b)"])
        XCTAssertEqual(texts("(see https://a.com/a_(b))"), ["https://a.com/a_(b)"])
        XCTAssertEqual(texts("is it https://a.com/x?"), ["https://a.com/x"])
        XCTAssertEqual(texts("'https://a.com/x'"), ["https://a.com/x"])
    }

    func testSeveralLinksKeepTheirOffsets() {
        let s = "a https://x.com and https://mantaui.com/y"
        let links = TranscriptLinkify.findLinks(in: s)
        XCTAssertEqual(links.map { String(s[$0.range]) }, ["https://x.com", "https://mantaui.com/y"])
    }

    func testSeesThroughRawMarkdownWrappers() {
        XCTAssertEqual(texts("`https://a.com/b`"), ["https://a.com/b"])
        XCTAssertEqual(texts("**https://a.com/b**"), ["https://a.com/b"])
        XCTAssertEqual(texts("BASE_URL=https://a.com/b"), ["https://a.com/b"])
        XCTAssertEqual(texts("|https://a.com/b|"), ["https://a.com/b"])
    }

    func testAUrlEndsAtWhitespaceAndNonAsciiPunctuation() {
        XCTAssertEqual(texts("https://a.com/x\nnext line"), ["https://a.com/x"])
        XCTAssertEqual(texts("见 https://a.com/x。然后"), ["https://a.com/x"])
        XCTAssertEqual(texts("https://a.com/路径/x"), ["https://a.com/路径/x"])
    }

    // MARK: - Markdown source

    private func md(_ s: String) -> String { TranscriptMarkdownLinks.autolinked(s) }

    func testABareUrlInProseBecomesAnAutolinkAndPunctuationStaysOutside() {
        XCTAssertEqual(md("see https://a.com/x. then"), "see <https://a.com/x>. then")
        XCTAssertEqual(md("**https://a.com/b**"), "**<https://a.com/b>**")
        XCTAssertEqual(md("- one https://a.com\n- two https://b.com"), "- one <https://a.com>\n- two <https://b.com>")
    }

    func testTextWithoutLinksIsReturnedUntouched() {
        let s = "# Title\n\nsome `code` and **bold**\n"
        XCTAssertEqual(md(s), s)
    }

    func testExistingLinksAndHtmlAreLeftAlone() {
        for s in ["[docs](https://a.com/x)", "[https://a.com/x](https://a.com/x)", "<https://a.com/x>", "![i](https://a.com/i.png)",
                  "[id]: https://a.com/x", "<a href=\"https://a.com\">x</a>", "text <a href=\"https://a.com\">x</a> end",
                  "[see](https://a.com/a_(b)) and more"] {
            XCTAssertEqual(md(s), s, s)
        }
    }

    func testFencedCodeIsNotTouched() {
        let s = "before https://a.com\n```sh\ncurl https://a.com/x `y https://b.com`\n```\nafter\n~~~\nhttps://c.com\n~~~"
        XCTAssertEqual(md(s), "before <https://a.com>\n```sh\ncurl https://a.com/x `y https://b.com`\n```\nafter\n~~~\nhttps://c.com\n~~~")
    }

    func testAFenceNeedsItsOwnClosingRun() {
        let s = "````\n```\nhttps://a.com\n````\nhttps://b.com"
        XCTAssertEqual(md(s), "````\n```\nhttps://a.com\n````\n<https://b.com>")
    }

    func testInlineCodeUrlBecomesALinkedCodeChip() {
        XCTAssertEqual(md("open `https://a.com/x` now"), "open [`https://a.com/x`](<https://a.com/x>) now")
    }

    func testOnlyTheUrlInsideAnInlineCodeSpanIsLinked() {
        // Each code piece is padded by one space inside its ticks (CommonMark strips one from each end), so the
        // piece "curl " is written "` curl  `".
        XCTAssertEqual(md("run `curl https://a.com/x -o f`"),
                       "run ` curl  `[`https://a.com/x`](<https://a.com/x>)`  -o f `")
    }

    func testInlineCodeWithTwoUrlsKeepsTheTextBetween() {
        XCTAssertEqual(md("`https://a.com and https://b.com`"),
                       "[`https://a.com`](<https://a.com>)`  and  `[`https://b.com`](<https://b.com>)")
    }

    func testInlineCodeWithoutAUrlIsUntouched() {
        let s = "use `npm test` and `a.b` then https://a.com"
        XCTAssertEqual(md(s), "use `npm test` and `a.b` then <https://a.com>")
    }

    func testACodeSpanThatIsAlreadyALinkLabelIsUntouched() {
        let s = "[`https://a.com`](https://a.com)"
        XCTAssertEqual(md(s), s)
    }

    func testAnUnclosedBacktickIsLiteralAndTextAfterItStillLinks() {
        XCTAssertEqual(md("a ` b https://a.com"), "a ` b <https://a.com>")
    }

    func testDoubleBacktickSpanKeepsItsFence() {
        XCTAssertEqual(md("``a ` https://a.com``"), "`` a `  ``[`https://a.com`](<https://a.com>)")
    }

    func testEscapedBacktickDoesNotStartASpan() {
        XCTAssertEqual(md("\\`https://a.com\\`"), "\\`<https://a.com>\\`")
    }
}
