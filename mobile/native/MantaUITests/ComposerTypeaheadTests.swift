import XCTest
@testable import MantaUI

// ===========================================================================
// BET-749 — @-file typeahead + / slash palette pure logic.
//
// Covers ComposerTypeahead: `@`-token detection + substitution (the Mention a
// selection yields), and the `/` palette's action list + filtering. No view,
// no HTTP — the same pure logic the composer drives at runtime.
// ===========================================================================

final class ComposerTypeaheadTests: XCTestCase {

    // MARK: - detectMention

    func testDetectMentionAtStartOfDraft() {
        let anchor = ComposerTypeahead.detectMention(in: "@fo", caret: 3)
        XCTAssertEqual(anchor, ComposerTypeahead.MentionAnchor(start: 0, end: 3, query: "fo"))
    }

    func testDetectMentionAfterWhitespace() {
        let anchor = ComposerTypeahead.detectMention(in: "look at @src", caret: 12)
        XCTAssertEqual(anchor, ComposerTypeahead.MentionAnchor(start: 8, end: 12, query: "src"))
    }

    func testDetectMentionQueryOnlyTypedPart() {
        // The token extends past the caret, but the query is what's typed.
        let anchor = ComposerTypeahead.detectMention(in: "a @sr", caret: 5)
        XCTAssertEqual(anchor?.start, 2)
        XCTAssertEqual(anchor?.end, 5)
        XCTAssertEqual(anchor?.query, "sr")
    }

    func testDetectMentionNotTriggeredWhenAtInsideWord() {
        // `@` embedded mid-word does NOT open the typeahead.
        XCTAssertNil(ComposerTypeahead.detectMention(in: "foo@bar", caret: 7))
    }

    func testDetectMentionNilWhenCaretOutsideToken() {
        // Caret is past the token's end (typing a space closes the mention).
        XCTAssertNil(ComposerTypeahead.detectMention(in: "@foo x", caret: 5))
    }

    func testDetectMentionIgnoredWhenAtPrefixedByWordChar() {
        XCTAssertNil(ComposerTypeahead.detectMention(in: "a@foo", caret: 5))
    }

    func testDetectMentionEmptyText() {
        XCTAssertNil(ComposerTypeahead.detectMention(in: "", caret: 0))
    }

    // MARK: - applyMention

    /// The core "composer state" behaviour: selecting a file replaces the
    /// `@`-anchor in the draft and yields a `Mention` whose `source` references
    /// the substituted `@<file>` range exactly.
    func testApplyMentionReplacesAnchorAndBuildsCorrectSourceRange() {
        let anchor = ComposerTypeahead.detectMention(in: "see @fo", caret: 7)!
        let insertion = ComposerTypeahead.applyMention("foo.swift", to: "see @fo", anchor: anchor)

        // The draft: `@fo` is replaced with `@foo.swift ` (trailing space kept
        // so a following word doesn't glue onto the token).
        XCTAssertEqual(insertion.newText, "see @foo.swift ")

        // The mention carries the file as its `name` and the substituted
        // `@foo.swift` as `source.value`, with start/end spanning that token.
        XCTAssertEqual(insertion.mention.name, "foo.swift")
        XCTAssertEqual(insertion.mention.source.value, "@foo.swift")
        XCTAssertEqual(insertion.mention.source.start, 4)   // index of '@' of '@foo.swift'
        XCTAssertEqual(insertion.mention.source.end, 4 + "@foo.swift".count)
    }

    /// The Mention built by a selection serializes unchanged onto a send — the
    /// exact `name`/`source` triple the RPC emits (see the wire test too).
    func testApplyMentionSerializesOntoSendArgs() {
        let anchor = ComposerTypeahead.detectMention(in: "@src/", caret: 5)!
        let insertion = ComposerTypeahead.applyMention("src/foo.swift", to: "@src/", anchor: anchor)
        XCTAssertEqual(insertion.mention.name, "src/foo.swift")
        XCTAssertEqual(insertion.mention.source.value, "@src/foo.swift")
        XCTAssertEqual(insertion.mention.source.start, 0)
        XCTAssertEqual(insertion.mention.source.end, "@src/foo.swift".count)
    }

    // MARK: - Mention equality (used by the store's queued prompt)

    func testMentionEquatable() {
        let a = SendPromptInput.Mention(name: "f", source: SendPromptInput.MentionSource(value: "@f", start: 0, end: 2))
        let b = SendPromptInput.Mention(name: "f", source: SendPromptInput.MentionSource(value: "@f", start: 0, end: 2))
        XCTAssertEqual(a, b)
    }

    // MARK: - / slash palette

    func testSlashCommandsBaseSet() {
        let commands = ComposerTypeahead.slashCommands(running: false)
        XCTAssertEqual(commands.map(\.id), ["submit", "compact", "clear", "fork"])
    }

    func testSlashCommandsAddsAbortOnlyWhileRunning() {
        XCTAssertEqual(ComposerTypeahead.slashCommands(running: true).map(\.id), ["submit", "compact", "clear", "fork", "abort"])
        XCTAssertEqual(ComposerTypeahead.slashCommands(running: false).map(\.id), ["submit", "compact", "clear", "fork"])
    }

    func testFilterSlashCommandsByTokenAndTitle() {
        let all = ComposerTypeahead.slashCommands(running: false)
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "comp").map(\.id), ["compact"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "CLEAR").map(\.id), ["clear"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "fork").map(\.id), ["fork"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "sub").map(\.id), ["submit"])
    }

    func testFilterSlashCommandsEmptyQueryReturnsAll() {
        let all = ComposerTypeahead.slashCommands(running: false)
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "").count, all.count)
    }

    /// A typed token that matches nothing is honestly absent — no command is
    /// invented for it.
    func testFilterSlashCommandsUnknownQueryIsEmpty() {
        let all = ComposerTypeahead.slashCommands(running: false)
        XCTAssertTrue(ComposerTypeahead.filterSlashCommands(all, query: "zzzz").isEmpty)
    }

    // MARK: - detectSlash

    func testDetectSlashOnlyAtStartOfLine() {
        XCTAssertNotNil(ComposerTypeahead.detectSlash(in: "/comp", caret: 5))
        // Not leading → no palette (mirrors the desktop).
        XCTAssertNil(ComposerTypeahead.detectSlash(in: "fix /comp", caret: 9))
    }

    func testDetectSlashCaretMustBeInsideFirstWord() {
        XCTAssertNil(ComposerTypeahead.detectSlash(in: "/comp again", caret: 11))
        XCTAssertNotNil(ComposerTypeahead.detectSlash(in: "/comp", caret: 3))
    }
}
