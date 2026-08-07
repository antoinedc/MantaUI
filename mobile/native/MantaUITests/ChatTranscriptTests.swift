import XCTest
@testable import MantaUI

// S4 / BET-596 — the pure chat mapping: `opencode:messages` → TranscriptBlock,
// the step-row presentation, the rollup, and the §8 header subtitle. These are
// the device-side PRESENTATION decisions only (§17); interpretation stays on
// the box. No HTTP/view/Keychain involved.

final class ChatTranscriptTests: XCTestCase {

    // MARK: - Fixture builders

    private func jsonObject(_ d: [String: JSONValue]) -> JSONValue { .object(d) }
    private func str(_ s: String) -> JSONValue { .string(s) }
    private func num(_ n: Double) -> JSONValue { .number(n) }

    private func textPart(_ id: String, _ messageID: String, _ text: String) -> OpencodePart {
        OpencodePart(type: "text", id: id, messageID: messageID, text: text)
    }

    private func toolPart(_ id: String, _ messageID: String, tool: String, status: String, input: [String: JSONValue], output: String? = nil, start: Double? = 100, end: Double? = 100.4) -> OpencodePart {
        var state: [String: JSONValue] = [
            "status": str(status),
            "input": jsonObject(input),
        ]
        if let output { state["output"] = str(output) }
        if let start, let end {
            state["time"] = jsonObject(["start": num(start), "end": num(end)])
        }
        return OpencodePart(type: "tool", id: id, messageID: messageID, extra: [
            "tool": str(tool),
            "state": jsonObject(state),
        ])
    }

    private func taskPart(_ id: String, _ messageID: String, childID: String, title: String, status: String) -> OpencodePart {
        var stateObject: [String: JSONValue] = [
            "status": str(status),
            "title": str(title),
            "metadata": jsonObject(["sessionId": str(childID)]),
        ]
        stateObject["time"] = jsonObject(["start": num(0), "end": num(5)])
        return OpencodePart(type: "tool", id: id, messageID: messageID, extra: [
            "tool": str("task"),
            "state": jsonObject(stateObject),
        ])
    }

    private func message(id: String, role: String, parts: [OpencodePart], completed: Bool = true) -> OpencodeMessage {
        OpencodeMessage(
            info: OpencodeMessageInfo(
                id: id,
                sessionID: "ses",
                role: OpencodeRole(rawValue: role),
                time: OpencodeTime(created: 0, completed: completed ? 1 : nil),
                modelID: nil,
                providerID: nil
            ),
            parts: parts
        )
    }

    // MARK: - User + prose

    func testUserTextMapsToUserBand() {
        let msgs = [message(id: "m1", role: "user", parts: [textPart("p1", "m1", "check bet-520")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .user(let text, _) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(text, "check bet-520")
    }

    func testAssistantTextMapsToProse() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Checking metadata.")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .prose(let text, _) = blocks[0] else {
            return XCTFail("expected .prose")
        }
        XCTAssertEqual(text, "Checking metadata.")
    }

    // MARK: - Timestamps (swipe-to-reveal gutter)

    /// opencode stamps `time` in epoch MILLISECONDS. Reading it as seconds puts
    /// every message in January 1970, which the gutter would render as a
    /// plausible-looking (and entirely wrong) time — so the unit is pinned here.
    func testUserBlockCarriesCreatedTimeInMilliseconds() {
        let createdMs: Double = 1_785_794_760_000  // 2026-08-03T18:06:00Z
        let msg = OpencodeMessage(
            info: OpencodeMessageInfo(
                id: "m1",
                sessionID: "ses",
                role: OpencodeRole(rawValue: "user"),
                time: OpencodeTime(created: createdMs, completed: nil),
                modelID: nil,
                providerID: nil
            ),
            parts: [textPart("p1", "m1", "check bet-520")]
        )
        let blocks = ChatTranscriptMapper.blocks(from: [msg])
        guard case .user(_, let at) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(at?.timeIntervalSince1970 ?? 0, createdMs / 1000, accuracy: 0.001)
    }

    /// A reply is timestamped when it FINISHED — that is the moment the reader
    /// saw it land.
    func testProseBlockCarriesCompletedTime() {
        let completedMs: Double = 1_785_794_820_000
        let msg = OpencodeMessage(
            info: OpencodeMessageInfo(
                id: "m1",
                sessionID: "ses",
                role: OpencodeRole(rawValue: "assistant"),
                time: OpencodeTime(created: 1_785_794_800_000, completed: completedMs),
                modelID: nil,
                providerID: nil
            ),
            parts: [textPart("p1", "m1", "Checking metadata.")]
        )
        let blocks = ChatTranscriptMapper.blocks(from: [msg])
        guard case .prose(_, let at) = blocks[0] else {
            return XCTFail("expected .prose, got \(blocks[0])")
        }
        XCTAssertEqual(at?.timeIntervalSince1970 ?? 0, completedMs / 1000, accuracy: 0.001)
    }

    /// Machinery has no wall-clock reading in the gutter — its rows already
    /// state how long each step took.
    func testStepsBlockHasNoTimestamp() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("ls")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertNil(blocks[0].timestamp)
    }

    /// A missing / zero / non-finite stamp must produce no date, so the gutter
    /// renders an empty slot instead of 1970.
    func testChatClockRejectsUnusableStamps() {
        XCTAssertNil(ChatClock.date(epochMs: nil))
        XCTAssertNil(ChatClock.date(epochMs: 0))
        XCTAssertNil(ChatClock.date(epochMs: -1))
        XCTAssertNil(ChatClock.date(epochMs: .infinity))
        XCTAssertEqual(ChatClock.time(nil), "")
        XCTAssertFalse(ChatClock.time(Date(timeIntervalSince1970: 1_785_794_760)).isEmpty)
    }

    // MARK: - Steps

    func testBashStepMapsToRanVerbAndCommandTarget() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("multica issue get BET-520")], output: "Blocked", start: 100, end: 100.4),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], rows.count == 1, case .step(let step) = rows[0] else {
            return XCTFail("expected a single-step group")
        }
        XCTAssertEqual(step.verb, "Ran")
        XCTAssertEqual(step.target, "multica issue get BET-520")
        XCTAssertEqual(step.duration, "0.4s")
        XCTAssertEqual(step.status, .done)
        XCTAssertEqual(step.output, "Blocked")
    }

    func testReadStepMapsToReadVerbAndFilePathTarget() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "running", input: ["filePath": str("pr-body.md")], output: nil, start: nil, end: nil),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], case .step(let step) = rows[0] else {
            return XCTFail("expected a step")
        }
        XCTAssertEqual(step.verb, "Read")
        XCTAssertEqual(step.target, "pr-body.md")
        // timeless running row → no duration
        XCTAssertEqual(step.duration, "")
        XCTAssertEqual(step.status, .running)
    }

    // MARK: - Subagent

    func testTaskPartMapsToSubagentWithChildSession() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            taskPart("t1", "m1", childID: "ses_child", title: "unblock sweep", status: "running"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], rows.count == 1, case .subagent(let agent) = rows[0] else {
            return XCTFail("expected a subagent row")
        }
        XCTAssertEqual(agent.taskName, "unblock sweep")
        XCTAssertEqual(agent.childSessionId, "ses_child")
        XCTAssertEqual(agent.status, .running)
        XCTAssertEqual(agent.duration, "5.0s")
    }

    // MARK: - Rollup

    func testThreeConsecutiveStepsRollUp() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
            toolPart("t3", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rollup(let summary, let rows)) = blocks[0], rows.count == 3 else {
            return XCTFail("expected a rollup of 3")
        }
        XCTAssertEqual(summary, "▸ 3 steps · Read 2, Ran 1")
    }

    func testTwoStepsStayUnrolled() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], rows.count == 2 else {
            return XCTFail("expected two unrolled rows")
        }
        XCTAssertEqual(rows.count, 2)
    }

    // MARK: - Blank-text parts must not inflate the step-group gap (BET-632)

    func testBlankTextPartBeforeStepsDoesNotEmitProseBlock() {
        // opencode commonly emits a newline/whitespace-only text part between
        // the real prose and a tool run. It must NOT become a `.prose` block —
        // that would stack another `--sp-3` + line box and widen the gap above
        // the 'Ran' group.
        let msgs = [message(id: "m1", role: "assistant", parts: [
            textPart("p1", "m1", "Let me check the issue."),
            textPart("p2", "m1", "\n"),
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("multica issue get BET-520")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertEqual(blocks.count, 2, "expected prose + steps only, got \(blocks)")
        guard case .prose = blocks[0], case .steps = blocks[1] else {
            return XCTFail("expected [.prose, .steps], got \(blocks)")
        }
    }

    func testWhitespaceOnlyTextPartIsBlank() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "   \n  ")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertTrue(blocks.isEmpty, "whitespace-only text must be skipped, got \(blocks)")
    }

    func testBlankTrailingTextAfterStepsIsSkipped() {
        // A blank text part AFTER a tool run must not leave a stray `.prose`
        // block trailing the steps group (another false gap on the next block).
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
            textPart("p1", "m1", "\n\n"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertEqual(blocks.count, 1, "expected only the steps block, got \(blocks)")
        guard case .steps = blocks[0] else {
            return XCTFail("expected .steps, got \(blocks)")
        }
    }

    func testUserBlankPartDoesNotAddParagraphInsideBand() {
        let msgs = [message(id: "m1", role: "user", parts: [
            textPart("p1", "m1", "check bet-520"),
            textPart("p2", "m1", "\n"),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .user(let text, _) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(text, "check bet-520")
    }

    func testSubagentNeverRolls() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
            taskPart("t2", "m1", childID: "c", title: "sweep", status: "running"),
            toolPart("t3", "m1", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .steps(.rows(let rows)) = blocks[0], rows.count == 3 else {
            return XCTFail("agent rows must keep the group as raw rows")
        }
        XCTAssertEqual(rows.count, 3)
    }

    // MARK: - Streaming duplication avoidance

    func testIncompleteAssistantMessageIsNotDuplicated() {
        // The running assistant turn (no time.completed) must NOT emit a prose
        // block — its text streams live via `stream.flush` and the store
        // appends it as the in-progress tail. Including it here would double
        // it while streaming.
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "streaming…")], completed: false)]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        XCTAssertTrue(blocks.isEmpty)
    }

    // MARK: - Header subtitle (§8)

    func testHeaderSubtitleRunningWithContext() {
        XCTAssertEqual(ChatHeaderSubtitle.text(running: true, elapsed: 61, contextPct: 8.4), "running · 1m · 8%")
    }

    func testHeaderSubtitleRunningNoContext() {
        XCTAssertEqual(ChatHeaderSubtitle.text(running: true, elapsed: 0, contextPct: nil), "running · 0s")
    }

    func testHeaderSubtitleIdleWithContext() {
        XCTAssertEqual(ChatHeaderSubtitle.text(running: false, elapsed: 0, contextPct: 12.6), "idle · 13%")
    }

    func testHeaderSubtitleIdle() {
        XCTAssertEqual(ChatHeaderSubtitle.text(running: false, elapsed: 0, contextPct: nil), "idle")
    }

    // MARK: - Question answers (§7.5)

    private func q(_ question: String, options: [String], multiple: Bool = false) -> QuestionInfo {
        QuestionInfo(
            question: question,
            header: "",
            options: options.map { QuestionOption(label: $0, description: "") },
            multiple: multiple,
            custom: false
        )
    }

    func testQuestionFreeTextAloneCanSubmitAcrossAll() {
        let questions = [q("Pick", options: ["A", "B"]), q("Pick2", options: ["C", "D"])]
        XCTAssertTrue(ChatQuestionAnswers.canSubmit(questions: questions, selected: [:], customText: "typed"))
        let out = ChatQuestionAnswers.answers(questions: questions, selected: [:], customText: "typed")
        XCTAssertEqual(out, [["typed"], ["typed"]])
    }

    func testQuestionSubmitDisabledUntilEveryQuestionAnswered() {
        let questions = [q("Q1", options: ["A"]), q("Q2", options: ["B"])]
        // Only Q1 answered → disabled.
        XCTAssertFalse(ChatQuestionAnswers.canSubmit(questions: questions, selected: [0: [0]], customText: ""))
        // Both answered → enabled.
        XCTAssertTrue(ChatQuestionAnswers.canSubmit(questions: questions, selected: [0: [0], 1: [0]], customText: ""))
    }

    func testQuestionPerQuestionSelectionsDoNotCollide() {
        // Option index 0 selected on question A must not select option 0 on B.
        let questions = [q("Q1", options: ["A0", "A1"]), q("Q2", options: ["B0", "B1"])]
        let out = ChatQuestionAnswers.answers(questions: questions, selected: [0: [1]], customText: "")
        XCTAssertEqual(out, [["A1"], []])
        XCTAssertFalse(ChatQuestionAnswers.canSubmit(questions: questions, selected: [0: [1]], customText: ""))
        XCTAssertTrue(ChatQuestionAnswers.canSubmit(questions: questions, selected: [0: [1], 1: [0]], customText: ""))
    }

    func testQuestionMultipleSelectionAccumulates() {
        let q = [QuestionInfo(question: "M", header: "", options: [
            QuestionOption(label: "x", description: ""),
            QuestionOption(label: "y", description: ""),
        ], multiple: true, custom: false)]
        let out = ChatQuestionAnswers.answers(questions: q, selected: [0: [0, 1]], customText: "")
        XCTAssertEqual(out, [["x", "y"]])
    }

    // MARK: - Block markdown
    //
    // The transcript used to run assistant text through inline-only markdown
    // parsing, which passes every BLOCK construct through as literal text: a
    // GFM table rendered as its own pipes and dashes, and `##` headings as
    // hashes. These pin the block split.

    func testMarkdownTableIsParsedWithHeaderAndRows() {
        let raw = """
        Intro line.

        | | today | on-device |
        |---|---|---|
        | Latency | record → upload | live partials |
        | Offline | broken | works |

        Trailing prose.
        """
        let blocks = MantaMarkdownParser.blocks(raw)
        guard blocks.count == 3 else {
            return XCTFail("expected paragraph + table + paragraph, got \(blocks)")
        }
        XCTAssertEqual(blocks[0], .paragraph("Intro line."))
        XCTAssertEqual(blocks[2], .paragraph("Trailing prose."))
        guard case .table(let table) = blocks[1] else {
            return XCTFail("second block is not a table: \(blocks[1])")
        }
        // The leading corner cell is EMPTY and must survive — dropping empties
        // would shift every column left by one.
        XCTAssertEqual(table.header, ["", "today", "on-device"])
        XCTAssertEqual(table.alignments, [.leading, .leading, .leading])
        XCTAssertEqual(table.rows, [
            ["Latency", "record → upload", "live partials"],
            ["Offline", "broken", "works"],
        ])
    }

    func testMarkdownTableAlignmentsAndRaggedRows() {
        let raw = """
        | a | b | c |
        |:--|:-:|--:|
        | 1 |
        | 1 | 2 | 3 | 4 |
        """
        let blocks = MantaMarkdownParser.blocks(raw)
        guard case .table(let table)? = blocks.first else {
            return XCTFail("expected a table, got \(blocks)")
        }
        XCTAssertEqual(table.alignments, [.leading, .center, .trailing])
        // Ragged rows are padded/truncated to the header width so the layout
        // can never index past a short row.
        XCTAssertEqual(table.normalizedRows, [["1", "", ""], ["1", "2", "3"]])
    }

    func testPipeBearingProseIsNotATable() {
        // No delimiter row → this is prose that happens to contain pipes, and
        // treating it as a table would eat the line.
        let raw = "run `a | b | c` to pipe it"
        XCTAssertEqual(MantaMarkdownParser.blocks(raw), [.paragraph(raw)])
    }

    func testEscapedPipeStaysInsideItsCell() {
        let cells = MantaMarkdownParser.splitRow("| a \\| b | c |")
        XCTAssertEqual(cells, ["a | b", "c"])
    }

    func testHeadingsListsRulesAndCode() {
        let raw = """
        ## The catch

        - **Model assets.** One-time download.
        - Second point.
        1. Ordered one.

        ---

        ```swift
        let x = 1
        ```
        """
        let blocks = MantaMarkdownParser.blocks(raw)
        XCTAssertEqual(blocks, [
            .heading(level: 2, text: "The catch"),
            .listItem(depth: 0, marker: "•", text: "**Model assets.** One-time download."),
            .listItem(depth: 0, marker: "•", text: "Second point."),
            .listItem(depth: 0, marker: "1.", text: "Ordered one."),
            .rule,
            .code(language: "swift", text: "let x = 1"),
        ])
    }

    func testUnclosedCodeFenceStillRendersAsCode() {
        // The streaming case: the closing fence has not arrived yet.
        let blocks = MantaMarkdownParser.blocks("```\nnpm test\n")
        XCTAssertEqual(blocks, [.code(language: nil, text: "npm test\n")])
    }

    func testHashtagIsNotAHeading() {
        XCTAssertEqual(MantaMarkdownParser.blocks("#nofilter"), [.paragraph("#nofilter")])
    }

    func testPlainProseIsOneParagraphPerBlankLineGroup() {
        let raw = "line one\nline two\n\nsecond para"
        XCTAssertEqual(MantaMarkdownParser.blocks(raw), [
            .paragraph("line one\nline two"),
            .paragraph("second para"),
        ])
    }

    // MARK: - Stable step identity (BET-666)
    //
    // The diffing list treats a removed+reinserted row as a flash/jump at every
    // turn boundary. A step's id must therefore be deterministic across refetch
    // (derived from the wire data, not a fresh random id).

    private func stepIDs(from blocks: [TranscriptBlock]) -> [String] {
        blocks.flatMap { block -> [String] in
            guard case .steps(let content) = block else { return [] }
            return content.rows.compactMap { row in
                guard case .step(let step) = row else { return nil }
                return step.id
            }
        }
    }

    func testStepIdsAreIdenticalAcrossRefetch() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
            toolPart("t2", "m1", tool: "read", status: "completed", input: ["filePath": str("a.ts")]),
        ])]
        let first = stepIDs(from: ChatTranscriptMapper.blocks(from: msgs))
        let second = stepIDs(from: ChatTranscriptMapper.blocks(from: msgs))
        XCTAssertFalse(first.isEmpty, "expected at least one step id")
        XCTAssertEqual(first, second, "mapping the same transcript twice must yield identical step ids")
    }

    func testStepIdsSurviveAppendingANewMessage() {
        let msgs = [message(id: "m1", role: "assistant", parts: [
            toolPart("t1", "m1", tool: "bash", status: "completed", input: ["command": str("run tests")]),
        ])]
        let before = stepIDs(from: ChatTranscriptMapper.blocks(from: msgs))
        let extended = msgs + [message(id: "m2", role: "assistant", parts: [
            toolPart("t3", "m2", tool: "read", status: "completed", input: ["filePath": str("b.ts")]),
        ])]
        let after = stepIDs(from: ChatTranscriptMapper.blocks(from: extended))
        let preserved = after.prefix(before.count)
        XCTAssertEqual(Array(preserved), before,
                       "pre-existing step ids must be preserved when a new message is appended")
    }
}
