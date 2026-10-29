import XCTest
@testable import MantaUI

// Transcript autolinking (docs/superpowers/specs/2026-10-29-transcript-autolink.md).
// The scanner is a port of the desktop's, so this file mirrors the desktop's tests:
// every case of src/renderer/linkify.test.ts, and the autolink.test.tsx cases whose
// surface exists on iOS. The expectations in "More cases" were produced by running the
// desktop's own `findLinks` (a node bundle of src/renderer/linkify.ts) on each input.
// Offsets are UTF-16 code units, as on the desktop.

final class TranscriptLinkifyTests: XCTestCase {

    private func links(_ s: String, _ mode: LinkifySchemeless = .yes) -> [TranscriptLink] {
        TranscriptLinkify.findLinks(in: s, schemeless: mode)
    }

    private func texts(_ s: String, _ mode: LinkifySchemeless = .yes) -> [String] { links(s, mode).map(\.text) }

    private func offsets(_ s: String, _ link: TranscriptLink) -> (Int, Int) {
        (s.utf16.distance(from: s.utf16.startIndex, to: link.range.lowerBound.samePosition(in: s.utf16) ?? s.utf16.startIndex),
         s.utf16.distance(from: s.utf16.startIndex, to: link.range.upperBound.samePosition(in: s.utf16) ?? s.utf16.startIndex))
    }

    /// `start-end text => href` per link, like the desktop's `{start, end, text, href}`.
    private func check(_ s: String, _ mode: LinkifySchemeless, _ expected: [String], file: StaticString = #filePath, line: UInt = #line) {
        let described = links(s, mode).map { link -> String in
            let (a, b) = offsets(s, link)
            return "\(a)-\(b) \(link.text) => \(link.href)"
        }
        XCTAssertEqual(described, expected, s.debugDescription, file: file, line: line)
    }

    func testTheRegexEngineCompiles() {
        XCTAssertNotNil(LinkifyEngine.shared)
    }

    // MARK: - linkify.test.ts

    func testReturnsNothingForEmptyAndLinkFreeInput() {
        XCTAssertEqual(links(""), [])
        XCTAssertEqual(links("just some words here"), [])
    }

    func testDetectsSchemefulUrlsAndKeepsThemAsWritten() throws {
        let s = "see https://example.com/a?b=1&c=2 now"
        let link = try XCTUnwrap(links(s).first)
        XCTAssertEqual(link.text, "https://example.com/a?b=1&c=2")
        XCTAssertEqual(link.href, "https://example.com/a?b=1&c=2")
        XCTAssertEqual(link.url.absoluteString, "https://example.com/a?b=1&c=2")
        XCTAssertEqual(offsets(s, link).0, 4)
        XCTAssertEqual(offsets(s, link).1, 33)
        XCTAssertEqual(links("http://localhost:3000/x").first?.href, "http://localhost:3000/x")
    }

    func testDetectsWwwAndNormalisesTheHrefToHttps() {
        check("go to www.example.com/x", .yes, ["6-23 www.example.com/x => https://www.example.com/x"])
        XCTAssertEqual(texts("www.foo.sh"), ["www.foo.sh"])
    }

    func testLinksSchemelessHosts() {
        for s in ["mantaui.com", "cto.useronda.com", "mantaui.com/downloads", "app.tryethernal.com/docs/api", "foo.app/x", "foo.ai/x"] {
            let found = links("open \(s) please")
            XCTAssertEqual(found.count, 1, s)
            XCTAssertEqual(found.first?.text, s)
            XCTAssertEqual(found.first?.href, "https://\(s)")
        }
    }

    func testDoesNotLinkFileNamesPathsAddressesOrPlaceholders() {
        for s in ["install.sh", "main.py", "lib.rs", "README.md", "package.json", "x.ts", "MantaUI.app", "logo.ai",
                  "/home/dev/foo.com", "src/a.io", "user@x.com", "http://localhost:<port>", "https://{host}/x",
                  "http://localhost:$PORT/x", "https://x.com/<path>", "ftp://x.com", "mailto:a@b.com", "//foo.com",
                  "~/foo.com", "--foo.com", "1.2.3.4"] {
            XCTAssertEqual(links("see \(s) ok"), [], s)
        }
    }

    func testDropsTrailingSentencePunctuationButKeepsBalancedParentheses() {
        XCTAssertEqual(texts("https://github.com/a/b/pull/1."), ["https://github.com/a/b/pull/1"])
        XCTAssertEqual(texts("visit mantaui.com, then mantaui.org!"), ["mantaui.com", "mantaui.org"])
        XCTAssertEqual(texts("(see https://a.com/x)"), ["https://a.com/x"])
        XCTAssertEqual(texts("https://a.com/a_(b)"), ["https://a.com/a_(b)"])
        XCTAssertEqual(texts("(see mantaui.com/x)"), ["mantaui.com/x"])
    }

    func testFindsSeveralLinksWithCorrectOffsets() {
        let s = "a https://x.com and mantaui.com/y"
        XCTAssertEqual(links(s).map { String(s[$0.range]) }, ["https://x.com", "mantaui.com/y"])
    }

    func testSeesThroughRawMarkdownWrappers() {
        XCTAssertEqual(texts("`https://a.com/b`"), ["https://a.com/b"])
        XCTAssertEqual(texts("**https://a.com/b**"), ["https://a.com/b"])
        XCTAssertEqual(texts("BASE_URL=https://a.com/b"), ["https://a.com/b"])
        XCTAssertEqual(texts("`mantaui.com`"), ["mantaui.com"])
    }

    func testSchemelessNoKeepsOnlyHttpAndWww() {
        XCTAssertEqual(texts("mantaui.com https://a.com www.b.com", .no), ["https://a.com", "www.b.com"])
    }

    func testSchemelessWholeLinksAHostOnlyWhenItIsTheWholeSpan() {
        XCTAssertEqual(texts("mantaui.com/downloads", .whole), ["mantaui.com/downloads"])
        XCTAssertEqual(texts("  mantaui.com  ", .whole), ["mantaui.com"])
        XCTAssertEqual(texts("curl mantaui.com", .whole), [])
        XCTAssertEqual(texts("curl https://a.com -o b.com", .whole), ["https://a.com"])
    }

    // MARK: - autolink.test.tsx (the surfaces iOS has)

    func testLinksInAUserPromptLikeTheDesktopBubble() {
        XCTAssertEqual(links("check https://a.com/x and mantaui.com").map(\.href), ["https://a.com/x", "https://mantaui.com"])
    }

    func testLinksUrlsInToolOutputLines() {
        XCTAssertEqual(texts("Server at https://a.com/x\nplain line"), ["https://a.com/x"])
    }

    func testDoesNotLinkFileNamesInProse() {
        XCTAssertEqual(links("Edit install.sh and README.md"), [])
    }

    func testOnlyHttpHrefsAreOpenable() {
        XCTAssertNil(TranscriptLinkify.openableURL("javascript:alert(1)"))
        XCTAssertNil(TranscriptLinkify.openableURL("file:///etc/passwd"))
        XCTAssertNil(TranscriptLinkify.openableURL("mailto:a@b.co"))
        XCTAssertEqual(TranscriptLinkify.openableURL("https://a.com/x")?.absoluteString, "https://a.com/x")
        XCTAssertEqual(links("javascript:alert(1) file:///etc/passwd mailto:a@b.co"), [])
    }

    // MARK: - More cases (expectations generated from the desktop's findLinks)

    func testMoreCasesMatchTheDesktop() {
        check("see http://[::1]:8080/x ok", .yes, ["4-23 http://[::1]:8080/x => http://[::1]:8080/x"])
        check("ftp://x.com/a mantaui.com", .yes, ["14-25 mantaui.com => https://mantaui.com"])
        check("mailto:a@b.com then mantaui.com", .yes, ["20-31 mantaui.com => https://mantaui.com"])
        check("see https://münchen.de/straße ok", .yes, ["4-29 https://münchen.de/straße => https://münchen.de/straße"])
        check("(mantaui.com)", .yes, ["1-12 mantaui.com => https://mantaui.com"])
        check("mantaui.com. next", .yes, ["0-11 mantaui.com => https://mantaui.com"])
        check("see www.foo.bar.xyz/a_(b) ok", .yes, ["4-25 www.foo.bar.xyz/a_(b) => https://www.foo.bar.xyz/a_(b)"])
        check("https://a.com/x'y and \"https://a.com/q\"", .yes, ["0-17 https://a.com/x'y => https://a.com/x'y",
            "23-38 https://a.com/q => https://a.com/q"])
        check("Foo.COM/Path and HTTP://X.COM/Y", .yes, ["0-12 Foo.COM/Path => https://Foo.COM/Path",
            "17-31 HTTP://X.COM/Y => HTTP://X.COM/Y"])
        check("a.b.c.co.uk/x", .yes, ["0-13 a.b.c.co.uk/x => https://a.b.c.co.uk/x"])
        check("see:mantaui.com", .yes, [])
        check("x=mantaui.com", .yes, ["0-13 x=mantaui.com => https://x=mantaui.com"])
        check("a (https://a.com/x,y;z!)", .yes, ["3-23 https://a.com/x,y;z! => https://a.com/x,y;z!"])
        check("emoji 😀mantaui.com", .yes, ["6-19 😀mantaui.com => https://😀mantaui.com"])
        check("emoji 😀 mantaui.com", .yes, ["9-20 mantaui.com => https://mantaui.com"])
        check("https://a.com/a**", .yes, ["0-15 https://a.com/a => https://a.com/a"])
        check("*https://a.com* and ^https://b.com^ and ~https://c.com", .yes, ["1-14 https://a.com => https://a.com",
            "21-34 https://b.com => https://b.com",
            "41-54 https://c.com => https://c.com"])
        check("http://127.0.0.1:3000/x", .yes, ["0-23 http://127.0.0.1:3000/x => http://127.0.0.1:3000/x"])
        check("https://a.com/x\nhttps://b.com/y\nmantaui.com", .yes, ["0-15 https://a.com/x => https://a.com/x",
            "16-31 https://b.com/y => https://b.com/y",
            "32-43 mantaui.com => https://mantaui.com"])
        check("www.example.com:8080/x", .yes, [])
        check("http://localhost:<port>/x", .yes, [])
        check("https://a.com/{x}", .yes, ["0-17 https://a.com/{x} => https://a.com/{x}"])
        check("https://a.com/x}", .yes, ["0-15 https://a.com/x => https://a.com/x"])
        check("[x](https://a.com/a_(b))", .yes, ["4-23 https://a.com/a_(b) => https://a.com/a_(b)"])
        check("git@github.com:foo/bar", .yes, [])
        check("see https://a.com/… ok", .yes, ["4-18 https://a.com/ => https://a.com/"])
        check("https://a.com/x#frag and https://a.com/?", .yes, ["0-20 https://a.com/x#frag => https://a.com/x#frag",
            "25-39 https://a.com/ => https://a.com/"])
        check("https://例え.jp/x", .yes, ["0-15 https://例え.jp/x => https://例え.jp/x"])
        check("mantaui.com/downloads?x=1&y=2#top.", .yes, ["0-33 mantaui.com/downloads?x=1&y=2#top => https://mantaui.com/downloads?x=1&y=2#top"])
        check("app.tryethernal.com and foo.app and foo.app/x and bar.ai/ and baz.ai", .yes, ["0-19 app.tryethernal.com => https://app.tryethernal.com",
            "36-45 foo.app/x => https://foo.app/x",
            "50-57 bar.ai/ => https://bar.ai/"])
        check("x.co, y.me; z.so: a.gg! b.xyz?", .yes, ["0-4 x.co => https://x.co",
            "6-10 y.me => https://y.me",
            "12-16 z.so => https://z.so",
            "18-22 a.gg => https://a.gg",
            "24-29 b.xyz => https://b.xyz"])
        check("a.sh b.rs c.py d.js e.md f.json g.yaml h.txt", .yes, [])
        check("v1.2.3 and 3.14 and e.g. and i.e.", .yes, [])
        check("see node_modules/foo.io and C:\\x\\foo.com and $HOME.com and a_mantaui.com and a-mantaui.com", .yes, ["77-90 a-mantaui.com => https://a-mantaui.com"])
        check("http://a.com:99999/x", .yes, [])
        check("https://a.com//b///c", .yes, ["0-20 https://a.com//b///c => https://a.com//b///c"])
        check("https://a.com/a b", .yes, ["0-15 https://a.com/a => https://a.com/a"])
        check("<https://a.com/x> and <mantaui.com>", .yes, ["1-16 https://a.com/x => https://a.com/x",
            "23-34 mantaui.com => https://mantaui.com"])
        check("_https://a.com/x_", .yes, [])
        check("https://a.com/x?y=(1+2)", .yes, ["0-23 https://a.com/x?y=(1+2) => https://a.com/x?y=(1+2)"])
        check("\"mantaui.com\" and 'mantaui.com' and «mantaui.com»", .yes, ["1-12 mantaui.com => https://mantaui.com",
            "19-30 mantaui.com => https://mantaui.com",
            "37-48 mantaui.com => https://mantaui.com"])
        check("see https://a.com/b。next", .yes, ["4-19 https://a.com/b => https://a.com/b"])
        check("https://a.com/x|y", .yes, ["0-17 https://a.com/x|y => https://a.com/x|y"])
        check("www.a-b.com www.-bad.com www.a..com", .yes, ["0-11 www.a-b.com => https://www.a-b.com"])
        check("https://www.mantaui.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z", .yes, ["0-75 https://www.mantaui.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z => https://www.mantaui.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z"])
        check("URL: https://a.com/x ", .whole, ["5-20 https://a.com/x => https://a.com/x"])
        check("  mantaui.com\n", .whole, ["2-13 mantaui.com => https://mantaui.com"])
        check("mantaui.com, ", .whole, [])
        check("mantaui.com www.a.com", .whole, ["12-21 www.a.com => https://www.a.com"])
        check("www.a.com", .whole, ["0-9 www.a.com => https://www.a.com"])
        check("\u{a0}mantaui.com\u{a0}", .whole, ["1-12 mantaui.com => https://mantaui.com"])
        check("mantaui.com https://a.com", .no, ["12-25 https://a.com => https://a.com"])
        check("install.sh www.a.sh", .no, ["11-19 www.a.sh => https://www.a.sh"])

    }

    func testAnUrlEndsAtWhitespaceAndNonAsciiPunctuation() {
        XCTAssertEqual(texts("https://a.com/x\nnext line"), ["https://a.com/x"])
        XCTAssertEqual(texts("见 https://a.com/x。然后"), ["https://a.com/x"])
    }

    func testAVeryLongPathStillLinks() {
        let s = "see https://a.com/" + String(repeating: "x", count: 3000) + " ok"
        XCTAssertEqual(links(s).count, 1)
        XCTAssertEqual(links(s).first?.text.count, 3000 + "https://a.com/".count)
    }

    func testManyLinesOfOutputScanQuickly() {
        let s = (0..<2000).map { "line \($0) https://a.com/\($0) and mantaui.com" }.joined(separator: "\n")
        XCTAssertEqual(links(s).count, 4000)
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

    // Desktop: inline code is `schemeless: "whole"`.
    func testASchemelessHostInInlineCodeLinksOnlyWhenItIsTheWholeSpan() {
        XCTAssertEqual(md("Use `mantaui.com` or `curl mantaui.com` here"),
                       "Use [`mantaui.com`](<https://mantaui.com>) or `curl mantaui.com` here")
    }

    // Desktop: prose is schemeless on; `www.` and schemeless hosts get an https href.
    func testSchemelessAndWwwHostsInProseBecomeLinksWithHttpsHrefs() {
        XCTAssertEqual(md("Download from mantaui.com/downloads today."),
                       "Download from [mantaui.com/downloads](<https://mantaui.com/downloads>) today.")
        XCTAssertEqual(md("see www.c.com now"), "see [www.c.com](<https://www.c.com>) now")
    }

    func testFileNamesInProseAreNotLinked() {
        let s = "Edit install.sh and README.md"
        XCTAssertEqual(md(s), s)
    }

    func testMailtoIsNeverLinked() {
        let s = "write mailto:a@b.com or a@b.com"
        XCTAssertEqual(md(s), s)
    }

    // A template placeholder stays a placeholder even when an HTML-looking tag follows it.
    func testPlaceholdersStayPlaceholdersInMarkdown() {
        let s = "run http://localhost:<port>/x here"
        XCTAssertEqual(md(s), s)
    }

    func testUrlCharactersThatNeedEscapingInMarkdownAreEscaped() {
        XCTAssertEqual(md("see www.a.com/a_b_c*d&e ok"),
                       "see [www.a.com/a\\_b\\_c\\*d\\&e](<https://www.a.com/a_b_c*d&amp;e>) ok")
    }

    func testAnUnclosedBracketDoesNotHideALink() {
        XCTAssertEqual(md("[note https://a.com"), "[note <https://a.com>")
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
