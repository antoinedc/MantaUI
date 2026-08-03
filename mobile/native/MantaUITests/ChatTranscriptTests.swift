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
        guard case .user(let text) = blocks[0] else {
            return XCTFail("expected .user, got \(blocks[0])")
        }
        XCTAssertEqual(text, "check bet-520")
    }

    func testAssistantTextMapsToProse() {
        let msgs = [message(id: "m1", role: "assistant", parts: [textPart("p1", "m1", "Checking metadata.")])]
        let blocks = ChatTranscriptMapper.blocks(from: msgs)
        guard case .prose(let text) = blocks[0] else {
            return XCTFail("expected .prose")
        }
        XCTAssertEqual(text, "Checking metadata.")
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
}
