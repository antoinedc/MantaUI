import XCTest
@testable import MantaUI

// WS01 — the mapper-level transcript-parity tests. These need `TranscriptBlock`
// (SwiftUI), `ToolActivity`, the stores and the card actions, so they run on the
// Mac only (`ios-mantaui` `test-unit`). The pure logic they build on is in
// TranscriptParityTests.swift, which also runs on Linux.

@MainActor
final class TranscriptMapperTests: XCTestCase {

    // MARK: - Fixtures

    private func msg(
        _ id: String,
        _ role: String,
        created: Double? = 0,
        completed: Double? = nil,
        tokens: OpencodeTokenUsage? = nil,
        finish: String? = nil,
        command: OpencodeCommandOrigin? = nil,
        parts: [OpencodePart] = []
    ) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: created, completed: completed),
                modelID: nil,
                providerID: nil,
                tokens: tokens,
                finish: finish,
                command: command
            ),
            parts: parts
        )
    }

    private func user(_ id: String, _ body: String = "go", parts extra: [OpencodePart] = [], command: OpencodeCommandOrigin? = nil) -> OpencodeMessage {
        msg(id, "user", command: command, parts: [text(id, body)] + extra)
    }

    private func assistant(_ id: String, created: Double = 1_000, completed: Double? = 2_000, parts: [OpencodePart],
                           tokens: OpencodeTokenUsage? = nil, finish: String? = nil) -> OpencodeMessage {
        msg(id, "assistant", created: created, completed: completed, tokens: tokens, finish: finish, parts: parts)
    }

    private func text(_ messageID: String, _ value: String, index: Int = 0) -> OpencodePart {
        OpencodePart(type: "text", id: "\(messageID):text:\(index)", messageID: messageID, text: value)
    }

    private func reasoning(_ messageID: String, _ value: String, index: Int = 0) -> OpencodePart {
        OpencodePart(type: "reasoning", id: "\(messageID):reasoning:\(index)", messageID: messageID, text: value)
    }

    private func bash(_ id: String, _ messageID: String, output: String? = "ok") -> OpencodePart {
        ToolActivity.makeToolPart(id: id, messageID: messageID, callID: id, tool: "bash", status: "completed",
                                  input: ["command": .string("ls")], output: output)
    }

    private func stepFinish(_ messageID: String, reason: String) -> OpencodePart {
        OpencodePart(type: "step-finish", id: "\(messageID):step-finish", messageID: messageID, extra: ["reason": .string(reason)])
    }

    private func beginPart(_ messageID: String, handle: String) -> OpencodePart {
        ToolActivity.makeToolPart(
            id: "\(messageID):begin", messageID: messageID, callID: "\(messageID):begin", tool: "media_begin", status: "completed",
            input: ["kind": .string("image"), "aspectRatio": .number(16.0 / 9.0)],
            output: "Placeholder reserved. Handle: \(handle). Keep it and pass it to media_show once the media file exists."
        )
    }

    /// The box's canonical media entry for a shown handle (what `view.media` carries).
    private func mediaView(_ handle: String, path: String) -> TranscriptMediaView {
        TranscriptMediaView(id: "media:h:\(handle)", path: path, mime: "image/png", aspectRatio: 16.0 / 9.0, size: 1234, handle: handle)
    }

    private func withMedia(_ message: OpencodeMessage, _ media: [TranscriptMediaView]) -> OpencodeMessage {
        var copy = message
        copy.view = TranscriptMessageView(media: media)
        return copy
    }

    private func showPart(_ messageID: String, handle: String?, path: String) -> OpencodePart {
        var input: [String: JSONValue] = ["path": .string(path)]
        if let handle { input["handle"] = .string(handle) }
        return ToolActivity.makeToolPart(
            id: "\(messageID):show", messageID: messageID, callID: "\(messageID):show", tool: "media_show", status: "completed",
            input: input, output: "Displayed \(path) (image/png 600x600, 1234 bytes) in the transcript."
        )
    }

    private func map(_ messages: [OpencodeMessage], _ options: TranscriptMapOptions = TranscriptMapOptions()) -> [TranscriptBlock] {
        // The box stamps each message's turn/truncation view (WS11 D8); the fixture does it the box's way.
        ChatTranscriptMapper.blocks(from: BoxViewFixture.stamp(messages, running: options.running), voiceNotes: [], widgets: [], options: options)
    }

    private func mediaEntries(_ blocks: [TranscriptBlock]) -> [TranscriptMediaEntry] {
        blocks.compactMap { block in
            if case .file(let attachment) = block, case .media(let entry) = attachment.kind { return entry }
            return nil
        }
    }

    private func footers(_ blocks: [TranscriptBlock]) -> [TranscriptTurnFooter] {
        blocks.compactMap { block in
            if case .turnFooter(let footer) = block { return footer }
            return nil
        }
    }

    private let t0 = Date(timeIntervalSince1970: 1_000)

    // MARK: - F1 user files

    func testAUserMessageWithOnlyAFilePartProducesAFilesRowAndNoTextRow() {
        let file = OpencodePart(type: "file", id: "u1:file:0", messageID: "u1",
                                extra: ["url": .string("file:///home/u/shot.png"), "filename": .string("shot.png"), "mime": .string("image/png")])
        let message = msg("u1", "user", parts: [OpencodePart(type: "text", id: "u1:text:0", messageID: "u1", text: ""), file])
        let blocks = map([message])
        XCTAssertEqual(blocks.count, 1)
        guard case .file(let attachment) = blocks[0], case .userFiles(let files) = attachment.kind else {
            return XCTFail("expected a user-files row, got \(blocks)")
        }
        XCTAssertEqual(files.messageID, "u1")
        XCTAssertEqual(files.refs.map(\.filename), ["shot.png"])
        XCTAssertEqual(uniqueTranscriptRows(blocks).map(\.id), ["fufiles:u1"])
    }

    func testTheFilesRowComesBeforeTheUserBand() {
        let file = OpencodePart(type: "file", id: "u1:file:0", messageID: "u1", extra: ["url": .string("file:///a.png")])
        let blocks = map([user("u1", "look", parts: [file])])
        XCTAssertEqual(blocks.count, 2)
        guard case .file = blocks[0], case .user(let text, _) = blocks[1] else {
            return XCTFail("expected [.file, .user], got \(blocks)")
        }
        XCTAssertEqual(text, "look")
    }

    // MARK: - F1 media

    func testMediaDrawsBeforeItsOwnersProse() {
        let a = assistant("A", parts: [text("A", "here it is")])
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "show", messageID: "A", width: 10, height: 10, path: "/home/u/x.png", mime: "image/png"), now: t0)
        let blocks = map([user("u1"), a], TranscriptMapOptions(liveMedia: state.vended()))
        guard case .file = blocks[1], case .prose(let prose, _) = blocks[2] else {
            return XCTFail("expected media then prose, got \(blocks)")
        }
        XCTAssertEqual(prose, "here it is")
    }

    func testBeginInAShowInBIsOneRowUnderAWhetherLiveOrCanonicalAndNeverADup() {
        let a = assistant("A", parts: [beginPart("A", handle: "ab12")])
        let b = assistant("B", parts: [showPart("B", handle: "ab12", path: "/home/u/cat.png")])

        // Live only: the transcript has the begin but no show yet.
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "ab12", messageID: "A", kind: "image", aspectRatio: 16.0 / 9.0), now: t0)
        state.apply(TranscriptMediaFrame(action: "show", handle: "ab12", messageID: "B", path: "/home/u/cat.png", mime: "image/png"), now: t0)
        let liveOnly = map([user("u1"), a], TranscriptMapOptions(liveMedia: state.vended()))
        XCTAssertEqual(mediaEntries(liveOnly).map(\.id), ["media:h:ab12"])

        // Canonical: the box reconstructed the entry on the begin's message (`view.media`).
        let aOwned = withMedia(a, [mediaView("ab12", path: "/home/u/cat.png")])
        let canonical = map([user("u1"), aOwned, b], TranscriptMapOptions(liveMedia: state.vended()))
        XCTAssertEqual(mediaEntries(canonical).map(\.id), ["media:h:ab12"])
        XCTAssertEqual(mediaEntries(canonical).first?.ownerMessageID, "A")
        for blocks in [liveOnly, canonical] {
            let ids = uniqueTranscriptRows(blocks).map(\.id)
            XCTAssertFalse(ids.contains { $0.contains("#dup") }, "no duplicate row id: \(ids)")
            XCTAssertEqual(ids.filter { $0.hasPrefix("fmedia:h:ab12") }, ["fmedia:h:ab12"])
        }
    }

    func testMediaRowIdsAreIdenticalAcrossTwoMappings() {
        let a = withMedia(assistant("A", parts: [beginPart("A", handle: "ab12"), showPart("A", handle: "ab12", path: "/home/u/cat.png")]),
                          [mediaView("ab12", path: "/home/u/cat.png")])
        let first = uniqueTranscriptRows(map([user("u1"), a])).map(\.id)
        let second = uniqueTranscriptRows(map([user("u1"), a])).map(\.id)
        XCTAssertEqual(first, second)
        XCTAssertTrue(first.contains("fmedia:h:ab12"))
    }

    // MARK: - F1 live tail

    func testLiveMediaTailExcludesSettledOwnersAndIncludesUnsettledOnes() {
        let settled = assistant("A", parts: [text("A", "x")])
        let running = assistant("C", completed: nil, parts: [])
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "aa", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "bb", messageID: "C"), now: t0)
        let tail = ChatTranscriptMapper.liveMediaTail(messages: [user("u1"), settled, running], live: state.vended(), isLiveWindow: false)
        XCTAssertEqual(mediaEntries(tail).map(\.id), ["media:h:bb"])
    }

    func testLiveMediaTailForAnAbsentOwnerNeedsTheLiveWindowAndTheCurrentTurn() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "aa", messageID: "not-in-transcript-yet"), now: t0)
        let messages = [user("u1")]
        XCTAssertEqual(mediaEntries(ChatTranscriptMapper.liveMediaTail(messages: messages, live: state.vended(), isLiveWindow: true)).count, 1)
        XCTAssertTrue(ChatTranscriptMapper.liveMediaTail(messages: messages, live: state.vended(), isLiveWindow: false).isEmpty)
    }

    // The round-4 paths, each through the REAL reducer (never a hand-made entry).

    func testPathPendingIsKeptWhenItsOwnerSettlesWithoutAShow() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "ab12", messageID: "A"), now: t0)
        let messages = [user("u1"), assistant("A", parts: [beginPart("A", handle: "ab12")])]
        let options = TranscriptMapOptions(running: true, liveMedia: state.vended())
        let entries = mediaEntries(map(messages, options))
        XCTAssertEqual(entries.map(\.id), ["media:h:ab12"])
        XCTAssertEqual(entries.first?.state, .pending)
        XCTAssertTrue(ChatTranscriptMapper.liveMediaTail(messages: messages, live: state.vended(), isLiveWindow: true).isEmpty)
    }

    func testPathFailureIsKeptAfterThePostTurnRefetch() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "ab12", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "fail", handle: "ab12", messageID: "A"), now: t0)
        state.observeRunning(false)
        let messages = [user("u1"), assistant("A", parts: [beginPart("A", handle: "ab12")])]
        let entries = mediaEntries(map(messages, TranscriptMapOptions(liveMedia: state.vended())))
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.state, .failed)
    }

    func testPathReadyIsRetiredByItsCanonicalTwin() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "ab12", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "show", handle: "ab12", messageID: "B", path: "/home/u/cat.png", mime: "image/png"), now: t0)
        let messages = [
            user("u1"),
            withMedia(assistant("A", parts: [beginPart("A", handle: "ab12")]), [mediaView("ab12", path: "/home/u/cat.png")]),
            assistant("B", parts: [showPart("B", handle: "ab12", path: "/home/u/cat.png")]),
        ]
        let entries = mediaEntries(map(messages, TranscriptMapOptions(liveMedia: state.vended())))
        XCTAssertEqual(entries.map(\.id), ["media:h:ab12"])
        XCTAssertEqual(entries.first?.inCurrentTurn, false, "the canonical entry is the one drawn, not the live twin")
        XCTAssertTrue(ChatTranscriptMapper.liveMediaTail(messages: messages, live: state.vended(), isLiveWindow: true).isEmpty)
    }

    func testPathAnOldOwnerBeyondTheWindowDrawsNowhereInALaterTurn() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "show", messageID: "X", path: "/home/u/old.png", mime: "image/png"), now: t0)
        state.observeRunning(false)
        state.observeRunning(true)   // turn 2
        let window = [user("u2"), assistant("Y", parts: [text("Y", "later")])]
        XCTAssertTrue(mediaEntries(map(window, TranscriptMapOptions(liveMedia: state.vended()))).isEmpty)
        XCTAssertTrue(ChatTranscriptMapper.liveMediaTail(messages: window, live: state.vended(), isLiveWindow: true).isEmpty)
    }

    func testPathAnOldFailureStaysOutOfANewTurnsTail() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "ab12", messageID: "A"), now: t0)
        state.apply(TranscriptMediaFrame(action: "fail", handle: "ab12", messageID: "A"), now: t0)
        state.observeRunning(false)
        state.observeRunning(true)   // turn 2; A is not in the window
        let window = [user("u2")]
        XCTAssertTrue(ChatTranscriptMapper.liveMediaTail(messages: window, live: state.vended(), isLiveWindow: true).isEmpty)
    }

    func testPathAFocusedSuffixShowsOnlyCurrentTurnMediaAtItsEnd() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "show", messageID: "OLD", path: "/home/u/old.png", mime: "image/png"), now: t0)
        state.observeRunning(false)
        state.observeRunning(true)   // turn 2
        state.apply(TranscriptMediaFrame(action: "show", messageID: "NEW", path: "/home/u/new.png", mime: "image/png"), now: t0)
        let full = [user("u1"), assistant("a1", parts: [text("a1", "x")]), user("u2"), assistant("a2", parts: [text("a2", "y")])]
        let suffix = Array(full.suffix(2))
        XCTAssertEqual(suffix.last?.info.id, full.last?.info.id)
        let tail = ChatTranscriptMapper.liveMediaTail(
            messages: suffix, live: state.vended(),
            isLiveWindow: suffix.last?.info.id == full.last?.info.id
        )
        XCTAssertEqual(mediaEntries(tail).map(\.id), ["media:s:NEW:/home/u/new.png"])
    }

    func testMapperAndTailAreDisjointForEveryOwnerKindAndWindow() {
        var state = TranscriptMediaSessionState()
        state.observeRunning(true)
        state.apply(TranscriptMediaFrame(action: "begin", handle: "aa", messageID: "A"), now: t0)      // settled owner
        state.apply(TranscriptMediaFrame(action: "begin", handle: "bb", messageID: "C"), now: t0)      // unsettled owner
        state.apply(TranscriptMediaFrame(action: "begin", handle: "cc", messageID: "ZZ"), now: t0)     // absent owner
        let messages = [user("u1"), assistant("A", parts: [text("A", "x")]), assistant("C", completed: nil, parts: [])]
        for isLiveWindow in [true, false] {
            let options = TranscriptMapOptions(running: true, liveMedia: state.vended())
            let inBlocks = Set(mediaEntries(map(messages, options)).map(\.id))
            let inTail = Set(mediaEntries(ChatTranscriptMapper.liveMediaTail(messages: messages, live: state.vended(), isLiveWindow: isLiveWindow)).map(\.id))
            XCTAssertTrue(inBlocks.isDisjoint(with: inTail), "isLiveWindow=\(isLiveWindow): \(inBlocks) vs \(inTail)")
            XCTAssertEqual(inBlocks, ["media:h:aa"])
            XCTAssertEqual(inTail, isLiveWindow ? ["media:h:bb", "media:h:cc"] : ["media:h:bb"])
        }
    }

    // MARK: - F1 store wiring (a real MantaEventStore)

    func testTheMediaStoreFollowsRunningEdgesAndMediaFrames() async {
        let stream = TranscriptTestStream()
        let events = MantaEventStore(stream: stream, tokenProvider: { nil }, serverProvider: { nil })
        let store = TranscriptMediaStore()
        store.bind(eventStore: events)
        store.bind(eventStore: events)   // idempotent

        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await settle()
        stream.inject(#"{"kind":"media","payload":{"action":"begin","handle":"ab12","sessionID":"ses","messageID":"A","kind":"image"}}"#)
        let first = store.entries(for: "ses")
        XCTAssertEqual(first.map(\.id), ["media:h:ab12"])
        XCTAssertEqual(first.first?.inCurrentTurn, true)

        stream.inject(#"{"kind":"stream","sub":"turnComplete","sessionId":"ses","payload":{"complete":true,"running":false}}"#)
        await settle()
        stream.inject(#"{"kind":"stream","sub":"running","sessionId":"ses","payload":{"running":true}}"#)
        await settle()
        XCTAssertEqual(store.entries(for: "ses").first?.inCurrentTurn, false, "the second turn opened, so the first turn's entry is no longer current")
    }

    private func settle() async {
        // The store's running sink hops through the main queue.
        try? await Task.sleep(nanoseconds: 80_000_000)
    }

    // MARK: - F2 reasoning

    private func reasoningMessages() -> [OpencodeMessage] {
        [user("u1"), assistant("a1", parts: [bash("t1", "a1"), reasoning("a1", "\n\nthinking hard\n"), bash("t2", "a1")])]
    }

    func testReasoningOffDrawsNoRowsAndTheRunStaysOne() {
        let blocks = map(reasoningMessages(), TranscriptMapOptions(showReasoning: false))
        let runs = blocks.compactMap { block -> ToolRun? in if case .activity(let run) = block { return run }; return nil }
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs.first?.parts.count, 2)
        XCTAssertFalse(blocks.contains { if case .reasoning = $0 { return true }; return false })
    }

    func testReasoningOnSplitsTheRunAndTrimsNewlines() {
        let blocks = map(reasoningMessages(), TranscriptMapOptions(showReasoning: true))
        let rows = uniqueTranscriptRows(blocks)
        guard let reasoningBlock = blocks.compactMap({ block -> TranscriptReasoning? in
            if case .reasoning(let value) = block { return value }
            return nil
        }).first else { return XCTFail("expected a reasoning block") }
        XCTAssertEqual(reasoningBlock.text, "thinking hard")
        XCTAssertEqual(reasoningBlock.id, "a1:reasoning:0")
        XCTAssertEqual(rows.map(\.id).filter { $0.hasPrefix("run-") }, ["run-t1", "run-t2"], "the second run's id is its first part's id")
        XCTAssertTrue(rows.map(\.id).contains("ra1:reasoning:0"))
    }

    func testBlankReasoningProducesNoRow() {
        let messages = [user("u1"), assistant("a1", parts: [reasoning("a1", "\n \n"), text("a1", "answer")])]
        XCTAssertFalse(map(messages, TranscriptMapOptions(showReasoning: true)).contains { if case .reasoning = $0 { return true }; return false })
    }

    // MARK: - The shape the store actually fetches (slim)

    /// The box's slim filter (`SLIM_DROP_PART_TYPES` in src/server/opencode.mjs):
    /// reasoning, step-start and snapshot parts are dropped; step-finish stays.
    private func slim(_ messages: [OpencodeMessage]) -> [OpencodeMessage] {
        messages.map { message in
            var copy = message
            copy.parts = message.parts.filter { !["step-start", "reasoning", "snapshot"].contains($0.type) }
            return copy
        }
    }

    func testASlimTranscriptStillCarriesTheRawFinishReasonSoContextWallSurvivesAReload() {
        let m = assistant("m", parts: [
            OpencodePart(type: "step-start", id: "m:ss", messageID: "m"),
            text("m", "cut"),
            stepFinish("m", reason: "model_context_window_exceeded"),
        ], tokens: output(5))
        let blocks = map(slim([user("u1"), m]))
        XCTAssertEqual(footers(blocks).first?.truncation?.kind, "context-wall")
    }

    func testASlimTranscriptHasNoReasoningRowsEvenWithTheSwitchOn() {
        let blocks = map(slim(reasoningMessages()), TranscriptMapOptions(showReasoning: true))
        XCTAssertFalse(blocks.contains { if case .reasoning = $0 { return true }; return false },
                       "the fetch must be unslimmed while the switch is on (TranscriptDisplayOptions.fetchSlim)")
        XCTAssertFalse(blocks.isEmpty)
    }

    // MARK: - F3 command turns

    func testUserMessageWithACommandBecomesACommandBand() {
        let origin = OpencodeCommandOrigin(name: "review", arguments: "main")
        let blocks = map([user("u1", "expanded template text", command: origin)])
        XCTAssertEqual(blocks.count, 1)
        guard case .command(let turn) = blocks[0] else { return XCTFail("expected .command, got \(blocks)") }
        XCTAssertEqual(turn.name, "review")
        XCTAssertEqual(turn.arguments, "main")
        XCTAssertEqual(turn.expandedText, "expanded template text")
        XCTAssertEqual(uniqueTranscriptRows(blocks).map(\.id), ["cmd-u1"])
    }

    func testWithoutACommandOriginTheTurnStaysAUserBand() {
        guard case .user = map([user("u1", "plain")])[0] else { return XCTFail("expected .user") }
    }

    func testALiveCommandFillsAMessageWithNoDurableOrigin() {
        let live = ["u1": OpencodeCommandOrigin(name: "init", arguments: nil)]
        guard case .command(let turn) = map([user("u1", "template")], TranscriptMapOptions(liveCommands: live))[0] else {
            return XCTFail("expected .command")
        }
        XCTAssertEqual(turn.arguments, "")
    }

    func testTheDurableCommandWinsOverTheLiveOne() {
        let durable = OpencodeCommandOrigin(name: "durable", arguments: nil)
        let live = ["u1": OpencodeCommandOrigin(name: "live", arguments: nil)]
        guard case .command(let turn) = map([user("u1", "t", command: durable)], TranscriptMapOptions(liveCommands: live))[0] else {
            return XCTFail("expected .command")
        }
        XCTAssertEqual(turn.name, "durable")
    }

    func testAnEmptyCommandNameIsAnOrdinaryUserBand() {
        let empty = OpencodeCommandOrigin(name: "", arguments: "x")
        guard case .user = map([user("u1", "t", command: empty)])[0] else { return XCTFail("expected .user") }
    }

    // MARK: - F4 footer

    private func output(_ n: Double) -> OpencodeTokenUsage {
        OpencodeTokenUsage(input: 1, output: n, reasoning: 0, cache: nil)
    }

    func testAFinishedTurnEndsWithAFooterAfterItsLastBlock() {
        let blocks = map([user("u1"), assistant("a1", created: 1_000, completed: 61_000, parts: [text("a1", "hi")], tokens: output(100))])
        XCTAssertEqual(blocks.count, 3)
        guard case .turnFooter(let footer) = blocks[2] else { return XCTFail("expected a footer last, got \(blocks)") }
        XCTAssertEqual(footer.messageID, "a1")
        XCTAssertTrue(footer.isTurnEnd)
        XCTAssertEqual(footer.summary, "\(TranscriptTurnVerb.past[TranscriptTurnVerb.index(for: "a1")]) for 1m0s \u{00B7} 100 tokens")
        XCTAssertEqual(uniqueTranscriptRows(blocks).last?.id, "tf-a1")
    }

    func testAMidTurnTruncatedMessageGetsAWarningOnlyFooter() {
        let a1 = assistant("a1", parts: [text("a1", "cut off"), stepFinish("a1", reason: "max_tokens")], tokens: output(5))
        let a2 = assistant("a2", created: 3_000, completed: 4_000, parts: [text("a2", "done")])
        let all = footers(map([user("u1"), a1, a2]))
        XCTAssertEqual(all.map(\.messageID), ["a1", "a2"])
        XCTAssertNil(all[0].summary)
        XCTAssertFalse(all[0].isTurnEnd)
        XCTAssertEqual(all[0].turnText, "", "no reply menu on a warning-only footer")
        XCTAssertEqual(all[0].truncation?.kind, "output-cap")
        XCTAssertTrue(all[1].isTurnEnd)
        XCTAssertEqual(all[1].turnText, "cut off\n\ndone")
    }

    func testALiveTruncationThenAnIncompleteSnapshotGivesNoFooterAndTheNoticeStays() {
        let incomplete = assistant("m", completed: nil, parts: [text("m", "partial")])
        let live = TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "H"))
        let blocks = map([user("u1"), incomplete], TranscriptMapOptions(liveTruncation: live))
        XCTAssertTrue(footers(blocks).isEmpty)
        XCTAssertTrue(ChatTranscriptMapper.footerTruncationMessageIDs(blocks).isEmpty, "WS02 keeps its notice")
    }

    func testACompletedMessageWithNoStepFinishTakesTheLiveKindAndIsInTheSet() {
        let m = assistant("m", parts: [text("m", "x")])
        let live = TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "H"))
        let blocks = map([user("u1"), m], TranscriptMapOptions(liveTruncation: live))
        XCTAssertEqual(footers(blocks).first?.truncation?.kind, "output-cap")
        XCTAssertEqual(ChatTranscriptMapper.footerTruncationMessageIDs(blocks), ["m"])
    }

    func testALiveOnlyTruncationOnANonFinalMessageIsAWarningOnlyFooter() {
        let m = assistant("m", parts: [text("m", "step")])
        let n = assistant("n", created: 3_000, completed: 4_000, parts: [text("n", "next")])
        let live = TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "context-wall", label: "truncated (context full)", hint: "H"))
        let blocks = map([user("u1"), m, n], TranscriptMapOptions(liveTruncation: live))
        let all = footers(blocks)
        XCTAssertEqual(all.first?.messageID, "m")
        XCTAssertEqual(all.first?.isTurnEnd, false)
        XCTAssertNil(all.first?.summary)
        XCTAssertEqual(all.first?.turnText, "")
        XCTAssertTrue(ChatTranscriptMapper.footerTruncationMessageIDs(blocks).contains("m"))
    }

    func testACompletedLastStepWhileRunningGivesNoFooterAndNoMenu() {
        let blocks = map([user("u1"), assistant("a1", parts: [text("a1", "prose")])], TranscriptMapOptions(running: true))
        XCTAssertTrue(footers(blocks).isEmpty)
    }

    func testALiveTruncationForAnotherMessageDoesNotAffectThisOne() {
        let live = TranscriptLiveTruncation(messageID: "other", view: TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "H"))
        let blocks = map([user("u1"), assistant("m", parts: [text("m", "x")])], TranscriptMapOptions(liveTruncation: live))
        XCTAssertNil(footers(blocks).first?.truncation)
    }

    func testACompletedMessageWithNoFinishRecordAndNoLiveEntryHasNoBadge() {
        let blocks = map([user("u1"), assistant("m", parts: [text("m", "x")])])
        XCTAssertNil(footers(blocks).first?.truncation)
        XCTAssertTrue(ChatTranscriptMapper.footerTruncationMessageIDs(blocks).isEmpty)
    }

    func testTheCanonicalKindBeatsTheLiveOne() {
        let m = assistant("m", parts: [text("m", "x"), stepFinish("m", reason: "length")], tokens: output(3))
        let live = TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "context-wall", label: "truncated (context full)", hint: "H"))
        XCTAssertEqual(footers(map([user("u1"), m], TranscriptMapOptions(liveTruncation: live))).first?.truncation?.kind, "output-cap")
    }

    func testFooterIdsAreStableAcrossMappings() {
        let messages = [user("u1"), assistant("a1", parts: [text("a1", "x")])]
        XCTAssertEqual(uniqueTranscriptRows(map(messages)).map(\.id), uniqueTranscriptRows(map(messages)).map(\.id))
    }

    func testTurnTextJoinsProseWithABlankLineAndExcludesToolRuns() {
        let a1 = assistant("a1", parts: [text("a1", "first")])
        let a2 = assistant("a2", created: 3_000, completed: 4_000, parts: [bash("t1", "a2"), text("a2", "second")])
        XCTAssertEqual(footers(map([user("u1"), a1, a2])).last?.turnText, "first\n\nsecond")
    }

    func testABackgroundResultSplitsTheTurnSoEachSideKeepsItsOwnFooter() {
        let bg = OpencodePart(type: "background-result", id: "bgm:bg", messageID: "bgm", text: "result", extra: [:])
        let messages = [
            user("u1"),
            assistant("a1", parts: [text("a1", "started")]),
            assistant("bgm", created: 5_000, completed: 5_000, parts: [bg]),
            assistant("a2", created: 6_000, completed: 8_000, parts: [text("a2", "review passed")]),
        ]
        let blocks = map(messages)
        XCTAssertEqual(footers(blocks).map(\.messageID), ["a1", "a2"], "the result message draws nothing and carries no footer")
        XCTAssertEqual(footers(blocks).first?.turnText, "started")
        XCTAssertEqual(footers(blocks).last?.turnText, "review passed", "the second turn's text never includes the first's")
    }

    func testABackgroundResultsOwnTextIsNotPartOfTheNextTurnsReplyText() {
        let bg = OpencodePart(type: "background-result", id: "bgm:bg", messageID: "bgm", text: "result", extra: [:])
        let bgText = text("bgm", "SHOULD NOT LEAK")
        let messages = [
            user("u1"),
            assistant("a1", parts: [text("a1", "started")]),
            assistant("bgm", created: 5_000, completed: 5_000, parts: [bg, bgText]),
            assistant("a2", created: 6_000, completed: 8_000, parts: [text("a2", "review passed")]),
        ]
        XCTAssertEqual(footers(map(messages)).last?.turnText, "review passed")
    }

    // MARK: - D8: the footer comes from the box's view only

    func testAnUnstampedTranscriptHasNoFooterAndNoReloadTimeTruncation() {
        // An older box (no `view`): the phone derives nothing, not even from a max_tokens finish.
        let m = assistant("a1", created: 1_000, completed: 61_000, parts: [text("a1", "hi"), stepFinish("a1", reason: "max_tokens")], tokens: output(5))
        let raw = ChatTranscriptMapper.blocks(from: [user("u1"), m], voiceNotes: [], widgets: [], options: TranscriptMapOptions())
        XCTAssertTrue(footers(raw).isEmpty)
    }

    func testLiveBeforeRefetchTheFooterShowsTheLiveLabelAndHintThenTheCanonicalViewTakesOverWithTheSameRowID() {
        let m = assistant("m", parts: [text("m", "x")])
        let live = TranscriptLiveTruncation(messageID: "m", view: TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "live hint"))
        let before = footers(ChatTranscriptMapper.blocks(from: [user("u1"), m], voiceNotes: [], widgets: [], options: TranscriptMapOptions(liveTruncation: live)))
        XCTAssertEqual(before.first?.truncation?.label, "truncated (output limit)")
        XCTAssertEqual(before.first?.truncation?.hint, "live hint")
        var canonical = m
        canonical.view = TranscriptMessageView(truncation: TranscriptTruncationView(kind: "output-cap", label: "truncated (output limit)", hint: "box hint"))
        let afterBlocks = ChatTranscriptMapper.blocks(from: [user("u1"), canonical], voiceNotes: [], widgets: [], options: TranscriptMapOptions(liveTruncation: live))
        XCTAssertEqual(footers(afterBlocks).first?.truncation?.hint, "box hint", "the canonical view wins")
        let beforeID = uniqueTranscriptRows(ChatTranscriptMapper.blocks(from: [user("u1"), m], voiceNotes: [], widgets: [], options: TranscriptMapOptions(liveTruncation: live))).last?.id
        XCTAssertEqual(uniqueTranscriptRows(afterBlocks).last?.id, beforeID)
        XCTAssertEqual(beforeID, "tf-m")
    }

    func testAnOldBoxsLiveFrameHasNoHintSoThePillIsPlainText() {
        let m = assistant("m", parts: [text("m", "x")])
        let live = TranscriptLiveTruncation.from(payload: StreamTruncationPayload(kind: "output-cap", label: "truncated (output limit)", messageID: "m"))
        let blocks = ChatTranscriptMapper.blocks(from: [user("u1"), m], voiceNotes: [], widgets: [], options: TranscriptMapOptions(liveTruncation: live))
        let f = footers(blocks).first
        XCTAssertEqual(f?.truncation?.label, "truncated (output limit)")
        XCTAssertNil(f?.truncation?.hint, "no explain action")
    }

    func testTheFooterMessageIDsHelperReadsOnlyTruncatedFooters() {
        let blocks: [TranscriptBlock] = [
            .turnFooter(TranscriptTurnFooter(messageID: "a", summary: nil, truncation: TranscriptTruncationView(kind: "output-cap", label: "x"), isTurnEnd: false, turnText: "")),
            .turnFooter(TranscriptTurnFooter(messageID: "b", summary: "x", truncation: nil, isTurnEnd: true, turnText: "t")),
        ]
        XCTAssertEqual(ChatTranscriptMapper.footerTruncationMessageIDs(blocks), ["a"])
    }

    // MARK: - F6 quote capability

    private func actions(onQuote: ((String, QuoteDestination) -> Void)?) -> TranscriptCardActions {
        TranscriptCardActions(
            buildModelName: "",
            onPermissionReply: { _, _ in }, onQuestionSubmit: { _, _ in }, onQuestionReject: { _ in },
            onBuildHere: { _, _ in }, onKeepPlanning: { _, _ in }, onOpenPage: { _ in },
            onQuote: onQuote
        )
    }

    func testReadOnlySurfacesCannotQuote() {
        XCTAssertFalse(TranscriptQuoteCapability.canQuote(.readOnly()))
        XCTAssertFalse(TranscriptQuoteCapability.canQuote(.readOnly(onOpenActivity: { _ in })))
        XCTAssertFalse(TranscriptQuoteCapability.canQuote(nil))
    }

    func testALiveSurfaceWithAQuoteClosureCanQuote() {
        XCTAssertTrue(TranscriptQuoteCapability.canQuote(actions(onQuote: { _, _ in })))
        XCTAssertFalse(TranscriptQuoteCapability.canQuote(actions(onQuote: nil)))
    }

    // MARK: - F5 copy + verbose output

    func testCopyTextForBashIsTheFullOutputNotTheTail() {
        let lines = (1...40).map { "line \($0)" }.joined(separator: "\n")
        let part = ToolActivity.makeToolPart(id: "t", tool: "bash", status: "completed", input: ["command": .string("seq 40")], output: lines)
        XCTAssertEqual(ToolActivity.copyText(of: part), lines)
        XCTAssertNotEqual(ToolActivity.copyText(of: part), ToolOutputPreview.tail(lines))
    }

    func testCopyTextForAnEditIsItsDiff() {
        let part = ToolActivity.makeToolPart(
            id: "t", tool: "edit", status: "completed",
            input: ["filePath": .string("/a.swift")], metadata: ["diff": .string("-old\n+new")], output: "Edit applied successfully."
        )
        XCTAssertEqual(ToolActivity.copyText(of: part), "-old\n+new")
    }

    func testCopyTextForAWriteWithNoOutputIsNil() {
        let part = ToolActivity.makeToolPart(id: "t", tool: "write", status: "completed", input: ["filePath": .string("/a.txt")], output: "")
        XCTAssertNil(ToolActivity.copyText(of: part))
    }

    func testCopyTextForAPatchIsItsFileList() {
        let part = OpencodePart(type: "patch", id: "p", messageID: "m", extra: ["files": .array([.string("a.swift"), .string("b.swift")])])
        XCTAssertEqual(ToolActivity.copyText(of: part), "a.swift\nb.swift")
    }

    func testCopyTextForATaskIsNil() {
        let part = ToolActivity.makeToolPart(id: "t", tool: "task", status: "completed", input: ["description": .string("x")], output: "done")
        XCTAssertNil(ToolActivity.copyText(of: part))
    }

    func testCopyTextForARunningToolUsesItsLiveMetadataOutput() {
        let part = ToolActivity.makeToolPart(id: "t", tool: "bash", status: "running", input: ["command": .string("ls")], metadata: ["output": .string("partial")])
        XCTAssertEqual(ToolActivity.copyText(of: part), "partial")
    }

    func testNonVerboseOutputIsTheTailedPreview() {
        let lines = (1...40).map { "l\($0)" }.joined(separator: "\n")
        let shown = ToolActivity.outputForDisplay(lines, verbose: false)
        XCTAssertEqual(shown.text, ToolOutputPreview.tail(lines))
        XCTAssertTrue(shown.trimmed)
    }

    func testVerboseOutputWithinTheBoundsIsUnchanged() {
        let lines = (1...2_000).map { "l\($0)" }.joined(separator: "\n")
        let shown = ToolActivity.outputForDisplay(lines, verbose: true)
        XCTAssertEqual(shown.text, lines)
        XCTAssertFalse(shown.trimmed)
    }

    func testAVerboseTenThousandLineOutputKeepsTheLastTwoThousandLines() {
        let lines = (0..<10_000).map { "l\($0)" }.joined(separator: "\n")
        let shown = ToolActivity.outputForDisplay(lines, verbose: true)
        XCTAssertTrue(shown.trimmed)
        XCTAssertTrue(shown.text.hasPrefix("… \n"))
        XCTAssertTrue(shown.text.hasSuffix("l9999"))
        XCTAssertFalse(shown.text.contains("l7999\n"))
        XCTAssertEqual(shown.text.components(separatedBy: "\n").count, 2_001, "the '… ' prefix line plus 2,000 lines")
    }

    func testAVerboseMillionCharacterLineKeepsTheLastHundredThousand() {
        let line = String(repeating: "x", count: 1_000_000)
        let shown = ToolActivity.outputForDisplay(line, verbose: true)
        XCTAssertTrue(shown.trimmed)
        XCTAssertEqual(shown.text.count, ToolOutputPreview.verboseMaxCharacters + 3)
    }

    func testAVerboseCompletedReadStartsExpandedAndTheUserStillWins() {
        func expanded(verbose: Bool, userToggled: Bool? = nil) -> Bool {
            ActivityDisclosure.expanded(callCount: 3, status: .completed, isTool: true, userToggled: userToggled, kind: .read, verbose: verbose)
        }
        XCTAssertFalse(expanded(verbose: false))
        XCTAssertTrue(expanded(verbose: true))
        XCTAssertFalse(expanded(verbose: true, userToggled: false), "a user's own toggle beats the default")
        XCTAssertFalse(ActivityDisclosure.expanded(callCount: 3, status: .completed, isTool: true, userToggled: nil, kind: .bash, verbose: true))
    }

    // MARK: - Client + geometry pins

    func testThePeekRequestCarriesTheMethodAndBearerToken() throws {
        let url = try XCTUnwrap(URL(string: "https://box.example/api/peek?path=%2Fa"))
        let head = MantaAPIClient.peekRequest(url: url, method: "HEAD", token: "tok")
        XCTAssertEqual(head.httpMethod, "HEAD")
        XCTAssertEqual(head.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(MantaAPIClient.peekRequest(url: url, method: "GET", token: nil).value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(MantaAPIClient.peekRequest(url: url, method: "GET", token: "").value(forHTTPHeaderField: "Authorization"))
    }

    func testTheInlineWidthCopyMatchesTheDesignToken() {
        XCTAssertEqual(TranscriptMediaGeometry.inlineMaxWidth, Double(Metrics.type.inlineMaxW))
    }

    // MARK: - The stager

    private final class IdentityBox {
        var value: TranscriptFileStager.Identity
        init(_ value: TranscriptFileStager.Identity) { self.value = value }
    }

    func testAnIdentityChangeDropsTheCacheAndNeverServesTheOldBoxsFile() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("stager-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = IdentityBox(TranscriptFileStager.Identity(boxID: "boxA", serverURL: "https://a.example"))
        let backend = TranscriptFileStager.Backend(
            peekSize: { _ in 4 },
            download: { _, destination, _ in try Data("data".utf8).write(to: destination) }
        )
        let stager = TranscriptFileStager(identity: { identity.value }, backend: backend, root: root)

        let first = try await stager.localURL(for: .boxPath("/home/u/a.txt"), sizeHint: nil, filename: "a.txt")
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(first.lastPathComponent, "a.txt")
        XCTAssertEqual(stager.cachedCount, 1)
        let again = try await stager.localURL(for: .boxPath("/home/u/a.txt"), sizeHint: nil, filename: "a.txt")
        XCTAssertEqual(again, first, "the same box serves the cached file")

        identity.value = TranscriptFileStager.Identity(boxID: "boxB", serverURL: "https://b.example")
        let second = try await stager.localURL(for: .boxPath("/home/u/a.txt"), sizeHint: nil, filename: "a.txt")
        XCTAssertNotEqual(second, first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "the old box's file is gone")
        XCTAssertEqual(stager.cachedCount, 1, "the old box's entries were dropped")
    }

    func testAnOverCapFileIsRefusedBeforeAnyDownload() async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("stager-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = TranscriptFileStager.Backend(
            peekSize: { _ in 30 * 1024 * 1024 },
            download: { _, _, _ in throw TranscriptFileFailure.unavailable("an over-cap file must not be downloaded") }
        )
        let stager = TranscriptFileStager(identity: { TranscriptFileStager.Identity(boxID: "b", serverURL: "s") }, backend: backend, root: root)
        do {
            _ = try await stager.localURL(for: .boxPath("/big.mov"), sizeHint: nil)
            XCTFail("expected tooLarge")
        } catch let failure as TranscriptFileFailure {
            XCTAssertEqual(failure, .tooLarge(30 * 1024 * 1024))
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}

/// A stream control that never connects but can inject frames into the store.
@MainActor
private final class TranscriptTestStream: MantaEventStreamControl {
    var onState: ((MantaConnectionState) -> Void)?
    var onMessage: ((String) -> Void)?
    var onReconnect: (() -> Void)?
    var onConfigError: ((Error) -> Void)?
    var hasConnectedOnce = false
    var currentState: MantaConnectionState = .idle

    func ensure() {}
    func markReconnectAndEnsure() {}
    func retryNow() {}
    func forceReconnect() {}
    func close(reason: String) {}

    func inject(_ text: String) { onMessage?(text) }
}
