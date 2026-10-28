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

    // MARK: - detectMention kinds (@ vs @@)

    func testDetectMentionDoubleAtIsAgent() {
        XCTAssertEqual(ComposerTypeahead.detectMention(in: "@@", caret: 2),
                       ComposerTypeahead.MentionAnchor(start: 0, end: 2, query: "", kind: .agent))
        XCTAssertEqual(ComposerTypeahead.detectMention(in: "hi @@pl", caret: 7),
                       ComposerTypeahead.MentionAnchor(start: 3, end: 7, query: "pl", kind: .agent))
        XCTAssertEqual(ComposerTypeahead.detectMention(in: "@@bu", caret: 4)?.query, "bu")
    }

    func testDetectMentionSingleAtIsFile() {
        XCTAssertEqual(ComposerTypeahead.detectMention(in: "@src", caret: 4)?.kind, .file)
        // Caret between the two @ is still a file token.
        XCTAssertEqual(ComposerTypeahead.detectMention(in: "@@", caret: 1)?.kind, .file)
    }

    func testDetectMentionRejectsAtInsideWordAndPastToken() {
        XCTAssertNil(ComposerTypeahead.detectMention(in: "a@@b", caret: 4))
        XCTAssertNil(ComposerTypeahead.detectMention(in: "@@pl x", caret: 6))
    }

    // MARK: - applyMentionToken

    /// Selecting a file/reference replaces the `@`-anchor with `@<text> ` and
    /// records nothing — it is plain text on the wire.
    func testApplyMentionTokenReplacesAnchorAndKeepsOneSpace() {
        let anchor = ComposerTypeahead.detectMention(in: "see @fo", caret: 7)!
        let result = ComposerTypeahead.applyMentionToken("@foo.swift", to: "see @fo", anchor: anchor)
        XCTAssertEqual(result.text, "see @foo.swift ")
        XCTAssertEqual(result.caret, ("see @foo.swift " as NSString).length)
    }

    func testApplyMentionTokenReplacesWholeTokenWithSlashes() {
        let anchor = ComposerTypeahead.detectMention(in: "@src/", caret: 5)!
        let result = ComposerTypeahead.applyMentionToken("@src/foo.swift", to: "@src/", anchor: anchor)
        XCTAssertEqual(result.text, "@src/foo.swift ")
        XCTAssertEqual(result.caret, 15)
    }

    /// UTF-16 range: an emoji (two code units) before the token shifts the
    /// replaced range and the returned caret accordingly.
    func testApplyMentionTokenUsesUTF16RangeAfterEmoji() {
        let text = "😀 @do"
        let ns = text as NSString
        let anchor = ComposerTypeahead.detectMention(in: text, caret: ns.length)!
        XCTAssertEqual(anchor.start, 3)
        let result = ComposerTypeahead.applyMentionToken("@docs", to: text, anchor: anchor)
        XCTAssertEqual(result.text, "😀 @docs ")
        XCTAssertEqual(result.caret, ("😀 @docs " as NSString).length)
    }

    func testApplyMentionTokenReplacesAgentAnchorIncludingBothAts() {
        let anchor = ComposerTypeahead.detectMention(in: "hi @@pl", caret: 7)!
        let result = ComposerTypeahead.applyMentionToken("@planner", to: "hi @@pl", anchor: anchor)
        XCTAssertEqual(result.text, "hi @planner ")
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
        XCTAssertEqual(commands.map(\.id), ["submit", "compact", "clear", "fork", "handoff"])
    }

    func testSlashCommandsAddsAbortOnlyWhileRunning() {
        XCTAssertEqual(ComposerTypeahead.slashCommands(running: true).map(\.id), ["submit", "compact", "clear", "fork", "handoff", "abort"])
        XCTAssertEqual(ComposerTypeahead.slashCommands(running: false).map(\.id), ["submit", "compact", "clear", "fork", "handoff"])
    }

    func testFilterSlashCommandsByTokenAndTitle() {
        let all = ComposerTypeahead.slashCommands(running: false)
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "comp").map(\.id), ["compact"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "CLEAR").map(\.id), ["clear"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "fork").map(\.id), ["fork"])
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "sub").map(\.id), ["submit"])
    }

    func testFilterSlashCommandsFindsHandoff() {
        let all = ComposerTypeahead.slashCommands(running: false)
        XCTAssertEqual(ComposerTypeahead.filterSlashCommands(all, query: "hand").map(\.id), ["handoff"])
        XCTAssertEqual(ComposerTypeahead.slashCommands(running: false).first { $0.id == "handoff" }?.kind, .handoff)
    }

    func testGoalAfterCommand() {
        XCTAssertEqual(ComposerTypeahead.goalAfterCommand(in: "/handoff fix the flaky test"), "fix the flaky test")
        XCTAssertEqual(ComposerTypeahead.goalAfterCommand(in: "/handoff   spaced  out \n"), "spaced  out")
        XCTAssertNil(ComposerTypeahead.goalAfterCommand(in: "/handoff"))
        XCTAssertNil(ComposerTypeahead.goalAfterCommand(in: "/handoff   "))
        XCTAssertNil(ComposerTypeahead.goalAfterCommand(in: "not a command goal"))
    }

    func testIsHandoffCommand() {
        XCTAssertTrue(ComposerTypeahead.isHandoffCommand("/handoff"))
        XCTAssertTrue(ComposerTypeahead.isHandoffCommand("  /handoff the goal  "))
        XCTAssertTrue(ComposerTypeahead.isHandoffCommand("/HANDOFF"))
        // A different command, a longer token, or prose that merely mentions it is a normal message.
        XCTAssertFalse(ComposerTypeahead.isHandoffCommand("/handoffs"))
        XCTAssertFalse(ComposerTypeahead.isHandoffCommand("/fork"))
        XCTAssertFalse(ComposerTypeahead.isHandoffCommand("please /handoff"))
        XCTAssertFalse(ComposerTypeahead.isHandoffCommand(""))
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

    // MARK: - paletteRows / applySlashInsertion

    private func cmd(_ name: String, _ description: String? = nil, source: String? = nil, background: Bool? = nil) -> OpencodeCommandInfo {
        OpencodeCommandInfo(name: name, description: description, source: source, argumentHint: nil, background: background)
    }

    private var builtins: [ComposerTypeahead.SlashCommand] { ComposerTypeahead.slashCommands(running: false) }

    func testPaletteRowsBuiltinsFirstThenRemote() {
        let rows = ComposerTypeahead.paletteRows(builtins: builtins, remote: [cmd("review", "Review code")], query: "")
        XCTAssertEqual(rows.map(\.id), ["submit", "compact", "clear", "fork", "handoff", "review"])
        XCTAssertEqual(rows.last?.kind, .insert(name: "review"))
        XCTAssertEqual(rows.last?.subtitle, "Review code")
    }

    func testPaletteRowsFiltersRemoteByNameCaseInsensitive() {
        let remote = [cmd("review"), cmd("Deploy"), cmd("test")]
        XCTAssertEqual(ComposerTypeahead.paletteRows(builtins: builtins, remote: remote, query: "re").map(\.id), ["review"])
        XCTAssertEqual(ComposerTypeahead.paletteRows(builtins: builtins, remote: remote, query: "DEP").map(\.id), ["Deploy"])
    }

    func testPaletteRowsDropsRemoteWithBuiltinName() {
        let rows = ComposerTypeahead.paletteRows(builtins: builtins, remote: [cmd("compact"), cmd("fork")], query: "comp")
        XCTAssertEqual(rows.map(\.id), ["compact"])
        XCTAssertEqual(rows.first?.kind, .compact)
    }

    func testPaletteRowsCapsAtTwelve() {
        let remote = (0..<30).map { cmd("cmd\($0)") }
        XCTAssertEqual(ComposerTypeahead.paletteRows(builtins: builtins, remote: remote, query: "").count, 12)
        XCTAssertEqual(ComposerTypeahead.paletteRows(builtins: builtins, remote: remote, query: "cmd", limit: 5).count, 5)
    }

    func testPaletteRowsSkillFlagAndEmptySubtitle() {
        let rows = ComposerTypeahead.paletteRows(
            builtins: [], remote: [cmd("brainstorm", nil, source: "skill"), cmd("plain", "d", source: "command")], query: "")
        XCTAssertEqual(rows.map(\.isSkill), [true, false])
        XCTAssertEqual(rows.first?.subtitle, "")
    }

    func testApplySlashInsertion() {
        XCTAssertEqual(ComposerTypeahead.applySlashInsertion(name: "review", to: "/re"), "/review ")
        XCTAssertEqual(ComposerTypeahead.applySlashInsertion(name: "review", to: "/re some args"), "/review some args")
        XCTAssertEqual(ComposerTypeahead.applySlashInsertion(name: "review", to: "/"), "/review ")
    }

    // MARK: - splitSlashText / planSlashSend

    func testSplitSlashText() {
        XCTAssertEqual(ComposerTypeahead.splitSlashText("/review")?.name, "review")
        XCTAssertEqual(ComposerTypeahead.splitSlashText("/review")?.args, "")
        XCTAssertEqual(ComposerTypeahead.splitSlashText("/review  a b\nc")?.name, "review")
        XCTAssertEqual(ComposerTypeahead.splitSlashText("/review  a b\nc")?.args, "a b\nc")
        XCTAssertNil(ComposerTypeahead.splitSlashText("hello"))
        XCTAssertNil(ComposerTypeahead.splitSlashText("/"))
        XCTAssertNil(ComposerTypeahead.splitSlashText("/ foo"))
    }

    func testPlanKnownCommandIsCommand() {
        let plan = ComposerTypeahead.planSlashSend(text: "/review the auth module", running: false, remote: [cmd("review")])
        XCTAssertEqual(plan, .command(name: "review", args: "the auth module", alwaysBackground: false))
    }

    func testPlanUnknownPathLikeTextIsPrompt() {
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/usr/bin is slow", running: false, remote: [cmd("review")]), .prompt)
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/usr/local is full", running: false, remote: []), .prompt)
    }

    func testPlanNilRemoteIsPromptButBuiltinsStillRecognised() {
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/review x", running: false, remote: nil), .prompt)
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/compact", running: false, remote: nil), .builtin(.compact))
    }

    func testPlanBuiltinsIdleAndRunning() {
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/compact", running: false, remote: []), .builtin(.compact))
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/clear", running: false, remote: []), .builtin(.clear))
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/fork", running: false, remote: []), .builtin(.fork))
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/compact", running: true, remote: []),
                       .refuse("Stop the agent or wait for it to finish before /compact"))
    }

    func testPlanKnownCommandWhileRunningStillCommand() {
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/review x", running: true, remote: [cmd("review")]),
                       .command(name: "review", args: "x", alwaysBackground: false))
    }

    func testPlanAlwaysBackgroundCommand() {
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/audit", running: false, remote: [cmd("audit", background: true)]),
                       .command(name: "audit", args: "", alwaysBackground: true))
    }

    /// The caller re-reads `running` right before planning: the same snapshot text
    /// plans differently as the session state changes during the command lookup.
    func testPlanDispatchTimeReReadOfRunning() {
        let remote = [cmd("review")]
        let text = "/review x"
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: text, running: false, remote: remote),
                       ComposerTypeahead.planSlashSend(text: text, running: true, remote: remote))
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/compact", running: true, remote: remote),
                       .refuse("Stop the agent or wait for it to finish before /compact"))
        XCTAssertEqual(ComposerTypeahead.planSlashSend(text: "/compact", running: false, remote: remote), .builtin(.compact))
    }

    // MARK: - backgroundState

    func testBackgroundState() {
        let remote = [cmd("review"), cmd("audit", background: true)]
        XCTAssertNil(ComposerTypeahead.backgroundState(text: "/compact", remote: remote))
        XCTAssertNil(ComposerTypeahead.backgroundState(text: "/unknown", remote: remote))
        XCTAssertNil(ComposerTypeahead.backgroundState(text: "plain text", remote: remote))
        XCTAssertNil(ComposerTypeahead.backgroundState(text: "/review", remote: nil))
        XCTAssertEqual(ComposerTypeahead.backgroundState(text: "/review a b", remote: remote),
                       BackgroundToggleState(name: "review", locked: false))
        XCTAssertEqual(ComposerTypeahead.backgroundState(text: "/audit", remote: remote),
                       BackgroundToggleState(name: "audit", locked: true))
    }

    func testBackgroundStateIgnoresBuiltinNamedRemote() {
        XCTAssertNil(ComposerTypeahead.backgroundState(text: "/compact", remote: [cmd("compact")]))
    }

    // MARK: - mentionRows

    private func ref(_ name: String, path: String? = nil, repository: String? = nil, description: String? = nil, hidden: Bool? = nil) -> OpencodeReferenceInfo {
        OpencodeReferenceInfo(name: name, path: path, repository: repository, branch: nil, description: description, hidden: hidden)
    }

    func testMentionRowsExcludesHiddenAndPutsReferencesFirst() {
        let rows = ComposerTypeahead.mentionRows(
            query: "do", references: [ref("docs"), ref("domain", hidden: true)], files: ["src/dom.ts", "docs/a.md"])
        XCTAssertEqual(rows.map(\.title), ["@docs", "@src/dom.ts", "@docs/a.md"])
        XCTAssertEqual(rows.map(\.kind), [.reference, .file, .file])
        XCTAssertEqual(rows.first?.insertText, "docs")
    }

    func testMentionRowsCaseInsensitiveReferenceMatch() {
        let rows = ComposerTypeahead.mentionRows(query: "DOC", references: [ref("Docs"), ref("other")], files: [])
        XCTAssertEqual(rows.map(\.title), ["@Docs"])
    }

    func testMentionRowsCapsAtTwenty() {
        let files = (0..<40).map { "f\($0).txt" }
        XCTAssertEqual(ComposerTypeahead.mentionRows(query: "f", references: [], files: files).count, 20)
    }

    func testMentionRowsSubtitleFallbackAndIcon() {
        let rows = ComposerTypeahead.mentionRows(query: "", references: [
            ref("a", path: "/p", repository: "org/repo", description: "desc"),
            ref("b", path: "/p", repository: "org/repo"),
            ref("c", path: "/only/path"),
        ], files: [])
        XCTAssertEqual(rows.map(\.subtitle), ["desc", "org/repo", "/only/path"])
        XCTAssertEqual(rows.map(\.systemImage), ["link", "link", "folder"])
    }

    func testFileStatusRowCopy() {
        XCTAssertEqual(ComposerTypeahead.fileStatusRow(searching: true).title, "Searching…")
        XCTAssertEqual(ComposerTypeahead.fileStatusRow(searching: false).title, "No matching files")
        XCTAssertEqual(ComposerTypeahead.fileStatusRow(searching: true).kind, .status(tappable: false))
    }

    // MARK: - agentRows

    private func agent(_ name: String, _ description: String? = nil) -> OpencodeAgent {
        OpencodeAgent(name: name, description: description, mode: nil, native: nil, builtIn: nil)
    }

    func testAgentRowsLoadingWhenNothingYet() {
        let rows = ComposerTypeahead.agentRows(agents: nil, loadError: nil, query: "")
        XCTAssertEqual(rows.map(\.title), ["Loading agents…"])
        XCTAssertEqual(rows.first?.kind, .status(tappable: false))
    }

    func testAgentRowsErrorGivesTappableRetry() {
        let rows = ComposerTypeahead.agentRows(agents: nil, loadError: "boom", query: "")
        XCTAssertEqual(rows.map(\.title), ["Couldn't load agents — tap to retry"])
        XCTAssertEqual(rows.first?.kind, .status(tappable: true))
    }

    /// failure → retry → loaded: the same call after the store recovered yields rows.
    func testAgentRowsFailureThenRetryThenLoaded() {
        XCTAssertEqual(ComposerTypeahead.agentRows(agents: nil, loadError: "x", query: "").first?.kind, .status(tappable: true))
        let rows = ComposerTypeahead.agentRows(agents: [agent("general", "Does things")], loadError: nil, query: "")
        XCTAssertEqual(rows.map(\.title), ["@general"])
        XCTAssertEqual(rows.first?.kind, .agent)
        XCTAssertEqual(rows.first?.subtitle, "Does things")
        XCTAssertEqual(rows.first?.insertText, "general")
    }

    func testAgentRowsFilterAndEmptyAndCap() {
        let agents = [agent("general"), agent("build"), agent("plan")]
        XCTAssertEqual(ComposerTypeahead.agentRows(agents: agents, loadError: nil, query: "GEN").map(\.title), ["@general"])
        XCTAssertEqual(ComposerTypeahead.agentRows(agents: agents, loadError: nil, query: "zzz").map(\.title), ["No matching agents"])
        let many = (0..<30).map { agent("a\($0)") }
        XCTAssertEqual(ComposerTypeahead.agentRows(agents: many, loadError: nil, query: "a").count, 12)
    }

    // MARK: - resolveAgentMentions

    func testResolveAgentMentionsRespectsWordBoundaries() {
        let resolved = ComposerTypeahead.resolveAgentMentions(text: "ask @builder then @build now", names: ["build"])
        XCTAssertEqual(resolved.count, 1)
        XCTAssertEqual(resolved.first?.source.value, "@build")
        XCTAssertEqual(resolved.first?.source.start, 18)
        XCTAssertEqual(resolved.first?.source.end, 24)
    }

    func testResolveAgentMentionsDropsDeletedToken() {
        XCTAssertTrue(ComposerTypeahead.resolveAgentMentions(text: "no mention here", names: ["general"]).isEmpty)
        XCTAssertTrue(ComposerTypeahead.resolveAgentMentions(text: "email a@general.com", names: ["general"]).isEmpty)
    }

    func testResolveAgentMentionsOffsetsAfterEmojiAreUTF16() {
        let resolved = ComposerTypeahead.resolveAgentMentions(text: "😀 @general go", names: ["general"])
        XCTAssertEqual(resolved.first?.source.start, 3)
        XCTAssertEqual(resolved.first?.source.end, 11)
        XCTAssertEqual(resolved.first?.name, "general")
    }

    func testResolveAgentMentionsDuplicateNamesOnce() {
        let resolved = ComposerTypeahead.resolveAgentMentions(text: "@general and @general", names: ["general", "general"])
        XCTAssertEqual(resolved.count, 1)
        XCTAssertEqual(resolved.first?.source.start, 0)
    }

    func testResolveAgentMentionsMultipleAgentsKeepSelectionOrder() {
        let resolved = ComposerTypeahead.resolveAgentMentions(text: "@plan then @general", names: ["general", "plan"])
        XCTAssertEqual(resolved.map(\.name), ["general", "plan"])
    }
}
